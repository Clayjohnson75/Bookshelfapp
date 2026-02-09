/**
 * User-scoped cache keys. Prevents account mixing: each user's data lives under their userId.
 * Key namespaces: books_cache (pending_books_${uid}, etc.), scan_job_${uid}_${jobId}, last_batch (last_scan_sync_${uid}).
 * On user change, clear in-memory state and use new user's keys; store active_user_id so we never read the wrong namespace.
 */

/** Books cache: pending, approved, rejected, photos, folders — user-scoped so account mixing is impossible. */
export function booksCacheKey(userId: string, kind: 'pending' | 'approved' | 'rejected' | 'photos' | 'folders'): string {
  const prefix = kind === 'pending' ? 'pending_books' : kind === 'approved' ? 'approved_books' : kind === 'rejected' ? 'rejected_books' : kind === 'photos' ? 'photos' : 'folders';
  return `${prefix}_${userId}`;
}

/** Scan queue / job tracking: namespace by userId so user B never sees user A's jobs. */
export function scanJobKey(userId: string, jobId: string): string {
  return `scan_job_${userId}_${jobId}`;
}

/** Last batch/sync timestamp: per user. */
export function lastBatchKey(userId: string): string {
  return `last_scan_sync_${userId}`;
}

/** Pending approve action (guest → sign-in): clear on sign out so next user doesn't get it. */
export const PENDING_APPROVE_ACTION_KEY = 'pending_approve_action';

/** Active userId: store when signed in, remove on sign out. Used to ensure we never read another user's namespace. */
export const ACTIVE_USER_ID_KEY = 'active_user_id';
