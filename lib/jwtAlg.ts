/**
 * Decode JWT header and return alg (e.g. HS256, RS256, ES256).
 * ES256 = Apple/Google ID token. HS256/RS256 = Supabase access_token.
 */
export function jwtAlg(token: string): string {
  try {
    const [h] = token.split('.');
    const json = JSON.parse(
      (typeof atob !== 'undefined' ? atob : (globalThis as any).atob)(
        (h ?? '').replace(/-/g, '+').replace(/_/g, '/')
      )
    );
    return json.alg ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
