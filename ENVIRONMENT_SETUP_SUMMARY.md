# Development vs Production Environment Setup - Summary

## ✅ What's Been Configured

### 1. **app.config.js** - Environment Variable Priority
The app now checks for environment variables in this order:
1. `.env` file with `_DEV` suffix (for local development)
2. `.env` file without suffix (production fallback)
3. `process.env` (EAS secrets for production builds)
4. Hardcoded production values (final fallback)

### 2. **eas.json** - Build Profile Environment
Added `EAS_ENV` to each build profile:
- `development` → Development builds
- `preview` → Preview/test builds  
- `production` → Production builds

### 3. **.env.example** - Template Created
Created template showing how to set up dev/prod values

## 🚀 Quick Start

### Step 1: Create Development Supabase Project
1. Go to https://supabase.com/dashboard
2. Create new project: `bookshelf-scanner-dev`
3. Copy Project URL and anon key

### Step 2: Set Up .env File
```bash
cp .env.example .env
```

Edit `.env` and add:
```
EXPO_PUBLIC_SUPABASE_URL_DEV=https://your-dev-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV=your-dev-anon-key
EXPO_PUBLIC_API_BASE_URL_DEV=https://your-dev-vercel.vercel.app
```

### Step 3: Run Migrations on Dev Database
Run all SQL migrations in your **development Supabase** project:
- `supabase-migration-add-photos-table.sql`
- `supabase-migration-add-book-stats-fields.sql`
- `supabase-migration-add-subscriptions.sql`
- `supabase-migration-add-user-stats-table.sql`

### Step 4: Create Photos Bucket
In dev Supabase: Storage → Create bucket `photos` (public)

## 📋 How It Works

### Development (Expo Go / Local Dev):
- Uses `.env` file values with `_DEV` suffix
- If not set, falls back to production values
- Safe to test without affecting production

### Production (App Store Builds):
- Uses EAS secrets (set via `eas secret:create`)
- Falls back to hardcoded production values
- Real user data

## 🔧 Setting EAS Secrets for Production

```bash
# Production Supabase
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value https://cnlnrlzhhbrtehpkttqv.supabase.co
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value your-prod-key

# Production Vercel
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value https://bookshelfapp-five.vercel.app
```

## ✅ Testing

1. **Test Development**:
   - Start Expo Go: `npx expo start`
   - Should use dev database from `.env` file
   - Check console logs for which URL is used

2. **Test Production**:
   - Build production: `eas build --platform ios --profile production`
   - Should use production database from EAS secrets
   - Verify data is separate

## 📝 Files Created/Modified

- ✅ `app.config.js` - Updated to check for `_DEV` values first
- ✅ `eas.json` - Added `EAS_ENV` to build profiles
- ✅ `.env.example` - Template for environment variables
- ✅ `DEV_PROD_SETUP_GUIDE.md` - Full setup guide
- ✅ `DEV_PROD_SETUP_STEPS.md` - Step-by-step instructions

## 🎯 Result

- **Development**: Separate database, safe testing
- **Production**: Real user data, protected
- **Separation**: Complete data isolation





