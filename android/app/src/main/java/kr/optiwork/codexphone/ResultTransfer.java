package dev.codexpocket.app;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class ResultTransfer {
    static final int CREATE = 72;
    private static final java.util.concurrent.atomic.AtomicReference<ResultTransfer> ACTIVE = new java.util.concurrent.atomic.AtomicReference<>();
    private final MainActivity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled, busy;
    private volatile HttpURLConnection connection;
    private String id, cookie, scope, operation;
    private JSONObject info;
    private Uri staged;
    private boolean waitingUi;
    private long deadline;
    ResultTransfer(MainActivity activity) { this.activity = activity; }
    void start(String operation, String token) {
        if (busy || !ACTIVE.compareAndSet(null, this)) { activity.transferStatus("다른 파일을 처리 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.", false); return; }
        busy = true; cancelled = false; deadline = android.os.SystemClock.elapsedRealtime() + 45L * 60 * 1000; this.operation = operation;
        activity.transferStatus("파일을 확인하고 있습니다…", false);
        executor.execute(() -> download(token));
    }
    private void check() throws Exception {
        if (cancelled || Thread.currentThread().isInterrupted() || android.os.SystemClock.elapsedRealtime() > deadline) throw new java.io.IOException("CANCELLED_OR_EXPIRED");
        if (!cookie.equals(BridgeClient.cookie())) throw new BridgeClient.Failure(401);
    }
    private static void validate(JSONObject info) throws Exception {
        String name = info.getString("name"), mime = info.getString("mime"), revision = info.getString("revision"); long size = info.getLong("size");
        long limit = mime.equals("video/mp4") ? 2147483648L : mime.equals("application/pdf") ? 134217728L : mime.matches("application/(?:zip|vnd.android.package-archive)") ? 536870912L : mime.matches("image/(?:png|jpeg|webp|gif)") ? 16777216L : 0;
        if (size <= 0 || size > limit || name.length() > 255 || java.util.regex.Pattern.compile("[\\p{Cntrl}/\\\\]").matcher(name).find() || !revision.matches("[a-f0-9]{64}")) throw new java.io.IOException("INVALID_FILE_INFO");
    }
    private void download(String token) {
        try {
            cookie = BridgeClient.cookie(); scope = BridgeClient.scope(BridgeClient.json("api/session", cookie));
            info = BridgeClient.json("api/files/" + token + "/info", cookie); validate(info); check();
            ResultProvider.cleanup(activity, info.getLong("size"));
            id = UUID.randomUUID().toString(); File part = ResultProvider.owned(activity, id, "part");
            if (!part.createNewFile()) throw new java.io.IOException("CACHE_COLLISION");
            connection = BridgeClient.open("api/files/" + token, cookie); connection.setRequestProperty("If-Match", "\"" + info.getString("revision") + "\"");
            int status = connection.getResponseCode(); if (status != 200) throw new BridgeClient.Failure(status);
            if (connection.getContentLengthLong() != info.getLong("size") || !info.getString("mime").equals(connection.getContentType()) || !("\"" + info.getString("revision") + "\"").equals(connection.getHeaderField("ETag"))) throw new java.io.IOException("INVALID_TRANSFER");
            long count = 0, last = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part, false)) {
                byte[] buffer = new byte[65536]; int n;
                while ((n = input.read(buffer)) != -1) {
                    check(); count += n; if (count > info.getLong("size")) throw new java.io.IOException("TRANSFER_LIMIT");
                    output.write(buffer, 0, n); long now = android.os.SystemClock.elapsedRealtime();
                    if (now - last > 300) { last = now; activity.transferStatus("파일 받는 중 · " + (count * 100 / info.getLong("size")) + "%", false); }
                }
                if (count != info.getLong("size")) throw new java.io.IOException("TRANSFER_INCOMPLETE"); output.getFD().sync();
            } finally { connection.disconnect(); connection = null; }
            check(); JSONObject after = BridgeClient.json("api/files/" + token + "/info", cookie); validate(after);
            if (!info.getString("revision").equals(after.getString("revision")) || info.getLong("size") != after.getLong("size") || !scope.equals(BridgeClient.scope(BridgeClient.json("api/session", cookie)))) throw new java.io.IOException("FILE_CHANGED");
            check(); if (!part.renameTo(ResultProvider.owned(activity, id, "data"))) throw new java.io.IOException("CACHE_COMMIT_FAILED");
            staged = ResultProvider.publish(activity, id, info); waitingUi = true;
            activity.runOnUiThread(this::present);
        } catch (Exception failure) { failed(); }
        finally { if (connection != null) { connection.disconnect(); connection = null; } }
    }
    void present() {
        if (!waitingUi || !MainActivity.visible || activity.isFinishing() || activity.isDestroyed()) return;
        waitingUi = false;
        executor.execute(() -> {
            try {
                check(); if (!scope.equals(BridgeClient.scope(BridgeClient.json("api/session", cookie)))) throw new BridgeClient.Failure(401);
                activity.runOnUiThread(() -> { if (!MainActivity.visible) waitingUi = true; else launchChooser(); });
            } catch (Exception failure) { failed(); }
        });
    }
    private void launchChooser() {
        try {
            check(); if (activity.isDestroyed() || activity.isFinishing()) throw new java.io.IOException("ACTIVITY_CLOSED");
            if (operation.equals("share")) {
                Intent share = new Intent(Intent.ACTION_SEND).setType(info.getString("mime")).putExtra(Intent.EXTRA_STREAM, staged).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                share.setClipData(ClipData.newRawUri("Codex 결과 파일", staged));
                activity.startActivity(Intent.createChooser(share, "결과 파일 공유"));
                activity.transferStatus("공유 선택창을 열었습니다. 전달 완료 여부는 선택한 앱에서 확인해 주세요.", true); finish(false);
            } else {
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(info.getString("mime")).putExtra(Intent.EXTRA_TITLE, info.getString("name"));
                activity.startActivityForResult(create, CREATE);
                activity.transferStatus("파일을 받았습니다. 새 파일을 저장할 위치를 선택해 주세요.", false);
            }
        } catch (Exception failure) { failed(); }
    }
    void destination(Uri uri) {
        if (!busy) return;
        if (uri == null || !"content".equals(uri.getScheme())) { cancelled = true; failed(); return; }
        executor.execute(() -> {
            try {
                check(); if (!scope.equals(BridgeClient.scope(BridgeClient.json("api/session", cookie)))) throw new BridgeClient.Failure(401);
                activity.transferStatus("선택한 새 문서에 저장 중입니다…", false);
                long count = 0;
                try (InputStream input = new FileInputStream(ResultProvider.owned(activity, id, "data")); OutputStream output = activity.getContentResolver().openOutputStream(uri, "w")) {
                    if (output == null) throw new java.io.IOException("DESTINATION_UNAVAILABLE");
                    byte[] buffer = new byte[65536]; int n;
                    while ((n = input.read(buffer)) != -1) { check(); output.write(buffer, 0, n); count += n; }
                    output.flush(); if (count != info.getLong("size")) throw new java.io.IOException("COPY_INCOMPLETE");
                }
                check(); activity.transferStatus("선택한 위치에 저장했습니다.", true); finish(true);
            } catch (Exception failure) {
                // ACTION_CREATE_DOCUMENT creates a new document, never an existing user file.
                try { DocumentsContract.deleteDocument(activity.getContentResolver(), uri); } catch (Exception ignored) { }
                failed();
            }
        });
    }
    void cancel() { cancelled = true; HttpURLConnection active = connection; if (active != null) active.disconnect(); if (waitingUi) { waitingUi = false; failed(); } }
    private void failed() { activity.transferStatus(cancelled ? "파일 처리를 취소했습니다." : "저장·공유를 완료하지 못했습니다. 연결·공간·파일 변경을 확인하고 원래 기록의 파일 다시 확인을 눌러 주세요.", true); finish(true); }
    private void finish(boolean remove) {
        if (remove && id != null) for (String suffix : new String[]{ "part", "json", "data" }) try { ResultProvider.owned(activity, id, suffix).delete(); } catch (Exception ignored) { }
        busy = false; waitingUi = false; cookie = null; scope = null; staged = null; id = null; ACTIVE.compareAndSet(this, null);
    }
    void destroy() { cancel(); if (!executor.isShutdown()) { executor.execute(() -> { if (busy) finish(true); }); executor.shutdown(); } }
}
