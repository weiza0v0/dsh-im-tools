#!/usr/bin/env node
// Send an IM message or file without going through an agent turn.
//
// This is the zero-token path: cron, systemd timers, build hooks and other
// scripts call it directly; no model is involved and no Session is created.
import {
  outboundSinceInbound,
  loadTargets,
  post,
  quotaKey,
  quotaLimit,
  readQuotaStore,
  resolveTarget,
  sendGuarded,
} from '../lib/index.js';

const NOTICE = '⚠️ 微信主动推送额度已用尽（或已熔断），请给机器人回任意一句话恢复推送。';

function usage(code = 1) {
  const text = `usage:
  dsh-im-send targets
  dsh-im-send text <message> [--bot <id>] [--target <id>] [--format markdown]
  dsh-im-send file <absolute-path> [--bot <id>] [--target <id>]

options:
  --notify-target <id>   on quota exhaustion, send a fixed notice to this target
  --notify-bot <id>      botId for --notify-target
env:
  DSH_HOME, DSH_WEB_URL, DSH_IM_BOT_ID, DSH_IM_TARGET_ID,
  DSH_IM_PROACTIVE_LIMIT, DSH_IM_NOTIFY_TARGET
exit codes:
  0 sent, 1 error, 2 quota exhausted/blocked, 3 delivery failed`;
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = value;
    i += 1;
  }
  return { positional, flags };
}

async function printTargets() {
  const targets = await loadTargets();
  const store = await readQuotaStore();
  const limit = quotaLimit();
  const rows = [];
  for (const target of targets) {
    const { lastInbound, outbound } = await outboundSinceInbound(target);
    const entry = store[quotaKey(target)] ?? null;
    const stale = lastInbound > (Number(entry?.since) || 0);
    const toolSends = stale ? 0 : (Number(entry?.count) || 0);
    const sent = Math.max(toolSends, outbound);
    const blocked = !stale && Boolean(entry?.blockedAt) && lastInbound <= Number(entry.blockedAt);
    rows.push({
      channel: target.channel,
      botId: target.botId,
      targetId: target.targetId,
      name: target.name ?? '',
      sent,
      limit,
      blocked,
    });
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.channel} | ${row.targetId} | ${row.name || '(unnamed)'} | bot=${row.botId} | sent ${row.sent}/${row.limit}${row.blocked ? ' (BLOCKED)' : ''}\n`,
    );
  }
}

async function notifyFallback(flags) {
  const targetId = flags['notify-target'] || process.env.DSH_IM_NOTIFY_TARGET;
  if (!targetId) return false;
  const botId = flags['notify-bot'] || process.env.DSH_IM_BOT_ID;
  try {
    const target = await resolveTarget({ botId, targetId });
    // The notice deliberately bypasses the quota guard: it is the escape hatch.
    await post('/api/dsh-im/delivery/messages', {
      botId: target.botId,
      targetId: target.targetId,
      text: NOTICE,
    });
    process.stderr.write(`notice sent to ${target.channel}/${target.targetId}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`notice failed: ${error?.code ?? error?.message ?? error}\n`);
    return false;
  }
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command) usage();

  if (command === 'targets') {
    await printTargets();
    return;
  }

  const selector = { botId: flags.bot, targetId: flags.target };
  if (command === 'text') {
    const text = rest.join(' ');
    if (!text.trim()) usage();
    const target = await resolveTarget(selector);
    const result = await sendGuarded(target, '/api/dsh-im/delivery/messages', {
      botId: target.botId,
      targetId: target.targetId,
      text,
      ...(flags.format === 'markdown' ? { format: 'markdown' } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'file') {
    const path = rest[0];
    if (!path) usage();
    const target = await resolveTarget(selector);
    const result = await sendGuarded(target, '/api/dsh-im/delivery/files', {
      botId: target.botId,
      targetId: target.targetId,
      path,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  usage();
}

try {
  await main();
} catch (error) {
  const code = error?.code ?? 'error';
  process.stderr.write(`dsh-im-send: ${code}: ${error?.message ?? error}\n`);
  if (code === 'im-quota-exhausted' || code === 'im-quota-blocked') {
    await notifyFallback(parse(process.argv.slice(2)).flags).catch(() => false);
    process.exit(2);
  }
  if (code.startsWith?.('http-') || code === 'delivery-failed') process.exit(3);
  process.exit(1);
}

