/**
 * GET /api/admin/user-stats
 * Admin-only: requires Bearer auth, then checks profiles.is_admin server-side only.
 * Never accept or trust isAdmin (or any admin flag) from the client always read from profiles.is_admin by requester id.
 * Returns user_activity_stats (username, email, scans, books). Uses Supabase service role to query
 * private.user_activity_stats (view lives in non-exposed schema to avoid auth_users_exposed / security_definer risk).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getCredentialedOrigin } from '../../lib/corsCredentialed';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
 res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 if (req.method !== 'GET') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const auth = req.headers.authorization || '';
 const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
 if (!token) {
 return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
 }

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !serviceKey) {
 console.error('[ADMIN_STATS] Missing Supabase env');
 return res.status(500).json({ error: 'Server configuration error' });
 }

 const supabase = createClient(supabaseUrl, serviceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });

 const { data: userData, error: userErr } = await supabase.auth.getUser(token);
 if (userErr || !userData?.user) {
 console.log('[ADMIN_STATS] requester=invalid ok=false reason=invalid_token');
 return res.status(401).json({ error: 'Invalid token', message: userErr?.message || 'Invalid or expired token' });
 }
 const requesterId = userData.user.id;

 const { data: profile, error: profileErr } = await supabase
 .from('profiles')
 .select('is_admin')
 .eq('id', requesterId)
 .maybeSingle();

 if (profileErr || !profile?.is_admin) {
 console.log('[ADMIN_STATS] requester=' + requesterId + ' ok=false reason=not_admin');
 return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
 }

 const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
 const active = typeof req.query.active === 'string' ? req.query.active : '';
 const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : '';
 const limit = Math.min(
 Math.max(1, parseInt(limitRaw, 10) || DEFAULT_LIMIT),
 MAX_LIMIT
 );

 // Query profiles + scan_jobs + books directly (private schema views
 // aren't accessible via PostgREST API — only public/graphql_public schemas allowed).
 try {

 let profilesQuery = supabase
   .from('profiles')
   .select('id, username, display_name')
   .is('deleted_at', null)
   .limit(limit);
 if (q) {
   profilesQuery = profilesQuery.or(`username.ilike.%${q}%,display_name.ilike.%${q}%`);
 }
 const { data: profiles, error: profilesError } = await profilesQuery;

 if (!profiles || profiles.length === 0) {
   return res.status(200).json({ data: [], error: profilesError?.message || 'No profiles found' });
 }

 // Get scan counts per user
 const userIds = profiles.map((p: any) => p.id);
 const { data: scans } = await supabase
   .from('scan_jobs')
   .select('user_id, status, created_at')
   .in('user_id', userIds)
   .is('deleted_at', null);

 const { data: books } = await supabase
   .from('books')
   .select('user_id')
   .in('user_id', userIds)
   .eq('status', 'approved')
   .is('deleted_at', null);

 const now = Date.now();
 const d7 = 7 * 24 * 60 * 60 * 1000;
 const d30 = 30 * 24 * 60 * 60 * 1000;

 const fallbackRows = profiles.map((p: any) => {
   const userScans = (scans || []).filter((s: any) => s.user_id === p.id);
   const completed = userScans.filter((s: any) => s.status === 'completed');
   const userBooks = (books || []).filter((b: any) => b.user_id === p.id);
   const last = completed.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
   return {
     user_id: p.id,
     username: p.username,
     display_name: p.display_name,
     email: null,
     total_completed_scans: completed.length,
     scans_last_7d: completed.filter((s: any) => now - new Date(s.created_at).getTime() < d7).length,
     scans_last_30d: completed.filter((s: any) => now - new Date(s.created_at).getTime() < d30).length,
     total_books: userBooks.length,
     avg_books_per_completed_scan: completed.length > 0 ? Math.round((userBooks.length / completed.length) * 10) / 10 : null,
     last_scan_at: last?.created_at || null,
   };
 });

 console.log('[ADMIN_STATS] requester=' + requesterId + ' ok=true rows=' + fallbackRows.length + ' (fallback)');
 return res.status(200).json({ data: fallbackRows });
 } catch (err: unknown) {
 const message = err instanceof Error ? err.message : String(err);
 console.error('[ADMIN_STATS] requester=' + requesterId + ' ok=false exception=' + message);
 return res.status(200).json({ data: [], error: message });
 }
}
