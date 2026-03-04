/**
 * Correlation id (opId) and structured log context for scan-related actions:
 * scan, approve, reject, delete pending (cleanup).
 * Use the same opId for an entire action and include it in all logs for that action.
 */

export type ScanLogContext = {
  opId: string;
  userId?: string;
  batchId?: string;
  scanJobId?: string;
  /** DB photo id (photos.id / books.source_photo_id) */
  photoId?: string;
  /** Client-side photo id before sync (e.g. local uuid) */
  localPhotoId?: string;
  /** Hash of image bytes or deterministic imageHash from scan_jobs */
  photoFingerprint?: string;
};

/**
 * Generate a new operation id (uuid v4) at the start of an action (scan, approve, reject, delete pending).
 * Works in Node (API routes) and browser.
 */
export function generateOpId(): string {
  try {
    const cryptoModule = typeof require !== 'undefined' ? require('crypto') : null;
    if (cryptoModule?.randomUUID) return cryptoModule.randomUUID();
  } catch {
    // ignore
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build a log prefix string for scan-related actions.
 * Example: [CLEANUP_PENDING] opId=... user=... photoId=... scanJobId=... fp=...
 * Only includes fields that are defined (non-empty string or provided).
 */
export function scanLogPrefix(tag: string, ctx: ScanLogContext): string {
  const parts: string[] = [`[${tag}]`, `opId=${ctx.opId}`];
  if (ctx.userId != null && ctx.userId !== '') parts.push(`user=${ctx.userId}`);
  if (ctx.batchId != null && ctx.batchId !== '') parts.push(`batchId=${ctx.batchId}`);
  if (ctx.scanJobId != null && ctx.scanJobId !== '') parts.push(`scanJobId=${ctx.scanJobId}`);
  if (ctx.photoId != null && ctx.photoId !== '') parts.push(`photoId=${ctx.photoId}`);
  if (ctx.localPhotoId != null && ctx.localPhotoId !== '') parts.push(`localPhotoId=${ctx.localPhotoId}`);
  if (ctx.photoFingerprint != null && ctx.photoFingerprint !== '') parts.push(`fp=${ctx.photoFingerprint}`);
  return parts.join(' ');
}
