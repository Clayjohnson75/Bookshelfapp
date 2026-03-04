/**
 * Server-side description enrichment: Google Books Open Library not_found.
 * Used by POST /api/books/enrich-description and enrich-batch.
 */

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1';

export type EnrichResult =
 | { description: string; source: 'google_books' | 'open_library' }
 | { status: 'not_found' };

interface BookRow {
 id?: string;
 title?: string | null;
 author?: string | null;
 isbn?: string | null;
 google_books_id?: string | null;
}

/** Try Google Books: by volume id if we have it, else search by title/author. */
async function fetchFromGoogleBooks(book: BookRow): Promise<string | null> {
 if (!GOOGLE_BOOKS_API_KEY) return null;
 const title = (book.title || '').trim();
 if (title.length < 2) return null;

 try {
 if (book.google_books_id) {
 const url = `${GOOGLE_BOOKS_BASE}/volumes/${encodeURIComponent(book.google_books_id)}?key=${GOOGLE_BOOKS_API_KEY}`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as { volumeInfo?: { description?: string } };
 const desc = data?.volumeInfo?.description;
 return typeof desc === 'string' && desc.trim() ? desc.trim() : null;
 }

 const author = (book.author || '').trim();
 const query = author ? `intitle:"${title}" inauthor:"${author}"` : `intitle:"${title}"`;
 const url = `${GOOGLE_BOOKS_BASE}/volumes?q=${encodeURIComponent(query)}&maxResults=3&key=${GOOGLE_BOOKS_API_KEY}`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as { items?: Array<{ volumeInfo?: { description?: string } }> };
 const first = data?.items?.[0]?.volumeInfo?.description;
 return typeof first === 'string' && first.trim() ? first.trim() : null;
 } catch {
 return null;
 }
}

/** Try Open Library: by ISBN then search by title/author. */
async function fetchFromOpenLibrary(book: BookRow): Promise<string | null> {
 const title = (book.title || '').trim();
 if (title.length < 2) return null;

 try {
 if (book.isbn) {
 const cleanIsbn = String(book.isbn).replace(/\D/g, '');
 if (cleanIsbn.length >= 10) {
 const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(cleanIsbn)}&jscmd=details&format=json`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as Record<string, { details?: { description?: string | { value?: string } } }>;
 const key = Object.keys(data).find((k) => k.startsWith('ISBN:'));
 if (!key) return null;
 const details = data[key]?.details;
 const desc = details?.description;
 if (typeof desc === 'string' && desc.trim()) return desc.trim();
 if (desc && typeof desc === 'object' && typeof (desc as { value?: string }).value === 'string') {
 const v = (desc as { value: string }).value.trim();
 if (v) return v;
 }
 }
 }

 const author = (book.author || '').trim();
 const params = new URLSearchParams({ title: title, limit: '3' });
 if (author) params.set('author', author);
 const url = `https://openlibrary.org/search.json?${params.toString()}`;
 const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!res.ok) return null;
 const data = (await res.json()) as { docs?: Array<{ key?: string }> };
 const firstKey = data?.docs?.[0]?.key;
 if (!firstKey || !firstKey.startsWith('/works/')) return null;
 const workId = firstKey.replace('/works/', '');
 const workUrl = `https://openlibrary.org/works/${workId}.json`;
 const workRes = await fetch(workUrl, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
 if (!workRes.ok) return null;
 const work = (await workRes.json()) as { description?: string | { value?: string } };
 const desc = work?.description;
 if (typeof desc === 'string' && desc.trim()) return desc.trim();
 if (desc && typeof desc === 'object' && typeof (desc as { value?: string }).value === 'string') {
 const v = (desc as { value: string }).value.trim();
 if (v) return v;
 }
 return null;
 } catch {
 return null;
 }
}

/** Try providers in order; return description + source or not_found. */
export async function fetchDescriptionForBook(book: BookRow): Promise<EnrichResult> {
 const fromGoogle = await fetchFromGoogleBooks(book);
 if (fromGoogle) return { description: fromGoogle, source: 'google_books' };

 const fromOpenLibrary = await fetchFromOpenLibrary(book);
 if (fromOpenLibrary) return { description: fromOpenLibrary, source: 'open_library' };

 return { status: 'not_found' };
}
