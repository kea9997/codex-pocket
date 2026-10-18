# Codex Pocket

Use your existing **Windows Codex desktop conversations** from an Android phone over your own Tailscale network. Read history, send an explicit follow-up to the same desktop-owned chat, or explicitly create a new chat. This is not a second chatbot, remote desktop, conversation clone or arbitrary RPC proxy.

**Unofficial community source app, MIT. Not affiliated with or endorsed by OpenAI.** The interface is currently Korean. [한국어 안내](GUIDE.ko.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Provenance](THIRD-PARTY-NOTICES.md).

## What is included

Full Node bridge/auth server, web interface, Windows encrypted account broker/helpers, Android WebView/notifications/document picker/result sharing sources, portable setup/build scripts and synthetic tests. No npm dependencies, vendor bundles, generated OpenAI schemas, credentials, real chats, APKs or signing keys are shipped. A separate loopback-only synthetic demo is secondary, not a substitute for the full app.

Features include desktop-owned history/pagination/search, explicit same-ID sends and new chats, per-chat next-send model/effort choices, drafts/attachments, image/video viewing, bounded result file download/share, activity/favorites/notifications, account quota/reset times/token activity, encrypted saved accounts and guarded account switching/recovery. Stops, approvals and blocking PC questions remain **PC-only**.

## Supported stack and limits

- Windows 11, same logged-in Windows user as the installed Codex desktop app, **Node.js22+**, **PowerShell7+** (`pwsh.exe` on PATH or explicit Node path in scripts).
- Stock Codex desktop installation with exactly one same-user `codex-app-tools-*` pipe and the compatible Desktop tool catalog. These interfaces may change; unsupported/missing/ambiguous installations fail closed. The readonly CLI resolver supports only the stock per-user `AppData/Local/OpenAI/Codex/bin/<16 lowercase hex>/codex.exe` layout. Custom/system installs are not silently substituted.
- Tailscale installed and already connected on PC/phone, stable IPv4 addresses in **100.64.0.0/10**. Tailnet policies must permit only the intended phone peers to the bridge port. Current stable Tailscale clients are recommended; no specific minimum release has been established by this source review.
- Android8/API26+ with an up-to-date Android System WebView; notification permission is requested on Android13+. Target/compile API36, JDK17 and Android SDK Build Tools36.0.0. Other tool versions are not claimed tested.
- Account save/switch supports the recognized stock **file-based** Codex login configuration only. Keyring, managed/admin policies, unsupported/custom homes or storage modes are rejected, never automatically rewritten. First login is human-controlled, not a browser OAuth fallback.

There is **no universal APK**. Each installer builds an APK with their exact host/port and their own signing identity. The public package `dev.codexpocket.app` is distinct from the original app; protocol2 and exact `CodexPhone/2 CodexPhoneApp/0.3.0` layout marker remain for compatibility. Legacy Java source directory names do not define the APK package. App0.3.0/versionCode4, combined web revision2026-10-18-pending-1.

Portability changes require independent Windows parse/helper, SDK build/sign/install, network and physical-device review before a release. Synthetic Node tests do **not** prove real account switching, delivery, CSS geometry, WebView decoding or installability. Physical foldable/IME testing remains an operator check; no broad-device compatibility claim is made.

## 1. Configure your own bridge

Extract/clone to an ordinary directory (spaces supported); keep private data **outside** the checkout and MSIX-virtualized AppData. Open PowerShell7 as your normal Windows user, not administrator. No execution-policy bypass is required or performed by these scripts.

The following addresses are **invented examples**, not defaults that start a service. Replace them with your own stable tailnet PC and phone addresses. Create a dedicated ordinary Codex desktop controller conversation and obtain its UUID from Codex's own supported UI/metadata; the app never creates, guesses or takes over a controller. Keep that conversation available on the PC. Do not paste real IDs/configuration into issues.

```powershell
$pc = '100.64.0.10'       # replace: your PC Tailscale IPv4
$phone = '100.64.0.11'    # replace: exact phone Tailscale IPv4
$controller = Read-Host 'Your dedicated desktop controller conversation UUID'
$private = Join-Path $env:USERPROFILE '.codex-pocket'
.\scripts\Setup-Bridge.ps1 -HostIPv4 $pc -PhonePeers @($phone) -ControllerThreadId $controller -PrivateDirectory $private -WhatIf
# After reviewing the dry-run:
.\scripts\Setup-Bridge.ps1 -HostIPv4 $pc -PhonePeers @($phone) -ControllerThreadId $controller -PrivateDirectory $private
```

Setup validates exact host/peer/port/UUID, creates a CurrentUser-owned ACL-protected directory and **creates** `bridge.json` with a protected CurrentUser-only file DACL, without overwriting. The private directory must be new/empty on first use; `.pocket-private` marks this app's dedicated store. Existing nonempty unmarked directories, drive/profile roots, source and AppData are refused rather than imported or repurposed. Config keys are exactly `host`, `port`, `peers`, `controllerThreadId`. Port defaults47831 (allowed1024–65535), 1–16 unique concrete phone peers, host not in peers. It does not start a service, login, alter Tailscale/firewall/ExecutionPolicy, install a startup task or import someone else's state. Startup fails if unconfigured. To change config, stop this bridge, review/edit your private file locally, then rebuild Android if host/port changed. Preserve ownership/ACL; do not publish the file.

## 2. Run and pair

Keep Codex desktop open and logged in. Node is discovered on PATH or supplied with `-NodePath <absolute node.exe>`. Run foreground first to review sanitized errors:

```powershell
.\scripts\Start-Bridge.ps1 -Foreground -PrivateDirectory $private
# Alternative: omit -Foreground for a hidden child wrapper.
# In another PowerShell7 window:
.\scripts\Request-Pairing.ps1 -PrivateDirectory $private
```

Read the one-time16hex-digit code **locally** from your private `pairing.json` (never send it to logs/issues). Open the exact configured `http://<PC-tailnet-IP>:<port>/` in the built Android app and enter it. Pairing is single-use, valid24hours; a paired session lasts7days. Pairing/phone auth is separate from Codex accounts: switching Codex accounts does not revoke phone pairing. Pairing renewal is an explicit private request; scripts never print the code. PC account UI can be opened with `scripts/Open-Accounts.ps1 -PrivateDirectory $private`; that browser may need its own pairing.

```powershell
.\scripts\Stop-Bridge.ps1 -PrivateDirectory $private
# Optional, user-invoked registration only; no overwrite and no immediate start:
.\scripts\Install-LoginTask.ps1 -PrivateDirectory $private -WhatIf
.\scripts\Install-LoginTask.ps1 -PrivateDirectory $private
```

The optional task is named `CodexPocket-Bridge`, interactive/current user/Limited. Existing task causes refusal; review it manually, do not replace unrelated tasks. Graceful stop uses only this configured bridge's private stop control; stale/ambiguous locks require manual review, never PID killing. For removal, stop this bridge and remove only the optional task you installed through Windows Task Scheduler. Private data/signing keys are not automatically deleted.

## 3. Build your own Android APK

On Windows, use **ASCII-only paths** for the source checkout, JDK, SDK and private build directory; spaces are supported. The reviewed Android toolchain failed to open an existing resource directory when its path contained Korean characters. For a non-ASCII Windows user profile, choose a new dedicated ASCII private directory outside the checkout/AppData, for example `D:/CodexPocketPrivate`, and pass it explicitly. Do not rename your Windows account or reuse an unrelated directory. Unicode Android build paths remain unsupported.

Install JDK17 and SDK platform36/build-tools36.0.0 through your normal trusted toolchain. Set `JAVA_HOME` and `ANDROID_SDK_ROOT` (or `ANDROID_HOME`), or pass explicit `-JdkPath`/`-SdkPath`. No Gradle/download/global cache or unrelated project environment is required. All generated config/resources/classes live in a fresh GUID build directory under your protected private directory; source resources are never changed.

```powershell
.\scripts\Build-Android.ps1 -HostIPv4 $pc -Port 47831 -PrivateDirectory $private -Unsigned
# After unsigned compilation review, build signed with your private identity:
.\scripts\Build-Android.ps1 -HostIPv4 $pc -Port 47831 -PrivateDirectory $private
```

`tools/check-android.mjs -HostIPv4 <IP> ...` is an optional Node entrypoint for the same unsigned builder. Signed build creates a random per-installer PKCS12 key/password under the protected directory if absent. No shared key/password is included. Back these up **privately**: future updates must use the same key; losing it requires uninstalling the old APK (and its app data). Inconsistent signing state refuses to overwrite; a per-store mutex serializes cooperating builds and canonical CurrentUser-only single-link read leases hold both files without write/delete sharing while signing. The script verifies signature and alignment and reports the APK SHA256/path. It does not install or deliver anything. Transfer the signed APK through your own trusted channel, verify its hash, then install manually using Android's per-source install UI. No package-install or broad storage permission is added. Unsigned APK is for compilation review, not installation.

Only the exact build-time IPv4 permits cleartext in Android's network-security config; native origin/port/URL checks use the same generated constants. There is no URL editor, dynamic DNS, wildcard, public/LAN binding, JavaScriptInterface or arbitrary native command/path bridge. Traffic is HTTP **inside Tailscale's encrypted tailnet**; never expose via reverse proxy, serve/funnel or a public port.

## Everyday behavior and safety

- Default model/effort is **keep PC settings** (omit both). Advertised choices are revalidated on explicit send/create; the current desktop model/effort is not guessed. Public prompts do not inject a developer's private workflow; your Codex AGENTS/settings remain yours.
- Only **unanswered** questions appear by default. Native exact replies, same-session/source server delivered receipts and exact local delivered receipts remove answered cards/count immediately. Options/direct text are available without opt-in; selection never sends. Ended/older async questions can still be unanswered; current PC waiting is not claimed. Message delivery is **not** native form completion or PC approval.
- Reserved/uncertain/acknowledged are not known answers. Source errors/partial scans preserve meaningful input/recovery; native answers remove obsolete question editors without changing the ordinary draft. No arbitrary prose/reasoning is scanned for answers.
- Every write is explicit, destination-bound and journaled with an idempotent UUID/hash-only association. Lost acknowledgement becomes `uncertain`; no auto replay. Inspect the real chat before deliberately unlocking. Unlock means acknowledged local recovery, not delivery or cancellation. Attachments are immutable/hash-checked and never automatically replayed.
- Stored history uses a readonly child allowlist. Desktop-owned sends/newchats use Desktop tools only, never standalone resume/fork/start. Reasoning bodies are not read. Recent50/pinned activity is not proof all PC work is idle.
- Quota windows, spendable credits, reset opportunities and **account token activity** are distinct. Detail shows cumulative plus latest explicit date when available; no today/UTC assumption or percentage-to-token conversion. Countdown is a local display, not proof of quota renewal. Exact credit decimals/reference-price/FX details remain accessible behind disclosure, with actionable stale/missing warnings outside. Reference KRW conversion is approximate, not an invoice. Only a public USD/KRW reference request leaves the bridge for FX; no account data is attached.
- Account profiles are CurrentUser DPAPI-encrypted on the PC with strict ACL/canonical non-link file checks. Human device-code login uses the official site and an isolated child home; tokens never go to the web. Switching requires explicit selection/idle confirmation, protects busy/unknown requests and drafts, waits only for exact owned processes, and preserves encrypted recovery. No force kill, unsupported hot switch or global storage-policy rewrite. Desktop internal-account state is not independently proven by shared-login success. Follow recovery UI; do not delete journals or overwrite competing login writers.
- Native notifications are opt-in, visible foreground work, permission/channel gated, redacted on lock screen and nonsticky. OS sleep/tailnet/force-stop may delay them. Document picker uses read-only temporary grants; result sharing uses bounded private staging and explicit SAF/share. Back/fullscreen/insets/IME have document/lifecycle guards; browser UA is layout-only, never auth.

## Tests and source review

```sh
node --test tests/*.test.mjs tools/public-preview/demo.test.mjs
node --check server/config.mjs
node tools/source-package.mjs
```

Default tests are synthetic, no login/native/account helper/GUI/service actions. Raster/video tests create unique generated-only `codex-pocket-raster-test-*` directories under the current user's home (outside checkout/AppData) and remove only those directories afterward; other fixtures use unique OS temporary directories. **Six Windows helper tests are opt-in**: after reviewing `scripts/Test-Account*.ps1`, an operator can set `$env:CODEX_POCKET_WINDOWS_QA='1'` in a dedicated shell and run `node --test tests/accounts-windows.test.mjs`. They use unique temporary fixtures (including DPAPI/crash/process tests), not live profiles. Do not treat skipped checks as passes. PowerShell parser review and actual build/device acceptance steps are in [VALIDATION.md](VALIDATION.md).

`tools/source-package.mjs` checks the explicit source manifest, regular non-linked text, private-residue/credential-shaped assignments and unexpected artifacts. With a new absolute destination argument it prepares an explicit full-source tree plus hash manifest, never overwrites/deletes and never publishes. Review every file manually before making a ZIP/public repository; scanning is not a privacy/license guarantee. Build outputs/private state/signing must stay outside the checkout. The checker ignores only Git's own metadata directory; any other unlisted file refuses export. Exported `SOURCE-HASHES.json` is accepted only when every entry matches the reviewed bytes. Narrow literal exceptions cover the reviewed inert credential fixtures and config boundary-address tests, not entire test folders; synthetic absolute paths are permitted while known developer identities and unknown tailnet addresses are blocked.

For a completely disconnected UI review, `node tools/ui-preview.mjs` serves synthetic samples at http://127.0.0.1:47832. The independent export `node tools/export-public-preview.mjs <new-absolute-directory>` runs as `node demo.mjs` on47833 with no Codex connection. Neither demo is authentication or a network deployment. See the dated [independent validation record](VALIDATION.md#independently-observed-checks--2026-10-18); automated/demo checks do not imply physical-device or live-account acceptance.
