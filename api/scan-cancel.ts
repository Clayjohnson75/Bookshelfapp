import type { VercelRequest, VercelResponse } from '@vercel/node';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip the "job_" prefix and return the raw UUID. Returns null if not a valid UUID. */
function toRawJobUuid(id: string): string | null {
 const raw = id.startsWith('job_') ? id.slice(4) : id;
 return UUID_REGEX.test(raw) ? raw : null;
}

/** Terminal statuses cancel is a no-op and should return 200 idempotently. */
const TERMINAL_STATUSES = new Set(['canceled', 'completed', 'failed', 'closed']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 res.setHeader('Content-Type', 'application/json');

 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

 try {
 const { jobId } = req.body || {};

 if (!jobId || typeof jobId !== 'string') {
 return res.status(400).json({
 ok: false,
 error: { code: 'missing_job_id', message: 'jobId is required' },
 });
 }

 // Accept "job_<uuid>" or raw UUID scan_jobs.id is uuid type.
 const dbJobId = toRawJobUuid(jobId);
 if (!dbJobId) {
 return res.status(400).json({
 ok: false,
 error: { code: 'invalid_job_id', message: `jobId must be a UUID (with or without "job_" prefix). Got: ${jobId}` },
 });
 }

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !supabaseServiceKey) {
 return res.status(500).json({
 ok: false,
 error: { code: 'database_not_configured', message: 'Database not configured' },
 });
 }

 const { createClient } = await import('@supabase/supabase-js');
 const supabase = createClient(supabaseUrl, supabaseServiceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });

 // Auth: Bearer token required. Derive userId from token — never from body.
 const authHeader = req.headers.authorization;
 const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
 ? authHeader.slice(7).trim()
 : null;
 if (!token) {
 return res.status(401).json({
 ok: false,
 error: { code: 'unauthorized', message: 'Authorization: Bearer <token> required' },
 });
 }
 const { data: userData, error: authErr } = await supabase.auth.getUser(token);
 if (authErr || !userData?.user?.id) {
 return res.status(401).json({
 ok: false,
 error: { code: 'invalid_token', message: authErr?.message ?? 'Invalid or expired token' },
 });
 }
 const authedUserId = userData.user.id;

 console.log(`[API] [CANCEL] jobId=${jobId} dbJobId=${dbJobId} authedUserId=${authedUserId}`);

 // Fetch the job do NOT filter by deleted_at so soft-deleted/terminal rows still return idempotent OK.
 const { data: existingJob, error: fetchError } = await supabase
 .from('scan_jobs')
 .select('id, user_id, status, progress')
 .eq('id', dbJobId)
 .maybeSingle();

 if (fetchError) {
 console.error(`[API] [CANCEL] [JOB ${jobId}] DB error fetching job:`, fetchError.message);
 return res.status(500).json({
 ok: false,
 error: { code: 'db_error', message: fetchError.message },
 });
 }

 // Job not found at all idempotent OK (may have been hard-deleted or never existed).
 if (!existingJob) {
 console.log(`[API] [CANCEL] [JOB ${jobId}] Job not found returning idempotent OK`);
 return res.status(200).json({ ok: true, alreadyTerminal: true, reason: 'not_found' });
 }

 // Ownership check: token is now required so authedUserId is always set.
 if (existingJob.user_id && existingJob.user_id !== authedUserId) {
 console.error(`[API] [CANCEL] [JOB ${jobId}] Unauthorized: token uid=${authedUserId} job uid=${existingJob.user_id}`);
 return res.status(403).json({
 ok: false,
 error: { code: 'unauthorized', message: 'You do not have permission to cancel this job' },
 });
 }

 // Already in a terminal state idempotent OK for all of them.
 if (TERMINAL_STATUSES.has(existingJob.status)) {
 console.log(`[API] [CANCEL] [JOB ${jobId}] Already terminal (status=${existingJob.status}) idempotent OK`);
 return res.status(200).json({ ok: true, alreadyTerminal: true, status: existingJob.status });
 }

 // Mark as canceled.
 const currentProgress = existingJob.progress || 0;
 const now = new Date().toISOString();
 const { error: updateError } = await supabase
 .from('scan_jobs')
 .update({
 cancel_requested: true,
 cancel_requested_at: now,
 canceled_at: now,
 status: 'canceled',
 stage: 'canceled',
 progress: Math.min(currentProgress, 99),
 updated_at: now,
 })
 .eq('id', dbJobId)
 .eq('user_id', authedUserId);

 if (updateError) {
 console.error(`[API] [CANCEL] [JOB ${jobId}] Failed to update job:`, updateError.message, updateError.details, updateError.hint);
 return res.status(500).json({
 ok: false,
 error: {
 code: 'cancel_failed',
 message: 'Failed to cancel job',
 supabase: { message: updateError.message, code: updateError.code, details: updateError.details, hint: updateError.hint },
 },
 });
 }

 console.log(`[API] [CANCEL] [JOB ${jobId}] Canceled (dbJobId=${dbJobId})`);
 return res.status(200).json({ ok: true });

 } catch (error: any) {
 console.error('[API] [CANCEL] Unhandled error:', error?.message || error);
 return res.status(500).json({
 ok: false,
 error: { code: 'internal_error', message: error?.message || 'Internal server error' },
 });
 }
}
