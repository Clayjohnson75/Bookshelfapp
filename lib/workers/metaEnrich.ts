/**
 * Meta-enrich worker: server-side metadata enrichment. Open Library primary, Google Books fallback only if no description.
 * Global cache book_metadata_cache. Concurrency 5. Never log full descriptions (descLen only).
 * Can be run directly (no HTTP) so cover-resolve-worker can chain without hitting Deployment Protection.
 *
 * Candidate selection: we do NOT filter by books.status pending and approved are both enriched.
 * Candidates: enrichment_status is null OR in ('pending','failed'); empty description; backoff on recently failed.
 * Uses getSupabase() which must be service role (SUPABASE_SERVICE_ROLE_KEY) so RLS does not hide rows.
 */
import pLimit from 'p-limit';
import { getSupabase } from '../coverResolution';
import { fetchFullMetadataForBook, type EnrichSourceTag } from '../enrichBookMetadata';
import { sanitizeTextForDb } from '../sanitizeTextForDb';
import { buildWorkKey } from '../workKey';

const META_CONCURRENCY = 5;
const limit = pLimit(META_CONCURRENCY);

/** Backoff: don't retry failed rows for this long (ms). Avoids hammering. */
const ENRICHMENT_FAILED_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

function isEmptyDescription(v: unknown): boolean {
 if (v == null) return true;
 if (typeof v !== 'string') return true;
 return v.trim().length === 0;
}

/** Candidates: enrichment_status is null OR in ('pending','failed'). We do NOT require NULL only. */
function isCandidateStatus(s: unknown): boolean {
 if (s == null) return true;
 if (s === 'pending' || s === 'failed') return true;
 return false;
}

function isPastBackoff(enrichmentUpdatedAt: unknown): boolean {
 if (enrichmentUpdatedAt == null) return true;
 const ts = typeof enrichmentUpdatedAt === 'string' ? new Date(enrichmentUpdatedAt).getTime() : NaN;
 if (Number.isNaN(ts)) return true;
 return Date.now() - ts >= ENRICHMENT_FAILED_BACKOFF_MS;
}

export type RunMetaEnrichParams = {
 scanJobId?: string;
 bookIds?: string[];
};

export type RunMetaEnrichSuccess = {
 ok: true;
 enriched: number;
 total: number;
 failed?: number;
 not_found?: number;
};

export type RunMetaEnrichError = {
 ok: false;
 error: string;
 statusCode?: number;
};

export type RunMetaEnrichResult = RunMetaEnrichSuccess | RunMetaEnrichError;

export async function runMetaEnrich(params: RunMetaEnrichParams): Promise<RunMetaEnrichResult> {
 const scanJobId = typeof params.scanJobId === 'string' ? params.scanJobId.trim() : undefined;
 const bookIds = Array.isArray(params.bookIds)
 ? params.bookIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
 : undefined;
 let scanJobUserId: string | null = null;

 if (!scanJobId && (!bookIds || bookIds.length === 0)) {
 return { ok: false, error: 'scanJobId or bookIds required', statusCode: 400 };
 }
 if (bookIds && bookIds.length > 100) {
 return { ok: false, error: 'Max 100 bookIds per batch', statusCode: 400 };
 }

 // Must use service role client so RLS does not hide pending/unapproved rows (getSupabase uses SUPABASE_SERVICE_ROLE_KEY).
 const supabase = getSupabase();
 if (!supabase) {
 return { ok: false, error: 'Storage not configured', statusCode: 500 };
 }

 if (scanJobId) {
 const { data: jobRow } = await supabase
 .from('scan_jobs')
 .select('user_id')
 .or(`job_uuid.eq.${scanJobId},id.eq.${scanJobId}`)
 .limit(1)
 .maybeSingle();
 scanJobUserId = (jobRow as any)?.user_id ?? null;
 }
 console.info('[META_ENRICH_START]', {
 scanJobId: scanJobId ?? null,
 userId: scanJobUserId,
 mode: scanJobId ? 'scanJob' : 'global',
 });

 // Do NOT filter by books.status we enrich both pending and approved. Select enrichment_updated_at for backoff.
 let query = supabase
 .from('books')
 .select('id, title, author, isbn, google_books_id, description, enrichment_status, enrichment_updated_at, status');

 const mode = scanJobId ? 'scanJobId' : 'bookIds';
 const queryFilterDesc = scanJobId
 ? `source_scan_job_id='${scanJobId}'`
 : `id IN (${bookIds!.length} ids)`;
 console.log('[META] query: from(books).select(...).' + (scanJobId ? `eq('source_scan_job_id', scanJobId)` : `in('id', bookIds)`) + ' filter: ' + queryFilterDesc);

 if (scanJobId) {
 query = query.eq('source_scan_job_id', scanJobId);
 } else {
 query = query.in('id', bookIds!);
 }

 const { data: rows, error: fetchErr } = await query;
 if (fetchErr) {
 console.error('[meta-enrich-worker] Query failed:', fetchErr.message);
 return { ok: false, error: 'Query failed', statusCode: 500 };
 }

 const allRows = rows || [];
 const totalFromQuery = allRows.length;

 if (totalFromQuery === 0) {
 console.log(`[meta-enrich-worker] No candidates (total rows: 0). Query returned 0 rows filter: ${queryFilterDesc}. Check: books may lack source_scan_job_id (provenance) or scanJobId is wrong.`);

 // Server fallback: confirm "books exist but missing provenance" without waiting for client logs
 if (scanJobId) {
 const { data: jobRow } = await supabase
 .from('scan_jobs')
 .select('user_id')
 .or(`job_uuid.eq.${scanJobId},id.eq.${scanJobId}`)
 .limit(1)
 .maybeSingle();
 const userId = (jobRow as any)?.user_id ?? null;
 if (userId) {
 const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
 const { count: fallbackCount } = await supabase
 .from('books')
 .select('*', { count: 'exact', head: true })
 .eq('user_id', userId)
 .gte('created_at', fiveMinAgo)
 .or('enrichment_status.is.null,enrichment_status.eq.pending');
 console.log(`[META] fallback (recent books, no provenance): user_id=${userId} count=${fallbackCount ?? '?'} (books exist but missing source_scan_job_id)`);

 // Last 30 books in last 10 min: confirm whether books exist at all when worker runs
 const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
 const { data: recentRows } = await supabase
 .from('books')
 .select('source_scan_job_id, created_at')
 .eq('user_id', userId)
 .gte('created_at', tenMinAgo)
 .order('created_at', { ascending: false })
 .limit(30);
 const recent = recentRows ?? [];
 const nullProvenance = recent.filter((r: any) => r.source_scan_job_id == null).length;
 const createdAts = recent.map((r: any) => r.created_at).filter(Boolean) as string[];
 const minCreatedAt = createdAts.length > 0 ? createdAts.reduce((a, b) => (a < b ? a : b)) : null;
 const maxCreatedAt = createdAts.length > 0 ? createdAts.reduce((a, b) => (a > b ? a : b)) : null;
 console.log(`[META] No candidates recent books (last 10 min, limit 30): count=${recent.length} source_scan_job_id_is_null=${nullProvenance} min_created_at=${minCreatedAt ?? ''} max_created_at=${maxCreatedAt ?? ''}`);
 }
 }

 return { ok: true, enriched: 0, total: 0 };
 }

 // Candidate breakdown: count at each filter step so we know which predicate is killing rows
 const missingDescription = allRows.filter((r: any) => isEmptyDescription(r.description)).length;
 const alreadyHasDescription = totalFromQuery - missingDescription;
 const statusComplete = allRows.filter((r: any) => r.enrichment_status === 'complete').length;
 const statusNotFound = allRows.filter((r: any) => r.enrichment_status === 'not_found').length;
 const enrichmentStatusInScope = allRows.filter((r: any) => isCandidateStatus(r.enrichment_status)).length;
 const alreadyEnrichedStatus = totalFromQuery - enrichmentStatusInScope; // complete/not_found excluded
 const hasGoogleBooksId = allRows.filter((r: any) => r.google_books_id != null && String(r.google_books_id).trim() !== '').length;
 const hasIsbn = allRows.filter((r: any) => r.isbn != null && String(r.isbn).trim() !== '').length;
 const hasTitleAuthor = allRows.filter((r: any) => {
 const t = r.title != null && String(r.title).trim() !== '';
 const a = r.author != null && String(r.author).trim() !== '';
 return t && a;
 }).length;
 // Backoff: skip failed rows that were updated recently to avoid hammering
 const afterBackoff = allRows.filter(
 (r: any) =>
 r.enrichment_status !== 'failed' || isPastBackoff(r.enrichment_updated_at)
 );
 const excludedByBackoff = allRows.length - afterBackoff.length;
 const candidates = afterBackoff.filter(
 (r: any) => isEmptyDescription(r.description) && isCandidateStatus(r.enrichment_status)
 );
 const finalCandidates = candidates.length;
 const statusNotFoundRecent = statusNotFound;
 const backoffFailedRecent = excludedByBackoff;
 let missingScanJobId = 0;
 if (scanJobId && scanJobUserId) {
 const { count } = await supabase
 .from('books')
 .select('*', { count: 'exact', head: true })
 .eq('user_id', scanJobUserId)
 .is('source_scan_job_id', null)
 .or('enrichment_status.is.null,enrichment_status.eq.pending,enrichment_status.eq.failed');
 missingScanJobId = count ?? 0;
 }
 console.info('[META_CANDIDATES]', {
 found: totalFromQuery,
 eligibleAfterFilters: finalCandidates,
 already_has_desc: alreadyHasDescription,
 status_complete: statusComplete,
 status_not_found_recent: statusNotFoundRecent,
 backoff_failed_recent: backoffFailedRecent,
 missing_scan_job_id: scanJobId ? missingScanJobId : null,
 });

 // Status breakdown (we do NOT filter by status log so we see pending vs approved)
 const statusPending = allRows.filter((r: any) => r.status === 'pending').length;
 const statusApproved = allRows.filter((r: any) => r.status === 'approved').length;
 const statusOther = totalFromQuery - statusPending - statusApproved;

 console.log('[META] query knobs:', {
 mode,
 scanJobId: scanJobId ?? null,
 bookIdsCount: bookIds?.length ?? null,
 maxBookIdsPerBatch: 100,
 concurrency: META_CONCURRENCY,
 serviceRole: true,
 });
 console.log('[META] candidate check:');
 console.log(` - total_books_from_query=${totalFromQuery} (query filter: ${queryFilterDesc})`);
 console.log(` - status_pending=${statusPending} status_approved=${statusApproved} status_other=${statusOther}`);
 console.log(` - missing_description=${missingDescription} (already_has_description=${alreadyHasDescription})`);
 console.log(` - enrichment_status_in_scope=${enrichmentStatusInScope} (already_enriched_status=${alreadyEnrichedStatus})`);
 console.log(` - has_google_books_id=${hasGoogleBooksId} has_isbn=${hasIsbn} has_title_author=${hasTitleAuthor}`);
 console.log(` - excluded_by_backoff=${excludedByBackoff} final_candidates=${finalCandidates}`);

 if (candidates.length === 0) {
 console.log(`[meta-enrich-worker] No candidates (total rows: ${totalFromQuery}). Filter: ${queryFilterDesc}. Breakdown above shows which predicate removed rows.`);
 return { ok: true, enriched: 0, total: 0 };
 }

 type ResultItem = {
 status: 'complete' | 'not_found' | 'failed';
 sourceTag?: EnrichSourceTag;
 id: string;
 title?: string | null;
 description?: string | null;
 description_source?: string | null;
 publisher?: string | null;
 published_date?: string | null;
 categories?: string[] | null;
 page_count?: number | null;
 isbn?: string | null;
 };

 const results: ResultItem[] = [];
 const startMs = Date.now();

 const tasks = candidates.map((row: any) =>
 limit(async (): Promise<ResultItem> => {
 const bookId = row.id;
 const titleAuthor = `${String(row.title ?? '').slice(0, 40)} | ${String(row.author ?? '').slice(0, 30)}`;
 const work_key = buildWorkKey(row.isbn, row.title, row.author) || undefined;
 try {
 const { meta, sourceTag } = await fetchFullMetadataForBook(
 {
 id: row.id,
 title: row.title,
 author: row.author,
 isbn: row.isbn,
 google_books_id: row.google_books_id,
 },
 { supabase, work_key }
 );

 const chosenSource = sourceTag ?? 'unknown';
 const gotDescLen = typeof meta.description === 'string' ? meta.description.length : 0;
 const statusWritten = meta.enrichment_status;

 const nowIso = new Date().toISOString();
 const updatePayload: Record<string, unknown> = {
 enrichment_status: meta.enrichment_status,
 enrichment_updated_at: nowIso,
 updated_at: nowIso,
 };

 if (meta.enrichment_status === 'complete') {
 if (meta.description) {
 updatePayload.description = meta.description;
 updatePayload.description_source = meta.description_source ?? 'open_library';
 }
 if (meta.publisher != null) updatePayload.publisher = sanitizeTextForDb(meta.publisher) ?? meta.publisher;
 if (meta.published_date != null) updatePayload.published_date = meta.published_date;
 if (meta.page_count != null) updatePayload.page_count = meta.page_count;
 if (meta.categories != null) updatePayload.categories = meta.categories;
 if (meta.language != null) updatePayload.language = meta.language;
 if (meta.subtitle != null) updatePayload.subtitle = sanitizeTextForDb(meta.subtitle) ?? meta.subtitle;
 if (meta.isbn != null) updatePayload.isbn = meta.isbn;
 if (meta.average_rating != null) updatePayload.average_rating = meta.average_rating;
 if (meta.ratings_count != null) updatePayload.ratings_count = meta.ratings_count;
 if (meta.google_books_id != null) updatePayload.google_books_id = meta.google_books_id;
 }

 const { data: updatedRows, error: updateErr } = await supabase
 .from('books')
 .update(updatePayload)
 .eq('id', bookId)
 .select('id');

 if (updateErr) {
 const failedItem: ResultItem = { status: 'failed', sourceTag: 'failed', id: bookId, title: row.title };
 results.push(failedItem);
 console.info('[META_ENRICH_ONE_RESULT]', {
 bookId,
 descLen: 0,
 status: 'failed',
 source: 'failed',
 updatedRows: 0,
 });
 console.log(`[META] candidate bookId=${bookId} title|author="${titleAuthor.replace(/"/g, '\\"')}" source=failed gotDescLen=0 statusWritten=failed`);
 return failedItem;
 }

 const item: ResultItem = {
 status: meta.enrichment_status,
 sourceTag,
 id: bookId,
 title: row.title,
 description: meta.enrichment_status === 'complete' ? meta.description ?? null : null,
 description_source: meta.description_source ?? null,
 publisher: meta.enrichment_status === 'complete' ? meta.publisher ?? null : null,
 published_date: meta.enrichment_status === 'complete' ? meta.published_date ?? null : null,
 categories: meta.enrichment_status === 'complete' ? meta.categories ?? null : null,
 page_count: meta.enrichment_status === 'complete' ? meta.page_count ?? null : null,
 isbn: meta.enrichment_status === 'complete' ? meta.isbn ?? null : null,
 };
 results.push(item);
 console.info('[META_ENRICH_ONE_RESULT]', {
 bookId,
 descLen: gotDescLen,
 status: meta.enrichment_status,
 source: chosenSource,
 updatedRows: updatedRows?.length ?? 0,
 });
 console.log(`[META] candidate bookId=${bookId} title|author="${titleAuthor.replace(/"/g, '\\"')}" source=${chosenSource} gotDescLen=${gotDescLen} statusWritten=${statusWritten}`);
 return item;
 } catch (err: any) {
 const nowIso = new Date().toISOString();
 const { data: failedRows } = await supabase
 .from('books')
 .update({
 enrichment_status: 'failed',
 enrichment_updated_at: nowIso,
 updated_at: nowIso,
 })
 .eq('id', bookId)
 .select('id');
 const failedItem: ResultItem = { status: 'failed', sourceTag: 'failed', id: bookId, title: row.title };
 results.push(failedItem);
 console.info('[META_ENRICH_ONE_RESULT]', {
 bookId,
 descLen: 0,
 status: 'failed',
 source: 'failed',
 updatedRows: failedRows?.length ?? 0,
 });
 console.log(`[META] candidate bookId=${bookId} title|author="${titleAuthor.replace(/"/g, '\\"')}" source=failed gotDescLen=0 statusWritten=failed`);
 return failedItem;
 }
 })
 );

 await Promise.all(tasks);

 const total = candidates.length;
 const withDesc = results.filter(
 (b) => typeof b.description === 'string' && b.description.trim().length > 0
 ).length;
 const withIsbn = results.filter(
 (b) => typeof b.isbn === 'string' && b.isbn.trim().length > 0
 ).length;
 const withPublisher = results.filter(
 (b) => typeof b.publisher === 'string' && b.publisher.trim().length > 0
 ).length;
 const withPublishedDate = results.filter(
 (b) => typeof b.published_date === 'string' && b.published_date.trim().length > 0
 ).length;
 const withCategories = results.filter(
 (b) => Array.isArray(b.categories) && b.categories.length > 0
 ).length;
 const withPageCount = results.filter(
 (b) => typeof b.page_count === 'number' && b.page_count > 0
 ).length;

 const cacheHit = results.filter((r) => r.sourceTag === 'cache').length;
 const openlib = results.filter((r) => r.sourceTag === 'open_library').length;
 const google = results.filter((r) => r.sourceTag === 'google_books').length;
 const failedCount = results.filter((r) => r.status === 'failed').length;
 const notFoundCount = results.filter((r) => r.status === 'not_found').length;
 const durMs = Date.now() - startMs;

 console.info(
 `[meta-enrich-worker] Enriched ${withDesc}/${total} descriptions (cacheHit=${cacheHit} openlib=${openlib} google=${google} failed=${failedCount}) durMs=${durMs}`
 );

 return {
 ok: true,
 enriched: withDesc,
 total,
 failed: failedCount,
 not_found: notFoundCount,
 };
}
