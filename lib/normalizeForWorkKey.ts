/**
 * Canonical normalization for work_key NO crypto, works on client and server.
 * Use this everywhere so work_key generation is identical on client + server.
 *
 * Pipeline: trim collapse whitespace lowercase remove trailing punctuation.
 * Author: treat missing / "Unknown" / "Unknown Author" as "" (NOT "Unknown").
 */

const TRAILING_PUNCT = /^[\s.,;:!?'"\-]+|[\s.,;:!?'"\-]+$/g;

function collapseWhitespace(s: string): string {
 return s.replace(/\s+/g, ' ').trim();
}

function removeTrailingPunctuation(s: string): string {
 return s.replace(TRAILING_PUNCT, '').trim();
}

/**
 * Canonical string normalization for work_key: trim collapse whitespace lowercase remove trailing punctuation.
 */
export function normalizeForWorkKey(value?: string | null): string {
 if (value == null) return '';
 let s = String(value).trim();
 s = collapseWhitespace(s);
 s = s.toLowerCase();
 s = removeTrailingPunctuation(s);
 return s;
}

/** Treat missing or "Unknown" author as "" so work_key is deterministic. */
function authorForWorkKey(author?: string | null): string {
 if (author == null) return '';
 const t = author.trim().toLowerCase();
 if (!t || t === 'unknown' || t === 'unknown author') return '';
 const normalized = normalizeForWorkKey(author);
 if (!normalized) return '';
 // Stable canonicalization: "Lastname, Firstname" and "Firstname Lastname" same key (sort name parts).
 const parts = normalized.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
 if (parts.length === 0) return '';
 parts.sort();
 return parts.join(' ');
}

/** Canonical title normalization for work_key. Collapse whitespace, lowercase, strip trailing punctuation. */
export function normalizeTitle(title?: string | null): string {
 return normalizeForWorkKey(title);
}

/** Canonical author normalization for work_key. Missing / "Unknown" "". Name parts sorted so "Doe, John" and "John Doe" match. */
export function normalizeAuthor(author?: string | null): string {
 return authorForWorkKey(author);
}
