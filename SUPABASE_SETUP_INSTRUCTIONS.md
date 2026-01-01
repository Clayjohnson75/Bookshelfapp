# Supabase Setup Instructions for Permanent Data Storage

This document explains how to set up Supabase to ensure all account data and photos persist permanently across app versions.

## 1. Run Database Migrations

Run these SQL migrations in your Supabase SQL Editor (in order):

1. **Books Table** (if not already created):
   - File: `supabase-migration-add-books-table.sql`
   - Creates the `books` table for storing user books

2. **Photos Table** (NEW - REQUIRED):
   - File: `supabase-migration-add-photos-table.sql`
   - Creates the `photos` table for storing photo metadata

3. **User Stats Table** (if not already created):
   - File: `supabase-migration-add-user-stats-table.sql`
   - Creates the `user_stats` table for tracking user statistics

## 2. Create Supabase Storage Bucket

You need to create a storage bucket for photos:

1. Go to your Supabase Dashboard
2. Navigate to **Storage** in the left sidebar
3. Click **New bucket**
4. Name it: `photos`
5. Make it **Public** (so photos can be accessed via URL)
6. Click **Create bucket**

## 3. Set Up Storage Policies

After creating the bucket, set up Row Level Security (RLS) policies:

```sql
-- Allow users to upload their own photos
CREATE POLICY "Users can upload own photos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'photos' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow users to view their own photos
CREATE POLICY "Users can view own photos"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'photos' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow users to update their own photos
CREATE POLICY "Users can update own photos"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'photos' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow users to delete their own photos
CREATE POLICY "Users can delete own photos"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'photos' AND
  auth.uid()::text = (storage.foldername(name))[1]
);
```

## 4. Verify Setup

After completing the above steps:

1. **Database Tables**: Verify these tables exist:
   - `public.books`
   - `public.photos`
   - `public.profiles`
   - `public.user_stats`

2. **Storage Bucket**: Verify the `photos` bucket exists and is public

3. **RLS Policies**: Verify all policies are enabled on the tables and storage bucket

## 5. How It Works

Once set up, the app will:

- **On App Startup**: Load all books and photos from Supabase (primary source)
- **On Save**: Save to both AsyncStorage (for offline access) and Supabase (for permanent storage)
- **On Photo Upload**: Upload photos to Supabase Storage and save metadata to the `photos` table
- **On Delete**: Delete from both local storage and Supabase

This ensures:
- ✅ Data persists across app versions
- ✅ Data syncs across devices
- ✅ Photos are permanently stored in the cloud
- ✅ Account details are always available

## Troubleshooting

If photos aren't uploading:

1. Check that the `photos` bucket exists and is public
2. Verify storage policies are set up correctly
3. Check browser console for upload errors
4. Ensure Supabase credentials are correct in `app.config.js`

If data isn't loading:

1. Check that all migrations have been run
2. Verify RLS policies allow users to read their own data
3. Check browser console for loading errors
4. Ensure user is authenticated




