/**
 * POST /api/import-guest-pending
 * Import guest pending books into the authenticated user's library (no photo).
 * Body: { books: Array<{ title: string, author?: string, book_key?: string }> }
 * Creates approved book rows only; no photo upload or source_photo_id.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { computeBookKey } from '../lib/bookKey';
import { sanitizeTextForDb } from '../lib/sanitizeTextForDb';

const MAX_BOOKS = 100;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token.' });
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'invalid token', message: error?.message || 'Invalid or expired token.' });
  }
  const userId = data.user.id;

  const body = req.body as { books?: Array<{ title?: string; author?: string; book_key?: string }> };
  const raw = Array.isArray(body?.books) ? body.books : [];
  if (raw.length === 0) {
    return res.status(200).json({ ok: true, imported: 0 });
  }
  const limited = raw.slice(0, MAX_BOOKS);

  const now = new Date().toISOString();
  const rows = limited.map((b) => {
    const title = sanitizeTextForDb(b.title) ?? '';
    const author = sanitizeTextForDb(b.author) ?? '';
    const bookKey =
      typeof b.book_key === 'string' && b.book_key.trim()
        ? b.book_key.trim()
        : computeBookKey({ title: b.title, author: b.author });
    return {
      user_id: userId,
      title,
      author,
      status: 'approved',
      book_key: bookKey,
      updated_at: now,
      scanned_at: null,
    };
  });

  const { data: inserted, error: insertErr } = await supabase
    .from('books')
    .upsert(rows, { onConflict: 'user_id,book_key', ignoreDuplicates: true })
    .select('id');

  if (insertErr) {
    console.error('[import-guest-pending] insert failed', insertErr);
    return res.status(500).json({ ok: false, error: 'Failed to import books', message: insertErr.message });
  }

  const imported = Array.isArray(inserted) ? inserted.length : 0;
  return res.status(200).json({ ok: true, imported });
}
