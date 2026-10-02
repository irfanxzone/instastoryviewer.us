'use strict';

const express = require('express');
const { resolveInstagramInput } = require('../services/inputResolver');
const { getCache, setCacheMerged } = require('../services/cacheService');
const { fetchAllPublic, hasPendingBrowserJob } = require('../services/instagramPublicFetcher');

const router = express.Router();
const activeLoads = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cacheKey(username) {
  return `all:hybrid-v4:${username.toLowerCase()}`;
}

function metaBlock(cached) {
  return {
    cache: cached
      ? { hit: true, stale: cached.stale, ageMs: cached.ageMs }
      : { hit: false },
    note: 'Only public Instagram content is supported. Private profiles are not bypassed.'
  };
}

function httpStatusFor(data) {
  switch (data?.status) {
    case 'NOT_FOUND': return 404;
    case 'BLOCKED_OR_RATE_LIMITED': return 503;
    case 'ERROR': return 500;
    default: return 200; // PUBLIC_ACCOUNT, PRIVATE_ACCOUNT, PARTIAL_DATA
  }
}

function loadOnce(username, key) {
  const lockKey = username.toLowerCase();
  if (activeLoads.has(lockKey)) {
    console.log(`[requests] Joined existing fetch for @${lockKey}`);
    return activeLoads.get(lockKey);
  }

  const job = fetchAllPublic(username)
    .then(fresh => {
      setCacheMerged(key, fresh);
      return fresh;
    })
    .finally(() => activeLoads.delete(lockKey));
  activeLoads.set(lockKey, job);
  return job;
}

async function resolveAndLoad(rawInput, { forceRefresh = false } = {}) {
  const resolved = resolveInstagramInput(rawInput);
  if (!resolved.username) {
    const e = new Error(
      resolved.message ||
      'This link points to a post or reel. Search by profile username or profile link.'
    );
    e.status = 400;
    throw e;
  }

  const key = cacheKey(resolved.username);

  const cached = getCache(key, { allowStale: true });
  if (cached && !cached.stale && !forceRefresh) {
    return { data: cached.data, cached };
  }

  if (cached?.stale && !forceRefresh) {
    loadOnce(resolved.username, key).catch(() => {});
    return { data: cached.data, cached };
  }

  try {
    const fresh = await loadOnce(resolved.username, key);
    return { data: fresh, cached: null };
  } catch (fetchErr) {
    if (cached) {
      return {
        data: {
          ...cached.data,
          source: 'stale_cache_after_provider_failure',
          stale: true,
          warning: 'Fresh provider data is temporarily unavailable. Showing cached public data.'
        },
        cached
      };
    }
    throw fetchErr;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/ig/resolve?input=...
router.get('/resolve', (req, res, next) => {
  try {
    const resolved = resolveInstagramInput(req.query.input);
    res.json({ success: true, resolved });
  } catch (err) {
    next(err);
  }
});

// GET /api/ig/all/:input[?refresh=1]
router.get('/all/:input', async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    // Resolve input first so we have the username for hasPendingBrowserJob
    const resolved = resolveInstagramInput(req.params.input);
    if (!resolved.username) {
      const e = new Error(resolved.message || 'Please paste a profile username or link.');
      e.status = 400; throw e;
    }
    const { data, cached } = await resolveAndLoad(req.params.input, { forceRefresh });
    const status  = httpStatusFor(data);
    const pending = data.backgroundLoading && hasPendingBrowserJob(resolved.username);
    res.status(status).json({
      ...data,
      backgroundLoading: pending,
      meta: metaBlock(cached),
      ...(pending ? { pollAfterMs: 14000 } : {})
    });
  } catch (err) {
    next(err);
  }
});

// Individual section routes — share the same load logic, return subset
const SECTION_ROUTES = ['profile', 'stories', 'highlights', 'posts', 'reels'];

SECTION_ROUTES.forEach(section => {
  router.get(`/${section}/:input`, async (req, res, next) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      const { data, cached } = await resolveAndLoad(req.params.input, { forceRefresh });
      const body = {
        success: true,
        status: data.status,
        source: data.source,
        fetchedAt: data.fetchedAt,
        profile: data.profile,
        meta: metaBlock(cached)
      };
      if (section !== 'profile') {
        body[section] = data[section];
      }
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
});

module.exports = router;
