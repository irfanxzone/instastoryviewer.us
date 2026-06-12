'use strict';

const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');

// TTLs from env — env var names match .env.example
const freshTtlMs = Number(process.env.CACHE_TTL_SECONDS || 900) * 1000;
const staleTtlMs = Number(process.env.STALE_CACHE_TTL_SECONDS || 86400) * 1000;

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

/**
 * @param {string} key
 * @param {{ allowStale?: boolean }} opts
 * @returns {{ hit: boolean, stale: boolean, ageMs: number, data: object } | null}
 */
function getCache(key, { allowStale = true } = {}) {
  const item = memory.get(key) || disk[key];
  if (!item || !item.savedAt || !item.data) return null;

  const ageMs = Date.now() - item.savedAt;

  // Don't serve cached error shells (no profile id and status is error)
  const d = item.data;
  if (d?.status === 'ERROR' || (d && !d.success)) return null;

  if (ageMs <= freshTtlMs) {
    return { hit: true, stale: false, ageMs, data: item.data };
  }
  if (allowStale && ageMs <= staleTtlMs) {
    return { hit: true, stale: true, ageMs, data: item.data };
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

function deleteCache(key) {
  memory.delete(key);
  delete disk[key];
  saveDisk();
}

loadDisk();

module.exports = { getCache, setCache, deleteCache };
