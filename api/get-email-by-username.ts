import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers - handle both www and non-www
  const origin = req.headers.origin || req.headers.referer || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === 'https://www.bookshelfscan.app' || origin === 'https://bookshelfscan.app' ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username } = req.body;

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ 
        error: 'Username required',
        message: 'Please provide a valid username.'
      });
    }

    // Get Supabase credentials - try both production and dev
    const prodSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const devSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL_DEV || process.env.SUPABASE_URL_DEV;
    const prodServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const devServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY_DEV;

    console.log('[API] Production Supabase URL:', prodSupabaseUrl ? `${prodSupabaseUrl.substring(0, 30)}...` : 'MISSING');
    console.log('[API] Dev Supabase URL:', devSupabaseUrl ? `${devSupabaseUrl.substring(0, 30)}...` : 'MISSING');

    // Try production first, then dev if production fails
    const supabaseConfigs = [
      { url: prodSupabaseUrl, key: prodServiceKey, name: 'PRODUCTION' },
      { url: devSupabaseUrl, key: devServiceKey, name: 'DEV' }
    ].filter(config => config.url && config.key);

    if (supabaseConfigs.length === 0) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Missing Supabase credentials.'
      });
    }

    // Try each Supabase instance until we find the user
    let profile: any = null;
    let profileError: any = null;
    let authUser: any = null;
    let authError: any = null;
    let usedSupabase = '';

    for (const config of supabaseConfigs) {
      console.log(`[API] Trying ${config.name} Supabase: ${config.url?.substring(0, 30)}...`);
      
      const supabase = createClient(config.url!, config.key!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

      // Get profile to find user ID (with timeout protection)
      console.log('[API] Looking up profile for username:', username.toLowerCase());
      const profilePromise = supabase
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .single();

      const profileTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Profile lookup timeout')), 10000)
      );
      
      let profileResult;
      try {
        profileResult = await Promise.race([profilePromise, profileTimeout]);
        const result = profileResult as any;
        
        if (result.data && !result.error) {
          profile = result.data;
          usedSupabase = config.name;
          console.log(`[API] Found profile in ${config.name} Supabase`);
          break; // Found it, stop trying
        } else if (result.error) {
          console.log(`[API] Profile not found in ${config.name} Supabase:`, result.error.message);
          // Continue to next Supabase instance
        }
      } catch (timeoutError: any) {
        console.error(`[API] Profile lookup timeout in ${config.name} Supabase:`, timeoutError);
        // Continue to next Supabase instance
      }
    }

    if (!profile) {
      console.error('[API] Profile not found in any Supabase instance');
      return res.status(404).json({ 
        error: 'Username not found',
        message: 'This username does not exist.'
      });
    }

    console.log(`[API] Found profile in ${usedSupabase}, looking up email for user ID:`, profile.id);
    
    // Use the same Supabase instance where we found the profile
    const config = supabaseConfigs.find(c => c.name === usedSupabase);
    if (!config || !config.url || !config.key) {
      return res.status(500).json({ 
        error: 'Configuration error',
        message: 'Could not find Supabase configuration.'
      });
    }
    
    const supabase = createClient(config.url, config.key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    // Get the user's email from auth.users using admin client (with timeout)
    const authPromise = supabase.auth.admin.getUserById(profile.id);
    const authTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Auth lookup timeout')), 10000)
    );
    
    let authResult;
    try {
      authResult = await Promise.race([authPromise, authTimeout]);
    } catch (timeoutError: any) {
      console.error('[API] Auth lookup timeout or error:', timeoutError);
      return res.status(500).json({ 
        error: 'Request timeout',
        message: 'The request took too long. Please try again.'
      });
    }
    
    const authResultData = authResult as any;
    authUser = authResultData.data;
    authError = authResultData.error;
    
    if (authError || !authUser?.user?.email) {
      console.error('[API] Email not found:', authError);
      return res.status(404).json({ 
        error: 'Email not found',
        message: 'Could not find email for this username.'
      });
    }
    
    console.log('[API] Successfully found email for username:', username);

    return res.status(200).json({
      email: authUser.user.email,
    });

  } catch (error: any) {
    console.error('[API] Error in get-email-by-username:', error);
    console.error('[API] Error stack:', error?.stack);
    console.error('[API] Error details:', {
      message: error?.message,
      name: error?.name,
      code: error?.code
    });
    
    // Ensure CORS headers are set even on error
    const origin = req.headers.origin || req.headers.referer || '*';
    res.setHeader('Access-Control-Allow-Origin', origin === 'https://www.bookshelfscan.app' || origin === 'https://bookshelfscan.app' ? origin : '*');
    
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
}

