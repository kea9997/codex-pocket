# Contributing

Original project contributions are MIT (LICENSE). Preserve third-party provenance and compatibility trademarks; do not add copied schemas/assets without applicable rights. This project is unofficial.

Use Node22+, PowerShell7 on Windows, JDK17/SDK36 for native review. Default `node --test tests/*.test.mjs tools/public-preview/demo.test.mjs` uses synthetic fixtures; Windows helper tests are explicitly opt-in (`CODEX_POCKET_WINDOWS_QA=1`) after script review. See VALIDATION.md. Test failures/skips and unverified real-device states must be reported honestly. No fake CI badge, coverage, adoption or install-success claims.

Keep code style consistent. Preserve exact origin/peer/auth/CSRF/CSP/path/identity limits, same-desktop-owner dispatch, no standalone writer, explicit send/model selection, question source binding, uncertain receipt recovery, account isolation and no token disclosure. Do not loosen guards to simplify a test or add arbitrary RPC/shell/path bridges. Use actual input/label activation in UI tests; preserve focus/drafts/IME,44px controls/16px body, Back/Escape/insets/media and hidden/resume behavior. Synthetic DOM contracts do not replace rendered/device checks.

All fixtures/examples must be invented (example tailnet100.64.0.10/.11, example UUIDs, `.invalid` email domains). Never send tests into real chats, run login/switch/GUI/service/task/install automatically, or include credentials/config/signing/logs/screenshots from a private installation. Do not log raw native output or reasoning. Keep source packaging manifest current and run its fail-closed checker; do not delete user data to pass it. Review every exported file before release.

Describe the objective, changed trust boundaries, exact checks run and remaining verification in patches. Handle security reports as SECURITY.md describes; no private contact address is assumed. Do not publish a sensitive proof-of-concept or private runtime artifacts in an issue.
