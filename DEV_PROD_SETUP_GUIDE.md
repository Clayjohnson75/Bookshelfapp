# Development vs Production Environment Setup

## Overview

This guide will help you set up separate development and production environments with:
- **Development Database**: Separate Supabase project for testing
- **Development Deployments**: Separate Vercel preview deployments
- **Production**: Your existing production database and deployment

## Step 1: Create Development Supabase Project

1. Go to https://supabase.com/dashboard
2. Click **"New Project"**
3. Name it: `bookshelf-scanner-dev` (or similar)
4. Choose a region close to you
5. Set a database password (save it!)
6. Click **"Create new project"**

### After Creation:
1. Go to **Settings** → **API**
2. Copy these values:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon/public key**: `eyJhbGc...`

## Step 2: Set Up Development Database

Run these migrations in your **development Supabase project**:

1. **Create profiles table** (if not exists)
2. **Create photos table**: Run `supabase-migration-add-photos-table.sql`
3. **Create books table**: Run `supabase-migration-add-book-stats-fields.sql`
4. **Create subscriptions**: Run `supabase-migration-add-subscriptions.sql`
5. **Create user_stats**: Run `supabase-migration-add-user-stats-table.sql`
6. **Create photos bucket**: Go to Storage → Create bucket `photos` (public)

## Step 3: Configure EAS Secrets for Different Environments

### For Development (Expo Go / Development Builds):

```bash
# Development Supabase
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_DEV --value https://your-dev-project.supabase.co
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV --value your-dev-anon-key

# Development Vercel (optional - can use preview URLs)
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL_DEV --value https://your-dev-vercel.vercel.app
```

### For Production:

```bash
# Production Supabase (already set)
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_PROD --value https://cnlnrlzhhbrtehpkttqv.supabase.co
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_PROD --value your-prod-anon-key

# Production Vercel
eas secret:create --scope project --name EXPO_PUBLIC_API_BASE_URL_PROD --value https://bookshelfapp-five.vercel.app
```

## Step 4: Update app.config.js

The config will automatically use the right environment based on the build profile.

## Step 5: Create Development Vercel Project (Optional)

1. Go to https://vercel.com
2. Create a new project from the same GitHub repo
3. Name it: `bookshelf-scanner-dev`
4. Set environment variables:
   - `EXPO_PUBLIC_SUPABASE_URL` → Your dev Supabase URL
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` → Your dev Supabase key
   - `SUPABASE_SERVICE_ROLE_KEY` → Your dev Supabase service role key
   - `OPENAI_API_KEY` → Same as production (or separate test key)
   - `GEMINI_API_KEY` → Same as production (or separate test key)

## Step 6: Update EAS Build Profiles

We'll update `eas.json` to have separate dev and production profiles.

## How to Use

### Development (Expo Go / Dev Builds):
- Uses development Supabase database
- Uses development Vercel deployment (or preview)
- Test data is separate from production

### Production (App Store Builds):
- Uses production Supabase database
- Uses production Vercel deployment
- Real user data

## Switching Between Environments

The app will automatically detect which environment to use based on:
- Build profile (development vs production)
- EAS secrets for that profile
- Fallback to hardcoded production values

## Important Notes

⚠️ **Data Separation**:
- Development database is completely separate
- Test accounts won't appear in production
- Scans in dev won't appear in production
- Safe to test destructive operations

✅ **Benefits**:
- Test without affecting production data
- Multiple developers can use same dev database
- Safe to experiment with new features




