/**
 * Server repair for dangling photo rows: photos that have storage_path set
 * but no corresponding object in storage (phantom rows that keep showing in profile).
 *
 * Finds photos for the authenticated user where:
 *   - deleted_at IS NULL
 *   - storage_path IS NOT NULL and non-empty
 *   - updated_at is older than N minutes (default 15) so we don't touch in-flight uploads
 *   - storage file does NOT exist at storage_path
 *
 * Marks each such row: deleted_at = now(), updated_at = now(), status = 'discarded'
 * so profile queries (deleted_at IS NULL, status != 'discarded') stop returning them.
 *
 * POST (auth required). Query: ?minutes=15 (optional, default 15).
 * Returns { repaired, photoIds }.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_MINUTES = 15;

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

  const minutes = Math.max(1, Math.min(1440, Number((req.query.minutes as string) || DEFAULT_MINUTES) || DEFAULT_MINUTES));
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

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

  // Photos that might be dangling: have storage_path, not deleted, older than N minutes
  const { data: candidates, error: listErr } = await admin
    .from('photos')
    .select('id, storage_path')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('storage_path', 'is', null)
    .lt('updated_at', cutoff);

  if (listErr) {
    console.error('[REPAIR_DANGLING_PHOTOS] list error', listErr.message);
    return res.status(500).json({ error: 'Failed to list photos', code: listErr.code });
  }

  const rows = (candidates ?? []).filter(
    (r: { storage_path?: string | null }) => typeof r?.storage_path === 'string' && r.storage_path.trim().length > 0
  );
  const toRepair: string[] = [];

  for (const row of rows) {
    const storagePath = (row as { storage_path: string }).storage_path.trim();
    if (!storagePath) continue;
    try {
      const { error: downloadError } = await admin.storage.from('photos').download(storagePath);
      if (downloadError) toRepair.push((row as { id: string }).id);
    } catch (e) {
      console.warn('[REPAIR_DANGLING_PHOTOS] storage check failed for', (row as { id: string }).id, (e as Error)?.message);
    }
  }

  if (toRepair.length === 0) {
    return res.status(200).json({ repaired: 0, photoIds: [] });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await admin
    .from('photos')
    .update({ deleted_at: now, updated_at: now, status: 'discarded' })
    .eq('user_id', userId)
    .in('id', toRepair)
    .select('id');

  if (updateErr) {
    console.error('[REPAIR_DANGLING_PHOTOS] update error', updateErr.message);
    return res.status(500).json({ error: 'Failed to repair photos', code: updateErr.code });
  }

  const repaired = Array.isArray(updated) ? updated.length : 0;
  const photoIds = (updated ?? []).map((r: { id: string }) => r.id);
  console.log('[REPAIR_DANGLING_PHOTOS]', { userId: userId.slice(0, 8), repaired, photoIds: photoIds.slice(0, 5).map((id: string) => id.slice(0, 8)) });
  return res.status(200).json({ repaired, photoIds });
}
