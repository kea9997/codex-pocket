// Isolated loopback fixture. Only generated test media; never Desktop, Auth, Engine or private state.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assets } from '../server/http.mjs';
import { assistantPreview } from '../server/activity.mjs';
import { sampleImage } from './sample-image.mjs';
import { markdownImages } from '../server/media.mjs';
import { sampleVideo } from './sample-video.mjs';
import { Readable } from 'node:stream';
import { serveVideo } from '../server/video.mjs';
import { usageBuckets } from '../server/usage.mjs';
import { workTime, compareWork } from '../server/work-order.mjs';
import { release } from '../server/release.mjs';
import { SampleAccounts } from './sample-accounts.mjs';

const controls = Buffer.from(`'use strict';
document.getElementById('sampleAccounts').onclick = async () => {
  const response = await fetch('/sample/accounts', {method:'POST', headers:{'Content-Type':'application/json','X-Codex-CSRF':'sample-not-a-credential'}, body:'{}'});
  document.getElementById('sampleAccountsState').textContent = (await response.json()).label;
  document.getElementById('listAccounts').click();
};
const button = document.getElementById('sampleActivityNext');
button.onclick = async () => {
  button.disabled = true;
  try {
    const response = await fetch('/sample/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    document.getElementById('sampleActivityState').textContent = result.label;
    window.dispatchEvent(new Event('online'));
  } finally { button.disabled = false; }
};
document.getElementById('sampleSizeNext').onclick = async () => {
  const response = await fetch('/sample/size', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const result = await response.json();
  document.getElementById('sampleSizeState').textContent = result.label;
  window.dispatchEvent(new Event('online'));
};
for (const [id, route, label] of [['sampleDiagnostics', '/sample/diagnostics', 'sampleDiagnosticState'], ['sampleQuestions', '/sample/questions', 'sampleQuestionState'], ['sampleQuestionSend', '/sample/question-send', 'sampleQuestionSendState'], ['sampleRuntime', '/sample/runtime', 'sampleRuntimeState'], ['sampleRecency', '/sample/recency', 'sampleRecencyState']]) document.getElementById(id).onclick = async () => {
  const response = await fetch(route, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  document.getElementById(label).textContent = (await response.json()).label;
  window.dispatchEvent(new Event('online'));
};
document.getElementById('sampleReveal').onclick = async () => {
  const button = document.getElementById('sampleReveal'); button.disabled = true;
  try {
    const response = await fetch('/sample/reveal', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    document.getElementById('sampleRevealState').textContent = (await response.json()).label;
    // Let the existing two-second poll deliver it, without a reconnect/online catch-up event.
  } finally { button.disabled = false; }
};
document.getElementById('sampleUsage').onclick = async () => {
  const response = await fetch('/sample/usage', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  document.getElementById('sampleUsageState').textContent = (await response.json()).label;
  // Sample-only: reload the page to read the chosen synthetic state without weakening production cache.
  location.reload();
};
document.getElementById('sampleModels').onclick = async () => {
  const response = await fetch('/sample/models', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  document.getElementById('sampleModelState').textContent = (await response.json()).label;
  location.reload();
};
document.getElementById('sampleUpdate').onclick = async () => {
  const response = await fetch('/sample/update', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  document.getElementById('sampleUpdateState').textContent = (await response.json()).label;
  // Deliberately use the product's manual retry; never auto-apply/reload a draft.
};
let sampleTransferBusy = false;
document.getElementById('sampleUpdateBlock').onclick = () => {
  sampleTransferBusy = !sampleTransferBusy;
  window.dispatchEvent(new CustomEvent('codexNative', {detail:{transfer:'합성 업데이트 보호 · 실제 파일 전송 아님', transferDone:!sampleTransferBusy}}));
  document.getElementById('sampleUpdateBlock').textContent = sampleTransferBusy ? '합성 전송 종료 · 업데이트 보호 해제' : '합성 전송 중 · 업데이트 보호 검사';
};
document.getElementById('sampleDeviceState').onclick = () => {
  window.dispatchEvent(new CustomEvent('codexNative', {detail:{message:'샘플 안내 · 별표·초안 입력·이전 기록 이동 후 새로고침하면 실제 기기 저장 코드를 확인할 수 있습니다. 네이티브 알림·전체화면은 이 브라우저에서 검증하지 않습니다.',transfer:'샘플 상태 · 파일 받는 중 50% (전송 실행 아님)',transferDone:false}}));
};`);

const sampleInsetsCss = Buffer.from('/* Synthetic safe-area inputs only; not Android insets or a native capability. */\n:root{--viewport-safe-top:44px;--viewport-safe-right:18px;--viewport-safe-bottom:34px;--viewport-safe-left:18px}\n');
const sampleInsetsNative = Buffer.from("'use strict';\n// Exercise only the shipped layout owner; do not spoof navigator or native events.\nsetSafeAreaOwner('CodexPhone/2 CodexPhoneApp/0.3.0');\n");

export function createPreview() {
  const capability = { online: true, continuationEnabled: true, ownership: 'desktop-owner', approvalsOnPc: true, interruptSupported: false };
  const titles = ['[샘플 · 전송 안 됨] Codex 원격 앱 화면 점검', '[샘플] 긴 한국어 제목과 작업 경로가 있는 기존 대화 화면 확인', '[샘플] 실행 중 대화 · 추가 지시'];
  const rows = Array.from({ length: 35 }, (_, i) => ({ id: `sample-${i}`, title: titles[i % 3], cwd: 'D:/sample/project', model: '샘플 모델', updatedAt: 1792100000 - i * 100, status: i === 2 ? 'active' : 'idle' }));
  const turns = new Map(rows.map(r => [r.id, [{ id: 'sample-turn', status: r.status === 'active' ? 'inProgress' : 'completed', startedAt: 2,
    items: [{ id: 'u', type: 'userMessage', text: '이 화면은 실제 대화가 아닌 테스트 자료입니다. 코드 복사와 이전 기록을 확인해 주세요.' },
      { id: 'a', type: 'agentMessage', text: '## 화면 확인\n\n기존 대화에서 읽은 메시지는 이런 형태로 보입니다. **이 서버는 실제 Codex에 연결하지 않습니다.**\n\n```js\nconst title = "한글 복사 테스트";\nconsole.log(title);\n```\n\n긴 경로 예시: D:/sample/project/a-very-long-directory-name-for-overflow-check/example-file.mjs' },
      { id: 'c', type: 'commandExecution', text: '샘플 검사', detail: '이 내용은 고정된 테스트 출력입니다.', status: 'completed' }] }]]));
  const sampleFiles = new Map([
    ['g'.repeat(43), { name: '생성 샘플.png', mime: 'image/png', data: sampleImage() }],
    ['h'.repeat(43), { name: '생성 샘플.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\n% generated synthetic preview only\n%%EOF\n') }]
  ]);
  const raster = sampleImage(), image = key => ({ state: 'ready', url: '/api/media/' + key.repeat(43), alt: '로컬 생성 샘플 이미지 · 실제 파일 아님' });
  const markdownText = '## 이미지 확인\n\n앞 문장 ![생성 이미지](<D:/sample with spaces/frame.png>) 뒤 문장';
  const start = markdownText.indexOf('!['), end = markdownText.indexOf(' 뒤 문장');
  turns.get('sample-0')[0].items.push(
    { id: 'markdown-image', type: 'agentMessage', text: markdownText, images: [{ start, end, media: image('a') }] },
    { id: 'view-image', type: 'imageView', media: image('a') },
    { id: 'user-image', type: 'userMessage', text: '첨부한 이미지 샘플', images: [image('a')] },
    { id: 'missing-image', type: 'imageView', media: image('b') },
    { id: 'retry-image', type: 'imageView', media: image('c') },
    { id: 'video', type: 'imageView', media: { state: 'unavailable', error: 'MEDIA_TYPE_UNSUPPORTED', alt: 'WebM 등 MP4 이외 동영상은 지원하지 않습니다.' } });
  for (const row of rows) turns.get(row.id).push({ id: 'older-sample-turn', startedAt: 1, status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: '이전 샘플 기록입니다. 실제 저장 대화는 아닙니다.' }, { id: 'old-image', type: 'imageView', media: image('a') }] });
  rows[0].title = '[샘플 · 전송 안 됨] 대화 안 이미지 · 누락 · 다시 확인';
  rows[3].title = '[샘플] 긴 기록 · 크기 한도와 출력 생략';
  const videoBytes = sampleVideo(), fixtureSession = { id: 'loopback-fixture' }, videoToken = 'v'.repeat(43);
  const video = { state: 'ready', kind: 'video', url: '/api/media/' + videoToken, alt: '1초 생성 동영상 · H264 · 무음' };
  const fixtureMedia = { openVideo(session, token) {
    if (session !== fixtureSession || token !== videoToken) throw new Error('SAMPLE_VIDEO_NOT_FOUND');
    return { size: videoBytes.length, stream(start, end) { return Readable.from([videoBytes.subarray(start, end + 1)]); }, close() {} };
  } };
  const videoText = '## 동영상 확인\n\n![생성 동영상](</D:/sample with spaces/generated.mp4>)\n\n재생·탐색 중에도 새 샘플 메시지가 추가됩니다.';
  rows[4].title = '[샘플] 동영상 재생 · 갱신 중 유지'; rows[4].status = 'active'; turns.get('sample-4')[0].status = 'inProgress';
  turns.get('sample-4')[0].items = [
    { id: 'video-message', type: 'agentMessage', text: videoText, images: markdownImages(videoText).map(ref => ({ start: ref.start, end: ref.end, media: video })) },
    { id: 'missing-video', type: 'imageView', media: { state: 'ready', kind: 'video', url: '/api/media/' + 'e'.repeat(43), alt: '누락된 샘플 동영상' } },
    { id: 'retry-video', type: 'imageView', media: { ...video, url: '/api/media/' + 'f'.repeat(43), alt: '첫 읽기 실패 · 다시 확인으로 재생' } }
  ];
  rows[5].title = '[샘플] 조용한 작업 내역 · 선택형 질문'; rows[5].status = 'active'; turns.get('sample-5')[0].status = 'inProgress';
  turns.get('sample-5')[0].items.push(...Array.from({ length: 18 }, (_, n) => ({ id: `execution-${n}`, type: ['commandExecution', 'fileChange', 'mcpToolCall', 'sleep', 'contextCompaction'][n % 5], text: '고정 샘플 작업', detail: '제한된 샘플 출력', status: n === 17 ? 'failed' : 'completed' })),
    { id: 'progress-1', type: 'agentMessage', text: '작업을 계속하면서 선택을 기다리는 비동기 질문 샘플입니다.' },
    { id: 'progress-2', type: 'agentMessage', text: '샘플 답변은 실제 대화로 전송하지 않습니다.' });
  rows[6].title = '[샘플] 질문 확인 불가 · PC에서 처리';
  rows[8].title = '[샘플] 휴대폰 요청 본문 · 원문 생략 안내';
  turns.get('sample-8')[0].items.unshift(
    { id: 'synthetic-native-request', type: 'userMessage', requestState: 'complete', text: '[합성 휴대폰 요청 · 실제 전송 없음]\n첫 줄과 두 번째 줄을 그대로 보여 주세요.\n<input>XML 문자 예시</input>\n```js\nconst text = "한글";\n```' },
    { id: 'synthetic-omitted-request', type: 'requestNotice', requestState: 'unavailable', text: '[합성 생략 사례] 요청 전달 기록의 원문이 조회 한도에서 잘려 전체 내용을 표시할 수 없습니다. 전체 요청은 PC에서 확인해 주세요.' });
  rows[7].title = '[샘플] 결과 파일 저장 · 기기 복원 · 즐겨찾기';
  turns.get('sample-7')[0].items.push({ id: 'result-files', type: 'agentMessage', text: '이 파일은 메모리에서 만든 샘플입니다. 브라우저의 저장 링크는 실제 샘플 바이트를 내려받습니다. Android 공유 선택창은 전용 기기에서 별도로 확인해야 합니다.', files: [...sampleFiles].map(([token, f]) => ({ file: { state: 'ready', url: '/api/files/' + token, name: f.name, mime: f.mime } })) });
  rows[9].title = '[샘플] 대화 도구 · 검색 · 결과 모음';
  turns.get('sample-9')[0].items.push(
    { id: 'literal-search', type: 'agentMessage', text: '문자 그대로 검색: .* [한글] <script>문자</script>\n\n결과 모음에서 원래 메시지로 돌아와 기존 보기·저장·공유를 확인해 주세요.' },
    { id: 'gathered-image', type: 'imageView', media: image('a') },
    { id: 'gathered-video', type: 'imageView', media: video },
    { id: 'gathered-file', type: 'agentMessage', text: '메모리에서 생성한 샘플 파일', files: [...sampleFiles].map(([token, f]) => ({ file: { state: 'ready', url: '/api/files/' + token, name: f.name, mime: f.mime } })) });
  rows[11].title = '[샘플] 표 · 목록 · 체크리스트 · 긴 초안';
  turns.get('sample-11')[0].items.push({ id: 'structured-markdown', type: 'agentMessage', text: '## 모바일 작업 정리\n\n| 작업 | 상태 | 확인 | 긴 항목 |\n| :--- | --- | ---: | --- |\n| **확장 편집** | 준비 | 직접 확인 | 긴 한국어 셀도 표 안에서만 스크롤됩니다 |\n| 빠른 지시 | 저장 | [샘플 링크](https://example.invalid) | 원문 복사도 별도로 제공합니다 |\n\n- [x] 읽기 전용 완료 표시\n- [ ] 아직 남은 작업\n- 일반 목록\n\n3. 순서 있는 첫 항목\n4. 다음 항목\n\n```md\n| 코드 안 표 | 그대로 |\n| --- | --- |\n- [x] 코드 안 체크리스트도 그대로\n```\n\n<script>문자 그대로 · 실행 안 됨</script>\n\n입력창 ⤢로 긴 초안을 편집하고 돌아가세요. 도구 → 내 빠른 지시 관리에서 추가·수정·순서를 바꾼 뒤 다시 열어 확인할 수 있습니다. 실제 전송은 하지 않습니다.' });
  rows[10].title = '[샘플] 새 답변 부드럽게 표시 · 클릭으로 수신'; rows[10].status = 'active'; turns.get('sample-10')[0].status = 'inProgress';
  turns.get('sample-10')[0].items[1].text += '\n\n' + Array.from({ length: 14 }, (_, n) => `읽던 샘플 기록 ${n + 1}. 위로 스크롤해 읽는 동안 새 답변을 받아도 위치를 강제로 바꾸지 않습니다.`).join('\n\n');
  const revealText = '## 새로 받은 샘플 답변\n\n이 문장은 실제 전송 없이 메모리에서 만든 답변입니다. 주기적으로 받은 본문을 짧게 이어서 보여 주며 실제 토큰 스트리밍은 아닙니다. 한글과 이모지 👩🏽‍💻 🇰🇷도 한 글자 단위로 안전하게 표시합니다. **읽던 위치와 영상은 그대로 유지합니다.**\n\n표시는 최대 0.7초 정도에 끝납니다. 도구의 답변 표시를 즉시로 바꾸거나 기기의 동작 줄이기를 켜면 바로 나타납니다. 이미 열린 기록과 이전 기록은 처음부터 즉시 표시합니다.';
  let revealStage = 0;
  const revealPanel = '<div class="sample-controls"><button id="sampleReveal" type="button">샘플 새 답변 받기</button><span id="sampleRevealState">11번째 대화 전용 · 처음 기록은 즉시, 클릭 후 다음 조회에서 수신 · 실제 전송 없음</span></div>';
  const sampleQuestions = { state: 'ready', data: [
    { id: '["request_user_input_async","call_sample_old",0]', title: '샘플 결과를 어떻게 볼까요?', options: ['간단히', '자세히'], state: 'answered', answer: '간단히', turnId: 'older-sample-turn' },
    { id: '["request_user_input_async","call_sample_live",0]', title: '어떤 편집 방향으로 이어갈까요?', options: ['기본 전환 유지', '전환을 더 짧게', '직접 답변'], state: 'unconfirmed', turnId: 'sample-turn' },
    { id: '["request_user_input_async","call_sample_text",0]', title: '권한 설정 화면과 token 표시 디자인은 어떻게 할까요?', options: [], state: 'unconfirmed', turnId: 'sample-turn' },
    { id: '["request_user_input","call_sample_blocking",0]', title: 'PC에서 질문 확인', options: [], state: 'pc-only', turnId: 'sample-turn' },
    { id: '["request_user_input_async","call_sample_ended",0]', title: '작업 종료 뒤에도 남은 질문에 어떻게 답할까요?', options: ['현재 방향 유지', '직접 설명'], state: 'historical', turnId: 'older-sample-turn' }
  ].map(q => q.state === 'pc-only' ? q : { ...q, sourceKey: createHash('sha256').update(JSON.stringify([q.id, q.title, q.options])).digest('hex') }) };
  const questionMessages = new Map(), questionRequests = new Map(); let questionSendStage = 0;
  const questionSendLabels = ['미응답만 표시 · 답변 전달 후 사라짐', '전송 전 거절 · 직접 재시도', '전달 확인 중 · 재전송 금지', '전달 불명 · 재전송 금지', '메시지만 전달 · PC 폼 완료 아님', 'PC 폼 응답 기록도 확인됨'];
  const questionsWithReceipts = () => ({ ...sampleQuestions, data: sampleQuestions.data.map(q => ({ ...q,
    ...(questionMessages.has(q.id) ? { messageState: questionMessages.get(q.id) } : {}),
    ...(questionSendStage === 5 && q.id.includes('call_sample_live') ? { state: 'answered', answer: '합성 PC 응답 · 일반 메시지 전달과 별개' } : {}) })) });
  const receipts = new Map(), creationInputs = new Map(), staged = new Map(), usedUploads = new Set(), candidates = new Map(); let modelStage = 0;
  const modelLabels = ['합성 모델·생성: 정상', '합성 모델·생성: 선택지 확인 불가', '합성 모델·생성: client-only 대기 · 자동 해결 불가', '합성 모델·생성: 생성 결과 불명', '합성 모델·생성: 실제 ID 후보 · 두 번 조회 후 검증 완료'];
  const verifyCandidate = receipt => {
    const candidate = candidates.get(receipt?.requestId);
    if (candidate && ++candidate.reads >= 2 && ['pending', 'uncertain'].includes(receipt.state)) {
      receipt.threadId = candidate.id; receipt.state = 'delivered'; receipt.verification = 'verified';
      rows.unshift({ id: candidate.id, title: '[합성] 지연 검증한 새 대화', status: 'idle' });
      turns.set(candidate.id, [{ id: 'candidate-turn', status: 'completed', items: [{ id: 'candidate-answer', type: 'agentMessage', text: '원래 응답의 합성 실제 ID 후보를 같은 ID/local Codex로 검증한 상태입니다. 실제 native 호출 없음.' }] }]);
    }
    return receipt;
  };
  const modelOptions = () => {
    const cap = models => ({ available: modelStage !== 1, state: modelStage === 1 ? 'unavailable' : 'ready', models: modelStage === 1 ? [] : models });
    return { source: 'pc-desktop', checkedAt: Date.now(), refreshAfter: Date.now() + 60000,
      send: cap([{ id: 'sample-fast', efforts: ['low', 'high'] }, { id: 'sample-other', efforts: ['medium'] }]),
      create: cap([{ id: 'sample-fast', efforts: ['low', 'high'] }, { id: 'sample-deep', efforts: ['xhigh', 'ultra'] }]),
      projects: { state: modelStage === 1 ? 'unavailable' : 'ready', items: modelStage === 1 ? [] : [{ id: 'sample-project', label: '합성 로컬 프로젝트 · 실제 폴더 아님' }] } };
  };
  const sampleAccounts = new SampleAccounts();
  const accountPanel = '<div class="sample-controls"><strong>계정 화면 샘플 · 실제 계정/로그인/재시작 없음</strong><p id="sampleAccountsState">실제 설치본 제한 → 합성 선택 가능 → 코드 대기 → 추가 완료 → 전환 처리 중 → 작업 중 차단 → 만료 → 복구 → 확인 완료. 계정 버튼의 저장/추가/취소/이름/제거도 메모리 합성입니다. DEMO-0000을 실제 로그인에 사용하지 마세요. 계정 전환 뒤 현재 계정을 직접 확인합니다.</p><button id="sampleAccounts" type="button">계정 상태 다음 샘플</button></div>';
  let updateStage = 0;
  const updateLabels = ['현재 버전과 같음', '다른 합성 웹 버전 · 직접 다시 확인', '업데이트 확인 실패 · 이전 안내 유지', '다른 합성 웹 버전 · 확인 복구'];
  const conveniencePanel = '<div class="sample-controls"><strong>모바일 편의 샘플 · 실제 전송 없음</strong><p>12번째 대화: 표·목록·체크리스트·원문 복사. 입력창 ⤢: 긴 초안, Back/Escape. 도구 → 내 빠른 지시 관리: 추가·수정·삭제·위/아래 순서·초안에만 적용. 11번째 대화에서 위로 스크롤 후 샘플 새 답변 받기 → 정기 조회 → 새 답변 ↓.</p><p id="sampleUpdateState">합성 웹 버전: 동일 → 다름 → 확인 실패 → 복구 → 동일. 목록/도구의 업데이트에서 직접 다시 확인하세요(3초 간격). 적용은 실제 페이지를 새로 여므로 초안 복원을 확인할 수 있습니다. APK는 바뀌지 않습니다.</p><button id="sampleUpdate" type="button">업데이트 상태 전환</button><button id="sampleUpdateBlock" type="button">합성 전송 중 · 업데이트 보호 검사</button></div>';
  let authenticated = true, stage = 0, scenario = 0, sizeLimit = false, retryAttempt = 0, videoRetry = 0, videoUpdate = 0, questionUpdate = 0, diagnosticStage = 0, questionStage = 0, usageStage = 0, runtimeMissing = false;
  const samplePanel = '<div class="sample-controls"><strong>샘플 활동 · 실제 전송 없음</strong><p id="sampleModelState">모델·프로젝트·새 대화도 메모리 합성입니다. 실제 Codex 호출 없음. 전환: 정상 → 선택지 확인 불가 → client-only 미해결 → 생성 결과 불명 → 실제 ID 후보의 지연 검증 완료 → 정상. 첨부는 hash만 메모리에 남기고 bytes를 저장하지 않는 합성 전송입니다. 업로드 오류·취소·재연결은 브라우저 네트워크 오프라인 전환으로 확인하세요. 전환 시 페이지를 다시 엽니다.</p><button id="sampleModels" type="button">모델·생성 샘플 전환</button><p id="sampleUsageState">합성 사용 한도·토큰 활동 · 실제 계정 값 아님. 누적/미래 초기화 → 0 → 날짜별/초기화 미상 → null → 미지원 → 실패/이전 값 → 초기화 시각 지남 → 다른 계정 값(321) → 무제한 → 잘못된 잔액 → 작은 소수 → 환율 확인 불가 → 오래된 환율. 원화·환율도 합성 자료이며 외부 조회 없음. 전환 시 페이지를 다시 엽니다.</p><button id="sampleUsage" type="button">사용 한도 샘플 전환</button><p id="sampleDiagnosticState">합성 진단: 정상 → PC 조회 실패 → 진단 실패 → 정상</p><button id="sampleDiagnostics" type="button">진단 상태 전환</button><p id="sampleRuntimeState">합성 질문 조회 연결: 정상 → 업데이트 중 실행 파일 없음 → 정상. 6번째 대화의 입력 보존·다시 확인을 점검합니다. 실제 설치 파일에 접근하지 않습니다.</p><button id="sampleRuntime" type="button">질문 조회 연결 오류 전환</button><p id="sampleRecencyState">합성 최근 작업순: 21번째 대화의 실제 샘플 updatedAt만 갱신합니다. 단순 조회·읽음은 시각을 바꾸지 않습니다. 별표와 이전 페이지를 보존하는지 확인하세요.</p><button id="sampleRecency" type="button">최근 작업 갱신 샘플</button><p id="sampleQuestionState">합성 질문: 전체 → 최근 → 최근 0개 → 오류 → 로딩 → 전체</p><button id="sampleQuestions" type="button">6번째 대화 질문 범위 전환</button><p id="sampleQuestionSendState">합성 답변: 정상 → 전송 전 거절 → 전달 확인 중 → 전달 불명 → 메시지만 전달 → PC 폼 응답 기록. 6번째 대화의 선택·직접 입력 후 보내기로 확인하세요. 이전 작업의 미응답 질문도 포함됩니다. 실제 전송 없음.</p><button id="sampleQuestionSend" type="button">질문 답변 전송 상태 전환</button><p>10번째 대화: 도구에서 빠른 지시·문자 검색·결과 종류/원래 메시지 이동. 클립보드 차단 시 직접 복사를 확인하세요.</p><p id="sampleActivityState">다음 단계: 작업 시작 → 진행 답변 → 작업 종료</p><button id="sampleActivityNext" type="button">샘플 활동 다음 단계</button><p id="sampleSizeState">긴 기록 샘플: 출력 생략 후 정상 · 첫 대화는 이미지 성공/누락/재확인</p><button id="sampleSizeNext" type="button">긴 기록 한도 오류 전환</button><button id="sampleDeviceState" type="button">v0.2 샘플 상태·복원 안내</button><p>별표·초안·이전 기록 뒤 새로고침: 기기 복원. 파일: 8번째 대화. 영상 전체화면: 재생 컨트롤. 네이티브 성공을 시뮬레이션하지 않습니다.</p></div>';
  const preview = id => ({ preview: assistantPreview(turns.get(id), Date.now()), previewCheckedAt: Date.now() });
  return http.createServer(async (req, res) => {
    const origin = 'http://127.0.0.1:47832';
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== '127.0.0.1:47832' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403, { error: 'PREVIEW_LOOPBACK_ONLY' });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'ORIGIN_REJECTED' });
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && path === '/sample-controls.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(controls); }
      if (req.method === 'GET' && !url.search && ['/sample-insets.css', '/sample-insets-native.js'].includes(path)) {
        res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
        return res.end(path.endsWith('.css') ? sampleInsetsCss : sampleInsetsNative);
      }
      if (req.method === 'GET' && assets.has(path)) {
        const insetMode = path === '/' ? url.searchParams.get('sampleInsets') : null;
        if (insetMode !== null && !['?sampleInsets=browser', '?sampleInsets=native'].includes(url.search)) return json(400, { error: 'INVALID_QUERY' });
        const a = assets.get(path); res.writeHead(200, { 'Content-Type': a.mime });
        if (path !== '/') return res.end(a.data);
        const insetHead = insetMode ? '<link rel="stylesheet" href="/sample-insets.css">' + (insetMode === 'native' ? '<script src="/sample-insets-native.js"></script>' : '') : '';
        const insetNote = insetMode ? '<p id="sampleInsetsNote">합성 안전 여백 · ' + insetMode + ' 소유 · 위44/오른쪽18/아래34/왼쪽18px 입력. 실제 Android inset·native 기능 검증이 아닙니다.</p>' : '';
        return res.end(a.data.toString().replace('<title>Codex 원격</title>', insetMode ? '<title>합성 안전 여백 · ' + insetMode + ' · Codex 원격</title>' : '<title>Codex 원격</title>').replace('</head>', insetHead + '<script src="/sample-controls.js" defer></script></head>').replace('<div class="search-wrap">', '<details id="sampleQa" class="sample-qa"><summary>합성 QA · 실제 Codex 연결 없음</summary><div class="sample-qa-body">' + insetNote + accountPanel + conveniencePanel + samplePanel + revealPanel + '</div></details><div class="search-wrap">'));
      }
      if (req.method === 'POST' && path === '/api/uploads') {
        if (!authenticated) return json(401, { error: 'AUTH_REQUIRED' });
        if (req.headers.origin !== origin || req.headers['x-codex-csrf'] !== 'sample-not-a-credential') return json(403, { error: 'CSRF_REJECTED' });
        if (req.url.includes('?') || staged.size >= 32 || Number(req.headers['content-length']) > 20 * 1024 * 1024) return json(413, { error: 'UPLOAD_SIZE' });
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) return json(413, { error: 'UPLOAD_SIZE' }); digest.update(chunk); }
        if (!authenticated) return json(401, { error: 'AUTH_REQUIRED' });
        const upload = { handle: randomBytes(32).toString('base64url'), sha256: digest.digest('hex'), size, expiresAt: Date.now() + 86400000 };
        staged.set(upload.handle, upload); return json(200, upload); // Hash only, no file bytes or filesystem access in preview.
      }
      let input = {};
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) return json(403, { error: 'ORIGIN_REQUIRED' });
        let size = 0, chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 24000) return json(413, { error: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString());
      }
      if (path === '/api/pair' && req.method === 'POST') { authenticated = true; return json(200, { paired: true }); }
      if (!authenticated) return json(401, { error: 'AUTH_REQUIRED' });
      if (path === '/api/release' && req.method === 'GET') {
        if (req.url.includes('?')) return json(400, { error: 'INVALID_QUERY' });
        if (updateStage === 2) return json(503, { error: 'NETWORK' });
        return json(200, updateStage ? { revision: release.revision + '-sample', notes: ['합성 업데이트 안내 · 실제 새 릴리스 아님', '초안을 보존하고 직접 적용하는 화면을 확인합니다.'] } : release);
      }
      if (path === '/sample/update' && req.method === 'POST') {
        if (req.url.includes('?') || !input || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        updateStage = (updateStage + 1) % 4; return json(200, { label: updateLabels[updateStage] });
      }
      const accountReply = sampleAccounts.handle(path, req.method, input, req.headers['x-codex-csrf'], req.url.includes('?'));
      if (accountReply) return json(accountReply.status, accountReply.data);
      if (path === '/api/session') return json(200, { csrf: 'sample-not-a-credential', storageScope: 'a'.repeat(64), accountRevision: sampleAccounts.revision, ...capability });
      if (path === '/api/logout' && req.method === 'POST') { authenticated = false; return json(200, { revoked: true }); }
      if (path === '/sample/models' && req.method === 'POST') {
        if (req.url.includes('?') || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        modelStage = (modelStage + 1) % 5; return json(200, { label: modelLabels[modelStage] });
      }
      if (path === '/api/options' && req.method === 'GET') {
        if (req.url.includes('?')) return json(400, { error: 'INVALID_QUERY' });
        return json(200, modelOptions());
      }
      if (path === '/api/create/state' && req.method === 'GET') {
        if (req.url.includes('?')) return json(400, { error: 'INVALID_QUERY' });
        return json(200, { request: verifyCandidate([...receipts.values()].find(r => r.kind === 'create' && ['pending', 'uncertain'].includes(r.state))) || null });
      }
      const cancelUpload = /^\/api\/uploads\/([A-Za-z0-9_-]{43})\/cancel$/.exec(path);
      if (cancelUpload && req.method === 'POST') {
        if (req.headers['x-codex-csrf'] !== 'sample-not-a-credential') return json(403, { error: 'CSRF_REJECTED' });
        if (usedUploads.has(cancelUpload[1])) return json(409, { error: 'UPLOAD_IN_USE' });
        if (!staged.delete(cancelUpload[1])) return json(404, { error: 'UPLOAD_NOT_FOUND' }); return json(200, { removed: true });
      }
      if (['/api/create', '/api/send'].includes(path) && input.attachments && (!Array.isArray(input.attachments) || input.attachments.length > 6 || input.attachments.some(a => { const r = staged.get(a.handle); return !r || r.sha256 !== a.sha256 || r.size !== a.size; }))) return json(404, { error: 'UPLOAD_NOT_FOUND' });
      const creationAck = /^\/api\/create\/([a-f0-9-]{36})\/acknowledge$/.exec(path);
      if (creationAck && req.method === 'POST') {
        const receipt = receipts.get(creationAck[1]);
        if (req.url.includes('?') || input.confirmed !== true || Object.keys(input).length !== 1) return json(400, { error: 'CONFIRMATION_REQUIRED' });
        if (receipt?.kind !== 'create') return json(404, { error: 'REQUEST_NOT_FOUND' });
        if (!['pending', 'uncertain', 'acknowledged'].includes(receipt.state)) return json(409, { error: 'REQUEST_NOT_UNCERTAIN' });
        receipt.state = 'acknowledged'; return json(200, receipt);
      }
      if (path === '/api/create' && req.method === 'POST') {
        if (req.url.includes('?') || !input || Object.keys(input).some(k => !['requestId', 'text', 'target', 'model', 'thinking', 'attachments'].includes(k)) ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) return json(400, { error: 'INVALID_INPUT' });
        const identity = JSON.stringify(input), old = receipts.get(input.requestId);
        if (old) return json(creationInputs.get(input.requestId) === identity ? 200 : 409, creationInputs.get(input.requestId) === identity ? old : { error: 'REQUEST_ID_CONFLICT' });
        if ([...receipts.values()].some(r => r.kind === 'create' && ['pending', 'uncertain'].includes(r.state))) return json(409, { error: 'PREVIOUS_CREATE_UNCERTAIN' });
        const options = modelOptions(), target = input.target;
        if (!options.create.available) return json(503, { error: 'OPTIONS_UNAVAILABLE' });
        if (!target || !(target.type === 'projectless' && Object.keys(target).length === 1 || target.type === 'project' && Object.keys(target).length === 2 && target.projectId === 'sample-project')) return json(400, { error: 'INVALID_TARGET' });
        const model = options.create.models.find(m => m.id === input.model);
        if ('model' in input && !model || 'thinking' in input && !model?.efforts.includes(input.thinking)) return json(409, { error: 'MODEL_CHOICE_UNAVAILABLE' });
        const state = [2, 4].includes(modelStage) ? 'pending' : modelStage === 3 ? 'uncertain' : 'delivered', id = `sample-${rows.length}`;
        const receipt = { kind: 'create', requestId: input.requestId, threadId: state === 'delivered' ? id : null, state, verification: state === 'delivered' ? 'verified' : modelStage === 4 ? 'candidate' : 'unresolved' };
        if (modelStage === 4) candidates.set(input.requestId, { id, reads: 0 });
        receipts.set(input.requestId, receipt); creationInputs.set(input.requestId, identity);
        for (const a of input.attachments || []) usedUploads.add(a.handle);
        if (state === 'delivered') {
          rows.unshift({ id, title: '[샘플 · 실제 생성 없음] 새 대화', status: 'idle', updatedAt: Date.now() / 1000 });
          turns.set(id, [{ id: 'sample-created-turn', status: 'completed', items: [{ id: 'sample-user', type: 'userMessage', text: input.text }, { id: 'sample-answer', type: 'agentMessage', text: '샘플 메모리에만 만들었습니다. 실제 Codex 대화 생성·전송·모델 변경은 없습니다.' }] }]);
        }
        return json(200, receipt);
      }
      if (path === '/sample/diagnostics' && req.method === 'POST') {
        diagnosticStage = (diagnosticStage + 1) % 3;
        return json(200, { label: ['합성 진단: 정상', '합성 진단: PC·저장 조회 실패', '합성 진단: 요청 실패 · 실제 네트워크 장애 아님'][diagnosticStage] });
      }
      if (path === '/sample/question-send' && req.method === 'POST') {
        if (url.search || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        questionSendStage = (questionSendStage + 1) % 6;
        for (const [requestId, id] of questionRequests) {
          const receipt = receipts.get(requestId);
          if (['reserved', 'uncertain'].includes(receipt.state) && [3, 4].includes(questionSendStage)) {
            receipt.state = questionSendStage === 3 ? 'uncertain' : 'delivered'; questionMessages.set(id, receipt.state);
          }
        }
        return json(200, { label: `합성 답변: ${questionSendLabels[questionSendStage]} · 실제 전송 없음` });
      }
      if (path === '/sample/questions' && req.method === 'POST') {
        questionStage = (questionStage + 1) % 5;
        return json(200, { label: ['합성 질문: 전체', '합성 질문: 최근 구간', '합성 질문: 최근 구간 0개', '합성 질문: 줄 한도 오류', '합성 질문: 최근 구간 로딩'][questionStage] });
      }
      if (path === '/sample/usage' && req.method === 'POST') {
        if (url.search || req.url.includes('?') || !input || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        usageStage = (usageStage + 1) % 13;
        return json(200, { label: `합성 사용 한도 단계 ${usageStage} · 실제 계정 값 아님` });
      }
      if (path === '/api/usage' && req.method === 'GET') {
        if (url.search || req.url.includes('?')) return json(400, { error: 'INVALID_QUERY' });
        const now = Date.now(), old = usageStage === 5 || usageStage === 6;
        const window = (remainingPercent, windowDurationMins) => ({ remainingPercent, windowDurationMins, resetsAt: Math.floor(now / 1000) + (usageStage === 6 ? -30 : windowDurationMins * 60) });
        const balance = usageStage === 1 ? '0' : usageStage === 7 ? '42.125' : usageStage === 8 ? null : usageStage === 9 ? '-1e999' : usageStage === 10 ? '0.000000000000000001' : '1234.567890123456789012';
        const credits = usageBuckets({ rateLimits: { credits: { hasCredits: usageStage !== 1, unlimited: usageStage === 8, balance } } })[0].credits;
        const buckets = [{ id: 'codex', label: 'Codex · 합성 샘플', primary: window(usageStage === 1 ? 0 : 72, 300), secondary: window(40, 10080), credits }];
        if (usageStage === 2) buckets.push({ id: 'bucket-2', label: '추가 한도 2 · 합성 샘플', primary: window(100, 90), secondary: null, credits: null }, { id: 'bucket-3', label: '추가 한도 3 · 합성 샘플', primary: window(null, 1440), secondary: window(12.5, 60), credits: { hasCredits: true, unlimited: null, balance: null } });
        const fx = { source: 'frankfurter', base: 'USD', quote: 'KRW', state: usageStage === 11 ? 'unavailable' : usageStage === 12 ? 'stale' : 'ready',
          rate: usageStage === 11 ? null : '1339.49', date: usageStage === 11 ? null : new Date(now - (usageStage === 12 ? 2 * 86400000 : 0)).toISOString().slice(0, 10),
          checkedAt: usageStage === 11 ? null : now - (usageStage === 12 ? 2 * 86400000 : 0), stale: usageStage === 12, refreshAfter: now + 86400000 };
        const tokenActivity = { source: 'pc-codex-account-activity', state: usageStage === 3 ? 'unknown' : usageStage === 4 ? 'unsupported' : usageStage === 5 ? 'unavailable' : 'ready',
          checkedAt: usageStage === 4 ? null : now - (old ? 120000 : 0), attemptedAt: now, refreshAfter: now + 60000, stale: old,
          lifetimeTokens: [3, 4].includes(usageStage) ? null : usageStage === 1 ? 0 : usageStage === 7 ? 321 : 1234567,
          peakDailyTokens: [3, 4].includes(usageStage) ? null : 45678, daily: [3, 4].includes(usageStage) ? [] : [{ startDate: '2026-06-18', tokens: usageStage === 1 ? 0 : 12345 }] };
        if (usageStage === 2) { tokenActivity.lifetimeTokens = null; buckets[0].primary.resetsAt = null; }
        return json(200, { tokenActivity, fx, source: 'pc-codex', state: usageStage === 3 ? 'unknown' : usageStage === 4 ? 'unsupported' : usageStage === 5 ? 'unavailable' : 'ready', checkedAt: usageStage === 4 ? null : now - (old ? 120000 : 0), attemptedAt: now, refreshAfter: now + 60000, stale: old, resetAvailableCount: usageStage === 3 || usageStage === 4 || usageStage === 9 ? null : usageStage === 1 ? 0 : usageStage === 7 ? 3 : 7, buckets: usageStage === 3 || usageStage === 4 ? [] : buckets });
      }
      if (path === '/api/diagnostics' && req.method === 'GET') {
        if (url.search) return json(400, { error: 'INVALID_QUERY' });
        if (diagnosticStage === 2) return json(503, { error: 'DESKTOP_NOT_AVAILABLE' });
        return json(200, { bridge: 'available', desktop: diagnosticStage ? 'unavailable' : 'available', readonly: diagnosticStage ? 'unavailable' : 'available', checkedAt: Date.now(), desktopSuccessAt: diagnosticStage ? null : Date.now(), readonlySuccessAt: diagnosticStage ? null : Date.now() });
      }
      if (path === '/sample/reveal' && req.method === 'POST') {
        if (url.search || !input || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        revealStage = (revealStage + 1) % 4;
        const turn = turns.get('sample-10')[0];
        turn.items = turn.items.filter(i => i.id !== 'smooth-answer');
        if (revealStage) turn.items.push({ id: 'smooth-answer', type: 'agentMessage', text: revealText + (revealStage >= 2 ? '\n\n추가로 받은 샘플 문장입니다. 같은 메시지 뒤에 이어지며, 같은 조회 결과가 반복되어도 표시를 다시 시작하지 않습니다.' : '') });
        turn.status = revealStage === 3 ? 'completed' : 'inProgress'; rows[10].status = revealStage === 3 ? 'idle' : 'active';
        return json(200, { label: ['샘플 초기화 · 다음 클릭으로 새 답변', '샘플 새 본문 준비 · 다음 정기 조회에서 수신', '샘플 덧붙임 준비 · 다음 정기 조회에서 수신', '샘플 완료 · 남은 표시는 즉시'][revealStage] });
      }
      if (path === '/sample/size' && req.method === 'POST') {
        sizeLimit = !sizeLimit;
        return json(200, { label: sizeLimit ? '긴 기록 샘플: 최소 조회도 크기 한도 초과' : '긴 기록 샘플: 출력 생략 후 정상 · 다시 확인 가능' });
      }
      const resultFile = /^\/api\/files\/([gh]{43})(\/info)?$/.exec(path);
      if (req.method === 'GET' && resultFile) {
        if (url.search || !sampleFiles.has(resultFile[1])) return json(400, { error: 'INVALID_QUERY' });
        const file = sampleFiles.get(resultFile[1]);
        if (resultFile[2]) return json(200, { name: file.name, mime: file.mime, size: file.data.length, revision: 'b'.repeat(64), threadId: 'sample-7' });
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.data.length, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name) }); return res.end(file.data);
      }
      const videoRequest = /^\/api\/media\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (req.method === 'GET' && videoRequest && [video.url, '/api/media/' + 'e'.repeat(43), '/api/media/' + 'f'.repeat(43)].includes(path)) {
        if (url.search) return json(400, { error: 'INVALID_QUERY' });
        if (path.endsWith('e'.repeat(43)) || (path.endsWith('f'.repeat(43)) && videoRetry++ === 0)) return json(404, { error: 'MEDIA_MISSING' });
        return serveVideo(fixtureMedia, fixtureSession, video.url.split('/').pop(), req, res);
      }
      const media = /^\/api\/media\/([abc]{43})$/.exec(path);
      if (req.method === 'GET' && media) {
        if (url.search) return json(400, { error: 'INVALID_QUERY' });
        if (media[1] === 'b'.repeat(43) || (media[1] === 'c'.repeat(43) && retryAttempt++ === 0)) return json(404, { error: 'MEDIA_MISSING' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': raster.length }); return res.end(raster);
      }
      if (path === '/sample/runtime' && req.method === 'POST') {
        if (url.search || !input || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        runtimeMissing = !runtimeMissing;
        return json(200, { label: runtimeMissing ? '합성 질문 조회 연결: 실행 파일 없음 · 입력 유지/읽기만 재확인' : '합성 질문 조회 연결: 복구 · 같은 선택지 확인' });
      }
      if (path === '/sample/recency' && req.method === 'POST') {
        if (url.search || !input || Object.keys(input).length) return json(400, { error: 'INVALID_QUERY' });
        const row = rows[20]; row.updatedAt = Math.max(...rows.map(r => workTime(r.updatedAt) ?? 0)) / 1000 + 1;
        return json(200, { label: '합성 21번째 대화 작업 시각 갱신 · 목록 맨 위 · 실제 Codex 작업 아님' });
      }
      if (path === '/sample/activity' && req.method === 'POST') {
        stage = stage % 3 + 1;
        const row = rows[2];
        if (stage === 1) {
          scenario++; row.status = 'active';
          turns.get(row.id).unshift({ id: `scenario-${scenario}`, status: 'inProgress', items: [{ id: 'sample-user', type: 'userMessage', text: '샘플 작업을 시작합니다.' }] });
        } else if (stage === 2) turns.get(row.id)[0].items.push({ id: 'progress', type: 'agentMessage', phase: 'commentary', text: '샘플 작업의 진행 메시지가 도착했습니다. 목록에서 새 응답을 확인해 주세요.' });
        else {
          turns.get(row.id)[0].items.push({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: '샘플 작업을 마쳤습니다. 실제 Codex에는 접근하지 않았습니다.' });
          turns.get(row.id)[0].status = 'completed'; row.status = 'idle';
        }
        row.updatedAt = Date.now() / 1000;
        return json(200, { label: ['작업 중 · 아직 답변 없음', '진행 답변 도착 · 다른 대화/목록에서 확인', '작업 종료 · 최종 답변 도착'][stage - 1] });
      }
      if (path === '/api/activity' && req.method === 'GET') return json(200, { available: true, checkedAt: Date.now(), scope: '샘플 활동',
        data: rows.map(row => ({ ...row, desktopUnread: false, stale: false, previewState: 'ready', ...preview(row.id) })) });
      if (path === '/api/threads') {
        const search = url.searchParams.get('search') || '', cursor = Number(url.searchParams.get('cursor') || 0);
        const matched = rows.filter(r => r.title.includes(search)).sort(compareWork);
        return json(200, { data: matched.slice(cursor, cursor + 15), nextCursor: matched.length > cursor + 15 ? String(cursor + 15) : null,
          scope: 'all-stored', searchScope: '샘플 제목 검색 · 실제 대화 없음' });
      }
      const match = /^\/api\/threads\/(sample-\d+)(\/(?:history|questions))?$/.exec(path);
      if (match && req.method === 'GET') {
        const row = rows.find(r => r.id === match[1]); if (!row) return json(404, { error: 'ROUTE_NOT_FOUND' });
        if (!match[2]) return json(200, { thread: row, capability, sending: false, uncertain: false });
        if (match[2] === '/questions') {
          if (url.search) return json(400, { error: 'INVALID_QUERY' });
          if (row.id === 'sample-5' && runtimeMissing) return json(200, { state: 'unavailable', reason: 'runtime-unavailable', data: [] });
          const questions = questionsWithReceipts();
          const scoped = questionStage === 1 ? { ...questions, coverage: 'recent', reason: 'recent-window' } : questionStage === 2 ? { state: 'ready', coverage: 'recent', reason: 'recent-window', data: [] } : questionStage === 3 ? { state: 'unavailable', reason: 'line-too-large', data: [] } : questionStage === 4 ? { state: 'loading', coverage: 'recent', reason: 'scan-in-progress', data: [] } : questions;
          return json(200, row.id === 'sample-5' ? scoped : { state: row.id === 'sample-6' ? 'unavailable' : 'ready', data: [] });
        }
        if (row.id === 'sample-3' && sizeLimit) return json(502, { error: 'HISTORY_SIZE_LIMIT' });
        const cursor = url.searchParams.get('cursor'), values = turns.get(row.id);
        if (row.id === 'sample-5' && !cursor) {
          const progress = values[0].items.find(item => item.id === 'progress-2');
          if (progress) progress.text = `새 진행 메시지 ${++questionUpdate} · 질문 선택과 직접 입력이 유지되는지 확인해 주세요.`;
        }
        if (row.id === 'sample-4' && !cursor) {
          const item = { id: 'live-update', type: 'agentMessage', text: `샘플 진행 메시지 ${++videoUpdate} · 재생 위치를 유지하는지 확인해 주세요.` };
          if (values[0].items.at(-1)?.id === item.id) values[0].items[values[0].items.length - 1] = item; else values[0].items.push(item);
        }
        const index = cursor ? values.findIndex(t => `before-${t.id}` === cursor) + 1 : 0;
        if (cursor && index === 0) return json(400, { error: 'INVALID_QUERY' });
        return json(200, { data: values.slice(index, index + 1), nextCursor: index + 1 < values.length ? `before-${values[index].id}` : null,
          status: row.status, outputLimit: row.id === 'sample-3' ? 0 : 1500, outputsOmitted: row.id === 'sample-3', ...(cursor ? {} : preview(row.id)) });
      }
      if (path === '/api/send' && req.method === 'POST') {
        if (!turns.has(input.threadId)) return json(400, { error: 'INVALID_THREAD_ID' });
        if (!receipts.has(input.requestId)) {
          if (input.question) {
            const q = input.threadId === 'sample-5' && questionsWithReceipts().data.find(q => q.id === input.question.id && q.sourceKey === input.question.sourceKey && ['unconfirmed', 'historical'].includes(q.state));
            if (!q) return json(409, { error: 'QUESTION_SOURCE_CHANGED' });
            if (['delivered', 'reserved', 'uncertain'].includes(q.messageState)) return json(409, { error: q.messageState === 'delivered' ? 'QUESTION_MESSAGE_DELIVERED' : 'QUESTION_MESSAGE_UNCONFIRMED' });
            if (questionSendStage === 1) { questionMessages.set(q.id, 'rejected'); return json(409, { error: 'DESKTOP_TOOL_UNSUPPORTED' }); }
            questionRequests.set(input.requestId, q.id);
          }
          turns.get(input.threadId).unshift({ id: `sample-${receipts.size}`, status: 'completed', startedAt: Date.now() / 1000,
            items: [{ id: 'mock-user', type: 'userMessage', text: String(input.text).slice(0, 16000) }, { id: 'mock-answer', type: 'agentMessage', text: '샘플 서버 메모리에만 반영했습니다. PC Codex에는 전송하지 않았습니다.' }] });
          const state = input.question && questionSendStage === 2 ? 'reserved' : input.question && questionSendStage === 3 ? 'uncertain' : 'delivered';
          receipts.set(input.requestId, { requestId: input.requestId, threadId: input.threadId, state });
          if (input.question) questionMessages.set(input.question.id, state);
          for (const a of input.attachments || []) usedUploads.add(a.handle);
        }
        return json(200, receipts.get(input.requestId));
      }
      if (path.startsWith('/api/requests/')) { const r = verifyCandidate(receipts.get(path.split('/').pop())); return json(r ? 200 : 404, r || { error: 'REQUEST_NOT_FOUND' }); }
      json(404, { error: 'ROUTE_NOT_FOUND' });
    } catch { json(400, { error: 'PREVIEW_INVALID_REQUEST' }); }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createPreview(); server.listen(47832, '127.0.0.1', () => console.log('SAMPLE ONLY: http://127.0.0.1:47832 — no real Codex connection'));
}
