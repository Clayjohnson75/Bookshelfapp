/**
 * GET /api/admin/scan-analytics
 * Admin-only: requires Bearer auth + profiles.is_admin.
 * Returns scan stats, recent scans, errors, and cover resolution breakdown.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getCredentialedOrigin } from '../../lib/corsCredentialed';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Server configuration error' });

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify admin
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
  const requesterId = userData.user.id;

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', requesterId)
    .maybeSingle();
  if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    // Run all queries in parallel
    const [
      totalUsersRes,
      totalScansRes,
      completedScansRes,
      failedScans24hRes,
      scans7dRes,
      totalBooksRes,
      booksWithCoversRes,
      recentScansRes,
      recentErrorsRes,
      coverReadyRes,
      coverMissingRes,
      coverErrorRes,
      coverTotalRes,
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('scan_jobs').select('id', { count: 'exact', head: true }),
      supabase.from('scan_jobs').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
      supabase.from('scan_jobs').select('id', { count: 'exact', head: true })
        .in('status', ['failed', 'error'])
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('scan_jobs').select('id', { count: 'exact', head: true })
        .eq('status', 'completed')
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('books').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('books').select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .not('cover_url', 'is', null),
      // Recent 50 scans with username
      supabase.from('scan_jobs')
        .select('id, user_id, status, created_at, updated_at, stage, stage_detail, books')
        .order('created_at', { ascending: false })
        .limit(50),
      // Recent 50 errors
      supabase.from('scan_jobs')
        .select('id, user_id, status, created_at, stage, stage_detail')
        .in('status', ['failed', 'error'])
        .order('created_at', { ascending: false })
        .limit(50),
      // Cover resolution stats — use separate count queries instead of fetching all rows
      supabase.from('cover_resolutions').select('id', { count: 'exact', head: true }).eq('status', 'ready'),
      supabase.from('cover_resolutions').select('id', { count: 'exact', head: true }).eq('status', 'missing'),
      supabase.from('cover_resolutions').select('id', { count: 'exact', head: true }).eq('status', 'error'),
      supabase.from('cover_resolutions').select('id', { count: 'exact', head: true }),
    ]);

    const totalUsers = totalUsersRes.count ?? 0;
    const totalScans = totalScansRes.count ?? 0;
    const completedScans = completedScansRes.count ?? 0;
    const failedScans24h = failedScans24hRes.count ?? 0;
    const scans7d = scans7dRes.count ?? 0;
    const totalBooks = totalBooksRes.count ?? 0;
    const booksWithCovers = booksWithCoversRes.count ?? 0;
    const coverRate = totalBooks > 0 ? Math.round((booksWithCovers / totalBooks) * 100) / 100 : 0;
    const avgBooksPerScan = completedScans > 0 ? Math.round((totalBooks / completedScans) * 10) / 10 : 0;

    // Get usernames for recent scans and errors
    const allUserIds = new Set<string>();
    (recentScansRes.data ?? []).forEach((s: any) => { if (s.user_id) allUserIds.add(s.user_id); });
    (recentErrorsRes.data ?? []).forEach((s: any) => { if (s.user_id) allUserIds.add(s.user_id); });

    let usernameMap: Record<string, string> = {};
    if (allUserIds.size > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', [...allUserIds]);
      if (profiles) {
        profiles.forEach((p: any) => { usernameMap[p.id] = p.username || 'unknown'; });
      }
    }

    // Process recent scans
    const recentScans = (recentScansRes.data ?? []).map((s: any) => {
      const booksArr = Array.isArray(s.books) ? s.books : [];
      const booksFound = booksArr.length;
      const booksWithCover = booksArr.filter((b: any) => b.coverUrl || b.cover_url).length;
      const duration = s.updated_at && s.created_at
        ? new Date(s.updated_at).getTime() - new Date(s.created_at).getTime()
        : null;
      return {
        jobId: s.id,
        userId: s.user_id,
        username: usernameMap[s.user_id] || 'unknown',
        createdAt: s.created_at,
        status: s.status,
        booksFound,
        booksWithCovers: booksWithCover,
        coverRate: booksFound > 0 ? Math.round((booksWithCover / booksFound) * 100) : 0,
        durationMs: duration,
        stage: s.stage,
      };
    });

    // Process recent errors
    const recentErrors = (recentErrorsRes.data ?? []).map((s: any) => ({
      jobId: s.id,
      userId: s.user_id,
      username: usernameMap[s.user_id] || 'unknown',
      createdAt: s.created_at,
      status: s.status,
      stage: s.stage,
      detail: s.stage_detail,
    }));

    // Cover stats from count queries
    const coverReady = coverReadyRes.count ?? 0;
    const coverMissing = coverMissingRes.count ?? 0;
    const coverError = coverErrorRes.count ?? 0;
    const totalResolutions = coverTotalRes.count ?? 0;

    return res.status(200).json({
      overview: {
        totalUsers,
        totalScans,
        completedScans,
        totalBooks,
        booksWithCovers,
        coverRate,
        avgBooksPerScan,
        scans7d,
        failedScans24h,
      },
      recentScans,
      recentErrors,
      coverStats: {
        total: totalResolutions,
        byStatus: { ready: coverReady, missing: coverMissing, error: coverError, other: totalResolutions - coverReady - coverMissing - coverError },
        bySource: {},
      },
    });
  } catch (err: any) {
    console.error('[ADMIN_ANALYTICS] Error:', err?.message);
    return res.status(500).json({ error: 'Failed to load analytics' });
  }
}
