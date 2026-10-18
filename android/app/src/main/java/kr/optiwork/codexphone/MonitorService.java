package dev.codexpocket.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class MonitorService extends Service {
    static final String MONITOR = "monitor-v2", EVENTS = "events-v2", STOP = "stop";
    static volatile boolean running;
    private ScheduledExecutorService executor;
    private NotificationManager notifications;
    private String cookie, scope, cursor;
    private int failures;
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    static void channels(NotificationManager manager) {
        NotificationChannel monitor = new NotificationChannel(MONITOR, "PC 활동 확인 중", NotificationManager.IMPORTANCE_LOW);
        monitor.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE); manager.createNotificationChannel(monitor);
        NotificationChannel events = new NotificationChannel(EVENTS, "완료·질문 알림", NotificationManager.IMPORTANCE_DEFAULT);
        events.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE); manager.createNotificationChannel(events);
    }
    static boolean permitted(android.content.Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class); channels(manager);
        return (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && manager.areNotificationsEnabled() && manager.getNotificationChannel(MONITOR).getImportance() != NotificationManager.IMPORTANCE_NONE
                && manager.getNotificationChannel(EVENTS).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    private Notification monitoring(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, MonitorService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, MONITOR).setSmallIcon(R.drawable.ic_codex).setContentTitle("Codex 원격 · PC 활동 확인 중")
                .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
                .addAction(new Notification.Action.Builder(null, "알림 끄기", stop).build()).build();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction()) || !MainActivity.visible || !permitted(this)) { stopSelf(); return START_NOT_STICKY; }
        if (running) return START_NOT_STICKY;
        notifications = getSystemService(NotificationManager.class); channels(notifications);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(40, monitoring("연결을 확인하고 있습니다."), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(40, monitoring("연결을 확인하고 있습니다."));
        } catch (RuntimeException failure) { stopSelf(); return START_NOT_STICKY; }
        running = true; MainActivity.monitorChanged(); getSharedPreferences("monitor", MODE_PRIVATE).edit().putBoolean("optIn", true).apply();
        executor = Executors.newSingleThreadScheduledExecutor(); executor.execute(this::poll);
        return START_NOT_STICKY;
    }
    private void poll() {
        if (!running) return;
        try {
            if (!permitted(this)) { stopSelf(); return; }
            String current = BridgeClient.cookie();
            if (cookie != null && !cookie.equals(current)) { stopSelf(); return; }
            cookie = current;
            JSONObject result = BridgeClient.json("api/events" + (cursor == null ? "" : "?cursor=" + cursor), cookie);
            if (!running || !cookie.equals(BridgeClient.cookie()) || !permitted(this)) { stopSelf(); return; }
            String nextScope = BridgeClient.scope(result), nextCursor = result.optString("cursor");
            if (!nextCursor.matches("[a-f0-9]{24}\\.[0-9]{1,12}")) throw new java.io.IOException("INVALID_CURSOR");
            boolean baseline = cursor == null || !nextScope.equals(scope) || result.optBoolean("reset", true);
            if (scope != null && !scope.equals(nextScope)) { stopSelf(); return; }
            if (scope == null) {
                SharedPreferences preferences = getSharedPreferences("monitor", MODE_PRIVATE);
                if (nextScope.equals(preferences.getString("scope", ""))) {
                    JSONArray hashes = new JSONArray(preferences.getString("seen", "[]"));
                    for (int n = Math.max(0, hashes.length() - 128); n < hashes.length(); n++) { String hash = hashes.optString(n); if (hash.matches("[a-f0-9]{64}")) seen.add(hash); }
                }
            }
            scope = nextScope;
            JSONArray events = result.optJSONArray("events");
            if (events == null || events.length() > 128) throw new java.io.IOException("INVALID_EVENTS");
            for (int n = 0; n < events.length(); n++) {
                JSONObject event = events.getJSONObject(n); String hash = event.optString("fingerprint"), id = event.optString("threadId"), type = event.optString("type");
                if (!hash.matches("[a-f0-9]{64}") || !id.matches("[A-Za-z0-9_-]{1,100}") || !type.matches("completed|question|waiting")) continue;
                if (!seen.contains(hash) && !baseline && !MainActivity.visible) notifyEvent(event, id, hash);
                seen.add(hash); while (seen.size() > 128) seen.remove(seen.iterator().next());
            }
            cursor = nextCursor;
            getSharedPreferences("monitor", MODE_PRIVATE).edit().putString("scope", scope).putString("cursor", cursor).putString("seen", new JSONArray(seen).toString()).apply();
            failures = 0;
            notifications.notify(40, monitoring(result.optBoolean("available") ? "완료·질문을 약 15초 간격으로 확인합니다. 절전 중에는 늦어질 수 있습니다." : "PC 확인 지연 · 연결을 다시 확인합니다."));
        } catch (BridgeClient.Failure failure) {
            if (failure.status == 401 || failure.status == 403) { getSharedPreferences("monitor", MODE_PRIVATE).edit().clear().apply(); stopSelf(); return; }
            failures++;
        } catch (Exception failure) { failures++; }
        if (!running) return;
        try {
            if (!permitted(this)) { stopSelf(); return; }
            if (failures > 0 && notifications != null) notifications.notify(40, monitoring("연결 지연 · Tailscale과 PC 전원을 확인해 주세요. 자동 재확인 중입니다."));
        } catch (RuntimeException revoked) { stopSelf(); return; }
        if (running && executor != null && !executor.isShutdown()) executor.schedule(this::poll, Math.min(120, 15L << Math.min(failures, 3)), TimeUnit.SECONDS);
    }
    private static String compact(String value, int max) { return value.replaceAll("[\\p{Cntrl}\\u202a-\\u202e\\u2066-\\u2069]", " ").substring(0, Math.min(value.length(), max)); }
    private synchronized void notifyEvent(JSONObject event, String thread, String hash) {
        if (!running || MainActivity.visible || !permitted(this) || cookie == null) return;
        try { if (!cookie.equals(BridgeClient.cookie())) { stopSelf(); return; } } catch (Exception expired) { stopSelf(); return; }
        Intent intent = new Intent(this, MainActivity.class).setAction("open-thread").putExtra("threadId", thread).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.setData(new android.net.Uri.Builder().scheme("codex-remote").authority("thread").appendPath(thread).appendPath(hash).build());
        PendingIntent tap = PendingIntent.getActivity(this, hash.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification publicVersion = new Notification.Builder(this, EVENTS).setSmallIcon(R.drawable.ic_codex).setContentTitle("Codex 원격").setContentText("PC 활동 알림이 있습니다.").build();
        notifications.notify(hash, 41, new Notification.Builder(this, EVENTS).setSmallIcon(R.drawable.ic_codex)
                .setContentTitle(compact(event.optString("title", "Codex 원격"), 100)).setContentText(compact(event.optString("body"), 180))
                .setContentIntent(tap).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).build());
    }
    @Override public synchronized void onDestroy() {
        running = false; MainActivity.monitorChanged(); cookie = null; if (executor != null) executor.shutdownNow();
        getSharedPreferences("monitor", MODE_PRIVATE).edit().putBoolean("optIn", false).apply();
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
