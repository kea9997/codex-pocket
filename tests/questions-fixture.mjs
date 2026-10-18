import * as fs from 'node:fs';
import { join } from 'node:path';
import { temp } from './helpers.mjs';

export const thread = '11111111-1111-4111-8111-111111111111';
export const turnId = '22222222-2222-4222-8222-222222222222';
export const key = (call = 'call_first', index = 0) => JSON.stringify(['request_user_input_async', call, index]);
export const record = (type, payload) => ({ timestamp: '2026-10-16T01:00:00.000Z', type, payload });
export const question = (call = 'call_first', title = '어떻게 진행할까요?') => record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: call, arguments: JSON.stringify({ questions: [{ title, options: ['기본 유지', '더 짧게'] }] }) });
export const replyText = (answer = '기본 유지', title = '어떻게 진행할까요?', call = 'call_first') => '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: key(call), question: title, answer }]) + '\n</send_user_message_question_reply>';
export const reply = () => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText() }] });
export const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
export const ordinalLines = rows => lines(rows.map((row, ordinal) => ({ timestamp: row.timestamp, ordinal, type: row.type, payload: row.payload })));
export function questionFixture(t) {
  const root = join(temp(t), 'sessions'), dir = join(root, '2026', '10', '16'); fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-16T01-00-00-${thread}.jsonl`);
  const initial = [record('session_meta', { id: thread }), record('turn_context', { turn_id: turnId }), question()];
  fs.writeFileSync(file, lines(initial));
  return { root, dir, file, initial, metadata: async () => ({ thread: { id: thread, path: file } }) };
}
