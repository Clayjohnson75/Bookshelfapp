/**
 * Deterministic book_key for dedupe: (user_id, book_key) unique.
 * Client-safe (no Node crypto). Use for upserts in books table.
 *
 * Format:
 * isbn13:<digits> when ISBN has 13 digits
 * ta:<title>|<author> normalized title|author (empty title+author empty:|id or empty:fallback)
 */
import { normalizeTitle, normalizeAuthor } from './normalizeForWorkKey';

function normalizeIsbnClient(s: string): string {
 return (s || '').replace(/[-\s]/g, '').trim();
}

function isIsbn13(s: string): boolean {
 const n = normalizeIsbnClient(s);
 return n.length === 13 && /^\d{12}[\dX]$/i.test(n);
}

/**
 * Compute book_key for a book. Deterministic; same inputs same key.
 */
export function computeBookKey(book: {
 title?: string | null;
 author?: string | null;
 isbn?: string | null;
 id?: string | null;
}): string {
 const isbn = book.isbn ? normalizeIsbnClient(book.isbn) : '';
 if (isbn.length === 13 && /^\d{12}[\dX]$/i.test(isbn)) {
 return `isbn13:${isbn}`;
 }
 const t = normalizeTitle(book.title);
 const a = normalizeAuthor(book.author);
 if (t || a) return `${t}|${a}`;
 return `empty:${book.id || `fallback_${Date.now()}`}`;
}

/**
 * Stable identity key for a book. Use for list keys and merge dedupe so id changes don't cause churn.
 * Prefer stored book_key so it stays stable across sync (temp id -> canonical id).
 */
export function getStableBookKey(book: { book_key?: string | null; title?: string | null; author?: string | null; isbn?: string | null; id?: string | null }): string {
 if (book.book_key && typeof book.book_key === 'string' && book.book_key.trim()) {
 return book.book_key.trim();
 }
 return computeBookKey(book);
}

/** DB column is source_photo_id. Use this when grouping books by photo / countsByPhotoId so we never use book.photo_id (does not exist). */
export function getBookSourcePhotoId(book: { sourcePhotoId?: string | null; source_photo_id?: string | null; photoId?: string | null }): string | undefined {
 const v = book.sourcePhotoId ?? book.source_photo_id ?? book.photoId;
 return typeof v === 'string' && v.trim() ? v : undefined;
}

/** DB column is source_scan_job_id. Use this when grouping books by scan job so we never use book.scan_job_id (does not exist). */
export function getBookSourceScanJobId(book: { source_scan_job_id?: string | null; scanJobId?: string | null }): string | undefined {
 const v = book.source_scan_job_id ?? book.scanJobId;
 return typeof v === 'string' && v.trim() ? v : undefined;
}
