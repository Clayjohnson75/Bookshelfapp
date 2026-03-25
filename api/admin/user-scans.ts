/**
 * GET /api/admin/user-scans?userId=xxx
 * Admin-only: returns all scans for a specific user with timestamps and book details.
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

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', userData.user.id).maybeSingle();
  if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    // Get user profile
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .eq('id', userId)
      .maybeSingle();

    // Get all scans for this user
    const { data: scans } = await supabase
      .from('scan_jobs')
      .select('id, status, created_at, updated_at, stage, stage_detail, books, progress')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200);

    // Get book counts
    const { count: approvedCount } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'approved');

    const { count: booksWithCovers } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'approved')
      .not('cover_url', 'is', null);

    const scanDetails = (scans ?? []).map((s: any) => {
      const booksArr = Array.isArray(s.books) ? s.books : [];
      const duration = s.updated_at && s.created_at
        ? new Date(s.updated_at).getTime() - new Date(s.created_at).getTime()
        : null;
      return {
        jobId: s.id,
        status: s.status,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        stage: s.stage,
        detail: s.stage_detail,
        booksFound: booksArr.length,
        booksWithCovers: booksArr.filter((b: any) => b.coverUrl || b.cover_url).length,
        bookTitles: booksArr.slice(0, 30).map((b: any) => ({
          title: b.title || 'Untitled',
          author: b.author || '',
          hasCover: !!(b.coverUrl || b.cover_url),
        })),
        durationMs: duration,
        progress: s.progress,
      };
    });

    return res.status(200).json({
      user: userProfile ?? { id: userId, username: 'unknown' },
      totalScans: scanDetails.length,
      completedScans: scanDetails.filter((s: any) => s.status === 'completed').length,
      failedScans: scanDetails.filter((s: any) => s.status === 'failed' || s.status === 'error').length,
      totalApprovedBooks: approvedCount ?? 0,
      booksWithCovers: booksWithCovers ?? 0,
      scans: scanDetails,
    });
  } catch (err: any) {
    console.error('[ADMIN_USER_SCANS] Error:', err?.message);
    return res.status(500).json({ error: 'Failed to load user scans' });
  }
}
