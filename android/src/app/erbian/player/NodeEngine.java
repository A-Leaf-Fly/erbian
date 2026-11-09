package app.erbian.player;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 本地引擎：把内置的 Node 运行时和 listen-server.js 拉起来。
 * 启动后页面走 http://127.0.0.1:PORT/，不再依赖任何外部服务器。
 */
public final class NodeEngine {

    public static final String TAG = "ErbianNode";
    public static final int PORT = 5599;
    public static final String ORIGIN = "http://127.0.0.1:" + PORT;

    /** 资源版本号，改了 assets/node 里的文件就加一，触发重新解包 */
    private static final String ASSET_VERSION = "1";

    private static final NodeEngine INSTANCE = new NodeEngine();

    private static boolean libsReady;
    private static String libError = "";
    private static volatile int lastExit = -1;

    static native int nativeStart(String[] args, String workDir, String[] env, Object listener);

    static native boolean nativeRunning();

    static native int nativeExitCode();

    private NodeEngine() {
    }

    /* ---------------- 库加载 ---------------- */

    private static synchronized void loadLibs() {
        if (libsReady) return;
        try {
            System.loadLibrary("c++_shared");
        } catch (Throwable t) {
            Log.w(TAG, "load c++_shared failed: " + t.getMessage());
        }
        try {
            System.loadLibrary("node");
            System.loadLibrary("nodestart");
            libsReady = true;
        } catch (Throwable t) {
            libError = t.getMessage();
            Log.e(TAG, "load libnode failed", t);
        }
    }

    public static String libError() {
        return libError;
    }

    /* ---------------- 资源解包 ---------------- */

    private static File runtimeDir(Context ctx) {
        return new File(ctx.getFilesDir(), "engine");
    }

    /**
     * 把 assets/node 整棵树解到私有目录，顺带写入版本号；版本没变就跳过。
     */
    public static File prepare(Context ctx) throws IOException {
        File dir = runtimeDir(ctx);
        File stamp = new File(dir, ".asset_version");
        if (dir.isDirectory() && stamp.isFile() && ASSET_VERSION.equals(readSmall(stamp))) {
            return dir;
        }
        if (dir.exists()) deleteTree(dir, 0);
        dir.mkdirs();
        copyAsset(ctx.getAssets(), "node", dir);
        writeSmall(stamp, ASSET_VERSION);
        return dir;
    }

    private static void copyAsset(AssetManager am, String path, File out) throws IOException {
        String[] kids = am.list(path);
        if (kids != null && kids.length > 0) {
            if (!out.exists() && !out.mkdirs()) throw new IOException("mkdir " + out);
            for (String k : kids) copyAsset(am, path + "/" + k, new File(out, k));
            return;
        }
        File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
        InputStream in = null;
        OutputStream os = null;
        try {
            in = am.open(path);
            os = new FileOutputStream(out);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            os.flush();
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) {}
            if (os != null) try { os.close(); } catch (IOException ignored) {}
        }
    }

    private static void deleteTree(File f, int depth) {
        if (f == null || depth > 12) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k, depth + 1);
        f.delete();
    }

    private static String readSmall(File f) {
        try {
            InputStream in = new java.io.FileInputStream(f);
            byte[] b = new byte[64];
            int n = in.read(b);
            in.close();
            return n > 0 ? new String(b, 0, n, "UTF-8").trim() : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static void writeSmall(File f, String s) {
        try {
            OutputStream os = new FileOutputStream(f);
            os.write(s.getBytes("UTF-8"));
            os.close();
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 启动 ---------------- */

    /**
     * 解包并拉起 Node。返回 0 表示线程已起（不代表已能访问）。
     */
    public static int start(Context ctx) {
        loadLibs();
        if (!libsReady) return -1;

        File dir;
        try {
            dir = prepare(ctx);
        } catch (IOException e) {
            libError = "解包失败：" + e.getMessage();
            return -1;
        }

        File entry = new File(dir, "listen-server.js");
        if (!entry.isFile()) {
            libError = "缺少 listen-server.js";
            return -1;
        }

        File cache = ctx.getCacheDir();
        File tmp = new File(cache, "node-tmp");
        tmp.mkdirs();

        String[] env = {
                "PORT=" + PORT,
                "HOST=127.0.0.1",
                "HOME=" + dir.getAbsolutePath(),
                "TMPDIR=" + tmp.getAbsolutePath(),
                "TZ=" + java.util.TimeZone.getDefault().getID(),
                "NODE_OPTIONS=--max-old-space-size=256"
        };
        String[] args = {"node", entry.getAbsolutePath()};
        Log.i(TAG, "starting node: " + entry);
        return nativeStart(args, dir.getAbsolutePath(), env, INSTANCE);
    }

    public static boolean running() {
        return libsReady && nativeRunning();
    }

    public static int exitCode() {
        return nativeExitCode();
    }

    /** 由 native 线程回调 */
    @SuppressWarnings("unused")
    public void onNodeExit(int code) {
        lastExit = code;
        Log.e(TAG, "node process exited: " + code);
    }

    /* ---------------- 健康检查 ---------------- */

    /** 探测本地服务是否已能响应，最多等 timeoutMs */
    public static boolean waitReady(long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (probe()) return true;
            try {
                Thread.sleep(220);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return probe();
    }

    public static boolean probe() {
        HttpURLConnection c = null;
        try {
            URL u = new URL(ORIGIN + "/api/health");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(500);
            c.setReadTimeout(900);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            return code >= 200 && code < 500;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
