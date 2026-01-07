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
    const { token, password, confirmPassword } = req.body;

    if (!token || !password || !confirmPassword) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Token, password, and confirm password are required.'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ 
        error: 'Passwords do not match',
        message: 'The passwords you entered do not match. Please try again.'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'Password too short',
        message: 'Password must be at least 6 characters long.'
      });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Get anon key for regular client (needed for recovery token exchange)
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseAnonKey) {
      console.error('[API] Missing Supabase anon key');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Create a regular Supabase client (not admin) for recovery token flow
    // Recovery tokens need to be exchanged using the regular client
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Verify the token and update the password
    // Supabase recovery tokens need to be exchanged for a session first
    try {
      // Try to exchange the token for a session
      // The token from the email link is typically a code that needs to be exchanged
      const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(token as string);
      
      if (sessionError || !sessionData?.user) {
        console.error('[API] Error exchanging code for session:', sessionError);
        
        // If exchangeCodeForSession fails, try verifyOtp as fallback
        const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: token as string,
          type: 'recovery',
        });

        if (verifyError || !verifyData?.user) {
          console.error('[API] verifyOtp also failed:', verifyError);
          return res.status(400).json({ 
            error: 'Invalid or expired token',
            message: 'The password reset link is invalid or has expired. Please request a new one.'
          });
        }

        // If verifyOtp worked, use that session to update password
        const { error: updateError } = await supabase.auth.updateUser({
          password: password as string
        });

        if (updateError) {
          console.error('[API] Error updating password:', updateError);
          return res.status(400).json({ 
            error: 'Password update failed',
            message: updateError.message || 'Failed to update password. Please try again.'
          });
        }

        return res.status(200).json({ 
          success: true,
          message: 'Your password has been successfully updated!'
        });
      }

      // If exchangeCodeForSession worked, we have a session, so update the password
      const { error: updateError } = await supabase.auth.updateUser({
        password: password as string
      });

      if (updateError) {
        console.error('[API] Error updating password:', updateError);
        return res.status(400).json({ 
          error: 'Password update failed',
          message: updateError.message || 'Failed to update password. Please try again.'
        });
      }

      return res.status(200).json({ 
        success: true,
        message: 'Your password has been successfully updated!'
      });

    } catch (error: any) {
      console.error('[API] Error in password update:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'An error occurred while updating your password. Please try again.'
      });
    }
  } catch (error: any) {
    console.error('[API] Error in update-password:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.'
    });
  }
}

