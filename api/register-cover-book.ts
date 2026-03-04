/**
 * POST /api/register-cover-book
 * Body: { bookId: string (uuid), workKey: string }
 * Authorization: Bearer <Supabase access_token>
 * Links a library book to a cover_resolutions work_key so the app can fetch covers by book_id.
 * Auth: supabase.auth.getUser(token) Supabase handles RS256 + JWKS internally.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'POST') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const auth = req.headers.authorization;
 const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
 if (!token) {
 return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
 }

 const { bookId, workKey } = req.body || {};
 if (!bookId || typeof bookId !== 'string' || !workKey || typeof workKey !== 'string') {
 return res.status(400).json({ error: 'bookId and workKey required' });
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
 return res.status(401).json({ error: 'invalid token', message: error?.message || 'Invalid or expired token' });
 }
 const userId = data.user.id;

 try {
 const { data: book } = await supabase
 .from('books')
 .select('id')
 .eq('id', bookId)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .maybeSingle();

 if (!book) {
 return res.status(404).json({ error: 'Book not found or access denied' });
 }

 await supabase
 .from('cover_resolution_books')
 .upsert({ book_id: bookId, work_key: workKey.trim() }, { onConflict: 'book_id' });

 return res.status(200).json({ ok: true });
 } catch (err: any) {
 console.error('[API] register-cover-book:', err);
 return res.status(500).json({ error: 'Server error', message: err?.message || 'Failed to register' });
 }
}
