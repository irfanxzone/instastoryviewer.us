'use strict';

const fs   = require('fs');
const path = require('path');
const { normalizeProfileUser, normalizeMetaOnly } = require('./instagramNormalizer');
const { setCache } = require('./cacheService');
const proxyService = require('./proxyService');

// ─── Chrome detection ─────────────────────────────────────────────────────────
const DEFAULT_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findChrome() {
  const e = process.env.CHROME_EXECUTABLE_PATH;
  if (e && fs.existsSync(e)) return e;
  return DEFAULT_CHROME.find(p => fs.existsSync(p)) || null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STEALTH = `
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
`;
const CHROME_DATA = path.join(process.cwd(), '.chrome-data');

// ─── Persistent browser singleton ────────────────────────────────────────────
let _pptr = null, _chromePath = null, _browser = null, _launching = null;

function browserReady() { return _browser && _browser.connected; }

function getProxyArgs() {
  const proxyUrl = proxyService.getCurrentProxy();
  if (!proxyUrl) return { args: [], auth: null };
  try {
    const u = new URL(proxyUrl);
    return {
      args: [`--proxy-server=${u.hostname}:${u.port}`],
      auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : null
    };
  } catch { return { args: [], auth: null }; }
}

let _proxyAuth = null;

async function getBrowser() {
  if (browserReady()) return _browser;
  if (_launching) return _launching;
  console.log('[browser] Launching persistent Chrome…');
  const { args: proxyArgs, auth } = getProxyArgs();
  _proxyAuth = auth;
  if (proxyArgs.length) console.log('[browser] Using proxy for Chrome');
  _launching = _pptr.launch({
    headless: true, executablePath: _chromePath, userDataDir: CHROME_DATA,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled',
           '--disable-features=IsolateOrigins,site-per-process',
           '--disable-infobars','--disable-extensions','--window-size=1440,900','--lang=en-US,en',
           ...proxyArgs],
    ignoreDefaultArgs: ['--enable-automation'], timeout: 30000
  }).then(b => {
    _browser = b; _launching = null;
    b.on('disconnected', () => { _browser = null; console.log('[browser] Chrome disconnected — will relaunch'); });
    console.log('[browser] Chrome ready (persistent)');
    return b;
  }).catch(err => { _launching = null; throw err; });
  return _launching;
}

async function openPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  if (_proxyAuth) await page.authenticate(_proxyAuth);
  await page.evaluateOnNewDocument(STEALTH);
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// ─── Warmup ───────────────────────────────────────────────────────────────────
async function warmupBrowser() {
  if (process.env.ENABLE_BROWSER_FALLBACK !== 'true') return;
  try { _pptr = require('puppeteer-core'); } catch { console.warn('[browser] puppeteer-core not installed'); return; }
  _chromePath = findChrome();
  if (!_chromePath) { console.warn('[browser] Chrome not found — set CHROME_EXECUTABLE_PATH in .env'); return; }
  try {
    const page = await openPage();
    // Inject session on warmup so cookies are stored in the persistent profile
    const sessionId = getSessionId();
    if (sessionId) {
      await page.setCookie({ name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true });
      console.log('[browser] Session cookie injected during pre-warm');
    }
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.close();
    console.log('[browser] Pre-warm complete — ready for requests ✓');
  } catch (err) { console.warn('[browser] Pre-warm error:', err.message); }
}

// ─── Helper — builds a synthetic user object from accumulated batches ─────────
function buildSyntheticUser(rawUser, accPosts, accReels, totalCount) {
  return {
    ...rawUser,
    edge_owner_to_timeline_media: {
      count: totalCount || accPosts.length,
      edges: accPosts.map(n => ({ node: n }))
    },
    edge_felix_video_timeline: {
      edges: accReels.map(n => ({ node: n }))
    }
  };
}

// ─── In-page progressive script ───────────────────────────────────────────────
// Runs inside real Chrome with Instagram's session cookies.
// Calls window.igBatch() after EVERY paginated batch so Node.js can write
// results to cache immediately — frontend gets more posts with each poll.
const IN_PAGE_SCRIPT = async function(username) {
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  const H = {
    'X-IG-App-ID':'936619743392459','X-ASBD-ID':'129477','X-Requested-With':'XMLHttpRequest',
    'X-CSRFToken':csrf,'X-Instagram-AJAX':'1','Accept':'application/json, text/plain, */*',
    'Accept-Language':'en-US,en;q=0.9','Referer':`https://www.instagram.com/${username}/`
  };
  async function GET(url) {
    try { const r=await fetch(url,{headers:H,credentials:'include'}); return r.ok?r.json():null; }
    catch { return null; }
  }

  // ── Profile ───────────────────────────────────────────────────────────────
  const init = await GET(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const user = init?.data?.user || init?.data?.xdt_api__v1__users__web_profile_info?.user || init?.user;
  if (!user || (!user.username && !user.id)) return { ok: false };
  const uid        = user.id || user.pk;
  const totalPosts = user.edge_owner_to_timeline_media?.count || 0;

  // Report the initial user profile immediately
  await window.igBatch({ type: 'init', user, totalCount: totalPosts, moreAvail: totalPosts > 0 });

  // ── Stories — fetch FIRST (before the long post loop) ─────────────────────
  // Must run early so they appear quickly; post pagination can take minutes.
  try {
    const storyEndpoints = [
      `/api/v1/feed/reels_media/?reel_ids=${uid}`,
      `/api/v1/feed/user_story/?user_id=${uid}`,
      `/api/v1/user/${uid}/story/`
    ];
    for (const ep of storyEndpoints) {
      const d = await GET(ep).catch(() => null);
      if (!d) continue;
      const items =
        d.reels_media?.[0]?.items ||
        d.reels?.[String(uid)]?.items ||
        d.story?.items ||
        d.items ||
        [];
      if (items.length) {
        await window.igBatch({ type: 'stories', items, moreAvail: false });
        break;
      }
    }
  } catch {}

  // ── Posts — ALL pages ─────────────────────────────────────────────────────
  // Strategy:
  //  Authenticated session → web_profile_info returns no embedded posts/cursor,
  //    start mobile feed from page 1 (no max_id).
  //  Anonymous session → web_profile_info embeds 12 posts + cursor,
  //    report those first then continue from cursor.
  const embeddedEdges = user.edge_owner_to_timeline_media?.edges || [];
  const hasCursor     = !!user.edge_owner_to_timeline_media?.page_info?.end_cursor;
  const initCursor    = user.edge_owner_to_timeline_media?.page_info?.end_cursor;
  const seenIds       = new Set(embeddedEdges.map(e => (e.node||e)?.id).filter(Boolean));

  // Report embedded posts if present (anonymous path)
  if (embeddedEdges.length > 0) {
    const initItems = embeddedEdges.map(e => e.node || e);
    await window.igBatch({ type: 'posts', items: initItems, totalCount: totalPosts, moreAvail: true });
  }

  // ALWAYS attempt to fetch — moreAvail starts true and the API response controls stopping.
  // This handles authenticated sessions where totalPosts may be 0 from web_profile_info
  // (Instagram omits media_count when a session is active).
  let nextMaxId = hasCursor ? initCursor : null;
  let moreAvail = true;   // always try — API returns empty items when truly done
  let pageNum   = 0;

  while (moreAvail && pageNum < 50) {
    pageNum++;
    const url = nextMaxId
      ? `/api/v1/feed/user/${uid}/?count=12&max_id=${encodeURIComponent(nextMaxId)}`
      : `/api/v1/feed/user/${uid}/?count=12`;
    const feed = await GET(url);
    if (!feed?.items?.length) break;   // API says no more → stop

    // Skip duplicates that were already in the embedded batch
    const newItems = (pageNum === 1 && !hasCursor && seenIds.size > 0)
      ? feed.items.filter(i => !seenIds.has(i.id))
      : feed.items;

    if (newItems.length) {
      await window.igBatch({ type: 'posts', items: newItems, totalCount: totalPosts, moreAvail: !!feed.more_available });
    }
    nextMaxId = feed.next_max_id;
    moreAvail = !!feed.more_available;   // API controls whether to continue
  }
  await window.igBatch({ type: 'posts_done', items: [], totalCount: totalPosts, moreAvail: false });

  // ── Reels — ALL pages ─────────────────────────────────────────────────────
  const initReels = (user.edge_felix_video_timeline?.edges || []).map(e => e.node || e);
  if (initReels.length) {
    await window.igBatch({ type: 'reels', items: initReels, moreAvail: true });
  }
  let reelMaxId     = user.edge_felix_video_timeline?.page_info?.end_cursor;
  let reelMoreAvail = user.edge_felix_video_timeline?.page_info?.has_next_page;
  let reelPage      = 0;

  while (reelMoreAvail && reelMaxId && reelPage < 15) {
    reelPage++;
    const feed = await GET(`/api/v1/clips/user/?user_id=${uid}&max_id=${encodeURIComponent(reelMaxId)}&count=12`);
    if (!feed?.items?.length) break;
    const items = feed.items.map(i => i.media || i);
    await window.igBatch({ type: 'reels', items, moreAvail: !!feed.paging_info?.more_available });
    reelMaxId     = feed.paging_info?.max_id;
    reelMoreAvail = feed.paging_info?.more_available;
  }

  // ── Highlights ────────────────────────────────────────────────────────────
  try {
    const hlEdges = user.edge_highlight_reels?.edges || [];
    const full = [];
    for (const edge of hlEdges.slice(0, 15)) {
      const node = edge.node || edge;
      const hid  = (node.id || '').replace('highlight:', '');
      if (!hid) { full.push(node); continue; }
      const hData = await GET(`/api/v1/highlights/${hid}/highlights_media/`).catch(() => null);
      const items = hData?.reels?.['highlight:'+hid]?.items || hData?.reels?.[hid]?.items || [];
      full.push({ ...node, _items: items });
    }
    if (full.length) await window.igBatch({ type: 'highlights', items: full, moreAvail: false });
  } catch {}

  await window.igBatch({ type: 'done', moreAvail: false, totalCount: totalPosts });
  return { ok: true };
};

// Safely decode URL-encoded session IDs (Instagram stores them URL-encoded)
function getSessionId() {
  const raw = process.env.INSTAGRAM_SESSION_ID || '';
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// ─── Main fallback function ───────────────────────────────────────────────────
async function fetchViaBrowserFallback(username, cacheKey = null) {
  if (process.env.ENABLE_BROWSER_FALLBACK !== 'true') return null;

  // Self-initialize if warmup never ran (e.g. warmup failed on startup)
  if (!_pptr) {
    try { _pptr = require('puppeteer-core'); }
    catch { console.warn('[browser] puppeteer-core not installed'); return null; }
  }
  if (!_chromePath) {
    _chromePath = findChrome();
    if (!_chromePath) { console.warn('[browser] Chrome not found'); return null; }
  }

  let page;
  try { page = await openPage(); }
  catch (err) { console.warn('[browser] Could not open page:', err.message); return null; }

  // Accumulate batches in Node.js scope
  const accPosts    = [];
  const accReels    = [];
  let   rawUser     = null;
  let   totalCount  = 0;
  let   jobDone     = false;   // only true after explicit 'done' signal

  try {
    // igBatch is called from browser JS after each pagination batch
    await page.exposeFunction('igBatch', payload => {
      try {
        const { type, user, items = [], totalCount: tc = 0, moreAvail = false } = payload;

        if (type === 'init' && user) {
          rawUser = user;
          totalCount = tc;
          // Include the first 12 posts that come with web_profile_info
          const initItems = (user.edge_owner_to_timeline_media?.edges || []).map(e => e.node || e);
          accPosts.push(...initItems);
        }
        else if (type === 'posts' && items.length) {
          accPosts.push(...items);
          if (tc) totalCount = tc;
        }
        else if (type === 'reels' && items.length) {
          accReels.push(...items);
        }
        else if (type === 'stories' && items.length && rawUser) {
          rawUser._stories = items;
        }
        else if (type === 'highlights' && items.length && rawUser) {
          rawUser._highlights = items;
        }
        else if (type === 'done') {
          jobDone = true;
        }

        // Write to cache after every batch so the frontend can poll for progress
        if (rawUser && cacheKey) {
          const synthetic = buildSyntheticUser(rawUser, accPosts, accReels, totalCount);
          const result    = normalizeProfileUser(synthetic, 'instagram_browser_fallback');
          // Stay in backgroundLoading until the explicit 'done' signal
          // (moreAvail alone is unreliable since totalPosts may be 0 with auth sessions)
          if (!jobDone) {
            result.backgroundLoading = true;
            result.loadingProgress   = {
              postsLoaded: accPosts.length,
              postsTotal:  totalCount || accPosts.length,
              reelsLoaded: accReels.length
            };
          }
          setCache(cacheKey, result);
          if (accPosts.length > 12) {
            console.log(`[browser] Cache updated: ${accPosts.length}/${totalCount || '?'} posts, ${accReels.length} reels`);
          }
        }
      } catch (e) { console.warn('[browser] igBatch error:', e.message); }
    });

    // Inject session cookie — unlocks stories, highlights and richer profile data.
    // sessionid must be URL-decoded before being set as a browser cookie.
    const sessionId = getSessionId();
    const dsUserId  = process.env.INSTAGRAM_DS_USER_ID || '';
    if (sessionId) {
      const cookies = [
        { name: 'sessionid',  value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true,  secure: true },
        { name: 'ds_user_id', value: dsUserId,  domain: '.instagram.com', path: '/', httpOnly: false, secure: true }
      ].filter(c => c.value);
      await page.setCookie(...cookies);
      console.log(`[browser] Session injected for @${username} (${sessionId.slice(0,8)}…)`);
    }

    console.log(`[browser] Fetching @${username}…`);
    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: 'domcontentloaded', timeout: 20000
    });

    // Wait up to 2s for network intercept to fire (Chrome's own JS hits web_profile_info)
    await new Promise(r => setTimeout(r, 2000));

    // Run the full in-page script: profile + ALL posts + ALL reels + stories + highlights
    await page.evaluate(IN_PAGE_SCRIPT, username).catch(err => {
      console.warn('[browser] Script error:', err.message);
    });

    // Build final result from accumulated data
    if (rawUser) {
      const synthetic = buildSyntheticUser(rawUser, accPosts, accReels, totalCount);
      const result    = normalizeProfileUser(synthetic, 'instagram_browser_fallback');
      console.log(`[browser] @${username} complete: ${accPosts.length} posts, ${accReels.length} reels, ${rawUser._stories?.length||0} stories`);
      return result;
    }

    const html = await page.content();
    return normalizeMetaOnly(username, html);

  } catch (err) {
    console.warn(`[browser] Error @${username}: ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});  // keep browser alive, close only the tab
  }
}

module.exports = { fetchViaBrowserFallback, warmupBrowser };
