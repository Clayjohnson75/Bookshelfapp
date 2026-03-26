import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import { IncomingMessage } from 'http';
import { Receiver } from '@upstash/qstash';
import { updateProgress as writeScanProgress } from '../lib/scanProgressServer';

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
 .is('deleted_at', null)
 .maybeSingle();
 
 if (error || !data) {
 console.warn(`[WORKER] [JOB ${jobId}] Error checking cancel status:`, error?.message || 'No data');
 return false; // If we can't check, continue processing
 }
 
 if (data.cancel_requested === true || data.status === 'canceled') {
 console.log(`[WORKER] [JOB ${jobId}] Job canceled (cancel_requested=${data.cancel_requested}, cancel_requested_at=${data.cancel_requested_at || 'N/A'}), stopping processing`);
 
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
 .is('deleted_at', null)
 .maybeSingle();
 
 // If job is already processing/completed, only update if progress increases
 if (current && (current.status === 'processing' || current.status === 'completed')) {
 const currentProgress = current.progress || 0;
 if (cappedProgress < currentProgress) {
 console.log(`[WORKER] [JOB ${jobId}] Skipping progress update: ${cappedProgress} < ${currentProgress} (not decreasing)`);
 return;
 }
 }
 
 await writeScanProgress(supabase, jobId, cappedProgress, stage, stageDetail);
 console.log(`[WORKER] [JOB ${jobId}] Progress: ${cappedProgress}%, Stage: ${stage}${stageDetail ? ` (${stageDetail})` : ''}`);
}

// Alias for backward compatibility
const setProgress = updateProgress;

/** Update scan_jobs and log [SCAN_JOB_UPDATE] (rows affected, patch keys) for debugging. */
async function updateScanJobAndLog(
 supabase: any,
 jobId: string,
 patch: Record<string, any>,
 extraEq?: Record<string, any>
): Promise<{ data: any; error: any }> {
 let q = supabase.from('scan_jobs').update(patch).eq('id', jobId);
 if (extraEq) {
 for (const [k, v] of Object.entries(extraEq)) q = q.eq(k, v);
 }
 const { data, error } = await q.select('id');
 const count = data?.length ?? 0;
 if (patch.progress != null || patch.stage != null) {
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: patch.progress ?? null, stage: patch.stage ?? null, count, error: error?.message });
 }
 console.log('[SCAN_JOB_UPDATE]', {
 jobId,
 patchKeys: Object.keys(patch),
 count,
 error: error?.message,
 });
 return { data, error };
}

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
 
 console.log(`[API] [WORKER] [JOB ${jobId}] Image optimized: ${originalSize} bytes ${optimizedSize} bytes (${sizeReduction}% reduction)`);
 
 // Convert to base64 data URL
 const base64 = optimizedBuffer.toString('base64');
 return `data:image/webp;base64,${base64}`;
 
 } catch (error: any) {
 // If sharp fails, fall back to original image
 console.error(`[API] [WORKER] [JOB ${jobId}] Image optimization failed:`, error?.message || error);
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
 console.error(`[API] [WORKER] Failed to read raw body: ${rawBodyError?.message || rawBodyError}`);
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
 console.error(`[API] [WORKER] Signature invalid: signature=${signature?.substring(0, 50)}..., hasCurrentKey=${!!currentSigningKey}, hasNextKey=${!!nextSigningKey}, rawBodyLength=${rawBody.length}`);
 console.log(`[API] [WORKER] RESPONSE: status=401 (Signature invalid)`);
 return res.status(401).json({ error: 'Invalid signature' });
 }
 
 console.log(`[API] [WORKER] Signature verified using @upstash/qstash Receiver`);
 } catch (sigError: any) {
 console.error(`[API] [WORKER] Signature verification error: ${sigError?.message || sigError}`);
 console.log(`[API] [WORKER] RESPONSE: status=401 (Signature verification failed)`);
 return res.status(401).json({ error: 'Signature verification failed' });
 }
 } else {
 // No signing keys configured - log warning but allow (for development/testing)
 console.warn(`[API] [WORKER] QStash signature present but no signing keys configured (QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY) - allowing request`);
 }
 }

 let finalStatus = 500;
 try {
 // Detect invocation source: QStash webhook vs sweeper/cron
 const isCronRequest = req.headers['user-agent']?.includes('vercel-cron') || req.headers['x-vercel-cron'] === '1';
 const mode = hasQStashHeaders ? 'qstash' : isCronRequest ? 'sweeper' : 'unknown';
 
 // QStash sends jobId (raw UUID from /api/scan) in body (image is in storage).
 // As a safety net, also accept legacy "job_<uuid>" format and strip the prefix.
 const { jobId: rawJobIdFromPayload, scanId: requestScanId, userId, batchId } = parsedBody || {};
 const messageId = req.headers["upstash-message-id"] || req.headers["x-qstash-message-id"] || null;

 if (!rawJobIdFromPayload) {
 console.error(`[API] [WORKER] [MODE=${mode}] Missing jobId in request body`);
 finalStatus = 400;
 console.log(`[API] [WORKER] RESPONSE: status=${finalStatus} (Missing jobId)`);
 return res.status(finalStatus).json({ error: 'jobId required' });
 }

 // Normalize to raw UUID strip "job_" prefix if present (legacy payloads).
 // All DB operations (.eq("id", jobId)) require the plain UUID; scan_jobs.id is uuid type.
 const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const jobIdStripped = rawJobIdFromPayload.startsWith('job_') ? rawJobIdFromPayload.slice(4) : rawJobIdFromPayload;
 const jobId = UUID_RE.test(jobIdStripped) ? jobIdStripped : rawJobIdFromPayload;
 const displayJobId = rawJobIdFromPayload; // keep original for logs

 // Log batch info if provided
 const batchLogPrefix = batchId ? `[BATCH ${batchId}]` : '';
 console.log(`[API] [WORKER] ${batchLogPrefix} [MODE=${mode}] [JOB ${displayJobId}] Received job request: dbJobId=${jobId}, scanId=${requestScanId || 'none'}, userId=${userId || 'none'}, messageId=${messageId || 'N/A'}, wasStripped=${jobId !== rawJobIdFromPayload}`);

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
 // Worker uses service role for scan_jobs and for processScanJob (books insert). Bypasses RLS.
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
 console.error(`[WORKER] CRITICAL: ${errorMsg}`);
 throw new Error(errorMsg);
 }
 
 // If data is returned, profile was created or already existed
 if (data) {
 console.log(`[WORKER] Profile row exists: ${userId}`);
 return true;
 }
 
 // If no data and no error, profile already existed (upsert returned nothing but no error)
 console.log(`[WORKER] Profile row already exists: ${userId}`);
 return true;
 } catch (err: any) {
 // Re-throw - this is a hard fail, don't catch it here
 const errorMsg = err?.message || String(err);
 console.error(`[WORKER] CRITICAL: Exception ensuring profile row for ${userId}: ${errorMsg}`);
 throw err; // Re-throw to be caught by caller
 }
 };
 
 // Ensure profile row exists before processing (maintains FK integrity)
 // HARD FAIL: If this fails, job will be marked as failed and we return 500
 try {
 await ensureProfileRow(supabase, userId);
 } catch (profileError: any) {
 console.error(`[WORKER] [JOB ${jobId}] Failed to ensure profile row, marking job as failed`);
 // Mark job as failed immediately
 await updateScanJobAndLog(supabase, jobId, {
 status: "failed",
 error: JSON.stringify({
 code: "profile_creation_failed",
 message: profileError?.message || String(profileError),
 }),
 updated_at: new Date().toISOString(),
 });
 // Return 500 so QStash doesn't retry (this is a permanent failure)
 return res.status(500).json({ error: "profile_creation_failed", detail: profileError?.message || String(profileError) });
 }
 
 // IDEMPOTENCY: Atomically claim the job by updating status from 'pending' to 'processing'
 // 
 // HOW IDEMPOTENCY WORKS:
 // 1. We query for jobs with status IN ('pending', 'processing') to handle edge cases
 // 2. We only update if status is 'pending' (using .eq('status', 'pending'))
 // 3. If update returns 0 rows, the job was already claimed (status was 'processing' or doesn't exist)
 // 4. If update returns 1 row, we successfully claimed it (status was 'pending' 'processing')
 // 5. This ensures only ONE worker can claim a job, even if multiple requests arrive simultaneously
 //
 // Why check IN ('pending','processing')? 
 // - If job is 'pending': We can claim it update succeeds
 // - If job is 'processing': Another worker already claimed it update fails (0 rows)
 // - If job is 'completed'/'failed': Not in our filter update fails (0 rows)
 // - This prevents race conditions where two workers try to claim the same job
 // 1) Atomic claim: pending -> processing
 const claimStart = Date.now();
 let claimRes = await supabase
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
 await updateScanJobAndLog(supabase, jobId, {
 status: "failed",
 error: JSON.stringify({ code: "claim_failed", message: claimRes.error.message }),
 updated_at: new Date().toISOString(),
 });

 return res.status(500).json({ error: "claim_failed" });
 }

 if (!claimRes.data) {
 // Nothing updated. Could be: already processing, already completed, or still pending (race/RLS).
 const { data: current, error: readErr } = await supabase
 .from("scan_jobs")
 .select("id,status,updated_at")
 .eq("id", jobId)
 .is("deleted_at", null)
 .maybeSingle();

 console.log("[WORKER] claim missed; current row", {
 jobId,
 current,
 readErr: readErr?.message || null,
 });

 // If it's completed or already processing, idempotent return is fine:
 if (current?.status && (current.status === "processing" || current.status === "completed")) {
 return res.status(200).json({ ok: true, reason: `already_${current.status}` });
 }

 // If status is 'failed', try to reclaim — the failure may have been from a race condition
 // (e.g. metadata-only QStash publish timed out and marked the job failed before we arrived).
 if (current?.status === "failed") {
 console.log("[WORKER] job is failed, attempting reclaim", { jobId });
 const reclaim = await supabase
   .from("scan_jobs")
   .update({ status: "processing", error: null, updated_at: new Date().toISOString() })
   .eq("id", jobId)
   .eq("status", "failed")
   .select("id,status,updated_at")
   .maybeSingle();
 if (reclaim.data) {
   console.log("[WORKER] reclaimed failed job — proceeding to process", { jobId, status: reclaim.data.status });
   claimRes = { data: reclaim.data, error: null, count: 1, status: 200, statusText: 'OK' } as any;
   // Break out of the !claimRes.data block — we now have a valid claim
 } else {
   console.warn("[WORKER] failed to reclaim", { jobId, error: reclaim.error?.message });
   return res.status(200).json({ ok: true, reason: "already_failed_cannot_reclaim" });
 }
 }

 // If reclaim succeeded above, skip the retry loop and proceed to processing
 if (claimRes.data) {
   // reclaimed — fall through to processing below
 } else if (current?.status === "pending") {
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
 // claimed on retry continue pipeline
 break;
 }
 }

 // After retries, if still not claimed: mark failed (otherwise your app polls forever)
 const { data: after } = await supabase.from("scan_jobs").select("status").eq("id", jobId).is("deleted_at", null).maybeSingle();
 if (after?.status === "pending") {
 await updateScanJobAndLog(supabase, jobId, {
 status: "failed",
 error: JSON.stringify({ code: "claim_failed_zero_rows", message: "Claim update returned 0 rows" }),
 updated_at: new Date().toISOString(),
 });

 return res.status(500).json({ error: "claim_failed_zero_rows" });
 }

 return res.status(200).json({ ok: true, reason: `claim_missed_status=${after?.status}` });
 } // end else if (pending retry loop)
 } // end if (!claimRes.data)

 // If we got here, we successfully claimed (status is now processing).
 console.log("[WORKER] claimed job", { jobId, status: claimRes.data.status });
 
 // Check if job was canceled before we claimed it (idempotent cancel check)
 if (await checkCanceled(supabase, jobId)) {
 console.log(`[WORKER] [JOB ${jobId}] Job was canceled, returning 200 (idempotent)`);
 return res.status(200).json({ ok: true, reason: 'canceled' });
 }
 
 // Checkpoint: 2% starting
 await updateProgress(supabase, jobId, 2, 'starting');
 
 // Get the full job data for processing
 const { data: updateData, error: fetchError } = await supabase
 .from('scan_jobs')
 .select('id, status, image_path, user_id, image_hash, scan_id, photo_id')
 .eq('id', jobId)
 .is('deleted_at', null)
 .single();
 
 if (!updateData || fetchError) {
 console.error("[WORKER] Failed to fetch job data after claim", { jobId, error: fetchError?.message || null });
 const patch = {
 status: "failed",
 error: JSON.stringify({ code: "claim_fetch_failed", message: fetchError?.message || "Job data not found" }),
 updated_at: new Date().toISOString(),
 };
 const { data: upData, error: upErr } = await supabase.from("scan_jobs").update(patch).eq("id", jobId).select("id");
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(patch), count: upData?.length ?? 0, error: upErr?.message });
 return res.status(500).json({ error: "claim_fetch_failed" });
 }
 
 // Check canceled again after fetching job data
 if (await checkCanceled(supabase, jobId)) {
 console.log(`[WORKER] [JOB ${jobId}] Job was canceled after fetch, returning 200 (idempotent)`);
 return res.status(200).json({ ok: true, reason: 'canceled' });
 }
 
 // Process the entire scan pipeline synchronously before responding.
 // Inner finally ensures we never leave status as 'processing' (e.g. if catch's update failed due to RLS).
 try {
 const { image_path, user_id, image_hash, scan_id, photo_id: jobPhotoId } = updateData;
 // Use scanId from request, then from database, then derive from the raw UUID.
 const scanId = requestScanId || scan_id || `scan_${jobId}`;
 const storagePath = image_path;

 console.log(`[SCAN_PROCESSOR] job_start`, { jobId, photoId: jobPhotoId ?? null, storagePath: storagePath ?? null, scanId, userId: user_id ?? null });
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
 await updateProgress(supabase, jobId, 10, 'downloading');
 
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

 let imageDimensions: { width?: number; height?: number } = {};
 try {
   const sharp = (await import('sharp')).default;
   const meta = await sharp(buffer).metadata();
   imageDimensions = { width: meta.width, height: meta.height };
 } catch (_) { /* non-fatal */ }
 console.log(`[SCAN_PROCESSOR] after_image_fetch`, { jobId, bytes: buffer.length, dimensions: imageDimensions, format: originalMimeType });
 console.log(`[WORKER] STAGE: download image complete`, { jobId, bytes: buffer.length, format: originalMimeType });
 if (await checkCanceled(supabase, jobId)) {
 console.log(`[WORKER] [JOB ${jobId}] Canceled after download, returning`);
 return res.status(200).json({ ok: true, reason: 'canceled' });
 }
 await updateProgress(supabase, jobId, 15, 'downloaded');
 // Checkpoint: 20% optimizing (after download, before/after optimize)
 await updateProgress(supabase, jobId, 20, 'optimizing');
 
 const imageDataURL = await optimizeImageForAI(buffer, originalMimeType, jobId);
 console.log(`[WORKER] STAGE: optimize image complete`, { jobId });
 if (await checkCanceled(supabase, jobId)) {
 console.log(`[WORKER] [JOB ${jobId}] Canceled after optimize, returning`);
 return res.status(200).json({ ok: true, reason: 'canceled' });
 }
 
 // STAGE: gemini/openai processing
 console.log(`[WORKER] STAGE: gemini start`, { jobId, scanId });
 if (await checkCanceled(supabase, jobId)) {
 console.log(`[WORKER] [JOB ${jobId}] Canceled before scanning, returning`);
 return res.status(200).json({ ok: true, reason: 'canceled' });
 }
 // Checkpoint: 40% scanning
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
 .is('deleted_at', null)
 .single();
 
if (finalJob?.status === 'completed') {
if (jobPhotoId) {
const now = new Date().toISOString();
// Only use DB-allowed status; never invent a status (e.g. never 'uploaded').
const { error: photoUpErr } = await supabase
.from('photos')
.update({ status: 'complete', updated_at: now })
.eq('id', jobPhotoId)
.eq('user_id', user_id);
if (photoUpErr) console.warn('[WORKER] photos.status=complete update failed', { photoId: jobPhotoId, error: photoUpErr.message });
}
 console.log(`[WORKER] completed`, { jobId, books: finalJob.books?.length || 0 });
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
 console.error(`[WORKER] failed`, { jobId, err: e?.message || e });
 const patch = {
 status: "failed",
 stage: "failed",
 progress: 95, // NOT NULL
 error: JSON.stringify({ code: "worker_failed", message: e?.message || String(e) }),
 updated_at: new Date().toISOString(),
 };
 const { data: upData, error: upErr } = await supabase.from("scan_jobs").update(patch).eq("id", jobId).select("id");
 const count = upData?.length ?? 0;
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: 95, stage: 'failed', count, error: upErr?.message });
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(patch), count, error: upErr?.message });
 // IMPORTANT: return non-2xx so QStash retries
 return res.status(500).json({ ok: false, error: "worker_failed" });
 } finally {
 // Never leave job in processing: if our catch's update failed (e.g. RLS), force failed here.
 const { data: row } = await supabase.from("scan_jobs").select("status").eq("id", jobId).is("deleted_at", null).maybeSingle();
 if (row?.status === "processing") {
 const failPatch = {
   status: "failed",
   stage: "failed",
   progress: 95,
   error: JSON.stringify({ code: "worker_exit_still_processing", message: "Worker exited while job was still processing" }),
   updated_at: new Date().toISOString(),
 };
 await updateScanJobAndLog(supabase, jobId, failPatch);
 console.log(`[WORKER] [JOB ${jobId}] Forced failed (was still processing)`);
 }
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
 
 const patch = {
 status: 'failed',
 stage: 'failed',
 progress: 95, // NOT NULL
 error: JSON.stringify({ code: 'worker_error', message: e?.message || String(e), stack: e?.stack }),
 updated_at: new Date().toISOString(),
 };
 const { data: upData, error: upErr } = await supabase
 .from('scan_jobs')
 .update(patch)
 .eq('id', failedJobId)
 .select('id');
 console.log('[SCAN_JOB_UPDATE]', { jobId: failedJobId, patchKeys: Object.keys(patch), count: upData?.length ?? 0, error: upErr?.message });
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

