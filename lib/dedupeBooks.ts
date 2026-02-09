import { Book } from '../types/BookTypes';

/**
 * Dedupe books by id; later entries win. Use when merging scan results into library state.
 */
export function dedupeBooks(books: Book[]): Book[] {
  const byId = new Map<string, Book>();
  for (const b of books) {
    const id = b.id ?? `${b.title}_${b.author ?? ''}_${b.scannedAt ?? 0}`;
    byId.set(id, b);
  }
  return Array.from(byId.values());
}
