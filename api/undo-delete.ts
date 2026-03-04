import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateOpId } from '../lib/scanCorrelation';

/**
 * Undo a soft-delete action within the undo window.
 *
 * Restores rows by clearing `deleted_at` for the specific book IDs and/or photo IDs
 * that were soft-deleted in the action identified by `actionId`. Only restores rows
 * that belong to the authenticated user and that were soft-deleted within UNDO_WINDOW_MS
 * (10 minutes).
 *
 * IDOR: userId is derived from the Bearer token only; body.userId is ignored.
 *
 * POST body: { actionId, bookIds?: string[], photoIds?: string[] }
 *   - actionId: the actionId from the DeleteIntent (e.g. "del_1234567890_abc123")
 *   - bookIds: UUIDs of book rows to undelete (must belong to authed user)
 *   - photoIds: UUIDs of photo rows to undelete (must belong to authed user)
 *
 * Response: { ok: true, restoredBooks: number, restoredPhotos: number }
 */

const UNDO_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Authorization: Bearer <token> required' } });
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ ok: false, error: { code: 'database_not_configured', message: 'Database not configured' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ ok: false, error: { code: 'invalid_token', message: authError?.message ?? 'Invalid or expired token' } });
  }
  const authedUserId = userData.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { actionId, bookIds, photoIds } = body ?? {};
  const opId = (body?.opId as string | undefined) ?? generateOpId();

  if (!actionId || typeof actionId !== 'string') {
    return res.status(400).json({ ok: false, error: { code: 'missing_action_id', message: 'actionId is required' } });
  }
  if ((!bookIds || bookIds.length === 0) && (!photoIds || photoIds.length === 0)) {
    return res.status(400).json({ ok: false, error: { code: 'nothing_to_undo', message: 'bookIds or photoIds required' } });
  }

  // Validate IDs are UUIDs (basic guard against injection)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const safeBookIds: string[] = (Array.isArray(bookIds) ? bookIds : []).filter((id: unknown) => typeof id === 'string' && UUID_RE.test(id));
  const safePhotoIds: string[] = (Array.isArray(photoIds) ? photoIds : []).filter((id: unknown) => typeof id === 'string' && UUID_RE.test(id));

  // Undo window: only restore rows soft-deleted within the last UNDO_WINDOW_MS.
  // We filter by deleted_at >= (now - UNDO_WINDOW_MS) so stale undos are a no-op.
  const windowStart = new Date(Date.now() - UNDO_WINDOW_MS).toISOString();

  let restoredBooks = 0;
  let restoredPhotos = 0;
  const errors: string[] = [];

  // Restore books
  if (safeBookIds.length > 0) {
    const { data: bookRows, error: bookErr } = await supabase
      .from('books')
      .update({ deleted_at: null, status: 'approved', updated_at: new Date().toISOString() })
      .eq('user_id', authedUserId)
      .in('id', safeBookIds)
      .gte('deleted_at', windowStart) // only within undo window
      .select('id');

    if (bookErr) {
      errors.push(`books: ${bookErr.message}`);
    } else {
      restoredBooks = bookRows?.length ?? 0;
    }
  }

  // Restore photos
  if (safePhotoIds.length > 0) {
    const { data: photoRows, error: photoErr } = await supabase
      .from('photos')
      .update({ deleted_at: null, status: 'complete', updated_at: new Date().toISOString() })
      .eq('user_id', authedUserId)
      .in('id', safePhotoIds)
      .gte('deleted_at', windowStart) // only within undo window
      .select('id');

    if (photoErr) {
      errors.push(`photos: ${photoErr.message}`);
    } else {
      restoredPhotos = photoRows?.length ?? 0;
    }
  }

  if (errors.length > 0 && restoredBooks === 0 && restoredPhotos === 0) {
    return res.status(500).json({
      ok: false,
      error: { code: 'undo_failed', message: errors.join('; ') },
      opId,
    });
  }

  return res.status(200).json({
    ok: true,
    actionId,
    restoredBooks,
    restoredPhotos,
    errors: errors.length > 0 ? errors : undefined,
    opId,
  });
}
