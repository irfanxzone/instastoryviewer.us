'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeProfileUser, normalizeMetaOnly } = require('./instagramNormalizer');
const { setCache } = require('./cacheService');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STEALTH = `
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
`;

const DEFAULT_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const BAD_URL_PARTS = [
  '/accounts/login',
  '/accounts/challenge',
  '/accounts/suspended',
  '/accounts/scraping_warning'
];

let pptr = null;
let chromePath = null;
let workers = null;

function findChrome() {
  const envPath = process.env.CHROME_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  return DEFAULT_CHROME.find(p => fs.existsSync(p)) || null;
}

function decodeValue(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

function sessionTail(sessionId) {
  return String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-5) || 'empty';
}

function proxyTail(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return `${u.hostname}:${u.port}`;
  } catch {
    return 'invalid-proxy';
  }
}

function normalizeProxy(rawProxy) {
  const raw = String(rawProxy || '').trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    u.protocol = 'http:';
    return u.toString();
  }

  const parts = raw.split(':');
  if (parts.length < 4) throw new Error('Proxy must be host:port:user:pass or http://user:pass@host:port');
  const [host, port, user, ...passParts] = parts;
  const pass = passParts.join(':');
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function parseWorkers() {
  const raw = process.env.IG_WORKERS || '';
  const entries = raw
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);

  return entries.map((entry, index) => {
    const sep = entry.indexOf('|');
    if (sep < 0) throw new Error(`IG_WORKERS entry ${index + 1} is missing "|"`);

    const sessionId = decodeValue(entry.slice(0, sep).trim());
    const proxyUrl = normalizeProxy(entry.slice(sep + 1).trim());
    const dsUserId = sessionId.split(':')[0] || '';
    const id = `w${index + 1}-${sessionTail(sessionId)}`;

    return {
      id,
      index,
      sessionId,
      dsUserId,
      proxyUrl,
      proxyAuth: getProxyAuth(proxyUrl),
      proxyServer: getProxyServer(proxyUrl),
      userDataDir: path.join(process.cwd(), '.chrome-data-ig-workers', id),
      busy: false,
      failedUntil: 0,
      failures: 0,
      browser: null,
      launching: null
    };
  });
}

function getWorkers() {
  if (workers) return workers;
  try {
    workers = parseWorkers();
    if (workers.length) {
      console.log(`[ig-workers] Loaded ${workers.length} worker(s)`);
    }
  } catch (err) {
    console.warn(`[ig-workers] Could not parse IG_WORKERS: ${err.message}`);
    workers = [];
  }
  return workers;
}

function hasWorkers() {
  return getWorkers().length > 0;
}

function getProxyServer(proxyUrl) {
  const u = new URL(proxyUrl);
  return `${u.protocol}//${u.hostname}:${u.port}`;
}

function getProxyAuth(proxyUrl) {
  const u = new URL(proxyUrl);
  if (!u.username) return null;
  return {
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || '')
  };
}

function isBadInstagramUrl(url) {
  return BAD_URL_PARTS.some(part => String(url || '').includes(part));
}

function isWorkerHealthy(worker) {
  return !worker.busy && Date.now() >= worker.failedUntil;
}

function workerOrder(excludedIds = new Set()) {
  const list = getWorkers().filter(w => !excludedIds.has(w.id));
  const preferredRaw = Number(process.env.IG_WORKER_PREFERRED_INDEX || 2);
  const preferredIndex = Number.isFinite(preferredRaw) ? preferredRaw - 1 : 1;

  return list.sort((a, b) => {
    const ap = a.index === preferredIndex ? 0 : 1;
    const bp = b.index === preferredIndex ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.failedUntil !== b.failedUntil) return a.failedUntil - b.failedUntil;
    if (a.failures !== b.failures) return a.failures - b.failures;
    return a.index - b.index;
  });
}

async function acquireWorker(username, excludedIds = new Set()) {
  const timeoutMs = Number(process.env.IG_WORKER_ACQUIRE_TIMEOUT_MS || 45000);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const worker = workerOrder(excludedIds).find(isWorkerHealthy);
    if (worker) {
      worker.busy = true;
      console.log(`[ig-workers] Acquired ${worker.id} for @${username}`);
      return worker;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return null;
}

function releaseWorker(worker) {
  if (worker) worker.busy = false;
}

function pauseWorker(worker, reason) {
  const cooldownMs = Number(process.env.IG_WORKER_FAILURE_COOLDOWN_MS || 600000);
  worker.failures += 1;
  worker.failedUntil = Date.now() + cooldownMs;
  console.warn(`[ig-workers] Paused ${worker.id} for ${Math.round(cooldownMs / 1000)}s: ${reason}`);
}

async function ensureRuntime() {
  if (!pptr) pptr = require('puppeteer-core');
  if (!chromePath) chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found. Set CHROME_EXECUTABLE_PATH.');
}

async function getBrowser(worker) {
  await ensureRuntime();
  if (worker.browser && worker.browser.connected) return worker.browser;
  if (worker.launching) return worker.launching;

  fs.mkdirSync(worker.userDataDir, { recursive: true });
  console.log(`[ig-workers] Launching Chrome for ${worker.id} via ${proxyTail(worker.proxyUrl)}`);

  worker.launching = pptr.launch({
    headless: true,
    executablePath: chromePath,
    userDataDir: worker.userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--disable-extensions',
      '--window-size=1440,900',
      '--lang=en-US,en',
      `--proxy-server=${worker.proxyServer}`
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 30000
  }).then(browser => {
    worker.browser = browser;
    worker.launching = null;
    browser.on('disconnected', () => { worker.browser = null; });
    return browser;
  }).catch(err => {
    worker.launching = null;
    throw err;
  });

  return worker.launching;
}

async function openWorkerPage(worker) {
  const browser = await getBrowser(worker);
  const page = await browser.newPage();
  if (worker.proxyAuth) await page.authenticate(worker.proxyAuth);
  await page.evaluateOnNewDocument(STEALTH);
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

async function resetInstagramCookies(page, worker) {
  const urls = ['https://www.instagram.com', 'https://instagram.com'];
  for (const url of urls) {
    const cookies = await page.cookies(url).catch(() => []);
    const igCookies = cookies
      .filter(c => String(c.domain || '').includes('instagram.com'))
      .map(c => ({ name: c.name, domain: c.domain, path: c.path || '/' }));
    if (igCookies.length) await page.deleteCookie(...igCookies).catch(() => {});
  }

  const cookies = [
    { name: 'sessionid', value: worker.sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    { name: 'ds_user_id', value: worker.dsUserId, domain: '.instagram.com', path: '/', httpOnly: false, secure: true }
  ].filter(c => c.value);
  await page.setCookie(...cookies);
}

function buildSyntheticUser(rawUser, accPosts, accReels, totalCount, stories, highlights) {
  return {
    ...rawUser,
    _stories: stories || rawUser._stories || [],
    _highlights: highlights || rawUser._highlights || [],
    edge_owner_to_timeline_media: {
      count: totalCount || rawUser.edge_owner_to_timeline_media?.count || accPosts.length,
      edges: accPosts.map(n => ({ node: n }))
    },
    edge_felix_video_timeline: {
      edges: accReels.map(n => ({ node: n }))
    }
  };
}

const WORKER_IN_PAGE_SCRIPT = async function(username) {
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  const headers = {
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRFToken': csrf,
    'X-Instagram-AJAX': '1',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `https://www.instagram.com/${username}/`
  };

  async function getJson(url) {
    try {
      const res = await fetch(url, { headers, credentials: 'include' });
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, error: err.message, data: null };
    }
  }

  function storyItems(data, userId) {
    return (
      data?.reels_media?.[0]?.items ||
      data?.reels?.[String(userId)]?.items ||
      data?.story?.items ||
      data?.items ||
      []
    );
  }

  const init = await getJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const user = init.data?.data?.user || init.data?.data?.xdt_api__v1__users__web_profile_info?.user || init.data?.user;
  if (!user || (!user.username && !user.id)) {
    return { ok: false, finalUrl: location.href, profileStatus: init.status };
  }

  const uid = user.id || user.pk;
  const totalPosts = user.edge_owner_to_timeline_media?.count || user.media_count || 0;
  const stories = [];
  const posts = [];
  const reels = [];
  const highlights = [];

  async function snapshot(done) {
    if (!window.igWorkerSnapshot) return;
    await window.igWorkerSnapshot({ user, posts, reels, stories, highlights, totalPosts, done: Boolean(done) });
  }

  const storyEndpoints = [
    `/api/v1/feed/reels_media/?reel_ids=${uid}`,
    `/api/v1/feed/user_story/?user_id=${uid}`,
    `/api/v1/user/${uid}/story/`
  ];

  for (const endpoint of storyEndpoints) {
    const response = await getJson(endpoint);
    const items = storyItems(response.data, uid);
    if (window.igStoryLog) await window.igStoryLog({ endpoint, status: response.status, count: items.length });
    if (items.length) {
      stories.push(...items);
      break;
    }
  }
  await snapshot(false);

  const embeddedEdges = user.edge_owner_to_timeline_media?.edges || [];
  const seenIds = new Set();
  for (const edge of embeddedEdges) {
    const node = edge.node || edge;
    if (node?.id) seenIds.add(node.id);
    if (node) posts.push(node);
  }

  let nextMaxId = user.edge_owner_to_timeline_media?.page_info?.end_cursor || null;
  let moreAvail = true;
  let pageNum = 0;

  while (moreAvail && pageNum < 50) {
    pageNum += 1;
    const url = nextMaxId
      ? `/api/v1/feed/user/${uid}/?count=12&max_id=${encodeURIComponent(nextMaxId)}`
      : `/api/v1/feed/user/${uid}/?count=12`;
    const feed = await getJson(url);
    const items = feed.data?.items || [];
    if (!items.length) break;
    for (const item of items) {
      if (item?.id && seenIds.has(item.id)) continue;
      if (item?.id) seenIds.add(item.id);
      posts.push(item);
    }
    if (pageNum === 1 || pageNum % 5 === 0) await snapshot(false);
    nextMaxId = feed.data?.next_max_id;
    moreAvail = Boolean(feed.data?.more_available && nextMaxId);
  }

  const initReels = (user.edge_felix_video_timeline?.edges || []).map(e => e.node || e).filter(Boolean);
  reels.push(...initReels);
  let reelMaxId = user.edge_felix_video_timeline?.page_info?.end_cursor;
  let reelMoreAvail = Boolean(user.edge_felix_video_timeline?.page_info?.has_next_page && reelMaxId);
  let reelPage = 0;

  while (reelMoreAvail && reelPage < 15) {
    reelPage += 1;
    const feed = await getJson(`/api/v1/clips/user/?user_id=${uid}&max_id=${encodeURIComponent(reelMaxId)}&count=12`);
    const items = (feed.data?.items || []).map(i => i.media || i).filter(Boolean);
    if (!items.length) break;
    reels.push(...items);
    if (reelPage === 1 || reelPage % 5 === 0) await snapshot(false);
    reelMaxId = feed.data?.paging_info?.max_id;
    reelMoreAvail = Boolean(feed.data?.paging_info?.more_available && reelMaxId);
  }

  const hlEdges = user.edge_highlight_reels?.edges || [];
  for (const edge of hlEdges.slice(0, 15)) {
    const node = edge.node || edge;
    const hid = String(node?.id || '').replace('highlight:', '');
    if (!hid) {
      if (node) highlights.push(node);
      continue;
    }
    const hData = await getJson(`/api/v1/highlights/${hid}/highlights_media/`);
    const items = hData.data?.reels?.['highlight:' + hid]?.items || hData.data?.reels?.[hid]?.items || [];
    highlights.push({ ...node, _items: items });
  }
  await snapshot(true);

  return {
    ok: true,
    finalUrl: location.href,
    user,
    posts,
    reels,
    stories,
    highlights,
    totalPosts,
    profileStatus: init.status
  };
};

async function fetchWithWorker(worker, username, cacheKey) {
  let page;
  try {
    page = await openWorkerPage(worker);
    await page.exposeFunction('igWorkerSnapshot', payload => {
      if (!cacheKey || !payload?.user) return;
      try {
        const synthetic = buildSyntheticUser(
          payload.user,
          payload.posts || [],
          payload.reels || [],
          payload.totalPosts || 0,
          payload.stories || [],
          payload.highlights || []
        );
        const result = normalizeProfileUser(synthetic, 'instagram_worker_browser');
        if (!payload.done) {
          result.backgroundLoading = true;
          result.loadingProgress = {
            postsLoaded: result.posts?.items?.length || 0,
            postsTotal: payload.totalPosts || result.posts?.items?.length || 0,
            reelsLoaded: result.reels?.items?.length || 0
          };
        }
        setCache(cacheKey, result);
      } catch (err) {
        console.warn(`[ig-workers] ${worker.id} cache snapshot failed: ${err.message}`);
      }
    });
    await page.exposeFunction('igStoryLog', ({ endpoint, status, count }) => {
      const pathOnly = String(endpoint || '').split('?')[0];
      console.log(`[ig-story] ${worker.id} ${pathOnly} -> ${status}, items=${count}`);
    });

    await resetInstagramCookies(page, worker);
    console.log(`[browser] Worker ${worker.id} owns @${username}`);

    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    const finalUrl = page.url();
    if (isBadInstagramUrl(finalUrl)) {
      const err = new Error(`bad Instagram redirect: ${finalUrl}`);
      err.badWorker = true;
      throw err;
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
    const payload = await page.evaluate(WORKER_IN_PAGE_SCRIPT, username);

    if (isBadInstagramUrl(payload?.finalUrl || page.url())) {
      const err = new Error(`bad Instagram redirect: ${payload?.finalUrl || page.url()}`);
      err.badWorker = true;
      throw err;
    }

    if (!payload?.ok || !payload.user) {
      const html = await page.content();
      return normalizeMetaOnly(username, html);
    }

    const synthetic = buildSyntheticUser(
      payload.user,
      payload.posts || [],
      payload.reels || [],
      payload.totalPosts || 0,
      payload.stories || [],
      payload.highlights || []
    );
    const result = normalizeProfileUser(synthetic, 'instagram_worker_browser');
    if (cacheKey && result.success && result.stories?.items?.length) {
      setCache(cacheKey, result);
    }

    console.log(`[browser] @${username} done: ${result.posts?.items?.length || 0} posts, ${result.reels?.items?.length || 0} reels, ${result.stories?.items?.length || 0} stories`);
    return result;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

function hasProfileOrMedia(result) {
  return Boolean(
    result?.profile?.username ||
    result?.posts?.items?.length ||
    result?.reels?.items?.length
  );
}

function storyCount(result) {
  return result?.stories?.items?.length || 0;
}

async function fetchViaIgWorkers(username, cacheKey = null) {
  if (!hasWorkers()) return null;

  const maxAttempts = Math.min(
    Number(process.env.IG_WORKER_FETCH_ATTEMPTS || 3),
    getWorkers().length
  );
  const attempted = new Set();
  let bestResult = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const worker = await acquireWorker(username, attempted);
    if (!worker) break;
    attempted.add(worker.id);

    try {
      const result = await fetchWithWorker(worker, username, cacheKey);
      if (storyCount(result) > 0) return result;

      if (hasProfileOrMedia(result)) {
        bestResult = bestResult || result;
        if (attempt < maxAttempts - 1) {
          console.log(`[ig-workers] @${username} returned 0 stories with ${worker.id}; retrying another worker`);
          continue;
        }
      } else if (!bestResult) {
        bestResult = result;
      }
    } catch (err) {
      if (err.badWorker) {
        pauseWorker(worker, err.message);
      } else {
        console.warn(`[ig-workers] ${worker.id} failed @${username}: ${err.message}`);
      }
    } finally {
      releaseWorker(worker);
    }
  }

  if (bestResult) {
    console.log(`[ig-workers] @${username} final: ${bestResult.posts?.items?.length || 0} posts, ${bestResult.reels?.items?.length || 0} reels, ${bestResult.stories?.items?.length || 0} stories`);
  }
  return bestResult;
}

async function warmupIgWorkers() {
  if (!hasWorkers()) return;
  await ensureRuntime().catch(err => {
    console.warn(`[ig-workers] Warmup skipped: ${err.message}`);
  });
}

module.exports = {
  hasWorkers,
  fetchViaIgWorkers,
  warmupIgWorkers,
  normalizeProxy
};
