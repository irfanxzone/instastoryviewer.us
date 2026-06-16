'use strict';

require('dotenv').config();

const path   = require('path');
const axios  = require('axios');
const express = require('express');
const helmet  = require('helmet');
const compression = require('compression');
const cors   = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const instagramRoutes = require('./routes/instagram.routes');

const app    = express();
const port   = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Security / Transport ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(isProd ? 'combined' : 'dev'));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait a moment and try again.' }
});

// Separate (looser) limiter for the image proxy — browsers make many parallel requests
const proxyLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: false,
  legacyHeaders: false
});

// ─── Image / Video Proxy ──────────────────────────────────────────────────────
// Browsers cannot load Instagram CDN URLs cross-origin — they need Referer:
// https://www.instagram.com/ on the request.  This endpoint fetches the media
// server-side and streams it back, so the browser never talks to Instagram CDN directly.
const ALLOWED_PROXY_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

function isAllowedProxy(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_PROXY_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

app.get('/api/proxy', proxyLimiter, async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl || !isAllowedProxy(rawUrl)) {
    return res.status(400).end();
  }

  try {
    const upstream = await axios.get(rawUrl, {
      responseType: 'stream',
      timeout: 20000,
      headers: {
        'User-Agent':       PROXY_UA,
        'Referer':          'https://www.instagram.com/',
        'Accept':           '*/*',
        'Accept-Encoding':  'gzip, deflate, br'
      }
    });

    const ct = upstream.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
});

// ─── Instagram API Routes ─────────────────────────────────────────────────────
app.use('/api/', apiLimiter);
app.use('/api/ig', instagramRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    success:   true,
    status:    'ok',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ─── Static Frontend ──────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { maxAge: isProd ? '1h' : '0', etag: isProd }));

// ─── Clean URLs (no .html extension) ─────────────────────────────────────────
const cleanPages = ['blog','about','contact','privacy','disclaimer','terms','dmca'];
cleanPages.forEach(p => {
  app.get(`/${p}`, (req, res) => res.sendFile(path.join(publicDir, `${p}.html`)));
});

// Blog posts clean URLs
app.get('/blog/:slug', (req, res) => {
  const file = path.join(publicDir, 'blog', `${req.params.slug}.html`);
  if (require('fs').existsSync(file)) return res.sendFile(file);
  res.redirect('/blog');
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ─── Error Handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const responseStatus =
    status === 404 ? 'NOT_FOUND' :
    status === 429 ? 'BLOCKED_OR_RATE_LIMITED' :
    (status === 503 || status === 502) ? 'BLOCKED_OR_RATE_LIMITED' : 'ERROR';

  res.status(status).json({
    success: false,
    status:  err.igStatus || responseStatus,
    error:   err.message || 'Something went wrong.',
    details: !isProd ? (err.details || err.stack) : undefined
  });
});

// ─── Start (local only — Vercel imports the app as a module, never calls listen) ─
module.exports = app;

if (require.main === module) {
  const { warmupBrowser } = require('./services/browserFallbackService');
  app.listen(port, () => {
    console.log(`[server] Instagram Viewer running at http://localhost:${port}`);
    console.log(`[server] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
    console.log(`[server] Browser fallback: ${process.env.ENABLE_BROWSER_FALLBACK === 'true' ? 'enabled' : 'disabled'}`);

    if (process.env.ENABLE_BROWSER_FALLBACK === 'true') {
      setTimeout(() => warmupBrowser().catch(() => {}), 2000);
    }
  });
}
