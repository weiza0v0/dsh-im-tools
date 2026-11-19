import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
      calls.push({ url: request.url, bodyLength: body.length, body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 }));
        return;
      }
      if (request.url === '/open-apis/im/v1/files') {
        response.end(JSON.stringify({ code: 0, data: { file_key: 'file-key-1' } }));
        return;
      }
      if (request.url === '/open-apis/im/v1/images') {
        response.end(JSON.stringify({ code: 0, data: { image_key: 'image-key-1' } }));
        return;
      }
      if (request.url.startsWith('/open-apis/im/v1/messages')) {
        response.end(JSON.stringify({ code: 0, data: { message_id: 'om_test' } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 404, msg: 'not-found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  home = await mkdtemp(join(tmpdir(), 'dsh-im-tools-feishu-'));
  const dir = join(home, 'integrations', 'dsh-feishu');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    version: 2,
    bots: [{
      id: 'bot_fs',
      appId: 'cli_test',
      secretRef: 'DSH_FEISHU_APP_SECRET_TEST',
      domain: 'feishu',
      botName: 'test-bot',
    }],
  }));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: {
      bot_fs: {
        tgt_user: { name: '私聊', kind: 'user', route: { openId: 'ou_1' } },
        tgt_group: { name: '群', kind: 'group', route: { chatId: 'oc_1' } },
      },
    },
  }));
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'records: {}',
    'refs:',
    '  DSH_FEISHU_APP_SECRET_TEST: test-secret',
    '',
  ].join('\n'));

  process.env.DSH_HOME = home;
  process.env.DSH_FEISHU_API_BASE = `${base}/open-apis`;
  delete process.env.DSH_FEISHU_APP_SECRET_TEST;
  delete process.env.DSH_IM_BOT_ID;
  delete process.env.DSH_IM_TARGET_ID;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

async function load() {
  const mod = await import('../lib/index.js');
  const target = await mod.resolveTarget({ botId: 'bot_fs', targetId: 'tgt_user' });
  return { mod, target };
}

test('feishu file goes straight to the open platform', async () => {
  calls.length = 0;
  const { mod, target } = await load();
  const file = join(home, 'report.pdf');
  await writeFile(file, '%PDF-1.4 test');
  const result = await mod.deliverFile(target, file);

  assert.equal(result.sent, true);
  assert.equal(result.channel, 'feishu');
  assert.equal(result.fileName, 'report.pdf');
  assert.deepEqual(calls.map((call) => call.url.split('?')[0]), [
    '/open-apis/auth/v3/tenant_access_token/internal',
    '/open-apis/im/v1/files',
    '/open-apis/im/v1/messages',
  ]);
  const sent = JSON.parse(calls[2].body);
  assert.equal(sent.receive_id, 'ou_1');
  assert.equal(sent.msg_type, 'file');
  assert.equal(JSON.parse(sent.content).file_key, 'file-key-1');
  assert.equal(calls[2].url.includes('receive_id_type=open_id'), true);
  // no delivery/files round trip in the direct path
  assert.equal(calls.some((call) => call.url.includes('/delivery/files')), false);
});

test('images use the image endpoint and an image message', async () => {
  calls.length = 0;
  const { mod, target } = await load();
  const file = join(home, 'shot.png');
  await writeFile(file, 'png-bytes');
  const result = await mod.deliverFile(target, file);
  assert.equal(result.sent, true);
  assert.equal(calls.some((call) => call.url === '/open-apis/im/v1/images'), true);
  assert.equal(calls.some((call) => call.url === '/open-apis/im/v1/files'), false);
  const sent = JSON.parse(calls[2].body);
  assert.equal(sent.msg_type, 'image');
  assert.equal(JSON.parse(sent.content).image_key, 'image-key-1');
});

test('group targets send by chat_id', async () => {
  calls.length = 0;
  const mod = await import('../lib/index.js');
  const target = await mod.resolveTarget({ botId: 'bot_fs', targetId: 'tgt_group' });
  const file = join(home, 'report.pdf');
  await mod.deliverFile(target, file);
  assert.equal(calls[2].url.includes('receive_id_type=chat_id'), true);
  assert.equal(JSON.parse(calls[2].body).receive_id, 'oc_1');
});

test('sensitive files are refused before any upload', async () => {
  calls.length = 0;
  const { mod, target } = await load();
  const secret = join(home, '.credentials.yaml');
  await assert.rejects(
    () => mod.deliverFile(target, secret),
    (error) => error.code === 'im-feishu-direct-failed' && /sensitive/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('feishu api errors surface as im-feishu-direct-failed', async () => {
  const { mod, target } = await load();
  const file = join(home, 'report.pdf');
  const previous = process.env.DSH_FEISHU_API_BASE;
  process.env.DSH_FEISHU_API_BASE = `${base}/nope`;
  try {
    await assert.rejects(
      () => mod.deliverFile(target, file),
      (error) => error.code === 'im-feishu-direct-failed',
    );
  } finally {
    process.env.DSH_FEISHU_API_BASE = previous;
  }
});
