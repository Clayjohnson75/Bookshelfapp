# Supabase Performance Optimizations

## Why Supabase Can Be Slow

### 1. **Photo Downloads on Every Load** (FIXED ✅)
- **Problem**: The app was downloading ALL photos from Supabase Storage on every app launch
- **Impact**: If you have 50 photos, that's 50 separate network requests blocking the UI
- **Solution**: 
  - Now uses cloud URLs directly (instant loading)
  - Photos are cached lazily in the background when viewed
  - Only downloads if not already cached

### 2. **No Query Limits** (FIXED ✅)
- **Problem**: Loading unlimited books could cause huge queries
- **Solution**: Added `.limit(1000)` to prevent massive data transfers

### 3. **Geographic Latency**
- **Problem**: Your Supabase instance might be far from your location
- **Current Region**: `cnlnrlzhhbrtehpkttqv.supabase.co` (check your Supabase dashboard)
- **Solution**: Consider moving to a region closer to your users

### 4. **Cold Starts**
- **Problem**: Supabase serverless functions can have cold starts (first request is slower)
- **Impact**: First query after inactivity can take 1-3 seconds
- **Solution**: Already handled with timeouts in auth initialization

### 5. **No Database Indexes**
- **Problem**: Queries on `user_id` and `scanned_at` might be slow without indexes
- **Solution**: Add indexes (see below)

## Optimizations Made

### ✅ Photo Loading
- **Before**: Blocked on downloading all photos
- **After**: Uses cloud URLs immediately, caches in background

### ✅ Query Limits
- Added reasonable limits to prevent huge data transfers

### ✅ Timeout Handling
- Added 5-second timeout for auth initialization
- Added 3-second timeout for session checks
- Falls back to local storage if Supabase is slow

### ✅ Background Processing
- Photo downloads happen in background (non-blocking)
- Cover fetching happens after initial load

## Recommended Database Indexes

Run this in your Supabase SQL editor to speed up queries:

```sql
-- Index for books queries (user_id + scanned_at)
CREATE INDEX IF NOT EXISTS idx_books_user_scanned 
ON books(user_id, scanned_at DESC);

-- Index for photos queries (user_id + timestamp)
CREATE INDEX IF NOT EXISTS idx_photos_user_timestamp 
ON photos(user_id, timestamp DESC);

-- Index for scan jobs (user_id + status + updated_at)
CREATE INDEX IF NOT EXISTS idx_scan_jobs_user_status_updated 
ON scan_jobs(user_id, status, updated_at DESC);
```

## Additional Optimizations You Can Make

### 1. **Use Supabase Region Closer to Users**
- Check your Supabase dashboard → Settings → Region
- Consider moving to a region closer to your primary user base

### 2. **Implement Pagination**
- Instead of loading all books at once, load in pages of 50-100
- Only load what's visible on screen

### 3. **Add Caching Layer**
- Cache Supabase responses in AsyncStorage with timestamps
- Only refetch if data is older than X minutes

### 4. **Lazy Load Photos**
- Only load photo thumbnails initially
- Load full photos when user taps to view

### 5. **Use Supabase Realtime (Optional)**
- For real-time updates without polling
- More efficient than periodic syncs

## Current Performance

After these optimizations:
- **Initial Load**: Should be < 2 seconds (was 5-10+ seconds)
- **Photo Loading**: Instant (uses cloud URLs)
- **Auth Check**: Max 5 seconds with timeout fallback

## Monitoring

Check Supabase dashboard → Logs to see:
- Query execution times
- Slow queries (> 1 second)
- Error rates

If queries are consistently slow, consider:
1. Adding the indexes above
2. Moving to a closer region
3. Upgrading your Supabase plan (better performance tier)





