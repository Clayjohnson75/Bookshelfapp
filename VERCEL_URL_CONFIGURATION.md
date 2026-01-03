# Vercel Deployment URL Configuration

## Where the Vercel URL is Stored

The Vercel deployment URL is configured in **`app.config.js`**:

```javascript
extra: {
  EXPO_PUBLIC_API_BASE_URL: envVars.EXPO_PUBLIC_API_BASE_URL || 
                            process.env.EXPO_PUBLIC_API_BASE_URL || 
                            'https://bookshelfapp-five.vercel.app',
}
```

## Current Configuration

**File:** `/Users/clayjohnson/BookshelfScannerExpoApp/app.config.js` (line 96)

**Current URL:** `https://bookshelfapp-five.vercel.app`

## How It Works

1. **Priority Order** (first match wins):
   - `.env` file → `EXPO_PUBLIC_API_BASE_URL`
   - `process.env` → `EXPO_PUBLIC_API_BASE_URL`
   - **Fallback** → `https://bookshelfapp-five.vercel.app` (hardcoded)

2. **Where It's Used**:
   - `tabs/ScansTab.tsx` → Makes API calls to `/api/scan`
   - `api/scan-job.ts` → Internal API calls
   - All scanning operations use this URL

## How to Change the Vercel URL

### Option 1: Update `app.config.js` (Recommended)
```javascript
EXPO_PUBLIC_API_BASE_URL: 'https://your-new-vercel-url.vercel.app',
```

### Option 2: Use `.env` file
Create/update `.env` file in project root:
```
EXPO_PUBLIC_API_BASE_URL=https://your-new-vercel-url.vercel.app
```

### Option 3: EAS Secrets (for production builds)
```bash
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value https://your-new-vercel-url.vercel.app
```

## Important Notes

- **Production URL**: `https://bookshelfapp-five.vercel.app` (current)
- **Preview Deployments**: Vercel creates preview URLs for each PR/branch
- **The app always uses the production URL** (not preview URLs) to avoid authentication issues

## Where the App Makes API Calls

The app calls these endpoints on your Vercel deployment:
- `https://bookshelfapp-five.vercel.app/api/scan` - Main scanning endpoint
- `https://bookshelfapp-five.vercel.app/api/scan-job` - Background job processing
- `https://bookshelfapp-five.vercel.app/api/sync-scans` - Sync completed scans
- `https://bookshelfapp-five.vercel.app/api/health` - Health check

## Verification

To verify which URL the app is using, check the console logs when scanning:
```
📡 Attempting server API scan at: https://bookshelfapp-five.vercel.app/api/scan
```

## Current Status

✅ **Configured**: `https://bookshelfapp-five.vercel.app`
✅ **Hardcoded fallback**: Same URL (so it always works)
✅ **Used in**: All API calls from the app




