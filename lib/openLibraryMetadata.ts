/**
 * Open Library as primary metadata source: /search.json /works/{id}.json.
 * Returns full metadata (description, subjects, number_of_pages, first_publish_date, etc.).
 */

import { sanitizeTextForDb } from './sanitizeTextForDb';

export interface OpenLibraryMetadata {
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
 open_library_work_id?: string | null;
}

function extractDescription(desc: unknown): string | null {
 if (typeof desc === 'string' && desc.trim()) return desc.trim();
 if (desc && typeof desc === 'object' && typeof (desc as { value?: string }).value === 'string') {
 const v = (desc as { value: string }).value.trim();
 if (v) return v;
 }
 return null;
}

/** Fetch full metadata from Open Library: search by ISBN or title/author, then /works/{id}.json. */
export async function fetchFullMetadataFromOpenLibrary(book: {
 title?: string | null;
 author?: string | null;
 isbn?: string | null;
}): Promise<OpenLibraryMetadata & { workId: string | null }> {
 const title = (book.title || '').trim();
 const author = (book.author || '').trim();
 const isbn = (book.isbn || '').replace(/\D/g, '');

 let workId: string | null = null;

 try {
 if (isbn.length >= 10) {
 const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=details&format=json`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (res.ok) {
 const data = (await res.json()) as Record<string, { details?: { works?: Array<{ key?: string }> } }>;
 const key = Object.keys(data).find((k) => k.startsWith('ISBN:'));
 const works = data[key]?.details?.works;
 if (works?.length && works[0].key) {
 workId = works[0].key.replace('/works/', '');
 }
 }
 }

 if (!workId && title.length >= 2) {
 const params = new URLSearchParams({ q: title, limit: '3' });
 if (author) params.set('author', author);
 const url = `https://openlibrary.org/search.json?${params.toString()}`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (res.ok) {
 const data = (await res.json()) as { docs?: Array<{ key?: string }> };
 const firstKey = data?.docs?.[0]?.key;
 if (firstKey?.startsWith('/works/')) workId = firstKey.replace('/works/', '');
 }
 }

 if (!workId) {
 return { workId: null };
 }

 const workUrl = `https://openlibrary.org/works/${workId}.json`;
 const workRes = await fetch(workUrl, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!workRes.ok) return { workId };

 const work = (await workRes.json()) as {
 description?: string | { value?: string };
 subjects?: string[];
 first_publish_date?: string;
 number_of_pages?: number;
 subtitle?: string;
 covers?: number[];
 };

 const description = extractDescription(work.description);
 const published_date = work.first_publish_date || undefined;
 const page_count = typeof work.number_of_pages === 'number' ? work.number_of_pages : undefined;
 const categories = Array.isArray(work.subjects) && work.subjects.length ? work.subjects : undefined;
 const subtitle = work.subtitle ? sanitizeTextForDb(work.subtitle) ?? undefined : undefined;

 return {
 description: description || undefined,
 published_date,
 page_count,
 categories,
 subtitle,
 open_library_work_id: workId,
 workId,
 };
 } catch {
 return { workId };
 }
}
