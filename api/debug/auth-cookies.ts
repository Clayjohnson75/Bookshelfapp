/**
 * GET /api/debug/auth-cookies
 * Debug: cookie names the server receives (no token values).
 * Hit both to compare domain/cookie behavior:
 * https://www.bookshelfscan.app/api/debug/auth-cookies
 * https://bookshelfscan.app/api/debug/auth-cookies
 * (Apex is not redirected for this path so you can hit it directly.)
 * If apex shows hasSbCookies:true and www shows false domain mismatch confirmed.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 if (process.env.VERCEL_ENV === 'production') {
 return res.status(404).end();
 }
 const raw = req.headers.cookie ?? '';
 const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('; ') : '';
 const cookieNames = header
 .split(';')
 .map((s) => s.trim().split('=')[0])
 .filter(Boolean);

 res.status(200).json({
 host: req.headers.host,
 hasCookieHeader: !!header,
 cookieNames: cookieNames.slice(0, 50),
 hasSbCookies: cookieNames.some((n) => n.startsWith('sb-')),
 });
}
