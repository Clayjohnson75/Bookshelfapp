/**
 * POST /api/session-refresh
 * Accepts { refresh_token } or { session } and returns a new session.
 * Use when the access_token has expired but you still have a valid refresh_token.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
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
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const session = body.session;
  const refreshToken =
    typeof body.refresh_token === 'string'
      ? body.refresh_token
      : session && typeof session.refresh_token === 'string'
        ? session.refresh_token
        : null;

  if (!refreshToken && !session) {
    return res.status(400).json({ error: 'refresh_token or session required' });
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    console.error('[session-refresh] Missing SUPABASE_URL or anon key');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let data: { session?: unknown } | null = null;
  let error: { message: string } | null = null;

  if (session && typeof session === 'object' && session.access_token && session.refresh_token) {
    const setResult = await supabase.auth.setSession(session);
    if (setResult.error) {
      console.log('[session-refresh] setSession failed:', setResult.error.message);
      return res.status(401).json({ error: 'Invalid session', message: setResult.error.message });
    }
    const refreshResult = await supabase.auth.refreshSession();
    data = refreshResult.data;
    error = refreshResult.error;
  } else {
    const refreshResult = await supabase.auth.refreshSession({ refresh_token: refreshToken! });
    data = refreshResult.data;
    error = refreshResult.error;
  }

  if (error) {
    console.log('[session-refresh] refresh failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired refresh token', message: error.message });
  }
  if (!data?.session) {
    return res.status(401).json({ error: 'No session returned' });
  }

  return res.status(200).json({ session: data.session });
}
