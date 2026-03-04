/**
 * Single source of truth: photos.status — only these values are allowed by the DB (photos_status_check).
 * Pipeline states (uploading, uploaded, processing, etc.) go in photos.processing_stage, not status.
 * Never write 'uploaded' to the DB; use 'complete' after STEP_B upload_ok.
 */

export type PhotosStatusDb = 'draft' | 'complete' | 'discarded' | 'scan_failed';

/** Only statuses the DB allows. Workers and clients must never invent a status outside this list. */
export const ALLOWED_PHOTO_STATUS_DB: readonly PhotosStatusDb[] = ['draft', 'complete', 'discarded', 'scan_failed'];

/** Map UI/pipeline status to DB. Never write 'uploaded' to photos.status. */
const UPLOADED_TO_COMPLETE: Record<string, PhotosStatusDb> = {
  uploaded: 'complete',
  processing: 'complete',
};

/**
 * Normalize any app status to the DB enum. Use before every photos insert/upsert.
 * 'uploaded' and 'processing' → 'complete'. Other non-enum values → 'draft' + processing_stage.
 */
export function normalizePhotoStatusForDb(
  status: string | undefined | null
): { status: PhotosStatusDb; processingStage?: string } {
  if (status != null && typeof status === 'string') {
    const s = status.trim().toLowerCase();
    if ((ALLOWED_PHOTO_STATUS_DB as readonly string[]).includes(s)) {
      return { status: s as PhotosStatusDb };
    }
    if (UPLOADED_TO_COMPLETE[s]) {
      return { status: UPLOADED_TO_COMPLETE[s], processingStage: status };
    }
    return { status: 'draft', processingStage: status };
  }
  return { status: 'draft' };
}

/**
 * Return status only if it is DB-allowed; otherwise return 'draft'.
 * Use in workers/APIs when setting photos.status from a variable to avoid inventing a non-DB status.
 */
export function ensurePhotoStatusDb(status: string | undefined | null): PhotosStatusDb {
  const s = status?.trim?.()?.toLowerCase?.();
  if (s && (ALLOWED_PHOTO_STATUS_DB as readonly string[]).includes(s)) {
    return s as PhotosStatusDb;
  }
  return 'draft';
}
