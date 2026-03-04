/**
 * THE ONLY Supabase client in the app bundle (supabaseClient).
 * createClient() is called exactly once here. api/ and scripts/ run on server and create
 * their own clients that's separate. Every app file must import { supabase } from here.
 * If any screen/provider calls createClient again, kill it: do not import createClient from
 * @supabase/supabase-js in app code; use this singleton only.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnvVar } from './getEnvVar';
import { LOG_NET } from './logFlags';
import { checkHttpRlsDenied } from './dbAudit';

declare const globalThis: { __SUPABASE_APP_CLIENT?: SupabaseClient };

// Single source: app.config sets extra.supabaseUrl / extra.supabaseAnonKey by env (dev vs prod).
const url = getEnvVar('supabaseUrl') || '';
const key = getEnvVar('supabaseAnonKey') || '';

const SUPABASE_REF = url ? url.replace(/^https?:\/\//, '').split('.')[0] : '';
const SUPABASE_ENV = __DEV__ ? 'dev' : 'prod';

// Check A: confirm the Supabase project ref at runtime — must be cnlnrlzhhbrtehpkttqv.
// Use console.log directly here (module-load time, before logger is definitely ready).
// The suppressor in logger.ts/setupDevLogBox will still strip noise; these fire once only.
if (__DEV__) {
  console.log('D/[SUPABASE_URL_RUNTIME]', url || '(empty)');
  console.log('D/[SUPABASE_REF_RUNTIME]', SUPABASE_REF || '(empty)');
}

// When dev build points at deployed API (Option A: EXPO_PUBLIC_API_BASE_URL_DEV = Vercel/prod URL), we intentionally use prod Supabase allow it.
const KNOWN_PROD_REF = 'cnlnrlzhhbrtehpkttqv';
const apiBaseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || '';
const devPointingAtDeployedApi = /bookshelfscan\.app|\.vercel\.app/i.test(apiBaseUrl);
if (__DEV__ && SUPABASE_REF === KNOWN_PROD_REF && !devPointingAtDeployedApi) {
 throw new Error('Dev build is pointing at PROD Supabase. Refusing to start. Set EXPO_PUBLIC_SUPABASE_URL_DEV (and _ANON_KEY_DEV) to your dev project in .env, or point EXPO_PUBLIC_API_BASE_URL_DEV at your deployed API to use prod Supabase.');
}

if (!url || !key) {
 console.error(' Missing Supabase config. app.config sets extra.supabaseUrl / extra.supabaseAnonKey from .env (dev: _DEV vars; prod: EXPO_PUBLIC_SUPABASE_*).');
}

export const SUPABASE_INSTANCE_ID = Math.random().toString(16).slice(2);
let _supabaseInstanceLogged = false;
export function logSupabaseInstanceOnce(): void {
 if (__DEV__ && !_supabaseInstanceLogged) {
 _supabaseInstanceLogged = true;
 // Suppressed: noise. Single client is assumed.
 // console.log('[SUPABASE_INSTANCE]', SUPABASE_INSTANCE_ID, '(single client)');
 }
}

// Log the Authorization header presence — gated by LOG_NET flag (EXPO_PUBLIC_LOG_NET=true).
// Only re-logs when the presence state flips (present→missing or missing→present) so it fires
// at most twice per session instead of on every REST call.
let _lastAuthHeaderPresent: boolean | null = null;
function _logAuthHeaderOnce(present: boolean, len: number): void {
  if (!LOG_NET) return;
  if (_lastAuthHeaderPresent === present) return;
  _lastAuthHeaderPresent = present;
  // Use console.log directly — this file runs at module-load time before imports settle.
  // The 'D/' prefix marks it as debug-level for grep filtering.
  console.log(
    'D/[REST_AUTH_HEADER]',
    present ? `✅ present (len=${len})` : '❌ MISSING',
  );
}

// Single client: create once, reuse from global so even duplicate imports get the same instance.
function getSupabaseClient(): SupabaseClient {
 if (globalThis.__SUPABASE_APP_CLIENT) {
 return globalThis.__SUPABASE_APP_CLIENT;
 }
 logSupabaseInstanceOnce();
 globalThis.__SUPABASE_APP_CLIENT = createClient(url!, key!, {
 auth: {
 storage: AsyncStorage,
 persistSession: true,
 autoRefreshToken: true,
 detectSessionInUrl: false,
 },
  global: {
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const reqUrl = String(input);
      const isRestCall = reqUrl.includes('/rest/v1/');
      if (isRestCall) {
        const headers: Record<string, string> = {};
        if (init.headers) {
          if (typeof (init.headers as any).get === 'function') {
            const h = init.headers as Headers;
            h.forEach((v, k) => { headers[k] = v; });
          } else {
            Object.assign(headers, init.headers);
          }
        }
        const auth = headers['Authorization'] || headers['authorization'] || null;
        _logAuthHeaderOnce(!!auth, auth?.length ?? 0);
      }

      const response = await fetch(input, init);

      // RLS / permission check: log any 401/403 from the REST layer.
      // Only check REST calls to avoid noise from storage/auth endpoints.
      if (isRestCall && (response.status === 401 || response.status === 403)) {
        checkHttpRlsDenied(response.status, reqUrl, init.method ?? 'GET');
      }

      return response;
    },
  },
 });
 return globalThis.__SUPABASE_APP_CLIENT;
}

export { SUPABASE_REF, SUPABASE_ENV };
export const supabase = getSupabaseClient();
