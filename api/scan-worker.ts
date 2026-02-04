import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/scan-worker
 * Worker endpoint that processes scan jobs
 * Called by QStash (or directly for testing)
 */
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
    // QStash sends only jobId in req.body (image is in storage)
    const { jobId } = req.body || {};
    
    if (!jobId) {
      console.error('[API] [WORKER] Missing jobId');
      return res.status(400).json({ error: 'jobId required' });
    }

    // Load job from Supabase to get image_path and other metadata
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error(`[API] [WORKER] [JOB ${jobId}] Database not configured`);
      return res.status(500).json({ error: 'Database not configured' });
    }
    
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    // Fetch job from Supabase
    const { data: jobData, error: jobError } = await supabase
      .from('scan_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    
    if (jobError || !jobData) {
      console.error(`[API] [WORKER] [JOB ${jobId}] Job not found:`, jobError);
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const { image_path, user_id, image_hash, scan_id } = jobData;
    const scanId = scan_id || `scan_${jobId.split('_')[1]}_${jobId.split('_')[2]}`; // Use stored scan_id or extract from jobId
    
    if (!image_path) {
      console.error(`[API] [WORKER] [JOB ${jobId}] No image_path in job data`);
      await supabase
        .from('scan_jobs')
        .update({
          status: 'failed',
          error: JSON.stringify({ code: 'missing_image_path', message: 'Image path not found in job' }),
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      return res.status(400).json({ error: 'Image path not found in job' });
    }
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Starting worker processing (image_path: ${image_path})...`);
    
    // Download image from Supabase Storage
    const { data: imageData, error: downloadError } = await supabase.storage
      .from('photos')
      .download(image_path);
    
    if (downloadError || !imageData) {
      console.error(`[API] [WORKER] [JOB ${jobId}] Failed to download image from storage:`, downloadError);
      await supabase
        .from('scan_jobs')
        .update({
          status: 'failed',
          error: JSON.stringify({ code: 'image_download_failed', message: downloadError?.message || 'Failed to download image' }),
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      return res.status(500).json({ error: 'Failed to download image from storage' });
    }
    
    // Convert blob to base64 data URL for processScanJob
    const arrayBuffer = await imageData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');
    const mimeType = image_path.endsWith('.png') ? 'image/png' : image_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const imageDataURL = `data:${mimeType};base64,${base64}`;
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Image downloaded from storage (${buffer.length} bytes)`);
    
    // Import the processScanJob function from scan.ts (now exported)
    const { processScanJob } = await import('./scan');
    
    // Process the job (this is the heavy work: Gemini + OpenAI + validation)
    // This can take 60-90+ seconds, but QStash allows long-running workers
    await processScanJob(imageDataURL, user_id, scanId, jobId);
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Worker processing completed`);
    
    // Return success - QStash will mark the message as processed
    return res.status(200).json({ success: true, jobId });
    
  } catch (e: any) {
    console.error('[API] [WORKER] Error in scan worker:', e);
    return res.status(500).json({ error: 'worker_failed', detail: e?.message || String(e) });
  }
}

