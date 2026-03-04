/**
 * Security baseline telemetry — items 4–7.
 *
 * Covers:
 *   4. Storage URL / path safety
 *      STORAGE_URL_MODE      — how a URL was obtained (signed vs public)
 *      STORAGE_PUBLIC_URL_DETECTED (warn) — permanent public URL for private-bucket data
 *
 *   5. Network + TLS sanity
 *      NETWORK_SECURITY_BASELINE — logged once per session at app start
 *      NETWORK_NON_HTTPS_BLOCKED  — any URL that would have been sent over plain HTTP
 *
 *   6. Abuse / anomaly detection
 *      ANOMALY_TOO_MANY_REQUESTS  — endpoint group exceeds N req/min
 *      ANOMALY_TOO_MANY_SCANS     — scans exceed threshold within a window
 *      ANOMALY_REPEATED_FAILURES  — same operation fails N times consecutively
 *
 *   7. Security-relevant breadcrumbs via clientTelemetry
 *      addSecurityBreadcrumb()    — fire-and-forget breadcrumb for post-mortems
 *      flushSecurityBreadcrumbs() — send queued breadcrumbs (e.g. on error boundary)
 *
 * Guardrails:
 *   • Never log JWTs, refresh tokens, or full access tokens.
 *   • Never log email addresses or full user IDs (prefix only).
 *   • Never log raw SQL or full DB error payloads.
 *   • Book titles are not logged (may be private reading data).
 *   • All rate-limit / anomaly counters are in-memory only (reset on app restart).
 */

import logger from '../utils/logger';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rounds seconds to nearest 300-second (5-min) bucket. */
function secBucket(secs: number): number {
  return Math.round(secs / 300) * 300;
}

// ── 4. Storage URL / path safety ─────────────────────────────────────────────

/** Known private buckets — should never have permanent public URLs generated for them. */
const PRIVATE_BUCKETS = new Set(['photos']);
/** Known public buckets — permanent public URLs are expected and fine. */
const PUBLIC_BUCKETS = new Set(['book-covers', 'avatars', 'covers']);

export type StorageUrlMode = 'signed' | 'public' | 'local' | 'legacy_http';

export interface StorageUrlModeParams {
  bucket: string;
  mode: StorageUrlMode;
  /** Signed URL TTL in seconds (only for mode='signed'). */
  expiresInSec?: number;
  /** Optional caller tag for grep. */
  caller?: string;
}

/**
 * Log how a storage URL was obtained.
 * Call once per distinct (bucket, mode) combination per session — rate-limited internally.
 *
 * Also emits STORAGE_PUBLIC_URL_DETECTED (warn) when a permanent public URL is used
 * for a private bucket, which is a security misconfiguration.
 */
export function logStorageUrlMode(params: StorageUrlModeParams): void {
  const { bucket, mode, expiresInSec, caller } = params;
  const isPrivateBucket = PRIVATE_BUCKETS.has(bucket);
  const isPublicUrl = mode === 'public';

  // Warn loudly if private bucket gets a public URL.
  if (isPrivateBucket && isPublicUrl) {
    logger.warn('[STORAGE_PUBLIC_URL_DETECTED]', {
      bucket,
      mode,
      caller: caller ?? null,
      severity: 'high',
      note: 'Private bucket data exposed via permanent public URL — should use signed URL',
    });
    addSecurityBreadcrumb('STORAGE_PUBLIC_URL_DETECTED', { bucket, caller });
    return;
  }

  const key = `storage_url_mode:${bucket}:${mode}`;
  logger.logOnce(key, 'info', '[STORAGE_URL_MODE]', 'storage URL mode', {
    bucket,
    mode,
    isPrivateBucket,
    expiresInSecBucket: expiresInSec != null ? secBucket(expiresInSec) : null,
    caller: caller ?? null,
  });
}

/**
 * Validate a storage URL before using it for display.
 * Warns if a private-bucket storage path is resolved to a public URL pattern.
 *
 * @param url    The resolved URL (signed, public, or file://).
 * @param bucket Which bucket this URL belongs to.
 * @param caller Caller tag for traceability.
 */
export function validateStorageUrl(url: string, bucket: string, caller?: string): void {
  if (!url || typeof url !== 'string') return;

  const isPublicPattern =
    url.includes('/storage/v1/object/public/') ||
    url.includes('/storage/v1/render/image/public/');

  if (PRIVATE_BUCKETS.has(bucket) && isPublicPattern) {
    logger.warn('[STORAGE_PUBLIC_URL_DETECTED]', {
      bucket,
      caller: caller ?? null,
      urlSuffix: url.slice(-40), // last 40 chars only — avoids leaking signed token
      note: 'Public URL pattern detected for private bucket',
    });
    addSecurityBreadcrumb('STORAGE_PUBLIC_URL_DETECTED', { bucket, caller, urlSuffix: url.slice(-40) });
  }
}

// ── 5. Network + TLS sanity ───────────────────────────────────────────────────

let _networkBaselineLogged = false;

/**
 * Log NETWORK_SECURITY_BASELINE once per session.
 * Call at app start (e.g. from AppWrapper or AuthProvider mount).
 */
export function logNetworkSecurityBaseline(): void {
  if (_networkBaselineLogged) return;
  _networkBaselineLogged = true;

  // iOS App Transport Security enforces HTTPS by default; can be disabled in Info.plist.
  // React Native expo-managed workflow sets NSAllowsArbitraryLoads=false by default.
  // We log what we can determine statically — runtime ATS override detection isn't possible
  // in JS, but the build fingerprint (logBuildFingerprint) confirms the env config.
  const platform = Platform.OS;
  const appVersion = Constants.expoConfig?.version ?? Constants.manifest?.version ?? 'unknown';

  logger.info('[NETWORK_SECURITY_BASELINE]', {
    usesHttpsOnly: true,         // getApiBaseUrl() enforces HTTPS (falls back to prod URL)
    pinnedCerts: false,          // No cert pinning implemented; standard TLS only
    atsEnabled: platform === 'ios',  // ATS is enforced on iOS by default in Expo managed workflow
    platform,
    appVersion,
    note: 'All API calls route through getApiBaseUrl() which rejects non-HTTPS and dev URLs',
  });
}

/**
 * Log NETWORK_NON_HTTPS_BLOCKED when a non-HTTPS URL is intercepted / rejected.
 * Call from getApiBaseUrl() or any fetch wrapper that enforces HTTPS.
 *
 * @param url  The raw URL that was rejected. Only hostname is logged — never the full path.
 */
export function logNonHttpsBlocked(url: string): void {
  let urlHost = '(unknown)';
  try {
    // Extract host only — path/query may contain auth tokens or user data.
    const u = new URL(url.startsWith('http') ? url : `http://${url}`);
    urlHost = u.host;
  } catch (_) {
    urlHost = url.slice(0, 30); // fallback: first 30 chars
  }
  logger.warn('[NETWORK_NON_HTTPS_BLOCKED]', { urlHost });
  addSecurityBreadcrumb('NETWORK_NON_HTTPS_BLOCKED', { urlHost });
}

// ── 6. Abuse / anomaly detection ─────────────────────────────────────────────

// Request rate tracking: Map<endpointGroup, [timestamps]>
const _requestTimes = new Map<string, number[]>();

/**
 * Track a request to `endpointGroup` and emit ANOMALY_TOO_MANY_REQUESTS if
 * the count in the last 60 seconds exceeds `threshold`.
 *
 * Call from scan submission, cover fetch, or any high-frequency API call site.
 *
 * @param endpointGroup  Logical group label (e.g. 'scan', 'cover_fetch', 'auth').
 * @param threshold      Max allowed requests per minute (default 30).
 */
export function trackRequest(endpointGroup: string, threshold = 30): void {
  const now = Date.now();
  const window = 60_000; // 1 minute
  const times = (_requestTimes.get(endpointGroup) ?? []).filter(t => now - t < window);
  times.push(now);
  _requestTimes.set(endpointGroup, times);

  if (times.length > threshold) {
    // Rate-limited: emit at most once every 30 seconds per group to avoid log spam.
    logger.rateLimit(
      `anomaly_too_many_requests:${endpointGroup}`,
      30_000,
      'warn',
      '[ANOMALY_TOO_MANY_REQUESTS]',
      {
        endpointGroup,
        countPerMin: times.length,
        threshold,
      },
    );
    addSecurityBreadcrumb('ANOMALY_TOO_MANY_REQUESTS', { endpointGroup, countPerMin: times.length });
  }
}

// Scan rate tracking: timestamps of scan submissions within the current window.
let _scanTimestamps: number[] = [];

/**
 * Record a scan submission and emit ANOMALY_TOO_MANY_SCANS if the count
 * within `windowSec` exceeds `threshold`.
 *
 * @param windowSec  Rolling window in seconds (default 300 = 5 minutes).
 * @param threshold  Max allowed scans in that window (default 10).
 */
export function trackScan(windowSec = 300, threshold = 10): void {
  const now = Date.now();
  _scanTimestamps = _scanTimestamps.filter(t => now - t < windowSec * 1000);
  _scanTimestamps.push(now);

  if (_scanTimestamps.length > threshold) {
    logger.rateLimit(
      'anomaly_too_many_scans',
      60_000, // suppress repeat log for 60 s
      'warn',
      '[ANOMALY_TOO_MANY_SCANS]',
      {
        scansInWindow: _scanTimestamps.length,
        windowSec,
        threshold,
      },
    );
    addSecurityBreadcrumb('ANOMALY_TOO_MANY_SCANS', { scansInWindow: _scanTimestamps.length, windowSec });
  }
}

// Consecutive-failure tracking: Map<op, { count, lastCode }>
const _failCounters = new Map<string, { count: number; lastCode: string | null }>();

/**
 * Record a failure for `op` and emit ANOMALY_REPEATED_FAILURES when `threshold`
 * consecutive failures are reached.
 *
 * Call on any repeatable operation (scan submit, auth, cover fetch, etc.).
 * Call resetFailures(op) on the next success to reset the counter.
 *
 * @param op         Operation name (e.g. 'scan_submit', 'auth_signin', 'cover_fetch').
 * @param code       Error code or HTTP status (string). Never the full error message.
 * @param threshold  Number of consecutive failures before the anomaly fires (default 3).
 */
export function recordFailure(op: string, code: string | null, threshold = 3): void {
  const prev = _failCounters.get(op) ?? { count: 0, lastCode: null };
  const next = { count: prev.count + 1, lastCode: code };
  _failCounters.set(op, next);

  if (next.count >= threshold) {
    logger.rateLimit(
      `anomaly_repeated_failures:${op}`,
      30_000,
      'warn',
      '[ANOMALY_REPEATED_FAILURES]',
      {
        op,
        consecutiveFails: next.count,
        lastCode: next.lastCode,
        threshold,
      },
    );
    addSecurityBreadcrumb('ANOMALY_REPEATED_FAILURES', { op, consecutiveFails: next.count, lastCode: code });
  }
}

/** Reset the consecutive-failure counter for `op` (call on success). */
export function resetFailures(op: string): void {
  _failCounters.delete(op);
}

// ── 7. Security breadcrumbs via clientTelemetry ───────────────────────────────

// Tags that are security-relevant and should be preserved in telemetry for post-mortems.
// These do NOT need to go through the 1-event/sec throttle — they fire rarely and are critical.
export const SECURITY_BREADCRUMB_TAGS = new Set([
  'AUTH_SESSION_INIT',
  'AUTH_SESSION_REFRESH',
  'AUTH_USER_MISMATCH',
  'AUTH_SIGNOUT',
  'RLS_DENIED',
  'MUTATION_INTENT',
  'MUTATION_EXECUTE',
  'MUTATION_BLOCKED_GUARDRAIL',
  'STORAGE_PUBLIC_URL_DETECTED',
  'NETWORK_NON_HTTPS_BLOCKED',
  'ANOMALY_TOO_MANY_REQUESTS',
  'ANOMALY_TOO_MANY_SCANS',
  'ANOMALY_REPEATED_FAILURES',
  'ENV_BUILD_FINGERPRINT',
  'DELETE_AUDIT',
]);

// In-memory ring buffer: last 50 security breadcrumbs.
// Flushed to telemetry on demand (e.g. when a crash/error is detected) or periodically.
interface Breadcrumb {
  tag: string;
  data: Record<string, unknown>;
  at: number; // epoch ms
}
const _breadcrumbs: Breadcrumb[] = [];
const BREADCRUMB_RING_SIZE = 50;

/**
 * Add a security-relevant breadcrumb to the in-memory ring.
 * Call from any security log emitter (auth, RLS, mutation, storage, network, anomaly).
 *
 * Does NOT send to telemetry immediately — use flushSecurityBreadcrumbs() for that.
 * The ring ensures the last N events are available for post-mortem even without flush.
 */
export function addSecurityBreadcrumb(
  tag: string,
  data: Record<string, unknown> = {},
): void {
  _breadcrumbs.push({ tag, data, at: Date.now() });
  if (_breadcrumbs.length > BREADCRUMB_RING_SIZE) _breadcrumbs.shift();
}

/**
 * Flush queued security breadcrumbs to clientTelemetry (fire-and-forget).
 * Safe to call at any time. Call:
 *   • When a critical error is detected (e.g. RLS_DENIED, AUTH_USER_MISMATCH).
 *   • On app foreground (background state change → active).
 *   • From an error boundary if you add one later.
 *
 * Telemetry import is lazy to avoid circular deps.
 */
export async function flushSecurityBreadcrumbs(
  opts: { userId?: string | null } = {},
): Promise<void> {
  if (_breadcrumbs.length === 0) return;
  const snapshot = _breadcrumbs.slice(); // copy ring at flush time
  try {
    const { sendTelemetry } = await import('./clientTelemetry');
    await sendTelemetry(
      'SECURITY_BREADCRUMBS',
      {
        count: snapshot.length,
        breadcrumbs: snapshot,
      },
      { userId: opts.userId ?? null },
    );
  } catch (_) {
    // Non-fatal — breadcrumbs are best-effort, never block the UI.
  }
}

// ── Automatic flush on high-severity events ───────────────────────────────────

/**
 * Add a breadcrumb AND immediately flush if the tag is high-severity.
 * High-severity: RLS_DENIED, AUTH_USER_MISMATCH, STORAGE_PUBLIC_URL_DETECTED,
 * MUTATION_BLOCKED_GUARDRAIL, ANOMALY_*.
 *
 * This is the recommended call site for security log emitters.
 */
const HIGH_SEVERITY_FLUSH_TAGS = new Set([
  'RLS_DENIED',
  'AUTH_USER_MISMATCH',
  'STORAGE_PUBLIC_URL_DETECTED',
  'MUTATION_BLOCKED_GUARDRAIL',
  'ANOMALY_TOO_MANY_REQUESTS',
  'ANOMALY_TOO_MANY_SCANS',
  'ANOMALY_REPEATED_FAILURES',
]);

export function addAndMaybeFlushBreadcrumb(
  tag: string,
  data: Record<string, unknown> = {},
  opts: { userId?: string | null } = {},
): void {
  addSecurityBreadcrumb(tag, data);
  if (HIGH_SEVERITY_FLUSH_TAGS.has(tag)) {
    flushSecurityBreadcrumbs(opts).catch(() => {});
  }
}
