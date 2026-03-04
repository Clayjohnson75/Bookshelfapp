/**
 * Server-side metadata enrichment: Open Library (primary) Google Books (fallback only if no description).
 * Global cache book_metadata_cache keyed by isbn_13, google_books_id, open_library_work_id, work_key.
 * Never log full descriptions (caller logs descLen only).
 */

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1';

import { sanitizeTextForDb } from './sanitizeTextForDb';
import { getFromCache, upsertCache, buildCacheKeys, CachedMetadata } from './bookMetadataCache';
import { fetchFullMetadataFromOpenLibrary } from './openLibraryMetadata';

export interface BookRowInput {
 id?: string;
 title?: string | null;
 author?: string | null;
 isbn?: string | null;
 google_books_id?: string | null;
}

export interface EnrichedMetadata {
 description?: string | null;
 publisher?: string | null;
 published_date?: string | null;
 page_count?: number | null;
 categories?: string[] | null;
 language?: string | null;
 subtitle?: string | null;
 isbn?: string | null;
 average_rating?: number | null;
 ratings_count?: number | null;
 google_books_id?: string | null;
 open_library_work_id?: string | null;
 description_source?: 'google_books' | 'open_library' | null;
 enrichment_status: 'complete' | 'failed' | 'not_found';
}

/** For worker logging: where the result came from. */
export type EnrichSourceTag = 'cache' | 'open_library' | 'google_books' | 'not_found' | 'failed';

export interface EnrichedMetadataResult {
 meta: EnrichedMetadata;
 sourceTag: EnrichSourceTag;
}

function isbn13(s: string | null | undefined): string | null {
 const n = (s || '').replace(/\D/g, '');
 return n.length === 13 && /^\d{12}[\dX]$/i.test(n) ? n : null;
}

/** Fetch one volume by ID from Google Books (fallback only when Open Library has no description). */
async function fetchVolumeById(volumeId: string): Promise<any | null> {
 if (!GOOGLE_BOOKS_API_KEY) return null;
 const url = `${GOOGLE_BOOKS_BASE}/volumes/${encodeURIComponent(volumeId)}?key=${GOOGLE_BOOKS_API_KEY}`;
 try {
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as { volumeInfo?: any; id?: string };
 return data?.volumeInfo ? { id: data.id, volumeInfo: data.volumeInfo } : null;
 } catch {
 return null;
 }
}

/** Search Google Books by title/author; returns first volume or null. */
async function searchVolumes(title: string, author: string): Promise<any | null> {
 if (!GOOGLE_BOOKS_API_KEY || !title || title.trim().length < 2) return null;
 const cleanTitle = (title || '').replace(/[^\w\s]/g, ' ').trim();
 const cleanAuthor = (author || '').trim();
 const query = cleanAuthor
 ? `intitle:"${cleanTitle}" inauthor:"${cleanAuthor}"`
 : `intitle:"${cleanTitle}"`;
 const url = `${GOOGLE_BOOKS_BASE}/volumes?q=${encodeURIComponent(query)}&maxResults=5&key=${GOOGLE_BOOKS_API_KEY}`;
 try {
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as { items?: Array<{ id?: string; volumeInfo?: any }> };
 const first = data?.items?.[0];
 return first?.volumeInfo ? { id: first.id, volumeInfo: first.volumeInfo } : null;
 } catch {
 return null;
 }
}

function mapVolumeToMetadata(volume: { id?: string; volumeInfo?: any }, book: BookRowInput): Partial<EnrichedMetadata> {
 const vi = volume?.volumeInfo || {};
 const isbn13Val = (vi.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_13')?.identifier;
 const isbn10 = (vi.industryIdentifiers || []).find((id: any) => id.type === 'ISBN_10')?.identifier;
 const isbn = isbn13Val || isbn10 || book.isbn;
 return {
 description: typeof vi.description === 'string' && vi.description.trim() ? vi.description.trim() : undefined,
 publisher: vi.publisher ? sanitizeTextForDb(vi.publisher) ?? undefined : undefined,
 published_date: vi.publishedDate || undefined,
 page_count: typeof vi.pageCount === 'number' ? vi.pageCount : undefined,
 categories: Array.isArray(vi.categories) && vi.categories.length ? vi.categories : undefined,
 language: vi.language || undefined,
 subtitle: vi.subtitle ? sanitizeTextForDb(vi.subtitle) ?? undefined : undefined,
 isbn: isbn || undefined,
 average_rating: typeof vi.averageRating === 'number' ? vi.averageRating : undefined,
 ratings_count: typeof vi.ratingsCount === 'number' ? vi.ratingsCount : undefined,
 google_books_id: volume?.id || undefined,
 description_source: 'google_books',
 };
}

/**
 * Fetch full metadata: A) try cache B) Open Library C) if no description, Google Books D) upsert cache E) return.
 * Only use Google Books when Open Library does not provide description.
 */
export async function fetchFullMetadataForBook(
 book: BookRowInput,
 opts?: { supabase?: any; work_key?: string | null }
): Promise<EnrichedMetadataResult> {
 const title = (book.title || '').trim();
 const author = (book.author || '').trim();
 const supabase = opts?.supabase ?? null;
 const work_key = opts?.work_key ?? null;

 const isbn13Key = isbn13(book.isbn);

 try {
 const cacheKeys = buildCacheKeys({
 isbn_13: isbn13Key ?? undefined,
 google_books_id: book.google_books_id ?? undefined,
 open_library_work_id: undefined,
 work_key: work_key ?? undefined,
 });

 const cached = supabase ? await getFromCache(supabase, cacheKeys) : null;
 if (cached && (cached.description || cached.publisher || cached.published_date || cached.page_count)) {
 const hasDesc = typeof cached.description === 'string' && cached.description.trim().length > 0;
 return {
 meta: {
 ...cached,
 description_source: cached.source ?? null,
 enrichment_status: hasDesc ? 'complete' : (cached.source ? 'complete' : 'not_found'),
 },
 sourceTag: 'cache',
 };
 }

 const ol = await fetchFullMetadataFromOpenLibrary({ title: book.title, author: book.author, isbn: book.isbn });
 let description: string | null = ol.description ?? null;
 let description_source: 'open_library' | 'google_books' | null = ol.description ? 'open_library' : null;
 let base: Partial<EnrichedMetadata> = {
 ...ol,
 open_library_work_id: ol.open_library_work_id ?? undefined,
 description_source: ol.description ? 'open_library' : null,
 };

 if (!(typeof description === 'string' && description.trim().length > 0)) {
 let volume: { id?: string; volumeInfo?: any } | null = null;
 if (book.google_books_id) volume = await fetchVolumeById(book.google_books_id);
 if (!volume && title) volume = await searchVolumes(title, author);
 if (volume) {
 const gMeta = mapVolumeToMetadata(volume, book);
 description = gMeta.description ?? null;
 description_source = description ? 'google_books' : null;
 base = { ...base, ...gMeta };
 }
 }

 const hasDesc = typeof description === 'string' && description.trim().length > 0;
 const enrichment_status: EnrichedMetadata['enrichment_status'] = hasDesc
 ? 'complete'
 : description_source
 ? 'complete'
 : 'not_found';

 const meta: EnrichedMetadata = {
 ...base,
 description: description || null,
 description_source,
 enrichment_status,
 };

 const sourceTag: EnrichSourceTag = hasDesc
 ? (description_source === 'open_library' ? 'open_library' : 'google_books')
 : description_source
 ? 'open_library'
 : 'not_found';

 if (supabase) {
 const bestKey =
 isbn13Key ? `isbn13:${isbn13Key}` :
 meta.google_books_id ? `google:${meta.google_books_id}` :
 meta.open_library_work_id ? `ol_work:${meta.open_library_work_id}` :
 work_key ? `work_key:${work_key}` : null;
 if (bestKey && (hasDesc || meta.publisher || meta.published_date || meta.page_count)) {
 const cacheSource = description_source || (meta.open_library_work_id ? 'open_library' : 'google_books');
 await upsertCache(
 supabase,
 bestKey,
 {
 description: meta.description,
 publisher: meta.publisher,
 published_date: meta.published_date,
 page_count: meta.page_count,
 categories: meta.categories,
 language: meta.language,
 subtitle: meta.subtitle,
 isbn: meta.isbn,
 average_rating: meta.average_rating,
 ratings_count: meta.ratings_count,
 google_books_id: meta.google_books_id,
 open_library_work_id: meta.open_library_work_id,
 source: cacheSource,
 },
 cacheSource
 );
 }
 }

 return { meta, sourceTag };
 } catch {
 return {
 meta: { enrichment_status: 'failed', description_source: null },
 sourceTag: 'failed',
 };
 }
}
