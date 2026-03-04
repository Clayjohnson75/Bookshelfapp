/**
 * GET /api/debug/whoami
 * Smoking gun: proves whether the server sees you as signed in via cookies.
 * Visit https://www.bookshelfscan.app/api/debug/whoami (with credentials).
 * If userId is null you are not logged in via cookies.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSupabaseServerClient } from '../../lib/supabaseServerCookies';
import { getCredentialedOrigin } from '../../lib/corsCredentialed';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 if (process.env.VERCEL_ENV === 'production') {
 return res.status(404).end();
 }
 res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
 res.setHeader('Access-Control-Allow-Credentials', 'true');
 res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 const supabase = createSupabaseServerClient(req, res);
 const { data: { user }, error } = await supabase.auth.getUser();

 const raw = req.headers.cookie ?? '';
 const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('; ') : '';
 const cookieNames = header
 .split(';')
 .map((s) => s.trim().split('=')[0])
 .filter(Boolean);

 res.status(200).json({
 host: req.headers.host,
 hasCookieHeader: !!header,
 cookieNames,
 userId: user?.id ?? null,
 error: error?.message ?? null,
 });
}
