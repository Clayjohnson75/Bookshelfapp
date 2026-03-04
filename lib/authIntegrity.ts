/**
 * Auth integrity — structured security logs for auth events.
 *
 * Rules:
 *   • Log metadata only — NEVER tokens, secrets, or full user IDs.
 *   • userIdPrefix = first 8 chars of UUID.
 *   • expiresInSecBucket rounds expiry to nearest 300 s to prevent exact-exp fingerprinting.
 *   • All functions are synchronous / fire-and-forget; they must never throw.
 *
 * Log tags (all searchable in production telemetry):
 *   [AUTH_SESSION_INIT]     — app start, reports whether a valid session exists
 *   [AUTH_SESSION_REFRESH]  — Supabase TOKEN_REFRESHED event
 *   [AUTH_USER_MISMATCH]    — session userId differs from in-memory user state
 *   [AUTH_SIGNOUT]          — user signed out, with reason
 *   [ENV_BUILD_FINGERPRINT] — env + build metadata, warns if dev config in release build
 */

import Constants from 'expo-constants';
import logger from '../utils/logger';
import { SUPABASE_REF, SUPABASE_ENV } from './supabase';
import { getEnvVar, getApiBaseUrl } from './getEnvVar';
import { addAndMaybeFlushBreadcrumb, addSecurityBreadcrumb } from './securityBaseline';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rounds a seconds value to the nearest 300-second bucket (5 minutes). */
function expiryBucket(expiresAt: number | undefined): number | null {
  if (expiresAt == null) return null;
  const secsFromNow = expiresAt - Math.floor(Date.now() / 1000);
  if (secsFromNow < 0) return -1; // already expired
  return Math.round(secsFromNow / 300) * 300;
}

/** Safe first 8 chars of a UUID, or null. */
function uidPrefix(id: string | null | undefined): string | null {
  return typeof id === 'string' ? id.slice(0, 8) : null;
}

/** Returns true if the access token belongs to an anonymous/anon Supabase role. */
function isAnonToken(accessToken: string | null | undefined): boolean {
  if (!accessToken) return true;
  try {
    const payload = JSON.parse(
      atob(accessToken.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')
    );
    return payload?.role === 'anon';
  } catch {
    return false;
  }
}

// ── ENV_BUILD_FINGERPRINT ──────────────────────────────────────────────────────

let _buildFingerprintLogged = false;

/**
 * Log build / env metadata once per app launch.
 * WARN (not just info) if __DEV__ is false but env looks like dev — that means
 * a dev/staging Supabase project or API URL is wired into a release binary.
 */
export function logBuildFingerprint(): void {
  if (_buildFingerprintLogged) return;
  _buildFingerprintLogged = true;

  const appVersion = Constants.expoConfig?.version ?? Constants.manifest?.version ?? 'unknown';
  const nativeBuildNumber =
    (Constants.expoConfig?.ios?.buildNumber ??
     Constants.expoConfig?.android?.versionCode ??
     Constants.manifest?.ios?.buildNumber ??
     'unknown');
  const channel = __DEV__ ? 'dev' : 'release';
  const supabaseRefPrefix = typeof SUPABASE_REF === 'string' ? SUPABASE_REF.slice(0, 8) : '(unset)';
  const apiBaseUrl = getApiBaseUrl();
  const apiIsDevUrl = apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1') ||
    apiBaseUrl.includes('192.168.') || apiBaseUrl.includes('ngrok') ||
    apiBaseUrl.includes('.local') || apiBaseUrl.includes(':3000');

  const isReleaseBuild = !__DEV__;
  const envLooksLikeDev = SUPABASE_ENV === 'dev' || apiIsDevUrl;
  const mismatch = isReleaseBuild && envLooksLikeDev;

  const payload = {
    channel,
    supabaseEnv: SUPABASE_ENV,
    supabaseRefPrefix,
    appVersion,
    nativeBuildNumber,
    apiBaseUrlSuffix: apiBaseUrl.slice(-30), // last 30 chars, no secrets
    platform: typeof navigator !== 'undefined' ? 'web' : 'native',
    mismatch,
  };

  if (mismatch) {
    logger.warn('[ENV_BUILD_FINGERPRINT]', 'DEV config in release build — possible misconfiguration', payload);
    addAndMaybeFlushBreadcrumb('ENV_BUILD_FINGERPRINT', { ...payload, mismatch: true });
  } else {
    logger.info('[ENV_BUILD_FINGERPRINT]', payload);
    addSecurityBreadcrumb('ENV_BUILD_FINGERPRINT', { channel, supabaseEnv: payload.supabaseEnv, appVersion });
  }
}

// ── AUTH_SESSION_INIT ─────────────────────────────────────────────────────────

/**
 * Call once at app start after getSession() resolves.
 * Logs metadata about the session state — never the token.
 */
export function logAuthSessionInit(session: {
  access_token?: string;
  user?: { id?: string; app_metadata?: { provider?: string } };
  expires_at?: number;
} | null): void {
  const hasSession = !!session;
  const provider = session?.user?.app_metadata?.provider ?? null;
  const expiresInSecBucket = expiryBucket(session?.expires_at);
  const isAnon = isAnonToken(session?.access_token);

  const payload = {
    hasSession,
    userIdPrefix: uidPrefix(session?.user?.id),
    provider,
    expiresInSecBucket,
    isAnonToken: isAnon,
  };
  logger.info('[AUTH_SESSION_INIT]', payload);
  addSecurityBreadcrumb('AUTH_SESSION_INIT', { hasSession, provider, expiresInSecBucket });
}

// ── AUTH_SESSION_REFRESH ──────────────────────────────────────────────────────

/**
 * Call inside onAuthStateChange when event === 'TOKEN_REFRESHED'.
 */
export function logAuthSessionRefresh(params: {
  ok: boolean;
  reason?: string;
  latencyMs?: number;
  newExpiresAt?: number;
  userIdPrefix?: string | null;
}): void {
  const { ok, reason, latencyMs, newExpiresAt, userIdPrefix: uid } = params;
  const logFn = ok ? logger.info : logger.warn;
  logFn('[AUTH_SESSION_REFRESH]', {
    ok,
    reason: reason ?? (ok ? 'token_refreshed' : 'unknown'),
    latencyMs: latencyMs ?? null,
    expiresInSecBucket: expiryBucket(newExpiresAt),
    userIdPrefix: uid ?? null,
  });
  addSecurityBreadcrumb('AUTH_SESSION_REFRESH', { ok, latencyMs: latencyMs ?? null });
}

// ── AUTH_USER_MISMATCH ────────────────────────────────────────────────────────

/**
 * Call when the userId in the new session differs from the userId currently in
 * React state. This is a high-signal event — it can mean session swap, race, or bug.
 */
export function logAuthUserMismatch(params: {
  sessionUserId: string | null | undefined;
  stateUserId: string | null | undefined;
  event?: string;
}): void {
  const payload = {
    sessionUserIdPrefix: uidPrefix(params.sessionUserId),
    stateUserIdPrefix: uidPrefix(params.stateUserId),
    event: params.event ?? null,
    note: 'session userId differs from in-memory user state — possible race or session swap',
  };
  logger.warn('[AUTH_USER_MISMATCH]', payload);
  addAndMaybeFlushBreadcrumb('AUTH_USER_MISMATCH', payload);
}

// ── AUTH_SIGNOUT ──────────────────────────────────────────────────────────────

export type SignOutReason = 'user' | 'expired' | 'revoked' | 'error' | 'getSession_failed' | 'no_session_on_init';

/**
 * Call at every sign-out path, structured with the reason so you can
 * distinguish user-initiated vs forced logouts in production logs.
 */
export function logAuthSignout(params: {
  reason: SignOutReason;
  userIdPrefix?: string | null;
  errMessage?: string;
}): void {
  const logFn = params.reason === 'user' ? logger.info : logger.warn;
  const payload = {
    reason: params.reason,
    userIdPrefix: params.userIdPrefix ?? null,
    errMessage: params.errMessage ?? null,
  };
  logFn('[AUTH_SIGNOUT]', payload);
  addSecurityBreadcrumb('AUTH_SIGNOUT', { reason: params.reason });
}
