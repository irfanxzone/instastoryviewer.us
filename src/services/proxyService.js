'use strict';

let proxies = [];
let currentIndex = 0;

function loadProxies() {
  const raw = process.env.OUTBOUND_PROXIES || '';
  proxies = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (proxies.length) {
    console.log(`[proxy] ${proxies.length} outbound proxy/proxies configured`);
  }
}

function hasProxies() {
  return proxies.length > 0;
}

function getCurrentProxy() {
  if (!proxies.length) return null;
  return proxies[currentIndex % proxies.length];
}

function rotateProxy() {
  if (!proxies.length) return;
  currentIndex = (currentIndex + 1) % proxies.length;
  console.log(`[proxy] Rotated to proxy index ${currentIndex}`);
}

function getAxiosProxyConfig(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const url = new URL(proxyUrl);
    const config = {
      host: url.hostname,
      port: Number(url.port) || 8080,
      protocol: url.protocol.replace(':', '')
    };
    if (url.username) {
      config.auth = {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password || '')
      };
    }
    return config;
  } catch {
    return undefined;
  }
}

// Returns true when the error warrants rotating to the next proxy
function shouldRotateOnError(error) {
  const status = error?.response?.status;
  if (status === 403 || status === 429) return true;
  const code = error?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPROTO'].includes(code)) return true;
  return false;
}

loadProxies();

module.exports = {
  hasProxies,
  getCurrentProxy,
  rotateProxy,
  getAxiosProxyConfig,
  shouldRotateOnError
};
