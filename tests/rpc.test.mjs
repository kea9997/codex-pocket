import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Rpc } from '../server/rpc.mjs';

test('real JSONL fixture child reads cursor pages and rejects every standalone mutation locally', async t => {
  const rpc = new Rpc({ executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url)), 'readonly'], timeoutMs: 1500 });
  t.after(async () => {
    const child = rpc.child; rpc.close();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  });
  await rpc.start(); const r = await rpc.request('thread/list', {}); assert.equal(r.data[0].name, '한글 저장 대화');
  assert.equal((await rpc.request('thread/list', { cursor: r.nextCursor })).nextCursor, null);
  for (const method of ['thread/resume', 'thread/start', 'thread/fork', 'turn/start', 'turn/steer', 'turn/interrupt', 'config/value/write'])
    await assert.rejects(rpc.request(method, {}), e => e.code === 'METHOD_NOT_ALLOWED');
  await assert.rejects(rpc.request('thread/read', {}), e => e.code === 'CODEX_REQUEST_FAILED' && !e.message.includes('fixture-private-error'));
});
test('JSONL UTF8 decoder preserves Korean split in the middle of a character', async () => {
  const rpc = new Rpc(); rpc.child = { stdin: { write() {} } };
  const pending = rpc.request('thread/list', {}), bytes = Buffer.from(JSON.stringify({ id: 1, result: { title: '한글' } }) + '\n');
  for (const byte of bytes) rpc.consume(Buffer.from([byte]));
  assert.equal((await pending).title, '한글'); rpc.fail();
});
