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
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ 
        error: 'Token required',
        message: 'Confirmation token is required.'
      });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Try to verify the token
    try {
      // First try verifyOtp
      const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: 'signup',
      });

      if (verifyError || !verifyData) {
        // Try exchangeCodeForSession as fallback
        const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(token);
        
        if (sessionError || !sessionData) {
          console.error('[API] Error confirming email:', sessionError || verifyError);
          return res.status(400).json({ 
            error: 'Invalid or expired token',
            message: 'The confirmation link is invalid or has expired. Please request a new one.'
          });
        }

        return res.status(200).json({ 
          success: true,
          message: 'Your email has been successfully confirmed!'
        });
      }

      return res.status(200).json({ 
        success: true,
        message: 'Your email has been successfully confirmed!'
      });

    } catch (error: any) {
      console.error('[API] Error in email confirmation:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'An error occurred while confirming your email. Please try again.'
      });
    }
  } catch (error: any) {
    console.error('[API] Error in confirm-email-api:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.'
    });
  }
}

