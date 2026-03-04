/**
 * Supabase server client using cookies (for Vercel serverless API routes).
 *
 * Router type: This project is Vercel serverless, not Next.js. We use req/res for cookie
 * handling (getAll from req.headers.cookie, setAll via res.setHeader). App Router would use
 * cookies() from next/headers; Pages Router would use req/res we match req/res.
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL), EXPO_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createServerClient } from '@supabase/ssr';
import { serialize, parse } from 'cookie';

function getCookieHeader(req: VercelRequest): string {
 const c = req.headers.cookie;
 return typeof c === 'string' ? c : Array.isArray(c) ? (c as string[]).join('; ') : '';
}

/**
 * FORCE these on every Set-Cookie so cookies work on both apex and www:
 * Domain=.bookshelfscan.app (if missing, cookies scope to wrong host and never reach www)
 * Path=/
 * Secure
 * HttpOnly
 * SameSite=Lax
 */
const COOKIE_BASE_OPTIONS: Parameters<typeof serialize>[2] = {
 path: '/',
 domain: '.bookshelfscan.app',
 secure: true,
 httpOnly: true,
 sameSite: 'lax',
};

const COOKIE_DOMAIN = '.bookshelfscan.app';

/** Ensure Domain=.bookshelfscan.app is on every Set-Cookie string (avoid adding twice). */
function withDomain(cookie: string): string {
 if (/;\s*Domain=/i.test(cookie)) return cookie;
 return `${cookie}; Domain=${COOKIE_DOMAIN}`;
}

/**
 * Create a Supabase server client that reads/writes auth via cookies.
 * - getAll: reads from req.headers.cookie
 * - setAll: writes Set-Cookie with Domain=.bookshelfscan.app, Path=/, HttpOnly, Secure, SameSite=Lax (base options always win; then we force Domain on the string).
 */
export function createSupabaseServerClient(
 req: VercelRequest,
 res: VercelResponse
) {
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
 if (!supabaseUrl || !anonKey) {
 throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY');
 }

 const cookieHeader = getCookieHeader(req);
 const parsed = parse(cookieHeader);

 return createServerClient(supabaseUrl, anonKey, {
 cookies: {
 getAll() {
 return Object.entries(parsed).map(([name, value]) => ({ name, value }));
 },
 setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
 const serialized = cookiesToSet.map(({ name, value, options }) => {
 const merged = { ...options, ...COOKIE_BASE_OPTIONS } as Parameters<typeof serialize>[2];
 return serialize(name, value, merged);
 });
 const updated = serialized.map(withDomain);
 const cookieNames = updated.map((c) => (c.split('=')[0] || '').trim()).filter(Boolean);
 console.log('[supabaseServerCookies] setAll cookie names (no values):', cookieNames.length ? cookieNames.join(', ') : '(none)');
 res.setHeader('X-Debug-SetCookie-Count', String(updated.length));
 if (updated.length > 0) {
 const existing = res.getHeader('Set-Cookie');
 const existingArr: string[] = Array.isArray(existing)
 ? (existing as string[])
 : existing != null
 ? [String(existing)]
 : [];
 res.setHeader('Set-Cookie', [...existingArr, ...updated]);
 }
 },
 },
 });
}
