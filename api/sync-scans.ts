import type { VercelRequest, VercelResponse } from '@vercel/node';

// Returns scan jobs for a user. Default: completed/failed (for syncing). ?active=1: pending+processing (for polling "my active scans").
// All queries: user_id, deleted_at is null, only relevant statuses, only recent (7d), order updated_at desc, limit 20.
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
  
  // Auth: Bearer token required. userId is derived from token — never from query params.
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
  }

  try {
    const { since, active, jobIds: jobIdsParam } = req.query;
    const activeOnly = active === '1' || active === 'true';
    const jobIdsRaw = typeof jobIdsParam === 'string' ? jobIdsParam : undefined;
    const jobIds = jobIdsRaw
      ? jobIdsRaw.split(',').map((id: string) => id.trim()).filter(Boolean).slice(0, 50)
      : undefined;

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

    // Verify token and derive userId — never trust userId from query string.
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ error: authErr?.message ?? 'Invalid or expired token' });
    }
    const userId = userData.user.id;

    const RECENT_DAYS = 7;
    const LIST_LIMIT = 20;
    const recentCutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // ?jobIds=id1,id2: fetch those specific jobs (any status) for tab-return progress rebuild
    if (jobIds && jobIds.length > 0) {
      const { data: jobData, error: jobError } = await supabase
        .from('scan_jobs')
        .select('id, status, books, error, created_at, updated_at')
        .eq('user_id', userId)
        .in('id', jobIds)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });

      if (jobError) {
        console.error('[API] Error fetching jobs by id:', jobError);
        return res.status(500).json({ error: 'Failed to fetch jobs' });
      }

      const rows = jobData ?? [];
      const jobs = rows.map((job: any) => ({
        jobId: job.id,
        status: job.status,
        books: job.books || [],
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      }));
      return res.status(200).json({ jobs });
    }

    if (activeOnly) {
      // Explicit active/pending list: only this user, not deleted, only active statuses, only recent, ordered, limited.
      // Use ?active=1 to poll "my current/active scans" (pending + processing).
      const { data: activeData, error: activeError } = await supabase
        .from('scan_jobs')
        .select('*')
        .eq('user_id', userId)
        .in('status', ['pending', 'processing'])
        .is('deleted_at', null)
        .gte('created_at', recentCutoff)
        .order('updated_at', { ascending: false })
        .limit(LIST_LIMIT);

      if (activeError) {
        console.error('[API] Error fetching active scan jobs:', activeError);
        return res.status(500).json({ error: 'Failed to fetch active scans' });
      }

      const rows = activeData ?? [];
      const jobs = rows.map((job: any) => ({
        jobId: job.id,
        status: job.status,
        books: job.books || [],
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      }));
      return res.status(200).json({ jobs });
    }

    // Completed/failed list: only this user, not deleted, not yet imported, only completed/failed, only recent
    let query = supabase
      .from('scan_jobs')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['completed', 'failed'])
      .is('deleted_at', null)
      .is('imported_at', null)
      .gte('created_at', recentCutoff);

    if (since && typeof since === 'string') {
      query = query.gt('updated_at', since);
    }

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT);
    
    if (error) {
      console.error('[API] Error fetching scan jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch scan jobs' });
    }

    const rows = data ?? [];
    
    // Format response
    const jobs = rows.map((job: any) => ({
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












