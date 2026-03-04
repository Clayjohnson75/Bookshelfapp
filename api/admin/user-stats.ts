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

 let query = supabase
 .schema('private')
 .from('user_activity_stats')
 .select('*')
 .order('total_completed_scans', { ascending: false })
 .limit(limit);

 if (q) {
 const safeQ = q.replace(/'/g, "''");
 query = query.or(`username.ilike.%${safeQ}%,display_name.ilike.%${safeQ}%,email.ilike.%${safeQ}%`);
 }
 if (active === '7') {
 query = query.gt('scans_last_7d', 0);
 } else if (active === '30') {
 query = query.gt('scans_last_30d', 0);
 }

 try {
 const { data: rows, error } = await query;

 if (error) {
 console.error('[ADMIN_STATS] requester=' + requesterId + ' ok=false error=' + error.message);
 return res.status(200).json({ data: [], error: error.message });
 }

 console.log('[ADMIN_STATS] requester=' + requesterId + ' ok=true rows=' + (rows?.length ?? 0));
 return res.status(200).json({ data: rows ?? [] });
 } catch (err: unknown) {
 const message = err instanceof Error ? err.message : String(err);
 console.error('[ADMIN_STATS] requester=' + requesterId + ' ok=false exception=' + message);
 return res.status(200).json({ data: [], error: message });
 }
}
