import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let home;
let failNext = 0;

before(async () => {
  server = createServer((request, response) => {
    // Drain the body so keep-alive sockets stay healthy.
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (failNext > 0) {
        failNext -= 1;
        response.statusCode = 502;
        response.end(JSON.stringify({ error: { code: 'delivery-failed' } }));
        return;
      }
      response.end(JSON.stringify({ sent: true, fileName: 'x.pdf' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.DSH_WEB_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DSH_IM_PROACTIVE_LIMIT = '2';
  delete process.env.DSH_IM_BOT_ID;
  delete process.env.DSH_IM_TARGET_ID;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), 'dsh-im-quota-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'integrations', 'dsh-weixin', 'accounts', 'bot1'), { recursive: true });
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'workspaces.json'),
    JSON.stringify({
      deliveryTargets: {
        bot1: { tgt1: { name: 'me', kind: 'user', route: { toUserId: 'u1' } } },
      },
    }),
  );
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'accounts', 'bot1', 'state.json'),
    JSON.stringify({ contextTokens: { users: { u1: { receivedAt: 1000, token: 'x' } } } }),
  );
  failNext = 0;
});

async function tools() {
  const { apply } = await import('../lib/index.js');
  const map = new Map();
  const sctx = {
    effect(fn) { fn(); },
    tools: { register(def) { map.set(def.name, def); return () => {}; } },
    systemPrompt: { context() {} },
  };
  apply({ inject(_deps, callback) { callback(sctx); }, logger: () => ({ info() {}, error() {} }) });
  return map;
}

async function setLastUserMessage(receivedAt) {
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'accounts', 'bot1', 'state.json'),
    JSON.stringify({ contextTokens: { users: { u1: { receivedAt, token: 'x' } } } }),
  );
}

test('allows sends up to the configured limit', async () => {
  const t = await tools();
  assert.equal((await t.get('im_send_text').execute({ text: 'one' })).sent, true);
  assert.equal((await t.get('im_send_text').execute({ text: 'two' })).sent, true);
  await assert.rejects(
    () => t.get('im_send_text').execute({ text: 'three' }),
    (error) => error.code === 'im-quota-exhausted',
  );
});

test('a newer inbound message resets the allowance', async () => {
  const t = await tools();
  await t.get('im_send_text').execute({ text: 'one' });
  await t.get('im_send_text').execute({ text: 'two' });
  await setLastUserMessage(Date.now() + 60_000);
  const result = await t.get('im_send_text').execute({ text: 'after reply' });
  assert.equal(result.sent, true);
});

test('two failed sends trip the breaker until the user writes again', async () => {
  const t = await tools();
  failNext = 2;
  await assert.rejects(() => t.get('im_send_text').execute({ text: 'a' }));
  await assert.rejects(() => t.get('im_send_text').execute({ text: 'b' }));
  await assert.rejects(
    () => t.get('im_send_text').execute({ text: 'c' }),
    (error) => error.code === 'im-quota-blocked',
  );
  await setLastUserMessage(Date.now() + 60_000);
  const result = await t.get('im_send_text').execute({ text: 'recovered' });
  assert.equal(result.sent, true);
});

test('non-WeChat channels skip the allowance', async () => {
  await mkdir(join(home, 'integrations', 'dsh-feishu'), { recursive: true });
  await writeFile(
    join(home, 'integrations', 'dsh-feishu', 'workspaces.json'),
    JSON.stringify({
      deliveryTargets: { botF: { tgtF: { name: 'group', kind: 'group', route: { chatId: 'oc_x' } } } },
    }),
  );
  const t = await tools();
  for (let i = 0; i < 4; i += 1) {
    const result = await t.get('im_send_text').execute({ text: `m${i}`, targetId: 'tgtF' });
    assert.equal(result.sent, true);
  }
});

test('im_targets reports the allowance', async () => {
  const t = await tools();
  await t.get('im_send_text').execute({ text: 'one' });
  const result = await t.get('im_targets').execute();
  assert.equal(result.targets[0].sentSinceLastUser, 1);
  assert.equal(result.targets[0].limit, 2);
  assert.equal(result.targets[0].blocked, false);
});

test('the quota file is persisted under DSH_HOME', async () => {
  const t = await tools();
  await t.get('im_send_text').execute({ text: 'one' });
  const raw = JSON.parse(await readFile(join(home, 'dsh-im-tools', 'quota.json'), 'utf8'));
  assert.equal(raw['weixin:bot1:tgt1'].count, 1);
});
