/**
 * CORS: when Access-Control-Allow-Credentials is true, the browser requires
 * Access-Control-Allow-Origin to be an exact origin, not "*".
 * Use this to get the origin to return for credentialed requests.
 */
const ALLOWED_ORIGINS = [
  'https://www.bookshelfscan.app',
  'https://bookshelfscan.app',
  'http://localhost:3000',
  'http://localhost:8081',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8081',
];

const DEFAULT_ORIGIN = 'https://www.bookshelfscan.app';

export function getCredentialedOrigin(req: { headers: { origin?: string | string[] } }): string {
  const raw = req.headers.origin;
  const origin = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return DEFAULT_ORIGIN;
}
