import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Authenticate via Bearer token — never trust userId from the body.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Validate token and extract userId from it (not from body)
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get username from profile using authenticated userId
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.status(200).json({ username: profile.username });
  } catch (error: any) {
    console.error('[API] Error in get-username:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
