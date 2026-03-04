/**
 * GET /api/debug/book-counts
 * Diagnostic: returns book counts for the authenticated user using SERVICE ROLE (bypasses RLS).
 * Use when "local approved = 42 but server says 0" to see what the DB actually has for this user.
 * If counts are zero while you expect 42, the issue is not the client (wrong env, RLS, or writes).
 *
 * Auth: Bearer token. Returns total_books, approved, pending, deleted for that user_id.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getCredentialedOrigin } from '../../lib/corsCredentialed';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error', message: 'Missing Supabase env' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'Invalid token', message: userErr?.message ?? 'Invalid or expired token' });
  }
  const userId = userData.user.id;

  type CountResult = { count: number | null; error: string | null };
  const runCount = async (
    opts: { status?: string; deletedAtNull?: boolean; deletedAtNotNull?: boolean }
  ): Promise<CountResult> => {
    let q = supabase.from('books').select('*', { count: 'exact', head: true }).eq('user_id', userId);
    if (opts.deletedAtNull === true) q = q.is('deleted_at', null);
    if (opts.deletedAtNotNull === true) q = q.not('deleted_at', 'is', null);
    if (opts.status) q = q.eq('status', opts.status);
    const { count, error } = await q;
    return { count: count ?? null, error: error?.message ?? null };
  };

  const [totalRes, approvedRes, pendingRes, deletedRes] = await Promise.all([
    runCount({}),
    runCount({ status: 'approved', deletedAtNull: true }),
    (async (): Promise<CountResult> => {
      const { count, error } = await supabase
        .from('books')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('deleted_at', null)
        .neq('status', 'approved')
        .neq('status', 'rejected')
        .neq('status', 'discarded');
      return { count: count ?? null, error: error?.message ?? null };
    })(),
    runCount({ deletedAtNotNull: true }),
  ]);

  const payload = {
    userId: userId.slice(0, 8) + '…',
    total_books: totalRes.count ?? 0,
    approved: approvedRes.count ?? 0,
    pending: pendingRes.count ?? 0,
    deleted: deletedRes.count ?? 0,
    errors: [
      totalRes.error && 'total',
      approvedRes.error && 'approved',
      pendingRes.error && 'pending',
      deletedRes.error && 'deleted',
    ].filter(Boolean) as string[],
  };

  if (payload.errors.length > 0) {
    return res.status(200).json({ ...payload, message: 'Some counts failed; see errors' });
  }
  return res.status(200).json(payload);
}
