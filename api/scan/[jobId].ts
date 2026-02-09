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
  
  // CRITICAL: Make this endpoint explicitly non-cacheable
  // Prevent 304 Not Modified responses that break polling
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  // Remove ETag to prevent conditional GET / 304 responses
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');

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

    // Read from durable storage - SELECT only the fields we need
    // CRITICAL: Select status, books (NOT results), error, id, stage, progress, stage_detail to ensure we get the canonical data
    const { data, error } = await supabase
      .from('scan_jobs')
      .select('id, status, books, error, stage, progress, stage_detail, updated_at') // Select books column (not results), plus stage/progress/stage_detail
      .eq('id', jobId)
      .single();

    if (error || !data) {
      console.log(`[API] [JOB ${jobId}] Job not found in database:`, error?.message || 'No data');
      // Always return 200 with JSON, never 304
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
    
    // CRITICAL: Return books when status is 'completed'
    // This is the key fix - frontend needs books when status='completed'
    const booksArray = Array.isArray(data.books) ? data.books : [];
    
    // CRITICAL: When status is 'completed', return status and books explicitly
    if (data.status === 'completed') {
      const response = {
        status: 'completed',
        books: booksArray, // Return books from books column
        stage: data.stage || 'completed',
        progress: data.progress !== null && data.progress !== undefined ? data.progress : 100,
        stage_detail: data.stage_detail || null
      };
      console.log(`[API] [JOB ${jobId}] ✅ Returning completed status with ${booksArray.length} books`);
      if (booksArray.length === 0) {
        console.warn(`[API] [JOB ${jobId}] ⚠️ WARNING: Status is 'completed' but books.length is 0!`);
      }
      return res.status(200).json(response);
    }
    
    // For other statuses, return full response including stage/progress/stage_detail
    // Don't log every poll when still processing - reduces log noise (client polls every 3s)
    const response = {
      jobId: data.id,
      status: data.status, // 'pending' | 'processing' | 'failed'
      books: [], // Empty array for non-completed statuses
      stage: data.stage || null, // Current stage: queued | downloading | optimizing | gemini | validating | enriching | completed | failed
      progress: data.progress !== null && data.progress !== undefined ? data.progress : null, // 0-100 or null
      stage_detail: data.stage_detail || null, // Optional detail like "batch 1/2"
      error: errorObj
    };
    return res.status(200).json(response);

  } catch (e: any) {
    console.error('[API] Error checking scan job status:', e);
    return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
  }
}

