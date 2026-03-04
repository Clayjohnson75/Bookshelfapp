/**
 * GET /api/library-books
 * Returns the authenticated user's approved library books (for favorites picker).
 * Requires Bearer token.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
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

  const { data: books, error: booksError } = await supabase
    .from('books')
    .select('id, title, author, cover_url, is_favorite')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .is('deleted_at', null)
    .order('title', { ascending: true });

  if (booksError) {
    console.error('[API] Error fetching library books:', booksError);
    return res.status(500).json({ error: 'Failed to fetch books' });
  }

  return res.status(200).json({ books: books || [] });
}
