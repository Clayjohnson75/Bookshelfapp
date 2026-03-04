/**
 * Clear library: soft-delete ALL photos and books for the current user by user_id.
 * Does NOT rely on client state or counts — runs server-side with service role so
 * every row for auth.uid() is updated regardless of what the client has.
 *
 * POST (auth required). Body: none.
 * Returns { ok, photosUpdated, booksUpdated, profilePhotosUpdated }.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.replace(/Bearer\s+/i, '').trim() : '';
  if (!token) return res.status(401).json({ error: 'Authorization required' });

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const userId = authData.user.id;
  const now = new Date().toISOString();

  let photosUpdated = 0;
  let booksUpdated = 0;
  let profilePhotosUpdated = 0;

  // Soft-delete all books for this user (by user_id, not local state).
  const { data: booksData, error: booksErr } = await admin
    .from('books')
    .update({ deleted_at: now, updated_at: now, status: 'rejected' })
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('id');
  if (!booksErr && Array.isArray(booksData)) booksUpdated = booksData.length;
  if (booksErr) {
    console.error('[CLEAR_LIBRARY] books update error', booksErr.message);
    return res.status(500).json({ ok: false, error: 'Failed to clear books', code: booksErr.code });
  }

  // Select all photo rows for this user (any status) to get storage_path for removal, then soft-delete ALL.
  const { data: photosToDelete, error: photosSelectErr } = await admin
    .from('photos')
    .select('id, storage_path')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (photosSelectErr) {
    console.error('[CLEAR_LIBRARY] photos select error', photosSelectErr.message);
    return res.status(500).json({ ok: false, error: 'Failed to list photos', code: photosSelectErr.code });
  }
  const storagePaths = (photosToDelete ?? [])
    .map((p: { storage_path?: string | null }) => p.storage_path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);

  // Soft-delete ALL photos for this user (regardless of status).
  const { data: photosData, error: photosErr } = await admin
    .from('photos')
    .update({ deleted_at: now, updated_at: now, status: 'discarded' })
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('id');
  if (!photosErr && Array.isArray(photosData)) photosUpdated = photosData.length;
  if (photosErr) {
    console.error('[CLEAR_LIBRARY] photos update error', photosErr.message);
    return res.status(500).json({ ok: false, error: 'Failed to clear photos', code: photosErr.code });
  }

  // Remove storage objects so files are not left in the bucket.
  if (storagePaths.length > 0) {
    const { error: storageErr } = await admin.storage.from('photos').remove(storagePaths);
    if (storageErr) {
      console.warn('[CLEAR_LIBRARY] storage remove (non-fatal)', storageErr.message, 'paths:', storagePaths.length);
    }
  }

  // Soft-delete profile_photos for this user. Table is keyed by user_id only (no id column); do not .select() to avoid "id does not exist".
  const { error: profileErr } = await admin
    .from('profile_photos')
    .update({ deleted_at: now })
    .eq('user_id', userId);
  if (!profileErr) profilePhotosUpdated = 1; // we don't get row count without select; 1 indicates update ran
  if (profileErr) {
    // Schema mismatch (e.g. table missing or column profile_photos.id referenced by RLS): skip, don't block clear.
    if (/column.*\.id does not exist/i.test(profileErr.message ?? '') || /relation.*does not exist/i.test(profileErr.message ?? '')) {
      console.warn('[CLEAR_LIBRARY] profile_photos update skipped (schema mismatch — table may not exist or has no id column):', profileErr.message);
    } else {
      console.warn('[CLEAR_LIBRARY] profile_photos update (non-fatal)', profileErr.message);
    }
  }

  // Reset user_stats scan counts.
  await admin
    .from('user_stats')
    .update({ total_scans: 0, monthly_scans: 0, last_scan_at: null, updated_at: now })
    .eq('user_id', userId);

  console.log('[CLEAR_LIBRARY]', { userId: userId.slice(0, 8), photosUpdated, booksUpdated, profilePhotosUpdated });
  return res.status(200).json({
    ok: true,
    photosUpdated,
    booksUpdated,
    profilePhotosUpdated,
  });
}
