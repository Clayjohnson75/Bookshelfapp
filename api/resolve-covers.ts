import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildWorkKey, getSupabase, getStoragePublicUrl, lookupBatch, upsertPending, type BookMetadata } from '../lib/coverResolution';
import { enqueueCoverResolve } from '../lib/enqueueCoverResolve';

interface BookInput {
  id: string;
  title: string;
  author?: string;
  isbn?: string;
}

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body as { books?: BookInput[] };
    const books = Array.isArray(body?.books) ? body.books : [];
    if (books.length === 0) {
      return res.status(200).json({ ok: true, results: {} });
    }
    if (books.length > 100) {
      return res.status(200).json({ ok: false, error: 'Max 100 books per batch' });
    }

    const db = getSupabase();
    if (!db) return res.status(200).json({ ok: false, error: 'Storage not configured' });

    const results: Record<string, { coverUrl: string; googleBooksId: string; metadata?: BookMetadata } | { status: 'pending' } | null> = {};

    // Build work_keys: ISBN first, else sha1(normalized_title + normalized_author). Never use spine_text.
    const entries: { book: BookInput; workKey: string }[] = [];
    for (const b of books) {
      if (!b?.id || !b?.title?.trim()) continue;
      const spineText = (b as { spine_text?: string }).spine_text;
      const titleForKey = spineText != null && String(b.title).trim() === String(spineText).trim() ? undefined : b.title;
      const workKey = buildWorkKey(b.isbn, titleForKey, b.author);
      entries.push({ book: b, workKey });
    }

    const workKeys = entries.map(e => e.workKey);
    const cacheMap = await lookupBatch(db, workKeys);

    const misses: { book: BookInput; workKey: string }[] = [];
    let hitCount = 0;
    let missCount = 0;

    for (const { book, workKey } of entries) {
      const row = cacheMap.get(workKey);
      const path = row?.cover_storage_path;
      if (path != null && path !== '') {
        hitCount++;
        console.log(`[COVER] HIT workKey=${workKey} path=${path}`);
        results[book.id] = {
          coverUrl: getStoragePublicUrl(path),
          googleBooksId: row.google_volume_id || workKey,
          ...(rowToMetadata(row) && { metadata: rowToMetadata(row) }),
        };
      } else {
        missCount++;
        console.log(`[COVER] MISS workKey=${workKey} -> downloading`);
        results[book.id] = { status: 'pending' };
        misses.push({ book, workKey });
      }
    }
    console.log(`[COVER] cache check: total=${entries.length} hit=${hitCount} miss=${missCount}`);

    // Cache misses: upsert pending, enqueue QStash. Worker resolves async and updates to ready.
    if (misses.length > 0) {
      for (const { book, workKey } of misses) {
        await upsertPending(db, workKey, book.isbn, book.title, book.author);
      }
      const items = misses.map(({ book, workKey }) => ({
        workKey,
        isbn: book.isbn,
        title: book.title,
        author: book.author,
      }));
      enqueueCoverResolve(items).catch(err => console.warn('[resolve-covers] Enqueue failed:', err?.message));
    }

    return res.status(200).json({ ok: true, results });
  } catch (err: any) {
    console.error('[resolve-covers] Error:', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'Internal error' });
  }
}
