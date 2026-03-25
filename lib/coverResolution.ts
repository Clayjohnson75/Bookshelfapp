/**
 * Book enrichment cache (cover_resolutions).
 * Resolver is authoritative: cover is must-have, metadata (description, page_count, etc.) is nice-to-have.
 * Never retry just for description once we have a cover, we're done.
 *
 * work_key uses canonical normalization from lib/workKey (isbn13:, isbn10:, ta:sha1).
 */
import sharp from 'sharp';
import {
 buildWorkKey,
 buildWorkKeyWithNorms,
 isIsbn10,
 isIsbn13,
 normalizeAuthor,
 normalizeIsbn,
 workKeyToStoragePath,
} from './workKey';
import { acquireCoverRateLimit } from './coverRateLimit';
import { sanitizeBookForDb } from './sanitizeTextForDb';

/** Resize cover to grid-friendly size (20-60KB) to reduce bandwidth. */
const COVER_MAX_WIDTH = 280;
const COVER_QUALITY = 70;

export async function resizeCoverForStorage(buffer: Buffer): Promise<Buffer> {
 try {
 const resized = await sharp(buffer)
 .resize(COVER_MAX_WIDTH, undefined, { withoutEnlargement: true })
 .jpeg({ quality: COVER_QUALITY })
 .toBuffer();
 return resized;
 } catch {
 return buffer; // Fallback to original on resize failure
 }
}

export { buildWorkKey, normalizeAuthor };

const BUCKET = 'book-covers';
export const MISS_RETRY_HOURS = 5 / 60; // 5 minutes — retry failed covers quickly
export const PLACEHOLDER_URL = 'https://placehold.co/128x192/e5e7eb/9ca3af?text=No+cover';

export interface BookMetadata {
 description?: string;
 categories?: string[];
 pageCount?: number;
 publisher?: string;
 publishedDate?: string;
 language?: string;
 subtitle?: string;
}

/** Service-role client (bypasses RLS). Used by cover-resolve-worker, meta-enrich-worker, etc. so they see all rows. */
export function getSupabase(): any {
 const url = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!url || !key) return null;
 try {
 const { createClient } = require('@supabase/supabase-js');
 return createClient(url, key, { auth: { persistSession: false } });
 } catch {
 return null;
 }
}

export function getStoragePublicUrl(path: string): string {
 const url = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 if (!url) return '';
 const base = url.replace(/\/$/, '');
 return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** Verify the stored object exists (HEAD). If 404 or error, return false caller should treat as MISS and re-download. */
export async function verifyStorageObjectExists(path: string): Promise<boolean> {
 const url = getStoragePublicUrl(path);
 if (!url) return false;
 try {
 const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
 return res.ok && res.status !== 404;
 } catch {
 return false;
 }
}

// Token bucket rate limiter for Open Library + Google Books (avoids 429s)
const RATE_BUCKET_SIZE = 4;
const RATE_REFILL_MS = 150;
let rateTokens = RATE_BUCKET_SIZE;
let rateLastRefill = Date.now();

async function acquireRateLimitToken(): Promise<void> {
 const now = Date.now();
 const elapsed = now - rateLastRefill;
 const refill = Math.floor(elapsed / RATE_REFILL_MS);
 if (refill > 0) {
 rateTokens = Math.min(RATE_BUCKET_SIZE, rateTokens + refill);
 rateLastRefill = now;
 }
 if (rateTokens > 0) {
 rateTokens--;
 return;
 }
 await new Promise(r => setTimeout(r, RATE_REFILL_MS));
 return acquireRateLimitToken();
}

/** Quality: low = displayable but worker may retry; ok/good = UI can show. */
export type CoverQuality = 'low' | 'ok' | 'good';

/** Worker upsert: ONLY these columns (all exist in schema). No provider, source_url, content_type, or extra metadata. */
const COVER_RES_COLUMNS = [
 'work_key', 'cover_storage_path', 'source', 'status', 'width', 'height', 'mime', 'updated_at',
] as const;

/** Strip payload to allowlisted columns only. Log dropped keys so we notice schema drift. */
function pickCoverResPayload(payload: Record<string, any>): Record<string, any> {
 const allowed = new Set<string>(COVER_RES_COLUMNS);
 const out: Record<string, any> = {};
 const dropped: string[] = [];
 for (const [k, v] of Object.entries(payload)) {
 if (allowed.has(k)) out[k] = v;
 else dropped.push(k);
 }
 if (dropped.length > 0 && typeof console !== 'undefined' && console.log) {
 console.log('[COVER] payload allowlist dropped columns (not in schema):', dropped.join(', '));
 }
 return out;
}

export { pickCoverResPayload, COVER_RES_COLUMNS };

const META_COLS = 'work_key, cover_storage_path, status, width, height, mime, description, categories, page_count, publisher, published_date, language, subtitle';

/** Upsert cover_resolutions as pending (no fetch). Call before enqueueing QStash job. Only allowed columns. */
export async function upsertPending(db: any, workKey: string, _isbn?: string, _title?: string, _author?: string): Promise<void> {
 const now = new Date().toISOString();
 const payload = pickCoverResPayload({
 work_key: workKey,
 status: 'pending',
 updated_at: now,
 });
 await db.from('cover_resolutions').upsert(payload, { onConflict: 'work_key' });
}

/** Options for hydrateBooksWithCovers: UI can display only ok/good; worker can retry low later. */
export type HydrateCoverOptions = { minQuality?: 'ok' | 'good' };

/** Guarantee: only return rows that imply usable image (status ready + path set). UI can filter by quality (ok/good). */
export async function hydrateBooksWithCovers(db: any, books: any[], options?: HydrateCoverOptions): Promise<any[]> {
 const workKeys = books.map(b => b?.work_key ?? b?.workKey).filter(Boolean);
 if (workKeys.length === 0) return books;

 const { data } = await db
 .from('cover_resolutions')
 .select('work_key, cover_storage_path, status')
 .in('work_key', workKeys)
 .in('status', ['ready', 'resolved'])
 .not('cover_storage_path', 'is', null);

 const minQuality = options?.minQuality;
 const map = new Map<string, string>();
 if (Array.isArray(data)) {
 for (const row of data) {
 if (minQuality === 'good' && row?.quality != null && row.quality !== 'good') continue;
 if (minQuality === 'ok' && row?.quality === 'low') continue;
 const path = row?.cover_storage_path;
 if (row?.work_key && path != null && path !== '') {
 map.set(row.work_key, getStoragePublicUrl(path));
 }
 }
 }

 return books.map(b => {
 if (b.coverUrl) return b;
 const key = b.work_key ?? b.workKey;
 const path = key ? map.get(key) : undefined;
 if (!path) return b;
 return { ...b, coverUrl: path };
 });
}

/** Persist cover URL directly onto the book row in scan_jobs.books. No separate hydration step. */
export async function updateScanJobBookCover(db: any, jobId: string, workKey: string, coverUrl: string): Promise<void> {
 const { data, error } = await db.from('scan_jobs').select('books').eq('id', jobId).is('deleted_at', null).maybeSingle();
 if (error || !data || !Array.isArray(data.books)) return;
 const books = data.books.map((b: any) => {
 const key = b?.work_key ?? b?.workKey;
 if (key !== workKey) return sanitizeBookForDb(b);
 return sanitizeBookForDb({ ...b, coverUrl });
 });
 await db.from('scan_jobs').update({ books, updated_at: new Date().toISOString() }).eq('id', jobId);
}

/** Batch lookup: only rows with usable image (status resolved/ready + path set). Guarantee: cache row = loadable. */
export async function lookupBatch(db: any, workKeys: string[]): Promise<Map<string, any>> {
 const uniq = [...new Set(workKeys)].filter(Boolean);
 if (uniq.length === 0) return new Map();
 const { data } = await db
 .from('cover_resolutions')
 .select(META_COLS)
 .in('work_key', uniq)
 .in('status', ['ready', 'resolved'])
 .not('cover_storage_path', 'is', null);
 const map = new Map<string, any>();
 if (Array.isArray(data)) {
 for (const row of data) {
 const path = row?.cover_storage_path;
 if (row?.work_key && path != null && path !== '') map.set(row.work_key, row);
 }
 }
 return map;
}

/** One cover candidate: try this URL (large-first); if too small, caller tries next. */
interface CoverCandidate {
 provider: string;
 url: string;
 metadata?: BookMetadata;
 googleVolumeId?: string;
 openlibraryCoverId?: string;
}

/** Open Library by ISBN: return candidates large medium small (escalation). */
async function getOlByIsbnCandidates(isbn: string): Promise<CoverCandidate[]> {
 const n = normalizeIsbn(isbn);
 if (!n) return [];
 const apiUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${n}&jscmd=data&format=json`;
 try {
 const res = await fetch(apiUrl);
 if (!res.ok) return [];
 const data = await res.json();
 const entry = data?.[`ISBN:${n}`];
 if (!entry?.cover) return [];
 const cover = entry.cover;
 const urls = [cover.large, cover.medium, cover.small].filter(Boolean) as string[];
 if (urls.length === 0) return [];
 const subjects = entry.subjects?.map((s: { name?: string }) => s?.name).filter(Boolean) || [];
 const desc = entry.excerpts?.[0]?.text || null;
 const metadata: BookMetadata = {
 description: desc || undefined,
 categories: subjects.length > 0 ? subjects : undefined,
 pageCount: typeof entry.number_of_pages === 'number' ? entry.number_of_pages : undefined,
 publisher: Array.isArray(entry.publishers) ? entry.publishers[0]?.name : undefined,
 publishedDate: entry.publish_date || undefined,
 };
 return urls.map(url => ({ provider: 'openlibrary', url, metadata, openlibraryCoverId: `isbn_${n}` }));
 } catch {
 return [];
 }
}

/** OL search by title/author: return candidates L then M (escalation). */
async function getOlSearchCandidates(title: string, author?: string): Promise<CoverCandidate[]> {
 const params = new URLSearchParams();
 params.set('title', (title || '').trim());
 if (author && author.trim().toLowerCase() !== 'unknown') params.set('author', (author || '').trim());
 params.set('limit', '3');
 params.set('fields', 'cover_i,key,subject,edition_key');
 const apiUrl = `https://openlibrary.org/search.json?${params.toString()}`;
 try {
 const res = await fetch(apiUrl);
 if (!res.ok) return [];
 const data = await res.json() as { docs?: any[] };
 const docs = data?.docs;
 if (!Array.isArray(docs) || docs.length === 0) return [];
 const candidates: CoverCandidate[] = [];
 // Check up to 3 results for covers (first result may not have one)
 for (const doc of docs.slice(0, 3)) {
   const coverId = doc?.cover_i;
   const subjects = Array.isArray(doc?.subject) ? doc.subject.slice(0, 10) : undefined;
   const metadata: BookMetadata = subjects?.length ? { categories: subjects } : undefined;
   if (typeof coverId === 'number' && coverId > 0) {
     candidates.push(
       { provider: 'openlibrary', url: `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`, metadata, openlibraryCoverId: String(coverId) },
       { provider: 'openlibrary', url: `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`, metadata, openlibraryCoverId: String(coverId) },
     );
     break; // Found a cover, no need to check more results
   }
   // No cover_i — try the work's OLID as a cover source
   const workKey = doc?.key; // e.g. "/works/OL12345W"
   if (workKey && typeof workKey === 'string') {
     const olid = workKey.replace('/works/', '');
     candidates.push(
       { provider: 'openlibrary', url: `https://covers.openlibrary.org/b/olid/${olid}-L.jpg`, metadata },
       { provider: 'openlibrary', url: `https://covers.openlibrary.org/b/olid/${olid}-M.jpg`, metadata },
     );
   }
 }
 return candidates;
 } catch {
 return [];
 }
}

async function downloadImage(url: string): Promise<Buffer | null> {
 try {
 const res = await fetch(url);
 if (!res.ok) return null;
 const ab = await res.arrayBuffer();
 return Buffer.from(ab);
 } catch {
 return null;
 }
}

/**
 * Heuristic: title/author often get swapped by the model (e.g. title="SCOTT FITZGERALD" author="The Curious Case of Benjamin Button").
 * Before calling cover providers, correct so cover lookup uses the right fields.
 */
function likelyBookTitle(s: string): boolean {
 const t = (s || '').trim();
 if (!t) return false;
 const lower = t.toLowerCase();
 if (/^(the|a|an)\s+/.test(lower)) return true;
 const titleLike = /\b(the|case|curious|benjamin|story|life|adventures|secret|great|last|first)\b/i;
 return titleLike.test(t);
}

function likelyPersonName(s: string): boolean {
 const t = (s || '').trim();
 if (!t) return false;
 if (/\b(the|a|an)\b/i.test(t)) return false; // "GIFT FROM THE SEA" is a title
 const words = t.split(/\s+/).filter(Boolean);
 if (words.length < 2 || words.length > 4) return false;
 const lower = t.toLowerCase();
 if (/^(the|a|an)\s+/.test(lower)) return false;
 const allCapsOrCapitalized = words.every(w => /^[A-Z]/.test(w) || w === w.toUpperCase());
 return allCapsOrCapitalized;
}

function correctTitleAuthorSwap(title: string, author: string): { title: string; author: string } {
 const t = (title || '').trim();
 const a = (author || '').trim();
 if (!t || !a) return { title: t, author: a };
 if (likelyPersonName(t) && likelyBookTitle(a)) {
 return { title: a, author: t };
 }
 return { title: t, author: a };
}

/**
 * Strip volume/edition/series info from titles for better cover search matching.
 * "The Divine Comedy Vol. I: Inferno" → "The Divine Comedy Inferno"
 * "Selected Writings Volume 2" → "Selected Writings"
 * "Emma (Penguin Classics)" → "Emma"
 */
function simplifyTitleForSearch(title: string): string {
 let t = (title || '')
   // Remove "Vol.", "Volume", "Vol" + number
   .replace(/\b(?:vol(?:ume)?\.?\s*(?:[ivxlcdm]+|\d+))\b/gi, '')
   // Remove edition info
   .replace(/\b(?:\d+(?:st|nd|rd|th)\s+edition)\b/gi, '')
   // Remove parenthetical series/publisher info
   .replace(/\([^)]*(?:classics|edition|series|press|books|library|penguin|oxford|norton|vintage)[^)]*\)/gi, '')
   // Remove standalone Roman numerals after colon (": I", ": III")
   .replace(/:\s*[ivxlcdm]+\s*$/i, '')
   // Remove subtitle after colon for cleaner search (keep original as fallback)
   .replace(/\s*:.*$/, '')
   // Clean up leftover punctuation
   .replace(/\s*:\s*$/, '')
   .replace(/\s{2,}/g, ' ')
   .trim();
 // Convert ALL CAPS to Title Case for better search matching.
 // Search engines rank title-case queries higher than all-caps.
 if (t === t.toUpperCase() && t.length > 3) {
   t = t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
 }
 return t;
}

/** Google Books API: return candidates extraLarge large medium thumbnail smallThumbnail (escalation). */
async function getGoogleCandidates(title: string, author?: string): Promise<CoverCandidate[]> {
 const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
 // Preserve apostrophes, hyphens, accents — only strip control chars and quotes.
 const cleanTitle = (title || '').replace(/["]/g, '').trim();
 const cleanAuthor = (author || '').replace(/["]/g, '').trim();
 const q = cleanAuthor && cleanAuthor.toLowerCase() !== 'unknown'
 ? `intitle:${cleanTitle} inauthor:${cleanAuthor}`
 : `intitle:${cleanTitle}`;
 const params = new URLSearchParams({ q, maxResults: '5' });
 if (apiKey) params.set('key', apiKey);
 const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
 try {
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (res.status === 429 || !res.ok) return [];
 const data = await res.json() as { items?: any[] };
 const items = data?.items;
 if (!Array.isArray(items) || items.length === 0) return [];
 // Check ALL results (up to 5) for cover images, not just the first one.
 const allCandidates: CoverCandidate[] = [];
 for (const v of items) {
 const vi = v?.volumeInfo;
 const links = vi?.imageLinks;
 if (!links) continue;
 const urls = [
 links.extraLarge,
 links.large,
 links.medium,
 links.thumbnail,
 links.smallThumbnail,
 ].filter(Boolean).map((raw: string) => raw.replace('http:', 'https:'));
 if (urls.length === 0) continue;
 const metadata: BookMetadata = {
 description: vi?.description || undefined,
 categories: Array.isArray(vi?.categories) ? vi.categories : undefined,
 pageCount: typeof vi?.pageCount === 'number' ? vi.pageCount : undefined,
 publisher: vi?.publisher || undefined,
 publishedDate: vi?.publishedDate || undefined,
 language: vi?.language || undefined,
 subtitle: vi?.subtitle || undefined,
 };
 allCandidates.push(...urls.map(u => ({ provider: 'google_books' as const, url: u, metadata, googleVolumeId: v.id || '' })));
 }
 return allCandidates;
 } catch {
 return [];
 }
}

const CACHE_MAX_AGE = '31536000'; // 1 year - covers rarely change
const DEFAULT_CONTENT_TYPE = 'image/jpeg';
/** Legacy: was used to reject small images; acceptance is now dimension-based. Kept for save-cover minimum. */
export const COVER_MIN_BYTES = 5000;
/** Minimum width/height (px). Use dimensions, not bytes bytes are noisy (e.g. 45KB at 128x194 is normal for Google thumbnails). */
export const COVER_MIN_DIMENSION = 80;
/** Reject buffers smaller than this (empty/error responses). */
const COVER_MIN_BYTES_FLOOR = 500;

/** Get image dimensions from buffer. Returns { width, height } or null. */
async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number } | null> {
 try {
 const meta = await sharp(buffer).metadata();
 const w = meta.width;
 const h = meta.height;
 if (typeof w === 'number' && typeof h === 'number') return { width: w, height: h };
 return null;
 } catch {
 return null;
 }
}

/** True if buffer passes size/dimension guards (dont cache thumbnails/error pages). Caller uses this before upload; if false, try next candidate. */
export async function acceptableCover(buffer: Buffer): Promise<{ ok: boolean; bytes: number; width?: number; height?: number; quality?: 'low' | 'high' }> {
 const bytes = buffer.length;
 if (bytes < COVER_MIN_BYTES_FLOOR) return { ok: false, bytes };
 const dims = await getImageDimensions(buffer);
 const width = dims?.width ?? 0;
 const height = dims?.height ?? 0;
 const ok = width >= COVER_MIN_DIMENSION && height >= COVER_MIN_DIMENSION;
 const quality: 'low' | 'high' = ok && (bytes < COVER_MIN_BYTES || width < 150 || height < 150) ? 'low' : 'high';
 return { ok, bytes, width: dims?.width, height: dims?.height, quality: ok ? quality : undefined };
}

/** Redact URL for logging (keep host + path prefix, truncate query). */
function redactUrl(url: string, maxLen = 100): string {
 try {
 const u = url.replace(/^https?:\/\//, '').split('?')[0];
 return u.length > maxLen ? u.slice(0, maxLen) + '' : u;
 } catch {
 return '(invalid url)';
 }
}

async function uploadToStorage(db: any, workKey: string, buffer: Buffer, contentType = DEFAULT_CONTENT_TYPE): Promise<string | null> {
 const path = workKeyToStoragePath(workKey, '.jpg');
 if (!path) return null;
 const resized = await resizeCoverForStorage(buffer);
 const { error } = await db.storage.from(BUCKET).upload(path, resized, {
 contentType,
 upsert: true,
 cacheControl: CACHE_MAX_AGE,
 });
 if (error) {
 console.error('[coverResolution] Storage upload error:', error.message);
 return null;
 }
 return path;
}

export type ResolveResult =
 | { coverUrl: string; googleBooksId: string; metadata?: BookMetadata }
 | { placeholder: true }
 | null;

function rowToMetadata(row: any): BookMetadata | undefined {
 if (!row) return undefined;
 const m: BookMetadata = {};
 if (row.description) m.description = row.description;
 if (Array.isArray(row.categories) && row.categories.length > 0) m.categories = row.categories;
 if (typeof row.page_count === 'number') m.pageCount = row.page_count;
 if (row.publisher) m.publisher = row.publisher;
 if (row.published_date) m.publishedDate = row.published_date;
 if (row.language) m.language = row.language;
 if (row.subtitle) m.subtitle = row.subtitle;
 return Object.keys(m).length > 0 ? m : undefined;
}

/** Resolve one book. Returns coverUrl+googleBooksId+metadata, { placeholder: true }, or null. */
export async function resolveOne(
 db: any,
 isbn: string,
 title: string,
 author: string,
 workKey: string
): Promise<ResolveResult> {
 const now = new Date().toISOString();

 const selectCols = 'cover_storage_path, status, last_attempt_at, updated_at, google_volume_id, description, categories, page_count, publisher, published_date, language, subtitle';
 const { data: row } = await db.from('cover_resolutions').select(selectCols).eq('work_key', workKey).maybeSingle();

 // Guarantee: only use cache when row implies usable image (status ready + path set). Auto-heal: verify object exists.
 if (row?.cover_storage_path != null && row.cover_storage_path !== '' && (row?.status === 'ready' || row?.status === 'resolved')) {
 const path = row.cover_storage_path;
 const exists = await verifyStorageObjectExists(path);
 if (exists) {
 console.log(`[COVER] skip download (verified cache) workKey=${workKey}`);
 const url = getStoragePublicUrl(path);
 const metadata = rowToMetadata(row);
 return { coverUrl: url, googleBooksId: row.google_volume_id || workKey, metadata };
 }
 console.log(`[COVER] auto-heal: storage object missing/broken workKey=${workKey}, re-downloading`);
 const updatePayload = pickCoverResPayload({ status: 'error', updated_at: now });
 await db.from('cover_resolutions').update(updatePayload).eq('work_key', workKey);
 // fall through to re-download + re-upload below
 }

 const lastAttempt = row?.last_attempt_at || row?.updated_at;
 if ((row?.status === 'missing' || row?.status === 'error' || row?.status === 'failed') && lastAttempt) {
 const attempted = new Date(lastAttempt).getTime();
 const cutoff = Date.now() - MISS_RETRY_HOURS * 60 * 60 * 1000;
 if (attempted > cutoff) return { placeholder: true };
 }

 const pendingPayload = pickCoverResPayload({
 work_key: workKey,
 status: 'pending',
 updated_at: now,
 });
 await db.from('cover_resolutions').upsert(pendingPayload, { onConflict: 'work_key' });

 try {
 console.log(`[COVER] MISS workKey=${workKey} -> trying candidates (large first, then fallbacks)`);
 await acquireRateLimitToken();

 const allowed = await acquireCoverRateLimit();
 if (!allowed) {
 await new Promise(r => setTimeout(r, 2000));
 const retryAllowed = await acquireCoverRateLimit();
 if (!retryAllowed) {
 console.log(`[COVER] FAIL workKey=${workKey} title="${(title || '').replace(/"/g, '\\"')}" author="${(author || '').replace(/"/g, '\\"')}" reasons: rate_limited`);
 return { placeholder: true };
 }
 }

 const rejectReasons: string[] = [];

 // Correct title/author swap before provider lookups (e.g. title="SCOTT FITZGERALD" author="The Curious Case..." swap).
 const { title: searchTitle, author: searchAuthor } = correctTitleAuthorSwap(title || '', author || '');
 if (searchTitle !== title || searchAuthor !== author) {
 console.log(`[COVER] title/author swap corrected for lookup workKey=${workKey} -> title="${searchTitle}" author="${searchAuthor}"`);
 }

 // Build candidates: OpenLibrary first (no API key needed), Google Books as fallback.
 const candidates: CoverCandidate[] = [];
 if (isbn?.trim()) {
 const ol = await getOlByIsbnCandidates(isbn);
 if (ol.length === 0) rejectReasons.push('openlibrary_isbn none_found');
 candidates.push(...ol);
 }
 if (searchTitle?.trim()) {
 // Simplify title for better matching (strip vol/edition info, convert ALL CAPS)
 const simpleTitle = simplifyTitleForSearch(searchTitle);
 // Normalize author for search: convert ALL CAPS to Title Case
 let normalizedAuthor = (searchAuthor || '').trim();
 if (normalizedAuthor === normalizedAuthor.toUpperCase() && normalizedAuthor.length > 3) {
   normalizedAuthor = normalizedAuthor.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
 }
 // OpenLibrary search first (free, no rate limit issues)
 const olSearch = await getOlSearchCandidates(simpleTitle, normalizedAuthor || undefined);
 if (olSearch.length === 0) rejectReasons.push('openlibrary_search none_found');
 candidates.push(...olSearch);
 // If simplified title differs, also try original (some titles need the exact match)
 if (simpleTitle !== searchTitle.trim() && olSearch.length === 0) {
   const olOriginal = await getOlSearchCandidates(searchTitle, normalizedAuthor || undefined);
   if (olOriginal.length > 0) candidates.push(...olOriginal);
 }
 // Google Books as fallback (has API key quota limits)
 const google = await getGoogleCandidates(simpleTitle, normalizedAuthor || undefined);
 if (google.length === 0) rejectReasons.push('google_books none_found');
 candidates.push(...google);
 }

 for (const c of candidates) {
 await acquireRateLimitToken();
 const buffer = await downloadImage(c.url);
 if (!buffer) {
 rejectReasons.push(`${c.provider} download_failed`);
 continue;
 }
 const check = await acceptableCover(buffer);
 if (!check.ok) {
 const w = check.width ?? '?';
 const h = check.height ?? '?';
 rejectReasons.push(`${c.provider} too_small(${w}x${h})`);
 continue;
 }
 const path = await uploadToStorage(db, workKey, buffer);
 if (!path) {
 rejectReasons.push(`${c.provider} upload_failed`);
 continue;
 }
 // Worker upsert: only allowed columns (work_key, cover_storage_path, source, status, width, height, mime, updated_at).
 const source = c.provider === 'google_books' ? 'google' : 'openlibrary';
 console.log('[COVER] uploaded', { workKey, cover_storage_path: path, source });
 const coverUrl = getStoragePublicUrl(path);
 const googleVolumeId = c.googleVolumeId ?? '';
 const openlibraryCoverId = c.openlibraryCoverId ?? null;
 const metadata = c.metadata ?? {};

 const payload = pickCoverResPayload({
 work_key: workKey,
 cover_storage_path: path,
 source,
 status: 'ready',
 width: check.width ?? null,
 height: check.height ?? null,
 mime: 'image/jpeg',
 updated_at: now,
 });
 const { error } = await db
 .from('cover_resolutions')
 .upsert(payload, { onConflict: 'work_key' });

 if (error) {
 console.error('[COVER] upsert failed', { workKey, error });
 throw error;
 }
 console.log('[COVER] upsert ok');
 const outMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
 return { coverUrl, googleBooksId: googleVolumeId || openlibraryCoverId || workKey, metadata: outMetadata };
 }

 // Only after all candidates fail do we mark missing.
 const reasonsStr = rejectReasons.length > 0 ? rejectReasons.join(', ') : 'no_candidates';
 console.log(`[COVER] FAIL workKey=${workKey} title="${(title || '').replace(/"/g, '\\"')}" author="${(author || '').replace(/"/g, '\\"')}" reasons: ${reasonsStr}`);

 const missingPayload = pickCoverResPayload({
 status: 'missing',
 updated_at: now,
 });
 await db.from('cover_resolutions').update(missingPayload).eq('work_key', workKey);

 return { placeholder: true };
 } catch (err: any) {
 console.error('[COVER] failed', { workKey, err: err?.message || err });
 try {
 const errorPayload = pickCoverResPayload({ status: 'error', updated_at: new Date().toISOString() });
 await db.from('cover_resolutions').update(errorPayload).eq('work_key', workKey);
 } catch (_) { /* ignore */ }
 throw err;
 }
}
