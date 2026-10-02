'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.OPENHANDLE_API_KEY = 'test-key';
process.env.CACHE_FILE = path.join(os.tmpdir(), `instastoryviewer-cache-test-${process.pid}.json`);

const axios = require('axios');
const calls = [];
axios.get = async (url, config) => {
  calls.push({ url, freshness: config.params?.freshness });
  if (url.endsWith('/stories')) {
    return {
      status: 200,
      headers: {},
      data: {
        capturedAt: new Date().toISOString(),
        data: [{
          id: 'story-1',
          code: 'story-code',
          createdAt: new Date().toISOString(),
          media: [{ type: 'video', url: 'https://cdn.example/story.mp4', thumbnail: { url: 'https://cdn.example/story.jpg' } }]
        }]
      }
    };
  }
  if (url.endsWith('/posts') || url.endsWith('/reels')) {
    return {
      status: 200,
      headers: {},
      data: {
        data: [{
          id: 'media-1',
          code: 'media-code',
          type: url.endsWith('/reels') ? 'reel' : 'image',
          media: [{ type: url.endsWith('/reels') ? 'video' : 'image', url: 'https://cdn.example/media' }]
        }]
      }
    };
  }
  return {
    status: 200,
    headers: {},
    data: {
      data: {
        id: '123',
        handle: 'example',
        displayName: 'Example User',
        bio: 'Real biography',
        avatar: { url: 'https://cdn.example/avatar.jpg' },
        metrics: { followers: 12000, following: 42, posts: 9 }
      }
    }
  };
};

async function run() {
  const openHandle = require('../services/openHandleService');
  const profile = await openHandle.fetchProfileViaOpenHandle('example');
  const stories = await openHandle.fetchStoriesViaOpenHandle('example');
  const posts = await openHandle.fetchMediaViaOpenHandle('example', 'posts');
  const reels = await openHandle.fetchMediaViaOpenHandle('example', 'reels');

  assert.strictEqual(profile.id, '123');
  assert.strictEqual(profile.fullName, 'Example User');
  assert.strictEqual(profile.followers, 12000);
  assert.strictEqual(stories.state, 'AVAILABLE');
  assert.strictEqual(stories.items[0].videoUrl, 'https://cdn.example/story.mp4');
  assert.strictEqual(posts.items[0].type, 'image');
  assert.strictEqual(reels.items[0].type, 'reel');
  assert(calls.some(call => call.url.endsWith('/stories') && call.freshness === 'live'));
  assert(calls.some(call => call.url.endsWith('/posts') && call.freshness === '24h'));

  const { setCache, setCacheMerged, getCache } = require('../services/cacheService');
  const key = 'all:hybrid-v4:example';
  const base = {
    success: true,
    status: 'PUBLIC_ACCOUNT',
    profile,
    stories,
    posts,
    reels,
    highlights: { available: false, items: [] }
  };
  setCache(key, base);
  setCacheMerged(key, {
    ...base,
    profile: { username: 'example', fullName: 'Instagram', id: null },
    stories: { available: false, items: [], state: 'TEMPORARILY_UNAVAILABLE' },
    posts: { available: false, items: [] }
  });

  const preserved = getCache(key);
  assert.strictEqual(preserved.data.profile.fullName, 'Example User');
  assert.strictEqual(preserved.data.stories.items.length, 1);
  assert.strictEqual(preserved.data.posts.items.length, 1);

  setCacheMerged(key, {
    ...base,
    stories: { available: false, items: [], state: 'EMPTY', checkedAt: new Date().toISOString() }
  });
  assert.strictEqual(getCache(key).data.stories.items.length, 0);
  console.log('Provider and cache self-test passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
