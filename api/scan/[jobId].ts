import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/scan/[jobId]
 * Poll endpoint to check scan job status
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId required' });
    }

    // CRITICAL: Read from durable storage (Supabase), not in-memory state
    // This ensures all serverless instances see the same job state
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error(`[API] [JOB ${jobId}] Database not configured for job status check`);
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Read from durable storage - this works across all serverless instances
    console.log(`[API] [JOB ${jobId}] Reading job status from durable storage (Supabase)`);
    const { data, error } = await supabase
      .from('scan_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Return job status - only status, books, and error
    // Only include books if status is 'completed'
    // Parse error if it's a JSON string
    let errorObj = null;
    if (data.error) {
      try {
        errorObj = typeof data.error === 'string' ? JSON.parse(data.error) : data.error;
      } catch {
        errorObj = { code: 'unknown_error', message: data.error };
      }
    }
    
    return res.status(200).json({
      status: data.status, // 'pending' | 'processing' | 'completed' | 'failed'
      books: data.status === 'completed' ? (data.books || []) : [],
      error: errorObj
    });

  } catch (e: any) {
    console.error('[API] Error checking scan job status:', e);
    return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
  }
}

