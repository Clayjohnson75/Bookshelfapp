import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateOpId } from '../lib/scanCorrelation';

/**
 * Delete library photo (and optionally cascade soft-delete approved books).
 *
 * IDOR: Must NOT accept userId from body as authority. Require Bearer and derive user from token only.
 * Otherwise an attacker could delete other users' photos and all their books.
 *
 * Auth: Authorization: Bearer <Supabase access_token> required. authedUserId is derived from the token only; any body userId is ignored.
 * All DB changes run in one transaction via RPC delete_library_photo_and_books; then storage object is removed.
 * Hard guard: isUserInitiated required true.
 *
 * Type: RPC expects p_photo_id uuid; books.source_photo_id must be uuid so cascade matches. Run migration books-source-photo-id-uuid.sql if delete fails with type errors.
 *
 * POST body: { photoId, cascadeBooks?, isUserInitiated, imageHash?, opId? } no userId; do not trust body for identity.
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

 const authHeader = req.headers.authorization;
 const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
 if (!token) {
 return res.status(401).json({
 ok: false,
 error: { code: 'unauthorized', message: 'Authorization: Bearer <token> required' },
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

 const { data: userData, error: authError } = await supabase.auth.getUser(token);
 if (authError || !userData?.user) {
 return res.status(401).json({
 ok: false,
 error: { code: 'invalid_token', message: authError?.message ?? 'Invalid or expired token' },
 });
 }
 const authedUserId = userData.user.id;

 // IDOR guard: never use body userId for authority; token is the only source of identity.
 const body = (req.body || {}) as Record<string, unknown>;
 if (body.userId !== undefined) {
 console.warn('[DELETE_LIBRARY_PHOTO] IDOR guard: ignoring body userId, using token only', { authedUserId });
 }
 const { photoId, cascadeBooks: bodyCascadeBooks, isUserInitiated, opId: bodyOpId, imageHash: bodyImageHash } = body;
 // Do not destructure userId from body never trust client for identity.

 const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 try {
 if (typeof photoId === 'string' && photoId) {
 console.log('[DELETE_PHOTO_REQUEST]', JSON.stringify({ photoId, authedUserId }));
 }
 const opId = typeof bodyOpId === 'string' && bodyOpId ? bodyOpId : generateOpId();

 // Hard guard: only allow delete when user explicitly tapped "delete photo". No refresh, sync, dedupe, or replace logic.
 if (!isUserInitiated) {
 console.log('[DELETE_LIBRARY_PHOTO] rejected: isUserInitiated not true (photoId=', photoId, ')');
 return res.status(403).json({
 ok: false,
 error: { code: 'not_user_initiated', message: 'Photo delete is only allowed via explicit user action' },
 });
 }

 if (!photoId || typeof photoId !== 'string') {
 return res.status(400).json({
 ok: false,
 error: { code: 'missing_photo_id', message: 'photoId is required' },
 });
 }
 console.log('[DELETE_STEP] photoId input', { photoId, typeof_photoId: typeof photoId });

  // Default cascadeBooks=false: deleting a photo only detaches its books (source_photo_id = NULL).
  // Books survive with their own lifecycle. Only cascade when user explicitly confirms "Delete photo + books".
  const cascadeBooks = typeof bodyCascadeBooks === 'boolean' ? bodyCascadeBooks : false;

 // Delete must target photoId (primary key) only. Always scope by authed user so users cannot delete others' photos.
 console.log('[DELETE_STEP] fetch_photo_row', { table: 'photos', column: 'id', photoId, typeof_photoId: typeof photoId });
 let { data: photoRows, error: photoFetchError } = await supabase
 .from('photos')
 .select('id, user_id, storage_path')
 .eq('id', photoId)
 .eq('user_id', authedUserId);

 if (photoFetchError) {
 return res.status(500).json({
 ok: false,
 error: { code: 'photo_fetch_failed', message: (photoFetchError as { message?: string })?.message ?? 'Failed to fetch photo' },
 });
 }
 let matchedPhotoIds = (photoRows ?? []).map((r) => r.id);
 console.log('[DELETE_SELECTION]', { requestedPhotoId: photoId, matchedPhotoIds, imageHashProvided: !!bodyImageHash });

 // If photoId not found and client sent imageHash, resolve canonical photo by (user_id, image_hash) and delete that row.
 const imageHash = typeof bodyImageHash === 'string' && bodyImageHash.trim() ? bodyImageHash.trim() : null;
 if (matchedPhotoIds.length === 0 && imageHash) {
 console.log('[DELETE_STEP] resolve_photo_by_image_hash', { table: 'photos', columns: ['user_id', 'image_hash'], photoId_requested: photoId });
 const { data: byHashRows, error: byHashErr } = await supabase
 .from('photos')
 .select('id, user_id, storage_path')
 .eq('user_id', authedUserId)
 .eq('image_hash', imageHash)
 .is('deleted_at', null);
 if (!byHashErr && byHashRows && byHashRows.length === 1) {
 photoRows = byHashRows;
 matchedPhotoIds = byHashRows.map((r) => r.id);
 console.log('[DELETE_SELECTION] resolved by image_hash', { requestedPhotoId: photoId, canonicalPhotoId: matchedPhotoIds[0] });
 }
 }

 if (matchedPhotoIds.length > 1) {
 console.error('[DELETE_SELECTION] GUARD: multiple photos matched for single photoId (delete must target primary key only). matchedPhotoIds=', matchedPhotoIds);
 return res.status(500).json({
 ok: false,
 error: { code: 'delete_selection_multiple', message: 'Delete must target one photo by primary key; multiple rows matched' },
 });
 }
 if (matchedPhotoIds.length === 0) {
 return res.status(404).json({
 ok: false,
 error: { code: 'photo_not_found', message: 'Photo not found' },
 });
 }
 const photoRow = photoRows![0];
 const resolvedPhotoId = photoRow.id;
 const resolvedPhotoIdIsUuid = UUID_REGEX.test(resolvedPhotoId);
 console.log('[DELETE_LIBRARY_PHOTO] requestedPhotoId=', photoId, 'resolvedPhotoId=', resolvedPhotoId, 'cascadeBooks=', cascadeBooks, 'opId=', opId);

 // RPC delete_library_photo_and_books expects p_photo_id uuid; books.source_photo_id must be uuid for cascade to match.
 if (!resolvedPhotoIdIsUuid) {
 console.warn('[DELETE_LIBRARY_PHOTO] resolvedPhotoId is not a valid UUID; RPC may fail. Run migration books-source-photo-id-uuid.sql and ensure photos.id is uuid.', { resolvedPhotoId });
 return res.status(500).json({
 ok: false,
 error: { code: 'invalid_photo_id_type', message: 'Photo id must be a UUID for delete. Contact support if this persists.' },
 });
 }

  // Count books referencing this photo for logging. The RPC handles both paths safely:
  //   cascadeBooks=true  -> soft-delete those books
  //   cascadeBooks=false -> null out source_photo_id on those books (detach, not delete)
  // We no longer block the delete when books reference the photo — both modes are safe.
  console.log('[DELETE_STEP] count_books_by_photo', { table: 'books', column: 'source_photo_id', photoId: resolvedPhotoId, cascadeBooks });
  const { count: refCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', authedUserId)
    .eq('source_photo_id', resolvedPhotoId)
    .is('deleted_at', null);
  console.log('[DELETE_STEP] books_referencing_photo', { count: refCount ?? 0, cascadeBooks });

 // Fetch column types via raw SQL information_schema is NOT accessible via
 // PostgREST .from(), so we call an RPC that runs the query directly.
 // This populates debug.columnTypes so any type-mismatch is diagnosable.
 const columnTypes: Record<string, string> = {};
 try {
 const { data: colTypeRows, error: colTypeErr } = await supabase.rpc('get_photo_column_types' as any);
 if (colTypeErr) {
 console.warn('[DELETE_SCHEMA_TYPES] get_photo_column_types RPC not available, falling back to direct query:', colTypeErr.message);
 // Fallback: run a direct SQL query via the pg REST interface
 const { data: fallbackRows, error: fallbackErr } = await (supabase as any).rpc('query', {
 sql: `select table_name, column_name, data_type, udt_name from information_schema.columns where table_schema='public' and table_name in ('photos','books','scan_jobs','library_events') and column_name in ('id','photo_id','source_photo_id','source_scan_job_id','book_id','user_id')`,
 });
 if (!fallbackErr) {
 for (const row of (fallbackRows ?? []) as Array<{ table_name: string; column_name: string; data_type: string; udt_name: string }>) {
 columnTypes[`${row.table_name}.${row.column_name}`] = `${row.data_type}/${row.udt_name}`;
 }
 }
 } else {
 for (const row of (colTypeRows ?? []) as Array<{ table_name: string; column_name: string; data_type: string; udt_name?: string }>) {
 columnTypes[`${row.table_name}.${row.column_name}`] = row.udt_name ? `${row.data_type}/${row.udt_name}` : row.data_type;
 }
 }
 } catch (schemaErr: any) {
 console.warn('[DELETE_SCHEMA_TYPES] schema check failed:', schemaErr?.message);
 }
 console.log('[DELETE_SCHEMA_TYPES]', JSON.stringify(columnTypes));

 // Single transaction: RPC soft-deletes books then photo; returns storage_path for API to remove object.
 console.log('[DELETE_STEP] rpc_delete_library_photo_and_books', {
 step: 'RPC: UPDATE books SET deleted_at WHERE source_photo_id = p_photo_id; UPDATE photos SET deleted_at WHERE id = p_photo_id',
 table_books_column: 'source_photo_id',
 table_photos_column: 'id',
 photoId: resolvedPhotoId,
 typeof_photoId: typeof resolvedPhotoId,
 });
 const { data: rpcResult, error: rpcError } = await supabase.rpc('delete_library_photo_and_books', {
 p_photo_id: resolvedPhotoId,
 p_cascade_books: cascadeBooks,
 p_user_id: authedUserId,
 });

 if (rpcError) {
 console.error('[API] [DELETE-LIBRARY-PHOTO] RPC error:', rpcError);
 return res.status(500).json({
 ok: false,
 error: { code: 'delete_failed', message: (rpcError as { message?: string })?.message ?? 'Delete failed' },
 debug: { columnTypes },
 });
 }

  const result = rpcResult as { ok?: boolean; error?: string; deleted_books?: number; nulled_books?: number; deleted_photo?: number; storage_path?: string | null } | null;
 if (!result || result.ok !== true) {
 const err = result?.error ?? 'photo_not_found';
 if (err === 'photo_not_found') {
 return res.status(404).json({
 ok: false,
 error: { code: 'photo_not_found', message: 'Photo not found' },
 });
 }
 if (err === 'user_required') {
 return res.status(400).json({
 ok: false,
 error: { code: 'user_required', message: 'User context required' },
 });
 }
 return res.status(500).json({
 ok: false,
 error: { code: 'delete_failed', message: err },
 });
 }

  const deletedBooks = typeof result.deleted_books === 'number' ? result.deleted_books : 0;
  const nulledBooks  = typeof result.nulled_books  === 'number' ? result.nulled_books  : 0;
  const deletedPhoto = typeof result.deleted_photo === 'number' ? result.deleted_photo : 0;
  const storagePath = typeof result.storage_path === 'string' && result.storage_path.trim() ? result.storage_path.trim() : null;

  // DB result: RPC has run — log before touching storage so we can distinguish the two steps.
  console.log('[PHOTO_DELETE_RESULT_DB]', JSON.stringify({
    photoId: resolvedPhotoId,
    deletedPhotoRow: deletedPhoto,
    deletedBooks,
    nulledBooks,
    cascadeBooks,
    storagePath: storagePath ?? null,
  }));

 let deletedStorageObjects = 0;
 if (storagePath) {
 console.log('[DELETE_STEP] storage_remove', { step: 'storage.from(photos).remove([path])', photoId: resolvedPhotoId, storagePath });
 const { error: storageErr } = await supabase.storage.from('photos').remove([storagePath]);
 if (!storageErr) deletedStorageObjects = 1;
 else console.warn('[DELETE_LIBRARY_PHOTO] storage remove failed:', storageErr);
 }

 // Storage result: log after remove so we see if storage succeeded even when DB did.
 console.log('[PHOTO_DELETE_RESULT_STORAGE]', JSON.stringify({
 photoId: resolvedPhotoId,
 storagePath: storagePath ?? null,
 deletedStorageObjects,
 storageSkipped: !storagePath,
 }));

 console.log('[DELETE_PHOTO_RESULT]', JSON.stringify({
 photoId: resolvedPhotoId,
 deletedBooks,
 deletedPhotoRow: deletedPhoto,
 deletedStorageObjects,
 }));

  return res.status(200).json({
    ok: true,
    booksDeleted: deletedBooks,
    booksDetached: nulledBooks,
    photoDeleted: deletedPhoto,
    deletedStorageObjects,
  });
 } catch (e: any) {
 console.error('[API] [DELETE-LIBRARY-PHOTO] Error:', e?.message || e);
 return res.status(500).json({
 ok: false,
 error: { code: 'server_error', message: e?.message || 'Internal server error' },
 });
 }
}
