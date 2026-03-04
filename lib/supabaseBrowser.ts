/**
 * Supabase browser client (plain supabase-js) for web pages.
 * Uses localStorage for session (persistSession: true) and auto-refresh.
 * After sign-in, call POST /api/web-sync-session with access_token + refresh_token
 * so the server mints sb-* cookies and /api/admin/check works.
 *
 * For inline scripts in server-rendered HTML, the page must inject EXPO_PUBLIC_SUPABASE_URL
 * and EXPO_PUBLIC_SUPABASE_ANON_KEY and create the client with the same options.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

export const supabaseBrowser =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null;
