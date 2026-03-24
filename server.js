'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const cron       = require('node-cron');

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:      process.env.PORT              || 10000,
  channelId: process.env.CHANNEL_ID        || 'UCT24pImU78QB7I8a6gofYyA',
  apiKey:    process.env.YOUTUBE_API_KEY   || '',
  // VIDEO_ID faqat 11 belgili bo'lsa ishlatiladi, aks holda avtomatik topadi
  videoId:   (process.env.VIDEO_ID || '').trim().length >= 8
               ? (process.env.VIDEO_ID || '').trim()
               : '',
  startCron:  process.env.STREAM_START_CRON || '0 20 * * *',
  durationH:  parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  pollMs:     5000,
  retryMs:    15000,
};

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
let S = {
  live:       false,
  videoId:    null,
  liveChatId: null,
  nextPage:   null,
  pollTimer:  null,
  endTimer:   null,
  retries:    0,
  seen:       new Set(),
  connecting: false,   // ikkinchi connect() chaqiruvini bloklash uchun
};

// ═══════════════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:       { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(express.static(__dirname));

app.get('/health', (_q, res) => res.json({
  ok:         true,
  live:       S.live,
  videoId:    S.videoId,
  liveChatId: S.liveChatId ? S.liveChatId.slice(0, 30) + '...' : null,
  retries:    S.retries,
  uptime:     Math.floor(process.uptime()),
  pollDelay:  CONFIG.pollMs,
}));

// Manual qayta ulanish endpointi
app.post('/reinit', async (_q, res) => {
  log('warn', 'Manual reinit...');
  stopLive();
  await connect();
  res.json({ ok: true, live: S.live });
});

// ═══════════════════════════════════════════════════════════
//  KEEP-ALIVE (Render free tier uchun)
// ═══════════════════════════════════════════════════════════
function setupKeepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL || '';
  if (!base) { log('warn', 'RENDER_EXTERNAL_URL yoq, keep-alive ishlamaydi'); return; }
  const url = base.replace(/\/$/, '') + '/health';
  log('ok', 'Keep-alive: ' + url);
  setInterval(function () {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, function (res) {
      log('info', 'Ping OK: ' + res.statusCode);
    });
    req.on('error', function (e) { log('warn', 'Ping xato: ' + e.message); });
    req.setTimeout(10000, function () { req.destroy(); });
  }, 8 * 60 * 1000); // har 8 daqiqada (Render 15 daq limit)
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
//  YouTube Data API v3
// ═══════════════════════════════════════════════════════════
function ytAPI(path) {
  return new Promise(function (resolve, reject) {
    const url = 'https://www.googleapis.com/youtube/v3/' + path;
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json' },
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) {
            reject(new Error(
              data.error.message +
              ' (code: ' + data.error.code + ')' +
              ' reason: ' + (data.error.errors?.[0]?.reason || '')
            ));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error('JSON parse xato: ' + e.message));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('Timeout 15s')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  1. Video ID topish
// ═══════════════════════════════════════════════════════════
async function findVideoId() {
  // Qo'lda berilgan VIDEO_ID (kamida 8 belgi)
  if (CONFIG.videoId) {
    log('ok', 'Video ID (qolda): ' + CONFIG.videoId);
    return CONFIG.videoId;
  }

  // Kanal orqali live qidirish
  log('info', 'YouTube ga ulanish...');
  const data = await ytAPI(
    'search?part=id' +
    '&channelId=' + CONFIG.channelId +
    '&eventType=live&type=video&maxResults=1' +
    '&key=' + CONFIG.apiKey
  );

  if (!data.items || data.items.length === 0) {
    log('warn', 'Jonli efir topilmadi');
    return null;
  }

  const videoId = data.items[0].id.videoId;
  log('ok', 'Video ID (qolda): ' + videoId);
  return videoId;
}

// ═══════════════════════════════════════════════════════════
//  2. liveChatId olish
// ═══════════════════════════════════════════════════════════
async function getLiveChatId(videoId) {
  log('info', 'liveChatId olinmoqda...');
  const data = await ytAPI(
    'videos?part=liveStreamingDetails' +
    '&id=' + videoId +
    '&key=' + CONFIG.apiKey
  );

  if (!data.items || data.items.length === 0) {
    log('error', 'Video topilmadi: ' + videoId);
    return null;
  }

  const details = data.items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) {
    log('warn', 'activeLiveChatId yoq — efir boshlanmagan yoki tugagan');
    log('info', 'liveStreamingDetails: ' + JSON.stringify(details));
    return null;
  }

  log('ok', 'jonli suhbatId: ' + details.activeLiveChatId);
  return details.activeLiveChatId;
}

// ═══════════════════════════════════════════════════════════
//  3. Chat xabarlarini olish
// ═══════════════════════════════════════════════════════════
async function fetchChat() {
  if (!S.liveChatId || !S.live) return;

  let path = 'liveChat/messages?part=id,snippet,authorDetails' +
             '&liveChatId=' + S.liveChatId +
             '&maxResults=200' +
             '&key=' + CONFIG.apiKey;

  if (S.nextPage) path += '&pageToken=' + S.nextPage;

  const data = await ytAPI(path);

  S.nextPage = data.nextPageToken || null;

  // YouTube tavsiya qilgan interval
  const recommended = data.pollingIntervalMillis || CONFIG.pollMs;
  const delay = Math.max(3000, Math.min(recommended, 10000));

  const items = data.items || [];
  let newCount = 0;

  for (const item of items) {
    const id = item.id;
    if (S.seen.has(id)) continue;
    S.seen.add(id);
    newCount++;

    const type   = item.snippet?.type || '';
    const author = item.authorDetails?.displayName || 'Unknown';

    if (type === 'textMessageEvent') {
      const text = item.snippet?.displayMessage || '';
      io.emit('vote', { author, text });

    } else if (type === 'superChatEvent') {
      const sc     = item.snippet?.superChatDetails;
      const amount = sc?.amountDisplayString || '';
      const text   = sc?.userComment || '';
      log('ok', 'SUPERCHAT ' + author + ': ' + amount);
      io.emit('vote',      { author, text: text || '💰', superChat: true, amount });
      io.emit('superchat', { author, amount, text });

    } else if (type === 'superStickerEvent') {
      const ss     = item.snippet?.superStickerDetails;
      const amount = ss?.amountDisplayString || '';
      log('ok', 'STICKER ' + author + ': ' + amount);
      io.emit('vote', { author, text: '⭐', superSticker: true, amount });

    } else if (type === 'newSponsorEvent') {
      log('ok', 'MEMBER: ' + author);
      io.emit('member', { author });
    }
  }

  if (newCount > 0) {
    log('info', newCount + ' yangi xabar | keyingi: ' + delay + 'ms');
  }

  // seen hajmini cheklash
  if (S.seen.size > 3000) {
    S.seen = new Set(Array.from(S.seen).slice(-1000));
  }

  S.pollTimer = setTimeout(pollLoop, delay);
}

// ═══════════════════════════════════════════════════════════
//  POLL LOOP
// ═══════════════════════════════════════════════════════════
async function pollLoop() {
  if (!S.live) return;
  try {
    await fetchChat();
    S.retries = 0;
  } catch (e) {
    S.retries++;
    const msg = e.message || String(e);
    log('error', 'pollLoop #' + S.retries + ': ' + msg);

    // Chat tugagan yoki ruxsat yo'q
    if (
      msg.includes('liveChatEnded') ||
      msg.includes('404') ||
      msg.includes('The live chat')
    ) {
      log('warn', 'Live tugadi yoki chat yopildi');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopLive();
      S.pollTimer = setTimeout(connect, 60000);
      return;
    }

    // 403 — API key muammosi
    if (msg.includes('403')) {
      log('error', 'API key xatosi (403): ' + msg);
      io.emit('yt_status', { status: 'API_ERROR', message: msg });
      stopLive();
      return; // Qayta urinmaymiz — key noto'g'ri
    }

    // Boshqa xatolarda exponential backoff
    const delay = Math.min(CONFIG.retryMs * Math.pow(1.4, Math.min(S.retries - 1, 6)), 120000);
    log('warn', 'Qayta urinish: ' + Math.round(delay / 1000) + 's');
    S.pollTimer = setTimeout(pollLoop, delay);
  }
}

// ═══════════════════════════════════════════════════════════
//  ULANISH — guard bilan (ikki marta chaqirilmasin)
// ═══════════════════════════════════════════════════════════
async function connect() {
  if (S.connecting) { log('warn', 'Allaqachon ulanish jarayonida...'); return; }
  S.connecting = true;
  clearTimeout(S.pollTimer);
  S.live = false;

  if (!CONFIG.apiKey) {
    log('error', 'YOUTUBE_API_KEY yoq! Render Environment Variables ga qoshing.');
    io.emit('yt_status', { status: 'NO_API_KEY' });
    S.connecting = false;
    return;
  }

  log('info', 'YouTube ga ulanish...');
  io.emit('yt_status', { status: 'CONNECTING' });

  try {
    // 1. Video ID
    const videoId = await findVideoId();
    if (!videoId) {
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, CONFIG.retryMs * 2);
      S.connecting = false;
      return;
    }

    // 2. liveChatId
    const liveChatId = await getLiveChatId(videoId);
    if (!liveChatId) {
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, CONFIG.retryMs * 2);
      S.connecting = false;
      return;
    }

    // 3. State yangilash
    S.live       = true;
    S.videoId    = videoId;
    S.liveChatId = liveChatId;
    S.nextPage   = null;
    S.retries    = 0;
    S.seen       = new Set();

    log('ok', 'Ulandi! Video: ' + videoId);
    io.emit('yt_status', { status: 'CONNECTED', videoId });

    // 4. Polling
    pollLoop();

  } catch (e) {
    log('error', 'connect: ' + e.message);
    io.emit('yt_status', { status: 'ERROR', message: e.message });
    S.pollTimer = setTimeout(connect, CONFIG.retryMs);
  } finally {
    S.connecting = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  TO'XTATISH
// ═══════════════════════════════════════════════════════════
function stopLive() {
  clearTimeout(S.pollTimer);
  clearTimeout(S.endTimer);
  S.live       = false;
  S.liveChatId = null;
  S.videoId    = null;
  S.nextPage   = null;
  S.connecting = false;
  io.emit('yt_status', { status: 'NOT_LIVE' });
  log('warn', 'Toxtatildi');
}

// ═══════════════════════════════════════════════════════════
//  CRON — avtomatik boshlash vaqti
// ═══════════════════════════════════════════════════════════
function setupCron() {
  cron.schedule(CONFIG.startCron, async function () {
    log('ok', 'Jadval: efir vaqti!');
    stopLive();
    await connect();
    S.endTimer = setTimeout(function () {
      log('warn', CONFIG.durationH + 'h efir tugadi');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopLive();
    }, CONFIG.durationH * 3600 * 1000);
  }, { timezone: 'Asia/Tashkent' });

  log('ok', 'Jadval: ' + CONFIG.startCron + ' (Toshkent)');
}

// ═══════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', function (socket) {
  log('info', 'Client: ' + socket.id);

  // Joriy holat yangi clientga
  socket.emit('yt_status', {
    status:  S.live ? 'CONNECTED' : 'NOT_LIVE',
    videoId: S.videoId,
  });

  socket.on('disconnect',    function () { log('info', 'Uzildi: ' + socket.id); });
  socket.on('admin_connect', function () { connect(); });
  socket.on('admin_stop',    function () { stopLive(); });
  socket.on('admin_vote',    function (d) {
    io.emit('vote', { text: (d && d.text) || 'Test', author: 'Admin' });
  });
});

// ═══════════════════════════════════════════════════════════
//  XATOLARNI TUTISH
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException',  function (e) { log('error', 'uncaughtException: ' + e.message); });
process.on('unhandledRejection', function (r) { log('error', 'unhandledRejection: ' + String(r)); });
process.on('SIGTERM', function () { stopLive(); server.close(function () { process.exit(0); }); });
process.on('SIGINT',  function () { stopLive(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, function () {
  log('ok', 'Server: http://localhost:' + CONFIG.port);
  log('ok', 'Kanal: ' + CONFIG.channelId);
  log('ok', 'API kaliti: ' + (CONFIG.apiKey ? 'bor ✅' : 'YOQ ❌'));
  log('ok', 'Video ID: ' + (CONFIG.videoId || 'avtomatik qidiriladi'));
  log('ok', 'Tirik qoling: https://emoji-war.onrender.com/health');
  setupCron();
  setupKeepAlive();
  connect();
});
