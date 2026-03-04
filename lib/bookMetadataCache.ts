/**
 * Global book_metadata_cache: lookup by priority keys, upsert by best key.
 * Never allow user deletes to touch this table (only service role writes; no delete in app code).
 */

export interface CachedMetadata {
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
  source?: 'open_library' | 'google_books' | null;
}

/** Try cache keys in order; return first hit or null. */
export async function getFromCache(
  supabase: any,
  cacheKeys: string[]
): Promise<CachedMetadata | null> {
  if (!supabase || !cacheKeys.length) return null;
  for (const key of cacheKeys) {
    if (!key || key.trim().length === 0) continue;
    const { data, error } = await supabase
      .from('book_metadata_cache')
      .select('description, publisher, published_date, page_count, categories, language, subtitle, isbn, average_rating, ratings_count, google_books_id, open_library_work_id, source')
      .eq('cache_key', key)
      .maybeSingle();
    if (!error && data) return data as CachedMetadata;
  }
  return null;
}

/** Upsert one row by cache_key. */
export async function upsertCache(
  supabase: any,
  cacheKey: string,
  data: CachedMetadata,
  source: 'open_library' | 'google_books'
): Promise<void> {
  if (!supabase || !cacheKey || cacheKey.trim().length === 0) return;
  const now = new Date().toISOString();
  await supabase
    .from('book_metadata_cache')
    .upsert(
      {
        cache_key: cacheKey,
        description: data.description ?? null,
        publisher: data.publisher ?? null,
        published_date: data.published_date ?? null,
        page_count: data.page_count ?? null,
        categories: data.categories ?? null,
        language: data.language ?? null,
        subtitle: data.subtitle ?? null,
        isbn: data.isbn ?? null,
        average_rating: data.average_rating ?? null,
        ratings_count: data.ratings_count ?? null,
        google_books_id: data.google_books_id ?? null,
        open_library_work_id: data.open_library_work_id ?? null,
        source,
        updated_at: now,
      },
      { onConflict: 'cache_key' }
    );
}

/** Build cache keys in priority order: isbn_13, google_books_id, open_library_work_id, work_key. */
export function buildCacheKeys(opts: {
  isbn_13?: string | null;
  google_books_id?: string | null;
  open_library_work_id?: string | null;
  work_key?: string | null;
}): string[] {
  const keys: string[] = [];
  const n = (s: string | null | undefined) => (s && String(s).trim()) || '';
  const isbn = n(opts.isbn_13).replace(/\D/g, '');
  if (isbn.length === 13) keys.push(`isbn13:${isbn}`);
  if (opts.google_books_id) keys.push(`google:${String(opts.google_books_id).trim()}`);
  if (opts.open_library_work_id) keys.push(`ol_work:${String(opts.open_library_work_id).trim()}`);
  if (opts.work_key) keys.push(`work_key:${String(opts.work_key).trim()}`);
  return keys;
}
