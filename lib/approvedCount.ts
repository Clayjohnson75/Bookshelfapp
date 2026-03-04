/**
 * Canonical approved count: unique book_key (excludes deleted).
 * Use this everywhere profile/header/library show "approved book count" so duplicates
 * (same book_key multiple times) don't inflate the number.
 */
import { getStableBookKey } from './bookKey';

/** Minimal book-like shape for counting (approved list items). */
type BookLike = {
  book_key?: string | null;
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  id?: string | null;
  status?: string | null;
  deleted_at?: string | null;
};

/**
 * Count unique approved books by book_key. Excludes rows without book_key or with deleted_at set.
 * Use this as the single source of truth for profile book count, header stats, and library count.
 */
export function getApprovedUniqueCount(approved: BookLike[]): number {
  const seen = new Set<string>();
  for (const b of approved) {
    if (b?.deleted_at != null) continue;
    if (b?.status !== 'approved') continue;
    const key = getStableBookKey(b);
    if (!key) continue;
    seen.add(key);
  }
  return seen.size;
}
