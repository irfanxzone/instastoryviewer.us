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

## Deploy for high traffic

For serious traffic, put this behind:

- Cloudflare cache/WAF
- Nginx reverse proxy
- PM2 cluster mode
- Redis cache instead of file cache
- Separate worker queue for refresh jobs

A million requests/month is about 0.4 requests/second average, which is manageable if most results are cached.
