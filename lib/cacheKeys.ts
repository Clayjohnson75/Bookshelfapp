/**
 * User-scoped cache keys. Prevents account mixing: each user's data lives under their userId.
 * Key namespaces: books_cache (pending_books_${uid}, etc.), scan_job_${uid}_${jobId}, last_batch (last_scan_sync_${uid}).
 * On user change, clear in-memory state and use new user's keys; store active_user_id so we never read the wrong namespace.
 */

/** Books cache: pending, approved, rejected, photos, folders user-scoped so account mixing is impossible. */
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

/** Active batch ID for current user (single batchId string). Clear only on cancel / all terminal / sign out. */
export function activeBatchKey(userId: string): string {
 return `active_batch_${userId}`;
}

/** ScanBatch object persisted by batchId (user-scoped). Key = scan_batch_${userId}_${batchId}. Never merge across batches. */
export function scanBatchKey(userId: string, batchId: string): string {
 return `scan_batch_${userId}_${batchId}`;
}

/** Imported photo keys: jobId:imageIndex (or storage_path) so we only import each job photo once. */
export function importedPhotoKeysKey(userId: string): string {
 return `imported_photo_keys_${userId}`;
}

/** Guest-only pending books (no auth, device-only). Shape: { books: Book[], guestScanId?: string, expiresAt?: string }. */
export const PENDING_GUEST_KEY = 'pending_guest';

/** Pending approve action (guest sign-in): clear on sign out so next user doesn't get it. */
export const PENDING_APPROVE_ACTION_KEY = 'pending_approve_action';

/** Active userId: store when signed in, remove on sign out. Used to ensure we never read another user's namespace. */
export const ACTIVE_USER_ID_KEY = 'active_user_id';

// ── Data-safety persistence keys ──────────────────────────────────────────────

/**
 * High-water marks for approved books + photos.
 * Shape: { approved: number; photos: number; updatedAt: number }
 * Persisted after every trusted snapshot commit so cold-start can detect unexpected drops.
 */
export function highWaterKey(userId: string): string {
  return `high_water_${userId}`;
}

/**
 * Last confirmed destructive action (user-initiated delete).
 * Shape: { actionId: string; reason: string; at: number; bookCount?: number; photoCount?: number }
 * Persisted so the merge guard knows whether a recent drop was intentional.
 */
export function lastDestructiveActionKey(userId: string): string {
  return `last_destructive_action_${userId}`;
}

/**
 * Safety epoch: UUID that changes when the user clears cache/data.
 * When epoch changes (or is missing), we do not compare against old high-water — accept next server snapshot as authoritative.
 */
export function safetyEpochKey(userId: string): string {
  return `safety_epoch_${userId}`;
}
