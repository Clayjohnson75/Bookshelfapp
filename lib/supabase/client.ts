/**
 * Supabase browser client for use with @supabase/ssr (cookie-based auth).
 * Use this for sign-in on the website so the session is stored in SSR cookies
 * and the server can read the user from cookies (e.g. /api/admin/check).
 *
 * Usage (when sign-in runs in the browser):
 * import { createSupabaseBrowserClient } from '@/lib/supabase/client';
 * const supabase = createSupabaseBrowserClient();
 * await supabase.auth.signInWithPassword({ email, password });
 *
 * Do not use plain createClient from supabase-js for sign-in it will not
 * set the SSR cookies the server expects.
 */
import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowserClient() {
 const supabaseUrl =
 process.env.EXPO_PUBLIC_SUPABASE_URL ||
 process.env.NEXT_PUBLIC_SUPABASE_URL ||
 '';
 const supabaseAnonKey =
 process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
 process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
 '';

 if (!supabaseUrl || !supabaseAnonKey) {
 throw new Error(
 'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_*)'
 );
 }

 return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
