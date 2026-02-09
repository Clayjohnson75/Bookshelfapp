/**
 * Single source-of-truth session debug. Call from init, supabaseSync, authHeaders
 * to see exactly where hasSession becomes false.
 */
import { supabase } from './supabase';

export async function debugSession(tag: string): Promise<{ id?: string; access_token?: string } | null> {
  if (!supabase) {
    console.log(`[AUTH DEBUG][${tag}] supabase=null`);
    return null;
  }
  const { data: { session }, error } = await supabase.auth.getSession();
  console.log(`[AUTH DEBUG][${tag}] hasSession=`, !!session);
  console.log(`[AUTH DEBUG][${tag}] userId=`, session?.user?.id);
  console.log(`[AUTH DEBUG][${tag}] tokenLen=`, session?.access_token?.length);
  if (error) console.log(`[AUTH DEBUG][${tag}] error=`, error?.message);
  return session ?? null;
}
