'use strict';

class AppError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (details) this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Profile not found. Check the username and try again.') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

class InputError extends AppError {
  constructor(message = 'Invalid input.') {
    super(message, 400);
    this.name = 'InputError';
  }
}

class UpstreamBlockedError extends AppError {
  constructor(message = 'Instagram blocked this request. Try again later.') {
    super(message, 503);
    this.name = 'UpstreamBlockedError';
  }
}

function isLoginWallText(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) return true;
  return (
    text.includes('login_required') ||
    text.includes('"authenticated":false') ||
    text.includes('checkpoint_required') ||
    text.includes('challenge_required') ||
    text.includes('Please wait a few minutes') ||
    text.includes('"status":"fail"') ||
    text.includes('two_factor_required')
  );
}

function isBlockedResponse(status, text) {
  if (status === 403 || status === 429) return true;
  return isLoginWallText(text);
}

module.exports = {
  AppError,
  NotFoundError,
  InputError,
  UpstreamBlockedError,
  isLoginWallText,
  isBlockedResponse
};
