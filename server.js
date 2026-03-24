'use strict';

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cron         = require('node-cron');
const { LiveChat } = require('youtube-chat');

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:       process.env.PORT              || 3000,
  channelId:  process.env.CHANNEL_ID        || 'UCT24pImU78QB7I8a6gofYyA',
  startCron:  process.env.STREAM_START_CRON || '0 20 * * *',
  durationH:  parseFloat(process.env.STREAM_DURATION_HOURS || '10'),

  // Qayta ulanish sozlamalari
  retryDelay:    15000,   // xato bo'lsa 15s kutish
  notLiveDelay:  30000,   // live bo'lmasa 30s kutish
  maxRetries:    9999,
};

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
let S = {
  live:        false,
  liveId:      null,
  chat:        null,       // LiveChat instance
  retries:     0,
  retryTimer:  null,
  endTimer:    null,
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
  ok:      true,
  live:    S.live,
  liveId:  S.liveId,
  retries: S.retries,
  uptime:  Math.floor(process.uptime()),
  time:    new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════
function log(lvl, msg) {
  const t = new Date().toISOString().slice(11, 19);
  const p = { info: '📘', warn: '⚠️ ', error: '🔴', ok: '✅' }[lvl] || '  ';
  console.log(`[${t}] ${p} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
//  CHAT XABARLARINI QAYTA ISHLASH
// ═══════════════════════════════════════════════════════════
function handleMessage(msg) {
  try {
    const author = msg.author?.name || 'Unknown';

    // Barcha matn qismlarini yig'amiz
    const text = (msg.message || [])
      .filter(m => m.text)
      .map(m => m.text)
      .join('');

    // Barcha emoji qismlarini yig'amiz
    const emojis = (msg.message || []).filter(m => m.emojiId);

    // ── Super Chat ─────────────────────────────────────
    if (msg.superchat) {
      const amount = msg.superchat.amount || '';
      log('ok', `💰 SUPERCHAT ${author}: ${amount}`);
      io.emit('vote', {
        author, text: text || '💰',
        superChat: true, amount,
      });
      io.emit('superchat', { author, amount, text });
      return;
    }

    // ── Custom emoji / sticker ─────────────────────────
    if (emojis.length > 0) {
      emojis.forEach(e => {
        const url = e.thumbnails?.[0]?.url || '';
        log('ok', `🎨 ${author} → ${e.emojiId}`);
        io.emit('vote', {
          author,
          emojiId:  e.emojiId,
          emojiUrl: url,
          text,
        });
      });
      return;
    }

    // ── Oddiy matn ─────────────────────────────────────
    if (text.trim()) {
      log('info', `💬 ${author}: ${text.slice(0, 50)}`);
      io.emit('vote', { author, text });
    }

  } catch (e) {
    log('error', `handleMessage: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  CHAT TO'XTATISH
// ═══════════════════════════════════════════════════════════
function stopChat() {
  if (S.chat) {
    try { S.chat.stop(); } catch (_) {}
    S.chat = null;
  }
  clearTimeout(S.retryTimer);
  S.live   = false;
  S.liveId = null;
  io.emit('yt_status', { status: 'NOT_LIVE' });
  log('warn', "Chat to'xtatildi");
}

// ═══════════════════════════════════════════════════════════
//  YOUTUBE GA ULANISH — asosiy funksiya
// ═══════════════════════════════════════════════════════════
async function connect() {
  // Avvalgi chat ni tozalash
  if (S.chat) {
    try { S.chat.stop(); } catch (_) {}
    S.chat = null;
  }
  clearTimeout(S.retryTimer);

  log('info', 'YouTube ga ulanish...');
  io.emit('yt_status', { status: 'CONNECTING' });

  try {
    // ── 1. Kanal ID orqali jonli efir ID ni topish ──
    log('info', `Kanal tekshirilmoqda: ${CONFIG.channelId}`);
    const probe  = new LiveChat({ channelId: CONFIG.channelId });
    const liveId = await probe.getLiveId();

    if (!liveId) {
      log('warn', "Jonli efir topilmadi → 30s keyin qayta tekshiriladi");
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.retryTimer = setTimeout(connect, CONFIG.notLiveDelay);
      return;
    }

    // Bir xil efirga ikki marta ulanmaslik
    if (liveId === S.liveId && S.live) {
      log('info', `Allaqachon ulangan: ${liveId}`);
      return;
    }

    log('ok', `Jonli efir topildi: ${liveId}`);

    // ── 2. Chat instanceni yaratish ──
    S.liveId = liveId;
    S.chat   = new LiveChat({ liveId });

    // ── 3. Eventlarni ulash ──

    S.chat.on('chat', handleMessage);

    S.chat.on('error', (err) => {
      const msg = err?.message || String(err);
      log('error', `Chat xato: ${msg}`);

      S.live = false;
      S.retries++;

      if (S.retries <= CONFIG.maxRetries) {
        // Xato turига qarab kutish vaqtini hisoblash
        const delay = Math.min(
          CONFIG.retryDelay * Math.pow(1.4, Math.min(S.retries - 1, 6)),
          120000
        );
        log('warn', `Qayta ulanish #${S.retries} → ${Math.round(delay/1000)}s keyin`);
        S.retryTimer = setTimeout(connect, delay);
      } else {
        stopChat();
      }
    });

    S.chat.on('end', () => {
      log('warn', 'Efir tugadi (end event)');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopChat();
      // Efir tugagandan keyin ham 60s da tekshirib turamiz
      // (baʼzan kanal yangi efir ochishi mumkin)
      S.retryTimer = setTimeout(connect, 60000);
    });

    // ── 4. Chatni boshlash ──
    const ok = await S.chat.start();

    if (ok) {
      S.live    = true;
      S.retries = 0;
      log('ok', `✅ Muvaffaqiyatli ulandi! LiveId: ${liveId}`);
      io.emit('yt_status', { status: 'CONNECTED', liveId });
    } else {
      log('error', 'chat.start() false qaytardi → qayta urinish');
      S.retryTimer = setTimeout(connect, CONFIG.retryDelay);
    }

  } catch (e) {
    log('error', `connect xato: ${e.message}`);
    io.emit('yt_status', { status: 'ERROR' });
    S.retryTimer = setTimeout(connect, CONFIG.retryDelay);
  }
}

// ═══════════════════════════════════════════════════════════
//  CRON — har kuni 20:00 Toshkent
// ═══════════════════════════════════════════════════════════
function setupCron() {
  cron.schedule(CONFIG.startCron, async () => {
    log('ok', '⏰ Jadval: efir boshlash vaqti!');
    stopChat();

    // Yangi efir boshlashdan oldin 5s kutish
    await new Promise(r => setTimeout(r, 5000));
    await connect();

    // 10 soatdan keyin avtomatik to'xtatish
    clearTimeout(S.endTimer);
    S.endTimer = setTimeout(() => {
      log('warn', `⏰ ${CONFIG.durationH} soatlik efir vaqti tugadi`);
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      stopChat();
    }, CONFIG.durationH * 3600 * 1000);

  }, { timezone: 'Asia/Tashkent' });

  log('ok', `📅 Jadval: "${CONFIG.startCron}" (Toshkent vaqti)`);
}

// ═══════════════════════════════════════════════════════════
//  SOCKET.IO EVENTLAR
// ═══════════════════════════════════════════════════════════
io.on('connection', socket => {
  log('info', `👤 Client ulandi: ${socket.id}`);

  // Yangi client ga hozirgi holatni yuborish
  socket.emit('yt_status', {
    status: S.live ? 'CONNECTED' : 'NOT_LIVE',
    liveId: S.liveId,
  });

  socket.on('disconnect', () => {
    log('info', `👤 Client uzildi: ${socket.id}`);
  });

  // Admin: qo'lda ulanish (test uchun)
  socket.on('admin_connect', () => {
    log('info', 'Admin: qoʻlda ulanish buyrug\'i');
    connect();
  });

  // Admin: test vote
  socket.on('admin_vote', data => {
    io.emit('vote', { text: data?.text || '🔥', author: 'Admin' });
  });
});

// ═══════════════════════════════════════════════════════════
//  XATOLARNI TUTISH
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException',  e => log('error', `uncaughtException: ${e.message}`));
process.on('unhandledRejection', r => log('error', `unhandledRejection: ${r}`));
process.on('SIGTERM', async () => { stopChat(); server.close(() => process.exit(0)); });
process.on('SIGINT',  async () => { stopChat(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
//  RENDER KEEP-ALIVE — har 10 daqiqada o'zini ping qiladi
//  Bu Render free tier ning "spin down" muammosini hal qiladi
// ═══════════════════════════════════════════════════════════
function setupKeepAlive() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
  if (!RENDER_URL) {
    log('info', 'RENDER_EXTERNAL_URL topilmadi — keep-alive o\'tkazib yuborildi');
    return;
  }

  const url = RENDER_URL.replace(/\/$/, '') + '/health';
  log('ok', `💓 Keep-alive yoqildi: ${url} (har 10 daqiqada)`);

  setInterval(() => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, (res) => {
      log('info', `💓 Ping: ${res.statusCode}`);
    });
    req.on('error', (e) => {
      log('warn', `💓 Ping xato: ${e.message}`);
    });
    req.setTimeout(10000, () => req.destroy());
  }, 10 * 60 * 1000); // 10 daqiqa
}

// ═══════════════════════════════════════════════════════════
//  ISHGA TUSHIRISH
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, () => {
  log('ok', `🚀 Server: http://localhost:${CONFIG.port}`);
  log('ok', `📺 Kanal ID: ${CONFIG.channelId}`);
  log('ok', `📅 Jadval: ${CONFIG.startCron} (${CONFIG.durationH}h)`);
  setupCron();
  setupKeepAlive();
  // Birinchi ulanish
  connect();
});
