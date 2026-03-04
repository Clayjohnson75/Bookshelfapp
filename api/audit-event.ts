import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/audit-event
 *
 * Persist a single delete/destructive-action audit record to audit_events.
 * Called fire-and-forget from deleteGuard.logDeleteAudit so every client-side
 * delete has a permanent server-side record regardless of local log retention.
 *
 * Auth: Authorization: Bearer <Supabase access_token> required.
 * userId is derived from token — never trusted from body.
 *
 * Body shape mirrors DeleteAuditPayload + intent fields:
 *   { actionId, reason, screen, gestureAt, bookIds?, photoIds?,
 *     bookCount?, photoCount?, extra? }
 */

const ALLOWED_REASONS = new Set([
  'user_delete_photo',
  'user_delete_photo_cascade',
  'user_delete_book',
  'user_delete_books_bulk',
  'user_reject_pending',
  'user_delete_scan',
  'user_clear_library',
  'user_approve',
  'debug_reset',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authorization: Bearer <token> required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ ok: false, error: 'Database not configured' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ ok: false, error: authError?.message ?? 'Invalid or expired token' });
  }
  const userId = userData.user.id;

  const body = (req.body ?? {}) as Record<string, unknown>;

  const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : null;
  const reason   = typeof body.reason   === 'string' ? body.reason.trim()   : null;
  const screen   = typeof body.screen   === 'string' ? body.screen.slice(0, 128) : null;
  const gestureAt = typeof body.gestureAt === 'number' ? body.gestureAt : null;

  if (!actionId || !reason) {
    return res.status(400).json({ ok: false, error: 'actionId and reason are required' });
  }
  if (!ALLOWED_REASONS.has(reason)) {
    return res.status(400).json({ ok: false, error: `Unknown reason: ${reason}` });
  }

  const bookIds: string[] =
    Array.isArray(body.bookIds)
      ? (body.bookIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 500)
      : [];
  const photoIds: string[] =
    Array.isArray(body.photoIds)
      ? (body.photoIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200)
      : [];
  const bookCount  = typeof body.bookCount  === 'number' ? body.bookCount  : bookIds.length;
  const photoCount = typeof body.photoCount === 'number' ? body.photoCount : photoIds.length;
  const extra =
    body.extra != null && typeof body.extra === 'object' && !Array.isArray(body.extra)
      ? (body.extra as Record<string, unknown>)
      : {};

  const occurredAt = gestureAt
    ? new Date(gestureAt).toISOString()
    : new Date().toISOString();

  console.log('[AUDIT_EVENT]', JSON.stringify({
    userId: userId.slice(0, 8),
    actionId,
    reason,
    screen,
    bookCount,
    photoCount,
    occurredAt,
  }));

  const { error: insertErr } = await supabase.from('audit_events').insert({
    user_id:     userId,
    action_id:   actionId,
    reason,
    screen,
    book_ids:    bookIds.length > 0   ? bookIds   : null,
    photo_ids:   photoIds.length > 0  ? photoIds  : null,
    book_count:  bookCount,
    photo_count: photoCount,
    extra,
    occurred_at: occurredAt,
  });

  if (insertErr) {
    // Duplicate actionId means the client retried — treat as success.
    if (insertErr.code === '23505') {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    // Table missing (migration not run): do not fail the client; log and return ok so clear-library etc. still succeed.
    const msg = insertErr.message ?? '';
    const tableMissing =
      insertErr.code === '42P01' ||
      /could not find the table/i.test(msg) ||
      /audit_events.*(does not exist|not found)/i.test(msg) ||
      /(relation|table).*audit_events.*does not exist/i.test(msg) ||
      /schema cache/i.test(msg);
    if (tableMissing) {
      console.warn('[AUDIT_EVENT] insert skipped (audit_events table not in schema):', msg);
      return res.status(200).json({ ok: true, skipped: true, reason: 'audit_events table not found' });
    }
    console.error('[AUDIT_EVENT] insert failed:', insertErr.message);
    return res.status(500).json({ ok: false, error: insertErr.message });
  }

  return res.status(201).json({ ok: true });
}
