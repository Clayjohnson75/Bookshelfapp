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
      const { imageDataURL, jobId } = req.body || {};
      if (!imageDataURL || typeof imageDataURL !== 'string') {
        return res.status(400).json({ error: 'imageDataURL required' });
      }

      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
      if (!token) {
        return res.status(401).json({ ok: false, error: 'reauth_required' });
      }

      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: 'Server not configured' });
      }

      const { createClient } = await import('@supabase/supabase-js');
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });

      let userId: string;
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data?.user) {
        try {
          const { verifySupabaseJwt } = await import('./verifySupabaseJwt');
          const authResult = await verifySupabaseJwt(token, supabaseUrl);
          userId = authResult.userId;
        } catch (verifyErr: any) {
          console.error('[AUTH] getUser and JWKS verify failed:', error?.message ?? error, verifyErr?.message ?? verifyErr);
          return res.status(401).json({ ok: false, error: 'reauth_required' });
        }
      } else {
        userId = data.user.id;
      }
      const supabase = supabaseAdmin;

      // Generate job ID if not provided
      const finalJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Create job record in database (user_id from JWT only)
      const { error: insertError } = await supabase
        .from('scan_jobs')
        .insert({
          id: finalJobId,
          user_id: userId,
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
      console.log(`[API] Starting background processing of scan job ${finalJobId}...`);

      const hostHeader = req.headers.host || req.headers['x-forwarded-host'];
      const requestHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || undefined;

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
  // DISABLED: Sweeper is disabled when QStash is configured to prevent double-processing
  // QStash handles all job delivery via /api/scan-worker with idempotency
  if ((req.method === 'PUT' || req.method === 'GET') && isCronRequest) {
    const qstashToken = process.env.QSTASH_TOKEN;
    if (qstashToken) {
      console.log('[API] [SWEEPER] Disabled: QStash is configured. All jobs are processed via QStash webhook (/api/scan-worker) with idempotency.');
      return res.status(200).json({ 
        message: 'Sweeper disabled - QStash is handling job processing',
        disabled: true,
        reason: 'qstash_configured'
      });
    }
    
    // Only run sweeper if QStash is NOT configured (fallback mode)
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
        console.error('[API] [SWEEPER] Error fetching pending jobs:', error);
        return res.status(500).json({ error: 'Failed to fetch pending jobs' });
      }
      
      if (!pendingJobs || pendingJobs.length === 0) {
        return res.status(200).json({ message: 'No pending jobs to process', processed: 0 });
      }
      
      console.log(`[API] [SWEEPER] Processing ${pendingJobs.length} pending scan jobs... (QStash not configured, using fallback mode)`);
      
      // Process each pending job
      // FIXED: Now passes null for imageDataURL - processScanJob will fetch from storage
      const results = await Promise.allSettled(
        pendingJobs.map(job => 
          processScanJob(job.id, job.image_data || null, job.user_id || undefined, undefined)
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
      console.error('[API] [SWEEPER] Error processing pending jobs:', e);
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
// FIXED: Now fetches image from storage and calls scan pipeline directly (does NOT call /api/scan)
async function processScanJob(jobId: string, imageDataURL: string | null, userId: string | undefined, requestHost?: string) {
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
    // Fetch job from database to get image_path
    const { data: jobData, error: jobError } = await supabase
      .from('scan_jobs')
      .select('image_path, scan_id, user_id')
      .eq('id', jobId)
      .single();
    
    if (jobError || !jobData) {
      throw new Error(`Job not found: ${jobError?.message || 'Not found'}`);
    }
    
    const { image_path, scan_id, user_id } = jobData;
    const scanId = scan_id || `scan_${jobId.split('_')[1]}_${jobId.split('_')[2]}`;
    const finalUserId = userId || user_id;
    
    // Update status to processing
    await supabase
      .from('scan_jobs')
      .update({ 
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    // Fetch image from storage if image_path exists, otherwise use imageDataURL (legacy)
    let imageDataURLToUse: string;
    
    if (image_path) {
      // Download image from Supabase Storage
      console.log(`[API] [SCAN-JOB] [JOB ${jobId}] Downloading image from storage: ${image_path}`);
      const { data: imageData, error: downloadError } = await supabase.storage
        .from('photos')
        .download(image_path);
      
      if (downloadError || !imageData) {
        throw new Error(`Failed to download image from storage: ${downloadError?.message || 'No blob'}`);
      }
      
      // Convert blob to base64 data URL
      const arrayBuffer = await imageData.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString('base64');
      const mimeType = image_path.endsWith('.png') ? 'image/png' : image_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      imageDataURLToUse = `data:${mimeType};base64,${base64}`;
      console.log(`[API] [SCAN-JOB] [JOB ${jobId}] Image downloaded from storage (${buffer.length} bytes)`);
    } else if (imageDataURL) {
      // Legacy: use imageDataURL if image_path not available
      console.log(`[API] [SCAN-JOB] [JOB ${jobId}] Using legacy imageDataURL from job data`);
      imageDataURLToUse = imageDataURL;
    } else {
      throw new Error('No image_path or imageDataURL found in job');
    }
    
    // Import the real processScanJob from scan.ts
    // This allows the QStash worker to process jobs correctly
    const { processScanJob: realProcessScanJob } = await import('./scan');
    
    // Generate scanId if not available
    const finalScanId = scanId || `scan_${jobId.split('_')[1]}_${jobId.split('_')[2]}`;
    
    console.log(`[API] [SCAN-JOB] [JOB ${jobId}] Calling processScanJob from scan.ts (scanId: ${finalScanId})`);
    
    // Call the real processScanJob function with the fetched image
    await realProcessScanJob(imageDataURLToUse, finalUserId, finalScanId, jobId);
    
    console.log(`[API] [SCAN-JOB] [JOB ${jobId}] ✅ Scan processing completed successfully`);
    
  } catch (error: any) {
    console.error(`[API] [SCAN-JOB] [JOB ${jobId}] Failed:`, error);
    
    // Update job with error
    await supabase
      .from('scan_jobs')
      .update({ 
        status: 'failed',
        error: JSON.stringify({
          code: 'scan_job_error',
          message: error?.message || String(error)
        }),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
  }
}

