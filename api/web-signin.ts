import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { emailOrUsername, password, username } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ 
        error: 'Missing credentials',
        message: 'Please provide both email/username and password.'
      });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured.'
      });
    }

    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Handle username lookup if needed
    let email = emailOrUsername;
    if (!emailOrUsername.includes('@')) {
      // It's a username, need to look up the email
      // Use service role key to access auth.users
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseServiceKey) {
        return res.status(500).json({ 
          error: 'Server configuration error',
          message: 'Server is not properly configured.'
        });
      }

      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
      
      // Get profile to find user ID
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', emailOrUsername.toLowerCase())
        .single();

      if (profileError || !profile) {
        return res.status(401).json({ 
          error: 'Invalid credentials',
          message: 'Invalid username or password.'
        });
      }

      // Get the user's email from auth.users using admin client
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(profile.id);
      if (authError || !authUser?.user?.email) {
        return res.status(401).json({ 
          error: 'Invalid credentials',
          message: 'Could not find email for this username.'
        });
      }
      email = authUser.user.email;
    }

    // Sign in with email and password
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (signInError || !signInData?.user) {
      return res.status(401).json({ 
        error: 'Invalid credentials',
        message: signInError?.message || 'Invalid email/username or password.'
      });
    }

    // If username was provided, verify it matches
    if (username) {
      const { data: userProfile } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', signInData.user.id)
        .single();

      if (userProfile?.username?.toLowerCase() !== username.toLowerCase()) {
        await supabase.auth.signOut();
        return res.status(403).json({ 
          error: 'Account mismatch',
          message: 'This account does not match this profile.'
        });
      }
    }

    // Return success with session token
    return res.status(200).json({
      success: true,
      message: 'Signed in successfully',
      user: {
        id: signInData.user.id,
        email: signInData.user.email,
      },
      session: signInData.session,
    });

  } catch (error: any) {
    console.error('[API] Error in web-signin:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.'
    });
  }
}

