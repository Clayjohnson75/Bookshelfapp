import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/scan-status?jobId=xxx
 * Poll endpoint to check scan job status
 * This is the single source of truth for job status
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  
  // CRITICAL: Make this endpoint explicitly non-cacheable
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');

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

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // CRITICAL: Select only the fields we need - use books column (not results)
    // Include progress, stage, and cancel fields for cancel + progress tracking
    const { data, error } = await supabase
      .from('scan_jobs')
      .select('id, status, books, error, progress, stage, stage_detail, cancel_requested, canceled_at, updated_at, created_at') // Select books column (not results) + progress/stage/cancel fields
      .eq('id', jobId)
      .single();

    if (error || !data) {
      console.log(`[API] [SCAN-STATUS] [JOB ${jobId}] Job not found:`, error?.message || 'No data');
      return res.status(200).json({ 
        jobId: jobId,
        status: 'not_found',
        books: [],
        error: { code: 'job_not_found', message: 'Job not found' }
      });
    }

    // Parse error if it's a JSON string
    let errorObj = null;
    if (data.error) {
      try {
        errorObj = typeof data.error === 'string' ? JSON.parse(data.error) : data.error;
      } catch {
        errorObj = { code: 'unknown_error', message: String(data.error) };
      }
    }
    
    // CRITICAL: Always return books from books column (not results)
    const booksArray = Array.isArray(data.books) ? data.books : [];
    const response = {
      jobId: data.id,
      status: data.status, // 'pending' | 'processing' | 'completed' | 'failed' | 'canceled'
      books: booksArray, // Always array - from books column (not results)
      error: errorObj,
      progress: data.progress !== null && data.progress !== undefined ? data.progress : 0, // 0-100
      stage: data.stage || null, // Current stage: queued/claimed/downloading/scanning/validating/enriching/completed/failed/canceled
      stage_detail: data.stage_detail || null, // Optional detail like "batch 1/2"
      cancel_requested: data.cancel_requested || false,
      canceled_at: data.canceled_at || null,
      updated_at: data.updated_at,
      created_at: data.created_at
    };
    
    // Log what we're returning - confirm books.length > 0 when completed
    console.log(`[API] [SCAN-STATUS] [JOB ${jobId}] ✅ Returning status: ${response.status}, books.length=${booksArray.length}, books.length>0=${booksArray.length > 0 ? 'YES' : 'NO'}`);
    if (response.status === 'completed' && booksArray.length === 0) {
      console.warn(`[API] [SCAN-STATUS] [JOB ${jobId}] ⚠️ WARNING: Status is 'completed' but books.length is 0!`);
    }
    
    return res.status(200).json(response);

  } catch (e: any) {
    console.error('[API] Error checking scan job status:', e);
    return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
  }
}

