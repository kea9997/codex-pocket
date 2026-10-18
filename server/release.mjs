// One static manifest supplies both the document's release script and authenticated metadata.
export const release = Object.freeze({
  revision: '2026-10-18-pending-1',
  notes: Object.freeze([
    '미응답 질문만 표시하고 선택·직접 입력을 바로 제공합니다. 답변 전달이 확인되면 목록에서 제외합니다.',
    '상단에서 각 잔여 한도와 초기화까지의 시간을 함께 봅니다.',
    '계정 토큰 활동은 한도·크레딧과 분리해 누적 또는 제공 날짜로 표시합니다.',
    '미지원·실패·오래된 토큰 값은 별도로 알리며 잔여량을 추정하지 않습니다.',
    '도구의 활동·진단 구분을 정리하고 기존 초안·복구·시스템 여백 보호를 유지합니다.'
  ])
});
export const releaseScript = Buffer.from(`'use strict';globalThis.CodexPhoneRelease=Object.freeze(${JSON.stringify(release)});\n`);
