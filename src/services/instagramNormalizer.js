'use strict';

const { compactNumber } = require('../utils/formatters');

// Instagram uses compact above 10k (9,542 shown as "9,542", 1.2M shown as "1.2M")
function formatStatNumber(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return '0';
  if (num < 10000) return num.toLocaleString('en-US');  // exact: "9,542"
  return compactNumber(num);                             // compact: "665M"
}

// ─── CDN Proxy ────────────────────────────────────────────────────────────────
// Instagram CDN blocks cross-origin image loads from third-party domains.
// We route every CDN URL through our /api/proxy endpoint so the browser fetches
// media from our server (which adds the required Referer header).
function proxyUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const needsProxy =
    url.includes('cdninstagram.com') ||
    url.includes('fbcdn.net') ||
    (url.includes('.fna.fbcdn') || url.includes('scontent'));
  return needsProxy ? `/api/proxy?url=${encodeURIComponent(url)}` : url;
}

// ─── Media normalizer ─────────────────────────────────────────────────────────

function resolveMediaType(node) {
  // Explicit __typename from GraphQL
  if (node.__typename === 'GraphSidecar') return 'carousel';
  if (node.__typename === 'GraphVideo') return 'video';
  if (node.__typename === 'GraphImage') return 'image';
  // media_type numeric code (Instagram API v1)
  if (node.media_type === 8) return 'carousel';
  if (node.media_type === 2) return 'video';
  if (node.media_type === 1) return 'image';
  // product_type (Reels / Clips)
  if (node.product_type === 'clips' || node.media_product_type === 'CLIPS') return 'reel';
  // Fallback
  if (node.is_video) return 'video';
  return 'image';
}

function bestThumbnail(node) {
  return proxyUrl(
    node.thumbnail_src ||
    node.display_url ||
    node.image_versions2?.candidates?.[0]?.url ||
    node.thumbnail_url ||
    null
  );
}

function bestVideoUrl(node) {
  return proxyUrl(node.video_url || node.video_versions?.[0]?.url || null);
}

function mediaFromNode(rawNode, forceType) {
  const node = rawNode?.node || rawNode;
  if (!node) return null;

  const type = forceType || resolveMediaType(node);
  const shortcode = node.shortcode || node.code || null;
  const isReel = type === 'reel' || node.product_type === 'clips';
  const postPath = isReel ? 'reel' : 'p';
  const url = shortcode ? `https://www.instagram.com/${postPath}/${shortcode}/` : null;

  return {
    id: node.id || node.pk || null,
    shortcode,
    type,
    thumbnail: bestThumbnail(node),
    displayUrl: proxyUrl(node.display_url || node.image_versions2?.candidates?.[0]?.url || null),
    videoUrl: bestVideoUrl(node),
    caption:
      node.edge_media_to_caption?.edges?.[0]?.node?.text ||
      node.caption?.text ||
      (typeof node.caption === 'string' ? node.caption : '') ||
      '',
    timestamp: node.taken_at_timestamp
      ? new Date(node.taken_at_timestamp * 1000).toISOString()
      : node.taken_at
        ? new Date(node.taken_at * 1000).toISOString()
        : null,
    likes: node.edge_liked_by?.count ?? node.like_count ?? 0,
    comments: node.edge_media_to_comment?.count ?? node.comment_count ?? 0,
    url
  };
}

function extractEdges(edgeSet) {
  if (!edgeSet) return [];
  if (Array.isArray(edgeSet.edges)) return edgeSet.edges;
  if (Array.isArray(edgeSet)) return edgeSet;
  return [];
}

// ─── Highlight normalizer ─────────────────────────────────────────────────────

function highlightFromEdge(edge) {
  const node = edge?.node || edge;
  if (!node) return null;

  // If the browser fallback fetched the actual stories inside this highlight
  const innerItems = (node._items || []).map(item => mediaFromNode({ node: item }, 'story')).filter(Boolean);

  return {
    id: node.id || null,
    shortcode: node.id || null,
    type: 'highlight',
    thumbnail: proxyUrl(
      node.cover_media?.thumbnail_src ||
      node.cover_media_cropped_thumbnail?.url ||
      node.cover_image_url ||
      null
    ),
    displayUrl: proxyUrl(node.cover_media?.thumbnail_src || null),
    videoUrl: null,
    caption: node.title || node.name || '',
    timestamp: null,
    likes: 0,
    comments: 0,
    url: null,
    items: innerItems.length ? innerItems : undefined
  };
}

// ─── Profile extractor ────────────────────────────────────────────────────────

// Handles all known Instagram payload shapes
function extractUserObject(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data?.data?.user ||
    data?.data?.xdt_api__v1__users__web_profile_info?.user ||
    data?.graphql?.user ||
    data?.user ||
    data?.profile ||
    data?.props?.pageProps?.graphql?.user ||
    data?.entry_data?.ProfilePage?.[0]?.graphql?.user ||
    null
  );
}

// ─── Main normalizer ──────────────────────────────────────────────────────────

function normalizeProfileUser(rawUser, source) {
  const user = rawUser;
  const isPrivate = Boolean(user.is_private);

  // ── Posts ────────────────────────────────────────────────────────────────
  const postEdges = extractEdges(
    user.edge_owner_to_timeline_media ||
    user.timeline_media ||
    user.media
  );
  const posts = postEdges
    .map(e => mediaFromNode(e))
    .filter(Boolean)
    .slice(0, 120);

  // ── Reels ────────────────────────────────────────────────────────────────
  const reelEdges = extractEdges(
    user.edge_felix_video_timeline ||
    user.clips_media ||
    user.reels_media
  );
  let reels = reelEdges
    .map(e => mediaFromNode(e, 'reel'))
    .filter(Boolean)
    .slice(0, 120);

  // Fall back: derive reels from posts that are videos
  if (!reels.length) {
    reels = posts
      .filter(p => p.type === 'video' || p.type === 'reel')
      .map(p => ({ ...p, type: 'reel' }));
  }

  // ── Highlights ───────────────────────────────────────────────────────────
  // _highlights is set by browserFallbackService when it fetches full highlight content
  const highlightEdges = user._highlights
    ? user._highlights.map(n => ({ node: n }))
    : extractEdges(user.edge_highlight_reels || user.highlight_reels);
  const highlights = highlightEdges.map(highlightFromEdge).filter(Boolean);

  // ── Stories ───────────────────────────────────────────────────────────────
  const rawStories = user._stories || [];
  const stories24h = rawStories.map(item => mediaFromNode({ node: item }, 'story')).filter(Boolean);

  // ── Stats ────────────────────────────────────────────────────────────────
  const followers =
    user.edge_followed_by?.count ??
    user.follower_count ??
    user.followers_count ??
    0;
  const following =
    user.edge_follow?.count ??
    user.following_count ??
    0;
  const postsCount =
    user.edge_owner_to_timeline_media?.count ??
    user.media_count ??
    posts.length;

  return {
    success: true,
    source,
    fetchedAt: new Date().toISOString(),
    status: isPrivate ? 'PRIVATE_ACCOUNT' : 'PUBLIC_ACCOUNT',
    profile: {
      id: user.id || user.pk || null,
      username: user.username || '',
      fullName: user.full_name || user.fullName || '',
      avatar: proxyUrl(
        user.profile_pic_url_hd ||
        user.hd_profile_pic_url_info?.url ||
        user.profile_pic_url ||
        ''
      ),
      bio: user.biography || '',
      externalUrl:
        user.external_url ||
        user.bio_links?.[0]?.url ||
        '',
      followers,
      followersText: formatStatNumber(followers),
      following,
      followingText: formatStatNumber(following),
      postsCount,
      // Posts always shown as exact number with commas (Instagram style)
      postsCountText: postsCount > 0 ? postsCount.toLocaleString('en-US') : '0',
      isPrivate,
      isVerified: Boolean(user.is_verified),
      category: user.category_name || user.business_category_name || '',
      instagramUrl: user.username
        ? `https://www.instagram.com/${user.username}/`
        : ''
    },
    stories: {
      available: stories24h.length > 0,
      items: isPrivate ? [] : stories24h,
      message: isPrivate
        ? 'This account is private. Stories are not publicly available.'
        : stories24h.length > 0
          ? undefined
          : 'No active stories in the last 24 hours, or stories are not publicly accessible without a session.'
    },
    highlights: {
      available: highlights.length > 0,
      items: isPrivate ? [] : highlights,
      message: isPrivate
        ? 'This account is private. Highlights are not publicly available.'
        : highlights.length > 0
          ? undefined
          : 'No highlight data was returned by the public fetcher for this request.'
    },
    posts: {
      available: posts.length > 0,
      items: isPrivate ? [] : posts,
      message: isPrivate
        ? 'This account is private. No posts can be displayed.'
        : posts.length === 0
          ? 'No posts were returned by the public fetcher for this request.'
          : undefined
    },
    reels: {
      available: reels.length > 0,
      items: isPrivate ? [] : reels,
      message: isPrivate
        ? 'This account is private. Reels are not publicly available.'
        : reels.length === 0
          ? 'No reels were returned by the public fetcher for this request.'
          : undefined
    }
  };
}

// ─── HTML meta fallback ───────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g,       (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Instagram og:description often contains: "598M Followers, 575 Following, 3,648 Posts - Name"
function parseStatsFromDescription(desc) {
  const followersMatch = desc.match(/([\d,.]+[KkMmBb]?)\s+Followers?/i);
  const followingMatch = desc.match(/([\d,.]+[KkMmBb]?)\s+Following/i);
  const postsMatch    = desc.match(/([\d,.]+[KkMmBb]?)\s+Posts?/i);
  return {
    followersText: followersMatch?.[1] || '—',
    followingText: followingMatch?.[1] || '—',
    postsCountText: postsMatch?.[1]    || '—'
  };
}

function getMetaContent(html, property, name) {
  return (
    html.match(new RegExp(`<meta\\s+property=["']${property}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] ||
    html.match(new RegExp(`<meta\\s+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'))?.[1] ||
    (name ? html.match(new RegExp(`<meta\\s+name=["']${name}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] : null) ||
    (name ? html.match(new RegExp(`<meta\\s+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'))?.[1] : null) ||
    ''
  );
}

function normalizeMetaOnly(username, html) {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const title = decodeHtmlEntities(rawTitle)
    .replace(/\s*[•·|]\s*Instagram.*$/i, '')
    .replace(/Instagram\s*[-–]\s*/i, '')
    .trim();

  const ogTitle = decodeHtmlEntities(getMetaContent(html, 'og:title'));
  const rawDesc = decodeHtmlEntities(getMetaContent(html, 'og:description', 'description'));
  const ogImg   = getMetaContent(html, 'og:image');
  const avatar  = proxyUrl(ogImg.replace(/&amp;/g, '&'));

  // og:title format: "Cristiano Ronaldo (@cristiano) • Instagram photos and videos"
  const displayName = ogTitle
    .replace(/\s*\(\s*@[^)]+\)\s*/g, '')   // remove (@username)
    .replace(/\s*[•·|]\s*.*$/,       '')   // remove • Instagram...
    .trim() || title || username;

  const { followersText, followingText, postsCountText } = parseStatsFromDescription(rawDesc);

  // Strip counts + generic Instagram filler, keep actual user bio text
  let bio = rawDesc
    .replace(/[\d,.]+[KkMmBb]?\s+Followers?,?\s*/gi, '')
    .replace(/[\d,.]+[KkMmBb]?\s+Following,?\s*/gi, '')
    .replace(/[\d,.]+[KkMmBb]?\s+Posts?,?\s*[-–]?\s*/gi, '')
    .trim();

  // Remove generic Instagram fallback description (no real bio)
  if (/^See Instagram (photos and videos|stories) from /i.test(bio)) bio = '';
  if (/^Instagram photos and videos/i.test(bio)) bio = '';

  const isPrivate =
    html.includes('"is_private":true') ||
    html.includes('"is_private": true') ||
    html.includes('"accountPrivacy":"PRIVATE"') ||
    html.includes('This account is private') ||
    bio.toLowerCase().includes('private account');

  const isVerified =
    html.includes('"is_verified":true') ||
    html.includes('"is_verified": true') ||
    html.includes('"verified":true') ||
    html.includes('verified_account') ||
    // og:title sometimes contains a ✓ checkmark badge for verified accounts
    ogTitle.includes('✓') ||
    ogTitle.includes('✔');

  const message = isPrivate
    ? undefined
    : 'Full post/story media could not be fetched right now. Showing public profile details.';

  return {
    success: true,
    source: 'html_meta_fallback',
    fetchedAt: new Date().toISOString(),
    partial: true,
    status: isPrivate ? 'PRIVATE_ACCOUNT' : 'PARTIAL_DATA',
    profile: {
      id: null,
      username,
      fullName: displayName,
      avatar,
      bio,
      externalUrl: '',
      followers: 0,
      followersText,
      following: 0,
      followingText,
      postsCount: 0,
      postsCountText,
      isPrivate,
      isVerified,
      category: '',
      instagramUrl: `https://www.instagram.com/${username}/`
    },
    stories: {
      available: false,
      items: [],
      message: isPrivate
        ? 'This account is private. Stories are not publicly available.'
        : message
    },
    highlights: {
      available: false,
      items: [],
      message: isPrivate
        ? 'This account is private. Highlights are not publicly available.'
        : message
    },
    posts: {
      available: false,
      items: [],
      message: isPrivate
        ? 'This account is private. No posts can be displayed.'
        : message
    },
    reels: {
      available: false,
      items: [],
      message: isPrivate
        ? 'This account is private. Reels are not publicly available.'
        : message
    }
  };
}

function normalizeStoryItems(items) { return (items || []).map(i => mediaFromNode({ node: i }, 'story')).filter(Boolean); }
function normalizeHighlightItems(items) { return (items || []).map(i => mediaFromNode({ node: i }, 'story')).filter(Boolean); }

module.exports = { normalizeProfileUser, normalizeMetaOnly, extractUserObject, normalizeStoryItems, normalizeHighlightItems };
