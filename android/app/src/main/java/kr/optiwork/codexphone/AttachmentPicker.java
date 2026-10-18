package dev.codexpocket.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.HashSet;

// Only a system document selection, no storage/camera permission or persistent grant.
final class AttachmentPicker {
    private final Activity activity;
    private ValueCallback<Uri[]> callback;
    private WebView view;
    private String context, cookie;
    private int serial = 8000, request, maximum;
    private static final String CONTEXT = "(function(){if(location.origin!==" + org.json.JSONObject.quote(PocketConfig.ORIGIN) + "||location.pathname!=='/'||location.search||window.codexPhoneReady!==true)return null;return window.codexPhoneFileContext||null;})()";
    private static final String[] MIME = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip"};
    AttachmentPicker(Activity activity) { this.activity = activity; }
    void cancel() { ValueCallback<Uri[]> old = callback; callback = null; view = null; context = null; cookie = null; if (old != null) old.onReceiveValue(null); }
    boolean show(WebView web, ValueCallback<Uri[]> result, WebChromeClient.FileChooserParams params, boolean trusted) {
        if (callback != null || !trusted || params.isCaptureEnabled() || (params.getMode() != WebChromeClient.FileChooserParams.MODE_OPEN && params.getMode() != WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) || serial >= 16000) { result.onReceiveValue(null); return true; }
        callback = result; view = web; request = ++serial; maximum = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE ? 6 : 1;
        final int token = request;
        cookie = CookieManager.getInstance().getCookie(BridgeClient.HOME);
        if (cookie == null || cookie.isEmpty()) { cancel(); return true; }
        web.evaluateJavascript(CONTEXT, value -> {
            if (callback == null || request != token || view != web) return;
            if (value == null || "null".equals(value) || !value.matches("\\\"[A-Za-z0-9_:.\\-]{1,320}\\\"")) { cancel(); return; }
            context = value;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, MIME);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { activity.startActivityForResult(intent, token); } catch (RuntimeException failure) { cancel(); }
        });
        web.postDelayed(() -> { if (callback != null && request == token && context == null) cancel(); }, 2000);
        return true;
    }
    boolean result(int code, int result, Intent data) {
        if (code < 8001 || code > 16000) return false;
        if (callback == null || code != request) return true;
        if (result != Activity.RESULT_OK || data == null || (data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) { cancel(); return true; }
        ArrayList<Uri> selected = new ArrayList<>();
        if (data.getClipData() != null) {
            if (data.getClipData().getItemCount() > maximum) { cancel(); return true; }
            for (int i = 0; i < data.getClipData().getItemCount(); i++) selected.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) selected.add(data.getData());
        HashSet<String> seen = new HashSet<>();
        for (Uri uri : selected) {
            String authority = uri == null ? null : uri.getAuthority();
            if (uri == null || !"content".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || uri.toString().length() > 2048 || !DocumentsContract.isDocumentUri(activity, uri) ||
                    !("com.android.providers.media.documents".equals(authority) || "com.android.providers.downloads.documents".equals(authority) || "com.android.externalstorage.documents".equals(authority)) || !seen.add(uri.toString())) { cancel(); return true; }
            try (android.content.res.AssetFileDescriptor fd = activity.getContentResolver().openAssetFileDescriptor(uri, "r")) {
                if (fd == null || fd.getLength() > 20L * 1024 * 1024 || fd.getLength() == 0) { cancel(); return true; }
            } catch (Exception failure) { cancel(); return true; }
        }
        if (selected.isEmpty() || view == null || !cookie.equals(CookieManager.getInstance().getCookie(BridgeClient.HOME))) { cancel(); return true; }
        final WebView web = view; final int token = request; final String expected = context;
        web.evaluateJavascript(CONTEXT, value -> {
            if (callback == null || request != token || view != web) return;
            if (expected == null || !expected.equals(value) || !cookie.equals(CookieManager.getInstance().getCookie(BridgeClient.HOME))) { cancel(); return; }
            ValueCallback<Uri[]> done = callback; callback = null; view = null; context = null; cookie = null;
            done.onReceiveValue(selected.toArray(new Uri[0]));
        });
        web.postDelayed(() -> { if (callback != null && request == token) cancel(); }, 2000);
        return true;
    }
}
