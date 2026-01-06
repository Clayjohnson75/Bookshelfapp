import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Check if an email already exists and is confirmed
 * Used to prevent duplicate signups
 */
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
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Supabase credentials not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Create admin client to check users
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Check if user with this email exists
    const { data: users, error } = await supabaseAdmin.auth.admin.listUsers();

    if (error) {
      console.error('Error checking email:', error);
      return res.status(500).json({ error: 'Failed to check email' });
    }

    // Find user with matching email
    const existingUser = users?.users?.find((user: any) => 
      user.email?.toLowerCase() === email.toLowerCase()
    );

    if (existingUser) {
      // Check if email is confirmed
      const isConfirmed = !!existingUser.email_confirmed_at;
      
      return res.status(200).json({
        exists: true,
        confirmed: isConfirmed,
        userId: existingUser.id,
      });
    }

    // Email doesn't exist
    return res.status(200).json({
      exists: false,
      confirmed: false,
    });
  } catch (error: any) {
    console.error('Error in check-email-exists:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message 
    });
  }
}

