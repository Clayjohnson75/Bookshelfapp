/**
 * Canonical photo storage path: one format everywhere.
 * Format: <userId>/<photoId>.jpg
 *
 * DB photos.storage_path, upload path, signed URL, and storageExists checks
 * must all use exactly this. No truncation, no "scans/" or "bf.../133" prefixes.
 *
 * Log [STORAGE_PATH] every time we compute it so if the same photoId ever
 * gets different values, we see the bug.
 */

/**
 * Canonical storage path for a photo in the "photos" bucket.
 * Always: <userId>/<photoId>.jpg
 */
export function getCanonicalPhotoStoragePath(userId: string, photoId: string): string {
  const storagePath = `${userId}/${photoId}.jpg`;
  // eslint-disable-next-line no-console
  console.log('[STORAGE_PATH]', JSON.stringify({ photoId, storagePath }));
  return storagePath;
}
