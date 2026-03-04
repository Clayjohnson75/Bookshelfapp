/**
 * Minimal end-to-end invariant check for a photoId.
 *
 * Invariant: (1) photos row exists (draft or complete) → (2) file at storage_path →
 * (3) scan_job row exists with photo_id → (4) scan_job completes →
 * (5) books rows with source_photo_id = photoId and user_id.
 *
 * GET ?photoId=xxx — returns which steps are ok so we can see where the chain breaks
 * (e.g. "complete but no books" → step5=0 or step3 missing).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const photoId = typeof req.query.photoId === 'string' ? req.query.photoId.trim() : '';
  if (!photoId || !UUID_REGEX.test(photoId)) {
    return res.status(400).json({ error: 'photoId required (UUID)' });
  }

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

  const invariant: {
    photoId: string;
    userId: string;
    step1_photosRow: boolean;
    step2_storageExists: boolean;
    step3_scanJobExists: boolean;
    step4_scanJobCompleted: boolean;
    step5_booksCount: number;
    photoStatus?: string;
    storagePath?: string | null;
    scanJobStatus?: string | null;
    scanJobId?: string | null;
  } = {
    photoId: photoId.slice(0, 8),
    userId: userId.slice(0, 8),
    step1_photosRow: false,
    step2_storageExists: false,
    step3_scanJobExists: false,
    step4_scanJobCompleted: false,
    step5_booksCount: 0,
  };

  // Step 1: photos row exists (draft or complete)
  const { data: photoRow, error: photoErr } = await admin
    .from('photos')
    .select('id, status, storage_path')
    .eq('id', photoId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (photoErr) {
    console.error('[PHOTO_INVARIANT] step1 error', { photoId: photoId.slice(0, 8), error: photoErr.message });
    return res.status(200).json({ ...invariant, _error: 'step1_query', message: photoErr.message });
  }
  invariant.step1_photosRow = !!photoRow;
  invariant.photoStatus = photoRow?.status ?? undefined;
  invariant.storagePath = photoRow?.storage_path ?? undefined;

  // Canonical path: <userId>/<photoId>.jpg — if DB differs, that's the bug
  const { getCanonicalPhotoStoragePath } = await import('../lib/photoStoragePath');
  const expectedPath = getCanonicalPhotoStoragePath(userId, photoId);
  if (photoRow?.storage_path && photoRow.storage_path !== expectedPath) {
    console.warn('[STORAGE_PATH] mismatch for same photoId', { photoId, expectedPath, actualPath: photoRow.storage_path });
  }

  if (!photoRow?.storage_path) {
    return res.status(200).json(invariant);
  }

  // Step 2: file exists in storage — same bucket and path as upload (photos bucket, photos.storage_path)
  try {
    const { error: downloadError } = await admin.storage.from('photos').download(photoRow.storage_path);
    invariant.step2_storageExists = !downloadError;
  } catch {
    invariant.step2_storageExists = false;
  }

  // Step 3 & 4: scan_job exists with photo_id, and completed
  const { data: jobRow, error: jobErr } = await admin
    .from('scan_jobs')
    .select('id, status, photo_id')
    .eq('photo_id', photoId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!jobErr && jobRow) {
    invariant.step3_scanJobExists = true;
    invariant.scanJobId = jobRow.id;
    invariant.scanJobStatus = jobRow.status;
    invariant.step4_scanJobCompleted = (jobRow.status === 'completed' || jobRow.status === 'complete') as boolean;
  }

  // Step 5: books with source_photo_id = photoId
  const { count, error: booksErr } = await admin
    .from('books')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('source_photo_id', photoId)
    .is('deleted_at', null);

  if (!booksErr && typeof count === 'number') {
    invariant.step5_booksCount = count;
  }

  console.log('[PHOTO_INVARIANT]', JSON.stringify(invariant));
  return res.status(200).json(invariant);
}
