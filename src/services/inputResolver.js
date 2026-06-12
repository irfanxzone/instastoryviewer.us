function cleanInput(raw) {
  return String(raw || '').trim();
}

function stripQueryHash(value) {
  return value.split('?')[0].split('#')[0].trim();
}

function normalizeUsername(value) {
  return value
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9._]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 30);
}

function resolveInstagramInput(raw) {
  const original = cleanInput(raw);
  if (!original) {
    const err = new Error('Please enter an Instagram username or link.');
    err.status = 400;
    throw err;
  }

  let value = original;
  if (!/^https?:\/\//i.test(value) && /instagram\.com/i.test(value)) {
    value = 'https://' + value;
  }

  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      const err = new Error('Invalid Instagram link.');
      err.status = 400;
      throw err;
    }

    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['instagram.com', 'instagr.am'].includes(host)) {
      const err = new Error('Only Instagram links are supported.');
      err.status = 400;
      throw err;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) {
      const err = new Error('Instagram link is missing a username.');
      err.status = 400;
      throw err;
    }

    if (parts[0] === 'stories' && parts[1]) {
      return { type: 'story', username: normalizeUsername(parts[1]), original };
    }
    if (['p', 'reel', 'tv'].includes(parts[0]) && parts[1]) {
      return { type: parts[0] === 'reel' ? 'reel' : 'post', shortcode: stripQueryHash(parts[1]), original };
    }

    const reserved = new Set(['explore', 'accounts', 'about', 'developer', 'directory', 'legal', 'privacy', 'terms']);
    if (reserved.has(parts[0].toLowerCase())) {
      const err = new Error('This Instagram link does not contain a public profile username.');
      err.status = 400;
      throw err;
    }

    return { type: 'profile', username: normalizeUsername(parts[0]), original };
  }

  const username = normalizeUsername(value);
  if (!username || username.length < 1) {
    const err = new Error('Invalid username.');
    err.status = 400;
    throw err;
  }

  return { type: 'profile', username, original };
}

module.exports = { resolveInstagramInput, normalizeUsername };
