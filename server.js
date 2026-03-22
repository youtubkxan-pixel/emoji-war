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
  port:            process.env.PORT              || 3000,
  channelId:       process.env.CHANNEL_ID        || 'UCT24pImU78QB7I8a6gofYyA',
  cookies:         process.env.YT_COOKIES        || '',
  startCron:       process.env.STREAM_START_CRON || '0 20 * * *',
  durationH:       parseFloat(process.env.STREAM_DURATION_HOURS || '10'),
  pollMs:          3500,
  retryMs:         8000,
  maxRetry:        9999,
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
function ytFetch(url, opt = {}) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          opt.json ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection':      'keep-alive',
      'Origin':          'https://www.youtube.com',
      'Referer':         `https://www.youtube.com/watch?v=${S.videoId || 'dQw4w9WgXcQ'}`,
      'Sec-Fetch-Dest':  opt.json ? 'empty'    : 'document',
      'Sec-Fetch-Mode':  opt.json ? 'same-origin' : 'navigate',
      'Sec-Fetch-Site':  opt.json ? 'same-origin' : 'none',
      ...(CONFIG.cookies ? { 'Cookie': CONFIG.cookies } : {}),
      ...(opt.headers || {}),
    };
    if (opt.body) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(opt.body);
    }
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   opt.body ? 'POST' : 'GET',
      headers,
    }, res => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());

      const buf = [];
      stream.on('data', c => buf.push(c));
      stream.on('end',  () => {
        const txt = Buffer.concat(buf).toString('utf8');
        if (opt.json) {
          try { ok(JSON.parse(txt)); }
          catch { fail(new Error('JSON parse error: ' + txt.slice(0,120))); }
        } else ok(txt);
      });
      stream.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(18000, () => req.destroy(new Error('Request timeout')));
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  STEP 1 — Kanaldan live video ID topish
// ═══════════════════════════════════════════════════════════
async function findVideoId() {
  try {
    // /live redirect sahifasini tekshir
    const html = await ytFetch(`https://www.youtube.com/channel/${CONFIG.channelId}/live`);

    // ytInitialData dan videoId qidirish
    let m = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
    if (m) return m[1];

    // URL dan qidirish
    m = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];

    // canonicalUrl dan
    m = html.match(/"canonicalUrl"\s*:\s*"[^"]*v=([a-zA-Z0-9_-]{11})"/);
    if (m) return m[1];

    return null;
  } catch (e) {
    log('error', `findVideoId: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  STEP 2 — Video sahifasidan chat config olish
// ═══════════════════════════════════════════════════════════
async function extractConfig(videoId) {
  try {
    const html = await ytFetch(`https://www.youtube.com/watch?v=${videoId}`);

    // Efir live ekanligini tekshir
    if (!html.includes('"isLive":true') && !html.includes('"liveBroadcastDetails"')) {
      log('warn', `Video ${videoId} hozir live emas`);
      return null;
    }

    const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };

    const apiKey      = grab(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)
                     || grab(/"innertubeApiKey"\s*:\s*"([^"]+)"/)
                     || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    const clientVer   = grab(/"clientVersion"\s*:\s*"([\d.]+)"/)
                     || '2.20240515.01.00';

    const visitorData = grab(/"visitorData"\s*:\s*"([^"]+)"/) || '';

    // Continuation token — live chat uchun kalit
    // Bir nechta pattern bilan izlash
    let continuation =
      grab(/"continuation"\s*:\s*"([^"]+)"/) ||
      grab(/"continuationCommand"\s*:.*?"token"\s*:\s*"([^"]+)"/) ||
      grab(/liveChatRenderer.*?"continuations".*?"continuation"\s*:\s*"([^"]+)"/s);

    if (!continuation) {
      log('warn', `${videoId} uchun continuation topilmadi`);
      return null;
    }

    return { apiKey, clientVer, visitorData, continuation };
  } catch (e) {
    log('error', `extractConfig: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  STEP 3 — Chat xabarlarini olish (YouTube ichki API)
// ═══════════════════════════════════════════════════════════
async function fetchChat() {
  if (!S.continuation || !S.apiKey) return null;

  const url  = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${S.apiKey}&prettyPrint=false`;
  const body = JSON.stringify({
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
    body, json: true,
    headers: {
      'X-YouTube-Client-Name':    '1',
      'X-YouTube-Client-Version': S.clientVer || '2.20240515.01.00',
      'X-Goog-AuthUser':          '0',
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  STEP 4 — Xabarlarni parse qilish
// ═══════════════════════════════════════════════════════════
function parseChat(data) {
  try {
    const lcc = data?.continuationContents?.liveChatContinuation;
    if (!lcc) return [];

    // Continuation yangilash
    const contData = lcc.continuations?.[0];
    const next = contData?.invalidationContinuationData?.continuation
              || contData?.timedContinuationData?.continuation
              || contData?.liveChatReplayContinuationData?.continuation;
    if (next) S.continuation = next;

    const out = [];
    for (const action of (lcc.actions || [])) {
      const item = action.addChatItemAction?.item;
      if (!item) continue;

      // ── TEXT MESSAGE ──
      if (item.liveChatTextMessageRenderer) {
        const r  = item.liveChatTextMessageRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        const author = r.authorName?.simpleText || 'Unknown';
        const runs   = r.message?.runs || [];
        const text   = runs.map(x => x.text || '').join('');
        const emojis = runs
          .filter(x => x.emoji)
          .map(x => ({
            emojiId:  x.emoji.emojiId || x.emoji.shortcuts?.[0] || '',
            emojiUrl: x.emoji.image?.thumbnails?.[0]?.url || '',
          }));
        out.push({ type:'text', author, text, emojis });
      }

      // ── SUPER CHAT ──
      else if (item.liveChatPaidMessageRenderer) {
        const r = item.liveChatPaidMessageRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        out.push({
          type:   'superchat',
          author: r.authorName?.simpleText || 'Unknown',
          text:   (r.message?.runs || []).map(x => x.text || '').join(''),
          amount: r.purchaseAmountText?.simpleText || '',
        });
      }

      // ── SUPER STICKER ──
      else if (item.liveChatPaidStickerRenderer) {
        const r = item.liveChatPaidStickerRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        out.push({
          type:       'sticker',
          author:     r.authorName?.simpleText || 'Unknown',
          amount:     r.purchaseAmountText?.simpleText || '',
          stickerUrl: r.sticker?.thumbnails?.[0]?.url || '',
        });
      }

      // ── MEMBER ──
      else if (item.liveChatMembershipItemRenderer) {
        const r = item.liveChatMembershipItemRenderer;
        if (S.seen.has(r.id)) continue;
        S.seen.add(r.id);
        out.push({ type:'member', author: r.authorName?.simpleText || 'Unknown' });
      }
    }

    // seen hajmini cheklash
    if (S.seen.size > 1500) {
      const arr = [...S.seen];
      S.seen = new Set(arr.slice(-600));
    }

    return out;
  } catch (e) {
    log('error', `parseChat: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
//  DISPATCH — Socket ga yuborish
// ═══════════════════════════════════════════════════════════
function dispatch(messages) {
  for (const m of messages) {
    if (m.type === 'text') {
      if (m.emojis.length > 0) {
        m.emojis.forEach(e => {
          log('ok', `🎨 ${m.author} → ${e.emojiId}`);
          io.emit('vote', { author: m.author, text: m.text, emojiId: e.emojiId, emojiUrl: e.emojiUrl });
        });
      } else if (m.text.trim()) {
        log('info', `💬 ${m.author}: ${m.text.slice(0,45)}`);
        io.emit('vote', { author: m.author, text: m.text });
      }
    } else if (m.type === 'superchat') {
      log('ok', `💰 SUPERCHAT ${m.author}: ${m.amount}`);
      io.emit('vote',      { author: m.author, text: m.text || '💰', superChat: true, amount: m.amount });
      io.emit('superchat', { author: m.author, text: m.text, amount: m.amount });
    } else if (m.type === 'sticker') {
      log('ok', `🎨 STICKER ${m.author}: ${m.amount}`);
      io.emit('vote',      { author: m.author, text: '⭐', superSticker: true, amount: m.amount, stickerUrl: m.stickerUrl });
      io.emit('superchat', { author: m.author, amount: m.amount });
    } else if (m.type === 'member') {
      log('ok', `🌟 MEMBER: ${m.author}`);
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
    const data = await fetchChat();
    if (!data) throw new Error('empty response');

    // Stream tugaganmi?
    if (data.error?.code === 403 || data.error?.code === 404) {
      log('warn', 'Stream ended (403/404)');
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLive();
      return;
    }

    const msgs = parseChat(data);
    if (msgs.length) dispatch(msgs);
    S.retries = 0;

    // YouTube tavsiya qilgan interval
    const recommended = data?.continuationContents
      ?.liveChatContinuation?.continuations?.[0]
      ?.timedContinuationData?.timeoutMs;

    const delay = recommended
      ? Math.max(1200, Math.min(recommended, 7000))
      : CONFIG.pollMs;

    S.pollTimer = setTimeout(pollLoop, delay);

  } catch (e) {
    S.retries++;
    const backoff = Math.min(CONFIG.retryMs * Math.pow(1.5, Math.min(S.retries - 1, 8)), 120000);
    log('error', `pollLoop #${S.retries}: ${e.message} → ${Math.round(backoff/1000)}s kutish`);
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
    // 1. Live video ID
    const videoId = await findVideoId();
    if (!videoId) {
      log('warn', 'Jonli efir topilmadi → 30s keyin qayta');
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, 30000);
      return;
    }

    // 2. Chat konfiguratsiya
    const cfg = await extractConfig(videoId);
    if (!cfg) {
      log('warn', `${videoId} chat config yo'q → 30s keyin qayta`);
      io.emit('yt_status', { status: 'NOT_LIVE' });
      S.pollTimer = setTimeout(connect, 30000);
      return;
    }

    // 3. State yangilash
    Object.assign(S, {
      live: true, videoId,
      continuation: cfg.continuation,
      apiKey: cfg.apiKey,
      clientVer: cfg.clientVer,
      visitorData: cfg.visitorData,
      retries: 0,
    });
    S.seen.clear();

    log('ok', `Ulandi! Video: ${videoId}`);
    io.emit('yt_status', { status: 'CONNECTED', videoId });

    // 4. Polling
    pollLoop();

  } catch (e) {
    log('error', `connect: ${e.message}`);
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
  log('warn', 'Live to\'xtatildi');
}

// ═══════════════════════════════════════════════════════════
//  CRON — har kuni 20:00 Toshkent
// ═══════════════════════════════════════════════════════════
function setupCron() {
  cron.schedule(CONFIG.startCron, async () => {
    log('ok', '⏰ Jadval: stream boshlash vaqti!');
    await stopLive();
    await connect();
    clearTimeout(S.endTimer);
    S.endTimer = setTimeout(async () => {
      log('warn', `⏰ ${CONFIG.durationH} soatlik efir tugadi`);
      io.emit('yt_status', { status: 'STREAM_ENDED' });
      await stopLive();
    }, CONFIG.durationH * 3600 * 1000);
  }, { timezone: 'Asia/Tashkent' });

  log('ok', `📅 Jadval: "${CONFIG.startCron}" (Toshkent)`);
}

// ═══════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', socket => {
  log('info', `👤 Client: ${socket.id}`);
  socket.emit('yt_status', { status: S.live ? 'CONNECTED' : 'NOT_LIVE', videoId: S.videoId });

  socket.on('disconnect',    () => log('info', `👤 Uzildi: ${socket.id}`));
  socket.on('admin_connect', () => connect());
  socket.on('admin_vote',  d => io.emit('vote', { text: d?.text || '🔥', author: 'Admin' }));
});

// ═══════════════════════════════════════════════════════════
//  PROCESS
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException',  e => log('error', `uncaughtException: ${e.message}`));
process.on('unhandledRejection', r => log('error', `unhandledRejection: ${r}`));
process.on('SIGTERM', async () => { await stopLive(); server.close(() => process.exit(0)); });
process.on('SIGINT',  async () => { await stopLive(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.port, () => {
  log('ok', `🚀 Server: http://localhost:${CONFIG.port}`);
  log('ok', `📺 Kanal:  ${CONFIG.channelId}`);
  log('ok', `🍪 Cookies: ${CONFIG.cookies ? 'bor ✅' : 'yo\'q (ixtiyoriy)'}`);
  setupCron();
  connect();
});
