import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
 generateScanId,
 retryWithBackoff,
 isGeminiInCooldown,
 isGeminiQuotaExceeded,
 recordGemini503,
 recordGeminiQuotaError,
 recordGeminiSuccess,
 ScanTimeBudget,
} from './scan-resilience';
import { ScanResultSchema, getScanResultJsonSchema } from './scan-schema';
import { splitImageIntoTiles, splitImageIntoHorizontalBands } from '../lib/imageTiles';
import { buildWorkKey, getStoragePublicUrl, lookupBatch, upsertPending } from '../lib/coverResolution';
import { normalizeTitle as canonicalTitle, normalizeAuthor as canonicalAuthor } from '../lib/workKey';
import { enqueueCoverResolve } from '../lib/enqueueCoverResolve';
import { sanitizeBookForDb, sanitizeTextForDb, debugString } from '../lib/sanitizeTextForDb';
import { computeBookKey } from '../lib/bookKey';
import { fetchDescriptionForBook } from '../lib/enrichDescription';
import { generateOpId, scanLogPrefix } from '../lib/scanCorrelation';
import { toRawScanJobUuid } from '../lib/scanId';
import { getCanonicalPhotoStoragePath } from '../lib/photoStoragePath';
import { updateProgress as writeScanProgress } from '../lib/scanProgressServer';
import { checkRateLimit, sendRateLimitResponse } from '../lib/rateLimit';

/**
 * Optimize image to canonical WebP (same params as worker). Hash = bytes we store dedupe is authoritative.
 * Returns the buffer to upload and its content type/extension. On failure, returns original buffer + mime.
 */
async function optimizeToCanonicalWebp(
 imageBuffer: Buffer,
 mimeType: string
): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
 try {
 const sharp = (await import('sharp')).default;
 const optimizedBuffer = await sharp(imageBuffer)
 .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
 .webp({ quality: 85, effort: 4 })
 .toBuffer();
 return { buffer: optimizedBuffer, contentType: 'image/webp', ext: 'webp' };
 } catch (err: any) {
 console.warn('[SCAN] optimizeToCanonicalWebp failed, using original:', err?.message ?? err);
 const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
 return { buffer: imageBuffer, contentType: mimeType, ext };
 }
}

/** One server summary per scan job for Vercel logs. Supports camelCase and snake_case book fields. */
function summarizeBooksForLogs(books: any[]): { count: Record<string, number>; sample: any[] } {
 const hasText = (v: any) => typeof v === 'string' && v.trim().length > 0;
 const hasArr = (v: any) => Array.isArray(v) && v.length > 0;

 const count = {
 total: books.length,
 withCover: 0,
 withDescription: 0,
 withIsbn10: 0,
 withIsbn13: 0,
 withPublisher: 0,
 withPublishedDate: 0,
 withCategories: 0,
 withPageCount: 0,
 withLanguage: 0,
 };

 for (const b of books) {
 const cover = b.cover_url ?? b.coverUrl;
 const desc = b.description;
 const isbn10 = b.isbn_10 ?? b.isbn10;
 const isbn13 = b.isbn_13 ?? b.isbn13;
 const pub = b.publisher;
 const pubDate = b.published_date ?? b.publishedDate;
 const cats = b.categories;
 const pages = b.page_count ?? b.pageCount;
 const lang = b.language;

 if (hasText(cover)) count.withCover++;
 if (hasText(desc)) count.withDescription++;
 if (hasText(isbn10)) count.withIsbn10++;
 if (hasText(isbn13)) count.withIsbn13++;
 if (hasText(pub)) count.withPublisher++;
 if (hasText(pubDate)) count.withPublishedDate++;
 if (hasArr(cats)) count.withCategories++;
 if (typeof pages === 'number' && pages > 0) count.withPageCount++;
 if (hasText(lang)) count.withLanguage++;
 }

 const sample = books.slice(0, 3).map((b) => ({
 id: b.id ?? null,
 title: (b.title ?? '').slice(0, 60),
 author: (b.author ?? '').slice(0, 40),
 descLen: hasText(b.description) ? (b.description as string).length : 0,
 hasCover: !!(b.cover_url ?? b.coverUrl),
 isbn13: b.isbn_13 ?? b.isbn13 ?? null,
 published_date: b.published_date ?? b.publishedDate ?? null,
 categoriesCount: Array.isArray(b.categories) ? b.categories.length : 0,
 }));

 return { count, sample };
}

/** Count metadata coverage for a list of books. Use after enrichment for a single clean log line. */
function summarizeMeta(books: any[]): {
 total: number;
 withDesc: number;
 withIsbn: number;
 withPublisher: number;
 withPublishedDate: number;
 withCategories: number;
 withPageCount: number;
} {
 const hasText = (v: any) => typeof v === 'string' && v.trim().length > 0;
 const hasArr = (v: any) => Array.isArray(v) && v.length > 0;
 return {
 total: books.length,
 withDesc: books.filter((b: any) => hasText(b.description)).length,
 withIsbn: books.filter((b: any) => hasText(b.isbn) || hasText(b.isbn_10) || hasText(b.isbn_13)).length,
 withPublisher: books.filter((b: any) => hasText(b.publisher)).length,
 withPublishedDate: books.filter((b: any) => hasText(b.published_date)).length,
 withCategories: books.filter((b: any) => hasArr(b.categories)).length,
 withPageCount: books.filter((b: any) => typeof b.page_count === 'number' && b.page_count > 0).length,
 };
}

const STRING_FIELDS = ['title', 'author', 'subtitle', 'description', 'publisher', 'publishedDate', 'published_date', 'language', 'printType', 'print_type', 'confidence'] as const;

/** Find books that have a backslash in any string field (likely poison for JSONB). For logging on save failure. */
function getBooksWithBackslash(books: any[]): { index: number; title: string; author: string; field: string; valuePreview: string; backslashContext: string }[] {
 const out: { index: number; title: string; author: string; field: string; valuePreview: string; backslashContext: string }[] = [];
 for (let i = 0; i < books.length; i++) {
 const b = books[i];
 const title = String(b?.title ?? '').slice(0, 60);
 const author = String(b?.author ?? '').slice(0, 40);
 for (const key of STRING_FIELDS) {
 const val = (b as any)[key];
 if (typeof val !== 'string') continue;
 if (!val.includes('\\')) continue;
 const backslashContext = val.slice(0, 200);
 const valuePreview = val.length > 80 ? val.slice(0, 80) + '' : val;
 out.push({ index: i, title, author, field: key, valuePreview, backslashContext });
 }
 }
 return out;
}

/** Compact metadata + cover summary for Vercel logs. Use after saving books (and after cover resolution if done server-side). */
function buildScanJobMetaSummary(
 jobId: string,
 books: any[],
 extra?: { recovery?: boolean }
): Record<string, unknown> {
 const withCover = books.filter((b: any) => !!(b.cover_url ?? b.coverUrl ?? b.cover_path ?? b.coverPath)).length;
 const withDesc = books.filter((b: any) => typeof b.description === 'string' && b.description.trim().length > 0).length;
 return {
 jobId,
 total: books.length,
 withCover,
 withDesc,
 withIsbn13: books.filter((b: any) => !!(b.isbn_13 ?? b.isbn13)).length,
 withPublisher: books.filter((b: any) => !!b.publisher).length,
 withPublishedDate: books.filter((b: any) => !!(b.published_date ?? b.publishedDate)).length,
 sample: books.slice(0, 3).map((b: any) => ({
 id: b.id,
 title: b.title,
 descLen: b.description?.length ?? 0,
 hasCover: !!(b.cover_url ?? b.coverUrl ?? b.cover_path ?? b.coverPath),
 isbn13: b.isbn_13 ?? b.isbn13 ?? null,
 })),
 ...extra,
 };
}

/**
 * Upsert scan job books into the books table (by user_id + book_key), then run metadata enrichment
 * (Google Books Open Library) and update each row by real books.id UUID.
 * Logs: per-book [META] ok|not_found|failed when LOG_LEVEL=debug or META_DEBUG=1; always one line [meta-enrich-worker] summary.
 */
async function upsertBooksAndEnrichMetadata(
 supabase: any,
 userId: string,
 jobId: string,
 scanId: string,
 books: any[]
): Promise<void> {
 if (!books.length) return;
 const { data: jobRow } = await supabase
 .from('scan_jobs')
 .select('id, photo_id')
 .eq('id', jobId)
 .maybeSingle();
 // scan_jobs.id is now uuid use it directly; job_uuid is a redundant mirror column.
 const rawJobId = (jobRow?.id != null ? String(jobRow.id) : null) ?? toRawScanJobUuid(jobId);
 const photoId = jobRow?.photo_id ?? null;
 if (!rawJobId) {
 console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Metadata enrichment skipped: no valid job id`);
 return;
 }
 // Invariant: books.source_photo_id must equal the scan job's photo_id. Do NOT insert books until job has photo_id (e.g. after dedupe patch).
 if (!photoId) {
 console.warn(`[SCAN_PROCESSOR] books_join_key_missing`, { jobId, scanId, reason: 'scan_jobs.photo_id is null', message: 'Skipping book insert until job has photo_id; books must use this job\'s photo_id as source_photo_id' });
 return;
 }

 // Join keys the app expects: books.source_photo_id = photo UUID, books.user_id = user UUID, books.status = pending|approved (client filters by these).
 // NEVER reuse a cached source_photo_id from the book input; always use the job's photo_id.
 const nowIso = new Date().toISOString();
 const scannedAt = Date.now();
 const dbRows: any[] = [];
 for (const book of books) {
 const bookKey = computeBookKey({
 title: book.title,
 author: book.author,
 isbn: book.isbn ?? book.isbn_13 ?? book.isbn13,
 id: undefined,
 });
 const title = sanitizeTextForDb(book.title) ?? '';
 const author = sanitizeTextForDb(book.author) ?? '';
 const row: any = {
 user_id: userId,
 book_key: bookKey,
 title,
 author,
 status: 'pending',
 scanned_at: scannedAt,
 updated_at: nowIso,
 source_scan_job_id: rawJobId,
 source_photo_id: photoId,
 // Hard-undelete: Clear Library soft-deletes by book_key; scan must revive so future scans don't stay deleted.
 deleted_at: null,
 };
 if (book.isbn ?? book.isbn_13 ?? book.isbn13) row.isbn = book.isbn ?? book.isbn_13 ?? book.isbn13;
 if (book.confidence) row.confidence = book.confidence;
 if (book.google_books_id ?? book.googleBooksId) row.google_books_id = book.google_books_id ?? book.googleBooksId;
 const desc = sanitizeTextForDb(book.description);
 if (desc) row.description = desc;
 if (book.page_count ?? book.pageCount != null) row.page_count = book.page_count ?? book.pageCount;
 if (book.categories) row.categories = book.categories;
 if (book.publisher) row.publisher = sanitizeTextForDb(book.publisher);
 if (book.published_date ?? book.publishedDate) row.published_date = book.published_date ?? book.publishedDate;
 if (book.language) row.language = sanitizeTextForDb(book.language);
 if (book.average_rating ?? book.averageRating != null) row.average_rating = book.average_rating ?? book.averageRating;
 if (book.ratings_count ?? book.ratingsCount != null) row.ratings_count = book.ratings_count ?? book.ratingsCount;
 if (book.subtitle) row.subtitle = sanitizeTextForDb(book.subtitle);
 if (book.print_type ?? book.printType) row.print_type = book.print_type ?? book.printType;
 if (book.cover_url ?? book.coverUrl) row.cover_url = book.cover_url ?? book.coverUrl;
 dbRows.push(row);
 }

 const firstRow = dbRows[0];
 if (firstRow) {
 console.log(`[SCAN_PROCESSOR] books_join_keys`, { jobId, scanId, rowCount: dbRows.length, source_photo_id: firstRow.source_photo_id ?? null, user_id: firstRow.user_id ?? null, status: firstRow.status, has_source_photo_id: !!firstRow.source_photo_id });
 }
// Insert row-by-row so we never depend on ON CONFLICT. Per-row errors are logged and skipped — the whole batch never fails.
// insertedIds = rows we actually inserted (this photo). resolvedUpserted = all ids for keyToId/enrichment (includes existing rows on 23505).
const resolvedUpserted: { id: string; book_key: string }[] = [];
const insertedIds: string[] = [];
for (let i = 0; i < dbRows.length; i++) {
  const row = dbRows[i];
  try {
    const { data: one, error: oneErr } = await supabase
      .from('books')
      .insert(row)
      .select('id, book_key')
      .single();
    if (!oneErr && one?.id) {
      resolvedUpserted.push({ id: one.id, book_key: (one as any).book_key ?? row.book_key ?? '' });
      insertedIds.push(one.id);
      continue;
    }
    if (oneErr && (oneErr as any).code === '23505') {
      let q = supabase.from('books').select('id, book_key, status, deleted_at').eq('user_id', userId).eq('title', row.title);
      if (row.author != null && row.author !== '') {
        q = q.eq('author', row.author);
      } else {
        q = q.or('author.is.null,author.eq.');
      }
      const { data: existing } = await q.limit(1).maybeSingle();
      if (existing?.id) {
        resolvedUpserted.push({ id: existing.id, book_key: (existing as any).book_key ?? row.book_key ?? '' });
        // Only reset to 'pending' if the book was DELETED (soft-deleted).
        // Never reset a currently-approved book back to pending — that causes
        // approved books to reappear in the pending tab after re-scanning.
        if (existing.deleted_at != null) {
          await supabase.from('books').update({
            status: 'pending',
            deleted_at: null,
            source_scan_job_id: rawJobId,
            source_photo_id: photoId,
            updated_at: nowIso,
          }).eq('id', existing.id);
        } else if (existing.status !== 'approved') {
          // Update source fields for non-approved books (e.g. pending from a previous scan)
          await supabase.from('books').update({
            source_scan_job_id: rawJobId,
            source_photo_id: photoId,
            updated_at: nowIso,
          }).eq('id', existing.id);
        }
        // If status is 'approved': leave it alone — book is already in user's library
      }
      continue;
    }
    console.warn(`[SCAN_PROCESSOR] books_insert_row_skip`, { jobId, scanId, index: i, code: (oneErr as any)?.code, message: (oneErr as any)?.message });
  } catch (err: any) {
    console.warn(`[SCAN_PROCESSOR] books_insert_row_error`, { jobId, scanId, index: i, message: err?.message ?? String(err) });
  }
}
 const insertedCount = resolvedUpserted.length;
 const bookIdsInserted = insertedIds;
 // Server-side invariant: only for rows we actually inserted; reused rows (23505) have a different source_photo_id by design.
 if (insertedIds.length > 0) {
   const { data: verifyRows } = await supabase
     .from('books')
     .select('id, source_photo_id')
     .in('id', insertedIds);
   const mismatched = (verifyRows ?? []).filter((r: any) => r.source_photo_id !== photoId);
   if (mismatched.length > 0) {
     console.error(`[SCAN_PROCESSOR] books_source_photo_id_invariant`, { jobId, scanId, photoId, expected: photoId, mismatchedCount: mismatched.length, sample: mismatched.slice(0, 5).map((r: any) => ({ id: r.id, source_photo_id: r.source_photo_id })) });
   }
 }
 console.info(`[API_BOOKS_INSERT] table=books (library_books) bookIdsInsertedLength=${bookIdsInserted.length} scanJobId=${rawJobId} photoId=${photoId ?? 'null'} jobId=${jobId} scanId=${scanId}`, {
 table: 'books',
 libraryBooks: true,
 bookIdsInsertedLength: bookIdsInserted.length,
 scanJobId: rawJobId,
 photoId: photoId ?? null,
 jobId,
 bookKeysSample: dbRows.slice(0, 5).map((r: any) => r.book_key),
 });
 // Force-undelete all books for this job (Clear Library leaves deleted_at set; upsert may match those rows without reviving).
 const { error: undeleteErr } = await supabase
   .from('books')
   .update({ deleted_at: null, updated_at: nowIso })
   .eq('source_scan_job_id', rawJobId);
 if (undeleteErr) {
   console.warn(`[SCAN_PROCESSOR] books undelete follow-up (non-fatal):`, undeleteErr.message);
 }
 const keyToId = new Map<string, string>();
 for (const r of resolvedUpserted ?? []) {
 if (r.id && r.book_key) keyToId.set(r.book_key, r.id);
 }

 let enrichmentComplete = 0;
 let enrichmentNotFound = 0;
 let enrichmentFailed = 0;
 const CONCURRENCY = 5;
 const metaDebug = process.env.LOG_LEVEL === 'debug' || process.env.META_DEBUG === '1';
 const updatedBooks: any[] = [];
 for (let i = 0; i < books.length; i += CONCURRENCY) {
 const chunk = books.slice(i, i + CONCURRENCY);
 const chunkResults = await Promise.all(
 chunk.map(async (book: any): Promise<any> => {
 const bookKey = computeBookKey({
 title: book.title,
 author: book.author,
 isbn: book.isbn ?? book.isbn_13 ?? book.isbn13,
 id: undefined,
 });
 const bookId = keyToId.get(bookKey);
 if (!bookId) return null;
 const queryStr = `${String(book.title ?? '').slice(0, 40)} | ${String(book.author ?? '').slice(0, 30)}`;
 try {
 const enriched = await enrichBookWithGoogleBooks(book, scanId, jobId, supabase);
 let description = enriched.description ?? book.description;
 let descriptionSource: string | null = enriched.google_books_id ? 'google_books' : null;
 if (!(typeof description === 'string' && description.trim().length > 0)) {
 const olResult = await fetchDescriptionForBook({
 title: enriched.title ?? book.title,
 author: enriched.author ?? book.author,
 isbn: enriched.isbn ?? book.isbn,
 google_books_id: enriched.google_books_id ?? book.google_books_id,
 });
 if (!('status' in olResult) && olResult.description) {
 description = olResult.description;
 descriptionSource = olResult.source;
 }
 }
 const hasDesc = typeof description === 'string' && description.trim().length > 0;
 const status: 'complete' | 'failed' | 'not_found' = hasDesc ? 'complete' : (descriptionSource ? 'complete' : 'not_found');
 if (status === 'complete') enrichmentComplete++;
 else if (status === 'not_found') enrichmentNotFound++;
 else enrichmentFailed++;

 if (metaDebug) {
 if (hasDesc) {
 console.log(`[META] ok bookId=${bookId} source=${descriptionSource ?? 'google_books'} descLen=${description?.length ?? 0}`);
 } else if (status === 'not_found') {
 console.log(`[META] not_found bookId=${bookId} query="${queryStr.replace(/"/g, '\\"')}"`);
 }
 }

 const updatePayload: any = {
 enrichment_status: status,
 enrichment_updated_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 deleted_at: null, // revive if row was soft-deleted by Clear Library
 };
 if (hasDesc) {
 updatePayload.description = sanitizeTextForDb(description, { recordId: bookId, field: 'description' }) ?? description;
 updatePayload.description_source = descriptionSource ?? 'google_books';
 }
 if (enriched.publisher) updatePayload.publisher = sanitizeTextForDb(enriched.publisher);
 if (enriched.published_date) updatePayload.published_date = enriched.published_date;
 if (enriched.page_count != null) updatePayload.page_count = enriched.page_count;
 if (enriched.categories) updatePayload.categories = enriched.categories;
 if (enriched.isbn) updatePayload.isbn = enriched.isbn;
 if (enriched.google_books_id) updatePayload.google_books_id = enriched.google_books_id;
 await supabase.from('books').update(updatePayload).eq('id', bookId);
 const effective = { ...book, ...enriched, description };
 return effective;
 } catch (e: any) {
 enrichmentFailed++;
 if (metaDebug) {
 console.log(`[META] failed bookId=${bookId} err="${String(e?.message ?? e).slice(0, 120).replace(/"/g, '\\"')}"`);
 }
 await supabase
 .from('books')
 .update({
 enrichment_status: 'failed',
 enrichment_updated_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 deleted_at: null, // revive if row was soft-deleted by Clear Library
 })
 .eq('id', bookId);
 return book;
 }
 })
 );
 updatedBooks.push(...chunkResults.filter((b): b is any => b != null));
 if (i + CONCURRENCY < books.length) await new Promise((r) => setTimeout(r, 150));
 }

 const s = summarizeMeta(updatedBooks);
 console.info(`[meta-enrich-worker] Enriched ${s.withDesc}/${s.total} descriptions (max ${CONCURRENCY} concurrent) failed=${enrichmentFailed} not_found=${enrichmentNotFound} isbn=${s.withIsbn} publisher=${s.withPublisher} publishedDate=${s.withPublishedDate} categories=${s.withCategories} pages=${s.withPageCount}`);
}

/** Extract valid book objects from malformed Gemini JSON by finding balanced { ... } objects */
function trySalvageGeminiArray(raw: string): any[] {
 const books: any[] = [];
 let i = 0;
 while (i < raw.length) {
 const start = raw.indexOf('{', i);
 if (start < 0) break;
 let depth = 0;
 let end = -1;
 let inString = false;
 let escape = false;
 for (let j = start; j < raw.length; j++) {
 const c = raw[j];
 if (escape) {
 escape = false;
 continue;
 }
 if (c === '\\' && inString) {
 escape = true;
 continue;
 }
 if (c === '"') {
 inString = !inString;
 }
 if (inString) continue;
 if (c === '{') depth++;
 else if (c === '}') {
 depth--;
 if (depth === 0) {
 end = j;
 break;
 }
 }
 }
 if (end >= 0) {
 const chunk = raw.slice(start, end + 1);
 try {
 const obj = JSON.parse(chunk);
 if (obj && typeof obj === 'object' && (obj.title || obj.author || obj.spine_text)) {
 if (!obj.title && obj.spine_text) obj.title = obj.spine_text;
 books.push(obj);
 }
 } catch {
 // Skip malformed object
 }
 i = end + 1;
 } else {
 i = start + 1;
 }
 }
 return books;
}

// Google Books API helper functions for server-side enrichment
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
const GOOGLE_BOOKS_BASE_URL = 'https://www.googleapis.com/books/v1';

/**
 * Normalize text for comparison (lowercase, remove special chars, collapse whitespace)
 */
function normalizeText(text: string): string {
 return (text || '')
 .toLowerCase()
 .replace(/[^a-z0-9\s]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

/**
 * Calculate similarity score between two strings (0..1)
 */
function similarityScore(a: string, b: string): number {
 const normA = normalizeText(a);
 const normB = normalizeText(b);
 if (!normA || !normB) return 0;
 if (normA === normB) return 1;
 
 // Token overlap
 const tokensA = new Set(normA.split(' ').filter(Boolean));
 const tokensB = new Set(normB.split(' ').filter(Boolean));
 if (!tokensA.size || !tokensB.size) return 0;
 
 let intersection = 0;
 for (const token of tokensA) {
 if (tokensB.has(token)) intersection++;
 }
 return intersection / Math.max(tokensA.size, tokensB.size);
}

/**
 * Check Google Books cache before making API call
 */
async function checkGoogleBooksCache(
 cacheKey: string,
 supabase: any
): Promise<any | null> {
 try {
 const { data, error } = await supabase
 .from('google_books_cache')
 .select('data, created_at')
 .eq('cache_key', cacheKey)
 .maybeSingle();
 
 if (error || !data) return null;
 
 // Check if cache is still valid (7 days)
 const age = Date.now() - new Date(data.created_at).getTime();
 const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
 if (age > CACHE_TTL_MS) return null;
 
 return data.data;
 } catch (e) {
 return null;
 }
}

/**
 * Save to Google Books cache
 */
async function saveGoogleBooksCache(
 cacheKey: string,
 data: any,
 supabase: any
): Promise<void> {
 try {
 await supabase
 .from('google_books_cache')
 .upsert({
 cache_key: cacheKey,
 data: data,
 created_at: new Date().toISOString()
 }, { onConflict: 'cache_key' });
 } catch (e) {
 // Silently fail - cache is best-effort
 }
}

/**
 * Enrich a book with Google Books API metadata
 * Replaces AI's title/author/ISBN with official ones if found
 * Falls back to original if not found
 * Checks cache first to avoid duplicate API calls
 */
async function enrichBookWithGoogleBooks(
 book: any,
 scanId: string,
 jobId: string,
 supabase: any
): Promise<any> {
 if (!GOOGLE_BOOKS_API_KEY) {
 return book; // Return original if no API key
 }

 const originalTitle = book.title || '';
 const originalAuthor = book.author || '';
 
 if (!originalTitle || originalTitle.length < 2) {
 return book; // Skip enrichment if title is too short
 }

 try {
 // Build search query and cache key
 const cleanTitle = originalTitle.replace(/[^\w\s]/g, ' ').trim();
 const cleanAuthor = originalAuthor.replace(/[^\w\s]/g, ' ').trim();
 const query = cleanAuthor 
 ? `intitle:"${cleanTitle}" inauthor:"${cleanAuthor}"`
 : `intitle:"${cleanTitle}"`;
 
 const cacheKey = `search:${normalizeText(cleanTitle)}|${normalizeText(cleanAuthor)}`;
 
 // Step 1: Check cache first (smart cache check)
 if (supabase) {
 const cachedData = await checkGoogleBooksCache(cacheKey, supabase);
 if (cachedData && cachedData.items && cachedData.items.length > 0) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Cache HIT for "${originalTitle}"`);
 
 // Process cached data same as API response
 const data = cachedData;
 
 // Find best match by scoring title and author similarity
 let bestMatch: any = null;
 let bestScore = 0;

 for (const item of data.items) {
 const volumeInfo = item.volumeInfo || {};
 const matchTitle = volumeInfo.title || '';
 const matchAuthors = volumeInfo.authors || [];
 const matchAuthor = matchAuthors.length > 0 ? matchAuthors[0] : '';
 
 const titleScore = similarityScore(originalTitle, matchTitle);
 const authorScore = originalAuthor && matchAuthor 
 ? similarityScore(originalAuthor, matchAuthor)
 : 0.5;
 
 const combinedScore = (titleScore * 0.7) + (authorScore * 0.3);
 
 if (combinedScore > bestScore && titleScore >= 0.5) {
 bestScore = combinedScore;
 bestMatch = item;
 }
 }

 if (bestMatch && bestScore >= 0.6) {
 const volumeInfo = bestMatch.volumeInfo || {};
 return {
 ...book,
 title: volumeInfo.title || originalTitle,
 author: (volumeInfo.authors && volumeInfo.authors.length > 0) 
 ? volumeInfo.authors[0] 
 : originalAuthor,
 isbn: (volumeInfo.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_13')?.identifier ||
 (volumeInfo.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_10')?.identifier ||
 book.isbn,
 google_books_id: bestMatch.id,
 description: volumeInfo.description || book.description,
 page_count: volumeInfo.pageCount || book.page_count,
 categories: volumeInfo.categories || book.categories,
 publisher: volumeInfo.publisher || book.publisher,
 published_date: volumeInfo.publishedDate || book.published_date,
 language: volumeInfo.language || book.language,
 average_rating: volumeInfo.averageRating || book.average_rating,
 ratings_count: volumeInfo.ratingsCount || book.ratings_count,
 subtitle: volumeInfo.subtitle || book.subtitle,
 print_type: volumeInfo.printType || book.print_type,
 spine_text: book.spine_text,
 spine_index: book.spine_index,
 confidence: book.confidence,
 };
 }
 }
 }

 // Step 2: Cache miss - call Google Books API
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 8000);

 const url = `${GOOGLE_BOOKS_BASE_URL}/volumes?q=${encodeURIComponent(query)}&maxResults=5&key=${GOOGLE_BOOKS_API_KEY}`;
 
 let response: Response;
 try {
 response = await fetch(url, { 
 signal: controller.signal,
 headers: { 'User-Agent': 'BookshelfScanner/1.0' }
 });
 clearTimeout(timeoutId);
 } catch (fetchError: any) {
 clearTimeout(timeoutId);
 if (fetchError.name === 'AbortError') {
 return book;
 }
 throw fetchError;
 }

 if (!response.ok) {
 return book;
 }

 const data = await response.json() as any;
 
 // Step 3: Save to cache for future requests
 if (supabase && data.items && data.items.length > 0) {
 saveGoogleBooksCache(cacheKey, data, supabase).catch(() => {
 // Silently fail - cache is best-effort
 });
 }
 
 if (!data.items || data.items.length === 0) {
 return book;
 }

 // Find best match by scoring title and author similarity
 let bestMatch: any = null;
 let bestScore = 0;

 for (const item of data.items) {
 const volumeInfo = item.volumeInfo || {};
 const matchTitle = volumeInfo.title || '';
 const matchAuthors = volumeInfo.authors || [];
 const matchAuthor = matchAuthors.length > 0 ? matchAuthors[0] : '';
 
 const titleScore = similarityScore(originalTitle, matchTitle);
 const authorScore = originalAuthor && matchAuthor 
 ? similarityScore(originalAuthor, matchAuthor)
 : 0.5;
 
 const combinedScore = (titleScore * 0.7) + (authorScore * 0.3);
 
 if (combinedScore > bestScore && titleScore >= 0.5) {
 bestScore = combinedScore;
 bestMatch = item;
 }
 }

 if (!bestMatch || bestScore < 0.6) {
 return book;
 }

 // Enrich book with official metadata
 const volumeInfo = bestMatch.volumeInfo || {};
 const enrichedBook = {
 ...book,
 title: volumeInfo.title || originalTitle,
 author: (volumeInfo.authors && volumeInfo.authors.length > 0) 
 ? volumeInfo.authors[0] 
 : originalAuthor,
 isbn: (volumeInfo.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_13')?.identifier ||
 (volumeInfo.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_10')?.identifier ||
 book.isbn,
 google_books_id: bestMatch.id,
 description: volumeInfo.description || book.description,
 page_count: volumeInfo.pageCount || book.page_count,
 categories: volumeInfo.categories || book.categories,
 publisher: volumeInfo.publisher || book.publisher,
 published_date: volumeInfo.publishedDate || book.published_date,
 language: volumeInfo.language || book.language,
 average_rating: volumeInfo.averageRating || book.average_rating,
 ratings_count: volumeInfo.ratingsCount || book.ratings_count,
 subtitle: volumeInfo.subtitle || book.subtitle,
 print_type: volumeInfo.printType || book.print_type,
 spine_text: book.spine_text,
 spine_index: book.spine_index,
 confidence: book.confidence,
 };

 return enrichedBook;

 } catch (error: any) {
 return book; // Fall back to original on any error
 }
}

/**
 * Enrich multiple books with Google Books API metadata
 * Uses parallel processing with concurrency limit (5-10) for high-speed enrichment
 * Checks cache first to avoid duplicate API calls
 */
async function enrichBooksWithGoogleBooks(
 books: any[],
 scanId: string,
 jobId: string,
 supabase: any
): Promise<any[]> {
 if (!GOOGLE_BOOKS_API_KEY || books.length === 0) {
 return books;
 }

 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enriching ${books.length} books with Google Books API (parallel, concurrency: 8)...`);
 
 const CONCURRENCY_LIMIT = 8; // Process 8 books in parallel
 const enrichedBooks: any[] = [];
 
 // Process books in chunks with concurrency limit
 for (let i = 0; i < books.length; i += CONCURRENCY_LIMIT) {
 const chunk = books.slice(i, i + CONCURRENCY_LIMIT);
 
 // Process chunk in parallel
 const chunkPromises = chunk.map(book => 
 enrichBookWithGoogleBooks(book, scanId, jobId, supabase)
 );
 
 const chunkResults = await Promise.all(chunkPromises);
 enrichedBooks.push(...chunkResults);
 
 // Small delay between chunks to respect rate limits (only if not last chunk)
 if (i + CONCURRENCY_LIMIT < books.length) {
 await new Promise(resolve => setTimeout(resolve, 200)); // 200ms between chunks
 }
 }

 const enrichedCount = enrichedBooks.filter(b => b.google_books_id).length;
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enrichment complete: ${enrichedCount}/${enrichedBooks.length} books enriched with Google Books metadata`);
 return enrichedBooks;
}

/** Enqueue cover resolution for scan books. Async background job; UI polls for covers. Only enqueue books missing coverUrl. Computes work_key when missing (so raw books can be enqueued before validation). */
function enqueueCoversForScanBooks(books: any[], scanId: string, jobId: string): void {
 log('info', 'COVER_ENQUEUE_INPUT_COUNT', { jobId, scanId, booksCount: books.length });
 const missingCover = books.filter(b => !(b.coverUrl || b.cover_url));
 const items: { workKey: string; isbn?: string; title?: string; author?: string }[] = missingCover
 .map(b => {
 const workKey = (b.work_key || b.workKey || '').trim() || buildWorkKey(b.isbn, b.title, b.author);
 return { workKey, isbn: b.isbn, title: b.title, author: b.author };
 })
 .filter(item => !!item.workKey);
 if (items.length === 0) return;
 const skipped = books.length - missingCover.length;
 enqueueCoverResolve(items, jobId).catch(err =>
 console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Cover enqueue failed:`, err?.message)
 );
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enqueued ${items.length} covers (${skipped} already had coverUrl, skipped)`);
}

/** Resolve covers in worker: batch lookup for hits; upsert pending + enqueue QStash for misses. No blocking.
 * Caller MUST pass books with work_key already set (after normalize dedupe validation). We use that frozen key only.
 * (Used by resolve-covers API; scan job uses enqueueCoversForScanBooks instead to decouple cover resolution.)
 */
async function resolveCoversInWorker(
 books: any[],
 scanId: string,
 jobId: string,
 db: any,
 checkCanceled?: () => Promise<boolean>
): Promise<any[]> {
 const entries: { idx: number; book: any; workKey: string; isbn: string; title: string; author: string }[] = [];
 for (let i = 0; i < books.length; i++) {
 const book = books[i];
 if (book.coverUrl || book.cover_url) continue;
 const title = (book.title || '').trim();
 const author = (book.author || '').trim();
 const isbn = (book.isbn || '').trim();
 const workKey = (book.work_key || book.workKey || '').trim() ||
 buildWorkKey(isbn, title !== (book.spine_text || '').trim() ? title : undefined, author);
 if (!workKey) continue;
 entries.push({ idx: i, book, workKey, isbn, title, author });
 }

 const workKeys = entries.map(e => e.workKey);
 const cacheMap = workKeys.length ? await lookupBatch(db, workKeys) : new Map<string, any>();

 const out: any[] = books.map(b => ({ ...b, coverUrl: b.coverUrl ?? b.cover_url, googleBooksId: b.google_books_id || b.googleBooksId }));
 const misses: typeof entries = [];

 let hitCount = 0;
 let missCount = 0;
 for (const e of entries) {
 const row = cacheMap.get(e.workKey);
 const path = row?.cover_storage_path;
 if (path != null && path !== '') {
 hitCount++;
 console.log(`[COVER] HIT workKey=${e.workKey} path=${path}`);
 const coverUrl = getStoragePublicUrl(path);
 const googleBooksId = row.google_volume_id || e.workKey;
 out[e.idx] = {
 ...e.book,
 work_key: e.workKey,
 coverUrl,
 googleBooksId: googleBooksId || e.book.google_books_id || e.book.googleBooksId,
 google_books_id: googleBooksId || e.book.google_books_id,
 };
 } else {
 missCount++;
 console.log(`[COVER] MISS workKey=${e.workKey} -> downloading`);
 out[e.idx] = { ...e.book, work_key: e.workKey };
 misses.push(e);
 }
 }
 console.log(`[COVER] cache check: total=${entries.length} hit=${hitCount} miss=${missCount}`);

 if (misses.length > 0) {
 // Queue ALL misses for background cover resolution (QStash worker).
 // IMPORTANT: Do NOT resolve covers inline — it causes Vercel function timeout,
 // which prevents the scan job from being marked 'completed'. This left jobs stuck
 // in 'processing' forever, causing the client to never receive scan results.
 // The client-side backfill at 12s and the background worker handle covers.
 for (const e of misses) {
   await upsertPending(db, e.workKey, e.isbn, e.title, e.author);
 }
 const items = misses.map(e => ({
   workKey: e.workKey,
   isbn: e.isbn,
   title: e.title,
   author: e.author,
 }));
 enqueueCoverResolve(items).catch(err =>
   console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Cover enqueue failed:`, err?.message)
 );
 }

 // Ensure every book has work_key (including those we couldn't look up)
 for (let i = 0; i < out.length; i++) {
 if (out[i].work_key === undefined) {
 const wk = buildWorkKey(out[i].isbn, out[i].title, out[i].author);
 out[i] = { ...out[i], work_key: wk || '' };
 }
 }

 const resolved = out.filter(b => b.coverUrl).length;
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Cover resolution complete: ${resolved}/${books.length} books have coverUrl`);
 console.info('[COVER_SUMMARY]', {
 jobId,
 total: out.length,
 withCover: resolved,
 missingCover: out.length - resolved,
 });
 return out;
}

// Basic helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Log level system
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logLevels: Record<string, number> = {
 error: 0,
 warn: 1,
 info: 2,
 debug: 3,
};

function log(level: keyof typeof logLevels, ...args: any[]) {
 const currentLevel = logLevels[LOG_LEVEL] ?? logLevels.info;
 if (logLevels[level] <= currentLevel) {
 console.log(`[${level.toUpperCase()}]`, ...args);
 }
}

// Gemini rate limiter: GLOBAL queue with single-flight execution
// HARD RULE: Only ONE Gemini request at a time, globally
// This prevents burst RPM limits (Gemini 3 Pro = 25 RPM, but burst tolerance is lower)

interface GeminiQueueItem {
 imageDataURL: string;
 resolve: (value: any[]) => void;
 reject: (error: any) => void;
 retryCount: number;
 timestamp: number;
 scanId?: string; // Add scanId to queue items
}

let geminiQueue: GeminiQueueItem[] = [];
let geminiProcessing = false;
let lastGeminiRequestTime = 0;
// Target 20 RPM (safely under Gemini 3 Pro's 25 RPM limit)
const MIN_GEMINI_INTERVAL_MS = 3000; // 3 seconds minimum between requests = 20 RPM max
const MAX_GEMINI_RETRIES = 2; // Max retries (but with proper delays, not immediate)
let geminiModelVerified = false; // Track if we've verified the model exists

// Track finalized scans to prevent late results from updating state
const finalizedScans = new Set<string>();

/**
 * Process Gemini queue - ensures single-flight execution
 * Only ONE Gemini request runs at a time, globally
 */
async function processGeminiQueue(): Promise<void> {
 // If already processing or queue is empty, return
 if (geminiProcessing || geminiQueue.length === 0) {
 return;
 }
 
 geminiProcessing = true;
 
 while (geminiQueue.length > 0) {
 const item = geminiQueue.shift()!;
 const now = Date.now();
 
 // Enforce minimum interval between requests
 const timeSinceLastRequest = now - lastGeminiRequestTime;
 if (timeSinceLastRequest < MIN_GEMINI_INTERVAL_MS) {
 const waitTime = MIN_GEMINI_INTERVAL_MS - timeSinceLastRequest;
 console.log(`[API] Gemini queue: waiting ${Math.ceil(waitTime/1000)}s before next request (enforcing ${MIN_GEMINI_INTERVAL_MS}ms interval, ${geminiQueue.length} in queue)...`);
 await delay(waitTime);
 }
 
 const logPrefix = item.scanId ? `[SCAN ${item.scanId}]` : '[API]';
 
 // CRITICAL: Check if quota exceeded - don't even try, resolve empty immediately
 if (isGeminiQuotaExceeded()) {
 console.log(`${logPrefix} Gemini quota exceeded - skipping request, returning empty (will use OpenAI)`);
 item.resolve([]);
 continue; // Skip to next item
 }
 
 try {
 console.log(`${logPrefix} Gemini queue: processing request (${geminiQueue.length} remaining, retry ${item.retryCount})...`);
 lastGeminiRequestTime = Date.now();
 
 const result = await scanWithGeminiDirect(item.imageDataURL, item.scanId);
 item.resolve(result.books); // Extract books array for queue compatibility
 } catch (error: any) {
 // CRITICAL: If quota error, don't retry - resolve empty immediately
 if (error?.isQuotaError || (error?.status === 429 && error?.message?.toLowerCase().includes('quota'))) {
 console.error(`${logPrefix} Gemini quota error - not retrying, returning empty (will use OpenAI)`);
 item.resolve([]); // Return empty, will fallback to OpenAI
 continue; // Skip to next item
 }
 
 // Handle 429 errors (rate limit, not quota) - re-queue with delay
 if (error?.status === 429 || error?.message?.includes('429') || error?.statusCode === 429) {
 if (item.retryCount < MAX_GEMINI_RETRIES) {
 // Use Retry-After header if provided, otherwise use longer backoff (30s/90s)
 let retryDelay: number;
 if (error?.retryAfter && typeof error.retryAfter === 'number') {
 retryDelay = error.retryAfter * 1000; // Convert seconds to ms
 console.log(`[API] Gemini 429: Using Retry-After header: ${error.retryAfter}s`);
 } else {
 // Longer backoff: 30s, 90s (more conservative)
 retryDelay = item.retryCount === 0 ? 30000 : 90000; // 30s first retry, 90s second
 const jitter = Math.random() * 5000; // 0-5s random
 retryDelay += jitter;
 }
 
 console.log(`[API] Gemini 429: re-queuing with ${Math.ceil(retryDelay/1000)}s delay (retry ${item.retryCount + 1}/${MAX_GEMINI_RETRIES})...`);
 
 // Add back to queue with delay
 setTimeout(() => {
 geminiQueue.push({
 ...item,
 retryCount: item.retryCount + 1,
 timestamp: Date.now(),
 });
 processGeminiQueue(); // Process queue again
 }, retryDelay);
 } else {
 console.error(`[API] Gemini failed after ${MAX_GEMINI_RETRIES} retries, returning empty array`);
 item.resolve([]); // Return empty instead of failing
 }
 } else {
 // Non-429 error - fail immediately
 console.error(`[API] Gemini non-429 error:`, error?.message || error);
 item.resolve([]); // Return empty on other errors too
 }
 }
 }
 
 geminiProcessing = false;
}

/**
 * Queue a Gemini request (single-flight execution)
 */
function queueGeminiRequest(imageDataURL: string, retryCount = 0, scanId?: string): Promise<any[]> {
 return new Promise((resolve, reject) => {
 geminiQueue.push({
 imageDataURL,
 resolve,
 reject,
 retryCount,
 timestamp: Date.now(),
 scanId,
 });
 
 // Start processing if not already running
 processGeminiQueue();
 });
}

/**
 * List available Gemini models - verifies model availability and quota surface
 */
async function listGeminiModels(): Promise<{ success: boolean; models?: string[]; endpoint?: string; error?: string }> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) {
 return { success: false, error: 'No API key' };
 }
 
 const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
 
 try {
 const res = await fetch(`${endpoint}?key=${key}`);
 if (!res.ok) {
 const errorText = await res.text();
 return {
 success: false,
 endpoint: 'generativelanguage.googleapis.com',
 error: `Status ${res.status}: ${errorText.slice(0, 200)}`,
 };
 }
 
 const data = await res.json() as { models?: Array<{ name: string }> };
 const models = data.models?.map(m => m.name.replace('models/', '')) || [];
 
 return {
 success: true,
 models,
 endpoint: 'generativelanguage.googleapis.com',
 };
 } catch (error: any) {
 return {
 success: false,
 endpoint: 'generativelanguage.googleapis.com',
 error: error?.message || String(error),
 };
 }
}

/**
 * Health check for Gemini API - confirms endpoint and quota surface
 */
async function pingGeminiAPI(model: string): Promise<{ success: boolean; endpoint?: string; model?: string; error?: string }> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) {
 return { success: false, error: 'No API key' };
 }
 
 // Verify URL format: POST /v1beta/models/<model>:generateContent
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 
 try {
 const res = await fetch(`${endpoint}?key=${key}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [{ parts: [{ text: 'ping' }] }],
 }),
 });
 
 const errorText = res.ok ? undefined : await res.text();
 
 return {
 success: res.ok,
 endpoint: 'generativelanguage.googleapis.com',
 model,
 error: res.ok ? undefined : `Status ${res.status}: ${errorText?.slice(0, 200) || 'Unknown error'}`,
 };
 } catch (error: any) {
 return {
 success: false,
 endpoint: 'generativelanguage.googleapis.com',
 model,
 error: error?.message || String(error),
 };
 }
}

/**
 * Direct Gemini API call (no queue, used by queue processor)
 * Now includes retry logic for 503 and 429 errors
 */
interface GeminiScanResult {
 books: any[];
 usedRepair: boolean;
 rawLength: number;
 needsOpenAI?: boolean; // Optional flag for quality gate failures
}

/** Per-scan metrics: model calls, tile count/bytes, providers, runtime. Log with [SCAN_METRICS] for certainty. */
export interface ScanMetrics {
 startTime: number;
 geminiCalls: number;
 openaiCalls: number;
 tileCount: number;
 tileBytes: number[];
 providers: Set<string>;
}

function logScanMetrics(scanId: string, jobId: string, metrics: ScanMetrics, booksFound: number): void {
 const totalRuntimeMs = Date.now() - metrics.startTime;
 const modelCalls = metrics.geminiCalls + metrics.openaiCalls;
 const providers = Array.from(metrics.providers).sort().join(',') || 'none';
 const bytesPerTile =
 metrics.tileBytes.length === 0
 ? null
 : {
 min: Math.min(...metrics.tileBytes),
 max: Math.max(...metrics.tileBytes),
 avg: Math.round(metrics.tileBytes.reduce((a, b) => a + b, 0) / metrics.tileBytes.length),
 count: metrics.tileBytes.length,
 };
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] [SCAN_METRICS]`, {
 model_calls: modelCalls,
 gemini_calls: metrics.geminiCalls,
 openai_calls: metrics.openaiCalls,
 tile_count: metrics.tileCount,
 bytes_per_tile: bytesPerTile,
 provider_used: providers,
 total_runtime_ms: totalRuntimeMs,
 total_runtime_sec: (totalRuntimeMs / 1000).toFixed(1),
 books_found: booksFound,
 cost_note: 'See provider dashboard for cost (Gemini/OpenAI usage).',
 });
}

async function scanWithGeminiDirect(
 imageDataURL: string,
 scanId?: string,
 signal?: AbortSignal,
 scanMetrics?: ScanMetrics
): Promise<GeminiScanResult> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) return { books: [], usedRepair: false, rawLength: 0 };
 
 const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
 
 // Use valid model name - gemini-3-flash-preview (as per Google docs)
 // Verify model exists via ListModels call on startup
 const model = 'gemini-3-flash-preview'; // Valid model for generateContent
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 
 console.log(`${logPrefix} Gemini request: endpoint=generativelanguage.googleapis.com, model=${model}, client=vanilla-fetch, URL=POST /v1beta/models/${model}:generateContent`);
 
 const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
 
 // Log image payload being sent to Gemini
 const imageBytesLengthSentToGemini = base64Data.length;
 const imageMimeSentToGemini = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
 console.log(`${logPrefix} Sending to Gemini: imageBytes=${imageBytesLengthSentToGemini}, mime=${imageMimeSentToGemini}, scanId=${scanId || 'none'}`);
 
 if (scanMetrics) {
 scanMetrics.geminiCalls += 1;
 scanMetrics.providers.add('gemini');
 }

 // Wrap fetch in retry logic for 503 and 429
 try {
 const result = await retryWithBackoff(async () => {
 const res = await fetch(
 `${endpoint}?key=${key}`,
 {
 ...(signal ? { signal } : {}),
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [
 {
 parts: [
 {
 text: `Scan book spines in this image. Extract all visible books and return a JSON array of objects.

CRITICAL RULES:
- Do not translate any text. Output the title exactly as seen on the spine.
- AUTHOR: Use the author's FULL NAME (first and last). If the spine only shows a last name (e.g. "BALZAC"), use your knowledge to provide the full name (e.g. "Honoré de Balzac"). Always prefer the complete, commonly known form of the author's name.
- TITLE is the book name (usually larger text on spine). AUTHOR is the person's name (usually smaller text). Do NOT swap them.
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE.
- Number books left-to-right: spine_index 0, 1, 2, etc.
- For spine_text: use short normalized text only; escape any quotes as \\" and newlines as \\n. If the raw text would break JSON, omit spine_text or set to null.
- Detect language only from spine_text (en, es, fr, or unknown). Do not invent language.
- If unclear, set confidence: low and leave unknown fields null. Prefer returning fewer books over guessing.

OUTPUT RULES (strict):
- Return ONLY a JSON array. No markdown, no code blocks, no commentary.
- All string values must be JSON-escaped (quotes as \\", newlines as \\n).
- Each element: {"title":"...","author":"...","confidence":"high|medium|low","spine_text":"...","language":"en|es|fr|unknown","reason":"...","spine_index":0}`,
 },
 { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
 ],
 },
 ],
 generationConfig: { 
 responseMimeType: "application/json",
 responseJsonSchema: getScanResultJsonSchema(),
 temperature: 0.1,
 maxOutputTokens: 20000,
 },
 }),
 }
 );
 
 // Check for Retry-After header
 const retryAfter = res.headers.get('Retry-After');
 const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
 
 // Handle 429 errors FIRST - check if it's quota/billing (most serious)
 if (res.status === 429) {
 const errorText = await res.text();
 let errorData: any = null;
 try {
 errorData = errorText ? JSON.parse(errorText) : null;
 } catch (e) {
 // Error text is not JSON, that's fine
 }
 const errorMessage = (errorData?.error?.message || errorText || '').toLowerCase();
 
 // CRITICAL: Detect quota/billing errors - don't retry, fallback immediately
 if (errorMessage.includes('quota') || errorMessage.includes('billing') || errorMessage.includes('exceeded')) {
 if (scanId) {
 // Set long cooldown (30-60 minutes) for quota errors
 const cooldownMinutes = errorMessage.includes('daily') ? 60 : 30;
 recordGeminiQuotaError(scanId, cooldownMinutes);
 }
 
 const error: any = new Error(`Gemini 429 QUOTA EXCEEDED: ${errorData?.error?.message || errorText}`);
 error.status = 429;
 error.statusCode = 429;
 error.isQuotaError = true; // Mark as quota error - don't retry
 throw error;
 }
 
 // Regular 429 (rate limit) - can retry
 console.error(`${logPrefix} Gemini 429 Rate Limit:`, {
 endpoint: 'generativelanguage.googleapis.com',
 model,
 retryAfter: retryAfterSeconds ? `${retryAfterSeconds}s` : 'not provided',
 errorMessage: errorData?.error?.message?.slice(0, 200) || '',
 quotaSurface: 'Gemini API (AI Studio)',
 clientLibrary: 'vanilla-fetch',
 });
 
 const error: any = new Error(`Gemini 429: ${errorData?.error?.message || errorText}`);
 error.status = 429;
 error.statusCode = 429;
 error.retryAfter = retryAfterSeconds; // Include Retry-After for queue handler
 error.isQuotaError = false; // Regular rate limit, can retry
 throw error;
 }
 
 // Handle 503 (model overloaded) - record for circuit breaker
 if (res.status === 503) {
 if (scanId) recordGemini503(scanId);
 const errorText = await res.text();
 let errorData: any = null;
 try {
 errorData = errorText ? JSON.parse(errorText) : null;
 } catch (e) {
 // Error text is not JSON, that's fine
 }
 const errorMessage = errorData?.error?.message || '';
 
 const error: any = new Error(`Gemini 503: ${errorMessage}`);
 error.status = 503;
 error.statusCode = 503;
 error.retryAfter = retryAfterSeconds;
 throw error;
 }
 
 if (!res.ok) {
 const errorText = await res.text();
 let errorData: any = null;
 try {
 errorData = errorText ? JSON.parse(errorText) : null;
 } catch (e) {
 // Error text is not JSON, that's fine
 }
 const errorMessage = errorData?.error?.message || errorText || '';
 console.error(`${logPrefix} Gemini scan failed: ${res.status} ${res.statusText} - ${errorMessage.slice(0, 200)}`);
 return [];
 }
 
 // Success - record for circuit breaker
 if (scanId) recordGeminiSuccess(scanId);
 
 // Parse response
 const data = await res.json() as any;
 return data;
 }, 2, scanId || 'unknown', false);
 
 // Parse response from result
 const data = result;
 const rawGeminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
 
 if (!rawGeminiText) {
 console.error(`${logPrefix} Gemini returned empty content`);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
 
 // Structured output: parse and validate (schema uses array-at-root)
 try {
 const parsed = JSON.parse(rawGeminiText);
 const arr = Array.isArray(parsed) ? parsed : parsed?.books ?? [];
 const books = ScanResultSchema.parse(arr);
 console.log(`${logPrefix} Gemini parsed ${books.length} books (structured output)`);
 return { books, usedRepair: false, rawLength: rawGeminiText.length };
 } catch (parseError) {
 // Truncation heuristic: if response doesn't end with ] or }, skip salvage and go straight to repair
 const trimmed = rawGeminiText.trim();
 const likelyTruncated = trimmed.length > 0 && !trimmed.endsWith(']') && !trimmed.endsWith('}');
 if (!likelyTruncated) {
 const salvaged = trySalvageGeminiArray(rawGeminiText);
 if (salvaged.length > 0) {
 console.log(`${logPrefix} Gemini parsed ${salvaged.length} books (salvaged from malformed JSON)`);
 return { books: salvaged, usedRepair: true, rawLength: rawGeminiText.length };
 }
 } else {
 console.log(`${logPrefix} Gemini output likely truncated (no closing ]/}), trying repair`);
 }
 // Repair step: send raw Gemini text to LLM to fix into valid JSON (very effective for unterminated strings)
 const BOOK_ARRAY_SCHEMA = 'array of book objects with title (string), author (string or null), confidence (high|medium|low), spine_text (string or null), language (en|es|fr|unknown), reason (string or null), spine_index (number)';
 const repaired = await repairJSON(rawGeminiText, BOOK_ARRAY_SCHEMA);
 if (repaired && Array.isArray(repaired)) {
 try {
 const books = ScanResultSchema.parse(repaired);
 console.log(`${logPrefix} Gemini parsed ${books.length} books (repaired from invalid JSON)`);
 return { books, usedRepair: true, rawLength: rawGeminiText.length };
 } catch (_) {
 // Schema validation failed on repaired array; fall through to empty
 }
 }
 const errMsg = (parseError as any)?.issues?.[0]?.message || (parseError as Error)?.message;
 console.warn(`${logPrefix} Gemini parse/schema failed:`, String(errMsg).slice(0, 120));
 return { books: [], usedRepair: false, rawLength: rawGeminiText.length };
 }
 } catch (error: any) {
 // If retries exhausted, return empty array (fallback to OpenAI)
 if (error?.status === 503 || error?.status === 429) {
 console.error(`${logPrefix} Gemini failed after retries (${error.status}), falling back to OpenAI`);
 }
 return { books: [], usedRepair: false, rawLength: 0 };
 }
}

/**
 * Retry Gemini with stricter prompt for reliability
 */
async function scanWithGeminiStrict(
 imageDataURL: string,
 scanId?: string,
 scanMetrics?: ScanMetrics
): Promise<GeminiScanResult> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) return { books: [], usedRepair: false, rawLength: 0 };
 
 const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
 const model = 'gemini-3-flash-preview';
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
 
 if (scanMetrics) {
 scanMetrics.geminiCalls += 1;
 scanMetrics.providers.add('gemini');
 }

 try {
 const res = await fetch(`${endpoint}?key=${key}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [
 {
 parts: [
 {
 text: `Scan book spines. Return a JSON array of book objects.

RULES: Do not translate. Output title/author exactly as seen. TITLE=book name, AUTHOR=person name. Do NOT swap. spine_index 0,1,2... left-to-right. Escape strings for JSON. Detect language from spine_text only. If unclear, set confidence: low and leave fields null. Prefer fewer books over guessing.

Return ONLY a JSON array. No markdown. No commentary.`,
 },
 { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
 ],
 },
 ],
 generationConfig: { 
 responseMimeType: "application/json",
 responseJsonSchema: getScanResultJsonSchema(),
 temperature: 0.1,
 maxOutputTokens: 20000,
 },
 }),
 });
 
 if (!res.ok) {
 console.error(`${logPrefix} Gemini strict retry failed: ${res.status}`);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
 
 const data = await res.json() as any;
 const rawGeminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
 
 if (!rawGeminiText) return { books: [], usedRepair: false, rawLength: 0 };
 
 const parsed = JSON.parse(rawGeminiText);
 const books = ScanResultSchema.parse(Array.isArray(parsed) ? parsed : parsed?.books ?? []);
 return { books, usedRepair: false, rawLength: rawGeminiText.length };
 } catch (error: any) {
 const errMsg = (error as any)?.issues?.[0]?.message || (error as Error)?.message;
 console.error(`${logPrefix} Gemini strict retry exception:`, String(errMsg).slice(0, 120));
 return { books: [], usedRepair: false, rawLength: 0 };
 }
}

/**
 * Dedupe key: prefer ISBN; else require both title and author (never title-only or one-word title alone).
 * Bad keys (too aggressive): title-only, one-word normalized title we avoid both by requiring author.
 */
function dedupeKey(title: string, author?: string, isbn?: string): string {
 const cleanIsbn = (isbn || '').replace(/\D/g, '');
 if (cleanIsbn.length >= 10) return `isbn:${cleanIsbn}`;
 const t = normalizeText(title || '');
 const a = author ? normalizeText(author) : '';
 if (!t || !a) return ''; // require both; never use title-only
 return `ta:${t}|${a}`;
}

/** Confidence score for merge: high=3, medium=2, low=1 */
function confidenceScore(c?: string): number {
 if (!c) return 1;
 if (c === 'high') return 3;
 if (c === 'medium') return 2;
 return 1;
}

/** Infer quality when model omits it (backward compatibility). */
function inferTileQuality(b: any): string {
 const q = (b?.quality ?? '').trim().toLowerCase();
 if (q === TILE_QUALITY_CONFIRMED || q === TILE_QUALITY_PARTIAL_TITLE || q === TILE_QUALITY_PARTIAL_AUTHOR || q === TILE_QUALITY_GARBAGE) return q;
 const hasTitle = !!(b?.title && String(b.title).trim());
 const hasAuthor = !!(b?.author && String(b.author).trim());
 if (hasTitle && hasAuthor) return TILE_QUALITY_CONFIRMED;
 if (hasAuthor) return TILE_QUALITY_PARTIAL_TITLE;
 if (hasTitle) return TILE_QUALITY_PARTIAL_AUTHOR;
 return TILE_QUALITY_GARBAGE;
}

/** Filter tile books deterministically: drop only garbage. Keep confirmed and partial_*. */
function filterTileBooksByQuality(books: any[]): any[] {
 return books.filter(b => {
 const quality = inferTileQuality(b);
 (b as any).quality = quality;
 return quality !== TILE_QUALITY_GARBAGE;
 });
}

/** Parse NDJSON from tile response - one JSON object per line, resilient to truncation */
function parseNdjsonTileResponse(raw: string): any[] {
 const books: any[] = [];
 const lines = raw.split('\n');
 for (const line of lines) {
 const trimmed = line.trim();
 if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
 try {
 const obj = JSON.parse(trimmed);
 if (obj && typeof obj === 'object' && (obj.title || obj.author || obj.spine_text)) {
 books.push(obj);
 }
 } catch {
 // Skip malformed lines
 }
 }
 return books;
}

/** Fallback: parse numbered list or "TITLE AUTHOR" style when NDJSON yields 0 */
function parseNumberedListTileResponse(raw: string): any[] {
 const books: any[] = [];
 const lines = raw.split('\n');

 const stripNumbering = (s: string) => s.replace(/^\s*\d+[\.:\)]\s*/, '').trim();
 const inferTitleAuthor = (text: string): { title: string; author: string } => {
 const t = text.trim();
 const byMatch = t.match(/^(.+?)\s+by\s+(.+)$/i);
 if (byMatch) return { title: byMatch[1].trim(), author: byMatch[2].trim() };
 const dashMatch = t.match(/^(.+?)\s+[-]\s+(.+)$/);
 if (dashMatch) return { title: dashMatch[1].trim(), author: dashMatch[2].trim() };
 const slashMatch = t.match(/^(.+?)\s+\/\s+(.+)$/);
 if (slashMatch) return { title: slashMatch[1].trim(), author: slashMatch[2].trim() };
 const parenMatch = t.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
 if (parenMatch) return { title: parenMatch[1].trim(), author: parenMatch[2].trim() };
 const parts = t.split(/\s{2,}|\t/);
 if (parts.length >= 2) {
 const tit = parts[0].trim();
 const aut = parts.slice(1).join(' ').trim();
 if (tit && aut) return { title: tit, author: aut };
 }
 const tokens = t.split(/\s+/);
 const isNameLike = (s: string) => /^[A-Z][a-z]+/.test(s) && !/^(The|A|An|And|Or|Of|In|On|At)$/i.test(s);
 if (tokens.length >= 3 && isNameLike(tokens[tokens.length - 1]) && isNameLike(tokens[tokens.length - 2])) {
 return { title: tokens.slice(0, -2).join(' '), author: tokens.slice(-2).join(' ') };
 }
 if (tokens.length >= 2 && isNameLike(tokens[tokens.length - 1])) {
 return { title: tokens.slice(0, -1).join(' '), author: tokens[tokens.length - 1] };
 }
 return { title: t, author: '' };
 };

 for (let i = 0; i < lines.length; i++) {
 let line = lines[i].trim();
 if (!line || line.length < 3) continue;
 if (line.startsWith('{')) continue; // Skip JSON-like

 line = stripNumbering(line);

 let content = '';
 const quotedWithBy = line.match(/^"([^"]+)"\s+by\s+(.+)$/i);
 if (quotedWithBy) {
 content = `"${quotedWithBy[1]}" by ${quotedWithBy[2]}`;
 } else {
 const quotedWithDash = line.match(/^"([^"]+)"\s*[-]\s*(.+)$/);
 if (quotedWithDash) {
 content = `"${quotedWithDash[1]}" - ${quotedWithDash[2]}`;
 } else {
 const quotedOnly = line.match(/^"([^"]+)"\s*$/);
 content = quotedOnly ? quotedOnly[1] : line;
 }
 }

 if (!content || content.length < 2) continue;

 const { title: t, author: a } = inferTitleAuthor(content);
 if (!t) continue;
 books.push({
 title: t || content,
 author: a || null,
 spine_text: content,
 confidence: a ? 'medium' : 'low',
 spine_index_in_tile: i,
 });
 }
 return books;
}

const TILE_MIN_BOOKS_DENSE = 4;
const TILE_DENSE_LINE_THRESHOLD = 5; // Raw has many lines -> expect multiple books

/** Validate tile output: must have books (NDJSON or salvage) and reasonable count for dense tiles */
function validateTileOutput(raw: string, books: any[]): { valid: boolean; reason?: string } {
 const trimmed = raw.trim();
 if (!trimmed) return { valid: true }; // Empty is handled elsewhere
 if (books.length === 0) {
 return { valid: false, reason: !raw.includes('{') ? 'no NDJSON (no { in response)' : 'parsed 0 books from non-empty response' };
 }
 const lineCount = trimmed.split('\n').filter(l => l.trim().length > 0).length;
 if (lineCount >= TILE_DENSE_LINE_THRESHOLD && books.length < TILE_MIN_BOOKS_DENSE) {
 return { valid: false, reason: `dense tile: ${lineCount} lines but only ${books.length} books parsed` };
 }
 return { valid: true };
}

/** Quality labels for tile output. Filter deterministically: keep confirmed + partial_*, drop garbage. */
const TILE_QUALITY_CONFIRMED = 'confirmed'; // title + author both present
const TILE_QUALITY_PARTIAL_TITLE = 'partial_title'; // author present, title missing/partial
const TILE_QUALITY_PARTIAL_AUTHOR = 'partial_author'; // title present, author missing/partial
const TILE_QUALITY_GARBAGE = 'garbage'; // not a real book spine

const TILE_PROMPT_INITIAL = `Extract ONLY the book spines visible in THIS crop. This is a partial region of a larger shelf image.

- Partial spines are OK. Return your best guess for any spine you can see (even if cut off).
- TITLE = book name (usually larger text), AUTHOR = person who wrote it (usually smaller).
- Output newline-delimited JSON (NDJSON). No surrounding array. One book per line. No trailing commentary.
- Each line MUST include "quality": one of "confirmed" | "partial_title" | "partial_author" | "garbage".
 - "confirmed": you have both title and author (real book).
 - "partial_title": you have author but title is missing or unclear.
 - "partial_author": you have title but author is missing or unclear.
 - "garbage": not a real book spine (reflection, binding, random text).
- Schema: {"title":"...", "author":"...", "spine_text":"...", "confidence":"high|medium|low", "quality":"confirmed|partial_title|partial_author|garbage", "spine_index_in_tile":0}
- spine_index_in_tile: 0, 1, 2... left-to-right within this crop only.`;

const TILE_PROMPT_RETRY = `Extract ONLY the book spines visible in THIS crop. This is a partial region of a larger shelf image.

CRITICAL - You MUST output NDJSON. No numbering. No quotes-only lines. No markdown. No prose.
- Each line MUST be a JSON object with keys: title, author, spine_text, confidence, quality.
- quality MUST be one of: "confirmed" (title+author), "partial_title" (author only), "partial_author" (title only), "garbage" (not a book).
- If unsure about a spine, still output JSON with null for unknown fields and set quality accordingly.
- One book per line. No array wrapper. No trailing text.
- Example: {"title":"The Great Gatsby","author":"F. Scott Fitzgerald","spine_text":"...","confidence":"high","quality":"confirmed","spine_index_in_tile":0}`;

/**
 * Tile-based fallback: split image into 8 vertical strips (thin slices, OCR-style),
 * run Gemini on each (concurrency 2), merge + dedupe by normalized title|author|spine_text.
 * Fewer spines per strip less truncation cleaner outputs.
 */
async function scanWithGeminiTiles(
 imageBuffer: Buffer,
 scanId?: string,
 checkCanceled?: () => Promise<boolean>,
 scanMetrics?: ScanMetrics
): Promise<GeminiScanResult> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) return { books: [], usedRepair: false, rawLength: 0 };

 const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
 const model = 'gemini-3-flash-preview';
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

 // Wider tiles (600800px) with 2535% overlap reduce boundary splits and improve recall
 const TILE_WIDTH_PX = 800;
 const TILE_OVERLAP_PX = 240; // ~30% of 800
 const TILE_STEP_X_PX = TILE_WIDTH_PX - TILE_OVERLAP_PX; // 560
 // Higher-res, sharper tiles: avoid over-compression so tiny spine text stays readable
 const TILE_MAX_LONGEST_SIDE = 2200;
 const TILE_WEBP_QUALITY = 0.85;

 try {
 const verticalTiles = await splitImageIntoTiles(imageBuffer, {
 rows: 1,
 tileWidth: TILE_WIDTH_PX,
 stepX: TILE_STEP_X_PX,
 maxLongestSide: TILE_MAX_LONGEST_SIDE,
 webpQuality: TILE_WEBP_QUALITY,
 });
 const horizontalBands = await splitImageIntoHorizontalBands(imageBuffer, {
 bands: 3,
 overlapPct: 0.15,
 maxLongestSide: TILE_MAX_LONGEST_SIDE,
 webpQuality: TILE_WEBP_QUALITY,
 });
 const horizontalTilesWithIndex = horizontalBands.map((t, i) => ({ ...t, tileIndex: verticalTiles.length + i }));
 const tiles = [...verticalTiles, ...horizontalTilesWithIndex];
 if (scanMetrics) {
 scanMetrics.tileCount = tiles.length;
 scanMetrics.tileBytes.push(...tiles.map(t => t.buffer.length));
 }
 console.log(`${logPrefix} [TILES] vertical=${verticalTiles.length} horizontal=${horizontalBands.length} total=${tiles.length} tileOverlapPx=${TILE_OVERLAP_PX}`, tiles.slice(0, 5).map(t => ({ tileIndex: t.tileIndex, bytes: t.buffer.length, region: t.region })));

 const TILE_TIMEOUT_MS = 30000;
 const TILE_MAX_TOKENS = 4096;
 const CONCURRENCY = 2;

 const runTile = async (tile: { buffer: Buffer; tileIndex: number; mimeType?: string }, useRetryPrompt = false): Promise<any[]> => {
 if (scanMetrics) {
 scanMetrics.geminiCalls += 1;
 scanMetrics.providers.add('gemini');
 }
 const promptVersion = useRetryPrompt ? 'retry' : 'initial';
 const base64 = tile.buffer.toString('base64');
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
 const prompt = useRetryPrompt ? TILE_PROMPT_RETRY : TILE_PROMPT_INITIAL;

 const res = await fetch(`${endpoint}?key=${key}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 signal: controller.signal,
 body: JSON.stringify({
 contents: [
 {
 parts: [
 { text: prompt },
 { inline_data: { mime_type: tile.mimeType || 'image/webp', data: base64 } },
 ],
 },
 ],
 generationConfig: {
 temperature: 0,
 maxOutputTokens: TILE_MAX_TOKENS,
 },
 }),
 });
 clearTimeout(timeoutId);

 if (!res.ok) {
 console.warn(`${logPrefix} [TILES] tile ${tile.tileIndex} failed: ${res.status}`);
 return [];
 }

 const data = await res.json() as any;
 const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
 if (!raw) {
 console.warn(`${logPrefix} [TILES] tile ${tile.tileIndex} returned empty response`);
 return [];
 }

 let books = parseNdjsonTileResponse(raw);
 let parseMode: 'ndjson' | 'salvage' = 'ndjson';
 if (books.length === 0 && raw.trim().length > 0) {
 const salvaged = parseNumberedListTileResponse(raw);
 if (salvaged.length > 0) {
 books = salvaged;
 parseMode = 'salvage';
 console.log(`${logPrefix} [TILES] tile ${tile.tileIndex} NDJSON yielded 0, salvage parser recovered ${books.length} books`);
 }
 }
 console.log(`${logPrefix} [TILES] tile ${tile.tileIndex} tilePromptVersion=${promptVersion} parse_mode=${parseMode} books=${books.length}`);
 const validation = validateTileOutput(raw, books);

 if (!validation.valid) {
 if (!useRetryPrompt) {
 console.warn(`${logPrefix} [TILES] tile ${tile.tileIndex} validation failed (${validation.reason}), retrying with stricter prompt`);
 return runTile(tile, true);
 }
 console.warn(`${logPrefix} [TILES] tile ${tile.tileIndex} still invalid after retry: ${validation.reason}, raw preview:`, raw.slice(0, 200));
 return [];
 }

 // Deterministic filter: drop garbage only; keep confirmed and partial_*
 books = filterTileBooksByQuality(books);

 return books.map((b: any) => ({
 ...b,
 title: b.title || b.spine_text || 'Unknown',
 tile_index: tile.tileIndex
 }));
 };

 const allBooks: any[] = [];
 for (let i = 0; i < tiles.length; i += CONCURRENCY) {
 if (checkCanceled && (await checkCanceled())) {
 console.log(`${logPrefix} [TILES] Canceled before tile batch ${i / CONCURRENCY + 1}, returning ${allBooks.length} books so far`);
 break;
 }
 const batch = tiles.slice(i, i + CONCURRENCY);
 const batchIndices = batch.map(t => t.tileIndex).join('+');
 console.log(`${logPrefix} [TILES] running tiles ${batchIndices} in parallel`);
 const results = await Promise.all(batch.map(t => runTile(t)));
 for (let j = 0; j < batch.length; j++) {
 const tileBooks = results[j] || [];
 console.log(`${logPrefix} [TILES] tile ${batch[j].tileIndex} returned ${tileBooks.length} books`);
 allBooks.push(...tileBooks);
 }
 }

 console.log(`${logPrefix} [TILES] merge: ${allBooks.length} raw books from tiles [${tiles.map(t => t.tileIndex).join(',')}]`);
 const dedupeMap = new Map<string, any>();
 let noKeyIndex = 0;
 for (const b of allBooks) {
 const title = (b.title || '').trim();
 if (!title) continue;
 let dk = dedupeKey(title, b.author, b.isbn);
 if (!dk) dk = `nokey:${noKeyIndex++}`;
 const existing = dedupeMap.get(dk);
 if (!existing) {
 dedupeMap.set(dk, b);
 } else {
 dedupeMap.set(dk, chooseMoreComplete(existing, b));
 }
 }

 const merged = Array.from(dedupeMap.values()).sort((a, b) => {
 const ta = a.tile_index ?? 99;
 const tb = b.tile_index ?? 99;
 if (ta !== tb) return ta - tb;
 return (a.spine_index_in_tile ?? 99) - (b.spine_index_in_tile ?? 99);
 });

 merged.forEach((b, idx) => { b.spine_index = idx; });

 console.log(`${logPrefix} [TILES] tile fallback produced ${merged.length} total books (${allBooks.length} raw -> ${merged.length} unique after dedupe)`);
 return { books: merged, usedRepair: true, rawLength: 0 };
 } catch (err: any) {
 console.error(`${logPrefix} [TILES] failed:`, err?.message || err);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
}

/**
 * Continuation strategy: if Gemini response was truncated/incomplete, make a follow-up call
 */
async function continueGeminiScan(
 imageDataURL: string,
 previousBooks: any[],
 scanId?: string
 ): Promise<GeminiScanResult> {
 const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
 const lastSpineIndex = previousBooks.length > 0 
 ? Math.max(...previousBooks.map(b => b.spine_index ?? -1)) + 1
 : 0;
 
 console.log(`${logPrefix} Gemini continuation: requesting books starting from spine_index ${lastSpineIndex}`);
 
 const key = process.env.GEMINI_API_KEY;
 if (!key) return { books: [], usedRepair: false, rawLength: 0 };
 
 const model = 'gemini-3-flash-preview';
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
 
 // Log image payload being sent to Gemini (continuation)
 const imageBytesLengthSentToGemini = base64Data.length;
 const imageMimeSentToGemini = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
 console.log(`${logPrefix} Sending continuation to Gemini: imageBytes=${imageBytesLengthSentToGemini}, mime=${imageMimeSentToGemini}, scanId=${scanId || 'none'}`);
 
 try {
 const res = await fetch(
 `${endpoint}?key=${key}`,
 {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [
 {
 parts: [
 {
 text: `Continue scanning book spines. You already found ${previousBooks.length} books (spine_index 0 through ${lastSpineIndex - 1}). Return remaining books from spine_index ${lastSpineIndex} as a JSON array of objects.

RULES: Do not translate. Output title/author exactly as seen. TITLE=book name, AUTHOR=person name. Do NOT swap. Continue numbering left-to-right. Escape strings for JSON. Detect language from spine_text only. If unclear, set confidence: low and leave fields null. Prefer fewer books over guessing.

Return ONLY a JSON array. No markdown. No commentary.`,
 },
 { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
 ],
 },
 ],
 generationConfig: { 
 responseMimeType: "application/json",
 responseJsonSchema: getScanResultJsonSchema(),
 temperature: 0.1,
 maxOutputTokens: 16000,
 },
 }),
 }
 );
 
 if (!res.ok) {
 console.warn(`${logPrefix} Gemini continuation failed: ${res.status}`);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
 
 const data = await res.json() as any;
 const rawGeminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
 
 if (!rawGeminiText) {
 console.warn(`${logPrefix} Gemini continuation returned empty content`);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
 
 try {
 const parsed = JSON.parse(rawGeminiText);
 const books = ScanResultSchema.parse(Array.isArray(parsed) ? parsed : parsed?.books ?? []);
 console.log(`${logPrefix} Gemini continuation parsed ${books.length} books (structured output)`);
 return { books, usedRepair: false, rawLength: rawGeminiText.length };
 } catch (parseErr) {
 const BOOK_ARRAY_SCHEMA = 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index';
 const repaired = await repairJSON(rawGeminiText, BOOK_ARRAY_SCHEMA);
 if (repaired && Array.isArray(repaired)) {
 try {
 const books = ScanResultSchema.parse(repaired);
 console.log(`${logPrefix} Gemini continuation parsed ${books.length} books (repaired JSON)`);
 return { books, usedRepair: true, rawLength: rawGeminiText.length };
 } catch (_) {}
 }
 console.warn(`${logPrefix} Gemini continuation parse failed:`, (parseErr as Error)?.message);
 return { books: [], usedRepair: false, rawLength: rawGeminiText.length };
 }
 } catch (error: any) {
 console.error(`${logPrefix} Gemini continuation error:`, error?.message || error);
 return { books: [], usedRepair: false, rawLength: 0 };
 }
}

/**
 * Enhanced normalization: trim, collapse spaces, normalize quotes/dashes, strip punctuation
 */
function normalize(s?: string) {
 if (!s) return '';
 return s.trim()
 .toLowerCase()
 .replace(/[""]/g, '"') // Normalize quotes
 .replace(/['']/g, "'") // Normalize apostrophes
 .replace(/[]/g, '-') // Normalize dashes
 .replace(/[.,;:!?]/g, '') // Remove punctuation
 .replace(/\s+/g, ' ') // Collapse multiple spaces
 .trim();
}

/**
 * Enhanced normalization with OCR artifact removal
 */
function normalizeWithOCR(s?: string): string {
 if (!s) return '';
 let normalized = normalize(s);
 // Remove common OCR artifacts
 normalized = normalized
 .replace(/\|/g, '') // Remove pipe characters (common OCR error)
 .replace(/^VOL\s+/i, '') // Remove leading "VOL" (volume indicators)
 .replace(/\s+VOL\s*$/i, '') // Remove trailing "VOL"
 .replace(/^[0-9]+\s*$/, '') // Remove pure numbers
 .replace(/^[%@#$&*]+\s*$/, '') // Remove pure symbols
 .trim();
 return normalized;
}

/**
 * Format author name: capitalize first letter of first and last name, use full name
 * Examples:
 * - "JOHN SMITH" -> "John Smith"
 * - "jane doe" -> "Jane Doe"
 * - "MARY J. JONES" -> "Mary J. Jones"
 * - "smith, john" -> "John Smith" (handle comma-separated)
 */
function formatAuthorName(author?: string | null): string | null {
 if (!author) return null;
 
 // Handle comma-separated names (e.g., "Smith, John" -> "John Smith")
 let name = author.trim();
 if (name.includes(',')) {
 const parts = name.split(',').map(p => p.trim());
 if (parts.length === 2) {
 name = `${parts[1]} ${parts[0]}`; // Swap last, first to first last
 }
 }
 
 // Split into words and capitalize each word properly
 const words = name.split(/\s+/).filter(w => w.length > 0);
 const formatted = words.map(word => {
 // Handle initials (e.g., "J." stays as "J.")
 if (word.length === 1 || (word.length === 2 && word.endsWith('.'))) {
 return word.toUpperCase();
 }
 // Capitalize first letter, lowercase the rest
 return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
 }).join(' ');
 
 return formatted;
}

function normalizeTitle(title?: string) {
 if (!title) return '';
 const normalized = normalize(title);
 // Remove "the", "a", "an" from the beginning
 let cleaned = normalized.replace(/^(the|a|an)\s+/, '').trim();
 // Remove common prefixes/suffixes that might vary
 cleaned = cleaned.replace(/^(a|an|the)\s+/i, '');
 // Remove extra whitespace and normalize
 return cleaned.replace(/\s+/g, ' ').trim();
}

function normalizeAuthor(author?: string) {
 if (!author) return '';
 const normalized = normalize(author);
 // Remove common suffixes
 let cleaned = normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
 // Handle "and" in author names (e.g., "Hoffman and Casnocha" vs "Reid Hoffman and Ben Casnocha")
 // For deduplication, we'll use a simpler approach - just normalize the string
 cleaned = cleaned.replace(/\s+and\s+/gi, ' & ');
 // Remove extra whitespace
 return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical key for deduplication. Requires both title and author (no title-only or one-word-only).
 * Format: normalized_title::normalized_author (full author to avoid over-merging).
 */
function buildCanonicalKey(book: any): string {
 const title = normalizeTitle(book.title || '');
 const author = normalizeAuthor(book.author || '');
 if (!title || !author) return '';
 return `${title}::${author}`;
}

/**
 * Merge book results from multiple providers and deduplicate
 */
function mergeBookResults(geminiBooks: any[], openaiBooks: any[]): any[] {
 const combined = [...geminiBooks, ...openaiBooks];
 return dedupeBooks(combined);
}

/**
 * Merge tiles into OpenAI base: OpenAI is authoritative. Add tile books only when they don't
 * match an existing work (by work_key or title+author). Never drop OpenAI entries.
 */
function mergeTilesIntoOpenAIBase(openaiBooks: any[], tilesBooks: any[]): any[] {
 const base = [...openaiBooks];
 const keyFor = (b: any) =>
 (b?.work_key || b?.workKey || '').trim() || dedupeKey(b?.title ?? '', b?.author, b?.isbn);
 const existingKeys = new Set<string>();
 for (const b of base) {
 const k = keyFor(b);
 if (k) existingKeys.add(k);
 }
 let tileNoKeyIdx = 0;
 for (const b of tilesBooks) {
 let k = keyFor(b);
 if (!k) k = `tile-nokey:${tileNoKeyIdx++}`;
 if (existingKeys.has(k)) continue;
 existingKeys.add(k);
 base.push(b);
 }
 return base;
}

/**
 * Dedupe for tiles+OpenAI fallback: prefer spine_text as identity, fallback to title|author.
 * Use when merging tiles and OpenAI results (don't dedupe only by title/author).
 * @deprecated Prefer mergeTilesIntoOpenAIBase so tiles never remove OpenAI books.
 */
function dedupeBooksForFallback(books: any[]): any[] {
 const seen = new Set<string>();
 const out: any[] = [];
 for (const b of books) {
 const spine = (b?.spine_text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
 const title = (b?.title ?? '').toLowerCase().trim();
 const author = (b?.author ?? '').toLowerCase().trim();
 const key = spine ? `sp:${spine}` : `ta:${title}|${author}`;
 if (!key || key === 'ta:|') continue;
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(b);
 }
 return out;
}

/**
 * Prefer completeness when resolving a collision: both title+author > longer title/author > higher confidence.
 */
function chooseMoreComplete(existing: any, candidate: any): any {
 const hasBoth = (b: any) => !!(b?.title && b?.author);
 const totalLen = (b: any) => (b?.title?.length ?? 0) + (b?.author?.length ?? 0);
 const candBoth = hasBoth(candidate);
 const exBoth = hasBoth(existing);
 if (candBoth && !exBoth) return candidate;
 if (!candBoth && exBoth) return existing;
 const candLen = totalLen(candidate);
 const exLen = totalLen(existing);
 if (candLen !== exLen) return candLen > exLen ? candidate : existing;
 return confidenceScore(candidate?.confidence) >= confidenceScore(existing?.confidence) ? candidate : existing;
}

/** Log one dropped book for pipeline diagnostics. */
function logDroppedBook(
 prefix: string,
 rawIndex: number,
 book: any,
 reasonsDropped: string[],
 duplicateOf?: string
): void {
 const normTitle = normalizeTitle(book?.title);
 const normAuthor = normalizeAuthor(book?.author);
 const hasIsbn = !!(book?.isbn && String(book.isbn).trim());
 const entry: Record<string, any> = {
 raw_index: rawIndex,
 title: book?.title ?? null,
 author: book?.author ?? null,
 confidence: book?.confidence ?? null,
 reasons_dropped: reasonsDropped,
 has_isbn: hasIsbn,
 isbn: book?.isbn ?? null,
 norm_title: normTitle || null,
 norm_author: normAuthor || null,
 };
 if (duplicateOf != null) entry.duplicate_of = duplicateOf;
 if (book?.validationNotes) entry.validation_notes = book.validationNotes;
 if (book?.chatgptReason) entry.chatgpt_reason = book.chatgptReason;
 if (book?.external_match) entry.external_match = !!book.external_match;
 console.log(`[DROP] ${prefix}`, JSON.stringify(entry));
}

/**
 * Improved merge/dedupe with canonical keys + fuzzy matching.
 * Dedupe prefers completeness: keep (title+author) > longer title/author > higher confidence.
 * Optional onDrop(book, 'duplicate_of', canonicalKey) when a book is dropped as duplicate.
 */
function dedupeBooks(books: any[], onDrop?: (dropped: any, reason: string, duplicateOf?: string) => void): any[] {
 if (!books || books.length === 0) return [];
 
 const noKeyBooks: any[] = [];
 const canonicalMap: Record<string, any> = {};
 for (const b of books) {
 if (!b || !b.title) continue;
 const key = buildCanonicalKey(b);
 if (!key) {
 noKeyBooks.push(b);
 continue;
 }
 if (!canonicalMap[key]) {
 canonicalMap[key] = b;
 } else {
 const existing = canonicalMap[key];
 const kept = chooseMoreComplete(existing, b);
 const dropped = kept === existing ? b : existing;
 if (onDrop) onDrop(dropped, 'duplicate_of', key);
 canonicalMap[key] = kept;
 }
 }
 
 const deduped = Object.values(canonicalMap);
 deduped.push(...noKeyBooks);
 
 // Second pass: fuzzy match titles within same spine_index neighborhood
 const final: any[] = [];
 for (const book of deduped) {
 const bookTitle = normalizeTitle(book.title);
 const bookAuthor = normalizeAuthor(book.author);
 const bookSpineIndex = book.spine_index ?? 999; // Default to end if missing
 
 if (!bookTitle || bookTitle.length < 2) continue;
 
 let isDuplicate = false;
 let duplicateOfKey: string | undefined;
 let droppedExisting = false; // we replaced existing with book only log existing as dropped
 for (const existing of final) {
 const existingTitle = normalizeTitle(existing.title);
 const existingAuthor = normalizeAuthor(existing.author);
 const existingSpineIndex = existing.spine_index ?? 999;
 
 // Exact match
 if (bookTitle === existingTitle && bookAuthor === existingAuthor) {
 isDuplicate = true;
 duplicateOfKey = buildCanonicalKey(existing);
 break;
 }
 
 // Fuzzy match: similar titles, same author, nearby spine positions
 const authorsMatch = bookAuthor === existingAuthor || 
 (!bookAuthor && !existingAuthor) ||
 (bookAuthor && existingAuthor && (
 bookAuthor === existingAuthor ||
 bookAuthor.includes(existingAuthor) ||
 existingAuthor.includes(bookAuthor)
 ));
 
 const spineNearby = Math.abs(bookSpineIndex - existingSpineIndex) <= 2;
 
 if (authorsMatch && spineNearby && bookTitle.length > 3 && existingTitle.length > 3) {
 // Token-set similarity: check if titles share significant words
 const bookWords = new Set(bookTitle.split(/\s+/).filter(w => w.length > 2));
 const existingWords = new Set(existingTitle.split(/\s+/).filter(w => w.length > 2));
 const intersection = new Set([...bookWords].filter(w => existingWords.has(w)));
 const union = new Set([...bookWords, ...existingWords]);
 const similarity = intersection.size / union.size;
 
 // Also check if one contains the other
 const containsMatch = bookTitle.includes(existingTitle) || 
 existingTitle.includes(bookTitle);
 
 if (similarity > 0.5 || containsMatch) {
 isDuplicate = true;
 duplicateOfKey = buildCanonicalKey(existing);
 // Prefer higher confidence or more complete data
 if (book.confidence === 'high' && existing.confidence !== 'high') {
 const index = final.indexOf(existing);
 if (index !== -1) {
 if (onDrop) onDrop(existing, 'duplicate_of', buildCanonicalKey(book));
 final[index] = book;
 droppedExisting = true;
 }
 }
 break;
 }
 }
 }
 
 if (isDuplicate && onDrop && duplicateOfKey && !droppedExisting) {
 onDrop(book, 'duplicate_of', duplicateOfKey);
 }
 if (!isDuplicate) {
 final.push(book);
 }
 }
 
 return final;
}

async function withRetries<T>(fn: () => Promise<T>, tries = 2, backoffMs = 800): Promise<T> {
 let last: any;
 for (let i = 0; i < tries; i++) {
 try {
 return await fn();
 } catch (e) {
 last = e;
 if (i < tries - 1) await delay(backoffMs * (i + 1));
 }
 }
 throw last;
}

/** Title-ish words that suggest a book title, not an author. */
const TITLE_LIKE_WORDS = /\b(the|a|an|case|curious|benjamin|story|life|adventures|secret|great|last|first)\b/i;

/** Heuristic: string looks like a person name (24 words, capitalized or all caps). Exclude if it contains title words (the/a/an) spines often all-caps. */
function looksLikePersonName(s: string): boolean {
 const t = (s || '').trim();
 if (!t) return false;
 if (/\b(the|a|an)\b/i.test(t)) return false; // "GIFT FROM THE SEA" is a title, not a name
 const words = t.split(/\s+/).filter(Boolean);
 if (words.length < 2 || words.length > 4) return false;
 if (/^(the|a|an)\s+/i.test(t)) return false;
 return words.every(w => /^[A-Z]/.test(w) || w === w.toUpperCase());
}

/** Heuristic: string looks like a book title (starts with article or has title-ish words). Don't use word count alone "ANNE MORROW LINDBERGH" is 3 words but a name. */
function looksLikeBookTitle(s: string): boolean {
 const t = (s || '').trim();
 if (!t) return false;
 if (/^(the|a|an)\s+/i.test(t)) return true;
 return TITLE_LIKE_WORDS.test(t);
}

/**
 * Cheap validator: filter obvious junk and swap suspicion before LLM validation.
 * Returns { isValid: boolean, normalizedBook: any }
 */
function cheapValidate(book: any): { isValid: boolean; normalizedBook: any } {
 const spineText = normalizeWithOCR(book.spine_text || book.title || '');
 const titleRaw = (book.title || '').trim();
 const authorRaw = (book.author || '').trim();
 const title = normalizeWithOCR(titleRaw);
 const author = normalizeWithOCR(authorRaw);
 const confidence = (book.confidence || '').toLowerCase();

 // Filter: spine_text too short AND no title/author
 if (spineText.length < 3 && !title && !author) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'spine_text_too_short' } };
 }

 // Filter: title is only digits/punctuation
 if (title && /^[0-9\s.,;:!?]+$/.test(title)) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_is_digits_only' } };
 }

 // Filter: obvious nonsense patterns
 if (title && /^(IIII|@@@@|%%%%|####|\|\|\|\|)$/.test(title)) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'nonsense_pattern' } };
 }

 // Filter: single generic word with no author and low confidence
 if (title && !author && confidence === 'low') {
 const words = title.split(/\s+/);
 if (words.length === 1 && ['the', 'a', 'an', 'book', 'volume', 'vol'].includes(words[0])) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'generic_word_no_author' } };
 }
 }

 // Filter: confidence low AND (title or author short/odd)
 if (confidence === 'low') {
 if (title && title.length < 2) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'low_confidence_title_too_short' } };
 }
 if (author && title && author.length < 2) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'low_confidence_author_too_short' } };
 }
 }

 // Swap suspicion: CORRECT instead of DROP swap title/author and keep; downstream (ISBN/cover lookup) can validate.
 if (author && title && looksLikePersonName(titleRaw) && looksLikeBookTitle(authorRaw)) {
 const swappedTitle = authorRaw;
 const swappedAuthor = titleRaw;
 const normalizedBook = {
 ...book,
 title: swappedTitle.trim() || null,
 author: formatAuthorName(swappedAuthor),
 spine_text: book.spine_text?.trim() || spineText,
 language: book.language || 'en',
 spine_index: book.spine_index ?? 0,
 };
 return { isValid: true, normalizedBook };
 }

 // Filter: title and author identical
 if (title && author && title === author) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_author_identical' } };
 }

 // Filter: title mostly non-letters or weird tokenization
 if (title) {
 const letters = (title.match(/[a-zA-Z]/g) || []).length;
 if (title.length >= 2 && letters / title.length < 0.5) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_mostly_non_letters' } };
 }
 const tokens = title.split(/\s+/).filter(Boolean);
 if (tokens.some(t => t.length > 80)) {
 return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_weird_tokenization' } };
 }
 }

 // Normalize the book
 const normalizedBook = {
 ...book,
 title: book.title?.trim() || null,
 author: formatAuthorName(book.author),
 spine_text: book.spine_text?.trim() || spineText,
 language: book.language || 'en',
 spine_index: book.spine_index ?? 0,
 };

 return { isValid: true, normalizedBook };
}

/**
 * JSON repair: when parse fails, send raw text to LLM to fix into valid JSON.
 * Very effective for unterminated strings and other parse failures.
 */
async function repairJSON(invalidJSON: string, schema: string): Promise<any> {
 const key = process.env.OPENAI_API_KEY;
 if (!key) return null;
 const trimmed = invalidJSON.trim();
 if (!trimmed) return null;

 try {
 const res = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${key}`,
 },
 body: JSON.stringify({
 model: 'gpt-4.1-mini',
 messages: [{
 role: 'user',
 content: `Fix this into valid JSON that matches this schema. Output only JSON.

Schema: ${schema}

Invalid or truncated JSON:
${trimmed.slice(0, 12000)}

Return ONLY valid JSON. No markdown, no code blocks, no commentary.`,
 }],
 max_tokens: 4000,
 temperature: 0,
 }),
 });

 if (!res.ok) return null;
 const data = await res.json() as {
 choices?: Array<{ message?: { content?: string } }>;
 };
 const content = data.choices?.[0]?.message?.content?.trim();
 if (!content) return null;

 const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
 return JSON.parse(cleaned);
 } catch {
 return null;
 }
}

async function scanWithOpenAI(
 imageDataURL: string,
 retryCount = 0,
 abortController?: AbortController,
 scanId?: string,
 scanMetrics?: ScanMetrics
): Promise<any[]> {
 const key = process.env.OPENAI_API_KEY;
 if (!key) return [];

 const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
 
 // Log image payload being sent to OpenAI
 const imageBytesLengthSentToOpenAI = imageDataURL.length;
 const imageMimeSentToOpenAI = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
 console.log(`${logPrefix} Sending to OpenAI: imageBytes=${imageBytesLengthSentToOpenAI}, mime=${imageMimeSentToOpenAI}, scanId=${scanId || 'none'}`);

 if (scanMetrics) {
 scanMetrics.openaiCalls += 1;
 scanMetrics.providers.add('openai');
 }

 const startTime = Date.now();
 // Use provided abort controller or create new one
 const controller = abortController || new AbortController();
 const timeout = abortController ? null : setTimeout(() => {
 console.warn('[API] OpenAI request timeout after 60 seconds - aborting');
 controller.abort();
 }, 60000); // 60 seconds - reduced to fail faster and avoid long waits
 try {
 const res = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${key}`,
 },
 signal: controller.signal,
 body: JSON.stringify({
 model: 'gpt-4.1', // Using gpt-4.1 for vision OCR (replaces deprecated gpt-4o)
 messages: [
 {
 role: 'user',
 content: [
 {
 type: 'text',
 text: `Scan this image and return ALL visible book spines as a strict JSON array.

CRITICAL RULES:
- Do not translate any text. Output the title exactly as seen on the spine.
- AUTHOR: Use the author's FULL NAME (first and last). If the spine only shows a last name (e.g. "BALZAC"), use your knowledge to provide the full name (e.g. "Honoré de Balzac"). Always prefer the complete, commonly known form of the author's name.
- TITLE is the book name (usually larger text, on the spine). AUTHOR is the person's name (usually smaller text). Do NOT swap them.
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE.
- Number books left-to-right: spine_index 0, 1, 2, etc.
- All string values must be JSON-escaped (quotes as \\", newlines as \\n). If spine_text would break JSON, omit or set to null.
- Detect language only from spine_text (en, es, fr, or unknown). Do not invent language.
- If unclear, set confidence: low and leave unknown fields null. Prefer returning fewer books over guessing.

Return ONLY a JSON array. No markdown. No commentary.
[{"title":"...","author":"...","confidence":"high|medium|low","spine_text":"...","language":"en|es|fr|unknown","reason":"...","spine_index":0}]`,
 },
 { type: 'image_url', image_url: { url: imageDataURL } },
 ],
 },
 ],
 max_tokens: 3000, // Reduced from 4000 to speed up response time
 }),
 });
 if (!res.ok) {
 const errorText = await res.text();
 const elapsed = Date.now() - startTime;
 
 // Handle rate limiting (429) or server errors (500-599, especially 502) with retry
 // Increased retries and backoff for reliability mode
 const maxRetries = 3; // Increased from 2 to 3
 if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && retryCount < maxRetries && !controller.signal.aborted) {
 // Exponential backoff: 2s, 4s, 8s (increased from 3s, 6s)
 const backoffDelay = Math.pow(2, retryCount) * 2000; // 2s, 4s, 8s
 console.warn(`${logPrefix} OpenAI ${res.status} error, retrying in ${backoffDelay/1000}s... (attempt ${retryCount + 1}/${maxRetries}) after ${elapsed}ms`);
 await delay(backoffDelay);
 return scanWithOpenAI(imageDataURL, retryCount + 1, controller, scanId, scanMetrics);
 }
 
 console.error(`[API] OpenAI scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)} (after ${elapsed}ms)`);
 return [];
 }
 const requestTime = Date.now() - startTime;
 const data = await res.json() as {
 choices?: Array<{ 
 message?: { content?: string; text?: string }; 
 content?: string;
 text?: string;
 finish_reason?: string 
 }>;
 error?: any;
 model?: string;
 usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
 };
 
 // Log request timing
 console.log(`[API] OpenAI request completed in ${requestTime}ms`);
 
 // Log full response structure for debugging
 console.log(`[API] OpenAI response structure:`, JSON.stringify({
 hasChoices: !!data.choices,
 choicesLength: data.choices?.length || 0,
 firstChoice: data.choices?.[0] ? {
 hasMessage: !!data.choices[0].message,
 hasContent: !!data.choices[0].message?.content,
 finishReason: data.choices[0].finish_reason,
 contentLength: data.choices[0].message?.content?.length || 0
 } : null,
 error: data.error,
 model: data.model
 }, null, 2));
 
 // Check for API errors
 if (data.error) {
 console.error(`[API] OpenAI API error:`, data.error);
 return [];
 }
 
 // Try multiple ways to extract content
 let content = '';
 const finishReason = data.choices?.[0]?.finish_reason;
 
 // Method 1: Standard path
 content = data.choices?.[0]?.message?.content?.trim() || '';
 
 // Method 2: Try alternative paths if standard is empty
 if (!content && data.choices?.[0]) {
 const choice = data.choices[0];
 // Try different possible structures
 content = choice.content?.trim() || 
 choice.text?.trim() || 
 choice.message?.text?.trim() || 
 '';
 }
 
 // Method 3: If finish_reason is "length", the response was truncated
 // gpt-5 uses reasoning tokens - if all tokens were used for reasoning, we need more tokens
 if (!content && finishReason === 'length') {
 const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
 const totalTokens = data.usage?.completion_tokens || 0;
 console.warn(`[API] OpenAI response truncated: used ${totalTokens} tokens (${reasoningTokens} for reasoning). Increase max_completion_tokens.`);
 }
 
 console.log(`[API] OpenAI raw response length: ${content.length} chars, finish_reason: ${finishReason}`);
 if (content.length > 0) {
 console.log(`[API] OpenAI response preview: ${content.slice(0, 200)}...`);
 }
 
 if (!content) {
 console.error(`[API] OpenAI returned empty content. Full response keys:`, Object.keys(data));
 console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
 // If finish_reason is 'length', the response was truncated - this is still an error for our use case
 if (finishReason === 'length') {
 console.error(`[API] Response was truncated due to token limit`);
 }
 return [];
 }
 
 // Remove markdown code blocks
 if (content.includes('```')) {
 content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
 }
 
 // Try to extract JSON array from response (might have text before/after)
 let parsed: any = null;
 
 // First try: parse entire content if it's pure JSON
 try {
 parsed = JSON.parse(content);
 if (Array.isArray(parsed)) {
 console.log(`[API] OpenAI parsed ${parsed.length} books (direct JSON)`);
 return parsed;
 }
 } catch {}
 
 // Second try: find JSON array in content
 const arrayMatch = content.match(/\[[\s\S]*\]/);
 if (arrayMatch) {
 try {
 parsed = JSON.parse(arrayMatch[0]);
 if (Array.isArray(parsed)) {
 console.log(`[API] OpenAI parsed ${parsed.length} books (extracted from text)`);
 return parsed;
 }
 } catch (e) {
 // Try JSON repair
 console.warn(`[API] OpenAI JSON parse failed, attempting repair...`);
 const repaired = await repairJSON(arrayMatch[0], 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
 if (repaired && Array.isArray(repaired)) {
 console.log(`[API] OpenAI parsed ${repaired.length} books (repaired JSON)`);
 return repaired;
 }
 console.error(`[API] OpenAI failed to parse/extract JSON:`, e);
 }
 }
 
 // Final attempt: try repairing the entire content
 console.warn(`[API] OpenAI attempting final JSON repair...`);
 const finalRepaired = await repairJSON(content, 'array of book objects');
 if (finalRepaired && Array.isArray(finalRepaired)) {
 console.log(`[API] OpenAI parsed ${finalRepaired.length} books (final repair)`);
 return finalRepaired;
 }
 
 console.error(`[API] OpenAI response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
 return [];
 } catch (e: any) {
 const elapsed = Date.now() - startTime;
 const isAbort = e.name === 'AbortError' || e.message?.includes('aborted') || e.message?.includes('AbortError');

 // Abort: do NOT retry. Hedge aborts OpenAI when Gemini wins; retrying would burn a second call.
 if (isAbort) {
 console.log(`${logPrefix} OpenAI request was aborted (${elapsed}ms) not retrying (hedge or timeout)`);
 return [];
 }

 // Retry on network errors with increased retries
 const errorMessage = e?.message || String(e);
 const maxNetworkRetries = 2; // Increased from 1
 if ((errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('ECONNRESET') || errorMessage.includes('502')) && retryCount < maxNetworkRetries) {
 const backoffDelay = Math.pow(2, retryCount) * 2000; // 2s, 4s
 console.warn(`${logPrefix} OpenAI network error after ${elapsed}ms, retrying in ${backoffDelay/1000}s... (attempt ${retryCount + 1}/${maxNetworkRetries})`);
 await delay(backoffDelay);
 return scanWithOpenAI(imageDataURL, retryCount + 1, undefined, scanId, scanMetrics);
 }
 
 console.error(`[API] OpenAI scan exception after ${elapsed}ms:`, errorMessage);
 return [];
 } finally {
 clearTimeout(timeout);
 }
}

/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
async function scanWithGemini(
 imageDataURL: string,
 scanId?: string,
 signal?: AbortSignal,
 scanMetrics?: ScanMetrics
): Promise<GeminiScanResult> {
 return scanWithGeminiDirect(imageDataURL, scanId, signal, scanMetrics);
}

/**
 * Early external lookup for ambiguous items (before batch validation)
 body: JSON.stringify({
 contents: [
 {
 parts: [
 {
 text: `Scan book spines in this image and return ONLY a strict JSON array.

CRITICAL RULES:
- Do not translate any text. Output the title exactly as seen on the spine.
- AUTHOR: Use the author's FULL NAME (first and last). If the spine only shows a last name (e.g. "BALZAC"), use your knowledge to provide the full name (e.g. "Honoré de Balzac"). Always prefer the complete, commonly known form of the author's name.
- TITLE is the book name (usually larger text on spine). AUTHOR is the person's name (usually smaller text). DO NOT swap them.
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE.
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy). Detect language only from spine_text (en, es, fr, or unknown). Do not invent language.
- If unclear, set confidence: low and leave unknown fields null. Prefer returning fewer books over guessing.

Return ONLY valid JSON array (no markdown, no code blocks, no explanations):
[{"title":"...","author":"...","confidence":"high|medium|low","spine_text":"...","language":"en|es|fr|unknown","reason":"...","spine_index":0}]`,
 },
 { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
 ],
 },
 ],
 generationConfig: { 
 responseMimeType: "application/json", // Force JSON-only output at API level
 temperature: 0, // Minimize randomness and formatting drift (changed from 0.1)
 maxOutputTokens: 16000, // Increased significantly for shelf scans (was 8000, now 16000)
 },
 }),
 }
 );
 
 // Handle rate limiting (429) with exponential backoff
 if (res.status === 429) {
 const maxRetries = 3; // Retry up to 3 times
 if (retryCount < maxRetries) {
 // Longer backoff: 5s, 10s, 20s (more conservative for rate limits)
 const backoffDelay = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
 console.warn(
 `[API] Gemini rate limited (429), retrying in ${backoffDelay/1000}s... (attempt ${retryCount + 1}/${maxRetries})`
 );
 await delay(backoffDelay);
 // Reset rate limiter before retry to allow the request
 geminiRequestTimes = geminiRequestTimes.slice(0, -1); // Remove the failed request from tracking
 return scanWithGemini(imageDataURL, retryCount + 1);
 } else {
 const errorText = await res.text();
 let errorData: any = null;
 try {
 errorData = errorText ? JSON.parse(errorText) : null;
 } catch (e) {
 // Error text is not JSON, that's fine
 }
 
 // Gemini's API returns "quota" in the error message even for rate limits
 // This is misleading - check if it's actually a burst rate limit
 const errorMessage = errorData?.error?.message || '';
 const mentionsQuota = errorMessage.toLowerCase().includes('quota');
 
 // Since user is well under quota limits, this is almost certainly a rate limit (burst)
 if (mentionsQuota) {
 console.error(`[API] Gemini rate limited (429) - Error message mentions "quota" but this is likely a burst rate limit, not actual quota. Message: ${errorMessage.slice(0, 200)}`);
 console.warn(`[API] Note: Gemini API often returns "quota" errors for rate limits. Check your RPM (requests per minute) limits, not just daily quota.`);
 } else {
 console.error(`[API] Gemini rate limited (429) after ${maxRetries} retries - ${errorMessage.slice(0, 200)}`);
 }
 // Return empty array instead of throwing - let OpenAI handle it
 return [];
 }
 }
 
 if (!res.ok) {
 const errorText = await res.text();
 // Parse error to check message
 let errorData: any = null;
 try {
 errorData = errorText ? JSON.parse(errorText) : null;
 } catch (e) {
 // Error text is not JSON, that's fine
 }
 const errorMessage = errorData?.error?.message || errorText || '';
 
 // Better error logging
 if (res.status === 429) {
 const mentionsQuota = errorMessage.toLowerCase().includes('quota');
 if (mentionsQuota) {
 console.error(`[API] Gemini rate limited (429) - Error mentions "quota" but this is likely a burst rate limit. Message: ${errorMessage.slice(0, 200)}`);
 } else {
 console.error(`[API] Gemini rate limited (429) - ${errorMessage.slice(0, 200)}`);
 }
 } else {
 console.error(`[API] Gemini scan failed: ${res.status} ${res.statusText} - ${errorMessage.slice(0, 200)}`);
 }
 return [];
 }
 const data = await res.json() as any;
 
 // Log full response structure for debugging
 console.log(`[API] Gemini response structure:`, JSON.stringify({
 hasCandidates: !!data.candidates,
 candidatesLength: data.candidates?.length || 0,
 firstCandidate: data.candidates?.[0] ? {
 hasContent: !!data.candidates[0].content,
 hasParts: !!data.candidates[0].content?.parts,
 partsLength: data.candidates[0].content?.parts?.length || 0,
 hasText: !!data.candidates[0].text,
 firstPartText: data.candidates[0].content?.parts?.[0]?.text?.substring(0, 50) || null
 } : null,
 error: data.error
 }, null, 2));
 
 let content = '';
 // Try multiple extraction methods
 if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
 content = data.candidates[0].content.parts[0].text;
 } else if (data.candidates?.[0]?.text) {
 content = data.candidates[0].text;
 } else if (data.candidates?.[0]?.content?.text) {
 content = data.candidates[0].content.text;
 } else if (data.text) {
 content = data.text;
 }
 
 // Check if content object exists but is empty (Gemini used all tokens for reasoning)
 if (!content && data.candidates?.[0]?.content) {
 const contentObj = data.candidates[0].content;
 // Try to extract from nested structures
 if (contentObj.parts && Array.isArray(contentObj.parts)) {
 for (const part of contentObj.parts) {
 if (part.text) {
 content = part.text;
 break;
 }
 }
 }
 }
 
 content = content.trim();
 
 console.log(`[API] Gemini raw response length: ${content.length} chars`);
 if (content.length > 0) {
 console.log(`[API] Gemini response preview: ${content.slice(0, 200)}...`);
 }
 
 if (!content) {
 // Check if Gemini used all tokens for reasoning (thoughtsTokenCount > 0 but no output)
 const usageMetadata = data.usageMetadata;
 if (usageMetadata?.thoughtsTokenCount && usageMetadata.thoughtsTokenCount > 0) {
 console.error(`[API] Gemini used ${usageMetadata.thoughtsTokenCount} tokens for reasoning but produced no output`);
 console.error(`[API] Total tokens: ${usageMetadata.totalTokenCount}, Output tokens: ${usageMetadata.totalTokenCount - usageMetadata.thoughtsTokenCount}`);
 console.error(`[API] This suggests the model needs more maxOutputTokens or a more direct prompt`);
 }
 console.error(`[API] Gemini returned empty content. Full response keys:`, Object.keys(data));
 console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
 return [];
 }
 
 // Remove markdown code blocks more aggressively
 // Handle both ```json\n...\n``` and ```\n...\n``` formats
 content = content
 .replace(/^```json\s*\n?/i, '') // Remove opening ```json (case insensitive)
 .replace(/^```\s*\n?/g, '') // Remove opening ```
 .replace(/\n?```\s*$/g, '') // Remove closing ```
 .replace(/```json\s*\n?/gi, '') // Remove any ```json in middle
 .replace(/```\s*\n?/g, '') // Remove any remaining ```
 .trim();
 
 // Try to extract JSON array from response
 let parsed: any = null;
 
 // First try: parse entire content if it's pure JSON
 try {
 parsed = JSON.parse(content);
 if (Array.isArray(parsed)) {
 console.log(`[API] Gemini parsed ${parsed.length} books (direct JSON)`);
 return parsed;
 }
 } catch {}
 
 // Second try: find complete JSON array in content (must have closing bracket)
 const completeArrayMatch = content.match(/\[[\s\S]*\]/);
 if (completeArrayMatch) {
 try {
 const arrayStr = completeArrayMatch[0];
 parsed = JSON.parse(arrayStr);
 if (Array.isArray(parsed)) {
 console.log(`[API] Gemini parsed ${parsed.length} books (extracted from text)`);
 return parsed;
 }
 } catch (e: any) {
 // If complete array fails, log the error and try partial extraction
 console.log(`[API] Gemini complete array parse failed: ${e?.message}, array length: ${completeArrayMatch[0].length}, trying partial extraction...`);
 }
 } else {
 console.log(`[API] Gemini: No complete array match found (no closing bracket)`);
 }
 
 // Third try: find incomplete JSON array and try to complete it
 // Look for array start and extract all complete objects
 const arrayStart = content.indexOf('[');
 if (arrayStart !== -1) {
 const arrayContent = content.substring(arrayStart);
 // Try to find all complete JSON objects in the array
 const objectMatches = arrayContent.match(/\{[^}]*"title"[^}]*"author"[^}]*\}/g);
 if (objectMatches && objectMatches.length > 0) {
 try {
 // Reconstruct array from complete objects
 const reconstructed = '[' + objectMatches.join(',') + ']';
 parsed = JSON.parse(reconstructed);
 if (Array.isArray(parsed)) {
 console.log(`[API] Gemini parsed ${parsed.length} books (reconstructed from partial)`);
 return parsed;
 }
 } catch (e) {
 // Try JSON repair
 console.warn(`[API] Gemini reconstruction failed, attempting repair...`);
 const reconstructedForRepair = '[' + objectMatches.join(',') + ']';
 const repaired = await repairJSON(reconstructedForRepair, 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
 if (repaired && Array.isArray(repaired)) {
 console.log(`[API] Gemini parsed ${repaired.length} books (repaired JSON)`);
 return repaired;
 }
 console.log(`[API] Gemini reconstruction failed:`, e);
 }
 }
 }
 
 // Final attempt: try repairing the entire content
 console.warn(`[API] Gemini attempting final JSON repair...`);
 const repaired = await repairJSON(content, 'array of book objects');
 if (repaired && Array.isArray(repaired)) {
 console.log(`[API] Gemini parsed ${repaired.length} books (final repair)`);
 return repaired;
 }
 
 console.error(`[API] Gemini response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
 return [];
}

/**
 * Early external lookup for ambiguous items (before batch validation)
 * Returns book with external_match data if found
 */
async function earlyLookup(book: any): Promise<any> {
 // Lookup ALL books to get covers and googleBooksId, not just ambiguous ones
 // This ensures we have googleBooksId for fast cover fetching on the client
 
 try {
 // Dynamic import to avoid circular dependencies
 const { fetchBookData } = await import('../services/googleBooksService');
 
 const title = book.title || book.spine_text || '';
 if (!title || title.length < 2) {
 console.log(`[API] Early lookup SKIP for "${book.title}": title too short or missing`);
 return book;
 }
 
 const author = book.author || undefined;
 console.log(`[API] Early lookup trying: "${title}" by ${author || 'no author'}`);
 
 // Try fetchBookData first (most accurate)
 let result = await fetchBookData(title, author);
 
 // If that fails, try searchMultipleBooks and take the first result (more flexible)
 if (!result || !result.googleBooksId) {
 try {
 const { searchMultipleBooks } = await import('../services/googleBooksService');
 const multipleResults = await searchMultipleBooks(title, author, 5);
 if (multipleResults && multipleResults.length > 0) {
 // Take the first result
 result = multipleResults[0];
 console.log(`[API] Early lookup found via searchMultipleBooks: "${title}"`);
 }
 } catch (error) {
 // Ignore errors from searchMultipleBooks
 }
 }
 
 // Log lookup result for debugging
 if (result && result.googleBooksId) {
 console.log(`[API] Early lookup SUCCESS for "${title}": found googleBooksId=${result.googleBooksId.substring(0, 20)}..., coverUrl=${result.coverUrl ? 'yes' : 'no'}`);
 } else {
 console.log(`[API] Early lookup NO MATCH for "${title}" by ${author || 'no author'}`);
 }
 
 // GoogleBooksData doesn't have title/author directly, but fetchBookData returns data with googleBooksId
 // We'll use the original book data but mark that we found a match
 if (result && result.googleBooksId) {
 // Strong match found - attach external data
 // Note: We'll use the book's original title/author but mark it as externally validated
 return {
 ...book,
 external_match: {
 googleBooksId: result.googleBooksId,
 confidence: 'high', // External match is high confidence
 },
 // Keep original title/author but mark as externally validated
 googleBooksId: result.googleBooksId,
 // Add cover URL if available (so covers load immediately)
 coverUrl: result.coverUrl || book.coverUrl,
 };
 }
 } catch (error) {
 // Silently fail - we'll validate with LLM anyway
 console.log(`[API] Early lookup failed for "${book.title}":`, error?.message || error);
 }
 
 return book;
}

/**
 * Batch validation: validate multiple books in one LLM call
 */
const VALIDATION_BATCH_SIZE = 20;

async function batchValidateBooks(books: any[]): Promise<any[]> {
 if (books.length === 0) return books;

 // Use Gemini as primary validator (faster, no rate-limit issues)
 // OpenAI used as fallback when Gemini key is not configured
 const geminiKey = process.env.GEMINI_API_KEY;
 if (geminiKey) {
 console.log(`[API] Batch validating ${books.length} books with Gemini (primary)...`);
 const results: any[] = [];
 for (let i = 0; i < books.length; i += VALIDATION_BATCH_SIZE) {
   const batch = books.slice(i, i + VALIDATION_BATCH_SIZE);
   const geminiResults = await batchValidateBooksWithGemini(batch);
   results.push(...geminiResults);
 }
 return results;
 }

 // Fallback to OpenAI only if Gemini key is not configured
 const key = process.env.OPENAI_API_KEY;
 if (!key) return books;
 
 // Chunk into batches to avoid token limits
 const results: any[] = [];
 
 for (let i = 0; i < books.length; i += VALIDATION_BATCH_SIZE) {
 const batch = books.slice(i, i + VALIDATION_BATCH_SIZE);
 const batchNum = Math.floor(i / VALIDATION_BATCH_SIZE) + 1;
 const totalBatches = Math.ceil(books.length / VALIDATION_BATCH_SIZE);
 
 console.log(`[API] Batch validating ${batchNum}/${totalBatches} (${batch.length} books)...`);
 
 try {
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), 60000); // 60s per batch
 
 const batchInput = batch.map((b, idx) => ({
 canonical_key: buildCanonicalKey(b),
 title: b.title || null,
 author: b.author || null,
 spine_text: b.spine_text || b.title || '',
 confidence: b.confidence || 'medium',
 external_match: b.external_match || null,
 }));
 
 const res = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${key}`,
 },
 signal: controller.signal,
 body: JSON.stringify({
 model: 'gpt-4.1-mini',
 messages: [{
 role: 'user',
 content: `You are a book expert validating detected books from a bookshelf scan.

DETECTED BOOKS (JSON array):
${JSON.stringify(batchInput, null, 2)}

TASK: For each book, determine if it's valid and correct any errors. Be LENIENT - only mark as invalid if clearly junk.

RULES:
1. Books WITHOUT authors are VALID if title is distinctive
2. Partial titles are VALID
3. Only mark INVALID if clearly not a real book (random words, OCR garbage)
4. If title/author are swapped, fix them
5. Fix OCR errors
6. Prefer external_match data if provided (from Google Books lookup)

Return ONLY valid JSON array (no markdown, no code blocks):
[{
 "canonical_key": "same as input",
 "is_valid": true,
 "final_title": "corrected title or null",
 "final_author": "corrected author or null",
 "final_confidence": "high|medium|low",
 "fixes": ["title_author_swap", "ocr_cleanup", "filled_author", "none"],
 "notes": "brief explanation"
}]`,
 }],
 max_tokens: 2000,
 temperature: 0.1,
 }),
 });
 
 clearTimeout(timeout);
 
 if (!res.ok) {
 console.error(`[API] Batch validation failed: ${res.status}, falling back to Gemini`);
 const geminiResults = await batchValidateBooksWithGemini(batch);
 results.push(...geminiResults);
 continue;
 }
 
 const data = await res.json() as {
 choices?: Array<{ message?: { content?: string } }>;
 };
 let content = data.choices?.[0]?.message?.content?.trim() || '';
 
 // Remove markdown
 content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
 
 let validated: any[];
 try {
 validated = JSON.parse(content);
 } catch {
 // Try repair
 const repaired = await repairJSON(content, 'array of validation results');
 validated = repaired || [];
 }
 
 // Map validation results back to books
 const validatedMap = new Map(validated.map((v: any) => [v.canonical_key, v]));
 
 for (const book of batch) {
 const key = buildCanonicalKey(book);
 const validation = validatedMap.get(key);
 
 if (validation && validation.is_valid) {
 results.push({
 ...book,
 title: validation.final_title || book.title,
 author: formatAuthorName(validation.final_author || book.author), // Format author name
 confidence: validation.final_confidence || book.confidence,
 validationFixes: validation.fixes || [],
 validationNotes: validation.notes,
 // Explicitly preserve googleBooksId, coverUrl, and external_match from early lookup
 googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
 coverUrl: book.coverUrl, // Preserve cover URL from early lookup
 external_match: book.external_match,
 });
 } else {
 // Invalid book - mark for filtering
 console.log(`[API] Batch validation marked as INVALID: "${book.title}" by ${book.author || 'no author'}`);
 results.push({
 ...book,
 isValid: false,
 confidence: 'invalid',
 validationNotes: validation.notes,
 // Preserve googleBooksId and coverUrl even for invalid books (might be useful for debugging)
 googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
 coverUrl: book.coverUrl, // Preserve cover URL
 });
 }
 }
 } catch (error: any) {
 if (error?.name === 'AbortError') {
 console.warn(`[API] Batch validation timeout for batch ${batchNum}, falling back to Gemini`);
 } else {
 console.error(`[API] Batch validation error:`, error?.message || error, '- falling back to Gemini');
 }
 const geminiResults = await batchValidateBooksWithGemini(batch);
 results.push(...geminiResults);
 }
 }

 return results;
}

/** Same prompt as batch OpenAI validation, but calls Gemini. Used when OpenAI fails. */
async function batchValidateBooksWithGemini(batch: any[]): Promise<any[]> {
 const key = process.env.GEMINI_API_KEY;
 if (!key || batch.length === 0) return batch;

 const batchInput = batch.map((b) => ({
 canonical_key: buildCanonicalKey(b),
 title: b.title || null,
 author: b.author || null,
 spine_text: b.spine_text || b.title || '',
 confidence: b.confidence || 'medium',
 external_match: b.external_match || null,
 }));

 const prompt = `You are a book expert validating detected books from a bookshelf scan.

DETECTED BOOKS (JSON array):
${JSON.stringify(batchInput, null, 2)}

TASK: For each book, determine if it's valid and correct any errors. Be LENIENT - only mark as invalid if clearly junk.

RULES:
1. Books WITHOUT authors are VALID if title is distinctive
2. Partial titles are VALID
3. Only mark INVALID if clearly not a real book (random words, OCR garbage)
4. If title/author are swapped, fix them
5. Fix OCR errors
6. Prefer external_match data if provided (from Google Books lookup)

Return ONLY valid JSON array (no markdown, no code blocks):
[{
 "canonical_key": "same as input",
 "is_valid": true,
 "final_title": "corrected title or null",
 "final_author": "corrected author or null",
 "final_confidence": "high|medium|low",
 "fixes": ["title_author_swap", "ocr_cleanup", "filled_author", "none"],
 "notes": "brief explanation"
}]`;

 try {
 const model = 'gemini-3-flash-preview';
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 const res = await fetch(`${endpoint}?key=${key}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [{ parts: [{ text: prompt }] }],
 generationConfig: {
 responseMimeType: 'application/json',
 temperature: 0.1,
 maxOutputTokens: 8000, // 20 books × ~150 tokens/result = ~3000 tokens needed
 },
 }),
 });
 if (!res.ok) {
 console.error(`[API] Gemini batch validation failed: ${res.status}`);
 return batch;
 }
 const data = (await res.json()) as any;
 let content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
 content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
 let validated: any[];
 try {
 validated = JSON.parse(content);
 } catch {
 console.warn(`[API] Gemini batch validation JSON parse failed, attempting repair`, { contentLength: content.length, contentPreview: content.slice(0, 200) });
 const repaired = await repairJSON(content, 'array of validation results');
 validated = repaired || [];
 }
 if (!Array.isArray(validated) || validated.length === 0) {
 console.warn(`[API] Gemini batch validation returned empty/invalid result`, { batchSize: batch.length, validatedLength: Array.isArray(validated) ? validated.length : 'not-array', contentLength: content.length, finishReason: data.candidates?.[0]?.finishReason });
 }
 // Build map keyed by canonical_key from Gemini response
 const validatedMap = new Map(validated.map((v: any) => [v.canonical_key, v]));
 const results: any[] = [];
 let matchedByKey = 0, matchedByIndex = 0, unmatched = 0;
 for (let i = 0; i < batch.length; i++) {
 const book = batch[i];
 const canonicalKey = buildCanonicalKey(book);
 let validation = validatedMap.get(canonicalKey);
 if (!validation && i < validated.length) {
   // Fallback: match by position when canonical keys diverge
   validation = validated[i];
   if (validation) matchedByIndex++;
 } else if (validation) {
   matchedByKey++;
 }
 // Handle both boolean true and string "true" from Gemini, and both is_valid and isValid
 const isBookValid = validation && (validation.is_valid === true || validation.is_valid === 'true' || validation.isValid === true || validation.isValid === 'true');
 if (isBookValid) {
 results.push({
 ...book,
 title: validation.final_title || book.title,
 author: formatAuthorName(validation.final_author || book.author),
 confidence: validation.final_confidence || book.confidence,
 validationFixes: validation.fixes || [],
 validationNotes: validation.notes,
 googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
 coverUrl: book.coverUrl,
 external_match: book.external_match,
 });
 } else if (validation) {
 // Matched but Gemini said invalid
 console.log(`[API] Gemini batch validation marked as INVALID: "${book.title}" by ${book.author || 'no author'}`, { matchType: 'matched_but_invalid', validationKeys: Object.keys(validation), is_valid_raw: validation.is_valid, isValid_raw: validation.isValid });
 results.push({
 ...book,
 isValid: false,
 confidence: 'invalid',
 googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
 coverUrl: book.coverUrl,
 });
 } else {
 // No match at all — don't drop the book, keep it as-is (validation inconclusive)
 unmatched++;
 console.log(`[API] Gemini batch validation: no match for "${book.title}" by ${book.author || 'no author'} — keeping as-is`);
 results.push(book);
 }
 }
 console.log(`[API] Gemini batch validation matching: ${matchedByKey} by key, ${matchedByIndex} by index, ${unmatched} unmatched of ${batch.length} books. Gemini returned ${validated.length} items.`);
 return results;
 } catch (err: any) {
 console.error(`[API] Gemini batch validation error:`, err?.message || err);
 return batch;
 }
}

/** Same prompt as validateBookWithChatGPT, but calls Gemini. Used when OpenAI fails. */
async function validateBookWithGemini(book: any): Promise<any> {
 const key = process.env.GEMINI_API_KEY;
 if (!key) return book;

 const prompt = `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author || '(no author)'}"
Confidence: ${book.confidence}

TASK: Determine if this is a real book. Be LENIENT - only mark as invalid if it's clearly junk (random words, obvious OCR garbage, not a real book title). If it's a real book (even with partial info), keep it and correct any obvious errors.

IMPORTANT RULES - BE LENIENT:
1. Books WITHOUT authors are VALID if the title is distinctive (e.g., "Fallingwater", "The Revolution", "Villareal")
2. Partial titles are VALID (e.g., "The Revolution" might be "Hamilton: The Revolution" - that's fine, keep it)
3. Only mark as INVALID if it's clearly not a real book (random words, obvious garbage, nonsensical titles)
4. CRITICAL: If title and author are swapped, ALWAYS fix them. Titles are book names, authors are people's names.
 - If "title" looks like a person's name (e.g., "John Smith", "Diana Gabaldon") and "author" looks like a book title, SWAP THEM
 - If "author" is clearly a book title (e.g., "The Great Gatsby", "Dragonfly in Amber") and "title" is a person's name, SWAP THEM
5. Fix obvious OCR errors (e.g., "owmen" "women")
6. Clean up titles (remove publisher prefixes, series numbers) but keep the core title

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name or null", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES OF VALID BOOKS (KEEP THESE):
Input: Title="The Revolution", Author="Hamilton"
Output: {"isValid": true, "title": "Hamilton: The Revolution", "author": "Lin-Manuel Miranda", "confidence": "high", "reason": "Real book, expanded title"}

Input: Title="Fallingwater", Author=""
Output: {"isValid": true, "title": "Fallingwater", "author": null, "confidence": "high", "reason": "Real book about famous building, author not required"}

Input: Title="Villareal", Author=""
Output: {"isValid": true, "title": "Villareal", "author": null, "confidence": "medium", "reason": "Could be real book, keep it"}

Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author - Diana Gabaldon is author, Dragonfly in Amber is title"}

Input: Title="John Smith", Author="The Great Novel"
Output: {"isValid": true, "title": "The Great Novel", "author": "John Smith", "confidence": "high", "reason": "Swapped title and author - John Smith is author, The Great Novel is title"}

EXAMPLES OF INVALID BOOKS (REJECT THESE):
Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book, random words"}

Input: Title="Kaufmann's", Author=""
Output: {"isValid": false, "title": "Kaufmann's", "author": "", "confidence": "low", "reason": "Not a book title, appears to be store name"}

Input: Title="Friendship", Author=""
Output: {"isValid": false, "title": "Friendship", "author": "", "confidence": "low", "reason": "Too generic, not a distinctive book title"}

Remember: When in doubt, KEEP IT. Only reject if clearly not a real book. Respond with ONLY the JSON object, nothing else.`;

 try {
 const model = 'gemini-3-flash-preview';
 const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 const res = await fetch(`${endpoint}?key=${key}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 contents: [{ parts: [{ text: prompt }] }],
 generationConfig: {
 responseMimeType: 'application/json',
 temperature: 0.1,
 maxOutputTokens: 500,
 },
 }),
 });
 if (!res.ok) return book;
 const data = (await res.json()) as any;
 const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
 if (!content) return book;
 let analysis: any;
 try {
 analysis = JSON.parse(content);
 } catch {
 const jsonMatch = content.match(/\{[\s\S]*\}/);
 if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
 else return book;
 }
 if (analysis.isValid) {
 const correctedAuthor = analysis.author === null || analysis.author === '' ? null : (analysis.author || book.author);
 return {
 ...book,
 title: analysis.title || book.title,
 author: formatAuthorName(correctedAuthor),
 confidence: analysis.confidence || book.confidence,
 };
 } else {
 console.log(`[API] Gemini validation marked book as INVALID: "${book.title}" by ${book.author || 'no author'} - Reason: ${analysis.reason}`);
 return {
 ...book,
 title: analysis.title || book.title,
 author: analysis.author || book.author,
 confidence: 'invalid',
 isValid: false,
 chatgptReason: analysis.reason,
 };
 }
 } catch (err: any) {
 console.error(`[API] Gemini validation error for "${book.title}":`, err?.message || err);
 return book;
 }
}

async function validateBookWithChatGPT(book: any): Promise<any> {
 const key = process.env.OPENAI_API_KEY;
 if (!key) return book; // Return original if no key

 const controller = new AbortController();
 const timeoutMs = 35000; // 35 seconds per book - increased to reduce timeouts
 const timeout = setTimeout(() => {
 console.log(`[API] AbortController timeout triggered for "${book.title}" after ${timeoutMs}ms`);
 controller.abort();
 }, timeoutMs);

 const startTime = Date.now();
 try {
 const res = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Authorization: `Bearer ${key}`,
 },
 signal: controller.signal,
 body: JSON.stringify({
 model: 'gpt-4.1-mini', // Faster model for validation
 messages: [
 {
 role: 'user',
 content: `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author || '(no author)'}"
Confidence: ${book.confidence}

TASK: Determine if this is a real book. Be LENIENT - only mark as invalid if it's clearly junk (random words, obvious OCR garbage, not a real book title). If it's a real book (even with partial info), keep it and correct any obvious errors.

IMPORTANT RULES - BE LENIENT:
1. Books WITHOUT authors are VALID if the title is distinctive (e.g., "Fallingwater", "The Revolution", "Villareal")
2. Partial titles are VALID (e.g., "The Revolution" might be "Hamilton: The Revolution" - that's fine, keep it)
3. Only mark as INVALID if it's clearly not a real book (random words, obvious garbage, nonsensical titles)
4. CRITICAL: If title and author are swapped, ALWAYS fix them. Titles are book names, authors are people's names.
 - If "title" looks like a person's name (e.g., "John Smith", "Diana Gabaldon") and "author" looks like a book title, SWAP THEM
 - If "author" is clearly a book title (e.g., "The Great Gatsby", "Dragonfly in Amber") and "title" is a person's name, SWAP THEM
5. Fix obvious OCR errors (e.g., "owmen" "women")
6. Clean up titles (remove publisher prefixes, series numbers) but keep the core title

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name or null", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES OF VALID BOOKS (KEEP THESE):
Input: Title="The Revolution", Author="Hamilton"
Output: {"isValid": true, "title": "Hamilton: The Revolution", "author": "Lin-Manuel Miranda", "confidence": "high", "reason": "Real book, expanded title"}

Input: Title="Fallingwater", Author=""
Output: {"isValid": true, "title": "Fallingwater", "author": null, "confidence": "high", "reason": "Real book about famous building, author not required"}

Input: Title="Villareal", Author=""
Output: {"isValid": true, "title": "Villareal", "author": null, "confidence": "medium", "reason": "Could be real book, keep it"}

Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author - Diana Gabaldon is author, Dragonfly in Amber is title"}

Input: Title="John Smith", Author="The Great Novel"
Output: {"isValid": true, "title": "The Great Novel", "author": "John Smith", "confidence": "high", "reason": "Swapped title and author - John Smith is author, The Great Novel is title"}

EXAMPLES OF INVALID BOOKS (REJECT THESE):
Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book, random words"}

Input: Title="Kaufmann's", Author=""
Output: {"isValid": false, "title": "Kaufmann's", "author": "", "confidence": "low", "reason": "Not a book title, appears to be store name"}

Input: Title="Friendship", Author=""
Output: {"isValid": false, "title": "Friendship", "author": "", "confidence": "low", "reason": "Too generic, not a distinctive book title"}

Remember: When in doubt, KEEP IT. Only reject if clearly not a real book. Respond with ONLY the JSON object, nothing else.`,
 },
 ],
 max_tokens: 500,
 temperature: 0.1, // Lower temperature = more consistent
 }),
 });

 const elapsed = Date.now() - startTime;
 console.log(`[API] Validation API call completed for "${book.title}" in ${elapsed}ms`);

 if (!res.ok) {
 console.error(`[API] Validation failed for "${book.title}": ${res.status}, falling back to Gemini`);
 clearTimeout(timeout);
 return validateBookWithGemini(book);
 }

 const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
 const content = data.choices?.[0]?.message?.content?.trim();

 if (!content) return book;

 let analysis;
 try {
 analysis = JSON.parse(content);
 } catch {
 // Try extracting from code blocks
 const jsonMatch = content.match(/\{[\s\S]*\}/);
 if (jsonMatch) {
 analysis = JSON.parse(jsonMatch[0]);
 } else {
 return book;
 }
 }

 if (analysis.isValid) {
 // Valid book - return corrected version
 // Preserve null/empty authors if validation returns null
 const correctedAuthor = analysis.author === null || analysis.author === '' ? null : (analysis.author || book.author);
 return {
 ...book,
 title: analysis.title || book.title,
 author: formatAuthorName(correctedAuthor), // Format author name
 confidence: analysis.confidence || book.confidence,
 };
 } else {
 // Invalid book - mark as invalid so it can be filtered out
 console.log(`[API] Validation marked book as INVALID: "${book.title}" by ${book.author || 'no author'} - Reason: ${analysis.reason}`);
 return {
 ...book,
 title: analysis.title || book.title,
 author: analysis.author || book.author,
 confidence: 'invalid', // Mark as invalid
 isValid: false,
 chatgptReason: analysis.reason,
 };
 }
 } catch (e: any) {
 const elapsed = Date.now() - startTime;
 if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
 console.warn(`[API] Validation aborted for "${book.title}" after ${elapsed}ms, falling back to Gemini`);
 } else {
 console.error(`[API] Validation error for "${book.title}" after ${elapsed}ms:`, e?.message || e, '- falling back to Gemini');
 }
 return validateBookWithGemini(book);
 } finally {
 clearTimeout(timeout);
 }
}

/** Log type for fallback orchestration */
type FallbackLog = (msg: string, meta?: Record<string, unknown>) => void;

/** Safe preview for logs: truncate (and redact keys in body). Do not log key material or key metadata. */
function safePreview(str: string, max = 600): string {
 if (!str || typeof str !== 'string') return '';
 let s = str.trim();
 s = s.replace(/\bsk-[a-zA-Z0-9]{20,}/g, 'sk-redacted');
 return s.length <= max ? s : s.slice(0, max) + '(truncated)';
}

/**
 * Run OpenAI full-image scan with hard timeout and full error logging.
 * Uses Responses API (gpt-4.1-mini). Logs everything needed to debug without leaking secrets.
 */
async function runOpenAIForBooks(params: {
 scanId: string;
 imageBytes: Uint8Array | Buffer;
 mime: string;
 log: FallbackLog;
 timeoutMs: number;
 scanMetrics?: ScanMetrics;
}): Promise<any[]> {
 const { scanId, imageBytes, mime, log, timeoutMs, scanMetrics } = params;
 const bytes = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(imageBytes);

 const apiKey = process.env.OPENAI_API_KEY;
 log('[OPENAI] start', { scanId, bytes: bytes.length, mime, timeoutMs, env: process.env.VERCEL_ENV ?? 'unknown' });

 if (!apiKey) {
 throw new Error('OPENAI_API_KEY missing');
 }

 const controller = new AbortController();
 const t = setTimeout(() => controller.abort(), timeoutMs);
 const started = Date.now();

 try {
 const url = 'https://api.openai.com/v1/responses';
 const b64 = bytes.toString('base64');

 const body = {
 model: 'gpt-4.1-mini',
 input: [
 {
 role: 'user',
 content: [
 {
 type: 'input_text',
 text:
 'You are reading a bookshelf photo. Extract ALL book spines you can see. ' +
 'Return strict JSON array only. Each item: {title, author, spine_text, confidence}. ' +
 'If unsure, set title/author null but still include spine_text. No markdown.',
 },
 {
 type: 'input_image',
 image_url: `data:${mime};base64,${b64}`,
 },
 ],
 },
 ],
 };

 // Must-have: Which endpoint/model did we call?
 log('[OPENAI] request', {
 scanId,
 endpoint: url,
 model: body.model,
 imageBytes: bytes.length,
 });

 if (scanMetrics) {
 scanMetrics.openaiCalls += 1;
 scanMetrics.providers.add('openai');
 }

 const resp = await fetch(url, {
 method: 'POST',
 headers: {
 Authorization: `Bearer ${apiKey}`,
 'Content-Type': 'application/json',
 },
 body: JSON.stringify(body),
 signal: controller.signal,
 });

 const ms = Date.now() - started;
 const text = await resp.text();

 // Must-have: How long did it take? What HTTP status did we get?
 log('[OPENAI] response', {
 scanId,
 status: resp.status,
 ok: resp.ok,
 ms,
 bodyPreview: safePreview(text),
 });

 if (!resp.ok) {
 // Must-have: If it failed, what was the exact error payload (truncated)?
 log('[OPENAI] error_response', {
 scanId,
 status: resp.status,
 ms,
 errorPayload: safePreview(text),
 });
 throw new Error(`OpenAI HTTP ${resp.status}: ${safePreview(text)}`);
 }

 let jsonText = '';
 try {
 const parsed = JSON.parse(text);
 const out = parsed.output?.[0]?.content?.[0];
 jsonText =
 out?.type === 'output_text'
 ? out.text
 : parsed.output_text ?? '';

 if (!jsonText) {
 log('[OPENAI] warn: no output_text found', { scanId, keys: Object.keys(parsed ?? {}) });
 }
 } catch (e: unknown) {
 const msg = e instanceof Error ? e.message : String(e);
 throw new Error(`OpenAI JSON parse failed: ${msg}`);
 }

 log('[OPENAI] model_text_preview', { scanId, preview: safePreview(jsonText) });

 let books: any[] = [];
 try {
 books = JSON.parse(jsonText);
 if (!Array.isArray(books)) throw new Error('not an array');
 } catch (e: unknown) {
 const msg = e instanceof Error ? e.message : String(e);
 throw new Error(`OpenAI books JSON invalid: ${msg} | textPreview=${safePreview(jsonText)}`);
 }

 // Must-have: Did the response parse into books?
 log('[OPENAI] success', { scanId, books: books.length, parsedIntoBooks: true });
 return books;
 } catch (e: unknown) {
 const ms = Date.now() - started;
 const errMsg = e instanceof Error ? e.message : String(e);
 log('[OPENAI] failed', { scanId, ms, err: errMsg, parsedIntoBooks: false });
 throw e;
 } finally {
 clearTimeout(t);
 }
}

/**
 * Run tiles pipeline (split + Gemini per tile, merge + dedupe). Returns books array.
 */
async function runTilesPipeline(params: {
 scanId: string;
 fullImageBytes: Uint8Array | Buffer;
 mime: string;
 log: FallbackLog;
 checkCanceled?: () => Promise<boolean>;
 scanMetrics?: ScanMetrics;
}): Promise<any[]> {
 const { scanId, fullImageBytes, log, checkCanceled, scanMetrics } = params;
 const imageBuffer = Buffer.isBuffer(fullImageBytes) ? fullImageBytes : Buffer.from(fullImageBytes);
 const result = await scanWithGeminiTiles(imageBuffer, scanId, checkCanceled, scanMetrics);
 return result?.books ?? [];
}

/**
 * 45s fallback: run tiles and OpenAI in parallel, wait for both (up to their timeouts), merge and dedupe.
 */
async function runFallbackTilesAndOpenAI(params: {
 scanId: string;
 fullImageBytes: Uint8Array | Buffer;
 mime: string;
 log: FallbackLog;
 checkCanceled?: () => Promise<boolean>;
 openaiTimeoutMs?: number;
 scanMetrics?: ScanMetrics;
}): Promise<{ tilesBooks: any[]; openaiBooks: any[]; merged: any[] }> {
 const { scanId, fullImageBytes, mime, log, checkCanceled, openaiTimeoutMs = 35_000, scanMetrics } = params;

 log('[FALLBACK] starting tiles + openai', { scanId });

 const tilesPromise = runTilesPipeline({ scanId, fullImageBytes, mime, log, checkCanceled, scanMetrics });
 const openaiPromise = runOpenAIForBooks({
 scanId,
 imageBytes: Buffer.isBuffer(fullImageBytes) ? fullImageBytes : Buffer.from(fullImageBytes),
 mime,
 log,
 timeoutMs: openaiTimeoutMs,
 scanMetrics,
 });

 const [tilesRes, openaiRes] = await Promise.allSettled([tilesPromise, openaiPromise]);

 const tilesBooks = tilesRes.status === 'fulfilled' ? tilesRes.value : [];
 const openaiBooks = openaiRes.status === 'fulfilled' ? openaiRes.value : [];

 if (tilesRes.status === 'rejected') {
 log('[FALLBACK] tiles failed', { scanId, err: (tilesRes.reason as Error)?.message ?? String(tilesRes.reason) });
 }
 if (openaiRes.status === 'rejected') {
 log('[FALLBACK] openai failed', { scanId, err: (openaiRes.reason as Error)?.message ?? String(openaiRes.reason) });
 }

 log('[FALLBACK] done', { scanId, tiles: tilesBooks.length, openai: openaiBooks.length });

 // OpenAI as base; tiles only add. Never drop OpenAI entries because of tile conflicts.
 const merged = mergeTilesIntoOpenAIBase(openaiBooks, tilesBooks);
 log('[FALLBACK] merged', { scanId, merged: merged.length, openaiBase: openaiBooks.length });

 return { tilesBooks, openaiBooks, merged };
}

/**
 * Process a scan job - runs Gemini/OpenAI and updates Supabase
 * This function is called by the worker endpoint (/api/scan-worker)
 * Exported so it can be imported by the worker
 */
export async function processScanJob(
 imageDataURL: string,
 userId: string | undefined,
 scanId: string,
 jobId: string
): Promise<void> {
 console.log(`[SCAN_PROCESSOR] processScanJob_start`, { jobId, scanId, userId: userId ?? null, imageBytes: typeof imageDataURL === 'string' ? imageDataURL.length : 0 });

 // Initialize Supabase client for job updates
 // Standardize to SUPABASE_URL (not EXPO_PUBLIC_SUPABASE_URL) for server-side code
 const supabaseUrl = process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 
 if (!supabaseUrl || !supabaseServiceKey) {
 console.error(`[API] [SCAN ${scanId}] Database not configured for job updates`);
 return;
 }
 
 const { createClient } = await import('@supabase/supabase-js');
 // Server uses service role for all DB operations (scan_jobs, books); bypasses RLS. Do not use anon or user JWT here.
 const supabase = createClient(supabaseUrl, supabaseServiceKey, {
 auth: {
 autoRefreshToken: false,
 persistSession: false
 }
 });

 let overallTimedOut = false;

 /**
 * Check if job has been canceled or overall timeout fired
 * Returns true if should stop, false otherwise
 */
 const checkCanceled = async (): Promise<boolean> => {
 if (overallTimedOut) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan time budget exceeded, stopping`);
 return true;
 }
 const { data, error } = await supabase
 .from('scan_jobs')
 .select('cancel_requested, status')
 .eq('id', jobId)
 .is('deleted_at', null)
 .maybeSingle();
 
 if (error || !data) {
 return false; // If we can't check, continue processing
 }
 
 if (data.cancel_requested === true || data.status === 'canceled') {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Job canceled, stopping processing`);
 
 // Ensure status/stage are set to canceled
 const cancelRes = await supabase
 .from('scan_jobs')
 .update({
 status: 'canceled',
 stage: 'canceled',
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 const cancelCount = cancelRes.data?.length ?? 0;
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: null, stage: 'canceled', count: cancelCount, error: cancelRes.error?.message });
 return true;
 }
 
 return false;
 };

 /**
 * Helper to update scan job progress and stage
 * Rules:
 * - Never decrease progress (only move forward)
 * - Cap at 95 until final save, then set 100
 * - If job is already processing, don't overwrite backwards
 * - Don't update if job is canceled
 */
 const setProgress = async (
 progress: number,
 stage: string,
 stageDetail?: string
 ): Promise<void> => {
 // Check if canceled first - don't update progress if canceled
 if (await checkCanceled()) {
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
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Skipping progress update: ${cappedProgress} < ${currentProgress} (not decreasing)`);
 return;
 }
 }
 
 await writeScanProgress(supabase, jobId, cappedProgress, stage, stageDetail);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Progress: ${cappedProgress}%, Stage: ${stage}${stageDetail ? ` (${stageDetail})` : ''}`);
 };
 
 // Track scan metadata for logging and error reporting
 const scanMetadata: {
 received_image_bytes?: number;
 content_type?: string;
 parse_path?: string[];
 ended_reason?: string;
 } = {};
 
 // Validate and log image data
 try {
 if (!imageDataURL || typeof imageDataURL !== 'string') {
 scanMetadata.ended_reason = 'missing_image';
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ code: 'missing_image', message: 'imageDataURL is required' }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 console.error(`[API] [SCAN ${scanId}] Missing image data`);
 return;
 }
 
 // Extract image metadata
 const imageBytes = imageDataURL.length; // Approximate size
 scanMetadata.received_image_bytes = imageBytes;

 // Detect content type from data URL
 const dataUrlMatch = imageDataURL.match(/^data:([^;]+);base64,/);
 scanMetadata.content_type = dataUrlMatch ? dataUrlMatch[1] : 'unknown';

 let imageDimensions: { width?: number; height?: number } = {};
 try {
   const base64Data = imageDataURL.split(',')[1];
   if (base64Data) {
     const buf = Buffer.from(base64Data, 'base64');
     const sharp = (await import('sharp')).default;
     const meta = await sharp(buf).metadata();
     imageDimensions = { width: meta.width, height: meta.height };
   }
 } catch (_) { /* non-fatal */ }
 console.log(`[SCAN_PROCESSOR] after_image_fetch`, { jobId, scanId, bytes: imageBytes, dimensions: imageDimensions, contentType: scanMetadata.content_type });
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image received: ${imageBytes} bytes, type: ${scanMetadata.content_type}`);
 
 // Validate base64 data
 const base64Data = imageDataURL.split(',')[1];
 if (!base64Data || base64Data.length < 100) {
 scanMetadata.ended_reason = 'invalid_image';
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ code: 'invalid_image', message: 'Image data too small or invalid' }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 console.error(`[API] [SCAN ${scanId}] Invalid image data (too small)`);
 return;
 }
 
 scanMetadata.parse_path = ['image_validated'];
 } catch (imageError: any) {
 scanMetadata.ended_reason = 'image_validation_failed';
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ code: 'image_validation_failed', message: imageError?.message || 'Image validation error' }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 console.error(`[API] [SCAN ${scanId}] Image validation error:`, imageError);
 return;
 }
 
 // Update job status to processing
 await supabase
 .from('scan_jobs')
 .update({
 status: 'processing',
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 
 // Declare all variables at function scope for access in try/catch/finally blocks
 let enrichedBooks: any[] = [];
 let finalBooks: any[] = [];
 let geminiController: AbortController;
 let openaiController: AbortController;
 let geminiTimeout: NodeJS.Timeout | null = null;
 let openaiTimeout: NodeJS.Timeout | null = null;
 let overallTimeout: NodeJS.Timeout | null = null;
 let geminiAttempted = false;
 let openaiAttempted = false;
 let geminiBooks: any[] = [];
 let openaiBooks: any[] = [];
 let geminiResult: GeminiScanResult | null = null;
 
 // Helper function: Fix title/author swaps
 const fixSwappedBooks = (books: any[]) => {
 return books.map(book => {
 const title = book.title?.trim() || '';
 const author = book.author?.trim() || '';
 const titleLooksLikeName = title && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(title) && title.split(' ').length <= 4;
 const authorLooksLikeTitle = author && (author.toLowerCase().startsWith('the ') || author.length > 20);
 if (titleLooksLikeName && authorLooksLikeTitle) {
 return { ...book, title: author, author: formatAuthorName(title) };
 }
 return book;
 });
 };
 
 // Update job progress helper
 // Note: progress column may not exist - only update updated_at to keep job alive
 const updateProgress = async (stage: string, booksFound?: number) => {
 try {
 if (!scanMetadata.parse_path) scanMetadata.parse_path = [];
 if (!scanMetadata.parse_path.includes(stage)) {
 scanMetadata.parse_path.push(stage);
 }
 // Only update updated_at - progress column may not exist
 await supabase
 .from('scan_jobs')
 .update({
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 } catch (e) {
 // Ignore progress update errors
 }
 };
 
 /**
 * Assign work_key ONLY after final list (normalize dedupe validation).
 * Store by ISBN first, else sha1(normalized_title + normalized_author). Never use spine_text.
 */
 const assignWorkKeysToBooks = (books: any[]): any[] => {
 const sample = books[0];
 if (sample && (sample.title || sample.author)) {
 const t = (sample.title ?? '').trim();
 const a = (sample.author ?? '').trim();
 const normT = canonicalTitle(sample.title);
 const normA = canonicalAuthor(sample.author);
 const before = `"${t} | ${a}"`;
 const after = normT || normA ? `${normT}|${normA}` : '(empty)';
 console.log('[COVER] canonical keys sample:\nbefore:', before, '\nafter:', after);
 }
 return books.map(book => {
 const titleForKey = book.title != null && String(book.title).trim() !== String(book.spine_text || '').trim() ? book.title : undefined;
 const wk = buildWorkKey(book.isbn, titleForKey, book.author);
 return { ...book, work_key: wk || '' };
 });
 };

 /** Assign work_key to validated books from raw books by matching (title, author) so cover worker updates find the same key we enqueued. */
 const assignWorkKeysFromRaw = (cleanBooks: any[], rawBooks: any[]): any[] => {
 const rawKeyMap = new Map<string, string>();
 for (const r of rawBooks) {
 const k = `${canonicalTitle(r.title)}|${canonicalAuthor(r.author)}`;
 if (!rawKeyMap.has(k)) rawKeyMap.set(k, buildWorkKey(r.isbn, r.title, r.author) || '');
 }
 return cleanBooks.map(book => {
 const key = `${canonicalTitle(book.title)}|${canonicalAuthor(book.author)}`;
 const work_key = rawKeyMap.get(key) || buildWorkKey(book.isbn, book.title, book.author) || '';
 return { ...book, work_key };
 });
 };

 /**
 * GUARANTEED PIPELINE: Parse Normalize + Validate cleanBooks
 * This function ALWAYS runs normalization and validation before saving.
 * 
 * @param rawBooks - Raw books from API (parse step)
 * @returns cleanBooks - Normalized and validated books ready to save
 */
 const normalizeAndValidateBooks = async (rawBooks: any[]): Promise<any[]> => {
 // Caller MUST call enqueueCoversForScanBooks(rawBooks) BEFORE this step (even if book later fails validation).
 const dropPrefix = `[SCAN ${scanId}] [JOB ${jobId}]`;
 console.log(`[API] ${dropPrefix} PIPELINE: Normalizing and validating ${rawBooks.length} raw books...`);
 
 // Step 1: Fix title/author swaps (normalization)
 await updateProgress('normalizing', rawBooks.length);
 const fixedBooks = fixSwappedBooks(rawBooks);
 
 // Step 2: Deduplicate (normalization)
 const deduped = dedupeBooks(fixedBooks);
 
 // Step 3: Apply cheap validator (validation)
 await updateProgress('cheap_validating', deduped.length);
 const cheapValidated = deduped.map(book => cheapValidate(book).normalizedBook);
 cheapValidated.forEach((book, i) => {
 if (book.cheapFilterReason) {
 logDroppedBook(dropPrefix, i, book, [book.cheapFilterReason]);
 }
 });
 const cheapFiltered = cheapValidated.filter(book => !book.cheapFilterReason);
 
 // Step 4: Batch validate (validation)
 await updateProgress('batch_validating', cheapFiltered.length);
 const validatedBooks = await batchValidateBooks(cheapFiltered);
 validatedBooks.forEach((b, i) => { (b as any).raw_index = i; });
 validatedBooks.forEach((book, i) => {
 if (book.confidence === 'invalid' || book.isValid === false) {
 const reason = book.confidence === 'invalid' ? 'validation_invalid' : 'validation_no_match';
 logDroppedBook(dropPrefix, i, book, [reason]);
 }
 });
 const validBooks = validatedBooks.filter(book => book.confidence !== 'invalid' && book.isValid !== false);
 
 // Step 5: Final deduplication (normalization)
 const finalCleanBooks = dedupeBooks(validBooks, (dropped, reason, duplicateOf) => {
 const reasons = [duplicateOf != null ? `duplicate_of=${duplicateOf}` : reason];
 logDroppedBook(dropPrefix, (dropped as any).raw_index ?? -1, dropped, reasons, duplicateOf);
 });
 
 console.log(`[API] ${dropPrefix} PIPELINE: ${rawBooks.length} raw ${finalCleanBooks.length} clean books`);
 
 return finalCleanBooks;
 };
 
 try {
 // Time budget: 180s for hedged pipeline (raised from 120s until logic is stable; abort losing provider to avoid runaway)
 const TOTAL_TIMEOUT_MS = 180000;
 const scanStartTime = Date.now();
 const getElapsedMs = () => Date.now() - scanStartTime;
 const getRemainingMs = () => Math.max(0, TOTAL_TIMEOUT_MS - getElapsedMs());
 const MIN_BOOKS = 4;
 const HEDGE_DELAY_MS = 45000; // At 45s, start OpenAI hedge; do NOT cancel Gemini

 // Check API keys
 const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
 const hasGeminiKey = !!process.env.GEMINI_API_KEY;
 
 if (!hasOpenAIKey && !hasGeminiKey) {
 scanMetadata.ended_reason = 'api_keys_missing';
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ code: 'api_keys_missing', message: 'No API keys configured' }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId);
 console.error(`[API] [SCAN ${scanId}] ERROR: No API keys configured!`);
 return;
 }
 
 // Initialize AbortControllers
 geminiController = new AbortController();
 openaiController = new AbortController();
 
 // Watchdog: when time budget exceeded, mark job failed (do NOT abort Gemini)
 overallTimeout = setTimeout(() => {
 overallTimedOut = true;
 scanMetadata.ended_reason = 'timeout';
 openaiController.abort();
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan time budget (${TOTAL_TIMEOUT_MS / 1000}s) exceeded - stopping further processing`);
 void (async () => {
 const patch = {
 status: 'failed',
 error: JSON.stringify({ code: 'timeout', message: `Scan exceeded ${TOTAL_TIMEOUT_MS / 1000}s time budget`, metadata: scanMetadata }),
 updated_at: new Date().toISOString(),
 };
 const { data: upData, error } = await supabase.from('scan_jobs').update(patch).eq('id', jobId).select('id');
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(patch), count: upData?.length ?? 0, error: error?.message });
 if (error) console.error(`[API] Failed to update job ${jobId} on timeout:`, error.message);
 })();
 }, TOTAL_TIMEOUT_MS);
 
 const scanMetrics: ScanMetrics = {
 startTime: Date.now(),
 geminiCalls: 0,
 openaiCalls: 0,
 tileCount: 0,
 tileBytes: [],
 providers: new Set<string>(),
 };

 try {
 await setProgress(2, 'starting');
 await updateProgress('starting', 0);

 type PrimarySource = 'gemini' | 'openai';
 const savePrimary = async (source: PrimarySource, rawBooks: any[]) => {
 enqueueCoversForScanBooks(rawBooks, scanId, jobId);
 await setProgress(55, 'validating');
 await setProgress(70, 'validating');
 await setProgress(85, 'saving');
 const cleanBooks = await normalizeAndValidateBooks(rawBooks);
 const withWorkKey = assignWorkKeysFromRaw(cleanBooks, rawBooks);
 if (await checkCanceled()) return null;
 const booksToSave = withWorkKey.map((b: any) => sanitizeBookForDb(b));
 const samplePayload = booksToSave.slice(0, 2).map((b: any, i: number) => ({ index: i, title: String(b?.title ?? '').slice(0, 50), author: String(b?.author ?? '').slice(0, 30) }));
 console.log(`[SCAN_PROCESSOR] before_db_insert`, { jobId, scanId, count: booksToSave.length, sample: samplePayload });
 await writeScanProgress(supabase, jobId, 100, 'completed');
 const patch = { status: 'completed', books: booksToSave, error: null, updated_at: new Date().toISOString() };
 const { data: upData, error } = await supabase.from('scan_jobs').update(patch).eq('id', jobId).select('id');
 const insertedRowCount = upData?.length ?? 0;
 console.log(`[SCAN_PROCESSOR] after_db_insert`, { jobId, scanId, booksCreated: booksToSave.length, insertedRowCount, error: error?.message ?? null, errorDetails: error ? { code: error.code, details: (error as any).details } : null });
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(patch), count: insertedRowCount, error: error?.message });
 if (!error) {
 console.log('[SCAN_JOB_TERMINAL]', { jobId, status: 'completed', stage: 'completed', progress: 100, booksCount: booksToSave.length });
 }
 if (error) {
 const candidates = getBooksWithBackslash(booksToSave);
 for (const c of candidates) {
 console.error('[SAVE_PRIMARY_FAIL]', {
 jobId,
 bookIndex: c.index,
 title: c.title,
 author: c.author,
 field: c.field,
 valuePreview: c.valuePreview,
 backslashContext: c.backslashContext,
 });
 }
 if (candidates.length === 0) {
 console.error('[SAVE_PRIMARY_FAIL] no book with backslash in batch; first 3 titles', booksToSave.slice(0, 3).map((b: any, i: number) => ({ index: i, title: String(b?.title ?? '').slice(0, 60), author: String(b?.author ?? '').slice(0, 40) })));
 }
 throw new Error(`Failed to save primary: ${error.message}`);
 }
 const { count: sumCount, sample: sumSample } = summarizeBooksForLogs(booksToSave);
 console.info('[SCAN_JOB_SUMMARY]', {
 jobId,
 batchId: null,
 userId: userId ?? null,
 stage: 'completed',
 progress: 100,
 books: {
 ...sumCount,
 missingCover: sumCount.total - sumCount.withCover,
 missingDescription: sumCount.total - sumCount.withDescription,
 },
 sample: sumSample,
 });
 console.info('[SCAN_JOB_META_SUMMARY]', buildScanJobMetaSummary(jobId, booksToSave));
 if (userId) {
 try { await upsertBooksAndEnrichMetadata(supabase, userId, jobId, scanId, booksToSave); } catch (e: any) { console.warn(`[SCAN ${scanId}] [JOB ${jobId}] Metadata enrichment error:`, e?.message); }
 }
 return booksToSave;
 };

 // Hedged request: start Gemini; at +45s if Gemini already finished and passes quality skip OpenAI. Else start OpenAI.
 if (hasGeminiKey && hasOpenAIKey && !isGeminiQuotaExceeded() && !isGeminiInCooldown()) {
 if (await checkCanceled()) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Canceled before hedge, stopping`);
 return;
 }
 geminiAttempted = true;
 openaiAttempted = true;
 log('info', `[SCAN ${scanId}] [JOB ${jobId}] Hedged request: Gemini now, OpenAI at +${HEDGE_DELAY_MS / 1000}s only if Gemini not done or fails quality.`);
 await updateProgress('gemini', 0);

 const geminiState = { settled: false, parseOk: false };

 const pGemini = scanWithGemini(imageDataURL, scanId, undefined, scanMetrics); // NO ABORT
 const pOpenAI = delay(HEDGE_DELAY_MS).then(async () => {
 if (await checkCanceled()) return [];
 const geminiFinishedAndPasses = geminiState.settled && geminiState.parseOk;
 if (geminiFinishedAndPasses) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] At +45s: Gemini already finished and passes quality skip OpenAI entirely`);
 return [];
 }
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] At +45s: else start OpenAI`);
 await setProgress(50, 'openai_hedge');
 return scanWithOpenAI(imageDataURL, 0, openaiController, scanId, scanMetrics);
 });

 const wrapGemini = pGemini
 .then(r => {
 const books = r?.books ?? [];
 geminiState.settled = true;
 geminiState.parseOk = books.length >= MIN_BOOKS;
 return { source: 'gemini' as PrimarySource, books };
 })
 .catch((e: any) => {
 geminiState.settled = true;
 geminiState.parseOk = false;
 console.warn(`[SCAN ${scanId}] Gemini hedge failed:`, e?.message || e);
 return { source: 'gemini' as PrimarySource, books: [] };
 });
 const wrapOpenAI = pOpenAI
 .then(books => ({ source: 'openai' as PrimarySource, books: books ?? [] }))
 .catch((e: any) => {
 console.warn(`[SCAN ${scanId}] OpenAI hedge failed:`, e?.message || e);
 return { source: 'openai' as PrimarySource, books: [] };
 });

 const first = await Promise.race([wrapGemini, wrapOpenAI]);
 console.log(`[SCAN_PROCESSOR] after_ocr_vision`, { jobId, scanId, spine_candidates: first.books?.length ?? 0, source: first.source, detections: (first.books ?? []).length });
 let primaryBooks: any[] = first.books.length > 0 ? first.books : [];
 let primarySource: PrimarySource = first.source;
 if (primaryBooks.length === 0) {
 const other = await (first.source === 'gemini' ? wrapOpenAI : wrapGemini);
 console.log(`[SCAN_PROCESSOR] after_ocr_vision_other`, { jobId, scanId, other_source: other.source, other_candidates: other.books?.length ?? 0 });
 if (other.books.length > 0) {
 primaryBooks = other.books;
 primarySource = other.source;
 }
 }
 console.log(`[SCAN_PROCESSOR] after_parsing`, { jobId, scanId, book_candidates: primaryBooks.length, source: primarySource });

 // Abort losing provider so we don't burn budget: if Gemini won with good result, stop OpenAI immediately.
 if (primaryBooks.length > 0 && primarySource === 'gemini' && geminiState.parseOk && !openaiController.signal.aborted) {
 openaiController.abort();
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Gemini won with good result abort OpenAI to stay within budget`);
 }

 if (primaryBooks.length > 0) {
 enrichedBooks = await savePrimary(primarySource, primaryBooks) ?? [];
 if (enrichedBooks.length > 0) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Primary from ${primarySource}: ${enrichedBooks.length} books`);
 if (overallTimeout) clearTimeout(overallTimeout);
 // Only merge other source when Gemini is not trustworthy (recovery). Gemini clean use Gemini only; do NOT merge.
 const shouldMergeOther = primarySource === 'openai' || !geminiState.parseOk;
 if (shouldMergeOther) {
 const otherWrap = first.source === 'gemini' ? wrapOpenAI : wrapGemini;
 otherWrap.then(async (second) => {
 if (second.books.length === 0) return;
 try {
 const enrRaw = second.books;
 enqueueCoversForScanBooks(enrRaw, scanId, jobId);
 const enrClean = await normalizeAndValidateBooks(enrRaw);
 const enrWithKey = assignWorkKeysFromRaw(enrClean, enrRaw);
 const { data: row } = await supabase.from('scan_jobs').select('books').eq('id', jobId).is('deleted_at', null).single();
 const currentBooks = Array.isArray(row?.books) ? row.books : [];
 const merged = mergeTilesIntoOpenAIBase(currentBooks, enrWithKey);
 if (merged.length > currentBooks.length) {
 const booksToSaveMerge = merged.map((b: any) => sanitizeBookForDb(b));
 const mergePatch = { books: booksToSaveMerge, updated_at: new Date().toISOString() };
 const mergeUpdateResult = await supabase.from('scan_jobs').update(mergePatch).eq('id', jobId).select('id');
 const mergeCount = mergeUpdateResult.data?.length ?? 0;
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(mergePatch), count: mergeCount, error: mergeUpdateResult.error?.message });
 if (mergeUpdateResult.error) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enrichment merge update failed:`, mergeUpdateResult.error);
 console.error('DB_SAVE_FAIL_SAMPLE (enrichment merge)', booksToSaveMerge.slice(0, 5).map((b: any) => ({
 title: debugString(String(b.title ?? '')),
 author: debugString(String(b.author ?? '')),
 })));
 } else {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enrichment from ${second.source}: +${merged.length - currentBooks.length} books (total ${merged.length})`);
 }
 }
 } catch (e: any) {
 console.warn(`[SCAN ${scanId}] Enrichment merge failed:`, e?.message || e);
 }
 }).catch(() => {});
 } else {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Gemini clean use Gemini only, do not merge OpenAI`);
 }
 return;
 }
 }
 // Both returned empty fall through to no-books path
 scanMetadata.ended_reason = scanMetadata.ended_reason || 'no_books_detected';
 finalBooks = [];
 } else if (hasGeminiKey && !isGeminiQuotaExceeded() && !isGeminiInCooldown()) {
 if (await checkCanceled()) return;
 geminiAttempted = true;
 log('info', `[SCAN ${scanId}] [JOB ${jobId}] Starting Gemini only (no OpenAI key or cooldown).`);
 await updateProgress('gemini', 0);
 try {
 geminiResult = await scanWithGemini(imageDataURL, scanId, undefined, scanMetrics);
 geminiBooks = geminiResult?.books ?? [];
 if (geminiBooks.length >= MIN_BOOKS) {
 enrichedBooks = await savePrimary('gemini', geminiBooks) ?? [];
 if (enrichedBooks.length > 0 && overallTimeout) clearTimeout(overallTimeout);
 if (enrichedBooks.length > 0) return;
 }
 } catch (e: any) {
 console.warn(`[SCAN ${scanId}] Gemini only failed:`, e?.message || e);
 }
 finalBooks = geminiBooks;
 } else if (hasOpenAIKey) {
 if (await checkCanceled()) return;
 openaiAttempted = true;
 log('info', `[SCAN ${scanId}] [JOB ${jobId}] Starting OpenAI only.`);
 await updateProgress('openai', 0);
 try {
 openaiBooks = await scanWithOpenAI(imageDataURL, 0, openaiController, scanId, scanMetrics);
 if (openaiBooks.length >= MIN_BOOKS) {
 enrichedBooks = await savePrimary('openai', openaiBooks) ?? [];
 if (enrichedBooks.length > 0 && overallTimeout) clearTimeout(overallTimeout);
 if (enrichedBooks.length > 0) return;
 }
 } catch (e: any) {
 console.warn(`[SCAN ${scanId}] OpenAI only failed:`, e?.message || e);
 }
 finalBooks = openaiBooks;
 } else {
 scanMetadata.ended_reason = 'no_books_detected';
 finalBooks = [];
 }

 // Fallback path: we have finalBooks from single-provider or empty
 if (finalBooks.length === 0) {
 scanMetadata.ended_reason = scanMetadata.ended_reason || 'no_books_detected';
 }
 const rawBooks = finalBooks;
 enqueueCoversForScanBooks(rawBooks, scanId, jobId);
 if (await checkCanceled()) return;
 const cleanBooks = await normalizeAndValidateBooks(rawBooks);
 const finalBooksWithWorkKey = assignWorkKeysFromRaw(cleanBooks, rawBooks);
 enrichedBooks = finalBooksWithWorkKey;
 if (await checkCanceled()) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Canceled before saving (fallback path), stopping`);
 return;
 }
 
 // Check canceled before writing books
 if (await checkCanceled()) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Canceled before writing books (fallback path), stopping`);
 return;
 }
 
 // Check if validation filtered everything out
 if (enrichedBooks.length === 0 && rawBooks.length > 0) {
 scanMetadata.ended_reason = 'validation_failed';
 console.warn(`[SCAN ${scanId}] All books filtered out by validation`);
 } else if (enrichedBooks.length === 0) {
 scanMetadata.ended_reason = scanMetadata.ended_reason || 'no_books_detected';
 } else {
 scanMetadata.ended_reason = 'completed';
 }
 
 // Log final metadata with jobId correlation
 // Note: apiResults removed - api_results column doesn't exist in scan_jobs table
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan completed:`, {
 received_image_bytes: scanMetadata.received_image_bytes,
 content_type: scanMetadata.content_type,
 parse_path: scanMetadata.parse_path,
 ended_reason: scanMetadata.ended_reason,
 books_found: enrichedBooks.length
 });

 // SAFEGUARD: Scans NEVER write to library_books table
 // Scan results are ONLY stored in scan_jobs.books (JSONB column)
 // Only user approval action can insert into library_books
 const booksCreated = enrichedBooks.length;
 console.log(`[SCAN_PROCESSOR] books_created`, { jobId, scanId, booksCreated });
 if (booksCreated === 0) {
 console.log(`[SCAN_PROCESSOR] why_0`, { jobId, scanId, ended_reason: scanMetadata.ended_reason, parse_path: scanMetadata.parse_path, metadata: scanMetadata });
 }
 // Only mark job completed if booksCreated > 0 (insert succeeded). Do NOT set status completed when booksCreated === 0 unless we explicitly treat "no books found" as completed_empty.
 const finalStatus = booksCreated > 0 ? 'completed' : 'failed';
 const finalError = booksCreated === 0 ? JSON.stringify({
 code: scanMetadata.ended_reason || 'no_books_detected',
 message: 'No books detected after validation',
 metadata: scanMetadata
 }) : null;

 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan results stored in scan_jobs.books only (NOT library_books). status=${finalStatus} (booksCreated=${booksCreated})`);
 
 // Check canceled before marking complete
 if (await checkCanceled()) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Canceled before marking complete (fallback path), stopping`);
 return;
 }
 
 // Step 4: Update scan_jobs status to 'completed' IMMEDIATELY after books are saved (early response)
 // Sanitize user-facing strings before DB insert (NUL, unpaired surrogates)
 const booksToSave = enrichedBooks.map((b: any) => sanitizeBookForDb(b));
 const samplePayload = booksToSave.slice(0, 2).map((b: any, i: number) => ({ index: i, title: String(b?.title ?? '').slice(0, 50), author: String(b?.author ?? '').slice(0, 30) }));
 console.log(`[SCAN_PROCESSOR] before_db_insert (fallback path)`, { jobId, scanId, count: booksToSave.length, sample: samplePayload, finalStatus });
 await setProgress(95, 'saving');

 const updateResult = await supabase
 .from('scan_jobs')
 .update({
 status: finalStatus,
 stage: finalStatus === 'completed' ? 'completed' : 'failed',
 progress: finalStatus === 'completed' ? 100 : 95, // NOT NULL: use 95 for failed
 books: booksToSave,
 error: finalError,
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 const updateCount = updateResult.data?.length ?? 0;
 console.log(`[SCAN_PROCESSOR] after_db_insert (fallback path)`, { jobId, scanId, booksCreated: booksToSave.length, insertedRowCount: updateCount, error: updateResult.error?.message ?? null, errorDetails: updateResult.error ? { code: updateResult.error.code, details: (updateResult.error as any).details } : null });
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: finalStatus === 'completed' ? 100 : 95, stage: finalStatus === 'completed' ? 'completed' : 'failed', count: updateCount, error: updateResult.error?.message });
 console.log(`[WORKER] STAGE: save scan_jobs.books complete`, { jobId, scanId, status: finalStatus });
 if (updateResult.error) {
 // CRITICAL: If DB update fails, treat as failed - don't log success
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] FAILED to update job with books:`, updateResult.error);
 const candidates = getBooksWithBackslash(booksToSave);
 for (const c of candidates) {
 console.error('[SAVE_PRIMARY_FAIL]', {
 jobId,
 bookIndex: c.index,
 title: c.title,
 author: c.author,
 field: c.field,
 valuePreview: c.valuePreview,
 backslashContext: c.backslashContext,
 });
 }
 if (candidates.length === 0) {
 console.error('[SAVE_PRIMARY_FAIL] no book with backslash in batch; first 3', booksToSave.slice(0, 3).map((b: any, i: number) => ({ index: i, title: String(b?.title ?? '').slice(0, 60), author: String(b?.author ?? '').slice(0, 40) })));
 }
 console.error('DB_SAVE_FAIL_SAMPLE', booksToSave.slice(0, 5).map((b: any) => ({
 title: debugString(String(b.title ?? '')),
 author: debugString(String(b.author ?? '')),
 })));
 // Try to update job as failed with error about the DB update failure
 const failRes = await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 stage: 'failed',
 progress: 95, // NOT NULL
 error: JSON.stringify({
 code: 'db_update_failed',
 message: `Failed to save books to database: ${updateResult.error.message || String(updateResult.error)}`
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: 95, stage: 'failed', count: failRes.data?.length ?? 0, error: failRes.error?.message });
 // Throw error so it's caught by outer catch block
 throw new Error(`Failed to update job with books: ${updateResult.error.message || String(updateResult.error)}`);
 } else {
 if (finalStatus === 'completed') {
 console.log('[SCAN_JOB_TERMINAL]', { jobId, status: finalStatus, stage: 'completed', progress: 100, booksCount: booksToSave.length });
 }
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] PIPELINE COMPLETE: Saved ${enrichedBooks.length} books to scan_jobs.books (status=${finalStatus})`);
 const { count: sumCount, sample: sumSample } = summarizeBooksForLogs(booksToSave);
 console.info('[SCAN_JOB_SUMMARY]', {
 jobId,
 batchId: null,
 userId: userId ?? null,
 stage: finalStatus,
 progress: finalStatus === 'completed' ? 100 : 95,
 books: {
 ...sumCount,
 missingCover: sumCount.total - sumCount.withCover,
 missingDescription: sumCount.total - sumCount.withDescription,
 },
 sample: sumSample,
 });
 console.info('[SCAN_JOB_META_SUMMARY]', buildScanJobMetaSummary(jobId, booksToSave));
 if (userId) {
 try { await upsertBooksAndEnrichMetadata(supabase, userId, jobId, scanId, booksToSave); } catch (e: any) { console.warn(`[SCAN ${scanId}] [JOB ${jobId}] Metadata enrichment error:`, e?.message); }
 }
 }
 
 console.log(`[WORKER] STAGE: done`, { jobId, scanId, booksCount: enrichedBooks.length, status: finalStatus });
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan job completed: ${enrichedBooks.length} books, status=${finalStatus}`);
 } catch (err: any) {
 throw err;
 } finally {
 logScanMetrics(scanId, jobId, scanMetrics, enrichedBooks?.length ?? 0);
 }
 } catch (err: any) {
 console.error(`[SCAN ${scanId}] Scan error:`, err?.message || err);
 scanMetadata.ended_reason = scanMetadata.ended_reason || 'scan_exception';
 if (err?.name === 'AbortError') {
 scanMetadata.ended_reason = 'request_aborted';
 }
 // If error occurred, still try to process any books we have
 if (finalBooks.length > 0) {
 try {
 const rawBooks = finalBooks;
 // Enqueue covers BEFORE normalize/validate (even if book later fails validation)
 enqueueCoversForScanBooks(rawBooks, scanId, jobId);
 const cleanBooks = await normalizeAndValidateBooks(rawBooks);
 const finalBooksWithWorkKey = assignWorkKeysFromRaw(cleanBooks, rawBooks);
 enrichedBooks = finalBooksWithWorkKey;
 const finalStatus = enrichedBooks.length > 0 ? 'completed' : 'failed';
 const finalError = enrichedBooks.length === 0 ? JSON.stringify({
 code: scanMetadata.ended_reason || 'scan_exception',
 message: err?.message || String(err),
 metadata: scanMetadata
 }) : null;
 
 const booksToSaveRecovery = enrichedBooks.map((b: any) => sanitizeBookForDb(b));
 const recoveryUpdateResult = await supabase
 .from('scan_jobs')
 .update({
 status: finalStatus,
 stage: finalStatus === 'completed' ? 'completed' : 'failed',
 progress: finalStatus === 'completed' ? 100 : 95,
 books: booksToSaveRecovery,
 error: finalError,
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: finalStatus === 'completed' ? 100 : 95, stage: finalStatus === 'completed' ? 'completed' : 'failed', count: recoveryUpdateResult.data?.length ?? 0, error: recoveryUpdateResult.error?.message });
 if (!recoveryUpdateResult.error && finalStatus === 'completed') {
 console.log('[SCAN_JOB_TERMINAL]', { jobId, status: finalStatus, stage: 'completed', progress: 100, booksCount: booksToSaveRecovery.length });
 }
 if (recoveryUpdateResult.error) {
 console.error('DB_SAVE_FAIL_SAMPLE (recovery)', booksToSaveRecovery.slice(0, 5).map((b: any) => ({
 title: debugString(String(b.title ?? '')),
 author: debugString(String(b.author ?? '')),
 })));
 } else {
 const { count: sumCount, sample: sumSample } = summarizeBooksForLogs(booksToSaveRecovery);
 console.info('[SCAN_JOB_SUMMARY]', {
 jobId,
 batchId: null,
 userId: userId ?? null,
 stage: finalStatus,
 progress: finalStatus === 'completed' ? 100 : 95,
 books: {
 ...sumCount,
 missingCover: sumCount.total - sumCount.withCover,
 missingDescription: sumCount.total - sumCount.withDescription,
 },
 sample: sumSample,
 recovery: true,
 });
 console.info('[SCAN_JOB_META_SUMMARY]', buildScanJobMetaSummary(jobId, booksToSaveRecovery, { recovery: true }));
 if (userId) {
 try { await upsertBooksAndEnrichMetadata(supabase, userId, jobId, scanId, booksToSaveRecovery); } catch (e: any) { console.warn(`[SCAN ${scanId}] [JOB ${jobId}] Metadata enrichment error (recovery):`, e?.message); }
 }
 }
 } catch (recoveryError) {
 // If recovery also fails, mark job as failed
 const recoveryFailRes = await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 progress: 95, // NOT NULL
 error: JSON.stringify({
 code: 'scan_exception',
 message: err?.message || String(err),
 metadata: scanMetadata
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: 95, stage: 'failed', count: recoveryFailRes.data?.length ?? 0, error: recoveryFailRes.error?.message });
 }
 } else {
 // No books to process, mark as failed
 const noBooksRes = await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 progress: 95, // NOT NULL
 error: JSON.stringify({
 code: 'scan_exception',
 message: err?.message || String(err),
 metadata: scanMetadata
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: 95, stage: 'failed', count: noBooksRes.data?.length ?? 0, error: noBooksRes.error?.message });
 }
 } finally {
 if (geminiTimeout) clearTimeout(geminiTimeout);
 if (openaiTimeout) clearTimeout(openaiTimeout);
 if (overallTimeout) clearTimeout(overallTimeout);
 // Do NOT abort Gemini (hedged request: Gemini keeps running in background)
 if (!openaiController.signal.aborted) openaiController.abort();
 }
 
 // Handle errors that occurred during the scan
 if (scanMetadata.ended_reason && scanMetadata.ended_reason !== 'completed') {
 const errorCode = scanMetadata.ended_reason;
 const errorMessage = scanMetadata.ended_reason === 'no_books_detected' 
 ? 'No books detected after validation'
 : scanMetadata.ended_reason;
 
 console.error(`[API] Scan job ${jobId} failed:`, errorMessage);
 console.error(`[API] [SCAN ${scanId}] Error metadata:`, {
 received_image_bytes: scanMetadata.received_image_bytes,
 content_type: scanMetadata.content_type,
 parse_path: scanMetadata.parse_path,
 ended_reason: scanMetadata.ended_reason,
 });
 
 const endFailRes = await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 progress: 95, // NOT NULL
 error: JSON.stringify({
 code: errorCode,
 message: errorMessage,
 metadata: scanMetadata
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', jobId)
 .select('id');
 console.log('[SCAN_PROGRESS_WRITE]', { jobId, pct: 95, stage: 'failed', count: endFailRes.data?.length ?? 0, error: endFailRes.error?.message });
 }
}

/**
 * Ensure a profile row exists in public.profiles table
 * This is called before inserting books to maintain FK integrity
 * HARD FAIL: If this fails, the scan job will be marked as failed
 * @param supabase - Supabase client with service role key
 * @param userId - User ID from auth (can be null/undefined for guest users)
 * @returns true if profile row was created/exists, throws error if creation fails
 * @throws Error if profile creation fails (will be caught and job marked failed)
 */
/**
 * Ensure profile row exists for an authenticated user
 * CRITICAL: This function should ONLY be called with userId from Supabase Auth (verified JWT)
 * DO NOT call this with random/non-auth user IDs - it will fail FK constraints
 * Guest users (null userId) are skipped - they don't need profiles
 * 
 * @param supabase - Supabase client (service role key)
 * @param userId - User ID from verified Supabase Auth token (auth.uid()), or null for guests
 * @returns true if profile exists or was created, false if userId is null/undefined (guest)
 * @throws Error if profile creation fails (hard fail for authenticated users)
 */
async function ensureProfileRow(supabase: any, userId: string | null | undefined): Promise<boolean> {
 // CRITICAL: Authentication is required - userId must never be null/undefined
 // This function should only be called with verified user IDs from Supabase Auth
 if (!userId) {
 const errorMsg = 'ensureProfileRow called with null/undefined userId - authentication is required';
 console.error(`[API] CRITICAL: ${errorMsg}`);
 throw new Error(errorMsg);
 }
 
 try {
 // Generate username if not provided (format: user_<first8charsOfId>)
 // This matches the trigger function, but we do it here too for safety
 const userIdWithoutHyphens = userId.replace(/-/g, '');
 const generatedUsername = `user_${userIdWithoutHyphens.substring(0, 8)}`;
 console.log('[USERNAME_DEFAULT] generated=', generatedUsername, 'reason=missing_profile|missing_username');
 
 // Upsert profile row - no-op if it already exists
 // Use id = userId (UUID from auth.users) - MUST be from verified Supabase Auth token
 // Provide generated username - trigger will also set it if missing, but this is safer
 // Username is now nullable, so this won't fail even if trigger doesn't run
 const { data, error } = await supabase
 .from('profiles')
 .upsert({ id: userId, username: generatedUsername }, { onConflict: 'id', ignoreDuplicates: true })
 .select('id, username')
 .maybeSingle();
 
 if (error) {
 // If error is "duplicate key" or similar, profile already exists - that's fine
 if (error.code === '23505' || error.message?.includes('duplicate') || error.message?.includes('already exists')) {
 console.log(`[API] Profile row already exists: ${userId}`);
 return true; // Return true - profile exists, that's what we need
 }
 // Other errors are CRITICAL - throw to fail the job
 const errorMsg = `Failed to ensure profile row for ${userId}: ${error.message || error.code || JSON.stringify(error)}`;
 console.error(`[API] CRITICAL: ${errorMsg}`);
 throw new Error(errorMsg);
 }
 
 // If data is returned, profile was created or already existed
 if (data) {
 console.log(`[API] Profile row exists: ${userId}`);
 return true;
 }
 
 // If no data and no error, profile already existed (upsert returned nothing but no error)
 console.log(`[API] Profile row already exists: ${userId}`);
 return true;
 } catch (err: any) {
 // Re-throw - this is a hard fail, don't catch it here
 const errorMsg = err?.message || String(err);
 console.error(`[API] CRITICAL: Exception ensuring profile row for ${userId}: ${errorMsg}`);
 throw err; // Re-throw to be caught by caller
 }
}

/**
 * Guest scan: run vision pipeline only, no Supabase Storage or DB writes.
 * Returns normalized/validated books for client to display; client gets 1 scan as guest.
 */
export async function runGuestScan(imageDataURL: string): Promise<{ books: any[] }> {
 const scanId = 'guest-' + (await import('crypto')).randomUUID();
 const scanMetrics: ScanMetrics = {
 startTime: Date.now(),
 geminiCalls: 0,
 openaiCalls: 0,
 tileCount: 0,
 tileBytes: [],
 providers: new Set(),
 };

 if (!process.env.GEMINI_API_KEY) {
 console.warn('[API] [GUEST_SCAN] No GEMINI_API_KEY, returning empty books');
 return { books: [] };
 }

 const geminiResult = await scanWithGemini(imageDataURL, scanId, undefined, scanMetrics);
 const rawBooks = geminiResult?.books ?? [];

 const fixSwappedBooks = (books: any[]) =>
 books.map((book: any) => {
 const title = (book.title ?? '').trim();
 const author = (book.author ?? '').trim();
 const titleLooksLikeName = title && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(title) && title.split(' ').length <= 4;
 const authorLooksLikeTitle = author && (author.toLowerCase().startsWith('the ') || author.length > 20);
 if (titleLooksLikeName && authorLooksLikeTitle) {
 return { ...book, title: author, author: formatAuthorName(title) };
 }
 return book;
 });

 const fixed = fixSwappedBooks(rawBooks);
 const deduped = dedupeBooks(fixed);
 const cheapValidated = deduped.map((book: any) => cheapValidate(book).normalizedBook);
 const cheapFiltered = cheapValidated.filter((book: any) => !(book as any).cheapFilterReason);
 const validated = await batchValidateBooks(cheapFiltered);
 const validBooks = validated.filter((b: any) => b.confidence !== 'invalid' && b.isValid !== false);
 const finalDeduped = dedupeBooks(validBooks);
 const withWorkKey = finalDeduped.map((book: any) => ({
 ...book,
 work_key: buildWorkKey(book.isbn, book.title, book.author) || '',
 }));

 console.log(`[API] [GUEST_SCAN] ${scanId} books=${withWorkKey.length}`);
 return { books: withWorkKey };
}

/** Decode JWT payload (second segment) to get iss. Safety check: only accept tokens issued by our Supabase. */

/** Request body limit: ask for 10mb where the runtime supports it (e.g. Next.js bodyParser). On Vercel the platform enforces 4.5MB before the handler — that cannot be increased; use metadata-only (photoId, storagePath) and do not send image bytes. See docs/API_BODY_LIMITS_413.md for Cloudflare/NGINX/Express. */
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
 // Build marker to confirm deployed code version
 console.log("[API] scan.ts build marker: 2026-02-04T21:XX publish-timeout-v1");
 
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
 
 const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 try {
 const { imageDataURL, batchId, index, total, photoId: bodyPhotoId, storagePath: bodyStoragePath, client_request_id: clientRequestId } = req.body || {};
 const photoIdFromClient = typeof bodyPhotoId === 'string' && bodyPhotoId.trim() ? bodyPhotoId.trim() : null;
 const validPhotoId = photoIdFromClient && UUID_REGEX.test(photoIdFromClient) ? photoIdFromClient : null;
 const storagePathFromClient = typeof bodyStoragePath === 'string' && bodyStoragePath.trim() ? bodyStoragePath.trim() : null;
 const isMetadataOnly = !!validPhotoId && !!storagePathFromClient && (!imageDataURL || typeof imageDataURL !== 'string');
 if (clientRequestId != null) console.log('[API] [SCAN] client_request_id', String(clientRequestId).slice(0, 36));
 if (!isMetadataOnly && (!imageDataURL || typeof imageDataURL !== 'string')) {
 return res.status(400).json({ 
 status: 'error',
 error: { code: 'missing_image', message: 'imageDataURL is required (or send photoId + storagePath for metadata-only)' }
 });
 }

 const MAX_DECODED_BYTES = 10 * 1024 * 1024; // 10MB (used below for image path)
 // Metadata-only path: skip image validation and guest path; will be handled after auth
 if (!isMetadataOnly) {
 // Input validation: allowed content-types and size cap (reject before auth/heavy work)
 const ALLOWED_DATA_URL = /^data:image\/(jpeg|png|webp);base64,/i;
 const MAX_BASE64_LENGTH = Math.ceil(MAX_DECODED_BYTES * 4 / 3);
 if (!ALLOWED_DATA_URL.test(imageDataURL)) {
 return res.status(400).json({
 status: 'error',
 error: { code: 'invalid_content_type', message: 'imageDataURL must be data:image/jpeg;base64,, image/png;base64,, or image/webp;base64,' },
 });
 }
 const base64Part = imageDataURL.indexOf(',') >= 0 ? imageDataURL.split(',')[1] : '';
 if (!base64Part || base64Part.length > MAX_BASE64_LENGTH) {
 return res.status(400).json({
 status: 'error',
 error: { code: 'image_too_large', message: `Image decoded size must not exceed ${MAX_DECODED_BYTES / (1024 * 1024)}MB` },
 });
 }

 // Mode A Guest scan: no auth, no Supabase writes, low rate limit per IP, hard size limit
 const isGuest = (req.body as any)?.guest === true;
 if (isGuest) {
 const GUEST_MAX_DECODED_BYTES = 5 * 1024 * 1024; // 5MB for guest
 const GUEST_MAX_BASE64_LENGTH = Math.ceil(GUEST_MAX_DECODED_BYTES * 4 / 3);
 if (!base64Part || base64Part.length > GUEST_MAX_BASE64_LENGTH) {
 return res.status(400).json({
 status: 'error',
 error: { code: 'image_too_large', message: 'Guest scan: image must not exceed 5MB' },
 });
 }
 const guestRateLimitResult = await checkRateLimit(req, 'scan_guest');
 if (!guestRateLimitResult.success) {
 sendRateLimitResponse(res, guestRateLimitResult);
 return;
 }
 try {
 const { books } = await runGuestScan(imageDataURL);
 const crypto = await import('crypto');
 const guestScanId = crypto.randomUUID();
 const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
 return res.status(200).json({
 ok: true,
 pendingBooks: books,
 guestScanId,
 expiresAt,
 });
 } catch (guestErr: any) {
 console.error('[API] [SCAN] Guest scan failed:', guestErr?.message ?? guestErr);
 return res.status(500).json({
 ok: false,
 error: { code: 'guest_scan_failed', message: guestErr?.message ?? 'Guest scan failed' },
 });
 }
 }
 }

 const authHeader = req.headers.authorization || '';
 const token = authHeader.startsWith('Bearer ') ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

 if (!token) {
 console.error('[API] [SCAN] No Authorization header provided');
 return res.status(401).json({ ok: false, error: 'reauth_required' });
 }

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

 if (!supabaseUrl || !supabaseServiceKey) {
 console.error('[API] [SCAN] Supabase configuration missing');
 return res.status(500).json({ status: 'error', error: { code: 'server_config_error', message: 'Server configuration error' } });
 }

 const { createClient } = await import('@supabase/supabase-js');
 const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
 auth: { autoRefreshToken: false, persistSession: false }
 });

 const { data, error } = await supabaseAdmin.auth.getUser(token);
 if (error || !data?.user) {
 console.error('[API] [SCAN] getUser failed:', error?.message ?? error);
 return res.status(401).json({ ok: false, error: 'reauth_required' });
 }
 const userId = data.user.id;

 const rateLimitResult = await checkRateLimit(req, 'scan', { userId });
 if (!rateLimitResult.success) {
 sendRateLimitResponse(res, rateLimitResult);
 return;
 }

 const supabase = supabaseAdmin;

 // Idempotent Step C: one scan_job per photo_id. Accept photoId and storagePath; get-or-create by photo_id.
 if (validPhotoId && (isMetadataOnly || storagePathFromClient)) {
 const { data: existingJob } = await supabase
 .from('scan_jobs')
 .select('id, status, scan_id')
 .eq('photo_id', validPhotoId)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 let dbJobId: string | undefined;
 let scanIdForPublish: string | undefined;
 if (existingJob) {
 dbJobId = existingJob.id;
 scanIdForPublish = (existingJob as { scan_id?: string }).scan_id ?? `scan_${dbJobId}`;
 console.log(`[API] [SCAN] Idempotent: returning existing job`, { photoId: validPhotoId, jobId: dbJobId, status: existingJob.status });
 } else if (isMetadataOnly && storagePathFromClient) {
 const crypto = await import('crypto');
 dbJobId = crypto.randomUUID();
 scanIdForPublish = `scan_${dbJobId}`;
 const nowIso = new Date().toISOString();
 const { error: insertErr } = await supabase.from('scan_jobs').insert({
 id: dbJobId,
 user_id: userId,
 photo_id: validPhotoId,
 image_path: storagePathFromClient,
 status: 'pending',
 stage: 'queued',
 progress: 0,
 books: [],
 scan_id: scanIdForPublish,
 created_at: nowIso,
 updated_at: nowIso,
 });
 if (insertErr) {
 const code = (insertErr as { code?: string })?.code;
 if (code === '23505') {
 const { data: raceJob } = await supabase
 .from('scan_jobs')
 .select('id, status, scan_id')
 .eq('photo_id', validPhotoId)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 if (raceJob) {
 dbJobId = raceJob.id;
 scanIdForPublish = (raceJob as { scan_id?: string }).scan_id ?? `scan_${dbJobId}`;
 console.log(`[API] [SCAN] Idempotent: unique violation, returning existing job`, { photoId: validPhotoId, jobId: dbJobId });
 } else {
 return res.status(500).json({ status: 'error', error: { code: 'job_insert_failed', message: insertErr.message } });
 }
 } else {
 console.error('[API] [SCAN] metadata-only job insert failed', insertErr.message);
 return res.status(500).json({ status: 'error', error: { code: 'job_insert_failed', message: insertErr.message } });
 }
 } else {
 console.log(`[API] [SCAN] Created job from metadata-only`, { photoId: validPhotoId, jobId: dbJobId, storagePath: storagePathFromClient.slice(0, 50) });
 }
 }
 if (dbJobId && scanIdForPublish) {
 // If the existing job is in a terminal state (failed/completed), reset to pending
 // so the worker can re-claim it. This handles retries after previous failures.
 if (existingJob && (existingJob.status === 'failed' || existingJob.status === 'completed')) {
 console.log(`[API] [SCAN] Resetting ${existingJob.status} job to pending for retry`, { jobId: dbJobId, photoId: validPhotoId });
 await supabase.from('scan_jobs').update({ status: 'pending', error: null, updated_at: new Date().toISOString() }).eq('id', dbJobId);
 }

 const qstashToken = process.env.QSTASH_TOKEN;
 const qstashBase = process.env.QSTASH_URL?.replace(/\/+$/, '');
 if (qstashToken && qstashBase) {
 const workerUrl = 'https://www.bookshelfscan.app/api/scan-worker';
 const publishUrl = `${qstashBase}/v2/publish/${workerUrl}`;
 const payload = { jobId: dbJobId, scanId: scanIdForPublish, userId };
 try {
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
   const pubResp = await fetch(publishUrl, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qstashToken}` },
   body: JSON.stringify(payload),
   signal: controller.signal,
   });
   clearTimeout(timeout);
   if (pubResp.ok) {
   console.log(`[API] [SCAN] QStash publish ok (metadata-only)`, { jobId: dbJobId, photoId: validPhotoId });
   return res.status(202).json({ jobId: dbJobId, photoId: validPhotoId, status: 'pending' });
   }
   console.error(`[API] [SCAN] QStash publish failed (metadata-only)`, { photoId: validPhotoId, jobId: dbJobId, status: pubResp?.status, body: (await pubResp.text().catch(() => '')).slice(0, 200) });
   // Mark job as failed so client doesn't poll forever
   await supabase.from('scan_jobs').update({ status: 'failed', error: JSON.stringify({ code: 'qstash_publish_failed', message: `QStash publish returned ${pubResp?.status}` }), updated_at: new Date().toISOString() }).eq('id', dbJobId);
   return res.status(500).json({ error: 'qstash_publish_failed', jobId: dbJobId, status: 'failed' });
 } catch (err: any) {
   const isTimeout = err?.name === 'AbortError';
   console.error(`[API] [SCAN] QStash publish error (metadata-only)`, { photoId: validPhotoId, jobId: dbJobId, error: err?.message, isTimeout });
   // Mark job as failed so client doesn't poll forever
   await supabase.from('scan_jobs').update({ status: 'failed', error: JSON.stringify({ code: isTimeout ? 'qstash_publish_timeout' : 'qstash_publish_error', message: err?.message }), updated_at: new Date().toISOString() }).eq('id', dbJobId);
   return res.status(500).json({ error: isTimeout ? 'qstash_publish_timeout' : 'qstash_publish_error', jobId: dbJobId, status: 'failed' });
 }
 }
 // No QStash configured — mark job as failed
 if (dbJobId) {
   await supabase.from('scan_jobs').update({ status: 'failed', error: JSON.stringify({ code: 'qstash_not_configured', message: 'Worker service not available' }), updated_at: new Date().toISOString() }).eq('id', dbJobId);
   return res.status(500).json({ error: 'qstash_not_configured', jobId: dbJobId, status: 'failed' });
 }
 }
 }

 const opId = generateOpId();
 console.log(scanLogPrefix('SCAN', { opId, userId, batchId: batchId ?? undefined }));
 
 // Log batch information if provided
 if (batchId && typeof index === 'number' && typeof total === 'number') {
 console.log(`[API] ${scanLogPrefix('SCAN', { opId, userId, batchId })} [${index}/${total}] Creating scan job`);
 }

 // Generate jobId for this scan with high entropy to prevent collisions
 // Use crypto.randomUUID() if available, otherwise use timestamp + counter + random
 let jobId: string;
 let scanId: string;
 try {
 const crypto = await import('crypto');
 // Use crypto.randomUUID() for maximum uniqueness (128 bits of entropy)
 const uuid = crypto.randomUUID();
 jobId = `job_${uuid}`;
 scanId = `scan_${uuid}`;
 } catch {
 // Fallback: timestamp + high-precision counter + random string
 // Add process.hrtime() for sub-millisecond precision
 const hrtime = process.hrtime();
 const counter = (global as any).__scanJobCounter = ((global as any).__scanJobCounter || 0) + 1;
 const randomStr = Math.random().toString(36).substring(2, 15); // Longer random string
 jobId = `job_${Date.now()}_${hrtime[1]}_${counter}_${randomStr}`;
 scanId = `scan_${Date.now()}_${hrtime[1]}_${counter}_${randomStr}`;
 }
 
 // Ensure profile row exists before proceeding (maintains FK integrity)
 // CRITICAL: userId is always set (authentication is required)
 // HARD FAIL: If this fails, job will be marked as failed
 try {
 await ensureProfileRow(supabase, userId);
 } catch (profileError: any) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Failed to ensure profile row for authenticated user ${userId}, marking job as failed`);
 const patch = {
 status: 'failed',
 error: JSON.stringify({ type: 'profile_creation_failed', message: profileError?.message || String(profileError) }),
 updated_at: new Date().toISOString(),
 };
 const { data: upData, error: upErr } = await supabase.from('scan_jobs').update(patch).eq('id', jobId).select('id');
 console.log('[SCAN_JOB_UPDATE]', { jobId, patchKeys: Object.keys(patch), count: upData?.length ?? 0, error: upErr?.message });
 return res.status(500).json({
 ok: false,
 error: 'profile_creation_failed',
 jobId,
 status: 'failed',
 });
 }
 
 // CRITICAL: Upload image to Supabase Storage first (don't send in QStash payload)
 // Every new photo gets its own id and storage path (no reuse by image_hash) so deleted photos don't reappear.
 let imageHash: string | null = null;
 let imagePath: string | null = null;
 let serverPhotoId: string | null = null;
 
 const MAX_DIMENSION = 8192;
 try {
 const crypto = await import('crypto');
 const base64Data = imageDataURL.split(',')[1] || imageDataURL;
 const imageBuffer = Buffer.from(base64Data, 'base64');
 if (imageBuffer.length > MAX_DECODED_BYTES) {
 return res.status(400).json({
 status: 'error',
 error: { code: 'image_too_large', message: `Image decoded size must not exceed ${MAX_DECODED_BYTES / (1024 * 1024)}MB` },
 });
 }
 const sharp = (await import('sharp')).default;
 const meta = await sharp(imageBuffer).metadata();
 const w = meta.width ?? 0;
 const h = meta.height ?? 0;
 if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
 return res.status(400).json({
 status: 'error',
 error: { code: 'image_dimensions_too_large', message: `Image dimensions must not exceed ${MAX_DIMENSION}x${MAX_DIMENSION} pixels` },
 });
 }
 const mimeMatch = imageDataURL.match(/^data:([^;]+);base64,/);
 const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
 
 const { buffer: uploadBuffer, contentType, ext } = await optimizeToCanonicalWebp(imageBuffer, mimeType);
 imageHash = crypto.createHash('sha256').update(uploadBuffer).digest('hex').substring(0, 16);
 const newPhotoId = crypto.randomUUID();
 console.log(scanLogPrefix('SCAN', { opId, userId, batchId: batchId ?? undefined, scanJobId: jobId, photoFingerprint: imageHash ?? undefined }));
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image hash (from ${contentType} bytes): ${imageHash}, userId: ${userId}, newPhotoId: ${newPhotoId}`);
 
 // Image Hash Locking: Check if scan with same image_hash exists
 // If forceFresh === true, ignore existing jobs (except very recent ones to prevent spam)
 // Otherwise, reuse existing job only if it's completed or actively processing (within 5 min)
 const forceFresh = (req.body as any)?.forceFresh === true;
 
 if (imageHash && !forceFresh) {
 // Normal behavior: reuse existing jobs when not forcing fresh
 const { data: existingJob } = await supabase
 .from('scan_jobs')
 .select('id, status, updated_at, created_at, photo_id')
 .eq('image_hash', imageHash)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 
 if (existingJob && existingJob.id !== jobId) {
 const now = Date.now();
 const updatedAt = existingJob.updated_at ? new Date(existingJob.updated_at).getTime() : 0;
 const ageSeconds = (now - updatedAt) / 1000;
 const status = existingJob.status;
 const existingPhotoId = existingJob.photo_id ?? null;
 
    // Reuse if: completed OR (processing AND updated within last 15 minutes)
    // Relaxed from 5 minutes since worker is now blocking/deterministic
    if (status === 'completed') {
      // Guard: only reuse if the photo row still exists and is not soft-deleted.
      // If the user deleted the photo (deleted_at IS NOT NULL), treat the hash as fresh —
      // create a new job/photo so the scan doesn't attach to a deleted photo and immediately vanish.
      let photoIsAlive = !existingPhotoId; // no photo_id = no photo to check (treat as alive)
      if (existingPhotoId) {
        const { data: photoCheck } = await supabase
          .from('photos')
          .select('id')
          .eq('id', existingPhotoId)
          .is('deleted_at', null)
          .maybeSingle();
        photoIsAlive = !!photoCheck?.id;
      }
      if (photoIsAlive) {
        console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image hash lock: Found completed job ${existingJob.id} with same image_hash, returning existing jobId`);
        return res.status(202).json({
          jobId: existingJob.id,
          photoId: existingPhotoId,
          status: existingJob.status
        });
      }
      // Photo was deleted — fall through to create a new job + photo row.
      console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image hash lock: completed job ${existingJob.id} found but photo ${existingPhotoId} is deleted — creating fresh job`);
    }
 
 // Relaxed timeout: Since worker is now blocking/deterministic, processing jobs are reliable
 // Only reuse if updated within last 15 minutes (was 5 minutes)
 if (status === 'processing' && ageSeconds < 900) { // 15 minutes = 900 seconds
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image hash lock: Found active processing job ${existingJob.id} (updated ${ageSeconds.toFixed(0)}s ago), returning existing jobId`);
 return res.status(202).json({
 jobId: existingJob.id,
 photoId: existingPhotoId,
 status: existingJob.status
 });
 }
 
 // If pending and stale (older than 60 seconds), mark as failed and create new job
 if (status === 'pending' && ageSeconds > 60) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Found stale pending job ${existingJob.id} (${ageSeconds.toFixed(0)}s old), marking as failed and creating new job`);
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ 
 code: 'stale_pending', 
 message: `Job was pending for ${ageSeconds.toFixed(0)} seconds and was replaced by a new scan request` 
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', existingJob.id);
 // Continue to create new job below
 }
 
 // If failed, create new job (continue below)
 if (status === 'failed') {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Found failed job ${existingJob.id} with same image_hash, creating new job`);
 // Continue to create new job below
 }
 
 // If processing but stale (older than 15 minutes), create new job
 // Relaxed from 5 minutes since worker is now blocking/deterministic
 if (status === 'processing' && ageSeconds >= 900) { // 15 minutes = 900 seconds
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Found stale processing job ${existingJob.id} (${ageSeconds.toFixed(0)}s old), creating new job`);
 // Continue to create new job below
 }
 }
 } else if (imageHash && forceFresh) {
 // forceFresh === true: Check for very recent jobs to prevent spam (3-5 seconds)
 const { data: recentJob } = await supabase
 .from('scan_jobs')
 .select('id, status, updated_at, created_at, photo_id')
 .eq('image_hash', imageHash)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 
 if (recentJob && recentJob.id !== jobId) {
 const now = Date.now();
 const createdAt = recentJob.created_at ? new Date(recentJob.created_at).getTime() : 0;
 const ageSeconds = (now - createdAt) / 1000;
 const status = recentJob.status;
 const recentPhotoId = recentJob.photo_id ?? null;
 
 // Only reuse if job was created in last 4 seconds AND is pending/processing (spam protection)
 if ((status === 'pending' || status === 'processing') && ageSeconds < 4) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Spam protection: Found very recent job ${recentJob.id} (created ${ageSeconds.toFixed(1)}s ago, status=${status}), reusing to prevent duplicate scans`);
 return res.status(202).json({
 jobId: recentJob.id,
 photoId: recentPhotoId,
 status: recentJob.status
 });
 }
 
 // Otherwise, ignore existing job and create fresh one
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] forceFresh=true: Ignoring existing job ${recentJob.id} (age=${ageSeconds.toFixed(1)}s, status=${status}), creating new job`);
 } else {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] forceFresh=true: No recent job found, creating fresh scan`);
 }
 }
 
 // Canonical path: <userId>/<photoId>.jpg — same format as client upload and signed URL
 imagePath = getCanonicalPhotoStoragePath(userId, newPhotoId);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Uploading image to storage: ${imagePath} (${uploadBuffer.length} bytes, ${contentType})`);
 
 const { error: uploadError } = await supabase.storage
 .from('photos')
 .upload(imagePath, uploadBuffer, {
 contentType: contentType,
 upsert: false,
 });
 
 if (uploadError) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Failed to upload image to storage:`, uploadError);
 return res.status(500).json({
 status: 'error',
 error: { code: 'image_upload_failed', message: 'Failed to upload image to storage' }
 });
 }
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image uploaded to storage: ${imagePath}`);
 
// Insert new photo row (one per capture). Never reuse by image_hash so deleted photos don't reappear.
// books: [] is required — the column is NOT NULL. Omitting it causes a constraint violation that
// silently prevents the photo row from being created, which then cascades: scan_jobs.photo_id FK
// patch fails (no matching photos.id), server snapshot returns 0 photos, and everything looks deleted.
// status: DB allows only draft|complete|discarded|scan_failed; never 'uploaded'. timestamp: BIGINT (epoch ms), not timestamptz.
const nowIso = new Date().toISOString();
const timestampMs = Date.now();
const photoInsertPayload = {
  id: newPhotoId,
  user_id: userId,
  image_hash: imageHash,
  storage_path: imagePath,
  books: [] as unknown[],   // NOT NULL — always send explicit empty array, never rely on DB default
  status: 'draft' as const,
  timestamp: timestampMs,
  updated_at: nowIso,
};
// Log exact field presence + values before every insert so we can confirm the schema
// constraint (books NOT NULL) is always satisfied and catch any future regressions fast.
console.log('[PHOTO_INSERT_FIELD_VALUES]', JSON.stringify({
  photoId: newPhotoId,
  status: photoInsertPayload.status,
  timestamp: photoInsertPayload.timestamp,
  storage_path: photoInsertPayload.storage_path ?? '',
  user_id: (photoInsertPayload.user_id ?? '').slice(0, 8),
  hasId: !!photoInsertPayload.id,
  hasUserId: !!photoInsertPayload.user_id,
  hasBooksField: 'books' in photoInsertPayload,
  booksLen: Array.isArray(photoInsertPayload.books) ? photoInsertPayload.books.length : null,
  hasStoragePath: !!photoInsertPayload.storage_path,
  hasImageHash: !!photoInsertPayload.image_hash,
  updatedAt: !!photoInsertPayload.updated_at,
}));
const { data: photoRow, error: photoErr } = await supabase
.from('photos')
.insert(photoInsertPayload)
.select('id')
.single();
if (!photoErr && photoRow?.id) {
serverPhotoId = photoRow.id;
console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Photo inserted (new id): id=${serverPhotoId}`);
} else if (photoErr) {
console.error('[PHOTO_INSERT_FIELD_VALUES] FAILED', JSON.stringify({
  photoId: newPhotoId,
  status: photoInsertPayload.status,
  timestamp: photoInsertPayload.timestamp,
  storage_path: photoInsertPayload.storage_path ?? '',
  user_id: (photoInsertPayload.user_id ?? '').slice(0, 8),
  errCode: (photoErr as any).code ?? 'unknown',
  errMsg: photoErr.message,
  hasBooksField: 'books' in photoInsertPayload,
  booksLen: Array.isArray(photoInsertPayload.books) ? photoInsertPayload.books.length : null,
}));
console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Photo insert failed (non-fatal):`, photoErr.message);
}
 
 } catch (storageError: any) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Storage error:`, storageError);
 return res.status(500).json({
 status: 'error',
 error: { code: 'storage_error', message: storageError?.message || 'Failed to process image for storage' }
 });
 }

 /** If job creation fails after upload, remove the uploaded image so storage doesn't fill with orphans. */
 const removeUploadedImageIfAny = async () => {
 if (!imagePath) return;
 try {
 await supabase.storage.from('photos').remove([imagePath]);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Cleaned up orphaned upload: ${imagePath}`);
 } catch (_) { /* ignore */ }
 };

 // Create job record in durable storage (Supabase). Server generates photo_id per upload (one photo row per capture).
 // Store image_path instead of image_data to avoid huge payloads. Set photo_id at insert so it is never "looked up from job" later.
 // scan_jobs.id is uuid type strip the "job_" prefix before writing to DB.
 // jobId (with prefix) is kept for client responses and QStash; dbJobId is the raw UUID for DB.
 const dbJobId = toRawScanJobUuid(jobId) ?? jobId;

 const jobData: Record<string, unknown> = {
 id: dbJobId,
 user_id: userId,
 image_path: imagePath,
 image_hash: imageHash,
 scan_id: scanId,
 status: 'pending',
 stage: 'queued',
 progress: 0,
 books: [],
 created_at: new Date().toISOString(),
 updated_at: new Date().toISOString()
 };
 if (serverPhotoId) {
 jobData.photo_id = serverPhotoId;
 }
 if (batchId && typeof batchId === 'string' && batchId.trim().length > 0) {
 jobData.batch_id = batchId.trim();
 }
 
 // Use upsert to handle conflicts gracefully (duplicate jobId or image_hash)
 let upsertedJob: any = null;
 let upsertError: any = null;
 let shouldPublishToQStash = false;

 // PRE-INSERT: log userId type + every column value being written so any type mismatch is immediately visible.
 console.log('[SCAN_JOB_PRE_INSERT]', JSON.stringify({
 authedUserId: userId,
 typeof_authedUserId: typeof userId,
 writingUserIdToColumn: 'scan_jobs.user_id',
 valueSent: userId,
 typeof_valueSent: typeof userId,
 dbJobId,
 typeof_dbJobId: typeof dbJobId,
 serverPhotoId: serverPhotoId ?? null,
 typeof_serverPhotoId: typeof serverPhotoId,
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }));
 
 const { data: initialUpsertedJob, error: initialUpsertError } = await supabase
 .from('scan_jobs')
 .upsert(jobData, {
 onConflict: 'id',
 ignoreDuplicates: false
 })
 .select('id, user_id, scan_id, status, photo_id')
 .single();

 if (initialUpsertedJob) {
 // POST-INSERT SUCCESS: log the actual row that landed in the DB.
 console.log('[SCAN_JOB_INSERTED]', JSON.stringify({
 insertedId: initialUpsertedJob.id,
 insertedUserId: initialUpsertedJob.user_id,
 insertedScanId: initialUpsertedJob.scan_id,
 insertedPhotoId: initialUpsertedJob.photo_id ?? null,
 insertedStatus: initialUpsertedJob.status,
 expectedId: dbJobId,
 expectedUserId: userId,
 idMatch: initialUpsertedJob.id === dbJobId,
 userIdMatch: initialUpsertedJob.user_id === userId,
 }));
 }
 
 // Verify the insert/upsert actually landed (use dbJobId raw UUID, no job_ prefix)
 const { data: verify } = await supabase.from("scan_jobs").select("id,status").eq("id", dbJobId).is("deleted_at", null).maybeSingle();
 console.log("[SCAN] verify job row:", verify);
 
 if (initialUpsertError) {
 upsertError = initialUpsertError;
 console.error('[API] [SCAN] scan_jobs upsert error:', JSON.stringify({
 message: upsertError.message,
 code: upsertError.code,
 details: upsertError.details,
 hint: upsertError.hint,
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 payloadValues: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, v === null ? 'null' : String(v).slice(0, 80)])),
 }));
 // If upsert failed, check if it's a duplicate image_hash conflict
 if (upsertError.code === '23505' || upsertError.message?.includes('duplicate') || upsertError.message?.includes('unique')) {
 // Try to find existing job with same image_hash
 if (imageHash) {
 const { data: existingJob } = await supabase
 .from('scan_jobs')
 .select('id, status, updated_at, photo_id')
 .eq('image_hash', imageHash)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 
 if (existingJob) {
 const now = Date.now();
 const updatedAt = existingJob.updated_at ? new Date(existingJob.updated_at).getTime() : 0;
 const ageSeconds = (now - updatedAt) / 1000;
 const status = existingJob.status;
 const existingPhotoId = existingJob.photo_id ?? null;
 
 // Reuse if: completed OR (processing AND updated within last 15 minutes)
 if (status === 'completed' || (status === 'processing' && ageSeconds < 900)) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Conflict resolved: Found existing job ${existingJob.id} (status=${status}, age=${ageSeconds.toFixed(0)}s), returning existing jobId`);
 await removeUploadedImageIfAny();
 return res.status(202).json({
 jobId: existingJob.id,
 photoId: existingPhotoId,
 status: existingJob.status
 });
 }
 
 // If pending and stale, mark as failed and retry upsert
 if (status === 'pending' && ageSeconds > 60) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Conflict: Found stale pending job ${existingJob.id} (${ageSeconds.toFixed(0)}s old), marking as failed and retrying upsert`);
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ 
 code: 'stale_pending', 
 message: `Job was pending for ${ageSeconds.toFixed(0)} seconds and was replaced by a new scan request` 
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', existingJob.id);
 
 // Retry upsert after marking stale job as failed
 const { data: retryUpsertedJob, error: retryUpsertError } = await supabase
 .from('scan_jobs')
 .upsert(jobData, {
 onConflict: 'id',
 ignoreDuplicates: false
 })
 .select('id, status')
 .single();
 
 if (retryUpsertError) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retry upsert failed after marking stale job as failed:`, retryUpsertError);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job after resolving stale job',
 supabase: { message: retryUpsertError.message, code: retryUpsertError.code, details: retryUpsertError.details, hint: retryUpsertError.hint },
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 
 // Upsert succeeded, continue to QStash publish
 upsertedJob = retryUpsertedJob;
 shouldPublishToQStash = true;
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retry upsert succeeded after marking stale job as failed`);
 } else if (status === 'failed' || (status === 'processing' && ageSeconds >= 900)) { // 15 minutes = 900 seconds
 // If failed or stale processing, retry upsert
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retrying upsert for ${status} job (age=${ageSeconds.toFixed(0)}s)`);
 const { data: retryUpsertedJob, error: retryUpsertError } = await supabase
 .from('scan_jobs')
 .upsert(jobData, {
 onConflict: 'id',
 ignoreDuplicates: false
 })
 .select('id, status')
 .single();
 
 if (retryUpsertError) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retry upsert failed:`, retryUpsertError);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job',
 supabase: { message: retryUpsertError.message, code: retryUpsertError.code, details: retryUpsertError.details, hint: retryUpsertError.hint },
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 
 // Upsert succeeded, continue to QStash publish
 upsertedJob = retryUpsertedJob;
 shouldPublishToQStash = true;
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retry upsert succeeded`);
 } else {
 // Unexpected case - return error
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Unexpected job status/age combination: status=${status}, age=${ageSeconds.toFixed(0)}s`);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: { code: 'job_creation_failed', message: 'Unexpected job state' }
 });
 }
 } else {
 // No existing job found but upsert failed - return error
 console.error('[API] Error creating/updating scan job (no existing job found):', upsertError);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job (no existing job found)',
 supabase: { message: upsertError.message, code: upsertError.code, details: upsertError.details, hint: upsertError.hint },
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 } else {
 // Not a duplicate conflict - return error
 console.error('[API] Error creating/updating scan job (not duplicate):', upsertError);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job (not duplicate conflict)',
 supabase: { message: upsertError.message, code: upsertError.code, details: upsertError.details, hint: upsertError.hint },
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 } else {
 // Upsert error but not a duplicate - return error
 console.error('[API] Error creating/updating scan job:', upsertError);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job',
 supabase: { message: upsertError.message, code: upsertError.code, details: upsertError.details, hint: upsertError.hint },
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 } else {
 // Initial upsert succeeded
 upsertedJob = initialUpsertedJob;
 shouldPublishToQStash = true;
 }

 // photo_id is set in jobData at insert when server created a photo. Only patch if we had no server photo (e.g. insert failed) and client sent one (backward compat).
 const effectivePhotoId = serverPhotoId ?? validPhotoId;
 if (effectivePhotoId && upsertedJob && !serverPhotoId) {
 const { data: jobRow } = await supabase
 .from('scan_jobs')
 .select('photo_id')
 .eq('id', dbJobId)
 .maybeSingle();
 const existingPhotoId = jobRow?.photo_id ?? null;
 if (existingPhotoId == null) {
 const { error: photoLinkErr } = await supabase
 .from('scan_jobs')
 .update({ photo_id: effectivePhotoId, updated_at: new Date().toISOString() })
 .eq('id', dbJobId)
 .is('photo_id', null);
 if (photoLinkErr) {
 console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] scan_jobs.photo_id patch failed (non-fatal):`, photoLinkErr.message);
 } else {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] scan_jobs.photo_id set to ${effectivePhotoId} (fallback)`);
 }
 }
 }

 // Ensure we have a successful upsert before continuing
 if (!upsertedJob || !shouldPublishToQStash) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Job creation failed - cannot proceed to QStash publish`);
 await removeUploadedImageIfAny();
 return res.status(500).json({ 
 status: 'error',
 error: {
 code: 'job_creation_failed',
 message: 'Failed to create scan job (upsertedJob null after all conflict resolution)',
 supabase: upsertError ? { message: upsertError.message, code: upsertError.code, details: upsertError.details, hint: upsertError.hint } : null,
 payloadKeys: Object.keys(jobData),
 payloadTypes: Object.fromEntries(Object.entries(jobData).map(([k, v]) => [k, typeof v])),
 }
 });
 }
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Job created/updated in durable storage (Supabase) with image_path: ${imagePath}`);
 
 // Build worker URL - MUST point to /api/scan-worker, never /api/scan
 // CRITICAL: Use canonical URL https://www.bookshelfscan.app/api/scan-worker
 let workerUrl: string;
 if (process.env.WORKER_URL) {
 // If WORKER_URL is set, use it but validate it points to scan-worker
 workerUrl = process.env.WORKER_URL;
 if (!workerUrl.includes('/api/scan-worker') && !workerUrl.includes('scan-worker')) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] WARNING: WORKER_URL does not point to scan-worker: ${workerUrl}`);
 // Force it to scan-worker
 const baseUrl = workerUrl.split('/api/')[0] || 'https://www.bookshelfscan.app';
 workerUrl = `${baseUrl}/api/scan-worker`;
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Corrected WORKER_URL to: ${workerUrl}`);
 }
 } else {
 // Default: always use canonical URL
 workerUrl = 'https://www.bookshelfscan.app/api/scan-worker';
 }
 
 // Validate QStash configuration BEFORE sending response
 const qstashToken = process.env.QSTASH_TOKEN;
 if (!qstashToken) {
 // QStash is required - mark job as failed if not configured
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash not configured - marking job as failed`);
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ code: 'qstash_not_configured', message: 'QStash token not configured' }),
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 
 return res.status(500).json({
 status: 'error',
 error: { code: 'worker_not_configured', message: 'Worker service not configured' }
 });
 }
 
 // Enqueue job to worker via QStash (ONLY send jobId - image is in storage)
 // CRITICAL: Publish MUST complete BEFORE sending response, or Vercel will kill the invocation
 // CRITICAL: Worker endpoint MUST be /api/scan-worker, NOT /api/scan
 try {
 // QStash path-based publish: destination URL goes in path, NOT encoded
 const qstashBase = process.env.QSTASH_URL!.replace(/\/+$/, "");
 const workerUrl = "https://www.bookshelfscan.app/api/scan-worker";
 
 // IMPORTANT: do NOT encode workerUrl
 const publishUrl = `${qstashBase}/v2/publish/${workerUrl}`;
 
 // CRITICAL: Ensure userId is never null - if it is, fail before publishing
 if (!userId) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] CRITICAL: userId is null/undefined - cannot publish to QStash`);
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ 
 code: 'missing_user_id', 
 message: 'User ID is required but was null/undefined' 
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 return res.status(500).json({ 
 ok: false, 
 error: 'missing_user_id',
 jobId,
 status: 'failed'
 });
 }
 
 // Worker uses scanJobId (raw UUID) for all DB operations never the job_ prefixed string.
 // jobId (prefixed) is kept only for client-side display/logging.
 const payload = { jobId: dbJobId, scanId, userId };
 
 // DEFINITIVE LOGGING: Log all QStash publish configuration before making the call
 const hasToken = !!qstashToken;
 
 // Log batch info if provided
 const batchLogPrefix = batchId && typeof index === 'number' && typeof total === 'number' 
 ? `[BATCH ${batchId}] [${index}/${total}]` 
 : '';
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} ========== QSTASH PUBLISH CONFIG ==========`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} baseUrl: ${qstashBase}`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} hasToken: ${hasToken}`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} workerUrl: ${workerUrl}`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} publishUrl: ${publishUrl}`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} payload: {jobId(dbUuid): ${dbJobId}, scanId: ${scanId}, userId: ${userId}, displayJobId: ${jobId}}`);
 if (batchId) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} batchId: ${batchId}, index: ${index}, total: ${total}`);
 }
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} ==========================================`);
 
 if (!hasToken) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash token missing - cannot publish`);
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ 
 code: 'qstash_token_missing', 
 message: 'QStash token is missing or empty' 
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 return res.status(500).json({ 
 ok: false, 
 error: 'qstash_token_missing',
 jobId,
 status: 'failed'
 });
 }
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] About to publish to QStash`);
 
 const publishStart = Date.now();
 const maxRetries = 2;
 const backoffMs = [250, 1000]; // Backoff delays for retries
 let lastError: any = null;
 let lastResponseStatus: number | null = null;
 let lastResponseBody: string | null = null;
 let actualAttempts = 0; // Track actual attempts made
 
 // Retry loop: initial attempt + 2 retries = 3 total attempts
 for (let attempt = 0; attempt <= maxRetries; attempt++) {
 actualAttempts = attempt + 1; // Track actual attempt number
 const attemptStart = Date.now();
 
 try {
 const controller = new AbortController();
 const t = setTimeout(() => controller.abort(), 8000); // 8s hard timeout per attempt
 
 if (attempt > 0) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Retry attempt ${attempt}/${maxRetries} after ${backoffMs[attempt - 1]}ms backoff`);
 }
 
 const resp = await fetch(publishUrl, {
 method: "POST",
 headers: {
 Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
 "Content-Type": "application/json",
 },
 body: JSON.stringify(payload),
 signal: controller.signal,
 });
 
 clearTimeout(t);
 
 const attemptDuration = Date.now() - attemptStart;
 const respText = await resp.text();
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${attempt > 0 ? ` Retry ${attempt} ` : ''} QStash publish response (${attemptDuration}ms)`, {
 status: resp.status,
 body: respText,
 attempt: attempt + 1,
 });
 
 if (resp.ok) {
 // Success! Mark job as pending and return
 const totalDuration = Date.now() - publishStart;
 
 // Extract messageId from QStash response (may be in body or headers)
 let messageId: string | null = null;
 try {
 // QStash may return messageId in response body or headers
 const respJson = respText ? JSON.parse(respText) : {};
 messageId = respJson.messageId || resp.headers.get('x-qstash-message-id') || resp.headers.get('upstash-message-id') || null;
 } catch {
 // If body is not JSON, try headers only
 messageId = resp.headers.get('x-qstash-message-id') || resp.headers.get('upstash-message-id') || null;
 }
 
 await supabase
 .from('scan_jobs')
 .update({
 status: 'pending',
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 
 const batchLogPrefix = batchId && typeof index === 'number' && typeof total === 'number' 
 ? `[BATCH ${batchId}] [${index}/${total}]` 
 : '';
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} Job marked as pending after successful QStash publish (total duration: ${totalDuration}ms, messageId: ${messageId || 'N/A'})`);
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${batchLogPrefix} responding to client with jobId and photoId`);
 return res.status(202).json({
 jobId, // prefixed display id: "job_<uuid>" for client UI/logging only
 scanJobId: dbJobId, // raw DB uuid use this for poll/cancel/status API calls
 scanId,
 photoId: serverPhotoId ?? undefined,
 status: 'pending',
 messageId: messageId || undefined
 });
 }
 
 // Non-ok response - save for potential retry
 lastResponseStatus = resp.status;
 lastResponseBody = respText;
 lastError = {
 type: 'qstash_publish_failed',
 status: resp.status,
 body: respText,
 attempt: attempt + 1,
 };
 
 // Don't retry on 4xx errors (client errors)
 if (resp.status >= 400 && resp.status < 500) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Client error (${resp.status}), not retrying`);
 break;
 }
 
 // For 5xx or other errors, retry if we have attempts left
 if (attempt < maxRetries) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Publish failed (${resp.status}), will retry after ${backoffMs[attempt]}ms`);
 await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]));
 continue;
 }
 
 } catch (err: any) {
 const attemptDuration = Date.now() - attemptStart;
 const isTimeout = err?.name === 'AbortError' || err?.message?.includes('aborted');
 
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] ${attempt > 0 ? ` Retry ${attempt} ` : ''} QStash publish threw (${attemptDuration}ms)`, {
 name: err?.name,
 message: err?.message,
 isTimeout,
 attempt: attempt + 1,
 });
 
 lastError = {
 type: isTimeout ? 'qstash_publish_timeout' : 'qstash_publish_exception',
 message: err?.message,
 name: err?.name,
 attempt: attempt + 1,
 };
 
 // Retry on timeout or network errors if we have attempts left
 if (attempt < maxRetries && (isTimeout || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND')) {
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Publish error (${isTimeout ? 'timeout' : err?.code}), will retry after ${backoffMs[attempt]}ms`);
 await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]));
 continue;
 }
 
 // No more retries or non-retryable error
 break;
 }
 }
 
 // All retries exhausted - mark job as failed
 const totalDuration = Date.now() - publishStart;
 const errorDetails = lastResponseStatus !== null
 ? JSON.stringify({ 
 type: 'qstash_publish_failed', 
 status: lastResponseStatus, 
 body: lastResponseBody || 'empty',
 attempts: actualAttempts,
 })
 : JSON.stringify({ 
 ...lastError,
 attempts: actualAttempts,
 });
 
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: errorDetails,
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 
 const errorCode = lastError?.type === 'qstash_publish_timeout' 
 ? 'qstash_publish_timeout' 
 : lastResponseStatus !== null
 ? 'qstash_publish_failed'
 : 'qstash_publish_exception';
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash publish failed after ${actualAttempts} attempt${actualAttempts !== 1 ? 's' : ''} (total duration: ${totalDuration}ms), responding with error`);
 return res.status(500).json({ 
 ok: false, 
 error: errorCode,
 jobId,
 status: 'failed'
 });
 } catch (qstashError: any) {
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] ========== QSTASH PUBLISH ERROR ==========`);
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Error type: ${qstashError?.name || 'Unknown'}`);
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Error message: ${qstashError?.message || String(qstashError)}`);
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Error stack:`, qstashError?.stack);
 console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] ==========================================`);
 
 // Mark job as failed with detailed error
 await supabase
 .from('scan_jobs')
 .update({
 status: 'failed',
 error: JSON.stringify({ 
 code: 'qstash_error', 
 message: qstashError?.message || String(qstashError),
 errorType: qstashError?.name || 'Unknown'
 }),
 updated_at: new Date().toISOString()
 })
 .eq('id', dbJobId);
 
 console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash outer catch error, responding with error`);
 return res.status(500).json({ 
 ok: false, 
 error: 'qstash_error',
 jobId,
 status: 'failed'
 });
 }
 } catch (e: any) {
 console.error('[API] Error in scan handler:', e);
 return res.status(500).json({ 
 status: 'error',
 error: { code: 'scan_failed', message: e?.message || String(e) }
 });
 }
}
