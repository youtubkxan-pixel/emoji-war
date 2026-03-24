'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const zlib       = require('zlib');
const { Server } = require('socket.io');
const cron       = require('node-cron');

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:         process.env.PORT              || 3000,
  channelId:    process.env.CHANNEL_ID        || 'UCT24pImU78QB7I8a6gofYyA',
  startCron:    process.env.STREAM_START_CRON || '0 20 * * *',
  durationH:    parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  retryDelay:   15000,
  notLiveDelay: 30000,
  maxRetries:   9999,
};

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
let S = {
  live:         false,
  liveId:       null,
  chat:         null,         // youtube-chat instance
  method:       null,         // 'library' | 'direct'
  retries:      0,
  retryTimer:   null,
  endTimer:     null,
  // direct method state
  continuation: null,
  apiKey:       null,
  clientVer:    null,
  visitorData:  null,
  pollTimer:    null,
  seen:         new Set(),
};

// ═══════════════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(express.static(__dirname));
app.get('/health', (_q, res) => res.json({
  ok: true, live: S.live, liveId: S.liveId,
  method: S.method, retries: S.retries,
  uptime: Math.floor(process.uptime()),
  time: new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════
//  KEEP-ALIVE
// ═══════════════════════════════════════════════════════════
function setupKeepAlive() {
  const BASE = process.env.RENDER_EXTERNAL_URL || '';
  if (!BASE) return;
  const url = BASE.replace(/\/$/, '') + '/health';
  log('ok', 'Keep-alive: ' + url);
  setInterval(function() {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, function(res) { log('info', 'Ping: ' + res.statusCode); });
    req.on('error', function(e) { log('warn', 'Ping xato: ' + e.message); });
    req.setTimeout(10000, function() { req.destroy(); });
  }, 10 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════
function log(lvl, msg) {
  const t = new Date().toISOString().slice(11, 19);
  const p = { info: '📘', warn: '⚠️ ', error: '🔴', ok: '✅' }[lvl] || '  ';
  console.log('[' + t + '] ' + p + ' ' + msg);
}

// ═══════════════════════════════════════════════════════════
//  DISPATCH — socket ga yuborish (ikki usul ham shu yerga keladi)
// ═══════════════════════════════════════════════════════════
function dispatch(author, text, emojis, superChat, amount) {
  if (superChat) {
    log('ok', 'SUPERCHAT ' + author + ': ' + amount);
    io.emit('vote',      { author, text: text || '💰', superChat: true, amount });
    io.emit('superchat', { author, amount, text });
    return;
  }
  if (emojis && emojis.length > 0) {
    emojis.forEach(function(e) {
      log('ok', 'EMOJI ' + author + ' -> ' + (e.emojiId || e));
      io.emit('vote', { author, emojiId: e.emojiId || e, emojiUrl: e.emojiUrl || '', text });
    });
    return;
  }
  if (text && text.trim()) {
    log('info', author + ': ' + text.slice(0, 50));
    io.emit('vote', { author, text });
  }
}

// ═══════════════════════════════════════════════════════════
//  USUL 1: youtube-chat KUTUBXONASI (asosiy)
// ═══════════════════════════════════════════════════════════
async function connectViaLibrary() {
  try {
    // Kutubxona mavjudligini tekshirish
    const { LiveChat } = require('youtube-chat');

    log('info', '[USUL-1] youtube-chat kutubxonasi orqali ulanish...');

    // youtube-chat yangi versiyasida channelId bilan to'g'ridan start() qilinadi
    S.chat = new LiveChat({ channelId: CONFIG.channelId });

    // Avval start() qilib liveId ni olamiz
    const started = await S.chat.start();
    if (!started) return false;

    const liveId = S.chat.liveId || S.chat.videoId || CONFIG.channelId;
    S.liveId = liveId;

    S.chat.on('chat', function(msg) {
      const author = (msg.author && msg.author.name) || 'Unknown';
      const text   = (msg.message || []).filter(function(m) { return m.text; }).map(function(m) { return m.text; }).join('');
      const emojis = (msg.message || []).filter(function(m) { return m.emojiId; }).map(function(e) {
        return { emojiId: e.emojiId, emojiUrl: (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || '' };
      });
      const superChat = !!msg.superchat;
      const amount    = (msg.superchat && msg.superchat.amount) || '';
      dispatch(author, text, emojis, superChat, amount);
    });

    S.chat.on('error', function(err) {
      log('error', '[USUL-1] Xato: ' + ((err && err.message) || err));
      S.live   = false;
      S.method = null;
      // Kutubxona ishlamadi — to'g'ridan-to'g'ri usulga o'tish
      log('warn', '[USUL-1] Kutubxona ishlamadi → USUL-2 ga o\'tish');
      clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(function() { connectViaDirect(); }, 3000);
    });

    S.chat.on('end', function() {
      log('warn', '[USUL-1] Efir tugadi');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopAll();
      S.retryTimer = setTimeout(connect, 60000);
    });

    const ok = await S.chat.start();
    if (ok) {
      S.live    = true;
      S.method  = 'library';
      S.retries = 0;
      log('ok', '[USUL-1] Muvaffaqiyatli ulandi! LiveId: ' + liveId);
      io.emit('yt_status', { status: 'CONNECTED', liveId, method: 'library' });
      return true;
    }

    // start() false qaytardi
    log('warn', '[USUL-1] start() false → USUL-2 ga o\'tish');
    return false;

  } catch (e) {
    log('error', '[USUL-1] Kutubxona xato: ' + e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  USUL 2: TO'G'RIDAN-TO'G'RI YouTube API (zaxira)
// ═══════════════════════════════════════════════════════════

// HTTP so'rov yordamchi
function ytFetch(url, opt) {
  opt = opt || {};
  return new Promise(function(ok, fail) {
    var u = new URL(url);
    var headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          opt.json ? 'application/json, */*; q=0.01' : 'text/html,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection':      'keep-alive',
      'Origin':          'https://www.youtube.com',
      'Referer':         'https://www.youtube.com/',
    };
    if (opt.body) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(opt.body);
    }
    var req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   opt.body ? 'POST' : 'GET',
      headers:  headers,
    }, function(res) {
      var enc = res.headers['content-encoding'];
      var stream = res;
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      var buf = [];
      stream.on('data', function(c) { buf.push(c); });
      stream.on('end', function() {
        var txt = Buffer.concat(buf).toString('utf8');
        if (opt.json) {
          try { ok(JSON.parse(txt)); }
          catch(e) { fail(new Error('JSON: ' + txt.slice(0, 100))); }
        } else ok(txt);
      });
      stream.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(18000, function() { req.destroy(new Error('Timeout')); });
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

async function findLiveId() {
  var html = await ytFetch('https://www.youtube.com/channel/' + CONFIG.channelId + '/live');
  var m;
  m = html.match(/"canonicalUrl":"[^"]*v=([a-zA-Z0-9_-]{11})"/);
  if (m) return m[1];
  m = html.match(/content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
  if (m) return m[1];
  m = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (m) return m[1];
  return null;
}

async function getConfig(videoId) {
  var html = await ytFetch('https://www.youtube.com/watch?v=' + videoId);
  function grab(re) { var m = html.match(re); return m ? m[1] : null; }
  var apiKey      = grab(/"INNERTUBE_API_KEY":"([^"]+)"/) || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  var clientVer   = grab(/"clientVersion":"([\d.]+)"/)    || '2.20240515.01.00';
  var visitorData = grab(/"visitorData":"([^"]+)"/)       || '';
  var continuation = grab(/"continuation":"([^"]+)"/);
  if (!continuation) return null;
  return { apiKey, clientVer, visitorData, continuation };
}

async function fetchMessages() {
  if (!S.continuation) return [];
  var url  = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=' + S.apiKey + '&prettyPrint=false';
  var body = JSON.stringify({
    context: { client: {
      clientName: 'WEB', clientVersion: S.clientVer || '2.20240515.01.00',
      visitorData: S.visitorData || '', hl: 'en', gl: 'US',
    }},
    continuation: S.continuation,
  });
  var data = await ytFetch(url, { body, json: true });

  // Continuation yangilash
  var lcc = data && data.continuationContents && data.continuationContents.liveChatContinuation;
  if (!lcc) return [];
  var next = (lcc.continuations && lcc.continuations[0] &&
    (lcc.continuations[0].invalidationContinuationData && lcc.continuations[0].invalidationContinuationData.continuation) ||
    (lcc.continuations[0].timedContinuationData && lcc.continuations[0].timedContinuationData.continuation));
  if (next) S.continuation = next;

  // Xabarlarni parse qilish
  var out = [];
  var actions = lcc.actions || [];
  for (var i = 0; i < actions.length; i++) {
    var item = actions[i].addChatItemAction && actions[i].addChatItemAction.item;
    if (!item) continue;
    var r;
    if (item.liveChatTextMessageRenderer) {
      r = item.liveChatTextMessageRenderer;
      if (S.seen.has(r.id)) continue;
      S.seen.add(r.id);
      var runs   = (r.message && r.message.runs) || [];
      var text   = runs.map(function(x) { return x.text || ''; }).join('');
      var emojis = runs.filter(function(x) { return !!x.emoji; }).map(function(x) {
        return { emojiId: x.emoji.emojiId || '', emojiUrl: (x.emoji.image && x.emoji.image.thumbnails && x.emoji.image.thumbnails[0] && x.emoji.image.thumbnails[0].url) || '' };
      });
      out.push({ author: (r.authorName && r.authorName.simpleText) || 'Unknown', text, emojis, superChat: false, amount: '' });
    } else if (item.liveChatPaidMessageRenderer) {
      r = item.liveChatPaidMessageRenderer;
      if (S.seen.has(r.id)) continue;
      S.seen.add(r.id);
      var runs2 = (r.message && r.message.runs) || [];
      out.push({ author: (r.authorName && r.authorName.simpleText) || 'Unknown', text: runs2.map(function(x) { return x.text || ''; }).join(''), emojis: [], superChat: true, amount: (r.purchaseAmountText && r.purchaseAmountText.simpleText) || '' });
    }
    if (S.seen.size > 1500) S.seen = new Set(Array.from(S.seen).slice(-600));
  }
  return out;
}

async function pollDirect() {
  if (!S.live || S.method !== 'direct') return;
  try {
    var msgs = await fetchMessages();
    msgs.forEach(function(m) { dispatch(m.author, m.text, m.emojis, m.superChat, m.amount); });
    S.retries = 0;
    S.pollTimer = setTimeout(pollDirect, 3500);
  } catch(e) {
    S.retries++;
    var delay = Math.min(15000 * Math.pow(1.5, Math.min(S.retries - 1, 6)), 120000);
    log('error', '[USUL-2] Poll xato #' + S.retries + ': ' + e.message);
    if (S.retries < CONFIG.maxRetries) {
      S.pollTimer = setTimeout(pollDirect, delay);
    } else {
      stopAll();
    }
  }
}

async function connectViaDirect() {
  log('info', '[USUL-2] To\'g\'ridan-to\'g\'ri API orqali ulanish...');
  try {
    var liveId = await findLiveId();
    if (!liveId) {
      log('warn', '[USUL-2] Live topilmadi -> ' + CONFIG.notLiveDelay/1000 + 's');
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.retryTimer = setTimeout(connect, CONFIG.notLiveDelay);
      return;
    }

    var cfg = await getConfig(liveId);
    if (!cfg) {
      log('warn', '[USUL-2] Continuation topilmadi -> qayta');
      S.retryTimer = setTimeout(connect, CONFIG.retryDelay);
      return;
    }

    S.live        = true;
    S.liveId      = liveId;
    S.method      = 'direct';
    S.continuation = cfg.continuation;
    S.apiKey      = cfg.apiKey;
    S.clientVer   = cfg.clientVer;
    S.visitorData = cfg.visitorData;
    S.retries     = 0;
    S.seen        = new Set();

    log('ok', '[USUL-2] Ulandi! LiveId: ' + liveId);
    io.emit('yt_status', { status: 'CONNECTED', liveId, method: 'direct' });
    pollDirect();

  } catch(e) {
    log('error', '[USUL-2] Xato: ' + e.message);
    S.retryTimer = setTimeout(connect, CONFIG.retryDelay);
  }
}

// ═══════════════════════════════════════════════════════════
//  ASOSIY ULANISH — avval kutubxona, keyin to'g'ridan-to'g'ri
// ═══════════════════════════════════════════════════════════
async function connect() {
  stopAll();
  log('info', 'Ulanish boshlandi...');
  io.emit('yt_status', { status: 'CONNECTING' });

  // Avval USUL-1 ni sinab ko'rish
  var ok = await connectViaLibrary();
  if (ok) return; // Kutubxona ishladi

  // USUL-1 ishlamadi → USUL-2
  log('warn', 'USUL-1 ishlamadi → USUL-2 ga o\'tish');
  await connectViaDirect();
}

// ═══════════════════════════════════════════════════════════
//  HAMMA NARSANI TO'XTATISH
// ═══════════════════════════════════════════════════════════
function stopAll() {
  if (S.chat) {
    try { S.chat.stop(); } catch(_) {}
    S.chat = null;
  }
  clearTimeout(S.retryTimer);
  clearTimeout(S.pollTimer);
  S.live   = false;
  S.liveId = null;
  S.method = null;
  S.continuation = null;
}

// ═══════════════════════════════════════════════════════════
//  CRON — har kuni 20:00 Toshkent
// ═══════════════════════════════════════════════════════════
function setupCron() {
  cron.schedule(CONFIG.startCron, async function() {
    log('ok', 'Jadval: efir boshlash vaqti!');
    stopAll();
    await new Promise(function(r) { setTimeout(r, 5000); });
    await connect();
    clearTimeout(S.endTimer);
    S.endTimer = setTimeout(function() {
      log('warn', CONFIG.durationH + 'h efir tugadi');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopAll();
    }, CONFIG.durationH * 3600 * 1000);
  }, { timezone: 'Asia/Tashkent' });
  log('ok', 'Jadval: "' + CONFIG.startCron + '" (Toshkent)');
}

// ═══════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', function(socket) {
  log('info', 'Client: ' + socket.id);
  socket.emit('yt_status', { status: S.live ? 'CONNECTED' : 'NOT_LIVE', liveId: S.liveId });
  socket.on('disconnect',    function() { log('info', 'Uzildi: ' + socket.id); });
  socket.on('admin_connect', function() { connect(); });
  socket.on('admin_vote',    function(d) { io.emit('vote', { text: (d && d.text) || '🔥', author: 'Admin' }); });
});

// ═══════════════════════════════════════════════════════════
//  XATOLARNI TUTISH
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException',  function(e) { log('error', 'uncaughtException: ' + e.message); });
process.on('unhandledRejection', function(r) { log('error', 'unhandledRejection: ' + String(r)); });
process.on('SIGTERM', function() { stopAll(); server.close(function() { process.exit(0); }); });
process.on('SIGINT',  function() { stopAll(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
//  ISHGA TUSHIRISH
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, function() {
  log('ok', 'Server: http://localhost:' + CONFIG.port);
  log('ok', 'Kanal: ' + CONFIG.channelId);
  setupCron();
  setupKeepAlive();
  connect();
});
