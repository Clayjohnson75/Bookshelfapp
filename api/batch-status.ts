import type { VercelRequest, VercelResponse } from '@vercel/node';

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];

/**
 * GET /api/batch-status?batchId=xxx
 * Optional lightweight batch progress endpoint.
 * Returns totalJobs, doneJobs, currentJobProgress so the client can compute
 * overall = (doneJobs + (currentJobProgress ?? 0) / 100) / totalJobs without
 * per-job polling or client-side progressByJobId.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { batchId } = req.query;
    if (!batchId || typeof batchId !== 'string') {
      return res.status(400).json({ error: 'batchId required' });
    }

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: rows, error } = await supabase
      .from('scan_jobs')
      .select('id, status, progress, stage')
      .eq('batch_id', batchId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[API] [BATCH-STATUS] Error:', error.message);
      return res.status(500).json({ error: 'batch_status_failed', detail: error.message });
    }

    const jobs = (rows ?? []) as Array<{ id: string; status: string; progress?: number | null; stage?: string | null }>;
    const totalJobs = jobs.length;
    const doneJobs = jobs.filter((j) => TERMINAL_STATUSES.includes(j.status)).length;
    const active = jobs.find((j) => j.status === 'pending' || j.status === 'processing');
    const currentJobProgress =
      active && active.progress != null ? Math.min(100, Math.max(0, Number(active.progress))) : null;
    const currentJobStage = active?.stage ?? null;

    return res.status(200).json({
      batchId,
      totalJobs,
      doneJobs,
      currentJobProgress,
      currentJobStage,
    });
  } catch (e: any) {
    console.error('[API] [BATCH-STATUS] Error:', e?.message ?? e);
    return res.status(500).json({ error: 'batch_status_failed', detail: e?.message ?? String(e) });
  }
}
