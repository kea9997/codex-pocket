import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStatus, assistantPreview } from '../server/activity.mjs';
import { Engine, summary } from '../server/engine.mjs';
import { MockDesktop, temp, waitFor } from './helpers.mjs';

function setup(t, count = 8) {
  let now = 1000;
  const desktop = new MockDesktop(), dir = temp(t), engine = new Engine(desktop, dir, { now: () => now });
  const rows = Array.from({ length: count }, (_, n) => ({ ...desktop.thread(`chat-${n}`), status: n < 4 ? 'active' : 'idle',
    isUnread: n === 1, summary: 'Retrieval summary, never a latest message' }));
  desktop.hook = async (tool, args) => {
    if (tool === 'list_threads') return { threads: rows, pinnedThreads: [] };
    if (tool === 'read_thread') return { thread: rows.find(r => r.id === args.threadId), turns: [{ id: 'latest', status: 'inProgress',
      items: [{ type: 'reasoning', get text() { throw new Error('Hidden reasoning inspected'); } },
        { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '실제 진행 답변' },
        { type: 'commandExecution', get aggregatedOutput() { throw new Error('Tool output inspected'); } }] }] };
  };
  return { engine, desktop, dir, rows, advance: n => { now += n; } };
}

test('string/object statuses normalize conservatively, including supported waiting flags; summary preserves unread and retrieval provenance', () => {
  for (const value of ['active', { type: 'active' }, 'in_progress']) assert.equal(normalizeStatus(value), 'active');
  for (const value of ['waiting_for_user', { type: 'active', activeFlags: ['waitingOnApproval'] }, { type: 'active', activeFlags: ['waitingOnUserInput'] }]) assert.equal(normalizeStatus(value), 'waiting');
  assert.equal(normalizeStatus('idle'), 'idle');
  assert.equal(normalizeStatus('notLoaded'), 'unavailable');
  for (const value of ['completed', 'future-status', undefined, {}]) assert.equal(normalizeStatus(value), 'unknown');
  const row = summary({ id: 'same', status: 'active', isUnread: true, summary: '검색용 요약' });
  assert.equal(row.status, 'active'); assert.equal(row.isUnread, true); assert.equal(row.retrievalSummary, '검색용 요약');
  assert.equal(row.preview, undefined);
});
test('assistant preview uses only latest visible agent text, is bounded, fingerprints full text, omits reasoning/user/tools', () => {
  const hidden = { type: 'reasoning', get text() { throw new Error('reasoning'); } };
  const page = [{ id: 'turn', status: 'inProgress', items: [hidden, { id: 'a', type: 'agentMessage', text: '한'.repeat(500) }, { type: 'userMessage', text: 'not assistant' }] },
    { id: 'old', items: [{ type: 'agentMessage', text: 'older' }] }];
  const first = assistantPreview(page, 10); assert.equal(first.text.length, 240); assert.equal(first.observedAt, 10);
  page[0].items[1].text += 'changed beyond truncation';
  assert.notEqual(assistantPreview(page, 20).version, first.version);
  assert.equal(assistantPreview([{ id: 'new', items: [hidden, { type: 'userMessage', text: 'only user' }] }, ...page], 30), null);
});
test('activity reads are readonly latest-turn only, shared/cached, never acknowledge send uncertainty or use retrieval summary as a message', async t => {
  const f = setup(t), before = readFileSync(join(f.dir, 'requests.json'), 'utf8');
  const first = f.engine.activity.snapshot(), duplicate = f.engine.activity.snapshot(); assert.equal(first, duplicate);
  const result = await first;
  assert.equal(result.data.length, 8); assert.equal(result.data[0].status, 'active'); assert.equal(result.data[1].desktopUnread, true);
  assert.equal(result.data[0].preview.text, '실제 진행 답변'); assert.equal(result.data[0].preview.phase, 'commentary');
  assert.equal(result.data.filter(r => r.previewState === 'ready').length, 4);
  assert.ok(!JSON.stringify(result).includes('Retrieval summary'));
  const calls = f.desktop.calls.length; await f.engine.activity.snapshot(); assert.equal(f.desktop.calls.length, calls);
  assert.equal(f.engine.readChecks.size, 0); assert.equal(readFileSync(join(f.dir, 'requests.json'), 'utf8'), before);
  assert.ok(f.desktop.calls.every(c => ['list_threads', 'read_thread'].includes(c.tool)));
  for (const call of f.desktop.calls.filter(c => c.tool === 'read_thread')) { assert.equal(call.args.turnLimit, 1); assert.equal(call.args.includeOutputs, false); }
});
test('single-flight recent list is shared by list/activity; preview fanout never exceeds four reads or two concurrent native calls', async t => {
  const f = setup(t); let releaseList, outstanding = 0, peak = 0; const releases = [];
  f.desktop.hook = async (tool, args) => {
    if (tool === 'list_threads') { await new Promise(r => { releaseList = r; }); return { threads: f.rows, pinnedThreads: [] }; }
    if (tool === 'read_thread') {
      outstanding++; peak = Math.max(peak, outstanding); await new Promise(r => releases.push(r)); outstanding--;
      return { thread: f.rows.find(r => r.id === args.threadId), turns: [] };
    }
  };
  const list = f.engine.list(), activity = f.engine.activity.snapshot();
  await waitFor(() => releaseList); assert.equal(f.desktop.calls.filter(c => c.tool === 'list_threads').length, 1); releaseList();
  await list; await waitFor(() => releases.length === 2); releases.splice(0).forEach(r => r());
  await waitFor(() => releases.length === 2); releases.splice(0).forEach(r => r()); await activity;
  assert.equal(peak, 2); assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread').length, 4);
});
test('slow previews do not block live status or start overlapping native read pools; cache remains bounded', async t => {
  const f = setup(t); const releases = []; let peak = 0, count = 0;
  const original = f.desktop.hook;
  f.desktop.hook = async (tool, args) => {
    if (tool !== 'read_thread') return original(tool, args);
    count++; peak = Math.max(peak, count); await new Promise(resolve => releases.push(resolve)); count--;
    return original(tool, args);
  };
  const snapshot = f.engine.activity.snapshot();
  await waitFor(() => releases.length === 2);
  const early = await snapshot;
  assert.equal(early.available, true); assert.equal(early.data[0].status, 'active');
  assert.equal(early.data[0].previewState, 'pending');
  f.advance(4001); await f.engine.activity.snapshot();
  assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread').length, 2);
  const reading = f.engine.activity.reading;
  releases.splice(0).forEach(r => r()); await waitFor(() => releases.length === 2); releases.splice(0).forEach(r => r()); await reading;
  assert.equal(peak, 2); assert.equal(f.engine.activity.reading, null);
  f.desktop.hook = original;
  for (let i = 0; i < 120; i++) f.engine.activity.entries.set(`unused-${i}`, {});
  f.advance(4001); await f.engine.activity.snapshot(); assert.ok(f.engine.activity.entries.size <= 96);
});
test('idle/unread chats are not starved by active chats; disconnect exposes stale evidence and recovery resumes bounded reads', async t => {
  const f = setup(t); await f.engine.activity.snapshot(); f.advance(4001);
  const next = await f.engine.activity.snapshot(); assert.ok(next.data.some(r => r.status === 'idle' && r.previewState === 'ready'));
  const read = f.desktop.hook; f.advance(4001);
  f.desktop.hook = async () => { throw new Error('private desktop error, must not escape'); };
  const offline = await f.engine.activity.snapshot(); assert.equal(offline.available, false); assert.ok(offline.data.every(r => r.stale));
  assert.ok(!JSON.stringify(offline).includes('private desktop'));
  const calls = f.desktop.calls.length; await f.engine.activity.snapshot(); assert.equal(f.desktop.calls.length, calls);
  f.advance(4001); f.desktop.hook = read;
  const recovered = await f.engine.activity.snapshot(); assert.equal(recovered.available, true); assert.ok(recovered.data.every(r => !r.stale));
});
test('failed latest-turn reads retain explicit stale preview without inventing fresh assistant content', async t => {
  const f = setup(t, 1); const first = await f.engine.activity.snapshot(); f.advance(4001);
  const read = f.desktop.hook;
  f.desktop.hook = (tool, args) => { if (tool === 'read_thread') throw new Error('offline'); return read(tool, args); };
  const second = await f.engine.activity.snapshot(); assert.equal(second.data[0].previewState, 'stale');
  assert.equal(second.data[0].preview.version, first.data[0].preview.version);
  assert.equal(second.data[0].previewCheckedAt, first.data[0].previewCheckedAt);
});
