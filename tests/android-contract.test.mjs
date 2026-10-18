import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const java = name => source('android/app/src/main/java/kr/optiwork/codexphone/' + name + '.java');
// Source contracts complement SDK compilation; they are not Android runtime/permission/decoder verification.
test('system attachment picker is readonly/trusted-context-only with bounded serial callbacks, URI authorities and document size checks', () => {
  const picker = java('AttachmentPicker'), activity = java('MainActivity');
  for (const guard of ['Intent.ACTION_OPEN_DOCUMENT', 'Intent.CATEGORY_OPENABLE', 'Intent.FLAG_GRANT_READ_URI_PERMISSION', 'DocumentsContract.isDocumentUri(activity, uri)', 'openAssetFileDescriptor(uri, "r")', 'uri.getQuery() != null', 'uri.getFragment() != null', 'uri.getUserInfo() != null', 'uri.toString().length() > 2048', '!seen.add(uri.toString())', 'fd.getLength() > 20L * 1024 * 1024', 'fd.getLength() == 0', 'getItemCount() > maximum', 'MODE_OPEN_MULTIPLE ? 6 : 1', 'serial >= 16000', 'request != token', 'code != request', '!expected.equals(value)', 'cookie.equals(CookieManager.getInstance().getCookie(BridgeClient.HOME))']) assert.ok(picker.includes(guard), guard);
  const authorities = [...picker.matchAll(/"(com\.android\.[^"]+\.documents)"/g)].map(m => m[1]);
  assert.deepEqual(authorities, ['com.android.providers.media.documents', 'com.android.providers.downloads.documents', 'com.android.externalstorage.documents']);
  for (const forbidden of ['takePersistableUriPermission', 'FLAG_GRANT_WRITE_URI_PERMISSION', 'FLAG_GRANT_PERSISTABLE_URI_PERMISSION', 'Uri.fromFile', 'addJavascriptInterface', 'SharedPreferences', 'Log.']) assert.ok(!picker.includes(forbidden));
  assert.match(picker, /location\.pathname!=='.*?\/'.*?location\.search.*?window\.codexPhoneReady!==true/);
  assert.match(picker, /window\.codexPhoneFileContext\|\|null/);
  assert.match(picker, /ValueCallback<Uri\[\]> done = callback; callback = null; view = null; context = null; cookie = null;\s*done.onReceiveValue/);
  assert.match(picker, /ValueCallback<Uri\[\]> old = callback; callback = null;[^\n]+old.onReceiveValue\(null\)/);
  assert.match(activity, /if \(picker != null\) picker.cancel\(\)/); assert.match(activity, /runOnUiThread\(\(\) -> picker.cancel\(\)\)/);
});
test('failed native document recovery has one visible-only bounded GET retry with lifecycle guards, unchanged cookies and no API replay', () => {
  const activity = java('MainActivity'), recovery = activity.slice(activity.indexOf('private void cancelPageRetry()'), activity.indexOf('private void invalidateBack()'));
  assert.match(recovery, /!visible \|\| !pageFailed \|\| web == null \|\| pageRetry != null \|\| pageRetryAttempts >= 3/);
  assert.match(recovery, /view != web \|\| generation != documentGeneration/); assert.match(recovery, /2000L << pageRetryAttempts/);
  assert.match(recovery, /pageRetryAttempts\+\+; loadHome\(\)/); assert.match(activity, /web.loadUrl\(HOME\)/);
  assert.match(activity, /onPause\(\) \{ visible = false; invalidateBack\(\); cancelPageRetry\(\)/);
  assert.match(activity, /web.onResume\(\); schedulePageRetry\(\)/); assert.match(activity, /window.dispatchEvent\(new Event\('pageshow'\)\)/);
  assert.doesNotMatch(recovery, /api\/|postUrl|removeAllCookies|setAcceptCookie|startService|ConnectivityManager/);
});
test('v0.3 Android build paths agree, backup remains disabled, only narrow nonexported service/provider permissions are introduced', () => {
  const manifest = source('android/app/src/main/AndroidManifest.xml'), build = source('scripts/Build-Android.ps1');
  assert.match(build, /'--version-code', '4', '--version-name', '0\.3\.0'/);
  assert.match(source('tools/check-android.mjs'), /Build-Android\.ps1/);
  assert.match(build, /codex-pocket-0\.3\.0-/); assert.doesNotMatch(manifest, /android:version(?:Code|Name)=/);
  const activity = java('MainActivity'); assert.match(activity, /CodexPhone\/2 CodexPhoneApp\/0\.3\.0/);
  assert.match(activity, /detail.put\("version", 2\)/); // Capability protocol 2 remains compatible with existing file/notification UI.
  assert.match(manifest, /android:label="Codex Pocket"/); assert.match(build, /dev\.codexpocket\.app/);
  assert.match(manifest, /allowBackup="false" android:fullBackupContent="false"/);
  assert.match(manifest, /service android:name="\.MonitorService" android:exported="false" android:foregroundServiceType="connectedDevice"/);
  assert.match(manifest, /provider android:name="\.ResultProvider"[^>]*android:exported="false" android:grantUriPermissions="true"/);
  for (const forbidden of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE', 'REQUEST_INSTALL_PACKAGES', 'RECEIVE_BOOT_COMPLETED', 'SCHEDULE_EXACT_ALARM', 'ACCESS_FINE_LOCATION']) assert.ok(!manifest.includes(forbidden));
  assert.match(manifest, /configChanges="orientation\|screenSize\|smallestScreenSize\|screenLayout\|keyboard\|keyboardHidden\|uiMode\|density"/);
});
test('native actions retain exact origin, current page/main-frame/gesture/GET checks and resource rejection; no generic JS bridge or arbitrary client paths', () => {
  const activity = java('MainActivity'), client = java('BridgeClient');
  assert.match(activity, /"http"\.equals\(uri.getScheme\(\)\).*HOST.equals\(uri.getHost\(\)\).*uri.getPort\(\) == PocketConfig.PORT.*uri.getUserInfo\(\) == null/);
  assert.match(activity, /request.isForMainFrame\(\) && request.hasGesture\(\) && "GET".equals\(request.getMethod\(\)\) && trustedCurrent\(\)/);
  assert.match(activity, /uri.getQuery\(\) == null && uri.getFragment\(\) == null && uri.getEncodedPath\(\).equals\(uri.getPath\(\)\)/);
  assert.match(activity, /new WebResourceResponse\("text\/plain", "utf-8", 403/);
  for (const guard of ['setAllowFileAccess(false)', 'setAllowContentAccess(false)', 'setAllowUniversalAccessFromFileURLs(false)', 'setMediaPlaybackRequiresUserGesture(true)', 'request.deny()', 'picker.show(view, callback, params, view == web && backPageReady())', 'handler.cancel()']) assert.ok(activity.includes(guard));
  assert.ok(!activity.includes('addJavascriptInterface')); assert.ok(!client.includes('SharedPreferences')); assert.ok(!client.includes('Log.'));
  assert.match(client, /setInstanceFollowRedirects\(false\)/); assert.match(client, /setConnectTimeout\(12000\); connection.setReadTimeout\(20000\)/); assert.match(client, /output.size\(\) \+ n > 262144/);
});
test('background observer is explicit visible nonsticky foreground work, permission/channel/session gated with bounded dedup/backoff; public notification is redacted and tap never sends', () => {
  const monitor = java('MonitorService');
  assert.match(monitor, /!MainActivity.visible \|\| !permitted\(this\)/); assert.match(monitor, /startForeground\(40,/); assert.match(monitor, /setOngoing\(true\)/); assert.match(monitor, /START_NOT_STICKY/);
  assert.match(monitor, /POST_NOTIFICATIONS/); assert.match(monitor, /getNotificationChannel\(EVENTS\).getImportance\(\)/);
  assert.match(monitor, /cursor == null \|\| !nextScope.equals\(scope\)/); assert.match(monitor, /!seen.contains\(hash\) && !baseline && !MainActivity.visible/);
  assert.match(monitor, /seen.size\(\) > 128/); assert.match(monitor, /Math.min\(120, 15L/); assert.match(monitor, /failure.status == 401 \|\| failure.status == 403/);
  assert.match(monitor, /setPublicVersion\(publicVersion\)/); assert.match(monitor, /putExtra\("threadId", thread\)/);
  assert.match(monitor, /intent.setData\(new android.net.Uri.Builder\(\)/);
  const activity = java('MainActivity'); assert.match(activity, /if \(visible\) requestMonitoring\(\); else monitorAfterResume = true/); assert.match(activity, /if \(monitorAfterResume\) \{ monitorAfterResume = false; requestMonitoring\(\); \}/);
  for (const forbidden of ['api/send', 'AlarmManager', 'BOOT_COMPLETED', 'START_STICKY', 'setNetworkPreference', 'Log.']) assert.ok(!monitor.includes(forbidden));
});
test('notification document lifecycle source contract retains latest intent through cold/failed loads and clears only acknowledged delivery in the same generation', () => {
  const activity = java('MainActivity'), delivery = activity.slice(activity.indexOf('private void deliverThread()'), activity.indexOf('@Override protected void onNewIntent'));
  assert.match(delivery, /!visible \|\| !pageLoaded \|\| threadDeliveryInFlight \|\| !trustedCurrent\(\)/);
  assert.match(delivery, /if \(generation != documentGeneration\) return/); assert.match(delivery, /!"true".equals\(delivered\)/);
  assert.ok(delivery.indexOf('!"true".equals(delivered)') < delivery.indexOf('openThread = null'));
  assert.match(delivery, /if \(id.equals\(openThread\)\) openThread = null;\s*else deliverThread\(\)/);
  assert.match(activity, /invalidateDocument\(\) \{ pageLoaded = false; threadDeliveryInFlight = false; documentGeneration\+\+/);
  assert.match(activity, /onPageStarted\([^\n]+invalidateDocument\(\)/);
  assert.match(activity, /view == web && !pageFailed && trusted\(Uri.parse\(url\)\) && url.equals\(web.getUrl\(\)\)/);
  assert.match(activity, /private void showFailure\(\) \{\s*invalidateDocument\(\)/);
  assert.match(activity, /onRenderProcessGone[^]*?invalidateDocument\(\); hideFullscreen\(\); root.removeView/);
  assert.match(activity, /onDestroy\(\) \{ visible = false; invalidateDocument\(\)/);
  assert.match(activity, /private void loadHome\(\) \{\s*if \(web == null\) return; invalidateDocument\(\)/);
  assert.match(activity, /if \(id != null && id.matches\("\[A-Za-z0-9_-\]\{1,100\}"\)\) openThread = id/);
  assert.match(activity, /monitorChanged\(\) \{ MainActivity activity = current.get\(\); if \(activity != null\) activity.nativeStatus\(null\)/);
  assert.match(activity, /MonitorService.running \? "화면 밖 알림이 켜져 있습니다\." : "화면 밖 알림은 꺼져 있습니다/);
  const monitor = java('MonitorService'); assert.match(monitor, /running = false; MainActivity.monitorChanged\(\)/);
});
test('native Back is fixed semantic dispatch with document nonce, generation/lifecycle/visibility guards, one flight and bounded root recheck; never canGoBack fallback exit', () => {
  const activity = java('MainActivity');
  const back = activity.slice(activity.indexOf('private void invalidateBack()'), activity.indexOf('@SuppressWarnings("deprecation") @Override public void onBackPressed'));
  assert.match(back, /backGeneration\+\+; backInFlight = false/);
  assert.match(back, /!visible \|\| !pageLoaded \|\| !trustedCurrent\(\) \|\| customView != null \|\| recovery.getVisibility\(\) != View.GONE \|\| web.getVisibility\(\) != View.VISIBLE/);
  assert.match(back, /"\/".equals\(uri.getEncodedPath\(\)\) && uri.getQuery\(\) == null/);
  assert.match(back, /view != web \|\| generation != documentGeneration/);
  assert.match(back, /view == web && generation == documentGeneration && request == backGeneration && document.equals\(backDocument\)/);
  assert.match(back, /url.equals\(web.getUrl\(\)\) && openThread == null && !threadDeliveryInFlight/);
  assert.match(back, /SystemClock.uptimeMillis\(\) - started < 1500/);
  assert.match(back, /backInFlight \|\| android.os.SystemClock.uptimeMillis\(\) < backQuietUntil \|\| !backPageReady\(\)/);
  assert.match(back, /backDocument == null\) \{ prepareBackDocument\(\); return; \}/);
  assert.match(back, /view.postDelayed\(\(\) -> \{ if \(request == backGeneration && backInFlight\) invalidateBack\(\); \}, 1500\)/);
  assert.match(back, /BACK_SCRIPT.replace\("%s", document\)/); assert.match(back, /BACK_CONFIRM_SCRIPT.replace\("%s", document\).replace\("%p", result\)/);
  assert.match(back, /backDocument = null; prepareBackDocument\(\);/); // Auth-invalidated nonce is reacquired, not treated as root.
  assert.equal((back.match(/if \(request != backGeneration \|\| generation != documentGeneration \|\| view != web\) return;/g) || []).length, 2);
  assert.match(back, /if \("true".equals\(confirmed\) && sameBackDocument\(view, generation, request, document, url, started\)\) finish\(\)/);
  assert.equal((activity.match(/\bfinish\(\)/g) || []).length, 1);
  assert.doesNotMatch(back, /canGoBack|goBack\(|loadUrl|send_message|api\//);
  assert.match(activity, /backDocument = null; backReadyInFlight = false; invalidateBack\(\)/);
  assert.match(activity, /onPause\(\) \{ visible = false; invalidateBack\(\)/);
  assert.match(activity, /onNewIntent\(Intent intent\) \{ super.onNewIntent\(intent\); invalidateBack\(\)/);
  assert.match(activity, /registerOnBackInvokedCallback\([^;]+this::navigateBack\)/);
  assert.match(activity, /onBackPressed\(\) \{ navigateBack\(\); \}/);
});
test('actual Java blocked equality decodes to the serialized WebView callback, so nonce rejection selects reacquisition rather than remaining stuck', () => {
  const activity = java('MainActivity');
  const back = activity.slice(activity.indexOf('private void navigateBack()'), activity.indexOf('@SuppressWarnings("deprecation") @Override public void onBackPressed'));
  const branch = back.match(/if \(("(?:\\.|[^"\\])*")\.equals\(result\)\) \{ backDocument = null; prepareBackDocument\(\); \}/);
  assert.ok(branch, 'Reacquisition must remain guarded by its actual callback equality.');
  // Quote/backslash escapes in this Java literal have the same decoding rules as JSON.
  assert.match(branch[1], /^"(?:[^"\\]|\\["\\])*"$/);
  const decoded = JSON.parse(branch[1]);
  assert.equal(decoded, JSON.stringify('blocked'));
  for (const callback of ['blocked', 'handled', 'busy', false, null]) {
    assert.equal(decoded === JSON.stringify(callback), callback === 'blocked');
  }
  assert.notEqual(decoded, 'blocked');
  assert.notEqual(decoded, '\\"blocked\\"');
});
test('staged result transfer uses revision/length checks and 64KiB I/O before SAF/share, readonly content grants and bounded own cache; fullscreen restores existing view/orientation/bars', () => {
  const transfer = java('ResultTransfer'), provider = java('ResultProvider'), activity = java('MainActivity');
  assert.match(transfer, /ACTIVE.compareAndSet\(null, this\)/); assert.match(transfer, /45L \* 60 \* 1000/); assert.match(transfer, /setRequestProperty\("If-Match"/);
  assert.match(transfer, /getContentLengthLong\(\) != info.getLong\("size"\)/); assert.match(transfer, /byte\[65536\]/); assert.match(transfer, /getFD\(\).sync\(\)/);
  assert.ok(transfer.indexOf('staged = ResultProvider.publish') > transfer.indexOf('FILE_CHANGED'));
  assert.ok(transfer.indexOf('ResultProvider.cleanup(activity, info.getLong("size"))') < transfer.indexOf('part.createNewFile()'));
  assert.match(provider, /file.getName\(\).endsWith\(".part"\) \|\| System.currentTimeMillis\(\) - file.lastModified\(\) > TTL/);
  assert.match(transfer, /ACTIVE.compareAndSet\(this, null\)/);
  assert.match(transfer, /Intent.ACTION_CREATE_DOCUMENT/); assert.match(transfer, /Intent.ACTION_SEND/); assert.match(transfer, /Intent.createChooser/); assert.match(transfer, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.ok(!transfer.includes('FLAG_GRANT_WRITE_URI_PERMISSION')); assert.ok(!transfer.includes('Uri.fromFile')); assert.ok(!transfer.includes('ACTION_INSTALL_PACKAGE'));
  assert.match(provider, /if \(!"r".equals\(mode\)\)/); assert.match(provider, /6L \* 60 \* 60 \* 1000/); assert.match(provider, /2300L \* 1024 \* 1024/); assert.match(provider, /data.size\(\) >= 8/); assert.match(provider, /getCanonicalPath\(\).equals\(file.getAbsolutePath\(\)\)/);
  assert.match(activity, /onShowCustomView\(View view, CustomViewCallback callback\)/); assert.match(activity, /if \(customView != null \|\| !visible \|\| !trustedCurrent\(\)\)/);
  assert.match(activity, /SCREEN_ORIENTATION_SENSOR_LANDSCAPE/); assert.match(activity, /setRequestedOrientation\(previousOrientation\)/); assert.match(activity, /setSystemBarsBehavior\(previousBarBehavior\)/);
  assert.match(activity, /navigateBack\(\) \{\s*if \(customView != null\) \{ invalidateBack\(\); hideFullscreen\(\);[^\n]+return; \}/); assert.match(activity, /onStop\(\) \{ hideFullscreen\(\)/);
});
