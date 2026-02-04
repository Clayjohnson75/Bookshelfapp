import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Optimize image for AI processing:
 * - Resize to max 2000px on longest side (AI models prefer this size)
 * - Convert to WebP format for lower latency and smaller file size
 * - Maintain aspect ratio
 * - Return optimized image as base64 data URL
 */
async function optimizeImageForAI(
  imageBuffer: Buffer,
  originalMimeType: string,
  jobId: string
): Promise<string> {
  try {
    const sharp = (await import('sharp')).default;
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Optimizing image: ${imageBuffer.length} bytes, format: ${originalMimeType}`);
    
    // Process image with sharp
    const optimizedBuffer = await sharp(imageBuffer)
      .resize(2000, 2000, {
        fit: 'inside', // Maintain aspect ratio, fit within 2000x2000
        withoutEnlargement: true, // Don't enlarge if already smaller
      })
      .webp({
        quality: 85, // Good balance between quality and file size
        effort: 4, // Moderate compression effort (0-6, higher = slower but better compression)
      })
      .toBuffer();
    
    const originalSize = imageBuffer.length;
    const optimizedSize = optimizedBuffer.length;
    const sizeReduction = ((originalSize - optimizedSize) / originalSize * 100).toFixed(1);
    
    console.log(`[API] [WORKER] [JOB ${jobId}] ✅ Image optimized: ${originalSize} bytes → ${optimizedSize} bytes (${sizeReduction}% reduction)`);
    
    // Convert to base64 data URL
    const base64 = optimizedBuffer.toString('base64');
    return `data:image/webp;base64,${base64}`;
    
  } catch (error: any) {
    // If sharp fails, fall back to original image
    console.error(`[API] [WORKER] [JOB ${jobId}] ⚠️ Image optimization failed:`, error?.message || error);
    console.log(`[API] [WORKER] [JOB ${jobId}] Falling back to original image format`);
    
    // Convert original buffer to base64 data URL
    const base64 = imageBuffer.toString('base64');
    return `data:${originalMimeType};base64,${base64}`;
  }
}

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
    // This endpoint is called by QStash, NOT by /api/scan
    const { jobId, scanId: requestScanId, userId } = req.body || {};
    
    if (!jobId) {
      console.error('[API] [WORKER] Missing jobId in request body');
      return res.status(400).json({ error: 'jobId required' });
    }
    
    console.log(`[API] [WORKER] Received job request: jobId=${jobId}, scanId=${requestScanId || 'none'}, userId=${userId || 'none'}`);

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
    // Use scanId from request, then from database, then generate from jobId
    const scanId = requestScanId || scan_id || `scan_${jobId.split('_')[1]}_${jobId.split('_')[2]}`;
    
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
    
    // Convert blob to buffer
    const arrayBuffer = await imageData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const originalMimeType = image_path.endsWith('.png') ? 'image/png' : image_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Image downloaded from storage (${buffer.length} bytes, format: ${originalMimeType})`);
    
    // Optimize image for AI processing (resize to max 2000px, convert to WebP)
    const imageDataURL = await optimizeImageForAI(buffer, originalMimeType, jobId);
    
    // Update job status to 'processing' before starting
    await supabase
      .from('scan_jobs')
      .update({
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Job status set to 'processing'`);
    
    // Import the processScanJob function from scan.ts (now exported)
    const { processScanJob } = await import('./scan');
    
    // Process the job (this is the heavy work: Gemini + OpenAI + validation)
    // This can take 60-90+ seconds, but QStash allows long-running workers
    // processScanJob will update the job status to 'completed' or 'failed' when done
    await processScanJob(imageDataURL, user_id, scanId, jobId);
    
    console.log(`[API] [WORKER] [JOB ${jobId}] Worker processing completed`);
    
    // Return success - QStash will mark the message as processed
    return res.status(200).json({ success: true, jobId });
    
  } catch (e: any) {
    console.error(`[API] [WORKER] [JOB ${req.body?.jobId || 'unknown'}] Error in scan worker:`, e);
    
    // Update job status to 'failed' if we have a jobId
    const failedJobId = req.body?.jobId;
    if (failedJobId) {
      try {
        const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (supabaseUrl && supabaseServiceKey) {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(supabaseUrl, supabaseServiceKey, {
            auth: {
              autoRefreshToken: false,
              persistSession: false
            }
          });
          
          await supabase
            .from('scan_jobs')
            .update({
              status: 'failed',
              error: JSON.stringify({ 
                code: 'worker_error', 
                message: e?.message || String(e),
                stack: e?.stack 
              }),
              updated_at: new Date().toISOString()
            })
            .eq('id', failedJobId);
          
          console.log(`[API] [WORKER] [JOB ${failedJobId}] Job status set to 'failed'`);
        }
      } catch (updateError) {
        console.error(`[API] [WORKER] Failed to update job status to 'failed':`, updateError);
      }
    }
    
    return res.status(500).json({ error: 'worker_failed', detail: e?.message || String(e) });
  }
}

