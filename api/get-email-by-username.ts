import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured.'
      });
    }

    // Use service role key to access profiles and auth.users
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
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
    } catch (timeoutError: any) {
      console.error('[API] Profile lookup timeout or error:', timeoutError);
      return res.status(500).json({ 
        error: 'Request timeout',
        message: 'The request took too long. Please try again.'
      });
    }
    
    const { data: profile, error: profileError } = profileResult as any;

    if (profileError || !profile) {
      console.error('[API] Profile not found:', profileError);
      return res.status(404).json({ 
        error: 'Username not found',
        message: 'This username does not exist.'
      });
    }

    console.log('[API] Found profile, looking up email for user ID:', profile.id);
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
    
    const { data: authUser, error: authError } = authResult as any;
    
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
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.'
    });
  }
}

