/**
 * Scan auth: ONLY Supabase session access_token.
 * Do NOT use: provider_token, id_token, appleToken, googleToken, identityToken, or anything cached as "token".
 */
import { supabase } from './supabase';
import { getEnvVar } from './getEnvVar';

let scanEnvLogged = false;
/** Get headers for scan API calls. Only session.access_token no fallback. */
export async function getScanAuthHeaders(): Promise<{ Authorization: string; 'Content-Type': string }> {
 const SUPABASE_URL = getEnvVar('supabaseUrl');
 const EXPO_PUBLIC_API_BASE_URL = getEnvVar('EXPO_PUBLIC_API_BASE_URL');
 if (__DEV__ && !scanEnvLogged) {
 scanEnvLogged = true;
 const env = typeof __DEV__ !== 'undefined' && __DEV__ ? 'dev' : 'prod';
 const supabaseRef = (SUPABASE_URL ?? '').replace(/^https:\/\/([^.]+)\.supabase\.co.*/, '$1').slice(0, 12);
 const build = typeof __DEV__ !== 'undefined' && __DEV__ ? 'dev' : 'prod';
 console.log('[BOOT] env=' + env + ' supabaseRef=' + (supabaseRef || '') + ' build=' + build);
 }

 // No mixing: dev Supabase + prod API = auth will fail (iss mismatch). Dev build + prod API + prod Supabase = OK (Option A: test on device against deployed API).
 const isProdApi = /bookshelfscan\.app/i.test(EXPO_PUBLIC_API_BASE_URL || '');
 const isProdSupabase = /cnlnrlzhhbrtehpkttqv\.supabase\.co/i.test(SUPABASE_URL || '');
 if (__DEV__ && isProdApi && !isProdSupabase) {
 throw new Error(
 'Dev build with prod API must use prod Supabase (same project). ' +
 'Dev Supabase + prod API = auth will fail.'
 );
 }
 if (!__DEV__ && !isProdSupabase && SUPABASE_URL) {
 throw new Error(
 'Prod build must use prod Supabase URL. ' +
 'Dev Supabase + prod API = auth will fail.'
 );
 }

 const { data } = await supabase.auth.getSession();
 const s = data.session;

 const at = s?.access_token ?? '';
 // Auth token debug removed from normal logs (noisy + close to auth materials). Enable EXPO_PUBLIC_LOG_TRACE for trace.

 if (!s?.access_token) {
 throw new Error('No Supabase session access_token');
 }

 // Payload-based validation: require Supabase iss, aud === 'authenticated', and sub.
 if (SUPABASE_URL && at.split('.').length === 3) {
 try {
 const payloadB64 = at.split('.')[1] || '';
 const payloadJson = typeof globalThis !== 'undefined' && globalThis.atob
 ? globalThis.atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
 : Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
 const payload = JSON.parse(payloadJson) as { iss?: string; aud?: string; sub?: string };
 const expectedIssPrefix = SUPABASE_URL.replace(/\/$/, '') + '/auth/v1';
 if (!payload.iss || !payload.iss.startsWith('https://') || !payload.iss.includes('.supabase.co/auth/v1')) {
 throw new Error(`Token iss invalid: must be Supabase auth URL (e.g. https://<ref>.supabase.co/auth/v1), got ${(payload.iss || '').slice(0, 60)}`);
 }
 if (payload.iss !== expectedIssPrefix) {
 throw new Error(`Token iss does not match Supabase URL: got ${payload.iss?.slice(0, 50)}, expected ${expectedIssPrefix?.slice(0, 50)}`);
 }
 const audOk = payload.aud === 'authenticated' || (Array.isArray(payload.aud) && payload.aud.includes('authenticated'));
 if (!audOk) {
 throw new Error(`Token aud must be 'authenticated', got ${JSON.stringify(payload.aud)}`);
 }
 if (!payload.sub || typeof payload.sub !== 'string') {
 throw new Error('Token sub (user id) is missing');
 }
 } catch (e) {
 if (e instanceof Error && (e.message.startsWith('Token ') || e.message.startsWith('Token iss') || e.message.startsWith('Token aud') || e.message.startsWith('Token sub'))) throw e;
 // Decode/parse failure: skip payload check (token may be opaque or different format)
 }
 }

 const authHeader = `Bearer ${s.access_token}`;
 // Never log token or prefix. Trace-only auth logging removed (noisy).

 return {
 Authorization: authHeader,
 'Content-Type': 'application/json',
 };
}

/** Get Supabase access token or throw. Use for scan enqueue and all API calls. */
export async function getSupabaseAccessTokenOrThrow(): Promise<string> {
 const headers = await getScanAuthHeaders();
 const match = headers.Authorization.match(/^Bearer\s+(.+)$/);
 return match ? match[1] : '';
}

/** @deprecated Use getScanAuthHeaders. Same behavior: only session.access_token. */
export async function authHeaders(): Promise<{ Authorization: string }> {
 return getScanAuthHeaders();
}
