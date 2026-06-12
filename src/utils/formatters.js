'use strict';

const intlCompact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function compactNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return intlCompact.format(num);
}

function safeString(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val).trim();
}

function isoNow() {
  return new Date().toISOString();
}

module.exports = { compactNumber, safeString, isoNow };
