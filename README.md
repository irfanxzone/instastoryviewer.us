# Insta Own API Viewer

This is a fresh implementation using your frontend style, with your own Node.js backend API.

## What it does

- Accepts username, @username, profile URL, story URL, reel URL, post URL.
- Normalizes the input into a username or shortcode.
- Uses your own backend, not RapidAPI.
- Tries public Instagram profile fetch methods.
- Returns clean normalized JSON to the frontend.
- Caches results for fast loading and fewer upstream requests.
- Shows profile details and available public post/reel previews.
- Shows clean fallback messages when stories/highlights are not publicly exposed.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

## API routes

- `GET /api/ig/resolve?input=<username|url>`
- `GET /api/ig/all/:input`
- `GET /api/ig/profile/:input`
- `GET /api/ig/stories/:input`
- `GET /api/ig/highlights/:input`
- `GET /api/ig/posts/:input`
- `GET /api/ig/reels/:input`

Examples:

```text
/api/ig/all/instagram
/api/ig/profile/instagram
/api/ig/posts/instagram
```

## Important reality

This project does not bypass private accounts, login walls, or Instagram restrictions. Stories/highlights for arbitrary accounts are usually not exposed to unauthenticated public requests. The API is structured to support them, but if Instagram blocks or hides them, the UI will show a clean message instead of fake data.

## Instagram worker sessions

For reliable public story loading, configure fixed Instagram worker identities in `.env`:

```bash
IG_WORKERS="sessionid|host:port:user:pass
sessionid|http://user:pass@host:port"
IG_WORKER_PREFERRED_INDEX=2
IG_WORKER_FETCH_ATTEMPTS=3
IG_WORKER_FAILURE_COOLDOWN_MS=600000
IG_WORKER_ACQUIRE_TIMEOUT_MS=45000
```

Each worker gets its own persistent Chrome profile under `.chrome-data-ig-workers/`, uses its own sticky residential proxy, and injects `sessionid` plus `ds_user_id` before fetching Instagram in real Chrome. Keep real session IDs and proxy credentials only in `.env` or server environment.

## Deploy for high traffic

For serious traffic, put this behind:

- Cloudflare cache/WAF
- Nginx reverse proxy
- PM2 cluster mode
- Redis cache instead of file cache
- Separate worker queue for refresh jobs

A million requests/month is about 0.4 requests/second average, which is manageable if most results are cached.
