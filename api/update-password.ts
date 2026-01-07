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

    // Get anon key for regular client (needed for recovery token verification)
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseAnonKey) {
      console.error('[API] Missing Supabase anon key');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Create admin client for password update (server-side)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Create a regular Supabase client (not admin) for recovery token verification
    // Recovery tokens need to be verified using the regular client
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Track if token was already used (for single-use enforcement)
    let tokenUsed = false;
    let userEmail: string | null = null;
    let userSession: any = null;

    // Verify the token and update the password
    // Supabase recovery tokens are hash tokens that should be used with verifyOtp
    // exchangeCodeForSession is for OAuth/PKCE flows, not recovery tokens
    try {
      // Recovery tokens should be verified using verifyOtp with type 'recovery'
      const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: token as string,
        type: 'recovery',
      });

      if (verifyError || !verifyData?.user) {
        console.error('[API] verifyOtp failed:', verifyError);
        
        // Check if error indicates token was already used or expired
        if (verifyError?.message?.includes('already been used') || 
            verifyError?.message?.includes('expired') ||
            verifyError?.code === 'otp_expired') {
          return res.status(400).json({ 
            error: 'Token already used',
            message: 'This password reset link has already been used or has expired. Please request a new one.'
          });
        }
        
        return res.status(400).json({ 
          error: 'Invalid or expired token',
          message: 'The password reset link is invalid or has expired. Please request a new one.'
        });
      }

      // Token was successfully verified - verifyOtp automatically sets the session
      tokenUsed = true;
      userEmail = verifyData.user.email || null;
      userSession = verifyData;

      // At this point, we have a valid session from the recovery token
      // The token is now consumed and cannot be used again (single-use enforced by Supabase)
      
      if (!userEmail) {
        return res.status(400).json({ 
          error: 'User email not found',
          message: 'Unable to retrieve user information. Please request a new password reset link.'
        });
      }

      // Verify the session is set (verifyOtp should have done this automatically)
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      if (!currentSession) {
        console.error('[API] No session found after verifyOtp');
        return res.status(400).json({ 
          error: 'Session error',
          message: 'Unable to establish session. Please request a new password reset link.'
        });
      }

      // Check if the new password is the same as the current password
      // We do this by attempting to sign in with the new password
      // If sign-in succeeds, the password hasn't changed
      const testSupabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      });

      const { data: signInData, error: signInError } = await testSupabase.auth.signInWithPassword({
        email: userEmail,
        password: password as string,
      });

      // If sign-in succeeds, it means the password is the same
      if (signInData?.user && !signInError) {
        return res.status(400).json({ 
          error: 'Password unchanged',
          message: 'The new password must be different from your current password. Please choose a different password.'
        });
      }

      // If we get here, the password is different (sign-in failed as expected)
      // Now update the password using the admin client since we're on the server
      // We have verified the token is valid, so we can safely update the password
      const userId = verifyData.user.id;
      console.log('[API] Updating password for user:', userEmail, 'ID:', userId);
      
      // Use admin client to update password directly
      const { data: updateData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        { password: password as string }
      );

      if (updateError) {
        console.error('[API] Error updating password with admin client:', updateError);
        console.error('[API] Update error details:', JSON.stringify(updateError, null, 2));
        
        // Fallback: try using the regular client with the session
        const { error: fallbackError } = await supabase.auth.updateUser({
          password: password as string
        });
        
        if (fallbackError) {
          console.error('[API] Fallback update also failed:', fallbackError);
          return res.status(400).json({ 
            error: 'Password update failed',
            message: fallbackError.message || 'Failed to update password. Please try again.'
          });
        }
      }

      console.log('[API] Password update successful for user:', userId);

      // Verify the password was actually changed by attempting to sign in with the new password
      const verifySupabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      });

      const { data: verifySignInData, error: verifySignInError } = await verifySupabase.auth.signInWithPassword({
        email: userEmail,
        password: password as string,
      });

      if (verifySignInError || !verifySignInData?.user) {
        console.error('[API] Password verification failed after update:', verifySignInError);
        return res.status(500).json({ 
          error: 'Password update verification failed',
          message: 'The password may not have been updated correctly. Please try again or contact support.'
        });
      }

      // Password was successfully updated and verified
      return res.status(200).json({ 
        success: true,
        message: 'Your password has been successfully updated!'
      });

    } catch (error: any) {
      console.error('[API] Error in password update:', error);
      
      // Check if error indicates token was already used
      if (error?.message?.includes('already been used') || 
          error?.message?.includes('expired')) {
        return res.status(400).json({ 
          error: 'Token already used',
          message: 'This password reset link has already been used. Please request a new one.'
        });
      }
      
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

