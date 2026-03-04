import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildWorkKey, getSupabase, getStoragePublicUrl, resolveOne, verifyStorageObjectExists, PLACEHOLDER_URL, pickCoverResPayload, type BookMetadata } from '../lib/coverResolution';

const META_COLS = 'cover_storage_path, status, last_attempt_at, description, categories, page_count, publisher, published_date, language, subtitle';

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

async function checkResolution(db: any, workKey: string): Promise<{ cover_storage_path: string; status: string } | null> {
  const { data, error } = await db.from('cover_resolutions').select('cover_storage_path, status').eq('work_key', workKey).maybeSingle();
  if (error || !data) return null;
  return data;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(200).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const isbn = (req.query.isbn as string) || (req.body?.isbn as string) || '';
    const title = (req.query.title as string) || (req.body?.title as string) || '';
    const author = (req.query.author as string) || (req.body?.author as string) || '';

    if (!title?.trim() && !isbn?.trim()) {
      return res.status(200).json({ ok: false, error: 'title or isbn required' });
    }

    const db = getSupabase();
    if (!db) return res.status(200).json({ ok: false, error: 'Storage not configured' });

    const workKey = buildWorkKey(isbn, title, author);
    const row = await checkResolution(db, workKey);

    // Guarantee: only use cache when row implies usable image (status ready + path set). Auto-heal: verify object exists.
    const path = row?.cover_storage_path;
    if (path != null && path !== '' && (row?.status === 'ready' || row?.status === 'resolved')) {
      const exists = await verifyStorageObjectExists(path);
      if (exists) {
        const url = getStoragePublicUrl(path);
        const { data: fullRow } = await db.from('cover_resolutions').select(META_COLS).eq('work_key', workKey).maybeSingle();
        const metadata = rowToMetadata(fullRow ?? null);
        const body: Record<string, unknown> = { ok: true, coverUrl: url, googleBooksId: path.split('.')[0] };
        if (metadata) body.metadata = metadata;
        return res.status(200).json(body);
      }
      const updatePayload = pickCoverResPayload({ status: 'error', updated_at: new Date().toISOString() });
      await db.from('cover_resolutions').update(updatePayload).eq('work_key', workKey);
    }

    const result = await resolveOne(db, isbn, title, author, workKey);
    if (result && 'placeholder' in result) {
      return res.status(200).json({ ok: false, placeholder: true, coverUrl: PLACEHOLDER_URL });
    }
    if (result && 'coverUrl' in result) {
      const body: Record<string, unknown> = { ok: true, coverUrl: result.coverUrl, googleBooksId: result.googleBooksId };
      if (result.metadata) body.metadata = result.metadata;
      return res.status(200).json(body);
    }
    return res.status(200).json({ ok: false, placeholder: true, coverUrl: PLACEHOLDER_URL });
  } catch (err: any) {
    console.error('[resolve-cover] Error:', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'Internal error' });
  }
}
