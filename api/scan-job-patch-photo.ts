import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/scan-job-patch-photo
 * Enforces invariant: every scan_job must have photo_id set.
 * After dedupe, ALWAYS patch scan_jobs.photo_id = canonicalPhotoId. No exceptions.
 * Call after client dedupe decides canonicalPhotoId (reused ? existing.id : newPhotoId).
 * Body: { jobId: string, photoId: string, userId: string }
 * 1) Update scan_jobs set photo_id = photoId where id = jobId and user_id = userId.
 * 2) Migrate books: UPDATE books SET source_photo_id = photoId WHERE user_id = userId AND source_photo_id = oldPhotoId (so no book references the old photo).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Bearer token required. userId is derived from token — never from body.
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Authorization: Bearer <token> required' } });
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const { jobId, photoId } = req.body || {};
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'missing_job_id', message: 'jobId is required' } });
    }
    if (!photoId || typeof photoId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'missing_photo_id', message: 'photoId is required' } });
    }
    if (!UUID_REGEX.test(photoId)) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_photo_id', message: 'photoId must be a UUID' } });
    }

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ ok: false, error: { code: 'database_not_configured', message: 'Database not configured' } });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify token and derive userId — never trust userId from body.
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: { code: 'invalid_token', message: authErr?.message ?? 'Invalid or expired token' } });
    }
    const userId = userData.user.id;

    const { data: job, error: fetchErr } = await supabase
      .from('scan_jobs')
      .select('id, user_id, photo_id')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchErr || !job) {
      return res.status(404).json({ ok: false, error: { code: 'job_not_found', message: 'Scan job not found' } });
    }
    if (job.user_id !== userId) {
      return res.status(403).json({ ok: false, error: { code: 'unauthorized', message: 'Job does not belong to user' } });
    }

    const oldPhotoId = job.photo_id ?? null;

    const { error: updateErr } = await supabase
      .from('scan_jobs')
      .update({ photo_id: photoId, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('user_id', userId);

    if (updateErr) {
      console.warn('[SCAN_JOB_PATCH_PHOTO] update failed:', updateErr.message);
      return res.status(500).json({ ok: false, error: { code: 'update_failed', message: updateErr.message } });
    }

    const scanJobsUpdated = 1;

    // Photo dedupe migration: migrate books from oldPhotoId to canonical photoId so no book references the old photo.
    let booksUpdated = 0;
    if (oldPhotoId && oldPhotoId !== photoId) {
      const { data: booksUpdatedRows, error: booksErr } = await supabase
        .from('books')
        .update({ source_photo_id: photoId, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('source_photo_id', oldPhotoId)
        .is('deleted_at', null)
        .select('id');
      if (!booksErr && Array.isArray(booksUpdatedRows)) {
        booksUpdated = booksUpdatedRows.length;
        if (booksUpdated > 0) {
          console.log('[SCAN_JOB_PATCH_PHOTO] books migrated', { oldPhotoId, canonicalPhotoId: photoId, count: booksUpdated });
        }
      }
    }

    console.log('[PHOTO_DEDUPE_MIGRATE_BOOKS]', JSON.stringify({
      oldPhotoId,
      canonicalPhotoId: photoId,
      booksUpdated,
      scanJobsUpdated,
    }));
    console.log('[SCAN_JOB_PATCH_PHOTO] jobId=', jobId, 'photo_id=', photoId);
    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    console.error('[SCAN_JOB_PATCH_PHOTO]', e);
    return res.status(500).json({ ok: false, error: { code: 'server_error', message: String(e) } });
  }
}
