/**
 * Canonical work_key (cover key) DETERMINISTIC. Use everywhere (server, worker, APIs).
 * If this is inconsistent, cache will never work properly ("cover exists but app can't find it").
 *
 * Normalization lives in normalizeForWorkKey.ts (client + server). Here we add the hash (server-only).
 *
 * Format:
 * isbn13:<isbn> when ISBN exists (13 digits)
 * isbn10:<isbn> when ISBN exists (10 digits, no 13)
 * ta:<sha1> sha1(normalized_title + "|" + normalized_author) when no ISBN
 */
import { createHash } from 'crypto';
import { normalizeTitle as normTitle, normalizeAuthor as normAuthor } from './normalizeForWorkKey';

export { normalizeForWorkKey, normalizeTitle, normalizeAuthor } from './normalizeForWorkKey';

export function normalizeIsbn(s: string): string {
 return (s || '').replace(/[-\s]/g, '').trim();
}

export function isIsbn13(s: string): boolean {
 const n = normalizeIsbn(s);
 return n.length === 13 && /^\d{12}[\dX]$/.test(n);
}

export function isIsbn10(s: string): boolean {
 const n = normalizeIsbn(s);
 return n.length === 10 && /^[\dX]{10}$/.test(n);
}

function sha1(s: string): string {
 return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** Build canonical work_key: ISBN first, else ta:sha1(normalized_title + "|" + normalized_author). Deterministic. */
export function buildWorkKey(isbn?: string, title?: string, author?: string): string {
 const n = normalizeIsbn(isbn || '');
 if (n.length === 13) return `isbn13:${n}`;
 if (n.length === 10) return `isbn10:${n}`;
 const t = normTitle(title);
 const a = normAuthor(author);
 if (!t && !a) return '';
 return `ta:${sha1(`${t}|${a}`)}`;
}

/**
 * Convert work_key to safe storage path with prefix (isbn13/, isbn10/, ta/).
 * Example: isbn13:9780140283297 isbn13/9780140283297.jpg
 */
export function workKeyToStoragePath(workKey: string, ext = '.jpg'): string {
 if (!workKey || !workKey.includes(':')) return '';
 const [prefix, value] = workKey.split(':', 2);
 if (!prefix || !value) return '';
 const safePrefix = prefix === 'isbn13' ? 'isbn13' : prefix === 'isbn10' ? 'isbn10' : prefix === 'ta' ? 'ta' : 'ta';
 return `${safePrefix}/${value}${ext}`;
}

/** Return { workKey, normTitle, normAuthor } for storage/debugging. */
export function buildWorkKeyWithNorms(isbn?: string, title?: string, author?: string): {
 workKey: string;
 normTitle: string;
 normAuthor: string;
} {
 const t = normTitle(title);
 const a = normAuthor(author);
 const n = normalizeIsbn(isbn || '');
 let workKey: string;
 if (n.length === 13) workKey = `isbn13:${n}`;
 else if (n.length === 10) workKey = `isbn10:${n}`;
 else workKey = t || a ? `ta:${sha1(`${t}|${a}`)}` : '';
 return { workKey, normTitle: t, normAuthor: a };
}