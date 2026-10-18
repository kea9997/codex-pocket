'use strict';
// In-memory selections only. Raw File bytes never enter device storage or JSON requests.
class AttachmentQueue {
  constructor({ csrf, epoch, active, changed, expired, revision = () => null, writable = active }) {
    Object.assign(this, { csrf, epoch, active, changed, expired, revision, writable }); this.groups = new Map();
    this.types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };
  }
  rows(key) { return this.groups.get(key) || []; }
  ready(key) { return this.rows(key).every(r => r.status === 'ready' && r.upload.expiresAt > Date.now()); }
  snapshot(key) { if (!this.ready(key)) throw { code: 'UPLOAD_NOT_READY' }; return this.rows(key).map(r => ({ handle: r.upload.handle, sha256: r.upload.sha256, size: r.upload.size })); }
  add(key, files) {
    if (!this.csrf() || !this.writable(key)) return;
    const rows = this.rows(key), picked = Array.from(files || []), all = [...this.groups.values()].flat();
    if (rows.length + picked.length > 6 || new Set([...this.groups.keys(), key]).size > 8 || all.reduce((n, r) => n + r.file.size, 0) + picked.reduce((n, f) => n + f.size, 0) > 160 * 1024 * 1024 || rows.reduce((n, r) => n + r.file.size, 0) + picked.reduce((n, f) => n + f.size, 0) > 40 * 1024 * 1024) { this.changed(key, '최대 6개 · 파일당 20MiB · 요청당 40MiB입니다.'); return; }
    if (picked.some(file => !this.types[file.name.split('.').pop().toLowerCase()] || file.size < 1 || file.size > 20 * 1024 * 1024 || file.name.length > 160 || /[\x00-\x1f\x7f-\x9f/\\:<>"|?*‪-‮⁦-⁩]/.test(file.name))) { this.changed(key, '지원하지 않는 이름·형식·크기입니다. 사진 또는 허용 문서를 골라 주세요.'); return; }
    this.groups.set(key, rows);
    for (const file of picked) rows.push({ file, status: 'waiting', progress: 0 });
    this.pump(); this.changed(key);
  }
  pump() {
    if (navigator.onLine === false) return;
    for (const [key, rows] of this.groups) for (const row of rows) if (row.status === 'waiting') this.start(key, row);
  }
  upload(key, row) {
    if (!this.csrf() || !this.writable(key) || navigator.onLine === false || row.xhr || !this.rows(key).includes(row) || row.status === 'removing' || row.status === 'waiting' || row.upload?.expiresAt > Date.now()) return;
    delete row.upload; row.status = 'waiting'; row.message = '업로드 차례를 기다립니다.';
    this.changed(key); this.pump();
  }
  start(key, row) {
    if (!this.csrf() || !this.writable(key) || row.status !== 'waiting' || row.xhr || !this.rows(key).includes(row)) return;
    if ([...this.groups.values()].flat().filter(r => r.xhr).length >= 2) return;
    const epoch = this.epoch(), xhr = new XMLHttpRequest(); row.xhr = xhr; row.status = 'uploading'; row.progress = 0;
    const current = () => epoch === this.epoch() && this.rows(key).includes(row) && row.xhr === xhr;
    const finish = (status, message) => { if (!current()) return; row.xhr = null; row.status = status; row.message = message; this.changed(key); this.pump(); };
    xhr.open('POST', '/api/uploads'); xhr.withCredentials = true; xhr.timeout = 120000;
    xhr.setRequestHeader('X-Codex-CSRF', this.csrf()); xhr.setRequestHeader('X-Upload-Name', encodeURIComponent(row.file.name));
    if (this.revision()) xhr.setRequestHeader('X-Codex-Account-Revision', this.revision());
    xhr.setRequestHeader('Content-Type', this.types[row.file.name.split('.').pop().toLowerCase()]);
    xhr.upload.onprogress = e => { if (current() && e.lengthComputable) { row.progress = Math.min(100, Math.floor(e.loaded / e.total * 100)); this.changed(key); } };
    xhr.onload = () => {
      if (!current()) return;
      if (xhr.status === 401) { this.expired(); return; }
      let data; try { data = JSON.parse(xhr.responseText); } catch { /* Ambiguous upload leaves staging to expire, never auto replay. */ }
      if (xhr.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(data?.handle) && /^[a-f0-9]{64}$/.test(data?.sha256) && data.size === row.file.size && Number.isFinite(data.expiresAt)) { row.upload = data; finish('ready', 'PC 전송 완료'); }
      else finish('error', data?.error === 'UPLOAD_BUSY' ? '다른 파일을 전송 중입니다. 잠시 후 직접 재시도해 주세요.' : xhr.status === 429 ? 'PC 첨부 보관 한도 · 정리 후 직접 재시도해 주세요.' : xhr.status === 415 ? '파일 형식과 실제 내용이 맞지 않거나 지원하지 않는 파일입니다.' : '업로드 확인 실패 · 자동 재시도하지 않습니다.');
    };
    xhr.onerror = xhr.ontimeout = () => finish('error', '연결 확인 실패 · 파일을 유지합니다. 직접 재시도해 주세요.');
    xhr.onabort = () => finish('cancelled', '업로드 취소 · 보내지 않았습니다.');
    xhr.send(row.file); this.changed(key);
  }
  cancel(row) {
    if (row.xhr) row.xhr.abort();
    else if (row.status === 'waiting') {
      row.status = 'cancelled'; row.message = '업로드 대기 취소 · 보내지 않았습니다.';
      for (const [key, rows] of this.groups) if (rows.includes(row)) this.changed(key);
    }
  }
  async remove(key, row, post) {
    if (!this.active(key) || !this.rows(key).includes(row) || row.status === 'removing') return;
    const epoch = this.epoch(); this.cancel(row);
    if (row.upload) {
      row.status = 'removing'; this.changed(key);
      try { await post(`/api/uploads/${row.upload.handle}/cancel`, {}); }
      catch { if (this.rows(key).includes(row)) { row.status = 'error'; row.message = '삭제 확인 실패 · PC에 보관 중일 수 있습니다. 다시 제거해 주세요.'; this.changed(key); } return; }
    }
    if (epoch !== this.epoch()) return;
    const rows = this.rows(key); if (rows.includes(row)) rows.splice(rows.indexOf(row), 1);
    if (!rows.length) this.groups.delete(key); this.changed(key);
  }
  consume(key, snapshot) {
    const handles = new Set((snapshot || []).map(a => a.handle));
    const rows = this.rows(key).filter(r => !handles.has(r.upload?.handle));
    if (rows.length) this.groups.set(key, rows); else this.groups.delete(key); this.changed(key);
  }
  clear() { const rows = [...this.groups.values()].flat(); this.groups.clear(); for (const row of rows) this.cancel(row); }
}
