# ═══════════════════════════════════════════════════════════
#  Emoji War — Server-Side Streaming
#  Xvfb + Chromium + FFmpeg (libx264) + Node.js 20
#  Render Starter plan ($7/mo) uchun optimallashtirilgan
# ═══════════════════════════════════════════════════════════

FROM node:20-slim

# ── 1. Tizim paketlari ──────────────────────────────────────
# Bitta RUN layer — image hajmini kamaytirish uchun
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Xvfb — virtual framebuffer (ekransiz ekran)
    xvfb \
    x11-utils \
    # Chromium va uning barcha kerakli kutubxonalari
    chromium \
    # Chromium font support
    fonts-liberation \
    fonts-noto-color-emoji \
    # FFmpeg — x11grab + libx264 + aac bilan
    ffmpeg \
    # Process boshqaruvi
    procps \
    # Tarmoq diagnostikasi (debug uchun)
    curl \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ── 2. Muhit o'zgaruvchilari ────────────────────────────────
ENV NODE_ENV=production \
    DISPLAY=:99 \
    NPM_CONFIG_LOGLEVEL=warn

# ── 3. Ishchi papka ─────────────────────────────────────────
WORKDIR /app

# ── 4. Dependency o'rnatish (cache layer) ───────────────────
# Avval faqat package fayllarini nusxalaymiz
# Shunda kod o'zgarganda npm install qayta ishlamaydi
COPY package*.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ── 5. Ilova kodi ───────────────────────────────────────────
COPY . .

# ── 6. Non-root foydalanuvchi (xavfsizlik) ──────────────────
# Chromium root sifatida ishlamaydi (--no-sandbox kerak)
# Render da ham root sifatida ishlash xavfli
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser \
 && chown -R appuser:appuser /app \
 # Xvfb lock faylini o'chirish uchun /tmp ruxsati
 && chmod 1777 /tmp

USER appuser

# ── 7. Port ─────────────────────────────────────────────────
EXPOSE 10000

# ── 8. Sog'liq tekshiruvi ───────────────────────────────────
# Render bu endpointni ping qiladi
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:10000/health || exit 1

# ── 9. Ishga tushirish ──────────────────────────────────────
# Xvfb lock faylini tozalab, keyin Node.js ni ishga tushuramiz
# (Render container qayta ishlasa /tmp/.X99-lock qolgan bo'lishi mumkin)
CMD ["sh", "-c", "rm -f /tmp/.X99-lock && exec node server.js"]
