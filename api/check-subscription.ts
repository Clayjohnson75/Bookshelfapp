import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract JWT from Authorization header
    const authHeader = req.headers.authorization || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!jwt) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Create Supabase client with user JWT (RLS enforced)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Get user ID
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    
    if (userErr) {
      console.error('[API] Error getting user from token:', userErr.message);
      return res.status(401).json({ error: 'Unauthorized', message: userErr.message });
    }
    
    const userId = userData?.user?.id;
    if (!userId) {
      console.error('[API] No user ID found in token');
      return res.status(401).json({ error: 'Unauthorized', message: 'No user ID in token' });
    }
    
    console.log('[API] Checking subscription for user:', userId);

    // Get subscription status
    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_tier, subscription_status, subscription_ends_at')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('[API] Error fetching profile:', error.message);
      return res.status(200).json({ isPro: false });
    }
    
    if (!data) {
      console.error('[API] No profile data found for user:', userId);
      return res.status(200).json({ isPro: false });
    }
    
    console.log('[API] Profile subscription data:', {
      tier: data.subscription_tier,
      status: data.subscription_status,
      endsAt: data.subscription_ends_at
    });

    // Check if subscription is active and not expired
    let isPro = false;
    if (data.subscription_tier === 'pro' || data.subscription_tier === 'owner') {
      if (data.subscription_status === 'active') {
        if (data.subscription_ends_at) {
          const endsAt = new Date(data.subscription_ends_at);
          isPro = endsAt > new Date();
        } else {
          // No end date means active
          isPro = true;
        }
      }
    }

    return res.status(200).json({ isPro });
  } catch (error: any) {
    console.error('[API] Error checking subscription:', error);
    return res.status(200).json({ isPro: false });
  }
}

