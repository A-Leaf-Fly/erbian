package app.erbian.player;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * 耳边 · 音乐（本地版）
 * Node 运行时 + listen-server.js + listen.html 全在 APK 内，启动后只连 127.0.0.1。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "erbian_app";
    private static final String KEY_LAST_CLEAN = "last_clean";
    private static final String KEY_AUTO = "auto_clean";

    /** 超过 200MB 自动清 */
    private static final long AUTO_MAX_BYTES = 200L * 1024 * 1024;
    private static final long AUTO_MIN_BYTES = 20L * 1024 * 1024;
    private static final long AUTO_MAX_AGE = 7L * 24 * 60 * 60 * 1000;

    private static final int REQ_FILE = 0x51;

    private WebView web;
    private View splash;
    private TextView splashTip;
    private ProgressBar bar;
    private PowerManager.WakeLock wake;
    private ValueCallback<Uri[]> fileCb;
    private volatile boolean playing;
    private boolean booting;
    private long lastBackAt;
    private static boolean notifHintShown;

    /** MediaService 通过它把通知栏按键转成页面 JS 调用 */
    private static java.lang.ref.WeakReference<MainActivity> ref;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        ref = new java.lang.ref.WeakReference<>(this);
        applyWindow();
        buildUi();
        boot();
    }

    /** 供 MediaService 在任意线程调用；内部切到 UI 线程执行页面 JS */
    public static void execJs(final String js) {
        final MainActivity a = ref == null ? null : ref.get();
        if (a == null || a.isFinishing()) return;
        a.runOnUiThread(new Runnable() {
            public void run() {
                try {
                    if (a.web != null) a.web.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void applyWindow() {
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(0xFFF5F6F8);
        w.setNavigationBarColor(0xFFF5F6F8);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        w.getDecorView().setSystemUiVisibility(flags);
    }

    /* ---------------- UI ---------------- */

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF5F6F8);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " EarSideApp/2.5");
        web.setBackgroundColor(0xFFF5F6F8);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "EarSide");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String sch = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
                if (!sch.startsWith("http")) {
                    openOutside(u);
                    return true;
                }
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                if (host.equals("127.0.0.1") || host.equals("localhost")) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                bar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame() && !booting) {
                    Toast.makeText(MainActivity.this, "本地服务没响应，点一下重新加载",
                            Toast.LENGTH_LONG).show();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                if (p >= 100) {
                    bar.setVisibility(View.GONE);
                } else {
                    bar.setVisibility(View.VISIBLE);
                    bar.setProgress(p);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
            }
        });

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(ColorStateList.valueOf(0xFF534AB7));
        bar.setBackgroundColor(Color.TRANSPARENT);
        bar.setVisibility(View.GONE);

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(2, dp(2.5f)));
        lp.gravity = Gravity.TOP;
        root.addView(bar, lp);

        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private View buildSplash() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(0xFFF5F6F8);

        TextView logo = new TextView(this);
        logo.setText("耳边");
        logo.setTextSize(30f);
        logo.setGravity(Gravity.CENTER);
        logo.setTextColor(0xFF534AB7);
        logo.setTypeface(logo.getTypeface(), android.graphics.Typeface.BOLD);
        box.addView(logo);

        ProgressBar sp = new ProgressBar(this);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(dp(26), dp(26));
        slp.topMargin = dp(26);
        sp.setIndeterminateTintList(ColorStateList.valueOf(0xFF534AB7));
        box.addView(sp, slp);

        splashTip = new TextView(this);
        splashTip.setText("正在启动本地引擎…");
        splashTip.setTextSize(13f);
        splashTip.setTextColor(0xFF646A77);
        splashTip.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(14);
        box.addView(splashTip, tlp);
        return box;
    }

    /* ---------------- 启动本地引擎 ---------------- */

    private void boot() {
        if (booting) return;
        booting = true;
        splash.setVisibility(View.VISIBLE);
        splashTip.setText("正在启动本地引擎…");

        new Thread(new Runnable() {
            public void run() {
                if (NodeEngine.probe()) {
                    onEngineReady();
                    return;
                }
                int rc = NodeEngine.start(MainActivity.this);
                if (rc != 0) {
                    onEngineFailed(NodeEngine.libError().isEmpty()
                            ? "引擎加载失败（code " + rc + "）" : NodeEngine.libError());
                    return;
                }
                if (NodeEngine.waitReady(30000)) {
                    onEngineReady();
                } else {
                    onEngineFailed("本地服务 30 秒内没有就绪");
                }
            }
        }, "engine-boot").start();
    }

    private void onEngineReady() {
        runOnUiThread(new Runnable() {
            public void run() {
                booting = false;
                bar.setVisibility(View.VISIBLE);
                web.loadUrl(NodeEngine.ORIGIN + "/?v=" + System.currentTimeMillis());
                splash.postDelayed(new Runnable() {
                    public void run() {
                        splash.setVisibility(View.GONE);
                    }
                }, 450);
            }
        });
    }

    private void onEngineFailed(final String why) {
        runOnUiThread(new Runnable() {
            public void run() {
                booting = false;
                splashTip.setText("引擎启动失败");
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("本地引擎启动失败")
                        .setMessage(why + "\n\n可以点「重试」。如果一直失败，把手机型号发我，"
                                + "我用 32 位版本重新打包。")
                        .setPositiveButton("重试", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                boot();
                            }
                        })
                        .setNegativeButton("退出", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                finish();
                            }
                        })
                        .show();
            }
        });
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 抖音在应用内登录 ---------------- */

    private void openDouyinLogin() {
        final Dialog dlg = new Dialog(this, android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);

        final TextView head = new TextView(this);
        head.setText("登录抖音 · 成功后自动绑定，无需手动确认\n用手机号验证码登录最方便；窗口里也可以扫码");
        head.setTextSize(13f);
        head.setTextColor(0xFF53586A);
        head.setPadding(dp(16), dp(14), dp(16), dp(10));
        root.addView(head);

        final WebView dv = new WebView(this);
        WebSettings ds = dv.getSettings();
        ds.setJavaScriptEnabled(true);
        ds.setDomStorageEnabled(true);
        ds.setDatabaseEnabled(true);
        ds.setLoadWithOverviewMode(true);
        ds.setUseWideViewPort(true);
        ds.setMediaPlaybackRequiresUserGesture(false);
        ds.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(dv, true);
        dv.loadUrl("https://www.douyin.com/");
        root.addView(dv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        final Button done = new Button(this);
        done.setText("我已登录完成（也可以等自动检测）");
        done.setAllCaps(false);
        done.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF534AB7);
        bg.setCornerRadius(dp(11));
        done.setBackground(bg);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46));
        blp.setMargins(dp(14), dp(10), dp(14), dp(14));
        root.addView(done, blp);

        /* 登录成功的绑定动作：自动检测和手动按钮共用 */
        final java.util.concurrent.atomic.AtomicBoolean bound =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        final Runnable[] bindNow = new Runnable[1];

        bindNow[0] = new Runnable() {
            public void run() {
                if (!bound.compareAndSet(false, true)) return;
                String cookie = "";
                try {
                    cookie = CookieManager.getInstance().getCookie("https://www.douyin.com");
                } catch (Throwable ignored) {
                }
                if (cookie == null || !cookie.toLowerCase(Locale.ROOT).contains("sessionid")) {
                    bound.set(false);
                    return;
                }
                done.setEnabled(false);
                done.setText("检测到登录，正在绑定…");
                final String payload = cookie;
                new Thread(new Runnable() {
                    public void run() {
                        final String err = postDyCookie(payload);
                        runOnUiThread(new Runnable() {
                            public void run() {
                                if (err == null) {
                                    dlg.dismiss();
                                    Toast.makeText(MainActivity.this, "抖音登录成功，已自动绑定",
                                            Toast.LENGTH_SHORT).show();
                                    web.evaluateJavascript(
                                            "window.__onDyLogin&&window.__onDyLogin(true,'')", null);
                                } else {
                                    bound.set(false);
                                    done.setEnabled(true);
                                    done.setText("绑定失败，点此重试");
                                    Toast.makeText(MainActivity.this, err, Toast.LENGTH_LONG).show();
                                }
                            }
                        });
                    }
                }).start();
            }
        };

        done.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                bindNow[0].run();
            }
        });

        /* 自动检测：窗口开着时每 1.5s 看一眼 Cookie，出现 sessionid 就自动绑定 */
        final android.os.Handler poller = new android.os.Handler();
        final Runnable[] poll = new Runnable[1];
        poll[0] = new Runnable() {
            public void run() {
                if (!dlg.isShowing() || bound.get()) return;
                String ck = "";
                try {
                    ck = CookieManager.getInstance().getCookie("https://www.douyin.com");
                } catch (Throwable ignored) {
                }
                if (ck != null && ck.toLowerCase(Locale.ROOT).contains("sessionid")) {
                    head.setText("检测到登录成功，正在自动绑定…");
                    bindNow[0].run();
                    return;
                }
                poller.postDelayed(poll[0], 1500);
            }
        };

        dlg.setContentView(root);
        Window w = dlg.getWindow();
        if (w != null) {
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }
        dlg.setOnDismissListener(new DialogInterface.OnDismissListener() {
            public void onDismiss(DialogInterface d) {
                poller.removeCallbacksAndMessages(null);
                try {
                    dv.destroy();
                } catch (Throwable ignored) {
                }
            }
        });
        dlg.show();
        poller.postDelayed(poll[0], 1500);
    }

    /** 把 WebView 里的抖音 Cookie 交给本地服务；成功返回 null，失败返回原因 */
    private String postDyCookie(String cookie) {
        HttpURLConnection c = null;
        try {
            String body = "{\"cookie\":" + quote(cookie) + "}";
            URL u = new URL(NodeEngine.ORIGIN + "/api/dy/login/cookie");
            c = (HttpURLConnection) u.openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(4000);
            c.setReadTimeout(20000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.close();
            int code = c.getResponseCode();
            java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) sb.append(new String(b, 0, n, "UTF-8"));
                in.close();
            }
            String text = sb.toString();
            if (code >= 200 && code < 300 && text.contains("\"ok\":true")) return null;
            if (text.contains("sessionid")) return "Cookie 里没有 sessionid，可能还没登录成功";
            return "绑定失败：" + (text.isEmpty() ? ("HTTP " + code) : text.substring(0, Math.min(80, text.length())));
        } catch (Exception e) {
            return "绑定失败：" + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') sb.append('\\').append(ch);
            else if (ch == '\n') sb.append("\\n");
            else if (ch == '\r') sb.append("\\r");
            else sb.append(ch);
        }
        return sb.append('"').toString();
    }

    /* ---------------- 播放时的常亮锁 ---------------- */

    private void keepAwake(boolean on) {
        try {
            if (on) {
                if (wake == null) {
                    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erbian:playback");
                    wake.setReferenceCounted(false);
                }
                if (!wake.isHeld()) wake.acquire(4L * 60 * 60 * 1000);
            } else if (wake != null && wake.isHeld()) {
                wake.release();
            }
        } catch (Throwable ignored) {
        }
    }

    /* ---------------- 缓存 ---------------- */

    private long cacheBytes() {
        return dirSize(getCacheDir()) + dirSize(getExternalCacheDir());
    }

    private String cacheJson() {
        long bytes = cacheBytes() + dirSize(new File(getFilesDir(), "engine"));
        long last = prefs().getLong(KEY_LAST_CLEAN, 0L);
        return "{\"bytes\":" + bytes + ",\"lastClean\":" + last + "}";
    }

    private long clearDiskCache() {
        long before = cacheBytes();
        web.post(new Runnable() {
            public void run() {
                try {
                    web.clearCache(true);
                } catch (Throwable ignored) {
                }
            }
        });
        if (!playing) {
            wipeChildren(getCacheDir(), 0);
            wipeChildren(getExternalCacheDir(), 0);
        }
        prefs().edit().putLong(KEY_LAST_CLEAN, System.currentTimeMillis()).apply();
        long after = cacheBytes();
        return Math.max(0, before - after);
    }

    private long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        File[] list = f.listFiles();
        if (list == null) return 0;
        long n = 0;
        for (File c : list) n += dirSize(c);
        return n;
    }

    private void wipeChildren(File dir, int depth) {
        if (dir == null || !dir.isDirectory() || depth > 8) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            String n = f.getName().toLowerCase(Locale.ROOT);
            if (n.startsWith("webview") || n.startsWith("org.chromium") || n.equals("node-tmp")) continue;
            if (f.isDirectory()) {
                wipeChildren(f, depth + 1);
                f.delete();
            } else {
                f.delete();
            }
        }
    }

    private boolean needAutoClean() {
        if (!prefs().getBoolean(KEY_AUTO, true)) return false;
        if (playing) return false;
        long bytes = cacheBytes();
        if (bytes > AUTO_MAX_BYTES) return true;
        long last = prefs().getLong(KEY_LAST_CLEAN, 0L);
        return last > 0 && bytes > AUTO_MIN_BYTES
                && System.currentTimeMillis() - last > AUTO_MAX_AGE;
    }

    /* ---------------- 与页面通信 ---------------- */

    private class Bridge {
        @JavascriptInterface
        public String cacheInfo() {
            return cacheJson();
        }

        @JavascriptInterface
        public String clearCache(String level) {
            return String.valueOf(clearDiskCache());
        }

        @JavascriptInterface
        public void setAutoClean(boolean on) {
            prefs().edit().putBoolean(KEY_AUTO, on).apply();
        }

        @JavascriptInterface
        public void setPlaying(final boolean p, final String title, final String artist) {
            playing = p;
            runOnUiThread(new Runnable() {
                public void run() {
                    keepAwake(p);
                    if (p && !notifHintShown && !notificationsOn()) {
                        notifHintShown = true;
                        if (android.os.Build.VERSION.SDK_INT >= 33) {
                            try {
                                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 0x52);
                            } catch (Throwable ignored) {
                            }
                        }
                        Toast.makeText(MainActivity.this,
                                "想让通知栏/锁屏显示播放控制？请在系统设置里允许「耳边」发通知",
                                Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        /** 页面 → 原生：播放状态（标题/歌手/进度/封面），驱动通知栏与锁屏媒体卡片 */
        @JavascriptInterface
        public void mediaState(final String json) {
            boolean p = json != null && json.contains("\"playing\":true");
            playing = p;
            MediaService.sync(MainActivity.this, p, json);
        }

        /** 本地版：没有可切换的服务器，页面据此隐藏「服务器」卡片 */
        @JavascriptInterface
        public String currentServer() {
            return NodeEngine.ORIGIN;
        }

        @JavascriptInterface
        public String isLocal() {
            return "1";
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(new Runnable() {
                public void run() {
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("本地引擎")
                            .setMessage("音乐服务就在这台手机里运行（" + NodeEngine.ORIGIN + "），"
                                    + "不连任何外部服务器。\n\n引擎状态："
                                    + (NodeEngine.running() ? "运行中" : "未启动"))
                            .setPositiveButton("知道了", null)
                            .setNeutralButton("重启引擎", new DialogInterface.OnClickListener() {
                                public void onClick(DialogInterface d, int w) {
                                    boot();
                                }
                            })
                            .show();
                }
            });
        }

        /** 抖音登录：手机上没有 Chrome，改成应用内登录 */
        @JavascriptInterface
        public void loginDouyin() {
            runOnUiThread(new Runnable() {
                public void run() {
                    openDouyinLogin();
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager()
                        .getPackageInfo(getPackageName(), 0).versionName;
            } catch (Throwable t) {
                return "2.5.0";
            }
        }
    }

    /** 通知是否可用（Android 13+ 看 POST_NOTIFICATIONS，低版本看系统开关） */
    private boolean notificationsOn() {
        try {
            android.app.NotificationManager nm =
                    (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (!nm.areNotificationsEnabled()) return false;
            if (android.os.Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) return false;
            return true;
        } catch (Throwable t) {
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == 0x52) {
            if (results.length == 0 || results[0] != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this,
                        "未允许通知：通知栏和锁屏将不会显示播放控制，可在 系统设置→应用→耳边→通知 里开启",
                        Toast.LENGTH_LONG).show();
            }
            return;
        }
        super.onRequestPermissionsResult(req, perms, results);
    }

    /* ---------------- 生命周期 ---------------- */

    @Override
    protected void onStop() {
        super.onStop();
        if (needAutoClean()) clearDiskCache();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 正在播放：返回键 = 退到后台继续播（通知栏/锁屏可控制），不杀播放
        if (playing) {
            moveTaskToBack(true);
            Toast.makeText(this, "已在后台播放 · 通知栏可控制", Toast.LENGTH_SHORT).show();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{data.getData()};
                }
            }
            if (fileCb != null) {
                fileCb.onReceiveValue(out);
                fileCb = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    protected void onDestroy() {
        keepAwake(false);
        if (!playing) MediaService.stop(this);   // 还在播就让前台服务续命
        if (web != null) {
            try {
                web.removeJavascriptInterface("EarSide");
                web.destroy();
            } catch (Throwable ignored) {
            }
        }
        super.onDestroy();
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}
