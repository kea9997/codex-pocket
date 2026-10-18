import readline from 'node:readline';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
// Synthetic JSONL child only; inert when discovered directly by a test runner.
if (process.argv[2] === 'readonly') readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.method === 'initialized' || !m.method) return;
  const ok = result => send({ id: m.id, result });
  if (m.method === 'initialize') return ok({ userAgent: 'fixture' });
  if (m.method === 'thread/list') return ok({ data: m.params.cursor ? [] : [{ id: 'stored-thread', name: '한글 저장 대화' }], nextCursor: m.params.cursor ? null : 'next' });
  send({ id: m.id, error: { code: -32000, message: 'credential=fixture-private-error' } });
});
