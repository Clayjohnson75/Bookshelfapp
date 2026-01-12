# Testing Sign-In Guide

## Quick Test Locations

### 1. Terminal (Test API)
Open Terminal app on your Mac and run:
```bash
curl -X POST https://www.bookshelfscan.app/api/get-email-by-username \
  -H "Content-Type: application/json" \
  -d '{"username":"YOUR_USERNAME"}'
```

### 2. Expo (Development)
```bash
cd /Users/clayjohnson/BookshelfScannerExpoApp
npx expo start
```
- Scan QR code with Expo Go app
- OR press `i` for iOS simulator
- OR press `a` for Android emulator
- Try signing in

### 3. Production App
- Open the app from App Store/TestFlight on your phone
- Try signing in with username
- Watch for loading/errors

### 4. Browser Console
1. Open any website
2. Press F12 (or Cmd+Option+I on Mac)
3. Go to Console tab
4. Paste and run:
```javascript
fetch('https://www.bookshelfscan.app/api/get-email-by-username', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'YOUR_USERNAME' })
})
.then(r => r.json())
.then(console.log)
.catch(console.error)
```

## What to Look For

✅ **Success**: Returns `{"email":"your@email.com"}`
❌ **Error**: Returns error message or times out
⏳ **Timeout**: Takes more than 10 seconds

