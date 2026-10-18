import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      if (request.url === '/api/dsh-im/delivery/messages') {
        response.end(JSON.stringify({ sent: true }));
        return;
      }
      if (request.url === '/api/dsh-im/delivery/files') {
        response.end(JSON.stringify({ sent: true, fileName: 'sample.pdf' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'not-found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  home = await mkdtemp(join(tmpdir(), 'dsh-im-tools-'));
  await mkdir(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
  await writeFile(
    join(home, 'integrations', 'dsh-weixin', 'workspaces.json'),
    JSON.stringify({
      deliveryTargets: {
        bot_alpha: {
          tgt_alpha: { name: '我的微信', kind: 'user', route: { toUserId: 'u1' } },
        },
      },
    }),
  );
  process.env.DSH_HOME = home;
  process.env.DSH_WEB_URL = base;
  process.env.DSH_IM_PROACTIVE_LIMIT = '50';
  delete process.env.DSH_IM_BOT_ID;
  delete process.env.DSH_IM_TARGET_ID;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

async function loadTools() {
  const { apply } = await import('../lib/index.js');
  const tools = new Map();
  const sctx = {
    effect(fn) { fn(); },
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string');
        assert.equal(definition.parameters.type, 'object');
        assert.ok(definition.output?.schema, `${definition.name} needs an output schema`);
        assert.equal(typeof definition.output.render, 'function');
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    systemPrompt: { context() {} },
  };
  const ctx = {
    inject(_deps, callback) { callback(sctx); },
    logger: () => ({ info() {}, error() {} }),
  };
  apply(ctx);
  return tools;
}

test('registers the three delivery tools', async () => {
  const tools = await loadTools();
  assert.deepEqual([...tools.keys()].sort(), ['im_send_file', 'im_send_text', 'im_targets']);
});

test('im_targets lists configured targets', async () => {
  const tools = await loadTools();
  const result = await tools.get('im_targets').execute();
  assert.equal(result.count, 1);
  assert.equal(result.targets[0].channel, 'weixin');
  assert.equal(result.targets[0].botId, 'bot_alpha');
  assert.equal(result.targets[0].targetId, 'tgt_alpha');
});

test('im_send_text posts the resolved target and text', async () => {
  calls.length = 0;
  const tools = await loadTools();
  const result = await tools.get('im_send_text').execute({ text: 'hello' });
  assert.deepEqual(result, { sent: true, channel: 'weixin', targetId: 'tgt_alpha' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/dsh-im/delivery/messages');
  assert.deepEqual(calls[0].body, { botId: 'bot_alpha', targetId: 'tgt_alpha', text: 'hello' });
});

test('im_send_text supports markdown format', async () => {
  calls.length = 0;
  const tools = await loadTools();
  await tools.get('im_send_text').execute({ text: '# hi', format: 'markdown' });
  assert.equal(calls[0].body.format, 'markdown');
});

test('im_send_file posts an existing file', async () => {
  calls.length = 0;
  const file = join(home, 'sample.pdf');
  await writeFile(file, '%PDF-1.4');
  const tools = await loadTools();
  const result = await tools.get('im_send_file').execute({ path: file });
  assert.equal(result.sent, true);
  assert.equal(result.channel, 'weixin');
  assert.equal(result.fileName, 'sample.pdf');
  assert.equal(calls[0].url, '/api/dsh-im/delivery/files');
  assert.equal(calls[0].body.path, file);
});

test('im_send_file rejects a missing file', async () => {
  const tools = await loadTools();
  await assert.rejects(
    () => tools.get('im_send_file').execute({ path: join(home, 'nope.pdf') }),
    (error) => error.code === 'im-file-missing',
  );
});

test('im_send_file rejects files over 30 MB', async () => {
  const file = join(home, 'big.bin');
  const handle = await open(file, 'w');
  await handle.truncate(30 * 1024 * 1024 + 1);
  await handle.close();
  const tools = await loadTools();
  await assert.rejects(
    () => tools.get('im_send_file').execute({ path: file }),
    (error) => error.code === 'im-file-too-large',
  );
});

test('ambiguous targets require an explicit id', async () => {
  const workspaces = join(home, 'integrations', 'dsh-weixin', 'workspaces.json');
  const original = await import('node:fs/promises').then((fs) => fs.readFile(workspaces, 'utf8'));
  await writeFile(
    workspaces,
    JSON.stringify({
      deliveryTargets: {
        bot_alpha: {
          tgt_alpha: { name: 'a', kind: 'user', route: { toUserId: 'u1' } },
          tgt_beta: { name: 'b', kind: 'user', route: { toUserId: 'u2' } },
        },
      },
    }),
  );
  try {
    const tools = await loadTools();
    await assert.rejects(
      () => tools.get('im_send_text').execute({ text: 'hi' }),
      (error) => error.code === 'im-ambiguous-target',
    );
    const result = await tools.get('im_send_text').execute({ text: 'hi', targetId: 'tgt_beta' });
    assert.equal(result.targetId, 'tgt_beta');
  } finally {
    await writeFile(workspaces, original);
  }
});
