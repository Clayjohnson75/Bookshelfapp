/**
 * POST /api/books/enrich-batch
 * Best-effort burst: enrich up to N books (default 5) where description is null and enrichment_status = 'pending'.
 * Call after scan import so new books get descriptions without user opening each one.
 * Server-side; requires Bearer token.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { fetchDescriptionForBook } from '../../lib/enrichDescription';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required.' });
  }

  const body = (req.body || {}) as { limit?: number };
  const limit = Math.min(
    Math.max(1, typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT),
    MAX_LIMIT
  );

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(auth);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'Invalid token', message: userErr?.message || 'Invalid or expired token.' });
  }
  const userId = userData.user.id;

  const { data: books, error: listErr } = await supabase
    .from('books')
    .select('id, user_id, title, author, isbn, google_books_id, description, description_source, enrichment_status')
    .eq('user_id', userId)
    .eq('enrichment_status', 'pending')
    .order('id', { ascending: true })
    .limit(limit);

  if (listErr) {
    console.error('[API] enrich-batch list error:', listErr.message);
    return res.status(200).json({ enriched: 0, bookIds: [], error: listErr.message });
  }

  const pending = (books || []).filter(
    (b) => b.user_id === userId && (!b.description || !String(b.description).trim())
  );
  const nowIso = new Date().toISOString();
  const enrichedIds: string[] = [];

  for (const book of pending) {
    try {
      if (book.description && String(book.description).trim()) {
        console.info('[DESC_BACKEND_SAVE]', {
          bookId: book.id,
          hasDescription: true,
          length: book.description?.length ?? 0,
          source: book.description_source ?? 'already_present',
        });
        await supabase
          .from('books')
          .update({
            enrichment_status: 'complete',
            enrichment_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', book.id);
        enrichedIds.push(book.id);
        continue;
      }

      const result = await fetchDescriptionForBook({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        google_books_id: book.google_books_id,
      });

      if (result.status === 'not_found') {
        await supabase
          .from('books')
          .update({
            enrichment_status: 'not_found',
            enrichment_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', book.id);
      } else {
        console.info('[DESC_BACKEND_SAVE]', {
          bookId: book.id,
          hasDescription: !!result.description,
          length: result.description?.length ?? 0,
          source: result.source,
        });
        await supabase
          .from('books')
          .update({
            description: result.description,
            description_source: result.source,
            enrichment_status: 'complete',
            enrichment_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', book.id);
        enrichedIds.push(book.id);
      }
    } catch (e) {
      console.warn('[API] enrich-batch single book error:', book.id, e);
      try {
        await supabase
          .from('books')
          .update({
            enrichment_status: 'failed',
            enrichment_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', book.id);
      } catch (_) {}
    }
  }

  return res.status(200).json({
    ok: true,
    enriched: enrichedIds.length,
    bookIds: enrichedIds,
    processed: pending.length,
  });
}
