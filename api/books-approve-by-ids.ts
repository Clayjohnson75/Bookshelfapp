import type { VercelRequest, VercelResponse } from '@vercel/node';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/books-approve-by-ids
 * Approve books by ID only. Idempotent: safe to call repeatedly with the same bookIds.
 * Body: { bookIds: string[], action_id?: string }. Auth: Bearer token; user_id from token only.
 * Sets status='approved' and deleted_at=null for matching rows.
 */
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

  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authorization: Bearer <token> required' });
  }

  try {
    const { bookIds, action_id: _actionId } = req.body || {};
    if (!Array.isArray(bookIds) || bookIds.length === 0) {
      return res.status(200).json({ ok: true, books_approved: 0 });
    }

    const validIds = bookIds
      .filter((id: unknown) => typeof id === 'string' && UUID_REGEX.test(id as string))
      .slice(0, 200) as string[];

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: authErr?.message ?? 'Invalid or expired token' });
    }
    const userId = userData.user.id;

    // Idempotent: set status='approved' and deleted_at=null. Safe to call twice.
    const { data: updated, error } = await supabase
      .from('books')
      .update({ status: 'approved', deleted_at: null })
      .eq('user_id', userId)
      .in('id', validIds)
      .select('id');

    if (error) {
      console.error('[API] books-approve-by-ids update failed:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const books_approved = Array.isArray(updated) ? updated.length : 0;
    return res.status(200).json({ ok: true, books_approved });
  } catch (e: any) {
    console.error('[API] books-approve-by-ids error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
