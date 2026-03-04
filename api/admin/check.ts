/**
 * GET /api/admin/check
 * Admin endpoint: requires auth (cookies), then checks profiles.is_admin server-side only.
 * Never accept or trust isAdmin (or any admin flag) from the client always read from profiles.is_admin by user id.
 * 1) Identify user via cookies only (anon key).
 * 2) Read profiles.is_admin via SERVICE ROLE client only (bypasses RLS safely).
 * Env: SUPABASE_SERVICE_ROLE_KEY must be set in Vercel/server; NOT exposed to browser.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'cookie';
import { createSupabaseServerClient } from '../../lib/supabaseServerCookies';
import { getCredentialedOrigin } from '../../lib/corsCredentialed';

function hasSbCookies(req: VercelRequest): boolean {
 const raw = req.headers.cookie;
 const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('; ') : '';
 const parsed = parse(header);
 return Object.keys(parsed).some((name) => name.startsWith('sb-'));
}

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

 // Same cookie helper as other routes: createSupabaseServerClient(req, res) reads req.headers.cookie and writes Set-Cookie via res.setHeader.
 if (!hasSbCookies(req)) {
 return res.status(401).json({ isAdmin: false, debug: 'no_sb_cookies' });
 }

 // 1) Identify user via cookies only (anon key). Try refresh if no user (keeps auth cookies fresh, avoids intermittent 401s).
 const supabase = createSupabaseServerClient(req, res);
 let { data: { user } } = await supabase.auth.getUser();
 if (!user) {
 const { data: { session } } = await supabase.auth.getSession();
 if (session?.refresh_token) {
 await supabase.auth.refreshSession({ refresh_token: session.refresh_token });
 const next = await supabase.auth.getUser();
 user = next.data.user ?? null;
 }
 }
 if (!user) {
 return res.status(401).json({ isAdmin: false, debug: 'no_user' });
 }

 // 2) Read admin flag via service role (bypass RLS)
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !serviceKey) {
 return res.status(500).json({
 isAdmin: false,
 debug: 'Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL (server env only, not exposed to browser)',
 userId: user.id,
 });
 }

 const adminSupabase = createClient(supabaseUrl, serviceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });

 const { data: profile, error } = await adminSupabase
 .from('profiles')
 .select('is_admin')
 .eq('id', user.id)
 .single();

 if (error) {
 return res.status(200).json({
 isAdmin: false,
 debug: 'profile_lookup_failed',
 error: error.message,
 userId: user.id,
 });
 }

 return res.status(200).json({
 isAdmin: !!profile?.is_admin,
 userId: user.id,
 });
}
