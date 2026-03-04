import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/scan-status?jobId=xxx
 * Poll endpoint to check scan job status.
 * Single source of truth: progress and stage come from scan_jobs (server), not from pending book count.
 * Client must drive progress UI from this endpoint; pendingCount is only for "results available", not "job in progress".
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
 const { jobId: rawJobId } = req.query;
 if (!rawJobId || typeof rawJobId !== 'string') {
 return res.status(400).json({ error: 'jobId required' });
 }
 // scan_jobs.id is uuid type strip the "job_" prefix if present before querying.
 const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const stripped = rawJobId.startsWith('job_') ? rawJobId.slice(4) : rawJobId;
 const jobId = UUID_RE.test(stripped) ? stripped : rawJobId;

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

 if (!supabaseUrl || !supabaseServiceKey) {
 return res.status(500).json({ error: 'Database not configured' });
 }

 // Use SERVICE ROLE so we always see worker progress writes (no RLS/caching/permission mismatch).
 const { createClient } = await import('@supabase/supabase-js');
 const supabase = createClient(supabaseUrl, supabaseServiceKey, {
 auth: {
 autoRefreshToken: false,
 persistSession: false
 }
 });

 // CRITICAL: Select only the fields we need - use books column (not results)
 // Include progress, stage, and cancel fields for cancel + progress tracking
 const { data: row, error } = await supabase
 .from('scan_jobs')
 .select('id, status, books, error, progress, stage, stage_detail, cancel_requested, canceled_at, updated_at, created_at') // Select books column (not results) + progress/stage/cancel fields
 .eq('id', jobId)
 .is('deleted_at', null)
 .single();

 console.log('[SCAN_STATUS_ROW]', { jobId, status: row?.status, stage: row?.stage, progress: row?.progress ?? 'null', updated_at: row?.updated_at });

 if (error || !row) {
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
 if (row.error) {
 try {
 errorObj = typeof row.error === 'string' ? JSON.parse(row.error) : row.error;
 } catch {
 errorObj = { code: 'unknown_error', message: String(row.error) };
 }
 }
 
 const books = row.books || [];
 const coverReady = books.filter((b: any) => b?.coverUrl).length;
 let progress = row.progress !== null && row.progress !== undefined ? row.progress : 0;
 let stage = row.stage || null;
 // Monotonic progress: if processing but still 0 for a long time, force at least 2% so UI doesn't look frozen.
 const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
 const staleZeroMs = 10_000;
 if (row.status === 'processing' && (progress == null || progress === 0) && createdAt && (Date.now() - createdAt > staleZeroMs)) {
 progress = 2;
 stage = 'starting';
 }
 const response = {
 jobId: row.id,
 status: row.status, // 'pending' | 'processing' | 'completed' | 'failed' | 'canceled'
 books, // From books column; coverUrl persisted on book row by worker
 covers: { total: books.length, ready: coverReady }, // UI can poll until ready === total
 error: errorObj,
 progress, // 0-100
 stage,
 stage_detail: row.stage_detail || null, // Optional detail like "batch 1/2"
 cancel_requested: row.cancel_requested || false,
 canceled_at: row.canceled_at || null,
 updated_at: row.updated_at,
 created_at: row.created_at
 };
 
 // Log what we're returning so client progress bar can be debugged (progress/stage from Vercel worker).
 console.log(`[API] [SCAN-STATUS] [JOB ${jobId}] progress=${response.progress} stage=${response.stage} status=${response.status} books.length=${books.length}`);
 if (response.status === 'completed' && books.length === 0) {
 console.warn(`[API] [SCAN-STATUS] [JOB ${jobId}] WARNING: Status is 'completed' but books.length is 0!`);
 }
 
 return res.status(200).json(response);

 } catch (e: any) {
 console.error('[API] Error checking scan job status:', e);
 return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
 }
}

