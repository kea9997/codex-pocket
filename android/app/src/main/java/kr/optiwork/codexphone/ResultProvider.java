package dev.codexpocket.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;

public final class ResultProvider extends ContentProvider {
    static final String AUTHORITY = "dev.codexpocket.app.results";
    static final long TTL = 6L * 60 * 60 * 1000, CACHE_LIMIT = 2300L * 1024 * 1024;
    static File directory(Context context) throws Exception {
        File directory = new File(context.getCacheDir(), "results-v2");
        if (!directory.isDirectory() && !directory.mkdir()) throw new java.io.IOException("CACHE_UNAVAILABLE");
        if (!directory.getCanonicalPath().equals(directory.getAbsolutePath())) throw new java.io.IOException("CACHE_PATH_REJECTED");
        return directory;
    }
    static File owned(Context context, String id, String suffix) throws Exception {
        if (!id.matches("[a-f0-9-]{36}") || !suffix.matches("data|json|part")) throw new FileNotFoundException();
        File file = new File(directory(context), id + "." + suffix);
        if (!file.getCanonicalPath().equals(file.getAbsolutePath())) throw new FileNotFoundException();
        return file;
    }
    static synchronized void cleanup(Context context, long reserve) throws Exception {
        File[] files = directory(context).listFiles(); if (files == null) throw new java.io.IOException("CACHE_UNAVAILABLE");
        ArrayList<File> data = new ArrayList<>(); long total = 0;
        for (File file : files) {
            if (!file.getName().matches("[a-f0-9-]{36}\\.(?:data|json|part)") || !file.getCanonicalPath().equals(file.getAbsolutePath())) continue;
            // Called before the sole process-wide transfer creates its part; remaining parts are interrupted downloads.
            if (file.getName().endsWith(".part") || System.currentTimeMillis() - file.lastModified() > TTL) { if (!file.delete()) throw new java.io.IOException("CACHE_CLEANUP_FAILED"); continue; }
            if (file.getName().endsWith(".data")) { data.add(file); total += file.length(); }
        }
        data.sort(Comparator.comparingLong(File::lastModified));
        while (!data.isEmpty() && (data.size() >= 8 || total + reserve > CACHE_LIMIT)) {
            File file = data.remove(0); total -= file.length(); String id = file.getName().substring(0, 36);
            owned(context, id, "json").delete(); if (!file.delete()) throw new java.io.IOException("CACHE_CLEANUP_FAILED");
        }
        if (total + reserve > CACHE_LIMIT || directory(context).getUsableSpace() < reserve + 32L * 1024 * 1024) throw new java.io.IOException("CACHE_LIMIT");
    }
    static Uri publish(Context context, String id, JSONObject info) throws Exception {
        File metadata = owned(context, id, "json");
        if (metadata.exists()) throw new java.io.IOException("CACHE_COLLISION");
        JSONObject value = new JSONObject().put("name", info.getString("name")).put("mime", info.getString("mime")).put("size", info.getLong("size")).put("created", System.currentTimeMillis());
        Files.write(metadata.toPath(), value.toString().getBytes(StandardCharsets.UTF_8), java.nio.file.StandardOpenOption.CREATE_NEW);
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(id).build();
    }
    private String id(Uri uri) throws Exception {
        if (!"content".equals(uri.getScheme()) || !AUTHORITY.equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null || uri.getPathSegments().size() != 1) throw new FileNotFoundException();
        String id = uri.getLastPathSegment(); owned(getContext(), id, "data"); return id;
    }
    private JSONObject metadata(Uri uri) throws Exception {
        String id = id(uri); File data = owned(getContext(), id, "data"), metadata = owned(getContext(), id, "json");
        if (!data.isFile() || !metadata.isFile() || metadata.length() > 4096) throw new FileNotFoundException();
        JSONObject info = new JSONObject(new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8));
        if (System.currentTimeMillis() - info.getLong("created") > TTL || data.length() != info.getLong("size")) throw new FileNotFoundException();
        return info;
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { try { return metadata(uri).getString("mime"); } catch (Exception failure) { return null; } }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            JSONObject info = metadata(uri); MatrixCursor cursor = new MatrixCursor(new String[]{ OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
            cursor.addRow(new Object[]{ info.getString("name"), info.getLong("size") }); return cursor;
        } catch (Exception failure) { return new MatrixCursor(new String[]{ OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException();
        try { metadata(uri); return ParcelFileDescriptor.open(owned(getContext(), id(uri), "data"), ParcelFileDescriptor.MODE_READ_ONLY); }
        catch (Exception failure) { throw new FileNotFoundException(); }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
