/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          EMOJI WAR — YouTube Live Bot Server             ║
 * ║          server.js — Production Ready                    ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * O'rnatish:
 *   npm install express socket.io googleapis node-cron dotenv axios
 *
 * Ishga tushirish:
 *   node server.js
 *
 * .env fayli kerak (bir marta sozlash):
 *   YOUTUBE_CLIENT_ID=...
 *   YOUTUBE_CLIENT_SECRET=...
 *   YOUTUBE_REFRESH_TOKEN=...
 *   CHANNEL_ID=UCxxxxxxxxxxxxxxxxxx
 *   PORT=3000
 *   STREAM_START_CRON=0 20 * * *   (har kuni 20:00)
 *   STREAM_DURATION_HOURS=10
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// DEPENDENCIES
// ═══════════════════════════════════════════════════════════
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

// ═══════════════════════════════════════════════════════════
// CONFIG — .env dan o'qiladi
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:              process.env.PORT                  || 3000,
  clientId:          process.env.YOUTUBE_CLIENT_ID     || '',
  clientSecret:      process.env.YOUTUBE_CLIENT_SECRET || '',
  refreshToken:      process.env.YOUTUBE_REFRESH_TOKEN || '',
  channelId:         process.env.CHANNEL_ID            || '',
  streamStartCron:   process.env.STREAM_START_CRON     || '0 20 * * *',
  streamDurationH:   parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  pollIntervalMs:    1000,   // 1000ms = kuniga ~57,600 so'rov × 5 quota = 288,000
                           // YouTube kunlik limit: 10,000,000 quota — xavfsiz ✅
  reconnectDelayMs:  5000,   // Xato bo'lganda qayta urinish
  maxReconnects:     999,    // Cheksiz qayta urinish
};

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
let state = {
  isLive:          false,
  liveChatId:      null,
  videoId:         null,
  nextPageToken:   null,
  pollTimer:       null,
  streamEndTimer:  null,
  reconnectCount:  0,
  lastMessageId:   null,   // dublikat oldini olish
  seenMessageIds:  new Set(), // so'nggi 500 xabar ID lari
};

// ═══════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO
// ═══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
});

// Statik fayllar — index_master.html shu papkada bo'lishi kerak
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    isLive:      state.isLive,
    videoId:     state.videoId,
    liveChatId:  state.liveChatId,
    uptime:      process.uptime(),
    time:        new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
// OAUTH2 — REFRESH TOKEN BILAN (bir marta sozlanadi)
// ═══════════════════════════════════════════════════════════
const oauth2Client = new google.auth.OAuth2(
  CONFIG.clientId,
  CONFIG.clientSecret,
  'urn:ietf:wg:oauth:2.0:oob'
);

oauth2Client.setCredentials({
  refresh_token: CONFIG.refreshToken,
});

// Token avtomatik yangilanadi
oauth2Client.on('tokens', tokens => {
  if (tokens.refresh_token) {
    log('info', '🔑 Yangi refresh token olindi');
    // Ixtiyoriy: .env ga yozish
    // process.env.YOUTUBE_REFRESH_TOKEN = tokens.refresh_token;
  }
  log('info', '✅ Access token yangilandi');
});

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ═══════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════
function log(level, msg, data = '') {
  const time    = new Date().toISOString().slice(11,19);
  const prefix  = { info: '📘', warn: '⚠️ ', error: '🔴', ok: '✅' }[level] || '  ';
  const logLine = `[${time}] ${prefix} ${msg} ${data ? JSON.stringify(data) : ''}`;
  console.log(logLine);
}

// ═══════════════════════════════════════════════════════════
// ACTIVE LIVE STREAM TOPISH
// Kanalda aktiv live stream bor-yo'qligini tekshiradi
// ═══════════════════════════════════════════════════════════
async function findActiveLiveStream() {
  try {
    const res = await youtube.search.list({
      channelId:  CONFIG.channelId,
      eventType:  'live',
      type:       'video',
      part:       'id,snippet',
      maxResults: 1,
    });

    const items = res.data.items || [];
    if (!items.length) {
      log('warn', 'Aktiv live stream topilmadi');
      return null;
    }

    const videoId = items[0].id.videoId;
    log('ok', `Live stream topildi: ${videoId}`);
    return videoId;

  } catch (err) {
    log('error', 'findActiveLiveStream xato:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// LIVE CHAT ID OLISH
// ═══════════════════════════════════════════════════════════
async function getLiveChatId(videoId) {
  try {
    const res = await youtube.videos.list({
      id:   videoId,
      part: 'liveStreamingDetails',
    });

    const details = res.data.items?.[0]?.liveStreamingDetails;
    if (!details?.activeLiveChatId) {
      log('warn', 'liveChatId topilmadi');
      return null;
    }

    log('ok', `liveChatId: ${details.activeLiveChatId}`);
    return details.activeLiveChatId;

  } catch (err) {
    log('error', 'getLiveChatId xato:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// CHAT POLL — xabarlarni o'qish
// ═══════════════════════════════════════════════════════════
async function pollChat() {
  if (!state.liveChatId || !state.isLive) return;

  try {
    const params = {
      liveChatId:  state.liveChatId,
      part:        'id,snippet,authorDetails',
      maxResults:  200,
    };
    if (state.nextPageToken) params.pageToken = state.nextPageToken;

    const res    = await youtube.liveChatMessages.list(params);
    const data   = res.data;
    const items  = data.items || [];

    state.nextPageToken = data.nextPageToken || state.nextPageToken;

    // Polling interval — YouTube API tavsiyasi
    // TEZLIK: YouTube pollingIntervalMillis ni ignore qilamiz
    // O'zimizning CONFIG.pollIntervalMs ishlatamiz (1000ms)
    // Bu quota xavfsiz — kuniga 10,000 / 5 = 2,000 so'rov
    // 1000ms * 2000 = 2,000,000ms = 33 soat — yetarli
    const pollingMs = CONFIG.pollIntervalMs;

    for (const item of items) {
      const msgId = item.id;

      // DUBLIKAT OLDINI OLISH
      if (state.seenMessageIds.has(msgId)) continue;
      state.seenMessageIds.add(msgId);

      // Set hajmini cheklash (xotira tejash)
      if (state.seenMessageIds.size > 500) {
        const first = state.seenMessageIds.values().next().value;
        state.seenMessageIds.delete(first);
      }

      const type   = item.snippet.type;
      const author = item.authorDetails?.displayName || 'Unknown';

      // ── ODDIY IZOH ──
      if (type === 'textMessageEvent') {
        const text = item.snippet.displayMessage || '';
        log('info', `💬 ${author}: ${text.slice(0, 40)}`);
        io.emit('vote', { text, author });
      }

      // ── SUPER CHAT ──
      else if (type === 'superChatEvent') {
        const sc   = item.snippet.superChatDetails;
        const text = sc?.userComment || '';
        const amt  = sc?.amountDisplayString || '';
        log('ok', `💰 SUPER CHAT ${author}: ${amt} — ${text}`);
        io.emit('vote',    { text, author, superChat: true, amount: amt });
        io.emit('superchat', { author, amount: amt, text });
      }

      // ── SUPER STICKER (iPhone/App Store stikerlar) ──
      else if (type === 'superStickerEvent') {
        const ss       = item.snippet.superStickerDetails;
        const label    = ss?.superStickerMetadata?.altText || '⭐';
        const stickerE = mapStickerToEmoji(label);
        const amt      = ss?.amountDisplayString || '';
        log('ok', `🎨 SUPER STICKER ${author}: ${label} → ${stickerE}`);
        io.emit('vote', { text: stickerE, emoji: stickerE, author, superSticker: true });
      }

      // ── MEMBER YANGI ──
      else if (type === 'newSponsorEvent') {
        log('ok', `🌟 YANGI MEMBER: ${author}`);
        io.emit('member', { author });
      }

      // ── GIFT MEMBERSHIP ──
      else if (type === 'memberMilestoneChatEvent') {
        const text = item.snippet.memberMilestoneChatDetails?.userComment || '';
        log('ok', `🎁 MEMBER MILESTONE ${author}: ${text}`);
        io.emit('vote', { text, author });
      }
    }

    // STREAM TUGADI tekshiruvi
    if (!data.nextPageToken && items.length === 0) {
      log('warn', 'Chat bo\'sh — stream tugaganmi?');
      await checkStreamStatus();
    }

    // Keyingi polling — YouTube tavsiya qilgan vaqtda
    state.pollTimer = setTimeout(pollChat, pollingMs);

  } catch (err) {
    const code = err?.response?.status;
    log('error', `pollChat xato (${code}):`, err.message);

    if (code === 403) {
      log('error', 'API quota tugadi yoki stream yakunlandi');
      io.emit('yt_status', { status: 'ERROR' });
      await stopLiveConnection();
    } else if (code === 404) {
      log('warn', 'liveChatId topilmadi — stream tugagan bo\'lishi mumkin');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    } else {
      // Tarmoq xatosi — qayta urin
      state.reconnectCount++;
      if (state.reconnectCount <= CONFIG.maxReconnects) {
        log('warn', `${CONFIG.reconnectDelayMs/1000}s keyin qayta urinamiz...`);
        io.emit('yt_status', { status: 'CONNECTING' });
        state.pollTimer = setTimeout(pollChat, CONFIG.reconnectDelayMs);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// STREAM STATUS TEKSHIRISH
// ═══════════════════════════════════════════════════════════
async function checkStreamStatus() {
  if (!state.videoId) return;
  try {
    const res = await youtube.videos.list({
      id:   state.videoId,
      part: 'snippet',
    });
    const status = res.data.items?.[0]?.snippet?.liveBroadcastContent;
    if (status !== 'live') {
      log('warn', `Stream holati: ${status} — to'xtatilmoqda`);
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    }
  } catch (e) {
    log('error', 'checkStreamStatus:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// SUPER STICKER → EMOJI MAPPER
// Apple/YouTube stikerlarini emoji ga moslashtiradi
// ═══════════════════════════════════════════════════════════
function mapStickerToEmoji(label) {
  const l = (label || '').toLowerCase();
  const MAP = {
    'fire':      '🔥', 'love':    '😍', 'heart':   '❤️',
    'skull':     '💀', 'ghost':   '👻', 'robot':   '🤖',
    'crown':     '👑', 'king':    '👑', 'lion':    '🦁',
    'tiger':     '🐯', 'wolf':    '🐺', 'fox':     '🦊',
    'dragon':    '🐉', 'unicorn': '🦄', 'rocket':  '🚀',
    'diamond':   '💎', 'thunder': '⚡', 'star':    '🌟',
    'target':    '🎯', 'trophy':  '🏆', 'cool':    '😎',
    'laugh':     '😂', 'lol':     '😂', 'wow':     '🤩',
    'shock':     '😱', 'strong':  '💪', 'alien':   '👽',
    'shark':     '🦈', 'eagle':   '🦅', 'bomb':    '💣',
    'rainbow':   '🌈', 'music':   '🎵', 'pizza':   '🍕',
  };

  for (const [key, emoji] of Object.entries(MAP)) {
    if (l.includes(key)) return emoji;
  }

  // Topilmasa default ⭐
  return '⭐';
}

// ═══════════════════════════════════════════════════════════
// YOUTUBE ULANISH — ASOSIY FUNKSIYA
// ═══════════════════════════════════════════════════════════
async function connectToYouTube() {
  log('info', '🔌 YouTube ga ulanish boshlandi...');
  io.emit('yt_status', { status: 'CONNECTING' });

  // Config tekshiruvi
  if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.refreshToken) {
    log('error', '.env da YouTube OAuth ma\'lumotlari yo\'q!');
    io.emit('yt_status', { status: 'ERROR' });
    return;
  }

  if (!CONFIG.channelId) {
    log('error', '.env da CHANNEL_ID yo\'q!');
    io.emit('yt_status', { status: 'NO_VIDEO_ID' });
    return;
  }

  // Aktiv stream topish
  const videoId = await findActiveLiveStream();
  if (!videoId) {
    io.emit('yt_status', { status: 'NOT_LIVE' });
    // 30 soniyada qayta tekshir
    setTimeout(connectToYouTube, 30_000);
    return;
  }

  // liveChatId olish
  const liveChatId = await getLiveChatId(videoId);
  if (!liveChatId) {
    io.emit('yt_status', { status: 'ERROR' });
    setTimeout(connectToYouTube, 30_000);
    return;
  }

  // State yangilash
  state.videoId       = videoId;
  state.liveChatId    = liveChatId;
  state.isLive        = true;
  state.nextPageToken = null;
  state.reconnectCount = 0;
  state.seenMessageIds.clear();

  log('ok', `YouTube ulandi! Video: ${videoId}`);
  io.emit('yt_status', { status: 'CONNECTED' });

  // Polling boshlash
  clearTimeout(state.pollTimer);
  pollChat();
}

// ═══════════════════════════════════════════════════════════
// ULANISHNI TO'XTATISH
// ═══════════════════════════════════════════════════════════
async function stopLiveConnection() {
  log('info', '⏹ YouTube ulanishi to\'xtatilmoqda...');
  state.isLive    = false;
  state.liveChatId = null;
  state.videoId    = null;
  clearTimeout(state.pollTimer);
  state.pollTimer  = null;
}

// ═══════════════════════════════════════════════════════════
// AVTOMATIK JADVAL — CRON JOB
// Har kuni belgilangan vaqtda stream boshlaydi
// ═══════════════════════════════════════════════════════════
function setupSchedule() {
  // Stream boshlash vaqti
  cron.schedule(CONFIG.streamStartCron, async () => {
    log('ok', `⏰ Jadval: stream boshlash vaqti keldi (${CONFIG.streamStartCron})`);

    // Avvalgi ulanishni tozalash
    await stopLiveConnection();

    // Yangi ulanish
    await connectToYouTube();

    // Stream tugash timeri
    if (state.streamEndTimer) clearTimeout(state.streamEndTimer);
    const durationMs = CONFIG.streamDurationH * 60 * 60 * 1000;
    state.streamEndTimer = setTimeout(async () => {
      log('ok', `⏰ ${CONFIG.streamDurationH} soat tugadi — stream to'xtatilmoqda`);
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    }, durationMs);

    log('ok', `✅ Stream ${CONFIG.streamDurationH} soatdan keyin avtomatik to'xtaydi`);
  }, {
    timezone: 'Asia/Tashkent', // O'zbekiston vaqt mintaqasi
  });

  log('ok', `📅 Jadval sozlandi: "${CONFIG.streamStartCron}" (Toshkent vaqti)`);
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO — CLIENT ULANISHLARI
// ═══════════════════════════════════════════════════════════
io.on('connection', socket => {
  log('info', `👤 Client ulandi: ${socket.id}`);

  // Joriy holat yuborish
  if (state.isLive) {
    socket.emit('yt_status', { status: 'CONNECTED' });
  } else {
    socket.emit('yt_status', { status: 'NOT_LIVE' });
  }

  socket.on('disconnect', () => {
    log('info', `👤 Client uzildi: ${socket.id}`);
  });

  // Admin: qo'lda ulanish (debug uchun)
  socket.on('admin_connect', async () => {
    log('warn', `Admin qo'lda ulanish buyrug'i`);
    await connectToYouTube();
  });

  // Admin: test ovoz yuborish (debug uchun)
  socket.on('admin_vote', data => {
    log('info', `Admin test vote: ${data.text}`);
    io.emit('vote', { text: data.text || '🔥', author: 'Admin' });
  });
});

// ═══════════════════════════════════════════════════════════
// XATO TUTISH — Server crash bo'lmasin
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', err => {
  log('error', 'uncaughtException:', err.message);
  // Serverni o'chirmaydi — ishlashda davom etadi
});

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection:', String(reason));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('warn', 'SIGTERM — server to\'xtatilmoqda...');
  await stopLiveConnection();
  server.close(() => {
    log('ok', 'Server to\'xtatildi');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  log('warn', 'SIGINT (Ctrl+C) — server to\'xtatilmoqda...');
  await stopLiveConnection();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════
// ISHGA TUSHIRISH
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, () => {
  log('ok', `🚀 Server ishga tushdi: http://localhost:${CONFIG.port}`);
  log('ok', `📺 YouTube kanal: ${CONFIG.channelId || 'sozlanmagan'}`);

  // Jadval sozlash
  setupSchedule();

  // Server boshlanishi bilan ham ulanishga urinish
  // (agar stream allaqachon davom etayotgan bo'lsa)
  connectToYouTube().catch(e => log('error', 'Dastlabki ulanish xato:', e.message));
});
