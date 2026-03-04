/**
 * Local storage audit utilities.
 * Computes sizes of DocumentDirectory and CacheDirectory sub-folders,
 * including scan-staging/ (documentDir — durable staging used by upload queue), photos/ (legacy), and covers/.
 */

import * as FileSystem from 'expo-file-system/legacy';

export interface FolderStats {
  path: string;
  exists: boolean;
  totalBytes: number;
  fileCount: number;
  avgBytes: number;
}

export interface StorageAuditResult {
  documentDir: FolderStats;
  cacheDir: FolderStats;
  photosSubdir: FolderStats;
  coversSubdir: FolderStats;
  /** Scan staging (documentDirectory/scan-staging/) — durable upload staging used by queue. */
  scanStagingSubdir: FolderStats;
  totalLocalBytes: number;
  computedAt: string;
}

/** Recursively sum size of all files under a directory URI. */
async function sumDirBytes(dirUri: string): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0;
  let fileCount = 0;

  const info = await FileSystem.getInfoAsync(dirUri);
  if (!info.exists || !info.isDirectory) {
    // If it's a file, count it directly.
    if (info.exists && 'size' in info) {
      totalBytes += (info as FileSystem.FileInfo & { size?: number }).size ?? 0;
      fileCount = 1;
    }
    return { totalBytes, fileCount };
  }

  let entries: string[] = [];
  try {
    entries = await FileSystem.readDirectoryAsync(dirUri);
  } catch {
    return { totalBytes, fileCount };
  }

  for (const entry of entries) {
    const entryUri = dirUri.endsWith('/') ? `${dirUri}${entry}` : `${dirUri}/${entry}`;
    const entryInfo = await FileSystem.getInfoAsync(entryUri);
    if (!entryInfo.exists) continue;
    if (entryInfo.isDirectory) {
      const sub = await sumDirBytes(entryUri);
      totalBytes += sub.totalBytes;
      fileCount += sub.fileCount;
    } else {
      totalBytes += (entryInfo as FileSystem.FileInfo & { size?: number }).size ?? 0;
      fileCount += 1;
    }
  }

  return { totalBytes, fileCount };
}

async function auditFolder(uri: string | null): Promise<FolderStats> {
  const path = uri ?? '';
  if (!path) {
    return { path, exists: false, totalBytes: 0, fileCount: 0, avgBytes: 0 };
  }
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return { path, exists: false, totalBytes: 0, fileCount: 0, avgBytes: 0 };
  }
  const { totalBytes, fileCount } = await sumDirBytes(path);
  return {
    path,
    exists: true,
    totalBytes,
    fileCount,
    avgBytes: fileCount > 0 ? Math.round(totalBytes / fileCount) : 0,
  };
}

/** Durable scan-staging path: same as photoUploadQueue (documentDirectory/scan-staging/). */
function getDurableScanStagingDir(): string {
  const base = FileSystem.documentDirectory ?? '';
  return base ? `${base}scan-staging/` : '';
}

export async function runStorageAudit(): Promise<StorageAuditResult> {
  const docBase = FileSystem.documentDirectory ?? '';
  const cacheBase = FileSystem.cacheDirectory ?? '';
  const scanStagingDir = getDurableScanStagingDir();

  const [documentDir, cacheDir, photosSubdir, coversSubdir, scanStagingSubdir] = await Promise.all([
    auditFolder(docBase),
    auditFolder(cacheBase),
    auditFolder(docBase ? `${docBase}photos/` : null),
    auditFolder(docBase ? `${docBase}covers/` : null),
    auditFolder(scanStagingDir || null),
  ]);

  return {
    documentDir,
    cacheDir,
    photosSubdir,
    coversSubdir,
    scanStagingSubdir,
    totalLocalBytes: documentDir.totalBytes + cacheDir.totalBytes,
    computedAt: new Date().toISOString(),
  };
}

/** Human-readable bytes string: "4.2 MB", "812 KB", etc. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}
