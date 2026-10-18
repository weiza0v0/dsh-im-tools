// dsh-im-tools — agent-callable proactive IM delivery tools.
//
// These tools post to the dsh-im delivery HTTP endpoints on the local DSH host.
// They are session-independent: any DSH session (web, CLI, schedule) can push
// text or a file to a configured IM target without binding the chat first.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const name = 'dsh-im-tools';
// Root-scope services only. Tools and the prompt service are resolved per
// agent inside apply(); requiring them here would leave apply() waiting.
export const inject = [];

const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** WeChat blocks a conversation after ~10 consecutive proactive sends (#151). */
const QUOTA_DEFAULT_LIMIT = 8;
const QUOTA_FAILURE_LIMIT = 2;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function baseUrl() {
  return (process.env.DSH_WEB_URL || `http://127.0.0.1:${process.env.DSH_WEB_PORT || 3080}`)
    .replace(/\/+$/, '');
}

async function loadTargets() {
  const root = join(dshHome(), 'integrations');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let doc;
    try {
      doc = JSON.parse(await readFile(join(root, entry.name, 'workspaces.json'), 'utf8'));
    } catch {
      continue;
    }
    const map = doc?.deliveryTargets;
    if (!map || typeof map !== 'object') continue;
    for (const [botId, list] of Object.entries(map)) {
      if (!list || typeof list !== 'object') continue;
      for (const [targetId, target] of Object.entries(list)) {
        targets.push({
          channel: entry.name.replace(/^dsh-/, ''),
          botId,
          targetId,
          name: typeof target?.name === 'string' ? target.name : undefined,
          kind: typeof target?.kind === 'string' ? target.kind : undefined,
          sessionSync: Boolean(target?.sessionSync),
          route: target?.route && typeof target.route === 'object' ? target.route : {},
        });
      }
    }
  }
  return targets;
}

async function resolveTarget({ botId, targetId } = {}) {
  const wantedBot = botId || process.env.DSH_IM_BOT_ID || undefined;
  const wantedTarget = targetId || process.env.DSH_IM_TARGET_ID || undefined;
  let list = await loadTargets();
  if (wantedBot) list = list.filter((target) => target.botId === wantedBot);
  if (wantedTarget) list = list.filter((target) => target.targetId === wantedTarget);
  if (list.length === 1) return list[0];
  if (list.length === 0) {
    const error = new Error('没有可用的 IM 投递目标。先在「设置 → IM机器人 → 主动投递」里创建并保存一个目标。');
    error.code = 'im-no-target';
    throw error;
  }
  const error = new Error(`匹配到 ${list.length} 个投递目标，请用 botId/targetId 指定：${
    list.map((target) => `${target.botId}/${target.targetId}`).join(', ')}`);
  error.code = 'im-ambiguous-target';
  throw error;
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const wrapped = new Error(`无法连接 DSH Web（${baseUrl()}）：${error?.message ?? error}`);
    wrapped.code = 'im-host-unreachable';
    throw wrapped;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.error) {
    const code = payload?.error?.code ?? `http-${response.status}`;
    const error = new Error(`IM 投递失败：${code}`);
    error.code = code;
    throw error;
  }
  return payload ?? { sent: true };
}

function quotaLimit() {
  const raw = Number(process.env.DSH_IM_PROACTIVE_LIMIT);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : QUOTA_DEFAULT_LIMIT;
}

function quotaFile() {
  return join(dshHome(), 'dsh-im-tools', 'quota.json');
}

async function readQuotaStore() {
  try {
    const parsed = JSON.parse(await readFile(quotaFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeQuotaStore(store) {
  const file = quotaFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`);
}

function quotaKey(target) {
  return `${target.channel}:${target.botId}:${target.targetId}`;
}

/** Latest inbound message time for this target (WeChat only; ms). */
async function lastUserMessageAt(target) {
  if (target.channel !== 'weixin') return 0;
  let state;
  try {
    state = JSON.parse(await readFile(
      join(dshHome(), 'integrations', 'dsh-weixin', 'accounts', target.botId, 'state.json'),
      'utf8',
    ));
  } catch {
    return 0;
  }
  const users = state?.contextTokens?.users;
  if (!users || typeof users !== 'object') return 0;
  const wanted = target.route?.toUserId;
  const entries = wanted && users[wanted] ? [users[wanted]] : Object.values(users);
  let latest = 0;
  for (const entry of entries) {
    const at = Number(entry?.receivedAt);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

/**
 * Block proactive WeChat sends before WeChat blocks them.
 *
 * The allowance resets only when the user messages the bot; a newer inbound
 * message therefore starts a fresh window. Two failed sends in a row trip the
 * breaker, because retrying "prepare failed" only extends the cooldown.
 */
async function guardQuota(target) {
  const limit = quotaLimit();
  if (target.channel !== 'weixin') return { store: null, key: null, entry: null, limit };
  const store = await readQuotaStore();
  const key = quotaKey(target);
  const lastUser = await lastUserMessageAt(target);
  let entry = store[key];
  if (!entry || typeof entry !== 'object' || lastUser > (Number(entry.since) || 0)) {
    entry = { since: lastUser, count: 0, failures: 0, blockedAt: 0 };
    store[key] = entry;
  }
  const blockedAt = Number(entry.blockedAt) || 0;
  if (blockedAt && lastUser <= blockedAt) {
    const error = new Error('微信主动推送已熔断：连续发送失败或额度用尽，需要用户先给机器人发一条消息才能恢复。');
    error.code = 'im-quota-blocked';
    throw error;
  }
  if ((Number(entry.count) || 0) >= limit) {
    const error = new Error(`自上次用户消息以来已主动发送 ${entry.count} 条，达到上限 ${limit}（微信侧约 10 条即拒）。请让用户给机器人发一条消息后再继续。`);
    error.code = 'im-quota-exhausted';
    throw error;
  }
  return { store, key, entry, limit, lastUser };
}

async function commitQuota(context, ok) {
  if (!context?.store || !context.entry) return;
  const { store, entry } = context;
  if (ok) {
    entry.count = (Number(entry.count) || 0) + 1;
    entry.failures = 0;
    entry.lastSentAt = Date.now();
  } else {
    entry.failures = (Number(entry.failures) || 0) + 1;
    if (entry.failures >= QUOTA_FAILURE_LIMIT) entry.blockedAt = Date.now();
  }
  await writeQuotaStore(store).catch(() => undefined);
}

async function sendGuarded(target, path, body) {
  const quota = await guardQuota(target);
  try {
    const result = await post(path, body);
    await commitQuota(quota, true);
    return result;
  } catch (error) {
    // A host that is unreachable says nothing about the WeChat allowance.
    if (error?.code !== 'im-host-unreachable') await commitQuota(quota, false);
    throw error;
  }
}

function textTool() {
  return {
    name: 'im_send_text',
    description: '向已配置的 IM 投递目标（微信/飞书/企微/钉钉/QQ/Telegram 等）主动发送一条文字消息。不依赖当前会话，网页/CLI/定时任务的回合都能用。默认发往本机唯一目标；有多个目标时先用 im_targets 查看并指定 botId/targetId。微信会限制连续主动推送（约 10 条），本工具自带熔断：额度用尽或连续失败会返回 im-quota-exhausted / im-quota-blocked，需要用户先给机器人发一条消息恢复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要发送的文字内容。' },
        botId: { type: 'string', description: '可选：机器人 id，默认取本机唯一目标。' },
        targetId: { type: 'string', description: '可选：投递目标 id，默认取本机唯一目标。' },
        format: { type: 'string', enum: ['plain', 'markdown'], description: '可选：plain（默认）或 markdown。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          channel: { type: 'string' },
          targetId: { type: 'string' },
        },
        required: ['sent', 'channel', 'targetId'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `sent=${value.sent} via ${value.channel}` }];
      },
    },
    async execute(args = {}) {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) {
        const error = new Error('text 不能为空');
        error.code = 'im-empty-text';
        throw error;
      }
      const target = await resolveTarget(args);
      const result = await sendGuarded(target, '/api/dsh-im/delivery/messages', {
        botId: target.botId,
        targetId: target.targetId,
        text,
        ...(args.format === 'markdown' ? { format: 'markdown' } : {}),
      });
      return {
        sent: result?.sent === true,
        channel: target.channel,
        targetId: target.targetId,
      };
    },
  };
}

function fileTool() {
  return {
    name: 'im_send_file',
    description: '向已配置的 IM 投递目标主动发送一个本地文件（PDF/图片/Office/压缩包等，绝对路径，≤30 MB）。不依赖当前会话；图片会以图片消息发送。发送成功只代表渠道已接受，不代表对方已读。与 im_send_text 共用微信侧推送额度与熔断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件的绝对路径。' },
        botId: { type: 'string', description: '可选：机器人 id。' },
        targetId: { type: 'string', description: '可选：投递目标 id。' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          fileName: { type: 'string' },
          channel: { type: 'string' },
          size: { type: 'number' },
        },
        required: ['sent', 'fileName', 'channel', 'size'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `sent=${value.sent} ${value.fileName}` }];
      },
    },
    async execute(args = {}) {
      const raw = typeof args.path === 'string' ? args.path.trim() : '';
      if (!raw) {
        const error = new Error('path 不能为空');
        error.code = 'im-empty-path';
        throw error;
      }
      const path = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
      let info;
      try {
        info = await stat(path);
      } catch {
        const error = new Error(`文件不存在：${path}`);
        error.code = 'im-file-missing';
        throw error;
      }
      if (!info.isFile()) {
        const error = new Error(`不是普通文件：${path}`);
        error.code = 'im-file-invalid';
        throw error;
      }
      if (info.size > MAX_FILE_BYTES) {
        const error = new Error(`文件超过 30 MB 上限：${info.size} bytes`);
        error.code = 'im-file-too-large';
        throw error;
      }
      const target = await resolveTarget(args);
      const result = await sendGuarded(target, '/api/dsh-im/delivery/files', {
        botId: target.botId,
        targetId: target.targetId,
        path,
      });
      return {
        sent: result?.sent === true,
        fileName: result?.fileName ?? path.split('/').pop() ?? '',
        channel: target.channel,
        size: info.size,
      };
    },
  };
}

function targetsTool() {
  return {
    name: 'im_targets',
    description: '列出本机 IM 机器人已配置的主动投递目标（渠道、botId、targetId、名称、是否开启会话同步）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                channel: { type: 'string' },
                botId: { type: 'string' },
                targetId: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string' },
                sessionSync: { type: 'boolean' },
                sentSinceLastUser: { type: 'number' },
                limit: { type: 'number' },
                blocked: { type: 'boolean' },
                lastUserMessageAt: { type: 'number' },
              },
            },
          },
        },
        required: ['count', 'targets'],
      },
      render(_args, value) {
        const lines = value.targets.map((target) => (
          `${target.channel} | ${target.targetId} | ${target.name || '(unnamed)'} | bot=${target.botId} | sent ${target.sentSinceLastUser ?? 0}/${target.limit ?? 0}${target.blocked ? ' (BLOCKED)' : ''}`
        ));
        return [{ type: 'text', text: `targets: ${value.count}\n${lines.join('\n')}` }];
      },
    },
    async execute() {
      const targets = await loadTargets();
      const store = await readQuotaStore();
      const limit = quotaLimit();
      const rows = [];
      for (const target of targets) {
        const lastUser = await lastUserMessageAt(target);
        const entry = store[quotaKey(target)] ?? null;
        const blocked = Boolean(entry?.blockedAt) && lastUser <= Number(entry.blockedAt);
        rows.push({
          channel: target.channel,
          botId: target.botId,
          targetId: target.targetId,
          name: target.name ?? '',
          kind: target.kind ?? '',
          sessionSync: Boolean(target.sessionSync),
          sentSinceLastUser: Number(entry?.count) || 0,
          limit,
          blocked,
          lastUserMessageAt: lastUser,
        });
      }
      return { count: rows.length, targets: rows };
    },
  };
}

export function apply(ctx) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-im-tools') : console;
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = [];
      for (const tool of [targetsTool(), textTool(), fileTool()]) {
        try {
          disposers.push(sctx.tools.register(tool));
        } catch (error) {
          log.error?.(`register failed for ${tool.name}: ${error?.message ?? error}`);
        }
      }
      log.info?.(`registered ${disposers.length}/3 IM delivery tools`);
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // Registration disposal is best-effort.
          }
        }
      };
    });
  });
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => sctx.systemPrompt.context({
      name: 'dsh-im-tools',
      order: 116,
      text: 'To push a message or a file to the user’s IM (e.g. WeChat) from any session, call im_send_text / im_send_file; im_targets lists configured delivery targets. These calls do not require the current chat to be bound to that IM conversation.',
    }));
  });
}
