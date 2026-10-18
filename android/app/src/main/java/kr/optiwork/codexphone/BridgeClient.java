package dev.codexpocket.app;

import android.webkit.CookieManager;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class BridgeClient {
    static final String HOME = PocketConfig.ORIGIN + "/";
    static final class Failure extends IOException {
        final int status;
        Failure(int status) { super("BRIDGE_REQUEST_FAILED"); this.status = status; }
    }
    static String cookie() throws IOException {
        String all = CookieManager.getInstance().getCookie(HOME);
        if (all != null) for (String part : all.split(";")) {
            String value = part.trim();
            if (value.matches("codex_phone=[A-Za-z0-9_-]{43}")) return value;
        }
        throw new Failure(401);
    }
    static HttpURLConnection open(String path, String cookie) throws IOException {
        if (!path.matches("api/(?:session|events(?:\\?cursor=[a-f0-9]{24}\\.[0-9]{1,12})?|files/[A-Za-z0-9_-]{43}(?:/info)?)")) throw new IOException("PATH_REJECTED");
        HttpURLConnection connection = (HttpURLConnection) new URL(HOME + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(12000); connection.setReadTimeout(20000);
        connection.setUseCaches(false); connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }
    static JSONObject json(String path, String cookie) throws Exception {
        HttpURLConnection connection = open(path, cookie);
        try {
            int status = connection.getResponseCode(); if (status != 200) throw new Failure(status);
            String type = connection.getContentType();
            if (type == null || !type.startsWith("application/json")) throw new IOException("INVALID_RESPONSE");
            if (connection.getContentLengthLong() > 262144) throw new IOException("RESPONSE_LIMIT");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int n;
                while ((n = input.read(buffer)) != -1) { if (output.size() + n > 262144) throw new IOException("RESPONSE_LIMIT"); output.write(buffer, 0, n); }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { connection.disconnect(); }
    }
    static String scope(JSONObject json) throws IOException {
        String scope = json.optString("storageScope"); if (!scope.matches("[a-f0-9]{64}")) throw new IOException("INVALID_SCOPE"); return scope;
    }
}
