/**
 * Cache eviction and local storage purge for scan staging, covers, and cache.
 *
 * Scan staging: FileSystem.cacheDirectory + "scan_staging/" — temporary files before upload.
 *               Delete after upload success; keep last SCAN_ORIGINALS_KEEP by mtime.
 * Covers:       documentDirectory + "covers/" — re-downloadable; evict by age.
 * Cache dir:   Expo CacheDirectory (manipulator temp, etc.) — clear on eviction/purge.
 *
 * All evictions are best-effort: errors are logged but not thrown.
 */

import * as FileSystem from 'expo-file-system/legacy';

const COVERS_MAX_AGE_DAYS = 30;
const SCAN_ORIGINALS_KEEP = 5;
/** Downloaded photos (cache): evict by age so cache doesn't grow unbounded. */
const PHOTO_CACHE_MAX_AGE_DAYS = 14;

/** Scan staging dir (cache). Use for upload staging only; purge on account reset. */
export function getScanStagingDir(): string {
  const base = FileSystem.cacheDirectory ?? '';
  return base ? `${base}scan_staging/` : '';
}

/** Photo cache dir (cache). Downloaded full/thumb from storage; evict by age so Documents doesn't grow. */
export function getPhotoCacheDir(): string {
  const base = FileSystem.cacheDirectory ?? '';
  return base ? `${base}photos/` : '';
}

export interface EvictionResult {
  coversDeleted: number;
  coversBytesFreed: number;
  photosDeleted: number;
  photosBytesFreed: number;
  photoCacheDeleted: number;
  photoCacheBytesFreed: number;
  cacheDirCleared: boolean;
  cacheDirBytesFreed: number;
  totalBytesFreed: number;
  errors: string[];
}

/** Return the modification time of a file (ms since epoch), or 0 if unavailable. */
async function getModifiedMs(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { md5: false });
    if (!info.exists) return 0;
    return (info as FileSystem.FileInfo & { modificationTime?: number }).modificationTime
      ? (info as FileSystem.FileInfo & { modificationTime?: number }).modificationTime! * 1000
      : 0;
  } catch {
    return 0;
  }
}

async function getFileSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return 0;
    return (info as FileSystem.FileInfo & { size?: number }).size ?? 0;
  } catch {
    return 0;
  }
}

async function deleteFile(uri: string): Promise<number> {
  const size = await getFileSize(uri);
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // best-effort
  }
  return size;
}

/** Evict cover cache files older than maxAgeDays. */
async function evictOldCovers(
  coversDir: string,
  maxAgeDays: number,
  errors: string[]
): Promise<{ deleted: number; bytesFreed: number }> {
  let deleted = 0;
  let bytesFreed = 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const info = await FileSystem.getInfoAsync(coversDir);
    if (!info.exists) return { deleted, bytesFreed };

    const entries = await FileSystem.readDirectoryAsync(coversDir);
    for (const entry of entries) {
      const uri = `${coversDir}${entry}`;
      const modMs = await getModifiedMs(uri);
      // If we can't read the mod time, fall back to keeping the file (safe default).
      if (modMs > 0 && modMs < cutoffMs) {
        bytesFreed += await deleteFile(uri);
        deleted++;
      }
    }
  } catch (e: unknown) {
    errors.push(`covers eviction: ${(e as Error)?.message ?? String(e)}`);
  }

  return { deleted, bytesFreed };
}

/** Keep only the most recent `keep` files in the given dir (by mtime), delete the rest. */
async function evictOldScanOriginals(
  dir: string,
  keep: number,
  errors: string[]
): Promise<{ deleted: number; bytesFreed: number }> {
  let deleted = 0;
  let bytesFreed = 0;

  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return { deleted, bytesFreed };

    const entries = await FileSystem.readDirectoryAsync(dir);
    const uris = entries.map((e) => `${dir}${e}`);

    const withMtime: { uri: string; modMs: number }[] = await Promise.all(
      uris.map(async (uri) => ({ uri, modMs: await getModifiedMs(uri) }))
    );
    withMtime.sort((a, b) => b.modMs - a.modMs);

    const toDelete = withMtime.slice(keep);
    for (const { uri } of toDelete) {
      bytesFreed += await deleteFile(uri);
      deleted++;
    }
  } catch (e: unknown) {
    errors.push(`scan_staging eviction: ${(e as Error)?.message ?? String(e)}`);
  }

  return { deleted, bytesFreed };
}

/** Prune scan_staging to keep only the most recent `keep` files. Call after upload success. */
export async function pruneScanStagingKeepLast(keep: number): Promise<{ deleted: number; bytesFreed: number }> {
  const errors: string[] = [];
  return evictOldScanOriginals(getScanStagingDir(), keep, errors);
}

/** Clear the entire Expo CacheDirectory (manipulator temp files, etc.). */
async function clearCacheDirectory(errors: string[]): Promise<{ cleared: boolean; bytesFreed: number }> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return { cleared: false, bytesFreed: 0 };

  let bytesFreed = 0;
  try {
    const info = await FileSystem.getInfoAsync(cacheDir);
    if (!info.exists) return { cleared: true, bytesFreed: 0 };

    const entries = await FileSystem.readDirectoryAsync(cacheDir);
    for (const entry of entries) {
      const uri = `${cacheDir}${entry}`;
      bytesFreed += await deleteFile(uri);
    }
    return { cleared: true, bytesFreed };
  } catch (e: unknown) {
    errors.push(`cache dir clear: ${(e as Error)?.message ?? String(e)}`);
    return { cleared: false, bytesFreed };
  }
}

export async function runCacheEviction(options?: {
  coversMaxAgeDays?: number;
  scanOriginalsKeep?: number;
  clearCacheDir?: boolean;
}): Promise<EvictionResult> {
  const maxAgeDays = options?.coversMaxAgeDays ?? COVERS_MAX_AGE_DAYS;
  const keepOriginals = options?.scanOriginalsKeep ?? SCAN_ORIGINALS_KEEP;
  const shouldClearCache = options?.clearCacheDir ?? true;

  const docBase = FileSystem.documentDirectory ?? '';
  const coversDir = docBase ? `${docBase}covers/` : '';
  const scanStagingDir = getScanStagingDir();
  const photoCacheDir = getPhotoCacheDir();

  const errors: string[] = [];

  const [coversResult, photosResult, photoCacheResult, cacheResult] = await Promise.all([
    coversDir ? evictOldCovers(coversDir, maxAgeDays, errors) : Promise.resolve({ deleted: 0, bytesFreed: 0 }),
    scanStagingDir ? evictOldScanOriginals(scanStagingDir, keepOriginals, errors) : Promise.resolve({ deleted: 0, bytesFreed: 0 }),
    photoCacheDir ? evictOldCovers(photoCacheDir, PHOTO_CACHE_MAX_AGE_DAYS, errors) : Promise.resolve({ deleted: 0, bytesFreed: 0 }),
    shouldClearCache ? clearCacheDirectory(errors) : Promise.resolve({ cleared: false, bytesFreed: 0 }),
  ]);

  const totalBytesFreed = coversResult.bytesFreed + photosResult.bytesFreed + photoCacheResult.bytesFreed + cacheResult.bytesFreed;

  return {
    coversDeleted: coversResult.deleted,
    coversBytesFreed: coversResult.bytesFreed,
    photosDeleted: photosResult.deleted,
    photosBytesFreed: photosResult.bytesFreed,
    photoCacheDeleted: photoCacheResult.deleted,
    photoCacheBytesFreed: photoCacheResult.bytesFreed,
    cacheDirCleared: cacheResult.cleared,
    cacheDirBytesFreed: cacheResult.bytesFreed,
    totalBytesFreed,
    errors,
  };
}

export interface PurgeLocalDataResult {
  scanStagingDeleted: number;
  scanStagingBytesFreed: number;
  coversDeleted: number;
  coversBytesFreed: number;
  cacheDirCleared: boolean;
  cacheDirBytesFreed: number;
  legacyPhotosDeleted: number;
  legacyPhotosBytesFreed: number;
  totalDeleted: number;
  totalBytesFreed: number;
  errors: string[];
}

/** Purge local scan cache, covers, and cache dir. Call on account reset. keepLastN applies only to scan_staging (0 = delete all). */
export async function purgeLocalData(options?: { keepLastN?: number }): Promise<PurgeLocalDataResult> {
  const keep = options?.keepLastN ?? 0;
  const docBase = FileSystem.documentDirectory ?? '';
  const cacheBase = FileSystem.cacheDirectory ?? '';
  const coversDir = docBase ? `${docBase}covers/` : '';
  const scanStagingDir = getScanStagingDir();
  const legacyPhotosDir = docBase ? `${docBase}photos/` : '';

  const errors: string[] = [];
  let scanStagingDeleted = 0;
  let scanStagingBytesFreed = 0;
  let coversDeleted = 0;
  let coversBytesFreed = 0;
  let cacheDirBytesFreed = 0;
  let cacheDirCleared = false;
  let legacyPhotosDeleted = 0;
  let legacyPhotosBytesFreed = 0;

  if (scanStagingDir) {
    const r = await evictOldScanOriginals(scanStagingDir, keep, errors);
    scanStagingDeleted = r.deleted;
    scanStagingBytesFreed = r.bytesFreed;
  }

  if (coversDir) {
    const r = await evictOldCovers(coversDir, 0, errors);
    coversDeleted = r.deleted;
    coversBytesFreed = r.bytesFreed;
  }

  const cacheResult = await clearCacheDirectory(errors);
  cacheDirCleared = cacheResult.cleared;
  cacheDirBytesFreed = cacheResult.bytesFreed;

  if (legacyPhotosDir) {
    try {
      const info = await FileSystem.getInfoAsync(legacyPhotosDir);
      if (info.exists) {
        const entries = await FileSystem.readDirectoryAsync(legacyPhotosDir);
        for (const entry of entries) {
          const uri = `${legacyPhotosDir}${entry}`;
          legacyPhotosBytesFreed += await deleteFile(uri);
          legacyPhotosDeleted++;
        }
      }
    } catch (e: unknown) {
      errors.push(`legacy photos purge: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  const totalDeleted = scanStagingDeleted + coversDeleted + legacyPhotosDeleted;
  const totalBytesFreed =
    scanStagingBytesFreed + coversBytesFreed + cacheDirBytesFreed + legacyPhotosBytesFreed;

  return {
    scanStagingDeleted,
    scanStagingBytesFreed,
    coversDeleted,
    coversBytesFreed,
    cacheDirCleared,
    cacheDirBytesFreed,
    legacyPhotosDeleted,
    legacyPhotosBytesFreed,
    totalDeleted,
    totalBytesFreed,
    errors,
  };
}
