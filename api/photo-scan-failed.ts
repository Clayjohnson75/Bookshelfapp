/**
 * Mark a photo as scan_failed when create_scan_job fails (e.g. 413).
 * POST body: { photoId, code?, message? }. Auth: Bearer required. Only updates rows for authed user.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

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
    return res.status(401).json({ error: 'Authorization required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const userId = userData.user.id;

  const body = (req.body || {}) as Record<string, unknown>;
  const photoId = typeof body.photoId === 'string' ? body.photoId.trim() : null;
  if (!photoId) {
    return res.status(400).json({ error: 'photoId required' });
  }
  const code = body.code != null ? String(body.code) : undefined;
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : undefined;
  const scanError = { code: code ?? 'unknown', message: message ?? '' };

  // Only use DB-allowed status; never invent a status (scan_failed is in photos_status_check).
  const { data, error } = await supabase
    .from('photos')
    .update({
      status: 'scan_failed',
      scan_error: scanError,
      updated_at: new Date().toISOString(),
    })
    .eq('id', photoId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[PHOTO_SCAN_FAILED]', error.message, { photoId: photoId.slice(0, 8), userId: userId.slice(0, 8) });
    return res.status(500).json({ error: 'Failed to update photo', code: error.code });
  }
  if (!data) {
    return res.status(404).json({ error: 'Photo not found or not owned by user' });
  }
  return res.status(200).json({ ok: true });
}
