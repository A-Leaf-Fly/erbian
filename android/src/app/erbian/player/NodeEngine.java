package app.erbian.player;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
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

    /** 资源版本号：由 build-local.sh 按 verCode 自动注入（勿手改），升级 APK 必然重新解包 */
    private static final String ASSET_VERSION = "11";

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
     * 版本号由 build-local.sh 按 verCode 自动注入，升级 APK 必然重新解包；
     * 另加「关键文件大小比对」兜底，避免忘了改版本号导致页面一直跑旧版。
     */
    public static File prepare(Context ctx) throws IOException {
        File dir = runtimeDir(ctx);
        File stamp = new File(dir, ".asset_version");
        boolean sameVer = dir.isDirectory() && stamp.isFile() && ASSET_VERSION.equals(readSmall(stamp));
        if (sameVer && assetSizeSame(ctx, dir)) {
            return dir;
        }
        // 重新解包前把运行数据挪出来，避免用户缓存/登录态被一起删掉
        File keep = new File(ctx.getFilesDir(), "engine_keep");
        if (keep.exists()) deleteTree(keep, 0);
        keep.mkdirs();
        String[] keepNames = {".listen-data", ".dydata"};
        for (String n : keepNames) stash(new File(dir, n), new File(keep, n));

        if (dir.exists()) deleteTree(dir, 0);
        dir.mkdirs();
        copyAsset(ctx.getAssets(), "node", dir);

        for (String n : keepNames) stash(new File(keep, n), new File(dir, n));
        deleteTree(keep, 0);
        writeSmall(stamp, ASSET_VERSION);
        return dir;
    }

    /** 把 src 挪到 dst（同分区 rename，失败则递归复制） */
    private static void stash(File src, File dst) {
        if (src == null || !src.exists()) return;
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        if (src.renameTo(dst)) return;
        try {
            copyTree(src, dst, 0);
            deleteTree(src, 0);
        } catch (Exception ignored) {
        }
    }

    private static void copyTree(File src, File dst, int depth) throws IOException {
        if (src == null || depth > 8) return;
        if (src.isFile()) {
            File parent = dst.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            InputStream in = new FileInputStream(src);
            OutputStream os = new FileOutputStream(dst);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                os.flush();
            } finally {
                try { in.close(); } catch (IOException ignored) {}
                try { os.close(); } catch (IOException ignored) {}
            }
            return;
        }
        dst.mkdirs();
        File[] kids = src.listFiles();
        if (kids == null) return;
        for (File k : kids) copyTree(k, new File(dst, k.getName()), depth + 1);
    }

    /** assets 里的页面/服务端与已解包副本字节数是否一致 */
    private static boolean assetSizeSame(Context ctx, File dir) {
        try {
            String[] keys = {"listen.html", "listen-server.js"};
            for (String k : keys) {
                long a = assetLength(ctx.getAssets(), "node/" + k);
                File f = new File(dir, k);
                if (a < 0 || !f.isFile() || f.length() != a) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static long assetLength(AssetManager am, String path) {
        InputStream in = null;
        try {
            in = am.open(path);
            long n = 0;
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = in.read(buf)) > 0) n += r;
            return n;
        } catch (Exception e) {
            return -1;
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) {}
        }
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
