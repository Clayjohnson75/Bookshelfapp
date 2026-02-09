/**
 * THE ONLY Supabase client in the app bundle (supabaseClient).
 * createClient() is called exactly once here. api/ and scripts/ run on server and create
 * their own clients — that's separate. Every app file must import { supabase } from here.
 * If any screen/provider calls createClient again, kill it: do not import createClient from
 * @supabase/supabase-js in app code; use this singleton only.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnvVar } from './getEnvVar';

declare const globalThis: { __SUPABASE_APP_CLIENT?: SupabaseClient };

// Single source: app.config sets extra.supabaseUrl / extra.supabaseAnonKey by env (dev vs prod).
const url = getEnvVar('supabaseUrl') || '';
const key = getEnvVar('supabaseAnonKey') || '';

const SUPABASE_REF = url ? url.replace(/^https?:\/\//, '').split('.')[0] : '';
const SUPABASE_ENV = __DEV__ ? 'dev' : 'prod';

if (__DEV__) {
  console.log('[SUPABASE_REF]', SUPABASE_REF);
  console.log('[SUPABASE] ENV:', SUPABASE_ENV);
}

// When dev build points at deployed API (Option A: EXPO_PUBLIC_API_BASE_URL_DEV = Vercel/prod URL), we intentionally use prod Supabase — allow it.
const KNOWN_PROD_REF = 'cnlnrlzhhbrtehpkttqv';
const apiBaseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || '';
const devPointingAtDeployedApi = /bookshelfscan\.app|\.vercel\.app/i.test(apiBaseUrl);
if (__DEV__ && SUPABASE_REF === KNOWN_PROD_REF && !devPointingAtDeployedApi) {
  throw new Error('Dev build is pointing at PROD Supabase. Refusing to start. Set EXPO_PUBLIC_SUPABASE_URL_DEV (and _ANON_KEY_DEV) to your dev project in .env, or point EXPO_PUBLIC_API_BASE_URL_DEV at your deployed API to use prod Supabase.');
}

if (!url || !key) {
  console.error('❌ Missing Supabase config. app.config sets extra.supabaseUrl / extra.supabaseAnonKey from .env (dev: _DEV vars; prod: EXPO_PUBLIC_SUPABASE_*).');
}

export const SUPABASE_INSTANCE_ID = Math.random().toString(16).slice(2);
if (__DEV__) console.log('[SUPABASE_INSTANCE]', SUPABASE_INSTANCE_ID);

// Single client: create once, reuse from global so even duplicate imports get the same instance.
function getSupabaseClient(): SupabaseClient {
  if (globalThis.__SUPABASE_APP_CLIENT) {
    return globalThis.__SUPABASE_APP_CLIENT;
  }
  globalThis.__SUPABASE_APP_CLIENT = createClient(url!, key!, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return globalThis.__SUPABASE_APP_CLIENT;
}

export { SUPABASE_REF, SUPABASE_ENV };
export const supabase = getSupabaseClient();
