# Step-by-Step: Setting Up Dev/Prod Separation

## Quick Start Checklist

- [ ] Create development Supabase project
- [ ] Run migrations on dev database
- [ ] Create development Vercel project (optional)
- [ ] Set up .env file for local development
- [ ] Set up EAS secrets for production builds
- [ ] Test development environment
- [ ] Verify production still works

## Step 1: Create Development Supabase Project

1. Go to https://supabase.com/dashboard
2. Click **"New Project"**
3. **Project Name**: `bookshelf-scanner-dev`
4. **Database Password**: (save this!)
5. **Region**: Choose closest to you
6. Click **"Create new project"**
7. Wait 2-3 minutes for setup

### Get Your Dev Supabase Credentials:
1. Go to **Settings** → **API**
2. Copy:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...`

## Step 2: Set Up Development Database

Run these SQL migrations in your **development Supabase SQL Editor**:

1. **Profiles table** (if needed):
   ```sql
   -- Check if profiles table exists, if not create it
   ```

2. **Photos table**: 
   - Open `supabase-migration-add-photos-table.sql`
   - Copy and paste into Supabase SQL Editor
   - Click **Run**

3. **Books stats fields**:
   - Open `supabase-migration-add-book-stats-fields.sql`
   - Run in SQL Editor

4. **Subscriptions**:
   - Open `supabase-migration-add-subscriptions.sql`
   - Run in SQL Editor

5. **User stats**:
   - Open `supabase-migration-add-user-stats-table.sql`
   - Run in SQL Editor

6. **Create Storage Bucket**:
   - Go to **Storage** → **Buckets**
   - Click **"New bucket"**
   - Name: `photos`
   - Make it **Public**
   - Click **"Create bucket"**

## Step 3: Create Development Vercel Project (Optional)

### Option A: Use Preview Deployments (Recommended)
- Vercel automatically creates preview URLs for each branch/PR
- No setup needed - just use preview URLs when testing

### Option B: Create Separate Dev Project
1. Go to https://vercel.com
2. Click **"Add New"** → **"Project"**
3. Import your GitHub repo
4. **Project Name**: `bookshelf-scanner-dev`
5. **Framework Preset**: Other
6. Click **"Deploy"**

### Set Environment Variables in Vercel:
1. Go to **Settings** → **Environment Variables**
2. Add:
   - `EXPO_PUBLIC_SUPABASE_URL` → Your dev Supabase URL
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` → Your dev Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY` → Your dev Supabase service role key
   - `OPENAI_API_KEY` → (same as production or separate test key)
   - `GEMINI_API_KEY` → (same as production or separate test key)

## Step 4: Set Up Local Development (.env file)

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your dev values:
   ```
   EXPO_PUBLIC_SUPABASE_URL_DEV=https://your-dev-project.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV=your-dev-anon-key
   EXPO_PUBLIC_API_BASE_URL_DEV=https://your-dev-vercel.vercel.app
   ```

3. Keep production values as fallback (or remove if you want strict separation)

## Step 5: Set Up EAS Secrets for Production

For production builds, set secrets in EAS:

```bash
# Production Supabase
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value https://cnlnrlzhhbrtehpkttqv.supabase.co --type string
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value your-prod-anon-key --type string

# Production Vercel
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL --value https://bookshelfapp-five.vercel.app --type string
```

## Step 6: Test Development Environment

1. **Start Expo Go**:
   ```bash
   npx expo start
   ```

2. **Check console logs** - should show:
   ```
   📋 Loaded env var: EXPO_PUBLIC_SUPABASE_URL_DEV
   ```

3. **Sign in** - should connect to dev database
4. **Scan a book** - should save to dev database
5. **Verify** - check dev Supabase dashboard to see the data

## Step 7: Verify Production Still Works

1. **Build production**:
   ```bash
   eas build --platform ios --profile production
   ```

2. **Test production build** - should use production database
3. **Verify** - production data should be separate from dev

## How It Works

### Development (Expo Go / Dev Builds):
- Uses `.env` file values (with `_DEV` suffix)
- Falls back to production if dev values not set
- Safe to test without affecting production

### Production (App Store Builds):
- Uses EAS secrets (production values)
- Falls back to hardcoded production values in `app.config.js`
- Real user data

## Environment Detection

The app automatically detects environment:
- **`__DEV__`** = true → Development mode (Expo Go)
- **`EAS_ENV=development`** → Development build
- **`EAS_ENV=production`** → Production build

## Troubleshooting

### Dev not using dev database?
- Check `.env` file exists and has correct values
- Restart Expo Go after changing `.env`
- Check console logs for which URL is being used

### Production using dev database?
- Check EAS secrets are set correctly
- Verify `EAS_ENV=production` in production build profile
- Check build logs for environment variables

### Both environments using same database?
- Make sure you created a separate Supabase project for dev
- Verify `.env` file has different `_DEV` values
- Check that EAS secrets are set for production

## Summary

✅ **Development**: Uses `.env` file → Dev Supabase → Dev Vercel
✅ **Production**: Uses EAS secrets → Prod Supabase → Prod Vercel
✅ **Separation**: Complete data isolation between environments



