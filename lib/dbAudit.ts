/**
 * Database operation audit — structured security logs for DB interactions.
 *
 * Three log families:
 *
 *   [RLS_DENIED]              — Supabase returned 401/403 or a permission/RLS error code.
 *                               Proves RLS is protecting data; surfaces mis-permissions.
 *
 *   [MUTATION_INTENT]         — Emitted before a destructive DB write (delete, soft-delete,
 *                               bulk update). Records what is about to happen and who triggered it.
 *
 *   [MUTATION_EXECUTE]        — Emitted after the write completes (ok or error).
 *                               Pairs with MUTATION_INTENT via requestId.
 *
 *   [MUTATION_BLOCKED_GUARDRAIL] — Emitted when a write is blocked by a safety threshold
 *                               (e.g. rowCount > BULK_DELETE_ROW_LIMIT without explicit confirmation).
 *
 * Rules:
 *   • Log metadata only — no row content, no PII, no tokens.
 *   • userIdPrefix = first 8 chars of UUID only.
 *   • msgHash = fnv32a(error.message) so repeated errors are grouped without leaking messages.
 *   • requestId = caller-supplied or auto-generated; used to correlate intent ↔ execute.
 *
 * Usage:
 *   const rid = startMutation({ action:'soft_delete', table:'books', entityType:'book',
 *                               count:3, sourceScreen:'ScansTab', userIdPrefix:'abc12345' });
 *   const { data, error } = await supabase.from('books').update(...);
 *   endMutation(rid, { ok:!error, count: data?.length ?? 0, error });
 *
 * RLS interception is wired into lib/supabase.ts fetch layer and into shared API helpers.
 */

import logger from '../utils/logger';
import { addAndMaybeFlushBreadcrumb } from './securityBaseline';

// ── Tiny non-crypto hash for error messages ───────────────────────────────────
function fnv32a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ── RLS / permission error detection ─────────────────────────────────────────

/** Postgres error codes and HTTP statuses that indicate a permission/RLS denial. */
const RLS_ERROR_CODES = new Set(['42501', 'PGRST301', 'PGRST116', '401', '403']);
const RLS_MESSAGE_PATTERNS = [
  /permission denied/i,
  /row.level security/i,
  /new row violates row-level security/i,
  /insufficient_privilege/i,
  /not authorized/i,
  /violates row-level/i,
];

export interface RlsContext {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc' | string;
  userIdPrefix?: string | null;
  /** Optional caller tag for grep (e.g. 'saveBookToSupabase', 'ScansTab.approve'). */
  caller?: string;
}

/**
 * Check a Supabase error object for RLS / permission signals.
 * If detected, emits [RLS_DENIED] and returns true. Otherwise returns false.
 *
 * Safe to call with null/undefined — returns false immediately.
 */
export function checkRlsDenied(
  error: { message?: string; code?: string; status?: number; details?: string } | null | undefined,
  ctx: RlsContext,
): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const status = error.status ?? 0;
  const msg = error.message ?? '';

  const isDenied =
    RLS_ERROR_CODES.has(code) ||
    RLS_ERROR_CODES.has(String(status)) ||
    RLS_MESSAGE_PATTERNS.some(p => p.test(msg)) ||
    RLS_MESSAGE_PATTERNS.some(p => p.test(error.details ?? ''));

  if (isDenied) {
    const payload = {
      table: ctx.table,
      action: ctx.action,
      userIdPrefix: ctx.userIdPrefix ?? null,
      caller: ctx.caller ?? null,
      code: code || null,
      status: status || null,
      msgHash: fnv32a(msg),
      // Include a short prefix of the message in dev only — prod never logs raw DB errors.
      msgPreview: __DEV__ ? msg.slice(0, 80) : undefined,
    };
    logger.warn('[RLS_DENIED]', payload);
    addAndMaybeFlushBreadcrumb('RLS_DENIED', { table: ctx.table, action: ctx.action, code: code || null });
  }
  return isDenied;
}

// ── HTTP-level RLS detection (for fetch interceptor in lib/supabase.ts) ───────

/**
 * Inspect a fetch Response for 401/403 from the Supabase REST layer.
 * Call this from the global fetch wrapper in lib/supabase.ts after every /rest/v1/ call.
 * Does NOT clone or consume the body — only checks status + URL.
 */
export function checkHttpRlsDenied(
  status: number,
  url: string,
  method: string,
): void {
  if (status !== 401 && status !== 403) return;

  // Extract table name from the path: /rest/v1/<table>?...
  let table = '(unknown)';
  try {
    const m = url.match(/\/rest\/v1\/([^?#]+)/);
    if (m) table = m[1].split('?')[0];
  } catch (_) {}

  const action = httpMethodToAction(method);
  logger.warn('[RLS_DENIED]', {
    table,
    action,
    userIdPrefix: null, // not available at fetch level — enriched by caller if needed
    caller: 'fetch_interceptor',
    code: String(status),
    status,
    msgHash: fnv32a(`http_${status}_${table}`),
  });
  addAndMaybeFlushBreadcrumb('RLS_DENIED', { table, action, code: String(status), caller: 'fetch_interceptor' });
}

function httpMethodToAction(method: string): string {
  switch ((method ?? '').toUpperCase()) {
    case 'GET':    return 'select';
    case 'POST':   return 'insert';
    case 'PATCH':  return 'update';
    case 'PUT':    return 'upsert';
    case 'DELETE': return 'delete';
    default:       return method.toLowerCase();
  }
}

// ── MUTATION_INTENT / MUTATION_EXECUTE ────────────────────────────────────────

export type MutationAction =
  | 'soft_delete'
  | 'hard_delete'
  | 'bulk_soft_delete'
  | 'bulk_update'
  | 'upsert'
  | 'insert'
  | 'rpc'
  | string;

export interface MutationIntentParams {
  action: MutationAction;
  table: string;
  entityType: 'book' | 'photo' | 'scan_job' | 'folder' | 'profile_photo' | 'user_stats' | string;
  count: number;
  sourceScreen: string;
  userIdPrefix?: string | null;
  /** Caller-supplied ID to correlate intent ↔ execute (auto-generated if omitted). */
  requestId?: string;
  /** Any extra context (filter shape, key sample, etc.). Avoid PII. */
  extra?: Record<string, unknown>;
}

interface ActiveMutation {
  requestId: string;
  startedAt: number;
  params: MutationIntentParams;
}

const _activeMutations = new Map<string, ActiveMutation>();

/**
 * Log MUTATION_INTENT and register the mutation so endMutation can pair it.
 * Returns a requestId to pass to endMutation().
 */
export function startMutation(params: MutationIntentParams): string {
  const requestId = params.requestId ?? `mut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  _activeMutations.set(requestId, { requestId, startedAt: Date.now(), params });
  logger.info('[MUTATION_INTENT]', {
    requestId,
    action: params.action,
    table: params.table,
    entityType: params.entityType,
    count: params.count,
    sourceScreen: params.sourceScreen,
    userIdPrefix: params.userIdPrefix ?? null,
    extra: params.extra ?? undefined,
  });
  return requestId;
}

export interface MutationResultParams {
  ok: boolean;
  /** Actual number of rows affected (if known from DB response). */
  affectedCount?: number;
  error?: { message?: string; code?: string } | null;
  /** Extra context for the result log. Avoid PII. */
  extra?: Record<string, unknown>;
}

/**
 * Log MUTATION_EXECUTE to close out a startMutation() call.
 * Also calls checkRlsDenied so any permission error is surfaced.
 */
export function endMutation(requestId: string, result: MutationResultParams): void {
  const active = _activeMutations.get(requestId);
  _activeMutations.delete(requestId);

  const latencyMs = active ? Date.now() - active.startedAt : null;
  const params = active?.params;
  const logFn = result.ok ? logger.info : logger.warn;

  logFn('[MUTATION_EXECUTE]', {
    requestId,
    action: params?.action ?? '(unknown)',
    table: params?.table ?? '(unknown)',
    entityType: params?.entityType ?? '(unknown)',
    intendedCount: params?.count ?? null,
    affectedCount: result.affectedCount ?? null,
    ok: result.ok,
    latencyMs,
    errCode: result.error?.code ?? null,
    errMsgHash: result.error?.message ? fnv32a(result.error.message) : null,
    extra: result.extra ?? undefined,
  });

  if (!result.ok && result.error) {
    checkRlsDenied(result.error, {
      table: params?.table ?? '(unknown)',
      action: params?.action ?? '(unknown)',
      userIdPrefix: params?.userIdPrefix ?? null,
      caller: params?.sourceScreen,
    });
  }
}

// ── MUTATION_BLOCKED_GUARDRAIL ─────────────────────────────────────────────────

export interface MutationBlockedParams {
  action: MutationAction;
  table: string;
  entityType: string;
  count: number;
  threshold: number;
  sourceScreen: string;
  userIdPrefix?: string | null;
  reason?: string;
}

/**
 * Log MUTATION_BLOCKED_GUARDRAIL when a write is prevented by a safety threshold.
 * Call this instead of (or in addition to) throwing/returning false.
 */
export function logMutationBlocked(params: MutationBlockedParams): void {
  logger.warn('[MUTATION_BLOCKED_GUARDRAIL]', {
    action: params.action,
    table: params.table,
    entityType: params.entityType,
    count: params.count,
    threshold: params.threshold,
    sourceScreen: params.sourceScreen,
    userIdPrefix: params.userIdPrefix ?? null,
    reason: params.reason ?? 'count_exceeded_threshold',
  });
  addAndMaybeFlushBreadcrumb('MUTATION_BLOCKED_GUARDRAIL', {
    action: params.action,
    table: params.table,
    count: params.count,
    threshold: params.threshold,
    sourceScreen: params.sourceScreen,
  });
}
