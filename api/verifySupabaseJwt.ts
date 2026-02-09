/**
 * Verify Supabase JWT using JWKS (supports both HS256 and ES256 tokens).
 * Use this instead of getUser(token) when the backend must accept tokens
 * signed with ES256 (e.g. from certain Supabase Auth configs).
 *
 * JWKS URL: https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string) {
  const base = supabaseUrl.replace(/\/$/, '');
  const jwksUrl = `${base}/auth/v1/.well-known/jwks.json`;
  if (!jwksCache.has(jwksUrl)) {
    jwksCache.set(jwksUrl, createRemoteJWKSet(new URL(jwksUrl)));
  }
  return jwksCache.get(jwksUrl)!;
}

export interface VerifyResult {
  userId: string;
  sub: string;
}

/**
 * Verify the JWT using Supabase's JWKS. Returns userId (sub) or throws.
 */
export async function verifySupabaseJwt(
  token: string,
  supabaseUrl: string
): Promise<VerifyResult> {
  const JWKS = getJwks(supabaseUrl);
  const { payload } = await jwtVerify(token, JWKS);
  const sub = payload.sub;
  if (!sub || typeof sub !== 'string') {
    throw new Error('JWT missing sub claim');
  }
  return { userId: sub, sub };
}
