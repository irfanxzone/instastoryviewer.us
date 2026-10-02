'use strict';

const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');

// TTLs from env — env var names match .env.example
const freshTtlMs = Number(process.env.CACHE_TTL_SECONDS || 900) * 1000;
const staleTtlMs = Number(process.env.STALE_CACHE_TTL_SECONDS || 86400) * 1000;
const emptyStoriesTtlMs = Number(process.env.EMPTY_STORIES_TTL_SECONDS || 120) * 1000;
const providerFailureTtlMs = Number(process.env.PROVIDER_FAILURE_CACHE_TTL_SECONDS || 30) * 1000;
const storyLifetimeMs = 24 * 60 * 60 * 1000;

// Vercel's filesystem is read-only — /tmp is the only writable directory
const defaultCachePath = process.env.VERCEL
  ? '/tmp/cache.json'
  : path.join(process.cwd(), 'src/storage/cache.json');

const cacheFile = process.env.CACHE_FILE
  ? path.resolve(process.cwd(), process.env.CACHE_FILE)
  : defaultCachePath;

// LRU keeps at most 5 000 entries in memory; they survive up to stale TTL
const memory = new LRUCache({ max: 5000, ttl: staleTtlMs });
let disk = {};

function loadDisk() {
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      disk = JSON.parse(raw) || {};
      // Hydrate LRU from disk so restarts keep warm cache
      for (const [key, value] of Object.entries(disk)) {
        memory.set(key, value);
      }
      console.log(`[cache] Loaded ${Object.keys(disk).length} entries from disk`);
    }
  } catch {
    disk = {};
  }
}

function saveDisk() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(disk, null, 2));
  } catch {}
}

function sanitizeStories(data, stale) {
  if (!data?.stories) return data;
  const now = Date.now();
  const original = data.stories.items || [];
  const checkedAt = Date.parse(data.stories.checkedAt || '');
  const items = original.filter(item => {
    const takenAt = Date.parse(item?.timestamp || '');
    if (Number.isFinite(takenAt)) return takenAt + storyLifetimeMs > now;
    if (Number.isFinite(checkedAt)) return checkedAt + storyLifetimeMs > now;
    return !stale;
  });
  if (items.length === original.length) return data;
  return {
    ...data,
    stories: {
      ...data.stories,
      available: items.length > 0,
      items,
      state: items.length ? data.stories.state : 'EMPTY',
      message: items.length ? undefined : 'No active Stories in the last 24 hours.'
    }
  };
}

/**
 * @param {string} key
 * @param {{ allowStale?: boolean }} opts
 * @returns {{ hit: boolean, stale: boolean, ageMs: number, data: object } | null}
 */
function getCache(key, { allowStale = true } = {}) {
  let item = memory.get(key) || disk[key];
  if (!item) {
    try {
      const latest = JSON.parse(fs.readFileSync(cacheFile, 'utf8') || '{}');
      item = latest[key];
      if (item) {
        disk[key] = item;
        memory.set(key, item);
      }
    } catch {}
  }
  if (!item || !item.savedAt || !item.data) return null;

  const ageMs = Date.now() - item.savedAt;

  // Don't serve cached error shells (no profile id and status is error)
  const d = item.data;
  if (d?.status === 'ERROR' || (d && !d.success)) return null;

  const storyState = item.data?.stories?.state;
  const effectiveFreshTtl = storyState === 'EMPTY'
    ? Math.min(freshTtlMs, emptyStoriesTtlMs)
    : ['TEMPORARILY_UNAVAILABLE', 'RATE_LIMITED'].includes(storyState)
      ? Math.min(freshTtlMs, providerFailureTtlMs)
      : freshTtlMs;

  if (ageMs <= effectiveFreshTtl) {
    return { hit: true, stale: false, ageMs, data: sanitizeStories(item.data, false) };
  }
  if (allowStale && ageMs <= staleTtlMs) {
    return { hit: true, stale: true, ageMs, data: sanitizeStories(item.data, true) };
  }
  return null;
}

/**
 * @param {string} key
 * @param {object} data  Normalized profile data object
 */
function setCache(key, data) {
  // Don't cache failed or empty responses
  if (!data || !data.success) return;
  const item = { savedAt: Date.now(), data };
  memory.set(key, item);
  disk[key] = item;
  saveDisk();
}

function setCacheMerged(key, data) {
  if (!data || !data.success) return;
  const previous = (memory.get(key) || disk[key])?.data;
  if (!previous?.success) {
    setCache(key, data);
    return;
  }

  const merged = { ...previous, ...data };
  for (const section of ['highlights', 'posts', 'reels']) {
    const oldSection = previous[section];
    const newSection = data[section];
    const oldCount = oldSection?.items?.length || 0;
    const newCount = newSection?.items?.length || 0;
    merged[section] = newSection && newCount >= oldCount ? newSection : oldSection;
  }

  const newStories = data.stories;
  const storiesAreAuthoritative = ['AVAILABLE', 'EMPTY', 'PRIVATE'].includes(newStories?.state);
  merged.stories = storiesAreAuthoritative
    ? newStories
    : (previous.stories?.items?.length ? previous.stories : newStories || previous.stories);

  merged.profile = { ...(previous.profile || {}) };
  const incomingProfileReliable = Boolean(data.profile?.id) || !previous.profile?.id;
  if (incomingProfileReliable) {
    for (const [field, value] of Object.entries(data.profile || {})) {
      if (value !== null && value !== undefined && value !== '') merged.profile[field] = value;
    }
  }
  setCache(key, merged);
}

function deleteCache(key) {
  memory.delete(key);
  delete disk[key];
  saveDisk();
}

loadDisk();

module.exports = { getCache, setCache, setCacheMerged, deleteCache };
