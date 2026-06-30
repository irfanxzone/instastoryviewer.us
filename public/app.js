/* Instagram Anonymous Viewer */
'use strict';

const menuBtn        = document.getElementById('menuBtn');
const mobileMenu     = document.getElementById('mobileMenu');
const form           = document.getElementById('searchForm');
const inp            = document.getElementById('username');
const statusEl       = document.getElementById('status');
const resultsSection = document.getElementById('resultsSection');
const resultShell    = document.getElementById('resultShell');
const pasteBtn       = document.getElementById('pasteBtn');
const searchBtn      = document.getElementById('searchBtn');

if (menuBtn) menuBtn.addEventListener('click', () => mobileMenu.classList.toggle('open'));

function esc(v) {
  return String(v ?? '').replace(/[&<>'"]/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
function setStatus(msg) { if (statusEl) { statusEl.textContent = msg || ''; } }

// ─── Skeleton loaders ─────────────────────────────────────────────────────────
function skeletonGrid(n = 9) {
  return '<div class="media-grid">' +
    Array.from({ length: n }, () =>
      `<article class="media-card sk-card">
         <div class="sk-thumb shimmer"></div>
         <div class="media-body">
           <div class="sk-line shimmer"></div>
           <div class="sk-line shimmer sk-short"></div>
         </div>
       </article>`
    ).join('') + '</div>';
}
function storyDots() {
  return `<div class="story-dots-wrap">
    <div class="story-dots">${Array.from({length:11},(_,i)=>`<span class="story-dot" style="animation-delay:${i*.1}s"></span>`).join('')}</div>
    <p class="story-dots-label">Checking for active stories in the last 24 h…</p>
  </div>`;
}

// ─── Loading animation ────────────────────────────────────────────────────────
const STEPS = ['Opening Instagram…','Loading @{u}…','Fetching public data…','Applying results…'];
let loadTimer = null, stepIdx = 0, _searchUsername = '';

function startLoading(username) {
  _searchUsername = username;
  stepIdx = 0;
  resultsSection.hidden = false;
  resultShell.innerHTML = `<div class="loading-card"><div class="spinner"></div><strong id="lm">${esc(STEPS[0])}</strong></div>`;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus(STEPS[0]);
  if (loadTimer) clearInterval(loadTimer);
  loadTimer = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, STEPS.length - 1);
    const msg = STEPS[stepIdx].replace('{u}', _searchUsername);
    const el = document.getElementById('lm'); if (el) el.textContent = msg;
    setStatus(msg);
  }, 1600);
}
function stopLoading() { if (loadTimer) { clearInterval(loadTimer); loadTimer = null; } }

// ─── Modal ────────────────────────────────────────────────────────────────────
let mItems = [], mIdx = 0;
function openModal(items, idx) { mItems = items; mIdx = idx; buildModal(); }
function buildModal() {
  document.getElementById('igModal')?.remove();
  const item = mItems[mIdx]; if (!item) return;
  const isVid = item.type === 'video' || item.type === 'reel' || item.type === 'story';
  const src   = item.videoUrl || item.displayUrl || item.thumbnail || '';
  const media = isVid && item.videoUrl
    ? `<video class="modal-media" src="${esc(item.videoUrl)}" controls autoplay muted playsinline loop></video>`
    : src ? `<img class="modal-media" src="${esc(src)}" alt="media" referrerpolicy="no-referrer" />`
           : `<div class="modal-media modal-placeholder">No preview</div>`;
  const dlUrl = item.videoUrl || item.displayUrl || item.thumbnail || '';
  const igUrl = item.url || '';
  const m = document.createElement('div');
  m.id = 'igModal'; m.className = 'modal-overlay';
  m.innerHTML = `
    <div class="modal-box">
      <button class="modal-close" id="mC">✕</button>
      ${mIdx > 0 ? '<button class="modal-nav modal-prev" id="mP">&#8249;</button>' : ''}
      <div class="modal-content">
        ${media}
        ${item.caption ? `<p class="modal-caption">${esc(item.caption)}</p>` : ''}
        <div class="modal-actions">
          ${dlUrl ? `<a class="modal-btn" href="${esc(dlUrl)}" download target="_blank" rel="noopener">⬇ Download</a>` : ''}
          ${igUrl ? `<a class="modal-btn modal-btn-outline" href="${esc(igUrl)}" target="_blank" rel="noopener">Open on Instagram ↗</a>` : ''}
        </div>
        <div class="modal-counter">${mIdx+1} / ${mItems.length}</div>
      </div>
      ${mIdx < mItems.length-1 ? '<button class="modal-nav modal-next" id="mN">&#8250;</button>' : ''}
    </div>`;
  document.body.appendChild(m);
  m.querySelector('#mC')?.addEventListener('click', () => m.remove());
  m.querySelector('#mP')?.addEventListener('click', () => { mIdx--; buildModal(); });
  m.querySelector('#mN')?.addEventListener('click', () => { mIdx++; buildModal(); });
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  const onKey = e => {
    if (!document.getElementById('igModal')) { document.removeEventListener('keydown', onKey); return; }
    if (e.key==='Escape') m.remove();
    if (e.key==='ArrowLeft'  && mIdx>0)             { mIdx--; buildModal(); }
    if (e.key==='ArrowRight' && mIdx<mItems.length-1){ mIdx++; buildModal(); }
  };
  document.addEventListener('keydown', onKey);
}

// ─── Avatar fallback ──────────────────────────────────────────────────────────
const BLANK = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Crect width='240' height='240' fill='%23f0edf6'/%3E%3Ccircle cx='120' cy='88' r='40' fill='%23c8c0d5'/%3E%3Cpath d='M48 214c12-50 132-50 144 0' fill='%23c8c0d5'/%3E%3C/svg%3E`;

// ─── Render profile head (static — never re-renders after first paint) ─────────
let _renderedUsername = null;
function renderProfileHead(data) {
  const p = data.profile || {};
  _renderedUsername = p.username;
  const verBadge  = p.isVerified ? '<span class="badge ok">✓ Verified</span>' : '';
  const privBadge = p.isPrivate  ? '<span class="badge warn">🔒 Private</span>' : '';

  document.getElementById('ig-profile-head')?.remove();
  const head = document.createElement('div');
  head.id = 'ig-profile-head';
  head.innerHTML = `
    <div class="profile-head">
      <div class="avatar-wrap${p.isVerified ? ' avatar-verified' : ''}">
        <img class="avatar" src="${esc(p.avatar)||BLANK}" alt="${esc(p.username)}" referrerpolicy="no-referrer" onerror="this.src='${BLANK}'" />
      </div>
      <div class="profile-main">
        <h2>${esc(p.fullName || p.username || 'Instagram profile')}</h2>
        <div class="username-line"><span class="at-sign">@</span>${esc(p.username || '')}</div>
        <div class="badge-row">${verBadge}${privBadge}</div>
        ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
        ${p.category ? `<div class="profile-category">${esc(p.category)}</div>` : ''}
        <div class="action-row">
          ${p.instagramUrl ? `<a class="small-link" target="_blank" rel="noopener" href="${esc(p.instagramUrl)}">View on Instagram</a>` : ''}
          ${p.externalUrl  ? `<a class="small-link light" target="_blank" rel="noopener" href="${esc(p.externalUrl)}">${esc(p.externalUrl.replace(/^https?:\/\//,'').slice(0,36))}</a>` : ''}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><strong>${esc(String(p.postsCountText||p.postsCount||'—'))}</strong><span>Posts</span></div>
        <div class="stat"><strong>${esc(String(p.followersText||p.followers||'—'))}</strong><span>Followers</span></div>
        <div class="stat"><strong>${esc(String(p.followingText||p.following||'—'))}</strong><span>Following</span></div>
      </div>
    </div>`;
  resultShell.insertBefore(head, resultShell.firstChild);
}

// ─── Render tabs shell (only once) ───────────────────────────────────────────
function renderTabsShell() {
  if (document.getElementById('ig-tabs')) return;
  const tabs = document.createElement('div');
  tabs.id = 'ig-tabs';
  tabs.innerHTML = `
    <div class="tabs" role="tablist">
      <button class="tab active" data-panel="stories"    role="tab">Stories</button>
      <button class="tab"        data-panel="posts"      role="tab">Posts</button>
      <button class="tab"        data-panel="reels"      role="tab">Reels</button>
      <button class="tab"        data-panel="highlights" role="tab">Highlights</button>
    </div>
    <div class="panel active" id="panel-stories"></div>
    <div class="panel"        id="panel-posts"></div>
    <div class="panel"        id="panel-reels"></div>
    <div class="panel"        id="panel-highlights"></div>`;
  resultShell.appendChild(tabs);

  tabs.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tabs.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.panel}`)?.classList.add('active');
    });
  });
}

// ─── Update tab labels with counts ───────────────────────────────────────────
function updateTabLabel(panelKey, items) {
  const tab = document.querySelector(`.tab[data-panel="${panelKey}"]`);
  if (!tab) return;
  const LABELS = { posts:'Posts', reels:'Reels', stories:'Stories', highlights:'Highlights' };
  const label  = LABELS[panelKey] || panelKey;
  tab.innerHTML = items?.length ? `${label} <span class="tab-count">${items.length}</span>` : label;
}

// ─── Fill a single panel ──────────────────────────────────────────────────────
function fillPanel(panelKey, collection, label) {
  const el = document.getElementById(`panel-${panelKey}`);
  if (!el) return;
  el.innerHTML = renderCollection(collection, label, panelKey);
  updateTabLabel(panelKey, collection?.items);
  // Wire up modal clicks for the newly inserted cards
  el.querySelectorAll('.media-card[data-index]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const items = (window._igData?.[panelKey]?.items) || [];
      const idx   = parseInt(card.dataset.index, 10);
      if (items.length) openModal(items, idx);
    });
  });
}

// ─── Show skeleton placeholders while media loads ─────────────────────────────
function showSkeletons() {
  document.getElementById('panel-posts')?.replaceChildren(...[document.createRange().createContextualFragment(skeletonGrid(12))]);
  document.getElementById('panel-reels')?.replaceChildren(...[document.createRange().createContextualFragment(skeletonGrid(12))]);
  document.getElementById('panel-stories')?.replaceChildren(...[document.createRange().createContextualFragment(storyDots())]);
  document.getElementById('panel-highlights')?.replaceChildren(...[document.createRange().createContextualFragment(skeletonGrid(6))]);
}

// ─── Render collection ────────────────────────────────────────────────────────
function renderCollection(col, label, key) {
  const items = col?.items || [];
  const msg   = col?.message || '';
  if (!items.length) {
    const icon = msg.includes('private') ? '🔒' : msg.includes('24') ? '⭕' : '📭';
    return `<div class="empty-state"><div style="font-size:38px;margin-bottom:8px">${icon}</div><strong>No ${esc(label)}</strong><p>${esc(msg||`No ${label.toLowerCase()} found for this profile.`)}</p></div>`;
  }
  return `<div class="media-grid">${items.map((item,i) => mediaCard(item,i,key)).join('')}</div>`;
}

const TICON = { image:'📷', video:'🎬', carousel:'🖼', reel:'🎥', story:'⭕', highlight:'⭐' };
function mediaCard(item, idx, key) {
  const thumb = item.thumbnail || item.displayUrl || '';
  const isVid = item.type==='video'||item.type==='reel';
  const likes = Number(item.likes||0);
  const dlUrl = item.videoUrl||item.displayUrl||item.thumbnail||'';
  const igUrl = item.url||'';
  return `
    <article class="media-card" data-index="${idx}" data-collection="${esc(key)}" title="Click to view">
      <div class="thumb-wrap">
        ${thumb ? `<img class="media-thumb" src="${esc(thumb)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('thumb-err')" alt="" />` : `<div class="media-thumb"></div>`}
        ${isVid ? '<div class="play-badge">▶</div>' : ''}
      </div>
      <div class="media-body">
        <div class="media-meta">
          <span>${TICON[item.type]||'📷'} ${esc(item.type||'photo')}</span>
          ${likes>0 ? `<span>♥ ${likes.toLocaleString()}</span>` : ''}
        </div>
        ${item.caption ? `<p class="media-caption">${esc(item.caption)}</p>` : ''}
        <div class="card-actions">
          ${dlUrl ? `<a class="card-btn card-btn-dl" href="${esc(dlUrl)}" download target="_blank" rel="noopener">Download</a>` : ''}
          ${igUrl ? `<a class="card-btn card-btn-ig" href="${esc(igUrl)}" target="_blank" rel="noopener">↗</a>` : ''}
        </div>
      </div>
    </article>`;
}

// ─── Full render (called once with phase-1 data, then panels updated for phase-2) ──
window._igData = null;
function renderProfile(data, isUpdate = false) {
  stopLoading();
  window._igData = data;
  resultShell.hidden = false;

  if (!isUpdate) {
    resultShell.innerHTML = '';
    renderProfileHead(data);
    renderTabsShell();
    if (data.backgroundLoading) {
      showSkeletons();
    } else {
      fillPanel('posts',      data.posts,      'Posts');
      fillPanel('reels',      data.reels,      'Reels');
      fillPanel('stories',    data.stories,    'Stories');
      fillPanel('highlights', data.highlights, 'Highlights');
    }
  } else {
    // Smooth update — only replace panel contents, profile head stays
    renderProfileHead(data);  // refresh stats (postsCount may have updated)
    fillPanel('posts',      data.posts,      'Posts');
    fillPanel('reels',      data.reels,      'Reels');
    fillPanel('stories',    data.stories,    'Stories');
    fillPanel('highlights', data.highlights, 'Highlights');
  }
}

// ─── Error ────────────────────────────────────────────────────────────────────
function showError(msg) {
  stopLoading();
  resultsSection.hidden = false;
  resultShell.innerHTML = `<div class="panel active"><div class="error-box"><strong>Could not load profile</strong><br>${esc(msg)}</div></div>`;
  setStatus('Search failed.');
}

// ─── Two-phase search ─────────────────────────────────────────────────────────
let _currentUser = '';
async function runSearch(raw) {
  const value = raw.trim();
  if (!value) { setStatus('Enter a username or Instagram link.'); return; }
  searchBtn.disabled = true;

  try {
    // ── Resolve ──────────────────────────────────────────────────────────────
    startLoading(value);
    const rr = await fetch(`/api/ig/resolve?input=${encodeURIComponent(value)}`);
    const rd = await rr.json();
    if (!rr.ok || !rd.success) throw new Error(rd.error || 'Could not resolve this input.');
    if (!rd.resolved.username) throw new Error(rd.resolved.message || 'Paste a username or profile link.');

    const username = rd.resolved.username;
    _currentUser = username;
    setStatus(`Loading @${username}…`);

    // ── Phase 1: fast profile (meta / cached) ─────────────────────────────
    const r1 = await fetch(`/api/ig/all/${encodeURIComponent(username)}`);
    const d1  = await r1.json();
    if (!r1.ok || !d1.success) throw new Error(d1.error || 'Could not load Instagram data.');

    renderProfile(d1);

    if (d1.backgroundLoading) {
      setStatus(`@${username} profile loaded — fetching posts & media…`);
      pollForMedia(username, 3000);  // start polling every 3s immediately
    } else {
      const n = d1.posts?.items?.length || 0;
      setStatus(n > 0 ? `${n} posts loaded.` : 'Profile loaded.');
    }

  } catch (err) {
    showError(err.message);
  } finally {
    searchBtn.disabled = false;
    stopLoading();
  }
}

function pollForMedia(username, delay) {
  setTimeout(async () => {
    if (_currentUser !== username) return;
    try {
      const r = await fetch(`/api/ig/all/${encodeURIComponent(username)}`);
      const d = await r.json();
      if (!d.success) return;

      // Always refresh panels — even partial batches should show immediately
      const prevPosts = window._igData?.posts?.items?.length || 0;
      const newPosts  = d.posts?.items?.length || 0;

      if (newPosts > prevPosts || !d.backgroundLoading) {
        renderProfile(d, true);  // smooth panel-only update
      }

      if (d.backgroundLoading) {
        // Show live progress while paginating
        const prog = d.loadingProgress;
        if (prog?.postsTotal > 0) {
          setStatus(`Loading posts… ${prog.postsLoaded} of ${prog.postsTotal}`);
        } else {
          setStatus(`Fetching posts & reels for @${username}…`);
        }
        // Poll every 3s while loading — fast enough to feel live
        pollForMedia(username, 3000);
      } else {
        const posts  = d.posts?.items?.length  || 0;
        const reels  = d.reels?.items?.length  || 0;
        const stories = d.stories?.items?.length || 0;
        const parts  = [];
        if (posts)   parts.push(`${posts} posts`);
        if (reels)   parts.push(`${reels} reels`);
        if (stories) parts.push(`${stories} stories`);
        setStatus(parts.length ? `${parts.join(', ')} loaded.` : 'Profile loaded.');
      }
    } catch {
      // Silently retry
      pollForMedia(username, 5000);
    }
  }, delay);
}

// ─── Events ───────────────────────────────────────────────────────────────────
form.addEventListener('submit', e => { e.preventDefault(); runSearch(inp.value); });
if (pasteBtn) {
  pasteBtn.addEventListener('click', async () => {
    if (!navigator.clipboard) return;
    try { inp.value = await navigator.clipboard.readText(); inp.focus(); } catch {}
  });
}
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    // Close all others
    document.querySelectorAll('.faq-item.open').forEach(el => {
      el.classList.remove('open');
      el.querySelector('.faq-q')?.setAttribute('aria-expanded','false');
    });
    if (!isOpen) {
      item.classList.add('open');
      btn.setAttribute('aria-expanded','true');
    }
  });
});
