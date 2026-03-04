# 413 Payload Too Large — API edge and body limits

When `create_scan_job` (POST to `/api/scan`) returns **413**, the request body is exceeding a size limit **before** or at your API. Fix it as follows.

## 1. Do not send image bytes

The client must send **only metadata** to `/api/scan`: `photoId` and `storagePath`. The worker reads the image from storage. Sending base64 or raw image in the body will hit size limits.

- Client: `lib/photoUploadQueue.ts` — STEP_C sends only `{ photoId, storagePath }`.
- If anything still sends `imageDataURL` or large payloads, remove it.

## 2. Raise limits where you control them

### Vercel (bookshelfscan.app)

- **Request body limit is 4.5 MB** and **cannot be increased** (platform limit).
- There is no `vercel.json` or function config option to raise body size.
- **Action:** Ensure the client never sends image data; use metadata-only. If you still see 413, the body is still too large (check for accidental base64, huge headers, or other bloat).

### Cloudflare (if in front of Vercel)

If requests go through Cloudflare (proxy or Workers):

- **Cloudflare Proxy:** By default, free/proxy plans may have request size limits. Check **Rules** or **Settings** for request/body limits.
- **Workers:** In the Worker, you can allow larger requests by not buffering the whole body, or by increasing limits in the plan. For “passthrough” to Vercel, increase any **request body** or **payload** limit in the dashboard so it’s at least **10 MB** (or match your desired max).
- **Action:** In Cloudflare dashboard, find the setting that limits request/body size for your domain and set it to **10 MB** or higher.

### NGINX (if in front of your API)

If you run NGINX in front of the API (e.g. reverse proxy to Node/Vercel):

```nginx
# In http or server block — raise client body size (e.g. 10MB)
client_max_body_size 10M;

# Or only for the API path
location /api/ {
  client_max_body_size 10M;
  proxy_pass https://your-backend;
}
```

Reload NGINX after changing.

### Express / Node (if you run a custom server)

If you use Express (or any body-parser) in front of the API:

- Default `body-parser` limits are often low (e.g. 100kb). Raise them so they are not smaller than Vercel’s 4.5 MB:

```js
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
```

- **Action:** Set `limit` to at least **10mb** (or match your desired max). Do not use a very low limit.

### Netlify (if you ever switch)

- Netlify Functions have a **6 MB** request body limit (slightly higher than Vercel). If you use Netlify, check their docs for the current limit and any way to increase it; still prefer metadata-only for scan.

## 3. Summary

| Layer           | Action |
|----------------|--------|
| **Client**     | Send only `photoId` + `storagePath` to `/api/scan`; no image bytes. |
| **Vercel**     | 4.5 MB is fixed; cannot be raised. |
| **Cloudflare** | In dashboard, raise request/body limit (e.g. 10 MB). |
| **NGINX**      | Set `client_max_body_size 10M;` (or higher). |
| **Express**    | Use `express.json({ limit: '10mb' })` (and same for urlencoded). |

Raising limits at the proxy/edge (Cloudflare, NGINX, Express) will stop 413s from those layers while you confirm the client is sending only metadata.
