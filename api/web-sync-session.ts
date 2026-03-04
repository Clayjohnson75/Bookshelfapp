/**
 * POST /api/web-sync-session
 * Cookie session sync: client sends access_token + refresh_token; server writes sb-* cookies
 * (Domain=.bookshelfscan.app) via createSupabaseServerClient + setSession.
 * Call this on page load or right after auto-signin so admin check and other cookie-based routes work.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSupabaseServerClient } from '../lib/supabaseServerCookies';
import { getCredentialedOrigin } from '../lib/corsCredentialed';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  const body = req.body || {};
  const { access_token, refresh_token } = body as { access_token?: string; refresh_token?: string };

  // TEMP DEBUG (safe): only booleans/lengths, never token strings
  const debug = {
    bodyKeys: Object.keys(body),
    hasAccessToken: !!access_token,
    hasRefreshToken: !!refresh_token,
    accessTokenLen: typeof access_token === 'string' ? access_token.length : null,
    refreshTokenLen: typeof refresh_token === 'string' ? refresh_token.length : null,
  };
  console.log('[web-sync-session] request body keys and token presence:', debug);

  if (!access_token || !refresh_token) {
    return res.status(401).json({ ok: false, reason: 'missing_tokens', debug });
  }

  const supabase = createSupabaseServerClient(req, res);
  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });

  if (error) {
    console.log('[web-sync-session] setSession failed:', error.message);
    return res.status(401).json({
      ok: false,
      reason: 'setSession_failed',
      message: error.message,
      debug,
    });
  }

  return res.status(200).json({
    ok: true,
    userId: data?.user?.id ?? null,
  });
}
