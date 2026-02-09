# Testing scans on a physical device

On a physical iOS/Android device, `http://localhost:3000` points to the **device**, not your Mac. Scans will fail with "Network request failed" unless the app uses a URL reachable from the device.

**App and API must use the same Supabase.** Expo dev uses **dev Supabase**; TestFlight/App Store use **prod Supabase**. If the app sends a JWT from dev Supabase to an API that validates with prod Supabase, you get **401 reauth_required**. So: when using dev Supabase in Expo, point the app at an API that also uses dev Supabase (local API or Vercel staging with dev env). When pointing at the main deployed API (prod Supabase), use prod Supabase in the app (confirm user in prod).

---

## Option A (fastest): Don’t run local API — only if API uses same Supabase as app

Point the app at your **deployed** Vercel URL (already HTTPS). No tunnel, no Node, no local server.

1. In **`.env`**, set:
   ```env
   EXPO_PUBLIC_API_BASE_URL_DEV=https://<your-vercel-deployment>
   ```
   e.g. `https://bookshelfapp-five.vercel.app` or your staging URL. Comment out any `EXPO_PUBLIC_API_BASE_URL_DEV` that points at LAN/ngrok so this is the only dev API URL.

2. Restart Expo (clean cache):
   ```bash
   npx expo start -c
   ```

3. On your phone, scans hit the deployed API. **Success in logs:** `[ENQUEUE_URL] https://.../api/scan`.

That’s it. No local API, no tunnel, no Node setup.

**Caveat:** The main Vercel deployment (e.g. `bookshelfapp-five.vercel.app`) uses **prod** Supabase. If your app uses **dev** Supabase (Expo dev), scans will return **401** — use Option C (local API + ngrok with dev Supabase) or a Vercel **preview** deployment with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set to your **dev** project.

---

## Option B: Point the app at prod (or use terminal export)

No tunnel, no LAN. Use your real deployed API (e.g. `https://www.bookshelfscan.app`) while developing. Expo runs locally; `/api/scan` goes to the deployed API.

**If you use terminal export (overrides `.env`):**

1. **Stop Expo and Metro** (Ctrl+C in the terminal that’s running Expo).

2. In the **same** terminal, set the API base and nuke caches, then start Expo:

   ```bash
   export EXPO_PUBLIC_API_BASE_URL="https://www.bookshelfscan.app"

   rm -rf .expo .expo-shared
   watchman watch-del-all 2>/dev/null || true

   npx expo start -c
   ```

   (Use your real domain if different, e.g. `https://<your-project>.vercel.app`.)

3. Relaunch the app on your phone. Scanning should hit the deployed API, not `http://192.168...:3000`.

**Success in logs:**

- `EXPO_PUBLIC_API_BASE_URL = https://www.bookshelfscan.app`
- `[ENQUEUE_URL] https://www.bookshelfscan.app/api/scan`

If you still see `192.168...`, the value is coming from somewhere else (e.g. `.env` has `EXPO_PUBLIC_API_BASE_URL_DEV=http://192.168...`). Comment that line out in `.env` or unset it so the terminal export wins.

**Why this is safe:** You’re only changing the client in your dev environment. As long as you don’t change the deployed server, there’s no extra risk to users. Use a dev/test user if you’re worried about hitting production data.

---

## Option C: ngrok (tunnel to local API)

Use this when you need to hit a **local** API (e.g. `vercel dev`) from your phone.

### Plan (ngrok)

### 1. Install ngrok

```bash
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken <YOUR_TOKEN>
```

Get a free token at [ngrok.com](https://ngrok.com).

### 2. Start the local API (port 3000)

On your laptop, start the API bound to the LAN (so it can be tunneled):

```bash
npm run dev:local
```

This runs `vercel dev --listen 0.0.0.0:3000`. Ensure it’s actually listening (e.g. `lsof -i :3000`, `curl http://localhost:3000/api/health`).

### 3. Start the tunnel

In a **second** terminal:

```bash
ngrok http 3000
```

Copy the **HTTPS** URL shown (e.g. `https://xxxxx.ngrok-free.app`).

### 4. Set the Expo API base URL

Set the ngrok URL so the app calls your tunnel instead of localhost. In `.env` or `.env.local`:

```env
EXPO_PUBLIC_API_BASE_URL=https://<ngrok-subdomain>.ngrok-free.app
```

For dev builds the app also reads `EXPO_PUBLIC_API_BASE_URL_DEV`, so you can set that instead:

```env
EXPO_PUBLIC_API_BASE_URL_DEV=https://<ngrok-subdomain>.ngrok-free.app
```

Use `.env.local` for device-only testing (not committed); `.env.local` overrides `.env`.

### 5. Restart Expo with a clean cache

So the app picks up the new env and there’s no stale localhost:

```bash
npx expo start -c
```

### 6. Confirm in the app

- In logs, **authHeaders** should print:  
  `EXPO_PUBLIC_API_BASE_URL = https://xxxxx.ngrok-free.app`
- Scan enqueue should **not** show "Network request failed".
- You should see `[ENQUEUE_URL] https://xxxxx.ngrok-free.app/api/scan` (or `/api/scan-job`) in logs when you run a scan.

## Notes / gotchas

- **Do NOT use `http://localhost:3000` on a physical device.** It will always fail for scan (and any) API calls.
- **If the ngrok URL changes** (e.g. new session), update `.env` or `.env.local` and run `npx expo start -c` again.
- **HTTPS:** ngrok gives HTTPS URLs, so iOS ATS is satisfied; no extra ATS config needed.
- **Scan endpoint:** The app uses `EXPO_PUBLIC_API_BASE_URL` everywhere for scan (and API) base; there is no hardcoded localhost for the scan endpoint. It’s set in `app.config.js` from env and read via `getEnvVar('EXPO_PUBLIC_API_BASE_URL')`.

## Production / dev safety

- **Short-term:** Keep these changes local; only deploy once verified. None of the auth/ngrok changes touch prod until you deploy.
- **Medium-term:** Dev and prod currently share the same Supabase project ref. That’s risky long-term (dev data/actions can touch prod). Create a **separate Supabase project for dev** and point dev builds at it (e.g. `EXPO_PUBLIC_SUPABASE_URL_DEV`, `EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV`).
