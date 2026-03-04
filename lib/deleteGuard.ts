/**
 * Deletion Contract — the single source of truth for all destructive operations.
 *
 * ─── The Rule ────────────────────────────────────────────────────────────────
 * The app MUST NOT delete or soft-delete any book or photo row unless:
 *   1. The reason is in ALLOWED_DELETE_REASONS
 *   2. userConfirmed === true
 *   3. A user gesture occurred within GESTURE_WINDOW_MS (default 15 s)
 *   4. An actionId ties the log entries end-to-end
 *
 * Any code path that cannot satisfy all four conditions must NOT delete data.
 * Sync, rehydrate, filter, orphan-cleanup, background poll — none of these
 * are permitted to write deleted_at or remove rows.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit } from '../lib/deleteGuard';
 *
 *   // 1. When the user taps "Delete":
 *   const intent = createDeleteIntent('user_delete_photo', 'PhotosScreen');
 *
 *   // 2. After the confirmation Alert fires:
 *   assertDeleteAllowed(intent);          // throws in dev if anything is wrong
 *
 *   // 3. Before the DB call:
 *   logDeleteAudit(intent, { photoId, bookCount, cascadeBooks });
 *
 *   // 4. Pass intent.actionId through to API and server logs so the action is traceable.
 *
 * ─── Allowed reasons ─────────────────────────────────────────────────────────
 * Every reason maps to a human-readable description used in audit logs.
 * Add new entries here only when a new explicit user action requires them.
 * Never add "sync", "cleanup", "orphan", "replace", "refresh" or similar.
 */

import { logger } from '../utils/logger';
import {
  saveLastDestructiveAction,
  clearLastDestructiveAction,
  UNDO_WINDOW_MS,
  type LastDestructiveAction,
} from './dataSafetyMark';
import { getApiBaseUrl } from './getEnvVar';
import { logMutationBlocked } from './dbAudit';

// ── Server-side audit persistence ─────────────────────────────────────────────
// Fire-and-forget: POST /api/audit-event so every delete has a permanent DB record.
// Requires a valid Bearer token; imported lazily to avoid circular deps.
let _cachedToken: string | null = null;

/** Register the current user's access token so audit events can be persisted. */
export function setAuditToken(token: string | null): void {
  _cachedToken = token;
}

async function persistAuditEvent(
  intent: DeleteIntent,
  payload: DeleteAuditPayload,
): Promise<void> {
  if (!_cachedToken) return;
  try {
    const url = `${getApiBaseUrl()}/api/audit-event`;
    const body = JSON.stringify({
      actionId:   intent.actionId,
      reason:     intent.reason,
      screen:     intent.screen,
      gestureAt:  intent.gestureAt,
      bookIds:    payload.bookIds,
      photoIds:   payload.photoIds,
      bookCount:  payload.bookCount,
      photoCount: payload.photoIds?.length,
      extra:      payload.extra,
    });
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_cachedToken}`,
      },
      body,
    });
  } catch (e: any) {
    // Non-fatal — client log is the fallback.
    logger.warn('[DELETE_AUDIT]', 'failed to persist audit event to server', { err: e?.message });
  }
}

// ── In-flight guards: prevent two clears, approve-during-clear, multiple full refreshes ──
let _clearInProgress = false;

/** True while a clear-library operation is running. Block approve and second clear. */
export function isClearInProgress(): boolean {
  return _clearInProgress;
}

export function setClearInProgress(value: boolean): void {
  _clearInProgress = value;
}

// ── Module-level in-memory last destructive action (for the current session) ──
// Updated synchronously on every logDeleteAudit call so that the merge guard in
// ScansTab can check it immediately (without an async AsyncStorage read).
// ScansTab loads the persisted value from AsyncStorage on boot and wires it into
// lastDestructiveActionRef so cross-session checks also work.

let _lastDestructiveAction: LastDestructiveAction | null = null;
let _lastDestructiveActionUserId: string | null = null;

/**
 * Returns the most recent destructive action for the given user, if any.
 * Used by ScansTab merge guard for in-session drop detection.
 */
export function getLastDestructiveAction(userId?: string): LastDestructiveAction | null {
  if (userId && _lastDestructiveActionUserId !== userId) return null;
  return _lastDestructiveAction;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** All permitted deletion reasons. Each maps to exactly one user gesture. */
export type DeleteReason =
  | 'user_delete_photo'         // User taps "Delete Photo" on a single photo
  | 'user_delete_photo_cascade' // User taps "Delete Photo + Books" — cascades to all books for that photo
  | 'user_delete_book'          // User deletes a single book from their library
  | 'user_delete_books_bulk'    // User selects multiple books and taps "Delete"
  | 'user_reject_pending'       // User taps "Delete" on a pending (not-yet-approved) scan result
  | 'user_delete_scan'          // User taps "Delete Scan" on a completed scan entry
  | 'user_clear_library'        // User taps "Clear Account Data / Delete Everything" in Settings
  | 'user_approve'              // User approved books (merge guard: allow server snapshot to win)
  | 'debug_reset';              // Dev/test only — blocked in production

/** Human-readable labels for audit logs and error messages. */
const REASON_LABELS: Record<DeleteReason, string> = {
  user_delete_photo:         'User deleted a single photo',
  user_delete_photo_cascade: 'User deleted a photo and all its books',
  user_delete_book:          'User removed a book from their library',
  user_delete_books_bulk:    'User bulk-deleted selected books',
  user_reject_pending:       'User rejected/deleted a pending scan result',
  user_delete_scan:          'User deleted a completed scan entry',
  user_clear_library:        'User cleared all library data (Settings)',
  user_approve:              'User approved books (authoritative for merge)',
  debug_reset:               '[DEV ONLY] Debug reset — not allowed in production',
};

/**
 * A delete intent represents one confirmed user delete gesture.
 * Create one per user action (not per row); pass it to assertDeleteAllowed + logDeleteAudit.
 */
export interface DeleteIntent {
  /** Canonical reason — must be in ALLOWED_DELETE_REASONS. */
  reason: DeleteReason;
  /** The screen/component the user was on (e.g. 'PhotosScreen', 'ScansTab'). */
  screen: string;
  /** Epoch ms when the user gesture occurred (e.g. when the Alert "confirm" button was tapped). */
  gestureAt: number;
  /**
   * True when the user has confirmed the action through an Alert, modal, or equivalent.
   * Set this ONLY inside an Alert `onPress` or modal confirm handler — never pre-set it.
   */
  userConfirmed: boolean;
  /**
   * Unique ID for this delete action. Attach to all API calls and log lines so you can
   * trace a single delete end-to-end across client + server logs.
   * Format: del_<timestamp>_<rand6>
   */
  actionId: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * How long after a gesture the intent is still considered valid.
 * If more than this time passes between the user tapping "Delete" and the actual
 * DB call, something is wrong (e.g. a background job re-ran the delete path).
 */
const GESTURE_WINDOW_MS = 15_000; // 15 seconds

/**
 * Maximum number of rows a single delete action may affect without being
 * explicitly flagged as a bulk operation.
 *
 * If rowCount > BULK_DELETE_ROW_LIMIT and the caller does NOT set
 * `isBulkConfirmed: true` on the payload, assertDeleteAllowed blocks the delete.
 * This prevents accidental mass-deletes (e.g. from background code accidentally
 * routing through a delete path that affects the whole library).
 *
 * The only exception is 'user_clear_library' — that reason always deletes the
 * entire library and is allowed regardless of rowCount (it goes through the
 * confirm-phrase modal which is a stronger gate).
 */
export const BULK_DELETE_ROW_LIMIT = 10;

/** Reasons allowed in production. debug_reset is stripped out. */
const PROD_ALLOWED_REASONS = new Set<DeleteReason>([
  'user_delete_photo',
  'user_delete_photo_cascade',
  'user_delete_book',
  'user_delete_books_bulk',
  'user_reject_pending',
  'user_delete_scan',
  'user_clear_library',
]);

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a delete intent.
 * Call this at the point the user gesture occurs (e.g. when the Alert appears),
 * NOT inside the confirm callback — so gestureAt accurately reflects when the
 * user initiated the action, not when they confirmed it.
 *
 * @param reason  Why the delete is happening
 * @param screen  Which screen/component triggered it
 */
export function createDeleteIntent(reason: DeleteReason, screen: string): DeleteIntent {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    reason,
    screen,
    gestureAt: Date.now(),
    userConfirmed: false, // Must be set to true inside the confirmation callback
    actionId: `del_${Date.now()}_${rand}`,
  };
}

// ── Guard ─────────────────────────────────────────────────────────────────────

/**
 * Assert that a delete intent is valid and safe to execute.
 *
 * Throws in __DEV__ if any invariant is violated. In production it logs
 * a structured error (visible in telemetry) and returns false so the caller
 * can abort gracefully without crashing the app.
 *
 * Call this immediately before the DB write, after the user has confirmed.
 *
 * @param intent   The delete intent (from createDeleteIntent).
 * @param payload  Optional payload — provide rowCount when known so the bulk-row
 *                 guard can check whether isBulkConfirmed is required.
 *
 * @returns true if the intent is valid; false if in production and invalid.
 * @throws  Error in __DEV__ if any check fails.
 */
export function assertDeleteAllowed(intent: DeleteIntent, payload?: Pick<DeleteAuditPayload, 'rowCount' | 'isBulkConfirmed'>): boolean {
  const failures: string[] = [];

  // 1. Reason must be in the allowed list.
  if (!PROD_ALLOWED_REASONS.has(intent.reason)) {
    failures.push(`reason "${intent.reason}" is not in PROD_ALLOWED_REASONS`);
  }

  // 2. debug_reset is never allowed in production.
  if (!__DEV__ && intent.reason === 'debug_reset') {
    failures.push('debug_reset is not allowed in production');
  }

  // 3. User must have explicitly confirmed.
  if (!intent.userConfirmed) {
    failures.push('userConfirmed is false — delete called without confirmation dialog');
  }

  // 4. The gesture must be recent (within GESTURE_WINDOW_MS).
  const age = Date.now() - intent.gestureAt;
  if (age > GESTURE_WINDOW_MS) {
    failures.push(`gesture is stale: ${age}ms ago (max ${GESTURE_WINDOW_MS}ms) — possible background re-run`);
  }

  // 5. Bulk-row guard: rowCount > BULK_DELETE_ROW_LIMIT requires isBulkConfirmed.
  //    Exempt: 'user_clear_library' always touches the whole library by design and
  //    goes through its own confirm-phrase modal (a stronger gate).
  const rowCount = payload?.rowCount ?? 0;
  if (
    rowCount > BULK_DELETE_ROW_LIMIT &&
    !payload?.isBulkConfirmed &&
    intent.reason !== 'user_clear_library'
  ) {
    logMutationBlocked({
      action: 'bulk_soft_delete',
      table: '(multiple)',
      entityType: 'book',
      count: rowCount,
      threshold: BULK_DELETE_ROW_LIMIT,
      sourceScreen: intent.screen,
      reason: 'isBulkConfirmed_not_set',
    });
    failures.push(
      `bulk delete blocked: rowCount=${rowCount} > BULK_DELETE_ROW_LIMIT=${BULK_DELETE_ROW_LIMIT}` +
      ` and isBulkConfirmed is not true — pass isBulkConfirmed:true after explicit user confirmation`
    );
  }

  if (failures.length === 0) return true;

  const msg =
    `[DELETE_GUARD] Delete blocked — ${failures.length} invariant(s) violated:\n` +
    failures.map((f, i) => `  ${i + 1}. ${f}`).join('\n') +
    `\n  intent: reason=${intent.reason} screen=${intent.screen} actionId=${intent.actionId}`;

  if (__DEV__) {
    throw new Error(msg);
  } else {
    logger.error('[DELETE_GUARD]', 'invariant violated — blocking delete', {
      failures,
      reason: intent.reason,
      screen: intent.screen,
      actionId: intent.actionId,
      gestureAgeMs: age,
      userConfirmed: intent.userConfirmed,
      rowCount,
    });
    return false;
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface DeleteAuditPayload {
  /** IDs of photo rows being deleted (if any). */
  photoIds?: string[];
  /** IDs of book rows being deleted (if any). */
  bookIds?: string[];
  /** Number of books affected (cascade or bulk). */
  bookCount?: number;
  /** Whether books are cascade-deleted (true) or just detached (false). */
  cascadeBooks?: boolean;
  /** Number of scan_job rows being deleted (if any). */
  scanJobCount?: number;
  /**
   * Total number of DB rows this delete will touch across all tables.
   * Required when rowCount > BULK_DELETE_ROW_LIMIT; assertDeleteAllowed will
   * block the delete if this is not accompanied by isBulkConfirmed: true.
   */
  rowCount?: number;
  /**
   * Must be true when rowCount > BULK_DELETE_ROW_LIMIT.
   * Set ONLY after an explicit user confirmation (confirm-phrase modal or equivalent).
   * Never pre-set this; it defeats the guard.
   */
  isBulkConfirmed?: boolean;
  /**
   * The authenticated userId — required to persist the record so the merge guard
   * can attribute a count drop to this action across restarts.
   */
  userId?: string;
  /** Any extra context the caller wants to attach for traceability. */
  extra?: Record<string, unknown>;
}

/**
 * Emit a single structured audit log for a confirmed delete action.
 *
 * Also persists the action to AsyncStorage (via dataSafetyMark) and updates the
 * in-memory module-level ref so the ScansTab merge guard can check it immediately.
 *
 * Always INFO level — these are high-signal events (one per user delete, not per row)
 * and should always be visible in production logs.
 *
 * Include intent.actionId in API request bodies so server logs can correlate.
 */
export function logDeleteAudit(intent: DeleteIntent, payload: DeleteAuditPayload = {}): void {
  const label = REASON_LABELS[intent.reason] ?? intent.reason;
  logger.info('[DELETE_AUDIT]', label, {
    actionId: intent.actionId,
    reason: intent.reason,
    screen: intent.screen,
    gestureAgeMs: Date.now() - intent.gestureAt,
    userConfirmed: intent.userConfirmed,
    ...payload,
  });

  // Persist and update in-memory last destructive action.
  const record: LastDestructiveAction = {
    actionId: intent.actionId,
    reason: intent.reason,
    at: Date.now(),
    bookCount: payload.bookCount ?? (payload.bookIds?.length ?? 0),
    photoCount: payload.photoIds?.length ?? 0,
    bookIds: payload.bookIds,
    photoIds: payload.photoIds,
  };
  _lastDestructiveAction = record;
  if (payload.userId) {
    _lastDestructiveActionUserId = payload.userId;
    saveLastDestructiveAction(payload.userId, record).catch(() => {});
  }

  // Persist to server audit log — fire-and-forget, never blocks the UI.
  persistAuditEvent(intent, payload).catch(() => {});
}

// ── Undo last delete ──────────────────────────────────────────────────────────

/**
 * Undo the last soft-delete for a user within the undo window.
 *
 * Lazily imports supabaseSync to avoid a circular dependency.  The caller must
 * trigger a library reload (loadUserData / rehydrate) after this resolves.
 *
 * @param userId  The authenticated user's UUID.
 * @returns  Structured result from supabaseSync.undoLastDelete, or an error if
 *           no recent action exists / the undo window has expired.
 */
export async function undoLastDeleteIfAllowed(userId: string): Promise<{
  ok: boolean;
  booksRestored: number;
  photosRestored: number;
  error?: string;
}> {
  const action = _lastDestructiveAction;
  if (!action) {
    return { ok: false, booksRestored: 0, photosRestored: 0, error: 'no_recent_action' };
  }
  const ageMs = Date.now() - action.at;
  if (ageMs > UNDO_WINDOW_MS) {
    return { ok: false, booksRestored: 0, photosRestored: 0, error: `undo_window_expired (${Math.round(ageMs / 1000)}s)` };
  }
  const { undoLastDelete } = await import('../services/supabaseSync');
  const result = await undoLastDelete(userId, action);
  if (result.ok) {
    // Clear in-memory + persisted records so undo can't be triggered twice.
    _lastDestructiveAction = null;
    clearLastDestructiveAction(userId).catch(() => {});
  }
  return result;
}

// ── Blocked-path log ──────────────────────────────────────────────────────────

/**
 * Call this when a non-user code path (sync, cleanup, rehydrate, etc.) encounters
 * logic that would delete data but correctly refuses. This proves the guard is
 * working and gives visibility if something unexpected routes through a delete path.
 */
export function logDeleteBlocked(params: {
  reason: string;
  screen?: string;
  photoId?: string;
  bookId?: string;
  context?: string;
}): void {
  logger.warn('[DELETE_BLOCKED]', 'non-user delete attempt refused', params);
}

// ── Legacy shims (backward compat with old deleteGuard.ts API) ────────────────

/**
 * @deprecated Use assertDeleteAllowed(intent) instead.
 * Kept so existing callers don't break during migration.
 */
export function assertUserDelete(reason: string, context?: string): void {
  if (reason === 'USER_ACTION' || reason === 'user_clear_library') return;
  const msg = `[DELETE_GUARD] Blocked non-user delete: reason=${reason}${context ? ` context=${context}` : ''}`;
  if (__DEV__) throw new Error(msg);
  else logger.warn('[DELETE_GUARD]', msg);
}

export interface DeleteIntentParams {
  screen: string;
  photoId: string;
  isCanonical: boolean;
  bookCount: number;
  cascadeBooks: boolean;
  imageHash?: string | null;
}

/**
 * @deprecated Use logDeleteAudit(intent, payload) instead.
 * Kept so existing callers don't break during migration.
 */
export function logDeleteIntent(params: DeleteIntentParams): void {
  const { screen, photoId, isCanonical, bookCount, cascadeBooks, imageHash } = params;
  const hashShort = imageHash ? imageHash.slice(0, 12) : null;
  logger.info('[DANGEROUS_DELETE]', `reason=USER_ACTION photoId=${photoId} canonical=${isCanonical} bookCount=${bookCount} screen=${screen}`, {
    screen, photoId, isCanonical, bookCount, cascadeBooks,
    ...(hashShort ? { imageHash: hashShort } : {}),
  });
  if (__DEV__) {
    logger.debug('[DANGEROUS_DELETE_STACK]', new Error('delete stack').stack ?? '(no stack)');
  }
}
