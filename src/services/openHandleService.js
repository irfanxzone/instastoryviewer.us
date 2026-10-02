'use strict';

const axios = require('axios');
const { compactNumber } = require('../utils/formatters');

const BASE_URL = 'https://api.openhandle.dev/v1/instagram';
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function isConfigured() {
  return Boolean(String(process.env.OPENHANDLE_API_KEY || '').trim());
}

function formatStatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return number < 10000 ? number.toLocaleString('en-US') : compactNumber(number);
}

function retryDelayMs(value) {
  const max = Number(process.env.OPENHANDLE_MAX_RETRY_AFTER_MS || 10000);
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(max, Math.max(1000, seconds * 1000));
  const dateMs = Date.parse(String(value || ''));
  return Number.isFinite(dateMs) ? Math.min(max, Math.max(1000, dateMs - Date.now())) : 2000;
}

function providerError(response, resource) {
  const error = new Error(
    response.data?.error?.message || response.data?.message ||
    `OpenHandle ${resource} returned HTTP ${response.status}`
  );
  error.upstreamStatus = response.status;
  error.status = response.status === 404 ? 404 : response.status === 429 ? 429 : 503;
  error.provider = 'openhandle';
  error.rateLimited = response.status === 429;
  return error;
}

async function request(username, resource = '', freshness = '24h', retry = 0) {
  if (!isConfigured()) {
    const error = new Error('OpenHandle is not configured.');
    error.status = 503;
    error.provider = 'openhandle';
    throw error;
  }

  const suffix = resource ? `/${resource}` : '';
  let response;
  try {
    response = await axios.get(
      `${BASE_URL}/profiles/@${encodeURIComponent(username)}${suffix}`,
      {
        params: { freshness },
        headers: { Authorization: `Bearer ${String(process.env.OPENHANDLE_API_KEY).trim()}` },
        timeout: Number(process.env.OPENHANDLE_TIMEOUT_MS || 20000),
        proxy: false,
        validateStatus: () => true
      }
    );
  } catch {
    const error = new Error('OpenHandle is temporarily unavailable.');
    error.status = 503;
    error.provider = 'openhandle';
    throw error;
  }

  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 429 && retry === 0) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(response.headers['retry-after'])));
    return request(username, resource, freshness, 1);
  }
  throw providerError(response, resource || 'profile');
}

function firstMedia(item) {
  return item?.media?.[0] || item?.media || {};
}

function firstUrl(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && value) return value;
    if (value?.url) return value.url;
  }
  return '';
}

function normalizeStory(item) {
  if (!item || typeof item !== 'object') return null;
  const media = firstMedia(item);
  const isVideo = media.type === 'video' || Boolean(media.videoUrl || media.video_url);
  const directUrl = firstUrl(
    media.url, media.videoUrl, media.video_url, media.variants,
    item.url && !String(item.url).includes('instagram.com') ? item.url : ''
  );
  const thumbnail = firstUrl(media.thumbnail, media.firstFrame, media.image, item.thumbnail);
  const timestamp = item.createdAt || item.takenAt || media.createdAt || media.takenAt || null;
  const takenAt = Date.parse(timestamp || '');
  if (Number.isFinite(takenAt) && takenAt + STORY_LIFETIME_MS <= Date.now()) return null;

  return {
    id: item.id || media.id || null,
    shortcode: item.code || item.shortcode || null,
    type: 'story',
    thumbnail: thumbnail || (!isVideo ? directUrl : ''),
    displayUrl: isVideo ? thumbnail : directUrl,
    videoUrl: isVideo ? directUrl : null,
    caption: item.text || item.caption || '',
    timestamp,
    likes: Number(item.metrics?.likes || 0),
    comments: Number(item.metrics?.comments || 0),
    url: item.url || null
  };
}

function normalizeMedia(item, resource) {
  if (!item || typeof item !== 'object') return null;
  const media = firstMedia(item);
  const isVideo = media.type === 'video' || item.type === 'reel' || Boolean(media.videoUrl || media.video_url);
  const directUrl = firstUrl(media.url, media.videoUrl, media.video_url, media.variants);
  const thumbnail = firstUrl(media.thumbnail, media.firstFrame, media.image, item.thumbnail);
  return {
    id: item.id || media.id || null,
    shortcode: item.code || item.shortcode || null,
    type: resource === 'reels' ? 'reel' : item.type === 'carousel' ? 'carousel' : isVideo ? 'video' : 'image',
    thumbnail: thumbnail || (!isVideo ? directUrl : ''),
    displayUrl: isVideo ? thumbnail : directUrl,
    videoUrl: isVideo ? directUrl : null,
    caption: item.text || item.caption || '',
    timestamp: item.createdAt || item.takenAt || media.createdAt || null,
    likes: Number(item.metrics?.likes || 0),
    comments: Number(item.metrics?.comments || 0),
    url: item.url || null
  };
}

function normalizeProfile(data, requestedUsername) {
  if (!data || typeof data !== 'object') return null;
  const metrics = data.metrics || {};
  const followers = Number(metrics.followers || 0);
  const following = Number(metrics.following || 0);
  const postsCount = Number(metrics.posts || 0);
  const username = data.handle || requestedUsername;
  return {
    id: data.id || null,
    username,
    fullName: data.displayName || '',
    avatar: firstUrl(data.avatar?.url, data.avatar?.variants, data.avatar?.thumbnail),
    bio: data.bio || '',
    externalUrl: data.externalUrl || data.bioLinks?.[0]?.url || '',
    followers,
    followersText: formatStatNumber(followers),
    following,
    followingText: formatStatNumber(following),
    postsCount,
    postsCountText: postsCount.toLocaleString('en-US'),
    isPrivate: Boolean(data.isPrivate),
    isVerified: Boolean(data.isVerified),
    category: data.category || '',
    instagramUrl: data.url || `https://www.instagram.com/${username}/`
  };
}

function responseItems(response, resource) {
  if (!Array.isArray(response.data?.data)) {
    const error = new Error(`OpenHandle returned malformed ${resource} data.`);
    error.status = 502;
    error.provider = 'openhandle';
    throw error;
  }
  return response.data.data;
}

async function fetchProfileViaOpenHandle(username) {
  const response = await request(username);
  const profile = normalizeProfile(response.data?.data, username);
  if (!profile?.username || !profile.id) {
    const error = new Error('OpenHandle returned an incomplete profile.');
    error.status = 502;
    error.provider = 'openhandle';
    throw error;
  }
  console.log(`[openhandle:profile] @${username}: id=yes`);
  return profile;
}

async function fetchStoriesViaOpenHandle(username) {
  const response = await request(username, 'stories', 'live');
  const items = responseItems(response, 'Stories').map(normalizeStory).filter(Boolean);
  console.log(`[openhandle:stories] @${username}: items=${items.length}`);
  return {
    available: items.length > 0,
    items,
    source: 'openhandle',
    checkedAt: response.data?.capturedAt || new Date().toISOString(),
    state: items.length ? 'AVAILABLE' : 'EMPTY',
    message: items.length ? undefined : 'No active Stories in the last 24 hours.'
  };
}

async function fetchMediaViaOpenHandle(username, resource) {
  if (!['posts', 'reels'].includes(resource)) throw new Error('Unsupported OpenHandle media resource.');
  const response = await request(username, resource, '24h');
  const items = responseItems(response, resource).map(item => normalizeMedia(item, resource)).filter(Boolean);
  console.log(`[openhandle:${resource}:fallback] @${username}: items=${items.length}`);
  return {
    available: items.length > 0,
    items,
    source: 'openhandle_fallback',
    state: items.length ? 'AVAILABLE' : 'EMPTY',
    message: items.length ? undefined : `No ${resource} were returned for this public profile.`
  };
}

module.exports = {
  isConfigured,
  fetchProfileViaOpenHandle,
  fetchStoriesViaOpenHandle,
  fetchMediaViaOpenHandle,
  normalizeProfile,
  normalizeStory,
  normalizeMedia
};
