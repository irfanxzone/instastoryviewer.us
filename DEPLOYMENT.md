# Production Deployment Notes

## Basic VPS deployment

```bash
npm install
cp .env.example .env
npm start
```

## PM2 cluster deployment

```bash
npm install -g pm2
pm2 start src/server.js -i max --name insta-own-api-viewer
pm2 save
```

## High request volume structure

For around 1 million searches/month, the important part is cache. Average load is low, but spikes can be high. Use:

```text
Cloudflare CDN/WAF
  -> Nginx reverse proxy
  -> Node.js PM2 cluster
  -> Redis cache in production
  -> file cache only for small/simple deployments
```

## Nginx example

```nginx
server {
  listen 80;
  server_name yourdomain.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Important

Do not remove cache. Without cache, Instagram will block requests faster and the site will feel slow.
