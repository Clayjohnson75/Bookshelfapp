/**
 * Supabase Sync Service
 * 
 * This service handles syncing books and photos to/from Supabase.
 * It ensures all user data is permanently stored in the cloud and
 * persists across app versions and devices.
 */

import { supabase } from '../lib/supabase';
import { getApiBaseUrl } from '../lib/getEnvVar';
import { getScanAuthHeaders } from '../lib/authHeaders';
import { isGoogleHotlink } from '../lib/coverUtils';
import { sanitizeTextForDb, sanitizeBookForDb, debugString } from '../lib/sanitizeTextForDb';
import { computeBookKey, getStableBookKey } from '../lib/bookKey';
import { mergeBookFieldLevel } from '../lib/mergeBooks';
import { DEBUG_VERBOSE } from '../lib/logFlags';
import { scanLogPrefix } from '../lib/scanCorrelation';
import { toRawScanJobUuid, toScanJobId } from '../lib/scanId';
import { logger } from '../utils/logger';
import { Book, Photo, Folder } from '../types/BookTypes';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { registerDedupe, markCanonical, isCanonical } from '../lib/canonicalPhotoMap';
import { canon, isPhotoKeyValid, normalizeId } from '../lib/photoKey';
import { logDeleteBlocked, logDeleteIntent } from '../lib/deleteGuard';
import { startMutation, endMutation, checkRlsDenied } from '../lib/dbAudit';
import { getScanStagingDir, getPhotoCacheDir, pruneScanStagingKeepLast } from '../lib/cacheEviction';
import { getCanonicalPhotoStoragePath } from '../lib/photoStoragePath';
import { normalizePhotoStatusForDb } from '../lib/photoStatusGuard';


/** UUID v4-style: 8-4-4-4-12 hex. Use for books.source_photo_id, photos.id when stored in uuid columns. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve book.source_photo_id to the full photo UUID from the known photo list. Store and join on full UUID only; never use short IDs as keys. */
function resolvePhotoIdForJoin(bookSourcePhotoId: string | undefined | null, photoIds: string[]): string {
  const id = (bookSourcePhotoId ?? '').trim();
  if (!id || photoIds.length === 0) return id;
  if (UUID_REGEX.test(id)) {
    if (photoIds.includes(id)) return id;
    const caseInsensitive = photoIds.find((p) => p.toLowerCase().trim() === id.toLowerCase());
    if (caseInsensitive) return caseInsensitive;
  }
  // Prefix/short id: resolve to full UUID from photoIds so we never use prefix as join key.
  const lower = id.toLowerCase();
  const full = photoIds.find((p) => p && p.trim().toLowerCase().startsWith(lower) && UUID_REGEX.test(p.trim()));
  if (full) return full.trim();
  return id;
}

/** True if value is a valid UUID (avoids "invalid input syntax for type uuid" when writing to uuid columns). */
export function isUuid(value: string | null | undefined): boolean {
 return typeof value === 'string' && UUID_REGEX.test(value);
}

/** Re-export for callers that still import from supabaseSync. Prefer importing from lib/scanId. */
export { toRawScanJobUuid, toScanJobId } from '../lib/scanId';

/** Signed URLs for photos bucket; canonical implementation in lib/photoUrls. Re-export for backward compatibility. */
export { getSignedPhotoUrl, clearSignedPhotoUrlCache } from '../lib/photoUrls';
import { getSignedPhotoUrl } from '../lib/photoUrls';

/**
 * From a list of approved books, return job IDs to close (scan_jobs.id format) and raw set for filtering pending.
 * Use when approve finishes: close exactly these jobs so pending is only from open jobs.
 * Only full UUIDs are passed to jobIdsToClose so the API/DB can match; short prefixes are skipped.
 */
export function getJobIdsToCloseFromApproved(approvedBooks: Book[], contextJobId?: string): { jobIdsToClose: string[]; closedJobIdsRaw: Set<string> } {
 const raw = new Set<string>(
 approvedBooks.map((b) => (b as any).source_scan_job_id).filter(Boolean) as string[]
 );
 if (contextJobId) {
 const ctxRaw = toRawScanJobUuid(contextJobId);
 if (ctxRaw) raw.add(ctxRaw);
 }
 const fullRawOnly = [...raw].map(toRawScanJobUuid).filter((r): r is string => r != null);
 const closedJobIdsRaw = new Set(fullRawOnly);
 const jobIdsToClose = fullRawOnly.map(toScanJobId);
 return { jobIdsToClose, closedJobIdsRaw };
}

/** Session memo: backfill source_photo_id at most once per (userId, rawJobId) to avoid spam and DB load. */
const didBackfillJobIds = new Set<string>();

/**
 * Upload a book cover to Supabase Storage and return the public URL
 */
export async function uploadBookCoverToStorage(
 userId: string,
 bookId: string,
 localUri: string
): Promise<{ storagePath: string; storageUrl: string } | null> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping cover upload');
 return null;
 }

 try {
 // Check if file exists first
 let fileInfo = await FileSystem.getInfoAsync(localUri);
 if (!fileInfo.exists) {
 logger.warn('Cover file does not exist:', localUri);
 return null;
 }

 // Resize and optimize the image if needed
 let imageUri = localUri;
 try {
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 localUri,
 [{ resize: { width: 600 } }],
 { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
 );
 imageUri = manipulatedImage.uri;
 } catch (manipError) {
 logger.warn('Error manipulating cover image, using original:', manipError);
 imageUri = localUri;
 }
 
 // Read the file as base64
 const base64 = await FileSystem.readAsStringAsync(imageUri, {
 encoding: FileSystem.EncodingType.Base64,
 });

 // Decode base64 to binary for Supabase Storage
 const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
 const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
 const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 const lookup = new Uint8Array(256);
 for (let i = 0; i < chars.length; i++) {
 lookup[chars.charCodeAt(i)] = i;
 }
 
 let bufferLength = cleanBase64.length * 0.75;
 if (cleanBase64[cleanBase64.length - 1] === '=') {
 bufferLength--;
 if (cleanBase64[cleanBase64.length - 2] === '=') {
 bufferLength--;
 }
 }
 
 const bytes = new Uint8Array(bufferLength);
 let p = 0;
 
 for (let i = 0; i < cleanBase64.length; i += 4) {
 const encoded1 = lookup[cleanBase64.charCodeAt(i)];
 const encoded2 = lookup[cleanBase64.charCodeAt(i + 1)];
 const encoded3 = lookup[cleanBase64.charCodeAt(i + 2)];
 const encoded4 = lookup[cleanBase64.charCodeAt(i + 3)];
 
 bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
 bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
 bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
 }
 
 return bytes.buffer;
 };

 const arrayBuffer = base64ToArrayBuffer(base64);

 // Upload to Supabase Storage (use 'photos' bucket or create 'covers' bucket)
 const storagePath = `${userId}/covers/${bookId}.jpg`;
 const { data, error } = await supabase.storage
 .from('photos')
 .upload(storagePath, arrayBuffer, {
 contentType: 'image/jpeg',
 upsert: true, // Overwrite if exists
 });

 if (error) {
 const err = error as { message?: string; code?: string };
 const errorMessage = err?.message || err?.code || JSON.stringify(error) || String(error);
 logger.error('Error uploading cover to storage:', errorMessage);
 return null;
 }

 // Photos bucket is private; do not use getPublicUrl. Callers must use getSignedPhotoUrl(storagePath) for display.
 return {
 storagePath,
 storageUrl: '',
 };
 } catch (error) {
 logger.error('Error uploading cover:', error);
 return null;
 }
}

/** Max longest-side for working copy (staging + upload). Avoids storing ~7GB of originals. */
const SCAN_WORKING_MAX = 1600;
/** Max width for precomputed thumbnails (grids never decode full-res). */
const SCAN_THUMB_MAX = 400;
/** JPEG quality for working and thumb (smaller = less storage). */
const SCAN_JPEG_QUALITY = 0.85;

/**
 * Upload a photo to Supabase Storage. Downscales to working size before storing/uploading; precomputes a thumbnail for grids.
 * Returns storagePath and optional thumbnailLocalUri (file:// to cache) so grids can render thumbnails without per-render work.
 */
export async function uploadPhotoToStorage(
 userId: string,
 photoId: string,
 localUri: string
): Promise<{ storagePath: string; storageUrl: string | null; thumbnailLocalUri?: string | null } | null> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping photo upload');
 return null;
 }

 try {
 // Check if file exists first
 let fileInfo = await FileSystem.getInfoAsync(localUri);
 if (!fileInfo.exists) {
 logger.warn('Photo file does not exist:', localUri);
 return null;
 }
 
 // Always copy/convert to a permanent location to avoid temporary file cleanup issues
 // This is especially important for iOS ImagePicker and Camera files
 let imageUri = localUri;
 const isTemporaryPath = localUri.includes('ImagePicker') || localUri.includes('Camera') || localUri.includes('tmp');
 const isHeic = localUri.toLowerCase().endsWith('.heic');
 
 // Track any staging file we create so we can delete it after a successful upload.
 // We only keep the remote copy; local copies are temporary staging files.
 let stagingPath: string | null = null;
 let thumbnailLocalUri: string | null = null;

 // Downscale to working size + precompute thumbnail; store only in cache (eviction via pruneScanStagingKeepLast).
 if (Platform.OS === 'ios' && (isTemporaryPath || isHeic)) {
 try {
 const scanStagingDir = getScanStagingDir();
 if (!scanStagingDir) {
 logger.error('Cache directory not available for scan staging');
 return null;
 }

 const dirInfo = await FileSystem.getInfoAsync(scanStagingDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(scanStagingDir, { intermediates: true });
 }
 const stagingFile = `${scanStagingDir}${photoId}.jpg`;
 const thumbFile = `${scanStagingDir}thumb_${photoId}.jpg`;

 const alreadyStaged = await FileSystem.getInfoAsync(stagingFile);
 if (!alreadyStaged.exists) {
 const working = await ImageManipulator.manipulateAsync(
 localUri,
 [{ resize: { width: SCAN_WORKING_MAX } }],
 { compress: SCAN_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
 );
 await FileSystem.copyAsync({ from: working.uri, to: stagingFile });
 await FileSystem.deleteAsync(working.uri, { idempotent: true });
 }
 const alreadyThumb = await FileSystem.getInfoAsync(thumbFile);
 if (!alreadyThumb.exists) {
 const thumb = await ImageManipulator.manipulateAsync(
 stagingFile,
 [{ resize: { width: SCAN_THUMB_MAX } }],
 { compress: SCAN_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
 );
 await FileSystem.copyAsync({ from: thumb.uri, to: thumbFile });
 await FileSystem.deleteAsync(thumb.uri, { idempotent: true });
 }

 imageUri = stagingFile;
 stagingPath = stagingFile;
 thumbnailLocalUri = thumbFile;

 fileInfo = await FileSystem.getInfoAsync(imageUri);
 if (!fileInfo.exists) {
 logger.warn(`Staged photo file does not exist: ${imageUri}`);
 return null;
 }
 } catch (convertError) {
 logger.warn('Error converting/copying image:', convertError);
 fileInfo = await FileSystem.getInfoAsync(localUri);
 if (!fileInfo.exists) {
 logger.warn(`Original photo file does not exist: ${localUri}`);
 return null;
 }
 imageUri = localUri;
 }
 } else if (isTemporaryPath) {
 try {
 const scanStagingDir = getScanStagingDir();
 if (!scanStagingDir) {
 logger.error('Cache directory not available for scan staging');
 return null;
 }

 const dirInfo = await FileSystem.getInfoAsync(scanStagingDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(scanStagingDir, { intermediates: true });
 }

 const stagingFile = `${scanStagingDir}${photoId}.jpg`;
 const thumbFile = `${scanStagingDir}thumb_${photoId}.jpg`;
 const alreadyStaged = await FileSystem.getInfoAsync(stagingFile);
 if (!alreadyStaged.exists) {
 const working = await ImageManipulator.manipulateAsync(
 localUri,
 [{ resize: { width: SCAN_WORKING_MAX } }],
 { compress: SCAN_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
 );
 await FileSystem.copyAsync({ from: working.uri, to: stagingFile });
 await FileSystem.deleteAsync(working.uri, { idempotent: true });
 }
 const alreadyThumb = await FileSystem.getInfoAsync(thumbFile);
 if (!alreadyThumb.exists) {
 const thumb = await ImageManipulator.manipulateAsync(
 stagingFile,
 [{ resize: { width: SCAN_THUMB_MAX } }],
 { compress: SCAN_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
 );
 await FileSystem.copyAsync({ from: thumb.uri, to: thumbFile });
 await FileSystem.deleteAsync(thumb.uri, { idempotent: true });
 }

 imageUri = stagingFile;
 stagingPath = stagingFile;
 thumbnailLocalUri = thumbFile;

 fileInfo = await FileSystem.getInfoAsync(imageUri);
 if (!fileInfo.exists) {
 logger.warn(`Staged photo file does not exist: ${imageUri}`);
 return null;
 }
 } catch (copyError) {
 logger.warn('Error copying temporary file:', copyError);
 fileInfo = await FileSystem.getInfoAsync(localUri);
 if (!fileInfo.exists) {
 logger.warn(`Original photo file does not exist: ${localUri}`);
 return null;
 }
 imageUri = localUri;
 }
 }
 
 // Read the file as base64
 const base64 = await FileSystem.readAsStringAsync(imageUri, {
 encoding: FileSystem.EncodingType.Base64,
 });

 // Decode base64 to binary for Supabase Storage
 // Simple base64 decoder for React Native (no atob available)
 const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
 // Remove data URL prefix if present
 const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
 
 // Base64 character set
 const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 const lookup = new Uint8Array(256);
 for (let i = 0; i < chars.length; i++) {
 lookup[chars.charCodeAt(i)] = i;
 }
 
 let bufferLength = cleanBase64.length * 0.75;
 if (cleanBase64[cleanBase64.length - 1] === '=') {
 bufferLength--;
 if (cleanBase64[cleanBase64.length - 2] === '=') {
 bufferLength--;
 }
 }
 
 const bytes = new Uint8Array(bufferLength);
 let p = 0;
 
 for (let i = 0; i < cleanBase64.length; i += 4) {
 const encoded1 = lookup[cleanBase64.charCodeAt(i)];
 const encoded2 = lookup[cleanBase64.charCodeAt(i + 1)];
 const encoded3 = lookup[cleanBase64.charCodeAt(i + 2)];
 const encoded4 = lookup[cleanBase64.charCodeAt(i + 3)];
 
 bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
 bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
 bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
 }
 
 return bytes.buffer;
 };

 const arrayBuffer = base64ToArrayBuffer(base64);

 const storagePath = getCanonicalPhotoStoragePath(userId, photoId);
 const { data, error } = await supabase.storage
 .from('photos')
 .upload(storagePath, arrayBuffer, {
 contentType: 'image/jpeg',
 upsert: true, // Overwrite if exists
 });

 if (error) {
 const err = error as { message?: string; code?: string };
 const errorMessage = err?.message || err?.code || JSON.stringify(error) || String(error);
 logger.info('[STEP_B]', 'upload_err', { photoId, code: err?.code ?? 'unknown', message: errorMessage });
 if (err.code === '404' || errorMessage.includes('Bucket not found') || errorMessage.includes('does not exist')) {
 logger.error(' Photo Storage Error: Storage bucket "photos" does not exist');
 logger.error(' SOLUTION: Create the "photos" bucket in Supabase Dashboard:');
 logger.error(' 1. Go to Storage New bucket');
 logger.error(' 2. Name: "photos"');
 logger.error(' 3. Make it Public');
 logger.error(' 4. Click Create bucket');
 } else if (err.code === '42501' || errorMessage.includes('row-level security') || errorMessage.includes('violates row-level security policy')) {
 logger.error(' Photo Storage Error: RLS policy violation');
 logger.error(' SOLUTION: Set up storage bucket policies in Supabase SQL Editor');
 logger.error(' See SUPABASE_SETUP_INSTRUCTIONS.md for the policy SQL');
 } else {
 logger.error('Error uploading photo to storage:', errorMessage);
 logger.error(' Error code:', err.code);
 logger.error(' Photo ID:', photoId);
 logger.error(' User ID:', userId);
 }
 return null;
 }

 logger.info('[STEP_B]', 'upload_ok', { photoId, storagePath });
 // Upload succeeded — delete the staging file and prune to keep last 5.
 if (stagingPath) {
 FileSystem.deleteAsync(stagingPath, { idempotent: true }).catch(() => {});
 pruneScanStagingKeepLast(5).then((r) => {
   if (r.deleted > 0) {
     logger.debug('[SCAN_STAGING_PRUNE]', { deleted: r.deleted, bytesFreed: r.bytesFreed });
   }
 });
 }

 // Photos bucket is private; do not use getPublicUrl. Callers must use getSignedPhotoUrl(storagePath) for display.
 // Return null (not '') so callers can distinguish "no URL" from "empty string URL" consistently.
 return {
 storagePath,
 storageUrl: null,
 thumbnailLocalUri: thumbnailLocalUri ?? undefined,
 };
 } catch (error) {
 const err = error as Error;
 logger.info('[STEP_B]', 'upload_err', { photoId, code: 'exception', message: err?.message ?? String(error) });
 logger.error('Error uploading photo:', error);
 return null;
 }
}

/**
 * Download a photo from Supabase Storage to local cache. Uses signed URL (photos bucket is private).
 */
export async function downloadPhotoFromStorage(
 storagePathOrLegacyUrl: string,
 photoId: string
): Promise<string | null> {
 const cacheDir = getPhotoCacheDir();
 if (!cacheDir) {
 logger.warn('Cache directory not available for photo download');
 return null;
 }

 if (!storagePathOrLegacyUrl || typeof storagePathOrLegacyUrl !== 'string' || !storagePathOrLegacyUrl.trim()) {
 logger.warn('Invalid storage path/URL provided for photo download:', storagePathOrLegacyUrl);
 return null;
 }

 try {
 const dirInfo = await FileSystem.getInfoAsync(cacheDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
 }

 const fullPath = `${cacheDir}${photoId}.jpg`;

 const existingFile = await FileSystem.getInfoAsync(fullPath);
 if (existingFile.exists) {
 return fullPath;
 }

 let downloadUrl: string;
 if (storagePathOrLegacyUrl.startsWith('http://') || storagePathOrLegacyUrl.startsWith('https://')) {
 downloadUrl = storagePathOrLegacyUrl;
 } else {
 try {
 downloadUrl = await getSignedPhotoUrl(storagePathOrLegacyUrl);
 } catch {
 return null;
 }
 }

 const downloadResult = await FileSystem.downloadAsync(downloadUrl, fullPath);

 if (downloadResult.uri) {
 return fullPath;
 }

 return null;
 } catch (error) {
 logger.error('Error downloading photo from storage:', error);
 return null;
 }
}

/**
 * Save a photo to Supabase (both storage and database).
 *
 * Photo model: Option A one photo per unique image per user.
 * We never create a second photos row for the same (user_id, image_hash). If a row exists
 * for that hash we reuse it (link job + backfill books) and skip insert. On unique constraint
 * violation we fetch the existing row and treat it as the effective photo id.
 */
export type SavePhotoOptions = {
 /** When server already has a different photoId for this job, call with (jobId, localPhotoId, canonicalPhotoId) so client can adopt canonical id. */
 onAdoptedCanonical?: (jobId: string, localPhotoId: string, canonicalPhotoId: string) => void;
 /**
  * Override the photo status written to the DB via patchPhotoLifecycle.
  * Use 'complete' during approve to ensure the DB row is stamped complete even when
  * photo.status is still 'draft' (photo was uploaded in a prior step but the local
  * object hasn't been updated yet). Only applied when the row has a valid storage_path.
  */
 statusOverride?: Photo['status'];
 /** Number of approved books for this photo — written to photos.approved_count. */
 approvedCountOverride?: number;
};

export type SavePhotoResult = {
  ok: boolean;
  canonicalPhotoId: string | null;
  /**
   * storage_path of the canonical DB row (non-null when a dedupe happened).
   * Callers should patch the in-memory photo object with this value so that
   * the photo has valid storage info and is never classified as "corrupt".
   */
  canonicalStoragePath?: string | null;
  /** storage_url of the canonical DB row (may be empty string — prefer storage_path). */
  canonicalStorageUrl?: string | null;
  /** Precomputed thumbnail file URI (cache) for grids; set on photo.thumbnail_uri so grid doesn't do work per render. */
  thumbnailLocalUri?: string | null;
};

export async function savePhotoToSupabase(
 userId: string,
 photo: Photo,
 options?: SavePhotoOptions
): Promise<SavePhotoResult> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping photo save');
 return { ok: false, canonicalPhotoId: null };
 }

 // Skip Supabase for guest users
 if (userId === 'guest_user') {
 return { ok: false, canonicalPhotoId: null }; // Silently skip - guest users save locally only
 }

const localPhotoId = photo.id ?? '';
const jobId = photo.jobId ?? (photo as { jobId?: string }).jobId ?? '';
const photoHash = typeof photo.photoFingerprint === 'string' && photo.photoFingerprint.trim() ? photo.photoFingerprint.trim() : null;
// Tracks the canonical photo row id as it gets resolved (may differ from localPhotoId after dedupe).
// Returned to callers so they can use the correct id for FK patches instead of the local id.
let _canonicalPhotoId: string | null = photo.id ?? null;

// Per-call timing breakdown — each phase records elapsed since the previous checkpoint.
// Emitted as [PHOTO_SAVE_TIMING_BREAKDOWN] at every return path so we can attribute
// the photo_save latency (sometimes 6–15 s) to a specific phase.
const _t0 = Date.now();
const _timing = { uploadMs: 0, hashLookupMs: 0, jobLookupMs: 0, upsertMs: 0, lifecycleMs: 0, barrierMs: 0 };
let _tLast = _t0;
const _tick = (phase: keyof typeof _timing) => {
  const now = Date.now();
  _timing[phase] += now - _tLast;
  _tLast = now;
};
const _emitBreakdown = (path: string, result: { ok: boolean }) => {
  const totalMs = Date.now() - _t0;
  logger.info('[PHOTO_SAVE_TIMING_BREAKDOWN]', {
    path,
    localPhotoId: localPhotoId.slice(0, 8),
    ok: result.ok,
    totalMs,
    ...Object.fromEntries(
      Object.entries(_timing).filter(([, v]) => v > 0)
    ),
  });
};
 // Use caller's statusOverride if provided (e.g. 'complete' during approve), else fall back
 // to the photo object's own status field. DB allows only 'draft' | 'complete' | 'discarded'.
 const rawPhotoStatus = options?.statusOverride ?? photo.status;
 const { status: statusDb, processingStage } = normalizePhotoStatusForDb(rawPhotoStatus);
 const photoStatus = statusDb;
 const approvedCount = options?.approvedCountOverride ?? (typeof photo.approved_count === 'number' ? photo.approved_count : undefined);
 // Log only when jobId is present (scan-related); avoid per-photo spam for legacy/library photos.
 if (jobId) {
 logger.debug('[PHOTO_SAVE_INPUT]', 'job-linked photo', {
 userId,
 localPhotoId,
 jobId: String(jobId).slice(0, 36),
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 incomingPhotoRowId: photo.id ?? null,
 });
 }

 try {
// knownStoragePath: if the caller already knows the storage_path (e.g. just after upload),
// pass it here to skip the inner DB SELECT. Avoids a round-trip and eliminates the race
// where the row isn't visible to SELECT yet right after upsert.
const patchPhotoLifecycle = async (photoId: string, knownStoragePath?: string | null) => {
  if (!photoId) return;
  if (photoStatus == null && approvedCount == null) return;
  // Critical guard:
  // Never mutate lifecycle on a different pre-existing photo row adopted by hash.
  // That can "revive" old scans (complete/discarded drift) when approving a new instance.
  if (localPhotoId && localPhotoId !== photoId) {
    logger.debug('[PHOTO_LIFECYCLE_PATCH_SKIPPED]', {
      reason: 'hash_adopted_different_photo_row',
      localPhotoId,
      targetPhotoId: photoId,
      status: photoStatus ?? null,
      approvedCount: approvedCount ?? null,
    });
    return;
  }
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  // Guard: never write status='complete' on a row that has no storage_path.
  // Use knownStoragePath when available (no DB round-trip); fall back to a DB query only
  // when the caller doesn't know the path (e.g. hash-adopt early-return paths).
  if (photoStatus != null) {
    if (photoStatus === 'complete') {
      let hasStoragePath = !!(knownStoragePath?.trim?.().length);
      if (!hasStoragePath) {
        const { data: existingRow } = await supabase
          .from('photos')
          .select('storage_path')
          .eq('id', photoId)
          .eq('user_id', userId)
          .maybeSingle();
        hasStoragePath = !!((existingRow as any)?.storage_path?.trim?.().length);
      }
      if (!hasStoragePath) {
        logger.debug('[PHOTO_LIFECYCLE_PATCH_DEFERRED]', {
          reason: 'no_storage_path_on_row',
          photoId,
          requestedStatus: photoStatus,
          effectiveStatus: 'draft',
        });
        patch.status = 'draft';
      } else {
        patch.status = photoStatus;
      }
    } else {
      patch.status = photoStatus;
    }
  }
  if (approvedCount != null) patch.approved_count = approvedCount;
  await supabase
    .from('photos')
    .update(patch)
    .eq('id', photoId)
    .eq('user_id', userId);
};

 // If there is no URI but the photo already has a storage_path (already uploaded), we can still
 // run the lifecycle patch (status, approved_count) the upload step is simply skipped.
 // This prevents approved_count from staying 0 when the signed URL has expired or was never cached.
 const existingStoragePath =
 (photo as any).storage_path &&
 typeof (photo as any).storage_path === 'string' &&
 ((photo as any).storage_path as string).trim().length > 0
 ? ((photo as any).storage_path as string).trim()
 : null;

 if (!photo.uri || typeof photo.uri !== 'string') {
 if (existingStoragePath) {
 // Already on storage — patch lifecycle and return. Pass path as hint to skip inner DB SELECT.
 await patchPhotoLifecycle(photo.id ?? '', existingStoragePath);
 logger.debug('[PHOTO_SAVE_LIFECYCLE_ONLY]', {
 photoId: photo.id ?? null,
 storage_path: existingStoragePath,
 status: photoStatus ?? null,
 approved_count: approvedCount ?? null,
 reason: 'no_uri_but_has_storage_path',
 });
 return { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: existingStoragePath, canonicalStorageUrl: null };
 }
 logger.error('Invalid photo URI (and no storage_path):', photo.uri);
 return { ok: false, canonicalPhotoId: _canonicalPhotoId };
 }

 // Upload photo to storage
 // Use null (not '') for missing values so every falsy check (!storageUrl, !storagePath)
 // and every explicit null check is consistent. Empty string is treated as missing by some
 // callers and as present by others null has unambiguous semantics everywhere.
 let storagePath: string | null = null;
 let storageUrl: string | null = null;
 let _thumbnailLocalUri: string | null = null;

 // Check if photo.uri is already a storage URL (legacy public URL); we only store path and use signed URLs now
 if (photo.uri && photo.uri.startsWith('http') && photo.uri.includes('supabase.co')) {
 const urlParts = photo.uri.split('/');
 const pathIndex = urlParts.findIndex(part => part === 'photos');
 if (pathIndex !== -1) {
 storagePath = urlParts.slice(pathIndex + 1).join('/'); // path after bucket name
 }
 storageUrl = null; // Do not persist public URL; use signed URL at display time
 } else if (photo.uri && !photo.uri.startsWith('http')) {
// Only upload if it's a local file path (not already a URL)
// Skip upload if file doesn't exist (old temporary files)
const uploadResult = await uploadPhotoToStorage(userId, photo.id, photo.uri);
_tick('uploadMs');
if (!uploadResult) {
 // If upload fails (e.g., file doesn't exist), but photo already has books,
 // we can still save the metadata if it's already in Supabase
 logger.warn(`Failed to upload photo ${photo.id} to storage, but continuing with metadata save`);
 // Try to get existing storage info from database
 const { data: existingPhoto } = await supabase
 .from('photos')
 .select('storage_path, storage_url')
 .eq('id', photo.id)
 .single();
 
 if (existingPhoto?.storage_path) {
 storagePath = existingPhoto.storage_path;
 // Normalise: treat '' the same as null so callers can rely on null === missing
 const rawUrl = (existingPhoto as { storage_url?: string | null }).storage_url ?? null;
 storageUrl = rawUrl && rawUrl.trim().length > 0 ? rawUrl : null;
 } else {
 // No existing storage info and upload failed - skip saving
 logger.error(` Cannot save photo ${photo.id}: no storage path and upload failed`);
 logger.error(' This usually means:');
 logger.error(' 1. The storage bucket "photos" does not exist');
 logger.error(' 2. Storage bucket RLS policies are not set up');
 logger.error(' 3. The photo file does not exist locally');
 logger.error(' SOLUTION: Check SUPABASE_SETUP_INSTRUCTIONS.md for storage setup');
 return { ok: false, canonicalPhotoId: _canonicalPhotoId };
 }
 } else {
 storagePath = uploadResult.storagePath;
 // Photos bucket: we do not persist public URL store null, not ''
 storageUrl = null;
 _thumbnailLocalUri = uploadResult.thumbnailLocalUri ?? null;
 }
 } else {
 // Photo has no valid URI - skip saving
 logger.warn(`Photo ${photo.id} has no valid URI, skipping save`);
 return { ok: false, canonicalPhotoId: _canonicalPhotoId };
 }

// B) Idempotent by hash: if DB has a row for (user_id, image_hash), reuse it and skip insert (avoids 23505 unique_photo_per_user_hash).
const imageHash = photoHash;
let chosenEffectivePhotoId: string = photo.id ?? '';
if (imageHash) {
const { data: existingByHash } = await supabase
.from('photos')
.select('id')
.eq('user_id', userId)
.eq('image_hash', imageHash)
.is('deleted_at', null)
.maybeSingle();
_tick('hashLookupMs');
   if (existingByHash?.id) {
      chosenEffectivePhotoId = existingByHash.id;
      _canonicalPhotoId = existingByHash.id; // dedupe: canonical != local
      // Register so callers can resolve localId→canonicalId and know this ID is protected.
      if (localPhotoId && localPhotoId !== existingByHash.id) {
        registerDedupe(localPhotoId, existingByHash.id);
      } else {
        markCanonical(existingByHash.id);
      }
      logger.info('[PHOTO_SAVE_REUSED_BY_HASH]', {
 userId,
 localPhotoId,
 jobId: jobId ? String(jobId).slice(0, 36) : '',
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 chosenEffectivePhotoId: existingByHash.id,
 });
 // Link this job to the existing photo and backfill/migrate books; skip insert.
 if (photo.jobId) {
 const rawJobId = toRawScanJobUuid(photo.jobId);
 if (rawJobId) {
 await supabase
 .from('scan_jobs')
 .update({ photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
 .eq('job_uuid', rawJobId)
 .eq('user_id', userId);
 const backfillKey = `${userId}:${rawJobId}`;
 if (!didBackfillJobIds.has(backfillKey)) {
 didBackfillJobIds.add(backfillKey);
 const { data: updated } = await supabase
 .from('books')
 .update({ source_photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
 .eq('user_id', userId)
 .eq('source_scan_job_id', rawJobId)
 .is('source_photo_id', null)
 .select('id');
 if (updated?.length && updated.length > 0) {
 logger.debug('[BACKFILL] jobId=' + (photo.jobId ?? '').slice(0, 20) + ' reusedByHash, updated=' + updated.length);
 }
 }
 }
 }
 // Photo dedupe migration: rewrite books that still point at the old (local) photo id to the canonical one.
 if (localPhotoId && localPhotoId !== chosenEffectivePhotoId) {
 const { data: migrated, error: migrateErr } = await supabase
 .from('books')
 .update({ source_photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
 .eq('user_id', userId)
 .eq('source_photo_id', localPhotoId)
 .is('deleted_at', null)
 .select('id');
 if (!migrateErr && migrated?.length && migrated.length > 0) {
 logger.info('[PHOTO_DEDUPE_MIGRATION] books source_photo_id rewritten', { from: localPhotoId, to: chosenEffectivePhotoId, count: migrated.length });
 }
 }
    await patchPhotoLifecycle(chosenEffectivePhotoId);
    _tick('lifecycleMs');
    {
      const { data: _row } = await supabase.from('photos').select('id, status, storage_path, storage_url, deleted_at').eq('id', chosenEffectivePhotoId).maybeSingle();
      _tick('barrierMs');
      const _ret = { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: (_row as any)?.storage_path ?? null, canonicalStorageUrl: (_row as any)?.storage_url ?? null };
      logger.debug('[PHOTO_SAVE_UPSERT]', { chosenEffectivePhotoId, resultId: chosenEffectivePhotoId, reusedByHash: true, row_id: _row?.id ?? null, row_status: (_row as any)?.status ?? null, row_storage_path: (_row as any)?.storage_path ?? null, row_storage_url: (_row as any)?.storage_url ?? null, row_deleted_at: (_row as any)?.deleted_at ?? null });
      _emitBreakdown('hash_reuse_early', _ret);
      return _ret;
    }
    }
  }

// C) Invariant: a job has exactly one canonical photoId; once set on server, client adopts it and does not create a new photo row.
if (photo.jobId) {
const rawJobId = toRawScanJobUuid(photo.jobId);
if (rawJobId) {
const { data: jobRow } = await supabase
.from('scan_jobs')
.select('photo_id')
.eq('user_id', userId)
.eq('job_uuid', rawJobId)
.maybeSingle();
_tick('jobLookupMs');
const scanJobsPhotoId = jobRow?.photo_id ?? null;
if (jobRow?.photo_id != null && jobRow.photo_id !== photo.id) {
 // Job already has canonical photoId on server adopt it (don't attempt new insert); client rewrites local refs via onAdoptedCanonical.
 const { data: localPhotoRow } = await supabase
 .from('photos')
 .select('id')
 .eq('id', photo.id)
 .maybeSingle();
 const localPhotoIdExistsInDb = !!localPhotoRow?.id;
 logger.info('[PHOTO_SAVE] job already has different photoId adopt canonical', {
 jobId: rawJobId.slice(0, 36),
 localPhotoId: photo.id,
 existingPhotoId: jobRow.photo_id,
 localPhotoIdExistsInDb,
 });
     await patchPhotoLifecycle(jobRow.photo_id);
      _tick('lifecycleMs');
      _canonicalPhotoId = jobRow.photo_id; // job-level adoption: canonical != local
      // Register canonical mapping so delete paths and callers can detect canonical IDs.
      registerDedupe(photo.id ?? localPhotoId, jobRow.photo_id);
      options?.onAdoptedCanonical?.(String(photo.jobId), photo.id ?? '', jobRow.photo_id);
      {
        const { data: _cRow } = await supabase.from('photos').select('storage_path, storage_url').eq('id', _canonicalPhotoId).maybeSingle();
        _tick('barrierMs');
        const _ret = { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: (_cRow as any)?.storage_path ?? null, canonicalStorageUrl: (_cRow as any)?.storage_url ?? null };
        _emitBreakdown('job_adopt_early', _ret);
        return _ret;
      }
}
 chosenEffectivePhotoId = (scanJobsPhotoId ?? photo.id) ?? '';
 _canonicalPhotoId = chosenEffectivePhotoId || _canonicalPhotoId;
 logger.debug('[PHOTO_SAVE_JOB_LOOKUP]', {
 userId,
 localPhotoId,
 jobId: rawJobId.slice(0, 36),
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 scanJobsPhotoId,
 chosenEffectivePhotoId,
 });
 }
 }

 // Sanitize user-facing strings before DB insert
 const caption = sanitizeTextForDb(photo.caption);
 const books = Array.isArray(photo.books) ? photo.books.map((b: Book) => sanitizeBookForDb(b as object) as Book) : [];

 // timestamp: BIGINT (epoch ms). Never null when upserting.
 const timestampMs = (typeof photo.timestamp === 'number' && photo.timestamp > 0) ? photo.timestamp : Date.now();
 const photoData: any = {
 id: photo.id,
 user_id: userId,
 storage_path: storagePath,
 storage_url: storageUrl,
 books,
 timestamp: timestampMs,
 caption: caption ?? null,
 updated_at: new Date().toISOString(),
 };
 photoData.status = photoStatus;
 if (processingStage != null) photoData.processing_stage = processingStage;
 if (approvedCount != null) {
 photoData.approved_count = approvedCount;
 }
 if (imageHash) {
 photoData.image_hash = imageHash;
 }
 
 // If uri column exists (legacy), set to local uri only; do not persist public storage URL
 if (photo.uri && !photo.uri.startsWith('http')) {
 photoData.uri = photo.uri;
 }
 // storage_url is written as '' for photos bucket; display uses getSignedPhotoUrl(storage_path)

// Pre-upsert re-check by (user_id, image_hash) to avoid 23505 race: another save may have inserted between our first check and now.
if (imageHash) {
const { data: existingPreUpsert } = await supabase
.from('photos')
.select('id')
.eq('user_id', userId)
.eq('image_hash', imageHash)
.is('deleted_at', null)
.maybeSingle();
_tick('hashLookupMs');
 if (existingPreUpsert?.id) {
      chosenEffectivePhotoId = existingPreUpsert.id;
      // Fix: this path previously omitted updating _canonicalPhotoId, so callers received the
      // original local photo id as canonical even though a dedupe happened.
      _canonicalPhotoId = existingPreUpsert.id;
      if (localPhotoId && localPhotoId !== existingPreUpsert.id) {
        registerDedupe(localPhotoId, existingPreUpsert.id);
      } else {
        markCanonical(existingPreUpsert.id);
      }
      logger.info('[PHOTO_SAVE_REUSED_BY_HASH]', {
        userId,
        localPhotoId,
        jobId: jobId ? String(jobId).slice(0, 36) : '',
        photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
        chosenEffectivePhotoId: existingPreUpsert.id,
        at: 'pre_upsert',
      });
 if (photo.jobId) {
 const rawJobId = toRawScanJobUuid(photo.jobId);
 if (rawJobId) {
 await supabase
 .from('scan_jobs')
 .update({ photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
 .eq('job_uuid', rawJobId)
 .eq('user_id', userId);
 const backfillKey = `${userId}:${rawJobId}`;
 if (!didBackfillJobIds.has(backfillKey)) {
 didBackfillJobIds.add(backfillKey);
 await supabase
 .from('books')
 .update({ source_photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
 .eq('user_id', userId)
 .eq('source_scan_job_id', rawJobId)
 .is('source_photo_id', null)
 .select('id');
 }
 }
 }
      await patchPhotoLifecycle(chosenEffectivePhotoId);
      _tick('lifecycleMs');
      {
        const { data: _row } = await supabase.from('photos').select('id, status, storage_path, storage_url, deleted_at').eq('id', chosenEffectivePhotoId).maybeSingle();
        _tick('barrierMs');
        logger.debug('[PHOTO_SAVE_UPSERT]', { chosenEffectivePhotoId, resultId: chosenEffectivePhotoId, reusedByHashPreUpsert: true, row_id: _row?.id ?? null, row_status: (_row as any)?.status ?? null, row_storage_path: (_row as any)?.storage_path ?? null, row_storage_url: (_row as any)?.storage_url ?? null, row_deleted_at: (_row as any)?.deleted_at ?? null });
        const _ret = { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: (_row as any)?.storage_path ?? null, canonicalStorageUrl: (_row as any)?.storage_url ?? null };
        _emitBreakdown('pre_upsert_hash_reuse', _ret);
        return _ret;
      }
      }
    }

    // Precheck before DB write: if job already has a different photoId on server, adopt canonical and skip insert (no DB error, no toast).
 let scanJobsPhotoIdPre: string | null = null;
 if (photo.jobId) {
 const rawJobIdPre = toRawScanJobUuid(photo.jobId);
 if (rawJobIdPre) {
const { data: jobRowPre } = await supabase
.from('scan_jobs')
.select('photo_id')
.eq('user_id', userId)
.eq('job_uuid', rawJobIdPre)
.maybeSingle();
_tick('jobLookupMs');
scanJobsPhotoIdPre = jobRowPre?.photo_id ?? null;
if (scanJobsPhotoIdPre != null && scanJobsPhotoIdPre !== localPhotoId) {
logger.debug('[PHOTO_SAVE_PRECHECK] adopt canonical and skip insert', {
jobId: rawJobIdPre.slice(0, 36),
localPhotoId,
scanJobsPhotoId: scanJobsPhotoIdPre,
});
     await patchPhotoLifecycle(scanJobsPhotoIdPre);
      _tick('lifecycleMs');
      _canonicalPhotoId = scanJobsPhotoIdPre; // pre-check adoption: canonical != local
      // Register canonical mapping so delete paths and callers can detect canonical IDs.
      registerDedupe(localPhotoId, scanJobsPhotoIdPre);
      options?.onAdoptedCanonical?.(String(photo.jobId), localPhotoId, scanJobsPhotoIdPre);
      {
        const { data: _cRow } = await supabase.from('photos').select('storage_path, storage_url').eq('id', _canonicalPhotoId).maybeSingle();
        _tick('barrierMs');
        const _ret = { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: (_cRow as any)?.storage_path ?? null, canonicalStorageUrl: (_cRow as any)?.storage_url ?? null };
        _emitBreakdown('precheck_adopt_early', _ret);
        return _ret;
      }
}
 }
 }
 const cachedExistingPhotoId = (chosenEffectivePhotoId && chosenEffectivePhotoId !== photo.id) ? chosenEffectivePhotoId : null;
 logger.debug('[PHOTO_SAVE_PRECHECK]', {
 jobId: jobId ? String(jobId).slice(0, 36) : null,
 localPhotoId,
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 cachedExistingPhotoId: cachedExistingPhotoId ?? null,
 scanJobsPhotoId: scanJobsPhotoIdPre ?? null,
 });

 const upsertColumns = Object.keys(photoData).join(',');
 logger.debug('[PHOTO_SAVE_BEFORE_UPSERT]', 'upsert', {
 userId,
 localPhotoId,
 jobId: jobId ? String(jobId).slice(0, 36) : null,
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 incomingPhotoRowId: photo.id ?? null,
 effectivePhotoId: chosenEffectivePhotoId,
 table: 'photos',
 payloadColumns: upsertColumns,
 onConflict: 'id',
 });

const { data: upserted, error } = await supabase
.from('photos')
.upsert(photoData, {
onConflict: 'id',
})
.select('id, status, storage_path, storage_url, deleted_at')
.maybeSingle();
_tick('upsertMs');

const resultId = upserted?.id ?? photo.id ?? chosenEffectivePhotoId;
 logger.debug('[PHOTO_SAVE_UPSERT]', {
 userId,
 localPhotoId,
 jobId: jobId ? String(jobId).slice(0, 36) : null,
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 chosenEffectivePhotoId,
 resultId,
 // DB row state after write these are what the filter will see on next rehydrate
 row_id: upserted?.id ?? null,
 row_status: upserted?.status ?? null,
 row_storage_path: upserted?.storage_path ?? null,
 row_storage_url: upserted?.storage_url ?? null,
 row_deleted_at: upserted?.deleted_at ?? null,
 });

 if (error) {
 const err = error as { code?: string; details?: string; constraint?: string; message?: string };
 const errCode = err?.code;
 const errConstraint = err.constraint ?? (err.message?.includes('unique_photo_per_user_hash') ? 'unique_photo_per_user_hash' : undefined);
 const isDedupeConstraint = errCode === '23505' || errConstraint === 'unique_photo_per_user_hash';

 // A) Treat 23505 unique_photo_per_user_hash as normal dedupe path don't log as fatal; recover and return true.
 if (isDedupeConstraint && imageHash) {
 let existingRow: { id: string } | null = null;
 const { data: row1 } = await supabase
 .from('photos')
 .select('id')
 .eq('user_id', userId)
 .eq('image_hash', imageHash)
 .is('deleted_at', null)
 .limit(1)
 .maybeSingle();
 existingRow = row1 ?? null;
 if (!existingRow?.id) {
 await new Promise((r) => setTimeout(r, 150));
 const { data: row2 } = await supabase
 .from('photos')
 .select('id')
 .eq('user_id', userId)
 .eq('image_hash', imageHash)
 .is('deleted_at', null)
 .limit(1)
 .maybeSingle();
 existingRow = row2 ?? null;
 }
  if (!existingRow?.id) {
    // Last attempt: still enforce deleted_at IS NULL — never reuse a deleted photo row.
    // The original code omitted this filter as a "wider net" fallback, but that's the bug:
    // reusing a deleted row causes the scan to attach to a photo that immediately vanishes.
    const { data: row3 } = await supabase
      .from('photos')
      .select('id, deleted_at')
      .eq('user_id', userId)
      .eq('image_hash', imageHash)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    existingRow = row3 ?? null;
    if (!existingRow?.id) {
      // All three retries found no active row — 23505 constraint fired but the conflicting row
      // is soft-deleted. This means the unique index still covers deleted rows (e.g. a partial
      // unique index without WHERE deleted_at IS NULL). Log and fall through: caller should
      // retry the insert after a short delay or use an upsert that resurrects the deleted row.
      logger.warn('[PHOTO_SAVE_23505_DELETED_ROW]', {
        photoHash: imageHash.slice(0, 16),
        localPhotoId,
        note: 'unique_photo_per_user_hash conflict but all matching rows are soft-deleted — hash index covers deleted rows',
        hint: 'Consider adding WHERE deleted_at IS NULL to the unique index, or use an upsert that sets deleted_at=null on conflict',
      });
    }
  }
  // If no active row found (all three retries returned nothing), check if there is a
  // soft-deleted row with this hash. Since the migration fix-photo-hash-index-partial.sql
  // makes the unique index partial (WHERE deleted_at IS NULL), a 23505 with no active row
  // should not happen on updated schemas — but handle it defensively for older schemas.
  if (!existingRow?.id) {
    const { data: deletedRow } = await supabase
      .from('photos')
      .select('id, deleted_at')
      .eq('user_id', userId)
      .eq('image_hash', imageHash)
      .not('deleted_at', 'is', null)
      .limit(1)
      .maybeSingle();
    if (deletedRow?.id) {
      // Resurrect: clear deleted_at and update storage info so this row becomes active again.
      // This is safer than leaving it in limbo or returning an error.
      const { data: resurrected } = await supabase
        .from('photos')
        .update({
          deleted_at: null,
          storage_path: photoData.storage_path ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deletedRow.id)
        .select('id')
        .maybeSingle();
      if (resurrected?.id) {
        existingRow = resurrected;
        logger.info('[PHOTO_SAVE_23505_RESURRECTED]', {
          photoHash: imageHash.slice(0, 16),
          localPhotoId,
          resurrectedId: resurrected.id,
          note: 'deleted row resurrected — unique index covers deleted rows; run fix-photo-hash-index-partial.sql migration to fix permanently',
        });
      }
    }
  }
  logger.info('[PHOTO_SAVE_23505]', {
    photoHash: imageHash.slice(0, 16) + '',
    localPhotoId,
    rowExistsForHash: !!existingRow?.id,
    existingPhotoId: existingRow?.id ?? null,
  });
    if (existingRow?.id) {
        chosenEffectivePhotoId = existingRow.id;
        // Fix: 23505 path was setting chosenEffectivePhotoId but not _canonicalPhotoId, so
        // callers got back the original local ID as canonical. Update both here.
        _canonicalPhotoId = existingRow.id;
        // Register so resolveCanonical() and isCanonical() work correctly at delete sites.
        if (localPhotoId && localPhotoId !== existingRow.id) {
          registerDedupe(localPhotoId, existingRow.id);
        } else {
          markCanonical(existingRow.id);
        }
        logger.info('[PHOTO_SAVE_DEDUPE]', 'photo deduped; reused existing photo row', {
          localPhotoId,
          chosenEffectivePhotoId: existingRow.id,
          jobId: jobId ? String(jobId).slice(0, 36) : null,
        });
        await patchPhotoLifecycle(chosenEffectivePhotoId);
        _tick('lifecycleMs');
        let _dedupeSP: string | null = null;
        let _dedupeSU: string | null = null;
        {
          const { data: _row } = await supabase.from('photos').select('id, status, storage_path, storage_url, deleted_at').eq('id', chosenEffectivePhotoId).maybeSingle();
          _tick('barrierMs');
          logger.debug('[PHOTO_SAVE_UPSERT]', { chosenEffectivePhotoId, resultId: existingRow.id, recoveredFromUniqueViolation: true, row_id: _row?.id ?? null, row_status: (_row as any)?.status ?? null, row_storage_path: (_row as any)?.storage_path ?? null, row_storage_url: (_row as any)?.storage_url ?? null, row_deleted_at: (_row as any)?.deleted_at ?? null });
          _dedupeSP = (_row as any)?.storage_path ?? null;
          _dedupeSU = (_row as any)?.storage_url ?? null;
        }
        if (photo.jobId) {
          const rawJobId = toRawScanJobUuid(photo.jobId);
          if (rawJobId) {
            await supabase
              .from('scan_jobs')
              .update({ photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
              .eq('job_uuid', rawJobId)
              .eq('user_id', userId);
            const backfillKey = `${userId}:${rawJobId}`;
            if (!didBackfillJobIds.has(backfillKey)) {
              didBackfillJobIds.add(backfillKey);
              await supabase
                .from('books')
                .update({ source_photo_id: chosenEffectivePhotoId, updated_at: new Date().toISOString() })
                .eq('user_id', userId)
                .eq('source_scan_job_id', rawJobId)
                .is('source_photo_id', null)
                .select('id');
            }
          }
        }
        const _dedupeRet = { ok: true, canonicalPhotoId: _canonicalPhotoId, canonicalStoragePath: _dedupeSP, canonicalStorageUrl: _dedupeSU };
        _emitBreakdown('23505_dedupe_recovery', _dedupeRet);
        return _dedupeRet;
}
}
// Only log as failure when we did not recover (so UI/toast don't treat benign dedupe as failure).
 logger.error('[PHOTO_SAVE_DB_ERROR]', {
 errCode: err.code,
 errDetails: err.details,
 errConstraint: err.constraint,
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 localPhotoId,
 jobId: jobId ? String(jobId).slice(0, 36) : null,
 });
 logger.warn('[APPROVE_SAVE_PHOTO_FAIL]', {
 userId,
 localPhotoId,
 jobId: jobId ? String(jobId).slice(0, 36) : null,
 photoHash: photoHash ? photoHash.slice(0, 16) + '' : null,
 code: errCode,
 constraint: errConstraint,
 err: err.message ?? String(error),
 });
 const errorMessage = error?.message || error?.code || JSON.stringify(error) || String(error);
 logger.error('Error saving photo to database:', errorMessage);
 const booksSample = (photo.books ?? []).slice(0, 5);
 logger.error('DB_SAVE_FAIL_SAMPLE', {
 caption: photo.caption != null ? debugString(String(photo.caption)) : null,
 books: booksSample.map((b: Book) => ({
 title: debugString(String((b as any).title ?? '')),
 author: debugString(String((b as any).author ?? '')),
 })),
 });
 if (errorMessage.includes('storage_path') || errorMessage.includes('column')) {
 logger.error(' Database schema issue: The photos table may be missing columns.');
 logger.error(' Please run the migration: supabase-migration-add-photos-table.sql');
 }
 return { ok: false, canonicalPhotoId: _canonicalPhotoId };
 }

 // Provenance: link scan_job to this photo (only when photo_id is null immutable after first set).
 // Backfill scope: only books created by this scan job (source_scan_job_id = rawJobId).
 if (photo.jobId) {
 const rawJobId = toRawScanJobUuid(photo.jobId);
 if (rawJobId) {
 await supabase
 .from('scan_jobs')
 .update({ photo_id: photo.id, updated_at: new Date().toISOString() })
 .eq('job_uuid', rawJobId)
 .eq('user_id', userId);
 const backfillKey = `${userId}:${rawJobId}`;
 if (!didBackfillJobIds.has(backfillKey)) {
 didBackfillJobIds.add(backfillKey);
 // Scope backfill only to books created by this scan job (source_scan_job_id = rawJobId)
 const { data: updated } = await supabase
 .from('books')
 .update({ source_photo_id: photo.id, updated_at: new Date().toISOString() })
 .eq('user_id', userId)
 .eq('source_scan_job_id', rawJobId)
 .is('source_photo_id', null)
 .select('id');
 if (updated?.length && updated.length > 0) {
 logger.debug('[BACKFILL] jobId=' + (photo.jobId ?? '').slice(0, 20) + ' updated=' + updated.length + ' (scoped to source_scan_job_id=' + rawJobId + ')');
 }
 }
  }
  }

  // Happy path: photo was successfully upserted — mark the ID as canonical.
  if (_canonicalPhotoId) markCanonical(_canonicalPhotoId);

  // Return storagePath so callers (ScansTab canonicalStorageMap) can hydrate
  // local photo objects that still have null storage fields from scan ingestion.
  // Without this, canonicalStorageMap gets {storagePath: null} and the photo
  // stays 'draft' forever, causing photosWithApprovedBooks to drop it.
  const _upsertedStoragePath = upserted?.storage_path ?? storagePath ?? null;
  const _upsertedStorageUrl = upserted?.storage_url ?? storageUrl ?? null;
  const _happyRet = {
    ok: true,
    canonicalPhotoId: _canonicalPhotoId,
    canonicalStoragePath: _upsertedStoragePath,
    canonicalStorageUrl: _upsertedStorageUrl,
    thumbnailLocalUri: _thumbnailLocalUri,
  };
  _emitBreakdown('upsert_success', _happyRet);
  return _happyRet;
} catch (error) {
  logger.error('Error saving photo to Supabase:', error);
  const _errRet = { ok: false, canonicalPhotoId: _canonicalPhotoId };
  _emitBreakdown('exception', _errRet);
  return _errRet;
}
}

/**
 * Load all photos from Supabase for a user.
 * Pass options.signal (e.g. libraryAbortControllerRef) to cancel when user switches — do NOT pass scan abort signal.
 */
export async function loadPhotosFromSupabase(userId: string, options?: { signal?: AbortSignal }): Promise<Photo[]> {
 if (!supabase) {
 logger.warn('Supabase not available, returning empty photos');
 return [];
 }

 try {
 // Delegate to fetchAllPhotos for the canonical photo snapshot.
 // fetchAllPhotos uses count-guided pagination that works even when the
 // server-side PostgREST max-rows cap is as low as 1.
 const rawData = await fetchAllPhotos(userId, options?.signal);

 if (rawData.length === 0) {
   return [];
 }

 // Include ALL non-deleted photos so that photos awaiting storage upload (e.g.
 // deduped canonical rows that haven't propagated yet) still enter client state
 // and can be matched to their books. Photos without storage can show a placeholder.
 // We only hard-exclude rows with no id at all.
 const allRows = rawData.filter(
 (row) => row.id && typeof row.id === 'string' && row.id.trim().length > 0
 );
 // Rows with usable storage for signed-URL generation or direct display.
 const rowsWithStorage = allRows.filter(
 (row) =>
 (row.storage_path && typeof row.storage_path === 'string' && row.storage_path.trim().length > 0) ||
 (row.storage_url && typeof row.storage_url === 'string' && row.storage_url.startsWith('http'))
 );
// Join keys must be full UUIDs only. Filter out any truncated/prefix ids so we never use them as map keys.
const rawPhotoIds = allRows
  .map((row) => row.id)
  .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
const photoIds = rawPhotoIds.filter((id) => isPhotoKeyValid(canon(id)));
if (rawPhotoIds.length > photoIds.length) {
  logger.warn('[PHOTO_ATTACH_JOIN]', 'dropped non-UUID photo ids (join uses full UUID only)', {
    total: rawPhotoIds.length,
    validUuids: photoIds.length,
    dropped: rawPhotoIds.length - photoIds.length,
  });
}
const booksByPhotoId = new Map<string, Book[]>();
if (photoIds.length > 0) {
   // Paginate the linkage query — also subject to PostgREST max-rows cap.
   const LINK_PAGE_SIZE = 1000;
   const allLinkedRows: any[] = [];
   let linkPage = 0;
   let linkFetching = true;
   while (linkFetching) {
     if (options?.signal?.aborted) break;
     const from = linkPage * LINK_PAGE_SIZE;
     const to = from + LINK_PAGE_SIZE - 1;
     let linkQ = supabase.from('books').select('id, title, author, status, deleted_at, source_photo_id, source_scan_job_id, book_key, created_at, updated_at').eq('user_id', userId).is('deleted_at', null).in('source_photo_id', photoIds).range(from, to);
     if (options?.signal) linkQ = linkQ.abortSignal(options.signal);
     const { data: linkedRows, error: linkedError } = await linkQ;
     if (linkedError) {
       logger.warn('[LOAD_PHOTOS_LINKAGE]', {
         ok: false,
         message: linkedError.message ?? String(linkedError),
         photoCount: photoIds.length,
         page: linkPage,
       });
       linkFetching = false;
       break;
     }
     const page = linkedRows ?? [];
     allLinkedRows.push(...page);
     if (page.length < LINK_PAGE_SIZE) {
       linkFetching = false;
     } else {
       linkPage++;
     }
   }
  const normalizedPhotoIdSet = new Set(photoIds.map((p) => canon(p)));
  // Attach all linked books (pending + approved) to each photo so Photos grid can show photos with pending books.
  // Join keys = full UUID only (canon). Never use slice(0, 8) or prefix as key.
  allLinkedRows.forEach((row: any) => {
    const rawPhotoId = row.source_photo_id as string | undefined;
    if (!rawPhotoId) return;
    const resolved = resolvePhotoIdForJoin(rawPhotoId, photoIds);
    const pid = canon(resolved);
    if (!pid || !isPhotoKeyValid(pid) || !normalizedPhotoIdSet.has(pid)) return;
    const mapped: Book = {
      id: row.id ?? undefined,
      dbId: row.id ?? undefined,
      title: row.title ?? '',
      author: row.author ?? undefined,
      status: row.status ?? undefined,
      book_key: row.book_key ?? undefined,
      source_photo_id: row.source_photo_id ?? undefined,
      sourcePhotoId: row.source_photo_id ?? undefined,
      photoId: row.source_photo_id ?? undefined,
      source_scan_job_id: row.source_scan_job_id ?? undefined,
      scanJobId: row.source_scan_job_id ?? undefined,
    };
    const arr = booksByPhotoId.get(pid) ?? [];
    arr.push(mapped);
    booksByPhotoId.set(pid, arr);
  });
  const approvedLinkedRows = allLinkedRows.filter((row: any) => row.status === 'approved');
  // Diagnostic: if booksFetched > 0 but firstPhotoBookCount === 0, join key mismatch (e.g. prefix vs full UUID).
  const booksFetched = allLinkedRows.length;
  const approvedFetched = approvedLinkedRows.length;
  const sampleSourcePhotoId = (allLinkedRows[0] as any)?.source_photo_id ?? null;
  const samplePhotoId = photoIds[0] ?? null;
  const firstPhotoBookCount = samplePhotoId ? (booksByPhotoId.get(canon(samplePhotoId))?.length ?? 0) : 0;
  // Log sample ids truncated for display only; join keys are always full UUIDs (photoIds filtered above).
  logger.info('[PHOTO_ATTACH_JOIN]', {
    booksFetched,
    approvedFetched,
    sampleBookSourcePhotoId: sampleSourcePhotoId?.slice?.(0, 12) ?? sampleSourcePhotoId,
    samplePhotoId: samplePhotoId?.slice?.(0, 12) ?? samplePhotoId,
    booksByPhotoIdKeysLength: booksByPhotoId.size,
    firstPhotoBookCount,
    joinKeyMismatch: booksFetched > 0 && firstPhotoBookCount === 0 && photoIds.length > 0,
  });
  // Invariant: every key must be full UUID so UI lookups by photo.id (UUID) never miss.
   for (const key of booksByPhotoId.keys()) {
     if (!isPhotoKeyValid(key)) {
       logger.warn('[PHOTO_BOOKS_MAP_INVARIANT]', 'photo→books map key is not a valid UUID; UI may show 0 books', {
         invalidKey: key,
         keyLength: key.length,
         expectedLength: 36,
         note: 'Map keys must be full UUID only; shorten only when logging.',
       });
     }
   }
 }

 // List fetch returns rows quickly; do NOT block on signed URLs here.
 // Each tile resolves storage_path → signed URL lazily (PhotoTile / getSignedPhotoUrl).
 // This prevents one slow/missing signed URL from delaying the whole grid and avoids
 // dropping drafts that don't have storage_path yet.
 const photos: Photo[] = allRows.map((row) => {
 const storagePath = row.storage_path && typeof row.storage_path === 'string' ? row.storage_path.trim() : undefined;
 const legacyUrl = row.storage_url && typeof row.storage_url === 'string' && row.storage_url.startsWith('http') ? row.storage_url : undefined;
 const uri = legacyUrl || '';
 return {
 id: row.id,
 uri: uri || '',
 books: booksByPhotoId.get(canon(row.id)) ?? ((row.books || []) as Book[]),
 timestamp: row.timestamp,
 caption: row.caption || undefined,
 storage_path: storagePath ?? (row.storage_path ?? undefined),
 storage_url: legacyUrl ?? null,
 photoFingerprint: (row as { image_hash?: string }).image_hash ?? undefined,
 status: (row as { status?: 'draft' | 'complete' | 'discarded' }).status ?? undefined,
 approved_count: typeof (row as { approved_count?: number }).approved_count === 'number'
 ? (row as { approved_count?: number }).approved_count
 : undefined,
 };
 });

 // Background download: use storage_path (signed URL inside) or legacy storage_url
 const pathOrUrl = (row: { storage_path?: string | null; storage_url?: string | null; id: string }) =>
 row.storage_path && row.storage_path.trim() ? row.storage_path : (row.storage_url || '');
 Promise.all(
 rowsWithStorage
 .filter((row) => pathOrUrl(row))
 .map((row) =>
 downloadPhotoFromStorage(pathOrUrl(row), row.id).catch(() => {})
 )
 ).catch(() => {});

  // Release-safe diagnostic: one line per sync. photosWithBooks = photos that have ≥1 book (pending or approved).
  const photosWithBooks = photos.filter((p) => (p.books?.length ?? 0) > 0).length;
  const photosWithApprovedOnly = photos.filter((p) => (p.books?.filter((b) => (b as any).status === 'approved').length ?? 0) > 0).length;
  const totalAttachedBooks = photos.reduce((sum, p) => sum + (p.books?.length ?? 0), 0);
  const samplePhotoCounts = photos
    .slice(0, 15)
    .map((p) => [p.id?.slice(0, 8) ?? '', p.books?.length ?? 0] as const);
  logger.info('[PHOTO_ATTACH_SUMMARY]', {
    photos: photos.length,
    photosWithBooks,
    photosWithApprovedOnly,
    totalAttachedBooks,
    samplePhotoCounts,
  });

  // When "complete but no books": run invariant check for first photo so we see which step is missing.
  if (photosWithBooks === 0 && photos.length > 0) {
    const first = photos[0];
    const photoId = first?.id?.trim();
    if (photoId && UUID_REGEX.test(photoId)) {
      Promise.resolve().then(async () => {
        try {
          const baseUrl = getApiBaseUrl();
          const headers = await getScanAuthHeaders();
          const res = await fetch(`${baseUrl}/api/photo-invariant?photoId=${encodeURIComponent(photoId)}`, { headers });
          const json = await res.json().catch(() => ({}));
          logger.info('[PHOTO_INVARIANT]', { photoId: photoId.slice(0, 8), ...json });
        } catch (e) {
          logger.warn('[PHOTO_INVARIANT]', 'check failed', { photoId: photoId?.slice(0, 8), err: (e as Error)?.message });
        }
      }).catch(() => {});
    }
  }

 return photos;
 } catch (error) {
 logger.error('Error loading photos from Supabase:', error);
 return [];
 }
}

/**
 * Server-truth: fetch all books attached to a single photo (source_photo_id = photoId).
 * Use this when opening the photo detail modal so TestFlight never relies on stale client merge.
 */
export async function fetchBooksForPhoto(userId: string, photoId: string): Promise<Book[]> {
  if (!supabase || !photoId?.trim()) return [];
  const { data: rows, error } = await supabase
    .from('books')
    .select('id, title, author, status, source_photo_id, source_scan_job_id, book_key')
    .eq('user_id', userId)
    .eq('source_photo_id', photoId)
    .is('deleted_at', null);
  if (error) {
    logger.warn('[fetchBooksForPhoto]', { photoId: photoId.slice(0, 8), error: error.message });
    return [];
  }
  return (rows ?? []).map((r: any) => ({
    id: r.id,
    dbId: r.id,
    title: r.title ?? '',
    author: r.author ?? undefined,
    status: r.status ?? undefined,
    book_key: r.book_key ?? undefined,
    source_photo_id: r.source_photo_id ?? undefined,
    sourcePhotoId: r.source_photo_id ?? undefined,
    photoId: r.source_photo_id ?? undefined,
    source_scan_job_id: r.source_scan_job_id ?? undefined,
    scanJobId: r.source_scan_job_id ?? undefined,
  })) as Book[];
}

/**
 * Server-truth: get book count per photo (source_photo_id) for a user.
 * Single query then group in JS; use for diagnostics or to enrich photo lists.
 */
export async function fetchPhotoBookCounts(userId: string): Promise<Map<string, number>> {
  if (!supabase) return new Map();
  const { data: rows, error } = await supabase
    .from('books')
    .select('source_photo_id')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('source_photo_id', 'is', null);
  if (error) {
    logger.warn('[fetchPhotoBookCounts]', { error: error.message });
    return new Map();
  }
  const countByPhotoId = new Map<string, number>();
  (rows ?? []).forEach((r: { source_photo_id?: string | null }) => {
    const id = r.source_photo_id;
    if (id) countByPhotoId.set(id, (countByPhotoId.get(id) ?? 0) + 1);
  });
  return countByPhotoId;
}

/**
 * Server-truth: photos + book_count per photo. Fetches all photos then enriches with counts.
 * Use when you need a single canonical list of photos with attachment counts (e.g. for release-safe UI).
 */
export async function fetchPhotosWithBookCounts(
  userId: string
): Promise<Array<RawPhotoRow & { book_count: number }>> {
  const [rawPhotos, countByPhotoId] = await Promise.all([
    fetchAllPhotos(userId),
    fetchPhotoBookCounts(userId),
  ]);
  return rawPhotos.map((row) => ({
    ...row,
    book_count: countByPhotoId.get(row.id) ?? 0,
  }));
}

/**
 * Photo Details Debug — run when (global as any).__photoDebug === true (e.g. set in console).
 * Logs for a given photoId: photo row fields, attached books count, sample book ids + source_photo_id,
 * and whether photoId was rewritten by the alias/canonical map.
 * Does not spam; call once per photo when opening detail or on demand.
 */
export async function runPhotoDetailsDebug(
  photoId: string,
  userId: string,
  aliasMap?: Record<string, string>
): Promise<void> {
  if (!supabase) return;
  const canonicalId = aliasMap?.[photoId] ?? photoId;
  const wasRewritten = canonicalId !== photoId;

  const { data: photoRow, error: photoErr } = await supabase
    .from('photos')
    .select('id, status, storage_path, storage_url, deleted_at, approved_count')
    .eq('user_id', userId)
    .eq('id', canonicalId)
    .maybeSingle();

  const { data: bookRows, error: booksErr } = await supabase
    .from('books')
    .select('id, source_photo_id')
    .eq('user_id', userId)
    .eq('source_photo_id', canonicalId)
    .is('deleted_at', null);

  logger.info('[PHOTO_DETAILS_DEBUG]', {
    photoId: photoId.slice(0, 8),
    canonicalId: canonicalId.slice(0, 8),
    wasRewrittenByAlias: wasRewritten,
    photoRow: photoRow
      ? {
          id: photoRow.id?.slice(0, 8),
          status: photoRow.status,
          hasStoragePath: !!(photoRow.storage_path?.trim?.()),
          hasStorageUrl: !!(photoRow.storage_url?.startsWith?.('http')),
          deleted_at: photoRow.deleted_at ?? null,
          approved_count: photoRow.approved_count ?? null,
        }
      : null,
    photoQueryError: photoErr?.message ?? null,
    attachedBooksCount: bookRows?.length ?? 0,
    booksQueryError: booksErr?.message ?? null,
    sampleBookIds: (bookRows ?? []).slice(0, 5).map((r: any) => ({
      id: r.id?.slice(0, 8),
      source_photo_id: r.source_photo_id?.slice(0, 8) ?? null,
    })),
  });
}

/**
 * Save profile photo (avatar) to profile_photos. One row per user; upsert on user_id.
 * No "id" column — user_id is the only key, so no id/dedupe confusion like photos (UUID vs custom string).
 * Sets deleted_at=null to un-soft-delete a row that was previously cleared by "Clear Account Data".
 * Call when user sets profile photo (after uploading to storage if needed). Scans stay in photos table.
 */
export async function saveProfilePhotoToSupabase(
  userId: string,
  payload: { uri: string; storage_path: string }
): Promise<boolean> {
  if (!supabase) {
    logger.warn('Supabase not available, skipping profile photo save');
    return false;
  }
  try {
    const { error } = await supabase
      .from('profile_photos')
      .upsert(
        {
          user_id: userId,
          uri: payload.uri,
          storage_path: payload.storage_path,
          updated_at: new Date().toISOString(),
          deleted_at: null, // clear any prior soft-delete so the new photo is immediately visible
        },
        { onConflict: 'user_id' }
      );
    if (error) {
      logger.error('Error saving profile photo:', error);
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Error saving profile photo to Supabase:', error);
    return false;
  }
}

/**
 * Load profile photo (avatar) from profile_photos only.
 * One row per user (user_id PK); filters deleted_at IS NULL so cleared rows are excluded.
 */
export async function loadProfilePhotoFromSupabase(userId: string): Promise<{ uri: string } | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('profile_photos')
      .select('uri')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !data?.uri) return null;
    return { uri: data.uri };
  } catch {
    return null;
  }
}

/** Optional: register book_id -> work_key for cover fetch by book_id (avoids hash mismatch). */
export type SaveBookOptions = {
 apiBaseUrl?: string;
 accessToken?: string;
 /** Photo (scan) id this book was imported from; stored as books.source_photo_id for delete-photo delete-books. */
 sourcePhotoId?: string;
 /** Scan job raw UUID; stored as books.source_scan_job_id for provenance. */
 sourceScanJobId?: string;
 /** Correlation id for this action (approve/reject); include in logs. */
 opId?: string;
 /** Client-side photo id before sync (for log correlation). */
 localPhotoId?: string;
 /** Image hash / fingerprint (for log correlation). */
 photoFingerprint?: string;
 /** Called with DB row id after successful save so UI can set book.dbId (fixes BookDetailModal dbId null). */
 onSuccess?: (id: string) => void;
 /** Called when approve fails (e.g. no_existing_row, duplicate_key) so UI can collapse into [APPROVE_DUPES] summary. */
 onApproveFailure?: (reason: string, title: string) => void;
 /**
 * Called after preflight DB lookup so the caller can accumulate a batch summary instead of
 * seeing one [BOOK_PREFLIGHT_DB_BY_KEY] + [PHOTO_ATTACH_DB_KEYCHECK] line per book.
 * Fired before any write; summary should be logged after the batch resolves.
 */
 onPreflight?: (result: { bookKey: string; rowFound: boolean; photoIdMismatch: boolean; error: string | null }) => void;
};

/**
 * Fetch cover URLs by library book IDs (bulletproof: uses cover_resolution_books join, no work_key hash mismatch).
 * Call when you have books with id and want to fill missing coverUrl. Requires auth.
 */
export async function fetchCoversByBookIds(
 bookIds: string[],
 apiBaseUrl: string,
 accessToken: string
): Promise<Record<string, string>> {
 if (bookIds.length === 0) return {};
 const base = apiBaseUrl.replace(/\/$/, '');
 const ids = [...new Set(bookIds)].slice(0, 100);
 const url = `${base}/api/cover-status?bookIds=${encodeURIComponent(ids.join(','))}`;
 try {
 const res = await fetch(url, {
 headers: { Authorization: `Bearer ${accessToken}` },
 cache: 'no-store',
 });
 if (!res.ok) return {};
 const data = (await res.json()) as { byBookId?: Record<string, string> };
 return data?.byBookId ?? {};
 } catch {
 return {};
 }
}

/**
 * Save a book to Supabase
 */
export async function saveBookToSupabase(
 userId: string,
 book: Book,
 status: 'pending' | 'approved' | 'rejected' | 'incomplete',
 options?: SaveBookOptions
): Promise<boolean> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping book save');
 return false;
 }

 // Skip Supabase for guest users
 if (userId === 'guest_user') {
 return false; // Silently skip - guest users save locally only
 }

 const tag = status === 'approved' ? 'APPROVE' : status === 'rejected' ? 'REJECT' : null;
 if (tag && options?.opId) {
 logger.debug(scanLogPrefix(tag, {
 opId: options.opId,
 userId,
 batchId: undefined,
 scanJobId: options.sourceScanJobId,
 photoId: options.sourcePhotoId,
 localPhotoId: options.localPhotoId,
 photoFingerprint: options.photoFingerprint,
 }));
 }

 try {
 const saveStartedAt = Date.now();
 // Caller must pass userId from AuthContext/session we do not call getSession() here as source of truth.
 // RLS still enforces auth.uid() on the server.
 // Convert scannedAt to BIGINT (timestamp in milliseconds) for Supabase
 // scanned_at is BIGINT in database, not TIMESTAMPTZ
 const scannedAtValue = book.scannedAt 
 ? (typeof book.scannedAt === 'number' ? book.scannedAt : new Date(book.scannedAt).getTime())
 : null;

 // Sanitize user-facing strings before DB insert (NUL, unpaired surrogates)
 const title = sanitizeTextForDb(book.title) ?? '';
 const author = sanitizeTextForDb(book.author) ?? '';

 // Build bookData with patch semantics: only include fields when they have real values
 const bookData: any = {
 user_id: userId,
 title,
 author,
 status: status,
 scanned_at: scannedAtValue,
 updated_at: new Date().toISOString(),
 };

 const desc = sanitizeTextForDb(book.description);
 if (desc) bookData.description = desc;
 const subtitle = sanitizeTextForDb(book.subtitle);
 if (subtitle) bookData.subtitle = subtitle;
 const publisher = sanitizeTextForDb(book.publisher);
 if (publisher) bookData.publisher = publisher;
 const publishedDate = sanitizeTextForDb(book.publishedDate);
 if (publishedDate) bookData.published_date = publishedDate;
 const language = sanitizeTextForDb(book.language);
 if (language) bookData.language = language;
 const printType = sanitizeTextForDb(book.printType);
 if (printType) bookData.print_type = printType;
 const confidence = sanitizeTextForDb(book.confidence);
 if (confidence) bookData.confidence = confidence;

 if (book.isbn) bookData.isbn = book.isbn;
 // Never persist Google URLs - only our Supabase Storage URLs
 if (book.coverUrl && !isGoogleHotlink(book.coverUrl)) bookData.cover_url = book.coverUrl;
 if (book.localCoverPath) bookData.local_cover_path = book.localCoverPath;
 if (book.googleBooksId) bookData.google_books_id = book.googleBooksId;
 if (book.pageCount) bookData.page_count = book.pageCount;
 if (book.categories) bookData.categories = book.categories;
 if (book.averageRating) bookData.average_rating = book.averageRating;
 if (book.ratingsCount) bookData.ratings_count = book.ratingsCount;
 if (typeof book.is_favorite === 'boolean') bookData.is_favorite = book.is_favorite;

 // Deterministic book_key for dedupe: unique (user_id, book_key) upsert
 const bookKey = computeBookKey(book);
 bookData.book_key = bookKey;
 const verifySavedRow = async (idOrNull: string | null, mode: string) => {
 try {
 let row: any = null;
 if (idOrNull) {
 const { data } = await supabase
 .from('books')
 .select('id, user_id, book_key, enrichment_status, description')
 .eq('id', idOrNull)
 .eq('user_id', userId)
 .maybeSingle();
 row = data;
 } else {
 const { data } = await supabase
 .from('books')
 .select('id, user_id, book_key, enrichment_status, description')
 .eq('user_id', userId)
 .eq('book_key', bookKey)
 .maybeSingle();
 row = data;
 }
 logger.debug('[SAVE_BOOK_VERIFY_SELECT]', {
 table: 'books',
 mode,
 verifyFilter: idOrNull ? 'by_id' : 'by_user_id_book_key',
 dbId: idOrNull,
 book_key: bookKey,
 found: !!row,
 descLen: typeof row?.description === 'string' ? row.description.trim().length : 0,
 enrichment_status: row?.enrichment_status ?? null,
 });
 } catch (e: any) {
 logger.debug('[SAVE_BOOK_VERIFY_SELECT]', {
 table: 'books',
 mode,
 verifyFilter: idOrNull ? 'by_id' : 'by_user_id_book_key',
 dbId: idOrNull,
 book_key: bookKey,
 found: false,
 error: e?.message ?? String(e),
 });
 }
 };
// Two-step photo FK patch: after the book row is written, attach source_photo_id via
// batchPatchSourcePhotoId which now throws if the photo row is absent (strict contract).
//
// If batchPatchSourcePhotoId throws, we catch it here and log an error WITHOUT re-throwing.
// This is intentional: the book row was already written successfully. A failed FK patch is
// serious but recoverable — the PHOTO_ID_REWRITE_PATCH sweep in approve will catch any
// stale source_photo_ids on the next save. Letting the throw propagate would mark the
// entire book save as failed (returning false) which then triggers APPROVE_FAILED for all
// 30+ books, which is far worse than a book temporarily having a null FK.
//
// The approve barrier (in ScansTab) guarantees the canonical photo row exists BEFORE any
// book upsert starts, so in normal operation this catch block should never fire. It is only
// a last-resort safety net for unexpected race conditions (e.g. the photo row was deleted
// between the barrier check and this patch call).
const patchPhotoFK = async (bookRowId: string) => {
  if (!resolvedSourcePhotoId) return; // nothing to attach
  try {
    await batchPatchSourcePhotoId(userId, resolvedSourcePhotoId, [bookRowId]);
  } catch (patchErr: unknown) {
    logger.error('[PHOTO_FK_PATCH_NONFATAL]',
      'FK patch failed after book was written — book saved but source_photo_id may be null; approve barrier should have prevented this',
      {
        bookRowId: bookRowId.slice(0, 8),
        photoId: resolvedSourcePhotoId.slice(0, 8),
        err: (patchErr as any)?.message ?? String(patchErr),
      }
    );
    // Do NOT re-throw: the book row is already in DB. A null FK is recoverable.
  }
};

 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: (book.dbId && isUuid(book.dbId)) ? book.dbId : (book.id && isUuid(book.id) ? book.id : null),
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'pending_lookup',
 });

 // Do NOT send normalized_title / normalized_author: column may not exist in schema (PostgREST schema cache). Re-enable after migration is applied and schema cache refreshed.

 // Only use update_by_id when the row actually exists. Client dbId is often a client-generated UUID that was never inserted (rowCount=0, verify found=false). Using update_by_id when the row doesn't exist writes nothing; enrich then finds by book_key and returns a different id. So: verify row exists first; otherwise fall through to upsert by (user_id, book_key) and get the real id back via onSuccess.
 const bookIdForUpdate = (book.dbId && isUuid(book.dbId)) ? book.dbId : (book.id && isUuid(book.id)) ? book.id : null;
 let rowExistsById = false;
 if (bookIdForUpdate) {
 const { data: existingById } = await supabase
 .from('books')
 .select('id')
 .eq('id', bookIdForUpdate)
 .eq('user_id', userId)
 .maybeSingle();
 rowExistsById = !!existingById;
 if (!rowExistsById) {
 logger.debug('[SAVE_BOOK]', 'dbId not found in DB, will upsert by (user_id, book_key) to get real id', { dbId: bookIdForUpdate, book_key: bookKey });
 }
 }
 // Provenance: resolve source_photo_id / source_scan_job_id but do NOT put them in bookData yet.
 // They are written in a separate UPDATE after the book row is committed (two-step write pattern).
 // This eliminates FK violations when the photo row hasn't been inserted yet:
 // Step 1 upsert book without source_photo_id (null FK = no constraint check)
 // Step 2 UPDATE book SET source_photo_id = ? after upsert succeeds
 // If step 2 fails (photo still not in DB) we warn and continue; the book is safe and the
 // patch will be retried on the next save. The FK is DEFERRABLE INITIALLY DEFERRED at the DB
 // level (see defer-source-photo-id-fkey.sql) so even within a single transaction the order
 // is flexible, but we keep the two-step pattern for defence-in-depth.
 //
 // PRIORITY: options.sourcePhotoId (canonical, pre-resolved by caller) WINS over
 // book.source_photo_id (may still carry a local/temp alias if the in-memory book object
 // hasn't been swept yet). The old order (book.source_photo_id ?? options) meant the local
 // stale ID could reach patchPhotoFK → batchPatchSourcePhotoId → "photo row not found".
 //
 // GUARD: only accept valid UUIDs never composite strings like "photo_123_abc".
 const _bookSourcePhotoId = (book as any).source_photo_id as string | undefined;
 const _optSourcePhotoId = options?.sourcePhotoId;
 // Caller-provided canonical id takes priority; fall back to book field only when caller omits it.
 const sourcePhotoId = (_optSourcePhotoId && isUuid(_optSourcePhotoId))
   ? _optSourcePhotoId
   : (_bookSourcePhotoId ?? _optSourcePhotoId);
 if (_optSourcePhotoId && _bookSourcePhotoId && _optSourcePhotoId !== _bookSourcePhotoId) {
   // Log once per book when they differ so we can verify canonical always wins.
   logger.debug('[SOURCE_PHOTO_ID_CANONICAL_WIN]', {
     bookKey,
     bookField: _bookSourcePhotoId.slice(0, 8),
     callerCanonical: _optSourcePhotoId.slice(0, 8),
     winner: 'caller_canonical',
   });
 }
 const resolvedSourcePhotoId = (sourcePhotoId && isUuid(sourcePhotoId)) ? sourcePhotoId : null;
 const sourceScanJobId = (book as any).source_scan_job_id ?? options?.sourceScanJobId;
 const resolvedSourceScanJobId = (sourceScanJobId && isUuid(sourceScanJobId)) ? sourceScanJobId : null;
 // source_scan_job_id is safe to include inline (scan_jobs rows exist before books are written).
 if (resolvedSourceScanJobId) bookData.source_scan_job_id = resolvedSourceScanJobId;
 // source_photo_id is intentionally omitted here attached via post-upsert patch below.

 if (bookIdForUpdate && rowExistsById) {
 let existingProvenance: { source_photo_id?: string | null; source_scan_job_id?: string | null } | null = null;
 try {
 const { data: existingRow } = await supabase
 .from('books')
 .select('source_photo_id, source_scan_job_id')
 .eq('id', bookIdForUpdate)
 .eq('user_id', userId)
 .maybeSingle();
 existingProvenance = existingRow ?? null;
 } catch {
 existingProvenance = null;
 }
 const updateByIdPayload: Record<string, unknown> = {
 updated_at: new Date().toISOString(),
 };
 if (book.coverUrl && !isGoogleHotlink(book.coverUrl)) updateByIdPayload.cover_url = book.coverUrl;
 if (book.localCoverPath != null) updateByIdPayload.local_cover_path = book.localCoverPath;
 if (book.googleBooksId != null) updateByIdPayload.google_books_id = book.googleBooksId;
 if (book.description != null) updateByIdPayload.description = sanitizeTextForDb(book.description);
 if (book.subtitle != null) updateByIdPayload.subtitle = sanitizeTextForDb(book.subtitle);
 if (book.publisher != null) updateByIdPayload.publisher = sanitizeTextForDb(book.publisher);
 if (book.publishedDate != null) updateByIdPayload.published_date = book.publishedDate;
 if (book.language != null) updateByIdPayload.language = book.language;
 if (book.pageCount != null) updateByIdPayload.page_count = book.pageCount;
 if (book.categories != null) updateByIdPayload.categories = book.categories;
 if (book.averageRating != null) updateByIdPayload.average_rating = book.averageRating;
 if (book.ratingsCount != null) updateByIdPayload.ratings_count = book.ratingsCount;
 if (typeof book.is_favorite === 'boolean') updateByIdPayload.is_favorite = book.is_favorite;
 if (status) updateByIdPayload.status = status;
 // source_photo_id intentionally excluded attached via patchPhotoFK after upsert (two-step write).
 // Preserve source_scan_job_id: prefer incoming resolved value, else carry forward from DB row.
 if (resolvedSourceScanJobId) {
 updateByIdPayload.source_scan_job_id = resolvedSourceScanJobId;
 } else if (existingProvenance?.source_scan_job_id) {
 updateByIdPayload.source_scan_job_id = existingProvenance.source_scan_job_id;
 }
if (status === 'approved') {
// Only block on missing source_photo_id (real FK constraint). Missing source_scan_job_id
// is a data-quality issue — warn but do NOT prevent the approve status write. Blocking on
// source_scan_job_id leaves rows as status='pending', making fetchAllApprovedBooks miss them.
const missingScanJobId =
updateByIdPayload.source_scan_job_id == null || String(updateByIdPayload.source_scan_job_id).trim() === '';
if (!resolvedSourcePhotoId) {
// Log both raw inputs so we can tell whether the ID was absent vs present-but-non-UUID.
// "rawBookField present but non-UUID" means a local composite id (photo_abc_xyz) reached
// the approve path without being canonicalized — fix: ensure canonicalPhotoIdMap is built
// before approvePromises are started.
// "rawCallerOpt null" means the caller (ScansTab approvePromises) didn't pass sourcePhotoId
// — fix: ensure canonicalPhotoIdMap.get(rawSourcePhotoId) resolves before calling saveBookToSupabase.
logger.error('[APPROVE_PROVENANCE_GUARD_BLOCKED]', {
path: 'update_by_id',
dbId: bookIdForUpdate,
title: book.title,
rawBookField: _bookSourcePhotoId ?? null,
rawCallerOpt: _optSourcePhotoId ?? null,
rawBookFieldIsUuid: _bookSourcePhotoId ? isUuid(_bookSourcePhotoId) : false,
rawCallerOptIsUuid: _optSourcePhotoId ? isUuid(_optSourcePhotoId) : false,
resolvedSourcePhotoId: null,
source_scan_job_id: updateByIdPayload.source_scan_job_id ?? null,
effect: 'book stays pending — status NOT written to DB',
});
return false;
}
if (missingScanJobId) {
logger.warn('[APPROVE]', 'update by id missing source_scan_job_id — proceeding (non-blocking)', {
dbId: bookIdForUpdate,
title: book.title,
resolvedSourcePhotoId: resolvedSourcePhotoId ?? null,
});
}
}
 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: bookIdForUpdate,
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'overwrite_by_id',
 preserving: false,
 });
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'before',
 mode: 'update_by_id',
 dbId: bookIdForUpdate,
 book_key: bookKey,
 userId,
 rowExistedPrior: true,
 });
 logger.debug('[BOOK_WRITE_INTENT]', {
 mode: 'update_by_id',
 onConflict: null,
 payload: {
 id: (updateByIdPayload as any).id ?? null,
 user_id: (updateByIdPayload as any).user_id ?? null,
 book_key: (updateByIdPayload as any).book_key ?? null,
 status: (updateByIdPayload as any).status ?? null,
 source_photo_id: null, // omitted from upsert; attached via patchPhotoFK
 pendingPhotoFKPatch: resolvedSourcePhotoId,
 source_scan_job_id: (updateByIdPayload as any).source_scan_job_id ?? null,
 enrichment_status: (updateByIdPayload as any).enrichment_status ?? null,
 descLen: typeof (updateByIdPayload as any).description === 'string' ? (updateByIdPayload as any).description.length : 0,
 },
 payloadKeys: Object.keys(updateByIdPayload as any).sort(),
 });
 const { data: updatedByIdRows, error: updateByIdError } = await supabase
 .from('books')
 .update(updateByIdPayload)
 .eq('id', bookIdForUpdate)
 .eq('user_id', userId)
 .select('id');

 if (updateByIdError) {
 logger.debug('[BOOK_DB_WRITE_RESULT]', {
 mode: 'update_by_id',
 onConflict: null,
 ok: false,
 error: updateByIdError?.message ?? null,
 status: (updateByIdError as any)?.status ?? null,
 });
 logger.debug('[SAVE_BOOK_UPSERT_ERR]', {
 table: 'books',
 mode: 'update_by_id',
 dbId: bookIdForUpdate,
 book_key: bookKey,
 userId,
 ok: false,
 error: updateByIdError?.message ?? String(updateByIdError),
 rowCount: 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 if (updateByIdError?.message?.includes('library_events_book_id_fkey')) {
 const le = await supabase
 .from('library_events')
 .select('id, book_id, created_at')
 .eq('book_id', bookIdForUpdate)
 .limit(5);
 logger.error('[FK_BLOCKER_LIBRARY_EVENTS]', {
 payloadBookId: bookIdForUpdate,
 libraryEventsCount: le.data?.length ?? null,
 sample: le.data ?? null,
 leError: le.error?.message ?? null,
 });
 }
 logger.error('[SAVE_BOOK]', 'update by id failed (edit existing)', { errorMessage: updateByIdError?.message ?? String(updateByIdError), bookId: bookIdForUpdate, title: book.title });
 return false;
 }
 const returnedRowIdUpdateById = updatedByIdRows?.[0]?.id ?? bookIdForUpdate;
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'after',
 mode: 'update_by_id',
 returnedRowId: returnedRowIdUpdateById,
 });
 logger.debug('[SAVE_BOOK_UPSERT_OK]', {
 table: 'books',
 mode: 'update_by_id',
 dbId: bookIdForUpdate,
 book_key: bookKey,
 userId,
 ok: true,
 status: 'ok',
 dataId: returnedRowIdUpdateById,
 rowCount: updatedByIdRows?.length ?? 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 await verifySavedRow(bookIdForUpdate, 'update_by_id');
 await patchPhotoFK(bookIdForUpdate);
 if (options?.onSuccess && bookIdForUpdate) options.onSuccess(bookIdForUpdate);
 if (options?.apiBaseUrl && options?.accessToken && bookIdForUpdate) {
 const workKey = (book as any).work_key ?? (book as any).workKey;
 if (workKey && typeof workKey === 'string') {
 fetch(`${options.apiBaseUrl.replace(/\/$/, '')}/api/register-cover-book`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
 body: JSON.stringify({ bookId: bookIdForUpdate, workKey }),
 }).catch(() => {});
 }
 }
 return true;
 }

 // [PHOTO_ATTACH_INTENT] prove which photoId/jobId is being linked and whether they are canonical UUIDs
 logger.debug('[PHOTO_ATTACH_INTENT]', {
 bookKey,
 userId,
 bookId: (book.id && isUuid(book.id)) ? book.id : null,
 bookDbId: (book.dbId && isUuid(book.dbId)) ? book.dbId : null,
 resolvedSourcePhotoId,
 resolvedSourceScanJobId,
 rawSourcePhotoId: (book as any).source_photo_id ?? null,
 optionsSourcePhotoId: options?.sourcePhotoId ?? null,
 sourcePhotoIdIsUuid: sourcePhotoId ? isUuid(sourcePhotoId) : false,
 status,
 twoStepWrite: true,
 });
 // [PHOTO_ATTACH_DB_KEYCHECK] only query + log when DEBUG_VERBOSE or when mismatch detection
 // is needed. In normal runs this is pure spam (6× per approve batch). The onPreflight callback
 // already captured rowFound; here we only fire if we need to verify photo id attachment.
 if (__DEV__ && DEBUG_VERBOSE) {
 const keyCheck = await supabase
 .from('books')
 .select('id, book_key, source_photo_id')
 .eq('user_id', userId)
 .eq('book_key', bookKey)
 .is('deleted_at', null)
 .limit(1);
 const photoIdMismatch = !!(keyCheck.data?.[0]?.source_photo_id && resolvedSourcePhotoId &&
 keyCheck.data[0].source_photo_id !== resolvedSourcePhotoId);
 logger.debug('[PHOTO_ATTACH_DB_KEYCHECK]', {
 bookKey,
 returned: keyCheck.data?.length ?? null,
 dbId: keyCheck.data?.[0]?.id ?? null,
 dbSourcePhotoId: keyCheck.data?.[0]?.source_photo_id ?? null,
 willAttachPhotoId: resolvedSourcePhotoId ?? null,
 photoIdMismatch,
 error: keyCheck.error?.message ?? null,
 });
 }

// Provenance guardrail: only block on missing source_photo_id (real FK constraint).
// Missing source_scan_job_id is a data-quality issue — warn but do NOT block the approve write.
// Blocking on source_scan_job_id leaves rows as status='pending', so fetchAllApprovedBooks misses them.
// Note: source_photo_id is no longer in bookData at this point (two-step write); check resolvedSourcePhotoId.
if (status === 'approved') {
const missingPhotoId = !resolvedSourcePhotoId;
const missingScanJobId = !resolvedSourceScanJobId;
if (missingPhotoId) {
logger.error('[APPROVE_PROVENANCE_GUARD_BLOCKED]', {
path: 'upsert_by_book_key',
title: bookData.title,
rawBookField: _bookSourcePhotoId ?? null,
rawCallerOpt: _optSourcePhotoId ?? null,
rawBookFieldIsUuid: _bookSourcePhotoId ? isUuid(_bookSourcePhotoId) : false,
rawCallerOptIsUuid: _optSourcePhotoId ? isUuid(_optSourcePhotoId) : false,
resolvedSourcePhotoId: null,
source_scan_job_id: resolvedSourceScanJobId ?? null,
effect: 'book stays pending — status NOT written to DB',
});
return false;
}
if (missingScanJobId) {
logger.warn('[APPROVE]', 'upsert row missing source_scan_job_id — proceeding (non-blocking)', {
title: bookData.title,
source_photo_id: resolvedSourcePhotoId ?? null,
});
}
 // Sample 13 max, gate behind DEBUG_VERBOSE (keep signal, drop noise)
 if (__DEV__ && DEBUG_VERBOSE) {
 const count = (global as any).__approveSampleCount ?? 0;
 (global as any).__approveSampleCount = count + 1;
 if (count < 3) {
 logger.debug('[APPROVE] upsert row sample', {
 title: bookData.title,
 source_photo_id: resolvedSourcePhotoId,
 source_scan_job_id: resolvedSourceScanJobId ?? null,
 });
 }
 }
 }

 // Optional: log only when __DEV__ and debugging (reduce noise)
 if (__DEV__ && (global as any).__DEBUG_SUPABASE_BOOKS__) {
 logger.debug(`[DB] Saving book: "${book.title}"`);
 }

 // Canonical identity: (user_id, book_key) only. Do not query by normalized_* (columns may not exist).
 const authorForQuery = author || '';
 let existingBook: { id: string; cover_url?: string; local_cover_path?: string; google_books_id?: string; description?: string; page_count?: number; categories?: string[]; publisher?: string; published_date?: string; language?: string; average_rating?: number; ratings_count?: number; subtitle?: string; print_type?: string; source_photo_id?: string | null; source_scan_job_id?: string | null } | null = null;
 const byBookKey = await supabase
 .from('books')
 .select('id, cover_url, local_cover_path, google_books_id, description, page_count, categories, publisher, published_date, language, average_rating, ratings_count, subtitle, print_type, source_photo_id, source_scan_job_id')
 .eq('user_id', userId)
 .eq('book_key', bookKey)
 .is('deleted_at', null)
 .maybeSingle();
 if (byBookKey.error && (byBookKey.error as any).code !== '42703') {
 const findError = byBookKey.error;
 const errorMessage = findError?.message || findError?.code || JSON.stringify(findError) || String(findError);
 const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || (findError as any)?.name === 'AbortError' || (findError as any)?.constructor?.name === 'AbortError';
 if (!isAbortError) logger.warn('Error finding book by book_key:', findError);
 } else if (byBookKey.data) {
 existingBook = byBookKey.data;
 }
 // Per-book preflight: report via onPreflight callback so the caller can emit a single
 // [BOOK_PREFLIGHT_SUMMARY] after the batch. Only log inline on anomaly or DEBUG_VERBOSE.
 const _preflightError = byBookKey.error?.message ?? null;
 const _preflightFound = !!byBookKey.data;
 if (options?.onPreflight) {
 options.onPreflight({
 bookKey,
 rowFound: _preflightFound,
 photoIdMismatch: false, // filled in by PHOTO_ATTACH_DB_KEYCHECK below
 error: _preflightError,
 });
 }
 if (!_preflightFound || _preflightError || (DEBUG_VERBOSE && __DEV__)) {
 logger.debug('[BOOK_PREFLIGHT_DB_BY_KEY]', {
 book_key: bookKey,
 foundCount: _preflightFound ? 1 : 0,
 existingId: byBookKey.data?.id ?? null,
 existingSourcePhotoId: byBookKey.data?.source_photo_id ?? null,
 error: _preflightError,
 });
 }
 // Route selector: does a row already exist for this (user_id, book_key)?
 // book.id / book.dbId are local hints only never sent as the DB primary key on insert.
 // Postgres generates the id; we get it back via RETURNING id and propagate through onSuccess.
 const _preflightExistingId = byBookKey.data?.id ?? null;
 if (existingBook) {
 // Update: merge local + server. Cover merge precedence:
 // - If server cover_* exists can overwrite with local only when local has a value.
 // - If server is null keep local (optional).
 // - Never let local null/empty wipe out server non-null.
 const updateData: any = {
 ...bookData, // Start with new data
 };

 // Apply cover merge precedence (never send null for cover_* when server has a value)
 const hasLocalCoverUrl = updateData.cover_url != null && updateData.cover_url !== '' && !isGoogleHotlink(updateData.cover_url);
 const hasServerCoverUrl = existingBook.cover_url != null && existingBook.cover_url !== '' && !isGoogleHotlink(existingBook.cover_url);
 if (!hasLocalCoverUrl && hasServerCoverUrl) {
 updateData.cover_url = existingBook.cover_url;
 }
 const hasLocalCoverPath = updateData.local_cover_path != null && updateData.local_cover_path !== '';
 const hasServerCoverPath = existingBook.local_cover_path != null && existingBook.local_cover_path !== '';
 if (!hasLocalCoverPath && hasServerCoverPath) {
 updateData.local_cover_path = existingBook.local_cover_path;
 }
 if (!updateData.google_books_id && existingBook.google_books_id) {
 updateData.google_books_id = existingBook.google_books_id;
 }
 // Preserve other metadata fields if new data doesn't have them
 if (!updateData.description && existingBook.description) {
 updateData.description = existingBook.description;
 }
 if (!updateData.page_count && existingBook.page_count) {
 updateData.page_count = existingBook.page_count;
 }
 if (!updateData.categories && existingBook.categories) {
 updateData.categories = existingBook.categories;
 }
 if (!updateData.publisher && existingBook.publisher) {
 updateData.publisher = existingBook.publisher;
 }
 if (!updateData.published_date && existingBook.published_date) {
 updateData.published_date = existingBook.published_date;
 }
 if (!updateData.language && existingBook.language) {
 updateData.language = existingBook.language;
 }
 if (!updateData.average_rating && existingBook.average_rating) {
 updateData.average_rating = existingBook.average_rating;
 }
 if (!updateData.ratings_count && existingBook.ratings_count) {
 updateData.ratings_count = existingBook.ratings_count;
 }
 if (!updateData.subtitle && existingBook.subtitle) {
 updateData.subtitle = existingBook.subtitle;
 }
 if (!updateData.print_type && existingBook.print_type) {
 updateData.print_type = existingBook.print_type;
 }
 const preserving = {
 description: !bookData.description && !!existingBook.description,
 page_count: !bookData.page_count && !!existingBook.page_count,
 categories: !bookData.categories && !!existingBook.categories,
 publisher: !bookData.publisher && !!existingBook.publisher,
 published_date: !bookData.published_date && !!existingBook.published_date,
 language: !bookData.language && !!existingBook.language,
 average_rating: !bookData.average_rating && !!existingBook.average_rating,
 ratings_count: !bookData.ratings_count && !!existingBook.ratings_count,
 subtitle: !bookData.subtitle && !!existingBook.subtitle,
 print_type: !bookData.print_type && !!existingBook.print_type,
 };
 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: existingBook.id,
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'update_existing_by_book_key',
 preserving,
 });
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'before',
 mode: 'upsert_by_key',
 dbId: existingBook.id,
 book_key: bookKey,
 userId,
 rowExistedPrior: true,
 });
 // source_photo_id is handled exclusively by patchPhotoFK (two-step write) never include it
 // in updateData here. The patchPhotoFK call after this upsert attaches it safely once the
 // book row is committed. Preserve source_scan_job_id from DB if the incoming payload lacks it.
 delete updateData.source_photo_id;
 if (updateData.source_scan_job_id == null || updateData.source_scan_job_id === '') {
 if (existingBook.source_scan_job_id != null && existingBook.source_scan_job_id !== '') {
 updateData.source_scan_job_id = existingBook.source_scan_job_id;
 } else {
 delete updateData.source_scan_job_id;
 }
 }

 if (status === 'approved') {
 logger.debug('[APPROVE_WRITE_MODE] method=update (row identified by user_id,book_key)');
 logger.debug('[APPROVE_DB_WRITE_MODE] method=update onConflict=user_id,book_key');
 }
 logger.debug('[BOOK_WRITE_INTENT]', {
 mode: 'update_existing_by_book_key',
 onConflict: null,
 payload: {
 id: (updateData as any).id ?? null,
 user_id: (updateData as any).user_id ?? null,
 book_key: (updateData as any).book_key ?? null,
 status: (updateData as any).status ?? null,
 source_photo_id: null, // omitted from upsert; attached via patchPhotoFK
 pendingPhotoFKPatch: resolvedSourcePhotoId,
 source_scan_job_id: (updateData as any).source_scan_job_id ?? null,
 enrichment_status: (updateData as any).enrichment_status ?? null,
 descLen: typeof (updateData as any).description === 'string' ? (updateData as any).description.length : 0,
 },
 payloadKeys: Object.keys(updateData as any).sort(),
 existingId: existingBook.id,
 idInPayload: (updateData as any).id ?? null,
 idMismatch: !!((updateData as any).id && (updateData as any).id !== existingBook.id),
 });
 const { data: updatedRows, error: updateError } = await supabase
 .from('books')
 .update(updateData)
 .eq('id', existingBook.id)
 .select('id');

 if (updateError) {
 logger.debug('[BOOK_DB_WRITE_RESULT]', {
 mode: 'update_existing_by_book_key',
 onConflict: null,
 ok: false,
 error: updateError?.message ?? null,
 status: (updateError as any)?.status ?? null,
 });
 logger.debug('[SAVE_BOOK_UPSERT_ERR]', {
 table: 'books',
 mode: 'update_existing_by_book_key',
 dbId: existingBook.id,
 book_key: bookKey,
 userId,
 ok: false,
 error: updateError?.message ?? String(updateError),
 rowCount: 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 if (updateError?.message?.includes('library_events_book_id_fkey')) {
 const le = await supabase
 .from('library_events')
 .select('id, book_id, created_at')
 .eq('book_id', existingBook.id)
 .limit(5);
 logger.error('[FK_BLOCKER_LIBRARY_EVENTS]', {
 payloadBookId: existingBook.id,
 libraryEventsCount: le.data?.length ?? null,
 sample: le.data ?? null,
 leError: le.error?.message ?? null,
 });
 }
 // Check if error is an AbortError (request was cancelled/timed out)
 const errorMessage = updateError?.message || updateError?.code || JSON.stringify(updateError) || String(updateError);
 const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || 
 (updateError as any)?.name === 'AbortError' || 
 (updateError as any)?.constructor?.name === 'AbortError';
 // Check for HTML error pages (Supabase service issues)
 const isHtmlError = typeof errorMessage === 'string' && (
 errorMessage.trim().startsWith('<!DOCTYPE') ||
 errorMessage.trim().startsWith('<html') ||
 errorMessage.includes('Cloudflare') ||
 errorMessage.includes('502 Bad Gateway') ||
 errorMessage.includes('503 Service Unavailable') ||
 errorMessage.includes('504 Gateway Timeout')
 );
 const isDateRangeError = typeof errorMessage === 'string' && errorMessage.includes('date/time field value out of range');
 
 if (isAbortError) {
 logger.warn(' Book update aborted (likely timeout or network issue):', book.title);
 logger.warn(' This is usually temporary - the book may sync on next attempt');
 return false;
 } else if (isHtmlError) {
 logger.warn(' Supabase service error (HTML response):', book.title);
 logger.warn(' This is usually a temporary Supabase/Cloudflare issue');
 logger.warn(' The book will be retried on next sync attempt');
 // Don't log full error details for HTML errors to reduce noise
 return false;
 } else if (isDateRangeError) {
 logger.error(' Error updating book in Supabase: Date/time field value out of range');
 logger.error(' This indicates scanned_at column is TIMESTAMPTZ but we sent BIGINT');
 logger.error(' SOLUTION: Run the migration supabase-migration-fix-scanned-at-type.sql');
 logger.error(' Book title:', book.title);
 logger.error(' scanned_at value:', bookData.scanned_at);
 // Don't log full book data for this error to reduce noise
 } else {
 logger.error('Error updating book in Supabase:', errorMessage);
 logger.error('DB_SAVE_FAIL_SAMPLE', [{
 title: debugString(String(book.title ?? '')),
 author: debugString(String(book.author ?? '')),
 }]);
 logger.error('Book data:', JSON.stringify(bookData, null, 2));
 }
 return false;
 }
 const returnedRowIdExisting = updatedRows?.[0]?.id ?? existingBook.id;
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'after',
 mode: 'upsert_by_key',
 returnedRowId: returnedRowIdExisting,
 });
 logger.debug('[SAVE_BOOK_UPSERT_OK]', {
 table: 'books',
 mode: 'update_existing_by_book_key',
 dbId: existingBook.id,
 book_key: bookKey,
 userId,
 ok: true,
 status: 'ok',
 dataId: returnedRowIdExisting,
 rowCount: updatedRows?.length ?? 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 await verifySavedRow(existingBook.id, 'update_existing_by_book_key');
 await patchPhotoFK(existingBook.id);

 const bookId = existingBook.id;
 if (options?.onSuccess && bookId) options.onSuccess(bookId);
 if (options?.apiBaseUrl && options?.accessToken && bookId) {
 const workKey = (book as any).work_key ?? (book as any).workKey;
 if (workKey && typeof workKey === 'string') {
 fetch(`${options.apiBaseUrl.replace(/\/$/, '')}/api/register-cover-book`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
 body: JSON.stringify({ bookId, workKey }),
 }).catch(() => {});
 }
 }
 return true; // Updated successfully (no per-book log to reduce noise)
 } else {
 // Approve = update existing row only. Pending and Library are the same row with a status field; never insert on approve.
 if (status === 'approved') {
 // Find existing row: by id (if DB UUID), then by (user_id, book_key), then by (user_id, title, author)
 const enrichmentSelect = 'id, status, source_photo_id, source_scan_job_id, description, page_count, categories, publisher, published_date, language, average_rating, ratings_count, subtitle, print_type, google_books_id, cover_url, local_cover_path';
 type RowToUpdate = { id: string; status?: string; source_photo_id?: string | null; source_scan_job_id?: string | null; description?: string | null; page_count?: number | null; categories?: string[] | null; publisher?: string | null; published_date?: string | null; language?: string | null; average_rating?: number | null; ratings_count?: number | null; subtitle?: string | null; print_type?: string | null; google_books_id?: string | null; cover_url?: string | null; local_cover_path?: string | null };
 let rowToUpdate: RowToUpdate | null = null;

    // NOTE: lookups intentionally do NOT filter .is('deleted_at', null).
    // A row may have been accidentally soft-deleted (e.g. SettingsModal "Clear Account Data")
    // while the user still has it locally as approved. Approve must resurrect it: the update
    // payload always sets deleted_at: null, which un-soft-deletes the row.
    if (book.id && isUuid(book.id)) {
      const { data: byId } = await supabase
        .from('books')
        .select(enrichmentSelect)
        .eq('user_id', userId)
        .eq('id', book.id)
        .maybeSingle();
      rowToUpdate = byId ?? null;
    }
    if (!rowToUpdate) {
      const { data: byKey } = await supabase
        .from('books')
        .select(enrichmentSelect)
        .eq('user_id', userId)
        .eq('book_key', bookKey)
        .maybeSingle();
      rowToUpdate = byKey ?? null;
    }
    if (!rowToUpdate) {
      const { data: byTa } = await supabase
        .from('books')
        .select(enrichmentSelect)
        .eq('user_id', userId)
        .eq('title', title)
        .eq('author', authorForQuery)
        .maybeSingle();
      rowToUpdate = byTa ?? null;
    }
    if (rowToUpdate?.id) {
      // Build updatePayload with enrichment fields prefer incoming non-empty value, fall back to
      // existing DB value so a re-scan never wipes good metadata with empties.
      // Approve path MUST set deleted_at = null so fetchAll (deleted_at IS NULL) and verify stay in sync.
      const updatePayload: any = {
        status: 'approved',
        deleted_at: null,  // idempotent: un-soft-delete if row was accidentally cleared; required for fetchAll/verify consistency
        updated_at: new Date().toISOString(),
        source_photo_id: bookData.source_photo_id ?? rowToUpdate.source_photo_id ?? null,
        source_scan_job_id: bookData.source_scan_job_id ?? rowToUpdate.source_scan_job_id ?? null,
      };
 // Enrichment fields: incoming wins if present, else keep server value (never overwrite with null).
 const enrichFieldsToMerge: Array<[keyof typeof updatePayload, unknown, unknown]> = [
 ['description', bookData.description, rowToUpdate.description],
 ['page_count', bookData.page_count, rowToUpdate.page_count],
 ['categories', bookData.categories, rowToUpdate.categories],
 ['publisher', bookData.publisher, rowToUpdate.publisher],
 ['published_date', bookData.published_date, rowToUpdate.published_date],
 ['language', bookData.language, rowToUpdate.language],
 ['average_rating', bookData.average_rating, rowToUpdate.average_rating],
 ['ratings_count', bookData.ratings_count, rowToUpdate.ratings_count],
 ['subtitle', bookData.subtitle, rowToUpdate.subtitle],
 ['print_type', bookData.print_type, rowToUpdate.print_type],
 ['google_books_id',bookData.google_books_id,rowToUpdate.google_books_id],
 ];
 for (const [field, incoming, existing] of enrichFieldsToMerge) {
 if (incoming != null && incoming !== '' && !(Array.isArray(incoming) && (incoming as unknown[]).length === 0)) {
 updatePayload[field] = incoming;
 } else if (existing != null && existing !== '' && !(Array.isArray(existing) && (existing as unknown[]).length === 0)) {
 updatePayload[field] = existing;
 }
 // else: field absent from payload entirely do not send null
 }
 // Cover URL: prefer local non-hotlink, fall back to server
 const hasLocalCover = bookData.cover_url != null && bookData.cover_url !== '' && !isGoogleHotlink(bookData.cover_url as string);
 const hasServerCover = rowToUpdate.cover_url != null && rowToUpdate.cover_url !== '' && !isGoogleHotlink(rowToUpdate.cover_url as string);
 if (hasLocalCover) updatePayload.cover_url = bookData.cover_url;
 else if (hasServerCover) updatePayload.cover_url = rowToUpdate.cover_url;
 const hasLocalCoverPath = bookData.local_cover_path != null && bookData.local_cover_path !== '';
 const hasServerCoverPath = rowToUpdate.local_cover_path != null && rowToUpdate.local_cover_path !== '';
 if (hasLocalCoverPath) updatePayload.local_cover_path = bookData.local_cover_path;
  else if (hasServerCoverPath) updatePayload.local_cover_path = rowToUpdate.local_cover_path;
  // Safety net: deleted_at must be null (not some other value) in the approve update payload.
  // We explicitly set it above; if something else overwrote it with a timestamp, that's a bug.
  if ((updatePayload as any).deleted_at !== null && (updatePayload as any).deleted_at !== undefined) {
    logger.error('[APPROVE_UPDATE_SAFETY] deleted_at in updatePayload is not null — forcing null. This is a bug.', {
      book_key: bookKey,
      deleted_at: (updatePayload as any).deleted_at,
    });
    (updatePayload as any).deleted_at = null;
  }
  logger.debug('[SAVE_BOOK_DB_WRITE]', {
    phase: 'before',
    mode: 'upsert_by_key',
    dbId: rowToUpdate.id,
    book_key: bookKey,
    userId,
    rowExistedPrior: true,
  });
  const { data: approveUpdatedRows, error: updateErr } = await supabase
    .from('books')
    .update(updatePayload)
    .eq('id', rowToUpdate.id)
    .select('id');
 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: rowToUpdate.id,
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'approve_update_existing_row',
 preserving: {
 source_photo_id: !bookData.source_photo_id && !!rowToUpdate.source_photo_id,
 source_scan_job_id: !bookData.source_scan_job_id && !!rowToUpdate.source_scan_job_id,
 },
 });
 if (!updateErr) {
 const returnedRowIdApprove = approveUpdatedRows?.[0]?.id ?? rowToUpdate.id;
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'after',
 mode: 'upsert_by_key',
 returnedRowId: returnedRowIdApprove,
 });
 logger.debug('[SAVE_BOOK_UPSERT_OK]', {
 table: 'books',
 mode: 'approve_update_existing_row',
 dbId: rowToUpdate.id,
 book_key: bookKey,
 userId,
 ok: true,
 status: 'ok',
 dataId: returnedRowIdApprove,
 rowCount: approveUpdatedRows?.length ?? 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 await verifySavedRow(rowToUpdate.id, 'approve_update_existing_row');
 await patchPhotoFK(rowToUpdate.id);
 logger.debug('[APPROVE_WRITE_MODE] method=update (existing row, status=approved)');
 if (options?.onSuccess && rowToUpdate.id) options.onSuccess(rowToUpdate.id);
 if (options?.apiBaseUrl && options?.accessToken) {
 const workKey = (book as any).work_key ?? (book as any).workKey;
 if (workKey && typeof workKey === 'string') {
 fetch(`${options.apiBaseUrl.replace(/\/$/, '')}/api/register-cover-book`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
 body: JSON.stringify({ bookId: rowToUpdate.id, workKey }),
 }).catch(() => {});
 }
 }
 return true;
 }
 logger.debug('[SAVE_BOOK_UPSERT_ERR]', {
 table: 'books',
 mode: 'approve_update_existing_row',
 dbId: rowToUpdate.id,
 book_key: bookKey,
 userId,
 ok: false,
 error: updateErr?.message ?? String(updateErr),
 rowCount: 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 }

// No existing row: approve is the only path that creates library books. Insert with status approved.
// Never send book.id / book.dbId in the payload Postgres generates the primary key.
// The DB-assigned id comes back via RETURNING id and is propagated through onSuccess.
// This eliminates the entire class of PK-mutation FK violations caused by two code paths
// minting different client UUIDs for the same (user_id, book_key).
const insertData = { ...bookData };
// Explicitly set deleted_at: null on insert — ensures any prior soft-delete is cleared
// if this book_key somehow already existed as a soft-deleted row (upsert on conflict).
(insertData as any).deleted_at = null;
// Safety net: if something in bookData set deleted_at to a non-null value, that's a bug.
if ((insertData as any).deleted_at !== null) {
  logger.error('[APPROVE_INSERT_SAFETY] deleted_at in insertData is not null — forcing null. This is a bug.', {
    book_key: bookKey,
    deleted_at: (insertData as any).deleted_at,
  });
  (insertData as any).deleted_at = null;
}
 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: null, // Postgres generates id; none sent in payload
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'approve_insert_or_upsert',
 preserving: false,
 });
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'before',
 mode: 'upsert_by_key',
 dbId: null,
 book_key: bookKey,
 userId,
 rowExistedPrior: false,
 });
 logger.debug('[BOOK_WRITE_INTENT]', {
 mode: 'approve_insert_or_upsert',
 onConflict: 'user_id,book_key',
 payload: {
 id: null, // intentionally omitted Postgres generates
 user_id: (insertData as any).user_id ?? null,
 book_key: (insertData as any).book_key ?? null,
 status: (insertData as any).status ?? null,
 source_photo_id: (insertData as any).source_photo_id ?? null,
 source_scan_job_id: (insertData as any).source_scan_job_id ?? null,
 enrichment_status: (insertData as any).enrichment_status ?? null,
 descLen: typeof (insertData as any).description === 'string' ? (insertData as any).description.length : 0,
 },
 payloadKeys: Object.keys(insertData as any).sort(),
 preflightExistingId: _preflightExistingId,
 });
 const { data: inserted, error: insertErr } = await supabase
 .from('books')
 .upsert(insertData, { onConflict: 'user_id,book_key', ignoreDuplicates: false })
 .select('id')
 .maybeSingle();
 if (insertErr) {
 logger.debug('[BOOK_DB_WRITE_RESULT]', {
 mode: 'approve_insert_or_upsert',
 onConflict: 'user_id,book_key',
 ok: false,
 error: insertErr?.message ?? null,
 status: (insertErr as any)?.status ?? null,
 });
 logger.debug('[SAVE_BOOK_UPSERT_ERR]', {
 table: 'books',
 mode: 'approve_insert_or_upsert',
 dbId: null,
 book_key: bookKey,
 userId,
 ok: false,
 error: insertErr?.message ?? String(insertErr),
 rowCount: 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 if (insertErr?.message?.includes('library_events_book_id_fkey')) {
 const le = await supabase
 .from('library_events')
 .select('id, book_id, created_at')
 .eq('book_key', bookKey)
 .limit(5);
 logger.error('[FK_BLOCKER_LIBRARY_EVENTS]', {
 payloadBookId: null, // no client id in payload
 libraryEventsCount: le.data?.length ?? null,
 sample: le.data ?? null,
 leError: le.error?.message ?? null,
 });
 }
 const code = (insertErr as any)?.code;
 if (code === '23505') {
 options?.onApproveFailure?.('duplicate_key', book.title);
 return false;
 }
 logger.warn('[APPROVE]', 'upsert (insert) failed', { title: book.title, error: insertErr.message });
 return false;
 }
 const insertedId = inserted?.id ?? null;
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'after',
 mode: 'upsert_by_key',
 returnedRowId: insertedId,
 });
 logger.debug('[SAVE_BOOK_UPSERT_OK]', {
 table: 'books',
 mode: 'approve_insert_or_upsert',
 dbId: insertedId,
 book_key: bookKey,
 userId,
 ok: true,
 status: 'ok',
 dataId: insertedId,
 rowCount: inserted ? 1 : 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 await verifySavedRow(insertedId, 'approve_insert_or_upsert');
 await patchPhotoFK(insertedId);
 if (options?.onSuccess && insertedId) options.onSuccess(insertedId);
 if (options?.apiBaseUrl && options?.accessToken && insertedId) {
 const workKey = (book as any).work_key ?? (book as any).workKey;
 if (workKey && typeof workKey === 'string') {
 fetch(`${options.apiBaseUrl.replace(/\/$/, '')}/api/register-cover-book`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
 body: JSON.stringify({ bookId: insertedId, workKey }),
 }).catch(() => {});
 }
 }
 return true;
 }

 // Non-approve (pending/rejected): upsert so new scan results can be saved.
 // Never send book.id in the payload Postgres generates the primary key.
 // The DB-assigned id comes back via RETURNING id and is propagated through onSuccess.
 const pendingData = { ...bookData };
 logger.debug('[SAVE_BOOK_TO_SUPABASE]', {
 dbId: null, // Postgres generates id; none sent in payload
 book_key: bookKey,
 incoming: {
 enrichment_status: book.enrichment_status ?? null,
 descLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 },
 mergeMode: 'non_approve_upsert',
 preserving: false,
 });
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'before',
 mode: 'upsert_by_key',
 dbId: null,
 book_key: bookKey,
 userId,
 });
 logger.debug('[BOOK_WRITE_INTENT]', {
 mode: 'non_approve_upsert',
 onConflict: 'user_id,book_key',
 payload: {
 id: null, // intentionally omitted Postgres generates
 user_id: (pendingData as any).user_id ?? null,
 book_key: (pendingData as any).book_key ?? null,
 status: (pendingData as any).status ?? null,
 source_photo_id: (pendingData as any).source_photo_id ?? null,
 source_scan_job_id: (pendingData as any).source_scan_job_id ?? null,
 enrichment_status: (pendingData as any).enrichment_status ?? null,
 descLen: typeof (pendingData as any).description === 'string' ? (pendingData as any).description.length : 0,
 },
 payloadKeys: Object.keys(pendingData as any).sort(),
 preflightExistingId: _preflightExistingId,
 });
 const { data: upserted, error: upsertError } = await supabase
 .from('books')
 .upsert(pendingData, { onConflict: 'user_id,book_key', ignoreDuplicates: false })
 .select('id')
 .maybeSingle();
 if (upsertError) {
 logger.debug('[BOOK_DB_WRITE_RESULT]', {
 mode: 'non_approve_upsert',
 onConflict: 'user_id,book_key',
 ok: false,
 error: upsertError?.message ?? null,
 status: (upsertError as any)?.status ?? null,
 });
 logger.debug('[SAVE_BOOK_UPSERT_ERR]', {
 table: 'books',
 mode: 'non_approve_upsert',
 dbId: null,
 book_key: bookKey,
 userId,
 ok: false,
 error: upsertError?.message ?? String(upsertError),
 rowCount: 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 if (upsertError?.message?.includes('library_events_book_id_fkey')) {
 const le = await supabase
 .from('library_events')
 .select('id, book_id, created_at')
 .eq('book_key', bookKey)
 .limit(5);
 logger.error('[FK_BLOCKER_LIBRARY_EVENTS]', {
 payloadBookId: null, // no client id in payload
 libraryEventsCount: le.data?.length ?? null,
 sample: le.data ?? null,
 leError: le.error?.message ?? null,
 });
 }
 const errorMessage = upsertError?.message || upsertError?.code || String(upsertError);
 logger.error('[SAVE_BOOK]', 'upsert failed (non-approve)', { errorMessage, title: book.title });
 return false;
 }
 const bookId = upserted?.id;
 logger.debug('[SAVE_BOOK_DB_WRITE]', {
 phase: 'after',
 mode: 'upsert_by_key',
 returnedRowId: bookId ?? null,
 });
 logger.debug('[SAVE_BOOK_UPSERT_OK]', {
 table: 'books',
 mode: 'non_approve_upsert',
 dbId: bookId ?? null,
 book_key: bookKey,
 userId,
 ok: true,
 status: 'ok',
 dataId: bookId ?? null,
 rowCount: upserted ? 1 : 0,
 elapsedMs: Date.now() - saveStartedAt,
 });
 await verifySavedRow(bookId ?? null, 'non_approve_upsert');
 if (bookId) await patchPhotoFK(bookId);
 if (options?.onSuccess && bookId) options.onSuccess(bookId);
 if (options?.apiBaseUrl && options?.accessToken && bookId) {
 const workKey = (book as any).work_key ?? (book as any).workKey;
 if (workKey && typeof workKey === 'string') {
 fetch(`${options.apiBaseUrl.replace(/\/$/, '')}/api/register-cover-book`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
 body: JSON.stringify({ bookId, workKey }),
 }).catch(() => {});
 }
 }
 return true;
 }
 } catch (error) {
 logger.error('Error saving book to Supabase:', error);
 return false;
 }
}

/**
 * Try to sync approved books that have sync_state pending (e.g. approved offline or rehydrated before server had rows).
 * Saves each to server, collects DB ids, then loads from server and merges. Call onMerged with the merged list so the app can update state and persist.
 * Call this on rehydrate when local approved list has items with sync_state === 'pending' and non-UUID id.
 */
export async function syncPendingApprovedBooks(
 userId: string,
 books: Book[],
 options: {
 accessToken?: string;
 apiBaseUrl?: string;
 onMerged: (merged: Book[]) => void | Promise<void>;
 }
): Promise<void> {
 if (!supabase || books.length === 0) return;
 const baseSaveOptions = options.accessToken && options.apiBaseUrl
 ? { apiBaseUrl: options.apiBaseUrl, accessToken: options.accessToken } : undefined;
 const dbIds: (string | undefined)[] = new Array(books.length);
 const savePromises = books.map((book, index) =>
 saveBookToSupabase(userId, book, 'approved', {
 ...baseSaveOptions,
 sourcePhotoId: (book as any).source_photo_id,
 sourceScanJobId: (book as any).source_scan_job_id,
 onSuccess: (dbId) => { dbIds[index] = dbId; },
 })
 );
 const results = await Promise.all(savePromises);
 const updatedBooks = books.map((b, i) => {
 const dbId = dbIds[i];
 return dbId ? { ...b, id: dbId, dbId } : b;
 });
 const refreshed = await loadBooksFromSupabase(userId);
 // Field-level merge: server wins for ids/enrichment, local wins for identity (title/author).
 // Never replace with a server-first concatenation — that silently overwrites what the user approved.
 const serverApproved = refreshed.approved || [];
 const serverByKey = new Map<string, Book>();
 serverApproved.forEach((b) => {
   const k = getStableBookKey(b);
   if (k) serverByKey.set(k, { ...b, book_key: b.book_key ?? k });
 });
 const localOnly: Book[] = [];
 updatedBooks.forEach((b) => {
   const k = getStableBookKey(b);
   if (!k) { localOnly.push(b); return; }
   const serverBook = serverByKey.get(k);
   if (!serverBook) {
     localOnly.push({ ...b, book_key: b.book_key ?? k });
   } else {
     serverByKey.set(k, mergeBookFieldLevel(serverBook, { ...b, book_key: b.book_key ?? k }));
   }
 });
 const merged = [...serverByKey.values(), ...localOnly];
 await Promise.resolve(options.onMerged(merged));
 if (__DEV__ && results.some(Boolean)) {
 logger.debug('[SYNC_PENDING_APPROVED]', { attempted: books.length, saved: results.filter(Boolean).length, mergedCount: merged.length });
 }
}

export type DescClientFetchMilestone = 'boot' | 'scan_complete' | 'approve_complete' | 'sync_complete';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical full-snapshot fetchers
//
// These are the ONLY functions allowed to populate libraryBooksById /
// libraryPhotosById (canonical state). They use count:exact on the first page
// to discover the server-reported total, then iterate until every row is
// fetched — even when the PostgREST max-rows cap is as low as 1.
//
// Rules:
//  1. Never call a "recent" or "limit(N)" query and use its result to REPLACE
//     canonical state. Partial results may only be MERGED into canonical state.
//  2. fetchAllApprovedBooks and fetchAllPhotos must be called whenever a full
//     snapshot is needed (boot, post-approve refresh barrier, post-sync).
//  3. loadBooksFromSupabase and loadPhotosFromSupabase delegate to these; they
//     exist for backward compat and add status-grouping / signed-URL logic on top.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize DB status so UI buckets (approved/pending/incomplete/rejected) work regardless of case/whitespace/variants.
 * Maps queued, processing, scanned, saving, in_progress → pending so books are not dropped.
 */
function normalizeBookStatus(raw: unknown): 'approved' | 'pending' | 'incomplete' | 'rejected' {
  const s = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  if (s === 'incomplete') return 'incomplete';
  // Treat any non-approved, non-rejected as pending (queued, processing, scanned, saving, in_progress, etc.)
  if (s === 'pending' || s === 'queued' || s === 'processing' || s === 'scanned' || s === 'saving' || s === 'in_progress') return 'pending';
  if (s === '') return 'pending';
  return 'pending';
}

/** Row shape returned by fetchAllApprovedBooks (raw DB columns, no transformation). */
export interface RawBookRow {
  id: string;
  user_id: string;
  title: string;
  author?: string | null;
  isbn?: string | null;
  confidence?: string | null;
  status: string;
  scanned_at?: number | null;
  cover_url?: string | null;
  local_cover_path?: string | null;
  google_books_id?: string | null;
  description?: string | null;
  enrichment_status?: string | null;
  page_count?: number | null;
  categories?: string[] | null;
  publisher?: string | null;
  published_date?: string | null;
  language?: string | null;
  average_rating?: number | null;
  ratings_count?: number | null;
  subtitle?: string | null;
  print_type?: string | null;
  read_at?: number | string | null;
  is_favorite?: boolean | null;
  source_photo_id?: string | null;
  source_scan_job_id?: string | null;
  book_key?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

/**
 * Verify (and if necessary refresh) the Supabase client session before any RLS-protected
 * read. RLS policies check auth.uid() — if the client has no active session, every read
 * returns 0 rows even when eq('user_id', userId) is correct. This is the most common cause
 * of FETCH_ALL_* returning serverTotal:0 right after approve (the approve used the server
 * service-role key; the client snapshot runs under RLS with an anon key + session).
 *
 * Returns { ok, sessionUserId, hadToRefresh, reason } so callers can log exactly what happened.
 */
async function ensureSessionForRead(callerLabel: string): Promise<{
  ok: boolean;
  sessionUserId: string | null;
  hadToRefresh: boolean;
  reason: string;
}> {
  if (!supabase) return { ok: false, sessionUserId: null, hadToRefresh: false, reason: 'no_client' };
  try {
    // AUTH_USER_ID: hits the Supabase Auth server (not local cache) — gold-standard check.
    // This tells us exactly what auth.uid() will return for RLS policies at this moment.
    const { data: getUserData, error: getUserErr } = await supabase.auth.getUser();
    logger.debug('[AUTH_USER_ID]', {
      caller: callerLabel,
      userId: getUserData?.user?.id ?? null,
      userIdPrefix: getUserData?.user?.id?.slice(0, 8) ?? null,
      email: getUserData?.user?.email ?? null,
      err: getUserErr?.message ?? null,
    });

    const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
    // Auth debug: all four lines collapsed into one logger.debug call.
    logger.debug('[AUTH_ID_COMPARISON]', {
      caller: callerLabel,
      getSessionId: session?.user?.id?.slice(0, 8) ?? null,
      getUserId: getUserData?.user?.id?.slice(0, 8) ?? null,
      hasSession: !!session,
      tokenLen: session?.access_token?.length ?? null,
      match: session?.user?.id === getUserData?.user?.id,
    });
    if (sessionErr) {
      logger.warn(`[SESSION_GUARD] ${callerLabel} getSession error`, { err: sessionErr.message });
      return { ok: false, sessionUserId: null, hadToRefresh: false, reason: 'get_session_error' };
    }
    if (session?.access_token && session?.user?.id) {
      return { ok: true, sessionUserId: session.user.id, hadToRefresh: false, reason: 'session_ok' };
    }
    // No valid session — attempt one refresh before giving up.
    logger.warn(`[SESSION_GUARD] ${callerLabel} no active session, attempting refresh`);
    const { data: { session: refreshed }, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed?.access_token || !refreshed?.user?.id) {
      logger.error(`[SESSION_GUARD] ${callerLabel} session refresh failed — RLS reads will return 0`, {
        refreshErr: refreshErr?.message ?? null,
        hasRefreshedToken: !!refreshed?.access_token,
      });
      return { ok: false, sessionUserId: null, hadToRefresh: true, reason: 'refresh_failed' };
    }
    logger.info(`[SESSION_GUARD] ${callerLabel} session refreshed successfully`, {
      sessionUserId: refreshed.user.id.slice(0, 8),
    });
    return { ok: true, sessionUserId: refreshed.user.id, hadToRefresh: true, reason: 'refreshed' };
  } catch (e: any) {
    logger.error(`[SESSION_GUARD] ${callerLabel} unexpected error`, { err: e?.message ?? String(e) });
    return { ok: false, sessionUserId: null, hadToRefresh: false, reason: 'exception' };
  }
}

/**
 * Fetch ALL approved book rows for a user using count-guided pagination.
 *
 * Uses `count: 'exact'` on the first request to learn the server-reported total,
 * then keeps fetching pages until `rows.length >= serverTotal`. This works even
 * when the PostgREST `max-rows` cap is as low as 1 — every page advances the
 * range offset by exactly however many rows the server returned.
 *
 * ONLY this function (and loadBooksFromSupabase which delegates to it) should
 * populate canonical booksById maps. Never use a "recent" or limit(N) query
 * to replace the canonical library state.
 */
export async function fetchAllApprovedBooks(userId: string, signal?: AbortSignal): Promise<RawBookRow[]> {
  if (!supabase) {
    logger.warn('[fetchAllApprovedBooks] Supabase not available');
    return [];
  }
  if (signal?.aborted) return [];

  const _t0 = Date.now();

  // Guard: verify the client has an active RLS session before querying.
  // Without a session, Supabase RLS returns 0 rows for every read even when the
  // user_id filter is correct. This is the root cause of serverTotal:0 right after
  // approve (approve runs server-side with service-role; this read uses anon+RLS).
  const sessionCheck = await ensureSessionForRead('fetchAllApprovedBooks');
  logger.debug('[FETCH_ALL_APPROVED_BOOKS] session_check', {
    hasSession: sessionCheck.ok,
    sessionUserId: sessionCheck.sessionUserId?.slice(0, 8) ?? null,
    callerUserId: userId.slice(0, 8),
    userIdMatch: sessionCheck.sessionUserId === userId,
    hadToRefresh: sessionCheck.hadToRefresh,
    reason: sessionCheck.reason,
  });
  if (!sessionCheck.ok) {
    logger.error('[FETCH_ALL_APPROVED_BOOKS] aborting — no RLS session; would return 0 rows and corrupt merge', {
      reason: sessionCheck.reason,
      userId: userId.slice(0, 8),
    });
    return [];
  }

  // Step 1: count-only query (head:true, no range) so we get an accurate total.
  // Mixing count:'exact' + .range() in one query is unreliable in PostgREST —
  // the count can return 0 even when data rows exist (documented supabase-js bug).
  // Separating the queries guarantees count accuracy.
  let q = supabase.from('books').select('*', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null).eq('status', 'approved');
  if (signal) q = q.abortSignal(signal);
  const { count: serverTotal, error: countErr } = await q;

  if (countErr) {
    logger.warn('[FETCH_ALL_APPROVED_BOOKS]', 'count query failed, will fetch one page and infer total', {
      err: countErr.message ?? String(countErr),
      userId: userId.slice(0, 8),
    });
  }

  logger.debug('[BOOKS_COUNT_QUERY_RESULT]', {
    count: serverTotal,
    error: countErr?.message ?? null,
    errorCode: (countErr as any)?.code ?? null,
    filters: { user_id: userId, deleted_at: 'IS NULL', status: 'approved' },
    userIdPrefix: userId.slice(0, 8),
  });

  // Companion diagnostic: count non-approved, non-deleted books so we can detect rows stuck
  // in 'pending' status that should have been approved (provenance guardrail regression).
  let qPending = supabase.from('books').select('*', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null).neq('status', 'approved').neq('status', 'rejected').neq('status', 'discarded');
  if (signal) qPending = qPending.abortSignal(signal);
  const { count: pendingCount } = await qPending;

  // Step 2: paginated data fetch — no count: option, just range.
  const allRows: RawBookRow[] = [];
  let offset = 0;
  let page = 0;
  const PAGE_LIMIT = 1000;
  let pageError: string | null = null;

  logger.debug('[SNAPSHOT_QUERY_META]', {
    table: 'books',
    filter_status: 'approved',
    filter_deleted_at: 'IS NULL',
    order: 'created_at DESC',
    pageLimit: PAGE_LIMIT,
    serverTotal: serverTotal ?? 'unknown',
    userIdPrefix: userId.slice(0, 8),
  });

  while (true) {
    if (signal?.aborted) break;
    let qPage = supabase.from('books').select('*').eq('user_id', userId).is('deleted_at', null).eq('status', 'approved').order('created_at', { ascending: false }).range(offset, offset + PAGE_LIMIT - 1);
    if (signal) qPage = qPage.abortSignal(signal);
    const { data, error } = await qPage;

    logger.debug('[BOOKS_PAGE_QUERY_RESULT]', {
      page,
      rangeFrom: offset,
      rangeTo: offset + PAGE_LIMIT - 1,
      dataLength: data?.length ?? null,
      error: error?.message ?? null,
      errorCode: (error as any)?.code ?? null,
      statusSample: (data ?? []).slice(0, 3).map((r: any) => r.status),
      userIdPrefix: userId.slice(0, 8),
    });

    if (error) {
      pageError = error.message ?? String(error);
      logger.error('[fetchAllApprovedBooks] error on page ' + page + ':', pageError);
      break;
    }

    const rows: RawBookRow[] = (data ?? []) as RawBookRow[];
    allRows.push(...rows);

    const hasNextPage = rows.length === PAGE_LIMIT && (serverTotal === null || allRows.length < serverTotal);
    logger.debug('[SNAPSHOT_QUERY_META]', {
      table: 'books',
      page,
      rangeFrom: offset,
      rangeTo: offset + PAGE_LIMIT - 1,
      rowsThisPage: rows.length,
      totalFetchedSoFar: allRows.length,
      hasNextPage,
    });
    if (!hasNextPage) break;

    offset += rows.length;
    page++;
  }

  const fetchComplete = serverTotal === null || allRows.length >= serverTotal;
  const countMismatch = serverTotal !== null && allRows.length !== serverTotal;
  const latencyMs = Date.now() - _t0;

  if (countMismatch) {
    logger.error('[FETCH_ALL_APPROVED_BOOKS]', 'SNAPSHOT_MISMATCH', {
      serverTotal,
      totalFetched: allRows.length,
      gap: serverTotal! - allRows.length,
      pendingOrIncompleteCount: pendingCount ?? 'unknown',
      userIdFull: userId,
      pages: page + 1,
      latencyMs,
      hint: 'Check RLS policies, PostgREST max-rows cap, and whether all approved rows have deleted_at=NULL and status=approved',
    });
  } else {
    // Single summary line — all the signal, none of the per-step noise.
    logger.info('[FETCH_ALL_APPROVED_BOOKS]', {
      serverTotal: serverTotal ?? 'unknown',
      totalFetched: allRows.length,
      pendingOrIncompleteCount: pendingCount ?? 'unknown',
      pages: page + 1,
      complete: fetchComplete,
      hadSessionRefresh: sessionCheck.hadToRefresh,
      pageError,
      userIdPrefix: userId.slice(0, 8),
      latencyMs,
    });
  }
  return allRows;
}

/** Row shape returned by fetchAllPhotos (raw DB columns). */
export interface RawPhotoRow {
  id: string;
  user_id: string;
  uri?: string | null;
  timestamp?: number | null;
  caption?: string | null;
  storage_path?: string | null;
  storage_url?: string | null;
  image_hash?: string | null;
  status?: 'draft' | 'complete' | 'discarded' | null;
  approved_count?: number | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

/**
 * Fetch ALL photo rows for a user using count-guided pagination.
 *
 * Same pagination strategy as fetchAllApprovedBooks — count-guided so it works
 * regardless of the PostgREST max-rows cap. Excludes discarded and deleted rows.
 *
 * ONLY this function (and loadPhotosFromSupabase which delegates to it) should
 * populate canonical photosById maps. Never use a partial/recent query to
 * replace canonical photo state.
 */
export async function fetchAllPhotos(userId: string, signal?: AbortSignal): Promise<RawPhotoRow[]> {
  if (!supabase) {
    logger.warn('[fetchAllPhotos] Supabase not available');
    return [];
  }
  if (signal?.aborted) return [];

  const _t0 = Date.now();

  // Guard: same RLS session check as fetchAllApprovedBooks — without a session all reads return 0.
  const sessionCheck = await ensureSessionForRead('fetchAllPhotos');
  logger.debug('[FETCH_ALL_PHOTOS] session_check', {
    hasSession: sessionCheck.ok,
    sessionUserId: sessionCheck.sessionUserId?.slice(0, 8) ?? null,
    callerUserId: userId.slice(0, 8),
    userIdMatch: sessionCheck.sessionUserId === userId,
    hadToRefresh: sessionCheck.hadToRefresh,
    reason: sessionCheck.reason,
  });
  if (!sessionCheck.ok) {
    logger.error('[FETCH_ALL_PHOTOS] aborting — no RLS session; would return 0 rows and corrupt merge', {
      reason: sessionCheck.reason,
      userId: userId.slice(0, 8),
    });
    return [];
  }

  // Step 1: count-only query (head:true, no range) — same reason as fetchAllApprovedBooks:
  // mixing count:'exact' + .range() is unreliable; separate the queries for accuracy.
  // Exclude discarded and scan_failed so only draft/complete (with scan results) appear in main library.
  let qCount = supabase.from('photos').select('*', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null).in('status', ['draft', 'complete']);
  if (signal) qCount = qCount.abortSignal(signal);
  const { count: serverTotal, error: countErr } = await qCount;

  if (countErr) {
    logger.warn('[FETCH_ALL_PHOTOS]', 'count query failed, will fetch one page and infer total', {
      err: countErr.message ?? String(countErr),
      userId: userId.slice(0, 8),
    });
  }

  logger.debug('[PHOTOS_COUNT_QUERY_RESULT]', {
    count: serverTotal,
    error: countErr?.message ?? null,
    errorCode: (countErr as any)?.code ?? null,
    filters: { user_id: userId, deleted_at: 'IS NULL', status: 'in draft,complete' },
    userIdPrefix: userId.slice(0, 8),
  });

  // Step 2: paginated data fetch — no count: option, just range.
  const allRows: RawPhotoRow[] = [];
  let offset = 0;
  let page = 0;
  const PAGE_LIMIT = 1000;
  let pageError: string | null = null;

  logger.debug('[SNAPSHOT_QUERY_META]', {
    table: 'photos',
    filter_deleted_at: 'IS NULL',
    filter_status: 'in draft,complete',
    order: 'timestamp DESC',
    pageLimit: PAGE_LIMIT,
    serverTotal: serverTotal ?? 'unknown',
    userIdPrefix: userId.slice(0, 8),
  });

  while (true) {
    if (signal?.aborted) break;
    let qPage = supabase.from('photos').select('*').eq('user_id', userId).is('deleted_at', null).in('status', ['draft', 'complete']).order('timestamp', { ascending: false }).range(offset, offset + PAGE_LIMIT - 1);
    if (signal) qPage = qPage.abortSignal(signal);
    const { data, error } = await qPage;

    logger.debug('[PHOTOS_PAGE_QUERY_RESULT]', {
      page,
      rangeFrom: offset,
      rangeTo: offset + PAGE_LIMIT - 1,
      dataLength: data?.length ?? null,
      error: error?.message ?? null,
      errorCode: (error as any)?.code ?? null,
      statusSample: (data ?? []).slice(0, 3).map((r: any) => r.status),
      userIdPrefix: userId.slice(0, 8),
    });

    if (error) {
      pageError = error.message ?? String(error);
      logger.error('[fetchAllPhotos] error on page ' + page + ':', pageError);
      break;
    }

    const rows: RawPhotoRow[] = (data ?? []).filter(
      (r: any) => r.id && typeof r.id === 'string'
    ) as RawPhotoRow[];
    allRows.push(...rows);

    const hasNextPage = rows.length === PAGE_LIMIT && (serverTotal === null || allRows.length < serverTotal);
    logger.debug('[SNAPSHOT_QUERY_META]', {
      table: 'photos',
      page,
      rangeFrom: offset,
      rangeTo: offset + PAGE_LIMIT - 1,
      rowsThisPage: rows.length,
      totalFetchedSoFar: allRows.length,
      hasNextPage,
    });
    if (!hasNextPage) break;

    offset += rows.length;
    page++;
  }

  const fetchComplete = serverTotal === null || allRows.length >= serverTotal;
  const countMismatch = serverTotal !== null && allRows.length !== serverTotal;
  const latencyMs = Date.now() - _t0;

  if (countMismatch) {
    logger.error('[FETCH_ALL_PHOTOS]', 'SNAPSHOT_MISMATCH', {
      serverTotal,
      totalFetched: allRows.length,
      gap: serverTotal! - allRows.length,
      userIdFull: userId,
      pages: page + 1,
      latencyMs,
      hint: 'Check RLS policies, PostgREST max-rows cap, and whether photos have deleted_at=NULL and status != discarded',
    });
  } else {
    // Single summary line — all the signal, none of the per-step noise.
    logger.info('[FETCH_ALL_PHOTOS]', {
      serverTotal: serverTotal ?? 'unknown',
      totalFetched: allRows.length,
      pages: page + 1,
      complete: fetchComplete,
      hadSessionRefresh: sessionCheck.hadToRefresh,
      pageError,
      userIdPrefix: userId.slice(0, 8),
      latencyMs,
    });
  }
  return allRows;
}

/**
 * Load all books from Supabase for a user, grouped by status.
 * Pass options.milestone to log [DESC_CLIENT_FETCH] at key moments (boot, approve, sync); otherwise logs only when total/withDesc change.
 * Pass options.signal (e.g. libraryAbortControllerRef) to cancel when user switches — do NOT pass scan abort signal.
 */
export async function loadBooksFromSupabase(
 userId: string,
 options?: { milestone?: DescClientFetchMilestone; signal?: AbortSignal }
): Promise<{
 pending: Book[];
 approved: Book[];
 rejected: Book[];
}> {
 if (!supabase) {
 logger.warn('Supabase not available, returning empty books');
 return { pending: [], approved: [], rejected: [] };
 }

 try {
 // Delegate to fetchAllApprovedBooks for the canonical approved snapshot.
 // fetchAllApprovedBooks uses count-guided pagination that works even when the
 // server-side PostgREST max-rows cap is as low as 1.
 // Pending and rejected are small sets; fetch them in a single paginated pass too.
 if (__DEV__) logger.debug('[MYLIB]', 'loadBooksFromSupabase → fetchAllApprovedBooks', { userId: userId.slice(0, 8) });

 // Approved: full snapshot via canonical fetcher.
 const approvedRaw = await fetchAllApprovedBooks(userId, options?.signal);

 // All non-approved books (pending, incomplete, rejected, and any variant: in_progress, processing, etc.)
 let nonApprovedRaw: any[] = [];
 {
   let prOffset = 0;
   let prDone = false;
   while (!prDone) {
     if (options?.signal?.aborted) break;
     let prQ = supabase.from('books').select('*').eq('user_id', userId).is('deleted_at', null).neq('status', 'approved').order('created_at', { ascending: false }).range(prOffset, prOffset + 999);
     if (options?.signal) prQ = prQ.abortSignal(options.signal);
     const { data: prData, error: prErr } = await prQ;
     if (prErr) { break; }
     const page = prData ?? [];
     nonApprovedRaw.push(...page);
     if (page.length < 1000) { prDone = true; }
     else { prOffset += page.length; }
   }
 }

 const allBooks: any[] = [...approvedRaw, ...nonApprovedRaw];

 // One-time diagnostic: confirm count and status shapes so we see unexpected statuses/deleted_at.
 logger.info('[BOOKS_FETCH_SHAPES]', {
   count: allBooks.length,
   approvedCount: approvedRaw.length,
   nonApprovedCount: nonApprovedRaw.length,
   sampleStatuses: allBooks.slice(0, 10).map((r: any) => (r.status ?? '').trim()),
   deletedAtPresent: allBooks.some((r: any) => r.deleted_at != null),
   userIdPrefix: userId.slice(0, 8),
 });

 if (allBooks.length === 0) {
   if (__DEV__) logger.debug('[MYLIB] books: 0');
   return { pending: [], approved: [], rejected: [] };
 }

 // Convert Supabase data to Book objects; normalize status so UI buckets work (trim/lowercase/variants).
 const books: Book[] = allBooks.map((row) => {
   const normalizedStatus = normalizeBookStatus(row.status);
   return {
 id: row.id || `${row.title}_${row.author || ''}_${row.scanned_at || Date.now()}`,
 dbId: row.id ?? undefined,
 book_key: row.book_key ?? undefined,
 title: row.title,
 author: row.author || undefined,
 isbn: row.isbn || undefined,
 confidence: row.confidence || undefined,
 status: normalizedStatus,
 // scanned_at is BIGINT in database, ensure it's a number or undefined
 scannedAt: row.scanned_at != null ? Number(row.scanned_at) : undefined,
 coverUrl: row.cover_url || undefined,
 localCoverPath: row.local_cover_path || undefined,
 googleBooksId: row.google_books_id || undefined,
 description: row.description || undefined,
 enrichment_status: row.enrichment_status ?? undefined,
 // Google Books API stats fields
 pageCount: row.page_count || undefined,
 categories: row.categories || undefined,
 publisher: row.publisher || undefined,
 publishedDate: row.published_date || undefined,
 language: row.language || undefined,
 averageRating: row.average_rating ? Number(row.average_rating) : undefined,
 ratingsCount: row.ratings_count || undefined,
 subtitle: row.subtitle || undefined,
 printType: row.print_type || undefined,
 readAt: row.read_at ? (typeof row.read_at === 'number' ? row.read_at : (typeof row.read_at === 'string' ? parseInt(row.read_at, 10) : new Date(row.read_at).getTime())) : undefined, // Map read_at from Supabase to readAt in Book (BIGINT -> number)
 is_favorite: row.is_favorite === true,
 source_photo_id: row.source_photo_id ?? undefined,
 sourcePhotoId: row.source_photo_id ?? undefined,
 photoId: row.source_photo_id ?? undefined,
 source_scan_job_id: row.source_scan_job_id ?? undefined,
 scanJobId: row.source_scan_job_id ?? undefined,
 };
 });
 // Single summary line instead of per-book logging.
 // Only emits when the totals actually change so sync loops don't spam.
 const mapTotals = {
 total: allBooks.length,
 enriched: 0,
 notFound: 0,
 zeroDesc: 0,
 };
 for (const b of allBooks) {
 const descLen = typeof b.description === 'string' ? b.description.trim().length : 0;
 if (descLen === 0) mapTotals.zeroDesc++;
 if (b.enrichment_status === 'complete') mapTotals.enriched++;
 if (b.enrichment_status === 'not_found') mapTotals.notFound++;
 }
 const mapSummaryKey = `${mapTotals.total}:${mapTotals.enriched}:${mapTotals.notFound}:${mapTotals.zeroDesc}`;
 logger.whenChanged(mapSummaryKey, 'info', '[LOAD_BOOKS_MAP_SUMMARY]', 'totals', mapTotals);
 if (__DEV__ && mapTotals.notFound > 0) {
 logger.debug('[LOAD_BOOKS_MAP_SAMPLE_NOT_FOUND]', 'sample',
 allBooks.filter(b => b.enrichment_status === 'not_found').slice(0, 2).map(b => ({
 id: b.id ?? null,
 title: typeof b.title === 'string' ? b.title.slice(0, 60) : null,
 enrichment_status: b.enrichment_status ?? null,
 }))
 );
 }

 const approved = books.filter((b) => b.status === 'approved');
 const rejected = books.filter((b) => b.status === 'rejected');

 // Log only when total/withDesc change or at key milestones (boot, approve, sync)
 const withDesc = books.filter((b) => typeof b.description === 'string' && b.description.trim().length > 0).length;
 const total = books.length;
 const descKey = `${total}:${withDesc}`;
 if (options?.milestone) {
 logger.info('[DESC_CLIENT_FETCH]', 'summary', { total, withDesc, milestone: options.milestone });
 logger.setWhenChangedKey('[DESC_CLIENT_FETCH]', descKey);
 } else {
 logger.whenChanged(descKey, 'info', '[DESC_CLIENT_FETCH]', 'summary', { total, withDesc });
 }

 // Pending: include ALL books with status pending or incomplete so UI shows them (e.g. 6 books from a completed scan).
 // No filter by open/terminal job — approved books are in approved list; merge/dedupe prevents duplicates.
 const pending = books.filter((b) => b.status === 'pending' || b.status === 'incomplete');

 const finalCount = pending.length + approved.length + rejected.length;

 if (__DEV__) logger.debug('[MYLIB]', 'books', { finalCount, pending: pending.length, approved: approved.length, rejected: rejected.length });

 return { pending, approved, rejected };
 } catch (error) {
 logger.error('Error loading books from Supabase:', error);
 return { pending: [], approved: [], rejected: [] };
 }
}

/** Lightweight fetch for enrichment: get title, author, cover_url, etc. by book ids. Merge results into local store so author/title appear without waiting for full rehydrate. */
export async function fetchBooksByIds(
  userId: string,
  bookIds: string[],
  signal?: AbortSignal
): Promise<Book[]> {
  if (!supabase || bookIds.length === 0) return [];
  const ids = bookIds.filter((id) => typeof id === 'string' && UUID_REGEX.test(id.trim()));
  if (ids.length === 0) return [];

  const sessionCheck = await ensureSessionForRead('fetchBooksByIds');
  if (!sessionCheck.ok) return [];

  let q = supabase
    .from('books')
    .select('id, title, author, cover_url, book_key, description, source_photo_id, source_scan_job_id, status, isbn, enrichment_status, page_count, publisher, published_date, categories, language, average_rating, ratings_count, subtitle')
    .eq('user_id', userId)
    .in('id', ids);
  if (signal) q = q.abortSignal(signal);
  const { data: rows, error } = await q;
  if (error) {
    logger.warn('[fetchBooksByIds]', error.message);
    return [];
  }
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row: any) => {
    const normalizedStatus = normalizeBookStatus(row.status);
    return {
      id: row.id,
      dbId: row.id ?? undefined,
      book_key: row.book_key ?? undefined,
      title: row.title ?? '',
      author: row.author ?? undefined,
      isbn: row.isbn ?? undefined,
      status: normalizedStatus,
      coverUrl: row.cover_url ?? undefined,
      description: row.description ?? undefined,
      enrichment_status: row.enrichment_status ?? undefined,
      pageCount: row.page_count ?? undefined,
      publisher: row.publisher ?? undefined,
      publishedDate: row.published_date ?? undefined,
      categories: row.categories ?? undefined,
      language: row.language ?? undefined,
      averageRating: row.average_rating != null ? Number(row.average_rating) : undefined,
      ratingsCount: row.ratings_count != null ? Number(row.ratings_count) : undefined,
      subtitle: row.subtitle ?? undefined,
      source_photo_id: row.source_photo_id ?? undefined,
      sourcePhotoId: row.source_photo_id ?? undefined,
      photoId: row.source_photo_id ?? undefined,
      source_scan_job_id: row.source_scan_job_id ?? undefined,
      scanJobId: row.source_scan_job_id ?? undefined,
    } as Book;
  });
}

/**
 * Load folders from Supabase for a user (for sync with app; website profile displays these).
 */
export async function loadFoldersFromSupabase(userId: string): Promise<Folder[]> {
 if (!supabase || userId === 'guest_user') return [];
 try {
 const { data, error } = await supabase
 .from('folders')
 .select('id, name, book_ids, created_at')
 .eq('user_id', userId)
 .order('created_at', { ascending: true });
 if (error) {
 if (__DEV__) logger.warn('[loadFoldersFromSupabase]', error.message);
 return [];
 }
 return (data || []).map((row: any) => ({
 id: row.id,
 name: row.name || 'Unnamed',
 bookIds: Array.isArray(row.book_ids) ? row.book_ids : (typeof row.book_ids === 'string' ? (() => { try { return JSON.parse(row.book_ids); } catch { return []; } })() : []),
 photoIds: [],
 createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
 }));
 } catch (e) {
 if (__DEV__) logger.warn('[loadFoldersFromSupabase]', e);
 return [];
 }
}

/**
 * Save folders to Supabase using upsert (by id) so existing rows are updated
 * rather than hard-deleted and re-inserted. Folders removed by the user are
 * soft-deleted (deleted_at = now) rather than physically removed so data is
 * recoverable. Never hard-deletes any row.
 */
export async function saveFoldersToSupabase(userId: string, folders: Folder[]): Promise<boolean> {
  if (!supabase || userId === 'guest_user') return false;
  try {
    const liveIds = new Set(folders.map(f => f.id));

    // 1) Soft-delete any rows in DB that are no longer in the local list.
    //    Only touches rows that don't have deleted_at already set.
    const { data: existingRows } = await supabase
      .from('folders')
      .select('id')
      .eq('user_id', userId)
      .is('deleted_at', null);
    const dbIds = (existingRows ?? []).map((r: any) => r.id as string);
    const toSoftDelete = dbIds.filter((id: string) => !liveIds.has(id));
    if (toSoftDelete.length > 0) {
      // NOTE: this is a sync-driven soft-delete (not a direct user gesture).
      // It is safe because toSoftDelete contains only folder IDs that the user has
      // already removed locally — we're just reconciling server state.
      const rid = startMutation({
        action: 'bulk_soft_delete',
        table: 'folders',
        entityType: 'folder',
        count: toSoftDelete.length,
        sourceScreen: 'saveFoldersToSupabase',
        userIdPrefix: userId.slice(0, 8),
        extra: { trigger: 'sync_reconcile', note: 'folders removed locally but still present on server' },
      });
      const { error: softDeleteErr } = await supabase
        .from('folders')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', toSoftDelete)
        .eq('user_id', userId);
      endMutation(rid, { ok: !softDeleteErr, error: softDeleteErr ?? undefined });
      if (softDeleteErr) {
        checkRlsDenied(softDeleteErr, { table: 'folders', action: 'update', userIdPrefix: userId.slice(0, 8), caller: 'saveFoldersToSupabase' });
        if (__DEV__) logger.warn('[saveFoldersToSupabase] soft-delete removed folders', softDeleteErr.message);
      }
    }

    if (folders.length === 0) return true;

    // 2) Upsert live folders (insert new, update existing).
    const rows = folders.map(f => ({
      id: f.id,
      user_id: userId,
      name: f.name,
      book_ids: f.bookIds || [],
      deleted_at: null, // ensure re-added folders are not marked deleted
    }));
    const { error: upsertError } = await supabase
      .from('folders')
      .upsert(rows, { onConflict: 'id' });
    if (upsertError) {
      if (__DEV__) logger.warn('[saveFoldersToSupabase] upsert', upsertError.message);
      return false;
    }
    return true;
  } catch (e) {
    if (__DEV__) logger.warn('[saveFoldersToSupabase]', e);
    return false;
  }
}

const DELETED_BOOK_IDS_KEY = (userId: string) => `deleted_book_ids_${userId}`;
// Stable-key tombstone — covers local-only books that have no UUID yet (composite temp ids).
// Keyed by pendingBookStableKey (db uuid → book_key → title|author|jobId fallback) so
// the server can't resurrect a deleted book even when it has no real DB row.
const DELETED_PENDING_STABLE_KEYS_KEY = (userId: string) => `deleted_pending_stable_keys_${userId}`;

/** Load the set of book IDs tombstoned as deleted (from photo delete). Merge must exclude these so we don't resurrect. */
export async function getDeletedBookIds(userId: string): Promise<Set<string>> {
 try {
 const raw = await AsyncStorage.getItem(DELETED_BOOK_IDS_KEY(userId));
 if (!raw) return new Set();
 const arr = JSON.parse(raw) as string[];
 return new Set(Array.isArray(arr) ? arr : []);
 } catch {
 return new Set();
 }
}

/** Add book IDs to the deleted tombstone (call after deleting a photo so merge doesn't resurrect). */
export async function addDeletedBookIdsTombstone(userId: string, bookIds: string[]): Promise<void> {
 if (bookIds.length === 0) return;
 try {
 const existing = await getDeletedBookIds(userId);
 bookIds.forEach(id => existing.add(id));
 await AsyncStorage.setItem(DELETED_BOOK_IDS_KEY(userId), JSON.stringify([...existing]));
 } catch (e) {
 logger.warn('Failed to persist deleted_book_ids tombstone:', e);
 }
}

/**
 * Load the set of stable keys tombstoned for deleted pending books.
 * Keys are scoped as baseKey|source_scan_job_id|source_photo_id so we only hide "this book from this scan",
 * not the same book from another scan. Old unscoped keys in storage no longer match (clear on Clear Library).
 */
export async function getDeletedPendingStableKeys(userId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DELETED_PENDING_STABLE_KEYS_KEY(userId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * Add stable keys to the pending-delete tombstone. Call immediately when a pending book is
 * deleted locally so that even if the server still has the row, rehydrate will filter it out.
 * Pass the same key that pendingBookStableKey() returns for that book.
 */
export async function addDeletedPendingStableKeysTombstone(userId: string, stableKeys: string[]): Promise<void> {
  if (stableKeys.length === 0) return;
  try {
    const existing = await getDeletedPendingStableKeys(userId);
    const prevTotal = existing.size;
    stableKeys.forEach(k => existing.add(k));
    await AsyncStorage.setItem(DELETED_PENDING_STABLE_KEYS_KEY(userId), JSON.stringify([...existing]));
    logger.info('[PENDING_TOMBSTONES]', {
      added: stableKeys.length,
      total: existing.size,
      newEntries: existing.size - prevTotal,
      sample: stableKeys.slice(0, 3),
    });
  } catch (e) {
    logger.warn('Failed to persist deleted_pending_stable_keys tombstone:', e);
  }
}

/** Clear pending tombstones (e.g. on Clear Library so new scans are not hidden by old tombstones). */
export async function clearDeletedPendingStableKeys(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(DELETED_PENDING_STABLE_KEYS_KEY(userId));
    logger.info('[PENDING_TOMBSTONES]', 'cleared (e.g. Clear Library)');
  } catch (e) {
    logger.warn('Failed to clear deleted_pending_stable_keys:', e);
  }
}

/** Result of deleteLibraryPhotoAndBooks for logging and rollback. */
export type DeletePhotoResult = {
  ok: boolean;
  /** Number of books soft-deleted (only when cascadeBooks=true). */
  booksDeleted?: number;
  /** Number of books detached (source_photo_id nulled) when cascadeBooks=false. */
  booksDetached?: number;
  photoDeleted?: number;
  error?: string;
};

/**
 * Flow A (safe): Delete a pending scan only. Never deletes approved books.
 * Calls POST /api/delete-pending-scan. Use when user cancels/removes a scan from the Scans tab.
 * When pendingBookIds is provided, server soft-deletes by id IN (...) AND status='pending' only (recommended).
 */
export async function deletePendingScanOnly(
 userId: string,
 options: { jobId?: string; batchId?: string; pendingBookIds?: string[] }
): Promise<{ ok: boolean; error?: string }> {
 const { jobId, batchId, pendingBookIds } = options;
 if ((!jobId || typeof jobId !== 'string') && (!batchId || typeof batchId !== 'string')) {
 return { ok: false, error: 'jobId or batchId required' };
 }
 try {
 const baseUrl = getApiBaseUrl();
 const ids = Array.isArray(pendingBookIds) ? pendingBookIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
 logger.debug('[DELETE_PENDING_SCAN_ONLY]', 'params', { jobId: jobId ?? null, batchId: batchId ?? null, pendingBookIdsCount: ids.length });
 logger.debug('[DELETE_CALL]', { endpoint: '/api/delete-pending-scan', jobId: jobId ?? null, batchId: batchId ?? null });
 const _deletePendingHeaders = await getScanAuthHeaders();
 const res = await fetch(`${baseUrl}/api/delete-pending-scan`, {
 method: 'POST',
 headers: { ..._deletePendingHeaders, 'Content-Type': 'application/json' },
 body: JSON.stringify({ jobId: jobId || undefined, batchId: batchId || undefined, pendingBookIds: ids.length > 0 ? ids : undefined }),
 });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) {
 return { ok: false, error: (data?.error as { message?: string })?.message ?? `HTTP ${res.status}` };
 }
 const jobsAffected = (data as { jobsAffected?: number }).jobsAffected;
 logger.debug('[DELETE_PENDING_SCAN_ONLY] done jobsAffected=', jobsAffected ?? null);
 return { ok: true };
 } catch (e: any) {
 logger.warn('[DELETE_PENDING_SCAN_ONLY] Error:', e?.message ?? e);
 return { ok: false, error: e?.message ?? 'Network error' };
 }
}

/** @deprecated Use deletePendingScanOnly. */
export const deletePendingScan = deletePendingScanOnly;

/**
 * Patch scan_jobs.photo_id to canonicalPhotoId after dedupe.
 * Enforces invariant: every scan_job must have photo_id set. Call after client decides canonicalPhotoId (reused ? existing.id : newPhotoId).
 */
export async function patchScanJobPhotoId(
 userId: string,
 jobId: string,
 photoId: string
): Promise<{ ok: boolean; error?: string }> {
 try {
 const baseUrl = getApiBaseUrl();
 if (!baseUrl) return { ok: false, error: 'No API base URL' };
 const _patchPhotoHeaders = await getScanAuthHeaders();
 const res = await fetch(`${baseUrl}/api/scan-job-patch-photo`, {
 method: 'POST',
 headers: { ..._patchPhotoHeaders, 'Content-Type': 'application/json' },
 body: JSON.stringify({ jobId, photoId }),
 });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) {
 const msg = (data?.error as { message?: string })?.message ?? `HTTP ${res.status}`;
 return { ok: false, error: msg };
 }
 return { ok: true };
 } catch (e: unknown) {
 const msg = e instanceof Error ? e.message : String(e);
 return { ok: false, error: msg };
 }
}

/**
 * Batch-patch books.source_photo_id for a list of book row IDs in a single UPDATE.
 *
 * CONTRACT (strict — no silent skips):
 * - If the photo row does not exist in DB, we THROW. The caller must ensure photos are
 *   committed before calling this (approvePromises now always runs after photo saves).
 *   "Will retry later" is not acceptable: localPhotoId never becomes real in the DB, so
 *   any skip leaves books permanently orphaned.
 * - If the Supabase UPDATE fails, we THROW so the approve pipeline can surface the error.
 * - Partial success (some rows not matched) logs a warning but does NOT throw — the rows
 *   may have been deleted or may not belong to this user, which is non-fatal.
 *
 * Logs once per batch (not once per book):
 * - success: debug
 * - photo row missing: error (throws)
 * - update error: error (throws)
 * - partial match: warn
 */
export async function batchPatchSourcePhotoId(
  userId: string,
  photoId: string,
  bookRowIds: string[]
): Promise<{ ok: boolean; countPatched: number; countFailed: number }> {
  if (!bookRowIds.length || !photoId) return { ok: true, countPatched: 0, countFailed: 0 };

  // Step 1: verify photo row exists. Throw if missing — "skip and retry" is unreliable because
  // the local photo ID never becomes a real row in the photos table after dedupe rewrite.
  const { data: photoRow, error: photoLookupErr } = await supabase
    .from('photos')
    .select('id')
    .eq('id', photoId)
    .eq('user_id', userId)
    .maybeSingle();

  if (photoLookupErr || !photoRow) {
    const reason = photoLookupErr?.message ?? 'not_found';
    logger.error('[PHOTO_FK_PATCH_MISSING_PHOTO]',
      'photo row absent — cannot patch books.source_photo_id; this indicates approvePromises ran before photo was committed', {
      photoId: photoId.slice(0, 8),
      bookCount: bookRowIds.length,
      reason,
    });
    throw new Error(`batchPatchSourcePhotoId: photo row ${photoId.slice(0, 8)} not found (${reason}). Books with local photo IDs will be orphaned.`);
  }

  // Step 2: single UPDATE for the whole batch.
  const { data: updated, error: patchErr } = await supabase
    .from('books')
    .update({ source_photo_id: photoId })
    .eq('user_id', userId)
    .in('id', bookRowIds)
    .select('id');

  if (patchErr) {
    logger.error('[PHOTO_FK_PATCH_FAIL]', 'batch patch failed', {
      photoId: photoId.slice(0, 8),
      countAttempted: bookRowIds.length,
      error: patchErr.message ?? String(patchErr),
      exampleIds: bookRowIds.slice(0, 2),
    });
    throw new Error(`batchPatchSourcePhotoId: UPDATE failed for photo ${photoId.slice(0, 8)}: ${patchErr.message}`);
  }

  const countPatched = updated?.length ?? 0;
  const countFailed = bookRowIds.length - countPatched;

  if (countFailed > 0) {
    const patchedSet = new Set((updated ?? []).map((r: { id: string }) => r.id));
    logger.warn('[PHOTO_FK_PATCH_PARTIAL]', {
      photoId: photoId.slice(0, 8),
      countAttempted: bookRowIds.length,
      countPatched,
      countFailed,
      exampleFailed: bookRowIds.filter(id => !patchedSet.has(id)).slice(0, 2),
      note: 'partial match is non-fatal — rows may have been deleted or belong to another user',
    });
  } else {
    logger.debug('[PHOTO_FK_PATCH_OK]', { photoId: photoId.slice(0, 8), countPatched });
  }

  return { ok: countFailed === 0, countPatched, countFailed };
}

/** Payload for background approve writes (queue worker). Must be JSON-serializable. */
export type ApproveWritesPayload = {
  newPending: Book[];
  newApproved: Book[];
  newRejected: Book[];
  newPhotos: Photo[];
  options?: {
    /** Book IDs (UUIDs) selected for approve; backend should update by id IN (...). Do not scope by scan job id. */
    selectedDbIds?: string[];
    photoIdForApproved?: string;
    photoIdsForApproved?: string[];
    scanJobIdForApproved?: string;
    /** Full scan job UUIDs only (not prefixes). */
    jobIdsToClose?: string[];
    [key: string]: unknown;
  };
};

export type RunApproveResult = {
  approvedWithRealIds: Book[];
  newPhotosRewritten: Photo[];
  photoAliases: Record<string, string>;
  jobIdsToClose: string[];
};

/**
 * Run the DB side of approve: photo saves, barrier, book saves, FK patch.
 * Used by the approve queue worker so completion is not tied to ScansTab being mounted.
 * resolvePhotoId: (id) => aliasMap[id] ?? id (alias map from AsyncStorage).
 */
export async function runApproveWrites(
  userId: string,
  payload: ApproveWritesPayload,
  resolvePhotoId: (id: string) => string,
  baseSaveOptions?: { apiBaseUrl?: string; accessToken?: string }
): Promise<RunApproveResult> {
  const { newPending, newApproved, newRejected, newPhotos, options } = payload;
  const photoIdForApproved = options?.photoIdForApproved ? resolvePhotoId(options.photoIdForApproved) : undefined;
  const explicitPhotoIds = (options?.photoIdsForApproved?.length
    ? options.photoIdsForApproved
    : [
        ...(photoIdForApproved ? [photoIdForApproved] : []),
        ...newApproved.map((b) => (b as any).source_photo_id).filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0),
      ]
  ).map(resolvePhotoId).filter((id) => id.trim().length > 0);
  const explicitSet = new Set(explicitPhotoIds);
  const photosToSaveFiltered = newPhotos.filter((p) => {
    const resolved = resolvePhotoId(p.id ?? '');
    if (!explicitSet.has(resolved)) return false;
    const hasUri = p.uri && typeof p.uri === 'string' && p.uri.trim().length > 0;
    const hasStoragePath = !!(p as any).storage_path && typeof (p as any).storage_path === 'string' && ((p as any).storage_path as string).trim().length > 0;
    return hasUri || hasStoragePath;
  });

  const canonicalPhotoIdMap = new Map<string, string>();
  const photoRewriteMap = new Map<string, { canonicalId: string; storagePath: string | null; storageUrl: string | null }>();
  const canonicalStorageMap = new Map<string, { storagePath: string | null; storageUrl: string | null }>();

  for (const photo of photosToSaveFiltered) {
    const result = await savePhotoToSupabase(userId, photo, { statusOverride: 'complete' });
    if (result.ok && result.canonicalPhotoId && photo.id) {
      canonicalPhotoIdMap.set(photo.id, result.canonicalPhotoId);
      if (result.canonicalPhotoId !== photo.id) {
        photoRewriteMap.set(photo.id, {
          canonicalId: result.canonicalPhotoId,
          storagePath: result.canonicalStoragePath ?? null,
          storageUrl: result.canonicalStorageUrl ?? null,
        });
      }
    }
    if (result.ok && photo.id) {
      canonicalStorageMap.set(photo.id, { storagePath: result.canonicalStoragePath ?? null, storageUrl: result.canonicalStorageUrl ?? null });
      if (result.canonicalPhotoId && result.canonicalPhotoId !== photo.id) {
        canonicalStorageMap.set(result.canonicalPhotoId, { storagePath: result.canonicalStoragePath ?? null, storageUrl: result.canonicalStorageUrl ?? null });
      }
    }
  }

  photoRewriteMap.forEach((rewrite, localId) => {
    if (!canonicalPhotoIdMap.has(localId)) canonicalPhotoIdMap.set(localId, rewrite.canonicalId);
  });

  if (supabase && userId) {
    for (const [localId, rewrite] of photoRewriteMap) {
      const { data: staleBooks, error: fetchErr } = await supabase.from('books').select('id').eq('user_id', userId).eq('source_photo_id', localId);
      if (!fetchErr && (staleBooks ?? []).length > 0) {
        const staleIds = (staleBooks ?? []).map((r: { id: string }) => r.id);
        await supabase.from('books').update({ source_photo_id: rewrite.canonicalId, updated_at: new Date().toISOString() }).eq('user_id', userId).in('id', staleIds);
      }
    }
  }

  const bookCanonicalPhotoIds = new Set<string>();
  for (const book of newApproved) {
    const rawPid = (book as any).source_photo_id as string | undefined;
    if (!rawPid) continue;
    const canonicalPid = canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoId(rawPid) ?? rawPid;
    if (canonicalPid && /^[0-9a-f-]{36}$/i.test(canonicalPid)) bookCanonicalPhotoIds.add(canonicalPid);
  }
  if (bookCanonicalPhotoIds.size > 0 && supabase) {
    const idsToCheck = [...bookCanonicalPhotoIds];
    const { data: existingPhotoRows, error: barrierErr } = await supabase.from('photos').select('id').eq('user_id', userId).in('id', idsToCheck);
    if (!barrierErr) {
      const foundIds = new Set((existingPhotoRows ?? []).map((r: { id: string }) => r.id));
      const missingIds = idsToCheck.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        throw new Error(`Approve barrier: ${missingIds.length} photo row(s) missing from DB. Please retry.`);
      }
    }
  }

  const approvedDbIds: (string | undefined)[] = new Array(newApproved.length);
  const scanJobIdForApproved = options?.scanJobIdForApproved;
  const approvePromises = newApproved.map((book, index) => {
    const rawSourcePhotoId = (book as any).source_photo_id ?? photoIdForApproved;
    const canonicalSourcePhotoId = rawSourcePhotoId ? (canonicalPhotoIdMap.get(rawSourcePhotoId) ?? resolvePhotoId(rawSourcePhotoId) ?? rawSourcePhotoId) : undefined;
    return saveBookToSupabase(userId, book, 'approved', {
      ...baseSaveOptions,
      sourcePhotoId: canonicalSourcePhotoId,
      sourceScanJobId: (book as any).source_scan_job_id ?? scanJobIdForApproved,
      onSuccess: (dbId) => { approvedDbIds[index] = dbId; },
    });
  });
  const bookPromises = [
    ...newPending.map((b) => saveBookToSupabase(userId, b, 'pending', { ...baseSaveOptions, sourcePhotoId: (b as any).source_photo_id ? (canonicalPhotoIdMap.get((b as any).source_photo_id) ?? resolvePhotoId((b as any).source_photo_id)) : undefined, sourceScanJobId: (b as any).source_scan_job_id })),
    ...approvePromises,
    ...newRejected.map((b) => saveBookToSupabase(userId, b, 'rejected', { ...baseSaveOptions, sourcePhotoId: (b as any).source_photo_id ? (canonicalPhotoIdMap.get((b as any).source_photo_id) ?? resolvePhotoId((b as any).source_photo_id)) : undefined, sourceScanJobId: (b as any).source_scan_job_id })),
  ];
  const bookResults = await Promise.all(bookPromises);
  const approveStart = newPending.length;
  const approveResults = bookResults.slice(approveStart, approveStart + newApproved.length);
  const failed = approveResults.filter((r) => !r).length;
  if (failed > 0) throw new Error(`Approve failed: ${failed} book(s) could not be saved. Please retry.`);

  const byPhoto = new Map<string, string[]>();
  newApproved.forEach((book, i) => {
    const dbId = approvedDbIds[i];
    if (!dbId) return;
    const rawPid = (book as any).source_photo_id ?? photoIdForApproved;
    const pid = rawPid ? (canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoId(rawPid) ?? rawPid) : undefined;
    if (pid && typeof pid === 'string') {
      if (!byPhoto.has(pid)) byPhoto.set(pid, []);
      byPhoto.get(pid)!.push(dbId);
    }
  });
  await Promise.all([...byPhoto.entries()].map(([pid, ids]) => batchPatchSourcePhotoId(userId, pid, ids)));

  const approvedWithRealIds: Book[] = newApproved.map((b, i) => {
    const dbId = approvedDbIds[i];
    const base = { ...b, identity_locked: true as const };
    const rawPid = (base as any).source_photo_id;
    if (rawPid) {
      const resolvedPid = canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoId(rawPid);
      if (resolvedPid && resolvedPid !== rawPid) (base as any).source_photo_id = resolvedPid;
    }
    if (dbId) return { ...base, id: dbId, dbId };
    return { ...base, sync_state: 'pending' as const, sync_pending_at: Date.now() };
  });

  const newPhotosRewritten: Photo[] = newPhotos.map((p) => {
    const localId = p.id ?? '';
    const rewrite = photoRewriteMap.get(localId);
    if (rewrite) {
      const patched: Photo = { ...p, id: rewrite.canonicalId };
      if (rewrite.storagePath && !(patched as any).storage_path) (patched as any).storage_path = rewrite.storagePath;
      if (rewrite.storageUrl && !(patched as any).storage_url) (patched as any).storage_url = rewrite.storageUrl;
      return patched;
    }
    const storageFix = canonicalStorageMap.get(localId);
    if (storageFix && !(p as any).storage_path?.trim?.() && !(p as any).storage_url?.startsWith?.('http')) {
      const patched: Photo = { ...p };
      if (storageFix.storagePath) (patched as any).storage_path = storageFix.storagePath;
      if (storageFix.storageUrl) (patched as any).storage_url = storageFix.storageUrl;
      return patched;
    }
    return p;
  });

  const jobIdsToClose = (options?.jobIdsToClose?.length ? options.jobIdsToClose : getJobIdsToCloseFromApproved(newApproved, options?.scanJobIdForApproved ? toScanJobId(options.scanJobIdForApproved) : undefined).jobIdsToClose) ?? [];
  const photoAliases: Record<string, string> = {};
  photoRewriteMap.forEach((rewrite, localId) => { photoAliases[localId] = rewrite.canonicalId; });

  return { approvedWithRealIds, newPhotosRewritten, photoAliases, jobIdsToClose };
}

/**
 * Delete a library photo. Only one codepath may call this: user tapped a delete button.
 * No refresh, sync, dedupe, or replace. Pass isUserInitiated: true only for explicit user action.
 *
 * cascadeBooks controls what happens to books tied to this photo:
 *   false (default) — books are DETACHED (source_photo_id set to null). Books survive in the library.
 *   true            — books are SOFT-DELETED. Only use when user explicitly confirms "Delete photo + books".
 *
 * IMPORTANT: photoId must be the photo row id (photos.id). Never pass jobId or a composite id.
 */
/**
 * Clean up orphaned photos: photos in the `photos` table that have no books
 * referencing them (via source_photo_id) and no active scan_jobs.
 * This prevents stale test/failed photos from inflating the photo count.
 * Safe to call on startup or after scan sessions complete.
 */
export async function cleanupOrphanedPhotos(userId: string): Promise<{ removed: number; error?: string }> {
  if (!supabase) return { removed: 0, error: 'supabase not available' };
  try {
    // 1. Get all active photos for the user
    const { data: photos, error: photosErr } = await supabase
      .from('photos')
      .select('id, created_at, status')
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (photosErr || !photos || photos.length === 0) {
      return { removed: 0, error: photosErr?.message };
    }

    // 2. Get all photo IDs referenced by non-deleted books
    const { data: bookRefs, error: bookErr } = await supabase
      .from('books')
      .select('source_photo_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .not('source_photo_id', 'is', null);

    if (bookErr) {
      return { removed: 0, error: bookErr.message };
    }

    const referencedPhotoIds = new Set((bookRefs ?? []).map((b: any) => b.source_photo_id));

    // 3. Get all photo IDs referenced by active scan_jobs (pending/processing)
    const { data: jobRefs, error: jobErr } = await supabase
      .from('scan_jobs')
      .select('photo_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .in('status', ['pending', 'processing'])
      .not('photo_id', 'is', null);

    if (jobErr) {
      return { removed: 0, error: jobErr.message };
    }

    const activeJobPhotoIds = new Set((jobRefs ?? []).map((j: any) => j.photo_id));

    // 4. Find orphaned photos: not referenced by any book or active job,
    //    and older than 10 minutes (to avoid racing with in-progress scans)
    const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const orphanedIds = photos
      .filter((p: any) =>
        !referencedPhotoIds.has(p.id) &&
        !activeJobPhotoIds.has(p.id) &&
        p.created_at < TEN_MINUTES_AGO
      )
      .map((p: any) => p.id);

    if (orphanedIds.length === 0) {
      logger.info('[CLEANUP_PHOTOS]', 'no orphaned photos found', { totalPhotos: photos.length, referencedByBooks: referencedPhotoIds.size });
      return { removed: 0 };
    }

    // 5. Soft-delete orphaned photos
    const { error: deleteErr } = await supabase
      .from('photos')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', orphanedIds)
      .eq('user_id', userId);

    if (deleteErr) {
      logger.error('[CLEANUP_PHOTOS]', 'soft-delete failed', { error: deleteErr.message, count: orphanedIds.length });
      return { removed: 0, error: deleteErr.message };
    }

    logger.info('[CLEANUP_PHOTOS]', 'removed orphaned photos', {
      removed: orphanedIds.length,
      totalPhotos: photos.length,
      referencedByBooks: referencedPhotoIds.size,
      activeJobs: activeJobPhotoIds.size,
    });
    return { removed: orphanedIds.length };
  } catch (err: any) {
    logger.error('[CLEANUP_PHOTOS]', 'unexpected error', { error: err?.message ?? String(err) });
    return { removed: 0, error: err?.message ?? String(err) };
  }
}

export async function deleteLibraryPhotoAndBooks(
  userId: string,
  photoId: string,
  cascadeBooks: boolean = false,
  isUserInitiated: boolean = false,
  imageHash?: string | null,
  /** Caller context for audit logs — screen or component name (e.g. 'ScansTab', 'PhotosScreen'). */
  screen?: string,
  /** Number of books that reference this photo, for audit logging. */
  bookCount?: number,
): Promise<DeletePhotoResult> {
  if (!isUserInitiated) {
    logDeleteBlocked({ reason: 'NOT_USER_INITIATED', photoId, screen, context: 'deleteLibraryPhotoAndBooks' });
    logger.debug('[DELETE_LIBRARY_PHOTO_AND_BOOKS]', 'rejected', { photoId, isUserInitiated: false });
    return { ok: false };
  }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) {
      logger.warn('[DELETE_LIBRARY_PHOTO_AND_BOOKS] no session / token');
      return { ok: false, error: 'Not authenticated' };
    }
    const baseUrl = getApiBaseUrl();
    if (!baseUrl) {
      logger.warn('[DELETE_LIBRARY_PHOTO_AND_BOOKS] no API base URL');
      return { ok: false, error: 'No API base URL configured' };
    }
    // Resolve canonical status from the in-process dedupe map.
    const _isCanonical = isCanonical(photoId);
    logDeleteIntent({
      screen: screen ?? 'unknown',
      photoId,
      isCanonical: _isCanonical,
      bookCount: bookCount ?? 0,
      cascadeBooks,
      imageHash,
    });
    logger.debug('[DELETE_LIBRARY_PHOTO_AND_BOOKS]', 'params', {
      photoId,
      cascadeBooks,
      source: 'user',
      photoIdChosenFrom: 'local_row',
      isCanonical: _isCanonical,
      imageHashForServerFallback: imageHash ? imageHash.slice(0, 16) + '' : null,
    });
    logger.info('[PHOTO_DELETE_INTENT]', {
      photoId,
      cascadeBooks,
      deleteStorage: true,
      deleteRow: true,
      imageHash: imageHash ? imageHash.slice(0, 16) + '' : null,
    });
 logger.debug('[DELETE_PHOTO_REQUEST]', { photoId });
 const res = await fetch(`${baseUrl}/api/delete-library-photo`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
 body: JSON.stringify({
 photoId,
 cascadeBooks,
 isUserInitiated: true,
 ...(imageHash ? { imageHash: imageHash.trim() } : {}),
 }),
 });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) {
 const errBody = data?.error as { message?: string; code?: string } | undefined;
 const errorMessage = typeof errBody === 'string' ? errBody : (errBody?.message ?? `HTTP ${res.status}`);
 logger.warn('[DELETE_LIBRARY_PHOTO_AND_BOOKS] API error', { status: res.status, photoId, error: errorMessage, body: data });
 return { ok: false, error: errorMessage };
 }
  const d = data as { booksDeleted?: number; booksDetached?: number; photoDeleted?: number; deletedStorageObjects?: number };
  const booksDeleted  = typeof d.booksDeleted  === 'number' ? d.booksDeleted  : undefined;
  const booksDetached = typeof d.booksDetached === 'number' ? d.booksDetached : undefined;
  const photoDeleted  = typeof d.photoDeleted  === 'number' ? d.photoDeleted  : undefined;
  const deletedStorageObjects = typeof d.deletedStorageObjects === 'number' ? d.deletedStorageObjects : (photoDeleted ? 1 : 0);
  logger.info('[PHOTO_DELETE_RESULT_DB]', { photoId, deletedPhotoRow: photoDeleted ?? 0, deletedBooks: booksDeleted ?? 0, booksDetached: booksDetached ?? 0, cascadeBooks });
  logger.info('[PHOTO_DELETE_RESULT_STORAGE]', { photoId, deletedStorageObjects });
  logger.info('[DELETE_PHOTO_RESULT]', { photoId, deletedBooks: booksDeleted ?? 0, booksDetached: booksDetached ?? 0, deletedPhotoRow: photoDeleted ?? 0, deletedStorageObjects });
  return { ok: true, booksDeleted, booksDetached, photoDeleted };
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 logger.error('[DELETE_LIBRARY_PHOTO_AND_BOOKS] Error:', error);
 return { ok: false, error: message };
 }
}

/** @deprecated Use deleteLibraryPhotoAndBooks. */
export const deletePhotoFromSupabase = deleteLibraryPhotoAndBooks;

/**
 * Delete a book from Supabase library (soft-delete with audit log)
 * 
 * SAFEGUARD: This function uses the delete_library_book RPC function which:
 * - Verifies user owns the book
 * - Inserts audit log entry
 * - Performs soft-delete (sets deleted_at) instead of hard delete
 * - Only works for authenticated users
 * 
 * Scans NEVER call this - only explicit user actions can delete books.
 */
export async function deleteBookFromSupabase(
 userId: string,
 book: Book,
 reason?: string
): Promise<boolean> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping book deletion');
 return false;
 }

 // Skip for guest users
 if (userId === 'guest_user') {
 return false;
 }

 // SAFEGUARD: Never soft-delete because a book is "missing locally" or during hydration/merge.
 // Only soft-delete when user explicitly taps delete/reject.
 if (reason === 'not_found_in_library') {
 if (__DEV__) logger.debug('SKIP_SOFT_DELETE not_found_in_library', book.id ?? `${book.title}_${book.author ?? ''}`);
 return false;
 }

 try {
 // Caller must pass userId from AuthContext/session we do not call getSession() here as source of truth.
 // Get book ID - prefer book.id, otherwise find by title+author
 let bookId: string | null = null;
 
 if (book.id) {
 // Verify the book exists and belongs to user
 const { data: existingBook } = await supabase
 .from('books')
 .select('id')
 .eq('id', book.id)
 .eq('user_id', userId)
 .is('deleted_at', null)
 .maybeSingle();
 
 if (existingBook) {
 bookId = existingBook.id;
 }
 }

 // If no ID match, try to find by title+author
 if (!bookId) {
 const authorForQuery = book.author || '';
 const { data: foundBook } = await supabase
 .from('books')
 .select('id')
 .eq('user_id', userId)
 .eq('title', book.title)
 .eq('author', authorForQuery)
 .is('deleted_at', null)
 .maybeSingle();
 
 if (foundBook) {
 bookId = foundBook.id;
 }
 }

 if (!bookId) {
 const deletedIds = await getDeletedBookIds(userId);
 if (book.id && deletedIds.has(book.id)) return true;
 // Idempotent: row already gone (e.g. after delete-pending or concurrent delete). Treat as success; don't warn.
 if (__DEV__) logger.debug('deleteBookFromSupabase: book not in DB (already deleted or never existed)', { title: book.title, id: book.id });
 return true;
 }

 // Call RPC function for safe deletion (soft-delete + audit log)
 const { data, error } = await supabase.rpc('delete_library_book', {
 p_book_id: bookId,
 p_reason: reason || 'User deleted from library'
 });

 if (error) {
 logger.error(' Error calling delete_library_book RPC:', error);
 return false;
 }

 if (!data || !data.success) {
 logger.error(' delete_library_book returned error:', data?.error || 'unknown');
 return false;
 }

 logger.debug(` Book soft-deleted: "${book.title}" (ID: ${bookId})`);
 return true;
 } catch (error) {
 logger.error('Error deleting book from Supabase:', error);
 return false;
 }
}

/** Only sync books from scan jobs completed in the last N hours when using batch filter. */
const SYNC_ON_OPEN_HOURS = 168; // 7 days max when filtering by batch_id

/**
 * Sync on Open: Completed scan jobs can only be imported once (canonical record: scan_job_imports).
 * 1) Fetch completed jobs (imported_at IS NULL for backwards compat).
 * 2) INSERT INTO scan_job_imports(scan_job_id, user_id) ON CONFLICT DO NOTHING; only jobs where insert
 * succeeds get processed (via RPC insert_scan_job_imports_once).
 * 3) Process only newly-imported jobs into pending; optionally set scan_jobs.imported_at.
 */
export async function syncCompletedScanJobs(
 userId: string,
 _options?: { knownBatchIds?: string[] }
): Promise<{ books: Book[]; jobIds: string[] }> {
 if (!supabase) {
 logger.warn('Supabase not available, skipping scan job sync');
 return { books: [], jobIds: [] };
 }

 if (userId === 'guest_user') {
 return { books: [], jobIds: [] };
 }

 try {
 const cutoff = new Date(Date.now() - SYNC_ON_OPEN_HOURS * 60 * 60 * 1000).toISOString();

 // Find unimported completed jobs: same criteria used in the "mark imported" update below. Include job_uuid (raw) and photo_id for provenance.
 const { data: completedJobs, error: jobsError } = await supabase
 .from('scan_jobs')
 .select('id, job_uuid, books, updated_at, created_at, batch_id, photo_id')
 .eq('user_id', userId)
 .eq('status', 'completed')
 .is('deleted_at', null)
 .is('imported_at', null)
 .gte('created_at', cutoff)
 .order('created_at', { ascending: false })
 .limit(100);

 if (jobsError) {
 logger.error('scan job fetch failed', JSON.stringify(jobsError, null, 2));
 return { books: [], jobIds: [] };
 }

 if (!completedJobs || completedJobs.length === 0) {
 logger.debug('No unimported completed scan jobs to sync');
 return { books: [], jobIds: [] };
 }

 logger.info('[SYNC_BATCH_START]', { numJobs: completedJobs.length });

 // scan_job_imports stores raw UUID only. Prefer scan_jobs.job_uuid; else strip job_ prefix from id.
 const jobIdsRaw = completedJobs
 .map((j: { id: string; job_uuid?: string | null }) => (j.job_uuid != null ? String(j.job_uuid) : toRawScanJobUuid(j.id)))
 .filter((id): id is string => id != null);
 const payload = jobIdsRaw.map((id) => toRawScanJobUuid(id)).filter((id): id is string => id != null);
 if (__DEV__ && payload.length > 0) {
 logger.debug('[SYNC]', 'scan_job_imports payload', { count: payload.length, ids: payload.slice(0, 3).join(','), more: payload.length > 3 });
 }

 let existingImportedIds: string[] = [];
 logger.debug('[SYNC] step A: check already imported');
 try {
 const { data: existingRows } = await supabase
 .from('scan_job_imports')
 .select('scan_job_id')
 .eq('user_id', userId)
 .in('scan_job_id', payload);
 existingImportedIds = (existingRows ?? []).map((r: { scan_job_id: string }) => String(r.scan_job_id));
 logger.debug('[SYNC] step A ok');
 } catch (e) {
 logger.error('[SYNC] step A FAILED', e);
 throw e;
 }

 let photoIdByJobId = new Map<string, string | null>();
 logger.debug('[SYNC] step B: resolve photo ids from scan_jobs');
 try {
 const { data: jobRows } = await supabase
 .from('scan_jobs')
 .select('job_uuid, photo_id')
 .eq('user_id', userId)
 .in('job_uuid', payload);
 if (jobRows) {
 jobRows.forEach((r: { job_uuid: string | null; photo_id: string | null }) => {
 if (r.job_uuid != null) photoIdByJobId.set(String(r.job_uuid), r.photo_id ?? null);
 });
 }
 logger.debug('[SYNC] step B ok');
 } catch (e) {
 logger.error('[SYNC] step B FAILED', e);
 throw e;
 }

 // Provenance: only import jobs that have scan_jobs.photo_id so every inserted book gets source_photo_id (fixes delete-photo cascade).
 const payloadWithPhoto = payload.filter((id) => {
 const pid = photoIdByJobId.get(id);
 return pid != null && pid !== '';
 });
 if (payloadWithPhoto.length < payload.length) {
 const missing = payload.length - payloadWithPhoto.length;
 logger.debug(`[SYNC] skipping ${missing} job(s) without scan_jobs.photo_id (will retry after client saves photo with jobId)`);
 }

 let newlyImportedIds: string[] | null = null;
 logger.debug('[SYNC] step C: insert scan_job_imports (jobs with photo_id only)');
 // Temporary: single-row insert first to get a clean error if it fails (batch can hide the offender).
 const one = payloadWithPhoto[0];
 if (!one) {
 newlyImportedIds = [];
 } else {
 const oneRow = {
 user_id: userId,
 scan_job_id: one,
 photo_id: photoIdByJobId.get(one) ?? null,
 };
 logger.debug('[SYNC] step C payload sample', oneRow);
 logger.debug('[SYNC] step C payload keys', Object.keys(oneRow));
 try {
 const { data: firstData, error: firstError } = await supabase
 .from('scan_job_imports')
 .insert(oneRow)
 .select()
 .single();
 if (firstError) {
 const err = firstError as any;
 logger.error('[SYNC] step C FAILED (single-row insert) raw', firstError);
 logger.error('[SYNC] step C FAILED json', JSON.stringify(firstError, null, 2));
 logger.error('[SYNC] step C FAILED fields', {
 code: err?.code,
 message: err?.message,
 details: err?.details,
 hint: err?.hint,
 status: err?.status,
 });
 return { books: [], jobIds: [] };
 }
 // Single row worked; insert the rest.
 const rest = payloadWithPhoto.slice(1);
 if (rest.length === 0) {
 newlyImportedIds = [one];
 } else {
 const restRows = rest.map((id) => ({
 user_id: userId,
 scan_job_id: id,
 photo_id: photoIdByJobId.get(id) ?? null,
 }));
 const { data: restData, error: restError } = await supabase
 .from('scan_job_imports')
 .insert(restRows)
 .select('scan_job_id');
 if (restError) {
 const err = restError as any;
 logger.error('[SYNC] step C FAILED (rest batch) raw', restError);
 logger.error('[SYNC] step C FAILED json', JSON.stringify(restError, null, 2));
 logger.error('[SYNC] step C FAILED fields', {
 code: err?.code,
 message: err?.message,
 details: err?.details,
 hint: err?.hint,
 status: err?.status,
 });
 return { books: [], jobIds: [] };
 }
 const restIds = (restData ?? []).map((r: { scan_job_id: string }) => String(r.scan_job_id));
 newlyImportedIds = [one, ...restIds];
 }
 logger.debug('[SYNC] step C ok');
 } catch (e: any) {
 logger.error('[SYNC] step C FAILED raw', e);
 logger.error('[SYNC] step C FAILED json', JSON.stringify(e, null, 2));
 logger.error('[SYNC] step C FAILED fields', {
 code: e?.code,
 message: e?.message,
 details: e?.details,
 hint: e?.hint,
 status: e?.status,
 });
 throw e;
 }
 }

 const insertedSet = new Set<string>((newlyImportedIds ?? []).map((id: string) => String(id)));
 const jobsToProcess = completedJobs.filter((j: { id: string; job_uuid?: string | null }) => {
 const raw = j.job_uuid != null ? String(j.job_uuid) : toRawScanJobUuid(j.id);
 return raw != null && insertedSet.has(raw) && (photoIdByJobId.get(raw) ?? (j as any).photo_id);
 });
 if (jobsToProcess.length === 0) {
 logger.debug(' No new scan jobs to import (all already in scan_job_imports)');
 return { books: [], jobIds: [] };
 }

 logger.debug(` Importing ${jobsToProcess.length} jobs (canonical: scan_job_imports); ${completedJobs.length - jobsToProcess.length} already imported`);

 // INVARIANT: Sync never creates library books. Only approve creates books. Sync only reconciles
 // state (scan_job_imports, imported_at) so we don't re-process the same job. Pending list is
 // derived from open scan jobs + scan_jobs.books, not from the books table.

 const nowIso = new Date().toISOString();
 const jobIdsToMarkRaw = jobsToProcess
 .map((j: { id: string; job_uuid?: string | null }) => ((j as any).job_uuid != null ? String((j as any).job_uuid) : toRawScanJobUuid(j.id)))
 .filter((id): id is string => id != null);

 // Mark imported: same WHERE as the query; use job_uuid (uuid) not id (text)
 if (jobIdsToMarkRaw.length > 0) {
 const { error: updateErr } = await supabase
 .from('scan_jobs')
 .update({ imported_at: nowIso, updated_at: nowIso })
 .eq('user_id', userId)
 .eq('status', 'completed')
 .is('imported_at', null)
 .in('job_uuid', jobIdsToMarkRaw);
 if (updateErr) {
 logger.warn('scan_jobs.imported_at update failed:', updateErr.message);
 }
 }

 // Pending is from open scan jobs + scan_jobs.books, not from books table. Sync does not insert books.
 // Book rows are created by the job processor (api/scan.ts upsertBooksAndEnrichMetadata) when the scan completes, not by this sync step.
 const jobIdsToMark = jobsToProcess.map((j: { id: string }) => j.id);
 logger.info('[SYNC_BATCH_COMPLETE]', {
 jobsProcessed: jobIdsToMark.length,
 booksInsertedBySync: 0,
 note: 'Book rows are inserted by job processor (api/scan.ts), not by sync',
 });
 return { books: [], jobIds: jobIdsToMark };
 } catch (e) {
 logger.error('scan job fetch failed', e instanceof Error ? e.message : logger.safeStringify(e));
 return { books: [], jobIds: [] }; // NO FALLBACK no merge, no resurrection, no ghosts
 }
}

// ── Undo last delete ──────────────────────────────────────────────────────────

export interface UndoDeleteResult {
  ok: boolean;
  booksRestored: number;
  photosRestored: number;
  error?: string;
}

/**
 * Undo a soft-delete within the UNDO_WINDOW_MS window.
 *
 * Clears deleted_at = NULL for the book/photo rows that were affected by the
 * given destructive action.  Only works within 10 minutes of the action.
 *
 * This is purely a DB-level undo — the caller is responsible for refreshing
 * local state after this resolves (e.g., call loadUserData() / rehydrate).
 */
export async function undoLastDelete(
  userId: string,
  action: {
    actionId: string;
    at: number;
    bookIds?: string[];
    photoIds?: string[];
  },
  undoWindowMs = 10 * 60 * 1000,
): Promise<UndoDeleteResult> {
  if (!supabase) {
    return { ok: false, booksRestored: 0, photosRestored: 0, error: 'supabase_unavailable' };
  }
  const ageMs = Date.now() - action.at;
  if (ageMs > undoWindowMs) {
    logger.warn('[UNDO_DELETE]', 'undo window expired', { actionId: action.actionId, ageMs, undoWindowMs });
    return { ok: false, booksRestored: 0, photosRestored: 0, error: `undo_window_expired (${Math.round(ageMs / 1000)}s > ${Math.round(undoWindowMs / 1000)}s)` };
  }

  let booksRestored = 0;
  let photosRestored = 0;
  const now = new Date().toISOString();

  // Restore books by IDs if provided.
  if (action.bookIds && action.bookIds.length > 0) {
    const { data: restoredBooks, error: bookErr } = await supabase
      .from('books')
      .update({ deleted_at: null, updated_at: now })
      .eq('user_id', userId)
      .in('id', action.bookIds)
      .not('deleted_at', 'is', null)
      .select('id');
    if (bookErr) {
      logger.error('[UNDO_DELETE]', 'book restore failed', { error: bookErr.message, actionId: action.actionId });
      return { ok: false, booksRestored: 0, photosRestored: 0, error: bookErr.message };
    }
    booksRestored = restoredBooks?.length ?? 0;
  }

  // Restore photos by IDs if provided.
  if (action.photoIds && action.photoIds.length > 0) {
    const { data: restoredPhotos, error: photoErr } = await supabase
      .from('photos')
      .update({ deleted_at: null, updated_at: now })
      .eq('user_id', userId)
      .in('id', action.photoIds)
      .not('deleted_at', 'is', null)
      .select('id');
    if (photoErr) {
      logger.error('[UNDO_DELETE]', 'photo restore failed', { error: photoErr.message, actionId: action.actionId });
      return { ok: false, booksRestored, photosRestored: 0, error: photoErr.message };
    }
    photosRestored = restoredPhotos?.length ?? 0;
  }

  logger.info('[UNDO_DELETE]', 'undo complete', {
    actionId: action.actionId,
    ageMs,
    booksRestored,
    photosRestored,
    userId: userId.slice(0, 8),
  });
  return { ok: true, booksRestored, photosRestored };
}

