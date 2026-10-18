import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-im-send.mjs');

let server;
let base;
let home;
const calls = [];

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      calls.push({ url: request.url, body: parsed });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ sent: true, fileName: 'x.pdf' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  home = await mkdtemp(join(tmpdir(), 'dsh-im-cli-'));
  await mkdir(join(home, 'integrations', 'dsh-weixin', 'accounts', 'bot1'), { recursive: true });
  await mkdir(join(home, 'integrations', 'dsh-feishu'), { recursive: true });
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'workspaces.json'),
    JSON.stringify({ deliveryTargets: { bot1: { tgt1: { name: 'me', kind: 'user', route: { toUserId: 'u1' } } } } }),
  );
  await writeFile(
    join(home, 'integrations', 'dsh-feishu', 'workspaces.json'),
    JSON.stringify({ deliveryTargets: { botF: { tgtF: { name: 'group', kind: 'group', route: { chatId: 'oc_x' } } } } }),
  );
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'accounts', 'bot1', 'state.json'),
    JSON.stringify({ contextTokens: { users: { u1: { receivedAt: 1000, token: 'x' } } } }),
  );
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

function run(args, extraEnv = {}) {
  // Async spawn: the mock server lives in this process, so a blocking
  // spawnSync would deadlock the child's request.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_WEB_URL: base,
        DSH_IM_PROACTIVE_LIMIT: '1',
        DSH_IM_BOT_ID: '',
        DSH_IM_TARGET_ID: '',
        DSH_IM_NOTIFY_TARGET: '',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('targets prints the configured target', async () => {
  const result = await run(['targets']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /weixin \| tgt1 \| me/);
  assert.match(result.stdout, /sent 0\/1/);
});

test('text sends once then reports the quota on the next call', async () => {
  calls.length = 0;
  const first = await run(['text', 'hello from cron', '--target', 'tgt1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).sent, true);
  assert.equal(calls.at(-1).url, '/api/dsh-im/delivery/messages');

  const second = await run(['text', 'again', '--target', 'tgt1']);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /im-quota-exhausted/);
});

test('quota exhaustion can notify a fallback target', async () => {
  calls.length = 0;
  const result = await run(['text', 'third', '--target', 'tgt1', '--notify-target', 'tgtF']);
  assert.equal(result.status, 2);
  const notice = calls.find((call) => call.body?.text?.includes('额度'));
  assert.ok(notice, 'expected a fallback notice to be posted');
  assert.equal(notice.body.botId, 'botF');
  assert.equal(notice.body.targetId, 'tgtF');
});

test('file sends through the files endpoint', async () => {
  calls.length = 0;
  const file = join(home, 'note.txt');
  await writeFile(file, 'hi');
  {
    const result = await run(['file', file, '--target', 'tgt1'], { DSH_IM_PROACTIVE_LIMIT: '5' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sent, true);
    assert.equal(calls.at(-1).url, '/api/dsh-im/delivery/files');
    assert.equal(calls.at(-1).body.path, file);
  }
});

test('targets --json is machine readable', async () => {
  const result = await run(['targets', '--json']);
  assert.equal(result.status, 0);
  const rows = JSON.parse(result.stdout);
  const row = rows.find((item) => item.targetId === 'tgt1');
  assert.ok(row, 'tgt1 should be listed');
  assert.equal(typeof row.sent, 'number');
});

test('quota state persists between processes', async () => {
  const raw = JSON.parse(await readFile(join(home, 'dsh-im-tools', 'quota.json'), 'utf8'));
  assert.ok(raw['weixin:bot1:tgt1']);
});
