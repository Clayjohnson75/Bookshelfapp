import type { VercelRequest, VercelResponse } from '@vercel/node';

// This endpoint returns all completed scan jobs for a user that haven't been synced yet
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { userId, since } = req.query;
    
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId required' });
    }
    
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Database not configured' });
    }
    
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    // Build query
    let query = supabase
      .from('scan_jobs')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['completed', 'failed']);
    
    // If since timestamp provided, only get jobs updated after that
    if (since && typeof since === 'string') {
      query = query.gt('updated_at', since);
    }
    
    const { data, error } = await query.order('updated_at', { ascending: false });
    
    if (error) {
      console.error('[API] Error fetching scan jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch scan jobs' });
    }
    
    // Format response
    const jobs = (data || []).map(job => ({
      jobId: job.id,
      status: job.status,
      books: job.books || [],
      error: job.error || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    
    return res.status(200).json({ jobs });
    
  } catch (e: any) {
    console.error('[API] Error syncing scans:', e);
    return res.status(500).json({ error: 'sync_failed', detail: e?.message || String(e) });
  }
}


