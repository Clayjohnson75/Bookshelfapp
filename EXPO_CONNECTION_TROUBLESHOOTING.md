# "Could not connect to the server" in Expo Go

This usually means your phone/emulator can’t reach the **Metro bundler** (the dev server) on your computer.

## Fix 1: Use tunnel (most reliable)

From the project root:

```bash
npm run start:tunnel
```

or:

```bash
npx expo start --tunnel
```

Then scan the QR code with Expo Go. Tunnel routes the connection through Expo’s servers, so it works even when your phone and computer are on different networks or Wi‑Fi is locked down.

## Fix 2: Same Wi‑Fi (LAN)

1. **Start the dev server** (in the project folder):
   ```bash
   npm start
   ```
2. **Same network**: Phone and computer must be on the **same Wi‑Fi** (not phone data, not a different SSID).
3. **Firewall**: Allow Node/Metro on ports **8081**, **19000**, **19001** (macOS: System Settings → Network → Firewall → Options; Windows: allow Node in Defender).
4. **Restart**: Quit Expo Go, stop Metro (Ctrl+C), run `npm start` again, then open the project in Expo Go.

## Fix 3: Clear Expo Go cache

- In Expo Go: shake device → **Reload** (or **Clear cache** if available).
- Or remove the project from Expo Go and scan the QR code again.

## Fix 4: Dev client vs Expo Go

This project includes **expo-dev-client**. For the best experience you can build a **development build** and use that instead of Expo Go:

```bash
npx expo run:ios
# or
npx expo run:android
```

If you only use Expo Go, tunnel mode (`npm run start:tunnel`) is usually the easiest way to avoid “could not connect” on LAN.
