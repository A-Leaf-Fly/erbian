package app.erbian.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 前台媒体服务：通知栏播放卡片 + 锁屏控制 + 音频焦点。
 * 音频本体仍由 WebView 播放；服务只负责「保持进程活着 + 提供系统媒体控制」。
 * 页面通过 EarSide.mediaState(json) 上报状态；控制指令回调到
 * MainActivity.execJs(...) → window.__mediaCtl(cmd)。
 */
public class MediaService extends Service {

    private static final String CH_ID = "erbian_playback";
    private static final int NOTI_ID = 0xEB41;

    static final String ACT_TOGGLE = "app.erbian.MEDIA_TOGGLE";
    static final String ACT_NEXT = "app.erbian.MEDIA_NEXT";
    static final String ACT_PREV = "app.erbian.MEDIA_PREV";
    static final String ACT_CLOSE = "app.erbian.MEDIA_CLOSE";

    private MediaSession session;
    private Handler main;
    private PowerManager.WakeLock wake;
    private AudioFocusRequest focusReq;
    private AudioManager audioMan;

    private boolean playing;
    private String title = "", artist = "", cover = "";
    private long durMs, posMs;
    private Bitmap coverBm;
    private String coverLoaded = "";

    public static void sync(Context ctx, boolean isPlaying, String json) {
        Intent i = new Intent(ctx, MediaService.class);
        i.setAction("sync");
        i.putExtra("playing", isPlaying);
        i.putExtra("state", json == null ? "" : json);
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, MediaService.class));
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        main = new Handler(Looper.getMainLooper());
        audioMan = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        setUpSession();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erbian:svc");
        wake.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startAsForeground();
        if (intent != null && "sync".equals(intent.getAction())) {
            playing = intent.getBooleanExtra("playing", playing);
            applyStateJson(intent.getStringExtra("state"));
        } else if (intent != null) {
            String a = intent.getAction();
            if (ACT_TOGGLE.equals(a)) MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('toggle')");
            else if (ACT_NEXT.equals(a)) MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('next')");
            else if (ACT_PREV.equals(a)) MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('prev')");
            else if (ACT_CLOSE.equals(a)) {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('pause')");
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        refreshSession();
        refreshNotification();
        if (playing) {
            if (!wake.isHeld()) wake.acquire(4L * 60 * 60 * 1000);
            requestFocus();
        } else {
            if (wake.isHeld()) wake.release();
        }
        return START_STICKY;
    }

    /* ---------------- MediaSession ---------------- */

    private void setUpSession() {
        session = new MediaSession(this, "Erbian");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('play')");
            }

            @Override
            public void onPause() {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('pause')");
            }

            @Override
            public void onSkipToNext() {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('next')");
            }

            @Override
            public void onSkipToPrevious() {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('prev')");
            }

            @Override
            public void onSeekTo(long pos) {
                MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('seek:" + (pos / 1000) + "')");
            }
        });
        session.setActive(true);
    }

    private void refreshSession() {
        try {
            MediaMetadata.Builder mb = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE,
                            title.isEmpty() ? "耳边 · 未在播放" : title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST,
                            artist.isEmpty() ? "选一首歌开始吧" : artist)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, durMs);
            Bitmap bm = currentCover();
            if (bm != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bm);
            session.setMetadata(mb.build());

            long actions = PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
                    | (playing ? PlaybackState.ACTION_PAUSE : PlaybackState.ACTION_PLAY);
            PlaybackState.Builder pb = new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            posMs, playing ? 1f : 0f);
            session.setPlaybackState(pb.build());
        } catch (Throwable ignored) {
        }
    }

    /* ---------------- 通知 ---------------- */

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_ID, "正在播放",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        try {
            startForeground(NOTI_ID, buildNotification());
        } catch (Throwable ignored) {
        }
    }

    private PendingIntent ctl(String action) {
        Intent i = new Intent(this, MediaService.class);
        i.setAction(action);
        int fl = android.os.Build.VERSION.SDK_INT >= 31
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getService(this, action.hashCode(), i, fl);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int fl = android.os.Build.VERSION.SDK_INT >= 31
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(this, 7, i, fl);
    }

    private Notification buildNotification() {
        Notification.Builder b = android.os.Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(openApp())
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setContentTitle(title.isEmpty() ? "耳边 · 未在播放" : title)
                .setContentText(artist.isEmpty() ? "选一首歌开始吧" : artist)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action(android.R.drawable.ic_media_previous,
                        "上一首", ctl(ACT_PREV)))
                .addAction(new Notification.Action(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "暂停" : "播放", ctl(ACT_TOGGLE)))
                .addAction(new Notification.Action(android.R.drawable.ic_media_next,
                        "下一首", ctl(ACT_NEXT)));

        Bitmap bm = currentCover();
        if (bm != null) b.setLargeIcon(bm);

        if (android.os.Build.VERSION.SDK_INT >= 21) {
            Notification.MediaStyle st = new Notification.MediaStyle();
            st.setMediaSession(session.getSessionToken());
            st.setShowActionsInCompactView(0, 1, 2);
            b.setStyle(st);
        }
        return b.build();
    }

    private void refreshNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTI_ID, buildNotification());
        } catch (Throwable ignored) {
        }
    }

    /* ---------------- 封面 ---------------- */

    private Bitmap currentCover() {
        if (cover == null || cover.isEmpty()) return null;
        if (cover.equals(coverLoaded) && coverBm != null) return coverBm;
        if (!cover.startsWith("http")) return null;
        final String url = cover;
        new Thread(new Runnable() {
            public void run() {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(8000);
                    InputStream in = c.getInputStream();
                    Bitmap bm = BitmapFactory.decodeStream(in);
                    in.close();
                    c.disconnect();
                    if (bm != null) {
                        int side = Math.min(bm.getWidth(), bm.getHeight());
                        if (side > 512) {
                            float k = 512f / side;
                            bm = Bitmap.createScaledBitmap(bm,
                                    Math.round(bm.getWidth() * k), Math.round(bm.getHeight() * k), true);
                        }
                        coverBm = bm;
                        coverLoaded = url;
                        main.post(new Runnable() {
                            public void run() {
                                refreshSession();
                                refreshNotification();
                            }
                        });
                    }
                } catch (Throwable ignored) {
                }
            }
        }, "cover-fetch").start();
        return coverBm;
    }

    /* ---------------- 状态与焦点 ---------------- */

    private void applyStateJson(String json) {
        if (json == null || json.isEmpty()) return;
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            title = o.optString("title", "");
            artist = o.optString("artist", "");
            cover = o.optString("cover", "");
            durMs = (long) (o.optDouble("dur", 0) * 1000);
            posMs = (long) (o.optDouble("pos", 0) * 1000);
        } catch (Throwable ignored) {
        }
    }

    private void requestFocus() {
        try {
            if (focusReq == null) {
                AudioAttributes at = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(at)
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
            }
            audioMan.requestAudioFocus(focusReq);
        } catch (Throwable t) {
            try { // API < 26 老接口
                audioMan.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN);
            } catch (Throwable ignored) {
            }
        }
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                public void onAudioFocusChange(int f) {
                    if (f == AudioManager.AUDIOFOCUS_LOSS
                            || f == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                        MainActivity.execJs("window.__mediaCtl&&window.__mediaCtl('pause')");
                    }
                }
            };

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务划掉 APP：WebView 已死，收掉通知
        try {
            stopForeground(true);
            stopSelf();
        } catch (Throwable ignored) {
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        try {
            if (session != null) {
                session.release();
                session = null;
            }
            if (wake != null && wake.isHeld()) wake.release();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
