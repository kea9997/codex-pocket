package dev.codexpocket.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;

public final class MainActivity extends Activity {
    static volatile boolean visible;
    private static java.lang.ref.WeakReference<MainActivity> current = new java.lang.ref.WeakReference<>(null);
    static void monitorChanged() { MainActivity activity = current.get(); if (activity != null) activity.nativeStatus(null); }
    private static final String HOST = PocketConfig.HOST, HOME = BridgeClient.HOME;
    private WebView web;
    private FrameLayout root, fullscreen;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private int previousOrientation, previousSystemUi, previousBars, previousBarBehavior;
    private LinearLayout recovery;
    private TextView status;
    private Button retry;
    private boolean pageFailed, pageLoaded, threadDeliveryInFlight, awaitingPermission, monitorAfterResume;
    private long documentGeneration, backGeneration, backQuietUntil;
    private boolean backInFlight, backReadyInFlight;
    private int pageRetryAttempts;
    private Runnable pageRetry;
    private String backDocument;
    static final String BACK_READY_SCRIPT = "(function(){if(location.origin!==" + org.json.JSONObject.quote(PocketConfig.ORIGIN) + "||location.pathname!=='/'||location.search||window.codexPhoneReady!==true)return null;return window.codexPhoneDocument;})()";
    static final String BACK_SCRIPT = "(function(){if(location.origin!==" + org.json.JSONObject.quote(PocketConfig.ORIGIN) + "||location.pathname!=='/'||location.search||window.codexPhoneReady!==true||window.codexPhoneDocument!==%s||typeof window.codexPhoneBack!=='function')return 'blocked';return window.codexPhoneBack();})()";
    static final String BACK_CONFIRM_SCRIPT = "(function(){if(location.origin!==" + org.json.JSONObject.quote(PocketConfig.ORIGIN) + "||location.pathname!=='/'||location.search||window.codexPhoneReady!==true||window.codexPhoneDocument!==%s||typeof window.codexPhoneConfirmBack!=='function')return false;return window.codexPhoneConfirmBack(%p);})()";
    static final String OPEN_THREAD_SCRIPT = "(function(){if(window.codexPhoneReady!==true)return false;window.dispatchEvent(new CustomEvent('codexOpenThread',{detail:{threadId:%s}}));return true;})()";
    private String openThread;
    private ResultTransfer transfer;
    private AttachmentPicker picker;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState); current = new java.lang.ref.WeakReference<>(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(32, 32, 32));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (customView != null) view.setPadding(0, 0, 0, 0);
            else if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root); transfer = new ResultTransfer(this); picker = new AttachmentPicker(this);
        web = new WebView(this); web.setBackgroundColor(Color.rgb(32, 32, 32)); root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        buildRecovery(); WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false); settings.setGeolocationEnabled(false); settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE); settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " CodexPhone/2 CodexPhoneApp/0.3.0");
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> Toast.makeText(this, "대화의 파일 저장·공유 버튼을 사용해 주세요.", Toast.LENGTH_LONG).show());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) { return picker.show(view, callback, params, view == web && backPageReady()); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) { showFullscreen(view, callback); }
            @Override public void onHideCustomView() { hideFullscreen(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trusted(uri)) {
                    if (uri.getPath() != null && uri.getPath().startsWith("/native/")) {
                        if (request.isForMainFrame() && request.hasGesture() && "GET".equals(request.getMethod()) && trustedCurrent() && uri.getQuery() == null && uri.getFragment() == null && uri.getEncodedPath().equals(uri.getPath())) nativeAction(uri.getPath());
                        return true;
                    }
                    return !request.isForMainFrame();
                }
                if (request.isForMainFrame() && request.hasGesture()) openExternal(uri);
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trusted(uri) && "/api/logout".equals(uri.getPath()) && "POST".equals(request.getMethod())) { stopService(new Intent(MainActivity.this, MonitorService.class)); transfer.cancel(); runOnUiThread(() -> picker.cancel()); }
                if (trusted(uri) && (uri.getPath() == null || !uri.getPath().startsWith("/native/"))) return null;
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { invalidateDocument(); hideFullscreen(); pageFailed = false; }
            @Override public void onPageFinished(WebView view, String url) {
                if (view == web && !pageFailed && trusted(Uri.parse(url)) && url.equals(web.getUrl())) { pageLoaded = true; pageRetryAttempts = 0; cancelPageRetry(); recovery.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); CookieManager.getInstance().flush(); nativeStatus(null); prepareBackDocument(); deliverThread(); }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) showFailure(); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { if (request.isForMainFrame()) showFailure(); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); showFailure(); }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                invalidateDocument(); hideFullscreen(); root.removeView(web); web.destroy(); web = null;
                status.setText("화면 실행이 중단되었습니다. 앱을 닫고 다시 열어 주세요."); retry.setEnabled(false); recovery.setVisibility(View.VISIBLE); return true;
            }
        });
        readIntent(getIntent());
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        loadHome();
    }
    static boolean trusted(Uri uri) {
        return uri != null && "http".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == PocketConfig.PORT && uri.getUserInfo() == null;
    }
    private boolean trustedCurrent() { return web != null && web.getUrl() != null && trusted(Uri.parse(web.getUrl())) && !pageFailed; }
    private void nativeAction(String path) {
        if (!visible) return;
        if (path.equals("/native/notifications/start")) {
            new AlertDialog.Builder(this).setTitle("화면 밖 알림을 켤까요?").setMessage("알림창에 PC 활동 확인 표시가 유지됩니다. 절전·Tailscale 연결 상태에 따라 늦어질 수 있으며 앱 강제 종료 후에는 직접 다시 켜야 합니다.")
                    .setNegativeButton("취소", null).setPositiveButton("켜기", (dialog, which) -> requestMonitoring()).show();
        } else if (path.equals("/native/notifications/stop")) { stopService(new Intent(this, MonitorService.class)); nativeStatus("화면 밖 알림을 껐습니다."); }
        else if (path.equals("/native/files/cancel")) transfer.cancel();
        else if (path.matches("/native/files/(?:save|share)/[A-Za-z0-9_-]{43}")) { String[] parts = path.split("/"); transfer.start(parts[3], parts[4]); }
    }
    private void requestMonitoring() {
        if (!visible) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { awaitingPermission = true; requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 71); return; }
        if (!MonitorService.permitted(this)) { nativeStatus("기기 알림 또는 알림 채널이 꺼져 있습니다. 앱 알림 설정을 확인한 뒤 다시 켜 주세요."); return; }
        try { startForegroundService(new Intent(this, MonitorService.class)); nativeStatus("화면 밖 알림을 시작합니다. 알림창의 확인 중 표시를 확인해 주세요."); }
        catch (RuntimeException failure) { nativeStatus("알림을 시작하지 못했습니다. 앱을 화면에 연 상태에서 다시 시도해 주세요."); }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 71 && awaitingPermission) {
            awaitingPermission = false;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) { if (visible) requestMonitoring(); else monitorAfterResume = true; }
            else nativeStatus("알림 권한이 없어 화면 밖 알림은 꺼져 있습니다.");
        }
    }
    private void emit(String event, JSONObject detail) {
        runOnUiThread(() -> { if (trustedCurrent()) web.evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detail.toString() + "}));", null); });
    }
    private void nativeStatus(String message) {
        JSONObject detail = new JSONObject();
        try { detail.put("version", 2).put("monitor", MonitorService.running).put("message", message != null ? message : MonitorService.running ? "화면 밖 알림이 켜져 있습니다." : "화면 밖 알림은 꺼져 있습니다. 필요할 때 직접 켜 주세요."); } catch (Exception ignored) { }
        emit("codexNative", detail);
    }
    void transferStatus(String message, boolean done) {
        JSONObject detail = new JSONObject(); try { detail.put("version", 2).put("transfer", message).put("transferDone", done); } catch (Exception ignored) { }
        emit("codexNative", detail);
    }
    private void readIntent(Intent intent) {
        String id = intent == null ? null : intent.getStringExtra("threadId"); if (id != null && id.matches("[A-Za-z0-9_-]{1,100}")) openThread = id;
    }
    private void invalidateDocument() { pageLoaded = false; threadDeliveryInFlight = false; documentGeneration++; backDocument = null; backReadyInFlight = false; invalidateBack(); cancelPageRetry(); if (picker != null) picker.cancel(); }
    private void deliverThread() {
        if (openThread == null || !visible || !pageLoaded || threadDeliveryInFlight || !trustedCurrent()) return;
        final String id = openThread; final long generation = documentGeneration;
        threadDeliveryInFlight = true;
        web.evaluateJavascript(OPEN_THREAD_SCRIPT.replace("%s", JSONObject.quote(id)), delivered -> {
            if (generation != documentGeneration) return;
            threadDeliveryInFlight = false;
            if (!pageLoaded || !trustedCurrent() || !"true".equals(delivered)) return;
            if (id.equals(openThread)) openThread = null;
            else deliverThread(); // A newer notification replaced the in-flight ID.
        });
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); invalidateBack(); setIntent(intent); readIntent(intent); deliverThread(); }
    private void showFullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (customView != null || !visible || !trustedCurrent()) { callback.onCustomViewHidden(); return; }
        invalidateBack();
        previousOrientation = getRequestedOrientation(); previousSystemUi = getWindow().getDecorView().getSystemUiVisibility();
        previousBars = Build.VERSION.SDK_INT >= 30 && root.getRootWindowInsets() != null ? (root.getRootWindowInsets().isVisible(WindowInsets.Type.statusBars()) ? WindowInsets.Type.statusBars() : 0) | (root.getRootWindowInsets().isVisible(WindowInsets.Type.navigationBars()) ? WindowInsets.Type.navigationBars() : 0) : 0;
        customView = view; customCallback = callback; fullscreen = new FrameLayout(this); fullscreen.setBackgroundColor(Color.BLACK); fullscreen.addView(view, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        root.addView(fullscreen, new FrameLayout.LayoutParams(-1, -1)); root.setPadding(0, 0, 0, 0);
        if (Build.VERSION.SDK_INT >= 30) { previousBarBehavior = getWindow().getInsetsController().getSystemBarsBehavior(); getWindow().getInsetsController().hide(WindowInsets.Type.systemBars()); getWindow().getInsetsController().setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); }
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }
    private void hideFullscreen() {
        if (customView == null) return;
        WebChromeClient.CustomViewCallback callback = customCallback; customCallback = null; customView = null;
        fullscreen.removeAllViews(); root.removeView(fullscreen); fullscreen = null;
        setRequestedOrientation(previousOrientation); getWindow().getDecorView().setSystemUiVisibility(previousSystemUi);
        if (Build.VERSION.SDK_INT >= 30) { getWindow().getInsetsController().setSystemBarsBehavior(previousBarBehavior); getWindow().getInsetsController().hide(WindowInsets.Type.systemBars()); if (previousBars != 0) getWindow().getInsetsController().show(previousBars); }
        root.requestApplyInsets(); if (callback != null) callback.onCustomViewHidden();
    }
    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) { Toast.makeText(this, "로컬 파일·앱 실행 링크는 열지 않습니다. PC에서 확인해 주세요.", Toast.LENGTH_LONG).show(); return; }
        if (uri.getHost() == null || uri.getUserInfo() != null) return;
        new AlertDialog.Builder(this).setTitle("외부 브라우저로 열까요?").setMessage(uri.getHost()).setNegativeButton("취소", null).setPositiveButton("열기", (dialog, which) -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (ActivityNotFoundException ignored) { Toast.makeText(this, "사용 가능한 브라우저가 없습니다.", Toast.LENGTH_SHORT).show(); }
        }).show();
    }
    private void buildRecovery() {
        recovery = new LinearLayout(this); recovery.setOrientation(LinearLayout.VERTICAL); recovery.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density); recovery.setPadding(pad, pad, pad, pad); recovery.setBackgroundColor(Color.rgb(32, 32, 32));
        status = new TextView(this); status.setTextSize(17); status.setTextColor(Color.rgb(238, 234, 229)); status.setGravity(Gravity.CENTER); status.setText("PC에 연결하고 있습니다…");
        recovery.addView(status, new LinearLayout.LayoutParams(-1, -2)); retry = new Button(this); retry.setText("다시 연결"); retry.setMinHeight((int) (48 * getResources().getDisplayMetrics().density));
        retry.setOnClickListener(view -> { pageRetryAttempts = 0; loadHome(); }); recovery.addView(retry); root.addView(recovery, new FrameLayout.LayoutParams(-1, -1));
    }
    private void loadHome() {
        if (web == null) return; invalidateDocument(); status.setText("PC에 연결하고 있습니다…"); retry.setVisibility(View.GONE); recovery.setVisibility(View.VISIBLE); web.setVisibility(View.INVISIBLE); pageFailed = false; web.loadUrl(HOME);
    }
    private void showFailure() {
        invalidateDocument(); hideFullscreen(); pageFailed = true; status.setText("PC에 연결할 수 없습니다.\n\n휴대폰과 PC의 Tailscale을 켜고, PC 전원과 Codex 원격 서비스가 실행 중인지 확인해 주세요.");
        retry.setVisibility(View.VISIBLE); recovery.setVisibility(View.VISIBLE); if (web != null) web.setVisibility(View.INVISIBLE);
        schedulePageRetry();
    }
    private void cancelPageRetry() { if (pageRetry != null && web != null) web.removeCallbacks(pageRetry); pageRetry = null; }
    private void schedulePageRetry() {
        if (!visible || !pageFailed || web == null || pageRetry != null || pageRetryAttempts >= 3) return;
        final WebView view = web; final long generation = documentGeneration;
        pageRetry = () -> {
            pageRetry = null;
            if (!visible || !pageFailed || view != web || generation != documentGeneration) return;
            pageRetryAttempts++; loadHome(); // Only reload the fixed document GET, never replay an API request.
        };
        status.setText("PC에 연결할 수 없습니다. 휴대폰·PC의 Tailscale과 PC 전원을 확인해 주세요.\n잠시 후 연결 화면을 다시 확인합니다. 자동 확인은 최대 3회입니다.");
        view.postDelayed(pageRetry, 2000L << pageRetryAttempts);
    }
    private void invalidateBack() { backGeneration++; backInFlight = false; }
    private boolean backPageReady() {
        if (!visible || !pageLoaded || !trustedCurrent() || customView != null || recovery.getVisibility() != View.GONE || web.getVisibility() != View.VISIBLE) return false;
        Uri uri = Uri.parse(web.getUrl()); return "/".equals(uri.getEncodedPath()) && uri.getQuery() == null;
    }
    private void prepareBackDocument() {
        if (!backPageReady() || backReadyInFlight || backDocument != null) return;
        final WebView view = web; final long generation = documentGeneration;
        backReadyInFlight = true;
        view.evaluateJavascript(BACK_READY_SCRIPT, result -> {
            if (view != web || generation != documentGeneration) return;
            backReadyInFlight = false;
            if (backPageReady() && result != null && result.matches("\\\"[a-f0-9-]{36}\\\"")) backDocument = result;
        });
    }
    private boolean sameBackDocument(WebView view, long generation, long request, String document, String url, long started) {
        return view == web && generation == documentGeneration && request == backGeneration && document.equals(backDocument) &&
                backPageReady() && url.equals(web.getUrl()) && openThread == null && !threadDeliveryInFlight && android.os.SystemClock.uptimeMillis() - started < 1500;
    }
    private void navigateBack() {
        if (customView != null) { invalidateBack(); hideFullscreen(); backQuietUntil = android.os.SystemClock.uptimeMillis() + 350; return; }
        if (backInFlight || android.os.SystemClock.uptimeMillis() < backQuietUntil || !backPageReady()) return;
        if (backDocument == null) { prepareBackDocument(); return; }
        final WebView view = web; final long generation = documentGeneration, request = ++backGeneration, started = android.os.SystemClock.uptimeMillis();
        final String document = backDocument, url = web.getUrl();
        backInFlight = true; backQuietUntil = started + 350;
        view.postDelayed(() -> { if (request == backGeneration && backInFlight) invalidateBack(); }, 1500);
        view.evaluateJavascript(BACK_SCRIPT.replace("%s", document), result -> {
            if (request != backGeneration || generation != documentGeneration || view != web) return;
            if (!sameBackDocument(view, generation, request, document, url, started) || result == null || !result.matches("\\\"root:[0-9]+:[0-9]+\\\"")) {
                backInFlight = false;
                if ("\"blocked\"".equals(result)) { backDocument = null; prepareBackDocument(); }
                return;
            }
            // Recheck the web route/auth revision, not just a delayed root result or WebView history.
            view.evaluateJavascript(BACK_CONFIRM_SCRIPT.replace("%s", document).replace("%p", result), confirmed -> {
                if (request != backGeneration || generation != documentGeneration || view != web) return;
                backInFlight = false;
                if ("true".equals(confirmed) && sameBackDocument(view, generation, request, document, url, started)) finish();
            });
        });
    }
    @SuppressWarnings("deprecation") @Override public void onBackPressed() { navigateBack(); }
    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (picker != null && picker.result(request, result, data)) return; if (request == ResultTransfer.CREATE) transfer.destination(result == RESULT_OK && data != null ? data.getData() : null); }
    @Override protected void onPause() { visible = false; invalidateBack(); cancelPageRetry(); if (trustedCurrent()) web.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null); CookieManager.getInstance().flush(); if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); visible = true; if (web != null) web.onResume(); schedulePageRetry(); if (pageLoaded && trustedCurrent()) web.evaluateJavascript("window.dispatchEvent(new Event('pageshow'));", null); nativeStatus(null); prepareBackDocument(); deliverThread(); if (monitorAfterResume) { monitorAfterResume = false; requestMonitoring(); } if (transfer != null) transfer.present(); }
    @Override protected void onStop() { hideFullscreen(); super.onStop(); }
    @Override protected void onDestroy() { visible = false; invalidateDocument(); hideFullscreen(); if (transfer != null) transfer.destroy(); if (web != null) { web.stopLoading(); web.destroy(); web = null; } super.onDestroy(); }
}
