/**
 * 飞书（Feishu/Lark）主动投递：直连开放平台 API，不依赖 dsh-im 内部实现。
 *
 * 用途：给 dsh-im-tools 的 im_send_file / dsh-im-send 提供一条与 @xmanrui/dsh-im
 * 版本解耦的文件投递通道（上游只支持文字主动投递）。
 *
 * 零第三方依赖：Node 18+ 的 fetch / FormData / Blob。
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_BASE = 'https://open.feishu.cn/open-apis';
const LARK_BASE = 'https://open.larksuite.com/open-apis';
const MAX_BYTES_DEFAULT = 30 * 1024 * 1024;

/** 飞书 im/v1/files 只认这几个 file_type，其余一律 stream。 */
const FILE_TYPE_BY_EXT = Object.freeze({
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.xls': 'xls',
  '.ppt': 'ppt',
});

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tif', '.tiff']);

/** 拒绝这些明显是凭据/私钥的东西，防止 agent 被诱导把密钥发出去。 */
const DENY_BASENAMES = new Set([
  '.credentials.yaml',
  '.credentials.yaml.bak',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  '.env',
  'credentials.json',
  'server-credentials.json',
]);
const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker']);

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从 $DSH_HOME/.credentials.yaml 的 refs 段取明文值（DSH 自己就是这么存的）。 */
export async function secretFromCredentials(ref, home = dshHome()) {
  let text;
  try {
    text = await readFile(path.join(home, '.credentials.yaml'), 'utf8');
  } catch {
    return null;
  }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (m && m[1] === ref) {
      const raw = m[2];
      if (!raw) return null;
      const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2');
      return unquoted || null;
    }
  }
  return null;
}

/** 解析凭据：环境变量 → 显式 override → $DSH_HOME/.credentials.yaml。 */
export async function resolveSecret(ref, home = dshHome()) {
  if (!ref) return null;
  const fromEnv = process.env[ref];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return secretFromCredentials(ref, home);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** 读 integrations/<channel>/ 下的 config.json 与 workspaces.json。 */
export async function loadFeishuIntegration(home = dshHome()) {
  const dir = path.join(home, 'integrations', 'dsh-feishu');
  const [config, workspaces] = await Promise.all([
    readJson(path.join(dir, 'config.json')).catch(() => null),
    readJson(path.join(dir, 'workspaces.json')).catch(() => null),
  ]);
  return { dir, config, workspaces };
}

export function listFeishuBots({ config }) {
  const bots = Array.isArray(config?.bots) ? config.bots : [];
  return bots.map((bot) => ({
    botId: bot.id,
    appId: bot.appId,
    secretRef: bot.secretRef,
    domain: bot.domain || 'feishu',
    name: bot.botName || null,
  }));
}

export function findFeishuTarget({ workspaces }, botId, targetId) {
  const perBot = workspaces?.deliveryTargets?.[botId];
  if (!perBot || typeof perBot !== 'object') return null;
  if (targetId) {
    const target = perBot[targetId];
    return target ? { targetId, ...target } : null;
  }
  const entries = Object.entries(perBot);
  if (entries.length !== 1) return null;
  const [id, target] = entries[0];
  return { targetId: id, ...target };
}

/** kind/route → receive_id_type + receive_id。 */
export function routeOf(target) {
  const route = target?.route ?? {};
  if (target?.kind === 'group' || route.chatId) {
    const chatId = route.chatId || route.openChatId;
    if (!chatId) throw new Error('target has no chatId');
    return { receiveIdType: 'chat_id', receiveId: chatId };
  }
  const openId = route.openId ?? route.userId ?? route.unionId;
  if (!openId) throw new Error('target has no openId');
  const receiveIdType = route.userId && !route.openId ? 'user_id' : 'open_id';
  return { receiveIdType, receiveId: openId };
}

async function api(base, token, pathname, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
    const code = body?.code ?? response.status;
    const msg = body?.msg || body?.error || response.statusText;
    const error = new Error(`feishu ${pathname} failed: ${code} ${msg}`);
    error.code = code;
    error.httpStatus = response.status;
    error.detail = body;
    throw error;
  }
  return body;
}

export async function tenantToken({ appId, appSecret, base }) {
  if (!appId) throw new Error('feishu appId missing');
  if (!appSecret) throw new Error('feishu app secret missing');
  const body = await api(base, null, '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const token = body.tenant_access_token;
  if (!token) throw new Error('feishu token response has no tenant_access_token');
  return { token, expire: body.expire ?? 7200 };
}

/** 文件路径安全检查：普通文件、非符号链接、大小上限、扩展名与敏感路径黑名单。 */
export async function checkFile(filePath, { maxBytes = MAX_BYTES_DEFAULT } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  if (!path.isAbsolute(filePath)) throw new Error('path must be absolute');
  const resolved = await realpath(filePath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('path is not a regular file');
  if (info.size === 0) throw new Error('refusing to send an empty file');
  if (info.size > maxBytes) {
    throw new Error(`file too large: ${info.size} bytes > ${maxBytes}`);
  }
  const base = path.basename(resolved).toLowerCase();
  if (DENY_BASENAMES.has(base) || base.startsWith('id_rsa')) {
    throw new Error(`refusing to send sensitive file: ${path.basename(resolved)}`);
  }
  for (const segment of resolved.split(/[\\/]/)) {
    if (DENY_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`refusing to send file from sensitive directory: ${segment}`);
    }
  }
  const ext = path.extname(resolved).toLowerCase();
  return { resolved, size: info.size, ext, fileName: path.basename(resolved) };
}

async function uploadFile(token, base, file) {
  const form = new FormData();
  form.append('file_type', FILE_TYPE_BY_EXT[file.ext] ?? 'stream');
  form.append('file_name', file.fileName);
  const bytes = await readFile(file.resolved);
  form.append('file', new Blob([bytes]), file.fileName);
  const body = await api(base, token, '/im/v1/files', { method: 'POST', body: form });
  const fileKey = body?.data?.file_key;
  if (!fileKey) throw new Error('feishu upload response has no file_key');
  return fileKey;
}

async function uploadImage(token, base, file) {
  const form = new FormData();
  form.append('image_type', 'message');
  const bytes = await readFile(file.resolved);
  form.append('image', new Blob([bytes]), file.fileName);
  const body = await api(base, token, '/im/v1/images', { method: 'POST', body: form });
  const imageKey = body?.data?.image_key;
  if (!imageKey) throw new Error('feishu image response has no image_key');
  return imageKey;
}

async function sendMessage(token, base, { receiveIdType, receiveId, msgType, content, uuid }) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType });
  const body = await api(base, token, `/im/v1/messages?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content: JSON.stringify(content),
      ...(uuid ? { uuid } : {}),
    }),
  });
  return body?.data ?? {};
}

/**
 * 主入口：把本地文件推到飞书。
 * @param {{filePath: string, botId?: string, targetId?: string, dshHome?: string, maxBytes?: number}} options
 */
export async function sendFeishuFile(options) {
  const { filePath } = options;
  const home = options.dshHome || dshHome();
  const integration = await loadFeishuIntegration(home);
  const bots = listFeishuBots(integration);
  if (bots.length === 0) throw new Error('no feishu bot configured in integrations/dsh-feishu/config.json');

  let bot = options.botId ? bots.find((b) => b.botId === options.botId) : null;
  if (!bot) {
    if (options.botId) throw new Error(`unknown feishu botId: ${options.botId}`);
    if (bots.length !== 1) throw new Error('multiple feishu bots; specify botId');
    bot = bots[0];
  }

  const target = findFeishuTarget(integration, bot.botId, options.targetId);
  if (!target) throw new Error(`unknown feishu targetId: ${options.targetId ?? '(auto)'}`);
  const { receiveIdType, receiveId } = routeOf(target);

  const file = await checkFile(filePath, { maxBytes: options.maxBytes });
  const appSecret = await resolveSecret(bot.secretRef, home);
  if (!appSecret) throw new Error(`feishu app secret not found for ref ${bot.secretRef}`);

  const base = process.env.DSH_FEISHU_API_BASE
    || (bot.domain === 'lark' ? LARK_BASE : DEFAULT_BASE);
  const { token } = await tenantToken({ appId: bot.appId, appSecret, base });

  const isImage = IMAGE_EXTS.has(file.ext);
  const msgType = isImage ? 'image' : 'file';
  const content = isImage
    ? { image_key: await uploadImage(token, base, file) }
    : { file_key: await uploadFile(token, base, file) };

  const sent = await sendMessage(token, base, {
    receiveIdType,
    receiveId,
    msgType,
    content,
    uuid: options.uuid,
  });

  return {
    sent: true,
    channel: 'feishu',
    botId: bot.botId,
    targetId: target.targetId,
    receiveIdType,
    fileName: file.fileName,
    bytes: file.size,
    msgType,
    messageId: sent.message_id ?? null,
  };
}

/** text 主动投递（上游也有，这里留一份便于自检）。 */
export async function sendFeishuText({ text, botId, targetId, dshHome: home, uuid }) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('text must be non-empty');
  const h = home || dshHome();
  const integration = await loadFeishuIntegration(h);
  const bots = listFeishuBots(integration);
  const bot = botId ? bots.find((b) => b.botId === botId) : bots[0];
  if (!bot) throw new Error('no feishu bot configured');
  const target = findFeishuTarget(integration, bot.botId, targetId);
  if (!target) throw new Error(`unknown feishu targetId: ${targetId ?? '(auto)'}`);
  const { receiveIdType, receiveId } = routeOf(target);
  const appSecret = await resolveSecret(bot.secretRef, h);
  const base = process.env.DSH_FEISHU_API_BASE || (bot.domain === 'lark' ? LARK_BASE : DEFAULT_BASE);
  const { token } = await tenantToken({ appId: bot.appId, appSecret, base });
  const sent = await sendMessage(token, base, {
    receiveIdType,
    receiveId,
    msgType: 'text',
    content: { text },
    uuid,
  });
  return { sent: true, channel: 'feishu', botId: bot.botId, targetId: target.targetId, messageId: sent.message_id ?? null };
}

// ---------------------------------------------------------------- CLI 自检
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('feishu-direct.mjs')) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pathArg = flag('path');
  const textArg = flag('text');
  try {
    if (pathArg) {
      const result = await sendFeishuFile({
        filePath: pathArg,
        botId: flag('bot'),
        targetId: flag('target'),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (textArg) {
      const result = await sendFeishuText({
        text: textArg,
        botId: flag('bot'),
        targetId: flag('target'),
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const integration = await loadFeishuIntegration();
      console.log(JSON.stringify({
        bots: listFeishuBots(integration),
        targets: integration.workspaces?.deliveryTargets ?? {},
      }, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ sent: false, error: error.message, code: error.code ?? null, detail: error.detail ?? null }, null, 2));
    process.exitCode = 1;
  }
}
