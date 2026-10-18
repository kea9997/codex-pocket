# Operator validation checklist

No real installation/build/service/task/account/device acceptance is implied by Node tests. Run these steps deliberately on your own supported Windows stack after source review. Use invented QA data and a new private test directory. Do not point synthetic tests at real auth/state/signing. Preserve original installations and unrelated services. Never publish generated outputs or private configuration.

## Independently observed checks — 2026-10-18

Reviewed on Windows with Node24.19.0, PowerShell7.6.5, JDK17.0.20.1 and Android platform36/build-tools36.0.0. These are observations of this source snapshot, not a claim about every installation.

| Check | Observed result |
| --- | --- |
| Full Node suite, Windows synthetic helpers explicitly enabled | 548 passed, 0 failed, 0 skipped; includes121 JS/MJS syntax checks |
| PowerShell scripts / fixed C# lease | 14 parsed; lease compiled |
| Full source export | Explicit inventory, byte/hash identity, privacy preflight and export regression checks passed |
| Windows setup/start/stop in paths with spaces | Fresh private config and marker; health200, five unpaired API401, wrong Origin403; only the QA bridge stopped through its own control file |
| Setup/task dry-run and overwrite guard | No task registration or dry-run config creation; existing configuration refused |
| Synthetic private-file lease | Read succeeded; write/delete/parent rename blocked; hardlink and shared ACL rejected |
| Android unsigned and signed builds in ASCII paths with spaces | Compiled; package dev.codexpocket.app,0.3.0/code4,min26,target36; exact generated host/domain and default cleartext denied |
| Signing | APK v2/v3 signature and zip alignment verified; second signed build retained the same isolated QA key |
| Non-ASCII Android build path | Failed at aapt2; unsupported, use the documented ASCII path setup |

No real account login/switch, real chat creation/send, physical APK installation, foldable/IME/notification acceptance or Android video decoder test was performed for this public snapshot. Signing interruption/concurrent-build and all device recovery combinations remain operator checks below. No operational credentials, signing files, private configuration or actual conversations are part of the distribution.

## Source and synthetic Node

From checkout: `node --test tests/*.test.mjs tools/public-preview/demo.test.mjs`, `node tools/source-package.mjs`. Review all failures/skips, the explicit SOURCE-MANIFEST.json and each file. Syntax checks: `node --check server/config.mjs`, `node --check server/main.mjs`, `node --check tools/source-package.mjs`, `node --check web/app.js`. Automated scan is not a guarantee of privacy, rights or security.

## PowerShell parse only (no script execution)

In PowerShell7 at checkout:

```powershell
$errors = @()
Get-ChildItem -LiteralPath ./scripts -Filter '*.ps1' | ForEach-Object {
    $tokens = $null; $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    $errors += $parseErrors
}
if ($errors.Count) { $errors; throw 'POWERSHELL_PARSE_FAILED' }
```

Review Runtime/Private-State/setup/start/stop/task/build code, supported stack and exact path/quote handling. Also compile the local fixed `Pocket-PrivateFile.cs` via `Add-Type -Path ./scripts/Pocket-PrivateFile.cs` in the reviewed PowerShell7 shell; Node source contracts do not establish C# compilation or Windows handle semantics. Parser success is not operational success.

## Windows synthetic helper opt-in

Review Test-AccountCrash/Publication/Platform/Processes.ps1 and Account-File.cs first. They create their own unique temporary roots and synthetic credentials/process fixtures. In a dedicated PowerShell7 shell, with pwsh.exe on PATH (or an absolute trusted CODEX_POCKET_PWSH):

```powershell
$env:CODEX_POCKET_WINDOWS_QA = '1'
node --test tests/accounts-windows.test.mjs
Remove-Item Env:CODEX_POCKET_WINDOWS_QA
```

Six tests cover CurrentUser DPAPI/publication/CAS/ACL/hardlink/crash recovery and exact process guards; review actual results, do not count skips as passes. No real login/GUI/switch should occur. Unset the opt-in after testing.

## Configuration and dry-run

Choose your exact PC/phone tailnet IPv4s, port and a human-prepared dedicated Desktop controller UUID. Review Setup-Bridge -WhatIf before explicitly writing a NEW normal-user private directory. Confirm only CurrentUser owns/accesses it, no links/hardlinks, and it is outside checkout/AppData. Test invalid host0.0.0.0/LAN/public/DNS/duplicate peers/unknown keys/placeholder IDs are rejected without starting a listener. First use must refuse nonempty unmarked directories and drive/profile roots without repurposing their ACLs; an empty dedicated directory receives `.pocket-private`. Confirm bridge.json has protected CurrentUser-only ownership/DACL and noncanonical/link/hardlink configuration fails closed. Setup twice must refuse existing config. Do not change Tailscale/firewall/ExecutionPolicy automatically.

Start foreground only after explicit review. Confirm one configured listener and sanitized health, unpaired API401, wrong Host/Origin/peer rejection, one-use pairing, CSRF and logout. Pairing code stays private. Verify Start with spaces in checkout/private/Node paths. Stop only this bridge via its configured stop file; ambiguous/stale lock requires manual review, never unrelated PID killing. Install-LoginTask -WhatIf must not create/change state/task; actual optional registration must refuse an existing task and not start immediately. Remove only the task you installed when finished.

## SDK/build/sign/install

Windows Android build paths must currently be ASCII-only (source, JDK, SDK and private work directory). Paths containing spaces were compiled and signed successfully; a Korean private path failed at aapt2 resource compilation despite the directory existing. This is a documented unsupported path condition, not a successful Unicode-path test. Use a new dedicated ASCII private directory for a non-ASCII user profile; do not rename accounts or repurpose existing data.

Use standard JDK17 and platform36/build-tools36.0.0. Run Build-Android -Unsigned with explicit host/port and a new private test directory. Confirm source tree byte-for-byte unchanged; work dir is new/protected; generated PocketConfig.java and network-security XML agree on exact host/port; manifest package/name/version/permissions are correct. Review javac/aapt2/D8/zipalign results. Then explicitly build signed with the same test-user private signing identity; verify apksigner and SHA256, no credentials in output/source. A second build must reuse only that user's key, never another installation's key. Check inconsistent/link/hardlink signing state fails closed. With invented files only, verify PocketPrivateFile.Open holds a canonical read lease rejecting another write/delete/rename and rejects non-CurrentUser ACLs; check a second simultaneous signing build refuses the per-store mutex and interrupted initialization leaves a review-required state rather than overwriting a key. Never commit any APK/key/password.

Manually install the signed APK under dev.codexpocket.app without replacing unrelated apps. Confirm exact origin, blocked other origins/redirects/path/query, no generic native bridge, picker temporary readonly URI grants, hash/size bounds, SAF/share, redacted opt-in notifications, permission denial/recovery and lifecycle guards. Generated two-frame silent sample-video source is original synthetic AVC/MP4; HTTP/container tests do not prove Android decoder playback. Validate actual video playback/seeking/fullscreen and codec failure UI on the device.

## Render and end-to-end acceptance

Review narrow320px/390px, foldable/tablet, desktop, short landscape/IME,44px controls/16px body, safe-area ownership, viewport scrolling, dialogs/copy/editor, Back/Escape/rapid Back, focus/selection/drafts, image/video preservation through polls, offline/hidden/resume/recovery. No screenshots from real conversations in public reports.

Question sample: mixed answered/live/older unanswered, delivered disappears immediately and after reload, selection alone never sends, reserved/uncertain remains guarded, source failure retains input, native reply removes obsolete editor but not ordinary draft. Usage: cumulative+explicit date, zero/unknown/stale/reset passed, disclosure precision and actionable FX warning; no quota/token/billing conflation.

Real sends/new chats, account saving/login/switching and GUI restart require a separate deliberate human action on the operator's own account. Do not manufacture success by sending test messages into existing conversations. Confirm exact destination, explicit model/default omission, uncertain receipt recovery/no replay, account-change isolation, preserved phone pairing and supported file-storage policy. Desktop internal account view, live billing, broad device compatibility and power-loss durability remain distinct from a shared-file success response.

Only after independent review/acceptance should a maintainer publish a reviewed source tree/ZIP. The worker does not create repositories, commit, upload, install or deploy.
