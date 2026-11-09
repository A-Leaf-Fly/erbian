'use strict';
/**
 * Listen 本地服务
 * - 提供 listen.html 静态页面
 * - 代理网易云音乐接口（搜索 / 播放地址 / 歌词），绕开浏览器同源限制
 * 零第三方依赖，只用 Node 内置模块。启动：node listen-server.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');

const PORT = Number(process.env.PORT) || 5599;
const ROOT = __dirname;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ---------------- 连接复用（省掉每次 TLS 握手 ~200-400ms） ---------------- */
const AGENT_OPT = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, timeout: 60000 };
const httpsAgent = new https.Agent(AGENT_OPT);
const httpAgent = new http.Agent(AGENT_OPT);

/* ---------------- HTTP 请求封装 ---------------- */
function httpRequest(target, opt) {
  opt = opt || {};
  const method = opt.method || 'GET';
  const headers = Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opt.headers || {});
  const body = opt.body || null;
  const timeout = opt.timeout || 12000;

  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const lib = u.protocol === 'http:' ? http : https;
    const agent = u.protocol === 'http:' ? httpAgent : httpsAgent;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('上游请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(target, opt) {
  const r = await httpRequest(target, opt);
  if (r.status !== 200) throw new Error('上游返回 HTTP ' + r.status);
  return JSON.parse(r.text);
}

/* ---------------- 网易云加密（eapi） ---------------- */
const EAPI_KEY = 'e82ckenh8dichen8';

function aesEcbHex(text, key) {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('hex').toUpperCase();
}

function eapiParams(apiPath, obj) {
  const text = JSON.stringify(obj);
  const digest = crypto
    .createHash('md5')
    .update('nobody' + apiPath + 'use' + text + 'md5forencrypt', 'utf8')
    .digest('hex');
  return aesEcbHex(apiPath + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest, EAPI_KEY);
}

/* ---------------- 业务接口 ---------------- */
const NE_HEADERS = { Referer: 'https://music.163.com/', Origin: 'https://music.163.com' };
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

function coverOf(url) {
  if (!url) return '';
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'param=200y200';
}

/** 搜索单曲 */
async function searchSongs(kw, page, limit) {
  page = Math.max(1, Number(page) || 1);
  limit = Math.min(50, Math.max(1, Number(limit) || 24));
  const body = 's=' + encodeURIComponent(kw) + '&type=1&offset=' + (page - 1) * limit + '&limit=' + limit;
  const j = await getJson('https://music.163.com/api/search/get', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, NE_HEADERS),
    body
  });
  const list = (j.result && j.result.songs) || [];
  const songs = list.map((s) => ({
    id: 'ne' + s.id,
    songId: s.id,
    title: s.name,
    artist: (s.artists || []).map((a) => a.name).join(' / '),
    album: (s.album && s.album.name) || '',
    cover: '',
    duration: s.duration || 0,
    fee: s.fee,
    source: 'netease'
  }));
  await fillCovers(songs);
  return { total: (j.result && j.result.songCount) || songs.length, songs };
}

/** 网易云搜不到时的 B 站搜歌兜底：把视频标题清洗成「歌名 + 歌手」 */
function cleanSearchTitle(raw) {
  let s = String(raw || '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ');
  s = s.split(/[|｜:：_]/)[0];
  s = s.replace(REC_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 28);
}

async function biliSongSearch(kw, limit) {
  const list = await biliSearch(kw, 30);
  const cand = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const raw = String(v.title || '');
    if (!v.sec || v.sec < 45 || v.sec > 720) continue;
    if (/教学|教程|伴奏|钢琴|吉他|架子鼓|铃声|八音盒|合集|串烧|歌单|盘点|小时|reaction|舞蹈|翻跳|慢摇|串烧/i.test(raw)) continue;
    const m = raw.match(/《([^》]{1,40})》/);
    const name = m ? m[1].replace(REC_NOISE, '').trim() : cleanSearchTitle(raw);
    if (!name || name.length < 2) continue;
    cand.push({
      score: (m ? 100 : 0) + Math.min(50, Math.log10(Math.max(1, v.play || 1)) * 10),
      item: {
        id: 'bb' + v.bvid,
        songId: null,
        bvid: v.bvid,
        title: name,
        artist: (m ? guessArtist(raw) : '') || v.author || '',
        album: '',
        cover: v.cover || '',
        duration: (v.sec || 0) * 1000,
        source: 'bilibili'
      }
    });
  }
  cand.sort((a, b) => b.score - a.score);
  const songs = cand.slice(0, limit || 30).map((c) => c.item);
  return { total: songs.length, songs };
}

/** 并发跑异步任务（限制并发数，单个失败不影响整体） */
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const k = idx++;
      try {
        out[k] = await fn(arr[k], k);
      } catch (e) {
        out[k] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, worker));
  return out;
}

/** 分P名太敷衍（如「第1部分」）就用合集标题替代 */
function partName(raw, albumTitle, pn) {
  const s = String(raw || '').trim();
  if (!s || /^(第\s*\d+\s*(p|部分|集)?|part\s*\d+|p\s*\d+|[\d.]+)$/i.test(s)) return albumTitle + ' P' + pn;
  return s;
}

/** 明显不是歌的视频：影视剪辑 / 剧情号 / 解说 / 综艺切片（B 站直搜过滤用） */
const BILI_NOT_SONG =
  /电影|影视|解说|预告|花絮|纪录片|剧场|番剧|小品|相声|访谈|采访|名场面|大结局|第\s*\d+\s*[集季]|剧情|reaction|开箱|实况|游戏|vlog/i;

/** B 站「直接搜索」：合集/多P 视频自动拆成分P逐首展示（限定音乐区，滤掉视频音频） */
async function biliDirectSearch(kw, limit) {
  const list = await biliSearch(kw, Math.min(30, limit || 20));
  // 并发取详情，拿到分P列表（详情有 6h 缓存，只有第一次搜会多打几个请求）
  const infos = await mapLimit(list, 5, (v) => biliInfo(v.bvid));
  const out = [];
  const okDur = (s) => s >= 45 && s <= 900; // 一首歌的正常长度区间
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const info = infos[i];
    const pages = info && info.pages && info.pages.length > 1 ? info.pages.slice(0, 60) : null;
    if (pages) {
      // 合集：每个分P一首歌，副标题标合集名
      pages.forEach((pg, pi) => {
        if (!okDur(pg.dur || 0) || BILI_NOT_SONG.test(partName(pg.part, v.title, pi + 1))) return;
        out.push({
          id: 'bb' + v.bvid + '_' + (pi + 1),
          songId: null,
          bvid: v.bvid,
          page: pi + 1,
          cid: pg.cid,
          title: partName(pg.part, v.title, pi + 1),
          artist: v.author || '',
          album: '合集 · ' + v.title,
          cover: v.cover || '',
          duration: (pg.dur || 0) * 1000,
          play: v.play || 0,
          source: 'bilibili'
        });
      });
    } else {
      if (!okDur(v.sec || 0) || BILI_NOT_SONG.test(v.title)) continue;
      out.push({
        id: 'bb' + v.bvid,
        songId: null,
        bvid: v.bvid,
        page: null,
        title: v.title,
        artist: v.author || '',
        album: '',
        cover: v.cover || '',
        duration: (v.sec || 0) * 1000,
        play: v.play || 0,
        source: 'bilibili'
      });
    }
  }
  return out;
}

/* ---------------- QQ 音乐：只当「歌曲信息源」 ----------------
 * QQ 音乐的搜索准度最好（歌名/歌手/专辑/时长都对），但匿名拿不到播放地址
 * （vkey 返回空 purl），所以这里只负责给出准确的歌曲信息；
 * 播放时前端拿 title + artist 去 B 站/抖音找音轨。
 */
const QQ_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const qqCache = new Map();
const QQ_TTL = 5 * 60 * 1000;

async function qqSearch(kw, limit) {
  limit = Math.min(30, Math.max(1, Number(limit) || 20));
  const key = String(kw).toLowerCase() + '|' + limit;
  const hit = qqCache.get(key);
  if (hit && Date.now() - hit.ts < QQ_TTL) return hit.data;

  const url =
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&inCharset=utf8&outCharset=utf8&notice=0' +
    '&platform=h5&needNewCode=1&w=' + encodeURIComponent(kw) +
    '&zhidaqu=1&catZhida=1&t=0&flag_qc=0&p=1&n=' + limit + '&remoteplace=txt.mqq.all&utf8=1';
  const j = await getJson(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': QQ_UA } });
  const raw = (j && j.data && j.data.song && j.data.song.list) || [];
  const songs = raw
    .filter((s) => s && s.songmid && s.songname)
    .map((s) => ({
      id: 'qq' + s.songmid,
      songId: null,
      qqMid: s.songmid,
      bvid: null,
      title: s.songname,
      artist: (s.singer || []).map((x) => x.name).filter(Boolean).join(' / '),
      album: s.albumname || '',
      cover: s.albummid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + s.albummid + '.jpg' : '',
      duration: (s.interval || 0) * 1000,
      vip: !!(s.pay && s.pay.payplay),
      source: 'qq'
    }));
  const data = {
    total: (j && j.data && j.data.song && j.data.song.totalnum) || songs.length,
    songs
  };
  if (qqCache.size > 200) qqCache.clear();
  qqCache.set(key, { data, ts: Date.now() });
  return data;
}

/* ---------------- QQ 音乐：热门歌单 ---------------- */
/**
 * 歌单同样只当「信息源」：拿准确的歌单名 / 封面 / 歌曲列表，
 * 真正播放仍然交给 /api/resolve 去 B 站、抖音找音轨。
 */
const qqPlCache = new Map();

function qqPic(url, size) {
  let u = String(url || '');
  if (!u) return '';
  u = u.replace(/^http:\/\//, 'https://');
  if (size && /\/\d+(\?|$)/.test(u)) u = u.replace(/\/\d+(\?|$)/, '/' + size + '$1');
  return u;
}

function qqAlbumCover(mid) {
  return mid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + mid + '.jpg' : '';
}

/** QQ 歌曲（musicu 歌单接口的字段名是 name/singer/album.mid）→ 统一格式 */
function qqSongOf(s) {
  const mid = s.mid || s.songmid || '';
  const albumMid = (s.album && s.album.mid) || s.albummid || '';
  return {
    id: 'qq' + mid,
    songId: null,
    qqMid: mid,
    bvid: null,
    title: s.name || s.songname || s.title || '',
    artist: (s.singer || []).map((x) => x.name).filter(Boolean).join(' / '),
    album: (s.album && (s.album.name || s.album.title)) || s.albumname || '',
    cover: qqAlbumCover(albumMid),
    duration: (s.interval || 0) * 1000,
    vip: !!(s.pay && (s.pay.payplay || s.pay.pay_play)),
    source: 'qq'
  };
}

/** 热门歌单榜：categoryId=10000000 全部分类，sortId=5 按最热，sin 翻页拿下一批 */
async function qqHotPlaylists(limit, page) {
  limit = Math.min(24, Math.max(6, Number(limit) || 12));
  page = Math.max(0, Number(page) || 0);
  const sin = (page * limit) % 120;
  const key = 'hot|' + limit + '|' + sin;
  const hit = qqPlCache.get(key);
  if (hit && Date.now() - hit.ts < 60 * 1000) return hit.data;   // 只缓存 1 分钟：每次打开都尽量是新榜

  const url =
    'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=' + Math.random() +
    '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0' +
    '&categoryId=10000000&sortId=5&sin=' + sin + '&ein=' + (sin + limit - 1);
  const j = await getJson(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': QQ_UA } });
  const raw = (j && j.data && j.data.list) || [];
  const playlists = raw
    .filter((it) => it && it.dissid && it.dissname)
    .map((it) => ({
      id: String(it.dissid),
      name: it.dissname,
      cover: qqPic(it.imgurl, 300),
      listen: it.listennum || 0,
      creator: (it.creator && it.creator.name) || '',
      desc: it.introduction || '',
      time: it.commit_time || ''
    }));
  const data = { total: (j && j.data && j.data.sum) || playlists.length, playlists };
  if (qqPlCache.size > 80) qqPlCache.clear();
  qqPlCache.set(key, { data, ts: Date.now() });
  return data;
}

/** 歌单详情：musicu 的 aiDissInfo 接口（匿名可用） */
async function qqPlaylist(dissid, limit) {
  const id = String(dissid || '').replace(/\D/g, '');
  if (!id) throw new Error('歌单 id 不合法');
  limit = Math.min(100, Math.max(10, Number(limit) || 60));
  const key = 'pl|' + id + '|' + limit;
  const hit = qqPlCache.get(key);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;

  const body = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req_2: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: { disstid: Number(id), enc_host_uin: '', tag: 1, userinfo: 1, song_begin: 0, song_num: limit }
    }
  });
  const j = await getJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      Referer: 'https://y.qq.com/n/ryqq/playlist/' + id,
      Origin: 'https://y.qq.com',
      'Content-Type': 'application/json',
      'User-Agent': QQ_UA
    },
    body
  });
  const d = (j && j.req_2 && j.req_2.data) || {};
  if (!d.dirinfo) throw new Error((j && j.req_2 && j.req_2.msg) || '歌单读取失败');
  const dir = d.dirinfo || {};
  const songs = (d.songlist || []).map(qqSongOf).filter((s) => s.title && s.qqMid);
  const data = {
    id,
    name: dir.title || 'QQ 歌单',
    cover: qqPic(dir.picurl, 600),
    desc: dir.desc || '',
    creator: dir.host_nick || (dir.creator && dir.creator.nick) || '',
    listen: dir.listennum || 0,
    tags: (dir.tag || []).map((t) => t.name).filter(Boolean),
    total: d.total_song_num || songs.length,
    hasMore: !!d.hasmore,
    songs
  };
  if (qqPlCache.size > 80) qqPlCache.clear();
  qqPlCache.set(key, { data, ts: Date.now() });
  return data;
}

/** 抖音搜索结果 → 统一歌曲格式（前端可直接入列播放） */
function dyToSong(n) {
  return {
    id: 'dy' + n.awemeId,
    songId: null,
    awemeId: n.awemeId,
    bvid: null,
    title: n.music || n.title || '抖音原声',
    artist: n.artist || '',
    album: '',
    cover: n.cover || '',
    duration: (n.dur || 0) * 1000,
    source: 'douyin'
  };
}

/** 搜索接口不返回封面，用详情接口批量补齐（一次请求） */
async function fillCovers(songs) {
  if (!songs.length) return songs;
  try {
    const ids = '[' + songs.map((s) => s.songId).join(',') + ']';
    const j = await getJson('https://music.163.com/api/song/detail?ids=' + encodeURIComponent(ids), {
      headers: NE_HEADERS
    });
    const map = {};
    (j.songs || []).forEach((s) => {
      if (s.album && s.album.picUrl) map[s.id] = s.album.picUrl;
    });
    songs.forEach((s) => {
      s.cover = coverOf(map[s.songId] || '');
    });
  } catch (e) {
    /* 封面拿不到不影响播放 */
  }
  return songs;
}

/** 歌曲播放地址（带缓存，25 分钟有效期内不重复请求） */
const urlCache = new Map();

async function songUrl(songId) {
  const hit = urlCache.get(songId);
  if (hit && Date.now() - hit.ts < 25 * 60 * 1000) return hit.data;

  const params = eapiParams('/api/song/enhance/player/url', { ids: '[' + songId + ']', br: 999000 });
  const j = await getJson('https://interface3.music.163.com/eapi/song/enhance/player/url', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'os=pc; appver=8.9.70' }, NE_HEADERS),
    body: 'params=' + params
  });
  const d = (j.data && j.data[0]) || {};
  const data = {
    url: d.url || '',
    bitrate: d.br ? Math.round(d.br / 1000) + 'kbps' : '',
    size: d.size || 0,
    type: d.type || '',
    code: d.code || 0,
    // freeTrialInfo 存在说明给的只是试听片段（30 秒左右）
    trial: !!(d.freeTrialInfo || (d.freeTrialPrivilege && d.freeTrialPrivilege.resConsumable === false)),
    dur: d.time || 0
  };
  if (data.url) urlCache.set(songId, { data, ts: Date.now() });
  return data;
}

/** 歌词（原文 + 翻译） */
async function lyric(songId) {
  const j = await getJson(
    'https://music.163.com/api/song/lyric?id=' + songId + '&lv=1&kv=1&tv=-1',
    { headers: NE_HEADERS }
  );
  return {
    lyric: (j.lrc && j.lrc.lyric) || '',
    translated: (j.tlyric && j.tlyric.lyric) || ''
  };
}

/* ---------------- 歌词（QQ 音乐为主，网易云兜底） ----------------
 * 音轨大多来自 B 站，视频本身没有歌词，所以歌词是「用歌名 + 歌手反查」来的。
 * 反查到的可能是别的版本，时间轴未必对得上 —— 前端会做时长校验和手动校准，
 * 这里只负责尽量挑到同一个版本。
 */
const LYRIC_TTL = 6 * 3600 * 1000;
const lyricCache = new Map();
const LYRIC_DISK = path.join(ROOT, '.listen-data', 'lyrics.json');
let lyricDisk = null;
let lyricDiskTimer = null;

function lyricDiskLoad() {
  if (lyricDisk) return lyricDisk;
  try {
    lyricDisk = JSON.parse(fs.readFileSync(LYRIC_DISK, 'utf8')) || {};
  } catch (e) {
    lyricDisk = {};
  }
  return lyricDisk;
}

function lyricDiskSave() {
  if (lyricDiskTimer) return;
  lyricDiskTimer = setTimeout(() => {
    lyricDiskTimer = null;
    try {
      const all = lyricDiskLoad();
      const keys = Object.keys(all).sort((a, b) => (all[b].ts || 0) - (all[a].ts || 0)).slice(0, 500);
      const out = {};
      keys.forEach((k) => { out[k] = all[k]; });
      fs.mkdirSync(path.dirname(LYRIC_DISK), { recursive: true });
      fs.writeFileSync(LYRIC_DISK, JSON.stringify(out));
    } catch (e) { /* 磁盘写失败不影响播放 */ }
  }, 3000);
  if (lyricDiskTimer.unref) lyricDiskTimer.unref();
}

function lrcHasTime(lrc) {
  return /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(String(lrc || ''));
}

/** QQ 有些曲目会返回「此歌曲为没有填词的纯音乐」这种占位，别当真歌词 */
function lrcUsable(lrc) {
  const s = String(lrc || '');
  if (!lrcHasTime(s)) return false;
  if (/(此歌曲为|没有填词|暂无歌词|歌词不存在|纯音乐[，,]?请)/.test(s)) return false;
  const n = (s.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g) || []).length;
  return n >= 4;
}

/** 歌词末行时间（秒），前端拿它和音轨时长比对来判断版本对不对 */
function lrcLastTime(lrc) {
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let m, last = 0;
  const s = String(lrc || '');
  while ((m = re.exec(s))) {
    const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(('0.' + m[3]).slice(0, 5)) : 0);
    if (t > last) last = t;
  }
  return Math.round(last * 10) / 10;
}

/** QQ 音乐歌词：songmid + Referer，不需要登录 */
async function qqLyric(mid) {
  const url =
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(mid) +
    '&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8' +
    '&notice=0&platform=yqq.json&needNewCode=0&trans=1';
  const j = await getJson(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': QQ_UA } });
  return { lrc: (j && j.lyric) || '', tlrc: (j && j.trans) || '' };
}

/** 「晴天 (Live)」→「晴天」，方便跨平台比对 */
function lyrTitleOf(s) {
  return recKey(
    String(s || '')
      .replace(REC_NOISE, ' ')
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
  );
}

/** B 站标题常见「歌名 - 歌手」「歌名｜歌手」，多准备几种写法取最高分 */
function lyrTitleVariants(title) {
  const raw = String(title || '').replace(REC_NOISE, ' ');
  const out = [];
  const push = (s) => {
    const v = recKey(String(s || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' '));
    if (v && v.length > 1 && out.indexOf(v) < 0) out.push(v);
  };
  push(raw);
  const seg = raw.split(/\s*[-–—|｜]\s*/).filter(Boolean);
  if (seg.length > 1) {
    push(seg[0]);
    push(seg[seg.length - 1]);
  }
  push(raw.split(/\s+/)[0]);
  return out.length ? out : [recKey(raw)];
}

function lyrArtistOf(s) {
  return recKey(String(s || '').split(/[/、,&]|feat\.?|ft\.?/i)[0]);
}

/** 二元组 Dice 相似度，比逐字比对更抗乱序 */
function lyrSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.indexOf(b) >= 0 || b.indexOf(a) >= 0 ? 0.8 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  ga.forEach((n, g) => { if (gb.has(g)) hit += Math.min(n, gb.get(g)); });
  const dice = (2 * hit) / (a.length - 1 + b.length - 1);
  // 「晴天」vs「晴天live」这类包含关系，Dice 会被长尾拉低，单独抬一手：
  // 短名整体出现在长名里，基本可以认定是同一首
  const contained = a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  return contained ? Math.max(0.8, dice) : dice;
}

/** 翻唱 / 伴奏 / DJ 版：不是不能要，但同名的原版优先 */
const LYRIC_COVER = /(翻唱|翻自|cover|伴奏|纯音乐|钢琴版|吉他版|dj|remix|慢速|降调|升调|加速|8bit|片段)/i;

function lyrVersionPenalty(queryTitle, candTitle) {
  let p = 0;
  if (LYRIC_COVER.test(candTitle) && !LYRIC_COVER.test(queryTitle)) p += 26;
  if (/(live|现场|演唱会)/i.test(candTitle) && !/(live|现场|演唱会)/i.test(queryTitle)) p += 8;
  return p;
}

function lyrScore(title, artist, cand, wantDur) {
  const candTitle = lyrTitleOf(cand.title);
  let ts = 0;
  lyrTitleVariants(title).forEach((v) => {
    const s = lyrSim(v, candTitle);
    if (s > ts) ts = s;
  });
  const a1 = lyrArtistOf(artist), a2 = lyrArtistOf(cand.artist);
  let as = 0;
  if (a1 && a2) as = a2.indexOf(a1) >= 0 || a1.indexOf(a2) >= 0 ? 1 : lyrSim(a1, a2);

  let score = ts * 100 + as * 26 - lyrVersionPenalty(String(title || ''), String(cand.title || ''));
  // 歌手完全对不上：多半是翻唱 / 串烧 / 同名 UGC 上传
  if (a1 && a2 && as < 0.35) score -= 12;
  // 时长是最硬的版本指纹：B 站音轨和原曲同版本时基本 1 秒内吻合
  // wantDur 是秒，cand.duration 是毫秒
  if (wantDur && cand.duration) {
    const d = Math.abs(wantDur - cand.duration / 1000);
    if (d <= 2) score += 20;
    else if (d <= 5) score += 13;
    else if (d <= 10) score += 6;
    else if (d <= 20) score += 0;
    else if (d <= 40) score -= 10;
    else score -= 22;
  }
  return { score, ts, as };
}

async function lyricSearch(title, artist, wantDur) {
  const base = cleanSearchTitle(title);
  const aName = String(artist || '').split(/[/、,&]/)[0].trim();
  // B 站音轨的 artist 常是 UP 主名（「适合一个人静静听歌」这种），丢进搜索会把结果带偏
  const artistUsable =
    aName && aName.length <= 12 &&
    !/(适合|歌单|精选|音乐|翻唱|合集|官方|频道|电台|无损|宝藏|\d{3,})/i.test(aName);

  const kws = [];
  if (artistUsable) kws.push((base + ' ' + aName).trim());
  kws.push(base);

  const picked = [];
  const seen = new Set();

  async function collect(kw, src, limit) {
    try {
      const res = src === 'qq' ? await qqSearch(kw, limit) : await searchSongs(kw, 1, limit);
      (res.songs || []).forEach((c) => {
        const idk = c.qqMid || c.songId;
        if (!idk || seen.has(idk)) return;
        seen.add(idk);
        const s = lyrScore(title, artist, c, wantDur);
        picked.push(Object.assign({ cand: c, src: src }, s));
      });
    } catch (e) { /* 这个源/这组关键词不行就跳过 */ }
  }

  // QQ 音乐曲库最全、时间轴也最准，先查
  for (const kw of kws) {
    await collect(kw, 'qq', 8);
    if (picked.some((p) => p.ts >= 0.95 && p.as >= 0.8)) break;
  }
  // QQ 明显没找着才去网易云，省一次请求
  if (!picked.length || Math.max.apply(null, picked.map((x) => x.ts)) < 0.85) {
    await collect(kws[kws.length - 1], 'netease', 3);
  }

  picked.sort((a, b) => b.score - a.score);

  // 候选里挑「歌词末行 ≈ 音轨时长」的那个：比只看歌名靠谱得多
  const tried = [];
  for (const p of picked.slice(0, 4)) {
    if (p.ts < 0.62) continue;
    if (p.ts < 0.8 && p.as < 0.5) continue;
    try {
      let l;
      if (p.src === 'qq') {
        l = await qqLyric(p.cand.qqMid);
      } else {
        const ne = await lyric(p.cand.songId);
        l = { lrc: ne.lyric, tlrc: ne.translated };
      }
      if (!lrcUsable(l.lrc)) continue;
      const lrcDur = lrcLastTime(l.lrc);
      // 歌词结束时间离音轨时长太远 → 基本是另一个版本，宁可没有也别乱配
      // 歌词可能比音轨早收尾（前奏/尾奏），但不能比音轨还长，也不能短太多
      if (wantDur) {
        if (lrcDur > wantDur + 6) continue;
        if (lrcDur < wantDur - 70) continue;
      }
      const fit = wantDur ? Math.min(40, Math.abs(lrcDur - wantDur) / 4) : 0;
      tried.push({
        lrc: l.lrc,
        tlrc: l.tlrc || '',
        source: p.src,
        matched: { title: p.cand.title, artist: p.cand.artist, duration: p.cand.duration || 0 },
        lrcDur,
        score: Math.round(p.score - fit)
      });
    } catch (e) { /* 这首拿不到就试下一首 */ }
  }
  if (!tried.length) return null;
  tried.sort((a, b) => b.score - a.score);
  return tried[0];
}

/** 统一的歌词入口：给了 mid / 网易云 id 就直取，否则按歌名反查 */
async function lyricGet(opt) {
  const key = opt.mid ? 'm:' + opt.mid
    : opt.id ? 'n:' + opt.id
    : 'q:' + lyrTitleOf(opt.title) + '|' + lyrArtistOf(opt.artist) + '|' + (opt.dur || 0);

  const mem = lyricCache.get(key);
  if (mem && Date.now() - mem.ts < LYRIC_TTL) return mem.data;

  const disk = lyricDiskLoad()[key];
  if (disk && Date.now() - (disk.ts || 0) < LYRIC_TTL) {
    lyricCache.set(key, disk);
    return disk.data;
  }

  let data = null;
  if (opt.mid) {
    try {
      const l = await qqLyric(opt.mid);
      if (lrcUsable(l.lrc)) {
        data = {
          lrc: l.lrc, tlrc: l.tlrc || '', source: 'qq',
          matched: { title: opt.title || '', artist: opt.artist || '', duration: opt.dur || 0 },
          lrcDur: lrcLastTime(l.lrc), score: 100
        };
      }
    } catch (e) { /* 直取失败就走反查 */ }
  } else if (opt.id) {
    try {
      const l = await lyric(opt.id);
      if (lrcUsable(l.lyric)) {
        data = {
          lrc: l.lyric, tlrc: l.translated || '', source: 'netease',
          matched: { title: opt.title || '', artist: opt.artist || '', duration: opt.dur || 0 },
          lrcDur: lrcLastTime(l.lyric), score: 100
        };
      }
    } catch (e) { /* 同上 */ }
  }
  if (!data) data = await lyricSearch(opt.title, opt.artist, opt.dur);
  if (!data) data = { lrc: '', tlrc: '', source: '', matched: null, lrcDur: 0, score: 0 };

  const rec = { data, ts: Date.now() };
  if (lyricCache.size > 240) lyricCache.clear();
  lyricCache.set(key, rec);
  if (data.lrc) {
    lyricDiskLoad()[key] = rec;
    lyricDiskSave();
  }
  return data;
}

/* ---------------- B 站音源 ---------------- */
const BILI_HEADERS = { Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };
let biliCookie = { val: '', ts: 0 };

async function biliCookieGet() {
  if (biliCookie.val && Date.now() - biliCookie.ts < 3600 * 1000) return biliCookie.val;
  const j = await getJson('https://api.bilibili.com/x/frontend/finger/spi', { headers: BILI_HEADERS });
  if (!j || !j.data) throw new Error('B 站风控：取不到 buvid');
  biliCookie.val = 'buvid3=' + j.data.b_3 + '; buvid4=' + j.data.b_4;
  biliCookie.ts = Date.now();
  return biliCookie.val;
}

function durToSec(s) {
  if (!s) return 0;
  return String(s)
    .split(':')
    .map(Number)
    .reduce((a, b) => a * 60 + b, 0);
}

/** 搜索视频（带 5 分钟缓存，重复解析同一首歌不再打搜索接口） */
const biliSearchCache = new Map();

async function biliSearch(kw, limit) {
  const ck = (limit || 20) + '|' + kw;
  const hit = biliSearchCache.get(ck);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;

  const cookie = await biliCookieGet();
  const parse = (j) => {
    const clean = (t) => String(t || '').replace(/<[^>]+>/g, '');
    const list = (j.data && j.data.result) || [];
    return list
      .filter((v) => v.bvid)
      .slice(0, limit || 20)
      .map((v) => ({
        bvid: v.bvid,
        title: clean(v.title),
        author: v.author,
        sec: durToSec(v.duration),
        play: v.play || 0,
        cover: v.pic ? (v.pic.startsWith('//') ? 'https:' + v.pic : v.pic) : '',
        pubdate: v.pubdate || 0
      }));
  };

  // 限定「音乐综合」分区（tids=130）：搜出来的是歌而不是影视剪辑/剧情号
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&tids=130&keyword=' +
    encodeURIComponent(kw);
  const j = await getJson(url, { headers: Object.assign({ Cookie: cookie }, BILI_HEADERS) });
  if (!j || j.code !== 0) throw new Error('B 站搜索失败：' + ((j && j.message) || '未知'));
  let out = parse(j);

  // 冷门词音乐分区可能没结果，回退全站再搜一次
  if (!out.length) {
    const url2 =
      'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' +
      encodeURIComponent(kw);
    const j2 = await getJson(url2, { headers: Object.assign({ Cookie: cookie }, BILI_HEADERS) });
    if (j2 && j2.code === 0) out = parse(j2);
  }

  if (biliSearchCache.size > 300) biliSearchCache.clear();
  biliSearchCache.set(ck, { data: out, ts: Date.now() });
  return out;
}

async function biliCid(bvid) {
  const cookie = await biliCookieGet();
  const j = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    headers: Object.assign({ Cookie: cookie }, BILI_HEADERS)
  });
  if (!j || j.code !== 0) throw new Error('取视频信息失败：' + ((j && j.message) || ''));
  return {
    cid: j.data.cid,
    title: j.data.title,
    pic: j.data.pic,
    dur: j.data.duration || 0,
    owner: j.data.owner && j.data.owner.name,
    // 分P 列表：合集/多P 视频每个分P都是一首「歌」
    pages: (j.data.pages || []).map((pg) => ({ cid: pg.cid, part: pg.part || '', dur: pg.duration || 0 }))
  };
}

async function biliAudioUrl(bvid, cid) {
  const cookie = await biliCookieGet();
  const u =
    'https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + cid + '&fnval=16&fourk=1';
  const j = await getJson(u, { headers: Object.assign({ Cookie: cookie }, BILI_HEADERS) });
  const dash = j && j.data && j.data.dash;
  if (!dash || !dash.audio || !dash.audio.length) throw new Error('该视频没有可用音轨');
  const best = dash.audio.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return {
    url: best.baseUrl,
    backup: best.backupUrl || [],
    bitrate: Math.round(best.bandwidth / 1000) + 'kbps',
    mime: best.mimeType || 'audio/mp4'
  };
}

/* --- 两级缓存：cid 6 小时有效（基本不变），音轨地址 15 分钟（B 站链接会过期） --- */
const biliInfoCache = new Map();
const BILI_INFO_TTL = 6 * 3600 * 1000;

async function biliInfo(bvid) {
  const hit = biliInfoCache.get(bvid);
  if (hit && Date.now() - hit.ts < BILI_INFO_TTL) return hit.data;
  const info = await biliCid(bvid);
  if (biliInfoCache.size > 400) biliInfoCache.clear();
  biliInfoCache.set(bvid, { data: info, ts: Date.now() });
  return info;
}

const biliAudioCache = new Map();
const BILI_AUDIO_TTL = 15 * 60 * 1000;

async function biliAudio(bvid, cid) {
  const ck = bvid + '|' + (cid || '');
  const hit = biliAudioCache.get(ck);
  if (hit && Date.now() - hit.ts < BILI_AUDIO_TTL) {
    tagAudio(hit.data.url, 'b:' + ck);
    return hit.data;
  }
  const a = await biliAudioUrl(bvid, cid);
  tagAudio(a.url, 'b:' + ck);
  (a.backup || []).forEach((u) => tagAudio(u, 'b:' + ck));
  if (biliAudioCache.size > 300) biliAudioCache.clear();
  biliAudioCache.set(ck, { data: a, ts: Date.now() });
  return a;
}

/** 版本信号词库：识别「原版 / 高音质 / 翻唱 / 教程」等版本特征 */
const GOOD_VER = /无损|hi-?res|flac|320k|母带|高音质|超清音质|官方|原版|正版|official|完整版|完整填词|现场版音源/i;
const BAD_VER = /翻唱|cover|remix|伴奏|instrumental|karaoke|ktv|纯音乐|8d|慢速|加速|降调|升调|变调|铃声|剪辑|卡点|教学|教程|钢琴版|吉他版|尤克里里|鼓谱|乐谱|扒谱|reaction|解析|盘点|搬运|喊麦|白噪音|助眠|催眠|弹幕|半音阶/i;
const LIVE_VER = /演唱会|live|巡回|音乐节|现场版|生日会/i;

function countRe(re, s) {
  let n = 0;
  const r = new RegExp(re.source, 'gi');
  while (r.exec(s)) n++;
  return n;
}

/**
 * 候选打分（多特征线性加权）：挑最像「正版原曲 · 高音质」的那条
 * 特征：标题命中 > 歌手匹配（UP主=歌手最加分）> 版本信号 > 时长匹配 > 热度 > 标题干净度
 */
function scoreBili(v, title, artist, wantDur) {
  const t = String(v.title || '').toLowerCase();
  const tl = String(title || '').toLowerCase().replace(/\s/g, '');
  let score = 0;

  // 1) 标题命中歌名
  if (tl && t.indexOf(tl) >= 0) score += 45;

  // 2) 歌手匹配：UP 主名就是歌手名 > 标题含歌手名
  const al = String(artist || '').toLowerCase().trim();
  if (al) {
    if (v.author && String(v.author).toLowerCase().indexOf(al) >= 0) score += 30;
    if (t.indexOf(al) >= 0) score += 18;
  }

  // 3) 版本信号：好词加分（封顶），坏词狠扣；搜索目标本身要 live 时反向加分
  const good = countRe(GOOD_VER, t);
  const bad = countRe(BAD_VER, t);
  score += Math.min(40, good * 22);
  score -= Math.min(60, bad * 30);
  const wantLive = /live|现场|演唱会/i.test(tl);
  if (!wantLive && LIVE_VER.test(t)) score -= 12;
  if (wantLive && LIVE_VER.test(t)) score += 15;

  // 4) 时长匹配（有参考时长时）
  if (wantDur && v.sec > 0) {
    const d = Math.abs(v.sec - wantDur);
    if (d < 8) score += 35;
    else if (d < 20) score += 22;
    else if (d < 45) score += 10;
    else if (d > 90) score -= 25;
  }
  if (v.sec >= 120 && v.sec <= 420) score += 6;   // 单曲常见长度

  // 5) 热度（log 缩放，百万播放≈+25）
  score += Math.min(25, Math.log10(Math.max(1, v.play)) * 6);

  // 6) 标题干净度：带《》书名号的投稿更「正经」
  if (/《/.test(v.title)) score += 10;

  return score;
}

/** 音频代理地址（浏览器不能直连 CDN，必须带 Referer） */
function biliProxyUrl(raw) {
  return '/api/bili/stream?u=' + encodeURIComponent(raw);
}

/** 通用媒体代理（B 站 / 抖音共用一套透传逻辑） */
function mediaProxyUrl(raw) {
  return '/api/media?u=' + encodeURIComponent(raw);
}

/* ---------------- 首段预缓冲 ----------------
 * 解析出音轨地址后，先在服务端把开头一段（约 10 秒音频）抓到内存。
 * 播放请求到达时直接用内存吐字节，跳过 CDN 握手 + 首包等待。
 * 只存开头一段，10 分钟回收，最多 50 条（约 16MB）。
 */
const WARM_BYTES = 320 * 1024;
const WARM_TTL = 10 * 60 * 1000;
const warmCache = new Map();

function warmTrim() {
  const now = Date.now();
  warmCache.forEach((v, k) => {
    if (now - v.ts > WARM_TTL) warmCache.delete(k);
  });
  while (warmCache.size > 50) warmCache.delete(warmCache.keys().next().value);
}

function cdnHeaders(extra) {
  return Object.assign(
    {
      // B 站 CDN 校验 UA，不带直接 403
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: '*/*',
      'Accept-Encoding': 'identity'
    },
    extra || {}
  );
}

function cdnGet(raw, headers, onRes) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  const req = https.request(
    {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: cdnHeaders(headers),
      agent: httpsAgent
    },
    onRes
  );
  req.on('error', () => {});
  req.setTimeout(15000, () => req.destroy());
  req.end();
  return req;
}

/** 只建连不发数据：把 TLS 连接提前放进连接池，播放请求到达时直接复用 */
function touchCdn(raw) {
  if (!raw) return;
  cdnGet(raw, { Range: 'bytes=0-1' }, (res) => res.resume());
}

/* ---------------- 音频磁盘缓存 ----------------
 * 完整下载过的音轨在本地落一份，之后同一首歌直接从文件读：
 *   1) 秒开，不必再等 CDN 握手 + 首包
 *   2) 拖动进度条不必重新向 CDN 要数据
 *   3) 离线版断网也能播放已经缓存过的歌
 * 索引主键用「稳定歌曲键」，不能用 CDN 直链——B 站直链带签名，几十分钟就过期。
 * 进程内维护「直链 → 歌曲键」，重启后重新解析音源时会自动重建。
 * 上限 400MB，按最近使用时间 LRU 淘汰。
 */
const AUDIO_DIR = path.join(ROOT, '.listen-data', 'audio');
const AUDIO_INDEX_FILE = path.join(AUDIO_DIR, 'index.json');
const AUDIO_MAX_BYTES = 400 * 1024 * 1024;
const AUDIO_MAX_AGE = 60 * 24 * 3600 * 1000;   // 两个月没用过就清掉
const AUDIO_MAX_CONC = 2;                       // 同时最多 2 个后台下载

const urlKeyMap = new Map();     // CDN 直链 → 稳定歌曲键
let audioIdx = null;             // Map<key, {f,size,ts,ct}>
let audioIdxDirty = false;
let audioIdxTimer = null;
const audioPending = new Set();  // 正在后台下载的 key
let audioCaching = true;         // 用户是否允许缓存（默认开，关掉会留个标记文件）

/** 登记「直链 → 歌曲键」，代理时用它反查磁盘缓存 */
function tagAudio(raw, key) {
  if (!raw || !key) return;
  if (urlKeyMap.size > 5000) urlKeyMap.clear();
  urlKeyMap.set(raw, key);
}

function audioFileOf(key) {
  return path.join(AUDIO_DIR, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.bin');
}

function audioIdxLoad() {
  if (audioIdx) return audioIdx;
  audioIdx = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(AUDIO_INDEX_FILE, 'utf8'));
    Object.keys(j || {}).forEach((k) => {
      const e = j[k];
      if (e && e.f && fs.existsSync(path.join(AUDIO_DIR, e.f))) audioIdx.set(k, e);
    });
  } catch (e) { /* 首次运行还没有索引 */ }
  return audioIdx;
}

function audioIdxFlush() {
  if (!audioIdxDirty || audioIdxTimer) return;
  audioIdxTimer = setTimeout(() => {
    audioIdxTimer = null;
    audioIdxDirty = false;
    const out = {};
    audioIdx.forEach((v, k) => { out[k] = v; });
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      fs.writeFileSync(AUDIO_INDEX_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(AUDIO_INDEX_FILE + '.tmp', AUDIO_INDEX_FILE);
    } catch (e) { /* 写不进去就当没有缓存，不影响播放 */ }
  }, 1500);
  if (audioIdxTimer.unref) audioIdxTimer.unref();
}

function audioTotal() {
  let n = 0;
  audioIdxLoad().forEach((v) => { n += v.size || 0; });
  return n;
}

/** 超上限就按「最久没用」删到 85% 以下 */
function audioPrune(keep) {
  const idx = audioIdxLoad();
  let total = audioTotal();
  if (total <= AUDIO_MAX_BYTES) return;
  const list = [];
  idx.forEach((v, k) => list.push([k, v]));
  list.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  for (let i = 0; i < list.length && total > AUDIO_MAX_BYTES * 0.85; i++) {
    const k = list[i][0];
    if (k === keep) continue;
    try { fs.unlinkSync(path.join(AUDIO_DIR, list[i][1].f)); } catch (e) {}
    idx.delete(k);
    total -= list[i][1].size || 0;
    audioIdxDirty = true;
  }
  audioIdxFlush();
}

/** 启动时清过期条目 + 孤儿文件 */
function audioBootSync() {
  try { audioCaching = !fs.existsSync(path.join(AUDIO_DIR, 'off')); } catch (e) {}
  const idx = audioIdxLoad();
  const now = Date.now();
  idx.forEach((v, k) => {
    if (now - (v.ts || 0) > AUDIO_MAX_AGE) {
      try { fs.unlinkSync(path.join(AUDIO_DIR, v.f)); } catch (e) {}
      idx.delete(k);
      audioIdxDirty = true;
    }
  });
  const used = new Set();
  idx.forEach((v) => used.add(v.f));
  try {
    fs.readdirSync(AUDIO_DIR).forEach((n) => {
      if (n === 'index.json' || n === 'index.json.tmp' || n === 'off') return;
      if (used.has(n) || /\.part$/.test(n)) {
        if (/\.part$/.test(n)) { try { fs.unlinkSync(path.join(AUDIO_DIR, n)); } catch (e) {} }
        return;
      }
      try { fs.unlinkSync(path.join(AUDIO_DIR, n)); } catch (e) {}   // 索引里没有的就是垃圾
    });
  } catch (e) {}
  audioIdxFlush();
  audioPrune('');
}

/** 从磁盘吐音频，支持 Range；没命中返回 false 交给后面走网络 */
function audioServe(key, req, res) {
  const idx = audioIdxLoad();
  const e = idx.get(key);
  if (!e) return false;
  const fp = path.join(AUDIO_DIR, e.f);
  let st;
  try { st = fs.statSync(fp); } catch (err) {
    idx.delete(key);
    audioIdxDirty = true;
    return false;
  }

  const total = st.size;
  const head = {
    'Accept-Ranges': 'bytes',
    'Content-Type': e.ct || 'audio/mp4',
    'Cache-Control': 'private, max-age=86400',
    'Access-Control-Allow-Origin': '*'
  };

  let start = 0;
  let end = total - 1;
  let code = 200;
  const range = String(req.headers.range || '').trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    if (m[1] === '') {
      const n = Number(m[2]) || 0;
      start = Math.max(0, total - n);
    } else {
      start = Number(m[1]) || 0;
      if (m[2]) end = Math.min(total - 1, Number(m[2]));
    }
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return true;
    }
    code = 206;
    head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
  }
  head['Content-Length'] = end - start + 1;

  // 命中即刷新使用时间（LRU 依据）
  e.ts = Date.now();
  audioIdxDirty = true;
  audioIdxFlush();

  res.writeHead(code, head);
  if (req.method === 'HEAD') { res.end(); return true; }
  const rs = fs.createReadStream(fp, { start, end });
  rs.on('error', () => { try { res.end(); } catch (e2) {} });
  req.on('close', () => rs.destroy());
  rs.pipe(res);
  return true;
}

/** 后台把整条音轨存一份；与本次播放完全解耦，不增加等待 */
function audioCacheFetch(target, key, ct) {
  if (!key || audioCaching === false) return;
  if (audioPending.has(key) || audioPending.size >= AUDIO_MAX_CONC) return;
  if (audioIdxLoad().has(key)) return;

  audioPending.add(key);
  const fp = audioFileOf(key);
  const tmp = fp + '.part';
  let got = 0;
  let fin = false;

  const done = (ok) => {
    if (fin) return;
    fin = true;
    audioPending.delete(key);
    if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} return; }
    try { fs.renameSync(tmp, fp); } catch (e) { return; }
    audioIdxLoad().set(key, { f: path.basename(fp), size: got, ts: Date.now(), ct: ct || 'audio/mp4' });
    audioIdxDirty = true;
    audioIdxFlush();
    audioPrune(key);
  };

  const up = cdnGet(target, {}, (res) => {
    if (res.statusCode !== 200) { res.resume(); return done(false); }
    const total = Number(res.headers['content-length'] || 0);
    let ctype = res.headers['content-type'] || '';
    if (!ctype || /octet-stream/i.test(ctype)) ctype = 'audio/mp4';
    try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch (e) {}
    const ws = fs.createWriteStream(tmp);
    let wsErr = false;
    res.on('data', (c) => { got += c.length; });
    res.on('error', () => { wsErr = true; try { ws.destroy(); } catch (e) {} done(false); });
    ws.on('error', () => { wsErr = true; done(false); });
    ws.on('finish', () => { if (!wsErr) done(!total || got >= total); });
    res.pipe(ws);
  });

  if (!up) return done(false);
  // 后台任务不能被一个卡住的连接拖死
  setTimeout(() => { if (!fin) { try { up.destroy(); } catch (e) {} done(false); } }, 120000);
}

/** 预热开头一段音频到内存 */
function warmAudio(raw) {
  if (!raw || warmCache.has(raw)) return;
  cdnGet(raw, { Range: 'bytes=0-' + (WARM_BYTES - 1) }, (res) => {
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      return;
    }
    let ct = res.headers['content-type'] || '';
    if (!ct || /octet-stream/i.test(ct)) ct = 'audio/mp4';
    let total = Number(res.headers['content-length'] || 0);
    const m = String(res.headers['content-range'] || '').match(/\/(\d+)\s*$/);
    if (m) total = Number(m[1]);

    const chunks = [];
    let got = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!got) return;
      const buf = Buffer.concat(chunks);
      warmCache.set(raw, { buf, total: total > buf.length ? total : buf.length, ct, ts: Date.now() });
      warmTrim();
    };
    res.on('data', (c) => {
      if (done) return;
      chunks.push(c);
      got += c.length;
      if (got >= WARM_BYTES) {
        finish();
        res.destroy();
        if (res.socket) res.socket.destroy();
      }
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', finish);
  });
}

/** 预热一段音频：解析出地址后马上调用，播放时省掉首包等待 */
function warmMaybe(raw, on) {
  if (!raw) return;
  if (on) warmAudio(raw);
  else touchCdn(raw);
}

/** 流式转发音频（保留 Range，支持拖动进度条） */
function proxyBiliStream(target, req, res, warmHit) {
  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return res.writeHead(400).end('bad url');
  }
  const okHost = /(^|\.)(bilivideo\.[a-z]{2,4}|hdslb\.com|bilibili\.com|szbdyd\.com|akamaized\.net|bstar\.net)$/i.test(u.hostname) ||
    /(^|\.)(douyinpic\.com|douyinvod\.com|douyinstatic\.com|douyincdn\.com|douyin\.com|iesdouyin\.com|byteicdn\.com|byteimg\.com|ibytedtos\.com|pstatp\.com|zjcdn\.com|volccdn\.com|snssdk\.com)$/i.test(u.hostname);
  if (!okHost) return res.writeHead(403).end('host not allowed');

  // 命中磁盘缓存：直接从本地文件吐，零网络等待
  const diskKey = urlKeyMap.get(target);
  if (diskKey && audioServe(diskKey, req, res)) return;
  // 没命中就顺手在后台存一份（不阻塞本次播放）
  if (diskKey) audioCacheFetch(target, diskKey, '');

  const baseHead = {
    'Accept-Ranges': 'bytes',
    // 允许浏览器缓存已下载的字节段（拖动进度条回来不用重下）
    'Cache-Control': 'private, max-age=600',
    'Access-Control-Allow-Origin': '*'
  };

  /* 命中首段缓冲：开头直接从内存吐，剩余部分续传 CDN */
  const range = String(req.headers.range || '').trim();
  const fromZero = !range || /^bytes=0-$/i.test(range);
  const w = warmHit || warmCache.get(target);

  if (w && fromZero && w.buf && w.buf.length) {
    const total = w.total || w.buf.length;
    const head = Object.assign({}, baseHead, {
      'Content-Type': w.ct || 'audio/mp4',
      'Content-Range': 'bytes 0-' + (total - 1) + '/' + total,
      'Content-Length': total
    });
    res.writeHead(206, head);
    res.write(w.buf);
    if (w.buf.length >= total) {
      return res.end();
    }
    const up = cdnGet(target, { Range: 'bytes=' + w.buf.length + '-' }, (upRes) => {
      if (upRes.statusCode >= 400) {
        try { res.end(); } catch (e) {}
        return;
      }
      upRes.pipe(res);
      upRes.on('error', () => { try { res.end(); } catch (e) {} });
    });
    if (up) {
      req.on('close', () => up.destroy());
    } else {
      try { res.end(); } catch (e) {}
    }
    return;
  }

  /* 普通透传（拖动进度条 / 未预热） */
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const up = cdnGet(target, headers, (upRes) => {
    let ct = upRes.headers['content-type'] || '';
    if (!ct || /octet-stream/i.test(ct)) ct = 'audio/mp4'; // B 站 dash 音轨是 mp4 容器
    const out = Object.assign({}, baseHead, { 'Content-Type': ct });
    if (upRes.headers['content-length']) out['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) out['Content-Range'] = upRes.headers['content-range'];
    if (upRes.headers['etag']) out['ETag'] = upRes.headers['etag'];
    res.writeHead(upRes.statusCode || 200, out);
    upRes.pipe(res);
    upRes.on('error', () => res.end());
  });
  if (!up) {
    try { res.writeHead(502).end('upstream error'); } catch (e) {}
    return;
  }
  req.on('close', () => up.destroy());
}

/** 综合解析：按偏好顺序尝试 网易云 / B 站 */
const fallbackCache = new Map();

async function resolveFallback(title, artist, dur, preferBili, warm) {
  // 前端传的时长可能是毫秒，统一成秒（B 站接口用的是秒）
  dur = Number(dur) || 0;
  if (dur > 2000) dur = Math.round(dur / 1000);

  const key = [title, artist, Math.round(dur || 0), preferBili ? 'b' : 'n'].join('|');
  const hit = fallbackCache.get(key);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) {
    warmMaybe(hit.raw, warm);
    return hit.data;
  }

  const primaryArtist = String(artist || '').split(/\s*[\/、,&]\s*/)[0].trim();
  const kw = (title + ' ' + primaryArtist).trim();

  const viaNetease = async () => {
    const r = await searchSongs(kw, 1, 8);
    const flat = String(title).replace(/\s/g, '');
    const cand =
      r.songs.find((s) => String(s.title).replace(/\s/g, '') === flat) ||
      r.songs.find((s) => String(s.title).replace(/\s/g, '').indexOf(flat) >= 0);
    if (!cand) return null;
    const u = await songUrl(cand.songId);
    if (!u.url) return null;
    // 试听片段直接否掉，宁可没音源也不要播半首
    if (u.trial) return null;
    const realDur = u.dur ? u.dur / 1000 : 0;
    if (dur && realDur && Math.abs(realDur - dur) > 8) return null;
    return {
      url: u.url,
      source: 'netease',
      title: cand.title,
      author: cand.artist,
      quality: u.bitrate,
      cover: cand.cover
    };
  };

  const viaBili = async () => {
    // 多路查询合并候选：原词 + 高音质定向词，让「原版/无损」版本有更多机会参与竞争
    const lists = await Promise.all([
      biliSearch(kw, 20).catch(() => []),
      biliSearch(kw + ' 无损 高音质', 10).catch(() => [])
    ]);
    const seenV = new Set();
    const list = [];
    lists.flat().forEach((v) => {
      if (v && v.bvid && !seenV.has(v.bvid)) {
        seenV.add(v.bvid);
        list.push(v);
      }
    });
    if (!list.length) return null;
    const ranked = list
      .map((v) => ({ v, s: scoreBili(v, title, primaryArtist, dur) }))
      .sort((a, b) => b.s - a.s);
    const pick = ranked[0];
    if (!pick || pick.s < 0) return null;
    const info = await biliInfo(pick.v.bvid);
    const audio = await biliAudio(pick.v.bvid, info.cid);
    const pic = info.pic || pick.v.cover;
    return {
      url: biliProxyUrl(audio.url),
      raw: audio.url,
      source: 'bilibili',
      title: pick.v.title,
      author: pick.v.author,
      quality: audio.bitrate,
      cover: pic && pic.indexOf('//') === 0 ? 'https:' + pic : pic,
      bvid: pick.v.bvid
    };
  };

  const viaDouyin = async () => {
    if (!dyLogged()) return null;
    const list = await dySearch(kw, 12);
    if (!list.length) return null;
    const pick = dyPick(list, title, primaryArtist, dur);
    if (!pick) return null;
    const a = await dyAudioCached(pick.awemeId);
    return {
      url: a.url,
      raw: a.raw,
      source: 'douyin',
      title: a.music || a.title || pick.title,
      author: a.artist || pick.artist,
      quality: a.kind === 'music' ? '抖音原声' : '抖音视频音轨',
      cover: a.cover || pick.cover,
      awemeId: pick.awemeId
    };
  };

  const order = preferBili
    ? [viaBili, viaDouyin, viaNetease]
    : [viaNetease, viaBili, viaDouyin];
  for (let i = 0; i < order.length; i++) {
    try {
      const r = await order[i]();
      if (r) {
        // 解析出来就顺手把开头一段抓到内存，前端一请求就能出声
        if (r.raw) warmMaybe(r.raw, warm);
        fallbackCache.set(key, { data: r, raw: r.raw || '', ts: Date.now() });
        return r;
      }
    } catch (e) {
      /* 换下一个源 */
    }
  }

  return {
    url: '',
    source: '',
    title: '',
    author: '',
    quality: '',
    cover: '',
    bvid: '',
    reason: '两个平台都没找到可用音源'
  };
}

/* ---------------- 抖音（登录态 + 音源） ----------------
 * 抖音的 web 接口一律要求登录态，且带签名校验；所以这里做的是：
 *   1) 让用户在自己的浏览器里扫码登录抖音，程序只读取该浏览器的 douyin.com Cookie
 *   2) 用这份 Cookie 去调抖音公开接口（搜索 / 视频详情 → 音轨）
 * 拿不到就返回明确原因，前端自动回退 B 站，不影响播放。
 */
const DY_DIR = path.join(ROOT, '.dydata');
const DY_SESSION_FILE = path.join(DY_DIR, 'session.json');   // 旧版：全局一份，仅用于迁移
const DY_DEBUG_PORT = 9301;
let dyChromeProc = null;
let dyLastErr = '';
const dyRawCache = new Map();   // key|awemeId → { raw, kind, title... }（搜索时顺手存）
const dySessions = new Map();   // 会话内存缓存：key → session

/* 抖音登录态「按人隔离」
 * key 规则：已登录耳边账号 → u<账号>；未登录 → d<本机设备号>；都没有 → anon
 * 这样别人打开同一个网站，读不到、也用不了你的抖音登录态。 */
const dyCtx = new AsyncLocalStorage();

/** 当前请求的身份：优先登录账号，其次本机设备号 */
function dyIdentityOf(q) {
  let key = 'anon';
  let dev = '';
  try {
    const me = accountOfToken(q.get('token'));
    if (me && me.account) key = 'u' + me.account;
  } catch (e) { /* 账号查询失败就当未登录 */ }
  const d = String((q && q.get('dev')) || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (d) dev = 'd' + d;
  if (key === 'anon' && dev) key = dev;
  return { key, dev };
}
const curDyKey = () => (dyCtx.getStore() || {}).key || 'anon';
const curDyDev = () => (dyCtx.getStore() || {}).dev || '';

function dyFileOf(key) {
  if (key === 'anon') return path.join(DY_DIR, 'session.anon.json');
  return path.join(DY_DIR, 'dy-' + key + '.json');
}

const DY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DY_HEADERS = {
  Referer: 'https://www.douyin.com/',
  Origin: 'https://www.douyin.com',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

/* a_bogus 签名器（abogus 包；缺失时退化为无签名调用） */
let DY_SIGNER = null;
try { DY_SIGNER = require('abogus'); } catch (e) {}

function dyCookieVal(name) {
  const s = dyLoad();
  const cookie = (s && s.cookie) || '';
  const mm = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return mm ? decodeURIComponent(mm[1]) : '';
}

function dyLoad() {
  const key = curDyKey();
  if (dySessions.has(key)) return dySessions.get(key);
  let s = null;
  try { s = JSON.parse(fs.readFileSync(dyFileOf(key), 'utf8')); } catch (e) { s = null; }
  if (!s || !s.cookie) s = dyAdoptLegacy(key);
  if (!s || !s.cookie) s = dyAdoptDev(key);
  if (!s || !s.cookie) s = null;
  dySessions.set(key, s);
  return s;
}

/** 未登录时先绑在本机设备上，之后登录同一个浏览器就把这份会话抬到账号名下 */
function dyAdoptDev(key) {
  if (!/^u\d+$/.test(key)) return null;
  const dev = curDyDev();
  if (!dev || dev === key) return null;
  let s = null;
  try { s = JSON.parse(fs.readFileSync(dyFileOf(dev), 'utf8')); } catch (e) { return null; }
  if (!s || !s.cookie) return null;
  try {
    fs.writeFileSync(dyFileOf(key), JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(dyFileOf(dev), dyFileOf(dev) + '.migrated-' + Date.now());
  } catch (e) {
    return null;
  }
  return s;
}

/**
 * 旧版只有一份全局 session.json —— 所有访问者共用，这正是问题所在。
 * 迁移规则：只交给「站点里唯一的那个账号」，交接后旧文件立刻改名作废，
 * 同一份登录态绝不会再被第二个 key 读到。
 */
function dyLegacyExists() {
  try { return fs.existsSync(DY_SESSION_FILE); } catch (e) { return false; }
}

function dyAdoptLegacy(key, force) {
  if (!/^u\d+$/.test(key)) return null;
  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(DY_SESSION_FILE, 'utf8')); } catch (e) { return null; }
  if (!legacy || !legacy.cookie) return null;
  if (!force) {
    try {
      const db = loadUsers();
      if (Object.keys(db.users || {}).length !== 1) return null;   // 账号不唯一就不敢乱给
      if (!db.users[key.slice(1)]) return null;
    } catch (e) { return null; }
  }
  try {
    fs.mkdirSync(DY_DIR, { recursive: true });
    fs.writeFileSync(dyFileOf(key), JSON.stringify(legacy), { mode: 0o600 });
    fs.renameSync(DY_SESSION_FILE, DY_SESSION_FILE + '.migrated-' + Date.now());
  } catch (e) {
    return null;
  }
  console.log('[抖音] 已把旧版本机登录态绑定给账号 ' + key.slice(1) + '（旧文件已作废，不再共享）');
  return legacy;
}

function dySave(cookie, extra) {
  const key = curDyKey();
  fs.mkdirSync(DY_DIR, { recursive: true });
  const s = Object.assign({}, dySessions.get(key) || {}, { cookie: cookie, ts: Date.now() }, extra || {});
  fs.writeFileSync(dyFileOf(key), JSON.stringify(s), { mode: 0o600 });
  dySessions.set(key, s);
  return s;
}

function dyClear() {
  const key = curDyKey();
  try { fs.unlinkSync(dyFileOf(key)); } catch (e) {}
  dySessions.set(key, null);
}

const dyLogged = () => {
  const s = dyLoad();
  return !!(s && s.cookie);
};

/** 当前请求身份的抖音会话（没有就返回空对象，方便取字段） */
const DY_STATE = () => dyLoad() || {};

/**
 * 构造带完整设备指纹参数的请求并生成 a_bogus 签名。
 * 实测：参数不全（缺 screen_width / cpu_core_num / enter_from / list_type 等）
 * 时抖音不报错，而是返回 status_code=0 且 data 为空的 verify_check 假成功。
 */
function dySign(extra) {
  const msToken =
    dyCookieVal('msToken') ||
    (DY_SIGNER && DY_SIGNER.getMsToken && DY_SIGNER.getMsToken()) ||
    '';
  const base = Object.assign(
    {
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      star_channel: 'no_need', client_client_type: '1',
      version_code: '170400', version_name: '17.4.0',
      cookie_enabled: 'true',
      screen_width: '1280', screen_height: '800',
      browser_language: 'zh-CN', browser_platform: 'Win32',
      browser_name: 'Chrome', browser_version: '131.0.0.0',
      browser_online: 'true', engine_name: 'Blink', engine_version: '131.0.0.0',
      os_name: 'Windows', os_version: '10', cpu_core_num: '8',
      device_memory: '8', platform: 'PC',
      downlink: '10', effective_type: '4g', round_trip_time: '50',
      webid: dyCookieVal('webid') || '7300000000000000000',
      msToken: msToken
    },
    extra || {}
  );
  let qs = '';
  Object.keys(base).forEach((k, i) => { qs += (i ? '&' : '') + k + '=' + encodeURIComponent(base[k]); });
  if (DY_SIGNER && DY_SIGNER.signParams) {
    try {
      const signed = DY_SIGNER.signParams(base, {
        url: 'https://www.douyin.com/aweme/v1/web/',
        userAgent: DY_UA
      });
      qs = new URLSearchParams(signed.params).toString();
    } catch (e) { /* 签名失败就用未签名参数试一把 */ }
  }
  return { qs: qs, msToken: msToken };
}

async function dyApi(pathName, extra) {
  const { qs, msToken } = dySign(extra);
  const url =
    'https://www.douyin.com/aweme/v1/web/' + pathName +
    (pathName.indexOf('?') >= 0 ? '&' : '?') + qs;
  const cookie =
    (((dyLoad() || {}).cookie) || '') + '; msToken=' + encodeURIComponent(msToken);
  const j = await getJson(url, {
    headers: Object.assign({}, DY_HEADERS, { 'User-Agent': DY_UA, Cookie: cookie }),
    timeout: 15000
  });
  return j || {};
}

/** 抖音的错误码翻译成人话 */
function dyWhy(j) {
  const code = j && j.status_code;
  if (code === 0) return '';
  if (code === 2483) return 'NEED_LOGIN';
  const msg = (j && (j.status_msg || j.message)) || '';
  if (/login|登录/i.test(msg)) return 'NEED_LOGIN';
  return 'STATUS_' + (code == null ? 'NO_RESPONSE' : code) + (msg ? ':' + msg : '');
}

function dyCover(v) {
  const pick = (o) => (o && o.url_list && o.url_list.filter(Boolean)[0]) || '';
  return pick(v && v.cover) || pick(v && v.origin_cover) || pick(v && v.dynamic_cover) || '';
}

function dyPlayUrlOf(o) {
  if (!o) return '';
  const lst = Array.isArray(o.url_list) ? o.url_list.filter(Boolean) : [];
  return lst[0] || (typeof o.url === 'string' ? o.url : '') || '';
}

function dyNorm(a) {
  const m = a.music || {};
  const v = a.video || {};
  let dur = Number(a.duration || m.duration || 0);
  if (dur > 2000) dur = Math.round(dur / 1000);
  const rawUrl = dyPlayUrlOf(m.play_url) || dyPlayUrlOf(v.play_addr);
  return {
    awemeId: String(a.aweme_id || ''),
    title: String(a.desc || m.title || '').replace(/\s+/g, ' ').trim(),
    music: m.title || '',
    artist: m.author || (a.author && a.author.nickname) || '',
    dur,
    cover: dyCover(v),
    rawUrl
  };
}

/** 搜索结果 → 歌曲列表；顺手把每条的音轨地址存起来（省一次详情请求） */
function dyParseSearch(j) {
  const out = [];
  (j.data || []).forEach((it) => {
    let a = it.aweme_info;
    if (!a && it.aweme_mix_info && it.aweme_mix_info.mix_items) {
      a = (it.aweme_mix_info.mix_items[0] || {}).aweme_info;
    }
    if (a && a.aweme_id) {
      const n = dyNorm(a);
      if (n.rawUrl) {
        dyRawCache.set(curDyKey() + '|' + n.awemeId, {
          raw: n.rawUrl,
          kind: dyPlayUrlOf((a.music || {}).play_url) ? 'music' : 'video',
          title: n.title, music: n.music, artist: n.artist, dur: n.dur, cover: n.cover,
          ts: Date.now()
        });
      }
      out.push(n);
    }
  });
  return out;
}

/** 抖音搜视频（要登录 + a_bogus 签名 + 完整设备指纹参数） */
const DY_SEARCH_TTL = 5 * 60 * 1000;
const dySearchCache = new Map();
async function dySearch(kw, limit) {
  if (!dyLogged()) throw new Error('NEED_LOGIN');
  const capped = Math.max(6, Math.min(20, limit || 12));
  const hit = dySearchCache.get(kw);
  if (hit && Date.now() - hit.ts < DY_SEARCH_TTL) return hit.list.slice(0, capped);

  const j = await dyApi('general/search/single/', {
    search_channel: 'aweme_general', sort_type: '0', publish_time: '0',
    keyword: kw, enter_from: 'search_history', enter_method: 'click_search_button',
    search_id: '', is_filter_search: '0', has_group: '',
    search_source: 'normal_search', query_correct_type: '1',
    offset: '0', count: String(capped), need_filter_settings: '1',
    list_type: 'multi', is_user_recently_search: 'false'
  });
  const why = dyWhy(j);
  if (why) { dyLastErr = why; throw new Error(why); }
  const list = dyParseSearch(j);
  if (!list.length) {
    // 签名/参数被风控时抖音会"假成功"：status 0 但 data 空、search_nil_type=verify_check
    const nil = (j.search_nil_info && j.search_nil_info.search_nil_type) || '';
    dyLastErr = nil ? 'VERIFY_CHECK' : 'EMPTY';
    throw new Error(dyLastErr);
  }
  dySearchCache.set(kw, { list: list, ts: Date.now() });
  return list.slice(0, capped);
}

/** 抖音视频详情 → 音轨地址 */
function dyAudioFromAweme(a) {
  const mu = dyPlayUrlOf((a.music || {}).play_url);
  const vd = dyPlayUrlOf((a.video || {}).play_addr);
  const raw = mu || vd;
  if (!raw) throw new Error('NO_AUDIO');
  const info = dyNorm(a);
  return Object.assign({}, info, { raw: raw, url: mediaProxyUrl(raw), kind: mu ? 'music' : 'video' });
}

async function dyAudio(awemeId) {
  // 1) 搜索时顺手缓存过的音轨（最快，零额外请求）
  const rc = dyRawCache.get(curDyKey() + '|' + awemeId);
  if (rc && rc.raw && Date.now() - rc.ts < DY_AUDIO_TTL) {
    return {
      awemeId: awemeId,
      title: rc.title || '', music: rc.music || '', artist: rc.artist || '',
      dur: rc.dur || 0, cover: rc.cover || '',
      raw: rc.raw, url: mediaProxyUrl(rc.raw), kind: rc.kind || 'video'
    };
  }
  if (!dyLogged()) throw new Error('NEED_LOGIN');

  // 2) 签名直调详情接口
  const j = await dyApi('aweme/detail/', { aweme_id: String(awemeId) });
  const why = dyWhy(j);
  if (why) { dyLastErr = why; throw new Error(why); }
  if (!j.aweme_detail) throw new Error('DETAIL_EMPTY');
  const a = dyAudioFromAweme(j.aweme_detail);
  dyRawCache.set(curDyKey() + '|' + awemeId, {
    raw: a.raw, kind: a.kind, title: a.title, music: a.music,
    artist: a.artist, dur: a.dur, cover: a.cover, ts: Date.now()
  });
  return a;
}

const DY_AUDIO_TTL = 10 * 60 * 1000;
const dyAudioCache = new Map();
async function dyAudioCached(awemeId) {
  const hit = dyAudioCache.get(curDyKey() + '|' + awemeId);
  if (hit && Date.now() - hit.ts < DY_AUDIO_TTL) {
    tagAudio(hit.data.raw, 'd:' + awemeId);
    return hit.data;
  }
  const data = await dyAudio(awemeId);
  tagAudio(data.raw, 'd:' + awemeId);
  dyAudioCache.set(curDyKey() + '|' + awemeId, { data: data, ts: Date.now() });
  return data;
}

/** 选片：优先歌名对得上、时长接近的 */
function dyPick(list, title, artist, wantDur) {
  const flat = (s) => String(s || '').toLowerCase().replace(/[\s\-–—_·、,，.。!！?？'"“”《》【】()（）#]/g, '');
  const want = flat(title);
  const who = flat(artist);
  let best = null;
  let bestScore = -1e9;
  list.forEach((v) => {
    let s = 0;
    const t = flat(v.title);
    const m = flat(v.music);
    if (t.indexOf(want) >= 0) s += 40;
    if (m && m.indexOf(want) >= 0) s += 45;
    if (who && (t.indexOf(who) >= 0 || m.indexOf(who) >= 0 || flat(v.artist).indexOf(who) >= 0)) s += 25;
    if (wantDur && v.dur) {
      const d = Math.abs(v.dur - wantDur);
      s += d < 6 ? 30 : d < 15 ? 12 : d < 40 ? 0 : -25;
    }
    if (v.dur && v.dur < 25) s -= 30;   // 十几秒的片段不适合当歌听
    if (/(舞蹈|翻跳|挑战|变装|教程|直播|切片|预告|花絮|表情包|鬼畜)/.test(v.title)) s -= 35;
    if (s > bestScore) { bestScore = s; best = v; }
  });
  return bestScore >= 30 ? best : null;
}

/** 登录用的本机浏览器 */
function dyChromeBin() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (let i = 0; i < cands.length; i++) {
    try { if (cands[i] && fs.existsSync(cands[i])) return cands[i]; } catch (e) {}
  }
  return '';
}

function dyStartBrowser() {
  const bin = dyChromeBin();
  if (!bin) throw new Error('没找到本机 Chrome / Edge，请改用「粘贴 Cookie」登录');
  fs.mkdirSync(DY_DIR, { recursive: true });
  if (dyChromeProc) {
    try { dyChromeProc.kill(); } catch (e) {}
    dyChromeProc = null;
  }
  dyChromeProc = require('child_process').spawn(
    bin,
    [
      '--user-data-dir=' + path.join(os.tmpdir(), 'listen-dy-chrome'),   // 放在系统临时目录，绝不进项目/部署包
      '--remote-debugging-port=' + DY_DEBUG_PORT,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://www.douyin.com/'
    ],
    { stdio: 'ignore', windowsHide: false }
  );
  dyChromeProc.on('exit', () => { dyChromeProc = null; });
  return { bin: path.basename(bin) };
}

function localJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 3000 }, (s) => {
      let b = '';
      s.on('data', (c) => (b += c));
      s.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 从登录窗口里把 douyin.com 的 Cookie 读出来 */
async function dyReadBrowserCookies() {
  let list;
  try {
    list = await localJson(DY_DEBUG_PORT, '/json/list');
  } catch (e) {
    return { ready: false, reason: '窗口没打开' };
  }
  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) return { ready: false, reason: '窗口里还没有页面' };
  if (typeof WebSocket === 'undefined') return { ready: false, reason: '当前 Node 版本不支持读取会话' };

  const jar = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch (e) { return finish(null); }
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} finish(null); }, 4000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Network.getCookies', params: { urls: ['https://www.douyin.com/', 'https://www.douyin.com'] } }));
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id === 2) {
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        finish((m.result && m.result.cookies) || []);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish(null); });
  });

  if (!jar) return { ready: false, reason: '读取会话超时' };
  const map = {};
  jar.forEach((c) => { if (/(^|\.)douyin\.com$/i.test(c.domain) || /douyin/i.test(c.domain)) map[c.name] = c.value; });
  if (!map.sessionid && !map.sessionid_ss) return { ready: false, reason: '还没登录（等你在窗口里扫码）' };
  const cookie = Object.keys(map).map((k) => k + '=' + map[k]).join('; ');
  return { ready: true, cookie: cookie, uid: map['uid_tt'] || map['uid_tt_ss'] || '' };
}

/** 试着取昵称（取不到不影响使用） */
async function dyProfile() {
  if (!dyLogged()) return null;
  const tries = ['user/profile/self/', 'im/user/info/'];
  for (let i = 0; i < tries.length; i++) {
    try {
      const j = await dyApi(tries[i]);
      if (j && j.status_code === 0) {
        const u = j.user || (j.data && j.data.user) || j.user_info || null;
        if (u) return { nickname: u.nickname || u.name || '', uid: u.uid || u.sec_uid || '' };
      }
    } catch (e) {}
  }
  return null;
}

/* ---------------- 猜你喜欢 ---------------- */
const REC_NOISE = /(无损|hi-?res|高解析|高音质|超高音质|音质|动态歌词|带歌词|附歌词|歌词版|4k|8k|1080p|60帧|完整版|珍藏版|收藏级|官方|原版|正版|\bmv\b|无水印|重制|修复版|纯享|试听|高码率|全景声)/gi;

const recKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-–—_·、,，.。!！?？'"“”《》【】()（）]/g, '');

/* --- 口味画像用的元数据源（只用来决定推哪首，播放仍走 B 站） --- */

const artistIdCache = new Map();
async function neteaseArtistId(name) {
  if (artistIdCache.has(name)) return artistIdCache.get(name);
  const j = await getJson('https://music.163.com/api/search/get', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'os=pc; appver=8.9.70' }, NE_HEADERS),
    body: 's=' + encodeURIComponent(name) + '&type=100&limit=1&offset=0'
  });
  const a = j && j.result && j.result.artists && j.result.artists[0];
  const id = a ? a.id : 0;
  artistIdCache.set(name, id);
  return id;
}

const artistSongsCache = new Map();
async function artistTopSongs(id, limit) {
  const hit = artistSongsCache.get(id);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.data;
  const j = await getJson(
    'https://music.163.com/api/v1/artist/songs?id=' + id + '&limit=' + (limit || 30) + '&offset=0&order=hot',
    { headers: Object.assign({ Cookie: 'os=pc; appver=8.9.70' }, NE_HEADERS) }
  );
  const data = ((j && j.songs) || []).map((s) => ({
    title: s.name,
    artist: (s.artists || []).map((a) => a.name).join(' / '),
    dur: Math.round((s.duration || 0) / 1000),
    cover: coverOf(s.album && s.album.picUrl)
  }));
  artistSongsCache.set(id, { data, ts: Date.now() });
  return data;
}

const hotChartCache = { ts: 0, data: [] };
async function neteaseHotChart() {
  if (hotChartCache.data.length && Date.now() - hotChartCache.ts < 10 * 60 * 1000) return hotChartCache.data;
  const j = await getJson('https://music.163.com/api/playlist/detail?id=3778678', {
    headers: Object.assign({ Cookie: 'os=pc; appver=8.9.70' }, NE_HEADERS)
  });
  const tracks = (j && j.result && j.result.tracks) || [];
  hotChartCache.data = tracks.map((t) => ({
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(' / '),
    dur: Math.round((t.duration || 0) / 1000),
    cover: coverOf(t.album && t.album.picUrl)
  }));
  hotChartCache.ts = Date.now();
  return hotChartCache.data;
}

const BAD_TITLE = /教学|教程|翻唱|伴奏|钢琴|吉他|指弹|架子鼓|鼓手|混音|remix|\bdj\b|karaoke|纯音乐|instrumental|cover|reaction|解析|合集|歌单|串烧|半小时|一小时|电台|直播|音乐节|采访|纪录片|花絮|配音|有声书|鬼畜|沙雕|搞笑|整活|挑战|测评|游戏|原声带|OST/i;

/** 从 "【无损】林俊杰《愿与愁》..." 或 "《海屿你》- 马也_Crabbit" 里抠出歌手名 */
function guessArtist(raw) {
  const s = String(raw || '');
  // 1) 歌名后面 " - 歌手"
  const after = s.match(/《[^》]{1,40}》\s*[-–—－~～:：]\s*([^\s【】\[\]（）()｜|]{2,16})/);
  if (after) return after[1].trim();

  const clean = (x) =>
    x
      .replace(/【[^】]*】/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(REC_NOISE, ' ')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9·\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // 2) 歌名后面紧跟的文字
  const tail = s.split(/《[^》]{1,40}》/)[1];
  if (tail) {
    const c = clean(tail);
    if (c.length >= 2 && c.length <= 16) return c;
  }
  // 3) 书名号前面
  const head = clean(s.split('《')[0]);
  return head.length >= 2 && head.length <= 16 ? head : '';
}

const biliHotCache = { ts: 0, data: [] };

/** B 站「热点歌曲」：按热度搜单曲投稿，只留标题带《》且像正经单曲的 */
async function biliHotSongs(limit) {
  if (biliHotCache.data.length && Date.now() - biliHotCache.ts < 10 * 60 * 1000) return biliHotCache.data;

  const kws = ['无损音质 热门歌曲', '高音质 单曲循环', '宝藏歌曲 无损'];
  const seen = new Set();
  const out = [];

  for (let i = 0; i < kws.length; i++) {
    let list = [];
    try {
      list = await biliSearch(kws[i], 20);
    } catch (e) {
      continue;
    }
    list.sort((a, b) => (b.play || 0) - (a.play || 0));
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      const raw = String(v.title || '');
      const m = raw.match(/《([^》]{1,30})》/);
      if (!m) continue;
      if (BAD_TITLE.test(raw)) continue;
      if (!v.sec || v.sec < 110 || v.sec > 430) continue;
      const key = recKey(m[1]);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        bvid: v.bvid,
        title: m[1].replace(REC_NOISE, '').trim().slice(0, 28),
        artist: guessArtist(raw) || v.author || '',
        dur: v.sec,
        cover: v.cover || '',
        play: v.play || 0,
        why: 'B 站热播单曲'
      });
    }
  }

  biliHotCache.data = out.sort((a, b) => b.play - a.play).slice(0, 30);
  biliHotCache.ts = Date.now();
  return biliHotCache.data;
}

/** 曲风/时段关键词搜歌（推荐用，30 分钟缓存） */
const biliTagCache = new Map();

async function biliTagSongs(kw, whyLabel) {
  const hit = biliTagCache.get(kw);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;
  const list = await biliSearch(kw, 20);
  const out = [];
  const seen = new Set();
  list.sort((a, b) => (b.play || 0) - (a.play || 0));
  for (const v of list) {
    const raw = String(v.title || '');
    const m = raw.match(/《([^》]{1,30})》/);
    if (!m) continue;
    if (BAD_TITLE.test(raw)) continue;
    if (!v.sec || v.sec < 110 || v.sec > 430) continue;
    const key = recKey(m[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      bvid: v.bvid,
      title: m[1].replace(REC_NOISE, '').trim().slice(0, 28),
      artist: guessArtist(raw) || v.author || '',
      dur: v.sec,
      cover: v.cover || '',
      play: v.play || 0,
      why: whyLabel
    });
  }
  biliTagCache.set(kw, { data: out, ts: Date.now() });
  return out;
}

/** 按小时段选氛围关键词 */
function moodKeyword() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return { kw: '晨间 舒服 好歌', why: '清晨适合听' };
  if (h >= 11 && h < 17) return { kw: '午后 轻松 好歌', why: '午后适合听' };
  if (h >= 17 && h < 23) return { kw: '夜晚 抒情 好歌', why: '夜晚适合听' };
  return { kw: '深夜 安静 好歌', why: '深夜适合听' };
}

/**
 * 推荐 10 首（多路召回 + 多样性约束）：
 *   1. 口味歌手 45%：常听/喜欢的歌手热门曲（前端带时间衰减权重排序）
 *   2. 曲风标签探索 20%：从听歌记录挖掘的曲风词（民谣/钢琴/粤语…）搜 B 站好歌
 *   3. 时段氛围 15%：清晨/午后/夜晚/深夜 不同的氛围歌
 *   4. B 站热播 20% + 全站热歌兜底
 * 同一歌手一批最多 2 首（多样性），seenTitles 里的不再出现
 */
async function recommend(limit, seedArtists, seenTitles, fresh, tags) {
  limit = Math.min(20, Math.max(1, Number(limit) || 10));
  const seen = new Set();
  (seenTitles || []).forEach((t) => {
    const k = recKey(t);
    if (k) seen.add(k);
  });

  const picked = [];
  const artistCount = {};   // MMR：同歌手多样性约束
  const take = (item) => {
    if (picked.length >= limit || !item || !item.title) return false;
    const k = recKey(item.title);
    if (!k || k.length < 1 || seen.has(k)) return false;
    if (!item.dur || item.dur < 60) return false;
    const ac = String(item.artist || '').split(/\s*[\/、,&]\s*/)[0].trim().slice(0, 12);   // 主歌手归一化
    if (ac && (artistCount[ac] || 0) >= 2) return false;   // 同歌手一批 ≤2 首
    seen.add(k);
    artistCount[ac] = (artistCount[ac] || 0) + 1;
    picked.push(item);
    return true;
  };

  const f = Number(fresh) || 0;
  const artists = (seedArtists || []).filter(Boolean).slice(0, 3);

  // 1) 口味：每个常听歌手取几首没听过的热门曲（45%）
  const perArtist = artists.length ? Math.max(2, Math.ceil((limit * 0.45) / artists.length)) : 0;
  for (let i = 0; i < artists.length; i++) {
    const a = artists[i];
    try {
      const id = await neteaseArtistId(a);
      if (!id) continue;
      const songs = await artistTopSongs(id, 40);
      // 每批从不同位置开始，避免每次都是同几首
      const off = songs.length ? (f * 3) % songs.length : 0;
      const ordered = songs.slice(off).concat(songs.slice(0, off));
      let got = 0;
      for (let k = 0; k < ordered.length && got < perArtist; k++) {
        if (take(Object.assign({}, ordered[k], { why: '你在听 ' + a }))) got++;
      }
    } catch (e) {
      /* 单歌手失败不影响整体 */
    }
  }

  // 2) 曲风标签探索（20%）：前端从听歌记录挖掘出来的词
  const quota2 = Math.max(1, Math.round(limit * 0.2));
  const tagList = (tags || []).filter(Boolean).slice(0, 2);
  for (const tag of tagList) {
    if (picked.length >= limit) break;
    try {
      const songs = await biliTagSongs(tag + ' 好歌 无损', '你的口味 · ' + tag);
      const off = songs.length ? (f * 4) % songs.length : 0;
      const ordered = songs.slice(off).concat(songs.slice(0, off));
      let got = 0;
      for (let i = 0; i < ordered.length && got < quota2; i++) {
        if (take(ordered[i])) got++;
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  // 3) 时段氛围（15%）：不同时间推荐不同的氛围歌
  const mood = moodKeyword();
  try {
    const songs = await biliTagSongs(mood.kw, mood.why);
    const off = songs.length ? (f * 2) % songs.length : 0;
    const ordered = songs.slice(off).concat(songs.slice(0, off));
    let got = 0;
    const quota3 = Math.max(1, Math.round(limit * 0.15));
    for (let i = 0; i < ordered.length && got < quota3; i++) {
      if (take(ordered[i])) got++;
    }
  } catch (e) {
    /* 忽略 */
  }

  // 4) B 站音乐区热榜（发现新歌，20%）
  try {
    const hot = await biliHotSongs(limit);
    const off = hot.length ? (f * 2) % hot.length : 0;
    const ordered = hot.slice(off).concat(hot.slice(0, off));
    let got = 0;
    const quota4 = Math.max(2, Math.round(limit * 0.2));
    for (let i = 0; i < ordered.length && got < quota4; i++) {
      if (take(ordered[i])) got++;
    }
  } catch (e) {
    /* 热榜挂了就继续兜底 */
  }

  // 5) 全站热歌榜补足（只在还缺的时候）
  try {
    const chart = await neteaseHotChart();
    const off = chart.length ? (f * 5) % chart.length : 0;
    const ordered = chart.slice(off).concat(chart.slice(0, off));
    for (let i = 0; i < ordered.length && picked.length < limit; i++) {
      take(Object.assign({}, ordered[i], { why: '全站热歌' }));
    }
  } catch (e) {
    /* 忽略 */
  }

  return picked.slice(0, limit);
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/listen.html';
  // 不对外暴露任何点号开头的目录/文件（会话 Cookie 就放在 .dydata 里）
  if (rel.split(/[\\/]/).some((s) => s.charAt(0) === '.' && s.length > 1)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 读请求体（用于 POST 提交 Cookie） */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 64 * 1024)) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/* ---------------- 多设备数据同步（喜欢 / 历史 / 播放列表） ---------------- */
const DATA_DIR = path.join(ROOT, '.listen-data');
const DATA_FILE = path.join(DATA_DIR, 'sync.json');

function loadSyncData(file) {
  try {
    return JSON.parse(fs.readFileSync(file || DATA_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveSyncData(payload, file) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const f = file || DATA_FILE;
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 账号体系（QQ 号式：数字账号 + 密码） ---------------- */
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadUsers() {
  try {
    const d = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return { nextId: d.nextId || 100001, users: d.users || {}, sessions: d.sessions || {} };
  } catch (e) {
    return { nextId: 100001, users: {}, sessions: {} };
  }
}

function saveUsers(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, USERS_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), String(salt), 32).toString('hex');
}

function pruneSessions(db) {
  const now = Date.now();
  const keys = Object.keys(db.sessions);
  for (const k of keys) {
    if (now - (db.sessions[k].ts || 0) > 90 * 24 * 3600 * 1000) delete db.sessions[k];
  }
  if (keys.length > 300) {
    keys.sort((a, b) => (db.sessions[a].ts || 0) - (db.sessions[b].ts || 0));
    for (const k of keys.slice(0, keys.length - 300)) delete db.sessions[k];
  }
}

function accountOfToken(token) {
  if (!token) return null;
  const db = loadUsers();
  const s = db.sessions[String(token)];
  if (!s || !db.users[s.account]) return null;
  return { account: s.account, nickname: db.users[s.account].nickname };
}

/* 登录用户的云端数据按账号分文件存；未登录的落到共享空间 */
function dataFileFor(token) {
  const me = accountOfToken(token);
  if (me) return path.join(DATA_DIR, 'data-' + me.account + '.json');
  return DATA_FILE;
}

/* ---------------- 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  const q = u.searchParams;

  // 整个请求在「身份上下文」里跑：抖音会话、缓存都按这个身份隔离
  return dyCtx.run(dyIdentityOf(q), async () => {
  try {
    /* ---------------- 账号：注册（用户自选数字账号，如 QQ 号） ---------------- */
    if (p === '/api/auth/register' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await readBody(req, 16 * 1024)); } catch (e) { /* 忽略坏包 */ }
      const account = String(b.account || '').trim();
      if (!/^\d{5,11}$/.test(account)) return json(res, 400, { ok: false, error: '账号必须是 5~11 位数字（比如你的 QQ 号）' });
      const pw = String(b.password || '');
      if (pw.length < 6) return json(res, 400, { ok: false, error: '密码至少 6 位' });
      if (pw.length > 64) return json(res, 400, { ok: false, error: '密码太长了（最多 64 位）' });
      const db = loadUsers();
      if (db.users[account]) return json(res, 400, { ok: false, error: '账号 ' + account + ' 已被占用，换一个数字账号试试' });
      const salt = crypto.randomBytes(8).toString('hex');
      db.users[account] = {
        salt,
        hash: hashPassword(pw, salt),
        nickname: String(b.nickname || '').trim().slice(0, 20) || '用户' + account.slice(-4),
        createdAt: Date.now()
      };
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = { account, ts: Date.now() };
      pruneSessions(db);
      saveUsers(db);
      return json(res, 200, { ok: true, account, token, nickname: db.users[account].nickname });
    }

    /* ---------------- 账号：登录 ---------------- */
    if (p === '/api/auth/login' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await readBody(req, 16 * 1024)); } catch (e) { /* 忽略坏包 */ }
      const account = String(b.account || '').trim();
      const db = loadUsers();
      const u = db.users[account];
      if (!u) return json(res, 200, { ok: false, error: '账号不存在，检查一下数字账号是否输对，或先注册' });
      if (hashPassword(String(b.password || ''), u.salt) !== u.hash) {
        return json(res, 200, { ok: false, error: '密码不对，再试试' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = { account, ts: Date.now() };
      pruneSessions(db);
      saveUsers(db);
      return json(res, 200, { ok: true, account, token, nickname: u.nickname });
    }

    /* ---------------- 账号：当前登录信息 ---------------- */
    if (p === '/api/auth/me' && req.method === 'GET') {
      const me = accountOfToken(q.get('token'));
      return json(res, 200, me ? { ok: true, account: me.account, nickname: me.nickname } : { ok: false });
    }

    /* ---------------- 账号：退出登录 ---------------- */
    if (p === '/api/auth/logout' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await readBody(req, 4 * 1024)); } catch (e) { /* 忽略坏包 */ }
      const db = loadUsers();
      if (b.token && db.sessions[b.token]) {
        delete db.sessions[b.token];
        saveUsers(db);
      }
      return json(res, 200, { ok: true });
    }

    /* ---------------- 多设备数据同步 ---------------- */
    if (p === '/api/sync' && req.method === 'GET') {
      const f = dataFileFor(q.get('token'));
      const d = loadSyncData(f);
      return json(res, 200, { ok: true, data: d ? d.data : null, ts: d ? d.ts : 0 });
    }
    if (p === '/api/sync' && req.method === 'POST') {
      const raw = await readBody(req, 2 * 1024 * 1024);
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* 忽略坏包 */ }
      if (!data || typeof data !== 'object') return json(res, 400, { ok: false, error: '数据格式不对' });
      const f = dataFileFor(data.token);
      const payload = { data, ts: Date.now() };
      delete payload.data.token;   // token 不落盘到数据文件
      const ok = saveSyncData(payload, f);
      return json(res, ok ? 200 : 500, { ok });
    }

    if (p === '/api/search') {
      const kw = (q.get('kw') || '').trim();
      if (!kw) return json(res, 400, { error: '缺少关键词' });
      const src = (q.get('src') || 'all').toLowerCase();
      const limit = Math.min(30, Number(q.get('limit')) || 30);
      let data = { total: 0, songs: [] };
      let lastError = '';

      if (src === 'netease') {
        try {
          data = await searchSongs(kw, q.get('page'), limit);
        } catch (e) {
          lastError = e.message;
        }
      } else if (src === 'bili') {
        // 用户点名要 B 站：限定音乐分区 + 滤掉影视/剧情类视频音频
        try {
          const songs = await biliDirectSearch(kw, limit);
          data = { total: songs.length, songs };
        } catch (e) {
          lastError = e.message;
        }
      } else if (src === 'qq') {
        // QQ 音乐：信息最准，但只给信息不给音轨
        try {
          data = await qqSearch(kw, limit);
        } catch (e) {
          lastError = 'QQ 音乐：' + e.message;
        }
      } else if (src === 'douyin') {
        try {
          const list = await dySearch(kw, limit);
          data = { total: list.length, songs: list.map(dyToSong) };
        } catch (e) {
          lastError = e.message;
        }
      } else {
        // 全部：网易云 + QQ 音乐 + B 站 + （已登录时）抖音 四路并发，按顺序合并去重
        const jobs = [
          searchSongs(kw, 1, limit).catch(() => null),
          qqSearch(kw, Math.min(20, limit)).catch(() => null),
          biliSongSearch(kw, Math.min(20, limit)).catch(() => null),
          dyLogged()
            ? dySearch(kw, 8).then((l) => l.map(dyToSong)).catch(() => null)
            : Promise.resolve(null)
        ];
        const parts = await Promise.all(jobs);
        const merged = [];
        const seen = new Set();
        const push = (arr) =>
          (arr || []).forEach((s) => {
            const k = recKey(s.title) + '|' + recKey(s.artist);
            if (k.length < 2 || seen.has(k)) return;
            seen.add(k);
            merged.push(s);
          });
        push(parts[0] && parts[0].songs);
        push(parts[1] && parts[1].songs);
        push(parts[2] && parts[2].songs);
        push(parts[3]);
        data = { total: merged.length, songs: merged };
        if (!merged.length) {
          const why = parts.map((x, i) => (x ? '' : ['网易云', 'QQ 音乐', 'B 站', '抖音'][i])).filter(Boolean);
          if (why.length) lastError = why.join(' / ') + ' 搜索都失败了';
        }
      }
      return json(res, 200, Object.assign(data, { lastError: lastError || '' }));
    }

    if (p === '/api/url') {
      const id = (q.get('id') || '').replace(/^ne/, '');
      if (!/^\d+$/.test(id)) return json(res, 400, { error: '歌曲 id 不合法' });
      const data = await songUrl(id);
      return json(res, 200, data);
    }

    /* ---------------- QQ 音乐歌单（信息源：热门榜 + 歌单详情） ---------------- */
    if (p === '/api/qq/playlists') {
      try {
        const data = await qqHotPlaylists(q.get('limit'), q.get('page'));
        return json(res, 200, data);
      } catch (e) {
        return json(res, 200, { playlists: [], error: 'QQ 音乐歌单：' + e.message });
      }
    }
    if (p === '/api/qq/playlist') {
      if (!q.get('id')) return json(res, 400, { error: '缺少歌单 id' });
      try {
        const data = await qqPlaylist(q.get('id'), q.get('limit'));
        return json(res, 200, data);
      } catch (e) {
        return json(res, 200, { songs: [], error: 'QQ 音乐歌单：' + e.message });
      }
    }

    if (p === '/api/lyric') {
      const rawId = (q.get('id') || '').trim();
      const id = rawId.replace(/^ne/, '');
      const mid = (q.get('mid') || '').trim().replace(/^qq/, '');
      const title = (q.get('title') || '').trim();
      const artist = (q.get('artist') || '').trim();
      const dur = Number(q.get('dur')) || 0;
      const opt = {};
      if (mid && /^[0-9A-Za-z]{10,20}$/.test(mid)) opt.mid = mid;
      else if (/^\d+$/.test(id)) opt.id = id;
      if (!opt.mid && !opt.id) {
        if (!title) return json(res, 400, { error: '缺少歌名' });
        opt.title = title;
        opt.artist = artist;
        opt.dur = dur;
      }
      try {
        const data = await lyricGet(opt);
        return json(res, 200, data.lrc ? data : Object.assign({ error: '没找到匹配的歌词' }, data));
      } catch (e) {
        return json(res, 200, { lrc: '', error: '歌词获取失败：' + e.message });
      }
    }

    if (p === '/api/bili/search') {
      const kw = (q.get('kw') || '').trim();
      if (!kw) return json(res, 400, { error: '缺少关键词' });
      const list = await biliSearch(kw, Number(q.get('limit')) || 20);
      return json(res, 200, { songs: list });
    }

    if (p === '/api/bili/stream') {
      return proxyBiliStream(q.get('u') || '', req, res);
    }

    if (p === '/api/bili/audio') {
      const bvid = (q.get('bvid') || '').trim();
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return json(res, 400, { error: 'bvid 不合法' });
      const pn = Math.max(1, Number(q.get('p')) || 1);
      const info = await biliInfo(bvid);
      let cid = info.cid, dur = info.dur || 0, title = info.title;
      if (pn > 1 && info.pages && info.pages[pn - 1]) {
        cid = info.pages[pn - 1].cid;
        dur = info.pages[pn - 1].dur || dur;
        title = info.title + ' P' + pn;
      }
      const audio = await biliAudio(bvid, cid);
      warmMaybe(audio.url, q.get('warm') === '1');
      return json(res, 200, {
        url: biliProxyUrl(audio.url),
        quality: audio.bitrate,
        title,
        author: info.owner || '',
        source: 'bilibili',
        cover: info.pic ? (info.pic.indexOf('//') === 0 ? 'https:' + info.pic : info.pic) : '',
        dur
      });
    }

    if (p === '/api/recommend') {
      const artists = (q.get('artists') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const titles = (q.get('titles') || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const tags = (q.get('tags') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const songs = await recommend(q.get('limit'), artists, titles, Number(q.get('fresh')) || 0, tags);
      return json(res, 200, { songs, seedArtists: artists });
    }

    if (p === '/api/resolve') {
      const title = (q.get('title') || '').trim();
      const artist = (q.get('artist') || '').trim();
      if (!title) return json(res, 400, { error: '缺少歌名' });
      const data = await resolveFallback(
        title,
        artist,
        Number(q.get('dur')) || 0,
        q.get('prefer') === 'bili',
        q.get('warm') === '1'
      );
      const out = {};
      Object.keys(data).forEach((k) => { if (k !== 'raw') out[k] = data[k]; });
      return json(res, 200, out);
    }

    if (p === '/api/prefetch') {
      // 静默预取：前端在播放当前歌时提前把下一首的地址与首段缓冲准备好
      const bvid = (q.get('bvid') || '').trim();
      const title = (q.get('title') || '').trim();
      if (bvid && /^BV[0-9A-Za-z]{8,12}$/.test(bvid)) {
        const info = await biliInfo(bvid);
        const audio = await biliAudio(bvid, info.cid);
        warmMaybe(audio.url, q.get('warm') !== '0');
        return json(res, 200, { url: biliProxyUrl(audio.url), source: 'bilibili', quality: audio.bitrate, dur: info.dur || 0 });
      }
      if (!title) return json(res, 400, { error: '缺少歌名或 bvid' });
      const data = await resolveFallback(title, (q.get('artist') || '').trim(), Number(q.get('dur')) || 0, true, q.get('warm') !== '0');
      const out = {};
      Object.keys(data).forEach((k) => { if (k !== 'raw') out[k] = data[k]; });
      return json(res, 200, out);
    }

    /* ---------------- 抖音登录 ---------------- */
    if (p === '/api/dy/status') {
      const s = DY_STATE();
      return json(res, 200, {
        logged: !!s.cookie,
        nickname: s.nickname || '',
        uid: s.uid || '',
        ts: s.ts || 0,
        windowOpen: !!dyChromeProc,
        lastError: dyLastErr || '',
        // 旧版全局会话还在 + 当前是账号身份 + 本人还没绑 → 允许手动认领一次
        claimable: !s.cookie && dyLegacyExists() && /^u\d+$/.test(curDyKey())
      });
    }

    if (p === '/api/dy/claim' && req.method === 'POST') {
      const key = curDyKey();
      if (!/^u\d+$/.test(key)) return json(res, 400, { ok: false, error: '先登录你的耳边账号，再点这个按钮' });
      const old = dySessions.get(key);
      if (old && old.cookie) return json(res, 200, { ok: true, already: true, nickname: old.nickname || '' });
      const got = dyAdoptLegacy(key, true);
      if (!got) return json(res, 200, { ok: false, error: '这台服务器上没有可认领的旧版抖音登录态，请用扫码 / Cookie 重新登录一次' });
      dySessions.set(key, got);
      return json(res, 200, { ok: true, nickname: got.nickname || '' });
    }

    if (p === '/api/dy/login/browser' && req.method === 'POST') {
      try {
        const r = dyStartBrowser();
        return json(res, 200, { ok: true, port: DY_DEBUG_PORT, bin: r.bin });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/dy/login/poll') {
      const r = await dyReadBrowserCookies();
      if (!r.ready) return json(res, 200, { ok: false, reason: r.reason });
      dySave(r.cookie, { uid: r.uid || '' });
      const prof = await dyProfile();
      if (prof) dySave(r.cookie, { uid: prof.uid || r.uid || '', nickname: prof.nickname || '' });
      return json(res, 200, {
        ok: true,
        nickname: (DY_STATE().nickname) || '',
        lastError: dyLastErr || ''
      });
    }

    if (p === '/api/dy/login/cookie' && req.method === 'POST') {
      const body = await readBody(req);
      let cookie = '';
      try {
        cookie = JSON.parse(body).cookie || '';
      } catch (e) {
        cookie = body;
      }
      cookie = String(cookie || '').trim().replace(/^cookie\s*:\s*/i, '');
      if (!/sessionid/i.test(cookie)) {
        return json(res, 400, { ok: false, error: 'Cookie 里没有 sessionid，可能还没登录成功' });
      }
      dySave(cookie, {});
      const prof = await dyProfile();
      if (prof) dySave(cookie, { uid: prof.uid || '', nickname: prof.nickname || '' });
      return json(res, 200, {
        ok: true,
        nickname: (DY_STATE().nickname) || '',
        lastError: dyLastErr || ''
      });
    }

    if (p === '/api/dy/logout' && req.method === 'POST') {
      dyClear();
      dyAudioCache.clear();
      if (dyChromeProc) {
        try { dyChromeProc.kill(); } catch (e) {}
        dyChromeProc = null;
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/dy/search') {
      const kw = (q.get('kw') || '').trim();
      if (!kw) return json(res, 400, { error: '缺少关键词' });
      try {
        const list = await dySearch(kw, Number(q.get('limit')) || 12);
        return json(res, 200, { songs: list, lastError: '' });
      } catch (e) {
        return json(res, 200, { songs: [], lastError: e.message });
      }
    }

    if (p === '/api/dy/audio') {
      const id = (q.get('awemeId') || '').trim();
      if (!/^\d{6,25}$/.test(id)) return json(res, 400, { error: 'awemeId 不合法' });
      try {
        const a = await dyAudioCached(id);
        warmMaybe(a.raw, q.get('warm') === '1');
        return json(res, 200, {
          url: a.url,
          source: 'douyin',
          title: a.music || a.title,
          author: a.artist,
          cover: a.cover,
          dur: a.dur,
          quality: a.kind === 'music' ? '抖音原声' : '抖音视频音轨'
        });
      } catch (e) {
        return json(res, 200, { error: e.message, lastError: e.message });
      }
    }

    if (p === '/api/dy/probe') {
      const kw = (q.get('kw') || '晴天').trim();
      const out = { logged: dyLogged(), cookieLen: (DY_STATE().cookie || '').length };
      try {
        const list = await dySearch(kw, 5);
        out.search = { ok: true, count: list.length, sample: list.slice(0, 2) };
        if (list[0]) {
          try {
            const a = await dyAudio(list[0].awemeId);
            out.audio = { ok: true, kind: a.kind, host: (a.raw.match(/^https?:\/\/([^/]+)/) || [])[1] || '' };
          } catch (e) {
            out.audio = { ok: false, error: e.message };
          }
        }
      } catch (e) {
        out.search = { ok: false, error: e.message };
      }
      // 顺便测一下最基础的公开接口，区分"没登录"和"被签名拦"
      try {
        const j = await getJson('https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1', {
          headers: DY_HEADERS
        });
        out.publicApi = { ok: j && j.status_code === 0 };
      } catch (e) {
        out.publicApi = { ok: false, error: e.message };
      }
      return json(res, 200, out);
    }

    if (p === '/api/dy/stream' || p === '/api/media') {
      return proxyBiliStream(q.get('u') || '', req, res);
    }

    /* 音频离线缓存：查状态 / 开关 / 清空 */
    if (p === '/api/audio-cache') {
      if (q.get('on') !== null) {
        audioCaching = q.get('on') !== '0' && q.get('on') !== 'false';
        try {
          fs.mkdirSync(AUDIO_DIR, { recursive: true });
          const flag = path.join(AUDIO_DIR, 'off');
          if (audioCaching) { try { fs.unlinkSync(flag); } catch (e) {} }
          else { fs.writeFileSync(flag, ''); audioPending.clear(); }
        } catch (e) {}
      }
      if (q.get('clear') === '1') {
        const idx = audioIdxLoad();
        idx.forEach((v) => { try { fs.unlinkSync(path.join(AUDIO_DIR, v.f)); } catch (e) {} });
        const n = idx.size;
        idx.clear();
        audioIdxDirty = true;
        audioIdxFlush();
        return json(res, 200, { ok: true, removed: n, count: 0, bytes: 0, limit: AUDIO_MAX_BYTES, enabled: audioCaching });
      }
      return json(res, 200, {
        ok: true,
        count: audioIdxLoad().size,
        bytes: audioTotal(),
        limit: AUDIO_MAX_BYTES,
        enabled: audioCaching
      });
    }

    if (p === '/api/health') return json(res, 200, { ok: true, port: PORT, douyin: dyLogged() });

    if (p === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: '未知接口' });

    serveStatic(p, res);
  } catch (e) {
    json(res, 502, { error: e.message || '请求失败' });
  }
  });
});

/* ---------------- 全局兜底：任何未捕获异常都不许把服务打死 ---------------- */
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', (e && (e.stack || e.message)) || e);
});

// 手机内置运行时用 HOST=127.0.0.1 只监听本机，避免同一 WiFi 下被别人连上
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  // 顺手把音频缓存清一遍：删过期条目、删没有索引的孤儿文件、超量按 LRU 淘汰
  try { audioBootSync(); } catch (e) { console.error('[audio-cache]', e.message); }

  let dyCount = 0;
  try {
    dyCount = fs.readdirSync(DY_DIR).filter((f) => /^dy-.*\.json$|^session\.anon\.json$/.test(f)).length;
  } catch (e) {}
  console.log('');
  console.log('  Listen 已启动 →  http://127.0.0.1:' + PORT + '/');
  console.log('  抖音音源: ' + (dyCount ? dyCount + ' 个账号已绑定（按账号隔离，别人用不了）' : '未绑定（在「我的 → 音源账号」里登录）'));
  console.log('  接口: /api/search?kw=  /api/url?id=  /api/lyric?id=');
  console.log('  按 Ctrl+C 停止');
  console.log('');

  if (process.argv.includes('--open') || process.env.LISTEN_OPEN === '1') {
    setTimeout(() => {
      const open =
        process.platform === 'win32'
          ? 'start "" "http://127.0.0.1:' + PORT + '/"'
          : process.platform === 'darwin'
            ? 'open http://127.0.0.1:' + PORT + '/'
            : 'xdg-open http://127.0.0.1:' + PORT + '/';
      require('child_process').exec(open, { shell: true }, () => {});
    }, 600);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 已被占用。可以换一个端口启动：set PORT=5600 && node listen-server.js');
  } else {
    console.log('启动失败:', e.message);
  }
});
