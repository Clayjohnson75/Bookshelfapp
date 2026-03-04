/**
 * Stuck job reaper: marks scan jobs stuck in "processing" as "failed" so the UI can retry.
 * Call via cron (e.g. every 10 min). If status is processing and updated_at < now - 10 min, mark failed with code: timeout.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const isCron =
    req.headers['user-agent']?.includes('vercel-cron') ||
    req.headers['x-vercel-cron'] === '1';

  if (!isCron && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Reaper only allowed from cron' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  const { data: stuck, error: fetchErr } = await supabase
    .from('scan_jobs')
    .select('id, updated_at, status')
    .eq('status', 'processing')
    .is('deleted_at', null)
    .lt('updated_at', cutoff);

  if (fetchErr) {
    console.error('[SCAN_REAPER] fetch failed', fetchErr);
    return res.status(500).json({ error: 'fetch_failed', detail: fetchErr.message });
  }

  const jobs = stuck ?? [];
  if (jobs.length === 0) {
    return res.status(200).json({ ok: true, reaped: 0, message: 'No stuck jobs' });
  }

  const failPatch = {
    status: 'failed',
    stage: 'failed',
    progress: 95,
    error: JSON.stringify({
      code: 'timeout',
      message: 'Job stuck in processing (reaper)',
    }),
    updated_at: new Date().toISOString(),
  };

  let reaped = 0;
  for (const job of jobs) {
    const { data, error } = await supabase
      .from('scan_jobs')
      .update(failPatch)
      .eq('id', job.id)
      .eq('status', 'processing')
      .select('id');
    if (!error && data?.length) reaped++;
    else if (error) console.error('[SCAN_REAPER] update failed', job.id, error.message);
  }

  console.log('[SCAN_REAPER]', { reaped, total: jobs.length, cutoff });
  return res.status(200).json({
    ok: true,
    reaped,
    total: jobs.length,
    cutoff,
  });
}
