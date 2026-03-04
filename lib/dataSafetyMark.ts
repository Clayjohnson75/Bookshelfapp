/**
 * Data-safety persistence: high-water marks + last destructive action.
 *
 * ─── What this solves ─────────────────────────────────────────────────────────
 * After a cold start (app killed + reopened) all in-memory refs reset to 0.
 * If the first rehydrate snapshot returns fewer items than the user actually
 * has (RLS glitch, network error, session gap), the merge guard can't detect
 * the drop because highWaterRef == 0.
 *
 * This module persists the last known good counts so the guard survives restarts.
 *
 * ─── High-water marks ─────────────────────────────────────────────────────────
 * highWaterApproved / highWaterPhotos — updated after EVERY trusted snapshot
 * commit (rehydrate_merge + post-approve).  Read on boot so refs start at the
 * real last-known value instead of 0.
 *
 * ─── Last destructive action ──────────────────────────────────────────────────
 * Persisted by logDeleteAudit() in deleteGuard.ts immediately after a confirmed
 * user delete.  The merge guard reads this to decide whether a drop is
 * intentional: if server returns N < highWater AND no destructive action fired
 * in the last RECENT_DESTRUCTIVE_MS milliseconds → potential data loss → WARN.
 *
 * ─── Undo window ──────────────────────────────────────────────────────────────
 * Deletes are "soft" (deleted_at set, rows not removed).  The last destructive
 * action record stores which bookIds / photoIds were affected so undoLastDelete()
 * can clear deleted_at for those rows within UNDO_WINDOW_MS.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { highWaterKey, lastDestructiveActionKey, safetyEpochKey } from './cacheKeys';
import { logger } from '../utils/logger';
import { uuidv4 } from './scanId';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * If a destructive action was confirmed within this window we consider the drop
 * intentional and suppress the data-loss warning.
 * 10 minutes — enough to cover approve → refresh → glitch cycles.
 */
export const RECENT_DESTRUCTIVE_MS = 10 * 60 * 1000; // 10 min

/**
 * Short window during which "authoritative" user actions (clear library, reject pending, approve)
 * allow the server snapshot to win over local safety guards. Stops ghost data from sticking.
 */
export const AUTHORITATIVE_DESTRUCTIVE_MS = 30 * 1000; // 30 seconds

/** Reasons that are authoritative for merge: allow server to overwrite local for AUTHORITATIVE_DESTRUCTIVE_MS. */
export const AUTHORITATIVE_DESTRUCTIVE_REASONS = ['user_clear_library', 'user_reject_pending', 'user_approve'] as const;

/** Soft-delete undo is allowed within this window after the action. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000; // 10 min

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HighWaterMark {
  approved: number;
  photos: number;
  /** epoch ms when this mark was last written */
  updatedAt: number;
}

export interface LastDestructiveAction {
  actionId: string;
  reason: string;
  /** epoch ms of the user gesture */
  at: number;
  /** How many books were affected (for undo and for the warn threshold) */
  bookCount: number;
  /** How many photos were affected */
  photoCount: number;
  /**
   * IDs of soft-deleted book rows (for undo).
   * Optional — only populated when the caller passes bookIds to logDeleteAudit.
   */
  bookIds?: string[];
  /**
   * IDs of soft-deleted photo rows (for undo).
   */
  photoIds?: string[];
}

// ── High-water mark ───────────────────────────────────────────────────────────

/**
 * Persist the current high-water marks.
 * Called after every trusted snapshot commit in ScansTab.
 * Errors are swallowed — this is a best-effort hint, not critical data.
 */
export async function saveHighWaterMark(
  userId: string,
  mark: Pick<HighWaterMark, 'approved' | 'photos'>,
): Promise<void> {
  try {
    const value: HighWaterMark = { ...mark, updatedAt: Date.now() };
    await AsyncStorage.setItem(highWaterKey(userId), JSON.stringify(value));
  } catch (e) {
    logger.debug('[HIGH_WATER]', 'save failed (non-fatal)', { error: (e as any)?.message });
  }
}

/**
 * Load the persisted high-water marks for a user.
 * Called once at boot (after auth resolves) to prime in-memory refs.
 * Returns null if nothing is stored yet (fresh install or first login).
 */
export async function loadHighWaterMark(userId: string): Promise<HighWaterMark | null> {
  try {
    const raw = await AsyncStorage.getItem(highWaterKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HighWaterMark>;
    if (typeof parsed.approved !== 'number' || typeof parsed.photos !== 'number') return null;
    return {
      approved: parsed.approved,
      photos: parsed.photos,
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/** Reset high-water marks for a user (called on sign-out / account clear). */
export async function clearHighWaterMark(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(highWaterKey(userId));
  } catch { /* non-fatal */ }
}

// ── Safety epoch (cache reset detection) ────────────────────────────────────────

/**
 * Load the current safety epoch for the user.
 * When missing or after a cache clear we set a new epoch so the next server snapshot is accepted.
 */
export async function getSafetyEpoch(userId: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(safetyEpochKey(userId));
    return raw && raw.length > 20 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Store the safety epoch (UUID). Used when creating a fresh epoch or after cache clear.
 */
export async function setSafetyEpoch(userId: string, epoch: string): Promise<void> {
  try {
    await AsyncStorage.setItem(safetyEpochKey(userId), epoch);
  } catch (e) {
    logger.debug('[SAFETY_EPOCH]', 'set failed (non-fatal)', { error: (e as any)?.message });
  }
}

/**
 * Reset all safety baselines so the next server snapshot is accepted as authoritative.
 * Call when the user clears cache / data (e.g. "Clear account" in Settings).
 * Clears high-water marks and last destructive action, then sets a new epoch.
 */
export async function resetSafetyBaselines(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(highWaterKey(userId));
    await AsyncStorage.removeItem(lastDestructiveActionKey(userId));
    await setSafetyEpoch(userId, uuidv4());
    const postEpoch = await getSafetyEpoch(userId);
    const postMark = await loadHighWaterMark(userId);
    logger.info('[RESET_BASELINES]', 'post-reset values (should be epoch set, high-water null)', {
      cacheEpoch: postEpoch?.slice(0, 8) ?? null,
      highWaterApproved: postMark?.approved ?? null,
      highWaterPhotos: postMark?.photos ?? null,
      userIdPrefix: userId.slice(0, 8),
    });
  } catch (e) {
    logger.debug('[SAFETY_EPOCH]', 'reset failed (non-fatal)', { error: (e as any)?.message });
  }
}

// ── Last destructive action ───────────────────────────────────────────────────

/**
 * Persist the last confirmed destructive action.
 * Called by logDeleteAudit() immediately before the DB write.
 */
export async function saveLastDestructiveAction(
  userId: string,
  action: LastDestructiveAction,
): Promise<void> {
  try {
    await AsyncStorage.setItem(lastDestructiveActionKey(userId), JSON.stringify(action));
  } catch (e) {
    logger.debug('[LAST_DESTRUCTIVE_ACTION]', 'save failed (non-fatal)', { error: (e as any)?.message });
  }
}

/**
 * Load the last destructive action record for a user.
 * Used by the merge guard to decide whether a recent count drop was intentional.
 */
export async function loadLastDestructiveAction(
  userId: string,
): Promise<LastDestructiveAction | null> {
  try {
    const raw = await AsyncStorage.getItem(lastDestructiveActionKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastDestructiveAction>;
    if (!parsed.actionId || typeof parsed.at !== 'number') return null;
    return {
      actionId: parsed.actionId,
      reason: parsed.reason ?? 'unknown',
      at: parsed.at,
      bookCount: parsed.bookCount ?? 0,
      photoCount: parsed.photoCount ?? 0,
      bookIds: Array.isArray(parsed.bookIds) ? parsed.bookIds : undefined,
      photoIds: Array.isArray(parsed.photoIds) ? parsed.photoIds : undefined,
    };
  } catch {
    return null;
  }
}

/** Clear the last destructive action record (called on sign-out). */
export async function clearLastDestructiveAction(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(lastDestructiveActionKey(userId));
  } catch { /* non-fatal */ }
}

// ── Undo last delete ──────────────────────────────────────────────────────────

export interface UndoDeleteResult {
  ok: boolean;
  restoredBooks: number;
  restoredPhotos: number;
  error?: string;
}

/**
 * Undo the last soft-delete action by calling the /api/undo-delete endpoint.
 *
 * Only works within UNDO_WINDOW_MS of the delete. Rows restored: books and/or
 * photos from the LastDestructiveAction record.
 *
 * @param apiBaseUrl  Base URL for the Vercel API (e.g. "https://www.bookshelfscan.app")
 * @param accessToken Supabase session access_token
 * @param action      The LastDestructiveAction to undo
 */
export async function undoLastDelete(
  apiBaseUrl: string,
  accessToken: string,
  action: LastDestructiveAction,
): Promise<UndoDeleteResult> {
  const now = Date.now();
  if (now - action.at > UNDO_WINDOW_MS) {
    return { ok: false, restoredBooks: 0, restoredPhotos: 0, error: 'undo_window_expired' };
  }
  if ((!action.bookIds || action.bookIds.length === 0) && (!action.photoIds || action.photoIds.length === 0)) {
    return { ok: false, restoredBooks: 0, restoredPhotos: 0, error: 'no_ids_to_restore' };
  }
  try {
    const base = apiBaseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/api/undo-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        actionId: action.actionId,
        bookIds: action.bookIds ?? [],
        photoIds: action.photoIds ?? [],
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, restoredBooks: 0, restoredPhotos: 0, error: data?.error?.message ?? `http_${res.status}` };
    }
    return { ok: true, restoredBooks: data.restoredBooks ?? 0, restoredPhotos: data.restoredPhotos ?? 0 };
  } catch (e) {
    return { ok: false, restoredBooks: 0, restoredPhotos: 0, error: (e as any)?.message ?? 'network_error' };
  }
}

// ── Drop detection ────────────────────────────────────────────────────────────

export interface DropCheckResult {
  /** True if a suspicious drop is detected and no recent destructive action explains it. */
  suspicious: boolean;
  /** Human-readable reason string for log/banner. */
  reason: string;
  approvedDrop: number;
  photosDrop: number;
  highWaterApproved: number;
  highWaterPhotos: number;
  serverApproved: number;
  serverPhotos: number;
  recentDestructiveAction: boolean;
  lastActionId: string | null;
  lastActionAgeMs: number | null;
}

/**
 * Check whether a server snapshot represents a suspicious drop compared to
 * the known high-water marks.
 *
 * "Suspicious" means: server returned fewer items than the high water mark
 * AND no destructive action was confirmed recently
 * AND not a fresh install/cache reset (epoch reset or local storage empty).
 *
 * Callers:
 *   - ScansTab rehydrate_merge, just before applying the snapshot
 *   - ScansTab post-approve full-refresh (sanity check)
 *
 * The caller decides what to do with the result (warn/block/safe-mode).
 */
export function checkForSuspiciousDrop(params: {
  serverApproved: number;
  serverPhotos: number;
  highWaterApproved: number;
  highWaterPhotos: number;
  lastDestructiveAction: LastDestructiveAction | null;
  /** Minimum number of items that must be missing before we call it suspicious. Default 1. */
  minDropThreshold?: number;
  /**
   * Total books attached to photos (from PHOTO_ATTACH_SUMMARY).
   * When serverApproved=0 but totalAttachedBooks>0, the books fetch is partial/filtered
   * (e.g. deleted_at IS NULL + status=approved returns 0 while photo linkage still has data).
   * Treat as untrusted: refuse to recompute counts to zero.
   */
  totalAttachedBooks?: number;
  /**
   * True when we just reset safety baselines (epoch change / cache clear).
   * Bypass suspicious-drop: accept the next server snapshot as authoritative.
   */
  isFreshInstallOrCacheReset?: boolean;
  /**
   * Local counts derived from AsyncStorage this run.
   * When both are 0 we have nothing to protect — accept server (avoids "upload failed" flicker from stale local-only state).
   */
  localApprovedCount?: number;
  localPhotosCount?: number;
}): DropCheckResult {
  const {
    serverApproved,
    serverPhotos,
    highWaterApproved,
    highWaterPhotos,
    lastDestructiveAction,
    minDropThreshold = 1,
    totalAttachedBooks = 0,
    isFreshInstallOrCacheReset = false,
    localApprovedCount,
    localPhotosCount,
  } = params;

  // Intentional reset: user cleared cache or we're in a fresh/empty state — accept server snapshot.
  if (isFreshInstallOrCacheReset) {
    return {
      suspicious: false,
      reason: 'fresh_install_or_cache_reset',
      approvedDrop: 0,
      photosDrop: 0,
      highWaterApproved,
      highWaterPhotos,
      serverApproved,
      serverPhotos,
      recentDestructiveAction: false,
      lastActionId: null,
      lastActionAgeMs: null,
    };
  }
  const localStorageEmpty =
    (localApprovedCount !== undefined && localPhotosCount !== undefined && localApprovedCount === 0 && localPhotosCount === 0);
  if (localStorageEmpty) {
    return {
      suspicious: false,
      reason: 'local_storage_empty_accept_server',
      approvedDrop: 0,
      photosDrop: 0,
      highWaterApproved,
      highWaterPhotos,
      serverApproved,
      serverPhotos,
      recentDestructiveAction: false,
      lastActionId: null,
      lastActionAgeMs: null,
    };
  }

  // Evidence of partial/filtered snapshot: books fetch returned 0 but photos still have attached books.
  const serverZeroButPhotosHaveBooks = serverApproved === 0 && totalAttachedBooks > 0;
  const approvedDrop = Math.max(0, highWaterApproved - serverApproved);
  const photosDrop = Math.max(0, highWaterPhotos - serverPhotos);
  const hasDrop = approvedDrop >= minDropThreshold || photosDrop >= minDropThreshold || serverZeroButPhotosHaveBooks;

  if (!hasDrop) {
    return {
      suspicious: false,
      reason: 'no_drop',
      approvedDrop, photosDrop,
      highWaterApproved, highWaterPhotos,
      serverApproved, serverPhotos,
      recentDestructiveAction: false,
      lastActionId: null,
      lastActionAgeMs: null,
    };
  }

  const now = Date.now();
  const actionAge = lastDestructiveAction ? now - lastDestructiveAction.at : null;
  const recentDestructiveAction =
    lastDestructiveAction !== null &&
    actionAge !== null &&
    actionAge < RECENT_DESTRUCTIVE_MS;

  const suspicious = hasDrop && !recentDestructiveAction;
  const reason = suspicious
    ? (serverZeroButPhotosHaveBooks
        ? `server_approved_zero_but_photos_have_books: approved=${serverApproved} totalAttachedBooks=${totalAttachedBooks} (partial/filtered snapshot — refuse to recompute to zero)`
        : `server_drop_unexplained: approved=${serverApproved} (was ${highWaterApproved}, drop=${approvedDrop}), photos=${serverPhotos} (was ${highWaterPhotos}, drop=${photosDrop})`)
    : `server_drop_explained_by_delete: actionId=${lastDestructiveAction?.actionId ?? 'none'} reason=${lastDestructiveAction?.reason ?? 'none'} ageMs=${actionAge ?? 'n/a'}`;

  return {
    suspicious,
    reason,
    approvedDrop, photosDrop,
    highWaterApproved, highWaterPhotos,
    serverApproved, serverPhotos,
    recentDestructiveAction,
    lastActionId: lastDestructiveAction?.actionId ?? null,
    lastActionAgeMs: actionAge,
  };
}
