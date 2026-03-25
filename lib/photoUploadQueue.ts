/**
 * Durable upload queue (AsyncStorage). Not tied to ScansTab mounting.
 *
 * - Persists queue to AsyncStorage: upload_queue_${userId}
 * - Worker processes 1–2 items at a time (MAX_CONCURRENT), continues across navigation, resumes on app start
 * - States: queued → uploading → uploaded → processing → complete; failed/canceled with exponential backoff retry
 * - Idempotent: storage_path = ${userId}/${photoId}.jpg (photoId-based); scan job get-or-create on server
 * - Cleanup: delete local original file after upload+processing success; keep thumbnail/cache only
 *
 * Only cancel on: explicit user cancel, sign-out, switching users.
 * Navigation away from Photos/Scans tab must NOT cancel uploads or clear this queue.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState, type NativeEventSubscription } from 'react-native';
import { getApiBaseUrl } from './getEnvVar';
import { getScanAuthHeaders } from './authHeaders';
import { toScanJobId } from './scanId';
import { logger } from '../utils/logger';
import { supabase } from './supabase';

const UPLOAD_QUEUE_PREFIX = 'upload_queue_';
const WORKER_INTERVAL_MS = 2500;
const MAX_CONCURRENT = 2;
const MAX_RETRIES = 10;

/** In-flight Step C (create scan job) per photoId. Second invocation for same photo awaits this and reuses jobId — prevents duplicate scan jobs. */
const stepCInFlightByPhotoId = new Map<string, Promise<string>>();
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 120; // ~4 min

export type UploadQueueState =
  | 'queued'
  | 'uploading'
  | 'created'   // photo row upserted
  | 'uploaded'  // storage upload done — only then request scan
  | 'scan_requested'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'canceled';

export interface UploadQueueItem {
  photoId: string;
  userId: string;
  /** Durable staging path (documentDirectory/scan-staging/photoId.jpg). Worker reads from this only. */
  localUri: string;
  createdAt: number;
  retries: number;
  state: UploadQueueState;
  jobId?: string;
  scanJobId?: string;
  errorMessage?: string;
  retryAfter?: number;
}

/** Durable staging dir (documentDirectory) so files are not evicted by cache clear. */
function getDurableScanStagingDir(): string {
  const base = FileSystem.documentDirectory ?? '';
  return base ? `${base}scan-staging/` : '';
}

/** Copy temp/cache URI to durable staging path. Returns { stagingUri, bytes } or null on failure. */
export async function copyToDurableStaging(
  sourceUri: string,
  photoId: string
): Promise<{ stagingUri: string; bytes: number } | null> {
  const dir = getDurableScanStagingDir();
  if (!dir) return null;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const stagingPath = `${dir}${photoId}.jpg`;
    await FileSystem.copyAsync({ from: sourceUri, to: stagingPath });
    const fileInfo = await FileSystem.getInfoAsync(stagingPath, { size: true });
    const exists = !!fileInfo.exists;
    const bytes = (fileInfo as FileSystem.FileInfo & { size?: number }).size ?? 0;
    return exists ? { stagingUri: stagingPath, bytes } : null;
  } catch (e) {
    logger.warn('[UPLOAD_QUEUE]', 'copyToDurableStaging failed', { photoId: photoId.slice(0, 8), err: (e as Error)?.message });
    return null;
  }
}

function queueKey(userId: string): string {
  return `${UPLOAD_QUEUE_PREFIX}${userId}`;
}

export async function getQueue(userId: string): Promise<UploadQueueItem[]> {
  const key = queueKey(userId);
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as UploadQueueItem[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function persistQueue(userId: string, items: UploadQueueItem[]): Promise<void> {
  const key = queueKey(userId);
  await AsyncStorage.setItem(key, JSON.stringify(items));
}

/** Add item to queue. When sourceUri is provided, staging is mandatory: copy to durable path first; if staging file doesn't exist after copy, do not enqueue. */
export async function addToQueue(
  item: Omit<UploadQueueItem, 'retries' | 'state'> & { sourceUri?: string }
): Promise<boolean> {
  const list = await getQueue(item.userId);
  let stagingUri: string;
  if (item.sourceUri) {
    const result = await copyToDurableStaging(item.sourceUri, item.photoId);
    if (!result || !result.stagingUri) {
      logger.warn('[UPLOAD_QUEUE]', 'addToQueue: staging mandatory — copy failed, not enqueueing', { photoId: item.photoId.slice(0, 8) });
      return false;
    }
    const existsCheck = await FileSystem.getInfoAsync(result.stagingUri);
    if (!existsCheck.exists) {
      logger.warn('[UPLOAD_QUEUE]', 'addToQueue: staging mandatory — file missing after copy, not enqueueing', { photoId: item.photoId.slice(0, 8), stagingUri: result.stagingUri.slice(0, 60) });
      return false;
    }
    logger.info('[STAGING]', 'wrote', { photoId: item.photoId.slice(0, 8), stagingUri: result.stagingUri, bytes: result.bytes, exists: true });
    stagingUri = result.stagingUri;
  } else {
    stagingUri = item.localUri;
  }
  const newItem: UploadQueueItem = {
    ...item,
    localUri: stagingUri,
    retries: 0,
    state: 'queued',
  };
  if (list.some((i) => i.photoId === item.photoId)) return true;
  list.push(newItem);
  await persistQueue(item.userId, list);
  logger.info('[UPLOAD_QUEUE]', 'added', { photoId: item.photoId.slice(0, 8), userId: item.userId?.slice(0, 8), stagingUri: stagingUri.slice(0, 50) });
  return true;
}

export async function updateItem(
  userId: string,
  photoId: string,
  update: Partial<UploadQueueItem>
): Promise<void> {
  const list = await getQueue(userId);
  const idx = list.findIndex((i) => i.photoId === photoId);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...update };
  await persistQueue(userId, list);
}

/** Reset a failed item to queued so the worker picks it up again. Returns true if item was found and reset. */
export async function retryQueueItem(userId: string, photoId: string): Promise<boolean> {
  const list = await getQueue(userId);
  const idx = list.findIndex((i) => i.photoId === photoId);
  if (idx < 0) return false;
  const item = list[idx];
  if (item.state !== 'failed') return false;
  list[idx] = {
    ...item,
    state: 'queued',
    retries: 0,
    retryAfter: undefined,
    errorMessage: undefined,
  };
  await persistQueue(userId, list);
  logger.info('[UPLOAD_QUEUE]', 'retry', { photoId: photoId.slice(0, 8) });
  return true;
}

/** Mark all queued/uploading items for this user as canceled. Do NOT clear the queue. */
export async function cancelAllForUser(userId: string): Promise<number> {
  const list = await getQueue(userId);
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].state === 'queued' || list[i].state === 'uploading') {
      list[i] = { ...list[i], state: 'canceled' as const };
      count++;
    }
  }
  if (count > 0) {
    await persistQueue(userId, list);
    logger.info('[UPLOAD_QUEUE]', 'cancelAllForUser', { userId: userId?.slice(0, 8), count });
  }
  return count;
}

/** Clear queue for user (e.g. on sign-out). */
export async function clearQueueForUser(userId: string): Promise<void> {
  await AsyncStorage.removeItem(queueKey(userId));
}

/** Remove a single item from the queue (e.g. when scan is complete so we don't re-process or re-upload). */
export async function removeFromQueue(userId: string, photoId: string): Promise<boolean> {
  const list = await getQueue(userId);
  const idx = list.findIndex((i) => i.photoId === photoId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  await persistQueue(userId, list);
  logger.info('[UPLOAD_QUEUE]', 'removed (done)', { photoId: photoId.slice(0, 8) });
  return true;
}

function backoffMs(retries: number): number {
  const ms = INITIAL_BACKOFF_MS * Math.pow(2, retries);
  return Math.min(ms, MAX_BACKOFF_MS);
}

let workerTimerId: ReturnType<typeof setInterval> | null = null;
let getCurrentUserId: (() => string | null) | null = null;
let appStateSubscription: NativeEventSubscription | null = null;
let workerPausedByBackground = false;
/** Called when a photo is uploaded to Storage and photos row is upserted; client can update local state. */
let onPhotoUploaded: ((userId: string, photoId: string, storagePath: string) => void) | null = null;
/** Called when scan job is complete and books are imported; client can set photo status 'complete'. */
let onPhotoComplete: ((userId: string, photoId: string) => void) | null = null;
/** Called when upload or processing fails; client can set photo status 'failed_upload' or 'scan_failed' and show "Failed — tap to retry". Optional statusCode (e.g. 413) so UI can set scan_failed. */
let onPhotoUploadFailed: ((userId: string, photoId: string, errorMessage?: string, statusCode?: number) => void) | null = null;
/** Called when Step C returns (scan job created). Client can add scanJobId to activeScanJobIds so bar stays visible until terminal. */
let onScanJobCreated: ((userId: string, photoId: string, scanJobId: string) => void) | null = null;
/** Called when queue's internal poll returns terminal (completed/failed/canceled). Client removes scanJobId from activeScanJobIds. */
let onJobTerminalStatus: ((jobId: string, status: 'completed' | 'failed' | 'canceled') => void) | null = null;

export function setOnPhotoUploaded(cb: ((userId: string, photoId: string, storagePath: string) => void) | null): void {
  onPhotoUploaded = cb;
}

export function setOnScanJobCreated(cb: ((userId: string, photoId: string, scanJobId: string) => void) | null): void {
  onScanJobCreated = cb;
}

export function setOnJobTerminalStatusQueue(cb: ((jobId: string, status: 'completed' | 'failed' | 'canceled') => void) | null): void {
  onJobTerminalStatus = cb;
}

export function setOnPhotoComplete(cb: ((userId: string, photoId: string) => void) | null): void {
  onPhotoComplete = cb;
}

export function setOnPhotoUploadFailed(cb: ((userId: string, photoId: string, errorMessage?: string, statusCode?: number) => void) | null): void {
  onPhotoUploadFailed = cb;
}

async function readUriAsBase64(localUri: string): Promise<string> {
  const exists = await FileSystem.getInfoAsync(localUri);
  if (!exists.exists) {
    throw new Error('File not found: ' + localUri.slice(0, 60));
  }
  return FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** Step B: upload file to Supabase Storage and upsert photos row. Returns { storagePath, dbOk } when upload succeeds; dbOk false when upload ok but DB upsert failed (caller must ack failed, no retry). */
async function uploadToStorageAndUpsertPhoto(
  userId: string,
  photoId: string,
  localUri: string
): Promise<{ storagePath: string; dbOk: boolean } | null> {
  const { getCanonicalPhotoStoragePath } = await import('./photoStoragePath');
  const storagePath = getCanonicalPhotoStoragePath(userId, photoId);
  let sizeBytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(localUri, { size: true });
    sizeBytes = (info as FileSystem.FileInfo & { size?: number }).size ?? 0;
  } catch {
    // use 0 if we can't read size
  }
  logger.info('[STEP_B]', 'upload_start', { photoId, stagingUri: localUri, storagePath, sizeBytes });

  const { uploadPhotoToStorage } = await import('../services/supabaseSync');
  const result = await uploadPhotoToStorage(userId, photoId, localUri);
  if (!result?.storagePath) return null;
  const uploadedStoragePath = result.storagePath;
  if (!supabase) return { storagePath: uploadedStoragePath, dbOk: true };
  // Never write 'uploaded' to photos.status. Use DB-allowed status only (complete after STEP_B upload_ok).
  const { normalizePhotoStatusForDb } = await import('./photoStatusGuard');
  const { status } = normalizePhotoStatusForDb('complete');
  const processingStage = 'uploaded';
  const timestampMs = Date.now();
  const nowIso = new Date().toISOString();
  const payload = {
    id: photoId,
    user_id: userId,
    storage_path: uploadedStoragePath,
    status,
    processing_stage: processingStage,
    books: [] as unknown[],
    timestamp: timestampMs,
    updated_at: nowIso,
  };
  logger.info('[UPLOAD_QUEUE]', 'photos upsert payload (proves status/timestamp if status_check or timestamp fails)', {
    photoId: photoId.slice(0, 8),
    status: payload.status,
    timestamp: payload.timestamp,
    storage_path: payload.storage_path ?? '',
    user_id: (payload.user_id ?? '').slice(0, 8),
  });
  const { data, error } = await supabase
    .from('photos')
    .upsert(payload, { onConflict: 'id' })
    .select('id, updated_at');
  if (error) {
    logger.warn('[UPLOAD_QUEUE]', 'photos upsert error', {
      photoId: photoId.slice(0, 8),
      code: error.code,
      message: error.message,
      details: error.details,
      hint: (error as { hint?: string }).hint,
    });
    return { storagePath: uploadedStoragePath, dbOk: false };
  }
  logger.info('[UPLOAD_QUEUE]', 'photos upsert result', {
    photoId: photoId.slice(0, 8),
    ok: true,
    id: (data?.[0] as { id?: string } | undefined)?.id ?? photoId,
    updated_at: (data?.[0] as { updated_at?: string } | undefined)?.updated_at,
  });
  onPhotoUploaded?.(userId, photoId, uploadedStoragePath);
  return { storagePath: uploadedStoragePath, dbOk: true };
}

/** Retry never: use when the local file is missing so retrying would never succeed. */
const NO_RETRY_AFTER_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Request scan (only after upload succeeded and storage confirmed) then poll until done. Sends only metadata (photoId, storagePath); server uses storage. */
async function requestScanAndPoll(
  userId: string,
  photoId: string,
  localUri: string,
  item: UploadQueueItem,
  baseUrl: string,
  storagePath: string
): Promise<void> {
  // Idempotency guard: re-read from durable storage so we see jobId if another tick or concurrent invocation already persisted it.
  const queue = await getQueue(userId);
  const storedItem = queue.find((i) => i.photoId === photoId);
  const storedJobId = (storedItem?.jobId ?? storedItem?.scanJobId) ?? null;
  const validStoredJobId =
    storedJobId && typeof storedJobId === 'string' && storedJobId.trim().length >= 8 ? storedJobId.trim() : null;

  let jobIdFromCreate: string | null = validStoredJobId ?? (item.jobId ?? item.scanJobId) ?? null;
  if (jobIdFromCreate) {
    logger.info('[STEP_C]', 'create_scan_job_skip_dedupe', { photoId, existingJobId: jobIdFromCreate, reason: 'already have jobId (persisted), polling only' });
    await updateItem(userId, photoId, { state: 'scan_requested', jobId: jobIdFromCreate, scanJobId: jobIdFromCreate });
  } else {
    // Another invocation may be calling the create API for this photo right now — wait for it and reuse jobId.
    const inFlight = stepCInFlightByPhotoId.get(photoId);
    if (inFlight) {
      try {
        jobIdFromCreate = await inFlight;
        logger.info('[STEP_C]', 'create_scan_job_skip_dedupe', { photoId, existingJobId: jobIdFromCreate, reason: 'reused jobId from in-flight create' });
        await updateItem(userId, photoId, { state: 'scan_requested', jobId: jobIdFromCreate, scanJobId: jobIdFromCreate });
      } catch {
        // In-flight create failed; re-read storage in case it succeeded just before failing.
        const again = await getQueue(userId);
        const againItem = again.find((i) => i.photoId === photoId);
        const againJobId = (againItem?.jobId ?? againItem?.scanJobId) ?? null;
        if (againJobId && typeof againJobId === 'string' && againJobId.trim().length >= 8) {
          jobIdFromCreate = againJobId.trim();
          await updateItem(userId, photoId, { state: 'scan_requested', jobId: jobIdFromCreate, scanJobId: jobIdFromCreate });
        }
        // If still no jobId, fall through and we will call the API below (only one invocation now; lock was released).
      }
    }
  }

  let headers: Record<string, string>;
  try {
    headers = (await getScanAuthHeaders()) as Record<string, string>;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const errMsg = msg.slice(0, 200);
    logger.info('[STEP_C]', 'create_scan_job_err', { photoId, code: 'auth_headers', message: errMsg });
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    return;
  }

  if (!jobIdFromCreate) {
  let resolveStepC: (v: string) => void;
  let rejectStepC: (e: unknown) => void;
  const stepCPromise = new Promise<string>((resolve, reject) => {
    resolveStepC = resolve;
    rejectStepC = reject;
  });
  stepCInFlightByPhotoId.set(photoId, stepCPromise);
  const clearInFlight = () => {
    stepCInFlightByPhotoId.delete(photoId);
  };

  logger.info('[STEP_C]', 'create_scan_job_start', { photoId, storagePath });
  const scanUrl = `${baseUrl}/api/scan`;
  // Hard rule: STEP_C body must be ONLY photoId + storagePath (server infers userId from token). Nothing else — no uri, base64, blob, file.
  const STEP_C_MAX_BODY_BYTES = 2 * 1024;
  const STEP_C_ALLOWED_KEYS = ['photoId', 'storagePath'] as const;
  const payload: { photoId: string; storagePath: string } = {
    photoId: String(photoId),
    storagePath: String(storagePath),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadKeys = Object.keys(payload);
  const hasOnlyAllowedKeys =
    payloadKeys.length === STEP_C_ALLOWED_KEYS.length &&
    payloadKeys.every((k) => STEP_C_ALLOWED_KEYS.includes(k as typeof STEP_C_ALLOWED_KEYS[number]));
  const forbidden = ['data:image', 'base64', 'blob:'];
  const hasForbidden = forbidden.some((s) => payloadJson.toLowerCase().includes(s));
  const overLimit = payloadJson.length > STEP_C_MAX_BODY_BYTES;

  const cookieLen = (headers['Cookie'] ?? headers['cookie'] ?? '').length;
  const headersApprox = Object.keys(headers).reduce((n, k) => n + k.length + (headers[k]?.length ?? 0), 0);
  logger.info('[STEP_C]', 'guard_before_fetch', {
    payloadJsonLength: payloadJson.length,
    cookieLength: cookieLen,
    headersApproxChars: headersApprox,
    hasOnlyAllowedKeys,
    hasForbiddenSubstring: hasForbidden,
    payloadKeys,
  });

  if (!hasOnlyAllowedKeys || hasForbidden || overLimit) {
    const errMsg = !hasOnlyAllowedKeys
      ? `STEP_C body keys must be exactly photoId,storagePath; got: ${payloadKeys.join(',')}`
      : hasForbidden
        ? 'STEP_C body must not contain uri/base64/blob'
        : `STEP_C body too large: ${payloadJson.length} bytes (max ${STEP_C_MAX_BODY_BYTES})`;
    const assertErr = new Error(
      `[STEP_C] create_scan_job guard failed before fetch: ${errMsg}. payloadKeys=[${payloadKeys.join(',')}] payloadLength=${payloadJson.length}`
    );
    logger.warn('[STEP_C]', 'guard_failed', {
      photoId: photoId.slice(0, 8),
      errMsg,
      payloadJsonLength: payloadJson.length,
      payloadKeys,
    });
    await updateItem(userId, photoId, {
      state: 'failed',
      errorMessage: errMsg,
      retryAfter: NO_RETRY_AFTER_MS,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    clearInFlight();
    rejectStepC!(assertErr);
    throw assertErr;
  }

  let response: Response;
  let responseText: string;
  try {
    response = await fetch(scanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: payloadJson,
    });
    responseText = await response.text();
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const errMsg = msg.slice(0, 200);
    logger.info('[STEP_C]', 'create_scan_job_err', { photoId, code: 'fetch', message: errMsg });
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    clearInFlight();
    rejectStepC!(e);
    return;
  }

  if (!response.ok) {
    const errMsg = `HTTP ${response.status}: ${responseText.slice(0, 150)}`;
    const statusCode = response.status;
    logger.info('[STEP_C]', 'create_scan_job_err', { photoId, code: String(statusCode), message: errMsg });
    // Set photo status to scan_failed on server; store last_error_code (e.g. 413) in scan_error.
    try {
      const { getScanAuthHeaders } = await import('./authHeaders');
      const headers = (await getScanAuthHeaders()) as Record<string, string>;
      const failUrl = `${baseUrl}/api/photo-scan-failed`;
      await fetch(failUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ photoId, code: statusCode, message: responseText.slice(0, 300) }),
      });
    } catch (e) {
      logger.warn('[STEP_C]', 'photo-scan-failed API call failed (non-fatal)', { photoId: photoId.slice(0, 8), err: (e as Error)?.message });
    }
    // Stop auto-retry: set retryAfter far in future so worker never picks this item again. Keep item in queue so "tap to retry" can re-queue.
    await updateItem(userId, photoId, {
      state: 'failed',
      errorMessage: errMsg,
      retryAfter: NO_RETRY_AFTER_MS,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg, statusCode);
    clearInFlight();
    rejectStepC!(new Error(errMsg));
    return;
  }

  let data: { jobId?: string; status?: string };
  try {
    data = JSON.parse(responseText) as { jobId?: string; status?: string };
  } catch {
    const errMsg = 'Invalid JSON response';
    logger.info('[STEP_C]', 'create_scan_job_err', { photoId, code: 'invalid_json', message: errMsg });
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    clearInFlight();
    rejectStepC!(new Error(errMsg));
    return;
  }

  jobIdFromCreate = data.jobId ?? null;
  const rawFromCreate = jobIdFromCreate != null && typeof jobIdFromCreate === 'string' ? jobIdFromCreate.trim() : '';
  if (!rawFromCreate || rawFromCreate.length < 8) {
    const errMsg = rawFromCreate === '' ? 'No jobId in response' : 'jobId too short';
    logger.info('[STEP_C]', 'create_scan_job_err', { photoId, code: 'no_job_id', message: errMsg });
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    clearInFlight();
    rejectStepC!(new Error(errMsg));
    return;
  }
  jobIdFromCreate = rawFromCreate;

  logger.info('[STEP_C]', 'create_scan_job_ok', { photoId, scanJobId: jobIdFromCreate });
  logger.info('[UPLOAD_QUEUE]', 'step 3 scan_job created', { photoId: photoId.slice(0, 8), jobId: String(jobIdFromCreate).slice(0, 8) });
  await updateItem(userId, photoId, { state: 'scan_requested', jobId: jobIdFromCreate, scanJobId: jobIdFromCreate });
  onScanJobCreated?.(userId, photoId, jobIdFromCreate);
  resolveStepC!(jobIdFromCreate);
  clearInFlight();
  }

  const jobId = jobIdFromCreate!;
  await updateItem(userId, photoId, { state: 'processing' });
  const pollUrl = `${baseUrl}/api/scan/${jobId}`;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let pollResp: Response;
    let pollText: string;
    try {
      pollResp = await fetch(pollUrl, {
        headers: { Accept: 'application/json', ...headers },
      });
      pollText = await pollResp.text();
    } catch {
      continue;
    }
    if (!pollResp.ok) {
      // 404/410: job was deleted (profile cleared) — remove zombie item and stop polling.
      if (pollResp.status === 404 || pollResp.status === 410) {
        logger.info('[UPLOAD_QUEUE]', 'poll job gone (404/410) — removing zombie', { photoId: photoId.slice(0, 8), jobId: String(jobId).slice(0, 8), status: pollResp.status });
        completedPhotoIds.add(photoId);
        await removeFromQueue(userId, photoId);
        return;
      }
      continue;
    }
    let pollData: { status?: string };
    try {
      pollData = JSON.parse(pollText) as { status?: string };
    } catch {
      continue;
    }
    const status = pollData.status;
    if (status === 'completed') {
      const raw = jobId != null && typeof jobId === 'string' ? jobId.trim() : '';
      if (raw && raw.length >= 8) {
        const fullId = toScanJobId(raw);
        logger.info('[UPLOAD_QUEUE]', 'job terminal dispatch', { photoId: photoId.slice(0, 8), jobId: fullId.slice(0, 12), hasCallback: !!onJobTerminalStatus, fullIdLen: fullId.length });
        if (fullId.length >= 40) {
          try {
            onJobTerminalStatus?.(fullId, 'completed');
          } catch (e) {
            logger.error('[UPLOAD_QUEUE]', 'onJobTerminalStatus threw', { photoId: photoId.slice(0, 8), error: String(e) });
          }
        }
      }
      completedPhotoIds.add(photoId); // Mark permanently done — prevents zombie re-processing.
      onPhotoComplete?.(userId, photoId);
      await removeFromQueue(userId, photoId);
      if (localUri && (localUri.startsWith('file://') || localUri.startsWith('file:'))) {
        try {
          const exists = await FileSystem.getInfoAsync(localUri);
          if (exists.exists) {
            await FileSystem.deleteAsync(localUri, { idempotent: true });
            logger.debug('[UPLOAD_QUEUE]', 'deleted staging after success', { photoId: photoId.slice(0, 8) });
          }
        } catch (e) {
          logger.warn('[UPLOAD_QUEUE]', 'cleanup delete failed (non-fatal)', { photoId: photoId.slice(0, 8), err: (e as Error)?.message });
        }
      }
      logger.info('[UPLOAD_QUEUE]', 'complete', { photoId: photoId.slice(0, 8), jobId: (jobId ?? '').slice(0, 8) });
      return;
    }
    if (status === 'failed' || status === 'canceled') {
      const raw = jobId != null && typeof jobId === 'string' ? jobId.trim() : '';
      if (raw && raw.length >= 8) {
        const fullId = toScanJobId(raw);
        if (fullId.length >= 40) onJobTerminalStatus?.(fullId, status as 'failed' | 'canceled');
      }
      const errMsg = `Job ${status}`;
      await updateItem(userId, photoId, { state: 'failed', errorMessage: errMsg });
      onPhotoUploadFailed?.(userId, photoId, errMsg);
      return;
    }
  }

  const errMsg = 'Poll timeout';
  // Mark as completed to prevent infinite re-processing on next tick.
  completedPhotoIds.add(photoId);
  await updateItem(userId, photoId, { state: 'failed', errorMessage: errMsg });
  onPhotoUploadFailed?.(userId, photoId, errMsg);
}

// Track items currently being processed AND permanently completed.
// inFlightPhotoIds: prevents concurrent processing of the same photo.
// completedPhotoIds: prevents re-processing of photos that already finished successfully.
const inFlightPhotoIds = new Set<string>();
const completedPhotoIds = new Set<string>();

async function processOneItem(item: UploadQueueItem): Promise<void> {
  const { userId, photoId, localUri } = item;
  // Skip if already completed in this session (zombie prevention).
  if (completedPhotoIds.has(photoId)) {
    // Force remove from queue to clean up the zombie entry.
    removeFromQueue(userId, photoId).catch(() => {});
    return;
  }
  // Prevent concurrent processing of the same photo.
  if (inFlightPhotoIds.has(photoId)) {
    return;
  }
  inFlightPhotoIds.add(photoId);
  try {
    return await _processOneItemInner(item);
  } finally {
    inFlightPhotoIds.delete(photoId);
  }
}

async function _processOneItemInner(item: UploadQueueItem): Promise<void> {
  const { userId, photoId, localUri } = item;
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    const errMsg = 'No API base URL';
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    return;
  }

  // If already past upload, skip to scan request (resume after restart/re-process).
  // This prevents zombie re-uploads for items that already have a scan job.
  if (item.state === 'uploaded' || item.state === 'scan_requested' || item.state === 'processing') {
    const fileInfoResume = await FileSystem.getInfoAsync(localUri);
    if (!fileInfoResume.exists) {
      const errMsg = 'Photo file missing, please re-select.';
      logger.warn('[UPLOAD_QUEUE]', 'staging file missing on resume', { photoId: photoId.slice(0, 8) });
      await updateItem(userId, photoId, {
        state: 'failed',
        errorMessage: errMsg,
        retryAfter: Date.now() + NO_RETRY_AFTER_MS,
      });
      onPhotoUploadFailed?.(userId, photoId, errMsg);
      return;
    }
    const { getCanonicalPhotoStoragePath } = await import('./photoStoragePath');
    const resumeStoragePath = getCanonicalPhotoStoragePath(userId, photoId);
    await requestScanAndPoll(userId, photoId, localUri, item, baseUrl, resumeStoragePath);
    return;
  }

  // Fail fast when staging file no longer exists. Do not retry.
  const fileInfo = await FileSystem.getInfoAsync(localUri);
  if (!fileInfo.exists) {
    const errMsg = 'Photo file missing, please re-select.';
    logger.warn('[UPLOAD_QUEUE]', 'staging file missing, marking failed (no retry)', {
      photoId: photoId.slice(0, 8),
      localUriPrefix: localUri.slice(0, 60),
    });
    await updateItem(userId, photoId, {
      state: 'failed',
      errorMessage: errMsg,
      retryAfter: Date.now() + NO_RETRY_AFTER_MS,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    return;
  }

  await updateItem(userId, photoId, { state: 'uploading' });

  // Step A — upload to Storage then upsert photos row. Only after both succeed do we request scan.
  const uploadResult = await uploadToStorageAndUpsertPhoto(userId, photoId, localUri);
  if (!uploadResult) {
    const errMsg = 'Upload to Storage failed';
    await updateItem(userId, photoId, {
      state: 'failed',
      retries: item.retries + 1,
      retryAfter: Date.now() + backoffMs(item.retries),
      errorMessage: errMsg,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    return;
  }
  if (!uploadResult.dbOk) {
    const errMsg = 'Photos DB update failed (upload succeeded)';
    await updateItem(userId, photoId, {
      state: 'failed',
      errorMessage: errMsg,
      retryAfter: Date.now() + NO_RETRY_AFTER_MS,
    });
    onPhotoUploadFailed?.(userId, photoId, errMsg);
    return;
  }

  // Ack upload: persist state so app restarts don't re-upload. Only after upload_ok + DB success.
  await updateItem(userId, photoId, { state: 'uploaded' });
  logger.info('[UPLOAD_QUEUE]', 'ack uploaded', { photoId: photoId.slice(0, 8) });

  await requestScanAndPoll(userId, photoId, localUri, item, baseUrl, uploadResult.storagePath);
}

async function workerTick(): Promise<void> {
  const userId = getCurrentUserId?.() ?? null;
  if (!userId) return;

  let list = await getQueue(userId);
  const now = Date.now();

  // Purge stale items: remove entries older than 10 minutes that are stuck in
  // 'scan_requested' or 'processing' state. These are zombies from previous sessions
  // whose scan jobs may have been deleted (profile clear). Without this, they loop
  // indefinitely, blocking new scans.
  const STALE_MS = 2 * 60 * 1000; // 2 minutes — scan jobs complete in ~30s, anything older is stuck
  const beforePurge = list.length;
  list = list.filter((item) => {
    const age = now - (item.createdAt ?? 0);
    const isStuckState = item.state === 'scan_requested' || item.state === 'processing' || item.state === 'uploaded' || item.state === 'queued';
    if (age > STALE_MS && isStuckState) {
      logger.info('[UPLOAD_QUEUE]', 'purge stale item', { photoId: item.photoId?.slice(0, 8), state: item.state, ageMs: age });
      completedPhotoIds.add(item.photoId);
      return false; // remove from queue
    }
    return true;
  });
  if (list.length < beforePurge) {
    await persistQueue(userId, list);
    logger.info('[UPLOAD_QUEUE]', 'purged stale items', { removed: beforePurge - list.length });
  }

  // Mark items that exceeded MAX_RETRIES as permanently failed.
  let mutated = false;
  for (const item of list) {
    if (item.state === 'failed' && item.retries >= MAX_RETRIES) {
      item.state = 'failed';
      item.errorMessage = `Permanently failed after ${MAX_RETRIES} retries`;
      item.retryAfter = undefined;
      mutated = true;
      onPhotoUploadFailed?.(userId, item.photoId, item.errorMessage);
      logger.warn('[UPLOAD_QUEUE]', 'max retries exceeded', { photoId: item.photoId.slice(0, 8), retries: item.retries });
    }
  }
  if (mutated) await persistQueue(userId, list);

  const runnable = list.filter(
    (i) =>
      (i.state === 'queued' || i.state === 'uploaded' || i.state === 'scan_requested' || i.state === 'processing' ||
       (i.state === 'failed' && i.retries < MAX_RETRIES && (i.retryAfter ?? 0) <= now)) &&
      i.state !== 'canceled'
  );
  const toProcess = runnable.slice(0, MAX_CONCURRENT);

  for (const item of toProcess) {
    if (item.state === 'canceled') continue;
    processOneItem(item).catch((e) => {
      logger.warn('[UPLOAD_QUEUE]', 'processOneItem error', { photoId: item.photoId?.slice(0, 8), error: String(e) });
    });
  }
}

/**
 * Start the durable upload worker. Runs every WORKER_INTERVAL_MS.
 * getCurrentUserId: return current user id or null (only that user's queue is processed).
 */
export function startUploadQueueWorker(getUserId: () => string | null): void {
  if (workerTimerId != null) return;
  getCurrentUserId = getUserId;
  workerPausedByBackground = false;
  workerTimerId = setInterval(workerTick, WORKER_INTERVAL_MS);
  workerTick();

  // Pause worker when app goes to background to save battery / avoid iOS suspension issues.
  if (!appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && workerPausedByBackground) {
        workerPausedByBackground = false;
        if (workerTimerId == null && getCurrentUserId) {
          workerTimerId = setInterval(workerTick, WORKER_INTERVAL_MS);
          workerTick();
          logger.info('[UPLOAD_QUEUE]', 'worker resumed (foreground)');
        }
      } else if (nextState === 'background' && workerTimerId != null) {
        clearInterval(workerTimerId);
        workerTimerId = null;
        workerPausedByBackground = true;
        logger.info('[UPLOAD_QUEUE]', 'worker paused (background)');
      }
    });
  }
  logger.info('[UPLOAD_QUEUE]', 'worker started');
}

export function stopUploadQueueWorker(): void {
  if (workerTimerId != null) {
    clearInterval(workerTimerId);
    workerTimerId = null;
  }
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  workerPausedByBackground = false;
  getCurrentUserId = null;
  logger.info('[UPLOAD_QUEUE]', 'worker stopped');
}
