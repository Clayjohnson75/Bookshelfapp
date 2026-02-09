import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { jobId, userId } = req.body || {};
    
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ 
        ok: false,
        error: { code: 'missing_job_id', message: 'jobId is required' }
      });
    }

    // Get Supabase client
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ 
        ok: false,
        error: { code: 'database_not_configured', message: 'Database not configured' }
      });
    }
    
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Verify caller owns the job (match user_id)
    // If userId is provided, verify ownership; if not, allow cancel (for guest users)
    const { data: existingJob, error: fetchError } = await supabase
      .from('scan_jobs')
      .select('id, user_id, status, progress')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchError || !existingJob) {
      console.error(`[API] [CANCEL] [JOB ${jobId}] Job not found:`, fetchError?.message || 'No data');
      return res.status(404).json({ 
        ok: false,
        error: { code: 'job_not_found', message: 'Job not found' }
      });
    }

    // Verify ownership if userId is provided
    if (userId && existingJob.user_id !== userId) {
      console.error(`[API] [CANCEL] [JOB ${jobId}] Unauthorized: userId mismatch`);
      return res.status(403).json({ 
        ok: false,
        error: { code: 'unauthorized', message: 'You do not have permission to cancel this job' }
      });
    }

    // Check if already canceled
    if (existingJob.status === 'canceled') {
      console.log(`[API] [CANCEL] [JOB ${jobId}] Job already canceled`);
      return res.status(200).json({ ok: true, alreadyCanceled: true });
    }

    // Check if already completed
    if (existingJob.status === 'completed') {
      console.log(`[API] [CANCEL] [JOB ${jobId}] Job already completed, cannot cancel`);
      return res.status(400).json({ 
        ok: false,
        error: { code: 'already_completed', message: 'Job is already completed and cannot be canceled' }
      });
    }

    // Update job to canceled state
    const currentProgress = existingJob.progress || 0;
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('scan_jobs')
      .update({
        cancel_requested: true,
        cancel_requested_at: now, // Track when cancellation was requested
        canceled_at: now,
        status: 'canceled',
        stage: 'canceled',
        progress: Math.min(currentProgress, 99), // Don't jump to 100, keep current or cap at 99
        updated_at: now
      })
      .eq('id', jobId);

    if (updateError) {
      console.error(`[API] [CANCEL] [JOB ${jobId}] Failed to cancel job:`, updateError);
      return res.status(500).json({ 
        ok: false,
        error: { code: 'cancel_failed', message: 'Failed to cancel job' }
      });
    }

    console.log(`[API] [CANCEL] [JOB ${jobId}] ✅ Job canceled successfully`);
    return res.status(200).json({ ok: true });
    
  } catch (error: any) {
    console.error('[API] [CANCEL] Error canceling scan:', error);
    return res.status(500).json({ 
      ok: false,
      error: { code: 'internal_error', message: error?.message || 'Internal server error' }
    });
  }
}

