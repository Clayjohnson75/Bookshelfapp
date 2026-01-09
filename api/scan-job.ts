import type { VercelRequest, VercelResponse } from '@vercel/node';

// This endpoint creates a scan job that will be processed asynchronously
// The scan will continue even if the client disconnects
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'POST') {
    try {
      const { imageDataURL, userId, jobId } = req.body || {};
      if (!imageDataURL || typeof imageDataURL !== 'string') {
        return res.status(400).json({ error: 'imageDataURL required' });
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
      
      // Generate job ID if not provided
      const finalJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Create job record in database
      const { error: insertError } = await supabase
        .from('scan_jobs')
        .insert({
          id: finalJobId,
          user_id: userId || null,
          image_data: imageDataURL,
          status: 'pending',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error('[API] Error creating scan job:', insertError);
        return res.status(500).json({ error: 'Failed to create scan job' });
      }
      
      // Start processing asynchronously - this will continue even if client disconnects
      // If the function terminates early, a cron job will pick up pending jobs
      console.log(`[API] Starting background processing of scan job ${finalJobId}...`);
      
      // Get the host from the request to use for calling the scan API
      const hostHeader = req.headers.host || req.headers['x-forwarded-host'];
      const requestHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || undefined;
      
      // Start processing but don't wait for it - return immediately
      // This allows the function to work even if the app is closed
      processScanJob(finalJobId, imageDataURL, userId, requestHost).catch(async (err) => {
        console.error('[API] Background scan job failed:', err);
        // Update job status to failed in database
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const errorSupabase = createClient(supabaseUrl, supabaseServiceKey, {
            auth: {
              autoRefreshToken: false,
              persistSession: false
            }
          });
          await errorSupabase
            .from('scan_jobs')
            .update({ 
              status: 'failed',
              error: err?.message || String(err),
              updated_at: new Date().toISOString()
            })
            .eq('id', finalJobId);
        } catch (updateErr) {
          console.error('[API] Failed to update job status after error:', updateErr);
        }
      });
      
      // Return immediately - processing continues in background
      // Works whether app is open or closed
      return res.status(202).json({ 
        jobId: finalJobId,
        status: 'pending',
        message: 'Scan job created, processing in background. Results will be available when you reopen the app.'
      });
      
    } catch (e: any) {
      console.error('[API] Error creating scan job:', e);
      return res.status(500).json({ error: 'scan_job_failed', detail: e?.message || String(e) });
    }
  }
  
  // Check if this is a cron request BEFORE handling regular GET requests
  const isCronRequest = req.headers['user-agent']?.includes('vercel-cron') || 
                        req.headers['x-vercel-cron'] === '1' ||
                        req.query?.action === 'process-pending';
  
  // Handle cron job processing (GET or PUT from cron)
  if ((req.method === 'PUT' || req.method === 'GET') && isCronRequest) {
    try {
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
      
      // Get pending jobs
      const { data: pendingJobs, error } = await supabase
        .from('scan_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(10); // Process up to 10 at a time
      
      if (error) {
        console.error('[API] Error fetching pending jobs:', error);
        return res.status(500).json({ error: 'Failed to fetch pending jobs' });
      }
      
      if (!pendingJobs || pendingJobs.length === 0) {
        return res.status(200).json({ message: 'No pending jobs to process', processed: 0 });
      }
      
      console.log(`[API] Processing ${pendingJobs.length} pending scan jobs...`);
      
      // Process each pending job
      // Use production URL for cron jobs (no request host available)
      const results = await Promise.allSettled(
        pendingJobs.map(job => 
          processScanJob(job.id, job.image_data, job.user_id || undefined, undefined)
        )
      );
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      return res.status(200).json({ 
        message: `Processed ${pendingJobs.length} jobs`,
        processed: successful,
        failed: failed
      });
      
    } catch (e: any) {
      console.error('[API] Error processing pending jobs:', e);
      return res.status(500).json({ error: 'process_failed', detail: e?.message || String(e) });
    }
  }
  
  if (req.method === 'GET') {
    // Check status of a scan job (regular GET request, not cron)
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
      
      const { data, error } = await supabase
        .from('scan_jobs')
        .select('*')
        .eq('id', jobId)
        .single();
      
      if (error || !data) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      return res.status(200).json({
        jobId: data.id,
        status: data.status,
        books: data.books || [],
        error: data.error || null,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      });
      
    } catch (e: any) {
      console.error('[API] Error checking scan job status:', e);
      return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
    }
  }
  
  
  return res.status(405).json({ error: 'Method not allowed' });
}

// Background processing function
async function processScanJob(jobId: string, imageDataURL: string, userId: string | undefined, requestHost?: string) {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Database not configured');
  }
  
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  
  try {
    // Update status to processing
    await supabase
      .from('scan_jobs')
      .update({ 
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    // Determine the base URL for calling the scan API
    // Use the request host if available (from the original request)
    // Otherwise fall back to production URL or environment variable
    let baseUrl: string;
    
    if (requestHost) {
      // Use the host from the original request
      baseUrl = `https://${requestHost}`;
    } else {
      // Fallback: use production URL (never use VERCEL_URL as it might be preview)
      baseUrl = process.env.API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || 'https://bookshelfscan.app';
      
      // Ensure it's a full URL with https
      if (!baseUrl.startsWith('http')) {
        baseUrl = `https://${baseUrl}`;
      }
    }
    
    console.log(`[API] Processing scan job ${jobId} via scan API at ${baseUrl}/api/scan`);
    
    const scanResponse = await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataURL, userId })
    });
    
    if (!scanResponse.ok) {
      const errorText = await scanResponse.text().catch(() => '');
      throw new Error(`Scan API returned ${scanResponse.status}: ${errorText.substring(0, 200)}`);
    }
    
    const scanData = await scanResponse.json();
    const books = Array.isArray(scanData.books) ? scanData.books : [];
    
    // Update job with results
    await supabase
      .from('scan_jobs')
      .update({ 
        status: 'completed',
        books: books,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    console.log(`[API] Scan job ${jobId} completed with ${books.length} books`);
    
  } catch (error: any) {
    console.error(`[API] Scan job ${jobId} failed:`, error);
    
    // Update job with error
    await supabase
      .from('scan_jobs')
      .update({ 
        status: 'failed',
        error: error?.message || String(error),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
  }
}

