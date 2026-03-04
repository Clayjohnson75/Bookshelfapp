import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/scan-mark-imported
 * Atomic + idempotent "Approve Scan Job": one DB transaction (RPC approve_scan_job) that
 * 1) UPDATE books SET status='approved' WHERE source_scan_job_id IN (job ids) AND user_id AND status='pending'
 * 2) UPDATE scan_jobs SET status='closed', books JSONB each status='approved' WHERE id IN (job ids)
 * Returns { ok, books_approved, jobs_closed }. Second call is no-op (pending=0).
 * Invariant: if scan_job.status='closed' then 0 pending books for that job (enforced in DB function).
 * Body: { userId: string, jobIds: string[] }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Bearer token required. userId is derived from token — never trusted from body.
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authorization: Bearer <token> required' });
  }

  try {
    const { jobIds } = req.body || {};

    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(200).json({ ok: true, books_approved: 0, jobs_closed: 0 });
    }

    const validIds = jobIds.filter((id: any) => typeof id === 'string').slice(0, 50);

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify token and derive userId from it — never from the request body.
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: authErr?.message ?? 'Invalid or expired token' });
    }
    const userId = userData.user.id;

    const { data, error } = await supabase.rpc('approve_scan_job', {
      p_user_id: userId,
      p_job_ids: validIds,
    });

    if (error) {
      console.error('[API] scan-mark-imported RPC failed:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const books_approved = typeof data?.books_approved === 'number' ? data.books_approved : 0;
    const jobs_closed = typeof data?.jobs_closed === 'number' ? data.jobs_closed : 0;

    return res.status(200).json({ ok: true, books_approved, jobs_closed });
  } catch (e: any) {
    console.error('[API] scan-mark-imported error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
