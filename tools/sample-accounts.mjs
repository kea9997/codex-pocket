// Loopback preview only. Metadata and simulated transitions; no credential files, processes, login or RPC.
import { randomUUID } from 'node:crypto';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const labels = ['합성 미지원 환경 · 전환 차단', '합성 저장 계정 · 전환 선택 가능', '합성 기기 코드 대기 · 실제 로그인 금지', '합성 계정 추가 완료 · 자동 활성화 없음', '합성 전환 처리 중 · 전송 보호', '합성 PC 작업 중 · 전환 차단', '합성 로그인 만료 · 직접 재시도', '합성 전환 복구 필요 · 전송 보호', '합성 재시작/공유 로그인 확인 완료'];
export class SampleAccounts {
  constructor() {
    this.revision = randomUUID(); this.stage = 0; this.profiles = [
      { id: randomUUID(), label: '[샘플] 개인', email: 'personal@example.invalid', plan: 'plus', savedAt: 1, current: true },
      { id: randomUUID(), label: '[샘플] 작업 공간 · 아주 긴 계정 이름', email: 'workspace-long-name@example.invalid', plan: 'team', savedAt: 2, current: false }
    ];
    this.operation = null; this.actions = new Map();
  }
  view() {
    const busy = [2, 4].includes(this.stage), current = this.profiles.find(p => p.current);
    return { revision: this.revision, supported: true, switchSupported: this.stage !== 0, switchReason: this.stage === 0 ? 'ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE' : null,
      busy, recovery: this.stage === 7, error: this.stage === 5 ? 'ACCOUNT_TASKS_ACTIVE' : this.stage === 6 ? 'ACCOUNT_LOGIN_EXPIRED' : this.stage === 7 ? 'ACCOUNT_RECOVERY_REQUIRED' : null,
      verification: this.stage === 8 ? 'shared-login-and-restarted-app' : 'shared-cache-only', current: current ? { email: current.email, plan: current.plan, profileId: current.id } : null,
      profiles: this.profiles, operation: this.operation };
  }
  setStage(stage) {
    if (stage === 3 && this.stage === 2 && this.pendingLabel && this.profiles.length < 8) {
      this.profiles.push({ id: randomUUID(), label: this.pendingLabel, email: 'added@example.invalid', plan: 'plus', savedAt: Date.now(), current: false });
      this.pendingLabel = null;
    }
    this.stage = stage;
    this.operation = stage === 2 ? { id: randomUUID(), kind: 'login', state: 'waiting', device: { url: 'https://auth.openai.com/codex/device', code: 'DEMO-0000' }, expiresAt: Date.now() + 15 * 60000 }
      : stage === 4 ? { id: randomUUID(), kind: 'switch', state: 'working' }
        : stage === 6 ? { id: randomUUID(), kind: 'login', state: 'failed', error: 'ACCOUNT_LOGIN_EXPIRED' }
          : [3, 8].includes(stage) ? { id: randomUUID(), kind: stage === 3 ? 'login' : 'switch', state: 'completed' } : null;
    if ([7, 8].includes(stage)) this.revision = randomUUID();
    return { label: '[샘플] ' + labels[stage] };
  }
  handle(path, method, input, csrf, query) {
    if (!['/sample/accounts', '/api/accounts'].includes(path) && !path.startsWith('/api/accounts/')) return null;
    const reply = (status, data) => ({ status, data }), error = (code, status = 409) => reply(status, { error: code });
    if (query) return error('INVALID_QUERY', 400);
    if (method === 'GET' && path === '/api/accounts') return reply(200, this.view());
    if (method !== 'POST') return error('ROUTE_NOT_FOUND', 404);
    if (csrf !== 'sample-not-a-credential') return error('CSRF_REJECTED', 403);
    if (path === '/sample/accounts') {
      if (Object.keys(input).length) return error('INVALID_INPUT', 400);
      return reply(200, this.setStage((this.stage + 1) % labels.length));
    }
    const action = path.slice('/api/accounts/'.length), fields = {
      presence: ['pageId', 'blocked', 'visible', 'closed'], save: ['operationId', 'label'], login: ['operationId', 'label'], cancel: ['operationId'],
      switch: ['operationId', 'profileId', 'confirmed', 'pageId', 'pcTasksComplete'], recover: ['operationId', 'mode', 'confirmed', 'pageId', 'pcTasksComplete'], rename: ['operationId', 'profileId', 'label'], remove: ['operationId', 'profileId', 'confirmed']
    }[action];
    if (!fields) return error('ROUTE_NOT_FOUND', 404);
    if (Object.keys(input).some(k => !fields.includes(k))) return error('INVALID_INPUT', 400);
    if (action === 'presence') return uuid(input.pageId) && typeof input.blocked === 'boolean' && typeof input.visible === 'boolean' ? reply(200, { revision: this.revision, busy: this.view().busy, recovery: this.stage === 7 }) : error('INVALID_INPUT', 400);
    if (!uuid(input.operationId)) return error('INVALID_INPUT', 400);
    if (action === 'cancel') { this.setStage(1); return reply(200, this.view()); }
    if (this.actions.has(input.operationId)) return reply(200, this.actions.get(input.operationId));
    if (this.view().busy) return error('ACCOUNT_BUSY');
    const row = this.profiles.find(p => p.id === input.profileId);
    if (['remove', 'rename', 'switch'].includes(action) && !row) return error('ACCOUNT_PROFILE_NOT_FOUND', 404);
    if (['remove', 'switch', 'recover'].includes(action) && input.confirmed !== true) return error('ACCOUNT_CONFIRM_REQUIRED', 400);
    if (['save', 'login', 'rename'].includes(action) && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 40)) return error('ACCOUNT_LABEL_INVALID', 400);
    if (['save', 'login'].includes(action) && this.profiles.length >= 8) return error('ACCOUNT_PROFILE_LIMIT');
    if (action === 'login') { this.pendingLabel = input.label; this.setStage(2); }
    if (action === 'save') { this.profiles.push({ id: randomUUID(), label: '[샘플] ' + input.label.slice(0, 34), email: 'saved@example.invalid', current: false, plan: 'plus', savedAt: Date.now() }); this.setStage(3); }
    if (action === 'rename') row.label = input.label;
    if (action === 'remove') this.profiles = this.profiles.filter(p => p !== row);
    if (['switch', 'recover'].includes(action)) {
      if (input.pcTasksComplete !== true || !uuid(input.pageId)) return error('ACCOUNT_CONFIRM_REQUIRED', 400);
      if (this.stage === 0) return error('ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE');
      if (this.stage === 5) return error('ACCOUNT_TASKS_ACTIVE');
      if (action === 'switch') for (const p of this.profiles) p.current = p === row;
      this.setStage(8);
    }
    if (action !== 'login') this.operation = { id: input.operationId, kind: action, state: 'completed' };
    const result = this.view(); this.actions.set(input.operationId, structuredClone(result));
    while (this.actions.size > 32) this.actions.delete(this.actions.keys().next().value);
    return reply(200, result);
  }
}
