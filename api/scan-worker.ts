import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import { IncomingMessage } from 'http';
import { Receiver } from '@upstash/qstash';

// Disable body parsing - we need raw bytes for signature verification
export const config = { api: { bodyParser: false } };

// Increase max duration for long-running scans (blocking pipeline needs more time)
// Vercel Pro allows up to 300s, Hobby allows 60s
export const maxDuration = 300; // Increased to handle full blocking pipeline
export const dynamic = "force-dynamic";

// Initialize QStash Receiver for signature verification
const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
});

/**
 * Check if job has been canceled
 * Returns true if canceled, false otherwise
 * If canceled, also ensures status/stage are set correctly
 */
async function checkCanceled(
  supabase: any,
  jobId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('scan_jobs')
    .select('cancel_requested, cancel_requested_at, status')
    .eq('id', jobId)
    .maybeSingle();
  
  if (error || !data) {
    console.warn(`[WORKER] [JOB ${jobId}] Error checking cancel status:`, error?.message || 'No data');
    return false; // If we can't check, continue processing
  }
  
  if (data.cancel_requested === true || data.status === 'canceled') {
    console.log(`[WORKER] [JOB ${jobId}] ⛔ Job canceled (cancel_requested=${data.cancel_requested}, cancel_requested_at=${data.cancel_requested_at || 'N/A'}), stopping processing`);
    
    // Ensure status/stage are set to canceled
    await supabase
      .from('scan_jobs')
      .update({
        status: 'canceled',
        stage: 'canceled',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    return true;
  }
  
  return false;
}

/**
 * Helper to update scan job progress and stage
 * Rules:
 * - Never decrease progress (only move forward)
 * - Cap at 95 until final save, then set 100
 * - If job is already processing, don't overwrite backwards
 * - Don't update if job is canceled
 */
async function updateProgress(
  supabase: any,
  jobId: string,
  progress: number,
  stage: string,
  stageDetail?: string
): Promise<void> {
  // Check if canceled first - don't update progress if canceled
  if (await checkCanceled(supabase, jobId)) {
    return; // Job is canceled, don't update progress
  }
  
  // Cap progress at 95 until final save (100 is set when marking completed)
  const cappedProgress = progress >= 95 ? 95 : progress;
  
  // Get current progress to ensure we never decrease
  const { data: current } = await supabase
    .from('scan_jobs')
    .select('progress, stage, status')
    .eq('id', jobId)
    .maybeSingle();
  
  // If job is already processing/completed, only update if progress increases
  if (current && (current.status === 'processing' || current.status === 'completed')) {
    const currentProgress = current.progress || 0;
    if (cappedProgress < currentProgress) {
      console.log(`[WORKER] [JOB ${jobId}] Skipping progress update: ${cappedProgress} < ${currentProgress} (not decreasing)`);
      return;
    }
  }
  
  const updateData: any = {
    progress: cappedProgress,
    stage: stage,
    updated_at: new Date().toISOString(),
  };
  
  // Add stage_detail if provided (assuming column exists, will be ignored if not)
  if (stageDetail) {
    updateData.stage_detail = stageDetail;
  }
  
  await supabase
    .from('scan_jobs')
    .update(updateData)
    .eq('id', jobId);
  
  console.log(`[WORKER] [JOB ${jobId}] Progress: ${cappedProgress}%, Stage: ${stage}${stageDetail ? ` (${stageDetail})` : ''}`);
}

// Alias for backward compatibility
const setProgress = updateProgress;

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
  // Log environment configuration for debugging
  console.log("[ENV]", {
    vercelEnv: process.env.VERCEL_ENV,
    supabaseUrl: process.env.SUPABASE_URL,
    serviceKeyPrefix: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").slice(0, 6),
  });
  
  // Log QStash headers to detect duplicate deliveries
  console.log("[WORKER] qstash headers", {
    messageId: req.headers["upstash-message-id"] || req.headers["x-qstash-message-id"] || null,
    signature: Boolean(req.headers["upstash-signature"] || req.headers["x-qstash-signature"]),
  });
  
  // LOGGING: First line - log request details before any processing
  const method = req.method || 'UNKNOWN';
  const url = req.url || req.headers['x-forwarded-url'] || 'unknown';
  const contentType = req.headers['content-type'] || 'unknown';
  
  // QStash sends signature in Upstash-Signature header (case-sensitive, JWT-looking string)
  const signature = (req.headers['upstash-signature'] || 
                     req.headers['Upstash-Signature'] || 
                     req.headers['x-upstash-signature'] ||
                     req.headers['x-qstash-signature']) as string | undefined;
  const hasUpstashSignature = !!signature;
  const hasQStashMessageId = !!req.headers['x-qstash-message-id'];
  const hasQStashHeaders = hasUpstashSignature || hasQStashMessageId;
  
  // CRITICAL: Read raw body bytes EXACTLY as sent (no parsing, no reconstruction)
  // QStash signature must be verified against exact raw request body bytes
  // Use raw-body to read from request stream before any parsing occurs
  let rawBody: string = '';
  let parsedBody: any = null;
  
  try {
    // Read raw body from request stream using raw-body package
    // This gives us the exact bytes as sent by QStash
    // When encoding is specified, getRawBody returns a string directly
    rawBody = await getRawBody(req as unknown as IncomingMessage, {
      limit: '10mb', // Reasonable limit for JSON payloads
      encoding: 'utf8'
    });
    
    // Parse JSON from raw body string (after we have the raw bytes for verification)
    parsedBody = JSON.parse(rawBody);
  } catch (rawBodyError: any) {
    // If raw body read fails, return 500 - no fallback allowed
    console.error(`[API] [WORKER] ❌ Failed to read raw body: ${rawBodyError?.message || rawBodyError}`);
    console.error(`[API] [WORKER] Raw body read error details:`, {
      name: rawBodyError?.name,
      message: rawBodyError?.message,
      stack: rawBodyError?.stack
    });
    console.log(`[API] [WORKER] RESPONSE: status=500 (Raw body read failed)`);
    return res.status(500).json({ 
      error: 'raw_body_read_failed', 
      detail: 'Failed to read raw request body for signature verification' 
    });
  }
  
  const bodyLength = rawBody.length;
  console.log(`[API] [WORKER] REQUEST: method=${method}, url=${url}, content-type=${contentType}, bodyLength=${bodyLength}, upstash-signature=${hasUpstashSignature}, x-qstash-message-id=${hasQStashMessageId}`);
  
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    console.log(`[API] [WORKER] RESPONSE: status=200 (OPTIONS)`);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.log(`[API] [WORKER] RESPONSE: status=405 (Method not allowed)`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // SIGNATURE VERIFICATION: Use official @upstash/qstash Receiver
  // QStash signature is in Upstash-Signature header
  // Must verify against exact raw request body string (not parsed JSON)
  if (hasUpstashSignature && signature) {
    const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
    
    console.log(`[API] [WORKER] Signature verification: signature present (length=${signature.length}), hasCurrentKey=${!!currentSigningKey}, hasNextKey=${!!nextSigningKey}, rawBodyLength=${rawBody.length}`);
    
    // If signing keys are configured, verify signature using official Receiver
    if (currentSigningKey || nextSigningKey) {
      try {
        const isValid = await receiver.verify({
          signature: signature,
          body: rawBody,
        });
        
        if (!isValid) {
          console.error(`[API] [WORKER] ❌ Signature invalid: signature=${signature?.substring(0, 50)}..., hasCurrentKey=${!!currentSigningKey}, hasNextKey=${!!nextSigningKey}, rawBodyLength=${rawBody.length}`);
          console.log(`[API] [WORKER] RESPONSE: status=401 (Signature invalid)`);
          return res.status(401).json({ error: 'Invalid signature' });
        }
        
        console.log(`[API] [WORKER] ✅ Signature verified using @upstash/qstash Receiver`);
      } catch (sigError: any) {
        console.error(`[API] [WORKER] ❌ Signature verification error: ${sigError?.message || sigError}`);
        console.log(`[API] [WORKER] RESPONSE: status=401 (Signature verification failed)`);
        return res.status(401).json({ error: 'Signature verification failed' });
      }
    } else {
      // No signing keys configured - log warning but allow (for development/testing)
      console.warn(`[API] [WORKER] ⚠️ QStash signature present but no signing keys configured (QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY) - allowing request`);
    }
  }

  let finalStatus = 500;
  try {
    // Detect invocation source: QStash webhook vs sweeper/cron
    const isCronRequest = req.headers['user-agent']?.includes('vercel-cron') || req.headers['x-vercel-cron'] === '1';
    const mode = hasQStashHeaders ? 'qstash' : isCronRequest ? 'sweeper' : 'unknown';
    
    // QStash sends only jobId in body (image is in storage)
    // This endpoint is called by QStash, NOT by /api/scan
    // Use parsedBody (parsed from raw body) for consistency
    const { jobId, scanId: requestScanId, userId, batchId } = parsedBody || {};
    const messageId = req.headers["upstash-message-id"] || req.headers["x-qstash-message-id"] || null;
    
    if (!jobId) {
      console.error(`[API] [WORKER] [MODE=${mode}] Missing jobId in request body`);
      finalStatus = 400;
      console.log(`[API] [WORKER] RESPONSE: status=${finalStatus} (Missing jobId)`);
      return res.status(finalStatus).json({ error: 'jobId required' });
    }
    
    // Log batch info if provided
    const batchLogPrefix = batchId ? `[BATCH ${batchId}]` : '';
    console.log(`[API] [WORKER] ${batchLogPrefix} [MODE=${mode}] [JOB ${jobId}] Received job request: scanId=${requestScanId || 'none'}, userId=${userId || 'none'}, messageId=${messageId || 'N/A'}`);

    // Load job from Supabase to get image_path and other metadata
    // Standardize to SUPABASE_URL (not EXPO_PUBLIC_SUPABASE_URL) for server-side code
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error(`[API] [WORKER] [MODE=${mode}] [JOB ${jobId}] Database not configured`);
      finalStatus = 500;
      console.log(`[API] [WORKER] RESPONSE: status=${finalStatus} (Database not configured)`);
      return res.status(finalStatus).json({ error: 'Database not configured' });
    }
    
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    /**
     * Ensure a profile row exists in public.profiles table
     * This is called before inserting books to maintain FK integrity
     * HARD FAIL: If this fails, the scan job will be marked as failed
     * @param supabase - Supabase client with service role key
     * @param userId - User ID from auth (can be null/undefined for guest users)
     * @returns true if profile row was created/exists, throws error if creation fails
     * @throws Error if profile creation fails (will be caught and job marked failed)
     */
    const ensureProfileRow = async (supabase: any, userId: string | null | undefined): Promise<boolean> => {
      // Skip for guest users (null/undefined userId)
      if (!userId) {
        return false;
      }
      
      try {
        // Upsert profile row - no-op if it already exists
        // Use id = userId (UUID from auth.users)
        const { data, error } = await supabase
          .from('profiles')
          .upsert({ id: userId }, { onConflict: 'id' })
          .select('id')
          .maybeSingle();
        
        if (error) {
          // If error is "duplicate key" or similar, profile already exists - that's fine
          if (error.code === '23505' || error.message?.includes('duplicate') || error.message?.includes('already exists')) {
            console.log(`[WORKER] Profile row already exists: ${userId}`);
            return true; // Return true - profile exists, that's what we need
          }
          // Other errors are CRITICAL - throw to fail the job
          const errorMsg = `Failed to ensure profile row for ${userId}: ${error.message || error.code || JSON.stringify(error)}`;
          console.error(`[WORKER] ❌ CRITICAL: ${errorMsg}`);
          throw new Error(errorMsg);
        }
        
        // If data is returned, profile was created or already existed
        if (data) {
          console.log(`[WORKER] ✅ Profile row exists: ${userId}`);
          return true;
        }
        
        // If no data and no error, profile already existed (upsert returned nothing but no error)
        console.log(`[WORKER] Profile row already exists: ${userId}`);
        return true;
      } catch (err: any) {
        // Re-throw - this is a hard fail, don't catch it here
        const errorMsg = err?.message || String(err);
        console.error(`[WORKER] ❌ CRITICAL: Exception ensuring profile row for ${userId}: ${errorMsg}`);
        throw err; // Re-throw to be caught by caller
      }
    };
    
    // Ensure profile row exists before processing (maintains FK integrity)
    // HARD FAIL: If this fails, job will be marked as failed and we return 500
    try {
      await ensureProfileRow(supabase, userId);
    } catch (profileError: any) {
      console.error(`[WORKER] [JOB ${jobId}] ❌ Failed to ensure profile row, marking job as failed`);
      // Mark job as failed immediately
      await supabase.from("scan_jobs").update({
        status: "failed",
        error: JSON.stringify({
          type: "profile_creation_failed",
          message: profileError?.message || String(profileError),
        }),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
      // Return 500 so QStash doesn't retry (this is a permanent failure)
      return res.status(500).json({ error: "profile_creation_failed", detail: profileError?.message || String(profileError) });
    }
    
    // IDEMPOTENCY: Atomically claim the job by updating status from 'pending' to 'processing'
    // 
    // HOW IDEMPOTENCY WORKS:
    // 1. We query for jobs with status IN ('pending', 'processing') to handle edge cases
    // 2. We only update if status is 'pending' (using .eq('status', 'pending'))
    // 3. If update returns 0 rows, the job was already claimed (status was 'processing' or doesn't exist)
    // 4. If update returns 1 row, we successfully claimed it (status was 'pending' → 'processing')
    // 5. This ensures only ONE worker can claim a job, even if multiple requests arrive simultaneously
    //
    // Why check IN ('pending','processing')? 
    // - If job is 'pending': We can claim it → update succeeds
    // - If job is 'processing': Another worker already claimed it → update fails (0 rows)
    // - If job is 'completed'/'failed': Not in our filter → update fails (0 rows)
    // - This prevents race conditions where two workers try to claim the same job
    // 1) Atomic claim: pending -> processing
    const claimStart = Date.now();
    const claimRes = await supabase
      .from("scan_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "pending")
      .select("id,status,updated_at")
      .maybeSingle();

    console.log("[WORKER] claim result", {
      ms: Date.now() - claimStart,
      jobId,
      data: claimRes.data,
      error: claimRes.error?.message || null,
    });

    // 2) Handle the 3 possible outcomes correctly
    if (claimRes.error) {
      console.error("[WORKER] claim update failed", claimRes.error);
      // mark job failed with claimRes.error.message
      await supabase.from("scan_jobs").update({
        status: "failed",
        error: JSON.stringify({ type: "claim_failed", message: claimRes.error.message }),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);

      return res.status(500).json({ error: "claim_failed" });
    }

    if (!claimRes.data) {
      // Nothing updated. Could be: already processing, already completed, or still pending (race/RLS).
      const { data: current, error: readErr } = await supabase
        .from("scan_jobs")
        .select("id,status,updated_at")
        .eq("id", jobId)
        .maybeSingle();

      console.log("[WORKER] claim missed; current row", {
        jobId,
        current,
        readErr: readErr?.message || null,
      });

      // If it's truly already processing/completed, idempotent return is fine:
      if (current?.status && current.status !== "pending") {
        return res.status(200).json({ ok: true, reason: `already_${current.status}` });
      }

      // If it's STILL pending, that means claim didn't work (RLS, schema cache, etc). RETRY claim a few times:
      for (let i = 1; i <= 5; i++) {
        await new Promise(r => setTimeout(r, 200));
        const retry = await supabase
          .from("scan_jobs")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .eq("id", jobId)
          .eq("status", "pending")
          .select("id,status,updated_at")
          .maybeSingle();

        console.log("[WORKER] claim retry", { i, data: retry.data, error: retry.error?.message || null });

        if (retry.error) break;
        if (retry.data) {
          // claimed on retry → continue pipeline
          break;
        }
      }

      // After retries, if still not claimed: mark failed (otherwise your app polls forever)
      const { data: after } = await supabase.from("scan_jobs").select("status").eq("id", jobId).maybeSingle();
      if (after?.status === "pending") {
        await supabase.from("scan_jobs").update({
          status: "failed",
          error: JSON.stringify({ type: "claim_failed_zero_rows" }),
          updated_at: new Date().toISOString(),
        }).eq("id", jobId);

        return res.status(500).json({ error: "claim_failed_zero_rows" });
      }

      return res.status(200).json({ ok: true, reason: `claim_missed_status=${after?.status}` });
    }

    // If we got here, we successfully claimed (status is now processing).
    console.log("[WORKER] ✅ claimed job", { jobId, status: claimRes.data.status });
    
    // Check if job was canceled before we claimed it (idempotent cancel check)
    if (await checkCanceled(supabase, jobId)) {
      console.log(`[WORKER] [JOB ${jobId}] Job was canceled, returning 200 (idempotent)`);
      return res.status(200).json({ ok: true, reason: 'canceled' });
    }
    
    // Set progress after claim
    await updateProgress(supabase, jobId, 10, 'claimed');
    
    // Get the full job data for processing
    const { data: updateData, error: fetchError } = await supabase
      .from('scan_jobs')
      .select('id, status, image_path, user_id, image_hash, scan_id')
      .eq('id', jobId)
      .single();
    
    if (!updateData || fetchError) {
      console.error("[WORKER] Failed to fetch job data after claim", { jobId, error: fetchError?.message || null });
      await supabase.from("scan_jobs").update({
        status: "failed",
        error: JSON.stringify({ type: "claim_fetch_failed", message: fetchError?.message || "Job data not found" }),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
      return res.status(500).json({ error: "claim_fetch_failed" });
    }
    
    // Check canceled again after fetching job data
    if (await checkCanceled(supabase, jobId)) {
      console.log(`[WORKER] [JOB ${jobId}] Job was canceled after fetch, returning 200 (idempotent)`);
      return res.status(200).json({ ok: true, reason: 'canceled' });
    }
    
    // Process the entire scan pipeline synchronously before responding
      try {
        const { image_path, user_id, image_hash, scan_id } = updateData;
        // Use scanId from request, then from database, then generate from jobId
        const scanId = requestScanId || scan_id || `scan_${jobId.split('_')[1]}_${jobId.split('_')[2]}`;
      
      console.log(`[WORKER] processing start`, { jobId, scanId });
        
        if (!image_path) {
        throw new Error('missing_image_path: Image path not found in job');
      }
      
      // STAGE: download image
      console.log(`[WORKER] STAGE: download image`, { jobId, image_path });
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Canceled before download, returning`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      await updateProgress(supabase, jobId, 15, 'downloading');
      
        const { data: imageData, error: downloadError } = await supabase.storage
          .from('photos')
          .download(image_path);
        
        if (downloadError || !imageData) {
        throw new Error(`image_download_failed: ${downloadError?.message || 'Failed to download image'}`);
        }
        
        // Convert blob to buffer
        const arrayBuffer = await imageData.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const originalMimeType = image_path.endsWith('.png') ? 'image/png' : image_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        
      console.log(`[WORKER] STAGE: download image complete`, { jobId, bytes: buffer.length, format: originalMimeType });
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Canceled after download, returning`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      await updateProgress(supabase, jobId, 20, 'downloaded');
      
      // STAGE: optimize image
      console.log(`[WORKER] STAGE: optimize image`, { jobId });
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Canceled before optimize, returning`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      await updateProgress(supabase, jobId, 25, 'optimizing');
      
        const imageDataURL = await optimizeImageForAI(buffer, originalMimeType, jobId);
      console.log(`[WORKER] STAGE: optimize image complete`, { jobId });
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Canceled after optimize, returning`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      await updateProgress(supabase, jobId, 30, 'optimized');
      
      // STAGE: gemini/openai processing
      console.log(`[WORKER] STAGE: gemini start`, { jobId, scanId });
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Canceled before scanning, returning`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      await updateProgress(supabase, jobId, 40, 'scanning');
        const { processScanJob } = await import('./scan');
        
        // Process the job (this is the heavy work: Gemini + OpenAI + validation)
        // processScanJob will update the job status to 'completed' or 'failed' when done
        await processScanJob(imageDataURL, user_id, scanId, jobId);
      console.log(`[WORKER] STAGE: gemini end`, { jobId, scanId });
      
      // Check canceled after processing completes (before final status check)
      if (await checkCanceled(supabase, jobId)) {
        console.log(`[WORKER] [JOB ${jobId}] Job was canceled after processing, returning 200 (idempotent)`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      }
      
      // Verify job was completed
      const { data: finalJob } = await supabase
              .from('scan_jobs')
        .select('id, status, books')
        .eq('id', jobId)
        .single();
      
      if (finalJob?.status === 'completed') {
        console.log(`[WORKER] ✅ completed`, { jobId, books: finalJob.books?.length || 0 });
        return res.status(200).json({ ok: true });
      } else if (finalJob?.status === 'canceled') {
        console.log(`[WORKER] [JOB ${jobId}] Job was canceled, returning 200 (idempotent)`);
        return res.status(200).json({ ok: true, reason: 'canceled' });
      } else {
        // Job was marked as failed by processScanJob
        const errorMsg = finalJob?.status || 'unknown_status';
        throw new Error(`Job processing failed with status: ${errorMsg}`);
      }
      
    } catch (e: any) {
      console.error(`[WORKER] ❌ failed`, { jobId, err: e?.message || e });
      
      await supabase.from("scan_jobs").update({
        status: "failed",
        stage: "failed",
        progress: null,
        error: JSON.stringify({ type: "worker_failed", message: e?.message || String(e) }),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
      
      // IMPORTANT: return non-2xx so QStash retries
      return res.status(500).json({ ok: false, error: "worker_failed" });
    }
    
  } catch (e: any) {
    const mode = hasQStashHeaders ? 'qstash' : 
                 (req.headers['user-agent']?.includes('vercel-cron') || req.headers['x-vercel-cron'] === '1') ? 'sweeper' : 'unknown';
    // Use parsedBody if available (may not be set if error occurred before body parsing)
    const failedJobId = parsedBody?.jobId;
    console.error(`[API] [WORKER] [MODE=${mode}] [JOB ${failedJobId || 'unknown'}] Error in scan worker:`, e);
    
    // Update job status to 'failed' if we have a jobId
    if (failedJobId) {
      try {
        // Standardize to SUPABASE_URL (not EXPO_PUBLIC_SUPABASE_URL) for server-side code
        const supabaseUrl = process.env.SUPABASE_URL;
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
    
    finalStatus = 500;
    console.log(`[API] [WORKER] RESPONSE: status=${finalStatus} (Error: ${e?.message || String(e)})`);
    return res.status(finalStatus).json({ error: 'worker_failed', detail: e?.message || String(e) });
  }
}

