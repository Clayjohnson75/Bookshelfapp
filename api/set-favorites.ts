/**
 * POST /api/set-favorites
 * Sets favorites for the authenticated user. Accepts up to 10 book IDs.
 * All provided IDs must belong to the user's approved books.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const MAX_FAVORITES = 10;

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

  const body = req.body;
  const bookIds = Array.isArray(body?.bookIds)
    ? body.bookIds.filter((id: unknown) => typeof id === 'string').slice(0, MAX_FAVORITES)
    : [];

  if (bookIds.length > MAX_FAVORITES) {
    return res.status(400).json({ error: `Maximum ${MAX_FAVORITES} favorites allowed.` });
  }

  // Verify all book IDs belong to this user's approved books
  const { data: userBooks } = await supabase
    .from('books')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .is('deleted_at', null);

  const validIds = new Set((userBooks || []).map((b: { id: string }) => b.id));
  const invalidIds = bookIds.filter((id: string) => !validIds.has(id));
  if (invalidIds.length > 0) {
    return res.status(400).json({ error: 'One or more book IDs do not belong to your library.' });
  }

  // Clear favorites for all user's books, then set favorites for selected IDs
  const { error: clearErr } = await supabase
    .from('books')
    .update({ is_favorite: false })
    .eq('user_id', userId)
    .is('deleted_at', null);

  if (clearErr) {
    console.error('[API] Error clearing favorites:', clearErr);
    return res.status(500).json({ error: 'Failed to update favorites' });
  }

  if (bookIds.length > 0) {
    const { error: setErr } = await supabase
      .from('books')
      .update({ is_favorite: true })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .in('id', bookIds);

    if (setErr) {
      console.error('[API] Error setting favorites:', setErr);
      return res.status(500).json({ error: 'Failed to update favorites' });
    }
  }

  return res.status(200).json({ success: true, favoritesCount: bookIds.length });
}
