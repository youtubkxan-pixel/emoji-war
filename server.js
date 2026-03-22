'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cron       = require('node-cron');
const https      = require('https');
const zlib       = require('zlib');

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:        process.env.PORT              || 3000,
  channelId:   process.env.CHANNEL_ID        || 'UCT24pImU78QB7I8a6gofYyA',
  cookies:     process.env.YT_COOKIES        || '',
  startCron:   process.env.STREAM_START_CRON || '0 20 * * *',
  durationH:   parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  pollMs:      3500,
  retryMs:     8000,
  maxRetry:    9999,
};

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
let S = {
  live:         false,
  videoId:      null,
  continuation: null,
  apiKey:       null,
  clientVer:    null,
  visitorData:  null,
  pollTimer:    null,
  endTimer:     null,
  retries:      0,
  seen:         new Set(),
};

// ═══════════════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
});

app.use(express.static(__dirname));
app.get('/health', (_q, res) => res.json({
  ok: true, live: S.live, videoId: S.videoId,
  retries: S.retries, uptime: Math.floor(process.uptime()),
  time: new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════
const ICONS = { info:'📘', warn:'⚠️ ', error:'🔴', ok:'✅' };
function log(lvl, msg) {
  console.log(`[${new Date().toISOString().slice(11,19)}] ${ICONS[lvl]||'  '} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
//  HTTP — real Chrome browser kabi so'rov
// ═══════════════════════════════════════════════════════════
function ytFetch(url, opt) {
  opt = opt || {};
  return new Promise(function(ok, fail) {
    var u = new URL(url);
    var headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          opt.json ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection':      'keep-alive',
      'Origin':          'https://www.youtube.com',
      'Referer':         'https://www.youtube.com/',
      'Sec-Fetch-Dest':  opt.json ? 'empty'       : 'document',
      'Sec-Fetch-Mode':  opt.json ? 'same-origin' : 'navigate',
      'Sec-Fetch-Site':  opt.json ? 'same-origin' : 'none',
    };
    if (CONFIG.cookies) headers['Cookie'] = CONFIG.cookies;
    if (opt.headers) Object.assign(headers, opt.headers);
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
          catch(e) { fail(new Error('JSON parse: ' + txt.slice(0,120))); }
        } else {
          ok(txt);
        }
      });
      stream.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(18000, function() { req.destroy(new Error('Timeout')); });
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  STEP 1 — Kanaldan live video ID topish
//  NOTE: live tekshiruvi YO'Q — extractConfig continuation
//        orqali live ekanligini o'zi tekshiradi
// ═══════════════════════════════════════════════════════════
async function findVideoId() {
  try {
    var html = await ytFetch('https://www.youtube.com/channel/' + CONFIG.channelId + '/live');

    // Pattern 1: canonicalUrl
    var m = html.match(/"canonicalUrl":"[^"]*v=([a-zA-Z0-9_-]{11})"/);
    if (m) { log('info', 'Video ID (canonical): ' + m[1]); return m[1]; }

    // Pattern 2: og:url content
    m = html.match(/content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
    if (m) { log('info', 'Video ID (og): ' + m[1]); return m[1]; }

    // Pattern 3: watch?v=
    m = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (m) { log('info', 'Video ID (watch): ' + m[1]); return m[1]; }

    // Pattern 4: "videoId":"..."
    m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (m) { log('info', 'Video ID (data): ' + m[1]); return m[1]; }

    log('warn', 'Video ID topilmadi');
    return null;
  } catch(e) {
    log('error', 'findVideoId: ' + e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  STEP 2 — Video sahifasidan chat config olish
// ═══════════════════════════════════════════════════════════
async function extractConfig(videoId) {
  try {
    var html = await ytFetch('https://www.youtube.com/watch?v=' + videoId);

    // Live ekanligini tekshirish — continuation faqat live da bo'ladi
    var isLive = html.includes('"isLive":true')
              || html.includes('"liveBroadcastContent":"live"')
              || html.includes('isLiveNow')
              || html.includes('"hlsManifestUrl"');

    if (!isLive) {
      log('warn', 'Video ' + videoId + ' hozir live emas');
      return null;
    }

    function grab(re) {
      var m = html.match(re);
      return m ? m[1] : null;
    }

    var apiKey = grab(/"INNERTUBE_API_KEY":"([^"]+)"/)
              || grab(/"innertubeApiKey":"([^"]+)"/)
              || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    var clientVer = grab(/"clientVersion":"([\d.]+)"/) || '2.20240515.01.00';
    var visitorData = grab(/"visitorData":"([^"]+)"/) || '';

    // Continuation token — live chat uchun eng muhim kalit
    var continuation = grab(/"continuation":"([^"]+)"/)
                    || grab(/"token":"([^"]+)".*?liveChatRenderer/);

    if (!continuation) {
      log('warn', videoId + ' uchun continuation topilmadi (live chat yopiqmi?)');
      return null;
    }

    return { apiKey: apiKey, clientVer: clientVer, visitorData: visitorData, continuation: continuation };
  } catch(e) {
    log('error', 'extractConfig: ' + e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  STEP 3 — Chat xabarlarini olish (YouTube ichki API)
// ═══════════════════════════════════════════════════════════
async function fetchChat() {
  if (!S.continuation || !S.apiKey) return null;

  var url  = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=' + S.apiKey + '&prettyPrint=false';
  var body = JSON.stringify({
    context: {
      client: {
        clientName:    'WEB',
        clientVersion: S.clientVer || '2.20240515.01.00',
        visitorData:   S.visitorData || '',
        hl: 'en', gl: 'US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36,gzip(gfe)',
        browserName:    'Chrome',
        browserVersion: '124.0.0.0',
        osName:         'Windows',
        osVersion:      '10.0',
      },
    },
    continuation: S.continuation,
  });

  return ytFetch(url, {
    body: body,
    json: true,
    headers: {
      'X-YouTube-Client-Name':    '1',
      'X-YouTube-Client-Version': S.clientVer || '2.20240515.01.00',
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  STEP 4 — Xabarlarni parse qilish
// ═══════════════════════════════════════════════════════════
function parseChat(data) {
  try {
    var lcc = data && data.continuationContents && data.continuationContents.liveChatContinuation;
    if (!lcc) return [];

    // Continuation yangilash
    var contData = lcc.continuations && lcc.continuations[0];
    if (contData) {
      var next = (contData.invalidationContinuationData && contData.invalidationContinuationData.continuation)
              || (contData.timedContinuationData && contData.timedContinuationData.continuation)
              || (contData.liveChatReplayContinuationData && contData.liveChatReplayContinuationData.continuation);
      if (next) S.continuation = next;
    }

    var out = [];
    var actions = lcc.actions || [];

    for (var i = 0; i < actions.length; i++) {
      var item = actions[i].addChatItemAction && actions[i].addChatItemAction.item;
      if (!item) continue;

      // TEXT MESSAGE
      if (item.liveChatTextMessageRenderer) {
        var r = item.liveChatTextMessageRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        var author = (r.authorName && r.authorName.simpleText) || 'Unknown';
        var runs   = (r.message && r.message.runs) || [];
        var text   = runs.map(function(x) { return x.text || ''; }).join('');
        var emojis = runs.filter(function(x) { return !!x.emoji; }).map(function(x) {
          return {
            emojiId:  (x.emoji.emojiId) || (x.emoji.shortcuts && x.emoji.shortcuts[0]) || '',
            emojiUrl: (x.emoji.image && x.emoji.image.thumbnails && x.emoji.image.thumbnails[0] && x.emoji.image.thumbnails[0].url) || '',
          };
        });
        out.push({ type:'text', author:author, text:text, emojis:emojis });
      }

      // SUPER CHAT
      else if (item.liveChatPaidMessageRenderer) {
        var r = item.liveChatPaidMessageRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        var runs = (r.message && r.message.runs) || [];
        out.push({
          type:   'superchat',
          author: (r.authorName && r.authorName.simpleText) || 'Unknown',
          text:   runs.map(function(x) { return x.text || ''; }).join(''),
          amount: (r.purchaseAmountText && r.purchaseAmountText.simpleText) || '',
        });
      }

      // SUPER STICKER
      else if (item.liveChatPaidStickerRenderer) {
        var r = item.liveChatPaidStickerRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        out.push({
          type:       'sticker',
          author:     (r.authorName && r.authorName.simpleText) || 'Unknown',
          amount:     (r.purchaseAmountText && r.purchaseAmountText.simpleText) || '',
          stickerUrl: (r.sticker && r.sticker.thumbnails && r.sticker.thumbnails[0] && r.sticker.thumbnails[0].url) || '',
        });
      }

      // MEMBER
      else if (item.liveChatMembershipItemRenderer) {
        var r = item.liveChatMembershipItemRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        out.push({ type:'member', author: (r.authorName && r.authorName.simpleText) || 'Unknown' });
      }
    }

    // seen hajmini cheklash
    if (S.seen.size > 1500) {
      var arr = Array.from(S.seen);
      S.seen = new Set(arr.slice(-600));
    }

    return out;
  } catch(e) {
    log('error', 'parseChat: ' + e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
//  DISPATCH — Socket ga yuborish
// ═══════════════════════════════════════════════════════════
function dispatch(messages) {
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.type === 'text') {
      if (m.emojis.length > 0) {
        m.emojis.forEach(function(e) {
          log('ok', '🎨 ' + m.author + ' → ' + e.emojiId);
          io.emit('vote', { author: m.author, text: m.text, emojiId: e.emojiId, emojiUrl: e.emojiUrl });
        });
      } else if (m.text.trim()) {
        log('info', '💬 ' + m.author + ': ' + m.text.slice(0,45));
        io.emit('vote', { author: m.author, text: m.text });
      }
    } else if (m.type === 'superchat') {
      log('ok', '💰 SUPERCHAT ' + m.author + ': ' + m.amount);
      io.emit('vote',      { author: m.author, text: m.text || '💰', superChat: true, amount: m.amount });
      io.emit('superchat', { author: m.author, text: m.text, amount: m.amount });
    } else if (m.type === 'sticker') {
      log('ok', '🎨 STICKER ' + m.author + ': ' + m.amount);
      io.emit('vote',      { author: m.author, text: '⭐', superSticker: true, amount: m.amount, stickerUrl: m.stickerUrl });
      io.emit('superchat', { author: m.author, amount: m.amount });
    } else if (m.type === 'member') {
      log('ok', '🌟 MEMBER: ' + m.author);
      io.emit('member', { author: m.author });
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  POLL LOOP
// ═══════════════════════════════════════════════════════════
async function pollLoop() {
  if (!S.live) return;
  try {
    var data = await fetchChat();
    if (!data) throw new Error('empty response');

    if (data.error && (data.error.code === 403 || data.error.code === 404)) {
      log('warn', 'Stream ended (' + data.error.code + ')');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLive();
      return;
    }

    var msgs = parseChat(data);
    if (msgs.length) dispatch(msgs);
    S.retries = 0;

    var recommended = data.continuationContents
      && data.continuationContents.liveChatContinuation
      && data.continuationContents.liveChatContinuation.continuations
      && data.continuationContents.liveChatContinuation.continuations[0]
      && data.continuationContents.liveChatContinuation.continuations[0].timedContinuationData
      && data.continuationContents.liveChatContinuation.continuations[0].timedContinuationData.timeoutMs;

    var delay = recommended ? Math.max(1200, Math.min(recommended, 7000)) : CONFIG.pollMs;
    S.pollTimer = setTimeout(pollLoop, delay);

  } catch(e) {
    S.retries++;
    var backoff = Math.min(CONFIG.retryMs * Math.pow(1.5, Math.min(S.retries - 1, 8)), 120000);
    log('error', 'pollLoop #' + S.retries + ': ' + e.message + ' → ' + Math.round(backoff/1000) + 's');
    if (S.retries < CONFIG.maxRetry) {
      S.pollTimer = setTimeout(pollLoop, backoff);
    } else {
      await stopLive();
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  CONNECT
// ═══════════════════════════════════════════════════════════
async function connect() {
  clearTimeout(S.pollTimer);
  S.live = false;

  log('info', 'YouTube ga ulanish...');
  io.emit('yt_status', { status: 'CONNECTING' });

  try {
    var videoId = await findVideoId();
    if (!videoId) {
      log('warn', 'Video ID topilmadi → 30s keyin qayta');
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, 30000);
      return;
    }

    var cfg = await extractConfig(videoId);
    if (!cfg) {
      log('warn', videoId + ' chat config yoq → 30s keyin qayta');
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, 30000);
      return;
    }

    S.live        = true;
    S.videoId     = videoId;
    S.continuation = cfg.continuation;
    S.apiKey      = cfg.apiKey;
    S.clientVer   = cfg.clientVer;
    S.visitorData = cfg.visitorData;
    S.retries     = 0;
    S.seen        = new Set();

    log('ok', 'Ulandi! Video: ' + videoId);
    io.emit('yt_status', { status: 'CONNECTED', videoId: videoId });

    pollLoop();

  } catch(e) {
    log('error', 'connect: ' + e.message);
    io.emit('yt_status', { status: 'ERROR' });
    S.pollTimer = setTimeout(connect, CONFIG.retryMs);
  }
}

// ═══════════════════════════════════════════════════════════
//  STOP
// ═══════════════════════════════════════════════════════════
async function stopLive() {
  clearTimeout(S.pollTimer);
  S.live = false; S.videoId = null; S.continuation = null;
  io.emit('yt_status', { status: 'NOT_LIVE' });
  log('warn', "Live to'xtatildi");
}

// ═══════════════════════════════════════════════════════════
//  CRON — har kuni 20:00 Toshkent
// ═══════════════════════════════════════════════════════════
function setupCron() {
  cron.schedule(CONFIG.startCron, async function() {
    log('ok', '⏰ Jadval: stream boshlash vaqti!');
    await stopLive();
    await connect();
    clearTimeout(S.endTimer);
    S.endTimer = setTimeout(async function() {
      log('warn', CONFIG.durationH + ' soatlik efir tugadi');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLive();
    }, CONFIG.durationH * 3600 * 1000);
  }, { timezone: 'Asia/Tashkent' });

  log('ok', 'Jadval: "' + CONFIG.startCron + '" (Toshkent)');
}

// ═══════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', function(socket) {
  log('info', '👤 Client: ' + socket.id);
  socket.emit('yt_status', { status: S.live ? 'CONNECTED' : 'NOT_LIVE', videoId: S.videoId });

  socket.on('disconnect',    function() { log('info', '👤 Uzildi: ' + socket.id); });
  socket.on('admin_connect', function() { connect(); });
  socket.on('admin_vote',    function(d) { io.emit('vote', { text: (d && d.text) || '🔥', author: 'Admin' }); });
});

// ═══════════════════════════════════════════════════════════
//  PROCESS
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException',  function(e) { log('error', 'uncaughtException: ' + e.message); });
process.on('unhandledRejection', function(r) { log('error', 'unhandledRejection: ' + String(r)); });
process.on('SIGTERM', async function() { await stopLive(); server.close(function() { process.exit(0); }); });
process.on('SIGINT',  async function() { await stopLive(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, function() {
  log('ok', '🚀 Server: http://localhost:' + CONFIG.port);
  log('ok', '📺 Kanal:  ' + CONFIG.channelId);
  log('ok', '🍪 Cookies: ' + (CONFIG.cookies ? 'bor ✅' : "yo'q (ixtiyoriy)"));
  setupCron();
  connect();
});
