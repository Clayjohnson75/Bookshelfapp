# Data Storage: Dev vs Production

## Current Setup: **SAME DATABASE** ✅

**Important**: Your app is currently using the **SAME Supabase database** for both development and production.

### What This Means:

1. **Same Account Data**: 
   - Your account (username, email, profile) is the same in dev and production
   - Your books, photos, and library are the same
   - Your subscription status is the same

2. **Data Persists Across Environments**:
   - When you test in Expo Go (dev), you see your real data
   - When you use the production app from App Store, you see the same data
   - Everything syncs to the same Supabase database

3. **No Data Separation**:
   - There is NO separate dev database
   - There is NO separate production database
   - Everything goes to: `cnlnrlzhhbrtehpkttqv.supabase.co`

## How It Works:

### Supabase Connection:
- **URL**: `https://cnlnrlzhhbrtehpkttqv.supabase.co` (same for dev and prod)
- **Database**: Same database for all environments
- **Storage**: Same Supabase Storage bucket for all photos

### Local Storage (AsyncStorage):
- **Dev (Expo Go)**: Stores data locally on your device
- **Production App**: Stores data locally on your device
- **Sync**: Both sync to the same Supabase database

## What Happens When You:

### Sign In:
- Same account works in both dev and production
- Same books, photos, and library appear
- Same subscription status

### Scan Books:
- Scans saved to the same Supabase database
- Photos uploaded to the same Supabase Storage
- Books saved to the same `books` table

### Switch Between Dev and Production:
- Your data is **identical** in both
- No need to re-scan or re-upload
- Everything is synced and shared

## If You Want Separate Dev/Prod Databases:

If you want to separate dev and production data (not recommended for your use case), you would need to:

1. **Create a second Supabase project** for development
2. **Update environment variables** to use different URLs
3. **Use EAS Secrets** to set different values for dev vs production builds

### Example Setup (if you wanted separation):

```javascript
// Development (Expo Go)
EXPO_PUBLIC_SUPABASE_URL=https://dev-project.supabase.co

// Production (App Store)
EXPO_PUBLIC_SUPABASE_URL=https://prod-project.supabase.co
```

## Current Recommendation: ✅ Keep It As Is

**Why keep the same database:**
- ✅ Simpler setup and maintenance
- ✅ Your test data is your real data (no confusion)
- ✅ No need to migrate data between environments
- ✅ Easier to test with real user data
- ✅ One source of truth

**When you might want separation:**
- ❌ If you want to test destructive operations safely
- ❌ If you have multiple developers with different test data
- ❌ If you want to test migrations without affecting production

## Summary:

**Your account and data are the SAME in dev and production.** When you:
- Test in Expo Go → You see your real books and photos
- Use the App Store app → You see the same books and photos
- Sign in with your account → Same account, same data everywhere

This is actually **good** - your data persists and syncs across all environments! 🎉





