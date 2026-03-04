import { createHash } from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkRateLimit, sendRateLimitResponse } from '../lib/rateLimit';

const ALLOWED_EVENTS = new Set([
  'SCAN_ENQUEUE',
  'SCAN_STATUS_CHANGE',
  'SCAN_IMPORT',
  'SCAN_DONE_CLIENT',
  'SCAN_POLL_TARGETS',
  'SCAN_TRACKED_JOB_CHANGE',
  'SCAN_BAR_VARIANT',
  'APP_STATE_CHANGE',
  'SCAN_POLL_RESUME',
  'SCAN_STATUS_HTTP_ERROR',
]);

const MAX_BODY_BYTES = 32 * 1024;
const MAX_DATA_BYTES = 8 * 1024;
const TOKEN_LIKE_KEYS = new Set([
  'authorization', 'access_token', 'refresh_token', 'token', 'password', 'secret',
  'api_key', 'apikey', 'api_key_id', 'bearer', 'jwt', 'session_id',
]);

function sanitizeTelemetryData(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (TOKEN_LIKE_KEYS.has(keyLower)) continue;
    if (v != null && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function') {
      out[k] = sanitizeTelemetryData(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rateLimitResult = await checkRateLimit(req, 'telemetry');
  if (!rateLimitResult.success) {
    sendRateLimitResponse(res, rateLimitResult);
    return;
  }

  try {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body required' });
    }

    const bodySize = JSON.stringify(body).length;
    if (bodySize > MAX_BODY_BYTES) {
      return res.status(400).json({ error: 'Payload too large', maxBytes: MAX_BODY_BYTES });
    }

    const eventName = body.eventName as string | undefined;
    if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
      return res.status(400).json({ error: 'Invalid or missing eventName' });
    }

    // Derive userId from Bearer token when provided — ignore body.userId to prevent spoofing.
    // Token is optional so unauthenticated clients (e.g. pre-login) can still log events with userId=null.
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (bearerToken) {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && supabaseServiceKey) {
        const { createClient: _createClient } = await import('@supabase/supabase-js');
        const _authClient = _createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { data: _ud } = await _authClient.auth.getUser(bearerToken);
        if (_ud?.user?.id) userId = _ud.user.id;
      }
    }
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 256) : null;
    // Store hashed session_id only (0023 sensitive_columns_exposed) — correlation without leaking raw identifier.
    const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 256) : null;
    const sessionId = rawSessionId
      ? createHash('sha256').update(rawSessionId, 'utf8').digest('hex')
      : null;
    const build = typeof body.build === 'string' ? body.build.slice(0, 128) : null;
    const rawData = body.data != null && typeof body.data === 'object' ? body.data : {};
    const data = sanitizeTelemetryData(rawData as Record<string, unknown>);
    if (JSON.stringify(data).length > MAX_DATA_BYTES) {
      return res.status(400).json({ error: 'Telemetry data object too large', maxBytes: MAX_DATA_BYTES });
    }
    const ts = typeof body.ts === 'string' ? body.ts.slice(0, 64) : new Date().toISOString();

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { error } = await supabase.from('client_telemetry').insert({
      user_id: userId,
      device_id: deviceId,
      session_id: sessionId,
      build: build || undefined,
      event_name: eventName,
      data,
      ts,
    });

    if (error) {
      console.error('[client-telemetry] insert failed:', error.message);
      return res.status(500).json({ error: 'Failed to store event' });
    }

    return res.status(204).end();
  } catch (e: unknown) {
    console.error('[client-telemetry] error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
