import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateOpId, scanLogPrefix } from '../lib/scanCorrelation';

/**
 * Flow A: deletePendingScan(scanJobId | batchId [, pendingBookIds])
 * Purpose: cancel/remove a pending scan and its temporary artifacts.
 * Must NEVER delete approved books.
 *
 * When pendingBookIds is provided (recommended): soft-delete books by id IN (pendingBookIds)
 * AND status='pending' AND user_id only. No filter by source_scan_job_id.
 * When not provided: soft-delete by source_scan_job_id IN (rawUuids), status='pending', user_id.
 *
 * Steps:
 * 1. Delete/mark canceled the scan_jobs row(s) for the job/batch.
 * 2. Delete any scan_job_imports rows tied to those scan jobs.
 * 3.5. Clear pending books: if pendingBookIds.length > 0 use id IN (ids) + status='pending' + user_id;
 * else use source_scan_job_id IN rawUuids + status='pending' + user_id. [DELETE_PREVIEW] + guard.
 * 4. Before deleting a photo row/storage: if any approved books reference it, do not delete; else delete.
 *
 * POST body: { jobId?: string, batchId?: string, userId: string, pendingBookIds?: string[] }
 * At least one of jobId or batchId required.
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
 const { jobId, batchId, pendingBookIds: rawPendingBookIds } = req.body || {};
 const pendingBookIds = Array.isArray(rawPendingBookIds)
 ? (rawPendingBookIds as string[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
 : [];

 if ((!jobId || typeof jobId !== 'string') && (!batchId || typeof batchId !== 'string')) {
 return res.status(400).json({
 ok: false,
 error: { code: 'missing_identifier', message: 'jobId or batchId is required' },
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

 const opId = generateOpId();
 const { canonicalJobId } = await import('../lib/scanId');
 const canonicalId = typeof jobId === 'string' ? (canonicalJobId(jobId) ?? jobId) : undefined;
 console.log(scanLogPrefix('CLEANUP_PENDING', { opId, userId, batchId: batchId ?? undefined, scanJobId: canonicalId ?? jobId ?? undefined }));

 // 1) Resolve scan_jobs to affect (by jobId or batchId)
 type JobRow = { id: string; user_id: string; job_uuid?: string; photo_id?: string; image_hash?: string };
 let jobRows: JobRow[];

 if (canonicalId) {
 const { data: single, error: fetchJobsError } = await supabase
 .from('scan_jobs')
 .select('id, user_id, job_uuid, photo_id, image_hash')
 .eq('user_id', userId)
 .eq('id', canonicalId)
 .maybeSingle();
 if (fetchJobsError) {
 return res.status(500).json({
 ok: false,
 error: { code: 'fetch_failed', message: fetchJobsError.message },
 });
 }
 jobRows = single ? [single] : [];
 } else {
 const { data: batch, error: fetchBatchError } = await supabase
 .from('scan_jobs')
 .select('id, user_id, job_uuid, photo_id, image_hash')
 .eq('user_id', userId)
 .eq('batch_id', batchId);
 if (fetchBatchError) {
 return res.status(500).json({
 ok: false,
 error: { code: 'fetch_failed', message: fetchBatchError.message },
 });
 }
 jobRows = (batch ?? []) as JobRow[];
 }

 if (jobRows.length === 0) {
 return res.status(404).json({
 ok: false,
 error: { code: 'job_not_found', message: 'No matching scan job(s) found' },
 });
 }

 const firstJob = jobRows[0];
 const photoIds = [...new Set(jobRows.map((j) => j.photo_id).filter(Boolean))] as string[];
 console.log(scanLogPrefix('CLEANUP_PENDING', {
 opId,
 userId,
 batchId: batchId ?? undefined,
 scanJobId: jobId ?? firstJob?.id,
 photoId: photoIds[0],
 photoFingerprint: firstJob?.image_hash ?? undefined,
 }), 'jobsAffected=', jobRows.length);
 const now = new Date().toISOString();
 const jobIds = jobRows.map((j: { id: string }) => j.id);
 const { toRawScanJobUuid } = await import('../lib/scanId');
 const rawUuids = jobRows
 .map((j: { job_uuid?: string; id: string }) => (j.job_uuid != null ? String(j.job_uuid) : toRawScanJobUuid(j.id)))
 .filter((id): id is string => id != null);

 // 2) Soft-delete scan_jobs (cancel/remove)
 const { error: updateJobsError } = await supabase
 .from('scan_jobs')
 .update({
 deleted_at: now,
 deleted_by: userId,
 updated_at: now,
 status: 'canceled',
 canceled_at: now,
 })
 .eq('user_id', userId)
 .in('id', jobIds);

 if (updateJobsError) {
 console.error(scanLogPrefix('CLEANUP_PENDING', { opId, userId, scanJobId: jobId ?? undefined }), 'scan_jobs update failed:', updateJobsError.message);
 return res.status(500).json({
 ok: false,
 error: { code: 'delete_failed', message: updateJobsError.message },
 });
 }

 // 3) Delete scan_job_imports for these jobs (raw UUIDs)
 if (rawUuids.length > 0) {
 await supabase
 .from('scan_job_imports')
 .delete()
 .eq('user_id', userId)
 .in('scan_job_id', rawUuids);
 }

 // 3.5) Clear pending books: prefer DB ids only (pendingBookIds); fallback to filter by source_scan_job_id.
 const useDbIdsOnly = pendingBookIds.length > 0;

 if (useDbIdsOnly) {
 // Hard guardrail: id IN (pendingBookIds) AND status='pending' AND user_id [AND source_scan_job_id IN (rawUuids) when we have job context]. Never delete approved.
 const exactDbFilters: Record<string, unknown> = {
 table: 'books',
 user_id: userId,
 id_in: pendingBookIds,
 status: 'pending',
 deleted_at: null,
 };
 if (rawUuids.length > 0) {
 exactDbFilters.source_scan_job_id_in = rawUuids;
 }
 console.log('[CLEAR_PENDING]', JSON.stringify({
 action: 'CLEAR_PENDING',
 mode: 'db_ids_only',
 jobId: jobId ?? undefined,
 batchId: batchId ?? undefined,
 photoId: photoIds[0] ?? undefined,
 pendingBookIdsCount: pendingBookIds.length,
 exactDbFilters,
 }));

 let previewQuery = supabase
 .from('books')
 .select('id, status, source_photo_id, source_scan_job_id, title, created_at')
 .eq('user_id', userId)
 .in('id', pendingBookIds)
 .eq('status', 'pending')
 .is('deleted_at', null);
 if (rawUuids.length > 0) {
 previewQuery = previewQuery.in('source_scan_job_id', rawUuids);
 }
 const { data: previewRows, error: previewErr } = await previewQuery;

 if (!previewErr && Array.isArray(previewRows)) {
 const count = previewRows.length;
 const byStatus: Record<string, number> = {};
 previewRows.forEach((r: { status?: string }) => {
 const s = r.status ?? 'null';
 byStatus[s] = (byStatus[s] ?? 0) + 1;
 });
 const sample = previewRows.slice(0, 10).map((r: any) => ({
 id: r.id,
 title: r.title != null ? String(r.title).slice(0, 40) : null,
 status: r.status,
 source_scan_job_id: r.source_scan_job_id ?? null,
 source_photo_id: r.source_photo_id ?? null,
 created_at: r.created_at ?? null,
 }));
 console.log('[DELETE_PREVIEW]', JSON.stringify({
 action: 'clear_pending',
 user_id: userId,
 scan_job_id: rawUuids[0] ?? jobId ?? null,
 source_photo_id: photoIds[0] ?? null,
 exactFilter: exactDbFilters,
 count,
 byStatus,
 sample,
 }));

 const nonPending = previewRows.filter((r: any) => r.status !== 'pending');
 if (nonPending.length > 0) {
 console.error('[DELETE_PREVIEW] Abort: non-pending rows in preview (action=clear_pending)', JSON.stringify({ nonPendingCount: nonPending.length, sample: nonPending.slice(0, 3).map((r: any) => ({ id: r.id, status: r.status })) }));
 return res.status(500).json({
 ok: false,
 error: { code: 'guard_abort', message: 'Clear pending (by id) must only touch pending rows; preview contained non-pending.' },
 });
 }

 // [DELETE_CANDIDATE] log each row; hard block if any approved (must never soft-delete approved here)
 for (const r of previewRows as { id?: string; status?: string; source_photo_id?: string; source_scan_job_id?: string }[]) {
 console.log('[DELETE_CANDIDATE]', { bookId: r.id, status: r.status, source_photo_id: r.source_photo_id ?? null, source_scan_job_id: r.source_scan_job_id ?? null });
 if (r.status === 'approved') {
 console.error('[DELETE_CANDIDATE] BLOCK: approved book in clear_pending path must never delete approved');
 return res.status(500).json({
 ok: false,
 error: { code: 'guard_abort', message: 'Approved books must never be deleted in clear-pending path.' },
 });
 }
 }

  // TEMPORARILY DISABLED: server-side book soft-delete on cancel is disabled while we debug
  // accidental bulk-delete. Cancel now only affects scan_jobs + scan_job_imports rows.
  // Books are removed from local state only (client-side) — they will re-appear on re-scan.
  // Re-enable by removing this block comment and restoring the update query below.
  if (count > 0) {
    console.log('[SOFT_DELETE_AUDIT] SKIPPED (debug mode — book delete disabled)', JSON.stringify({
      caller: 'api/delete-pending-scan.clear_pending_by_id',
      wouldHaveDeleted: count,
      previewSample: previewRows.slice(0, 3).map((r: any) => ({ id: r.id?.slice(0, 8), status: r.status })),
    }));
    // DISABLED BODY — uncomment to re-enable:
    // let updateQuery = supabase.from('books').update({ deleted_at: now, updated_at: now, deleted_by: userId, delete_reason: 'pending_cleared' })
    //   .eq('user_id', userId).in('id', previewRows.map((r: any) => r.id)).eq('status', 'pending').is('deleted_at', null);
    // if (rawUuids.length > 0) updateQuery = updateQuery.in('source_scan_job_id', rawUuids);
    // const { error: booksUpdateErr } = await updateQuery;
    // if (booksUpdateErr) { console.error(...); return res.status(500).json(...); }
  }
} else if (rawUuids.length > 0) {
 // Fallback: filter by source_scan_job_id IN (rawUuids), status='pending', user_id.
 const exactDbFilters = {
 table: 'books',
 user_id: userId,
 source_scan_job_id_in: rawUuids,
 status: 'pending',
 deleted_at: null,
 };
 console.log('[CLEAR_PENDING]', JSON.stringify({
 action: 'CLEAR_PENDING',
 mode: 'by_scan_job_id',
 jobId: jobId ?? undefined,
 batchId: batchId ?? undefined,
 photoId: photoIds[0] ?? undefined,
 exactDbFilters,
 }));

 const clearPendingFilters = { user_id: userId, source_scan_job_id_in: rawUuids, status: 'pending', deleted_at: null };
 const { data: previewRows, error: previewErr } = await supabase
 .from('books')
 .select('id, status, source_photo_id, source_scan_job_id, title, created_at')
 .eq('user_id', userId)
 .in('source_scan_job_id', rawUuids)
 .eq('status', 'pending')
 .is('deleted_at', null)
 .limit(500);

 if (!previewErr && Array.isArray(previewRows)) {
 const count = previewRows.length;
 const byStatus: Record<string, number> = {};
 previewRows.forEach((r: { status?: string }) => {
 const s = r.status ?? 'null';
 byStatus[s] = (byStatus[s] ?? 0) + 1;
 });
 const sample = previewRows.slice(0, 10).map((r: any) => ({
 id: r.id,
 title: r.title != null ? String(r.title).slice(0, 40) : null,
 status: r.status,
 source_scan_job_id: r.source_scan_job_id ?? null,
 source_photo_id: r.source_photo_id ?? null,
 created_at: r.created_at ?? null,
 }));
 console.log('[DELETE_PREVIEW]', JSON.stringify({
 action: 'clear_pending',
 user_id: userId,
 scan_job_id: rawUuids[0] ?? jobId ?? null,
 source_photo_id: photoIds[0] ?? null,
 exactFilter: exactDbFilters,
 count,
 byStatus,
 sample,
 }));

 const approvedInPreview = previewRows.filter((r: any) => r.status === 'approved');
 if (approvedInPreview.length > 0) {
 console.error('[DELETE_PREVIEW] Abort: approved rows in preview (action=clear_pending)', JSON.stringify({ count: approvedInPreview.length, sample: approvedInPreview.slice(0, 3).map((r: any) => ({ id: r.id, status: r.status })) }));
 return res.status(500).json({
 ok: false,
 error: { code: 'guard_abort', message: 'Clear pending must only delete pending rows; preview contained approved.' },
 });
 }

 console.log('[CLEAR_PENDING_PREVIEW]', JSON.stringify({ filters: clearPendingFilters, count, byStatus, sample }));

 const nonPending = previewRows.filter((r: any) => r.status !== 'pending');
 if (nonPending.length > 0) {
 console.error('[CLEAR_PENDING_ABORT_NON_PENDING]', JSON.stringify({
 reason: 'preview contained non-pending rows',
 nonPendingCount: nonPending.length,
 sample: nonPending.slice(0, 5).map((r: any) => ({ id: r.id, status: r.status })),
 }));
 return res.status(500).json({
 ok: false,
 error: { code: 'guard_abort', message: 'Clear pending must only delete pending rows; preview contained non-pending.' },
 });
 }

 // [DELETE_CANDIDATE] log each row; hard block if any approved
 for (const r of previewRows as { id?: string; status?: string; source_photo_id?: string; source_scan_job_id?: string }[]) {
 console.log('[DELETE_CANDIDATE]', { bookId: r.id, status: r.status, source_photo_id: r.source_photo_id ?? null, source_scan_job_id: r.source_scan_job_id ?? null });
 if (r.status === 'approved') {
 console.error('[DELETE_CANDIDATE] BLOCK: approved book in clear_pending (by job) path must never delete approved');
 return res.status(500).json({
 ok: false,
 error: { code: 'guard_abort', message: 'Approved books must never be deleted in clear-pending path.' },
 });
 }
 }

  // TEMPORARILY DISABLED: server-side book soft-delete on cancel is disabled while we debug
  // accidental bulk-delete. Only scan_jobs + scan_job_imports are touched.
  if (count > 0) {
    console.log('[SOFT_DELETE_AUDIT] SKIPPED (debug mode — book delete disabled)', JSON.stringify({
      caller: 'api/delete-pending-scan.clear_pending_by_job',
      wouldHaveDeleted: count,
      previewSample: previewRows.slice(0, 3).map((r: any) => ({ id: r.id?.slice(0, 8), status: r.status })),
    }));
    // DISABLED BODY — uncomment to re-enable:
    // const { error: booksUpdateErr } = await supabase.from('books')
    //   .update({ deleted_at: now, updated_at: now, deleted_by: userId, delete_reason: 'pending_scan_removed' })
    //   .eq('user_id', userId).in('source_scan_job_id', rawUuids).eq('status', 'pending').is('deleted_at', null);
    // if (booksUpdateErr) { console.error(...); return res.status(500).json(...); }
  }

 const photoByStatus: Record<string, Record<string, number>> = {};
 for (const photoId of photoIds) {
 const { data: photoRows } = await supabase
 .from('books')
 .select('status')
 .eq('user_id', userId)
 .eq('source_photo_id', photoId)
 .is('deleted_at', null);
 const counts: Record<string, number> = {};
 (photoRows ?? []).forEach((r: any) => {
 const s = r.status ?? 'null';
 counts[s] = (counts[s] ?? 0) + 1;
 });
 photoByStatus[photoId] = counts;
 }
 const jobByStatus: Record<string, Record<string, number>> = {};
 for (const rawJ of rawUuids) {
 const { data: jobRows } = await supabase
 .from('books')
 .select('status')
 .eq('user_id', userId)
 .eq('source_scan_job_id', rawJ)
 .is('deleted_at', null);
 const counts: Record<string, number> = {};
 (jobRows ?? []).forEach((r: any) => {
 const s = r.status ?? 'null';
 counts[s] = (counts[s] ?? 0) + 1;
 });
 jobByStatus[rawJ] = counts;
 }
 console.log('[CLEAR_PENDING_VERIFY] photoId=', photoIds[0] ?? '', 'byStatus=', JSON.stringify(photoByStatus), 'jobId=', rawUuids[0] ?? '', 'byStatus=', JSON.stringify(jobByStatus));
 }
 }
 }

// 4) TEMPORARILY DISABLED: photo row + storage delete is disabled while we debug accidental bulk-delete.
// Photos are left in place; storage is not removed. Re-enable after root cause is confirmed fixed.
for (const photoId of photoIds) {
  const { count: approvedCount } = await supabase
    .from('books')
    .select('*', { count: 'exact', head: true })
    .eq('source_photo_id', photoId)
    .eq('status', 'approved')
    .is('deleted_at', null);
  const approved = approvedCount ?? 0;
  console.log('[SOFT_DELETE_AUDIT] SKIPPED (debug mode — photo delete disabled)', JSON.stringify({
    caller: 'api/delete-pending-scan.delete_photo',
    photoId,
    approvedBooksCount: approved,
    note: approved > 0 ? 'would have been skipped anyway (approved books present)' : 'would have deleted photo + storage',
  }));
  // DISABLED BODY — uncomment to re-enable:
  // if (approved > 0) { continue; }
  // const { data: photoRow } = await supabase.from('photos').select('id,storage_path').eq('id', photoId).eq('user_id', userId).maybeSingle();
  // if (photoRow?.storage_path) { await supabase.storage.from('photos').remove([photoRow.storage_path]); }
  // await supabase.from('photos').update({ deleted_at: now, updated_at: now }).eq('id', photoId).eq('user_id', userId);
}

 return res.status(200).json({ ok: true, jobsAffected: jobIds.length });
 } catch (e: any) {
 console.error('[CLEANUP_PENDING] Error:', e?.message || e);
 return res.status(500).json({
 ok: false,
 error: { code: 'server_error', message: e?.message || 'Internal server error' },
 });
 }
}
