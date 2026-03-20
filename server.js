'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const cron       = require('node-cron');
const path       = require('path');

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  port:              process.env.PORT                  || 3000,
  clientId:          process.env.YOUTUBE_CLIENT_ID     || '',
  clientSecret:      process.env.YOUTUBE_CLIENT_SECRET || '',
  refreshToken:      process.env.YOUTUBE_REFRESH_TOKEN || '',
  channelId:         process.env.CHANNEL_ID            || '',
  streamStartCron:   process.env.STREAM_START_CRON     || '0 20 * * *',
  streamDurationH:   parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  pollIntervalMs:    5000,
  reconnectDelayMs:  5000,
  maxReconnects:     999,
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
  seenMessageIds:  new Set(),
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

app.use(express.static(__dirname));

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
// OAUTH2 — TO'G'RILANGAN REDIRECT URI
// ═══════════════════════════════════════════════════════════
const oauth2Client = new google.auth.OAuth2(
  CONFIG.clientId,
  CONFIG.clientSecret,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: CONFIG.refreshToken,
});

oauth2Client.on('tokens', tokens => {
  if (tokens.refresh_token) {
    log('info', '🔑 Yangi refresh token olindi');
  }
  log('info', '✅ Access token yangilandi');
});

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ═══════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════
function log(level, msg, data = '') {
  const time   = new Date().toISOString().slice(11,19);
  const prefix = { info: '📘', warn: '⚠️ ', error: '🔴', ok: '✅' }[level] || '  ';
  console.log(`[${time}] ${prefix} ${msg} ${data ? JSON.stringify(data) : ''}`);
}

// ═══════════════════════════════════════════════════════════
// ACTIVE LIVE STREAM TOPISH
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
// CHAT POLL
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

    const res   = await youtube.liveChatMessages.list(params);
    const data  = res.data;
    const items = data.items || [];

    state.nextPageToken = data.nextPageToken || state.nextPageToken;

    for (const item of items) {
      const msgId = item.id;

      if (state.seenMessageIds.has(msgId)) continue;
      state.seenMessageIds.add(msgId);

      if (state.seenMessageIds.size > 500) {
        const first = state.seenMessageIds.values().next().value;
        state.seenMessageIds.delete(first);
      }

      const type   = item.snippet.type;
      const author = item.authorDetails?.displayName || 'Unknown';

      if (type === 'textMessageEvent') {
        const text = item.snippet.displayMessage || '';
        log('info', `💬 ${author}: ${text.slice(0, 40)}`);
        io.emit('vote', { text, author });
      }
      else if (type === 'superChatEvent') {
        const sc  = item.snippet.superChatDetails;
        const text = sc?.userComment || '';
        const amt  = sc?.amountDisplayString || '';
        log('ok', `💰 SUPER CHAT ${author}: ${amt}`);
        io.emit('vote',     { text, author, superChat: true, amount: amt });
        io.emit('superchat', { author, amount: amt, text });
      }
      else if (type === 'superStickerEvent') {
        const ss      = item.snippet.superStickerDetails;
        const label   = ss?.superStickerMetadata?.altText || '⭐';
        const stickerE = mapStickerToEmoji(label);
        log('ok', `🎨 SUPER STICKER ${author}: ${stickerE}`);
        io.emit('vote', { text: stickerE, emoji: stickerE, author, superSticker: true });
      }
      else if (type === 'newSponsorEvent') {
        log('ok', `🌟 YANGI MEMBER: ${author}`);
        io.emit('member', { author });
      }
    }

    if (!data.nextPageToken && items.length === 0) {
      await checkStreamStatus();
    }

    state.pollTimer = setTimeout(pollChat, CONFIG.pollIntervalMs);

  } catch (err) {
    const code = err?.response?.status;
    log('error', `pollChat xato (${code}):`, err.message);

    if (code === 403 || code === 404) {
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    } else {
      state.reconnectCount++;
      if (state.reconnectCount <= CONFIG.maxReconnects) {
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
      log('warn', `Stream holati: ${status}`);
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    }
  } catch (e) {
    log('error', 'checkStreamStatus:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// STICKER → EMOJI
// ═══════════════════════════════════════════════════════════
function mapStickerToEmoji(label) {
  const l = (label || '').toLowerCase();
  const MAP = {
    'fire':'🔥','love':'😍','heart':'❤️','skull':'💀','ghost':'👻',
    'robot':'🤖','crown':'👑','king':'👑','lion':'🦁','tiger':'🐯',
    'wolf':'🐺','fox':'🦊','dragon':'🐉','unicorn':'🦄','rocket':'🚀',
    'diamond':'💎','thunder':'⚡','star':'🌟','target':'🎯','trophy':'🏆',
    'cool':'😎','laugh':'😂','lol':'😂','wow':'🤩','shock':'😱',
    'strong':'💪','alien':'👽','shark':'🦈','eagle':'🦅','bomb':'💣',
  };
  for (const [key, emoji] of Object.entries(MAP)) {
    if (l.includes(key)) return emoji;
  }
  return '⭐';
}

// ═══════════════════════════════════════════════════════════
// YOUTUBE GA ULANISH
// ═══════════════════════════════════════════════════════════
async function connectToYouTube() {
  log('info', '🔌 YouTube ga ulanish boshlandi...');
  io.emit('yt_status', { status: 'CONNECTING' });

  if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.refreshToken) {
    log('error', '.env da OAuth ma\'lumotlari yo\'q!');
    io.emit('yt_status', { status: 'ERROR' });
    return;
  }

  if (!CONFIG.channelId) {
    log('error', '.env da CHANNEL_ID yo\'q!');
    io.emit('yt_status', { status: 'NO_VIDEO_ID' });
    return;
  }

  const videoId = await findActiveLiveStream();
  if (!videoId) {
    io.emit('yt_status', { status: 'NOT_LIVE' });
    setTimeout(connectToYouTube, 30_000);
    return;
  }

  const liveChatId = await getLiveChatId(videoId);
  if (!liveChatId) {
    io.emit('yt_status', { status: 'ERROR' });
    setTimeout(connectToYouTube, 30_000);
    return;
  }

  state.videoId        = videoId;
  state.liveChatId     = liveChatId;
  state.isLive         = true;
  state.nextPageToken  = null;
  state.reconnectCount = 0;
  state.seenMessageIds.clear();

  log('ok', `YouTube ulandi! Video: ${videoId}`);
  io.emit('yt_status', { status: 'CONNECTED' });

  clearTimeout(state.pollTimer);
  pollChat();
}

// ═══════════════════════════════════════════════════════════
// ULANISHNI TO'XTATISH
// ═══════════════════════════════════════════════════════════
async function stopLiveConnection() {
  state.isLive     = false;
  state.liveChatId = null;
  state.videoId    = null;
  clearTimeout(state.pollTimer);
  state.pollTimer  = null;
}

// ═══════════════════════════════════════════════════════════
// CRON JOB
// ═══════════════════════════════════════════════════════════
function setupSchedule() {
  cron.schedule(CONFIG.streamStartCron, async () => {
    log('ok', `⏰ Jadval: stream boshlash vaqti`);
    await stopLiveConnection();
    await connectToYouTube();

    if (state.streamEndTimer) clearTimeout(state.streamEndTimer);
    const durationMs = CONFIG.streamDurationH * 60 * 60 * 1000;
    state.streamEndTimer = setTimeout(async () => {
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLiveConnection();
    }, durationMs);
  }, { timezone: 'Asia/Tashkent' });

  log('ok', `📅 Jadval: "${CONFIG.streamStartCron}" (Toshkent)`);
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', socket => {
  log('info', `👤 Client ulandi: ${socket.id}`);

  if (state.isLive) {
    socket.emit('yt_status', { status: 'CONNECTED' });
  } else {
    socket.emit('yt_status', { status: 'NOT_LIVE' });
  }

  socket.on('disconnect', () => {
    log('info', `👤 Client uzildi: ${socket.id}`);
  });

  socket.on('admin_connect', async () => {
    await connectToYouTube();
  });

  socket.on('admin_vote', data => {
    io.emit('vote', { text: data.text || '🔥', author: 'Admin' });
  });
});

// ═══════════════════════════════════════════════════════════
// XATO TUTISH
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', err => {
  log('error', 'uncaughtException:', err.message);
});

process.on('unhandledRejection', reason => {
  log('error', 'unhandledRejection:', String(reason));
});

process.on('SIGTERM', async () => {
  await stopLiveConnection();
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  await stopLiveConnection();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════
// ISHGA TUSHIRISH
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, () => {
  log('ok', `🚀 Server: http://localhost:${CONFIG.port}`);
  log('ok', `📺 Kanal: ${CONFIG.channelId}`);
  setupSchedule();
  connectToYouTube().catch(e => log('error', 'Dastlabki ulanish:', e.message));
});
