// dsh-im-tools — agent-callable proactive IM delivery tools.
//
// These tools post to the dsh-im delivery HTTP endpoints on the local DSH host.
// They are session-independent: any DSH session (web, CLI, schedule) can push
// text or a file to a configured IM target without binding the chat first.
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const name = 'dsh-im-tools';
// Root-scope services only. Tools and the prompt service are resolved per
// agent inside apply(); requiring them here would leave apply() waiting.
export const inject = [];

const MAX_FILE_BYTES = 30 * 1024 * 1024;

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

function textTool() {
  return {
    name: 'im_send_text',
    description: '向已配置的 IM 投递目标（微信/飞书/企微/钉钉/QQ/Telegram 等）主动发送一条文字消息。不依赖当前会话，网页/CLI/定时任务的回合都能用。默认发往本机唯一目标；有多个目标时先用 im_targets 查看并指定 botId/targetId。',
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
      const result = await post('/api/dsh-im/delivery/messages', {
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
    description: '向已配置的 IM 投递目标主动发送一个本地文件（PDF/图片/Office/压缩包等，绝对路径，≤30 MB）。不依赖当前会话；图片会以图片消息发送。发送成功只代表渠道已接受，不代表对方已读。',
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
      const result = await post('/api/dsh-im/delivery/files', {
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
              },
            },
          },
        },
        required: ['count', 'targets'],
      },
      render(_args, value) {
        const lines = value.targets.map((target) => (
          `${target.channel} | ${target.targetId} | ${target.name || '(unnamed)'} | bot=${target.botId}`
        ));
        return [{ type: 'text', text: `targets: ${value.count}\n${lines.join('\n')}` }];
      },
    },
    async execute() {
      const targets = await loadTargets();
      return {
        count: targets.length,
        targets: targets.map((target) => ({
          channel: target.channel,
          botId: target.botId,
          targetId: target.targetId,
          name: target.name ?? '',
          kind: target.kind ?? '',
          sessionSync: Boolean(target.sessionSync),
        })),
      };
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
