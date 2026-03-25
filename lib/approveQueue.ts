/**
 * Durable approve queue (AsyncStorage). Not tied to ScansTab mounting.
 *
 * - On Approve tap: enqueue job and return immediately; UI shows optimistic state.
 * - Worker processes one job at a time (MAX_CONCURRENT_APPROVE_JOBS=1), continues across navigation, resumes on app start.
 * - Exponential backoff on failure (INITIAL_BACKOFF_MS, MAX_BACKOFF_MS). Idempotent: same payload can be retried.
 *
 * Completion must NOT depend on PhotosTab/ScansTab being open.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiBaseUrl } from './getEnvVar';
import { getScanAuthHeaders } from './authHeaders';
import { logger } from '../utils/logger';
import {
  runApproveWrites,
  type ApproveWritesPayload,
} from '../services/supabaseSync';
import type { Book } from '../types/BookTypes';
import { addApproveMutation, markMutationConfirmed } from './approveMutationsOutbox';

const APPROVE_QUEUE_PREFIX = 'approve_queue_';
const PHOTO_ALIASES_PREFIX = 'photo_id_aliases_';
const APPROVE_WORKER_INTERVAL_MS = 3000;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_APPROVE_JOBS = 1;

export type ApproveJobState = 'queued' | 'running' | 'done' | 'failed';

export interface ApproveQueueItem {
  id: string;
  userId: string;
  payload: ApproveWritesPayload;
  createdAt: number;
  state: ApproveJobState;
  retries: number;
  retryAfter?: number;
  errorMessage?: string;
}

function queueKey(userId: string): string {
  return `${APPROVE_QUEUE_PREFIX}${userId}`;
}

function backoffMs(retries: number): number {
  const ms = INITIAL_BACKOFF_MS * Math.pow(2, retries);
  return Math.min(ms, MAX_BACKOFF_MS);
}

export async function getApproveQueue(userId: string): Promise<ApproveQueueItem[]> {
  const raw = await AsyncStorage.getItem(queueKey(userId));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as ApproveQueueItem[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getApprovePendingCount(userId: string): Promise<number> {
  const list = await getApproveQueue(userId);
  const now = Date.now();
  return list.filter(
    (i) =>
      i.state === 'queued' ||
      i.state === 'running' ||
      (i.state === 'failed' && (i.retryAfter ?? 0) <= now)
  ).length;
}

async function persistQueue(userId: string, items: ApproveQueueItem[]): Promise<void> {
  await AsyncStorage.setItem(queueKey(userId), JSON.stringify(items));
}

export async function addApproveJob(userId: string, payload: ApproveWritesPayload): Promise<string> {
  const id = `approve_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const list = await getApproveQueue(userId);
  const newItem: ApproveQueueItem = {
    id,
    userId,
    payload,
    createdAt: Date.now(),
    state: 'queued',
    retries: 0,
  };
  list.push(newItem);
  await persistQueue(userId, list);
  logger.info('[APPROVE_QUEUE]', 'added', {
    jobId: typeof id === 'string' ? id.slice(0, 16) : '(?)',
    approvedCount: payload.newApproved.length,
    photosCount: payload.newPhotos.length,
  });
  return id;
}

async function updateJob(
  userId: string,
  jobId: string,
  update: Partial<ApproveQueueItem>
): Promise<void> {
  const list = await getApproveQueue(userId);
  const idx = list.findIndex((i) => i.id === jobId);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...update };
  await persistQueue(userId, list);
}

async function loadPhotoAliases(userId: string): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(`${PHOTO_ALIASES_PREFIX}${userId}`);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    return typeof o === 'object' && o !== null ? o : {};
  } catch {
    return {};
  }
}

async function mergePhotoAliases(userId: string, newAliases: Record<string, string>): Promise<void> {
  if (Object.keys(newAliases).length === 0) return;
  const current = await loadPhotoAliases(userId);
  const merged = { ...current, ...newAliases };
  await AsyncStorage.setItem(`${PHOTO_ALIASES_PREFIX}${userId}`, JSON.stringify(merged));
}

export async function callBooksApproveByIds(
  accessToken: string,
  bookIds: string[],
  actionId?: string
): Promise<boolean> {
  if (bookIds.length === 0) return true;
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/api/books-approve-by-ids`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds, action_id: actionId }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn('[APPROVE_QUEUE]', 'books-approve-by-ids failed', { status: res.status, body: text.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('[APPROVE_QUEUE]', 'books-approve-by-ids failed', { err: (err as Error)?.message });
    return false;
  }
}

async function callScanMarkImported(userId: string, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return;
  try {
    const headers = (await getScanAuthHeaders()) as Record<string, string>;
    await fetch(`${baseUrl}/api/scan-mark-imported`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds }),
    });
  } catch (err) {
    logger.warn('[APPROVE_QUEUE]', 'scan-mark-imported failed', { err: (err as Error)?.message });
  }
}

async function processOneJob(userId: string, job: ApproveQueueItem): Promise<void> {
  await updateJob(userId, job.id, { state: 'running' });
  const aliasMap = await loadPhotoAliases(userId);
  const resolvePhotoId = (id: string): string => aliasMap[id] ?? id;

  let session: { access_token?: string } | null = null;
  try {
    const { supabase } = await import('./supabase');
    const { data: { session: s } } = await supabase.auth.getSession();
    session = s;
  } catch {
    // ignore
  }
  const baseSaveOptions =
    session?.access_token && getApiBaseUrl()
      ? { apiBaseUrl: getApiBaseUrl(), accessToken: session.access_token }
      : undefined;

  try {
    const selectedDbIds = job.payload.options?.selectedDbIds;
    const actionId = typeof job.payload.options?.action_id === 'string' ? job.payload.options.action_id : undefined;
    if (selectedDbIds?.length && session?.access_token) {
      const ok = await callBooksApproveByIds(session.access_token, selectedDbIds, actionId);
      if (ok && actionId) await markMutationConfirmed(userId, actionId);
    }
    const result = await runApproveWrites(userId, job.payload, resolvePhotoId, baseSaveOptions);

    await mergePhotoAliases(userId, result.photoAliases);

    const userApprovedKey = `approved_books_${userId}`;
    const userPendingKey = `pending_books_${userId}`;
    const userRejectedKey = `rejected_books_${userId}`;
    const userPhotosKey = `photos_${userId}`;

    // Persist by book ID: do not collapse by book_key. Approve selected N books → N must stay in approved list.
    // CRITICAL: MERGE with existing approved books — don't replace the entire list.
    // The user may have previously approved books that aren't in this batch.
    const approvedToStore = result.approvedWithRealIds;
    let mergedApproved = approvedToStore;
    try {
      const existingRaw = await AsyncStorage.getItem(userApprovedKey);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw);
        if (Array.isArray(existing) && existing.length > 0) {
          // Deduplicate by title+author (case-insensitive) to avoid duplicates.
          const newKeys = new Set(approvedToStore.map((b: any) =>
            `${(b.title ?? '').toLowerCase().trim()}|${(b.author ?? '').toLowerCase().trim()}`
          ));
          const existingNotInNew = existing.filter((b: any) => {
            const key = `${(b.title ?? '').toLowerCase().trim()}|${(b.author ?? '').toLowerCase().trim()}`;
            return !newKeys.has(key);
          });
          mergedApproved = [...approvedToStore, ...existingNotInNew];
        }
      }
    } catch {}
    await Promise.all([
      AsyncStorage.setItem(userApprovedKey, JSON.stringify(mergedApproved)),
      AsyncStorage.setItem(userPendingKey, JSON.stringify(job.payload.newPending)),
      AsyncStorage.setItem(userRejectedKey, JSON.stringify(job.payload.newRejected)),
      AsyncStorage.setItem(userPhotosKey, JSON.stringify(result.newPhotosRewritten)),
    ]);

    await callScanMarkImported(userId, result.jobIdsToClose);

    await updateJob(userId, job.id, { state: 'done' });

    const selectedCount = job.payload.options?.selectedDbIds?.length ?? job.payload.newApproved.length;
    const approvedCountsByPhotoIdSample: Record<string, number> = {};
    result.approvedWithRealIds.forEach((b) => {
      const pid = (b as any).source_photo_id ?? (b as any).sourcePhotoId ?? (b as any).photoId;
      if (pid) {
        // Join/key rule: use full UUID only; never slice(0, 8) as key.
        approvedCountsByPhotoIdSample[pid] = (approvedCountsByPhotoIdSample[pid] ?? 0) + 1;
      }
    });
    logger.info('[APPROVE_VERIFY]', 'after server', {
      selectedCount,
      approvedCountAfter: result.approvedWithRealIds.length,
      pendingCountAfter: job.payload.newPending.length,
      approvedCountsByPhotoIdSample: Object.keys(approvedCountsByPhotoIdSample).length ? approvedCountsByPhotoIdSample : undefined,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const retries = job.retries + 1;
    const retryAfter = Date.now() + backoffMs(retries);
    await updateJob(userId, job.id, {
      state: 'failed',
      retries,
      retryAfter,
      errorMessage: typeof msg === 'string' ? msg.slice(0, 300) : String(msg).slice(0, 300),
    });
    logger.warn('[APPROVE_QUEUE]', 'job failed', {
      jobId: typeof job.id === 'string' ? job.id.slice(0, 16) : '(?)',
      retries,
      retryAfterMs: backoffMs(retries),
      error: typeof msg === 'string' ? msg.slice(0, 150) : String(msg).slice(0, 150),
    });
  }
}

function dedupeApprovedByBookKey(books: Book[]): Book[] {
  const byKey = new Map<string, Book>();
  for (const b of books) {
    const k = (b.book_key ?? `${(b.title ?? '').toLowerCase().trim()}|${(b.author ?? '').toLowerCase().trim()}`);
    if (!byKey.has(k)) byKey.set(k, b);
  }
  return [...byKey.values()];
}

let approveWorkerTimerId: ReturnType<typeof setInterval> | null = null;
let getCurrentUserIdForApprove: (() => string | null) | null = null;

async function approveWorkerTick(): Promise<void> {
  const userId = getCurrentUserIdForApprove?.() ?? null;
  if (!userId) return;

  const list = await getApproveQueue(userId);
  const now = Date.now();
  const runnable = list.filter(
    (i) =>
      (i.state === 'queued' || (i.state === 'failed' && (i.retryAfter ?? 0) <= now)) &&
      i.state !== 'done'
  );
  const toProcess = runnable.slice(0, MAX_CONCURRENT_APPROVE_JOBS);
  const running = list.filter((i) => i.state === 'running');
  if (running.length >= MAX_CONCURRENT_APPROVE_JOBS) return;

  for (const job of toProcess) {
    if (job.state === 'done') continue;
    processOneJob(userId, job).catch((e) => {
      logger.warn('[APPROVE_QUEUE]', 'processOneJob error', { jobId: typeof job.id === 'string' ? job.id.slice(0, 16) : '(?)', error: String(e) });
    });
    break; // one job per tick
  }
}

export function startApproveQueueWorker(getUserId: () => string | null): void {
  if (approveWorkerTimerId != null) return;
  getCurrentUserIdForApprove = getUserId;
  approveWorkerTimerId = setInterval(approveWorkerTick, APPROVE_WORKER_INTERVAL_MS);
  approveWorkerTick();
  logger.info('[APPROVE_QUEUE]', 'worker started');
}

export function stopApproveQueueWorker(): void {
  if (approveWorkerTimerId != null) {
    clearInterval(approveWorkerTimerId);
    approveWorkerTimerId = null;
  }
  getCurrentUserIdForApprove = null;
  logger.info('[APPROVE_QUEUE]', 'worker stopped');
}
