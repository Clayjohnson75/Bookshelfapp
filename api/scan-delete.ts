import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/scan-delete
 * When user deletes a scan soft-delete: update deleted_at = now(), deleted_by = userId.
 * Body: { jobId: string, userId: string }
 * Verifies user owns the job then: .update({ deleted_at, deleted_by }).eq("id", jobId).eq("user_id", userId)
 * Every query that lists or fetches scan_jobs MUST filter: deleted_at is null.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 res.setHeader('Content-Type', 'application/json');

 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 if (req.method !== 'POST') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 // Auth: Bearer token required. userId is derived from token — never from body.
 const authHeader = req.headers.authorization;
 const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
 if (!token) {
 return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Authorization: Bearer <token> required' } });
 }

 try {
 const { jobId } = req.body || {};

 if (!jobId || typeof jobId !== 'string') {
 return res.status(400).json({
 ok: false,
 error: { code: 'missing_job_id', message: 'jobId is required' },
 });
 }

 const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
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

 // Verify token and derive userId — never trust userId from body.
 const { data: userData, error: authErr } = await supabase.auth.getUser(token);
 if (authErr || !userData?.user?.id) {
 return res.status(401).json({ ok: false, error: { code: 'invalid_token', message: authErr?.message ?? 'Invalid or expired token' } });
 }
 const userId = userData.user.id;

 // Verify job exists and caller owns it (include soft-deleted so delete is idempotent)
 const { data: existing, error: fetchError } = await supabase
 .from('scan_jobs')
 .select('id, user_id')
 .eq('id', jobId)
 .maybeSingle();

 if (fetchError || !existing) {
 return res.status(404).json({
 ok: false,
 error: { code: 'job_not_found', message: 'Job not found' },
 });
 }
 if (existing.user_id !== userId) {
 return res.status(403).json({
 ok: false,
 error: { code: 'unauthorized', message: 'You do not have permission to delete this job' },
 });
 }

  const now = new Date().toISOString();
  console.log('[SOFT_DELETE_AUDIT]', JSON.stringify({
    caller: 'api/scan-delete',
    table: 'scan_jobs',
    filter: { user_id: userId, job_id: jobId },
    setValue: { deleted_at: now },
    note: 'USER-INITIATED: user deleted a completed scan job',
  }));
  const { error: updateError } = await supabase
    .from('scan_jobs')
    .update({
      deleted_at: now,
      deleted_by: userId,
      updated_at: now,
    })
    .eq('id', jobId)
    .eq('user_id', userId);

 if (updateError) {
 console.error(`[API] [SCAN-DELETE] [JOB ${jobId}] Soft-delete failed:`, updateError.message);
 return res.status(500).json({
 ok: false,
 error: { code: 'delete_failed', message: updateError.message },
 });
 }

 return res.status(200).json({ ok: true });
 } catch (e: any) {
 console.error('[API] [SCAN-DELETE] Error:', e?.message || e);
 return res.status(500).json({
 ok: false,
 error: { code: 'server_error', message: e?.message || 'Internal server error' },
 });
 }
}
