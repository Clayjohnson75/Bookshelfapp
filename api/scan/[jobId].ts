import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hydrateBooksWithCovers } from '../../lib/coverResolution';

/**
 * GET /api/scan/[jobId]
 * Poll endpoint to check scan job status.
 * Completed books are hydrated with coverUrl from cover_resolutions (batch lookup by work_key).
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
 const { jobId: rawJobId } = req.query;
 if (!rawJobId || typeof rawJobId !== 'string') {
 return res.status(400).json({ error: 'jobId required' });
 }

 // scan_jobs.id is uuid type strip the "job_" prefix if present before querying.
 const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const stripped = rawJobId.startsWith('job_') ? rawJobId.slice(4) : rawJobId;
 const jobId = UUID_RE.test(stripped) ? stripped : rawJobId;

 console.log('[PENDING] requested jobId:', rawJobId, 'dbJobId:', jobId);

 // CRITICAL: Read from durable storage (Supabase), not in-memory state.
 // Pending = scan_jobs.books for this exact jobId only. Do NOT use "latest scan job" or .order().limit(1).
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

 if (!supabaseUrl || !supabaseServiceKey) {
 console.error(`[API] [JOB ${rawJobId}] Database not configured for job status check`);
 return res.status(500).json({ error: 'Database not configured' });
 }

 const { createClient } = await import('@supabase/supabase-js');
 const supabase = createClient(supabaseUrl, supabaseServiceKey, {
 auth: {
 autoRefreshToken: false,
 persistSession: false
 }
 });

 const { data: row, error } = await supabase
 .from('scan_jobs')
 .select('id, status, books, error, stage, progress, stage_detail, updated_at')
 .eq('id', jobId)
 .is('deleted_at', null)
 .single();

 console.log('[PENDING] fetched row id:', row?.id, 'status:', row?.status, 'books:', row?.books?.length);

 if (error || !row) {
 console.log(`[API] [JOB ${jobId}] Job not found in database:`, error?.message || 'No data');
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

 // Return books when status === 'completed' (primary + any merged enrichment, same column).
 const booksArray = Array.isArray(row.books) ? row.books : [];
 if (row.status === 'completed') {
 const hydratedBooks = await hydrateBooksWithCovers(supabase, booksArray);
 console.log('[PENDING] after API transforms:', hydratedBooks.length);
 const coverReady = hydratedBooks.filter((b: any) => b?.coverUrl).length;
 const response = {
 jobId: jobId,
 id: row.id,
 status: 'completed',
 books: hydratedBooks,
 covers: { total: hydratedBooks.length, ready: coverReady },
 stage: row.stage || 'completed',
 progress: row.progress !== null && row.progress !== undefined ? row.progress : 100,
 stage_detail: row.stage_detail || null
 };
 if (hydratedBooks.length === 0) {
 console.warn(`[API] [JOB ${jobId}] WARNING: Status is 'completed' but books.length is 0!`);
 }
 return res.status(200).json(response);
 }

 const response = {
 jobId: row.id,
 status: row.status,
 books: [],
 stage: row.stage || null,
 progress: row.progress !== null && row.progress !== undefined ? row.progress : null,
 stage_detail: row.stage_detail || null,
 error: errorObj
 };
 return res.status(200).json(response);

 } catch (e: any) {
 console.error('[API] Error checking scan job status:', e);
 return res.status(500).json({ error: 'status_check_failed', detail: e?.message || String(e) });
 }
}

