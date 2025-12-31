-- ============================================================
-- SCAN ANALYTICS QUERIES
-- ============================================================
-- Run these queries in your Supabase SQL Editor to view scan analytics
-- ============================================================

-- ============================================================
-- 1. USER SCAN SUMMARY
-- Shows total scans, monthly scans, and last scan date for each user
-- ============================================================
-- Note: If you get an error accessing auth.users, remove the email line
SELECT 
  p.username,
  p.display_name,
  au.email,  -- Remove this line if you get permission errors
  p.subscription_tier,
  COALESCE(us.total_scans, 0) as total_scans,
  COALESCE(us.monthly_scans, 0) as monthly_scans,
  us.last_scan_at,
  us.created_at as account_created
FROM public.profiles p
LEFT JOIN auth.users au ON p.id = au.id
LEFT JOIN public.user_stats us ON p.id = us.user_id
ORDER BY COALESCE(us.total_scans, 0) DESC;

-- Alternative version without email (if you can't access auth.users):
-- SELECT 
--   p.username,
--   p.display_name,
--   p.subscription_tier,
--   COALESCE(us.total_scans, 0) as total_scans,
--   COALESCE(us.monthly_scans, 0) as monthly_scans,
--   us.last_scan_at,
--   us.created_at as account_created
-- FROM public.profiles p
-- LEFT JOIN public.user_stats us ON p.id = us.user_id
-- ORDER BY COALESCE(us.total_scans, 0) DESC;

-- ============================================================
-- 2. SCANS PER USER WITH BOOK COUNTS
-- Shows how many scans each user has and total books found
-- ============================================================
SELECT 
  p.username,
  p.display_name,
  p.subscription_tier,
  COUNT(DISTINCT ph.id) as total_photos_scanned,
  COALESCE(us.total_scans, 0) as total_scans_from_stats,
  COUNT(DISTINCT b.id) as total_books_found,
  COUNT(DISTINCT CASE WHEN b.status = 'approved' THEN b.id END) as approved_books,
  COUNT(DISTINCT CASE WHEN b.status = 'pending' THEN b.id END) as pending_books,
  COUNT(DISTINCT CASE WHEN b.status = 'rejected' THEN b.id END) as rejected_books
FROM public.profiles p
LEFT JOIN public.user_stats us ON p.id = us.user_id
LEFT JOIN public.photos ph ON p.id = ph.user_id
LEFT JOIN public.books b ON p.id = b.user_id
GROUP BY p.id, p.username, p.display_name, p.subscription_tier, us.total_scans
ORDER BY total_photos_scanned DESC;

-- ============================================================
-- 3. BOOKS SCANNED BY EACH USER
-- Shows all books that each user has scanned
-- ============================================================
SELECT 
  p.username,
  p.display_name,
  b.title,
  b.author,
  b.status,
  b.scanned_at,
  ph.id as photo_id,
  ph.caption as photo_caption,
  ph.timestamp as photo_timestamp
FROM public.profiles p
INNER JOIN public.books b ON p.id = b.user_id
LEFT JOIN public.photos ph ON b.user_id = ph.user_id 
  AND b.title = ANY(
    SELECT jsonb_array_elements_text(ph.books::jsonb->'title')
  )
WHERE b.status IN ('approved', 'pending')
ORDER BY p.username, b.scanned_at DESC;

-- ============================================================
-- 4. BOOKS FROM PHOTOS (JSONB)
-- Shows books extracted from photos JSONB field
-- ============================================================
SELECT 
  p.username,
  p.display_name,
  ph.id as photo_id,
  ph.caption,
  ph.timestamp,
  ph.created_at,
  jsonb_array_length(ph.books) as books_count,
  ph.books as books_json
FROM public.profiles p
INNER JOIN public.photos ph ON p.id = ph.user_id
WHERE jsonb_array_length(ph.books) > 0
ORDER BY ph.timestamp DESC;

-- ============================================================
-- 5. MOST SCANNED BOOKS (across all users)
-- Shows which books are scanned most frequently
-- ============================================================
SELECT 
  b.title,
  b.author,
  COUNT(DISTINCT b.user_id) as unique_users_scanned,
  COUNT(b.id) as total_times_scanned,
  COUNT(DISTINCT CASE WHEN b.status = 'approved' THEN b.user_id END) as users_with_approved
FROM public.books b
WHERE b.title IS NOT NULL
GROUP BY b.title, b.author
HAVING COUNT(b.id) > 1
ORDER BY total_times_scanned DESC, unique_users_scanned DESC
LIMIT 50;

-- ============================================================
-- 6. USER ACTIVITY TIMELINE
-- Shows scan activity over time for each user
-- ============================================================
SELECT 
  p.username,
  DATE(ph.created_at) as scan_date,
  COUNT(DISTINCT ph.id) as photos_scanned,
  COUNT(DISTINCT b.id) as books_found
FROM public.profiles p
LEFT JOIN public.photos ph ON p.id = ph.user_id
LEFT JOIN public.books b ON p.id = b.user_id 
  AND b.scanned_at::date = ph.created_at::date
WHERE ph.created_at IS NOT NULL
GROUP BY p.username, DATE(ph.created_at)
ORDER BY scan_date DESC, photos_scanned DESC;

-- ============================================================
-- 7. DETAILED USER SCAN REPORT
-- Complete breakdown for a specific user (replace USERNAME)
-- ============================================================
-- Replace 'USERNAME' with the actual username you want to see
SELECT 
  p.username,
  p.display_name,
  p.subscription_tier,
  -- Stats
  COALESCE(us.total_scans, 0) as total_scans,
  COALESCE(us.monthly_scans, 0) as monthly_scans,
  us.last_scan_at,
  -- Photos
  COUNT(DISTINCT ph.id) as total_photos,
  -- Books
  COUNT(DISTINCT b.id) as total_books,
  COUNT(DISTINCT CASE WHEN b.status = 'approved' THEN b.id END) as approved_books,
  COUNT(DISTINCT CASE WHEN b.status = 'pending' THEN b.id END) as pending_books,
  COUNT(DISTINCT CASE WHEN b.status = 'rejected' THEN b.id END) as rejected_books
FROM public.profiles p
LEFT JOIN public.user_stats us ON p.id = us.user_id
LEFT JOIN public.photos ph ON p.id = ph.user_id
LEFT JOIN public.books b ON p.id = b.user_id
WHERE p.username = 'USERNAME'  -- Change this to the username you want
GROUP BY p.id, p.username, p.display_name, p.subscription_tier, us.total_scans, us.monthly_scans, us.last_scan_at;

-- ============================================================
-- 8. ALL BOOKS FOR A SPECIFIC USER
-- Shows all books scanned by a specific user (replace USERNAME)
-- ============================================================
-- Replace 'USERNAME' with the actual username
SELECT 
  b.title,
  b.author,
  b.status,
  b.scanned_at,
  b.confidence,
  b.cover_url,
  ph.id as photo_id,
  ph.caption as from_photo
FROM public.profiles p
INNER JOIN public.books b ON p.id = b.user_id
LEFT JOIN public.photos ph ON b.user_id = ph.user_id
WHERE p.username = 'USERNAME'  -- Change this to the username you want
ORDER BY b.scanned_at DESC;

-- ============================================================
-- 9. SUMMARY STATISTICS
-- Overall app statistics
-- ============================================================
SELECT 
  COUNT(DISTINCT p.id) as total_users,
  COUNT(DISTINCT CASE WHEN us.total_scans > 0 THEN p.id END) as active_users,
  SUM(COALESCE(us.total_scans, 0)) as total_scans_all_users,
  AVG(COALESCE(us.total_scans, 0)) as avg_scans_per_user,
  COUNT(DISTINCT ph.id) as total_photos,
  COUNT(DISTINCT b.id) as total_books,
  COUNT(DISTINCT CASE WHEN b.status = 'approved' THEN b.id END) as total_approved_books,
  COUNT(DISTINCT CASE WHEN p.subscription_tier = 'pro' THEN p.id END) as pro_users,
  COUNT(DISTINCT CASE WHEN p.subscription_tier = 'free' THEN p.id END) as free_users
FROM public.profiles p
LEFT JOIN public.user_stats us ON p.id = us.user_id
LEFT JOIN public.photos ph ON p.id = ph.user_id
LEFT JOIN public.books b ON p.id = b.user_id;

-- ============================================================
-- 10. RECENT SCANS (Last 24 hours)
-- Shows all scans from the last 24 hours
-- ============================================================
SELECT 
  p.username,
  p.display_name,
  ph.id as photo_id,
  ph.caption,
  TO_TIMESTAMP(ph.timestamp / 1000) as scan_time,
  jsonb_array_length(ph.books) as books_found,
  COUNT(DISTINCT b.id) as books_in_database
FROM public.profiles p
INNER JOIN public.photos ph ON p.id = ph.user_id
LEFT JOIN public.books b ON p.id = b.user_id 
  AND DATE(b.scanned_at) = DATE(TO_TIMESTAMP(ph.timestamp / 1000))
WHERE ph.created_at > NOW() - INTERVAL '24 hours'
GROUP BY p.username, p.display_name, ph.id, ph.caption, ph.timestamp
ORDER BY ph.timestamp DESC;

