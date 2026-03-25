import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useFocusEffect, useNavigation, useIsFocused } from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { 
 View, 
 Text, 
 StyleSheet, 
 TouchableOpacity, 
 TouchableWithoutFeedback,
 Pressable,
 Alert, 
 AppState,
 Dimensions,
 ScrollView,
 FlatList,
 ActivityIndicator,
 Modal,
 Image,
 TextInput,
 Animated,
 KeyboardAvoidingView,
 Platform,
 Keyboard,
 LayoutAnimation,
 GestureResponderEvent,
 InteractionManager,
} from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  WarningIcon,
  CloseIcon,
  ImageOutlineIcon,
  BookOutlineIcon,
  ChevronBackIcon,
  FlashIcon,
  AddIcon,
  RemoveIcon,
  ImagesOutlineIcon,
  ListOutlineIcon,
  ChevronForwardIcon,
  TrashIcon,
  CheckmarkCircleIcon,
  SwapHorizontalIcon,
  FolderIcon,
  CheckmarkIcon,
  CheckboxOutlineIcon,
} from '../components/Icons';
import { useAuth, isGuestUser, GUEST_USER_ID } from '../auth/SimpleAuthContext';
import { useProfileStats } from '../contexts/ProfileStatsContext';
import { useResponsive } from '../lib/useResponsive';
import { scanJobKey, lastBatchKey, PENDING_APPROVE_ACTION_KEY, PENDING_GUEST_KEY, activeBatchKey, scanBatchKey, importedPhotoKeysKey } from '../lib/cacheKeys';
import { uuidv4 } from '../lib/scanId';
import { dedupBy, photoStableKey, photoStableKeyMatchMethod, canonicalPhotoListKey, mergePhotosPreferRemote, mergePhotosPreferLocal, mergePreserveLocalUris, dedupePhotosByJobId } from '../lib/dedupBy';
import { generateOpId } from '../lib/scanCorrelation';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit, getLastDestructiveAction, isClearInProgress } from '../lib/deleteGuard';
import { perfLog } from '../lib/perfLogger';
import {
  saveHighWaterMark,
  loadHighWaterMark,
  clearHighWaterMark,
  getSafetyEpoch,
  setSafetyEpoch,
  loadLastDestructiveAction,
  clearLastDestructiveAction,
  checkForSuspiciousDrop,
  undoLastDelete,
  type LastDestructiveAction,
  RECENT_DESTRUCTIVE_MS,
  UNDO_WINDOW_MS,
  AUTHORITATIVE_DESTRUCTIVE_MS,
  AUTHORITATIVE_DESTRUCTIVE_REASONS,
} from '../lib/dataSafetyMark';
import type { ScanBatch, JobResult } from '../types/scanBatch';
import { batchProgress, deriveBatchStatus, isTerminalJobStatus, isTerminalBatchStatus } from '../types/scanBatch';
import { useScanning } from '../contexts/ScanningContext';
import { useCamera } from '../contexts/CameraContext';
import { useCoverUpdate } from '../contexts/CoverUpdateContext';
import { Book, Photo, Folder, enforcePhotoStorageStatus } from '../types/BookTypes';
import { PhotoTile } from '../components/PhotoTile';
import {
 loadBooksFromSupabase,
 loadPhotosFromSupabase,
 fetchAllApprovedBooks,
 fetchAllPhotos,
 fetchBooksByIds,
 fetchBooksForPhoto,
 runPhotoDetailsDebug,
 saveBookToSupabase,
 toRawScanJobUuid,
 toScanJobId,
 getJobIdsToCloseFromApproved,
 savePhotoToSupabase,
 deleteLibraryPhotoAndBooks,
 deletePendingScanOnly,
 patchScanJobPhotoId,
 batchPatchSourcePhotoId,
 deleteBookFromSupabase,
 getDeletedBookIds,
 addDeletedBookIdsTombstone,
 getDeletedPendingStableKeys,
 addDeletedPendingStableKeysTombstone,
 syncCompletedScanJobs,
 syncPendingApprovedBooks,
} from '../services/supabaseSync';
import { setOnPhotoUploaded, setOnPhotoComplete, setOnPhotoUploadFailed, setOnScanJobCreated, setOnJobTerminalStatusQueue, retryQueueItem, addToQueue } from '../lib/photoUploadQueue';
import { emitLibraryInvalidate, subscribeLibraryInvalidate } from '../lib/libraryInvalidate';
import { clearActiveScanJobIds as clearActiveScanJobIdsStore } from '../lib/activeScanJobsStore';
import { canUserScan, getUserScanUsage, incrementScanCount, ScanUsage, isSubscriptionUIHidden } from '../services/subscriptionService';
import { TabHeader, HEADER_CONTENT_HEIGHT } from '../components/TabHeader';
import { ScanLimitBanner, ScanLimitBannerRef } from '../components/ScanLimitBanner';
import { UpgradeModal } from '../components/UpgradeModal';
import { AuthGateModal } from '../components/AuthGateModal';
import { fetchBookData, saveCoverToStorage, searchMultipleBooks, searchBooksByQuery } from '../services/googleBooksService';
import { getEnvVar, getApiBaseUrl } from '../lib/getEnvVar';
import { isGoogleHotlink } from '../lib/coverUtils';
import { computeBookKey, getStableBookKey } from '../lib/bookKey';
import { canon } from '../lib/photoKey';
import { mergeBookFieldLevel } from '../lib/mergeBooks';
import { supabase } from '../lib/supabase';
import { getSignedPhotoUrl } from '../lib/photoUrls';
import { LOG_TRACE, LOG_DEBUG, LOG_POLL, LOG_UI, USE_PURE_JS_HASH, DEBUG_PENDING } from '../lib/logFlags';
import { logger, makeScanTraceId, makeBatchTraceId, logScanSummary, logScanMilestone, getTraceId, setTraceId, clearTraceId, DEBUG_INTEGRITY, DEBUG_STACKS } from '../utils/logger';
import { sendTelemetry } from '../lib/clientTelemetry';
import { logStorageUrlMode, trackScan, trackRequest, recordFailure, resetFailures } from '../lib/securityBaseline';
import { setProvenanceMissingThisSession } from '../lib/provenanceGuard';
import { recordPhotoDedupe, getDedupeStats, resetDedupeStats } from '../lib/photoDedupeLog';
import { recordApproveDupe, flushApproveDupes } from '../lib/approveDupeLog';
import { resolveCanonical, isCanonical, registerDedupe, clearCanonicalPhotoMap } from '../lib/canonicalPhotoMap';
import { canonicalJobId } from '../lib/scanId';
import { hashStringToHex16, sha256Hex16 } from '../lib/hashString';
import { registerAddCaptionCallbacks } from '../lib/addCaptionCallbacks';
import { registerSelectCollectionCallback } from '../lib/selectCollectionCallbacks';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeTokens } from '../theme/tokens';
import { useBottomDock } from '../contexts/BottomDockContext';
import { useSignedPhotoUrlMap } from '../contexts/SignedPhotoUrlContext';
import { usePhotoSignedUrlPersistRef } from '../contexts/PhotoSignedUrlPersistContext';

// Utility: wait for ms
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Log who is writing library snapshot state so we can find "who overwrote my snapshot" with empty. */
function logLibraryStateWrite(
  source: string,
  next: { approved?: number; photos?: number; pending?: number }
) {
  const payload: Record<string, unknown> = {
    source,
    approved: next.approved ?? '-',
    photos: next.photos ?? '-',
    pending: next.pending ?? '-',
  };
  // Full stack only at error level or when LOG_LEVEL=trace / DEBUG_STACKS; otherwise first line + hash to keep logs small.
  const stack = new Error().stack;
  if (stack) {
    const lines = stack.split('\n');
    const firstLine = lines[1]?.trim() ?? lines[0] ?? '';
    if (logger.LOG_LEVEL === 'trace' || DEBUG_STACKS) {
      payload.stack = lines.slice(0, 6).join('\n');
    } else {
      payload.stackSummary = firstLine;
    }
  }
  logger.cat('[LIBRARY_STATE_WRITE]', '', payload, 'trace');
}

/**
 * Hermes-safe abort-error check.
 * Hermes (React Native's JS engine) does not expose DOMException, so
 *   `err instanceof DOMException` and `new DOMException(...)` both throw
 *   "ReferenceError: Property 'DOMException' doesn't exist".
 * Instead we check the three signals that any AbortError carries regardless of runtime:
 *   1. err.name === 'AbortError'   — standard fetch abort signal
 *   2. err.code === 20             — legacy DOMException ABORT_ERR numeric code
 *   3. message contains 'abort'   — catch-all for custom/polyfilled errors
 */
function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === 'AbortError' ||
    e.code === 20 ||
    (typeof e.message === 'string' && e.message.toLowerCase().includes('abort'))
  );
}

/**
 * Create a plain Error that looks like an AbortError to isAbortError() above,
 * without using DOMException (which crashes on Hermes).
 */
/**
 * Classify Supabase/backend errors for logging and circuit-breaker.
 * Returns message, code, details, and kind (network | auth | rls | timeout | unknown).
 */
function classifySupabaseError(err: unknown): { message: string; code: string | number | undefined; details: unknown; kind: 'network' | 'auth' | 'rls' | 'timeout' | 'unknown' } {
  const message = err != null && typeof (err as any).message === 'string' ? (err as any).message : String(err);
  const code = err != null && typeof err === 'object' ? (err as any).code : undefined;
  const details = err != null && typeof err === 'object' ? (err as any).details ?? (err as any).hint ?? err : err;
  const msgLower = message.toLowerCase();
  let kind: 'network' | 'auth' | 'rls' | 'timeout' | 'unknown' = 'unknown';
  if (message === 'Supabase load timeout' || msgLower.includes('timeout') || msgLower.includes('timed out')) kind = 'timeout';
  else if (msgLower.includes('abort') || msgLower.includes('network') || msgLower.includes('fetch') || msgLower.includes('failed to fetch')) kind = 'network';
  else if (msgLower.includes('auth') || msgLower.includes('401') || msgLower.includes('jwt') || msgLower.includes('session') || (typeof code === 'string' && code.includes('PGRST301'))) kind = 'auth';
  else if (msgLower.includes('rls') || msgLower.includes('policy') || msgLower.includes('row level') || (typeof code === 'string' && code.includes('42501'))) kind = 'rls';
  return { message, code, details, kind };
}

function makeAbortError(msg = 'aborted'): Error {
  const err = new Error(msg);
  (err as any).name = 'AbortError';
  (err as any).code = 20;
  return err;
}

const COVERS_BUCKET = 'book-covers';

/** Get file size and mime/extension for error logging. Never throws. */
async function getFileInfoForLog(uri: string): Promise<{ size?: number; exists?: boolean; mimeOrExtension?: string }> {
 const out: { size?: number; exists?: boolean; mimeOrExtension?: string } = {};
 try {
 const lower = (uri ?? '').split('?')[0].toLowerCase();
 if (lower.endsWith('.png')) out.mimeOrExtension = 'image/png';
 else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) out.mimeOrExtension = 'image/jpeg';
 else if (lower.endsWith('.webp')) out.mimeOrExtension = 'image/webp';
 else if (lower.endsWith('.heic')) out.mimeOrExtension = 'image/heic';
 else if (uri?.startsWith('data:')) out.mimeOrExtension = (uri.match(/^data:([^;]+)/)?.[1] ?? 'data:*') as string;
 else out.mimeOrExtension = 'unknown';
 const info = await FileSystem.getInfoAsync(uri);
 out.exists = info.exists;
 if (info.exists && 'size' in info && typeof (info as { size?: number }).size === 'number') out.size = (info as { size: number }).size;
 } catch (_) { /* ignore */ }
 return out;
}

function formatErrorForLog(error: unknown): { message: string; stack?: string } {
 if (error instanceof Error) return { message: error.message, stack: error.stack };
 return { message: String(error), stack: undefined };
}

const UUID_REGEX_HEALTH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Debug counter: how many duplicate rows have been collapsed (same book_key). Read via getApprovedDuplicateCollapseCount(); no log spam. */
let approvedDuplicateCollapseTotal = 0;

/** One entry per book_key, prefer server UUID when present. Use before persisting approved so we never persist doubled state. Collapse is deterministic; increments approvedDuplicateCollapseTotal when duplicates are removed. */
function ensureApprovedOnePerBookKey(list: Book[]): Book[] {
 const byKey = new Map<string, Book>();
 list.forEach((b) => {
 const k = getStableBookKey(b);
 if (!k) return;
 const existing = byKey.get(k);
 const preferUuid = (x: Book) => x.id && UUID_REGEX_HEALTH.test(x.id);
 const keep = !existing ? b : preferUuid(existing) ? existing : preferUuid(b) ? b : existing;
 byKey.set(k, keep);
 });
 const result = [...byKey.values()];
 if (list.length > result.length) {
 approvedDuplicateCollapseTotal += list.length - result.length;
 }
 return result;
}

/** Returns total number of duplicate approved rows collapsed so far (for debug screens / diagnostics). */
export function getApprovedDuplicateCollapseCount(): number {
 return approvedDuplicateCollapseTotal;
}

/** Log [APPROVED_IDENTITY_HEALTH] for a list about to become/read as approved; phase identifies where (proves 52 spike source). */
function logApprovedIdentityHealth(approved: Book[], phase: string): void {
 const approvedLen = approved.length;
 const ids = approved.map((b) => b.id).filter((x): x is string => Boolean(x));
 const uniqueIdCount = new Set(ids).size;
 const keys = approved.map((b) => getStableBookKey(b)).filter(Boolean);
 const uniqueBookKeyCount = new Set(keys).size;
 const keyCount = new Map<string, number>();
 keys.forEach((k) => keyCount.set(k, (keyCount.get(k) ?? 0) + 1));
 const duplicateBookKeysTop5 = [...keyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k).slice(0, 5);
 const tempIdCount = approved.filter((b) => b.id && !UUID_REGEX_HEALTH.test(b.id)).length;
 const byKey = new Map<string, { hasUuid: boolean; hasTemp: boolean }>();
 approved.forEach((b) => {
 const k = getStableBookKey(b);
 if (!k) return;
 const entry = byKey.get(k) ?? { hasUuid: false, hasTemp: false };
 if (b.id) {
 if (UUID_REGEX_HEALTH.test(b.id)) entry.hasUuid = true;
 else entry.hasTemp = true;
 }
 byKey.set(k, entry);
 });
 const hasUuidAndTempForSameBookKeyCount = [...byKey.values()].filter((e) => e.hasUuid && e.hasTemp).length;
 logger.debug('[APPROVED_IDENTITY_HEALTH]', {
 phase,
 approvedLen,
 uniqueIdCount,
 uniqueBookKeyCount,
 ...(duplicateBookKeysTop5.length > 0 && { duplicateBookKeysTop5 }),
 tempIdCount,
 ...(hasUuidAndTempForSameBookKeyCount > 0 && { hasUuidAndTempForSameBookKeyCount }),
 });
}

/** One consolidated [CANONICAL_IDENTITY_AUDIT] per hydration cycle: approvedLen, uniqueBookKeyCount, uniqueIdCount, tempIdCount, duplicateBookKeyCount, aliasMapSize + sample. */
function logCanonicalIdentityAudit(approved: Book[], aliasMap: Record<string, string>, phase: string): void {
 const approvedLen = approved.length;
 const ids = approved.map((b) => b.id).filter((x): x is string => Boolean(x));
 const uniqueIdCount = new Set(ids).size;
 const keys = approved.map((b) => getStableBookKey(b)).filter(Boolean);
 const uniqueBookKeyCount = new Set(keys).size;
 const keyCount = new Map<string, number>();
 keys.forEach((k) => keyCount.set(k, (keyCount.get(k) ?? 0) + 1));
 const duplicateBookKeyCount = [...keyCount.values()].filter((n) => n > 1).length;
 const tempIdCount = approved.filter((b) => b.id && !UUID_REGEX_HEALTH.test(b.id)).length;
 const aliasMapSize = Object.keys(aliasMap).length;
 const aliasMapSample = Object.entries(aliasMap).slice(0, 5).map(([temp, canonical]) => ({ temp, canonical }));
 logger.debug('[CANONICAL_IDENTITY_AUDIT]', {
 phase,
 approvedLen,
 uniqueBookKeyCount,
 uniqueIdCount,
 tempIdCount,
 duplicateBookKeyCount,
 aliasMapSize,
 ...(aliasMapSample.length > 0 && { aliasMapSample }),
 });
}

/**
 * Second fetch for Pending UI: books live in scan_jobs.books; covers live in cover_resolutions.
 * Query cover_resolutions by work_key, then build public (or signed) URLs and merge into book list.
 */
async function loadCoversForBooks(books: Book[]): Promise<Map<string, string>> {
 const workKeys = books.map(b => (b as any).workKey ?? (b as any).work_key).filter(Boolean) as string[];
 if (workKeys.length === 0) return new Map();

 const { data: rows, error } = await supabase
 .from('cover_resolutions')
 .select('work_key, cover_storage_path')
 .in('work_key', workKeys)
 .not('cover_storage_path', 'is', null);

 logger.debug('[PENDING] covers found:', rows?.length ?? 0);
 if (error) logger.debug('[COVERS] error', error?.message);

 const pathMap = new Map<string, string>();
 if (Array.isArray(rows)) {
 for (const r of rows) {
 const path = r?.cover_storage_path;
 if (r?.work_key && path && path !== '') pathMap.set(r.work_key, path);
 }
 }

 // Public bucket: getPublicUrl(path) returns full URL (no network call)
 const urlMap = new Map<string, string>();
 let loggedCoversBucketMode = false;
 for (const [workKey, path] of pathMap) {
 const { data } = supabase.storage.from(COVERS_BUCKET).getPublicUrl(path);
 if (data?.publicUrl) {
   urlMap.set(workKey, data.publicUrl);
   if (!loggedCoversBucketMode) {
     loggedCoversBucketMode = true;
     logStorageUrlMode({ bucket: COVERS_BUCKET, mode: 'public', caller: 'loadCoversForBooks' });
   }
 }
 }
 return urlMap;
}

// Utility: retry a scan function that returns Book[]
async function withRetries(fn: () => Promise<Book[]>, tries = 2, backoffMs = 1200): Promise<Book[]> {
 let last: Book[] = [];
 for (let attempt = 0; attempt < tries; attempt++) {
 try {
 const res = await fn();
 if (Array.isArray(res) && res.length > 0) return res;
 last = res;
 } catch (e) {
 // ignore and backoff
 }
 if (attempt < tries - 1) await delay(backoffMs * (attempt + 1));
 }
 return last;
}

/** Client-side safety: only treat scans as "pending" if backend says queued/processing. Even if backend messes up. */
const PENDING_SCAN_STATUSES = ['queued', 'processing'] as const;
function filterToPendingScans<T extends { status?: string }>(scans: T[]): T[] {
 return scans.filter(s => PENDING_SCAN_STATUSES.includes((s?.status ?? '') as any));
}

interface ScanQueueItem {
  id: string;
  uri: string;
  /**
   * status meanings:
   *   queued / pending / processing  — in-flight
   *   completed                      — server job done AND import succeeded
   *   failed                         — server job failed (server-side error)
   *   canceled                       — user or system canceled before completion
   *   error                          — upload / pre-processing failed (never reached server)
   *   import_failed                  — server job COMPLETED but client-side import threw;
   *                                   safe to retry via retryImportJob(scanJobId)
   */
  status: 'queued' | 'pending' | 'processing' | 'completed' | 'failed' | 'canceled' | 'error' | 'import_failed';
  batchId?: string;
  jobId?: string;
  /** Raw scan-job UUID (from server); used to re-fetch results on import retry. */
  scanJobId?: string;
  /** UUID for this capture; set atomically when batch starts so upload/scan can use it. */
  photoId?: string;
  /** When the queue record was created; used for atomic batch (write record first, then kick async). */
  createdAt?: number;
  source?: 'camera' | 'library';
  /** Human-readable message for status 'error' or 'import_failed'. */
  errorMessage?: string;
  /** Books returned by the server — preserved on import_failed so retry can skip re-fetch. */
  serverBooks?: Book[];
}

export const ScansTab: React.FC = () => {
 const insets = useSafeAreaInsets();
 const navigation = useNavigation();
 
 // Client-side dedupe: track active scans by image hash to prevent double-submit
 // Defined at component level to persist across renders
 const activeScansRef = React.useRef(new Map<string, { jobId: string; timestamp: number }>());
 const DEDUPE_WINDOW_MS = 5000; // 5 seconds
 const { user, session, authReady, loading: authLoading } = useAuth();
 const userRef = useRef(user);
 userRef.current = user;
 const { refreshProfileStats, startRehydrate, completeRehydrate, endRehydrate, setLastApprovedAt } = useProfileStats();
 const { signedUrlMap } = useSignedPhotoUrlMap();
 const photoSignedUrlPersistRef = usePhotoSignedUrlPersistRef();
 const { t } = useTheme();
 const { screenWidth, pendingGridColumns, typeScale } = useResponsive();
 const PENDING_GRID_HORIZONTAL_PADDING = 20;
 const PENDING_GRID_GAP = 10;
 const pendingGridContainerWidth = Math.min(screenWidth, 900);
 const pendingGridItemWidth = Math.max(
 1,
 Math.floor(
 (pendingGridContainerWidth - (PENDING_GRID_HORIZONTAL_PADDING * 2) - (PENDING_GRID_GAP * (pendingGridColumns - 1))) /
 pendingGridColumns
 )
 );
 
 const styles = useMemo(
 () => getStyles(screenWidth, t, pendingGridColumns, typeScale),
 [screenWidth, t, pendingGridColumns, typeScale]
 );
 
const { scanProgress, setScanProgress, updateProgress, jobsInProgress, setJobsInProgress, failedUploadCount, setFailedUploadCount, setUploadDebug, setOnCancelComplete, setOnDismissComplete, setOnJobTerminalStatus, setServerActiveJobIds, addActiveScanJobId, removeActiveScanJobId, activeScanJobIds, cancelGenerationRef, cancelAll } = useScanning();
const { isCoverUpdateActive } = useCoverUpdate();

/**
 * Capture the current cancel generation and return a guard function.
 * Call at the START of any async pipeline (upload, poll, import).
 * Call the returned function before every state write — it returns false if a
 * cancel happened while we were awaiting, in which case the caller should abort.
 *
 * Usage:
 *   const genOk = captureGen();
 *   await somethingAsync();
 *   if (!genOk()) return;
 *   setSomeState(...);
 */
const captureGen = useCallback((): (() => boolean) => {
  const gen = cancelGenerationRef.current;
  return () => cancelGenerationRef.current === gen;
}, [cancelGenerationRef]);

/** Reason for next setScanProgress (batch_start | queue_resume). Consumed by activeBatch effect. */
const scanShowReasonRef = useRef<string | null>(null);
 
 // Keep ref in sync so cancel callback can read jobIds (before state is cleared)
 React.useEffect(() => {
 scanProgressRef.current = scanProgress;
 }, [scanProgress]);

 /** Persist ScanBatch to AsyncStorage (keyed by batchId). Also set active_batch to this batchId. Never merge across batches. */
 const persistBatch = useCallback(async (batch: ScanBatch) => {
 if (!user?.uid) return;
 try {
 const key = scanBatchKey(user.uid, batch.batchId);
 await AsyncStorage.setItem(key, JSON.stringify(batch));
 await AsyncStorage.setItem(activeBatchKey(user.uid), batch.batchId);
 } catch (_) {}
 }, [user?.uid]);

 /** Remove batch from storage and clear active batch key. */
 const removeBatchFromStorage = useCallback(async (batchId: string) => {
 if (!user?.uid) return;
 try {
 await AsyncStorage.removeItem(scanBatchKey(user.uid, batchId));
 await AsyncStorage.removeItem(activeBatchKey(user.uid));
 } catch (_) {}
 }, [user?.uid]);

 // Batch state: primary key for UI. Immutable per batch; never merge across batches. Navigation does not clear.
 const [activeBatch, setActiveBatch] = useState<ScanBatch | null>(null);
 const activeBatchRef = useRef<ScanBatch | null>(null);
 const currentBatchIdRef = useRef<string | null>(null);
 const currentBatchStartedAtRef = useRef<number | null>(null);
 /** Camera flow: reuse same batch when adding 2nd photo so progress bar can poll first job. Cleared when batch is cleared. */
 const cameraBatchIdRef = useRef<string | null>(null);

 const currentBatchId = activeBatch?.batchId ?? null;
 /** Log [DESC_CLIENT_FETCH] at boot only once. */
 const descBootLoggedRef = useRef(false);
 /** Clear active batch (cancel/terminal/sign out). If no batchId, removes current active batch from storage.
 *  INVARIANT: Must NOT touch approved books, pending books, photos, or library snapshot — only scan batch/queue/refs and scan AsyncStorage keys (scanBatchKey, activeBatchKey). */
const clearActiveBatch = useCallback(async (batchIdToRemove?: string, reason?: string) => {
  const batch = activeBatchRef.current;
  const id = batchIdToRemove ?? batch?.batchId;

  clearTraceId();

  // Determine whether this is a hard cancel (user-initiated stop) vs. a soft cleanup
  // (navigation, import_complete, dismiss, TTL expiry).
  //
  // HARD CANCEL: aborts all pollers and evicts in-flight tracking maps so no stale results
  // can land after the user pressed X. Reasons: 'cancel', 'clear_data'.
  //
  // SOFT CLEANUP: only nulls out the UI batch state (activeBatch ref + AsyncStorage) and
  // aborts HTTP upload controllers. Pollers are left running so they can still finish
  // importing if the scan is still in-flight. batchResultsMapRef / batchOutcomesMapRef /
  // inFlightBatchIdsRef are preserved so BATCH_COMPLETE sees the correct counts.
  // Reasons: everything else ('cleanup', 'import_complete', 'focus_server_zero_active', etc.)
  const isHardCancel = reason === 'cancel' || reason === 'clear_data';

  const jobIdsToLog = batch?.jobIds ?? [];
  for (const jid of jobIdsToLog) {
    sendTelemetry('SCAN_DONE_CLIENT', { jobId: jid, reason: isHardCancel ? 'cancel' : 'cleanup' });
  }

  const clearedStorageKeys: string[] = [];
  if (id && user?.uid) {
    try {
      clearedStorageKeys.push(scanBatchKey(user.uid, id), activeBatchKey(user.uid));
      await AsyncStorage.removeItem(scanBatchKey(user.uid, id));
      await AsyncStorage.removeItem(activeBatchKey(user.uid));
    } catch (_) {}
  }

  logCleanupAction({
    reason: reason ?? 'cleanup',
    clearedScanQueue: false,
    clearedScanProgress: false,
    clearedActiveBatch: true,
    clearedStorageKeys,
  });
  cameraBatchIdRef.current = null;
  logQueueDelta(reason ?? 'cleanup', 0);

  // For explicit cancel/clear-data: mark in-flight items as 'canceled' so the UI shows a
  // distinct terminal state rather than a ghost item stuck in 'processing'.
  if (isHardCancel) {
    setScanQueue(prev => {
      const updated = prev.map(item =>
        (item.status === 'queued' || item.status === 'pending' || item.status === 'processing')
          ? { ...item, status: 'canceled' as const }
          : item
      );
      const cancelledCount = updated.filter(i => i.status === 'canceled').length;
      if (cancelledCount > 0) {
        logger.info('[BATCH_CANCEL]', `marked ${cancelledCount} in-flight item(s) as canceled`, { reason });
      }
      return updated;
    });
  }

  // Always: null out the active batch identity so the UI bar hides.
  setActiveBatch(null);
  activeBatchRef.current = null;
  currentBatchIdRef.current = null;
  currentBatchStartedAtRef.current = null;

  if (isHardCancel) {
    // Hard cancel only: evict in-flight tracking maps so any results that arrive after cancel
    // are discarded by the genOk() / inFlightBatchIdsRef guards in enqueueBatch.
    inFlightBatchIdsRef.current.clear();
    batchResultsMapRef.current.clear();
    batchOutcomesMapRef.current.clear();
    // Abort all per-job pollers — user explicitly stopped scanning, no more poll results needed.
    pollerAbortControllersRef.current.forEach((ctrl) => ctrl.abort());
    pollerAbortControllersRef.current.clear();
  }
  // Soft cleanup: pollers keep running; batchResultsMapRef / batchOutcomesMapRef / inFlightBatchIdsRef
  // are preserved. enqueueBatch will still compute the correct BATCH_COMPLETE outcome and call
  // saveUserData when all poll promises resolve, even if the tab was navigated away from.
}, [user?.uid]);
 useEffect(() => {
 currentBatchIdRef.current = activeBatch?.batchId ?? null;
 currentBatchStartedAtRef.current = activeBatch ? activeBatch.createdAt : null;
 activeBatchRef.current = activeBatch;
 }, [activeBatch]);

 /** Abort scan upload fetches only (batch controllers). Do NOT abort libraryAbortControllerRef — library fetch must not be canceled on blur. */
 const abortControllersOnly = React.useCallback(() => {
 abortControllersRef.current.forEach((controller, batchId) => {
 if (__DEV__) logger.debug(`[BLUR] Aborting in-flight scan fetches for batch ${batchId} (keeping batch identity)`);
 controller.abort();
 });
 abortControllersRef.current.clear();
 }, []);

/** Abort scan-related requests only (upload + poll). Does NOT abort libraryAbortControllerRef — library snapshot fetch is only aborted on user switch.
 *  INVARIANT: Must NOT touch approved books, photos, or library state — only scan AbortControllers and canceledJobIdsRef. */
const abortInFlightRequests = React.useCallback(() => {
  const jobIds = scanProgressRef.current?.jobIds;
  if (jobIds && Array.isArray(jobIds)) {
    jobIds.forEach(id => canceledJobIdsRef.current.add(id));
  }
  // Abort batch-level upload controllers (stops in-flight POSTs).
  abortControllersRef.current.forEach((controller, batchId) => {
    if (__DEV__) logger.debug(` [CANCEL] Aborting fetch requests for batch ${batchId}`);
    controller.abort();
  });
  abortControllersRef.current.clear();
  // Abort per-job poll controllers (stops every active poll loop immediately).
  const pollerCount = pollerAbortControllersRef.current.size;
  pollerAbortControllersRef.current.forEach((controller, jobId) => {
    if (__DEV__) logger.debug(` [CANCEL] Aborting poller for job ${(jobId ?? '').slice(0, 12)}`);
    controller.abort();
  });
  pollerAbortControllersRef.current.clear();
  if (pollerCount > 0) logger.info('[CANCEL]', `aborted ${pollerCount} active poller(s)`);
}, []);

 // Processing states and refs used by resetUIProgress (must be defined before resetUIProgress)
 const [isProcessing, setIsProcessing] = useState(false);
 const [scanQueue, setScanQueue] = useState<ScanQueueItem[]>([]);
const scanQueueRef = React.useRef<ScanQueueItem[]>(scanQueue);
scanQueueRef.current = scanQueue;
const activeScanJobIdsRef = React.useRef<string[]>(activeScanJobIds ?? []);
activeScanJobIdsRef.current = activeScanJobIds ?? [];
 const [currentScan, setCurrentScan] = useState<{id: string, uri: string, progress: {current: number, total: number}} | null>(null);
 const [isScanning, setIsScanning] = useState(false);
 const [isUploading, setIsUploading] = useState(false);
const inFlightEnqueuesRef = useRef<number>(0);

// ─── Scan vs library abort controllers (must stay separate) ───────────────────
// SCAN: safe to abort on tab blur and on user cancel. Used for upload + poll only.
/** One AbortController per active batch (scan upload). Aborted on blur and on user cancel. Do NOT use for library fetch. */
const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
/**
 * One AbortController per polling job (scan status poll). Aborted on user cancel only.
 * Do NOT use for library fetch.
 */
const pollerAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

// LIBRARY: do NOT abort on tab blur or scan cancel. Only abort when user switches accounts (or signs out).
/** Current AbortController for the in-flight library snapshot fetch (loadUserData). Abort ONLY on user switch/sign-out — never on blur or scan cancel. */
const libraryAbortControllerRef = useRef<AbortController | null>(null);
const totalScansRef = useRef<number>(0);
const processingUrisRef = useRef<Set<string>>(new Set());

 /** Reset scan UI progress (safe on navigation/blur does NOT abort fetches). Use when you only want to clear the UI.
  *  Must NOT touch approved books, photos, or library snapshot — only scan queue/progress/refs. */
 const resetUIProgress = React.useCallback(() => {
 clearActiveBatch();
 setScanQueue([]);
 totalScansRef.current = 0;
 inFlightEnqueuesRef.current = 0;
 setScanProgress(null);
 setIsProcessing(false);
 setIsUploading(false);
 setIsScanning(false);
 setCurrentScan(null);
 processingUrisRef.current.clear();
 }, [clearActiveBatch]);

// Register cancel callback: called ONLY by cancelAll() (explicit user cancel), NOT on navigation.
// Navigation away from Photos/Scans tab must NOT cancel uploads or clear the durable upload queue.
// Pass callback via updater (prev => next) so React does not invoke our callback as the updater.
React.useEffect(() => {
  if (setOnCancelComplete) {
    const callback = () => {
      logger.info('[CANCEL] ScansTab cleanup: aborting UI fetches + clearing batch + resetting pending/photos state');
      abortInFlightRequests();
      lastCanceledAtRef.current = Date.now();
      const batchId = activeBatchRef.current?.batchId;
      clearActiveBatch(batchId, 'cancel');
      if (user?.uid) clearActiveScanJobIdsStore(user.uid).catch(() => {});
      // Clear in-memory pending books and photos so they don't persist after "Clear All Data".
      setPendingBooks([]);
      setPhotos([]);
      setScanQueue((prev) => {
        const isInFlight = (s: ScanQueueItem['status']) =>
          s === 'queued' || s === 'pending' || s === 'processing';
        const cancelledCount = prev.filter((i) => isInFlight(i.status)).length;
        if (cancelledCount > 0) {
          logger.info('[CANCEL]', `marked ${cancelledCount} in-flight queue item(s) as 'canceled'`);
        }
        return prev.map((item) =>
          isInFlight(item.status)
            ? { ...item, status: 'canceled' as const, errorMessage: 'Canceled by user' }
            : item
        );
      });
      const discarded = serialScanQueueRef.current.splice(0);
      if (discarded.length > 0) {
        logger.info('[CANCEL]', `discarded ${discarded.length} serial-queued item(s) (user cancelled)`);
      }
    };
    setOnCancelComplete(() => callback);
  }
  return () => {
    if (setOnCancelComplete) {
      setOnCancelComplete(undefined);
    }
  };
}, [setOnCancelComplete, abortInFlightRequests, clearActiveBatch]);

 // Register dismiss callback: when user dismisses completed batch (Done), clear batch state. Do NOT clear on tab blur/focus.
 React.useEffect(() => {
 if (setOnDismissComplete) {
 const callback = () => {
 const batch = activeBatchRef.current;
 const batchId = batch?.batchId;
 if (__DEV__ && batchId) logger.debug('[DISMISS] User dismissed completed batch', batchId);
 if (batchId) {
 clearActiveBatch(batchId, 'cleanup');
 setScanProgress(null);
 setScanQueue((prev) => prev.filter((item) => item.batchId !== batchId));
 }
 };
 setOnDismissComplete(() => callback);
 }
 return () => {
 if (setOnDismissComplete) {
 setOnDismissComplete(undefined);
 }
 };
 }, [setOnDismissComplete, clearActiveBatch]);

 // Durable upload queue: when worker finishes Step B (upload + upsert photo) or Step C (complete), update local photo state.
 React.useEffect(() => {
   setOnPhotoUploaded((uid, photoId, storagePath) => {
     if (uid !== user?.uid) return;
     // Resolve through alias map: upload queue uses Step A photoId, but React state
     // may have canonicalized it to a different ID during scan import.
     // Also match on localId: scan import may have changed p.id to canonical UUID
     // but preserved the original as p.localId.
     const resolvedId = photoIdAliasRef.current[photoId] ?? photoId;
     setPhotos((prev) => {
       const updated = prev.map((p) =>
         (p.id === photoId || p.id === resolvedId || p.localId === photoId) ? { ...p, status: 'complete' as const, storage_path: storagePath } : p
       );
       const key = `photos_${user?.uid}`;
       if (user?.uid) AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
       return updated;
     });
   });
   setOnPhotoComplete((uid, photoId) => {
     if (uid !== user?.uid) return;
     const resolvedId = photoIdAliasRef.current[photoId] ?? photoId;
     setPhotos((prev) => {
       const updated = prev.map((p) =>
         (p.id === photoId || p.id === resolvedId || p.localId === photoId) ? { ...p, status: 'complete' as const } : p
       );
       const key = `photos_${user?.uid}`;
       if (user?.uid) AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
       return updated;
     });
   });
   setOnPhotoUploadFailed((uid, photoId, errorMessage, statusCode) => {
     if (uid !== user?.uid) return;
     const resolvedId = photoIdAliasRef.current[photoId] ?? photoId;
     // 413 (or other STEP_C failure): set scan_failed so we stop auto-retry and show "Failed — tap to retry".
     const status: 'scan_failed' | 'failed_upload' = statusCode === 413 ? 'scan_failed' : 'failed_upload';
     setPhotos((prev) => {
       const updated = prev.map((p) =>
         (p.id === photoId || p.id === resolvedId || p.localId === photoId) ? { ...p, status, errorMessage: errorMessage ?? undefined } : p
       ) as Photo[];
       const key = `photos_${user?.uid}`;
       if (user?.uid) AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
       return updated;
     });
     // Decrement in-progress: mark matching scanQueue item terminal so bar visibility recalculates (no stuck "Uploading…").
     setScanQueue((prev) =>
       prev.map((item) =>
         item.photoId === photoId ? { ...item, status: 'error' as const, errorMessage: errorMessage ?? undefined } : item
       )
     );
   });
   return () => {
     setOnPhotoUploaded(null);
     setOnPhotoComplete(null);
     setOnPhotoUploadFailed(null);
   };
 }, [user?.uid]);

 const handleRetryUpload = React.useCallback(
   async (photoId: string) => {
     if (!user?.uid) return;
     let ok = await retryQueueItem(user.uid, photoId);
     if (!ok) {
       const photo = photosRef.current.find((p) => p.id === photoId);
       const localUri = (photo as { local_uri?: string })?.local_uri ?? (photo as { uri?: string })?.uri;
       if (localUri) {
         ok = await addToQueue({
           userId: user.uid,
           photoId,
           localUri,
           sourceUri: localUri,
           createdAt: Date.now(),
         });
       }
     }
     if (ok) {
       setPhotos((prev) => {
         const updated = prev.map((p) =>
           p.id === photoId ? { ...p, status: 'local_pending' as const, errorMessage: undefined } : p
         );
         const key = `photos_${user.uid}`;
         AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
         return updated;
       });
       setScanQueue((prev) => {
         const found = prev.find((i) => i.photoId === photoId);
         if (found) {
           return prev.map((i) =>
             i.photoId === photoId ? { ...i, status: 'queued' as const, errorMessage: undefined } : i
           );
         }
         return [...prev, { id: photoId, uri: '', status: 'queued' as const, photoId }];
       });
     }
   },
   [user?.uid]
 );

 const handleRetryAllFailed = React.useCallback(async () => {
   if (!user?.uid) return;
   const failed = photosRef.current.filter((p) => (p as { status?: string }).status === 'failed_upload');
   for (const p of failed) {
     if (p.id) await handleRetryUpload(p.id);
   }
 }, [user?.uid, handleRetryUpload]);

 // Fix D: On terminal (completed|failed|canceled), remove job from durable active store, log the step, then trigger data refresh (photos + allBooks).
 // Durable store uses full scanJobId (job_<uuid>). Standardize so add/remove use same canonical id.
 const triggerDataRefreshRef = React.useRef<() => void>(() => {});
 /** Watchdog uses this only — refresh scan-job list (sync-scans?active=1), never profile/books/photos. */
 const refreshScanJobsOnlyRef = React.useRef<() => Promise<void>>(async () => {});
 const enqueueBookEnrichmentRef = React.useRef<(bookIds: string[]) => void | Promise<void>>(() => {});
  const handleJobTerminalStatus = React.useCallback((jobId: string, status: 'completed' | 'failed' | 'canceled') => {
    if (jobId == null || typeof jobId !== 'string') return;
    const raw = jobId.trim();
    if (!raw || raw.length < 8) return;
    const canonicalId = toScanJobId(raw);
    if (canonicalId.length < 40) return;
 const activeJobIdsBefore = activeScanJobIdsRef.current.length;
 removeActiveScanJobId(canonicalId);
 logger.info('[SCAN_TERMINAL_REMOVE]', 'remove job from active list (durable store + in-memory)', {
 jobId: canonicalId.slice(0, 12),
 status,
 activeJobIdsBefore,
 });
 // Capture matching item synchronously from ref before setScanQueue to avoid React 18 batching race.
 const capturedItem = status === 'completed'
   ? (scanQueueRef.current.find((item) => {
       const itemCanonical = canonicalJobId(item.jobId) ?? canonicalJobId(item.scanJobId) ?? item.jobId ?? item.scanJobId;
       return itemCanonical === canonicalId;
     }) ?? null)
   : null;
 // Mark matching scanQueue item terminal.
 setScanQueue((prev) => {
   const next = prev.map((item) => {
     const itemCanonical = canonicalJobId(item.jobId) ?? canonicalJobId(item.scanJobId) ?? item.jobId ?? item.scanJobId;
     if (itemCanonical !== canonicalId) return item;
     const terminalStatus = status === 'completed' ? 'completed' as const : status === 'failed' ? 'failed' as const : 'canceled' as const;
     return { ...item, status: terminalStatus };
   });
   return next;
 });
 setActiveBatch((prev) => {
 const matchingKey = prev?.jobIds?.find((id) => (canonicalJobId(id) ?? id) === canonicalId);
 if (!prev || !matchingKey) return prev;
 const updatedResults = { ...prev.resultsByJobId, [matchingKey]: { status, books: undefined } };
 const next = { ...prev, resultsByJobId: updatedResults };
 persistBatch(next);
 return next;
 });
 const scanGraceMs = 5000;
 scanTerminalGraceUntilRef.current = Date.now() + scanGraceMs;
 emitLibraryInvalidate({ reason: 'scan_terminal', jobId: canonicalId });
 // For failed/canceled: refresh from server — but only when no batch is in-flight.
 // Otherwise the refresh would overwrite locally-imported pending books from other jobs.
 if (status !== 'completed' && inFlightBatchIdsRef.current.size === 0 && serialScanQueueRef.current.length === 0) {
   triggerDataRefreshRef.current();
 }
 if (status === 'completed') {
   (async () => {
     try {
       const { getScanAuthHeaders } = await import('../lib/authHeaders');
       const headers = await getScanAuthHeaders();
       const base = getApiBaseUrl();
       const res = await fetch(`${base}/api/scan/${encodeURIComponent(canonicalId)}`, { headers });
       if (!res.ok) return;
       const data = (await res.json()) as { status?: string; books?: any[] };
       const ids = (data?.books ?? []).map((b) => b?.id).filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
       if (ids.length > 0) enqueueBookEnrichmentRef.current(ids);
       if (data?.status !== 'completed' || !Array.isArray(data.books) || data.books.length === 0) return;
       const item = capturedItem;
       const photoId = item?.photoId ?? item?.id;
       const uri = item?.uri ?? '';
       if (!photoId) return;
       const rawJobUuid = toRawScanJobUuid(canonicalId) ?? canonicalId.replace(/^job_/, '');
       const photoBooks: Book[] = data.books
         .filter((b: any) => b && (b.title || b.author))
         .map((b: any) => ({
           id: b.id,
           title: b.title ?? '',
           author: b.author ?? '',
           status: 'pending' as const,
           source_photo_id: photoId,
           source_scan_job_id: rawJobUuid,
           ...(b.book_key && { book_key: b.book_key }),
           ...(b.description && { description: b.description }),
           ...(b.coverUrl && { coverUrl: b.coverUrl }),
         }));
       if (photoBooks.length === 0) return;
       const existingKey = (b: Book) => `${(b.title || '').toLowerCase().trim()}|${(b.author || '').toLowerCase().trim()}`;
       const newPhoto: Photo = {
         id: photoId,
         uri,
         books: photoBooks,
         timestamp: Date.now(),
         jobId: canonicalId,
         status: 'draft',
       };
       setPhotos((prev) => dedupBy([...prev, newPhoto], photoStableKey));
       // Capture the actual new pending list inside the updater (prev is always current).
       // Using booksSnapshotRef.current.pending would be stale when two scans complete
       // in quick succession (useEffect hasn't fired yet), causing the second scan to
       // overwrite AsyncStorage with only its own books and wipe the first scan on rehydrate.
       let newPendingForSave: Book[] = [];
       setPendingBooks((prev) => {
         const approvedKeys = new Set(approvedBooksRef.current.map((b) => existingKey(b)));
         const existingKeys = new Set(prev.map((b) => existingKey(b)));
         const deduped = photoBooks.filter((b: Book) => {
           const k = existingKey(b);
           if (approvedKeys.has(k) || existingKeys.has(k)) return false;
           existingKeys.add(k);
           return true;
         });
         newPendingForSave = [...prev, ...deduped];
         return newPendingForSave;
       });
       clearSelection();
       const snap = booksSnapshotRef.current;
       if (user && snap) {
         const newPhotos = [...(photosRef.current ?? []), newPhoto];
         // await so the finally block fires after books are committed to AsyncStorage.
         await saveUserData(newPendingForSave, snap.approved ?? [], snap.rejected ?? [], newPhotos);
         // Mark snapshot committed so focus-refresh debounce guard protects against stale reloads.
         lastSnapshotCommittedAtRef.current = Date.now();
       }
     } catch (_) {
     } finally {
       // Books (if any) are now in AsyncStorage. Only refresh if no other batches are
       // in-flight — otherwise the merge would wipe their locally-imported pending books.
       if (inFlightBatchIdsRef.current.size === 0 && serialScanQueueRef.current.length === 0) {
         triggerDataRefreshRef.current();
       }
     }
     })();
 }
 }, [persistBatch, removeActiveScanJobId, setScanQueue, user]);
 React.useEffect(() => {
 if (!setOnJobTerminalStatus) return;
 setOnJobTerminalStatus(() => handleJobTerminalStatus);
 return () => setOnJobTerminalStatus(undefined);
 }, [setOnJobTerminalStatus, handleJobTerminalStatus]);

 // Durable queue: when Step C returns add scanJobId to activeScanJobIds and set jobId on scanQueue item so handleJobTerminalStatus can match and mark terminal.
 React.useEffect(() => {
 setOnScanJobCreated((uid, photoId, scanJobId) => {
 if (uid !== user?.uid) return;
 const raw = scanJobId != null && typeof scanJobId === 'string' ? scanJobId.trim() : '';
 if (!raw || raw.length < 8) return;
 const canonical = toScanJobId(raw);
 if (canonical.length < 40) return;
 addActiveScanJobId(canonical);
 setScanQueue((prev) => prev.map((item) => (item.photoId === photoId ? { ...item, jobId: canonical, scanJobId: canonical } : item)));
 });
 setOnJobTerminalStatusQueue(handleJobTerminalStatus);
 return () => {
 setOnScanJobCreated(null);
 setOnJobTerminalStatusQueue(null);
 };
 }, [user?.uid, addActiveScanJobId, handleJobTerminalStatus, setScanQueue]);

 // Camera states
 const { isCameraActive, setIsCameraActive } = useCamera();
 const [permission, requestPermission] = useCameraPermissions();
 const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
 const [capturedImage, setCapturedImage] = useState<string | null>(null);
 const [isCameraReady, setIsCameraReady] = useState(false);
 const [zoom, setZoom] = useState(0); // Zoom level (0 = no zoom, 1 = max zoom)
 const lastZoomRef = useRef(0); // Track last zoom for pinch gesture
 const [flashOn, setFlashOn] = useState(false); // Flash for next photo
 const isFocused = useIsFocused();

 // Reset ready and flash when camera closes so next open starts not-ready until onCameraReady
 useEffect(() => {
 if (!isCameraActive) {
 setIsCameraReady(false);
 setFlashOn(false);
 }
 }, [isCameraActive]);

 // Camera tooltip: gentle hint, fade out after ~3s so it feels like a nudge not an alert
 const cameraTipOpacity = useRef(new Animated.Value(1)).current;
 useEffect(() => {
 if (!isCameraActive) return;
 cameraTipOpacity.setValue(1);
 const t = setTimeout(() => {
 Animated.timing(cameraTipOpacity, {
 toValue: 0,
 duration: 600,
 useNativeDriver: true,
 }).start();
 }, 3000);
 return () => clearTimeout(t);
 }, [isCameraActive, cameraTipOpacity]);
 
 // Ref to refresh scan limit banner after scans
 const scanLimitBannerRef = useRef<ScanLimitBannerRef>(null);

 // Track last userId so we clear cache/queue when user changes (prevent account mixing)
 const previousUserIdRef = useRef<string | null>(null);
 // Latest userId for debounce callback (so token refresh doesn't clear state)
 const latestUserIdRef = useRef<string | null>(null);
 const signOutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const SIGN_OUT_DEBOUNCE_MS = 400;
 
 // Ref for search debounce timeout
 const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
 
 // Refs for cancel: so single-image poll knows user canceled and doesn't show "Scan Timeout"
 const scanProgressRef = useRef<typeof scanProgress>(null);
 const canceledJobIdsRef = useRef<Set<string>>(new Set());
 
 // Ref to track if screen is active/mounted (prevents background updates)
 const isActiveRef = useRef(true);
 const checkAndCompletePendingActionsRef = useRef<() => Promise<void>>(async () => {});
 
// Per-batch poll results. Keyed by batchId so concurrent batches each accumulate independently.
// A new scan starting no longer clobbers the in-flight batch's result list.
const batchResultsMapRef = useRef<Map<string, Array<{ index: number; uniqueNewPending: Book[]; newPhoto: Photo }>>>(new Map());
// Per-batch terminal outcomes recorded synchronously in poll callbacks (before React state flushes).
// Each entry is the terminal server status for one job: 'completed' | 'failed' | 'canceled' | 'import_failed'.
// This is the authoritative source for BATCH_COMPLETE tallies — never read stale scanQueue state.
const batchOutcomesMapRef = useRef<Map<string, Array<'completed' | 'failed' | 'canceled' | 'import_failed'>>>(new Map());
// Set of batchIds whose poll loops are still running. Used as the gate for "should this result be imported?"
// Replaces the old `currentBatchIdRef !== batchId` guard which only allowed the *latest* batch to import.
const inFlightBatchIdsRef = useRef<Set<string>>(new Set());
/**
 * Timestamp of the most recent hard cancel (Date.now()). Used by grace-window cleanup effects to
 * immediately bypass the 15-second grace window when a user-initiated cancel just fired.
 * Set to 0 at boot; updated by the cancel callback before clearActiveBatch.
 */
const lastCanceledAtRef = useRef<number>(0);
/**
 * Per-job book count as reported by SCAN_IMPORT (JOB_SUMMARY.booksOnServer).
 * Populated by enqueueBatch when scan results arrive. Used by verifyOk to detect
 * count mismatches between what was imported and what was actually written to the server.
 * Key: bare scan job UUID (without "job_" prefix). Value: bookCount from server.
 */
const importedBookCountByJobIdRef = useRef<Record<string, number>>({});

/**
 * Serial scan queue: images that arrived while a batch was already in-flight.
 * Instead of starting a second concurrent batch (which corrupts UI/cancel/polling state),
 * we buffer them here and drain as a single new batch once the active batch reaches terminal.
 *
 * Invariant: at most ONE batch runs at a time. New images either join the current
 * batch's queue records (if it hasn't uploaded yet) or land here to start next.
 */
const serialScanQueueRef = useRef<Array<{ uri: string; scanId: string }>>([]);
/**
 * Callback ref: set by enqueueBatch to drain serialScanQueueRef once the batch it
 * started reaches terminal (completed / failed / all-canceled). Cleared after drain.
 */
const onBatchTerminalRef = useRef<(() => void) | null>(null);

 // Server-reported active job ids (from sync-scans on focus). Used for backstop and jobsInProgress recalc.
 const [lastServerActiveJobIds, setLastServerActiveJobIds] = useState<string[] | null>(null);
 const lastLoggedServerActiveRef = useRef<string | null>(null);

 /** True while enqueueBatch is running (atomic add done, async loop in progress). Guard: do not run cleanup/restore-replace. */
 const batchStartingRef = useRef(false);
 /** True when queue has items with status 'queued' (batch just created, no jobIds yet). Guard: do not run cleanup. */
 const queueHasQueuedRef = useRef(false);
 /** True when queue has any item status 'queued' or 'processing' (in-flight work). Guard: do not run cleanup. */
 const queueHasInFlightRef = useRef(false);
 /** Set to Date.now() when a scan job is enqueued (camera or batch). Grace window: no cleanup for 15s after start. */
 const lastScanStartAtRef = useRef(0);
 /** Set to Date.now() when user approves photo/books. Do not run CLEANUP_ACTION right after approval (state transition, not "no active jobs"). */
 const lastApprovedAtRef = useRef(0);
 /** End of approval grace window (ms). While now < this, server snapshot must not replace local if server is smaller/stale. */
 const approvalGraceUntilRef = useRef(0);
 /** End of scan-terminal grace (ms). Set when a scan job goes terminal so the next refresh doesn't overwrite just-imported photos/books with a stale server snapshot. */
 const scanTerminalGraceUntilRef = useRef(0);
 /** Mirror of jobsInProgress for use in async cleanup callbacks (focus/reconcile). */
 const jobsInProgressRef = useRef(0);
 /** Throttle SCAN_WATCHDOG logs to at most every 5s. */
 const lastWatchdogLogRef = useRef(0);
 /** Log JOBS_IN_PROGRESS_RECALC only when inFlight count changes (delta). */
 const lastInFlightForLogRef = useRef<number>(-1);
 /** Log LOCAL_QUEUE_UPDATE only when reason+queueLength changes (short delta message). */
 const lastQueueLogKeyRef = useRef<string>('');
 /** Log CLEANUP_ACTION only when reason+cleared flags change (dedupe repeats). */
 const lastCleanupKeyRef = useRef<string>('');

 // TTL for completed batches: clear only when batch is terminal AND older than this (do not clear on tab blur/focus).
 const BATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24h

 /** Log queue delta only when reason+queueLength changes; short one-liner. */
 const logQueueDelta = useCallback((reason: string, queueLength: number, extra?: string) => {
 const key = `${reason}:${queueLength}`;
 if (key === lastQueueLogKeyRef.current) return;
 lastQueueLogKeyRef.current = key;
 const msg = reason === 'cleanup' ? 'queue cleared' : extra ? `${extra}, queue ${queueLength} job(s)` : `queue ${queueLength} job(s)`;
 logger.debug('[LOCAL_QUEUE_UPDATE]', msg, { reason, queueLength });
 }, []);

 /** Log CLEANUP_ACTION only when reason+cleared flags change (suppress repeat cancel/cleanup spam). */
 const logCleanupAction = useCallback((payload: { reason: string; clearedScanQueue: boolean; clearedScanProgress: boolean; clearedActiveBatch: boolean; clearedStorageKeys: string[] }) => {
 const key = [payload.reason, payload.clearedScanQueue, payload.clearedScanProgress, payload.clearedActiveBatch, payload.clearedStorageKeys.length].join('|');
 if (key === lastCleanupKeyRef.current) return;
 lastCleanupKeyRef.current = key;
 if (LOG_DEBUG) logger.debug('[CLEANUP_ACTION]', payload.reason, payload);
 }, []);

 // jobsInProgress = in-flight queue items (queued/uploading/processing) so bar shows immediately for camera; also count batch jobIds when present.
 // Defer setJobsInProgress to next tick so we never update the Provider during ScansTab's render/effect phase (avoids "Cannot update ScansTab while rendering ScanningProvider").
 useEffect(() => {
 queueHasQueuedRef.current = scanQueue.some((i) => i.status === 'queued');
 queueHasInFlightRef.current = scanQueue.some((i) => i.status === 'queued' || i.status === 'processing' || i.status === 'pending');
 const isInFlightStatus = (s: ScanQueueItem['status']) => s === 'queued' || s === 'pending' || s === 'processing';
 const queueInFlightCount = scanQueue.filter((i) => isInFlightStatus(i.status)).length;
 const hasValidBatch = (item: ScanQueueItem) => !!item.batchId && item.batchId !== 'no-batch';
 const pendingProcessing = scanQueue.filter(
 (item) => isInFlightStatus(item.status) && hasValidBatch(item)
 );
 const fromQueue = pendingProcessing
 .map((item) => canonicalJobId(item.jobId))
 .filter((id): id is string => id != null);
 const localQueueJobIds = (activeBatch?.jobIds ?? []).map(canonicalJobId).filter((id): id is string => id != null);
 const fromBatch = localQueueJobIds.filter((jid) => !isTerminalJobStatus(activeBatch?.resultsByJobId[jid]?.status ?? 'queued'));
 const batchInFlightCount = new Set([...fromQueue, ...fromBatch]).size;
 const inFlight = Math.max(queueInFlightCount, batchInFlightCount);
 jobsInProgressRef.current = inFlight;
 if (inFlight !== lastInFlightForLogRef.current) {
 const prev = lastInFlightForLogRef.current;
 lastInFlightForLogRef.current = inFlight;
 const msg = prev >= 0 ? `inProgress ${prev}${inFlight}` : `inProgress ${inFlight}`;
 logger.debug('[JOBS_IN_PROGRESS_RECALC]', msg, { inFlight });
 }
 const t = setTimeout(() => setJobsInProgress(inFlight), 0);
 return () => clearTimeout(t);
 }, [scanQueue, activeBatch?.jobIds, activeBatch?.resultsByJobId, lastServerActiveJobIds, setJobsInProgress]);

 // If batch is invalid (has batchId but no jobIds), clear it but NOT when queue has 'queued' items or batch loop is still running.
 // Skipping when queueHasQueuedRef.current or batchStartingRef.current avoids clearing activeBatch before jobIds are filled, which caused "Scan failed".
 useEffect(() => {
 const hasValidBatch = activeBatch?.batchId && (activeBatch.jobIds?.length ?? 0) > 0;
 const batchLoopRunning = batchStartingRef.current;
 if (jobsInProgress > 0 && !hasValidBatch && activeBatch !== null && !queueHasQueuedRef.current && !batchLoopRunning) {
 if (scanProgress !== null) setScanProgress(null);
 clearActiveBatch(undefined, 'cleanup');
 }
 }, [jobsInProgress, activeBatch, scanProgress, setScanProgress, clearActiveBatch]);

// Rule 3: When jobsInProgress === 0, clear state unless a natural (non-cancel) scan just started.
// CANCEL BYPASS: if a hard cancel fired within the last 2s, skip all grace windows — the bar must hide immediately.
  useEffect(() => {
  if (jobsInProgress !== 0) return;
  const msSinceCancel = Date.now() - lastCanceledAtRef.current;
  const justCanceled = lastCanceledAtRef.current > 0 && msSinceCancel < 2000;
  if (!justCanceled) {
    // Normal (non-cancel) guards: don't clear state if a new scan is legitimately starting.
    const serverActive = lastServerActiveJobIds ?? [];
    if (serverActive.length > 0) return; // Server still has active jobs; do not clear.
    if (batchStartingRef.current) return; // Batch loop still running; do not clear.
    if (scanQueue.some((item) => item.status === 'queued' || item.status === 'processing')) return; // Queue has in-flight items.

    // TERMINAL BATCH CHECK: if every jobId in the current batch already has a terminal
    // status in resultsByJobId (failed/completed/canceled), there is no live work — skip
    // the grace window so a fast failure clears the bar immediately instead of waiting 15s.
    const batchJobIds = activeBatchRef.current?.jobIds ?? [];
    const batchResults = activeBatchRef.current?.resultsByJobId ?? {};
    const allBatchJobsTerminal =
      batchJobIds.length > 0 &&
      batchJobIds.every((jid) => isTerminalJobStatus(batchResults[jid]?.status ?? 'queued'));

    // QUEUE TERMINAL CHECK: if all queue items for this batch have reached a terminal
    // status (completed/failed/error/canceled/import_failed), there is no live work —
    // skip the grace window. This catches the case where jobs failed before being assigned
    // a jobId (so batchJobIds is empty) but the queue records are already terminal.
    const batchId = activeBatchRef.current?.batchId;
    const batchQueueItems = batchId ? scanQueue.filter((i) => i.batchId === batchId) : [];
    const terminalQueueStatuses: ScanQueueItem['status'][] = ['completed', 'failed', 'error', 'canceled', 'import_failed'];
    const allQueueItemsTerminal =
      batchQueueItems.length > 0 &&
      batchQueueItems.every((i) => terminalQueueStatuses.includes(i.status));

    const noLiveWork = allBatchJobsTerminal || allQueueItemsTerminal;

    if (!noLiveWork) {
      if ((activeBatchRef.current?.jobIds?.length ?? 0) > 0) return; // Batch has jobIds still in flight; do not clear.
      // Grace window: allow up to 15s after a NATURAL (non-cancel) batch start before auto-clearing.
      // This prevents a premature clear while jobIds are being assigned to the batch.
      // SKIPPED entirely on cancel AND when we've confirmed no live work remains.
      if (Date.now() - lastScanStartAtRef.current < 15000) return;
    } else {
      logger.debug('[RULE3_TERMINAL_BYPASS]', 'skipping grace window — all jobs terminal', {
        allBatchJobsTerminal,
        allQueueItemsTerminal,
        batchJobIds: batchJobIds.length,
        batchQueueItems: batchQueueItems.length,
      });
    }
  }
  // ScanningNotification handles its own 100% exit animation, so we can clear immediately.
  if (scanProgress !== null) setScanProgress(null);
  if (activeBatch !== null) clearActiveBatch(undefined, justCanceled ? 'cancel' : 'import_complete');
  }, [jobsInProgress, scanProgress, activeBatch, lastServerActiveJobIds, scanQueue, setScanProgress, clearActiveBatch]);

 // ── Stuck-queue watchdog ─────────────────────────────────────────────────────
 // Only mark 'error' when: item is still 'queued', no scanJobId assigned yet, and past threshold.
 // "Queued for 12s" is normal (upload + Step C can take 10–30s). Do not use watchdog to "mark error so bar can clear."
 // Either use a long threshold (60–120s) or only mark when (no jobId AND upload done AND retries exhausted).
 // We use: only mark error when status === 'queued' AND no jobId/scanJobId (server never assigned) AND stuck > threshold.
 const WATCHDOG_TIMEOUT_MS = 60000; // 60s; was 12s — queued 12s is normal, not a failure
 useEffect(() => {
   const stuckItems = scanQueue.filter(
     (i) =>
       i.status === 'queued' &&
       !i.jobId &&
       !i.scanJobId &&
       i.createdAt != null &&
       Date.now() - i.createdAt > WATCHDOG_TIMEOUT_MS
   );
   if (stuckItems.length === 0) return;

   const earliestCreated = Math.min(...stuckItems.map((i) => i.createdAt ?? Date.now()));
   const msUntilExpiry = WATCHDOG_TIMEOUT_MS - (Date.now() - earliestCreated);
   const timer = setTimeout(() => {
     setScanQueue((prev) => {
       const now = Date.now();
       let changed = false;
       const next = prev.map((i) => {
         if (
           i.status === 'queued' &&
           !i.jobId &&
           !i.scanJobId &&
           i.createdAt != null &&
           now - i.createdAt > WATCHDOG_TIMEOUT_MS
         ) {
           changed = true;
           if (now - lastWatchdogLogRef.current > 5000) {
             logger.warn('[SCAN_WATCHDOG]', 'queue item stuck in queued (no jobId); marking error', {
               scanId: i.id,
               batchId: i.batchId ?? null,
               stuckMs: now - i.createdAt,
             });
             lastWatchdogLogRef.current = now;
           }
           return { ...i, status: 'error' as const, errorMessage: 'Scan timed out waiting for server — please retry' };
         }
         return i;
       });
       return changed ? next : prev;
     });
   }, Math.max(0, msUntilExpiry));
   return () => clearTimeout(timer);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [scanQueue]);
 // ─────────────────────────────────────────────────────────────────────────────

 // Derive scanProgress from activeBatch (primary). Single progress bar = completedJobs / totalJobs. Never merge across batches.
 // Only clear batch when: user Cancel, user dismisses completed batch, or batch terminal + older than TTL. Do NOT clear on focus/navigation.
 // When no activeBatch: only clear scanProgress if no jobs in progress. Do NOT depend on scanProgress in deps to avoid max update depth loop; use scanProgressRef for guard.
 useEffect(() => {
 if (!activeBatch) {
 if (jobsInProgress === 0 && (lastServerActiveJobIds ?? []).length === 0) {
 const prev = scanProgressRef.current;
 if (prev !== null) setScanProgress(null);
 totalScansRef.current = 0;
 }
 return;
 }
 const { completed, total, fraction } = batchProgress(activeBatch);
 const failed = activeBatch.jobIds.filter((jid) => activeBatch.resultsByJobId[jid]?.status === 'failed').length;
 const canceled = activeBatch.jobIds.filter((jid) => activeBatch.resultsByJobId[jid]?.status === 'canceled').length;
 const completedScans = activeBatch.jobIds.filter((jid) => activeBatch.resultsByJobId[jid]?.status === 'completed').length;
 totalScansRef.current = total;
 const reason = scanShowReasonRef.current ?? undefined;
 if (scanShowReasonRef.current) scanShowReasonRef.current = null;
 const nextProgress = {
 currentScanId: null,
 currentStep: Math.round(fraction * 10),
 totalSteps: 10,
 totalScans: total,
 completedScans,
 failedScans: failed,
 canceledScans: canceled,
 startTimestamp: activeBatch.createdAt,
 batchId: activeBatch.batchId,
 jobIds: (activeBatch.jobIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length >= 8),
 showReason: reason,
 };
 const prev = scanProgressRef.current;
 const same =
 prev &&
 prev.batchId === nextProgress.batchId &&
 prev.startTimestamp === nextProgress.startTimestamp &&
 prev.totalScans === nextProgress.totalScans &&
 prev.completedScans === nextProgress.completedScans &&
 prev.failedScans === nextProgress.failedScans &&
 (prev.canceledScans ?? 0) === (nextProgress.canceledScans ?? 0) &&
 prev.currentStep === nextProgress.currentStep;
 if (!same) setScanProgress(nextProgress);
 const status = deriveBatchStatus(activeBatch);
 if (total > 0 && isTerminalBatchStatus(status)) {
 const age = Date.now() - activeBatch.createdAt;
 if (age >= BATCH_TTL_MS) {
 clearActiveBatch(activeBatch.batchId, 'cleanup');
 setScanProgress(null);
 setScanQueue((prev) => prev.filter((item) => item.batchId !== activeBatch.batchId));
 }
 }
 }, [activeBatch, clearActiveBatch, jobsInProgress, lastServerActiveJobIds]);

 // Single structured log snapshot when scan bar state changes (proves whether UI or server is out of sync). Log once per logical change.
 const lastScanBarLogKeyRef = useRef<string>('');
 const scanBarVisibilityLogKeyRef = useRef<string>('');
 useEffect(() => {
 const localBatchId = activeBatch?.batchId ?? null;
 const localQueueJobIds = (activeBatch?.jobIds ?? []).map(canonicalJobId).filter((id): id is string => id != null);
 const serverActiveJobIds = ((scanProgress as any)?.jobIds ?? []).map(canonicalJobId).filter((id): id is string => id != null);
 const reason = (scanProgress as any)?.showReason ?? (activeBatch ? 'batch' : 'none');
 const pendingCountByScanJobId: Record<string, number> = {};
 scanQueue.forEach((item) => {
 const bid = item.batchId ?? 'no-batch';
 pendingCountByScanJobId[bid] = (pendingCountByScanJobId[bid] ?? 0) + (item.status === 'queued' || item.status === 'pending' || item.status === 'processing' ? 1 : 0);
 });
 const key = [reason, localBatchId, localQueueJobIds.join(','), serverActiveJobIds.join(','), jobsInProgress, JSON.stringify(pendingCountByScanJobId)].join('|');
 if (key === lastScanBarLogKeyRef.current) return;
 lastScanBarLogKeyRef.current = key;
 logger.trace('[SCAN_BAR_STATE]', 'tracked/jobsInProgress/batchId changed', {
 reason,
 localBatchId,
 localQueueJobIds: [...localQueueJobIds],
 serverActiveJobIds: [...serverActiveJobIds],
 jobsInProgress,
 pendingCountByScanJobId,
 });
 }, [activeBatch, scanProgress, scanQueue, jobsInProgress]);

 // Data states — single source of truth: books[] with status. Profile shows only approved; Pending screen uses only this filter (never photo join).
 const [books, setBooks] = useState<Book[]>([]);
 const approvedBooks = React.useMemo(
   () => books.filter((b) => (b as any).status === 'approved' && !(b as any).deleted_at),
   [books]
 );
 // Pending screen: derive from ALL books by status only. Never from approved-derived buckets or photos-with-approved-books.
 const pendingBooks = React.useMemo(
   () => books.filter((b) => ((b as any).status === 'pending' || (b as any).status === 'incomplete') && !(b as any).deleted_at),
   [books]
 );
 // Ref for current pending books so loadUserData merge can access fresh value (not stale closure).
 const pendingBooksRef = useRef(pendingBooks);
 pendingBooksRef.current = pendingBooks;
 const rejectedBooks = React.useMemo(
   () => books.filter((b) => (b as any).status === 'rejected' && !(b as any).deleted_at),
   [books]
 );
 const setBooksFromBuckets = useCallback((approved: Book[], pending: Book[], rejected: Book[]) => {
   type Status = NonNullable<Book['status']>;
   setBooks([
     ...approved.map((b): Book => ({ ...b, status: 'approved' })),
     ...pending.map((b): Book => ({ ...b, status: ((b as any).status === 'incomplete' ? 'incomplete' : 'pending') as Status })),
     ...rejected.map((b): Book => ({ ...b, status: 'rejected' })),
   ]);
 }, []);
 const setApprovedBooks = useCallback((updater: Book[] | ((prev: Book[]) => Book[])) => {
   setBooks((prev) => {
     const approved = prev.filter((b) => (b as any).status === 'approved');
     const next = typeof updater === 'function' ? updater(approved) : updater;
     const nextWithStatus = (Array.isArray(next) ? next : []).map((b) => ({ ...b, status: 'approved' as const }));
     return [...prev.filter((b) => (b as any).status !== 'approved'), ...nextWithStatus];
   });
 }, []);
 const setPendingBooks = useCallback((updater: Book[] | ((prev: Book[]) => Book[])) => {
   setBooks((prev) => {
     const pending = prev.filter((b) => (b as any).status === 'pending' || (b as any).status === 'incomplete');
     const next = typeof updater === 'function' ? updater(pending) : updater;
     const nextWithStatus = (Array.isArray(next) ? next : []).map((b): Book => ({ ...b, status: ((b as any).status === 'incomplete' ? 'incomplete' : 'pending') as NonNullable<Book['status']> }));
     return [...prev.filter((b) => (b as any).status !== 'pending' && (b as any).status !== 'incomplete'), ...nextWithStatus];
   });
 }, []);
 const setRejectedBooks = useCallback((updater: Book[] | ((prev: Book[]) => Book[])) => {
   setBooks((prev) => {
     const rejected = prev.filter((b) => (b as any).status === 'rejected');
     const next = typeof updater === 'function' ? updater(rejected) : updater;
     const nextWithStatus = (Array.isArray(next) ? next : []).map((b) => ({ ...b, status: 'rejected' as const }));
     return [...prev.filter((b) => (b as any).status !== 'rejected'), ...nextWithStatus];
   });
 }, []);
 /** Mirror of approvedBooks for use in async callbacks (avoid stale closure captures). */
 const approvedBooksRef = React.useRef<Book[]>(approvedBooks);
 React.useEffect(() => {
   approvedBooksRef.current = approvedBooks;
 }, [approvedBooks]);
 /** Snapshot of all buckets for enrichment merge (patch by id without full rehydrate). */
 const booksSnapshotRef = React.useRef<{ approved: Book[]; pending: Book[]; rejected: Book[] }>({ approved: [], pending: [], rejected: [] });
 React.useEffect(() => {
   booksSnapshotRef.current = { approved: approvedBooks, pending: pendingBooks, rejected: rejectedBooks };
 }, [approvedBooks, pendingBooks, rejectedBooks]);

 /** Enrichment: fetch title/author/cover by ids and merge into store so author data appears without waiting for full rehydrate. Call after scan terminal or approve. */
 const enqueueBookEnrichment = useCallback(
   async (bookIds: string[]) => {
     if (!user?.uid || isGuestUser(user) || bookIds.length === 0) return;
     try {
       const fetched = await fetchBooksByIds(user.uid, bookIds);
       if (fetched.length === 0) return;
       const byId = new Map<string, Book>();
       fetched.forEach((b) => {
         if (b.id) byId.set(b.id, b);
       });
       const patch = (list: Book[]): Book[] =>
         list.map((b) => {
           const f = (b.id && byId.get(b.id)) ?? (b.dbId && byId.get(b.dbId));
           if (!f) return b;
           return {
             ...b,
             title: f.title ?? b.title,
             author: f.author ?? b.author,
             coverUrl: f.coverUrl ?? b.coverUrl,
             description: f.description ?? b.description,
             book_key: f.book_key ?? b.book_key,
             enrichment_status: f.enrichment_status ?? b.enrichment_status,
             pageCount: f.pageCount ?? b.pageCount,
             publisher: f.publisher ?? b.publisher,
             publishedDate: f.publishedDate ?? b.publishedDate,
             categories: f.categories ?? b.categories,
             language: f.language ?? b.language,
             averageRating: f.averageRating ?? b.averageRating,
             ratingsCount: f.ratingsCount ?? b.ratingsCount,
             subtitle: f.subtitle ?? b.subtitle,
           };
         });
       const snap = booksSnapshotRef.current;
       const patchedApproved = patch(snap.approved);
       const patchedPending = patch(snap.pending);
       const approvedCanonical = ensureApprovedOnePerBookKey(patchedApproved);
       setBooksFromBuckets(approvedCanonical, patchedPending, snap.rejected);
       const userApprovedKey = `approved_books_${user.uid}`;
       const userPendingKey = `pending_books_${user.uid}`;
       const userRejectedKey = `rejected_books_${user.uid}`;
       await Promise.all([
         AsyncStorage.setItem(userApprovedKey, JSON.stringify(approvedCanonical)),
         AsyncStorage.setItem(userPendingKey, JSON.stringify(patchedPending)),
         AsyncStorage.setItem(userRejectedKey, JSON.stringify(snap.rejected)),
       ]);
       logger.debug('[BOOK_ENRICHMENT]', 'merged by id', { requested: bookIds.length, fetched: fetched.length });
     } catch (e) {
       logger.warn('[BOOK_ENRICHMENT]', (e as Error)?.message ?? String(e));
     }
   },
   [user?.uid, setBooksFromBuckets]
 );
 React.useEffect(() => {
   enqueueBookEnrichmentRef.current = enqueueBookEnrichment;
 }, [enqueueBookEnrichment]);

 const [photos, setPhotos] = useState<Photo[]>([]);
/** Latest photos for dedupe: when reused, use existing photo id everywhere (batch store, books, keys). */
const photosRef = React.useRef<Photo[]>(photos);
React.useEffect(() => {
photosRef.current = photos;
}, [photos]);

// Derive failed upload count for dock: show "N upload failed — Tap to retry" banner when only failures remain.
React.useEffect(() => {
  const count = photos.filter((p) => (p as { status?: string }).status === 'failed_upload').length;
  setFailedUploadCount(count);
}, [photos, setFailedUploadCount]);

/** Persist signed URL on the photo in state and AsyncStorage. Refresh 1 min before expiry. */
const upsertPhotoSignedUrl = useCallback(
  (photoId: string, signedUrl: string, expiresInSec: number) => {
    const expiresAt = Date.now() + (expiresInSec - 60) * 1000;
    setPhotos((prev) => {
      const next = prev.map((p) =>
        p.id === photoId ? { ...p, signed_url: signedUrl, signed_url_expires_at: expiresAt } : p
      );
      const hasSignedNow = !!next.find((p) => p.id === photoId)?.signed_url;
      logger.info('[SIGNED_URL_PERSIST]', {
        photoId: photoId.slice(0, 8),
        wroteToState: true,
        hasSignedNow,
      });
      if (user?.uid) {
        const key = `photos_${user.uid}`;
        AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
      }
      return next;
    });
  },
  [user?.uid]
);

React.useEffect(() => {
  if (photoSignedUrlPersistRef) photoSignedUrlPersistRef.current = upsertPhotoSignedUrl;
  return () => {
    if (photoSignedUrlPersistRef) photoSignedUrlPersistRef.current = null;
  };
}, [photoSignedUrlPersistRef, upsertPhotoSignedUrl]);

 /** Diagnostic: log every approved list change. Identity = book_key (not id); id can change tempUUID without churn. */
 const prevApprovedIdsRef = React.useRef<Set<string> | null>(null);
 const prevApprovedKeysRef = React.useRef<Set<string> | null>(null);
 const lastApprovedUpdateSourceRef = React.useRef<string>('initial');
 const WATCH_APPROVED_ID = 'be281ef3-e0fe-458e-acd7-fa26b0ee59e7';
 /** Once server merge has run, never replace approved from AsyncStorage again (hydrate once). Reset on sign_out/user_switch. */
 const hasServerHydratedRef = React.useRef<boolean>(false);
 /** Current approved length for diagnostic when deciding async_storage_initial. */
 const approvedBooksLenRef = React.useRef<number>(0);
 /**
  * Monotonically increasing sequence number. Incremented on every authoritative snapshot write
  * (rehydrate_merge and post-approve full refresh). Every state update carries the seq it was
  * computed from. A write is only applied if its seq >= the last applied seq, preventing an
  * older in-flight rehydrate from overwriting a newer post-approve snapshot.
  */
 const snapshotSeqRef = React.useRef<number>(0);
 /** Seq number of the last snapshot actually applied to React state. */
 const appliedSnapshotSeqRef = React.useRef<number>(0);
 /**
  * Timestamp until which rehydrate_merge must not overwrite post-approve state.
  * Set to Date.now() + POST_APPROVE_LOCK_MS when APPROVE_FULL_REFRESH commits.
  * A rehydrate that fires within this window is skipped (it would carry stale server
  * data from a fetch that started before the approve landed).
  */
 const postApproveLockUntilRef = React.useRef<number>(0);
/** The highest serverApprovedCount we have ever seen from a trusted snapshot. Prevents
 * a subsequent 0-row snapshot from wiping the approved list.
 * Primed at boot from AsyncStorage via loadHighWaterMark() so cold restarts retain memory. */
const highWaterApprovedCountRef = React.useRef<number>(0);
/** Same high-water mark for photos. Primed at boot from AsyncStorage. */
const highWaterPhotosCountRef = React.useRef<number>(0);
/** When epoch changes (e.g. after cache clear), we reset high-water refs so the next server snapshot is accepted. */
const safetyEpochRef = React.useRef<string | null>(null);
/** True for one rehydrate cycle after we reset refs due to epoch change — so drop check bypasses (accept server). */
const justResetBaselinesRef = React.useRef<boolean>(false);
/** True when we created a new epoch this session (no epoch in storage at priming). Used for [SAFETY_BOOT] diagnostic. */
const isFreshInstallThisSessionRef = React.useRef<boolean>(false);
/**
 * The last destructive action loaded from AsyncStorage at boot.
 * Updated in-memory whenever logDeleteAudit fires (via the deleteGuard module which also
 * persists to AsyncStorage). The merge guard reads this to decide whether a count drop is
 * explained by a recent intentional delete or is truly suspicious.
 */
const lastDestructiveActionRef = React.useRef<LastDestructiveAction | null>(null);
/** Grace window after a destructive action where count-drops are accepted (server may not have settled). */
const DESTRUCTIVE_ACTION_GRACE_MS = RECENT_DESTRUCTIVE_MS;
const POST_APPROVE_LOCK_MS = 20_000; // 20 s window after approve where rehydrate can't overwrite
/** tempId -> canonicalId so we don't churn list when ids change; persist and load with user data. */
const idAliasRef = React.useRef<Record<string, string>>({});
/** localPhotoId -> canonicalPhotoId; persisted across sessions so every ingestion edge can canonicalize without re-deduping. */
const photoIdAliasRef = React.useRef<Record<string, string>>({});
/** Resolve a photo id through the persisted alias map. Stable — safe to call anywhere in the component. */
const resolvePhotoId = useCallback((id: string | undefined | null): string | undefined => {
  if (!id) return id ?? undefined;
  return photoIdAliasRef.current[id] ?? id;
}, []);

/**
 * Resolve a photo id and emit a rate-limited [PHOTO_ID_RESOLVE] log.
 * Use this at named call sites (approve, rehydrate, integrity_check) so you can trace
 * "we rewrote the ID but the book still held the old one".
 */
const resolvePhotoIdLogged = useCallback((
  id: string | undefined | null,
  context: 'approve' | 'approve_with_real_ids' | 'rehydrate' | 'merge' | 'integrity_check' | 'ingestion',
): string | undefined => {
  if (!id) return id ?? undefined;
  const resolved = photoIdAliasRef.current[id] ?? id;
  const wasAliased = resolved !== id;
  if (wasAliased) {
    logger.rateLimit(
      `photo_id_resolve_${context}`,
      2000,
      'debug',
      '[PHOTO_ID_RESOLVE]',
      context,
      { context, in: id.slice(0, 8), out: resolved.slice(0, 8), wasAliased: true },
    );
  }
  return resolved;
}, []);

/** Apply resolvePhotoId to a book's source_photo_id. Returns same object if no change. */
const resolveBookPhotoIdsCb = useCallback((books: Book[], context: 'approve' | 'rehydrate' | 'merge' | 'integrity_check' | 'ingestion' = 'ingestion'): Book[] =>
  books.map((b) => {
    const canonical = resolvePhotoIdLogged(b.source_photo_id, context);
    return canonical !== b.source_photo_id ? { ...b, source_photo_id: canonical } : b;
  }), [resolvePhotoIdLogged]);

/**
 * Normalize photos to canonical ids at ingestion so UI mapping uses one namespace.
 * Resolves each photo.id through alias map; merges duplicates (same canonical id) into one photo with combined books.
 */
const normalizePhotosToCanonicalIds = useCallback((photos: Photo[]): Photo[] => {
  const byId = new Map<string, Photo>();
  photos.forEach((p) => {
    const canonical = resolvePhotoId(p.id) ?? p.id ?? '';
    if (!canonical) return;
    const existing = byId.get(canonical);
    if (!existing) {
      byId.set(canonical, { ...p, id: canonical });
      return;
    }
    byId.set(canonical, {
      ...existing,
      books: [...(existing.books ?? []), ...(p.books ?? [])],
    });
  });
  return Array.from(byId.values());
}, [resolvePhotoId]);

/**
 * Query the DB for a set of photo IDs and log which were found vs missing.
 * Resolves each requested ID through the alias map first so we catch "queried by alias" bugs.
 * Safe to call anywhere; no-ops if supabase is unavailable or ids is empty.
 */
const logPhotoRowLookup = useCallback(async (
  ids: string[],
  context: string,
): Promise<void> => {
  if (!supabase || !user?.uid || ids.length === 0) return;
  const t0 = Date.now();
  const resolvedIds = ids.map((id) => resolvePhotoId(id) ?? id);
  const deduped = [...new Set(resolvedIds)];
  try {
    const { data } = await supabase
      .from('photos')
      .select('id')
      .eq('user_id', user.uid)
      .in('id', deduped.slice(0, 20)); // cap to avoid huge IN queries
    const foundSet = new Set((data ?? []).map((r: { id: string }) => r.id));
    const foundIds = deduped.filter((id) => foundSet.has(id));
    const missingIds = deduped.filter((id) => !foundSet.has(id));
    logger.info('[PHOTO_ROW_LOOKUP]', {
      context,
      requestedIds: ids.slice(0, 5).map((id) => id.slice(0, 8)),
      resolvedIds: deduped.slice(0, 5).map((id) => id.slice(0, 8)),
      foundCount: foundIds.length,
      missingCount: missingIds.length,
      missingIds: missingIds.slice(0, 5).map((id) => id.slice(0, 8)),
      queryLatencyMs: Date.now() - t0,
    });
  } catch (err: any) {
    logger.warn('[PHOTO_ROW_LOOKUP]', { context, error: err?.message ?? String(err) });
  }
}, [user?.uid, resolvePhotoId]);

/** Merge new entries into photoIdAliasRef, persist to AsyncStorage, and log the update. */
const mergePhotoAliases = useCallback(async (newAliases: Record<string, string>) => {
  if (!user?.uid || Object.keys(newAliases).length === 0) return;
  const genuinelyNew = Object.fromEntries(
    Object.entries(newAliases).filter(([k, v]) => photoIdAliasRef.current[k] !== v)
  );
  if (Object.keys(genuinelyNew).length === 0) return;
  photoIdAliasRef.current = { ...photoIdAliasRef.current, ...genuinelyNew };
  await AsyncStorage.setItem(`photo_id_aliases_${user.uid}`, JSON.stringify(photoIdAliasRef.current));
  const aliasCount = Object.keys(photoIdAliasRef.current).length;
  const newMappingsSample = Object.entries(genuinelyNew)
    .slice(0, 5)
    .map(([local, canonical]) => ({ local: local.slice(0, 8), canonical: canonical.slice(0, 8) }));
  // Show a few example resolutions so you can quickly confirm the map is being used correctly.
  const exampleResolve = Object.entries(photoIdAliasRef.current)
    .slice(0, 3)
    .map(([local, canonical]) => `${local.slice(0, 8)}→${canonical.slice(0, 8)}`);
  logger.info('[PHOTO_ALIAS_MAP_UPDATE]', {
    aliasCount,
    newMappings: newMappingsSample,
    exampleResolve,
  });
}, [user?.uid]);
 useEffect(() => {
 const list = approvedBooks ?? [];
 const nextIds = new Set(list.map((b) => b.id).filter((x): x is string => Boolean(x)));
 const nextKeys = new Set(list.map((b) => getStableBookKey(b)).filter(Boolean));
 approvedBooksLenRef.current = nextIds.size;
 if (prevApprovedKeysRef.current === null) {
 prevApprovedIdsRef.current = nextIds;
 prevApprovedKeysRef.current = nextKeys;
 return;
 }
 const prevKeys = prevApprovedKeysRef.current;
 const addedKeys = [...nextKeys].filter((k) => !prevKeys.has(k));
 const removedKeys = [...prevKeys].filter((k) => !nextKeys.has(k));
 const prevIds = prevApprovedIdsRef.current;
 const hasMissingIdBefore = prevIds.has(WATCH_APPROVED_ID);
 const hasMissingIdAfter = nextIds.has(WATCH_APPROVED_ID);
 const idUpgradedCount = nextKeys.size === prevKeys.size && addedKeys.length === 0 && removedKeys.length === 0 && nextIds.size !== 0 && prevIds.size !== 0
 ? [...nextIds].filter((id) => !prevIds.has(id)).length
 : 0;
 logger.debug('[APPROVED_CHANGED]', 'approved list updated (by book_key)', {
 from: prevKeys.size,
 to: nextKeys.size,
 source: lastApprovedUpdateSourceRef.current,
 addedKeys: addedKeys.length > 0 ? addedKeys.slice(0, 5) : undefined,
 removedKeys: removedKeys.length > 0 ? removedKeys.slice(0, 3) : undefined,
 removedKeyCount: removedKeys.length,
 idUpgradedCount: idUpgradedCount > 0 ? idUpgradedCount : undefined,
 hasMissingIdBefore,
 hasMissingIdAfter,
 watchId: WATCH_APPROVED_ID,
 });
 prevApprovedIdsRef.current = nextIds;
 prevApprovedKeysRef.current = nextKeys;
}, [approvedBooks]);

// Track orphaned books: derive from approved list + known photos and schedule rehydrate when any exist.
// Uses photo IDs from photos state (not integrity_state which is disabled during log_only mode).
// IMPORTANT: only count books that have a real DB UUID as authoritative for orphan detection.
// Books without a DB id are local-only / not yet synced — their source_photo_id may reference a
// local placeholder photo that doesn't exist on the server yet. Treating them as "orphaned" causes
// spurious cleanup decisions based on incomplete data (the main cause of phantom photo pruning).
useEffect(() => {
  const photoIdSet = new Set((photos ?? []).map((p) => p.id).filter((x): x is string => Boolean(x)));
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hasAny = photoIdSet.size > 0 && (approvedBooks ?? []).some(
    // Only books with a real server UUID are authoritative for orphan detection.
    // Books with no id or a local composite id are not yet confirmed by the server
    // and must not drive photo cleanup decisions.
    (b) => b.id && UUID_RE.test(b.id) && b.source_photo_id && !photoIdSet.has(b.source_photo_id)
  );
  setHasOrphanedBooks(hasAny);
}, [approvedBooks, photos]);

// Backstop: if a job disappeared from server (no longer in serverActiveJobIds) and we have no pending queue items for the batch and results already arrived, mark it terminal locally so the bar can hide.
 useEffect(() => {
 if (!activeBatch?.batchId || !lastServerActiveJobIds) return;
 const serverSet = new Set(lastServerActiveJobIds);
 const batchJobIds = (activeBatch.jobIds ?? []).map(canonicalJobId).filter((id): id is string => id != null);
 const pendingByBatch: Record<string, number> = {};
 scanQueue.forEach((item) => {
 const bid = item.batchId ?? 'no-batch';
 if (item.status === 'queued' || item.status === 'pending' || item.status === 'processing') {
 pendingByBatch[bid] = (pendingByBatch[bid] ?? 0) + 1;
 }
 });
 const batchId = activeBatch.batchId;
 const pendingCount = pendingByBatch[batchId] ?? 0;
 const toMarkTerminal: string[] = [];
 for (const jobId of batchJobIds) {
 if (serverSet.has(jobId)) continue;
 const existing = activeBatch.resultsByJobId[jobId];
 if (existing?.status === 'completed' || existing?.status === 'failed' || existing?.status === 'canceled') continue;
 if (pendingCount !== 0) continue;
 const rawJobId = toRawScanJobUuid(jobId);
 const resultsArrived =
 (rawJobId != null && pendingBooks.some((b) => (b as any).source_scan_job_id === rawJobId)) ||
 (existing?.books?.length ?? 0) > 0;
 if (!resultsArrived) continue;
 toMarkTerminal.push(jobId);
 }
 if (toMarkTerminal.length === 0) return;
 const newResultsByJobId = { ...activeBatch.resultsByJobId };
 for (const jobId of toMarkTerminal) {
 newResultsByJobId[jobId] = { status: 'completed' as const, books: activeBatch.resultsByJobId[jobId]?.books };
 }
 setActiveBatch((prev) => (prev && prev.batchId === batchId ? { ...prev, resultsByJobId: { ...prev.resultsByJobId, ...newResultsByJobId } } : prev));
 setScanQueue((prev) =>
 prev.map((item) => (item.jobId && toMarkTerminal.includes(item.jobId) ? { ...item, status: 'completed' as const } : item))
 );
 persistBatch({ ...activeBatch, resultsByJobId: newResultsByJobId });
 }, [lastServerActiveJobIds, activeBatch, scanQueue, pendingBooks, persistBatch]);

 // Background scan jobs
 const [backgroundScanJobs, setBackgroundScanJobs] = useState<Map<string, { jobId: string, scanId: string, photoId: string }>>(new Map());
 
 /** Full list of recent scans in a modal (tapping "See all scans" opens it). */
 const [showAllScansModal, setShowAllScansModal] = useState(false);

 // Modal states
 const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
 const [showScanModal, setShowScanModal] = useState(false);
 /** When set, Scan Details modal reads books from GET /api/scan/[jobId] (scan_jobs.books), not from photo.books. */
 const [scanModalBooksFromJob, setScanModalBooksFromJob] = useState<Book[] | null>(null);
 const [scanModalBooksLoading, setScanModalBooksLoading] = useState(false);
 /** Book selected from scan detail grid for detail modal (tap = open detail, long press = remove). */
 /** Request token so a stale fetch cannot overwrite the list. Only the latest req may call setScanModalBooksFromJob. If you add job progress subscription, do NOT call setScanModalBooksFromJob from itonly update progress UI. */
 const latestPendingReqRef = React.useRef<string | null>(null);
 /** When user approves/rejects books, we treat local as authoritative until sync confirms. Avoids nuking fresh local changes on focus. */
 const lastLocalMutationAtRef = React.useRef<number>(0);
 /** Guard: prevent duplicate loadUserData from effect + focus firing close together. */
 const loadUserDataInProgressRef = React.useRef<boolean>(false);
 /** When a load is requested while one is in-flight, run one more load when current finishes (dedupe = reuse in-flight). */
 const loadUserDataAgainAfterRef = React.useRef<boolean>(false);
 const lastLoadUserDataAtRef = React.useRef<number>(0);
 /** Circuit-breaker: backend unhealthy after N consecutive Supabase load failures. When false, watchdog does not trigger full refresh and focus skips loadUserData. */
 const supabaseHealthyRef = React.useRef<boolean>(true);
 const lastSupabaseFailureAtRef = React.useRef<number>(0);
 const consecutiveSupabaseFailuresRef = React.useRef<number>(0);
 const SUPABASE_FAILURES_THRESHOLD = 2;
 /** Watchdog only refreshes scan-job list (never profile/books/photos). Throttle so we don't refresh more than every WATCHDOG_THROTTLE_MS. */
 const lastWatchdogRefreshAtRef = React.useRef<number>(0);
 const WATCHDOG_THROTTLE_MS = 5000;
 const WATCHDOG_UNHEALTHY_POLL_MS = 20000;
 /** After this many ms since last Supabase failure, allow full load again (retry). */
 const SUPABASE_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
 /**
  * Timestamp of the last successfully committed snapshot (rehydrate_merge or post-approve).
  * Updated at the same points as appliedSnapshotSeqRef. Used by focus-refresh to skip a
  * redundant fetch when a snapshot just ran (e.g. approve fired 2 s ago → focus fires → skip).
  */
 const lastSnapshotCommittedAtRef = React.useRef<number>(0);
 /**
  * Focus-refresh is suppressed for this many ms after any committed snapshot.
  * 5 s gives post-approve full-refresh time to land before focus can trigger another fetch.
  */
 const FOCUS_REFRESH_DEBOUNCE_MS = 5_000;
 /** Fix #3: Monotonic token so only the latest refresh applies (older request can't overwrite). */
 const pendingLoadRequestIdRef = React.useRef<number>(0);
/** Idempotency: prevent duplicate approve (double-tap or concurrent saveUserData). */
const isApprovingRef = React.useRef<boolean>(false);
/** Disable approve buttons and throttle taps while approve is in flight. */
const [isApproving, setIsApproving] = useState(false);
/** Incremented each time approve completes so a useEffect can log ground-truth state. */
const [approveCompletedCount, setApproveCompletedCount] = React.useState(0);
/**
 * False between approve-complete and the post-approve full-refresh snapshot.
 * During this window many approved books have no DB UUID yet (approvedBooksWithoutId > 0).
 * Actions that need a reliable DB id (Edit Cover / Switch Book → saveBookToSupabase)
 * should be gated on this flag.  Resets to true once the snapshot merges in.
 *
 * Starts as true (no pending refresh on mount).
 */
const [postApproveIdsSettled, setPostApproveIdsSettled] = useState(true);

// ── Draft photo repair ────────────────────────────────────────────────────────
// Photos stuck in status='draft' may not display until storage propagates.
// Strategy: if storage_path set → promote to 'complete'. If not → 30s watchdog.
// On expiry: mark 'stalled' (not errored) and retry: re-check DB row, re-request signed URL.
// Only mark 'errored' after retries exhaust (no storage_path after 3 retries).
const draftRepairTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
const stalledRetryCountRef = useRef<Map<string, number>>(new Map());
/** Clear draft watchdog for a photo when save succeeds (upsert_success / hash_reuse_early) so the 30s timer never fires. */
const clearDraftWatchdogForPhoto = useCallback((photoId: string | undefined, canonicalPhotoId?: string | null) => {
  if (photoId) {
    const t = draftRepairTimersRef.current.get(photoId);
    if (t != null) { clearTimeout(t); draftRepairTimersRef.current.delete(photoId); }
  }
  if (canonicalPhotoId && canonicalPhotoId !== photoId) {
    const t = draftRepairTimersRef.current.get(canonicalPhotoId);
    if (t != null) { clearTimeout(t); draftRepairTimersRef.current.delete(canonicalPhotoId); }
  }
}, []);

/** Retry stalled draft: re-check DB row by ID, re-request signed URL. Promote to complete if storage_path present; else retry again or mark errored after max retries. */
const retryDraftPhotoStalled = useCallback(async (photoId: string) => {
  const userId = userRef.current?.uid;
  if (!userId || !supabase) return;
  try {
    const { data: row, error } = await supabase
      .from('photos')
      .select('id, status, storage_path, storage_url')
      .eq('id', photoId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      logger.warn('[PHOTO_DRAFT_REPAIR]', 'retry fetch failed', { photoId: photoId.slice(0, 8), error: error.message });
      return;
    }
    const storagePath = row?.storage_path && typeof row.storage_path === 'string' ? row.storage_path.trim() : undefined;
    if (storagePath) {
      const signed = await getSignedPhotoUrl(storagePath);
      setPhotos(prev => prev.map(p => p.id === photoId ? { ...p, status: 'complete', storage_path: storagePath, uri: signed } as Photo : p));
      stalledRetryCountRef.current.delete(photoId);
      clearDraftWatchdogForPhoto(photoId, photoId);
      logger.info('[PHOTO_DRAFT_REPAIR]', 'retry promoted stalled→complete', { photoId: photoId.slice(0, 8) });
      return;
    }
    const count = (stalledRetryCountRef.current.get(photoId) ?? 0) + 1;
    stalledRetryCountRef.current.set(photoId, count);
    const STALLED_MAX_RETRIES = 3;
    if (count >= STALLED_MAX_RETRIES) {
      setPhotos(prev => prev.map(p => p.id === photoId ? { ...p, status: 'errored' } as Photo : p));
      stalledRetryCountRef.current.delete(photoId);
      logger.warn('[PHOTO_DRAFT_REPAIR]', 'retries exhausted — marking as errored', { photoId: photoId.slice(0, 8), retries: count });
      return;
    }
    logger.debug('[PHOTO_DRAFT_REPAIR]', 'retry no storage yet — will retry again', { photoId: photoId.slice(0, 8), attempt: count });
    setTimeout(() => retryDraftPhotoStalled(photoId), 15_000);
  } catch (e) {
    logger.warn('[PHOTO_DRAFT_REPAIR]', 'retry threw', { photoId: photoId.slice(0, 8), err: String(e) });
  }
}, [clearDraftWatchdogForPhoto]); // eslint-disable-line react-hooks/exhaustive-deps

useEffect(() => {
  const DRAFT_WATCHDOG_MS = 30_000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const draftPhotos = photos.filter(
    p => ((p as any).status === 'draft' || (p as any).status === 'local_pending' || (p as any).status === 'uploading') && p.id && UUID_RE.test(p.id ?? '')
  );
  if (draftPhotos.length === 0) return;

  const repairs: Photo[] = [];
  for (const photo of draftPhotos) {
    const hasStoragePath = !!((photo as any).storage_path as string | undefined)?.trim?.().length;

    if (hasStoragePath) {
      // Upload is done — status just wasn't updated. Promote now.
      repairs.push({ ...photo, status: 'complete' } as Photo);
      logger.info('[PHOTO_DRAFT_REPAIR]', 'promoted draft→complete (storage_path present)', {
        photoId: photo.id?.slice(0, 8),
        storagePath: ((photo as any).storage_path as string).slice(0, 40),
      });
      // Cancel any pending watchdog for this photo.
      const t = draftRepairTimersRef.current.get(photo.id!);
      if (t != null) { clearTimeout(t); draftRepairTimersRef.current.delete(photo.id!); }
      continue;
    }

    // No storage_path yet — upload still in flight (or lost). Start watchdog if not already running.
    if (!draftRepairTimersRef.current.has(photo.id!)) {
      const photoId = photo.id!;
      logger.debug('[PHOTO_DRAFT_WATCHDOG]', 'starting 30s watchdog for in-flight draft', { photoId: photoId.slice(0, 8) });
      const timer = setTimeout(() => {
        draftRepairTimersRef.current.delete(photoId);
        setPhotos(prev => {
          const stillDraft = prev.find(
            p => p.id === photoId && ((p as any).status === 'draft' || (p as any).status === 'local_pending' || (p as any).status === 'uploading') && !((p as any).storage_path as string | undefined)?.trim?.().length
          );
          if (!stillDraft) return prev;
          logger.debug('[PHOTO_DRAFT_REPAIR]', 'watchdog expired — marking stalled and retrying', { photoId: photoId.slice(0, 8) });
          return prev.map(p =>
            p.id === photoId ? { ...p, status: 'stalled' } as Photo : p
          );
        });
        retryDraftPhotoStalled(photoId);
      }, DRAFT_WATCHDOG_MS);
      draftRepairTimersRef.current.set(photoId, timer);
    }
  }

  if (repairs.length > 0) {
    setPhotos(prev => prev.map(p => {
      const fix = repairs.find(r => r.id === p.id);
      return fix ?? p;
    }));
  }
}, [photos, retryDraftPhotoStalled]); // eslint-disable-line react-hooks/exhaustive-deps
// Post-approve ground-truth log: fires AFTER React state settles (setApprovedBooks + setPhotos
// functional updaters have committed). Captures the REAL rendered counts, not the stale closure
// values inside the approve callback. This is the authoritative "what is the UI showing" log.
// eslint-disable-next-line react-hooks/exhaustive-deps
useEffect(() => {
  if (approveCompletedCount === 0) return; // skip on mount
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const withDbId = approvedBooks.filter(b => b.id && UUID_RE.test(b.id));
  const booksById: Record<string, boolean> = {};
  withDbId.forEach(b => { if (b.id) booksById[b.id] = true; });
  const draftPhotos = photos.filter(p => (p as any).status === 'draft');
  const completePhotos = photos.filter(p => (p as any).status === 'complete');
  logger.info('[APPROVE_STATE_AFTER_SETTLE]', {
    approveCompletedCount,
    approvedBooksRendered: approvedBooks.length,
    approvedBooksWithDbId: withDbId.length,
    approvedBooksWithoutId: approvedBooks.length - withDbId.length,
    booksByIdMapSize: Object.keys(booksById).length,
    photosTotal: photos.length,
    photosComplete: completePhotos.length,
    photosDraft: draftPhotos.length,
    draftPhotoIds: draftPhotos.slice(0, 5).map(p => p.id?.slice(0, 8) ?? '?'),
    note: 'ground-truth after React state settle — compare to APPROVE_FULL_REFRESH merged.length inside updater',
  });
}, [approveCompletedCount]); // intentionally omits approvedBooks/photos — reads post-settle values
/**
 * Non-null when the last approve attempt failed. Displayed as an inline banner
 * above the selection bar instead of a blocking Alert. Cleared on the next
 * successful approve or when the user dismisses it.
 * Storing the error here (instead of inside saveUserData's catch) keeps it
 * in component state so the banner re-renders correctly and the pending list
 * is provably unchanged when the user sees it.
 */
const [approveError, setApproveError] = useState<string | null>(null);
/** True while optimistic approve is running in background (flush + saveUserData). Used for inline "Adding…" and to guard double-tap. */
const [approveInProgress, setApproveInProgress] = useState(false);
/**
 * Reserved for DATA_SAFETY_DROP guard. Kept for setDataSafetySyncIssue(null) on clear/sign-out.
 * Guard is log-only: we never set a message here; no sync banner is shown to users.
 */
const [dataSafetySyncIssue, setDataSafetySyncIssue] = useState<string | null>(null);
/**
 * When non-null, shows an "Undo" toast at the bottom of the screen.
 * Set immediately after any soft-delete so the user can reverse within the undo window.
 * Cleared after UNDO_WINDOW_MS elapses or when the user taps Undo / Dismiss.
 */
const [undoToast, setUndoToast] = useState<{
  label: string;
  action: LastDestructiveAction;
  expiresAt: number;
} | null>(null);
const undoToastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

/** Show the undo toast for UNDO_TOAST_MS, then auto-dismiss. The server-side window is UNDO_WINDOW_MS. */
const UNDO_TOAST_MS = 8_000; // show toast for 8 s; server-side undo window is 10 min
const showUndoToast = useCallback((label: string, action: LastDestructiveAction) => {
  if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
  const expiresAt = Date.now() + UNDO_WINDOW_MS;
  setUndoToast({ label, action, expiresAt });
  undoToastTimerRef.current = setTimeout(() => setUndoToast(null), UNDO_TOAST_MS);
}, []);

/**
 * True when at least one approved book references a source_photo_id not present in photos state.
 * Triggers a "Syncing photos…" banner. Cleared when photos are re-loaded and IDs resolve.
 * Note: integrity_state is currently disabled (log_only mode) — this derives from live photo state.
 */
const [hasOrphanedBooks, setHasOrphanedBooks] = useState(false);
 /** Scan job IDs we've already closed this session; skip approve if same job already closed (double-approve guard). */
 const closedScanJobIdsRef = React.useRef<Set<string>>(new Set());
 const LOAD_USER_DATA_DEBOUNCE_MS = 2000;

 // Edit incomplete book states
 const [editingBook, setEditingBook] = useState<Book | null>(null);
 const [showEditModal, setShowEditModal] = useState(false);
 const [searchQuery, setSearchQuery] = useState('');
 const [searchResults, setSearchResults] = useState<any[]>([]);
 const [isSearching, setIsSearching] = useState(false);
 const [manualTitle, setManualTitle] = useState('');
 const [manualAuthor, setManualAuthor] = useState('');

 // Edit mode states for pending books
 const [showEditCoverModal, setShowEditCoverModal] = useState(false);
 const [showSwitchCoversModal, setShowSwitchCoversModal] = useState(false);
 const [showSwitchBookModal, setShowSwitchBookModal] = useState(false);
 const [coverSearchResults, setCoverSearchResults] = useState<Array<{googleBooksId: string, coverUrl?: string}>>([]);
 const [isLoadingCovers, setIsLoadingCovers] = useState(false);
 const [bookSearchResults, setBookSearchResults] = useState<Array<{googleBooksId: string, title: string, author?: string, coverUrl?: string}>>([]);
 const [isSearchingBooks, setIsSearchingBooks] = useState(false);
 const [bookSearchQuery, setBookSearchQuery] = useState('');

 // Show caption modal when image is ready from camera.
 // Scan is NOT started here it starts only after the user taps Continue or Skip on the caption screen.
 // This mirrors the library picker flow exactly (pickImage openAddCaptionScreen startUploadAfterCaption).
 const handleImageSelected = async (uri: string) => {

 // Check if user can scan
 // If user is null, treat as guest (shouldn't happen, but safety check)
 if (!user || isGuestUser(user)) {
 const guestScanKey = 'guest_scan_used';
 const hasUsedScan = await AsyncStorage.getItem(guestScanKey);
 if (hasUsedScan === 'true') {
 Alert.alert(
 'Sign In Required',
 'You\'ve used your free scan. Sign in to continue scanning and save your books to your profile!',
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Sign In',
 onPress: () => {
 navigation.navigate('MyLibrary' as never);
 }
 }
 ]
 );
 return;
 }
 }

 const scanId = uuidv4();
 const item = { uri, scanId };

 scanCaptionsRef.current.set(scanId, '');
 currentScanIdRef.current = scanId;

 // Stage the image for the caption screen (same as library picker path).
 // enqueueBatch runs only after the user confirms/skips caption.
 // IMPORTANT: Append to existing batch ref instead of overwriting, so Photo 1
 // isn't lost if Photo 2 is taken while Photo 1's caption screen is still open.
 const existing = pendingUploadBatchRef.current;
 if (existing && existing.length > 0 && !existing.some(e => e.scanId === scanId)) {
   pendingUploadBatchRef.current = [...existing, item];
 } else {
   pendingUploadBatchRef.current = [item];
 }
 setPendingImages(pendingUploadBatchRef.current);
 setCurrentImageIndex(pendingUploadBatchRef.current.length - 1);
 setPendingImageUri(uri);
 setCaptionText('');

 if (__DEV__) logger.debug('[SCAN] camera caption gate scanId=' + scanId.slice(0, 8));

 openAddCaptionScreen(pendingUploadBatchRef.current);
 };

 useEffect(() => {
 const titleQ = manualTitle.trim();
 const authorQ = manualAuthor.trim();
 const q = [titleQ, authorQ].filter(Boolean).join(' ');
 if (!showEditModal) return; // Only when modal open
 if (q.length < 2) {
 setSearchResults([]);
 return;
 }
 const handle = setTimeout(async () => {
 try {
 setIsSearching(true);
 // Use proxy API route to get API key and rate limiting
 // Canonical URL: always use www.bookshelfscan.app
 const baseUrl = getApiBaseUrl();
 const response = await fetch(
 `${baseUrl}/api/google-books?path=/volumes&q=${encodeURIComponent(q)}&maxResults=10`
 );
 const data = await response.json();
 setSearchResults(data.items || []);
 } catch (err) {
 setSearchResults([]);
 } finally {
 setIsSearching(false);
 }
 }, 350);
 return () => clearTimeout(handle);
 }, [manualTitle, manualAuthor, showEditModal]);
 
 // Stable per-book identity key for selection and FlatList keys.
 // book.id is undefined for fresh-scan books (DB hasn't returned yet), so we must not use it
 // as the sole key every id-less book would share '' or undefined and all appear selected at once.
 // Priority: DB uuid dbId book_key (stable computed key) title|author|jobId fallback.
 const pendingBookStableKey = useCallback((b: Book): string => {
 if (b.id) return b.id;
 if ((b as any).dbId) return (b as any).dbId;
 const bk = (b as any).book_key ?? getStableBookKey(b);
 if (bk) return bk;
 return `${b.title ?? ''}|${b.author ?? ''}|${(b as any).source_scan_job_id ?? ''}`;
 }, []);

 // Scoped key for pending tombstones only: baseKey|scan_job_id|photo_id so we only hide "this book from this scan", not same book from another scan.
 const getPendingStableKeyScoped = useCallback((b: Book): string => {
 const base = b.id ?? (b as any).dbId ?? (b as any).book_key ?? getStableBookKey(b) ?? `${b.title ?? ''}|${b.author ?? ''}`;
 const job = (b as any).source_scan_job_id ?? '';
 const photo = (b as any).source_photo_id ?? '';
 return `${base}|${job}|${photo}`;
 }, []);

 // Selection states: O(1) "Select All" — avoid building huge selectedIds array on tap.
 // When selectAllMode is true, "all completable are selected" except excludedIds.
 const [selectAllMode, setSelectAllMode] = useState(false);
 const [excludedIds, setExcludedIds] = useState<Set<string>>(() => new Set());
 const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
 // Completable pending keys (for select-all and selectedCount); memoized so we don't recompute every render.
 const completableKeys = useMemo(
   () => pendingBooks.filter(book => book.status !== 'incomplete').map(pendingBookStableKey),
   [pendingBooks, pendingBookStableKey]
 );
 // O(1) selectedCount: avoid building a full array on every render when 100+ items selected.
 const selectedCount = selectAllMode ? (completableKeys.length - excludedIds.size) : selectedBooks.size;
 const selectionMode: 'none' | 'single' | 'multi' = selectedCount === 0 ? 'none' : selectedCount === 1 ? 'single' : 'multi';
 // O(1) single-selected id: only resolve when selectedCount === 1 (no full-array build).
 const selectedId = useMemo(() => {
   if (selectedCount !== 1) return null;
   if (selectAllMode) return completableKeys.find(k => !excludedIds.has(k)) ?? null;
   const arr = [...selectedBooks];
   return arr.length === 1 ? arr[0] : null;
 }, [selectedCount, selectAllMode, completableKeys, excludedIds, selectedBooks]);
/** O(1) check: is this book key selected? Use this instead of selectedBooks.has() so select-all is correct. */
const isBookSelected = useCallback(
  (key: string) => selectAllMode ? !excludedIds.has(key) : selectedBooks.has(key),
  [selectAllMode, excludedIds, selectedBooks]
);
// Stable refs for render callbacks — prevents FlatList from re-rendering all rows
// every time selection state changes. The ref always points to the latest callback.
const isBookSelectedRef = useRef(isBookSelected);
isBookSelectedRef.current = isBookSelected;
/** Clear all selection state (use after approve, reject, clear, add to queue, etc.). */
const clearSelection = useCallback(() => {
  setSelectAllMode(false);
  setExcludedIds(new Set());
  setSelectedBooks(new Set());
}, []);

/**
 * The single-selected pending book (looked up by stable key via pendingBookStableKey,
 * the same function used when building selectedBooks). Null when nothing selected or
 * when single-selected book can't be found (should never happen, but guarded).
 */
const selectedPendingBook = useMemo(() => {
  if (selectedId == null) return null;
  return pendingBooks.find(b => pendingBookStableKey(b) === selectedId) ?? null;
}, [selectedId, pendingBooks, pendingBookStableKey]);

/**
 * True when the single-selected pending book is ready for cover/book edits.
 * Requires:
 *   1. source_photo_id is present so saveBookToSupabase won't hit the provenance guard.
 *   2. postApproveIdsSettled is true — i.e. the post-approve full-refresh has
 *      completed and all approved books now carry real DB UUIDs. During the
 *      settle window (typically ~1 s after approve) this is false so we don't
 *      silently fire save calls that will fail or corrupt provenance.
 *
 * Does NOT require a DB UUID for the *pending* book itself — cover edits work on
 * pending books before approve. The save uses upsert-by-book_key when id is absent.
 */
const selectedBookEditReady = useMemo(() => {
  if (!selectedPendingBook) return false;
  if (!postApproveIdsSettled) return false;
  return !!(selectedPendingBook as any).source_photo_id;
}, [selectedPendingBook, postApproveIdsSettled]);

/** Only relevant in single mode; reset when mode or selectedId changes to avoid half-expanded UI. */
const [editExpanded, setEditExpanded] = useState(false);

 // Auto-correct expanded state when selection changes (01, 12, 21)
 useEffect(() => {
 if (selectionMode !== 'single') setEditExpanded(false);
 }, [selectionMode]);
 useEffect(() => {
 setEditExpanded(false);
 }, [selectedId]);

 // Caption modal state
 const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
 const [captionText, setCaptionText] = useState<string>('');
 // Store multiple pending images for Add Caption screen
 const [pendingImages, setPendingImages] = useState<Array<{uri: string, scanId: string}>>([]);
 const [currentImageIndex, setCurrentImageIndex] = useState<number>(0);
 // Store the scanId for the current pending image so we can update its caption later
 const currentScanIdRef = React.useRef<string | null>(null);
 // Store caption for each scan (keyed by scanId)
 const scanCaptionsRef = React.useRef<Map<string, string>>(new Map());
 // Map scanId -> photoId when photo is created, so we can persist caption to photo if user submits after PHOTO_CREATE
 const scanIdToPhotoIdRef = React.useRef<Map<string, string>>(new Map());
 /** When user picks Upload, we go to Caption first; upload/enqueue runs only when Caption calls Continue/Skip. */
 const pendingUploadBatchRef = React.useRef<Array<{ uri: string; scanId: string }> | null>(null);

 // Folder management state
 const [folders, setFolders] = useState<Folder[]>([]);
 
 // Guest scan status
 const [guestHasUsedScan, setGuestHasUsedScan] = useState<boolean>(false);
 const [showFolderModal, setShowFolderModal] = useState(false);
 const [newFolderName, setNewFolderName] = useState('');
 const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

 // Subscription and scan limit state
 const [showUpgradeModal, setShowUpgradeModal] = useState(false);
 const [showAuthGateModal, setShowAuthGateModal] = useState(false);
 const [guestPendingToImport, setGuestPendingToImport] = useState<Book[] | null>(null);
 const [importingGuestPending, setImportingGuestPending] = useState(false);
 const [scanUsage, setScanUsage] = useState<ScanUsage | null>(null);
 const [canScan, setCanScan] = useState<boolean>(true); // Track if user can scan

 // Orientation state for camera tip
 const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
 
 // Scroll tracking for sticky toolbar
 const scrollY = React.useRef(new Animated.Value(0)).current;

 // Create a memoized photo map for fast lookups
 const photoMap = useMemo(() => {
 const map = new Map<string, Photo>();
 photos.forEach(photo => {
 if (photo.id) {
 map.set(photo.id, photo);
 }
 });
 return map;
 }, [photos]);

 /** Scan group: books from one scan, with metadata for GroupHeader (createdAt, thumb, photo for open modal). */
 type PendingScanGroup = {
  scanJobId: string;
  photoId: string;
  books: Book[];
  isGuest?: boolean;
  createdAt: number;
  thumbUri?: string;
  thumbnailUri?: string | null;
  storagePath?: string;
  photo?: Photo | null;
  };

// Pending screen source of truth: pendingBooks (derived from all books by status). Group by photoId/jobId only for display.
// Do NOT require photos: grouping is by book.source_photo_id / source_scan_job_id; photos used only for thumbnail (optional). Never drop groups based on "approved match".
 const groupedPendingBooks = useMemo(() => {
 const extractLastName = (author?: string): string => {
 if (!author) return '';
 const firstAuthor = author.split(/,|&| and /i)[0].trim();
 const parts = firstAuthor.split(/\s+/).filter(Boolean);
 if (parts.length === 0) return '';
 return parts[parts.length - 1].replace(/,/, '').toLowerCase();
 };

 // Build photo lookup for thumbnail enrichment only. Full UUID keys (canon) so join never misses.
 const photosById = new Map<string, Photo>();
 photos.forEach(photo => { const k = canon(photo.id); if (k) photosById.set(k, photo); });

 // Map preserves insertion order — books are pushed to pendingBooks in scan order,
 // so the first group in the Map is the first scan, the last is the most recent.
 const groupedByScan = new Map<string, Book[]>();
 pendingBooks.forEach(book => {
 // Only show books with status 'pending'. Incomplete books (no author, no title, low confidence)
 // are filtered out so they don't clutter the pending list as noise.
 if (book.status !== 'pending') return;
 const isGuest = (book as Book & { isGuest?: boolean }).isGuest === true;
 // Group key priority: source_scan_job_id → source_photo_id → book_key (last-resort).
 // source_scan_job_id and source_photo_id come from the book's own fields, not from
 // cross-referencing photos[], so grouping works even when photos[] is empty.
 const bookKey = (book as any).book_key ?? getStableBookKey(book);
 const groupKey = isGuest
   ? 'guest_scan'
   : ((book as Book & { source_scan_job_id?: string }).source_scan_job_id
       ?? (book as Book & { source_photo_id?: string }).source_photo_id
       ?? bookKey
       ?? 'unknown');
 if (!groupedByScan.has(groupKey)) groupedByScan.set(groupKey, []);
 groupedByScan.get(groupKey)!.push(book);
 });

 const groups: PendingScanGroup[] = [];
 groupedByScan.forEach((books, scanJobId) => {
 const sorted = [...books].sort((a, b) => {
 const aLast = extractLastName(a.author);
 const bLast = extractLastName(b.author);
 if (aLast && bLast) {
 if (aLast < bLast) return -1;
 if (aLast > bLast) return 1;
 } else if (aLast || bLast) return aLast ? -1 : 1;
 const aTitle = (a.title || '').toLowerCase();
 const bTitle = (b.title || '').toLowerCase();
 if (aTitle < bTitle) return -1;
 if (aTitle > bTitle) return 1;
 return 0;
 });
 const first = sorted[0];
 const isGuestGroup = scanJobId === 'guest_scan';
 // Derive photoId from the books' own source_photo_id — no cross-reference needed.
 const photoId = isGuestGroup
   ? 'guest_scan'
   : ((first as Book & { source_photo_id?: string }).source_photo_id ?? scanJobId);
 // Thumbnail enrichment: look up photo from state for thumb display only.
 // Absence of a photo here is non-blocking — group header renders a placeholder.
 const photo = (photoId && photoId !== 'guest_scan') ? (photosById.get(canon(photoId)) ?? null) : null;
 const thumbUri = photo?.uri ?? undefined;
 const thumbnailUri = photo?.thumbnail_uri ?? photo?.uri ?? null;
 const storagePath = photo?.storage_path ?? undefined;
 const createdAt = photo?.timestamp ?? (first?.scannedAt ?? 0);
 groups.push({
 scanJobId,
 photoId,
 books: sorted,
 isGuest: isGuestGroup,
 createdAt,
 thumbUri,
 thumbnailUri,
 storagePath,
 photo,
 });
 });

 // Fallback: if we have pending books but no groups (e.g. grouping key missing), show one group so list is never empty.
 const pendingOnly = pendingBooks.filter((b) => b.status === 'pending' || b.status === 'incomplete');
 if (groups.length === 0 && pendingOnly.length > 0) {
   groups.push({
     scanJobId: 'unknown',
     photoId: 'unknown',
     books: [...pendingOnly].sort((a, b) => ((a.title ?? '').localeCompare(b.title ?? '')) || ((a.author ?? '').localeCompare(b.author ?? ''))),
     isGuest: false,
     createdAt: 0,
     thumbUri: undefined,
     thumbnailUri: null,
     storagePath: undefined,
     photo: null,
   });
 }
 // Do NOT sort by createdAt here — Map insertion order already reflects scan arrival order.
 return groups;
 }, [pendingBooks, photos]);

// Sanity check: if pending=41 but render count is 0, it's 100% UI filtering/selector logic.
useEffect(() => {
  if (!DEBUG_PENDING) return;
  const booksRendered = groupedPendingBooks.flatMap((g) => g.books).length;
  logger.debug('[PENDING_DEBUG_RENDER]', {
    pendingInState: pendingBooks.length,
    groupsRendered: groupedPendingBooks.length,
    booksRendered,
  });
}, [pendingBooks.length, groupedPendingBooks]);

// Instant confirmation: Pending screen is driven by all books by status; pending: 42 when server has 42 pending.
useEffect(() => {
  logger.info('[PENDING_COUNTS]', {
    all: books.length,
    pending: pendingBooks.length,
    approved: approvedBooks.length,
    rejected: rejectedBooks.length,
  });
}, [books.length, pendingBooks.length, approvedBooks.length, rejectedBooks.length]);

 /** Flat list of all pending books for the 4-column grid (no carousel, no "See all"). */
 const allPendingBooks = useMemo(
 () => groupedPendingBooks.flatMap((g) => g.books),
 [groupedPendingBooks]
 );

 /** Count of pending books whose source_photo_id is not in photos (join mismatch). Show warning so we don't hide them. */
 const pendingUnattachedToPhotoCount = useMemo(() => {
   if (pendingBooks.length === 0 || photos.length === 0) return 0;
   const photoIdSet = new Set(photos.map((p) => p.id).filter((id): id is string => Boolean(id)));
   return pendingBooks.filter(
     (b) => ((b as any).status === 'pending' || (b as any).status === 'incomplete') && ((b as any).source_photo_id && !photoIdSet.has((b as any).source_photo_id))
   ).length;
 }, [pendingBooks, photos]);

 /** Flat list of rows for virtualized Pending: group_header rows and book_row rows (chunked by pendingGridColumns). */
 type PendingListRow =
 | { type: 'group_header'; group: PendingScanGroup; groupIndex: number }
 | { type: 'book_row'; books: Book[]; group: PendingScanGroup; groupIndex: number; rowIndex: number };
 const pendingListRows = useMemo((): PendingListRow[] => {
 const rows: PendingListRow[] = [];
 groupedPendingBooks.forEach((group, groupIndex) => {
 rows.push({ type: 'group_header', group, groupIndex });
 for (let i = 0; i < group.books.length; i += pendingGridColumns) {
 const chunk = group.books.slice(i, i + pendingGridColumns);
 rows.push({ type: 'book_row', books: chunk, group, groupIndex, rowIndex: Math.floor(i / pendingGridColumns) });
 }
 });
 return rows;
 }, [groupedPendingBooks, pendingGridColumns]);

 // Detect orientation changes when camera is active
 useEffect(() => {
 if (!isCameraActive) return;

 const updateOrientation = () => {
 const { width, height } = Dimensions.get('window');
 const isLandscape = width > height;
 setOrientation(isLandscape ? 'landscape' : 'portrait');
 };

 // Set initial orientation
 updateOrientation();

 // Listen for dimension changes
 const subscription = Dimensions.addEventListener('change', updateOrientation);

 return () => {
 if (subscription && typeof subscription.remove === 'function') {
 subscription.remove();
 }
 };
 }, [isCameraActive]);

 // Load data only after auth is ready. Only clear when userId actually changes (prev !== next).
 // Do NOT clear when session temporarily nulls during token refresh or on tab focus.
 useEffect(() => {
   if (!authReady) return;
   const userId = user?.uid ?? null;
   latestUserIdRef.current = userId;

   const clearSignOutDebounce = () => {
     if (signOutDebounceRef.current) {
       clearTimeout(signOutDebounceRef.current);
       signOutDebounceRef.current = null;
     }
   };

   // First boot: just record, do not clear
   if (previousUserIdRef.current === null) {
     previousUserIdRef.current = userId;
     if (userId) {
       loadUserData().catch(error => {
         logger.error(' Error loading user data:', error);
         loadUserDataFromStorage().catch(e => {
           logger.error(' Error loading from AsyncStorage fallback:', e);
         });
       });
       loadScanUsage().catch(error => {
         logger.error(' Error loading scan usage:', error);
         setCanScan(true);
       });
     }
     return clearSignOutDebounce;
   }

   const prev = previousUserIdRef.current;
   const changed = prev !== userId;

   if (!changed) {
     // Same user (or still null). Do not clear — avoids wiping state on token refresh / tab focus.
     return clearSignOutDebounce;
   }

   // User actually changed: clear only when prevUserId !== nextUserId
   if (userId === null) {
     // Possible sign-out. Debounce so token refresh (brief null) doesn't clear.
     if (signOutDebounceRef.current) clearTimeout(signOutDebounceRef.current);
     signOutDebounceRef.current = setTimeout(() => {
       signOutDebounceRef.current = null;
       if (latestUserIdRef.current !== null) return; // user came back, do not clear
       hasServerHydratedRef.current = false;
       prevApprovedIdsRef.current = null;
       prevApprovedKeysRef.current = null;
       lastApprovedUpdateSourceRef.current = 'sign_out';
       snapshotSeqRef.current = 0;
       appliedSnapshotSeqRef.current = 0;
       postApproveLockUntilRef.current = 0;
       highWaterApprovedCountRef.current = 0;
       highWaterPhotosCountRef.current = 0;
       lastDestructiveActionRef.current = null;
       lastSnapshotCommittedAtRef.current = 0;
       setDataSafetySyncIssue(null);
       if (previousUserIdRef.current) {
         clearHighWaterMark(previousUserIdRef.current).catch(() => {});
         clearLastDestructiveAction(previousUserIdRef.current).catch(() => {});
       }
       logCleanupAction({
         reason: 'sign_out',
         clearedScanQueue: true,
         clearedScanProgress: true,
         clearedActiveBatch: true,
         clearedStorageKeys: [],
       });
       if (libraryAbortControllerRef.current) {
         libraryAbortControllerRef.current.abort();
         libraryAbortControllerRef.current = null;
       }
       abortInFlightRequests();
       clearActiveBatch(undefined, 'cleanup');
       setScanProgress(null);
       logLibraryStateWrite('auth_effect_signout', { approved: 0, photos: 0, pending: 0 });
       setBooksFromBuckets([], [], []);
       setPhotos([]);
       setScanQueue([]);
       setScanUsage(null);
       setCanScan(true);
       previousUserIdRef.current = null;
       clearCanonicalPhotoMap();
     }, SIGN_OUT_DEBOUNCE_MS);
     return clearSignOutDebounce;
   }

   // Switch to another user (or null -> user): clear immediately, then load
   if (signOutDebounceRef.current) {
     clearTimeout(signOutDebounceRef.current);
     signOutDebounceRef.current = null;
   }
   hasServerHydratedRef.current = false;
   prevApprovedIdsRef.current = null;
   prevApprovedKeysRef.current = null;
   lastApprovedUpdateSourceRef.current = 'user_switch';
   snapshotSeqRef.current = 0;
   appliedSnapshotSeqRef.current = 0;
   postApproveLockUntilRef.current = 0;
   highWaterApprovedCountRef.current = 0;
   highWaterPhotosCountRef.current = 0;
   lastDestructiveActionRef.current = null;
   lastSnapshotCommittedAtRef.current = 0;
   setDataSafetySyncIssue(null);
   if (previousUserIdRef.current) {
     clearHighWaterMark(previousUserIdRef.current).catch(() => {});
     clearLastDestructiveAction(previousUserIdRef.current).catch(() => {});
   }
   logCleanupAction({
     reason: 'user_switch',
     clearedScanQueue: true,
     clearedScanProgress: true,
     clearedActiveBatch: true,
     clearedStorageKeys: [],
   });
   if (libraryAbortControllerRef.current) {
     libraryAbortControllerRef.current.abort();
     libraryAbortControllerRef.current = null;
   }
   abortInFlightRequests();
   clearActiveBatch(undefined, 'cleanup');
   setScanProgress(null);
   logLibraryStateWrite('auth_effect_user_switch', { approved: 0, photos: 0, pending: 0 });
   setBooksFromBuckets([], [], []);
   setPhotos([]);
   setScanQueue([]);
   previousUserIdRef.current = userId;
   loadUserData().catch(error => {
     logger.error(' Error loading user data:', error);
     loadUserDataFromStorage().catch(e => {
       logger.error(' Error loading from AsyncStorage fallback:', e);
     });
   });
   loadScanUsage().catch(error => {
     logger.error(' Error loading scan usage:', error);
     setCanScan(true);
   });

   return clearSignOutDebounce;
 }, [user?.uid, authReady, abortInFlightRequests, clearActiveBatch]);

 // Fallback function to load from AsyncStorage if Supabase fails
 const loadUserDataFromStorage = async () => {
 if (!user) return;
 
 try {
 logger.debug(' Loading user data from AsyncStorage fallback...');
 const userPendingKey = `pending_books_${user.uid}`;
 const userApprovedKey = `approved_books_${user.uid}`;
 const userRejectedKey = `rejected_books_${user.uid}`;
 const userPhotosKey = `photos_${user.uid}`;
 
 const [savedPending, savedApproved, savedRejected, savedPhotos] = await Promise.all([
 AsyncStorage.getItem(userPendingKey),
 AsyncStorage.getItem(userApprovedKey),
 AsyncStorage.getItem(userRejectedKey),
 AsyncStorage.getItem(userPhotosKey),
 ]);
 
 let storagePending = 0, storageApproved = 0, storageRejected = 0, storagePhotos = 0;
 if (savedPending) {
 try {
 const parsed = JSON.parse(savedPending);
 setPendingBooks(parsed);
 storagePending = parsed.length;
 } catch (e) {
 logger.error('Error parsing pending books:', e);
 }
 }
if (savedApproved) {
    try {
      const raw = JSON.parse(savedApproved);
      const parsed = resolveBookPhotoIdsCb(Array.isArray(raw) ? raw.filter((b: Book) => (b as any).status === 'approved') : [], 'ingestion');
      const willApply = !hasServerHydratedRef.current;
      logger.debug('[ASYNC_STORAGE_FALLBACK]', 'decision', {
        bootstrapped: hasServerHydratedRef.current,
        hasServerHydrated: hasServerHydratedRef.current,
        approvedLenBefore: approvedBooksLenRef.current,
        storageApprovedLen: parsed.length,
        willApply,
      });
      if (willApply) {
        const approvedFallback = ensureApprovedOnePerBookKey(parsed);
        logApprovedIdentityHealth(approvedFallback, 'async_storage_initial');
        logCanonicalIdentityAudit(approvedFallback, idAliasRef.current, 'async_storage_initial');
        logger.debug('[STATE_PUBLISHED]', { statePublished: 'preMerge' });
        lastApprovedUpdateSourceRef.current = 'async_storage_fallback';
        logLibraryStateWrite('async_storage_fallback', { approved: approvedFallback.length });
        setApprovedBooks(approvedFallback);
      }
      storageApproved = parsed.length;
    } catch (e) {
      logger.error('Error parsing approved books:', e);
    }
  }
  if (savedRejected) {
    try {
      const parsed = resolveBookPhotoIdsCb(JSON.parse(savedRejected), 'ingestion');
      setRejectedBooks(parsed);
      storageRejected = parsed.length;
    } catch (e) {
      logger.error('Error parsing rejected books:', e);
    }
  }
  if (savedPhotos) {
    try {
      const rawList: Photo[] = JSON.parse(savedPhotos);
      const list = (Array.isArray(rawList) ? rawList : []).map((p) => {
        const canonical = resolvePhotoId(p.id);
        const idFixed = canonical !== p.id ? { ...p, id: canonical } : p;
        return enforcePhotoStorageStatus(idFixed);
      });
      logLibraryStateWrite('async_storage_fallback_photos', { photos: list.length });
      const normalizedList = normalizePhotosToCanonicalIds(dedupBy(list, photoStableKey));
      setPhotos(normalizedList);
      storagePhotos = list.length;

      // Pre-fetch signed URLs for photos that need them — runs in background so tiles don't show "Loading…" on sign-in.
      // Fires in batches of 4 to avoid overwhelming the network. Results written to photos state so tiles render immediately.
      const PREFETCH_EXPIRY_SEC = 60 * 60 * 24 * 365; // 1 year
      const needsUrl = normalizedList.filter(
        (p) => p.storage_path?.trim() && (!p.signed_url || !p.signed_url_expires_at || p.signed_url_expires_at < Date.now())
      );
      if (needsUrl.length > 0) {
        (async () => {
          const batchSize = 4;
          for (let i = 0; i < needsUrl.length; i += batchSize) {
            const batch = needsUrl.slice(i, i + batchSize);
            await Promise.all(
              batch.map(async (photo) => {
                try {
                  const url = await getSignedPhotoUrl(photo.storage_path!.trim(), PREFETCH_EXPIRY_SEC);
                  upsertPhotoSignedUrl(photo.id, url, PREFETCH_EXPIRY_SEC);
                } catch { /* tile will retry on its own */ }
              })
            );
          }
        })().catch(() => {});
      }
    } catch (e) {
      logger.error('Error parsing photos:', e);
    }
  }
 if (__DEV__ && LOG_DEBUG) logger.debug('[SYNC] storage pending=' + storagePending + ' approved=' + storageApproved + ' rejected=' + storageRejected + ' photos=' + storagePhotos);
 } catch (error) {
 logger.error('Error loading from AsyncStorage:', error);
 }
 };

 // Load scan usage when user changes
 const loadScanUsage = async () => {
 if (!user) {
 setCanScan(true); // Allow scanning if no user (shouldn't happen, but safe fallback)
 return;
 }
 
 // Guest users: 1 free scan per device
 if (isGuestUser(user)) {
 const guestScanKey = 'guest_scan_used';
 const hasUsedScan = await AsyncStorage.getItem(guestScanKey);
 const scansUsed = hasUsedScan === 'true' ? 1 : 0;
 const scansRemaining = hasUsedScan === 'true' ? 0 : 1;
 
 setCanScan(scansRemaining > 0);
 setScanUsage({
 subscriptionTier: 'free',
 monthlyScans: scansUsed,
 monthlyLimit: 1, // One free scan for guests
 scansRemaining: scansRemaining,
 resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
 });
 return;
 }
 
 try {
 // Add timeout to prevent hanging
 const usagePromise = getUserScanUsage(user.uid);
 const timeoutPromise = new Promise((_, reject) => 
 setTimeout(() => reject(new Error('Scan usage load timeout')), 5000)
 );
 
 const usage = await Promise.race([usagePromise, timeoutPromise]) as ScanUsage | null;
 setScanUsage(usage);
 
 // Determine if user can scan based on usage data
 // Signed-in users: unlimited scans (scansRemaining is null = unlimited)
 if (usage) {
 // If scansRemaining is null, user has unlimited scans
 const hasUnlimitedScans = usage.scansRemaining === null;
 const hasScansRemaining = usage.scansRemaining !== null && usage.scansRemaining > 0;
 const userCanScan = hasUnlimitedScans || hasScansRemaining;
 setCanScan(userCanScan);
 
 logger.debug(` Scan usage: tier=${usage.subscriptionTier}, scans=${usage.monthlyScans}/${usage.monthlyLimit || 'unlimited'}, remaining=${usage.scansRemaining || 'unlimited'}, canScan=${userCanScan}`);
 } else {
 // If we can't get usage, default to allowing scans (signed-in users get unlimited)
 logger.warn(' Could not load scan usage, allowing scans by default (signed-in users have unlimited)');
 setCanScan(true);
 }
 } catch (error: any) {
 if (error.message === 'Scan usage load timeout') {
 logger.warn(' Scan usage load timed out, allowing scans by default');
 } else {
 logger.error(' Error loading scan usage:', error);
 }
 // Default to allowing scans if we can't load usage (don't block users)
 setCanScan(true);
 // Set a default scanUsage so the banner doesn't show "loading" forever
 // Signed-in users get unlimited scans
 setScanUsage({
 subscriptionTier: 'free',
 monthlyScans: 0,
 monthlyLimit: null, // null = unlimited for signed-in users
 scansRemaining: null, // null = unlimited
 resetAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
 });
 }
 };
 
 // Background scan syncing disabled - scans work synchronously
 // If re-enabled: treat server as source of truth replace with server list (setPhotos(serverScans)), don't merge (no [...prev, ...serverScans]).
 const syncBackgroundScans = async () => {
 // Disabled - no background jobs
 return;
 if (!user) {
 logger.debug(' Skipping background scan sync: no user');
 return;
 }
 
 try {
 const baseUrl = getApiBaseUrl();
 
 // Get last sync time from storage (user-scoped)
 const lastSyncKey = lastBatchKey(user.uid);
 const lastSyncTime = await AsyncStorage.getItem(lastSyncKey);
 const since = lastSyncTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Default to 7 days ago
 
 const syncUrl = `${baseUrl}/api/sync-scans?since=${encodeURIComponent(since)}`;
 logger.debug(` Syncing background scans from ${baseUrl}...`);
 
 // Fetch completed scan jobs
 const { getScanAuthHeaders: _getScanAuthHeaders } = await import('../lib/authHeaders');
 const _syncHeaders = await _getScanAuthHeaders();
 const response = await fetch(syncUrl, { headers: _syncHeaders });
 if (!response.ok) {
 let errorMessage = `Failed to sync background scans: ${response.status} ${response.statusText}`;
 try {
 const errorData = await response.json();
 errorMessage += ` - ${errorData.error || errorData.detail || JSON.stringify(errorData)}`;
 } catch (e) {
 try {
 const errorText = await response.text();
 if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
 } catch (e2) {
 // Ignore parsing errors
 }
 }
 logger.error(errorMessage);
 return;
 }
 
 const data = await response.json();
 // Client-side safety: only process completed/failed; if backend sends queued/processing, ignore them here
 const allJobs = data.jobs || [];
 const completedJobs = allJobs.filter((j: { status?: string }) =>
 j?.status === 'completed' || j?.status === 'failed'
 );
 if (completedJobs.length !== allJobs.length) {
 logger.warn(`[sync-scans] Filtered to ${completedJobs.length} completed/failed (dropped ${allJobs.length - completedJobs.length} non-completed)`);
 }

 if (completedJobs.length === 0) {
 // Update last sync time
 await AsyncStorage.setItem(lastSyncKey, new Date().toISOString());
 return;
 }
 
 logger.debug(` Syncing ${completedJobs.length} completed background scans...`);
 
 // Collect all pending books from all scans to fetch covers for them
 const allSyncedPendingBooks: Book[] = [];
 
 // Process each completed job
 for (const job of completedJobs) {
 if (job.status === 'completed' && job.books && job.books.length > 0) {
 const storedJobId = job.jobId ? (canonicalJobId(job.jobId) ?? job.jobId) : undefined;
 // Get the photo ID associated with this job (user-scoped key)
 const jobKey = scanJobKey(user.uid, storedJobId ?? job.jobId ?? '');
 const jobData = await AsyncStorage.getItem(jobKey);
 
 if (jobData) {
 const { scanId, photoId } = JSON.parse(jobData);
 
 // Create photo if it doesn't exist
 let photo = photos.find(p => p.id === photoId);
 if (!photo) {
 photo = {
 id: photoId,
 uri: '', // We don't store the image URI in background jobs
 timestamp: new Date(job.createdAt).getTime(),
 books: [],
 jobId: storedJobId, // UI reads from GET /api/scan/[jobId] (scan_jobs.books); always store canonical job_ id
 };
 } else if (storedJobId) {
 photo = { ...photo, jobId: storedJobId };
 }
 
 // Convert job books to Book format; preserve server-enriched fields (googleBooksId, coverUrl, etc.).
 // Provenance at creation: photoId is UUID from photos.id; write into books so approve doesn't need to infer.
 const originPhotoId = photoId; // UUID from photos.id exact value for books.source_photo_id
 const originScanJobId = storedJobId ? (toRawScanJobUuid(storedJobId) ?? undefined) : undefined;
 const bookTimestamp = Date.now();
 const scanRandomSuffix = Math.random().toString(36).substring(2, 9);
 const newBooks: Book[] = job.books.map((book: any, index: number) => ({
 ...book,
 // Preserve a server-returned UUID (already the DB id); otherwise leave id undefined so
 // Postgres generates it on insert. book_key is the stable local identity until then.
 id: (book.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(book.id)) ? book.id : undefined,
 title: book.title ?? '',
 author: book.author || 'Unknown Author',
 isbn: book.isbn || '',
 confidence: book.confidence || 'medium',
 status: 'pending' as const,
 scannedAt: new Date(job.createdAt).getTime(),
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 }));
 
 // Separate complete and incomplete
 const newPendingBooks = newBooks.filter(book => !isIncompleteBook(book));
 const newIncompleteBooks = newBooks.filter(book => isIncompleteBook(book)).map(book => ({
 ...book,
 status: 'incomplete' as const
 }));
 
 // Collect all pending books for cover fetching
 allSyncedPendingBooks.push(...newPendingBooks);
 
 // Update photo with books
 const updatedPhoto: Photo = {
 ...photo,
 books: [
 ...newPendingBooks.map(book => ({ ...book, status: 'pending' as const })),
 ...newIncompleteBooks.map(book => ({ ...book, status: 'incomplete' as const }))
 ]
 };
 
 // Add books to pending using deduplicateBooks
 const importJobId = storedJobId ?? job.jobId;
 logger.debug('[SCAN_IMPORT]', { jobId: importJobId, bookCount: newPendingBooks.length });
 sendTelemetry('SCAN_IMPORT', { jobId: importJobId, bookCount: newPendingBooks.length });
 sendTelemetry('SCAN_DONE_CLIENT', { jobId: importJobId, reason: 'imported' });
 setPendingBooks(prev => {
 const deduped = deduplicateBooks(prev, newPendingBooks);
 const userPendingKey = `pending_books_${user.uid}`;
 AsyncStorage.setItem(userPendingKey, JSON.stringify(deduped));
 return deduped;
 });
 
 // Update photos (dedup by stable key so merge never duplicates)
 setPhotos(prev => {
 const existing = prev.find(p => p.id === photoId);
 const merged = existing
 ? prev.map(p => p.id === photoId ? updatedPhoto : p)
 : [...prev, updatedPhoto];
 const updated = dedupBy(merged, photoStableKey);
 const userPhotosKey = `photos_${user.uid}`;
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(updated));
 if (__DEV__ && LOG_TRACE) {
 const ids = updated.map(p => p.id).filter(Boolean).slice(0, 3);
 logger.debug(`[PENDING] poll fetch count=${updated.length} ids=[${ids.join(',')}] source=poll`);
 }
 return updated;
 });
 
 // Remove job tracking
 await AsyncStorage.removeItem(jobKey);
 }
 }
 }
 
 // Update last sync time
 await AsyncStorage.setItem(lastSyncKey, new Date().toISOString());
 
 logger.debug(` Synced ${completedJobs.length} background scans`);
 
 // Covers are resolved in worker; client shows book.coverUrl or placeholder
 
 } catch (error) {
 const errorMessage = error instanceof Error 
 ? `Error syncing background scans: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
 : `Error syncing background scans: ${String(error)}`;
 logger.error(errorMessage);
 }
 };

 /** Fix #3: Guard photo import from completed scan jobs run once per job. Key = jobId + ":" + imageIndex (or storage_path). */
 const getImportedPhotoKeys = async (userId: string): Promise<Set<string>> => {
 try {
 const raw = await AsyncStorage.getItem(importedPhotoKeysKey(userId));
 if (!raw) return new Set();
 const arr = JSON.parse(raw);
 return new Set(Array.isArray(arr) ? arr : []);
 } catch {
 return new Set();
 }
 };
 const addImportedPhotoKey = async (userId: string, key: string): Promise<void> => {
 const set = await getImportedPhotoKeys(userId);
 set.add(key);
 await AsyncStorage.setItem(importedPhotoKeysKey(userId), JSON.stringify([...set]));
 };

 const loadUserData = async () => {
 // CRITICAL GUARD: Never run loadUserData while scanning is in progress.
 // The server merge in loadUserData replaces pendingBooks with server data,
 // wiping locally-imported books from scans that haven't synced yet.
 // The data will refresh naturally when all scanning completes.
 if (inFlightBatchIdsRef.current.size > 0 || serialScanQueueRef.current.length > 0) {
   logger.debug('[LOAD_USER_DATA] skip: scanning in progress', {
     inFlightBatches: inFlightBatchIdsRef.current.size,
     serialQueue: serialScanQueueRef.current.length,
   });
   return;
 }
 // APPROVAL GUARD: Don't run loadUserData within 10s of approval.
 // The server may not have processed the approve yet, so the merge would
 // overwrite the optimistic approved books with stale server data (0 approved).
 if (approvalGraceUntilRef.current > 0 && Date.now() < approvalGraceUntilRef.current) {
   logger.debug('[LOAD_USER_DATA] skip: approval grace window', {
     graceRemaining: approvalGraceUntilRef.current - Date.now(),
   });
   return;
 }
 // A) Don't run any pending fetch until auth is ready and we have a session (or guest). If !userId, return don't set pending, don't replace, don't merge.
 if (!authReady) {
 logger.debug(' Auth not ready yet, delaying data load');
 return;
 }
 if (!user?.uid) return;
 const hasSession = !!session;
 if (!hasSession && !isGuestUser(user)) {
 logger.debug(' Session not ready yet, delaying data load');
 return;
 }
 // Guest mode ONLY when authReady === true AND session === null; never earlier.
 if (authReady && session === null) {
 logger.debug('[GUEST_GATE]', JSON.stringify({
 authReady,
 hasSession: false,
 reason: 'no_session_guest_ok',
 }, null, 2));
 logger.debug(' Guest user (authReady=true, session=null), using local data only');
 return;
 }

 // D) Prevent duplicate loads: effect + focus (or double mount in dev) must not run merge twice.
 if (loadUserDataInProgressRef.current) {
 if (__DEV__ && LOG_TRACE) logger.debug('[LOAD_USER_DATA] skip: already in progress (will run again after current)');
 loadUserDataAgainAfterRef.current = true;
 return;
 }
 const now = Date.now();
 if (now - lastLoadUserDataAtRef.current < LOAD_USER_DATA_DEBOUNCE_MS) {
 if (__DEV__ && LOG_TRACE) logger.debug('[LOAD_USER_DATA] skip: debounce', { ms: now - lastLoadUserDataAtRef.current });
 return;
 }
loadUserDataInProgressRef.current = true;
const requestId = ++pendingLoadRequestIdRef.current;
const _rehydrateT0 = Date.now();
startRehydrate();

// Library fetch uses its own AbortController — aborted only on user switch/sign-out, never on tab blur or scan cancel.
if (libraryAbortControllerRef.current) libraryAbortControllerRef.current.abort();
const libraryController = new AbortController();
libraryAbortControllerRef.current = libraryController;
const librarySignal = libraryController.signal;

// Prime high-water marks, safety epoch, and last destructive action from AsyncStorage on EVERY load.
// If no safety epoch (fresh install / never set), set one and keep refs at 0 so first snapshot is accepted.
Promise.all([
  getSafetyEpoch(user.uid),
  loadHighWaterMark(user.uid),
  loadLastDestructiveAction(user.uid),
]).then(async ([epoch, storedMark, storedAction]) => {
  if (!epoch) {
    const newEpoch = uuidv4();
    await setSafetyEpoch(user.uid, newEpoch);
    safetyEpochRef.current = newEpoch;
    highWaterApprovedCountRef.current = 0;
    highWaterPhotosCountRef.current = 0;
    isFreshInstallThisSessionRef.current = true;
  } else {
    safetyEpochRef.current = epoch;
    isFreshInstallThisSessionRef.current = false;
    if (storedMark) {
      if (storedMark.approved > highWaterApprovedCountRef.current) {
        highWaterApprovedCountRef.current = storedMark.approved;
      }
      if (storedMark.photos > highWaterPhotosCountRef.current) {
        highWaterPhotosCountRef.current = storedMark.photos;
      }
      logger.debug('[HIGH_WATER]', 'loaded from storage', {
        approved: highWaterApprovedCountRef.current,
        photos: highWaterPhotosCountRef.current,
        storedAt: storedMark.updatedAt,
      });
    } else {
      // No stored high-water (e.g. after cache clear / resetSafetyBaselines) — accept next snapshot.
      highWaterApprovedCountRef.current = 0;
      highWaterPhotosCountRef.current = 0;
    }
  }
  if (storedAction) {
    lastDestructiveActionRef.current = storedAction;
  }
}).catch(() => { /* non-fatal */ });

try {
// Load from AsyncStorage FIRST for instant UI, then merge Supabase data
logger.debug(' Loading user data (AsyncStorage first, then Supabase)...');
 
const userPendingKey = `pending_books_${user.uid}`;
const userApprovedKey = `approved_books_${user.uid}`;
const userRejectedKey = `rejected_books_${user.uid}`;
const userPhotosKey = `photos_${user.uid}`;
const approvedBookIdAliasesKey = `approved_book_id_aliases_${user.uid}`;
const photoIdAliasesKey = `photo_id_aliases_${user.uid}`;
// When setting scan queue from server: const filtered = filterToPendingScans(scansFromServer); then setScanQueue(...)
// Guest: load pending_guest only (device-only, no dbId/sync)
const isGuest = isGuestUser(user);
const [savedPendingOrGuest, savedApproved, savedRejected, savedPhotos, deletedBookIds, deletedPendingStableKeys, savedAliases, savedPhotoAliases] = await Promise.all(
  isGuest
    ? [AsyncStorage.getItem(PENDING_GUEST_KEY), Promise.resolve(null), Promise.resolve(null), Promise.resolve(null), getDeletedBookIds(user.uid), getDeletedPendingStableKeys(user.uid), Promise.resolve(null), Promise.resolve(null)]
    : [AsyncStorage.getItem(userPendingKey), AsyncStorage.getItem(userApprovedKey), AsyncStorage.getItem(userRejectedKey), AsyncStorage.getItem(userPhotosKey), getDeletedBookIds(user.uid), getDeletedPendingStableKeys(user.uid), AsyncStorage.getItem(approvedBookIdAliasesKey), AsyncStorage.getItem(photoIdAliasesKey)]
);
const savedPending = isGuest ? null : savedPendingOrGuest;
const savedGuest = isGuest ? savedPendingOrGuest : null;

let storagePending = 0, storageApproved = 0, storageRejected = 0;
// filterDeleted: remove books whose UUID is tombstoned (covers server-resurrected rows).
const filterDeleted = (b: Book) => !b.id || !deletedBookIds.has(b.id);
if (savedAliases) {
  try {
    const parsed = JSON.parse(savedAliases) as Record<string, string>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      idAliasRef.current = parsed;
    }
  } catch (_) { /* ignore */ }
}
if (savedPhotoAliases) {
  try {
    const parsed = JSON.parse(savedPhotoAliases) as Record<string, string>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      photoIdAliasRef.current = parsed;
      const count = Object.keys(parsed).length;
      if (count > 0) {
        const sample = Object.entries(parsed)
          .slice(0, 3)
          .map(([local, canonical]) => `${local.slice(0, 8)}→${canonical.slice(0, 8)}`);
        logger.info('[PHOTO_ALIAS_MAP_LOADED]', { aliasCount: count, sample });
      }
    }
  } catch (_) { /* ignore */ }
}

 if (savedGuest) {
 try {
 const payload = JSON.parse(savedGuest) as { books?: Book[]; guestScanId?: string; expiresAt?: string };
 const books = Array.isArray(payload?.books) ? payload.books : [];
 setBooksFromBuckets([], books.map(b => ({ ...b, isGuest: true as const, status: (b as any).status === 'incomplete' ? 'incomplete' : 'pending' })), []);
 storagePending = books.length;
 logLibraryStateWrite('guest_restore', { approved: 0, photos: 0, pending: books.length });
 setPhotos([]);
 } catch (e) {
 logger.error('Error parsing pending_guest:', e);
 }
 } else if (savedPending) {
 try {
 const parsed = resolveBookPhotoIdsCb(JSON.parse(savedPending) as Book[], 'ingestion');
 setPendingBooks(parsed);
 storagePending = parsed.length;
 } catch (e) {
 logger.error('Error parsing pending books:', e);
 }
 }
 if (savedApproved) {
 try {
 let parsed = (JSON.parse(savedApproved) as Book[]).filter(filterDeleted).filter((b) => (b as any).status === 'approved');
 const aliases = idAliasRef.current;
 parsed = parsed.map((b) => {
 const resolvedId = b.id && aliases[b.id] ? aliases[b.id] : b.id;
 return resolvedId !== b.id ? { ...b, id: resolvedId, dbId: resolvedId ?? b.dbId } : b;
 });
 parsed = resolveBookPhotoIdsCb(parsed, 'ingestion');
 const bootstrapped = hasServerHydratedRef.current;
 const hasServerHydrated = hasServerHydratedRef.current;
 const approvedLenBefore = approvedBooksLenRef.current;
 logger.debug('[ASYNC_STORAGE_INITIAL]', 'decision', {
 bootstrapped,
 hasServerHydrated,
 approvedLenBefore,
 storageApprovedLen: parsed.length,
 willApply: !hasServerHydrated,
 });
if (!hasServerHydratedRef.current) {
const approvedInitial = ensureApprovedOnePerBookKey(parsed);
logApprovedIdentityHealth(approvedInitial, 'async_storage_initial');
logCanonicalIdentityAudit(approvedInitial, idAliasRef.current, 'async_storage_initial');
logger.debug('[STATE_PUBLISHED]', { statePublished: 'preMerge' });
lastApprovedUpdateSourceRef.current = 'async_storage_initial';
logLibraryStateWrite('async_storage_initial', { approved: approvedInitial.length });
setApprovedBooks(approvedInitial);
} else {
logger.debug('[ASYNC_STORAGE_INITIAL]', 'skipped (already bootstrapped)', { hasServerHydrated: true, approvedLenBefore });
}
storageApproved = parsed.length;
} catch (e) {
logger.error('Error parsing approved books:', e);
}
}
if (savedRejected) {
 try {
 const parsed = resolveBookPhotoIdsCb((JSON.parse(savedRejected) as Book[]).filter(filterDeleted), 'ingestion');
 setRejectedBooks(parsed);
 storageRejected = parsed.length;
 } catch (e) {
 logger.error('Error parsing rejected books:', e);
 }
 }
// Fix #2: Parse storage photos once for instant UI and for canonical merge below (no append).
// Canonicalize photo ids at the edge so every downstream consumer sees the canonical UUID.
const storagePhotos: Photo[] = savedPhotos
  ? (() => { try { const p = JSON.parse(savedPhotos); return Array.isArray(p) ? p : []; } catch { return []; } })()
  : [];
const storagePhotosCanonical = storagePhotos.map((p) => {
  const canonical = resolvePhotoId(p.id);
  const idFixed = canonical !== p.id ? { ...p, id: canonical } : p;
  // A file:// URI with no storage_path/url is a local placeholder; never mark it complete.
  return enforcePhotoStorageStatus(idFixed);
});
const localDeduped = dedupBy(storagePhotosCanonical, photoStableKey);
logLibraryStateWrite('async_storage_initial_photos', { photos: localDeduped.length });
setPhotos(normalizePhotosToCanonicalIds(dedupePhotosByJobId(localDeduped)));
 if (__DEV__ && LOG_DEBUG) logger.debug('[SYNC] storage pending=' + storagePending + ' approved=' + storageApproved + ' rejected=' + storageRejected + ' photos=' + localDeduped.length);

 // Now load from Supabase with timeout and merge
 let supabaseBooks: any = null;
 let supabasePhotos: any = null;
 
 // Skip Supabase only when guest: authReady && session === null (guest mode)
 if (authReady && session === null && isGuestUser(user)) {
 logger.rateLimit('sync_guest_skip', 10000, 'debug', '[SYNC]', 'guest skip (no Supabase fetch while guest)');
 supabaseBooks = null;
 supabasePhotos = null;
} else {
let adoptions: { jobId: string; localPhotoId: string; canonicalPhotoId: string; canonicalStoragePath?: string | null; canonicalStorageUrl?: string | null }[] = [];
// Snapshot partial-detection: declared here (outside the try block) so it is in scope for
// both the books merge (inside try) and the photos merge (after the catch).
// Thresholds: server < 50% of local on either dimension = partial snapshot.
// Exception: if local is also 0 there is nothing to protect — normal first-load.
const _localApprovedNow = approvedBooks.length;
const _localPhotosNow = photos.length;
let snapshotIsPartial = false;
// These partial-snapshot trigger flags are declared here (outside the try/if block) so
// they remain in scope for the photos merge section which runs after the try/catch.
let _serverApprovedZero         = false;
let _serverPhotosZero           = false;
let _serverApprovedSuspiciouslyLow = false;
let _serverPhotosSuspiciouslyLow   = false;
let _noIdBooksWithZeroServer    = false;
let _serverApprovedZeroButPhotosHaveBooks = false;
let approvedBooksWithNoId       = 0;
let totalAttachedBooksFromPhotos = 0;
try {
 const descMilestone = descBootLoggedRef.current ? undefined : 'boot';
 if (descMilestone) descBootLoggedRef.current = true;
 // Stamp the snapshot sequence for this fetch so we can detect stale responses.
 const mySnapshotSeq = ++snapshotSeqRef.current;
 const supabasePromise = Promise.all([
 loadBooksFromSupabase(user.uid, { ...(descMilestone ? { milestone: descMilestone } : {}), signal: librarySignal }),
 loadPhotosFromSupabase(user.uid, { signal: librarySignal }),
 ]);
 
 const timeoutPromise = new Promise((_, reject) => 
 setTimeout(() => reject(new Error('Supabase load timeout')), 5000)
 );
 
 const result = await Promise.race([
 supabasePromise,
 timeoutPromise,
 ]);
 
// Hoisted so they are readable by the merge block below (outside the Array.isArray guard).
let _snapPhotos = 0;
let _snapSource: string = descMilestone === 'boot' ? 'boot' : 'focus';

// Check if result is an array (success) or error (timeout)
if (Array.isArray(result)) {
[supabaseBooks, supabasePhotos] = result;
supabaseHealthyRef.current = true;
consecutiveSupabaseFailuresRef.current = 0;
logger.debug('[TIMING]', { op: 'rehydrate_supabase_fetch', ms: Date.now() - _rehydrateT0, counts: { books: ((supabaseBooks?.approved?.length ?? 0) + (supabaseBooks?.pending?.length ?? 0)), photos: supabasePhotos?.length ?? 0 } });
// Single-line snapshot trustworthiness check.
// Use total books (approved + pending) for partial detection so we don't treat "0 approved, 6 pending" as partial.
// Previously we used approved-only; that triggered books_zero_but_photos_have_books and blocked state updates.
const _snapApproved = supabaseBooks?.approved?.length ?? 0;
const _snapPending = supabaseBooks?.pending?.length ?? 0;
const _snapBooks = _snapApproved + _snapPending;
_snapPhotos = supabasePhotos?.length ?? 0;
_snapSource = descMilestone === 'boot' ? 'boot' : 'focus';

// If the server returned dramatically fewer items than local already has, something upstream
// is wrong (RLS gap, photos.books NOT NULL insert failure, PostgREST cap, transient error).
// snapshotIsPartial flows into both books and photos merge below to force local-wins.
//
// Four independent triggers — any one is sufficient:
//   A) Zero-snapshot: server returned 0 total books (approved + pending) where local has items.
//      This is the strongest signal — a complete wipeout from a trusted server read is never
//      correct when local has real data. Catches RLS session gaps (auth.uid() returns null →
//      PostgREST returns 0 rows).
//   B) Dramatically fewer: server returned < 50% of local approved or < 50% of local photos.
//      Avoids treating every poll where server is 1 behind as partial (stops oscillation).
//   C) No-id books + zero server: client has approved books with no DB UUID *and* server
//      returned 0 total — means the approve write may not have landed yet.
// (Variables are declared outside the try block above so photos merge can read them too.)
approvedBooksWithNoId         = (approvedBooks ?? []).filter(b => !b.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.id)).length;
totalAttachedBooksFromPhotos  = (supabasePhotos ?? []).reduce((s, p) => s + ((p as { books?: unknown[] }).books?.length ?? 0), 0);
_serverApprovedZero           = _localApprovedNow > 0 && _snapBooks === 0;
_serverPhotosZero             = _localPhotosNow > 0 && _snapPhotos === 0;
// Evidence of partial snapshot: server returned 0 total books but photos attach says books exist.
// With all-books fetch, this only fires when we truly get 0 books (not when we have 0 approved + 6 pending).
_serverApprovedZeroButPhotosHaveBooks = _snapBooks === 0 && totalAttachedBooksFromPhotos > 0;
// "Suspiciously low": server returned dramatically fewer than local (< 50%), not just any-fewer.
// Avoids treating every poll where server is 1 behind as partial (stops oscillation / re-sanitize every tick).
_serverApprovedSuspiciouslyLow =
  _localApprovedNow > 0 && _snapApproved > 0 && _snapApproved < Math.max(1, Math.floor(_localApprovedNow * 0.5));
_serverPhotosSuspiciouslyLow =
  _localPhotosNow > 0 && _snapPhotos > 0 && _snapPhotos < Math.max(1, Math.floor(_localPhotosNow * 0.5));
_noIdBooksWithZeroServer      = approvedBooksWithNoId > 0 && _snapBooks === 0;
snapshotIsPartial =
  _serverApprovedZero ||
  _serverPhotosZero ||
  _serverApprovedSuspiciouslyLow ||
  _serverPhotosSuspiciouslyLow ||
  _noIdBooksWithZeroServer ||
  _serverApprovedZeroButPhotosHaveBooks;

// Snapshot summary is deferred to after the merge decision so one log line captures
// server totals + partial state + merge outcome together (see [SNAPSHOT_MERGE] below).
} else {
if (__DEV__ && LOG_DEBUG) logger.debug('[SYNC] fail timeout');
logger.warn('[SNAPSHOT_MERGE]', {
  source: descMilestone === 'boot' ? 'boot' : 'focus',
  ok: false,
  reason: 'timeout',
  serverApproved: null,
  serverPhotos: null,
  latencyMs: Date.now() - _rehydrateT0,
  userIdPrefix: user.uid.slice(0, 8),
});
supabaseBooks = null;
supabasePhotos = null;
}
 
 
 // Merge server into local never nuke fresh local mutations (approved books vanish fix)
 if (supabaseBooks) {
 const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
 const cutoff = Date.now() - PENDING_MAX_AGE_MS;
 const serverPending = (supabaseBooks.pending || []).filter((b: Book) => {
 const scannedAt = b.scannedAt ?? (b as any).scanned_at;
 if (scannedAt == null) return true;
 return Number(scannedAt) > cutoff;
 });
 const serverApproved = supabaseBooks.approved || [];
 const serverRejected = supabaseBooks.rejected || [];
 logApprovedIdentityHealth(serverApproved, 'server_load');

 // Rule A/B: books with unconfirmed approve stay approved; don't resurrect to pending from server.
 const { getBookIdsWithUnconfirmedApprove } = await import('../lib/approveMutationsOutbox');
 const unconfirmedApproveBookIds = await getBookIdsWithUnconfirmedApprove(user.uid);
 const serverPendingForMerge = serverPending.filter((b: Book) => !(b.id && unconfirmedApproveBookIds.has(b.id)));

 const MERGE_WINDOW_MS = 60 * 1000;
 const hasRecentMutation = Date.now() - lastLocalMutationAtRef.current < MERGE_WINDOW_MS;
 /** Grace window after approval: merge local-first so we don't overwrite with stale remote until remote confirms. */
 const APPROVE_GRACE_MS = 15 * 1000;
 const hasApprovalGraceWindow =
   Date.now() - lastApprovedAtRef.current < APPROVE_GRACE_MS ||
   (approvalGraceUntilRef.current > 0 && Date.now() < approvalGraceUntilRef.current) ||
   (scanTerminalGraceUntilRef.current > 0 && Date.now() < scanTerminalGraceUntilRef.current);

 const makeKey = (b: Book) => getStableBookKey(b);

 /** Merge server + local; order controls who wins on key collision: mergeList(server, local) = server wins, mergeList(local, server) = local wins. */
 const mergeList = (primary: Book[], secondary: Book[]): Book[] => {
 const primaryKeys = new Set(primary.map(makeKey));
 const secondaryOnly = secondary.filter((b) => !primaryKeys.has(makeKey(b)));
 return [...primary, ...secondaryOnly];
 };
  /** Offline-first: approved = union by book_key with field-level merge. Identity (title/author) prefer local; server id/enrichment when present.
   * Pass photoAliasMap (localPhotoId → canonicalPhotoId) so provenance IDs are resolved before
   * merge winner logic runs — prevents local alias from beating the server canonical value. */
  const mergeListDbCanonical = (server: Book[], local: Book[], photoAliasMap?: Record<string, string>): Book[] => {
    const serverByKey = new Map<string, Book>();
    server.forEach((b) => serverByKey.set(makeKey(b), { ...b, book_key: b.book_key ?? makeKey(b) }));
    const localOnly: Book[] = [];
    local.forEach((b) => {
      const k = makeKey(b);
      const serverBook = serverByKey.get(k);
      const localWithKey = { ...b, book_key: b.book_key ?? k };
      if (!serverBook) {
        localOnly.push(
          (b as any).sync_state === 'pending' || typeof (b as any).sync_pending_at === 'number'
            ? localWithKey
            : { ...localWithKey, sync_state: 'pending' as const, sync_pending_at: (b as any).sync_pending_at ?? Date.now() }
        );
        return;
      }
      serverByKey.set(k, mergeBookFieldLevel(serverBook, localWithKey, photoAliasMap));
    });
    return [...serverByKey.values(), ...localOnly];
  };

 // Only exclude remote pending when we have a local pending for the same book_key or same scan_job_id/photo_id. Otherwise show remote pending.
 // Tombstone filter must be surgical: only exclude server pending when there is explicit deleted_at on that exact book id, or explicit rejected status.
 // Never apply stable-key tombstones to server rows (avoids dropping 32/34 when keys are broad or stale); never treat "missing from snapshot" as deleted when partial.
 const mergePending = (local: Book[], server: Book[]): Book[] => {
 const key = (b: Book) => (b.id ?? (b as any).book_key ?? makeKey(b)) || '';
 const serverFiltered = server.filter((s: Book) => {
   if (s.id && deletedBookIds.has(s.id)) return false;
   if ((s as any).deleted_at != null) return false;
   if ((s as any).status === 'rejected') return false;
   return true;
 });
 const tombstoneFilteredCount = server.length - serverFiltered.length;
 if (tombstoneFilteredCount > 0) {
   logger.info('[PENDING_TOMBSTONES_APPLIED]', { filteredOutCount: tombstoneFilteredCount, serverTotal: server.length, serverAfterFilter: serverFiltered.length, reason: 'id_in_deletedBookIds_or_deleted_at_or_rejected_only' });
 }
 const merged: Book[] = [...local];
 for (const s of serverFiltered) {
 const hasLocalWithSameKey = local.some((l) => key(l) === key(s));
 const hasLocalWithSameProv =
 (s.source_scan_job_id != null || s.source_photo_id != null) &&
 local.some(
 (l) =>
 l.source_scan_job_id === s.source_scan_job_id || l.source_photo_id === s.source_photo_id
 );
 if (!hasLocalWithSameKey && !hasLocalWithSameProv) merged.push(s);
 }
 const byKey = new Map<string, Book>();
 merged.forEach((b) => byKey.set(key(b), b));
 return [...byKey.values()];
 };

// Re-read pending from AsyncStorage: the Supabase fetch above can take 1-3s.
// saveUserData may have written new scan books during that time; use the freshest value.
const freshSavedPending = !isGuest ? await AsyncStorage.getItem(userPendingKey) : null;
const pendingStorageStr = freshSavedPending ?? savedPending;
// Canonicalize source_photo_id at the storage ingestion edge so merge never sees local aliases.
const localPending: Book[] = resolveBookPhotoIdsCb(pendingStorageStr ? (() => { try { return JSON.parse(pendingStorageStr); } catch { return []; } })() : [], 'rehydrate');
// Exclude any book with deleted_at set so stale cache after "clear library" is never treated as active (matches fetchAll filter).
const localApproved: Book[] = resolveBookPhotoIdsCb(
  savedApproved ? (() => {
    try {
      const parsed = JSON.parse(savedApproved) as Book[];
      return Array.isArray(parsed) ? parsed.filter((b: any) => b?.deleted_at == null) : [];
    } catch { return []; }
  })() : [],
  'rehydrate'
);
const localRejected: Book[] = resolveBookPhotoIdsCb(savedRejected ? (() => { try { return JSON.parse(savedRejected); } catch { return []; } })() : [], 'rehydrate');

 // Apply photo dedupe adoptions BEFORE merge so we publish once (no PHOTO_DEDUPE_LOCAL_REWRITE after STATE_PUBLISHED).
 const photosWithJobEarly = localDeduped.filter((p: Photo) => p.jobId);
 if (photosWithJobEarly.length > 0) {
  for (const p of photosWithJobEarly) {
    const saveResult = await savePhotoToSupabase(user.uid, p, {
      statusOverride: (p.storage_path || p.status === 'complete') ? 'complete' : undefined,
      onAdoptedCanonical: (jobId, localId, canonicalId) => {
        // Storage fields are captured from saveResult after the await; push a placeholder here.
        adoptions.push({ jobId, localPhotoId: localId, canonicalPhotoId: canonicalId });
        // Register in the canonical map so delete sites can detect this ID is protected.
        registerDedupe(localId, canonicalId);
      },
    });
    if (saveResult?.ok) clearDraftWatchdogForPhoto(p.id, saveResult.canonicalPhotoId ?? null);
    // Back-fill storage fields onto the last adoption entry that was pushed by this call.
    if (saveResult?.canonicalPhotoId && saveResult.canonicalPhotoId !== p.id) {
      const lastAdoption = adoptions[adoptions.length - 1];
      if (lastAdoption && lastAdoption.canonicalPhotoId === saveResult.canonicalPhotoId) {
        lastAdoption.canonicalStoragePath = saveResult.canonicalStoragePath ?? null;
        lastAdoption.canonicalStorageUrl = saveResult.canonicalStorageUrl ?? null;
      }
    }
  }
 if (adoptions.length > 0) {
   // Persist new photo aliases immediately so future sessions resolve without re-deduping.
   const newPhotoAliases: Record<string, string> = {};
   for (const a of adoptions) {
     if (a.localPhotoId !== a.canonicalPhotoId) newPhotoAliases[a.localPhotoId] = a.canonicalPhotoId;
   }
   await mergePhotoAliases(newPhotoAliases);
   // The localApproved/localPending arrays were already canonicalized at the storage ingestion
   // edge (resolveBookPhotoIds), so only rewrite residual local aliases missed by the alias map
   // (e.g. very first session where map was empty when books were parsed).
   for (const a of adoptions) {
     for (const b of localApproved) {
       if ((b as any).source_photo_id === a.localPhotoId) (b as any).source_photo_id = a.canonicalPhotoId;
     }
     for (const b of localPending) {
       if ((b as any).source_photo_id === a.localPhotoId) (b as any).source_photo_id = a.canonicalPhotoId;
     }
   }
   logger.debug('[PHOTO_ADOPT_CANONICAL]', 'applying before merge (no UI rewrite after)', {
     count: adoptions.length,
     adoptions: adoptions.map((a) => ({ jobId: a.jobId.slice(0, 8), local: a.localPhotoId?.slice(0, 8), canonical: a.canonicalPhotoId?.slice(0, 8) })),
   });
   for (const a of adoptions) {
     const localBooksRewritten =
       localApproved.filter((b) => (b as any).source_photo_id === a.canonicalPhotoId).length +
       localPending.filter((b) => (b as any).source_photo_id === a.canonicalPhotoId).length;
     logger.debug('[PHOTO_DEDUPE_LOCAL_REWRITE]', { oldPhotoId: a.localPhotoId, canonicalPhotoId: a.canonicalPhotoId, localBooksRewritten });
   }

   // INVARIANT: if any book now references canonicalPhotoId, that photo row MUST exist locally.
   // Insert the canonical photo into localDeduped (replacing the local placeholder) so that
   // photosForMerge and the integrity check always find it — even if supabasePhotos is empty
   // (e.g. timeout) or the merge drops the server row before we get there.
   for (const a of adoptions) {
     if (a.localPhotoId === a.canonicalPhotoId) continue; // no actual rewrite happened
     const canonicalAlreadyLocal = localDeduped.some((p: Photo) => p.id === a.canonicalPhotoId);
     if (!canonicalAlreadyLocal) {
       // Build canonical row from the local placeholder, overwriting id + any storage fields.
       const localPlaceholder = localDeduped.find((p: Photo) => p.id === a.localPhotoId);
       const canonicalRow: Photo = {
         ...(localPlaceholder ?? ({} as Photo)),
         id: a.canonicalPhotoId,
         ...(a.canonicalStoragePath ? { storage_path: a.canonicalStoragePath } : {}),
         ...(a.canonicalStorageUrl ? { storage_url: a.canonicalStorageUrl, uri: a.canonicalStorageUrl } : {}),
       };
       // Enforce correct status: if no remote storage, stay as 'draft'.
       const canonicalGuarded = enforcePhotoStorageStatus(canonicalRow);
       localDeduped.push(canonicalGuarded);
       logger.debug('[PHOTO_CANONICAL_INSERT]', {
         localPhotoId: a.localPhotoId.slice(0, 8),
         canonicalPhotoId: a.canonicalPhotoId.slice(0, 8),
         hadStoragePath: !!a.canonicalStoragePath,
         status: canonicalGuarded.status ?? 'unknown',
       });
     }
     // Remove the stale local placeholder so we don't carry both rows forward.
     const placeholderIdx = localDeduped.findIndex((p: Photo) => p.id === a.localPhotoId);
     if (placeholderIdx !== -1) {
       localDeduped.splice(placeholderIdx, 1);
       logger.debug('[PHOTO_LOCAL_PLACEHOLDER_REMOVED]', { localPhotoId: a.localPhotoId.slice(0, 8), canonicalPhotoId: a.canonicalPhotoId.slice(0, 8) });
     }
   }
 }
 }

 // Fix #4: Pending is local-first. Remove from pending only when: (1) exact book id is in server approved/rejected, or (2) user explicitly deleted this pending (scoped stable key).
 // Surgical: match by exact book id only — never by makeKey (would drop brand-new pending that share title/author with an approved book).
 const serverApprovedIds = new Set((serverApproved ?? []).map((b) => b.id).filter((id): id is string => !!id));
 const serverRejectedIds = new Set((serverRejected ?? []).map((b) => b.id).filter((id): id is string => !!id));

 const removeTombstoned = (list: Book[]): Book[] => {
   const filtered = list.filter((b) => {
     if (b.id && (serverApprovedIds.has(b.id) || serverRejectedIds.has(b.id))) return false;
     if (deletedPendingStableKeys.has(getPendingStableKeyScoped(b))) return false;
     return true;
   });
   const filteredOutCount = list.length - filtered.length;
   if (filteredOutCount > 0) {
     logger.info('[PENDING_TOMBSTONES_APPLIED]', { filteredOutCount, listTotal: list.length, listAfterFilter: filtered.length, reason: 'exact_id_approved_rejected_or_scoped_stable_key' });
   }
   return filtered;
 };

 // Fix #2: During active batch (jobs not all completed), don't let server overwrite pending refresh approved/rejected only.
 const batch = activeBatchRef.current;
 const hasActiveBatch = batch != null && !isTerminalBatchStatus(deriveBatchStatus(batch));

 let finalPending: Book[];
 let finalApproved: Book[];
 let finalRejected: Book[];

  // Build photo alias map from adoptions so mergeListDbCanonical can resolve local photo ids.
  const adoptionPhotoAliasMap: Record<string, string> = {};
  adoptions.forEach((a) => { if (a.localPhotoId !== a.canonicalPhotoId) adoptionPhotoAliasMap[a.localPhotoId] = a.canonicalPhotoId; });

  // When user just ran "Clear Library", server returns 0/0 — apply empty so local cache stops showing "approved=18" (matches server).
  const _serverPhotosForMerge = _snapPhotos ?? 0;
  const serverIsEmptyForMerge = serverApproved.length === 0 && _serverPhotosForMerge === 0;
  const _inSessionActionForEmpty = getLastDestructiveAction(user.uid);
  const _persistedActionForEmpty = lastDestructiveActionRef.current;
  const _effectiveLastActionForEmpty = (_inSessionActionForEmpty && (!_persistedActionForEmpty || _inSessionActionForEmpty.at > _persistedActionForEmpty.at)) ? _inSessionActionForEmpty : _persistedActionForEmpty;
  const isRecentAuthoritativeDestructive = _effectiveLastActionForEmpty != null
    && (AUTHORITATIVE_DESTRUCTIVE_REASONS as readonly string[]).includes(_effectiveLastActionForEmpty.reason)
    && (Date.now() - _effectiveLastActionForEmpty.at) < AUTHORITATIVE_DESTRUCTIVE_MS;

  // Empty snapshot guard: only accept 0 books/photos from server if user just did an authoritative action (clear library / reject pending / approve) within 30s. Otherwise keep local.
  // Never downgrade from non-empty local to empty server unless an authoritative destructive action explains it.
  const localHasApproved = localApproved.length > 0;
  const serverApprovedZero = serverApproved.length === 0;
  const untrustedEmptySnapshot = localHasApproved && serverApprovedZero && !isRecentAuthoritativeDestructive;

  // Merge rule: never drop local accepted items. Use field-level merge so server never overwrites local title/author with blank.
  // snapshotIsPartial = server returned dramatically fewer items than local already holds — treat
  // same as grace window: keep local as base, only layer server additions on top.
  if (untrustedEmptySnapshot) {
    // Server returned 0 approved but local has data and user did not just clear — treat as partial/untrusted, keep local.
    finalPending = removeTombstoned(mergeList(localPending, serverPendingForMerge));
    finalApproved = mergeList(localApproved, serverApproved);
    finalRejected = mergeList(localRejected, serverRejected);
    if (__DEV__) {
      logger.warn('[BOOKS_MERGE_EMPTY_GUARD]', 'server approved=0 with local > 0 and no recent authoritative action — keeping local (do not downgrade)', {
        localApprovedCount: localApproved.length,
        serverApprovedCount: 0,
      });
    }
  } else if (serverIsEmptyForMerge && isRecentAuthoritativeDestructive) {
    // Apply server empty so UI stops treating cleared/updated data as active (clear library / reject / approve within 30s).
    finalApproved = serverApproved;
    finalPending = removeTombstoned(serverPendingForMerge);
    finalRejected = serverRejected;
  } else if (hasActiveBatch) {
    // Never drop server pending: merge so serverPending > 0 is never overwritten with 0 (fix: focus merge was setting localPendingAfter:0 when serverPending:6).
    finalPending = removeTombstoned(mergeList(localPending, serverPendingForMerge));
    finalApproved = mergeListDbCanonical(serverApproved, localApproved, adoptionPhotoAliasMap);
    finalRejected = mergeList(serverRejected, localRejected);
  } else if (hasApprovalGraceWindow || snapshotIsPartial) {
    // Grace window OR partial snapshot: local-first so just-approved items / full local library
    // are not overwritten by a lagging or incomplete server snapshot.
    if (snapshotIsPartial) {
      const _logFn = (_serverApprovedZero || _serverPhotosZero || _serverApprovedZeroButPhotosHaveBooks) ? logger.error : logger.warn;
      _logFn('[BOOKS_MERGE_PARTIAL_SNAPSHOT]', 'server snapshot is untrusted — keeping local as merge base (partial snapshot guard)', {
        serverApprovedCount: serverApproved.length,
        localApprovedCount: localApproved.length,
        localPhotosCount: _localPhotosNow,
        totalAttachedBooksFromPhotos,
        trigger: [
          _serverApprovedZero            ? 'books_zero' : null,
          _serverPhotosZero              ? 'photos_zero' : null,
          _serverApprovedSuspiciouslyLow ? 'books_low_50pct' : null,
          _serverPhotosSuspiciouslyLow   ? 'photos_low_50pct' : null,
          _noIdBooksWithZeroServer       ? 'no_id_books_zero_server' : null,
          _serverApprovedZeroButPhotosHaveBooks ? 'books_zero_but_photos_have_books' : null,
        ].filter(Boolean).join('+'),
        approvedBooksWithNoId,
        hint: 'Likely cause: RLS session gap (auth.uid()=null → 0 rows), deleted_at filter mismatch, or photos.books NOT NULL insert failure. Check SESSION_GUARD and FETCH_ALL_APPROVED_BOOKS logs.',
      });
    }
    finalPending = removeTombstoned(mergeList(localPending, serverPendingForMerge));
    finalApproved = mergeList(localApproved, serverApproved);
    finalRejected = mergeList(localRejected, serverRejected);
    if (__DEV__ && !snapshotIsPartial) logger.debug('[LOAD_USER_DATA] approval grace window: merge local-first', { approvedNow: finalApproved.length });
  } else if (hasRecentMutation) {
    finalPending = removeTombstoned(mergePending(localPending, serverPendingForMerge));
    finalApproved = mergeListDbCanonical(serverApproved, localApproved, adoptionPhotoAliasMap);
    finalRejected = mergeList(serverRejected, localRejected);
  } else {
    finalPending = removeTombstoned(mergePending(localPending, serverPendingForMerge));
    finalApproved = mergeListDbCanonical(serverApproved, localApproved, adoptionPhotoAliasMap);
    finalRejected = mergeList(serverRejected, localRejected);
  }
  // Safety net: if server had pending we must never overwrite with 0 in any partial/keep-local path.
  if (serverPendingForMerge.length > 0 && finalPending.length === 0) {
    logger.warn('[BOOKS_MERGE_PENDING_GUARD]', 'server had pending but merge produced 0 — forcing server pending in', {
      serverPendingCount: serverPendingForMerge.length,
      mergePath: hasActiveBatch ? 'hasActiveBatch' : hasApprovalGraceWindow ? 'grace' : snapshotIsPartial ? 'partial' : hasRecentMutation ? 'recentMutation' : 'default',
    });
    finalPending = removeTombstoned(mergeList(localPending, serverPendingForMerge));
  }
  // Approved bucket must only contain status === 'approved'. Move any non-approved out so profile/counts never show pending as approved.
  // Side effect: strays are merged INTO pending (mergeList), not replacing — pending has its own pipeline; UI reads pendingBooks from books by status.
  const approvedOnly = finalApproved.filter((b) => (b as any).status === 'approved');
  const strayToPending = finalApproved.filter((b) => (b as any).status !== 'approved');
  if (strayToPending.length > 0) {
    // Throttle: same data re-sanitized every poll causes flicker; log at most once per 30s.
    logger.logThrottle('books_merge_approved_sanitize', 30_000, 'warn', '[BOOKS_MERGE_APPROVED_SANITIZE]', 'moved non-approved out of approved bucket (approved is derived by status); strays added to pending', {
      movedCount: strayToPending.length,
      approvedAfter: approvedOnly.length,
      sampleStatuses: [...new Set(strayToPending.map((b) => (b as any).status))],
    });
    finalApproved = approvedOnly;
    finalPending = removeTombstoned(mergeList(finalPending, strayToPending));
  }
  // Repair pass: re-approve server-pending books that have an unconfirmed local approve (self-healing sync).
  const repairBookIds = serverPending
    .filter((b: Book) => b.id && unconfirmedApproveBookIds.has(b.id))
    .map((b: Book) => b.id as string);
  if (repairBookIds.length > 0 && session?.access_token) {
    try {
      const approveQueue = await import('../lib/approveQueue');
      const ok = await approveQueue.callBooksApproveByIds(session.access_token, repairBookIds);
      if (ok) {
        finalPending = finalPending.filter((b) => !repairBookIds.includes(b.id ?? ''));
        const repairBooks = serverPending
          .filter((b: Book) => b.id && repairBookIds.includes(b.id))
          .map((b: Book) => ({ ...b, status: 'approved' as const }));
        finalApproved = [...finalApproved, ...repairBooks];
        logger.info('[REHYDRATE_REPAIR]', 're-approved server-pending books that had unconfirmed local approve', { count: repairBookIds.length });
      }
    } catch (e) {
      logger.warn('[REHYDRATE_REPAIR]', 'repair approve failed', { count: repairBookIds.length, error: String(e) });
    }
  }
 // Backfill dbId/id on pending books from server rows so they are never id-less after a
 // sync. Local pending books start life with no DB id (book not yet written) or a stale
 // client-composite id. Once the server has a real UUID for the same book_key we must
 // propagate it otherwise the delete / approve handlers see withId:0 and fall back to
 // the book_key path unnecessarily.
 const serverIdByKey = new Map<string, string>();
 serverPending.forEach((b: Book) => {
 const k = (b as any).book_key ?? makeKey(b);
 const realId = (b as any).dbId ?? (b.id && b.id.length === 36 ? b.id : null);
 if (k && realId) serverIdByKey.set(k, realId);
 });
 if (serverIdByKey.size > 0) {
 let backfilled = 0;
 finalPending = finalPending.map((b) => {
 const k = (b as any).book_key ?? makeKey(b);
 const serverId = k ? serverIdByKey.get(k) : undefined;
 if (!serverId) return b;
 const hasRealId = b.id && b.id.length === 36;
 const hasDbId = !!(b as any).dbId;
 if (hasRealId && hasDbId) return b; // already fully resolved
 backfilled++;
 return { ...b, id: b.id && b.id.length === 36 ? b.id : serverId, dbId: serverId } as Book;
 });
 if (backfilled > 0) {
 logger.debug('[PENDING_ID_BACKFILL]', { backfilled, serverKeys: serverIdByKey.size, finalPending: finalPending.length });
 }
 }

 if (__DEV__ && LOG_DEBUG) logger.debug('[SYNC] merged pending=' + finalPending.length + ' approved=' + finalApproved.length + ' rejected=' + finalRejected.length);

 const mergeFavorsLocal = finalApproved.length > serverApproved.length;
 const localExceedsDbBy = mergeFavorsLocal ? finalApproved.length - serverApproved.length : 0;
 // Identity = book_key (not id). Same book can have local temp id and server UUID; diff by key to verify merge.
 const localApprovedKeySet = new Set<string>(localApproved.map((b) => getStableBookKey(b)).filter(Boolean));
 const dbApprovedKeySet = new Set<string>(serverApproved.map((b) => getStableBookKey(b)).filter(Boolean));
 const localOnlyByKey: string[] = [...localApprovedKeySet].filter((k) => !dbApprovedKeySet.has(k));
 const dbOnlyByKey: string[] = [...dbApprovedKeySet].filter((k) => !localApprovedKeySet.has(k));
 const booksSummary = `books local=${localApproved.length} db=${serverApproved.length} merged=${finalApproved.length} localOnlyByKey=${localOnlyByKey.length} dbOnlyByKey=${dbOnlyByKey.length}`;
 logger.once('REHYDRATE_SUMMARY_BOOKS', 'debug', '[REHYDRATE_SUMMARY]', booksSummary, {
 localApproved: localApproved.length,
 dbApproved: serverApproved.length,
 mergedApproved: finalApproved.length,
 localOnlyByKeyCount: localOnlyByKey.length,
 dbOnlyByKeyCount: dbOnlyByKey.length,
 ...(LOG_DEBUG && (localOnlyByKey.length > 0 || dbOnlyByKey.length > 0) && {
 localOnlyByKeySample: localOnlyByKey.slice(0, 5),
 dbOnlyByKeySample: dbOnlyByKey.slice(0, 5),
 }),
 });

 // Fix #3: Only apply if this request is still the latest (older response must not overwrite).
 if (requestId === pendingLoadRequestIdRef.current) {
 // ── Snapshot sequencing guard ────────────────────────────────────────────
 // Each rehydrate carries mySnapshotSeq stamped at fetch-start. Only apply if
 // it's >= the last applied seq — prevents an older in-flight rehydrate from
 // overwriting a newer post-approve snapshot.
 // Post-approve lock: if approve just wrote authoritative state, don't let a
 // concurrent rehydrate (which started before approve) clobber it.
 const isWithinPostApproveLock = Date.now() < postApproveLockUntilRef.current;
 if (isWithinPostApproveLock) {
   logger.warn('[REHYDRATE_MERGE_BLOCKED]', 'post-approve lock active — skipping rehydrate_merge to protect just-approved state', {
     lockExpiresInMs: Math.max(0, postApproveLockUntilRef.current - Date.now()),
     mySeq: mySnapshotSeq,
     appliedSeq: appliedSnapshotSeqRef.current,
     serverApprovedCount: serverApproved.length,
     localApprovedCount: localApproved.length,
   });
   return;
 }
 if (mySnapshotSeq < appliedSnapshotSeqRef.current) {
   logger.warn('[REHYDRATE_MERGE_STALE]', 'dropping stale rehydrate — a newer snapshot was already applied', {
     mySeq: mySnapshotSeq,
     appliedSeq: appliedSnapshotSeqRef.current,
     serverApprovedCount: serverApproved.length,
   });
   return;
 }
 // When epoch changes (user cleared cache / data), reset high-water refs so we accept the next server snapshot as authoritative.
 let currentEpoch = await getSafetyEpoch(user.uid);
 if (!currentEpoch) {
   const newEpoch = uuidv4();
   await setSafetyEpoch(user.uid, newEpoch);
   currentEpoch = newEpoch;
 }
 if (currentEpoch !== safetyEpochRef.current) {
   safetyEpochRef.current = currentEpoch;
   highWaterApprovedCountRef.current = 0;
   highWaterPhotosCountRef.current = 0;
   justResetBaselinesRef.current = true;
   saveHighWaterMark(user.uid, { approved: 0, photos: 0 }).catch(() => {});
   logger.debug('[SAFETY_EPOCH]', 'epoch changed — reset high-water refs so next snapshot accepted', { epoch: currentEpoch.slice(0, 8) });
 }
 // ── Empty-snapshot overwrite guard ──────────────────────────────────────
 // Never downgrade from non-empty to empty unless: user just cleared library, user switched accounts, or server explicitly indicated deletion scope.
 // If server returned 0/0 but we have high-water evidence of data (or snapshotIsPartial already caught "local > 0 and server 0"), skip the write.
 // Exception: if the user just did an authoritative action (clear/reject/approve), a 0/0 snapshot may be expected — allow overwrite (already applied above via serverIsEmptyForMerge && isRecentAuthoritativeDestructive).
 const hadHighWater = highWaterApprovedCountRef.current > 0;
 if (serverIsEmptyForMerge && hadHighWater && !snapshotIsPartial) {
   if (isRecentAuthoritativeDestructive) {
     logger.info('[REHYDRATE_MERGE_EMPTY_GUARD]', 'allowing empty snapshot — recent authoritative action (clear/reject/approve)', {
       actionId: _effectiveLastActionForEmpty?.actionId,
       reason: _effectiveLastActionForEmpty?.reason,
       ageMs: Date.now() - (_effectiveLastActionForEmpty?.at ?? 0),
     });
     highWaterApprovedCountRef.current = 0;
     highWaterPhotosCountRef.current = 0;
     saveHighWaterMark(user.uid, { approved: 0, photos: 0 }).catch(() => {});
   } else {
     logger.error('[REHYDRATE_MERGE_EMPTY_GUARD]', 'server returned 0 books + 0 photos but high-water shows we had data — skipping to prevent wipe', {
       highWaterApproved: highWaterApprovedCountRef.current,
       highWaterPhotos: highWaterPhotosCountRef.current,
       serverApprovedCount: serverApproved.length,
       serverPhotosCount: _serverPhotosForMerge,
       mySeq: mySnapshotSeq,
       recentDestructiveAction: !!_effectiveLastActionForEmpty,
       lastActionReason: _effectiveLastActionForEmpty?.reason ?? null,
       hint: 'This is likely an RLS session gap (auth.uid()=null). The post-approve snapshot will restore state.',
     });
     return;
   }
 }
 lastApprovedUpdateSourceRef.current = 'rehydrate_merge';
 // Reload stability: snapshot identity fields from local approved before merge (keyed by book_key or id fallback).
 const beforeByKey = new Map<string, { book_key?: string; title: string; author?: string; source_photo_id?: string; source_scan_job_id?: string }>();
 localApproved.forEach((b) => {
 const k = b.book_key ?? getStableBookKey(b) ?? (b.id ?? '');
 if (!k) return;
 beforeByKey.set(k, {
 book_key: b.book_key,
 title: b.title ?? '',
 author: b.author,
 source_photo_id: b.source_photo_id,
 source_scan_job_id: b.source_scan_job_id,
 });
 });
    // Integrity check: for any book whose source_photo_id is not in the known photo set,
    // attempt alias re-resolution first, then LOG ONLY (action:'log_only') — no state mutation.
    // Marking orphaned is disabled until canonical photo insertion is stable.
    const photoIds = new Set<string>([
      ...localDeduped.map((p: Photo) => p.id).filter((x): x is string => Boolean(x)),
      ...(adoptions.length > 0 ? adoptions.map((a) => a.canonicalPhotoId) : []),
    ]);
    const serverPhotoIdSet: Set<string> = new Set((supabasePhotos ?? []).map((p: { id?: string }) => p.id).filter((x): x is string => Boolean(x)));
    // All photo IDs we consider "known" (local + server).
    const allKnownPhotoIds = new Set<string>([...photoIds, ...serverPhotoIdSet]);
    // Also add alias keys: if a book holds a local/temp photoId that aliases to a known canonical,
    // treat it as known so we don't flag it as orphaned before the in-memory sweep runs.
    Object.entries(photoIdAliasRef.current).forEach(([local, canonical]) => {
      if (allKnownPhotoIds.has(canonical)) allKnownPhotoIds.add(local);
    });
    // PHOTO_ROW_LOOKUP: query server for the exact IDs books reference, to detect alias vs canonical mismatches.
    {
      const bookPhotoIds = [...new Set(finalApproved.map((b) => b.source_photo_id).filter((x): x is string => Boolean(x)))];
      logPhotoRowLookup(bookPhotoIds, 'rehydrate_integrity').catch(() => {});
    }
    const _integrityT0 = Date.now();
    // Pass-through: resolve alias in source_photo_id but never set integrity_state.
    const approvedFiltered = finalApproved.map((b) => {
      if (!b.source_photo_id) return b;
      const resolved = resolvePhotoIdLogged(b.source_photo_id, 'integrity_check');
      return resolved !== b.source_photo_id ? { ...b, source_photo_id: resolved } : b;
    });
    // Identify books whose photo is still unresolved — for logging only, no mutation.
    const newlyOrphaned = approvedFiltered.filter((b) => {
      const id = b.source_photo_id;
      return id && !allKnownPhotoIds.has(id);
    });
    if (newlyOrphaned.length > 0) {
      // Summary: always emit once per phase (throttled 30 s so rapid rehydrates don't spam).
      const missingPhotoIds = [...new Set(newlyOrphaned.map((b) => b.source_photo_id).filter(Boolean))] as string[];
      logger.logThrottle('integrity_rehydrate_merge', 30_000, 'info', '[INTEGRITY_CLEANUP_DECISION]', 'summary', {
        phase: 'rehydrate_merge',
        action: 'log_only',
        booksImpactedCount: newlyOrphaned.length,
        distinctMissingPhotoIds: missingPhotoIds.length,
        ...(DEBUG_STACKS && { stack: new Error().stack?.split('\n').slice(1, 4).join(' | ') }),
      });
      // Detail: only when DEBUG_INTEGRITY=true.
      if (DEBUG_INTEGRITY) {
        const resolvedMissingPhotoIds = missingPhotoIds.map((id) => resolvePhotoIdLogged(id, 'integrity_check') ?? id);
        const serverHasPhotoIds: Record<string, boolean> = Object.fromEntries(
          missingPhotoIds.map((id) => [id, serverPhotoIdSet.has(id)])
        );
        const serverHasResolvedPhotoIds: Record<string, boolean> = Object.fromEntries(
          resolvedMissingPhotoIds.map((id) => [id, serverPhotoIdSet.has(id)])
        );
        logger.debug('[INTEGRITY_CLEANUP_DECISION]', {
          phase: 'rehydrate_merge',
          missingPhotoIds: missingPhotoIds.slice(0, 5).map((id) => id.slice(0, 8)),
          resolvedMissingPhotoIds: resolvedMissingPhotoIds.slice(0, 5).map((id) => id.slice(0, 8)),
          reason: missingPhotoIds.some((id) => !serverHasPhotoIds[id] && serverHasResolvedPhotoIds[resolvedMissingPhotoIds[missingPhotoIds.indexOf(id)]])
            ? 'photo_missing_in_local_cache'
            : 'photo_missing_on_server',
          serverHasOriginalIds: serverHasPhotoIds,
          serverHasResolvedIds: serverHasResolvedPhotoIds,
          booksImpactedSample: newlyOrphaned.slice(0, 5).map((b) => ({
            bookId: (b.id ?? '').slice(0, 8),
            photoIdReferenced: (b.source_photo_id ?? '').slice(0, 8),
            wasPhotoIdAliased: b.source_photo_id !== resolvePhotoIdLogged(b.source_photo_id ?? '', 'integrity_check'),
            resolvedPhotoId: (resolvePhotoIdLogged(b.source_photo_id ?? '', 'integrity_check') ?? '').slice(0, 8),
          })),
        });
      }
    }
    logger.debug('[TIMING]', { op: 'integrity_check_rehydrate', ms: Date.now() - _integrityT0, counts: { books: finalApproved.length, wouldOrphan: newlyOrphaned.length } });
 const approvedWithStableKey = approvedFiltered.map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) }));
 // Canonical list: one per book_key. Use this for count, booksById, state, and persist so we never have duplicate-book_key inflation.
 const approvedCanonical = ensureApprovedOnePerBookKey(approvedWithStableKey);
 if (__DEV__ && approvedWithStableKey.length !== approvedCanonical.length) {
   logger.debug('[REHYDRATE_CANONICAL]', 'raw vs canonical', { raw: approvedWithStableKey.length, canonical: approvedCanonical.length });
 }

 // B) Alias migration: before applying, build tempId -> uuid from merge so all refs can resolve.
 const UUID_REGEX_REHYDRATE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const localByKey = new Map<string, Book>();
 localApproved.forEach((b) => {
 const k = getStableBookKey(b);
 if (k) localByKey.set(k, b);
 });
 const rehydrateAliases: Record<string, string> = {};
 approvedCanonical.forEach((mergedBook) => {
 const k = mergedBook.book_key ?? getStableBookKey(mergedBook);
 if (!k) return;
 const localBook = localByKey.get(k);
 if (!localBook?.id || !mergedBook.id) return;
 if (localBook.id === mergedBook.id) return;
 if (!UUID_REGEX_REHYDRATE.test(localBook.id) && UUID_REGEX_REHYDRATE.test(mergedBook.id)) {
 rehydrateAliases[localBook.id] = mergedBook.id;
 }
 });
 if (Object.keys(rehydrateAliases).length > 0) {
 idAliasRef.current = { ...idAliasRef.current, ...rehydrateAliases };
 const aliasKey = `approved_book_id_aliases_${user.uid}`;
 await AsyncStorage.setItem(aliasKey, JSON.stringify(idAliasRef.current));
 logger.debug('[REHYDRATE_ALIAS_MIGRATION]', { count: Object.keys(rehydrateAliases).length, sample: Object.entries(rehydrateAliases).slice(0, 3) });
 }

 // D) Hard invariant: use canonical list for both count and booksById so no duplicate-book_key inflation.
 const booksById: Record<string, Book> = {};
 approvedCanonical.forEach((b) => {
 if (b.id) booksById[b.id] = b;
 });
 const approvedLen = approvedCanonical.length;
 const booksByIdSize = Object.keys(booksById).length;
 const everyBookHasId = approvedCanonical.every((b) => Boolean(b.id));
 const everyBookInMap = approvedCanonical.every((b) => b.id && booksById[b.id] === b);
const invariantOk = approvedLen === booksByIdSize && everyBookHasId && everyBookInMap;
if (!invariantOk) {
  // Log the violation but DO NOT fail closed. Failing closed means the UI shows
  // only the stale AsyncStorage snapshot (e.g. 7 books) instead of the merged
  // 25-book list. The invariant is most commonly violated because loadBooksFromSupabase
  // returned a partial server list (PostgREST cap), so local-only books have no DB id.
  // The correct behavior is: apply the merge (all 25 books appear), keep hasServerHydratedRef
  // false so the next rehydrate will re-check. The pagination fix in loadBooksFromSupabase
  // should eliminate this over time.
  const UUID_RE_INV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const _withDbId    = approvedCanonical.filter(b => b.id && UUID_RE_INV.test(b.id));
  const _withTempId  = approvedCanonical.filter(b => b.id && !UUID_RE_INV.test(b.id));
  const _withoutId   = approvedCanonical.filter(b => !b.id);
  const _invariantSig = `rehydrate_invariant:${approvedLen}:${booksByIdSize}:${everyBookHasId}:${everyBookInMap}`;
  logger.logOnce(_invariantSig, 'warn', '[REHYDRATE_INVARIANT_VIOLATION]', 'approvedLen !== booksById — applying merge anyway (warn-only, not fail-closed)', {
    approvedLen,
    booksByIdSize,
    everyBookHasId,
    everyBookInMap,
    // ID breakdown — the key diagnostic: withoutDbId books can never appear in booksById,
    // they are local-only and not authoritative for cleanup/verify/photo-prune decisions.
    withDbIdCount: _withDbId.length,
    withTempIdCount: _withTempId.length,
    withoutIdCount: _withoutId.length,
    tempIdSample: _withTempId.slice(0, 3).map(b => (b.id ?? '').slice(0, 20)),
    withoutIdSample: _withoutId.slice(0, 3).map(b => ({ title: (b.title ?? '').slice(0, 30), key: b.book_key?.slice(0, 24) })),
    expectedCause: _withoutId.length > 0
      ? 'books without DB UUID: server snapshot partial (photos.books NOT NULL fix will resolve) or approve id-backfill missed them'
      : 'duplicate book_keys collapsing in ensureApprovedOnePerBookKey',
    note: 'Non-blocking. UI shows all merged books. Only withDbId books are authoritative for photo-prune and verify.',
  });
  // Fall through to apply the merge — same path as invariantOk.
}
{
 hasServerHydratedRef.current = true;
 // Record this seq as applied so a future stale rehydrate cannot overwrite it.
 appliedSnapshotSeqRef.current = mySnapshotSeq;
 // Stamp commit time so focus-refresh debounce knows a snapshot just ran.
 lastSnapshotCommittedAtRef.current = Date.now();
 // Update high-water marks — only move up, never down.
 if (serverApproved.length > highWaterApprovedCountRef.current) {
   highWaterApprovedCountRef.current = serverApproved.length;
 }
 // [REHYDRATE_IDENTITY_DIFF]: approved identity must never change; log only diffs (one log per apply).
 const rehydrateChanged: Array<{ key: string; field: string; before: string | undefined; after: string | undefined; locked: boolean; source: string }> = [];
 approvedCanonical.forEach((b) => {
 const key = b.book_key ?? b.id ?? '';
 if (!key) return;
 const before = beforeByKey.get(key);
 if (!before) return;
 const identityFields: Array<{ name: string; before: string | undefined; after: string | undefined }> = [
 { name: 'book_key', before: before.book_key, after: b.book_key },
 { name: 'title', before: before.title, after: b.title },
 { name: 'author', before: before.author, after: b.author },
 { name: 'source_photo_id', before: before.source_photo_id, after: b.source_photo_id },
 { name: 'source_scan_job_id', before: before.source_scan_job_id, after: b.source_scan_job_id },
 ];
 identityFields.forEach(({ name, before: bv, after: av }) => {
 if (bv !== av) rehydrateChanged.push({ key, field: name, before: bv, after: av, locked: true, source: 'rehydrate_merge' });
 });
 });
 if (rehydrateChanged.length > 0) {
 logger.warn('[REHYDRATE_IDENTITY_DIFF]', {
 changed: rehydrateChanged,
 counts: { approvedBefore: localApproved.length, approvedAfter: approvedCanonical.length },
 });
 }
 // approvedCanonical is already one per book_key; use it for state and persist.
 const approvedToApply = approvedCanonical;
 logApprovedIdentityHealth(approvedToApply, 'rehydrate_merge');
 logCanonicalIdentityAudit(approvedToApply, idAliasRef.current, 'rehydrate_merge');
 const mergeSample = approvedToApply.slice(0, 5).map((b) => ({
 book_key: (b.book_key ?? getStableBookKey(b))?.slice(0, 24),
 dbId: b.dbId ?? b.id ?? null,
 hasDescription: !!(b.description && String(b.description).trim()),
 hasMetadataFields: !!(b.pageCount ?? b.publisher ?? b.publishedDate ?? b.categories?.length),
 }));
logger.debug('[MERGE_BOOKS]', { phase: 'rehydrate_merge', count: approvedToApply.length, sample: mergeSample });
logger.debug('[STATE_PUBLISHED]', { statePublished: 'postCanonicalize' });
logger.info('[TIMING]', { op: 'rehydrate_merge', ms: Date.now() - _rehydrateT0, counts: { approved: approvedToApply.length, pending: finalPending.length, rejected: finalRejected.length } });
// Why did local win or server win? One line explains "why did my books disappear."
const _mergeReason: string = !supabaseBooks
  ? 'first_load'
  : hasActiveBatch
    ? 'server_partial_keep_local'
    : hasApprovalGraceWindow
      ? 'server_partial_keep_local'
      : snapshotIsPartial
        ? 'server_partial_keep_local'
        : (serverApproved.length > 0 || hasRecentMutation)
          ? 'server_full'
          : 'server_full';
// Single line: server snapshot totals + partial detection + merge outcome.
// Replaces the former separate SERVER_SNAPSHOT_SUMMARY + MERGE_DECISION pair.
logger.info('[SNAPSHOT_MERGE]', {
  source: _snapSource,
  ok: !snapshotIsPartial,
  mergeReason: _mergeReason,
  // Server snapshot counts (from fetch-all queries)
  serverApproved: serverApproved.length,
  serverPending: serverPending.length,
  serverPhotos: _snapPhotos,
  // Local counts before merge
  localApprovedBefore: localApproved.length,
  localPendingBefore: localPending.length,
  localPhotosBefore: _localPhotosNow,
  // Merged result counts (what gets written to state)
  localApprovedAfter: approvedToApply.length,
  localPendingAfter: finalPending.length,
  // Partial snapshot flags
  snapshotIsPartial,
  partialReason: snapshotIsPartial
    ? [
        _serverApprovedZero            ? `books_zero(local=${_localApprovedNow})` : null,
        _serverPhotosZero              ? `photos_zero(local=${_localPhotosNow})` : null,
        _serverApprovedSuspiciouslyLow ? `books_low(srv=${serverApproved.length}<local=${_localApprovedNow})` : null,
        _serverPhotosSuspiciouslyLow   ? `photos_low(srv=${_snapPhotos}<local=${_localPhotosNow})` : null,
        _noIdBooksWithZeroServer       ? `no_id_zero_srv(noId=${approvedBooksWithNoId})` : null,
        _serverApprovedZeroButPhotosHaveBooks ? `books_zero_but_photos_attach(totalAttached=${totalAttachedBooksFromPhotos})` : null,
      ].filter(Boolean).join('; ')
    : null,
  // Context flags
  hasActiveBatch,
  hasApprovalGraceWindow,
  hasRecentMutation,
  userIdPrefix: user.uid.slice(0, 8),
  latencyMs: Date.now() - _rehydrateT0,
});

// ── Drop detection (B from data-safety spec) ──────────────────────────────
// Check whether the server snapshot is suspiciously lower than our high-water
// marks. If so, keep local state and emit a warning banner — don't silently wipe.
// One-time boot diagnostic: cacheEpoch, isFreshInstall, highWaterPhotos, localPhotosCount.
logger.logOnce('safety_boot', 'info', '[SAFETY_BOOT]', 'cacheEpoch, isFreshInstall, highWaterPhotos, localPhotosCount', {
  cacheEpoch: safetyEpochRef.current?.slice(0, 8) ?? null,
  isFreshInstall: isFreshInstallThisSessionRef.current,
  highWaterApproved: highWaterApprovedCountRef.current,
  highWaterPhotos: highWaterPhotosCountRef.current,
  localPhotosCount: localDeduped.length,
});
// Use the most recent destructive action from either the persisted ref (loaded at
// boot from AsyncStorage) or the in-session module-level record (updated on the
// same run by logDeleteAudit) — whichever is newer.
const _inSessionAction = getLastDestructiveAction(user.uid);
const _persistedAction = lastDestructiveActionRef.current;
const _effectiveLastAction = (
  _inSessionAction && (!_persistedAction || _inSessionAction.at > _persistedAction.at)
) ? _inSessionAction : _persistedAction;
const _dropCheck = checkForSuspiciousDrop({
  serverApproved: serverApproved.length,
  serverPhotos: _snapPhotos ?? 0,
  highWaterApproved: highWaterApprovedCountRef.current,
  highWaterPhotos: highWaterPhotosCountRef.current,
  lastDestructiveAction: _effectiveLastAction,
  totalAttachedBooks: totalAttachedBooksFromPhotos,
  isFreshInstallOrCacheReset: justResetBaselinesRef.current,
  localApprovedCount: localApproved.length,
  localPhotosCount: localDeduped.length,
});
if (justResetBaselinesRef.current) justResetBaselinesRef.current = false;
if (_dropCheck.suspicious) {
  logger.warn('[DATA_SAFETY_DROP]', 'suspicious count drop — keeping local, not overwriting', _dropCheck);
  if (__DEV__) (global as any).__dataSafetyDropLast = _dropCheck;
  // Log-only: no sync banner shown to user.
  setDataSafetySyncIssue(null);
} else {
  setDataSafetySyncIssue(null);
  logger.info('[SAFETY_ACCEPT]', 'guard did not fire — accepting snapshot', {
    reason: _dropCheck.reason,
    serverApproved: serverApproved.length,
    serverPhotos: _snapPhotos ?? 0,
  });
}

// ── Persist updated high-water marks ─────────────────────────────────────
// Only persist when we have a trustworthy (non-partial) snapshot so we don't
// lower the bar on a glitch fetch.
if (!snapshotIsPartial && !_dropCheck.suspicious) {
  const newHWApproved = Math.max(serverApproved.length, highWaterApprovedCountRef.current);
  const newHWPhotos = Math.max(_snapPhotos ?? 0, highWaterPhotosCountRef.current);
  if (newHWApproved > highWaterApprovedCountRef.current) highWaterApprovedCountRef.current = newHWApproved;
  if (newHWPhotos > highWaterPhotosCountRef.current) highWaterPhotosCountRef.current = newHWPhotos;
  saveHighWaterMark(user.uid, {
    approved: highWaterApprovedCountRef.current,
    photos: highWaterPhotosCountRef.current,
  }).catch(() => {});
}

// Ingest with ONE canonical photoId everywhere so grid/map never miss (alias vs canonical mismatch).
const pendingNormalized = resolveBookPhotoIdsCb(finalPending, 'rehydrate');
const approvedNormalized = resolveBookPhotoIdsCb(approvedToApply, 'rehydrate');
const rejectedNormalized = resolveBookPhotoIdsCb(finalRejected, 'rehydrate');
const totalMerged = pendingNormalized.length + approvedNormalized.length + rejectedNormalized.length;

// Skip apply when merge result is effectively unchanged (stops oscillation / re-sanitize every poll).
const ids = (arr: Book[]) => new Set(arr.map((b) => b.id).filter((x): x is string => Boolean(x)));
const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));
const booksMergeUnchanged =
  approvedNormalized.length === localApproved.length &&
  pendingNormalized.length === localPending.length &&
  rejectedNormalized.length === localRejected.length &&
  sameIds(ids(approvedNormalized), ids(localApproved)) &&
  sameIds(ids(pendingNormalized), ids(localPending)) &&
  sameIds(ids(rejectedNormalized), ids(localRejected));

// Never downgrade to empty: if merge produced 0 approved but local had data and no recent authoritative action,
// protect the approved bucket only — still apply pending and rejected so the Pending screen shows server data.
if (approvedNormalized.length === 0 && localApproved.length > 0 && !isRecentAuthoritativeDestructive) {
  logger.warn('[REHYDRATE_APPLY_GUARD]', 'protecting local approved; still applying server pending/rejected so Pending screen is correct', {
    localApprovedCount: localApproved.length,
    serverApprovedCount: serverApproved.length,
    serverPendingCount: pendingNormalized.length,
    serverRejectedCount: rejectedNormalized.length,
  });
  const localCanonical = ensureApprovedOnePerBookKey(localApproved);
  // Merge server pending with local-only pending (books from recent scans not yet synced).
  // Without this, navigating away and back wipes locally-imported pending books.
  const pendingKey = (b: Book) => `${(b.title || '').toLowerCase().trim()}|${(b.author || '').toLowerCase().trim()}`;
  const serverPendingKeys = new Set(pendingNormalized.map(b => pendingKey(b)));
  const currentPending = pendingBooksRef.current;
  const localOnlyPending = currentPending.filter(b =>
    (b.status === 'pending' || b.status === 'incomplete') && !serverPendingKeys.has(pendingKey(b))
  );
  const mergedPending = [...pendingNormalized, ...localOnlyPending];
  setBooksFromBuckets(localCanonical, mergedPending, rejectedNormalized);
  await Promise.all([
    AsyncStorage.setItem(userPendingKey, JSON.stringify(pendingNormalized)),
    AsyncStorage.setItem(userApprovedKey, JSON.stringify(localCanonical)),
    AsyncStorage.setItem(userRejectedKey, JSON.stringify(rejectedNormalized)),
  ]);
  refreshProfileStats();
  return;
}

if (booksMergeUnchanged) {
  logger.debug('[REHYDRATE_SKIP]', 'merge result unchanged — skipping books apply to avoid oscillation', {
    approved: approvedNormalized.length,
    pending: pendingNormalized.length,
    rejected: rejectedNormalized.length,
  });
} else {
const applyRehydrateMerge = () => {
  const books = [...approvedNormalized, ...pendingNormalized, ...rejectedNormalized];
  if (DEBUG_PENDING) {
    logger.debug('[PENDING_DEBUG]', {
      total: books.length,
      pending: books.filter((b: Book) => (b as any).status === 'pending').length,
      approved: books.filter((b: Book) => (b as any).status === 'approved').length,
    });
  }
  // Merge server pending with local-only pending (books from recent scans not yet synced).
  const pKey = (b: Book) => `${(b.title || '').toLowerCase().trim()}|${(b.author || '').toLowerCase().trim()}`;
  const serverPKeys = new Set(pendingNormalized.map(b => pKey(b)));
  const currentP = pendingBooksRef.current;
  const localOnlyP = currentP.filter(b =>
    (b.status === 'pending' || b.status === 'incomplete') && !serverPKeys.has(pKey(b))
  );
  const mergedP = [...pendingNormalized, ...localOnlyP];
  logLibraryStateWrite('loadUserData_applyRehydrateMerge', {
    approved: approvedNormalized.length,
    pending: mergedP.length,
  });
  setBooksFromBuckets(approvedNormalized, mergedP, rejectedNormalized);
};
if (totalMerged > 50) {
  InteractionManager.runAfterInteractions(() => applyRehydrateMerge());
} else {
  applyRehydrateMerge();
}
 // Single-line snapshot: proves what state is actually published after rehydrate.
 // pendingSelector='books-status' = pending list is driven by pendingBooks.status, independent of photos.
 // Use once() so this fires once per session (not on every focus/sync loop).
 logger.once('pending_pipeline_rehydrate', 'info', '[PENDING_PIPELINE_SUMMARY]', 'rehydrate', {
 phase: 'rehydrate',
 totalBooks: pendingNormalized.length + approvedNormalized.length + rejectedNormalized.length,
 pendingBooksCount: pendingNormalized.length,
 pendingByStatus: {
 pending: pendingNormalized.filter(b => b.status === 'pending').length,
 incomplete: pendingNormalized.filter(b => b.status === 'incomplete').length,
 withId: pendingNormalized.filter(b => !!b.id).length,
 withoutId: pendingNormalized.filter(b => !b.id).length,
 withJobId: pendingNormalized.filter(b => !!(b as any).source_scan_job_id).length,
 withPhotoId: pendingNormalized.filter(b => !!(b as any).source_photo_id).length,
 },
 approvedBooksCount: approvedNormalized.length,
 pendingSelector: 'books-status (pendingBooks.status===pending|incomplete, independent of photos)',
 });
 // Persist merged result so we never overwrite storage with server-only (avoids dropping just-accepted when remote lags).
 await Promise.all([
 AsyncStorage.setItem(userPendingKey, JSON.stringify(pendingNormalized)),
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(approvedNormalized)),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(rejectedNormalized)),
 ]);
 // Post-apply invariants: if missingInBooksByIdCount > 0, that's the exact reason for "0 books".
 const postBooksById: Record<string, Book> = {};
 approvedNormalized.forEach((b) => {
 if (b.id) postBooksById[b.id] = b;
 });
 const missingInBooksById = approvedNormalized.filter((b) => !b.id || !postBooksById[b.id]);
 const missingInBooksByIdCount = missingInBooksById.length;
 logger.debug('[POST_REHYDRATE_INVARIANTS]', {
 approvedLen: approvedNormalized.length,
 booksByIdLen: Object.keys(postBooksById).length,
 missingInBooksByIdCount,
 missingIdsSample: missingInBooksByIdCount > 0 ? missingInBooksById.map((b) => b.id ?? '(no id)').slice(0, 10) : undefined,
 });
 // Diagnostic: always log so we can tell "save didn't happen" vs "reload overwrote".
 logger.debug('[LOAD_MERGE_APPLIED]', {
 pending: pendingNormalized.length,
 approved: approvedFiltered.length,
 rejected: rejectedNormalized.length,
 serverApproved: serverApproved.length,
 localApproved: localApproved.length,
 });
 const approvedIdStableRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const rehydrateTempIds = approvedNormalized.filter((b) => !b.id || !approvedIdStableRegex.test(b.id));
 logger.debug('[APPROVED_ID_STABILITY]', {
 approvedLen: approvedNormalized.length,
 tempIdCount: rehydrateTempIds.length,
 aliasMapSize: Object.keys(idAliasRef.current).length,
 tempIdsSample: rehydrateTempIds.map((b) => b.id).filter(Boolean).slice(0, 3),
 });
 refreshProfileStats();
}
 // Only unfreeze here for guest (no post-sync); signed-in users unfreeze in post-sync block for one swap at end.
 if (isGuestUser(user)) {
 completeRehydrate(approvedNormalized.length);
 }
 // Reconcile local-only approved: trigger sync so they get server DB ids (don't drop them).
 const rehydrateUuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const needSyncApproved = approvedNormalized.filter(
 (b) =>
 ((b as any).sync_state === 'pending' || typeof (b as any).sync_pending_at === 'number') &&
 b.id &&
 !rehydrateUuidRegex.test(b.id)
 );
 if (needSyncApproved.length > 0 && !isGuestUser(user) && session?.access_token) {
 syncPendingApprovedBooks(user.uid, needSyncApproved, {
 accessToken: session.access_token,
 apiBaseUrl: getApiBaseUrl(),
 onMerged: async (merged) => {
 if (pendingLoadRequestIdRef.current !== requestId) return;
 const toApply = ensureApprovedOnePerBookKey(merged);
 logCanonicalIdentityAudit(toApply, idAliasRef.current, 'rehydrate_sync_pending');
 logger.debug('[STATE_PUBLISHED]', { statePublished: 'postCanonicalize' });
 setApprovedBooks(toApply);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(toApply));
 refreshProfileStats();
 logger.debug('[REHYDRATE_SYNC_PENDING_APPROVED]', { mergedCount: toApply.length });
 const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const tempIds = toApply.filter((b) => !b.id || !uuidRegex.test(b.id));
 logger.debug('[APPROVED_ID_STABILITY]', {
 approvedLen: toApply.length,
 tempIdCount: tempIds.length,
 aliasMapSize: Object.keys(idAliasRef.current).length,
 tempIdsSample: tempIds.map((b) => b.id).filter(Boolean).slice(0, 3),
 });
 },
 }).catch((err) => logger.warn('[REHYDRATE_SYNC_PENDING_APPROVED]', (err as Error)?.message ?? err));
 }
 }
 } else if (__DEV__) {
 if (LOG_TRACE) logger.debug('[LOAD_USER_DATA] skip apply: stale request', { requestId, current: pendingLoadRequestIdRef.current });
 }

 }
 
 // Photos: server is source of truth replace, don't merge (prevents deleted scans from resurrecting)
 // (Handled in single block below after try/catch so we always replace when we have server data)
 
 // C) Sync on Open: import inserts new books into DB (upsert by book_key). Refetch approved/rejected after sync.
 // Step A Fix write path: save photos with jobId to Supabase BEFORE importing jobs, so scan_jobs.photo_id is set
 // and every inserted book gets source_photo_id at insert (books linked to photo: N will match, cascade delete works).
 // Photo save + adoptions run before merge (see photosWithJobEarly block); adoptions used below for photosForMerge only.
 if (adoptions.length > 0 && __DEV__ && LOG_DEBUG) {
 logger.debug('[PHOTO_ADOPT_CANONICAL]', 'adoptions already applied before merge', { count: adoptions.length });
 }
 // After sync, always load approved/rejected from Supabase so we show DB rows (dbId, description) and never local-only items.
 if (!isGuestUser(user)) {
 try {
 await syncCompletedScanJobs(user.uid);
 const refreshed = await loadBooksFromSupabase(user.uid, { milestone: 'sync_complete' });
 if (requestId !== pendingLoadRequestIdRef.current) {
 if (__DEV__ && LOG_TRACE) logger.debug('[LOAD_USER_DATA] skip post-sync apply: stale request');
 } else {
 // A) Prefer server-approved wholesale: when server has data, setApproved(server) only do NOT union with local temp ids.
 const serverApprovedList = refreshed.approved || [];
 const localApprovedPostSync: Book[] = savedApproved ? (() => { try { return JSON.parse(savedApproved); } catch { return []; } })() : [];
 const localRejectedPostSync: Book[] = savedRejected ? (() => { try { return JSON.parse(savedRejected); } catch { return []; } })() : [];
 const makeKeyPostSync = (b: Book) => getStableBookKey(b);
 // B) Only merge when server is empty (offline): by book_key, server first (wins), then local only if key not on server.
 const mergeByBookKeyOnly = (server: Book[], local: Book[]): Book[] => {
 const byKey = new Map<string, Book>();
 server.forEach((b) => {
 const k = makeKeyPostSync(b);
 if (k) byKey.set(k, { ...b, book_key: b.book_key ?? k });
 });
 local.forEach((b) => {
 const k = makeKeyPostSync(b);
 if (!k || byKey.has(k)) return; // only add local if key doesn't exist on server
 byKey.set(k, { ...b, book_key: b.book_key ?? k });
 });
 return [...byKey.values()];
 };
 const beforeByKeyPostSync = new Map<string, { book_key?: string; title: string; author?: string; source_photo_id?: string; source_scan_job_id?: string }>();
 localApprovedPostSync.forEach((b) => {
 const k = b.book_key ?? getStableBookKey(b) ?? (b.id ?? '');
 if (!k) return;
 beforeByKeyPostSync.set(k, {
 book_key: b.book_key,
 title: b.title ?? '',
 author: b.author,
 source_photo_id: b.source_photo_id,
 source_scan_job_id: b.source_scan_job_id,
 });
 });
// Field-level merge: server wins for ids/enrichment, local wins for identity (title/author).
// Never replace with server-only — that silently drops locally-approved books whose sync_state
// is still 'pending' (written before the last loadBooksFromSupabase round-trip completed).
// Follows the merge-approve-lock invariant from lib/mergeBooks.ts:
//   • key present on both → mergeBookFieldLevel (server for dbId/description, local for title/author)
//   • local-only (key not on server) → kept as-is (pending sync)
const _postSyncMakeKey = (b: Book) => getStableBookKey(b);
const _postSyncServerByKey = new Map<string, Book>();
serverApprovedList.forEach((b) => {
  const k = _postSyncMakeKey(b);
  if (k) _postSyncServerByKey.set(k, { ...b, book_key: b.book_key ?? k });
});
const _postSyncLocalOnly: Book[] = [];
localApprovedPostSync.forEach((b) => {
  const k = _postSyncMakeKey(b);
  if (!k) return;
  const serverBook = _postSyncServerByKey.get(k);
  if (!serverBook) {
    _postSyncLocalOnly.push({ ...b, book_key: b.book_key ?? k });
  } else {
    _postSyncServerByKey.set(k, mergeBookFieldLevel(serverBook, { ...b, book_key: b.book_key ?? k }, photoIdAliasRef.current));
  }
});
const approvedPostSyncCollapsed = [..._postSyncServerByKey.values(), ..._postSyncLocalOnly];
 const rejectedMerged = mergeByBookKeyOnly(refreshed.rejected || [], localRejectedPostSync);
    // Integrity check (post-sync): alias re-resolve then mark orphaned (soft) for any book
    // whose source_photo_id still cannot be matched. NEVER tombstone or delete.
    const photoIdsPostSync = new Set<string>(localDeduped.map((p: Photo) => p.id).filter((x): x is string => Boolean(x)));
    // Add canonical targets and alias keys so books holding a local/temp photoId are not
    // falsely flagged when the canonical row is present in the set.
    Object.entries(photoIdAliasRef.current).forEach(([local, canonical]) => {
      if (photoIdsPostSync.has(canonical)) photoIdsPostSync.add(local);
      else if (photoIdsPostSync.has(local)) photoIdsPostSync.add(canonical);
    });
    // PHOTO_ROW_LOOKUP: verify which photo IDs are present on server before marking orphaned.
    {
      const bookPhotoIdsPostSync = [...new Set(approvedPostSyncCollapsed.map((b) => b.source_photo_id).filter((x): x is string => Boolean(x)))];
      logPhotoRowLookup(bookPhotoIdsPostSync, 'post_sync_integrity').catch(() => {});
    }
    // Pass-through: resolve alias but never set integrity_state (action:'log_only' until stable).
    const approvedPostSyncFiltered = approvedPostSyncCollapsed.map((b) => {
      if (!b.source_photo_id) return b;
      const resolved = resolvePhotoIdLogged(b.source_photo_id, 'integrity_check');
      return resolved !== b.source_photo_id ? { ...b, source_photo_id: resolved } : b;
    });
    const newlyOrphanedPostSync = approvedPostSyncFiltered.filter((b) => {
      const id = b.source_photo_id;
      return id && !photoIdsPostSync.has(id);
    });
    if (newlyOrphanedPostSync.length > 0) {
      const missingPhotoIdsPostSync = [...new Set(newlyOrphanedPostSync.map((b) => b.source_photo_id).filter(Boolean))] as string[];
      // Summary: always, throttled.
      logger.logThrottle('integrity_post_sync_merge', 30_000, 'info', '[INTEGRITY_CLEANUP_DECISION]', 'summary', {
        phase: 'post_sync_merge',
        action: 'log_only',
        booksImpactedCount: newlyOrphanedPostSync.length,
        distinctMissingPhotoIds: missingPhotoIdsPostSync.length,
        ...(DEBUG_STACKS && { stack: new Error().stack?.split('\n').slice(1, 4).join(' | ') }),
      });
      // Detail: only when DEBUG_INTEGRITY=true.
      if (DEBUG_INTEGRITY) {
        const resolvedMissingPostSync = missingPhotoIdsPostSync.map((id) => resolvePhotoIdLogged(id, 'integrity_check') ?? id);
        logger.info('[INTEGRITY_CLEANUP_DECISION]', {
          phase: 'post_sync_merge',
          missingPhotoIds: missingPhotoIdsPostSync.slice(0, 5).map((id) => id.slice(0, 8)),
          resolvedMissingPhotoIds: resolvedMissingPostSync.slice(0, 5).map((id) => id.slice(0, 8)),
          reason: 'photo_missing_in_local_cache',
          booksImpactedSample: newlyOrphanedPostSync.slice(0, 5).map((b) => ({
            bookId: (b.id ?? '').slice(0, 8),
            photoIdReferenced: (b.source_photo_id ?? '').slice(0, 8),
            wasPhotoIdAliased: b.source_photo_id !== resolvePhotoIdLogged(b.source_photo_id ?? '', 'integrity_check'),
            resolvedPhotoId: (resolvePhotoIdLogged(b.source_photo_id ?? '', 'integrity_check') ?? '').slice(0, 8),
          })),
        });
      }
    }
 const approvedPostSyncWithKey = approvedPostSyncFiltered.map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) }));
 const postSyncChanged: Array<{ key: string; field: string; before: string | undefined; after: string | undefined; locked: boolean; source: string }> = [];
 approvedPostSyncWithKey.forEach((b) => {
 const key = b.book_key ?? b.id ?? '';
 if (!key) return;
 const before = beforeByKeyPostSync.get(key);
 if (!before) return;
 const identityFields: Array<{ name: string; before: string | undefined; after: string | undefined }> = [
 { name: 'book_key', before: before.book_key, after: b.book_key },
 { name: 'title', before: before.title, after: b.title },
 { name: 'author', before: before.author, after: b.author },
 { name: 'source_photo_id', before: before.source_photo_id, after: b.source_photo_id },
 { name: 'source_scan_job_id', before: before.source_scan_job_id, after: b.source_scan_job_id },
 ];
 identityFields.forEach(({ name, before: bv, after: av }) => {
 if (bv !== av) postSyncChanged.push({ key, field: name, before: bv, after: av, locked: true, source: 'post_sync_merge' });
 });
 });
 if (postSyncChanged.length > 0) {
 logger.warn('[REHYDRATE_IDENTITY_DIFF]', {
 changed: postSyncChanged,
 counts: { approvedBefore: localApprovedPostSync.length, approvedAfter: approvedPostSyncWithKey.length },
 });
 }
 // One canonical list for count, state, and persist (no duplicate book_key inflation).
 const approvedPostSyncToPersist = ensureApprovedOnePerBookKey(approvedPostSyncWithKey);
 logApprovedIdentityHealth(approvedPostSyncToPersist, 'post_sync_merge');
 logCanonicalIdentityAudit(approvedPostSyncToPersist, idAliasRef.current, 'post_sync_merge');
 const postSyncMergeSample = approvedPostSyncToPersist.slice(0, 5).map((b) => ({
 book_key: (b.book_key ?? getStableBookKey(b))?.slice(0, 24),
 dbId: b.dbId ?? b.id ?? null,
 hasDescription: !!(b.description && String(b.description).trim()),
 hasMetadataFields: !!(b.pageCount ?? b.publisher ?? b.publishedDate ?? b.categories?.length),
 }));
 logger.debug('[MERGE_BOOKS]', { phase: 'post_sync_merge', count: approvedPostSyncToPersist.length, sample: postSyncMergeSample });
 logger.debug('[STATE_PUBLISHED]', { statePublished: 'postMerge' });
 hasServerHydratedRef.current = true;
 lastApprovedUpdateSourceRef.current = 'post_sync_merge';
 setApprovedBooks(approvedPostSyncToPersist);
 setRejectedBooks(rejectedMerged);
 const postSyncUuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const postSyncTempIds = approvedPostSyncToPersist.filter((b) => !b.id || !postSyncUuidRegex.test(b.id));
 logger.debug('[APPROVED_ID_STABILITY]', {
 approvedLen: approvedPostSyncToPersist.length,
 tempIdCount: postSyncTempIds.length,
 aliasMapSize: Object.keys(idAliasRef.current).length,
 tempIdsSample: postSyncTempIds.map((b) => b.id).filter(Boolean).slice(0, 3),
 });
 const userApprovedKey = `approved_books_${user.uid}`;
 const userRejectedKey = `rejected_books_${user.uid}`;
 await Promise.all([
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(approvedPostSyncToPersist)),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(rejectedMerged)),
 ]);
 refreshProfileStats();
 completeRehydrate(approvedPostSyncToPersist.length);
 }
 } catch (syncErr) {
 logger.warn('Sync completed scan jobs:', syncErr);
 }
 }

 // Covers are resolved in worker; client shows book.coverUrl or placeholder
 } catch (supabaseError: any) {
 const classified = classifySupabaseError(supabaseError);
 logger.error('Supabase load failed (inner)', {
   message: classified.message,
   code: classified.code,
   details: classified.details,
   kind: classified.kind,
 });
 consecutiveSupabaseFailuresRef.current = (consecutiveSupabaseFailuresRef.current + 1) | 0;
 if (consecutiveSupabaseFailuresRef.current >= SUPABASE_FAILURES_THRESHOLD) {
   supabaseHealthyRef.current = false;
   lastSupabaseFailureAtRef.current = Date.now();
   logger.warn('[SUPABASE_CIRCUIT_BREAKER]', 'backend marked unhealthy after N failures', { count: consecutiveSupabaseFailuresRef.current });
 }
 }
 
 // Server is source of truth: merge with local tombstones (never resurrect locally-deleted scans)
 const deletedIdsKey = `deleted_photo_ids_${user.uid}`;
 let deletedPhotoIds = new Set<string>();
 try {
 const saved = await AsyncStorage.getItem(deletedIdsKey);
 if (saved) {
 const arr = JSON.parse(saved);
 if (Array.isArray(arr)) deletedPhotoIds = new Set(arr);
 }
 } catch (_) { /* ignore */ }
 if (supabasePhotos && supabasePhotos.length > 0) {
 // Filter server photos: reject discarded/deleted and photos with no usable URL.
 // Any rejected photo gets purged from local state so it never resurrects via cached signed URL.
 //
 // INVARIANT: if a photo has approved or pending books attached it must NEVER be dropped or
 // tombstoned, regardless of storage state. Dropping it causes those books to lose their
 // parent photo reference and disappear from the UI until a full rehydrate.
 const DISPLAYABLE_STATUSES = new Set(['complete', 'draft', undefined, null]);
 const corruptServerPhotoIds: string[] = [];

 // Build fast-lookup set of photo IDs that currently have books (approved or pending).
 // Uses the in-memory state at merge time — safe because this runs inside loadUserData
 // which always has the latest approvedBooks/pendingBooks from the closure.
 const _photoIdsWithBooks = new Set<string>(
   [
     ...(approvedBooks ?? []).map(b => (b as any).source_photo_id as string | undefined),
     ...(pendingBooks  ?? []).map(b => (b as any).source_photo_id as string | undefined),
   ].filter((id): id is string => Boolean(id))
 );

 const dbPhotos = supabasePhotos.filter(photo => {
 if (deletedPhotoIds.has(photo.id ?? '')) return false;

 // Reject discarded photos — unless they still have books attached.
 // A photo with books must stay renderable so the book cards don't orphan.
 const photoStatus = (photo as any).status ?? null;
 const _hasBooks = !!(photo.id && _photoIdsWithBooks.has(photo.id));
 if (photoStatus === 'discarded' || photoStatus === 'rejected') {
   if (_hasBooks) {
     // Override: keep despite discarded status — photo still owns approved/pending books.
     logger.warn(`[PHOTO_FILTER_BOOKS_OVERRIDE] photo ${photo.id}: status=${photoStatus} but has books — keeping`, {
       photo_id: photo.id, status: photoStatus,
     });
     return true;
   }
 logger.warn(`Skipping photo ${photo.id}: status=${photoStatus} (discarded/rejected purging locally)`, {
 photo_id: photo.id, status: photoStatus,
 storage_path: (photo as any).storage_path ?? null,
 uri: photo.uri ?? null,
 });
 if (photo.id) corruptServerPhotoIds.push(photo.id);
 return false;
 }

 // Reject photos where deleted_at is set (server may have soft-deleted after query)
 const deletedAt = (photo as any).deleted_at ?? null;
 if (deletedAt) {
   if (_hasBooks) {
     logger.warn(`[PHOTO_FILTER_BOOKS_OVERRIDE] photo ${photo.id}: deleted_at set but has books — keeping`, {
       photo_id: photo.id, deleted_at: deletedAt,
     });
     return true;
   }
 logger.warn(`Skipping photo ${photo.id}: deleted_at=${deletedAt} purging locally`);
 if (photo.id) corruptServerPhotoIds.push(photo.id);
 return false;
 }

 // A photo is displayable if it has a signed/legacy http URI, OR a storage_path that can
 // produce a signed URL at display time, OR a local file:// URI (still uploading).
 // If none of those exist but the photo has books: keep it so books don't orphan.
 const hasHttpUri = photo.uri && typeof photo.uri === 'string' &&
 photo.uri.startsWith('http') && photo.uri.includes('supabase.co');
 const hasLocalUri = photo.uri && typeof photo.uri === 'string' &&
 (photo.uri.startsWith('file://') || photo.uri.startsWith('ph://') || photo.uri.startsWith('/'));
 const hasStoragePath = !!(photo as any).storage_path &&
 typeof (photo as any).storage_path === 'string' &&
 ((photo as any).storage_path as string).trim().length > 0;
 const hasLegacyUrl = !!(photo as any).storage_url &&
 typeof (photo as any).storage_url === 'string' &&
 ((photo as any).storage_url as string).startsWith('http');
 const hasValidStorage = hasHttpUri || hasLocalUri || hasStoragePath || hasLegacyUrl;

 // Do not drop when storagePath exists — photo is valid even if it has no URI (tile will use signed URL).
 if (hasStoragePath) return true;
 if (!hasValidStorage) {
 // Diagnostic: log every photo that enters the no-storage path so we can confirm
 // whether file:// photos with pending books are being caught by the books-override guard.
 if (!!(photo as any).storage_url === false && !!(photo as any).storage_path === false && photo.uri?.startsWith('file://')) {
   logger.warn('[PHOTO_DRAFT_WITH_BOOKS]', {
     id: photo.id?.slice(0, 8) ?? null,
     status: photoStatus,
     hasBooks: _hasBooks,
     booksAttachedCount: _photoIdsWithBooks.has(photo.id ?? '') ? 'yes' : 'no',
     uri: photo.uri?.slice(0, 40) ?? null,
   });
 }
// Do NOT filter out photos just because storage_path is null — those are local_pending/uploading/uploaded/processing.
const inFlightStatuses = ['local_pending', 'uploading', 'uploaded', 'processing', 'draft', 'stalled'];
if (inFlightStatuses.includes(photoStatus as string)) {
  logger.debug(`[PHOTO_IN_FLIGHT] photo ${photo.id}: status=${photoStatus}, no storage yet keeping`, {
    photo_id: photo.id,
    storage_path: (photo as any).storage_path ?? null,
    uri: photo.uri ?? null,
  });
  return true;
}
   // Override: if photo has books attached, keep it even without any storage reference.
   // The render site will fall back to a placeholder rather than dropping the photo entirely.
   if (_hasBooks) {
     logger.warn(`[PHOTO_FILTER_BOOKS_OVERRIDE] photo ${photo.id}: no storage but has books — keeping to prevent orphaned books`, {
       photo_id: photo.id,
       storage_url: (photo as any).storage_url ?? null,
       storage_path: (photo as any).storage_path ?? null,
       uri: photo.uri ?? null,
       status: photoStatus,
     });
     return true;
   }
 // If this photo ID is a known alias for a canonical server row (i.e. dedupe chose a
 // different row), it will never have storage fields under its local UUID — that is
 // expected, not corruption. The approve path rewrites photo.id to canonical, but
 // the server-fetch filter runs before that rewrite. Skip tombstoning here so the
 // photo isn't purged before the rewrite can happen.
 if (photo.id && isCanonical(resolveCanonical(photo.id)) && resolveCanonical(photo.id) !== photo.id) {
 logger.debug(`[PHOTO_ALIAS_SKIP] photo ${photo.id}: local alias for canonical ${resolveCanonical(photo.id)}, not corrupt`, {
 photo_id: photo.id,
 canonical: resolveCanonical(photo.id),
 });
 return false; // exclude the local alias row from dbPhotos (the canonical row will be present)
 }
 // Do NOT filter out photos just because storage_path is null — keep as uploading tiles (regenerate signed_url on-demand).
 logger.debug(`[PHOTO_KEEP_NO_STORAGE] photo ${photo.id}: no storage path yet, keeping for uploading tile`, {
   photo_id: photo.id,
   status: photoStatus,
 });
 return true;
 }

 return true;
 });

          // LOCAL-ONLY PURGE — no Supabase deletes here.
          // Removes discarded/corrupt photo IDs from local React state and AsyncStorage only.
          // The server already soft-deleted these rows (deleted_at is set); we're just
          // keeping the local cache consistent with the server view.
          // Covers: (1) server-discarded/no-URL photos, (2) stale local-only photos computed below.
          // Note: staleLocalIds is computed after photosForMerge — two-pass purge.
          // Pass 1: purge server-known corrupt ids right now.
          const allPurgeIds = [...corruptServerPhotoIds]; // staleLocalIds added in pass 2 below
 if (allPurgeIds.length > 0) {
 logger.warn('[PHOTO_PURGE]', `Purging ${allPurgeIds.length} discarded/corrupt photo(s) from local state`, { ids: allPurgeIds });
 setPhotos(prev => prev.filter(p => !p.id || !allPurgeIds.includes(p.id)));
 try {
 const uid = user?.uid;
 if (uid) {
 const userPhotosKey = `photos_${uid}`;
 const stored = await AsyncStorage.getItem(userPhotosKey);
 if (stored) {
 const parsed: Photo[] = JSON.parse(stored);
 const cleaned = parsed.filter(p => !p.id || !allPurgeIds.includes(p.id));
 await AsyncStorage.setItem(userPhotosKey, JSON.stringify(cleaned));
 logger.info('[PHOTO_PURGE]', `Removed ${parsed.length - cleaned.length} photo(s) from AsyncStorage`);
 }
 // Tombstone so they never get rehydrated from cache
 const saved = await AsyncStorage.getItem(deletedIdsKey);
 const tombstones: string[] = saved ? JSON.parse(saved) : [];
 const mergedTombstones = [...new Set([...tombstones, ...allPurgeIds])];
 await AsyncStorage.setItem(deletedIdsKey, JSON.stringify(mergedTombstones));
 }
 } catch (purgeErr: any) {
 logger.warn('[PHOTO_PURGE]', 'Failed to persist purge to AsyncStorage:', purgeErr?.message);
 }
 }
// Use adopted canonical photo ids so local state matches server (no orphan local-only photos).
// Also enforce that file:// photos without remote storage cannot be marked 'complete'.
const photosForMerge = (adoptions.length > 0
  ? localDeduped.map((p: Photo) => {
    const a = adoptions.find(x => p.jobId === x.jobId && p.id === x.localPhotoId);
    return a ? { ...p, id: a.canonicalPhotoId } : p;
  })
  : localDeduped
).map(enforcePhotoStorageStatus);
 // Diagnostic: show exactly which IDs are on each side before merge so we can
 // tell immediately if a deletion removed it from DB only, storage only, or locally.
 logger.debug('[PHOTOS_REHYDRATE_IDS]', {
 localIds: photosForMerge.map(p => p.id).filter(Boolean),
 remoteIds: dbPhotos.map(p => p.id).filter(Boolean),
 });

 // Merge: during approval or scan-terminal grace prefer local so just-accepted/just-imported photos
 // are not overwritten by a stale or partial server snapshot ([PHOTO_MERGE_PARTIAL_SNAPSHOT]).
 // Without the grace window, "keep local" would still run on partial snapshots but the UI could
 // flicker between local and server truth; the grace window locks it down during mutations.
 const APPROVE_GRACE_MS_PHOTOS = 15 * 1000;
 const hasApprovalGraceWindowPhotos =
   Date.now() - lastApprovedAtRef.current < APPROVE_GRACE_MS_PHOTOS ||
   (approvalGraceUntilRef.current > 0 && Date.now() < approvalGraceUntilRef.current) ||
   (scanTerminalGraceUntilRef.current > 0 && Date.now() < scanTerminalGraceUntilRef.current);
 const serverPhotoIds = new Set(dbPhotos.map(p => p.id).filter(Boolean));
 const localPendingNotOnServer = photosForMerge.filter(
 (p) => ((p as any).sync_state === 'pending' || (p as any).sync_pending_at) && !(p.id && serverPhotoIds.has(p.id))
 );

// Partial-snapshot guard: any signal that the server list is incomplete → force local-wins.
//
// We check BOTH the pre-filter raw count (_snapPhotos) AND the post-filter dbPhotos count.
// They can diverge: e.g. server returned 4 photos but 3 failed the storage filter →
// dbPhotos.length=1, _snapPhotos=4. In that case snapshotIsPartial would NOT fire
// (4 is not < 50% of local), but the post-filter count IS lower than local — still partial.
//
// Only treat as partial when server is dramatically fewer (< 50%), not any-fewer.
// Stops oscillation: every poll where server is 1 behind no longer triggers "keep local" + re-sanitize.
const serverReturnedZeroPhotos = dbPhotos.length === 0 && photosForMerge.length > 0;
const serverReturnedFewerPhotosThanLocal =
  photosForMerge.length > 0 && dbPhotos.length < Math.max(1, Math.floor(photosForMerge.length * 0.5));
const photoSnapshotIsPartial =
  serverReturnedZeroPhotos ||
  serverReturnedFewerPhotosThanLocal ||
  snapshotIsPartial;

if (photoSnapshotIsPartial) {
  // Escalate to error when a zero-snapshot or "any-fewer" trigger fired (strongest signals).
  const isZeroTrigger = serverReturnedZeroPhotos || _serverApprovedZero || _serverPhotosZero;
  const logFn = (isZeroTrigger || serverReturnedFewerPhotosThanLocal) ? logger.error : logger.warn;
  logFn('[PHOTO_MERGE_PARTIAL_SNAPSHOT]', 'server snapshot untrusted for photos — keeping local (partial snapshot guard)', {
    localCount: photosForMerge.length,
    serverCountRaw: supabasePhotos?.length ?? 0,
    serverCountPostFilter: dbPhotos.length,
    snapshotIsPartial,
    serverReturnedZeroPhotos,
    serverReturnedFewerPhotosThanLocal,
    trigger: [
      serverReturnedZeroPhotos          ? 'photos_zero_direct' : null,
      serverReturnedFewerPhotosThanLocal ? `photos_fewer: server=${dbPhotos.length} < local=${photosForMerge.length}` : null,
      _serverPhotosZero                 ? 'photos_zero_shared' : null,
      _serverApprovedZero               ? 'books_zero' : null,
      _serverApprovedSuspiciouslyLow    ? 'books_low_50pct' : null,
      _serverPhotosSuspiciouslyLow      ? 'photos_low_50pct' : null,
      _noIdBooksWithZeroServer          ? 'no_id_books_zero_server' : null,
    ].filter(Boolean).join('+'),
    userId: user.uid.slice(0, 8),
    hint: 'Likely cause: RLS session gap, photos.books NOT NULL constraint, or storage filter dropping valid photos. Check SESSION_GUARD and FETCH_ALL_PHOTOS logs.',
  });
}

const merged = (hasApprovalGraceWindowPhotos || photoSnapshotIsPartial)
? mergePhotosPreferLocal(photosForMerge, dbPhotos)
: mergePhotosPreferRemote(photosForMerge, dbPhotos);
 // Preserve client-only fields and match identity by canonical id / storage_path / hash so same photo isn't complete then draft.
 const resolveToCanonicalId = (id: string) => photoIdAliasRef.current[id] ?? id;
 const mergedWithUris = mergePreserveLocalUris(merged, photosForMerge, resolveToCanonicalId);
 const mergedWithPending = localPendingNotOnServer.length > 0 ? dedupBy([...mergedWithUris, ...localPendingNotOnServer], photoStableKey) : mergedWithUris;
 // Also purge from merged list: any photo that the server reported as discarded/corrupt.
 // This prevents local-only signed URLs from resurrecting photos the server has discarded.
 const corruptIdSet = new Set(corruptServerPhotoIds);

// PHOTO_STALE_LOCAL_PURGE — DISABLED.
// Root cause: loadPhotosFromSupabase returns a partial server list (capped by PostgREST
// max-rows). Any photo not in that partial list looks "local-only" and gets purged, even
// though it actually exists on the server. This destroys real photos.
// Rule: never auto-purge local photos based on a server list unless that list is provably
// complete (pagination finished, row count matches server COUNT(*)).
// Until pagination is verified complete, treat all local-only photos as valid.
const staleLocalIds = new Set<string>(); // always empty — purge disabled
const pendingPhotoIdSet = new Set<string>(
pendingBooks
  .map(b => (b as any).source_photo_id as string | undefined)
  .filter((id): id is string => Boolean(id))
);
const localOnlyIdSet = new Set(
photosForMerge
  .filter(p => p.id && !serverPhotoIds.has(p.id))
  .map(p => p.id)
  .filter((id): id is string => Boolean(id))
);
if (localOnlyIdSet.size > 0) {
  logger.info('[PHOTO_LOCAL_ONLY_KEPT]', `${localOnlyIdSet.size} local-only photo(s) retained (purge disabled until full snapshot verified)`, {
    ids: [...localOnlyIdSet].slice(0, 5),
    hasPendingBooks: [...localOnlyIdSet].some(id => pendingPhotoIdSet.has(id)),
    taggedNeedsRepair: photoSnapshotIsPartial,
  });
}

// Tag local-only photos as needs_server_repair when the snapshot was partial.
// This makes it explicit in the data that these photos need a full server re-check —
// they are not orphans, the server just didn't return them this cycle.
// On the next successful full snapshot these tags will be cleared by the merge
// (server row found → no longer local-only → tag not applied).
const withoutTombstones = mergedWithPending
  .filter(p =>
    !deletedPhotoIds.has(p.id ?? '') &&
    !corruptIdSet.has(p.id ?? '') &&
    !staleLocalIds.has(p.id ?? '')
  )
  .map(p => {
    if (photoSnapshotIsPartial && p.id && localOnlyIdSet.has(p.id)) {
      return { ...p, needs_server_repair: true } as Photo;
    }
    return p;
  });
 const onePerJob = dedupePhotosByJobId(withoutTombstones);
 const mergedFromLocal = onePerJob.filter(p => photosForMerge.some(l => l.id === p.id)).length;
 const mergedFromRemote = onePerJob.filter(p => dbPhotos.some(d => d.id === p.id)).length;
 const droppedLocal = photosForMerge.length - mergedFromLocal;
 const droppedRemote = dbPhotos.length - mergedFromRemote;
 const photosMergeFavorsLocal = onePerJob.length > dbPhotos.length;
 const localPhotoIdSet = new Set<string>(photosForMerge.map((p) => p.id).filter((x): x is string => Boolean(x)));
 const dbPhotoIdSet = new Set<string>(dbPhotos.map((p) => p.id).filter((x): x is string => Boolean(x)));
 const localOnlyPhotoIds: string[] = [...localPhotoIdSet].filter((id) => !dbPhotoIdSet.has(id));
 const dbOnlyPhotoIds: string[] = [...dbPhotoIdSet].filter((id) => !localPhotoIdSet.has(id));
 const localHashSet = new Set<string>(photosForMerge.map((p) => p.photoFingerprint).filter((x): x is string => Boolean(x)));
 const dbHashSet = new Set<string>(dbPhotos.map((p) => p.photoFingerprint).filter((x): x is string => Boolean(x)));
 const localOnlyHashes: string[] = [...localHashSet].filter((h) => !dbHashSet.has(h));
 const dbOnlyHashes: string[] = [...dbHashSet].filter((h) => !localHashSet.has(h));
 // Log photos that were skipped by the server-side URL filter (not in dbPhotos but were in supabasePhotos)
 const dbPhotoIdSetForLog = new Set(dbPhotos.map(p => p.id));
 const skippedByUrlFilter = supabasePhotos.filter(p => !dbPhotoIdSetForLog.has(p.id ?? ''));
 if (skippedByUrlFilter.length > 0) {
 logger.warn('[PHOTO_FILTER_SKIPPED]', `${skippedByUrlFilter.length} server photo(s) skipped (no valid storage URL):`, {
 count: skippedByUrlFilter.length,
 skipped: skippedByUrlFilter.map(p => ({
 id: p.id,
 storage_url: (p as any).storage_url ?? null,
 storage_path: (p as any).storage_path ?? null,
 uri: p.uri ?? null,
 status: (p as any).status ?? null,
 deleted_at: (p as any).deleted_at ?? null,
 })),
 });
 }

 // Log local-only photos (exist locally but not in the server snapshot).
 // IMPORTANT: if serverTotal > dbPhotos.length (snapshot is incomplete due to RLS or
 // PostgREST max-rows cap), these IDs may exist on the server — they are NOT real orphans.
 // Look for FETCH_ALL_PHOTOS SNAPSHOT_MISMATCH above in logs to detect that case.
 // The stale-purge is disabled so these are KEPT regardless.
 if (localOnlyPhotoIds.length > 0) {
 const localOnlyDetails = photosForMerge
 .filter(p => p.id && localOnlyPhotoIds.includes(p.id))
 .map(p => ({
 id: p.id,
 storage_url: (p as any).storage_url ?? null,
 storage_path: (p as any).storage_path ?? null,
 uri: p.uri ?? null,
 status: (p as any).status ?? null,
 deleted_at: (p as any).deleted_at ?? null,
 booksCount: (p as any).books?.length ?? 0,
 source: 'local-only',
 }));
 logger.warn('[PHOTO_LOCAL_ONLY]', `${localOnlyPhotoIds.length} local-only photo(s) not in server snapshot (KEPT — purge disabled):`, {
 count: localOnlyPhotoIds.length,
 serverSnapshotSize: dbPhotos.length,
 localPhotosSize: photosForMerge.length,
 note: 'If serverSnapshotSize is unexpectedly low, check FETCH_ALL_PHOTOS SNAPSHOT_MISMATCH — photos may exist on server but were not returned (RLS / max-rows cap).',
 photos: localOnlyDetails,
 });
 }

const photosSummary = `photos local=${photosForMerge.length} remote=${dbPhotos.length} merged=${onePerJob.length} localOnly=${localOnlyPhotoIds.length} dbOnly=${dbOnlyPhotoIds.length}`;
logger.once('REHYDRATE_SUMMARY_PHOTOS', 'debug', '[REHYDRATE_SUMMARY]', photosSummary, {
localPhotos: photosForMerge.length,
dbPhotos: dbPhotos.length,
mergedPhotos: onePerJob.length,
localOnlyCount: localOnlyPhotoIds.length,
dbOnlyCount: dbOnlyPhotoIds.length,
mergedPhotoIds: onePerJob.map(p => p.id).filter(Boolean),
...(LOG_DEBUG && (localOnlyPhotoIds.length > 0 || dbOnlyPhotoIds.length > 0) && {
localOnlyIdsSample: localOnlyPhotoIds.slice(0, 5),
dbOnlyIdsSample: dbOnlyPhotoIds.slice(0, 5),
}),
});
// Why did local win or server win for photos? "droppedLocalPhotosCount" catches the case where
// server returned 0/few photos and merge silently dropped local entries.
const _photoMergeReason: string =
  photoSnapshotIsPartial
    ? 'server_partial_keep_local'
    : hasApprovalGraceWindowPhotos
      ? 'approval_grace_keep_local'
      : !supabasePhotos || supabasePhotos.length === 0
        ? 'first_load'
        : 'server_full';
const _droppedLocalPhotos = photosForMerge.filter(p => p.id && !onePerJob.some(o => o.id === p.id));
logger.debug('[MERGE_DECISION]', {
  kind: 'photos',
  reason: _photoMergeReason,
  serverPhotos: dbPhotos.length,
  localPhotosBefore: photosForMerge.length,
  localPhotosAfter: onePerJob.length,
  droppedLocalPhotosCount: _droppedLocalPhotos.length,
  droppedLocalPhotosSample: _droppedLocalPhotos.slice(0, 3).map(p => p.id),
  localOnlyKept: localOnlyPhotoIds.length,
});

// Single pipeline summary: every stage from raw server fetch to setPhotos call in one record.
// "why did I end up with N photos?" is answerable by reading this one line.
{
  // Stage 1: raw server rows → dbPhotos (filter step)
  const _droppedDiscarded = supabasePhotos.filter(p => {
    const s = (p as any).status;
    return s === 'discarded' || s === 'rejected';
  }).length;
  const _droppedDeletedAt = supabasePhotos.filter(p => !!(p as any).deleted_at).length;
  const _droppedNoStorage = supabasePhotos.filter(p => {
    const s = (p as any).status;
    if (s === 'discarded' || s === 'rejected') return false;
    if (!!(p as any).deleted_at) return false;
    const hasHttpUri = p.uri && typeof p.uri === 'string' && p.uri.startsWith('http');
    const hasStoragePath = !!(p as any).storage_path && ((p as any).storage_path as string).trim().length > 0;
    const hasLegacyUrl = !!(p as any).storage_url && ((p as any).storage_url as string).startsWith('http');
    // Do not count as dropped when storagePath exists (tile can render via signed URL).
    if (hasStoragePath) return false;
    return !(hasHttpUri || hasLegacyUrl) && s !== 'draft' && s !== 'stalled';
  }).length;
  // Stage 2: after tombstones + dedupeByJobId
  const _droppedTombstoned = mergedWithPending.length - withoutTombstones.length;
  const _droppedByJobDedupe = withoutTombstones.length - onePerJob.length;
  // Stage 3: invariant — local photos whose IDs have no match in the final list
  const _missingPhotoRowCount = photosForMerge.filter(
    p => p.id && !onePerJob.some(o => o.id === p.id)
  ).length;

  logger.info('[PHOTO_RENDER_PIPELINE]', {
    // Raw server fetch
    serverPhotosRaw: supabasePhotos.length,
    // Filter step (supabasePhotos → dbPhotos)
    droppedDiscardedOrRejected: _droppedDiscarded,
    droppedDeletedAt: _droppedDeletedAt,
    droppedNoStorage: _droppedNoStorage,
    dbPhotosAfterFilter: dbPhotos.length,
    // Merge step (photosForMerge + dbPhotos → merged → mergedWithPending)
    localPhotosBeforeMerge: photosForMerge.length,
    photoSnapshotIsPartial,
    mergeStrategy: _photoMergeReason,
    mergedCount: mergedWithPending.length,
    localPendingNotOnServerAdded: localPendingNotOnServer.length,
    // Post-merge cleanup
    droppedTombstoned: _droppedTombstoned,
    droppedByJobDedupe: _droppedByJobDedupe,
    // Final state set
    finalPhotosCount: onePerJob.length,
    needsServerRepairCount: onePerJob.filter(p => !!(p as any).needs_server_repair).length,
    // Invariant: local photos that didn't make it into final list
    missingPhotoRowCount: _missingPhotoRowCount,
    localOnlyKeptCount: localOnlyPhotoIds.length,
    skippedByUrlFilterCount: skippedByUrlFilter.length,
  });
}
// Ingest with ONE canonical photoId so grid/map never miss (alias vs canonical mismatch).
const photosNormalized = normalizePhotosToCanonicalIds(onePerJob);

// Never downgrade local photos to zero just because server returned 0. Only delete locally if server explicitly says deleted_at or we have a local tombstone.
const _photosActionForEmpty = getLastDestructiveAction(user.uid);
const _photosPersistedForEmpty = lastDestructiveActionRef.current;
const _effectivePhotosAction = (_photosActionForEmpty && (!_photosPersistedForEmpty || _photosActionForEmpty.at > _photosPersistedForEmpty.at)) ? _photosActionForEmpty : _photosPersistedForEmpty;
const isRecentAuthoritativeDestructivePhotos = _effectivePhotosAction != null
  && (AUTHORITATIVE_DESTRUCTIVE_REASONS as readonly string[]).includes(_effectivePhotosAction.reason)
  && (Date.now() - _effectivePhotosAction.at) < AUTHORITATIVE_DESTRUCTIVE_MS;

const wouldApplyEmptyPhotos = photosNormalized.length === 0 && photosForMerge.length > 0;
const photoIdsMerged = new Set(photosNormalized.map((p) => p.id).filter((x): x is string => Boolean(x)));
const photoIdsLocal = new Set(photosForMerge.map((p) => p.id).filter((x): x is string => Boolean(x)));
const photosMergeUnchanged = photosNormalized.length === photosForMerge.length && photoIdsMerged.size === photoIdsLocal.size && [...photoIdsMerged].every((id) => photoIdsLocal.has(id));

if (wouldApplyEmptyPhotos && !isRecentAuthoritativeDestructivePhotos) {
  logger.warn('[REHYDRATE_APPLY_GUARD]', 'refusing to apply empty photos — local had data, no recent authoritative action (transient empty server snapshot)', {
    localPhotosCount: photosForMerge.length,
    serverPhotosCount: dbPhotos.length,
  });
} else if (photosMergeUnchanged) {
  logger.debug('[REHYDRATE_SKIP]', 'photos merge result unchanged — skipping setPhotos to avoid oscillation', {
    count: photosNormalized.length,
  });
} else {
  logLibraryStateWrite('loadUserData_photos_merge', { photos: photosNormalized.length });
  photosNormalized.slice(0, 15).forEach((merged) => {
    const photoId = merged.id ?? '';
    logger.cat('[PHOTO_MERGE_DEBUG]', '', {
      photoId: photoId.slice(0, 8),
      status: merged.status,
      hasStoragePath: !!merged.storage_path,
      hasLocalUri: !!((merged as { localThumbUri?: string }).localThumbUri ?? (merged as { fallbackUri?: string }).fallbackUri ?? (merged.uri?.startsWith('file://') || merged.uri?.startsWith('ph://'))),
      hasSigned: !!(photoId && signedUrlMap[photoId]),
    }, 'trace');
  });
  if (photosNormalized.length > 15) {
    logger.cat('[PHOTO_MERGE_DEBUG]', '', { andNMore: photosNormalized.length - 15 }, 'trace');
  }
  setPhotos(photosNormalized);
  // Update photo high-water mark so empty-snapshot guard can catch RLS glitches.
  if (dbPhotos.length > highWaterPhotosCountRef.current) {
    highWaterPhotosCountRef.current = dbPhotos.length;
  }
  await AsyncStorage.setItem(userPhotosKey, JSON.stringify(photosNormalized));

  // Pre-fetch signed URLs for photos missing them — runs in background so tiles don't show "Loading…" on sign-in.
  // This covers first-time sign-in (server photos have no signed_url) and expired URLs (returning users).
  const PREFETCH_EXPIRY_SEC = 60 * 60 * 24 * 365; // 1 year
  const needsUrl = photosNormalized.filter(
    (p) => p.storage_path?.trim() && (!p.signed_url || !p.signed_url_expires_at || p.signed_url_expires_at < Date.now())
  );
  if (needsUrl.length > 0) {
    (async () => {
      const batchSize = 4;
      for (let i = 0; i < needsUrl.length; i += batchSize) {
        const batch = needsUrl.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (photo) => {
            try {
              const url = await getSignedPhotoUrl(photo.storage_path!.trim(), PREFETCH_EXPIRY_SEC);
              upsertPhotoSignedUrl(photo.id, url, PREFETCH_EXPIRY_SEC);
            } catch { /* tile will retry on its own */ }
          })
        );
      }
    })().catch(() => {});
  }
}
 logger.debug('[SYNC_RESTORE]', 'restore cycle', { localPhotos: photosForMerge.length, serverPhotos: dbPhotos.length, merged: onePerJob.length, localPending: storagePending });
 // Photos side of the pipeline pair with [PENDING_PIPELINE_SUMMARY] phase:rehydrate above.
 // photosFilteredCount = photos that passed the Library Photos filter (status=complete + approved match).
 // Pending section does NOT use this number; it reads pendingBooks state directly.
 logger.debug('[PENDING_PIPELINE_SUMMARY]', {
 phase: 'photos_merge',
 totalPhotosMerged: onePerJob.length,
 localPhotos: photosForMerge.length,
 remotePhotos: dbPhotos.length,
 draftPhotos: onePerJob.filter(p => (p as any).status === 'draft').length,
 completePhotos: onePerJob.filter(p => (p as any).status === 'complete').length,
 });
 }
 // If no Supabase photos, we already set from storage above do not set again (no append, no double-count)

 
 // Also load folders from AsyncStorage (folders not yet in Supabase)
 const userFoldersKey = `folders_${user.uid}`;
 const savedFolders = await AsyncStorage.getItem(userFoldersKey);
 if (savedFolders) {
 try {
 const parsed = JSON.parse(savedFolders);
 // Deduplicate folders by ID
 const seen = new Map<string, Folder>();
 const deduplicated = parsed.filter((folder: Folder) => {
 if (!folder.id) return false;
 if (seen.has(folder.id)) {
 logger.warn(`Duplicate folder ID found: ${folder.id}, keeping first occurrence`);
 return false;
 }
 seen.set(folder.id, folder);
 return true;
 });
 setFolders(deduplicated);
 } catch (e) {
 logger.error('Error parsing folders:', e);
 }
 }
 
 // Books: we persist merged (finalPending/finalApproved/finalRejected) inside the supabaseBooks block above, never server-only.
 // Photos: we already persisted merge(storage, db) above when supabasePhotos had data; do not overwrite with server-only.
 } // Close else block
 
 } catch (error) {
 const classified = classifySupabaseError(error);
 logger.error('Error loading user data from Supabase, falling back to AsyncStorage', {
   message: classified.message,
   code: classified.code,
   details: classified.details,
   kind: classified.kind,
 });
 consecutiveSupabaseFailuresRef.current = (consecutiveSupabaseFailuresRef.current + 1) | 0;
 if (consecutiveSupabaseFailuresRef.current >= SUPABASE_FAILURES_THRESHOLD) {
   supabaseHealthyRef.current = false;
   lastSupabaseFailureAtRef.current = Date.now();
   logger.warn('[SUPABASE_CIRCUIT_BREAKER]', 'backend marked unhealthy after N failures', { count: consecutiveSupabaseFailuresRef.current });
 }

 // Fallback to AsyncStorage if Supabase fails
 try {
 const userPendingKey = `pending_books_${user.uid}`;
 const userApprovedKey = `approved_books_${user.uid}`;
 const userRejectedKey = `rejected_books_${user.uid}`;
 const userPhotosKey = `photos_${user.uid}`;
 const userFoldersKey = `folders_${user.uid}`;
 
 const [savedPending, savedApproved, savedRejected, savedPhotos, savedFolders] = await Promise.all([
 AsyncStorage.getItem(userPendingKey),
 AsyncStorage.getItem(userApprovedKey),
 AsyncStorage.getItem(userRejectedKey),
 AsyncStorage.getItem(userPhotosKey),
 AsyncStorage.getItem(userFoldersKey),
 ]);
 
 let loadedPending: Book[] = [];
 let loadedApproved: Book[] = [];
 let loadedRejected: Book[] = [];
 
if (savedPending) {
try {
const parsed = resolveBookPhotoIdsCb(JSON.parse(savedPending) as Book[], 'ingestion');
const arr = Array.isArray(parsed) ? parsed : [];
loadedPending = arr;
setPendingBooks(arr);
} catch (e) {
logger.error('Error parsing pending books:', e);
}
}
if (savedApproved) {
try {
const parsed = resolveBookPhotoIdsCb(JSON.parse(savedApproved) as Book[], 'ingestion');
const approvedArr = Array.isArray(parsed) ? parsed : [];
loadedApproved = approvedArr;
const bootstrapped = hasServerHydratedRef.current;
logger.debug('[ASYNC_STORAGE_CATCH]', 'decision', {
bootstrapped,
hasServerHydrated: hasServerHydratedRef.current,
approvedLenBefore: approvedBooksLenRef.current,
storageApprovedLen: approvedArr.length,
willApply: !hasServerHydratedRef.current,
});
if (!hasServerHydratedRef.current) {
const approvedBootstrap = ensureApprovedOnePerBookKey(approvedArr);
logApprovedIdentityHealth(approvedBootstrap, 'async_storage_initial');
logCanonicalIdentityAudit(approvedBootstrap, idAliasRef.current, 'async_storage_initial');
logger.debug('[STATE_PUBLISHED]', { statePublished: 'preMerge' });
lastApprovedUpdateSourceRef.current = 'async_storage_catch';
logLibraryStateWrite('async_storage_catch', { approved: approvedBootstrap.length });
setApprovedBooks(approvedBootstrap);
}
} catch (e) {
logger.error('Error parsing approved books:', e);
}
}
if (savedRejected) {
try {
const parsed = resolveBookPhotoIdsCb(JSON.parse(savedRejected) as Book[], 'ingestion');
const arr = Array.isArray(parsed) ? parsed : [];
loadedRejected = arr;
setRejectedBooks(arr);
} catch (e) {
logger.error('Error parsing rejected books:', e);
}
}
 if (savedPhotos) {
 try {
 const parsed = JSON.parse(savedPhotos);
 const list = Array.isArray(parsed) ? parsed : [];
 logLibraryStateWrite('fallback_error_photos', { photos: list.length });
 setPhotos(dedupBy(list, photoStableKey));
 const ids = list.map((p: Photo) => p.id).filter(Boolean).slice(0, 3);
 logger.debug(`[PENDING] hydrate cache count=${list.length} ids=[${ids.join(',')}] source=fallback_error`);
 } catch (e) {
 logger.error('Error parsing photos:', e);
 }
 }
 if (savedFolders) {
 try {
 const parsed = JSON.parse(savedFolders);
 setFolders(Array.isArray(parsed) ? parsed : []);
 } catch (e) {
 logger.error('Error parsing folders:', e);
 }
 }
 
 // Covers are resolved in worker; client shows book.coverUrl or placeholder
 } catch (fallbackError) {
 logger.error('Error loading from AsyncStorage fallback:', fallbackError);
 }
 } finally {
 if (libraryAbortControllerRef.current === libraryController) libraryAbortControllerRef.current = null;
 endRehydrate();
 loadUserDataInProgressRef.current = false;
 lastLoadUserDataAtRef.current = Date.now();
 if (loadUserDataAgainAfterRef.current) {
 loadUserDataAgainAfterRef.current = false;
 loadUserData().catch(() => {});
 }
 }
 };
 const loadUserDataRef = React.useRef<() => Promise<void>>(loadUserData);
 loadUserDataRef.current = loadUserData;
 /** Refresh only scan-job list (sync-scans?active=1). Never touches profile/books/photos — watchdog uses this so it does not re-render header/collage. */
 const refreshScanJobsOnly = React.useCallback(async () => {
   if (!user?.uid || isGuestUser(user)) return;
   const baseUrl = getApiBaseUrl();
   if (!baseUrl) return;
   try {
     const { getScanAuthHeaders } = await import('../lib/authHeaders');
     const headers = await getScanAuthHeaders();
     const res = await fetch(`${baseUrl}/api/sync-scans?active=1`, { headers });
     const data = res.ok ? await res.json() : { jobs: [] };
     const jobs = (data?.jobs ?? []) as Array<{ jobId?: string; id?: string; status?: string }>;
     const serverActive = jobs.filter((j) => (j.jobId ?? j.id) && (j.status === 'pending' || j.status === 'processing'));
     const serverActiveCanonical = serverActive
       .map((j) => canonicalJobId(j.jobId ?? j.id) ?? '')
       .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
     setLastServerActiveJobIds(serverActiveCanonical);
     if (setServerActiveJobIds) setServerActiveJobIds(serverActiveCanonical);
   } catch (_) {
     // Scan-only fetch: do not trigger circuit-breaker or full rehydrate
   }
 }, [user?.uid, setServerActiveJobIds]);
 // Fix D: When a job goes terminal, trigger refetch so photos + allBooks (pending included) refresh.
 useEffect(() => {
   triggerDataRefreshRef.current = () => loadUserDataRef.current?.().catch(() => {});
   refreshScanJobsOnlyRef.current = refreshScanJobsOnly;
 }, [refreshScanJobsOnly]);

 // Stuck visibility watchdog: refresh only scan-job list (never profile/books/photos). Throttled; disabled when backend unhealthy.
 const lastListChangeAtRef = React.useRef(Date.now());
 const lastListSignatureRef = React.useRef('');
 const activeCountRef = React.useRef(0);
 const scanQueueLengthRef = React.useRef(0);
 React.useEffect(() => {
 const sig = `${photos.length}-${scanQueue.length}`;
 if (sig !== lastListSignatureRef.current) {
 lastListSignatureRef.current = sig;
 lastListChangeAtRef.current = Date.now();
 }
 }, [photos.length, scanQueue.length]);
 activeCountRef.current = Array.isArray(activeScanJobIds) ? activeScanJobIds.length : 0;
 scanQueueLengthRef.current = scanQueue.length;
 useEffect(() => {
 const interval = setInterval(() => {
 const active = activeCountRef.current > 0 || scanQueueLengthRef.current > 0;
 if (!active) return;
 const now = Date.now();
 if (now - lastListChangeAtRef.current < 2000) return;
 const healthy = supabaseHealthyRef.current;
 if (!healthy) {
 if (now - lastWatchdogLogRef.current > WATCHDOG_UNHEALTHY_POLL_MS) {
 lastWatchdogLogRef.current = now;
 logger.debug('[SCAN_WATCHDOG]', 'backend unhealthy — slow scan-job poll only (no full refresh)');
 refreshScanJobsOnlyRef.current?.();
 }
 return;
 }
 if (now - lastWatchdogRefreshAtRef.current < WATCHDOG_THROTTLE_MS) return;
 if (now - lastWatchdogLogRef.current > 5000) {
 logger.warn('[SCAN_WATCHDOG]', 'list unchanged for 2s with active jobs/queue — refreshing scan-job list only');
 lastWatchdogLogRef.current = now;
 }
 lastListChangeAtRef.current = now;
 lastWatchdogRefreshAtRef.current = now;
 refreshScanJobsOnlyRef.current?.();
 }, 2000);
 return () => clearInterval(interval);
 }, []);

 // Check guest scan status
 useEffect(() => {
 const checkGuestScanStatus = async () => {
 if (!user || !isGuestUser(user)) {
 setGuestHasUsedScan(false);
 return;
 }
 
 const guestScanKey = 'guest_scan_used';
 const hasUsedScan = await AsyncStorage.getItem(guestScanKey);
 setGuestHasUsedScan(hasUsedScan === 'true');
 };
 
 checkGuestScanStatus();
 }, [user, pendingBooks]); // Re-check when pendingBooks changes (after scan completes)

 // When signed in, check for guest pending to import (show "Import into library" banner)
 useFocusEffect(
 useCallback(() => {
 if (!user || isGuestUser(user) || !session) return;
 AsyncStorage.getItem(PENDING_GUEST_KEY)
 .then((raw) => {
 if (!raw) return;
 try {
 const payload = JSON.parse(raw) as { books?: Book[] };
 const books = Array.isArray(payload?.books) ? payload.books : [];
 if (books.length > 0) setGuestPendingToImport(books);
 } catch (_) {
 /* ignore */
 }
 })
 .catch(() => {});
 }, [user, session])
 );
 
 // Reload data when tab is focused (user navigates back to this tab)
 // Must be after loadUserData and loadScanUsage are defined
 // A) Server authoritative: only run pending fetch when auth is ready and we have a session (or guest). If !userId, return don't set pending, don't replace, don't merge.
 // B) Scan bar server-truth: on focus, fetch active jobs from server; if 0, clear local batch/queue and hide bar.
 // RULE: "server has zero active jobs" MUST only clear scan UI state. Do NOT remove photos, remove accepted books, or cascade delete.
 useFocusEffect(
 useCallback(() => {
 isActiveRef.current = true;
 if (!authReady) return;
 const hasSession = !!session;
 const userId = user?.uid ?? null;
 if (!userId) return;
 if (!hasSession && !isGuestUser(user)) return;

 // Scan bar server-truth: fetch active jobs on focus; if none, clear scan UI only (queue, progress, batch). Never touch library.
 const baseUrl = getApiBaseUrl();
 if (baseUrl && !isGuestUser(user)) {
 import('../lib/authHeaders').then(({ getScanAuthHeaders: _gsh }) => _gsh()).then((_h) =>
 fetch(`${baseUrl}/api/sync-scans?active=1`, { headers: _h })
).then((res) => (res.ok ? res.json() : { jobs: [] }))
 .then((data: { jobs?: Array<{ jobId?: string; id?: string; status?: string }> }) => {
 const serverActive = (data?.jobs ?? []).filter(
 (j) => (j.jobId ?? j.id) && (j.status === 'pending' || j.status === 'processing')
 );
 const serverActiveCanonical = serverActive
 .map((j) => canonicalJobId(j.jobId ?? j.id) ?? '')
 .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
 const key = JSON.stringify([...serverActiveCanonical].sort());
 if (key !== lastLoggedServerActiveRef.current) {
 if (LOG_DEBUG) logger.debug('[SERVER_ACTIVE_JOBS]', { jobs: serverActiveCanonical });
 lastLoggedServerActiveRef.current = key;
 }
 setLastServerActiveJobIds(serverActiveCanonical);
 if (setServerActiveJobIds) setServerActiveJobIds(serverActiveCanonical);
 const jobsInProgressFromServer = serverActive.length;
 logger.debug('[SYNC_RESTORE]', 'restore cycle (server active only)', { serverActiveJobs: serverActiveCanonical.length });
 if (jobsInProgressFromServer === 0) {
 const graceMs = 15000;
 const approvedGraceMs = 10000;
 if (Date.now() - lastScanStartAtRef.current < graceMs) {
 logger.debug('[SCAN_BAR] focus: within scan-start grace window skip cleanup');
 return;
 }
 if (Date.now() - lastApprovedAtRef.current < approvedGraceMs) {
 logger.debug('[SCAN_BAR] focus: within approval grace window skip cleanup (approval is state transition, not no active jobs)');
 return;
 }
      if (jobsInProgressRef.current > 0 || queueHasInFlightRef.current || (activeBatchRef.current?.jobIds?.length ?? 0) > 0) {
        logger.debug('[SCAN_BAR] focus: server 0 active but local in-flight skip cleanup');
        return;
      }
      if (inFlightBatchIdsRef.current.size > 0) {
        logger.debug('[SCAN_BAR] focus: server 0 active but inFlightBatchIds non-empty skip cleanup', { batchIds: [...inFlightBatchIdsRef.current] });
        return;
      }
      if (batchStartingRef.current || queueHasQueuedRef.current) {
        logger.debug('[SCAN_BAR] focus: server 0 active but batch starting or queue has queued skip cleanup, only merge server');
        return;
      }
      // Only clear scan UI: queue, progress, batch. Never clear photos/approved storage or setPhotos([])/setApprovedBooks([]).
      logger.debug('[SCAN_BAR] focus: server has 0 active jobs -> clear scan UI only');
 logCleanupAction({
 reason: 'focus_server_zero_active',
 clearedScanQueue: true,
 clearedScanProgress: true,
 clearedActiveBatch: true,
 clearedStorageKeys: [], // batch keys cleared by clearActiveBatch; photos/books keys must never appear here
 });
 setScanQueue([]);
 setScanProgress(null);
 clearActiveBatch(undefined, 'cleanup');
 }
 })
 .catch(() => {});
 }

 // ── Focus-refresh debounce ────────────────────────────────────────────────
 // Skip if within scan-terminal grace window. handleJobTerminalStatus sets this
 // when a job completes; saveUserData may still be writing to AsyncStorage.
 // loadUserData would read stale data and overwrite the pending books just set.
 if (scanTerminalGraceUntilRef.current > 0 && Date.now() < scanTerminalGraceUntilRef.current) {
   logger.logThrottle('focus_skip_terminal_grace', 10_000, 'debug', '[FOCUS_REFRESH_SKIP]', '', { reason: 'scan_terminal_grace', graceRemaining: scanTerminalGraceUntilRef.current - Date.now() });
   return;
 }
 // Skip if: (a) a snapshot was committed within FOCUS_REFRESH_DEBOUNCE_MS — avoids
 // a redundant fetch when approve or boot just ran, OR (b) an active batch is in
 // progress — scanning/approving should not be interrupted by a parallel merge.
 const _focusNow = Date.now();
 const _msSinceLastSnapshot = _focusNow - lastSnapshotCommittedAtRef.current;
 const _hasActiveBatchNow = activeBatchRef.current != null && !isTerminalBatchStatus(deriveBatchStatus(activeBatchRef.current));
 if (_hasActiveBatchNow) {
   logger.logThrottle('focus_skip_batch', 10_000, 'debug', '[FOCUS_REFRESH_SKIP]', '', { reason: 'active_batch', batchId: activeBatchRef.current?.batchId });
   return;
 }
 if (_msSinceLastSnapshot < FOCUS_REFRESH_DEBOUNCE_MS) {
   logger.logThrottle('focus_skip_debounce', 10_000, 'debug', '[FOCUS_REFRESH_SKIP]', '', { reason: 'debounce', msSinceLastSnapshot: _msSinceLastSnapshot, threshold: FOCUS_REFRESH_DEBOUNCE_MS });
   return;
 }

 // When backend is unhealthy (circuit-breaker), skip full load to avoid failure loop and header flash. Allow retry after cooldown.
 if (!supabaseHealthyRef.current) {
   const msSinceFailure = Date.now() - lastSupabaseFailureAtRef.current;
   if (msSinceFailure < SUPABASE_CIRCUIT_BREAKER_COOLDOWN_MS) {
     logger.logThrottle('focus_skip_unhealthy', 10_000, 'debug', '[FOCUS_REFRESH_SKIP]', '', { reason: 'backend_unhealthy' });
     return;
   }
   supabaseHealthyRef.current = true;
   consecutiveSupabaseFailuresRef.current = 0;
   logger.debug('[SUPABASE_CIRCUIT_BREAKER]', 'cooldown elapsed, allowing full load retry');
 }

 // Focus: only fetch pending rows. Batch restore runs once on mount (see reconcile effect below).
 loadUserData().catch(error => {
 logger.error(' Error reloading user data on focus:', error);
 });
 loadScanUsage().catch(error => {
 logger.error(' Error reloading scan usage on focus:', error);
 });
 if (!isCoverUpdateActive()) checkAndCompletePendingActionsRef.current();
 if (isGuestUser(user)) {
 AsyncStorage.getItem('guest_scan_used').then(hasUsedScan => {
 setGuestHasUsedScan(hasUsedScan === 'true');
 });
 }
 return () => {
 isActiveRef.current = false;
 try {
 const { clearGoogleBooksQueue } = require('../services/googleBooksService');
 clearGoogleBooksQueue();
 } catch (error) {
 logger.debug('Error clearing Google Books queue:', error);
 }
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps -- checkAndCompletePendingActions is defined later
 }, [user, authReady, session, setScanQueue, setScanProgress, clearActiveBatch])
 );

 // On boot: reconcile with server. Fetch queued/processing jobs; if none clear scan UI; if some rebuild queue + batch from server (fixes mid-scan crash).
 const reconcileRanRef = useRef<Set<string>>(new Set());
 useEffect(() => {
 if (!authReady || !user?.uid) return;
 if (!session && !isGuestUser(user)) return;
 if (reconcileRanRef.current.has(user.uid)) return;
 const baseUrl = getApiBaseUrl();
 if (!baseUrl || isGuestUser(user)) {
 reconcileRanRef.current.add(user.uid);
 return;
 }

 import('../lib/authHeaders').then(({ getScanAuthHeaders: _gsh2 }) => _gsh2()).then((_h2) =>
 fetch(`${baseUrl}/api/sync-scans?active=1`, { headers: _h2 })
).then((res) => (res.ok ? res.json() : { jobs: [] }))
 .then(async (data: { jobs?: Array<{ jobId?: string; id?: string; status?: string }> }) => {
 // Read persisted keys for [SCAN_RESTORE] logs (confirm in one run)
 const activeKey = activeBatchKey(user.uid);
 let activeRaw: string | null = null;
 let batchRaw: string | null = null;
 let batchKeyRead: string | null = null;
 try {
 activeRaw = await AsyncStorage.getItem(activeKey);
 if (activeRaw && activeRaw.trim()) {
 const batchIdFromStorage = activeRaw.startsWith('{') ? (JSON.parse(activeRaw) as { batchId?: string })?.batchId : activeRaw.trim();
 if (batchIdFromStorage) {
 batchKeyRead = scanBatchKey(user.uid, batchIdFromStorage);
 batchRaw = await AsyncStorage.getItem(batchKeyRead);
 }
 }
 } catch (_) {}
 const loadedKeys: Record<string, string> = {};
 loadedKeys[activeKey] = activeRaw != null ? (activeRaw.length > 80 ? activeRaw.slice(0, 80) + '' : activeRaw) : 'null';
 if (batchKeyRead) loadedKeys[batchKeyRead] = batchRaw != null ? (batchRaw.length > 80 ? batchRaw.slice(0, 80) + '' : batchRaw) : 'null';
 logger.debug('[SCAN_RESTORE] loaded keys', loadedKeys);

 const serverJobs = (data?.jobs ?? []).filter(
 (j) => (j.jobId ?? j.id) && (j.status === 'pending' || j.status === 'processing')
 );
 if (serverJobs.length === 0) {
 const graceMs = 15000;
 const approvedGraceMs = 10000;
 if (Date.now() - lastScanStartAtRef.current < graceMs) {
 logger.debug('[SCAN_RESTORE] within scan-start grace window skip cleanup');
 return;
 }
 if (Date.now() - lastApprovedAtRef.current < approvedGraceMs) {
 logger.debug('[SCAN_RESTORE] within approval grace window skip cleanup');
 return;
 }
    if (jobsInProgressRef.current > 0 || queueHasInFlightRef.current || (activeBatchRef.current?.jobIds?.length ?? 0) > 0) {
      logger.debug('[SCAN_RESTORE] server 0 active but local in-flight skip cleanup');
      return;
    }
    if (inFlightBatchIdsRef.current.size > 0) {
      logger.debug('[SCAN_RESTORE] server 0 active but inFlightBatchIds non-empty skip cleanup', { batchIds: [...inFlightBatchIdsRef.current] });
      return;
    }
    if (batchStartingRef.current || queueHasQueuedRef.current) {
      logger.debug('[SCAN_RESTORE] server 0 active but batch starting or queue has queued skip cleanup');
      return;
    }
 logger.debug('[SCAN_RESTORE] invalid_state -> clearing scan UI only');
 // No active jobs clear scan UI and persisted scan state only. Never remove photos or library books.
 logCleanupAction({
 reason: 'reconcile_no_active_jobs',
 clearedScanQueue: true,
 clearedScanProgress: true,
 clearedActiveBatch: true,
 clearedStorageKeys: [],
 });
 setScanQueue([]);
 setScanProgress(null);
 logQueueDelta('cleanup', 0);
 setActiveBatch(null);
 activeBatchRef.current = null;
 currentBatchIdRef.current = null;
 currentBatchStartedAtRef.current = null;
 try {
 AsyncStorage.removeItem(activeBatchKey(user.uid));
 } catch (_) {}
 } else {
 // Only show recovered batch if at least one job still has active server status (avoid phantom scan bar).
 const jobIdsToCheck = serverJobs.map((j) => canonicalJobId(j.jobId ?? j.id!) ?? (j.jobId ?? j.id!)).filter(Boolean);
 const stillActive: Array<{ jobId: string; status: string }> = [];
 await Promise.all(
 jobIdsToCheck.map(async (jid) => {
 try {
 const r = await fetch(`${baseUrl}/api/scan-status?jobId=${encodeURIComponent(jid)}`, {
 method: 'GET',
 headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
 cache: 'no-store'
 });
 if (!r.ok) return;
 const body = await r.json();
 const status = body?.status;
 if (status === 'pending' || status === 'processing') stillActive.push({ jobId: jid as string, status });
 } catch (_) {}
 })
 );
 if (stillActive.length === 0) {
 const graceMs = 15000;
 const approvedGraceMs = 10000;
 if (Date.now() - lastScanStartAtRef.current < graceMs) {
 logger.debug('[SCAN_RESTORE] no_jobs_still_active but within grace window skip cleanup');
 return;
 }
 if (Date.now() - lastApprovedAtRef.current < approvedGraceMs) {
 logger.debug('[SCAN_RESTORE] no_jobs_still_active but within approval grace window skip cleanup');
 return;
 }
      if (jobsInProgressRef.current > 0 || queueHasInFlightRef.current || (activeBatchRef.current?.jobIds?.length ?? 0) > 0) {
        logger.debug('[SCAN_RESTORE] no_jobs_still_active but local in-flight skip cleanup');
        return;
      }
      if (inFlightBatchIdsRef.current.size > 0) {
        logger.debug('[SCAN_RESTORE] no_jobs_still_active but inFlightBatchIds non-empty skip cleanup', { batchIds: [...inFlightBatchIdsRef.current] });
        return;
      }
      if (batchStartingRef.current || queueHasQueuedRef.current) {
        logger.debug('[SCAN_RESTORE] no_jobs_still_active but batch starting or queue has queued skip cleanup');
        return;
      }
      logger.debug('[SCAN_RESTORE] no_jobs_still_active -> clearing (avoid phantom bar)');
 setScanQueue([]);
 setScanProgress(null);
 logQueueDelta('cleanup', 0);
 setActiveBatch(null);
 activeBatchRef.current = null;
 currentBatchIdRef.current = null;
 currentBatchStartedAtRef.current = null;
 try {
 AsyncStorage.removeItem(activeBatchKey(user.uid));
 } catch (_) {}
 } else {
 // Rebuild scan UI only for jobs that are still queued/processing on server
 const batchId = `recovered_${Date.now()}`;
 const jobIds = stillActive.map((a) => a.jobId);
 logger.debug('[SCAN_RESTORE] showing bar for verified active jobs', {
 restoredBatchId: batchId,
 jobCount: jobIds.length,
 jobIds
 });
 const resultsByJobId: Record<string, JobResult> = {};
 for (const a of stillActive) {
 resultsByJobId[a.jobId] = {
 status: a.status === 'pending' ? 'queued' : (a.status as JobResult['status']),
 books: undefined
 };
 }
 const batch: ScanBatch = {
 batchId,
 createdAt: Date.now(),
 jobIds,
 scanIds: [],
 status: 'processing',
 resultsByJobId,
 importedJobIds: [],
 expectedJobCount: jobIds.length,
 };
 logQueueDelta('import_complete', jobIds.length, 'import complete');
 const queueItems: ScanQueueItem[] = jobIds.map((jid) => {
 const a = stillActive.find((x) => x.jobId === jid);
 const status = (a?.status === 'pending' ? 'pending' : 'processing') as 'pending' | 'processing';
 return {
 id: jid,
 uri: '',
 status,
 batchId,
 jobId: jid
 };
 });
 scanShowReasonRef.current = 'queue_resume';
 setScanQueue(queueItems);
 setActiveBatch(batch);
 persistBatch(batch);
 }
 }
 reconcileRanRef.current.add(user.uid);
 })
 .catch(() => {
 reconcileRanRef.current.add(user.uid);
 });
 }, [authReady, user?.uid, session, setScanQueue, setScanProgress, setActiveBatch, persistBatch]);

 const importGuestPending = useCallback(async () => {
 const list = guestPendingToImport;
 if (!list?.length || importingGuestPending || !user || isGuestUser(user)) return;
 setImportingGuestPending(true);
 const baseUrl = getApiBaseUrl();
 try {
 const { getScanAuthHeaders } = await import('../lib/authHeaders');
 const headers = await getScanAuthHeaders();
 const body = {
 books: list.map((b) => ({
 title: b.title,
 author: b.author,
 book_key: (b as any).book_key ?? getStableBookKey(b),
 })),
 };
 const res = await fetch(`${baseUrl}/api/import-guest-pending`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', ...headers },
 body: JSON.stringify(body),
 });
 const data = (await res.json().catch(() => ({}))) as { ok?: boolean; imported?: number };
 if (res.ok && data.ok) {
 await AsyncStorage.removeItem(PENDING_GUEST_KEY);
 setGuestPendingToImport(null);
 setPendingBooks((prev) => prev.filter((b) => !(b as any).isGuest));
 refreshProfileStats();
 loadUserData().catch(() => {});
 Alert.alert('Imported', `${data.imported ?? list.length} book${(data.imported ?? list.length) !== 1 ? 's' : ''} added to your library.`);
 } else {
 Alert.alert('Import failed', 'Could not import books. Try again.');
 }
 } catch (e: any) {
 logger.error('Import guest pending failed', e?.message ?? e);
 Alert.alert('Import failed', e?.message ?? 'Could not import books.');
 } finally {
 setImportingGuestPending(false);
 }
 }, [guestPendingToImport, importingGuestPending, user, refreshProfileStats]);

 // Helper to show login prompt for guest users
 const showLoginPrompt = (message: string, onLogin?: () => void) => {
 Alert.alert(
 'Sign In Required',
 message,
 [
 { text: 'Cancel', style: 'cancel' },
 { 
 text: 'Sign In', 
 onPress: () => {
 // Navigate to login - we'll need to add a way to show login screen
 // For now, just show an alert with instructions
 Alert.alert(
 'Sign In',
 'Please go to Settings and sign in to access this feature.',
 [{ text: 'OK' }]
 );
 if (onLogin) onLogin();
 }
 }
 ]
 );
 };

 const saveUserData = async (
 newPending: Book[],
 newApproved: Book[],
 newRejected: Book[],
 newPhotos: Photo[],
 options?: { photoIdForApproved?: string; photoIdsForApproved?: string[]; scanJobIdForApproved?: string; batchIdForApproved?: string; jobIdsToClose?: string[]; source?: 'scan' | 'cover_update'; runInBackground?: boolean }
 ) => {
 if (!user) return;
 if (isGuestUser(user)) {
 await AsyncStorage.setItem(PENDING_GUEST_KEY, JSON.stringify({ books: newPending }));
 return;
 }

 const userPendingKey = `pending_books_${user.uid}`;
 const userApprovedKey = `approved_books_${user.uid}`;
 const userRejectedKey = `rejected_books_${user.uid}`;
 const userPhotosKey = `photos_${user.uid}`;

 const persistToStorage = () =>
 Promise.all([
 AsyncStorage.setItem(userPendingKey, JSON.stringify(newPending)),
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(ensureApprovedOnePerBookKey(newApproved))),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(newRejected)),
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(newPhotos)),
 ]);

 // Approve reconciliation (job close, APPROVE_COMPLETE) only when source === 'scan'. Cover updates must not trigger it.
 const runApproveReconciliation = newApproved.length > 0 && options?.source === 'scan';

 // Approve path: single-flight, all-or-nothing. No half-mutate on network/500. Only when source is scan.
 if (runApproveReconciliation) {
 const photoIdForOpt = options?.photoIdForApproved;
    // Canonicalize every photo ID through the alias map before building the approve payload.
    // Local aliases (e.g. ef10... → e2ec...) must be resolved to canonical UUIDs so the
    // approve step operates on real DB row IDs, not ephemeral client-local IDs.
    // Uses resolvePhotoIdLogged so every aliased ID is traceable in logs.
    const canonicalizePhotoIds = (ids: string[]): string[] =>
      Array.from(new Set(ids.map((id) => resolvePhotoIdLogged(id, 'approve') ?? id).filter((id) => !!id && id.trim().length > 0)));

    const explicitPhotoIds = canonicalizePhotoIds(
      options?.photoIdsForApproved && options.photoIdsForApproved.length > 0
        ? options.photoIdsForApproved
        : [
            ...(photoIdForOpt ? [photoIdForOpt] : []),
            ...newApproved
              .map((b: Book) => (b as any).source_photo_id)
              .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0),
          ]
    );
    const scanJobIdForOpt = options?.scanJobIdForApproved;
    const photosToSaveCount =
      explicitPhotoIds.length > 0
        ? newPhotos.filter((p) => explicitPhotoIds.includes(resolvePhotoIdLogged(p.id, 'approve') ?? p.id) && p.uri && typeof p.uri === 'string' && p.uri.trim().length > 0).length
        : 0;
    const _approveT0 = Date.now();
    logger.info('[APPROVE_START]', {
      userId: user.uid,
      approvedCount: newApproved.length,
      pendingCount: newPending.length,
      rejectedCount: newRejected.length,
      selectedPhotoId: photoIdForOpt ? (resolvePhotoIdLogged(photoIdForOpt, 'approve') ?? photoIdForOpt) : null,
      explicitPhotoIds,
      photosToSaveCount,
      localPhotosCountBefore: newPhotos.length,
    });
    // Canonicalize pendingPhotoIds too — this is what gets logged and used for FK patching.
    const pendingPhotoIds = canonicalizePhotoIds(
      (newApproved.map((b: Book) => (b as any).source_photo_id).filter(Boolean)) as string[]
    );
    // APPROVE_PAYLOAD_SUMMARY: prove which photo IDs and alias counts go into the approve call.
    {
      const allBookPhotoIds = newApproved.map((b: Book) => (b as any).source_photo_id as string | undefined).filter((x): x is string => !!x);
      const distinctPhotoIdsInBooks = [...new Set(allBookPhotoIds)];
      const resolvedDistinct = distinctPhotoIdsInBooks.map((id) => resolvePhotoIdLogged(id, 'approve') ?? id);
      const booksWithAliasedPhotoId = allBookPhotoIds.filter((id) => (resolvePhotoIdLogged(id, 'approve') ?? id) !== id).length;
      const booksWithCanonicalPhotoId = allBookPhotoIds.length - booksWithAliasedPhotoId;
      logger.info('[APPROVE_PAYLOAD_SUMMARY]', {
        approvedBooksCount: newApproved.length,
        distinctPhotoIdsInBooks: { count: distinctPhotoIdsInBooks.length, sample: distinctPhotoIdsInBooks.slice(0, 5).map((id) => id.slice(0, 8)) },
        explicitPhotoIdsSent: { count: explicitPhotoIds.length, sample: explicitPhotoIds.slice(0, 5).map((id) => id.slice(0, 8)) },
        resolvedExplicitPhotoIdsSent: { count: resolvedDistinct.length, sample: resolvedDistinct.slice(0, 5).map((id) => id.slice(0, 8)) },
        booksWithAliasedPhotoIdCount: booksWithAliasedPhotoId,
        booksWithCanonicalPhotoIdCount: booksWithCanonicalPhotoId,
      });
    }
 logger.info('[PENDING_ACCEPT]', {
 pendingPhotoIds,
 acceptedPhotoId: photoIdForOpt ?? null,
 acceptedJobId: scanJobIdForOpt ?? null,
 willInsertPhotos: newPhotos.map((p: Photo) => p.id),
 willInsertBooks: { approved: newApproved.length, pending: newPending.length },
 });
 if (isApprovingRef.current) return;
 if (isClearInProgress()) return;
 const jobIdsToCloseEarly =
 options?.jobIdsToClose?.length > 0
 ? options.jobIdsToClose
 : getJobIdsToCloseFromApproved(
 newApproved,
 options?.scanJobIdForApproved ? toScanJobId(options.scanJobIdForApproved) : undefined
 ).jobIdsToClose;
 if (jobIdsToCloseEarly.length > 0 && jobIdsToCloseEarly.every((id) => closedScanJobIdsRef.current.has(id))) {
 if (__DEV__) logger.debug('[APPROVE] skip: same scan job(s) already closed locally', { jobIds: jobIdsToCloseEarly });
 return;
 }
 if (!options?.runInBackground) {
 isApprovingRef.current = true;
 setIsApproving(true);
 }
 (global as any).__approveSampleCount = 0;
 const _approveClickT0 = Date.now();
 perfLog('approve', 'tap', { tapAt: _approveClickT0, booksApproved: newApproved.length });
 logger.info('[APPROVE_TIMING]', 'approve_click', { at: _approveClickT0 });
 let snapshotApproved: Book[] | null = null;
 let snapshotPending: Book[] | null = null;
 const newApprovedWithStatus = newApproved.map((b) => ({ ...b, status: 'approved' as const }));
 const newApprovedKeySet = new Set(newApproved.map((b) => computeBookKey(b)).filter(Boolean));
 setApprovedBooks((prev) => {
   snapshotApproved = prev;
   const keySet = new Set(prev.map((b) => computeBookKey(b)).filter(Boolean));
   const toAdd = newApprovedWithStatus.filter((b) => !keySet.has(computeBookKey(b)));
   return [...prev, ...toAdd];
 });
 setPendingBooks((prev) => {
   snapshotPending = prev;
   return prev.filter((b) => !newApprovedKeySet.has(computeBookKey(b)));
 });
 lastApprovedAtRef.current = Date.now();
 lastLocalMutationAtRef.current = Date.now();
 refreshProfileStats();
 try {
 const baseSaveOptions = session?.access_token ? { apiBaseUrl: getApiBaseUrl(), accessToken: session.access_token } : undefined;
    // Resolve option-provided photo/job IDs to canonical before using them in DB writes.
    const photoIdForApproved = options?.photoIdForApproved
      ? (resolvePhotoIdLogged(options.photoIdForApproved, 'approve') ?? options.photoIdForApproved)
      : undefined;
    const scanJobIdForApproved = options?.scanJobIdForApproved;
 // Collect server DB ids so we never persist synthetic ids as canonical approved state.
 const approvedDbIds: (string | undefined)[] = new Array(newApproved.length);
 // Accumulate preflight results across all concurrent book saves for a single summary log.
 const _preflightResults: Array<{ bookKey: string; rowFound: boolean; photoIdMismatch: boolean; error: string | null }> = [];
 const _onPreflight = (r: { bookKey: string; rowFound: boolean; photoIdMismatch: boolean; error: string | null }) => {
 _preflightResults.push(r);
 };

    // NOTE: approvePromises is built AFTER photo saves complete (below), so that
    // canonicalPhotoIdMap is fully populated with current-session dedupe results before
    // we resolve each book's source_photo_id. Building it here (before photo saves) would
    // cause books to be upserted with local/stale photo IDs that may not exist in the DB.

    // Strict finalize contract: only explicit photo ids from approved selection are eligible.
    // Match against the resolved (canonical) ID since explicitPhotoIds is already canonicalized.
    const photosToSave = newPhotos.filter((p) => explicitPhotoIds.includes(resolvePhotoIdLogged(p.id, 'approve') ?? p.id));
 // Include photos that have a uri OR already have a storage_path (already uploaded).
 // Photos with only storage_path need their lifecycle patched (status=complete, approved_count)
 // even though the signed URI may have expired or not yet been computed client-side.
 const photosToSaveFiltered = photosToSave.filter((photo) => {
 const hasUri = photo.uri && typeof photo.uri === 'string' && photo.uri.trim().length > 0;
 const hasStoragePath = !!(photo as any).storage_path &&
 typeof (photo as any).storage_path === 'string' &&
 ((photo as any).storage_path as string).trim().length > 0;
 return hasUri || hasStoragePath;
 });

 // CRITICAL: Save photos BEFORE books. Books reference photos.id via source_photo_id FK.
 // Running book saves (Promise.all) before photo upsert causes FK violations when the
 // photo row doesn't exist in the DB yet.
 // Sequential saves also prevent duplicate image_hash 23505 errors.
 // canonicalPhotoIdMap: localPhotoId canonicalPhotoId from the DB after dedupe.
 // Used below to ensure batchPatchSourcePhotoId uses the canonical (existing) row id,
 // not the client's local id which may not exist in the photos table.
 const photoResults: boolean[] = [];
 const _photoSaveT0 = Date.now();
const canonicalPhotoIdMap = new Map<string, string>(); // localId → canonicalId
// Full rewrite info: localId → { canonicalId, storagePath, storageUrl }
// Used to patch in-memory photo objects so they carry the canonical ID and valid
// storage fields, preventing classification as "corrupt" on the next render pass.
const photoRewriteMap = new Map<string, { canonicalId: string; storagePath: string | null; storageUrl: string | null }>();
// canonicalStorageMap: localId → { storagePath, storageUrl } for ALL successfully saved photos,
// regardless of whether the canonical ID differs from the local ID.
// This fills the gap where savePhotoToSupabase returns ok:true with the same ID (no ID rewrite)
// but the local photo object still has null storage fields from scan ingestion. Without this,
// photosWithAccepted can't stamp status:'complete' because hasStorage is false, causing the
// photo to be dropped by photosWithApprovedBooks (which requires status='complete').
const canonicalStorageMap = new Map<string, { storagePath: string | null; storageUrl: string | null }>();
for (const photo of photosToSaveFiltered) {
try {
// Pass statusOverride:'complete' so patchPhotoLifecycle stamps the DB row as complete
// even when photo.status is still 'draft'. This happens when the upload succeeded in
// a prior step but the local photo object wasn't updated before approve was triggered.
// approvedCountOverride is set after books save completes; at this point we don't yet
// know the count, so it will be filled in by patchPhotoLifecycle → approvedCountByPhotoId
// later. For now, at minimum ensure status transitions from draft → complete.
const result = await savePhotoToSupabase(user.uid, photo, { statusOverride: 'complete' });
photoResults.push(result.ok);
if (result.ok) clearDraftWatchdogForPhoto(photo.id, result.canonicalPhotoId ?? null);
if (result.canonicalPhotoId && photo.id) {
canonicalPhotoIdMap.set(photo.id, result.canonicalPhotoId);
if (result.canonicalPhotoId !== photo.id) {
// Dedupe happened — record full rewrite so we can patch the photo object in state.
photoRewriteMap.set(photo.id, {
canonicalId: result.canonicalPhotoId,
storagePath: result.canonicalStoragePath ?? null,
storageUrl: result.canonicalStorageUrl ?? null,
});
}
}
// Always record storage fields for every successfully saved photo so we can
// hydrate null-storage local photo objects after approve, even when canonical ID === local ID.
if (result.ok && photo.id) {
canonicalStorageMap.set(photo.id, {
storagePath: result.canonicalStoragePath ?? null,
storageUrl: result.canonicalStorageUrl ?? null,
});
// Also record under canonical ID if it differs (so lookup works both ways).
if (result.canonicalPhotoId && result.canonicalPhotoId !== photo.id) {
canonicalStorageMap.set(result.canonicalPhotoId, {
storagePath: result.canonicalStoragePath ?? null,
storageUrl: result.canonicalStorageUrl ?? null,
});
}
}
 if (result.ok) {
 logger.debug('[APPROVE_SAVE_PHOTO_OK]', {
 localPhotoId: photo.id,
 canonicalPhotoId: result.canonicalPhotoId ?? null,
 deduped: result.canonicalPhotoId !== photo.id,
 jobId: photo.jobId ?? null,
 });
 } else {
 logger.warn('[APPROVE_SAVE_PHOTO_FAIL]', {
 localPhotoId: photo.id,
 jobId: photo.jobId ?? null,
 err: 'returned false',
 });
 }
 } catch (err: any) {
 logger.warn('[APPROVE_SAVE_PHOTO_FAIL]', {
 localPhotoId: photo.id,
 jobId: photo.jobId ?? null,
 err: err?.message ?? String(err),
 });
 photoResults.push(false);
 }
 }
 logger.info('[TIMING]', { op: 'photo_save', ms: Date.now() - _photoSaveT0, totalFromClick: Date.now() - _approveClickT0, counts: { attempted: photosToSaveFiltered.length, ok: photoResults.filter(Boolean).length, rewrites: photoRewriteMap.size } });
if (photoRewriteMap.size > 0) {
  logger.info('[PHOTO_ID_REWRITE]', {
    count: photoRewriteMap.size,
    rewrites: [...photoRewriteMap.entries()].map(([local, r]) => ({
      local: local.slice(0, 8),
      canonical: r.canonicalId.slice(0, 8),
      hasStoragePath: !!r.storagePath,
    })),
  });
  // Persist photo aliases so every future ingestion edge can canonicalize without re-deduping.
  const approvePhotoAliases: Record<string, string> = {};
  photoRewriteMap.forEach((rewrite, localId) => { approvePhotoAliases[localId] = rewrite.canonicalId; });
  await mergePhotoAliases(approvePhotoAliases);

  // Patch any book rows already in Supabase that still reference a local photo ID.
  // This covers the case where a prior saveUserData (scan import) inserted books with
  // localPhotoId before the photo dedupe happened. Now that we know the canonical ID,
  // we MUST patch those rows — "retry later" is unreliable because localPhotoId never
  // becomes a real photo row in the DB.
  if (user) {
    const patchPromises: Promise<void>[] = [];
    photoRewriteMap.forEach((rewrite, localId) => {
      patchPromises.push((async () => {
        try {
          // Find all book rows for this user that still reference the old local photo ID.
          const { data: staleBooks, error: fetchErr } = await supabase
            .from('books')
            .select('id')
            .eq('user_id', user.uid)
            .eq('source_photo_id', localId);
          if (fetchErr) {
            logger.warn('[PHOTO_ID_REWRITE_PATCH]', 'failed to fetch stale books', { localId: localId.slice(0, 8), err: fetchErr.message });
            return;
          }
          const staleIds = (staleBooks ?? []).map((r: { id: string }) => r.id);
          if (staleIds.length === 0) return;
          logger.info('[PHOTO_ID_REWRITE_PATCH]', 'patching stale book rows', {
            localId: localId.slice(0, 8),
            canonicalId: rewrite.canonicalId.slice(0, 8),
            count: staleIds.length,
          });
          const { error: patchErr } = await supabase
            .from('books')
            .update({ source_photo_id: rewrite.canonicalId, updated_at: new Date().toISOString() })
            .eq('user_id', user.uid)
            .in('id', staleIds);
          if (patchErr) {
            logger.warn('[PHOTO_ID_REWRITE_PATCH]', 'patch failed', { localId: localId.slice(0, 8), canonicalId: rewrite.canonicalId.slice(0, 8), err: patchErr.message });
          }
        } catch (e: any) {
          logger.warn('[PHOTO_ID_REWRITE_PATCH]', 'unexpected error', { localId: localId.slice(0, 8), err: e?.message ?? String(e) });
        }
      })());
    });
    await Promise.all(patchPromises);
  }
}

// All photo rows are now committed AND canonicalPhotoIdMap + alias map are fully populated.
// Build approvePromises NOW so every book gets the canonical source_photo_id, not the local
// placeholder. Building this before photo saves (the old position) caused books to be upserted
// with local IDs that don't exist in DB, making the subsequent FK patch the only safety net —
// and that patch was itself failing with PHOTO_FK_PATCH_SKIP on the first approve after a dedupe.

// ─── APPROVE BARRIER ────────────────────────────────────────────────────────
// Before touching any books: confirm every canonical photo ID that books will
// reference actually exists as a row in the DB right now.
//
// Why this is needed:
//   • Photo save can return ok:false (network/upload failure). The canonical ID
//     returned in that case is unreliable — it may be a prior-session alias that
//     was never fully committed, or a row that was deleted.
//   • Even when ok:true, a dedupe can reuse a canonical ID from a prior session
//     alias that no longer exists (stale alias map entry).
//   • If we let book upserts proceed with a missing photo FK, batchPatchSourcePhotoId
//     now throws (by design), causing every book save to return false → approve fails.
//
// The barrier:
//   1. Collect every distinct canonical photo ID that any book will reference.
//   2. Query the DB once to confirm they all exist.
//   3. If any are missing, throw a clear error BEFORE touching books, so the
//      approve button can show "Finalizing scans…" and the user can retry.
{
  // Collect all canonical photo IDs books will reference.
  const bookCanonicalPhotoIds = new Set<string>();
  for (const book of newApproved) {
    const rawPid = (book as any).source_photo_id as string | undefined;
    if (!rawPid) continue;
    const canonicalPid = canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoIdLogged(rawPid, 'approve') ?? rawPid;
    if (canonicalPid && /^[0-9a-f-]{36}$/i.test(canonicalPid)) {
      bookCanonicalPhotoIds.add(canonicalPid);
    }
  }

  if (bookCanonicalPhotoIds.size > 0) {
    const idsToCheck = [...bookCanonicalPhotoIds];
    const { data: existingPhotoRows, error: barrierErr } = await supabase
      .from('photos')
      .select('id')
      .eq('user_id', user.uid)
      .in('id', idsToCheck);

    if (barrierErr) {
      logger.warn('[APPROVE_BARRIER]', 'DB query failed — proceeding cautiously', { err: barrierErr.message });
      // Don't block on query failure — network hiccup shouldn't prevent approve.
    } else {
      const foundIds = new Set((existingPhotoRows ?? []).map((r: { id: string }) => r.id));
      const missingIds = idsToCheck.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        logger.error('[APPROVE_BARRIER]', 'canonical photo rows missing from DB — blocking approve to prevent FK failures', {
          missingCount: missingIds.length,
          missingIds: missingIds.map(id => id.slice(0, 8)),
          foundCount: foundIds.size,
          note: 'This means either photo upload failed or alias map has stale entries. Clear the alias map or retry the scan.',
        });
        throw new Error(
          `Approve failed: ${missingIds.length} photo row(s) referenced by books are not yet in the database. ` +
          `Please wait a moment and try again. (Missing: ${missingIds.map(id => id.slice(0, 8)).join(', ')})`
        );
      }
      logger.info('[APPROVE_BARRIER]', 'all canonical photo rows confirmed in DB', {
        checkedCount: idsToCheck.length,
        foundCount: foundIds.size,
      });
    }
  }
}
// ─── END APPROVE BARRIER ────────────────────────────────────────────────────

// Also guard: if any photo save returned ok:false, block the approve entirely.
// An ok:false result means the photo row may not be fully committed, so books
// referencing it will hit FK failures. The user should see a clear error.
{
  const failedPhotoSaves = photosToSaveFiltered.filter((_, i) => !photoResults[i]);
  if (failedPhotoSaves.length > 0) {
    logger.error('[APPROVE_PHOTO_SAVE_FAIL_BLOCK]', 'blocking approve: photo save(s) failed', {
      failedCount: failedPhotoSaves.length,
      failedIds: failedPhotoSaves.map(p => p.id?.slice(0, 8)),
    });
    throw new Error(
      `Approve failed: ${failedPhotoSaves.length} photo(s) could not be saved. Please check your connection and try again.`
    );
  }
}

const approvePromises = newApproved.map((book, index) => {
  const rawSourcePhotoId: string | undefined = (book as any).source_photo_id ?? photoIdForApproved;
  // Prefer canonicalPhotoIdMap (current-session dedupe) then alias map (prior sessions).
  const canonicalSourcePhotoId = rawSourcePhotoId
    ? (canonicalPhotoIdMap.get(rawSourcePhotoId) ?? resolvePhotoIdLogged(rawSourcePhotoId, 'approve') ?? rawSourcePhotoId)
    : undefined;
  return saveBookToSupabase(user.uid, book, 'approved', {
    ...baseSaveOptions,
    sourcePhotoId: canonicalSourcePhotoId,
    sourceScanJobId: (book as any).source_scan_job_id ?? scanJobIdForApproved,
    onPreflight: _onPreflight,
    onSuccess: (dbId) => {
      approvedDbIds[index] = dbId;
      lastApprovedUpdateSourceRef.current = 'approve_on_success';
      setApprovedBooks((prev) =>
        prev.map((b) => (computeBookKey(b) === computeBookKey(book) ? { ...b, id: dbId, dbId } : b))
      );
    },
    onApproveFailure: (reason, title) => {
      if (reason === 'duplicate_key') recordApproveDupe(title);
    },
  });
});

const bookPromises = [
  ...newPending.map((book) => saveBookToSupabase(user.uid, book, 'pending', { ...baseSaveOptions, onPreflight: _onPreflight })),
  ...approvePromises,
  ...newRejected.map((book) => saveBookToSupabase(user.uid, book, 'rejected', { ...baseSaveOptions, onPreflight: _onPreflight })),
];
 const bookResults = await Promise.all(bookPromises).catch((err) => {
 logger.warn('[APPROVE_FAILED]', { reason: 'network', message: (err as Error)?.message, jobClosed: false });
 logger.error('Error saving to Supabase:', err);
 throw new Error('Approve failed: network error. Please retry.');
 });

  // Batch FK patch: one UPDATE per distinct canonical photoId instead of one per book.
  // canonicalPhotoIdMap is seeded from two sources:
  //   1. This session's photo saves (photoRewriteMap) — populated above.
  //   2. The persistent alias map (photoIdAliasRef) — covers local IDs that were deduped
  //      in a *previous* saveUserData call (e.g. scan-import before approve). Without this
  //      second seed, a photo that was deduped at scan-import time (local "3d367830" →
  //      canonical "00485cd7") would NOT be in canonicalPhotoIdMap, causing the FK patch
  //      to send the local ID to batchPatchSourcePhotoId → photo row not found → SKIP.
  Object.entries(photoIdAliasRef.current).forEach(([localId, canonicalId]) => {
    if (!canonicalPhotoIdMap.has(localId)) {
      canonicalPhotoIdMap.set(localId, canonicalId);
    }
  });
  if (user) {
    const byPhoto = new Map<string, string[]>();
    newApproved.forEach((book, i) => {
      const dbId = approvedDbIds[i];
      if (!dbId) return;
      const rawPid = (book as any).source_photo_id ?? photoIdForApproved;
      // Resolve to canonical: prefer canonicalPhotoIdMap (current-session dedupe), then
      // alias map (prior-session dedupe via resolvePhotoIdLogged). Never pass a local
      // alias as the photo FK — it has no row in the photos table.
      const pid = rawPid
        ? (canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoIdLogged(rawPid, 'approve') ?? rawPid)
        : undefined;
      if (pid && typeof pid === 'string') {
        if (pid !== rawPid) {
          logger.debug('[BATCH_FK_PATCH_CANONICAL_RESOLVED]', {
            localId: rawPid.slice(0, 8),
            canonicalId: pid.slice(0, 8),
            bookKey: computeBookKey(book),
          });
        }
        if (!byPhoto.has(pid)) byPhoto.set(pid, []);
        byPhoto.get(pid)!.push(dbId);
      }
    });
    if (byPhoto.size > 0) {
      logger.debug('[BATCH_FK_PATCH_PLAN]', {
        distinctPhotoIds: byPhoto.size,
        totalBooks: [...byPhoto.values()].reduce((n, ids) => n + ids.length, 0),
        deduped: [...canonicalPhotoIdMap.entries()].filter(([l, c]) => l !== c).length,
      });
    }
    await Promise.all(
      [...byPhoto.entries()].map(([pid, ids]) =>
        batchPatchSourcePhotoId(user.uid, pid, ids)
      )
    );
  }

    // Single summary for all preflight DB lookups in this batch (replaces N×[BOOK_PREFLIGHT_DB_BY_KEY] lines).
    if (_preflightResults.length > 0) {
      const _pfExisting = _preflightResults.filter(r => r.rowFound).length;
      const _pfWillUpsert = _preflightResults.filter(r => !r.rowFound).length;
      const _pfMismatch = _preflightResults.filter(r => r.photoIdMismatch).length;
      const _pfErrors = _preflightResults.filter(r => r.error).length;
      // Only include anomaly sample when there are real problems (mismatches or errors).
      // "willUpsert > 0" is normal for a first-time approve and must not look like an error.
      const _realAnomalies = _preflightResults.filter(r => r.photoIdMismatch || r.error);
      const logFn = (_pfMismatch > 0 || _pfErrors > 0) ? logger.warn : logger.debug;
      logFn('[BOOK_PREFLIGHT_SUMMARY]', {
        total: _preflightResults.length,
        existingOnServer: _pfExisting,
        willUpsert: _pfWillUpsert,
        ...(_pfMismatch > 0 && { photoIdMismatches: _pfMismatch }),
        ...(_pfErrors > 0 && { errors: _pfErrors }),
        ...(_realAnomalies.length > 0 && {
          anomalySample: _realAnomalies.slice(0, 5).map(r => ({
            bookKey: r.bookKey,
            photoIdMismatch: r.photoIdMismatch,
            error: r.error,
          })),
        }),
      });
    }

 const allResults = [...bookResults, ...photoResults];
 const approveStart = newPending.length;
 const approveResults = allResults.slice(approveStart, approveStart + newApproved.length);
 const photoStart = approveStart + newApproved.length + newRejected.length;
 const pendingOk = allResults.slice(0, newPending.length).filter(Boolean).length;
 const approvedOk = approveResults.filter(Boolean).length;
 const rejectedOk = allResults.slice(approveStart + newApproved.length, photoStart).filter(Boolean).length;
 const photosOk = allResults.slice(photoStart).filter(Boolean).length;
 if (pendingOk > 0 || newPending.length === 0) logger.debug('[APPROVE_SAVE_BOOKS_OK]', { type: 'pending', count: pendingOk });
 if (approvedOk > 0 || newApproved.length === 0) logger.debug('[APPROVE_SAVE_BOOKS_OK]', { type: 'approved', count: approvedOk });
 if (rejectedOk > 0 || newRejected.length === 0) logger.debug('[APPROVE_SAVE_BOOKS_OK]', { type: 'rejected', count: rejectedOk });
 const failedPending = newPending.length - pendingOk;
 const failedApproved = newApproved.length - approvedOk;
 const failedRejected = newRejected.length - rejectedOk;
if (failedPending > 0) logger.warn('[APPROVE_SAVE_BOOKS_FAIL]', { type: 'pending', count: failedPending, err: 'returned false' });
if (failedApproved > 0) {
  // If failedApproved > 0, the most common cause is APPROVE_PROVENANCE_GUARD_BLOCKED in
  // saveBookToSupabase — a book had no valid UUID source_photo_id so the guard returned false
  // to avoid a DB FK violation. The books stay status='pending' on server (never flipped to
  // 'approved'), which is exactly what [APPROVE_VERIFY_IDS] notApprovedStatus shows.
  // Diagnostic: log which approved books failed and their source_photo_id state.
  const failedBooks = newApproved.filter((_, i) => !approveResults[i]);
  logger.error('[APPROVE_SAVE_BOOKS_FAIL]', {
    type: 'approved',
    count: failedApproved,
    err: 'returned false — likely APPROVE_PROVENANCE_GUARD_BLOCKED (no valid source_photo_id)',
    failedSample: failedBooks.slice(0, 5).map(b => ({
      title: b.title?.slice(0, 30),
      id: b.id ?? null,
      source_photo_id: (b as any).source_photo_id ?? null,
      source_scan_job_id: (b as any).source_scan_job_id ?? null,
    })),
    canonicalPhotoIdMapSize: canonicalPhotoIdMap.size,
    canonicalPhotoIdMapSample: [...canonicalPhotoIdMap.entries()].slice(0, 3).map(([k, v]) => ({
      local: k.slice(0, 8),
      canonical: v.slice(0, 8),
    })),
  });
}
if (failedRejected > 0) logger.warn('[APPROVE_SAVE_BOOKS_FAIL]', { type: 'rejected', count: failedRejected, err: 'returned false' });
 logger.info('[APPROVE_SAVE]', {
 booksPending: newPending.length,
 booksApproved: newApproved.length,
 booksRejected: newRejected.length,
 photosSaved: photosOk,
 photosAttempted: photosToSaveFiltered.length,
 });
 logger.info('[TIMING]', { op: 'upsert_books', ms: Date.now() - _approveT0, totalFromClick: Date.now() - _approveClickT0, counts: { approved: newApproved.length, pending: newPending.length, photos: photosToSaveFiltered.length } });
 const failed = approveResults.filter((r) => !r).length;
 if (failed > 0) {
 flushApproveDupes(logger);
 const failedBookKeys = newApproved
 .filter((_, i) => !approveResults[i])
 .map((b) => computeBookKey(b));
 const failedIds = newApproved.filter((_, i) => !approveResults[i]).map((b) => b.id ?? b.title);
 logger.warn('[APPROVE_FAILED]', {
 failedCount: failed,
 failedBookKeys,
 failedIds: failedIds.slice(0, 10),
 jobClosed: false,
 });
 throw new Error(
 `Approve failed: ${failed} book(s) could not be saved (e.g. network or server error). Please retry. Leave everything as pending.`
 );
 }

 // ── ID Backfill: guarantee every approved book has a server UUID ────────────────
 // onSuccess(dbId) is called per-book as saves complete, populating approvedDbIds[i].
 // If a save returned false (provenance error, network hiccup, etc.) onSuccess was never
 // called and approvedDbIds[i] is undefined. Those books would end up with id=undefined
 // or a local temp-id, causing:
 //   - booksByIdSize < approvedLen → REHYDRATE_INVARIANT_VIOLATION
 //   - 18 books invisible in the UI, showing only the 7 that had real ids
 //
 // Fix: one targeted SELECT after all saves settle. For every index where approvedDbIds[i]
 // is still undefined, look up the server row by (user_id, book_key) and fill in the id.
 // This is authoritative — the DB is the source of truth for ids.
 {
   const missingIndices = newApproved
     .map((_, i) => i)
     .filter(i => !approvedDbIds[i]);
   if (missingIndices.length > 0) {
     const missingKeys = missingIndices.map(i => computeBookKey(newApproved[i])).filter(Boolean);
     logger.warn('[APPROVE_ID_BACKFILL]', {
       missingCount: missingIndices.length,
       sampleKeys: missingKeys.slice(0, 5),
       note: 'onSuccess was not called for these books; backfilling server ids by book_key',
     });
     try {
       // Fetch in pages of 100 book_keys (safe for IN clause)
       const PAGE = 100;
       const keyToId = new Map<string, string>();
       for (let p = 0; p < missingKeys.length; p += PAGE) {
         const chunk = missingKeys.slice(p, p + PAGE);
         const { data: rows, error: backfillErr } = await supabase
           .from('books')
           .select('id, book_key')
           .eq('user_id', user.uid)
           .in('book_key', chunk)
           .is('deleted_at', null);
         if (backfillErr) {
           logger.warn('[APPROVE_ID_BACKFILL]', 'backfill query failed', { err: backfillErr.message });
           break;
         }
         (rows ?? []).forEach((r: { id: string; book_key: string | null }) => {
           if (r.book_key) keyToId.set(r.book_key, r.id);
         });
       }
       // Fill in the recovered ids
       let recovered = 0;
       missingIndices.forEach(i => {
         const key = computeBookKey(newApproved[i]);
         const id = key ? keyToId.get(key) : undefined;
         if (id) {
           approvedDbIds[i] = id;
           recovered++;
         }
       });
       logger.info('[APPROVE_ID_BACKFILL]', {
         missingCount: missingIndices.length,
         recovered,
         stillMissing: missingIndices.length - recovered,
       });
     } catch (backfillEx: any) {
       logger.warn('[APPROVE_ID_BACKFILL]', 'backfill threw', { err: backfillEx?.message ?? String(backfillEx) });
     }
   }
 }

 // Replace synthetic ids with server DB ids so we never persist photoId_title_p_* / book_* as canonical.
 const nowForSync = Date.now();
  const approvedWithRealIds: Book[] = newApproved.map((b, i) => {
    const dbId = approvedDbIds[i];
    const base = { ...b, identity_locked: true as const, status: 'approved' as const };
    // Canonicalize source_photo_id so books persisted to state and AsyncStorage always reference
    // the server-canonical photo ID. If the book has none, stamp from approve context so client
    // join (countsByPhotoId / book.source_photo_id === photo.id) works and UI shows booksCount > 0.
    let rawPid = (base as any).source_photo_id;
    if (!rawPid && photoIdForApproved) {
      rawPid = photoIdForApproved;
      (base as any).source_photo_id = undefined; // resolve below
      (base as any).sourcePhotoId = undefined;
      (base as any).photoId = undefined;
    }
    if (rawPid) {
      const resolvedPid = canonicalPhotoIdMap.get(rawPid) ?? resolvePhotoIdLogged(rawPid, 'approve_with_real_ids') ?? rawPid;
      (base as any).source_photo_id = resolvedPid;
      (base as any).sourcePhotoId = resolvedPid;
      (base as any).photoId = resolvedPid;
    }
    if (!(base as any).source_scan_job_id && scanJobIdForApproved) {
      (base as any).source_scan_job_id = scanJobIdForApproved;
      (base as any).scanJobId = scanJobIdForApproved;
    }
    if (dbId) {
      return { ...base, id: dbId, dbId };
    }
    // Backfill above should have resolved all ids. If still missing, mark as pending-retry
    // so syncPendingApprovedBooks picks it up on the next rehydrate rather than silently
    // appearing with a null id in the canonical booksById map.
    logger.warn('[APPROVE_ID_MISSING]', {
      bookKey: computeBookKey(b),
      title: b.title,
      note: 'id still null after backfill — will retry on next sync',
    });
    return { ...base, sync_state: 'pending' as const, sync_pending_at: nowForSync };
  });

 // ── Post-backfill invariant + recovery fetch ───────────────────────────────
 // All approved books MUST have a server UUID after the backfill above.
 // If any are still missing, do ONE recovery fetch (fetchAllApprovedBooks) to pull
 // the full canonical server list and inject real IDs into approvedWithRealIds.
 // This covers the case where:
 //   a) computeBookKey normalization differs between client and DB (backfill miss)
 //   b) saveBookToSupabase returned false for all books (onSuccess never fired)
 //   c) DB stored the row under a different book_key variant
 //
 // Invariant requirement (must hold after approve):
 //   approvedBooksWithNoId === 0
 //   booksByIdSize === approvedLen
 //   photosByIdSize === photosLen
 const UUID_REGEX_CHECK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 let _missingIdCountPost = approvedWithRealIds.filter(b => !b.id || !UUID_REGEX_CHECK.test(b.id)).length;

 if (_missingIdCountPost > 0) {
   logger.warn('[APPROVE_ID_INVARIANT]', {
     missingIdCount: _missingIdCountPost,
     total: approvedWithRealIds.length,
     sampleMissing: approvedWithRealIds
       .filter(b => !b.id || !UUID_REGEX_CHECK.test(b.id))
       .slice(0, 5)
       .map(b => ({ title: b.title, id: b.id ?? null, bookKey: computeBookKey(b) })),
     action: 'triggering_recovery_fetch',
   });

   // Recovery fetch: pull ALL approved books from DB and merge IDs into approvedWithRealIds.
   // This is the authoritative source — if the book row exists in DB, we get its id here.
   try {
     const { fetchAllApprovedBooks } = await import('../services/supabaseSync');
     const recoveryRows = await fetchAllApprovedBooks(user.uid);
     // Build a map from every possible key variant → DB row id.
     // Use both title+author (lower-trimmed) and stored book_key so we match
     // even when computeBookKey normalization differs slightly.
     const keyToRecoveryId = new Map<string, string>();
     for (const row of recoveryRows) {
       if (!row.id) continue;
       if (row.book_key) keyToRecoveryId.set(row.book_key, row.id);
       // Also index by raw title|author (fallback when book_key differs).
       const rawKey = `${(row.title ?? '').toLowerCase().trim()}|${(row.author ?? '').toLowerCase().trim()}`;
       if (rawKey && rawKey !== '|') keyToRecoveryId.set(rawKey, row.id);
     }

     let recoveredByRecovery = 0;
     for (let i = 0; i < approvedWithRealIds.length; i++) {
       const b = approvedWithRealIds[i];
       if (b.id && UUID_REGEX_CHECK.test(b.id)) continue; // already has an id
       // Try stored book_key first, then computed key, then raw title|author.
       const candidateKeys = [
         b.book_key,
         computeBookKey(b),
         `${(b.title ?? '').toLowerCase().trim()}|${(b.author ?? '').toLowerCase().trim()}`,
       ].filter((k): k is string => !!k && k !== '|');
       let recoveredId: string | undefined;
       for (const k of candidateKeys) {
         const found = keyToRecoveryId.get(k);
         if (found) { recoveredId = found; break; }
       }
       if (recoveredId) {
         approvedWithRealIds[i] = { ...b, id: recoveredId, dbId: recoveredId };
         approvedDbIds[i] = recoveredId;
         recoveredByRecovery++;
       }
     }

     _missingIdCountPost = approvedWithRealIds.filter(b => !b.id || !UUID_REGEX_CHECK.test(b.id)).length;
     logger.info('[APPROVE_ID_RECOVERY]', {
       recoveryRowsFromDB: recoveryRows.length,
       recoveredByRecovery,
       stillMissingAfterRecovery: _missingIdCountPost,
       note: _missingIdCountPost === 0
         ? 'All IDs resolved via recovery fetch — invariant satisfied'
         : 'Some books still have no DB id; they will retry on next sync',
     });
   } catch (recoveryErr: any) {
     logger.warn('[APPROVE_ID_RECOVERY]', 'recovery fetch threw', {
       err: recoveryErr?.message ?? String(recoveryErr),
       stillMissing: _missingIdCountPost,
     });
   }
 }

 if (_missingIdCountPost > 0) {
   // Still missing after recovery — log but do not block. Books will show in UI
   // but won't be in booksById until the next rehydrate sync picks them up.
   logger.warn('[APPROVE_ID_INVARIANT_VIOLATED]', {
     missingIdCount: _missingIdCountPost,
     total: approvedWithRealIds.length,
     note: 'approvedBooksWithNoId > 0 after recovery fetch; next sync will retry',
   });
 } else {
   logger.debug('[APPROVE_ID_INVARIANT]', { ok: true, total: approvedWithRealIds.length });
 }
 // ── End post-backfill invariant ────────────────────────────────────────────

 const wroteThisCall = newApproved.length;
 const idsToApprove = approvedWithRealIds.map((b) => b.id).filter(Boolean) as string[];
 const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const uuidIds = idsToApprove.filter((id) => UUID_REGEX.test(id));
 let verifyOk = true;
 let verifyReason = '';

 // Strengthened verify: runs in background (fire-and-forget) — does NOT block approve completion
 // but sets verifyOk=false and logs warnings that will surface in [APPROVE_COMPLETE].
 // Checks:
 //   1. All expected book IDs exist on server with status=approved
 //   2. Every book has a non-null source_photo_id pointing to a real photo row
 //   3. Every photo row has storage_path (confirming the photo is in storage, not a local draft)
 //   4. Count of books per scan job matches the SCAN_IMPORT bookCount for this approve session
 if (uuidIds.length > 0) {
   // Compute expected per-job book counts from SCAN_IMPORT telemetry captured this session.
   // `importedBookCountByJobId` is built in the batch pipeline: jobId -> bookCount.
   const expectedCountsByJob: Record<string, number> = {};
   const approvedByJob: Record<string, string[]> = {};
   approvedWithRealIds.forEach((b) => {
     const jid = (b as any).source_scan_job_id as string | undefined;
     const bid = b.id;
     if (jid && bid) {
       approvedByJob[jid] = approvedByJob[jid] ?? [];
       approvedByJob[jid].push(bid);
     }
   });
   // Use SCAN_IMPORT counts captured by enqueueBatch (importedBookCountByJobId ref).
   Object.keys(approvedByJob).forEach((jid) => {
     const imported = importedBookCountByJobIdRef.current?.[jid];
     if (imported != null) expectedCountsByJob[jid] = imported;
   });

  // ── VERIFY QUERY AUDIT (fire-and-forget — pure diagnostic, never blocks the button) ──
  // Verify uses the same filters as fetchAll: status='approved' AND deleted_at IS NULL
  // so "wouldPass" / "wouldFail" match fetchAll semantics (no mismatch from soft-deleted rows).
  Promise.resolve(
    supabase
      .from('books')
      .select('id, status, deleted_at')
      .eq('user_id', user.uid)
      .eq('status', 'approved')
      .is('deleted_at', null)
      .in('id', uuidIds)
  ).then(({ data: _verifyCompareRows = [] }) => {
      const _approvedNullDeleted  = (_verifyCompareRows ?? []).filter((r: any) => r.status === 'approved' && !r.deleted_at).length;
      const _notApprovedOrDeleted = (_verifyCompareRows ?? []).filter((r: any) => r.status !== 'approved' || !!r.deleted_at);
      const _verifyAuditLevel = _notApprovedOrDeleted.length > 0 ? 'warn' : 'debug';
      logger[_verifyAuditLevel]('[VERIFY_VS_FETCHALL_AUDIT]', {
        verifyQueryFilters: "user_id + in(ids) + status='approved' + deleted_at IS NULL (matches fetchAll)",
        verifyTotalFound: (_verifyCompareRows ?? []).length,
        fetchAllQueryFilters: "status='approved' AND deleted_at IS NULL",
        wouldPassFetchAllFilter: _approvedNullDeleted,
        wouldFailFetchAllFilter: _notApprovedOrDeleted.length,
        actualStatusValues: Array.from(new Set((_verifyCompareRows ?? []).map((r: any) => JSON.stringify(r.status)))),
        failingSample: _notApprovedOrDeleted.slice(0, 5).map((r: any) => ({
          id: r.id?.slice(0, 8),
          status: r.status,
          deleted_at: r.deleted_at,
        })),
      });
    })
    .catch(() => {});

  Promise.all([
    // Check 1+2: fetch approved book rows (same filters as fetchAll: status + deleted_at IS NULL).
    // user_id is selected so we can audit whether rows were inserted under the wrong user_id
    // (e.g. short id "bf672ff5" instead of full UUID) — the smoking gun for snapshot returning 0.
    supabase.from('books').select('id, status, source_photo_id, user_id').eq('user_id', user.uid).eq('status', 'approved').is('deleted_at', null).in('id', uuidIds),
  ]).then(async ([booksRes]) => {
    const bookRows = booksRes.data ?? [];
    const bookRowsById = new Map(bookRows.map((r: { id: string; status: string | null; source_photo_id: string | null; user_id: string | null }) => [r.id, r]));

    // USER_ID AUDIT: prove whether returned rows actually carry the querying user_id.
    // If row.user_id !== user.uid the row was inserted under a different identity and
    // the full-snapshot query (which also filters by user_id) will miss it — this is
    // exactly how "verify finds 18 books but snapshot returns 0" happens.
    {
      const matchingUserIdCount = bookRows.filter((r: { user_id: string | null }) => r.user_id === user.uid).length;
      const mismatchRows = bookRows.filter((r: { user_id: string | null }) => r.user_id !== user.uid);
      const mismatchSample = mismatchRows.slice(0, 3).map((r: { id: string; user_id: string | null }) => ({
        bookId: r.id.slice(0, 8),
        rowUserId: r.user_id ?? null,
        queryUserId: user.uid,
      }));
      const auditFn = mismatchRows.length > 0 ? logger.error : logger.info;
      auditFn('[APPROVE_VERIFY_USERID_AUDIT]', {
        queryUserIdFull: user.uid,
        totalRowsReturned: bookRows.length,
        matchingUserIdCount,
        mismatchCount: mismatchRows.length,
        mismatchSample,
        ok: mismatchRows.length === 0,
      });
    }

     // Check 1: all expected IDs found as approved
     const foundIds = new Set(bookRows.map((r: { id: string }) => r.id));
     const missingIds = uuidIds.filter(id => !foundIds.has(id));
     const notApproved = bookRows.filter((r: { status: string | null }) => r.status !== 'approved');

     // Check 2: books missing source_photo_id
     const missingPhotoFk = bookRows.filter((r: { source_photo_id: string | null }) => !r.source_photo_id);

     // Collect all distinct source_photo_ids
     const distinctPhotoIds = [...new Set(
       bookRows.map((r: { source_photo_id: string | null }) => r.source_photo_id).filter((x): x is string => !!x)
     )];

     // Check 3: photo rows exist and have storage_path
     let photosWithoutStorage: string[] = [];
     let missingPhotoRows: string[] = [];
     if (distinctPhotoIds.length > 0) {
       const { data: photoRows } = await supabase
         .from('photos')
         .select('id, storage_path')
         .eq('user_id', user.uid)
         .in('id', distinctPhotoIds);
       const photoMap = new Map((photoRows ?? []).map((p: { id: string; storage_path: string | null }) => [p.id, p]));
       missingPhotoRows = distinctPhotoIds.filter(pid => !photoMap.has(pid));
       photosWithoutStorage = [...photoMap.values()]
         .filter((p: { storage_path: string | null }) => !p.storage_path)
         .map((p: { id: string; storage_path: string | null }) => p.id.slice(0, 8));
     }

     // Check 4: per-job book count vs SCAN_IMPORT expected count.
     // "expected" = client-inserted pending count (deduped.length only, incomplete books excluded)
     // "actual"   = books from that job that landed on server as approved
     // A mismatch here is a real drop (not an expected incomplete-filter difference).
     const countMismatches: Array<{ jobId: string; expected: number; actual: number }> = [];
     Object.entries(approvedByJob).forEach(([jid, bookIds]) => {
       const expected = expectedCountsByJob[jid];
       if (expected == null) return; // no telemetry for this job, skip
       const actual = bookIds.filter(id => foundIds.has(id)).length;
       if (actual !== expected) countMismatches.push({ jobId: jid.slice(0, 8), expected, actual });
     });

     // Count-level mismatch: foundIds.size < uuidIds.length means at least one ID
     // was sent but not returned by the DB query. This can happen even when missingIds
     // is empty if uuidIds contains duplicate entries (same ID twice) — in that case
     // the DB returns it once, foundIds has N unique IDs, but uuidIds.length > N.
     // Either way it's a signal worth surfacing.
     const hasSizeMismatch = foundIds.size < uuidIds.length;
     if (hasSizeMismatch && missingIds.length === 0) {
       logger.warn('[APPROVE_VERIFY_COUNT_GAP]', {
         expected: uuidIds.length,
         found: foundIds.size,
         gap: uuidIds.length - foundIds.size,
         note: 'foundIds.size < uuidIds.length but missingIds=[]; likely duplicate IDs in uuidIds (same book approved twice)',
         dupIds: uuidIds.filter((id, i) => uuidIds.indexOf(id) !== i).slice(0, 5).map(id => id.slice(0, 8)),
       });
     }

     const hasHardIssues = missingIds.length > 0 || hasSizeMismatch || notApproved.length > 0
       || missingPhotoFk.length > 0 || missingPhotoRows.length > 0 || photosWithoutStorage.length > 0;
     const hasCountMismatch = countMismatches.length > 0;
     const hasIssues = hasHardIssues || hasCountMismatch;

     // Log the verify result with its own tag so it's easy to find regardless of
     // when it fires relative to [APPROVE_COMPLETE] (verify is fire-and-forget).
     const logFn = hasIssues ? logger.warn : logger.info;
     logFn('[APPROVE_VERIFY_IDS]', {
       totalExpected: uuidIds.length,
       totalFound: foundIds.size,
       missingFromServer: missingIds.slice(0, 5).map(id => id.slice(0, 8)),
       notApprovedStatus: notApproved.slice(0, 5).map((r: { id: string; status: string | null }) => ({ id: r.id.slice(0, 8), status: r.status })),
       booksWithNullPhotoFk: missingPhotoFk.slice(0, 5).map((r: { id: string }) => r.id.slice(0, 8)),
       distinctPhotoIdsOnBooks: distinctPhotoIds.length,
       missingPhotoRows: missingPhotoRows.slice(0, 5),
       photosWithoutStoragePath: photosWithoutStorage.slice(0, 5),
       perJobCountMismatches: countMismatches,
       sampleBooks: [...bookRowsById.values()].slice(0, 5).map((b: { id: string; source_photo_id: string | null }) => ({
         bookId: b.id.slice(0, 8),
         source_photo_id: b.source_photo_id?.slice(0, 8) ?? null,
       })),
     });

     if (hasIssues) {
       verifyOk = false;
       verifyReason = [
         missingIds.length > 0 ? `${missingIds.length} book(s) missing from server` : '',
         hasSizeMismatch && missingIds.length === 0 ? `count gap: sent ${uuidIds.length} ids, server returned ${foundIds.size} (likely duplicate ids)` : '',
         missingPhotoFk.length > 0 ? `${missingPhotoFk.length} book(s) have null source_photo_id` : '',
         missingPhotoRows.length > 0 ? `${missingPhotoRows.length} photo row(s) missing` : '',
         photosWithoutStorage.length > 0 ? `${photosWithoutStorage.length} photo(s) without storage_path` : '',
         countMismatches.length > 0 ? `per-job count mismatch on ${countMismatches.length} job(s)` : '',
       ].filter(Boolean).join('; ');

       // Surface the mismatch in the UI so it's visible — not just in logs.
       // Hard issues (missing rows, null FKs) get a warning banner.
       // Count-only mismatch gets a softer "N of M imported" note — it may be a dedupe
       // collapse or one filtered book, not necessarily a data-loss bug.
       if (hasHardIssues) {
         const parts: string[] = [];
         if (missingIds.length > 0) parts.push(`${missingIds.length} book(s) not found on server`);
         if (missingPhotoFk.length > 0) parts.push(`${missingPhotoFk.length} missing photo link(s)`);
         if (missingPhotoRows.length > 0) parts.push(`${missingPhotoRows.length} photo row(s) missing`);
         setApproveError(`Import issue: ${parts.join(', ')}. Your books were saved — this may resolve after a refresh.`);
       } else if (hasCountMismatch) {
         // Count mismatch only — softer message.
         const totalExpected = countMismatches.reduce((s, m) => s + m.expected, 0);
         const totalActual = countMismatches.reduce((s, m) => s + m.actual, 0);
         const dropped = totalExpected - totalActual;
         setApproveError(
           `${totalActual} of ${totalExpected} book${totalExpected !== 1 ? 's' : ''} imported` +
           ` (${dropped} may be a duplicate or was filtered). Your library was saved.`
         );
       }
     }
     // Emit a dedicated result log so the verify outcome is always visible even
     // though it fires asynchronously after [APPROVE_COMPLETE].
     if (hasIssues) {
       logger.warn('[APPROVE_VERIFY_RESULT]', {
         verifyOk: false,
         verifyReason,
         hasHardIssues,
         hasCountMismatch,
         countMismatches,
         uiMessageShown: hasHardIssues || hasCountMismatch,
       });
     } else {
       logger.info('[APPROVE_VERIFY_RESULT]', { verifyOk: true });
     }
   }).catch((err: unknown) => {
     verifyOk = false;
     verifyReason = `verify query failed: ${(err as any)?.message ?? String(err)}`;
     logger.warn('[APPROVE_VERIFY_RESULT]', { verifyOk: false, verifyReason });
   });
 }

 // PHOTO_ROW_LOOKUP: confirm the photo IDs referenced by approved books exist on server.
 {
   const postApprovePhotoIds = [...new Set(newApproved.map((b) => (b as any).source_photo_id).filter((x: unknown): x is string => typeof x === 'string' && x.length > 0))];
   logPhotoRowLookup(postApprovePhotoIds, 'post_approve').catch(() => {});
 }
  flushApproveDupes(logger);
  const approvedScanJobIds = [...new Set(newApproved.map((b) => (b as any).source_scan_job_id).filter(Boolean))] as string[];
 // Do NOT persist here with synthetic ids; we persist after merge with approvedWithRealIds.

 const jobIdsToClose =
 options?.jobIdsToClose?.length > 0
 ? options.jobIdsToClose
 : getJobIdsToCloseFromApproved(
 newApproved,
 options?.scanJobIdForApproved ? toScanJobId(options.scanJobIdForApproved) : undefined
 ).jobIdsToClose;
 // scan-mark-imported: fire-and-forget — never blocks the button.
 // Mark jobs as imported in the background; jobClosed is updated optimistically via closedScanJobIdsRef.
 let jobClosed = false;
 if (jobIdsToClose.length > 0) {
   jobIdsToClose.forEach((id) => closedScanJobIdsRef.current.add(id));
   jobClosed = true;
   ;(async () => {
     const baseUrl = getApiBaseUrl();
     if (!baseUrl) return;
     try {
       const { getScanAuthHeaders: _getScanAuthHeaders2 } = await import('../lib/authHeaders');
       const _markImportedHeaders = await _getScanAuthHeaders2();
       await fetch(`${baseUrl}/api/scan-mark-imported`, {
         method: 'POST',
         headers: { ..._markImportedHeaders, 'Content-Type': 'application/json' },
         body: JSON.stringify({ jobIds: jobIdsToClose }),
       });
     } catch (err) {
       logger.warn('[scan-mark-imported]', (err as Error)?.message ?? err);
     }
   })();
 }

 // Update idAlias so tempId -> canonicalId; prevents churn when resolving refs (e.g. folder.bookIds).
 const UUID_REGEX_ALIAS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const newAliases: Record<string, string> = {};
 newApproved.forEach((b, i) => {
 const tempId = b.id;
 const canonicalId = approvedDbIds[i];
 if (tempId && canonicalId && !UUID_REGEX_ALIAS.test(tempId) && UUID_REGEX_ALIAS.test(canonicalId)) {
 newAliases[tempId] = canonicalId;
 }
 });
 if (Object.keys(newAliases).length > 0) {
 idAliasRef.current = { ...idAliasRef.current, ...newAliases };
 const aliasKey = `approved_book_id_aliases_${user.uid}`;
 await AsyncStorage.setItem(aliasKey, JSON.stringify(idAliasRef.current));
 }

  // ── Optimistic local merge (no blocking server fetch) ────────────────────────
  // Commit local state immediately so the button re-enables in ~ms.
  // The fire-and-forget IIFE below will overwrite with the ground-truth server
  // snapshot once DB writes have propagated (~800ms + network).
  const photoIdAliasForMerge: Record<string, string> = {};
  photoRewriteMap.forEach((rewrite, localId) => { photoIdAliasForMerge[localId] = rewrite.canonicalId; });
  const mergeByBookKey = (server: Book[], local: Book[]): Book[] => {
    const byKey = new Map<string, Book>();
    server.forEach((b) => {
      const k = getStableBookKey(b);
      byKey.set(k, { ...b, book_key: b.book_key ?? k });
    });
    local.forEach((b) => {
      const k = getStableBookKey(b);
      const existing = byKey.get(k);
      const localWithKey = { ...b, book_key: b.book_key ?? k };
      byKey.set(k, existing ? mergeBookFieldLevel(existing, localWithKey, photoIdAliasForMerge) : localWithKey);
    });
    return [...byKey.values()];
  };
  // Use local approved list as the optimistic state (server refresh overwrites via IIFE).
  const refreshed = { approved: [] as Book[], pending: [] as Book[] };
 const now = Date.now();
 // Apply photo ID rewrites from dedupe BEFORE building photosWithAccepted.
 // Without this, newPhotos still carries the local UUID (e.g. 9baa...) even though the
 // DB canonical is different (e.g. 6c0f...). The corrupt-photo filter then sees
 // storage_url:null on the local-UUID photo and drops it, and FK patches can never
 // find the photo row.
const newPhotosRewritten: Photo[] = newPhotos.map((p: Photo) => {
const localId = p.id ?? '';
const rewrite = photoRewriteMap.get(localId);
// Case A: ID changed (dedupe to different canonical). Replace ID + hydrate storage.
if (rewrite) {
  const patched: Photo = { ...p, id: rewrite.canonicalId };
  if (rewrite.storagePath && !(patched as any).storage_path) {
    (patched as any).storage_path = rewrite.storagePath;
  }
  if (rewrite.storageUrl && !(patched as any).storage_url) {
    (patched as any).storage_url = rewrite.storageUrl;
  }
  return patched;
}
// Case B: ID same but local photo object has null storage fields (drafted from scan ingestion).
// Hydrate from canonicalStorageMap so photosWithAccepted can stamp status:'complete'.
// Without this, photos saved with no local URI appear as 'draft' indefinitely even though
// the DB row has valid storage_path/storage_url, causing photosWithApprovedBooks to drop them.
const storageFix = canonicalStorageMap.get(localId);
if (storageFix) {
  const hasLocalStorage = !!((p as any).storage_path?.trim?.() || (p as any).storage_url?.startsWith?.('http'));
  if (!hasLocalStorage) {
    const patched: Photo = { ...p };
    if (storageFix.storagePath) (patched as any).storage_path = storageFix.storagePath;
    if (storageFix.storageUrl) {
      (patched as any).storage_url = storageFix.storageUrl;
      // Also set uri so PhotoTile can display even before signed URL regenerates.
      if (!(patched as any).uri?.startsWith?.('http')) {
        (patched as any).uri = storageFix.storageUrl;
      }
    }
    // hadStoragePath:true, hadStorageUrl:false is normal for private-bucket photos
    // (storage_url is not persisted; PhotoTile derives a signed URL from storage_path).
    logger.debug('[PHOTO_STORAGE_HYDRATE]', {
      photoId: localId.slice(0, 8),
      hadStoragePath: !!(patched as any).storage_path,
      hadStorageUrl: !!(patched as any).storage_url,
    });
    return patched;
  }
}
return p;
});
 // INVARIANT: for every rewrite entry, the canonical photo MUST exist in newPhotosRewritten.
 // If the local placeholder was not in newPhotos (e.g. prior-session photo), inject the
 // canonical row now so photosWithAccepted and AsyncStorage always contain it.
 const rewrittenIds = new Set(newPhotosRewritten.map((p: Photo) => p.id));
 photoRewriteMap.forEach((rewrite, localId) => {
   if (!rewrittenIds.has(rewrite.canonicalId)) {
     // Build a minimal canonical row — storage fields come from the rewrite map.
     const localPlaceholder = newPhotos.find((p: Photo) => p.id === localId);
     const canonicalRow: Photo = enforcePhotoStorageStatus({
       ...(localPlaceholder ?? ({} as Photo)),
       id: rewrite.canonicalId,
       ...(rewrite.storagePath ? { storage_path: rewrite.storagePath } : {}),
       ...(rewrite.storageUrl ? { storage_url: rewrite.storageUrl, uri: rewrite.storageUrl } : {}),
     });
     newPhotosRewritten.push(canonicalRow);
     logger.info('[PHOTO_CANONICAL_INSERT]', {
       context: 'approve_rewrite',
       localPhotoId: localId.slice(0, 8),
       canonicalPhotoId: rewrite.canonicalId.slice(0, 8),
       hadStoragePath: !!rewrite.storagePath,
       status: canonicalRow.status ?? 'unknown',
     });
   }
 });
    // acceptedPhotoIds uses canonical IDs after the rewrite.
    // Fall back to resolvePhotoIdLogged for aliases from prior sessions not in this session's photoRewriteMap.
    const acceptedPhotoIds = new Set(photosToSave.map((p: Photo) => {
      const rewrite = photoRewriteMap.get(p.id ?? '');
      if (rewrite) return rewrite.canonicalId;
      return resolvePhotoIdLogged(p.id, 'approve') ?? p.id;
    }));
 const approvedCountByPhotoId = approvedWithRealIds.reduce<Record<string, number>>((acc, b) => {
 const sourcePhotoId = (b as any).source_photo_id;
 if (!sourcePhotoId) return acc;
 acc[sourcePhotoId] = (acc[sourcePhotoId] ?? 0) + 1;
 return acc;
 }, {});
 const photosWithAccepted = newPhotosRewritten.map((p: Photo) => {
 if (!acceptedPhotoIds.has(p.id)) return p;
 // Only stamp 'complete' when we have confirmed the photo is on storage.
 // After the ID rewrite above, p.storage_path is the canonical row's path (if available).
 // If storage_path is still null it means either: (a) the upload hasn't finished yet,
 // or (b) this is still a local placeholder. Leave it as 'draft' so the corrupt-photo
 // filter doesn't tombstone it and it gets a second chance on next approve/rehydrate.
 const hasStorage = !!(
 ((p as any).storage_path && ((p as any).storage_path as string).trim().length > 0) ||
 ((p as any).storage_url && ((p as any).storage_url as string).startsWith('http'))
 );
 const nextStatus: Photo['status'] = hasStorage ? 'complete' : 'draft';
 if (!hasStorage) {
 logger.debug('[PHOTO_STATUS_DEFER]', {
 photoId: p.id,
 reason: 'no_storage_path_after_approve',
 status: nextStatus,
 });
 }
 return {
 ...p,
 state: 'accepted' as const,
 accepted_at: now,
 sync_state: 'pending' as const,
 sync_pending_at: now,
 status: nextStatus,
 // Only set when known; never coerce to 0 so UI can treat undefined = "not ready".
 ...(approvedCountByPhotoId[p.id] != null ? { approved_count: approvedCountByPhotoId[p.id] } : {}),
 };
 });
 const serverApprovedWithKey = (refreshed.approved || []).map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) }));
 const localWithKey = approvedWithRealIds.map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) }));
 const mergedApproved = mergeByBookKey(serverApprovedWithKey, localWithKey);
 const mergedPending = mergeByBookKey((refreshed.pending || []).map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) })), newPending.map((b) => ({ ...b, book_key: b.book_key ?? getStableBookKey(b) })));
 logCanonicalIdentityAudit(mergedApproved, idAliasRef.current, 'approve_post_refresh');
 logger.debug('[STATE_PUBLISHED]', { statePublished: 'postMerge' });
 lastApprovedUpdateSourceRef.current = 'approve_post_refresh';

 // ── Post-approve invariant check ────────────────────────────────────────────
 // After merging with server, EVERY book must have a real server UUID.
 // If any are still missing (server returned 0 rows due to propagation delay,
 // or the recovery fetch above also returned nothing), schedule a retry in 2s.
 const _postMergeNoId = mergedApproved.filter(b => !b.id || !/^[0-9a-f-]{36}$/i.test(b.id)).length;
 logger.info('[APPROVE_POST_MERGE_INVARIANT]', {
   approvedLen: mergedApproved.length,
   approvedBooksWithNoId: _postMergeNoId,
   serverRowsReturned: serverApprovedWithKey.length,
   invariantOk: _postMergeNoId === 0,
 });
 if (_postMergeNoId > 0 && serverApprovedWithKey.length === 0) {
   // Server returned 0 rows — likely propagation delay. Schedule a single retry.
   logger.warn('[APPROVE_POST_MERGE_INVARIANT]', {
     action: 'scheduling_retry_refresh',
     delayMs: 2000,
     note: 'server returned 0 approved books immediately after approve; will retry once',
   });
   setTimeout(async () => {
     if (!user) return;
     try {
       const { fetchAllApprovedBooks } = await import('../services/supabaseSync');
       const retryRows = await fetchAllApprovedBooks(user.uid);
       if (retryRows.length === 0) {
         logger.warn('[APPROVE_RETRY_REFRESH]', 'still 0 rows on retry; invariant remains violated');
         return;
       }
       setApprovedBooks(prev => {
         const keyToId = new Map<string, string>();
         const keyToRow = new Map<string, { id: string; source_photo_id?: string | null; source_scan_job_id?: string | null }>();
         retryRows.forEach((r: { id?: string; book_key?: string | null; title?: string | null; author?: string | null; source_photo_id?: string | null; source_scan_job_id?: string | null }) => {
           if (!r.id) return;
           if (r.book_key) {
             keyToId.set(r.book_key, r.id);
             keyToRow.set(r.book_key, { id: r.id, source_photo_id: r.source_photo_id, source_scan_job_id: r.source_scan_job_id });
           }
           const raw = `${(r.title ?? '').toLowerCase().trim()}|${(r.author ?? '').toLowerCase().trim()}`;
           if (raw && raw !== '|') {
             keyToId.set(raw, r.id);
             keyToRow.set(raw, { id: r.id, source_photo_id: r.source_photo_id, source_scan_job_id: r.source_scan_job_id });
           }
         });
         let fixed = 0;
         const next = prev.map(b => {
           if (b.id && /^[0-9a-f-]{36}$/i.test(b.id)) return b;
           const candidates = [
             b.book_key,
             `${(b.title ?? '').toLowerCase().trim()}|${(b.author ?? '').toLowerCase().trim()}`,
           ].filter((k): k is string => !!k && k !== '|');
           for (const k of candidates) {
             const found = keyToId.get(k);
             const row = keyToRow.get(k);
             if (found && row) {
               fixed++;
               const out = { ...b, id: found, dbId: found };
               if (row.source_photo_id != null) {
                 (out as any).source_photo_id = row.source_photo_id;
                 (out as any).sourcePhotoId = row.source_photo_id;
                 (out as any).photoId = row.source_photo_id;
               }
               if (row.source_scan_job_id != null) {
                 (out as any).source_scan_job_id = row.source_scan_job_id;
                 (out as any).scanJobId = row.source_scan_job_id;
               }
               return out;
             }
           }
           return b;
         });
         const stillMissing = next.filter(b => !b.id || !/^[0-9a-f-]{36}$/i.test(b.id)).length;
         logger.info('[APPROVE_RETRY_REFRESH]', {
           retryRowCount: retryRows.length,
           fixedCount: fixed,
           stillMissing,
           invariantOk: stillMissing === 0,
         });
         if (fixed > 0) {
           const canonical = ensureApprovedOnePerBookKey(next);
           AsyncStorage.setItem(`approved_books_${user.uid}`, JSON.stringify(canonical)).catch(() => {});
           return canonical;
         }
         return prev;
       });
     } catch (retryErr: any) {
       logger.warn('[APPROVE_RETRY_REFRESH]', 'retry threw', { err: retryErr?.message ?? String(retryErr) });
     }
   }, 2000);
 }
 // ── End post-approve invariant check ────────────────────────────────────────

 logger.info('[TIMING]', { op: 'optimistic_commit', totalFromClick: Date.now() - _approveClickT0, counts: { approved: mergedApproved.length, pending: mergedPending.length } });
 const approvedCanonicalCommit = ensureApprovedOnePerBookKey(mergedApproved);
 setApprovedBooks(approvedCanonicalCommit);
 setPendingBooks(mergedPending);
 await Promise.all([
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(approvedCanonicalCommit)),
 AsyncStorage.setItem(userPendingKey, JSON.stringify(mergedPending)),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(newRejected)),
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(photosWithAccepted)),
 ]);
 logger.debug('[APPROVE_ASYNCSTORAGE_WRITE]', { key: userApprovedKey, countWritten: mergedApproved.length });
 logger.debug('[APPROVE_ASYNCSTORAGE_WRITE]', { key: userPendingKey, countWritten: mergedPending.length });
 logger.debug('[APPROVE_PERSIST]', {
 serverApproved: (refreshed.approved || []).length,
 serverPending: (refreshed.pending || []).length,
 mergedApproved: mergedApproved.length,
 mergedPending: mergedPending.length,
 photosSaved: photosWithAccepted.length,
 });
 const approvedIds = approvedCanonicalCommit.map((b) => b.id ?? b.dbId).filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
 if (approvedIds.length > 0) enqueueBookEnrichment(approvedIds);

// Log immediate approve outcome — perJob details arrive from background diagnostics below.
{
  const _canonicalIds = new Set([...canonicalPhotoIdMap.values()]);
  const _savedOkCount = photoResults.filter(Boolean).length;
  const _missingCount = photosToSaveFiltered.length - _savedOkCount;
  const _withPath = [...canonicalStorageMap.values()].filter(v => !!v.storagePath).length;
  const _withUrl = [...canonicalStorageMap.values()].filter(v => !!v.storageUrl).length;
  logger.info('[PHOTO_CANONICAL_STATUS]', {
    explicitLocalPhotoIdsCount: explicitPhotoIds.length,
    photosToSaveCount: photosToSaveFiltered.length,
    rewritesCount: photoRewriteMap.size,
    canonicalPhotoIdsCount: _canonicalIds.size,
    canonicalRowsFoundCount: _savedOkCount,
    missingCanonicalRowsCount: _missingCount,
    photosWithStoragePathCount: _withPath,
    photosWithStorageUrlCount: _withUrl,
    canonicalIdSample: [..._canonicalIds].slice(0, 3).map(id => id.slice(0, 8)),
  });
}
logger.info('[APPROVE_COMPLETE]', {
  upserted: wroteThisCall,
  verifyOk,
  verifyReason: verifyOk ? undefined : verifyReason,
  batchId: options?.batchIdForApproved ?? undefined,
  approvedScanJobIds,
  jobClosed,
  note: 'perJob diagnostic runs in background',
});
if (!verifyOk) logger.warn('[APPROVE] verify failed', { reason: verifyReason });

// ── Per-job and per-photo diagnostics (fire-and-forget — pure audit, never blocks button) ──
;(async () => {
  try {
    const perJobDiag: Record<string, { serverPendingCountAfterApprove: number; serverApprovedCountAfterApprove: number; scanJobStatusAfterApprove: string | null }> = {};
    await Promise.all(approvedScanJobIds.map(async (rawId) => {
      const [pendingRes, approvedRes, pendingRowsRes, jobRes] = await Promise.all([
        supabase.from('books').select('id', { count: 'exact', head: true }).eq('user_id', user.uid).eq('source_scan_job_id', rawId).eq('status', 'pending').is('deleted_at', null),
        supabase.from('books').select('id', { count: 'exact', head: true }).eq('user_id', user.uid).eq('source_scan_job_id', rawId).eq('status', 'approved').is('deleted_at', null),
        supabase.from('books').select('id, title, author, status, source_scan_job_id, updated_at').eq('user_id', user.uid).eq('source_scan_job_id', rawId).eq('status', 'pending').is('deleted_at', null),
        supabase.from('scan_jobs').select('status').eq('user_id', user.uid).eq('job_uuid', rawId).maybeSingle(),
      ]);
      const pendingCount = pendingRes.count ?? 0;
      const scanJobStatusAfterApprove = jobRes.data?.status ?? null;
      perJobDiag[rawId] = {
        serverPendingCountAfterApprove: pendingCount,
        serverApprovedCountAfterApprove: approvedRes.count ?? 0,
        scanJobStatusAfterApprove,
      };
      if (pendingCount > 0) {
        const rows = pendingRowsRes.data ?? [];
        logger.warn('[APPROVE_PENDING_LEFTOVER]', {
          scanJobId: rawId,
          scanJobStatusAfterApprove,
          pendingCount,
          pendingBookIds: rows.map((r: any) => r.id),
          pendingBooks: rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            author: r.author,
            status: r.status,
            source_scan_job_id: r.source_scan_job_id,
            updated_at: r.updated_at,
          })),
        });
      }
    }));
    logger.debug('[APPROVE_PERJOB_DIAG]', perJobDiag);

    // Per-photo link verification
    const verifyPhotoIds = Array.from(new Set(
      (explicitPhotoIds.length > 0
        ? explicitPhotoIds
        : approvedWithRealIds.map((b) => (b as any).source_photo_id).filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    ));
    await Promise.all(verifyPhotoIds.map(async (photoId) => {
      const linkedBooksInMemory = approvedWithRealIds.filter((b) => (b as any).source_photo_id === photoId).length;
      const { count, error: linkVerifyErr } = await supabase
        .from('books').select('id', { count: 'exact', head: true })
        .eq('user_id', user.uid).eq('source_photo_id', photoId)
        .eq('status', 'approved').is('deleted_at', null);
      logger.debug('[PHOTO_LINK_VERIFY]', {
        photoId,
        linkedBooksInMemory,
        linkedBooksInDB: count ?? 0,
        error: linkVerifyErr?.message ?? null,
      });
    }));
  } catch (diagErr: any) {
    logger.debug('[APPROVE_DIAG_BG]', 'background diagnostics threw (non-fatal)', { err: diagErr?.message ?? String(diagErr) });
  }
})();

// Photos and approved already merged/persisted above; just update in-memory photos and stamp.
setPhotos(photosWithAccepted);
// Stamp the post-approve lock immediately so any concurrent loadUserData
// (e.g. triggered by scan IIFE finally blocks) cannot overwrite canonical
// photo/book IDs with local AsyncStorage IDs before APPROVE_FULL_REFRESH runs.
// Without this, loadUserData reaches its lock check (line ~3704) before
// APPROVE_FULL_REFRESH sets the lock (800ms later), overwrites canonical IDs
// with local IDs, and APPROVE_FULL_REFRESH then merges 2 local + 2 canonical
// = 4 phantom photos (and 6 duplicate books).
postApproveLockUntilRef.current = Date.now() + POST_APPROVE_LOCK_MS;
const _stateCommittedAt = Date.now();
perfLog('approve', 'state_committed', { stateCommittedAt: _stateCommittedAt, booksApproved: mergedApproved.length });
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    perfLog('approve', 'list_rendered', { listRenderedAt: Date.now(), booksApproved: mergedApproved.length });
  });
});
await AsyncStorage.setItem(userPhotosKey, JSON.stringify(photosWithAccepted));
logger.debug('[APPROVE_ASYNCSTORAGE_WRITE]', { key: userPhotosKey, countWritten: photosWithAccepted.length });
lastApprovedAtRef.current = now;

logger.info('[APPROVE_DONE]', {
approvedNow: mergedApproved.length,
pendingNow: mergedPending.length,
photosNow: photosWithAccepted.length,
});
refreshProfileStats();

// ── Full-Refresh Barrier ────────────────────────────────────────────────────
// Re-fetch the FULL library (books + photos) from the server immediately after
// approve commits so any "1 photo / 7 books" mismatch between local state and
// DB is resolved on the same render cycle that cleared pending.
// This runs non-blocking (fire-and-forget after a short settle delay) so it
// does NOT extend the approve loading spinner, but it does overwrite state with
// the ground-truth server snapshot once the writes have propagated.
// Field-level merge (mergeBookFieldLevel) prevents the refresh from regressing
// any identity fields (title/author) that were just approved.
;(async () => {
  // Small settle delay so the DB writes (upserts in approvePromises) are visible
  // to the read replica before we query.
  await new Promise(r => setTimeout(r, 800));
  if (!user) return; // user signed out during delay
  try {
    // Session check: if the RLS session is missing or expired, the snapshot will
    // return 0 rows and the merge will incorrectly treat the library as empty.
    // Verify session before starting — the fetchAll* functions also check internally,
    // but doing it here lets us skip the fetch entirely and log the abort reason once.
    const { data: { session: _snapSession } } = await supabase!.auth.getSession();
    const _snapHasSession = !!_snapSession?.access_token && !!_snapSession?.user?.id;
    const _snapSessionUserId = _snapSession?.user?.id ?? null;
    logger.info('[APPROVE_FULL_REFRESH]', 'pre-fetch session check', {
      hasSession: _snapHasSession,
      sessionUserId: _snapSessionUserId?.slice(0, 8) ?? null,
      callerUserId: user.uid.slice(0, 8),
      userIdMatch: _snapSessionUserId === user.uid,
    });
    if (!_snapHasSession) {
      logger.error('[APPROVE_FULL_REFRESH]', 'aborting snapshot — no active RLS session; snapshot would return 0 and corrupt merge. Local approved state preserved.', {
        callerUserId: user.uid.slice(0, 8),
        hint: 'Session expired or not loaded. fetchAll* will attempt refresh internally on next rehydrate.',
      });
      return;
    }
    // ── Advance snapshot seq before fetching so any concurrent rehydrate that
    // started before this approve cannot overwrite the result we're about to write.
    const _approveSnapSeq = ++snapshotSeqRef.current;
    logger.info('[APPROVE_FULL_REFRESH]', 'fetching full library snapshot post-approve', { approveSnapSeq: _approveSnapSeq });
    const _approveSnapT0 = Date.now();
    const [freshBooks, freshPhotos] = await Promise.all([
      loadBooksFromSupabase(user.uid, { milestone: 'approve_complete' }),
      loadPhotosFromSupabase(user.uid),
    ]);
    const _approveLocalApprovedBefore = approvedBooks.length;
    const _approveLocalPhotosBefore = photos.length;
    const _graceServerApproved = freshBooks.approved?.length ?? 0;
    const _graceServerPhotos = freshPhotos.length;
    const inGrace = Date.now() < approvalGraceUntilRef.current;
    const serverStale = _graceServerApproved < _approveLocalApprovedBefore || _graceServerPhotos < _approveLocalPhotosBefore;
    if (inGrace && serverStale) {
      logger.info('[APPROVE_FULL_REFRESH]', 'in grace and server snapshot smaller than local — skip overwrite, books-only retry in 500ms', {
        serverApproved: _graceServerApproved,
        localApproved: _approveLocalApprovedBefore,
        serverPhotos: _graceServerPhotos,
        localPhotos: _approveLocalPhotosBefore,
      });
      approvalGraceUntilRef.current = 0;
      setTimeout(async () => {
        if (!user) return;
        try {
          const refreshed = await loadBooksFromSupabase(user.uid, { milestone: 'approve_complete' });
          setApprovedBooks((prev) => {
            const byKey = new Map<string, Book>();
            // Secondary index: title|author -> server stable-key, for local books lacking book_key.
            const serverByTA = new Map<string, string>();
            (refreshed.approved || []).forEach((b) => {
              const k = getStableBookKey(b);
              if (!k) return;
              byKey.set(k, { ...b, book_key: b.book_key ?? k, status: 'approved' as const });
              const ta = computeBookKey({ title: b.title, author: b.author });
              if (ta && ta !== k && !ta.startsWith('empty:')) serverByTA.set(ta, k);
            });
            prev.forEach((b) => {
              const k = getStableBookKey(b);
              if (!k) return;
              const srv = byKey.get(k);
              if (srv) {
                byKey.set(k, mergeBookFieldLevel(srv, { ...b, book_key: b.book_key ?? k }, photoIdAliasRef.current));
              } else {
                // Check if local book (no book_key) matches a server book via title|author (ISBN vs title|author key mismatch).
                const ta = computeBookKey({ title: b.title, author: b.author });
                const serverKey = ta && !ta.startsWith('empty:') ? serverByTA.get(ta) : undefined;
                if (serverKey) {
                  const srvBook = byKey.get(serverKey)!;
                  byKey.set(serverKey, mergeBookFieldLevel(srvBook, { ...b, book_key: srvBook.book_key ?? k }, photoIdAliasRef.current));
                } else {
                  byKey.set(k, { ...b, book_key: b.book_key ?? k });
                }
              }
            });
            const merged = [...byKey.values()];
            AsyncStorage.setItem(`approved_books_${user.uid}`, JSON.stringify(ensureApprovedOnePerBookKey(merged))).catch(() => {});
            return merged;
          });
          setPendingBooks((prev) => {
            const byKey = new Map<string, Book>();
            (refreshed.pending || []).forEach((b) => {
              const k = getStableBookKey(b);
              if (k) byKey.set(k, { ...b, book_key: b.book_key ?? k });
            });
            prev.forEach((b) => {
              const k = getStableBookKey(b);
              if (!k) return;
              if (!byKey.has(k)) byKey.set(k, { ...b, book_key: b.book_key ?? k });
            });
            return [...byKey.values()];
          });
          refreshProfileStats();
        } catch (_) {}
      }, 500);
      return;
    }
    let _approveLocalApprovedAfter = 0;
    let _approveLocalPhotosAfter = 0;

    // Merge books: field-level so approved identity is never overwritten.
    setApprovedBooks(prev => {
      const byKey = new Map<string, Book>();
      // Secondary index: title|author -> server stable-key, for local books lacking book_key.
      const serverByTA = new Map<string, string>();
      (freshBooks.approved || []).forEach(b => {
        const k = getStableBookKey(b);
        if (!k) return;
        byKey.set(k, { ...b, book_key: b.book_key ?? k });
        const ta = computeBookKey({ title: b.title, author: b.author });
        if (ta && ta !== k && !ta.startsWith('empty:')) serverByTA.set(ta, k);
      });
      prev.forEach(b => {
        const k = getStableBookKey(b);
        if (!k) return;
        const srv = byKey.get(k);
        if (srv) {
          byKey.set(k, mergeBookFieldLevel(srv, { ...b, book_key: b.book_key ?? k }, photoIdAliasRef.current));
        } else {
          // Check if local book (no book_key) matches a server book via title|author (ISBN vs title|author key mismatch).
          const ta = computeBookKey({ title: b.title, author: b.author });
          const serverKey = ta && !ta.startsWith('empty:') ? serverByTA.get(ta) : undefined;
          if (serverKey) {
            const srvBook = byKey.get(serverKey)!;
            byKey.set(serverKey, mergeBookFieldLevel(srvBook, { ...b, book_key: srvBook.book_key ?? k }, photoIdAliasRef.current));
          } else {
            byKey.set(k, { ...b, book_key: b.book_key ?? k }); // local-only, keep
          }
        }
      });
      const merged = [...byKey.values()];
      _approveLocalApprovedAfter = merged.length;
      // Persist so next boot has the authoritative server snapshot.
      AsyncStorage.setItem(userApprovedKey, JSON.stringify(ensureApprovedOnePerBookKey(merged))).catch(() => {});
      return merged;
    });
    // Merge photos: server rows win for storage fields; preserve any local-only
    // entries that were just written (they may not yet appear in the server list).
    setPhotos(prev => {
      const byId = new Map(prev.map(p => [p.id, p]));
      freshPhotos.forEach(sp => {
        const existing = byId.get(sp.id);
        byId.set(sp.id, existing
          ? { ...existing, ...(sp as any), id: sp.id } // server storage fields win
          : sp
        );
      });
      const merged = [...byId.values()].filter(p => !(p as any).deleted_at && (p as any).status !== 'discarded');
      _approveLocalPhotosAfter = merged.length;
      AsyncStorage.setItem(userPhotosKey, JSON.stringify(merged)).catch(() => {});
      return merged;
    });
    // ── Record authoritative snapshot seq + set post-approve lock ───────────
    // Any rehydrate that fires within POST_APPROVE_LOCK_MS is blocked from
    // overwriting the state we just wrote above.
    appliedSnapshotSeqRef.current = _approveSnapSeq;
    postApproveLockUntilRef.current = Date.now() + POST_APPROVE_LOCK_MS;
    lastSnapshotCommittedAtRef.current = Date.now();
    // Advance high-water marks with the freshest trusted counts.
    const _freshApprovedCount = freshBooks.approved?.length ?? 0;
    const _freshPhotosCount = freshPhotos.length;
    if (_freshApprovedCount > highWaterApprovedCountRef.current) {
      highWaterApprovedCountRef.current = _freshApprovedCount;
    }
    if (_freshPhotosCount > highWaterPhotosCountRef.current) {
      highWaterPhotosCountRef.current = _freshPhotosCount;
    }
    // Persist updated high-water marks after post-approve authoritative snapshot.
    saveHighWaterMark(user.uid, {
      approved: highWaterApprovedCountRef.current,
      photos:   highWaterPhotosCountRef.current,
    }).catch(() => {});
    // Single summary line: server snapshot totals + merge outcome + lock state.
    // Replaces the former SERVER_SNAPSHOT_SUMMARY + two APPROVE_FULL_REFRESH "merged" lines
    // + APPROVE_SNAPSHOT_COMMITTED — all the signal in one scannable record.
    logger.info('[SNAPSHOT_MERGE]', {
      source: 'post_approve',
      ok: true,
      mergeReason: 'post_approve_full_refresh',
      serverApproved: _freshApprovedCount,
      serverPending: freshBooks.pending?.length ?? 0,
      serverPhotos: _freshPhotosCount,
      localApprovedBefore: _approveLocalApprovedBefore,
      localPhotosBefore: _approveLocalPhotosBefore,
      localApprovedAfter: _approveLocalApprovedAfter,
      localPhotosAfter: _approveLocalPhotosAfter,
      approveSnapSeq: _approveSnapSeq,
      postApproveLockMs: POST_APPROVE_LOCK_MS,
      highWaterApproved: highWaterApprovedCountRef.current,
      highWaterPhotos: highWaterPhotosCountRef.current,
      latencyMs: Date.now() - _approveSnapT0,
      userIdPrefix: user.uid.slice(0, 8),
    });
    logger.info('[TIMING]', { op: 'full_refresh_done', totalFromClick: Date.now() - _approveClickT0, latencyMs: Date.now() - _approveSnapT0 });

    // Full refresh committed — DB ids are now merged into local state.
    // Edit Cover / Switch Book are now safe to use.
    setPostApproveIdsSettled(true);

    refreshProfileStats();

    // ── Server-truth sanity check ────────────────────────────────────────────
    // After the full refresh merges, run direct server counts for both books and
    // photos to verify the merged local state matches the DB.
    // A mismatch is an ERROR (not just a warning) because it means we are masking
    // real data-loss with a local cache fallback.
    // All queries use user.uid (full UUID) — never a truncated prefix.
    if (supabase && user) {
      try {
        const [bookCountRes, photoCountRes] = await Promise.all([
          supabase
            .from('books')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.uid)
            .is('deleted_at', null)
            .eq('status', 'approved'),
          supabase
            .from('photos')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.uid)
            .is('deleted_at', null)
            .neq('status', 'discarded'),
        ]);

        const { count: serverApprovedCount, error: bookCountErr } = bookCountRes;
        const { count: serverPhotoCount, error: photoCountErr } = photoCountRes;

        // ── Drop detection: post-approve snapshot ──────────────────────────
        // Run the same suspicious-drop check as rehydrate_merge. By this point
        // highWaterApprovedCountRef has already been advanced with _freshApprovedCount
        // (the snapshot we just fetched), so we check the direct DB counts against
        // those same high-water marks to catch any RLS-filtered under-counts.
        if (!bookCountErr && !photoCountErr) {
          const _postApproveDropCheck = checkForSuspiciousDrop({
            serverApproved: serverApprovedCount ?? 0,
            serverPhotos: serverPhotoCount ?? 0,
            highWaterApproved: highWaterApprovedCountRef.current,
            highWaterPhotos: highWaterPhotosCountRef.current,
            lastDestructiveAction: lastDestructiveActionRef.current,
          });
          if (_postApproveDropCheck.suspicious) {
            logger.warn('[DATA_SAFETY_DROP]', 'post-approve sanity: suspicious count drop detected', _postApproveDropCheck);
            if (__DEV__) (global as any).__dataSafetyDropLast = _postApproveDropCheck;
            setDataSafetySyncIssue(null);
          } else {
            setDataSafetySyncIssue(null);
          }
        }

        if (bookCountErr) {
          logger.warn('[APPROVE_SANITY_CHECK]', 'books server count query failed', {
            err: bookCountErr.message ?? String(bookCountErr),
            userIdFull: user.uid,
            userId: user.uid.slice(0, 8),
          });
        } else {
          // NOTE: approvedBooks here is the STALE closure value — React state hasn't settled
          // yet because setApprovedBooks() is a functional updater still queued. The real
          // rendered count will appear in [APPROVE_STATE_AFTER_SETTLE] (fires after settle).
          // We compare serverCount vs freshBooks.approved here only to detect RLS/filter gaps.
          const renderedApproved = freshBooks.approved ?? []; // server snapshot as proxy
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const TEMP_ID_RE = /^(photo_|scan_|tmp_|[^-]{1,8}$)/i; // local composite / short ids
          const withDbId = renderedApproved.filter(b => b.id && UUID_RE.test(b.id));
          const withTempId = renderedApproved.filter(b => b.id && !UUID_RE.test(b.id));
          const withoutId = renderedApproved.filter(b => !b.id);
          const serverCount = serverApprovedCount ?? 0;
          const mismatch = serverCount !== renderedApproved.length;
          if (mismatch) {
            logger.warn('[APPROVE_SANITY_CHECK]', 'BOOKS MISMATCH: server count does not match rendered approved list', {
              serverApprovedCount: serverCount,
              localApprovedCountRendered: renderedApproved.length,
              localApprovedCountByIdMap: withDbId.length,
              localApprovedCountWithDbId: withDbId.length,
              localApprovedCountWithTempId: withTempId.length,
              localApprovedCountWithoutId: withoutId.length,
              freshBooksApprovedCount: freshBooks.approved?.length ?? 0,
              diff: serverCount - renderedApproved.length,
              userIdPrefix: user.uid.slice(0, 8),
              hint: 'If serverCount > rendered: approve wrote rows but fetch-all missed them (RLS/max-rows). If serverCount < rendered: local has phantom books not in DB.',
            });
            // ── Snapshot probe: run only on mismatch (expensive — fetches full book row data) ──
            // Answers: "do rows exist at all?" vs "did filters exclude them?"
            supabase.auth.getUser().then(({ data: { user: probeUser } }) => {
              const probeUid = probeUser?.id ?? user.uid;
              return supabase
                .from('books')
                .select('id,user_id,status,deleted_at', { count: 'exact' })
                .eq('user_id', probeUid);
            }).then(({ data: probeData, error: probeErr, count: probeCount }) => {
              logger.warn('[PROBE_BOOKS_ANY_STATUS]', {
                trigger: 'sanity_mismatch',
                error: probeErr?.message ?? null,
                count: probeCount,
                approvedInProbe: (probeData ?? []).filter((r: any) => r.status === 'approved').length,
                deletedInProbe: (probeData ?? []).filter((r: any) => !!r.deleted_at).length,
                userIdPrefix: user.uid.slice(0, 8),
                sample: (probeData ?? []).slice(0, 5).map((r: any) => ({
                  id: r.id?.slice(0, 8),
                  status: r.status,
                  deleted_at: r.deleted_at,
                })),
              });
            }).catch((e: any) => {
              logger.warn('[PROBE_BOOKS_ANY_STATUS]', 'probe failed', { err: e?.message ?? String(e) });
            });
          } else {
            logger.debug('[APPROVE_SANITY_CHECK]', 'BOOKS OK', {
              serverApprovedCount: serverCount,
              localApprovedCountRendered: renderedApproved.length,
              localApprovedCountWithDbId: withDbId.length,
              localApprovedCountWithTempId: withTempId.length,
              localApprovedCountWithoutId: withoutId.length,
            });
          }
        }

        if (photoCountErr) {
          logger.warn('[APPROVE_SANITY_CHECK]', 'photos server count query failed', {
            err: photoCountErr.message ?? String(photoCountErr),
            userIdFull: user.uid,
            userId: user.uid.slice(0, 8),
          });
        } else {
          // freshPhotos is the server snapshot just fetched — authoritative.
          const localPhotoCount = freshPhotos.length;
          const serverCount = serverPhotoCount ?? 0;
          const mismatch = serverCount !== localPhotoCount;
          if (mismatch) {
            logger.warn('[APPROVE_SANITY_CHECK]', 'PHOTOS MISMATCH', {
              serverPhotoCount: serverCount,
              localPhotoCount,
              diff: serverCount - localPhotoCount,
              userIdPrefix: user.uid.slice(0, 8),
              hint: 'serverCount > localCount → fetchAllPhotos missed rows (RLS, max-rows). serverCount < localCount → local has ghost photos.',
            });
          } else {
            logger.debug('[APPROVE_SANITY_CHECK]', 'PHOTOS OK', {
              serverPhotoCount: serverCount,
              localPhotoCount,
            });
          }
        }
      } catch (sanityErr: any) {
        logger.warn('[APPROVE_SANITY_CHECK]', 'sanity check threw (non-fatal)', { err: sanityErr?.message ?? String(sanityErr) });
      }
    }
  } catch (refreshErr: any) {
    // Non-fatal: the approve already committed. Log and move on.
    logger.warn('[APPROVE_FULL_REFRESH]', 'post-approve refresh failed (non-fatal)', { err: refreshErr?.message ?? String(refreshErr) });
    // Still settle ids even if refresh failed — don't lock the UI indefinitely.
    setPostApproveIdsSettled(true);
  }
})();
 } catch (approveErr) {
   if (snapshotApproved != null) setApprovedBooks(snapshotApproved);
   if (snapshotPending != null) setPendingBooks(snapshotPending);
   refreshProfileStats();
   Alert.alert('Approve failed', (approveErr as Error)?.message ?? 'Could not save. Please retry. Changes were reverted.');
   throw approveErr;
 } finally {
  if (!options?.runInBackground) {
    isApprovingRef.current = false;
    setIsApproving(false);
  }
  logger.info('[TIMING]', { op: 'button_released', totalFromClick: Date.now() - _approveClickT0 });
  // Record authoritative approve so merge guard allows server snapshot to win for 30s.
  if (options?.source === 'scan' && user?.uid) {
    logDeleteAudit(
      { reason: 'user_approve', screen: 'ScansTab', gestureAt: Date.now() - 100, userConfirmed: true, actionId: `approve_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` },
      { userId: user.uid, bookCount: newApproved.length },
    );
  }
  // IDs are not yet settled — the fire-and-forget refresh above will set this
  // to true once the snapshot merges in.  Until then, Edit Cover / Switch Book
  // are disabled so they don't silently fail due to missing DB ids.
    setPostApproveIdsSettled(false);
  setApproveCompletedCount(c => c + 1);
  }
  return;
  }

  try {
  await persistToStorage();
 const countsKey = `${newPending.length}:${newApproved.length}:${newRejected.length}:${newPhotos.length}`;
 logger.whenChanged(countsKey, 'info', '[SAVE_USER_DATA]', 'counts changed', {
 source: options?.source ?? 'unknown',
 pending: newPending.length,
 approved: newApproved.length,
 rejected: newRejected.length,
 photos: newPhotos.length,
 });
 if (isGuestUser(user)) {
 logger.debug(' Guest user: Data saved locally. Sign in to sync across devices.');
 return;
 }
 const baseSaveOptions = session?.access_token ? { apiBaseUrl: getApiBaseUrl(), accessToken: session.access_token } : undefined;
 // CRITICAL: photos MUST be committed before any books that reference them via source_photo_id FK.
 // Save photos sequentially first (sequential avoids 23505 duplicate image_hash), then books in parallel.
 (async () => {
 try {
 const photosToWrite = newPhotos.filter(
 (photo) => photo.uri && typeof photo.uri === 'string' && photo.uri.trim().length > 0
 );
 // Build a localId → canonicalId map from photo saves so that each book's
 // patchPhotoFK call always uses the canonical DB photo row id, never a local alias.
 // Without this, saveBookToSupabase falls back to book.source_photo_id which may be
 // a local temp-id that was deduped to a canonical id — causing PHOTO_FK_PATCH_MISSING_PHOTO.
 const localToCanonicalPhotoId = new Map<string, string>();
 for (const photo of photosToWrite) {
   const photoResult = await savePhotoToSupabase(user.uid, photo, { statusOverride: 'complete' });
   if (photoResult.ok) clearDraftWatchdogForPhoto(photo.id, photoResult.canonicalPhotoId ?? null);
   if (photo.id && photoResult.canonicalPhotoId) {
     localToCanonicalPhotoId.set(photo.id, photoResult.canonicalPhotoId);
     if (photoResult.canonicalPhotoId !== photo.id) {
       logger.debug('[SAVE_USER_DATA_PHOTO_DEDUPE]', {
         localId: photo.id.slice(0, 8),
         canonicalId: photoResult.canonicalPhotoId.slice(0, 8),
         reused: true,
       });
     }
   }
 }
 // Also seed from persistent alias map so books whose photos were deduped in a prior
 // session (aliases already recorded) get the canonical id without re-deduping.
 Object.entries(photoIdAliasRef.current).forEach(([localId, canonicalId]) => {
   if (!localToCanonicalPhotoId.has(localId)) {
     localToCanonicalPhotoId.set(localId, canonicalId);
   }
 });
 const resolveBookPhotoId = (book: Book): string | undefined => {
   const rawPid = (book as any).source_photo_id as string | undefined;
   if (!rawPid) return undefined;
   return localToCanonicalPhotoId.get(rawPid) ?? rawPid;
 };
 await Promise.all([
 ...newPending.map((book) => saveBookToSupabase(user.uid, book, 'pending', { ...baseSaveOptions, sourcePhotoId: resolveBookPhotoId(book) })),
 ...newApproved.map((book) => saveBookToSupabase(user.uid, book, 'approved', { ...baseSaveOptions, sourcePhotoId: resolveBookPhotoId(book) })),
 ...newRejected.map((book) => saveBookToSupabase(user.uid, book, 'rejected', { ...baseSaveOptions, sourcePhotoId: resolveBookPhotoId(book) })),
 ]);
 refreshProfileStats();
 } catch (error) {
 logger.error('Error saving to Supabase (non-blocking):', error);
 }
 })();
 } catch (error) {
 logger.error('Error saving user data:', error);
 }
 };

 // Helper function to determine if a book is incomplete
 const isIncompleteBook = (book: any): boolean => {
 const title = (book.title || '').trim();
 const author = (book.author || '').trim();
 const titleLower = title.toLowerCase();
 const authorLower = author.toLowerCase();
 
 // Check for missing or invalid data
 if (!title || !author) return true;
 if (title === '' || author === '') return true;
 
 // Check for Unknown author (case-insensitive) - main case for ChatGPT failures
 if (authorLower === 'unknown' || authorLower === 'n/a' || authorLower === 'not found' || authorLower === '') return true;
 if (titleLower === 'unknown' || titleLower === 'n/a' || titleLower === 'not found') return true;
 
 // Check if ChatGPT marked it as invalid with Unknown author
 if (book.confidence === 'low' && (authorLower === 'unknown' || !author || author.trim() === '')) return true;
 if (book.chatgptReason && (book.chatgptReason.toLowerCase().includes('not a real book') || book.chatgptReason.toLowerCase().includes('unknown'))) return true;
 
 // Check for common OCR errors or invalid text
 if (title.length < 2 || author.length < 2) return true;
 if (/^[^a-zA-Z0-9\s]+$/.test(title) || /^[^a-zA-Z0-9\s]+$/.test(author)) return true;
 
 return false;
 };

 // NOTE: Client-side validation removed for security
 // All validation is now handled server-side by the API endpoint

 /** Hash dataURL for dedupe and JOB_SUMMARY. Must be unique per image hash actual content (base64), never return a constant. */
 const hashDataURL = async (dataURL: string): Promise<string> => {
 const base64 = dataURL.includes(',') ? dataURL.split(',')[1] ?? dataURL : dataURL;
 const MAX_HASH_INPUT = 500000; // avoid huge strings; fingerprint if larger
 const toHash =
 base64.length <= MAX_HASH_INPUT
 ? base64
 : base64.slice(0, 2000) + '|' + base64.length + '|' + base64.slice(-2000);
 if (USE_PURE_JS_HASH) {
 logger.info('[HASH] using pure-JS (USE_PURE_JS_HASH) for consistent dedupe across envs');
 return hashStringToHex16(toHash);
 }
 return sha256Hex16(toHash);
 };

 /**
 * Optimize image before upload: resize to max 1600px (longest side), compress to 0.6 quality, convert to WebP.
 * Returns dataURL and metadata for JOB_SUMMARY (orig/opt dimensions, bytes).
 */
 const optimizeImageForUpload = async (uri: string): Promise<{ dataURL: string; origW: number; origH: number; optW: number; optH: number; bytes: number }> => {
 try {
 const scheme = (uri && uri.includes('://')) ? uri.split('://')[0] : (uri ? 'no-scheme' : 'empty');
 if (LOG_DEBUG) logger.debug('[UPLOAD_FILE_INFO]', { uri: uri?.slice?.(0, 120), scheme });
 const info = await FileSystem.getInfoAsync(uri);
 const fileSize = (info as { size?: number }).size;
 if (LOG_DEBUG) logger.debug('[UPLOAD_FILE_INFO_RESULT]', { uri: uri?.slice?.(0, 120), exists: info.exists, size: fileSize, isDirectory: info.isDirectory });
 if (!info.exists) {
 logger.warn('[UPLOAD_FILE_INFO] file does not exist optimization may fail', { uri: uri?.slice?.(0, 80), scheme });
 }
 const imageInfo = await ImageManipulator.manipulateAsync(
 uri, [], { format: ImageManipulator.SaveFormat.PNG }
 );
 const origW = imageInfo.width ?? 0;
 const origH = imageInfo.height ?? 0;

 let resizeActions: any[] = [];
 if (origW && origH) {
 const maxDimension = Math.max(origW, origH);
 if (maxDimension > 1600) {
 if (origW >= origH) resizeActions.push({ resize: { width: 1600 } });
 else resizeActions.push({ resize: { height: 1600 } });
 }
 }

 const t0Base64 = Date.now();
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 uri,
 resizeActions,
 { compress: 0.6, format: ImageManipulator.SaveFormat.WEBP, base64: true }
 );

 if (manipulatedImage.base64) {
 const dataUrl = `data:image/webp;base64,${manipulatedImage.base64}`;
 const optW = manipulatedImage.width ?? origW;
 const optH = manipulatedImage.height ?? origH;
 const bytes = Math.round((manipulatedImage.base64.length * 3) / 4);
 logger.debug('[UPLOAD_OPTIMIZE_DONE]', {
 inUri: uri?.slice?.(0, 80),
 ms: Date.now() - t0Base64,
 bytes,
 width: optW,
 height: optH,
 format: 'webp',
 });
 return { dataURL: dataUrl, origW, origH, optW, optH, bytes };
 }
 throw new Error('Failed to get base64 from ImageManipulator');
 } catch (error) {
 const { message, stack } = formatErrorForLog(error);
 const fileInfo = await getFileInfoForLog(uri);
 logger.error(' [JOB_CREATE] Image optimization failed', {
 step: 'resize/conversion',
 message,
 stack: stack ?? undefined,
 uri: uri?.slice?.(0, 120),
 fileSize: fileInfo.size,
 mimeOrExtension: fileInfo.mimeOrExtension,
 fileExists: fileInfo.exists,
 });
 const dataURL = await convertImageToBase64(uri);
 const bytes = Math.round((dataURL.replace(/^data:[^;]+;base64,/, '').length * 3) / 4);
 logger.debug('[UPLOAD_OPTIMIZE_DONE]', { inUri: uri?.slice?.(0, 80), bytes, width: 0, height: 0, format: 'jpeg', source: 'fallback' });
 return { dataURL, origW: 0, origH: 0, optW: 0, optH: 0, bytes };
 }
 };

 const convertImageToBase64 = async (uri: string): Promise<string> => {
 const t0 = Date.now();
 try {
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 uri,
 [],
 { 
 compress: 0.6, 
 format: ImageManipulator.SaveFormat.JPEG,
 base64: true 
 }
 );
 
 if (manipulatedImage.base64) {
 const dataURL = `data:image/jpeg;base64,${manipulatedImage.base64}`;
 logger.debug('[UPLOAD_BASE64]', { ms: Date.now() - t0, bytes: Math.round((manipulatedImage.base64.length * 3) / 4), source: 'convertImageToBase64' });
 return dataURL;
 }
 
 throw new Error('Failed to get base64 from ImageManipulator');
 } catch (error) {
 const { message, stack } = formatErrorForLog(error);
 const fileInfo = await getFileInfoForLog(uri);
 logger.error(' [JOB_CREATE] Image conversion (base64) failed', {
 step: 'file_read/conversion',
 message,
 stack: stack ?? undefined,
 uri: uri?.slice?.(0, 120),
 fileSize: fileInfo.size,
 mimeOrExtension: fileInfo.mimeOrExtension,
 fileExists: fileInfo.exists,
 });
 throw error;
 }
 };

 // Downscale and convert to base64 for fallback attempts
 const convertImageToBase64Resized = async (uri: string, maxWidth: number, quality: number): Promise<string> => {
 try {
 // Converting resized image to base64
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 uri,
 [
 { resize: { width: maxWidth } },
 ],
 {
 compress: quality,
 format: ImageManipulator.SaveFormat.JPEG,
 base64: true,
 }
 );
 if (manipulatedImage.base64) {
 return `data:image/jpeg;base64,${manipulatedImage.base64}`;
 }
 throw new Error('Failed to get base64 from resized ImageManipulator');
 } catch (error) {
 const { message, stack } = formatErrorForLog(error);
 const fileInfo = await getFileInfoForLog(uri);
 logger.error(' [JOB_CREATE] Resized image conversion failed', {
 step: 'resize/conversion',
 message,
 stack: stack ?? undefined,
 uri: uri?.slice?.(0, 120),
 fileSize: fileInfo.size,
 mimeOrExtension: fileInfo.mimeOrExtension,
 fileExists: fileInfo.exists,
 });
 throw error;
 }
 };

 /**
 * Ensure a picker URI is a readable local file:// path before we display it or hand it
 * to ImageManipulator / FileSystem. On iOS, launchImageLibraryAsync can return:
 * - ph:// native Photos asset reference
 * - assets-library:// legacy Photos reference
 * - file:// an iCloud stub that hasn't been downloaded yet
 *
 * ImageManipulator.manipulateAsync is the most reliable way to force the OS to export
 * the pixels to a real cached JPEG regardless of scheme or iCloud status.
 * If it fails we log and return the original URI so the downstream optimizer can try again.
 */
 const ensureLocalUri = async (uri: string): Promise<string> => {
 if (!uri) return uri;
 try {
 const exported = await ImageManipulator.manipulateAsync(
 uri,
 [],
 { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
 );
 if (LOG_DEBUG) logger.debug('[ENSURE_LOCAL_URI]', { original: uri?.slice?.(0, 80), local: exported.uri?.slice?.(0, 100) });
 return exported.uri;
 } catch (err: any) {
 logger.warn('[ENSURE_LOCAL_URI_FAIL]', { uri: uri?.slice?.(0, 80), err: String(err?.message ?? err) });
 return uri;
 }
 };

 // Helper to get cover URI - prefer local, then remote (from hydrated scan response)
 const getBookCoverUri = (book: Book): string | undefined => {
 if (book.localCoverPath && FileSystem.documentDirectory) {
 try {
 const localPath = `${FileSystem.documentDirectory}${book.localCoverPath}`;
 return localPath;
 } catch {
 // Silently fail
 }
 }
 if (book.coverUrl) {
 const url = book.coverUrl.trim();
 if (isGoogleHotlink(url)) return undefined; // Never render Google hotlinks - they fail in RN
 if (url.startsWith('http://') || url.startsWith('https://')) return url;
 }
 return undefined;
 };

 // Download and cache cover image to local storage
 const downloadAndCacheCover = async (coverUrl: string, googleBooksId: string): Promise<string | null> => {
 try {
 if (!FileSystem.documentDirectory) {
 logger.warn('FileSystem document directory not available');
 return null;
 }
 
 // Create covers directory if it doesn't exist
 const coversDirPath = `${FileSystem.documentDirectory}covers/`;
 const dirInfo = await FileSystem.getInfoAsync(coversDirPath);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(coversDirPath, { intermediates: true });
 }

 // Generate filename from googleBooksId or hash the URL
 const filename = googleBooksId ? `${googleBooksId}.jpg` : `${coverUrl.split('/').pop() || Date.now()}.jpg`;
 const localPath = `covers/${filename}`;
 const fullPath = `${FileSystem.documentDirectory}${localPath}`;

 // Check if already cached
 const existingFile = await FileSystem.getInfoAsync(fullPath);
 if (existingFile.exists) {
 return localPath;
 }

 // Download the image
 const downloadResult = await FileSystem.downloadAsync(coverUrl, fullPath);

 if (downloadResult.uri) {
 return localPath;
 }

 return null;
 } catch (error) {
 logger.error('Error caching cover:', error);
 return null;
 }
 };

 // Cover resolution happens in worker; client renders book.coverUrl or localCoverPath or placeholder

 // NOTE: Client-side API key usage removed for security
 // All scans now go through the server API endpoint which handles API keys securely

 const mergeBookResults = (openaiBooks: Book[], geminiBooks: Book[]): Book[] => {
 // Aggressive normalization to catch duplicates with slight variations
 const normalize = (s?: string) => {
 if (!s) return '';
 return s.trim()
 .toLowerCase()
 .replace(/[.,;:!?]/g, '') // Remove punctuation
 .replace(/\s+/g, ' '); // Normalize whitespace
 };
 
 // Remove leading articles from titles for better matching
 const normalizeTitle = (title?: string) => {
 const normalized = normalize(title);
 // Remove "the", "a", "an" from the beginning
 return normalized.replace(/^(the|a|an)\s+/, '').trim();
 };
 
 // Normalize author names more aggressively
 const normalizeAuthor = (author?: string) => {
 const normalized = normalize(author);
 // Remove common suffixes and normalize
 return normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
 };

 const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;

 const unique: Record<string, Book> = {};
 
 // Process all books from both sources
 const allBooks = [...openaiBooks, ...geminiBooks];
 
 for (const b of allBooks) {
 const k = makeKey(b);
 // Only add if we haven't seen this exact key before
 if (!unique[k]) {
 unique[k] = b;
 }
 }
 
 const merged = Object.values(unique);
 
 // Final pass: check for near-duplicates using similarity
 const final: Book[] = [];
 for (const book of merged) {
 const bookTitle = normalizeTitle(book.title);
 const bookAuthor = normalizeAuthor(book.author);
 
 let isDuplicate = false;
 for (const existing of final) {
 const existingTitle = normalizeTitle(existing.title);
 const existingAuthor = normalizeAuthor(existing.author);
 
 // Exact match on normalized title + author
 if (bookTitle === existingTitle && bookAuthor === existingAuthor) {
 isDuplicate = true;
 break;
 }
 
 // If titles are very similar (one contains the other) and authors match
 if (bookAuthor === existingAuthor && bookAuthor && bookAuthor !== 'unknown' && bookAuthor !== 'unknown author') {
 if (bookTitle.includes(existingTitle) && existingTitle.length > 3) {
 isDuplicate = true;
 break;
 }
 if (existingTitle.includes(bookTitle) && bookTitle.length > 3) {
 isDuplicate = true;
 break;
 }
 }
 }
 
 if (!isDuplicate) {
 final.push(book);
 }
 }
 
 return final;
 };

 // Submit scan as background job (continues even if app closes)
 const submitBackgroundScanJob = async (imageDataURL: string, scanId: string, photoId: string): Promise<string | null> => {
 const baseUrl = getApiBaseUrl();

 let headers: Record<string, string>;
 try {
 const { getScanAuthHeaders } = await import('../lib/authHeaders');
 headers = { 'Content-Type': 'application/json', ...(await getScanAuthHeaders()) };
 } catch (err: any) {
 logger.warn(' No Supabase session or invalid token; block scanning until re-auth.', err?.message);
 if (!err?.message?.startsWith('BUG:')) {
 Alert.alert('Sign in required', 'Please sign in again to scan.', [{ text: 'OK' }]);
 }
 return null;
 }

 try {
 const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

 const scanJobUrl = `${baseUrl}/api/scan-job`;
 logger.debug('[SCAN_JOB_POST]', { url: scanJobUrl });
 const resp = await fetch(scanJobUrl, {
 method: 'POST',
 headers,
 body: JSON.stringify({
 imageDataURL,
 jobId,
 photoId,
 }),
 });
 
 if (resp.ok) {
 const data = await resp.json();
 const finalJobId = data.jobId || jobId;
 logger.info('[SCAN_ENQUEUE_OK]', { scanJobId: jobId, jobId: finalJobId, photoId, source: 'library' });
 // Check if job was completed synchronously
 if (data.status === 'completed' && data.books) {
 if (__DEV__) logger.debug('[SCAN] job completed books=' + (data.books?.length ?? 0));
 // Job completed immediately, return the jobId so caller knows it's done
 // The books will be processed by the sync function when app reopens
 // For now, just store the job info (user-scoped so account mixing is impossible)
 const uid = user?.uid ?? GUEST_USER_ID;
 const jobKey = scanJobKey(uid, finalJobId);
 await AsyncStorage.setItem(jobKey, JSON.stringify({
 jobId: finalJobId,
 scanId,
 photoId,
 createdAt: new Date().toISOString(),
 completed: true,
 books: data.books
 }));
 return finalJobId;
 } else if (data.status === 'failed') {
 logger.error(` Background scan job failed: ${finalJobId} - ${data.error}`);
 return null;
 } else {
 // Job is still processing or pending
 logger.debug(` Background scan job submitted: ${finalJobId} (status: ${data.status})`);
 // Store job tracking info (user-scoped)
 const uid = user?.uid ?? GUEST_USER_ID;
 const jobKey = scanJobKey(uid, finalJobId);
 await AsyncStorage.setItem(jobKey, JSON.stringify({
 jobId: finalJobId,
 scanId,
 photoId,
 createdAt: new Date().toISOString()
 }));
 
 // Track in state
 setBackgroundScanJobs(prev => {
 const newMap = new Map(prev);
 newMap.set(finalJobId, { jobId: finalJobId, scanId, photoId });
 return newMap;
 });
 
 return finalJobId;
 }
 } else {
 const errText = await resp.text().catch(() => '');
 logger.warn('[SCAN_ENQUEUE_FAIL]', { status: resp.status, error: errText.slice(0, 200) || String(resp.status) });
 logger.error(` Failed to submit background scan job: ${resp.status}`);
 return null;
 }
 } catch (error) {
 const errMsg = (error as Error)?.message ?? String(error);
 logger.warn('[SCAN_ENQUEUE_FAIL]', { error: errMsg.slice(0, 200) });
 logger.error(' Error submitting background scan job:', error);
 setIsUploading(false);
 return null;
 }
 };

 // Enqueue a single image (create job, return jobId immediately). photoId from queue record (uuid per capture).
 const enqueueImage = async (
 imageDataURL: string,
 batchId: string,
 index: number,
 total: number,
 scanId: string,
 abortController?: AbortController,
 photoId?: string
 ): Promise<{ jobId: string, scanJobId: string, scanId: string, photoId?: string } | null> => {
 // CRITICAL: Increment in-flight counter (always decrement in finally)
 inFlightEnqueuesRef.current++;
 const wasAborted = abortController?.signal.aborted;
 
 if (__DEV__ && LOG_TRACE) logger.debug(`[BATCH ${batchId}] enqueue start scanId=${scanId}`);
 if (wasAborted) {
 inFlightEnqueuesRef.current--; // Decrement immediately
 return null;
 }
 
 const baseUrl = getApiBaseUrl();
 
 if (!baseUrl) {
 logger.error(' CRITICAL: No API base URL configured!');
 inFlightEnqueuesRef.current--; // Decrement on early return
 return null;
 }
 
 const scanUrl = `${baseUrl}/api/scan`;
 const payload = {
 imageDataURL,
 batchId,
 index,
 total,
 forceFresh: true,
 photoId: photoId ?? scanId,
 };
 const bodyStr = JSON.stringify(payload);
 // Track scan rate for anomaly detection (threshold: 10 scans per 5-minute window).
 trackScan(300, 10);
 // Track request rate for the 'scan' endpoint group (threshold: 20 req/min).
 trackRequest('scan', 20);
 logger.debug('[SCAN_POST]', { batchId, index, total, photoId: photoId ?? scanId, base64Bytes: Math.round(((imageDataURL?.length ?? 0) * 3) / 4) });
 try {
 const enqueueStart = Date.now();
 const { getScanAuthHeaders } = await import('../lib/authHeaders');
 const headers = await getScanAuthHeaders();

 let createResp: Response;
 let responseText = '';
 try {
 createResp = await fetch(scanUrl, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Accept': 'application/json',
 ...headers,
 },
 body: bodyStr,
 signal: abortController?.signal, // CRITICAL: Pass abort signal to fetch
 });
 responseText = await createResp.text();
 logger.debug('[SCAN_POST_RES]', { status: createResp.status, ok: createResp.ok, bodyPrefix: responseText.slice(0, 200) });
 } catch (fetchErr: any) {
 logger.warn('[SCAN_POST_ERR]', { message: String(fetchErr), name: fetchErr?.name });
 throw fetchErr;
 }
 
 const enqueueDuration = Date.now() - enqueueStart;
 
 if (abortController?.signal.aborted) return null;
 
 if (!createResp.ok) {
 const errorText = responseText;
 recordFailure('scan_submit', String(createResp.status));
 logger.warn('[SCAN_ENQUEUE_FAIL]', { batchId, status: createResp.status, error: errorText.slice(0, 200) });
 logger.error(' [JOB_CREATE] POST /api/scan failed', {
 step: 'POST /api/scan',
 endpoint: scanUrl,
 status: createResp.status,
 statusText: createResp.statusText,
 responseBody: errorText.slice(0, 500),
 batchId,
 index,
 total,
 scanId,
 });
 if (createResp.status === 401) {
 try {
 const errBody = JSON.parse(errorText);
 if (errBody?.error === 'reauth_required') {
 Alert.alert('Session expired', 'Please sign in again to scan.', [{ text: 'OK' }]);
 abortController?.abort();
 }
 } catch (_) {}
 }
 return null;
 }
 
 let jobData: { jobId?: string; photoId?: string; [k: string]: unknown };
 try {
 jobData = JSON.parse(responseText);
 } catch (parseErr) {
 logger.warn('[SCAN_ENQUEUE_FAIL]', { batchId, error: 'Invalid JSON response', bodyPrefix: responseText.slice(0, 200) });
 logger.error(' [JOB_CREATE] Scan API returned non-JSON', { batchId, scanId });
 return null;
 }
 const rawJobId = jobData?.jobId ?? jobData?.job_id;
 const jobId = typeof rawJobId === 'string' ? rawJobId : null;
 // scanJobId is the raw DB UUID use for poll/cancel API calls (scan_jobs.id is uuid type)
 const rawScanJobId = jobData?.scanJobId ?? jobData?.scan_job_id;
 const UUID_RE_EQ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 // Derive raw UUID: prefer explicit scanJobId, else strip prefix from jobId
 const derivedScanJobId: string | null = (() => {
 if (typeof rawScanJobId === 'string' && UUID_RE_EQ.test(rawScanJobId)) return rawScanJobId;
 if (typeof jobId === 'string') {
 const s = jobId.startsWith('job_') ? jobId.slice(4) : jobId;
 return UUID_RE_EQ.test(s) ? s : null;
 }
 return null;
 })();
 const rawPhotoId = jobData?.photoId ?? jobData?.photo_id;
 const serverPhotoId = typeof rawPhotoId === 'string' ? rawPhotoId : undefined;
 
 if (!jobId || !derivedScanJobId) {
 logger.warn('[SCAN_ENQUEUE_FAIL]', { batchId, error: 'No jobId/scanJobId returned', jobId, derivedScanJobId });
 logger.error(' [JOB_CREATE] No jobId in scan API response', {
 step: 'POST /api/scan',
 endpoint: scanUrl,
 batchId,
 index,
 total,
 scanId,
 status: createResp.status,
 });
 return null;
 }
 
 logger.info('[SCAN_ENQUEUE_OK]', { batchId, scanJobId: derivedScanJobId, jobId, photoId: serverPhotoId ?? photoId ?? scanId, source: 'library' });
 resetFailures('scan_submit');
 return { jobId, scanJobId: derivedScanJobId, scanId, photoId: serverPhotoId };
  } catch (e: any) {
   if (isAbortError(e) || abortController?.signal.aborted) return null;
   const { message, stack } = formatErrorForLog(e);
 recordFailure('scan_submit', 'exception');
 logger.warn('[SCAN_ENQUEUE_FAIL]', { batchId, error: message.slice(0, 200) });
 logger.error(' [JOB_CREATE] POST /api/scan threw', {
 step: 'POST /api/scan',
 endpoint: scanUrl,
 message,
 stack: stack ?? undefined,
 batchId,
 index,
 total,
 scanId,
 });
 return null;
 } finally {
 inFlightEnqueuesRef.current--;
 }
 };

// Enqueue a batch of images. Atomic: write all queue records (batchId, photoId, status: queued) first, then kick async upload/scan.
// If any step fails, keep the queue record with status 'error' and errorMessage (do not silently clear).
const enqueueBatch = async (items: Array<{uri: string, scanId: string}>): Promise<void> => {
  if (items.length === 0) {
    logger.debug('[SCAN_EARLY_RETURN]', { reason: 'items_length_zero' });
    return;
  }

  // Hard guard: cover update must never create a batch or scan state
  if (isCoverUpdateActive()) {
    logger.debug('[SCAN_EARLY_RETURN]', { reason: 'isCoverUpdateActive' });
    logger.error('[BATCH_START] called from cover-update path; aborting. Do not create batch for cover update.');
    if (__DEV__) throw new Error('BATCH_START must not be called during cover update');
    return;
  }

  // ─── SERIAL GATE ─────────────────────────────────────────────────────────────
  // Only one batch may be in-flight at a time. If another batch is already running,
  // buffer the new items and return. They will be drained by onBatchTerminalRef when
  // the active batch reaches terminal (completed / failed / all-canceled).
  //
  // This prevents the "second batch corrupts first batch" bug:
  //   - No second batchId means no parallel BATCH_QUEUED_ALONGSIDE races
  //   - No second AbortController means cancel stays clean for the active batch
  //   - No second activeBatch means the progress bar never flickers or resets
  if (inFlightBatchIdsRef.current.size > 0) {
    const bufferedCount = items.length;
    const existingIds = [...inFlightBatchIdsRef.current];
    // Deduplicate: don't buffer items already buffered (e.g. user taps twice quickly)
    const alreadyBufferedUris = new Set(serialScanQueueRef.current.map((i) => i.uri));
    const newItems = items.filter((i) => !alreadyBufferedUris.has(i.uri));
    if (newItems.length > 0) {
      serialScanQueueRef.current.push(...newItems);
    }
    logger.info('[BATCH_SERIAL_QUEUED]', {
      bufferedCount,
      newItems: newItems.length,
      totalBuffered: serialScanQueueRef.current.length,
      existingBatch: existingIds[0] ?? null,
    });
    // No toast here — caller (startUploadAfterCaption) controls UX; the bar already shows "Scanning".
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Capture cancel generation at batch start. Every post-await state write checks genOk()
  // before dispatching so a mid-flight cancel cannot re-open the bar or write stale data.
  const genOk = captureGen();

  const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  setTraceId(makeBatchTraceId());
  const total = items.length;
 logger.trace('[BATCH_ENQUEUE_START]', 'enqueue', { batchId, count: items.length });

 if (user?.uid) {
 const knownBatchIdsKey = `known_batch_ids_${user.uid}`;
 try {
 const saved = await AsyncStorage.getItem(knownBatchIdsKey);
 const list: string[] = saved ? JSON.parse(saved) : [];
 if (!list.includes(batchId)) list.unshift(batchId);
 await AsyncStorage.setItem(knownBatchIdsKey, JSON.stringify(list.slice(0, 100)));
 } catch (_) { /* ignore */ }
 }

 const batchController = new AbortController();
 abortControllersRef.current.set(batchId, batchController);
 scanShowReasonRef.current = 'batch_start';

 // Log source URI health for every item being enqueued.
 // If source=library and uri is missing/not-http, the scan will fail silently.
 const itemsWithBadUri = items.filter(item => {
 const uri = item.uri;
 return !uri || typeof uri !== 'string' || uri.trim().length === 0;
 });
 const itemsWithLocalUri = items.filter(item => {
 const uri = item.uri ?? '';
 return uri && !uri.startsWith('http') && !uri.startsWith('data:');
 });
 // Only warn on genuinely broken URIs. Local file:// URIs are EXPECTED in Expo / mobile 
 // the client uploads image bytes directly; the server never fetches local paths.
 if (itemsWithBadUri.length > 0) {
 logger.warn('[SCAN_SOURCE_AUDIT]', `${itemsWithBadUri.length} item(s) have missing/empty URI scan will fail`, { scanIds: itemsWithBadUri.map(i => i.scanId) });
 }
 if (__DEV__ && itemsWithLocalUri.length > 0) {
 logger.debug('[SCAN_SOURCE_AUDIT]', 'local file:// URIs (expected in Expo)', { count: itemsWithLocalUri.length });
 }

 logger.info('[BATCH_START]', { batchId, numJobs: total });
 resetDedupeStats();
 batchStartingRef.current = true;
 lastScanStartAtRef.current = Date.now();
 try {
 // Atomic: create queue records with batchId, photoId, status 'queued', createdAt then write in one go. Only after that kick async.
 const now = Date.now();
 const records: ScanQueueItem[] = items.map(({ uri, scanId }) => ({
 id: scanId,
 uri,
 batchId,
 jobId: undefined,
 photoId: uuidv4(),
 status: 'queued' as const,
 createdAt: now,
 source: 'library' as const,
 }));

  // Step A — on image pick: create Photo in local state, persist to AsyncStorage, enqueue into durable upload queue.
  let usedDurableQueue = false;
  if (user?.uid) {
    // Guard: skip creating local_pending entries for URIs already tracked in state (any status).
    // Prevents duplicate entries when a photo already in the library is rescanned.
    const trackedUriSet = new Set(
      photosRef.current.flatMap(p => [
        (p as any).local_uri,
        p.uri,
      ].filter((u): u is string => Boolean(u?.trim())))
    );
    const newRecords = records.filter(r => !trackedUriSet.has(r.uri?.trim() ?? ''));
    const skipped = records.length - newRecords.length;
    if (skipped > 0) {
      logger.info('[STEP_A]', 'skipped records already tracked (rescan guard)', { skipped });
    }
    const newPhotos: Photo[] = newRecords.map((r) => ({
      id: r.photoId!,
      user_id: user.uid,
      status: 'local_pending',
      local_uri: r.uri,
      created_at: r.createdAt,
      books: [],
      timestamp: r.createdAt,
      uri: r.uri,
    }));
    if (newPhotos.length > 0) {
      const userPhotosKeyA = `photos_${user.uid}`;
      try {
        const existingRaw = await AsyncStorage.getItem(userPhotosKeyA);
        const existing: Photo[] = existingRaw ? (JSON.parse(existingRaw) as Photo[]) : [];
        // Deduplicate by URI when merging to prevent AsyncStorage accumulating stale duplicates.
        const existingUriSet = new Set(
          (Array.isArray(existing) ? existing : []).flatMap(p => [
            (p as any).local_uri, p.uri,
          ].filter((u): u is string => Boolean(u?.trim())))
        );
        const nonDupNew = newPhotos.filter(p => !existingUriSet.has(((p as any).local_uri ?? p.uri)?.trim() ?? ''));
        const merged = Array.isArray(existing) ? [...existing, ...nonDupNew] : nonDupNew;
        await AsyncStorage.setItem(userPhotosKeyA, JSON.stringify(merged));
      } catch (_) {
        await AsyncStorage.setItem(userPhotosKeyA, JSON.stringify(newPhotos));
      }
      for (const r of newRecords) {
        await import('../lib/photoUploadQueue').then(({ addToQueue }) =>
          addToQueue({
            photoId: r.photoId!,
            userId: user.uid,
            sourceUri: r.uri,
            localUri: r.uri,
            createdAt: r.createdAt,
          })
        );
      }
      setPhotos((prev) => [...prev, ...newPhotos]);
      logger.info('[STEP_A]', 'photos created + persisted + enqueued', { count: newPhotos.length, photoIds: newPhotos.map(p => p.id?.slice(0, 8)) });
    }
    usedDurableQueue = true;
  }

  const scanIds = records.map((r) => r.id);
  const initialBatch: ScanBatch = {
    batchId,
    createdAt: now,
    jobIds: [],
    scanIds,
    status: 'queued',
    resultsByJobId: {},
    importedJobIds: [],
    expectedJobCount: records.length,
  };

  setScanQueue((prev) => [...prev, ...records]);
  logQueueDelta('enqueue_atomic', records.length);
  // Serial gate above guarantees no other batch is in-flight when we reach here.
  // Always promote to activeBatch and persist immediately.
  setActiveBatch(initialBatch);
  await persistBatch(initialBatch);
  // Register this batch as in-flight so its poll callbacks are allowed to import.
  inFlightBatchIdsRef.current.add(batchId);

  // When Step A added items to the durable queue, the worker will process; do not run the enqueueImage loop (avoid double upload/scan).
  if (usedDurableQueue) {
    logger.info('[STEP_A]', 'durable queue used — worker will process upload + scan');
    // The durable queue worker handles concurrency internally — clear this batch from
    // inFlightBatchIdsRef so the serial gate doesn't permanently block subsequent scans.
    // Without this, photo 2 stays buffered in serialScanQueueRef forever because the
    // poll loop (which normally calls inFlightBatchIdsRef.delete) never runs.
    inFlightBatchIdsRef.current.delete(batchId);
    // Drain any items that were buffered while we were setting up.
    const serialItems = serialScanQueueRef.current.splice(0);
    if (serialItems.length > 0) {
      logger.info('[BATCH_SERIAL_DRAIN_DURABLE]', { bufferedItems: serialItems.length, prevBatchId: batchId });
      enqueueBatch(serialItems).catch((err) => {
        logger.error('[BATCH_SERIAL_DRAIN_DURABLE] failed to start next batch', err);
      });
    }
    return;
  }

 // Now kick async upload/scan for each record. Failures keep record with status 'error' and errorMessage.
 const enqueuedJobs: Array<{ jobId: string; scanJobId: string; scanId: string; photoId?: string; traceId: string; index: number; jobCreatedAt: number; uri: string; imageHash: string; origW: number; origH: number; optW: number; optH: number; bytes: number }> = [];

 for (let i = 0; i < records.length; i++) {
 const record = records[i];
 const { uri, id: scanId, photoId } = record;
 const index = i + 1;
 const traceId = makeScanTraceId();
 logger.trace('[BATCH_ENQUEUE_ITEM_START]', 'item', { traceId, batchId, scanId, photoId, uri: uri?.slice?.(0, 80) });

 if (currentBatchIdRef.current !== batchId || batchController.signal.aborted) {
 if (LOG_TRACE) logger.debug('[BATCH] canceled, stopping loop');
 break;
 }

 if (i === 0) setUploadDebug({ phase: 'uploading', progress: null, transport: 'fetch' });
 try {
 // Normalize ph:// / assets-library:// / iCloud URIs to a local file:// path.
 // URIs from pickImage should already be normalized by ensureLocalUri, but we keep
 // this as a second defence for URIs that arrive via camera or other paths.
 let uriToUse = uri;
 const uriScheme = uri ? uri.split('://')[0] : '';
 const needsNormalize = uriScheme === 'ph' || uriScheme === 'assets-library' || uriScheme === 'phAsset';
 if (needsNormalize) {
 try {
 const exported = await ImageManipulator.manipulateAsync(
 uri,
 [],
 { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
 );
 uriToUse = exported.uri;
 logger.debug('[URI_NORMALIZE]', { scheme: uriScheme, normalized: uriToUse?.slice?.(0, 80) });
 } catch (normalizeErr: any) {
 logger.warn('[URI_NORMALIZE_FAIL]', { uri: uri?.slice?.(0, 80), scheme: uriScheme, err: String(normalizeErr?.message ?? normalizeErr) });
 // Fall through with original URI optimizeImageForUpload has its own fallback
 }
 } else if (uriScheme === 'file') {
 // file:// URIs may still be iCloud stubs not yet downloaded locally.
 // If the file doesn't exist we attempt a manipulator export to trigger download.
 const fileInfo = await FileSystem.getInfoAsync(uri);
 if (!fileInfo.exists) {
 logger.warn('[URI_FILE_MISSING]', { uri: uri?.slice?.(0, 100), scheme: uriScheme });
 try {
 const exported = await ImageManipulator.manipulateAsync(
 uri,
 [],
 { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
 );
 uriToUse = exported.uri;
 logger.debug('[URI_ICLOUD_EXPORT]', { exported: uriToUse?.slice?.(0, 80) });
 } catch (iCloudErr: any) {
 logger.warn('[URI_ICLOUD_EXPORT_FAIL]', { uri: uri?.slice?.(0, 80), err: String(iCloudErr?.message ?? iCloudErr) });
 }
 }
 }
 const optResult = await optimizeImageForUpload(uriToUse);
 const outputFingerprint = `${optResult.dataURL.length}B_${optResult.dataURL.slice(8, 48)}`;
 logger.debug('[PIPELINE_AFTER_OPTIMIZER]', {
 index,
 inputUri: uri,
 outputUri: outputFingerprint,
 bytes: optResult.bytes,
 });
 const imageHash = await hashDataURL(optResult.dataURL);

      if (!genOk() || currentBatchIdRef.current !== batchId || batchController.signal.aborted) {
        if (LOG_TRACE) logger.debug('[BATCH] canceled after optimization', { genOk: genOk() });
        setScanQueue((prev) => prev.map((item) =>
          item.id === scanId ? { ...item, status: 'canceled' as const, batchId, errorMessage: 'Canceled' } : item
        ));
        continue;
      }

      logger.debug('[PIPELINE_BEFORE_JOB]', { index, outputUri: outputFingerprint, imageHash });

      const jobCreatedAt = Date.now();
      const result = await enqueueImage(optResult.dataURL, batchId, index, total, scanId, batchController, photoId);
      if (!genOk()) {
        // Cancel fired while POST was in-flight — mark item canceled and move on.
        setScanQueue((prev) => prev.map((item) =>
          item.id === scanId ? { ...item, status: 'canceled' as const, batchId, errorMessage: 'Canceled' } : item
        ));
        continue;
      }
      if (result) {
 const storedJobId = canonicalJobId(result.jobId) ?? result.jobId;
 const storedScanJobId = result.scanJobId; // raw UUID use for poll/cancel API calls
 const effectivePhotoId = result.photoId ?? photoId;
 const validId = storedJobId && typeof storedJobId === 'string' && storedJobId.trim().length >= 8;
 const validScanId = storedScanJobId && typeof storedScanJobId === 'string' && storedScanJobId.trim().length >= 8;
 if (!validId || !validScanId) {
   logger.debug('[SCAN_ENQUEUE]', 'skipping active-job registration: invalid jobId/scanJobId from API', { jobId: String(storedJobId ?? '').slice(0, 24), scanJobId: String(storedScanJobId ?? '').slice(0, 24) });
   setScanQueue((prev) => prev.map((item) =>
     item.id === scanId ? { ...item, status: 'error' as const, batchId, errorMessage: 'Invalid job id from server' } : item
   ));
 } else {
 logger.trace('[BATCH_ENQUEUE_ITEM_OK]', 'item ok', { traceId, batchId, scanId, photoId, jobId: storedJobId, scanJobId: storedScanJobId });
 sendTelemetry('SCAN_ENQUEUE', { jobId: storedJobId, batchId });
 logger.debug('[SCAN_START]', { traceId, jobId: storedJobId, scanJobId: storedScanJobId, photoId: effectivePhotoId, batchId });
 enqueuedJobs.push({
 jobId: storedJobId,
 scanJobId: storedScanJobId,
 scanId: result.scanId,
 photoId: effectivePhotoId,
 traceId,
 index,
 jobCreatedAt,
 uri,
 imageHash,
 origW: optResult.origW,
 origH: optResult.origH,
 optW: optResult.optW,
 optH: optResult.optH,
 bytes: optResult.bytes,
 });
      setScanQueue((prev) => prev.map((item) =>
        item.id === scanId ? { ...item, status: 'processing' as const, batchId, jobId: storedJobId, scanJobId: storedScanJobId, ...(result.photoId != null ? { photoId: result.photoId } : {}) } : item
      ));
 addActiveScanJobId(storedScanJobId);
 setActiveBatch((prev) => {
 if (!prev || prev.batchId !== batchId) return prev;
 if (prev.jobIds.includes(storedJobId)) return prev;
 return {
 ...prev,
 jobIds: [...prev.jobIds, storedJobId],
 resultsByJobId: { ...prev.resultsByJobId, [storedJobId]: { status: 'processing' as const } },
 };
 });
 }
 } else {
 logger.trace('[BATCH_ENQUEUE_ITEM_FAIL]', 'Enqueue failed', { traceId, batchId, scanId, photoId });
 setScanQueue((prev) => prev.map((item) =>
 item.id === scanId ? { ...item, status: 'error' as const, batchId, errorMessage: 'Enqueue failed' } : item
 ));
 }
 } catch (error: any) {
 logger.trace('[BATCH_ENQUEUE_ITEM_FAIL]', String(error?.message ?? error), { traceId, batchId, scanId, photoId });
    if (isAbortError(error) || batchController.signal.aborted) {
      if (LOG_TRACE) logger.debug('[BATCH] enqueue aborted');
 setScanQueue((prev) => prev.map((item) =>
 item.id === scanId ? { ...item, status: 'error' as const, batchId, errorMessage: 'Canceled' } : item
 ));
 continue;
 }
 if (error?.message?.includes('re-auth') || error?.message?.includes('session')) {
 Alert.alert('Sign in required', 'Please sign in again to scan.', [{ text: 'OK' }]);
 }
 const { message, stack } = formatErrorForLog(error);
 const errMsg = message.slice(0, 120);
 const fileInfo = await getFileInfoForLog(uri);
 logger.error(' [JOB_CREATE] Batch enqueue failed (file read, conversion, or POST)', {
 step: 'batch_enqueue',
 message,
 stack: stack ?? undefined,
 uri: uri?.slice?.(0, 120),
 fileSize: fileInfo.size,
 mimeOrExtension: fileInfo.mimeOrExtension,
 fileExists: fileInfo.exists,
 batchId,
 index,
 total,
 scanId,
 });
 setScanQueue((prev) => prev.map((item) =>
 item.id === scanId ? { ...item, status: 'error' as const, batchId, errorMessage: errMsg || 'Preprocessing or upload failed' } : item
 ));
 }
 }

 abortControllersRef.current.delete(batchId);

 const batchTrace = getTraceId() ?? batchId;
 if (enqueuedJobs.length > 0) {
   logScanMilestone(batchTrace, 'stepA', { photos_enqueued: enqueuedJobs.length });
   logScanMilestone(batchTrace, 'stepB', { uploads_ok: enqueuedJobs.length, uploads_fail: total - enqueuedJobs.length });
   logScanMilestone(batchTrace, 'stepC', { jobs_created: enqueuedJobs.length });
 }
 if (__DEV__ && enqueuedJobs.length > 0) {
 logger.debug('[SCAN] optimized photos=' + enqueuedJobs.length);
 }
 if (__DEV__ && LOG_TRACE) logger.debug(`[BATCH ${batchId}] enqueued ${enqueuedJobs.length}/${total}`);

  if (enqueuedJobs.length === 0) {
    // Do not clear queue records they have status 'error'/'canceled' and errorMessage. Only clear batch/scan UI.
    clearActiveBatch(batchId, 'cleanup');
    if (genOk()) {
      // Only show the alert if this wasn't a user cancel (a cancel would have already cleared UI).
      setScanProgress(null);
      setUploadDebug(null);
      logger.error('[SCAN_FAILED_TOAST]', 'no jobs were enqueued — showing "Could not start scan" alert', {
        reason: 'no_jobs_enqueued',
        batchId,
        totalItems: total,
        cancelEpoch: cancelGenerationRef.current,
        lastPollResponse: null,
      });
      Alert.alert(
        'Scan failed',
        'Could not start scan. Check the list for errors, or sign in and try again.',
        [{ text: 'OK' }]
      );
    }
    return;
  }

  // If cancelled while upload loop was running, abort before starting the poll loop.
  if (!genOk()) {
    clearActiveBatch(batchId, 'cancel');
    logger.info('[BATCH] cancelled during upload loop; poll loop not started', { batchId });
    return;
  }

  setUploadDebug((prev) => (prev ? { ...prev, phase: 'scanning' } : { phase: 'scanning', progress: null, transport: 'fetch' }));
 const jobIds = enqueuedJobs.map((j) => j.jobId);
 if (__DEV__ && jobIds.length > 0) {
 const first2 = jobIds.slice(0, 2).map((id) => id.slice(0, 8) + '').join(',');
 logger.debug('[SCAN] jobsCreated=' + jobIds.length + ' jobIds=[' + first2 + (jobIds.length > 2 ? ',]' : ']'));
 }
 const batchWithJobs: ScanBatch = {
 ...initialBatch,
 jobIds,
 status: 'processing',
 resultsByJobId: Object.fromEntries(enqueuedJobs.map((j) => [j.jobId, { status: 'processing' as const }])),
 };
  logQueueDelta('enqueue', jobIds.length);
  // Only promote to activeBatch if no other batch has claimed that slot since we yielded.
  if (activeBatchRef.current === null || activeBatchRef.current?.batchId === batchId) {
    setActiveBatch(batchWithJobs);
    await persistBatch(batchWithJobs);
  }
  if (__DEV__) logger.debug('[SCANS] Persisted batch with jobs', { batchId, jobCount: jobIds.length });
  
  // Step 2: Poll all jobs until they complete (pass batch controller so cancel stops polling)
  // Each job merges into state and starts cover fetch as soon as it completes (no wait for all)
  batchResultsMapRef.current.set(batchId, []);
  batchOutcomesMapRef.current.set(batchId, []);

const pollPromises = enqueuedJobs.map(({ jobId, scanJobId, scanId, photoId: jobPhotoId, traceId: itemTraceId, index, jobCreatedAt, uri, imageHash, origW, origH, optW, optH, bytes }) => {
  // Create a per-job AbortController so we can abort this specific poller independently.
  // Combined with the batch controller via AbortSignal.any (or manual abort chain below).
  const jobPollController = new AbortController();
  pollerAbortControllersRef.current.set(jobId, jobPollController);
  // Chain the batch controller signal: if batch is aborted, also abort this job's poller.
  batchController.signal.addEventListener('abort', () => jobPollController.abort(), { once: true });
  return pollJobUntilComplete(scanJobId, scanId, batchId, index, total, jobCreatedAt, jobPollController.signal).then(async result => {
  // Job reached terminal — unregister its poller controller (no longer needed).
  pollerAbortControllersRef.current.delete(jobId);
    const durMs = Date.now() - jobCreatedAt;
    const finalCount = result.books?.length ?? 0;
    logger.info('[JOB_SUMMARY]', {
      jobId: (jobId ?? '').slice(0, 16),
      status: result.status,
      imageHash: imageHash ? imageHash.slice(0, 16) : null,
      booksOnServer: finalCount,
      durMs,
      bytes,
    });

    // CRITICAL: Ignore updates from batches that have been explicitly canceled/aborted.
    // Gate 1: cancel generation — if the user hit X, cancelGenerationRef was incremented and
    //   genOk() returns false. This is the primary guard against stale state writes.
    // Gate 2: inFlightBatchIdsRef — secondary guard for batches evicted by concurrent batches
    //   (unrelated to user cancel; prevents the old "second scan clobbers first" bug).
    if (!genOk()) {
      if (LOG_TRACE) logger.debug('[BATCH] ignoring update (cancelled by user)', { batchId: batchId.slice(-8) });
      return { scanId, status: result.status, books: result.books, ignored: true };
    }
    if (!inFlightBatchIdsRef.current.has(batchId)) {
      if (LOG_TRACE) logger.debug('[BATCH] ignoring update (batch canceled/evicted)', { batchId: batchId.slice(-8) });
      return { scanId, status: result.status, books: result.books, ignored: true };
    }

    // Update batch: resultsByJobId and derived status; persist (only for the displayed batch)
    const batch = activeBatchRef.current;
    if (batch && batch.batchId === batchId) {
 const updatedResults = { ...batch.resultsByJobId, [jobId]: { status: result.status as JobResult['status'], books: result.books } };
 const updatedBatch: ScanBatch = { ...batch, resultsByJobId: updatedResults, status: deriveBatchStatus({ ...batch, resultsByJobId: updatedResults }) };
 setActiveBatch(updatedBatch);
 persistBatch(updatedBatch);
 }

    // Record terminal outcome synchronously into ref so BATCH_COMPLETE can tally accurately
    // regardless of whether React has flushed the setScanQueue updates yet.
    const jobTerminalStatus: 'completed' | 'failed' | 'canceled' =
      result.status === 'completed' ? 'completed' :
      result.status === 'canceled' ? 'canceled' :
      'failed';
    if (!batchOutcomesMapRef.current.has(batchId)) batchOutcomesMapRef.current.set(batchId, []);
    batchOutcomesMapRef.current.get(batchId)!.push(jobTerminalStatus);

    // Record per-job book count for verifyOk cross-check at approve time.
    // NOTE: this records the SERVER count as a temporary ceiling; the real client-inserted
    // count is overwritten below inside setPendingBooks once dedupe runs (see SCAN_IMPORT_AUDIT).
    // Using server count here ensures the ref is set even if setPendingBooks hasn't run yet.
    if (result.status === 'completed' && finalCount > 0 && scanJobId) {
      importedBookCountByJobIdRef.current[scanJobId] = finalCount;
    }

    // Update queue status so UI shows completed/failed
    setScanQueue(prev => prev.map(item =>
      item.id === scanId && item.batchId === batchId ? {
        ...item,
        status: result.status === 'completed' ? 'completed' as const :
                result.status === 'failed' ? 'failed' as const :
                result.status === 'canceled' ? 'canceled' as const :
                'failed' as const
      } : item
    ));

 // Merge this scan into state immediately so first scan's books (and covers) show while others still process
 if (result.status === 'completed' && result.books && result.books.length > 0) {
 logger.info('[SCAN_IMPORT]', { traceId: itemTraceId, jobId, bookCount: result.books?.length });
 sendTelemetry('SCAN_IMPORT', { jobId, bookCount: result.books?.length ?? 0 });
 sendTelemetry('SCAN_DONE_CLIENT', { jobId, reason: 'imported' });
 setUploadDebug(prev => prev ? { ...prev, phase: 'importing' } : { phase: 'importing', progress: null, transport: 'fetch' });
 const allBooks = result.books;
 const newPendingBooks = allBooks.filter((book: Book) => !isIncompleteBook(book));
 const newIncompleteBooks = allBooks.filter((book: Book) => isIncompleteBook(book));
 const existingKey = (b: Book) => `${(b.title || '').toLowerCase().trim()}|${(b.author || '').toLowerCase().trim()}`;
 const keyForDedupe = photoStableKey({ id: scanId, photoFingerprint: imageHash } as Photo);
 const prevPhotos = photosRef.current;
 const newPhotoBytes = bytes;
 const newPhotoWidth = optW;
 const newPhotoHeight = optH;
 const existing = prevPhotos.find(p => {
 if (photoStableKey(p) !== keyForDedupe) return false;
 if (newPhotoBytes != null && p.bytes != null && p.bytes !== newPhotoBytes) return false;
 if (newPhotoWidth != null && p.width != null && p.width !== newPhotoWidth) return false;
 if (newPhotoHeight != null && p.height != null && p.height !== newPhotoHeight) return false;
 return true;
 });
    // Option A: one photo per unique image per user dedupe by hash so we never create multiple local photos for same hash.
    const existingByHash = imageHash ? prevPhotos.find(p => p.photoFingerprint === imageHash) : null;
    const reused = !!existingByHash || !!existing;
    const canonicalPhotoId = existingByHash?.id ?? jobPhotoId ?? (reused ? (existing!.id ?? scanId) : scanId);

    // Emit a clear per-job dedupe identity log so it's obvious in the log stream when
    // "scanning a new photo" resolves to the same underlying image as a previous scan.
    if (reused) {
      logger.info('[PHOTO_DEDUPED_TO_EXISTING]', {
        jobId: (jobId ?? '').slice(0, 8),
        imageHash: imageHash ? imageHash.slice(0, 16) : null,
        dedupeMethod: existingByHash ? 'hash' : 'stable_key',
        localScanId: scanId.slice(0, 8),
        canonicalPhotoId: canonicalPhotoId.slice(0, 8),
        note: 'This scan resolves to an existing photo — no new photo row created.',
      });
    }
 // Identity: book_key is the stable local identity. book.id is only set when the server
 // already returned a DB UUID (e.g. re-import of a previously saved job). For fresh scan
 // results id is left undefined Postgres generates it on insert and propagates via onSuccess.
 const originPhotoId = canonicalPhotoId;
 const originScanJobId = jobId ? (toRawScanJobUuid(jobId) ?? undefined) : undefined;
 const uniqueNewPending: Book[] = newPendingBooks.map((book: Book, i: number) => ({
 ...book,
 id: book.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(book.id) ? book.id : undefined,
 status: 'pending' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 }));
 const uniqueNewIncomplete: Book[] = newIncompleteBooks.map((book: Book, i: number) => ({
 ...book,
 id: book.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(book.id) ? book.id : undefined,
 status: 'incomplete' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 }));
 const photoBooks: Book[] = [...uniqueNewPending, ...uniqueNewIncomplete];
 const finalCaption = scanCaptionsRef.current.get(scanId) || undefined;
 scanCaptionsRef.current.delete(scanId);
 scanIdToPhotoIdRef.current.set(scanId, canonicalPhotoId);
 // Preserve storage_path and status from the existing Step A photo if it was already
 // uploaded by the durable queue. Without this, the scan import creates a fresh 'draft'
 // photo that overwrites the uploaded one, making the spinner show forever.
 // Match by multiple criteria since IDs can differ between Step A (local scanId) and
 // scan import (canonicalPhotoId from server/hash dedup).
 const trimUri = uri?.trim();
 const existingStepA = prevPhotos.find(p =>
   p.id === canonicalPhotoId ||
   p.id === scanId ||
   (p.localId && (p.localId === canonicalPhotoId || p.localId === scanId)) ||
   (trimUri && ((p as any).local_uri ?? p.uri)?.trim() === trimUri)
 );
 const preservedStoragePath = existingStepA?.storage_path ?? undefined;
 // Once scan results are imported (we have books), mark photo as complete.
 // The upload may still be in progress but the scan is done — no spinner needed.
 const preservedStatus = 'complete' as const;
 const newPhoto: Photo = {
 id: canonicalPhotoId,
 uri: existingStepA?.uri ?? uri,
 books: photoBooks,
 timestamp: existingStepA?.timestamp ?? Date.now(),
 caption: finalCaption,
 jobId,
 status: preservedStatus,
 storage_path: preservedStoragePath,
 localId: existingStepA?.localId,
 ...(imageHash && { photoFingerprint: imageHash }),
 bytes: newPhotoBytes ?? existingStepA?.bytes,
 width: newPhotoWidth ?? existingStepA?.width,
 height: newPhotoHeight ?? existingStepA?.height,
 };
 logger.debug('[PHOTO_CREATE]', { traceId: itemTraceId, photoId: canonicalPhotoId, jobId, photoHash: imageHash ? imageHash.slice(0, 16) + '' : null, bytes: newPhotoBytes ?? null });
 logger.debug('[PHOTO_ATTACH_BOOKS]', { traceId: itemTraceId, photoId: canonicalPhotoId, jobId, booksCount: photoBooks.length });
 const photoImportKey = jobId + ':' + (newPhoto.storage_path ?? newPhoto.id ?? String(index));
    // Generation check after async key lookup — cancel may have fired while we awaited.
    if (!genOk()) return { scanId, status: result.status, books: result.books, ignored: true };
    // Do NOT skip when importedKeys has this key — same as processImage: in production it caused pending books to never appear. Always apply; dedupe prevents duplicate books.
    try {
      if (!batchResultsMapRef.current.has(batchId)) batchResultsMapRef.current.set(batchId, []);
      batchResultsMapRef.current.get(batchId)!.push({ index, uniqueNewPending, newPhoto });

      setPhotos(prevPhotos => {
        const key = photoStableKey(newPhoto);
        const existingInState = prevPhotos.find(p => photoStableKey(p) === key);
        recordPhotoDedupe(!!reused);
        if (existingInState && existingInState.id !== canonicalPhotoId) logger.info('[PHOTO_DEDUPE]', 'mismatch', { imageHash: (imageHash ?? '').slice(0, 12), expectedId: existingInState.id, canonicalPhotoId });
        // Clean up any dangling local_pending entries that share the same URI as the incoming result.
        // These are orphans created by Step A when a photo already in the library is rescanned —
        // once real scan results arrive we purge the stale placeholder so no duplicate appears in the UI.
        const anchorPhoto = reused && existingInState ? existingInState : newPhoto;
        const anchorUri = ((anchorPhoto as any).local_uri ?? anchorPhoto.uri)?.trim();
        const anchorId = anchorPhoto.id;
        const withoutStalePending = anchorUri
          ? prevPhotos.filter(p =>
              !(p.status === 'local_pending' &&
                p.id !== anchorId &&
                ((p as any).local_uri ?? p.uri)?.trim() === anchorUri))
          : prevPhotos;
        // Option A: when reused (same hash), attach new scan/books to existing photo do not create new photo entry.
        const nextPhotos = reused && existingInState
          ? withoutStalePending.map(p => photoStableKey(p) === key ? { ...p, books: [...p.books, ...photoBooks] } : p)
          : dedupBy([...withoutStalePending, newPhoto], photoStableKey);
        setPendingBooks(prevPending => {
          const existingKeys = new Set(prevPending.map(b => existingKey(b)));
          // Resolve source_photo_id through alias map immediately at import time.
          // If this same image was scanned before and deduped to a canonical ID in a prior
          // session, the alias map already knows the mapping. Resolving here means books
          // never carry stale local IDs into approve / FK patch / integrity checks.
          const resolvedNewPending = resolveBookPhotoIdsCb(uniqueNewPending, 'ingestion');
          const rewroteCount = resolvedNewPending.filter((b, i) => (b as any).source_photo_id !== (uniqueNewPending[i] as any).source_photo_id).length;
          if (rewroteCount > 0) logger.info('[SCAN_IMPORT_PHOTO_ID_RESOLVED]', { jobId, rewroteCount, sample: resolvedNewPending.slice(0, 1).map((b) => ({ pid: (b as any).source_photo_id?.slice(0, 8) })) });
          const deduped = resolvedNewPending.filter((book: Book) => {
            if (existingKeys.has(existingKey(book))) return false;
            existingKeys.add(existingKey(book));
            return true;
          });
          // [SCAN_IMPORT_AUDIT]: one line per job that proves how many books survived into
          // pending state vs how many the server reported. A mismatch here is the direct
          // cause of "expected 9 actual 8" in APPROVE_VERIFY_IDS perJobCountMismatches.
          // Dropped books are filtered by the title|author dedupe guard above — they were
          // already in prevPending (e.g. from a prior re-scan of the same shelf image).
          const serverBooksCount = allBooks.length;
          const droppedByDedupe = resolvedNewPending.length - deduped.length;
          const droppedSample = droppedByDedupe > 0
            ? resolvedNewPending
                .filter((b: Book) => !deduped.some((d: Book) => existingKey(d) === existingKey(b)))
                .slice(0, 3)
                .map((b: Book) => ({ title: (b.title ?? '').slice(0, 30), author: (b.author ?? '').slice(0, 20), stableKey: existingKey(b) }))
            : [];
          // ok = no pending books were dropped by dedupe (incomplete books filtered out is expected/normal).
          // verifyExpected = deduped.length = what APPROVE_VERIFY_IDS will use as "expected" per job.
          const auditFn = droppedByDedupe > 0 ? logger.warn : logger.info;
          auditFn('[SCAN_IMPORT_AUDIT]', {
            jobId,
            serverBooksCount,
            serverPendingCount: newPendingBooks.length,
            serverIncompleteCount: newIncompleteBooks.length,
            afterPhotoIdResolve: resolvedNewPending.length,
            clientInsertedCount: deduped.length,
            droppedByDedupeCount: droppedByDedupe,
            missingStableKeysSample: droppedSample,
            prevPendingCount: prevPending.length,
            verifyExpected: deduped.length,
            ok: droppedByDedupe === 0,
          });
          // Overwrite with actual client-inserted count so approve verify compares apples-to-apples.
          // The server count recorded above (finalCount) is the ceiling; after title|author dedupe
          // the real insertable count may be lower (expected when the same book appears in prevPending).
          // IMPORTANT: do NOT include newIncompleteBooks.length here. Incomplete books are never sent
          // in the approve payload (booksToApprove filters status !== 'incomplete'), so counting them
          // in `expected` causes a permanent per-job mismatch that fires even when everything is fine.
          if (scanJobId) {
            importedBookCountByJobIdRef.current[scanJobId] = deduped.length;
          }
          const nextPending = [...prevPending, ...deduped];
          clearSelection();
          if (user && (deduped.length > 0 || nextPhotos.length > 0)) {
            // Defer AsyncStorage write so JSON.stringify doesn't block the UI thread.
            // Books are already in React state (nextPending) so the UI updates instantly;
            // persistence can happen after interactions are processed.
            InteractionManager.runAfterInteractions(() => {
              saveUserData(nextPending, approvedBooks, rejectedBooks, nextPhotos).catch(err => logger.error('Error saving batch user data:', err));
            });
          }
          return nextPending;
        });
        return nextPhotos;
      });
      // Fire-and-forget: don't await non-critical writes so the UI stays responsive.
      if (user) addImportedPhotoKey(user.uid, photoImportKey).catch(() => {});
      if (user && jobId && canonicalPhotoId) {
        patchScanJobPhotoId(user.uid, jobId, canonicalPhotoId).catch(() => {});
      }
      scanTerminalGraceUntilRef.current = Date.now() + 15000;
      emitLibraryInvalidate({ reason: 'scan_terminal', jobId: scanJobId ?? jobId, photoId: canonicalPhotoId });
      // DO NOT call triggerDataRefreshRef here — it fires loadUserData() which re-fetches
      // from the server and can overwrite locally-imported pending books from a concurrent
      // job that hasn't synced to the server yet. This was the root cause of "first scan
      // disappears when second scan arrives." The refresh is called once after BATCH_COMPLETE.
      if (LOG_TRACE) logger.debug(`[BATCH] job ${index}/${total} completed, +${uniqueNewPending.length} pending`);

      // Fetch covers for books that arrived without coverUrl (cover worker may still be running).
      // Delay 3s so the UI is responsive for tapping books right after scan results appear.
      const booksNeedingCovers = uniqueNewPending.filter((b: Book) => !b.coverUrl);
      if (booksNeedingCovers.length > 0) {
        setTimeout(() => {
          loadCoversForBooks(booksNeedingCovers).then((coverMap) => {
            if (coverMap.size === 0) return;
            setPendingBooks(prev => prev.map(b => {
              const key = (b as any).workKey ?? (b as any).work_key;
              const url = key ? coverMap.get(key) : undefined;
              if (url && !b.coverUrl) return { ...b, coverUrl: url };
              return b;
            }));
            logger.info('[SCAN_COVERS_BACKFILL]', { jobId, resolved: coverMap.size, needed: booksNeedingCovers.length });
          }).catch(() => {});
        }, 3000);
      }
    } catch (importErr: any) {
      // Server job succeeded but local import threw. Mark as import_failed so user can retry
      // without re-scanning. Books from the server are preserved on the queue item.
      logger.info('[SCAN_IMPORT_FAILED]', {
        traceId: itemTraceId, jobId, scanId,
        err: importErr?.message ?? String(importErr),
      });
      // Patch outcome: server job completed but client import threw — record as import_failed.
      const batchOutcomes = batchOutcomesMapRef.current.get(batchId);
      if (batchOutcomes) {
        const idx = batchOutcomes.lastIndexOf('completed');
        if (idx !== -1) batchOutcomes[idx] = 'import_failed';
      }
      setScanQueue(prev => prev.map(item =>
        item.id === scanId ? {
          ...item,
          status: 'import_failed' as const,
          errorMessage: 'Scan completed but results failed to import. Tap to retry.',
          serverBooks: result.books,
        } : item
      ));
    }
    }

  return { scanId, status: result.status, books: result.books };
  });
});

  // Wait for all polls to complete (each job already merged into state and triggered cover fetch when it completed)
  await Promise.all(pollPromises);

  // Deregister from in-flight set — results from this batch are no longer expected.
  inFlightBatchIdsRef.current.delete(batchId);
  // If this batch was running alongside another that finished first and claimed activeBatch,
  // promote ourselves now so the UI shows our terminal status.
  if (activeBatchRef.current === null || activeBatchRef.current?.batchId === batchId) {
    // already the displayed batch — nothing to do
  } else if (inFlightBatchIdsRef.current.size === 0) {
    // All other batches also done; promote ourselves briefly so BATCH_COMPLETE is visible.
    setActiveBatch({ ...batchWithJobs, status: 'completed' });
  }

  const batchResults = batchResultsMapRef.current.get(batchId) ?? [];
  batchResultsMapRef.current.delete(batchId); // free memory

  // Tally outcomes from the ref — authoritative because it's written synchronously in poll
  // callbacks when each job hits terminal status, before React state flushes. Reading from
  // scanQueue here would give stale values (React batches the setScanQueue calls).
  const batchOutcomes = batchOutcomesMapRef.current.get(batchId) ?? [];
  batchOutcomesMapRef.current.delete(batchId); // free memory
  const jobCompletedCount  = batchOutcomes.filter(s => s === 'completed').length;
  const jobFailedCount     = batchOutcomes.filter(s => s === 'failed').length;
  const jobCanceledCount   = batchOutcomes.filter(s => s === 'canceled').length;
  const importFailedCount  = batchOutcomes.filter(s => s === 'import_failed').length;
  // "server completed" = reached terminal 'completed' on server (includes import_failed subset)
  const serverCompletedCount = jobCompletedCount + importFailedCount;
  const importedCount = batchResults.length;
  const totalBooks = batchResults.reduce((sum, r) => sum + (r.uniqueNewPending?.length ?? 0), 0);

  const dedupeStats = getDedupeStats();
  if (dedupeStats.reused > 0 || dedupeStats.created > 0) {
    logger.info('[PHOTO_DEDUPE_SUMMARY]', {
      batchId,
      hashesCreated: dedupeStats.created,
      hashesReused: dedupeStats.reused,
      ...(dedupeStats.reused > 0 && dedupeStats.created === 0
        ? { note: 'All photos in this batch resolved to existing canonical photos — no new photos were created. This is expected for duplicate scans.' }
        : dedupeStats.reused > 0
        ? { note: `${dedupeStats.reused} photo(s) resolved to existing canonical photo(s).` }
        : undefined),
    });
  }
  resetDedupeStats();
  logger.info('[BATCH_COMPLETE]', {
    batchId,
    totalJobs: jobIds.length,
    jobsCompleted: serverCompletedCount,   // server hit terminal 'completed' (may include import_failed)
    jobsFailed: jobFailedCount,
    jobsCanceled: jobCanceledCount,
    importsSucceeded: importedCount,       // client-side import succeeded
    importsFailed: importFailedCount,      // server ok but local import threw (retryable)
    booksFound: totalBooks,
  });
  // outcome reflects client-visible result (priority order matters):
  //   canceled      — every job was canceled (user pressed X); nothing was imported
  //   fail          — no jobs completed on server and at least one failed
  //   import_failed — server succeeded but ≥1 local import failed (retryable)
  //   partial       — some jobs completed, some failed on server
  //   success       — all jobs completed on server AND all imports succeeded
  const allCanceled = jobCanceledCount > 0 && serverCompletedCount === 0 && jobFailedCount === 0;
  const outcome: 'canceled' | 'fail' | 'import_failed' | 'partial' | 'success' =
    allCanceled                                      ? 'canceled' :
    serverCompletedCount === 0 && jobFailedCount > 0 ? 'fail' :
    importFailedCount > 0                            ? 'import_failed' :
    jobFailedCount > 0                               ? 'partial' :
                                                       'success';
  const batchTraceFinal = getTraceId() ?? batchId;
  logScanMilestone(batchTraceFinal, 'stepD', { jobs_completed: serverCompletedCount, jobs_failed: jobFailedCount });
  logScanMilestone(batchTraceFinal, 'stepE', {
    books_created: totalBooks,
    pending: importedCount,
    approved: 0,
  });
  logScanSummary({
    traceId: enqueuedJobs[0]?.traceId ?? batchId,
    outcome,
    jobId: enqueuedJobs[0]?.jobId ?? null,
    scanJobId: enqueuedJobs[0]?.scanJobId ?? null,
    photoId: enqueuedJobs[0]?.photoId ?? null,
    batchId,
    counts: { detected: totalBooks, imported: importedCount, saved: totalBooks, failed: jobFailedCount, importFailed: importFailedCount, jobsCompleted: serverCompletedCount, jobsCanceled: jobCanceledCount },
  });

  // ─── SERIAL DRAIN ────────────────────────────────────────────────────────────
  // If images arrived while this batch was running they were buffered in serialScanQueueRef.
  // Now that we're terminal, kick them as a fresh batch (only if not canceled).
  // On cancel we discard the buffer so users don't get surprise scans after pressing X.
  const serialItems = serialScanQueueRef.current.splice(0); // atomically take all buffered items
  if (serialItems.length > 0) {
    if (jobCanceledCount > 0 && serverCompletedCount === 0) {
      // Pure cancel: discard buffered items (user pressed X; they don't want more scans).
      logger.info('[BATCH_SERIAL_DISCARDED]', {
        reason: 'batch_was_canceled',
        discarded: serialItems.length,
      });
    } else {
      // Natural terminal (complete/fail): start the buffered items as a new batch.
      logger.info('[BATCH_SERIAL_DRAIN]', {
        bufferedItems: serialItems.length,
        prevBatchId: batchId,
        prevOutcome: outcome,
      });
      // Start the next batch immediately instead of with a 300ms delay.
      // The delay was causing a window where activeBatch became null, making
      // the previous batch's results flicker (disappear then reappear).
      enqueueBatch(serialItems).catch((err) => {
        logger.error('[BATCH_SERIAL_DRAIN] failed to start next batch', err);
      });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Trigger data refresh ONLY when no more batches are queued/in-flight.
  // If a serial drain just started a new batch, defer the refresh until that
  // batch completes — otherwise loadUserData's server merge overwrites the
  // new batch's locally-imported pending books (the "scan 1 disappears" bug).
  if (serialItems.length === 0 && inFlightBatchIdsRef.current.size === 0) {
    triggerDataRefreshRef.current();
  }

  // Batch is terminal; progress bar and queue are cleared by the activeBatch effect when status becomes terminal.
  } finally {
    batchStartingRef.current = false;
  }
};

  /**
   * Retry a failed import for a single queue item whose server job already completed.
   *
   * Strategy:
   *   1. If the queue item still has `serverBooks` (cached from the failed attempt), use them.
   *   2. Otherwise re-fetch `/api/scan/:scanJobId` once to get the completed result.
   *   3. Re-run the import block (setPhotos / setPendingBooks / saveUserData).
   *   4. On success → status: 'completed'; on failure → keep status: 'import_failed' with updated errorMessage.
   */
  const retryImportJob = async (queueItemId: string) => {
    const queueItem = scanQueue.find(i => i.id === queueItemId);
    if (!queueItem || queueItem.status !== 'import_failed') return;

    const { scanJobId, jobId, uri, photoId: itemPhotoId, imageHash: _ih, serverBooks: cachedBooks } = queueItem as any;

    // Mark as processing so the UI shows activity.
    setScanQueue(prev => prev.map(i =>
      i.id === queueItemId ? { ...i, status: 'processing' as const, errorMessage: undefined } : i
    ));

    try {
      let booksToImport: Book[] = cachedBooks ?? [];

      // Re-fetch from server if we don't have a cached copy.
      if (booksToImport.length === 0 && scanJobId) {
        const baseUrl = getApiBaseUrl();
        const { getScanAuthHeaders } = await import('../lib/authHeaders');
        const headers = await getScanAuthHeaders();
        const resp = await fetch(`${baseUrl}/api/scan/${scanJobId}`, { headers });
        if (!resp.ok) throw new Error(`Re-fetch failed: ${resp.status}`);
        const data = await resp.json();
        if (data.status !== 'completed') throw new Error(`Job not completed on server: ${data.status}`);
        booksToImport = data.books ?? [];
      }

      if (booksToImport.length === 0) {
        // Job completed with no books — mark as completed (not an error).
        setScanQueue(prev => prev.map(i =>
          i.id === queueItemId ? { ...i, status: 'completed' as const, errorMessage: undefined, serverBooks: undefined } : i
        ));
        return;
      }

      const existingKey = (b: Book) => `${(b.title || '').toLowerCase().trim()}|${(b.author || '').toLowerCase().trim()}`;
      const prevPhotos = photosRef.current;
      const existingByHash = (queueItem as any).imageHash
        ? prevPhotos.find((p: Photo) => p.photoFingerprint === (queueItem as any).imageHash)
        : null;
      const existingById = prevPhotos.find((p: Photo) => photoStableKey(p) === photoStableKey({ id: queueItem.id, photoFingerprint: (queueItem as any).imageHash } as Photo));
      const reused = !!(existingByHash ?? existingById);
      const canonicalPhotoId = existingByHash?.id ?? itemPhotoId ?? queueItem.id;
      const originPhotoId = canonicalPhotoId;
      const originScanJobId = jobId ? (toRawScanJobUuid(jobId) ?? undefined) : undefined;

      const newPending: Book[] = booksToImport
        .filter((b: Book) => !isIncompleteBook(b))
        .map((b: Book) => ({
          ...b,
          id: b.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.id) ? b.id : undefined,
          status: 'pending' as const,
          ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
          ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
        }));

      const photoBooks: Book[] = newPending;
      const newPhoto: Photo = {
        id: canonicalPhotoId,
        uri: uri ?? queueItem.uri,
        books: photoBooks,
        timestamp: Date.now(),
        jobId: jobId ?? undefined,
        status: 'draft',
        // Don't set approved_count: 0 — undefined = unknown.
        ...((queueItem as any).imageHash && { photoFingerprint: (queueItem as any).imageHash }),
      };

      const photoImportKey = (jobId ?? queueItemId) + ':' + newPhoto.id;
      // Do NOT skip when key already imported — same as processImage/batch: always apply so pending books appear in production. Dedupe prevents duplicate books.

      setPhotos(prevPhotos => {
        const key = photoStableKey(newPhoto);
        const existingInState = prevPhotos.find(p => photoStableKey(p) === key);
        const nextPhotos = reused && existingInState
          ? prevPhotos.map(p => photoStableKey(p) === key ? { ...p, books: [...(p.books ?? []), ...photoBooks] } : p)
          : dedupBy([...prevPhotos, newPhoto], photoStableKey);
        setPendingBooks(prevPendingBooks => {
          const existingKeys = new Set(prevPendingBooks.map(b => existingKey(b)));
          const deduped = newPending.filter((b: Book) => {
            if (existingKeys.has(existingKey(b))) return false;
            existingKeys.add(existingKey(b));
            return true;
          });
          const nextPendingBooks = [...prevPendingBooks, ...deduped];
          clearSelection();
          if (user && (deduped.length > 0 || nextPhotos.length > 0)) {
            setTimeout(() => {
              saveUserData(nextPendingBooks, approvedBooks, rejectedBooks, nextPhotos).catch(err =>
                logger.error('[RETRY_IMPORT] saveUserData failed:', err)
              );
            }, 0);
          }
          return nextPendingBooks;
        });
        return nextPhotos;
      });

      if (user) await addImportedPhotoKey(user.uid, photoImportKey);
      if (user && jobId && canonicalPhotoId) {
        try { await patchScanJobPhotoId(user.uid, jobId, canonicalPhotoId); } catch (_) {}
      }

      setScanQueue(prev => prev.map(i =>
        i.id === queueItemId ? { ...i, status: 'completed' as const, errorMessage: undefined, serverBooks: undefined } : i
      ));
      logger.info('[RETRY_IMPORT_OK]', { queueItemId, jobId, booksImported: newPending.length });
    } catch (err: any) {
      logger.info('[RETRY_IMPORT_FAILED]', { queueItemId, jobId, err: err?.message ?? String(err) });
      setScanQueue(prev => prev.map(i =>
        i.id === queueItemId ? {
          ...i,
          status: 'import_failed' as const,
          errorMessage: `Import failed: ${err?.message ?? 'Unknown error'}. Tap to retry.`,
        } : i
      ));
    }
  };

  // Poll a single job until completion
  // When abortSignal is aborted (user canceled), stop polling and return canceled
  // Per-job timeout: starts when job is created, not when polling starts
  const pollJobUntilComplete = async (
 jobId: string, 
 scanId: string, 
 batchId: string, 
 index: number, 
 total: number,
 jobCreatedAt: number, // Timestamp when job was created (starts per-job timeout)
 abortSignal?: AbortSignal
 ): Promise<{ status: 'completed' | 'failed' | 'canceled', books: Book[] }> => {
 const baseUrl = getApiBaseUrl();
 
const JOB_TIMEOUT_MS = 360000; // 6 minutes per job (starts when job is created)
const POLL_INTERVAL_MS = 3000; // 3 seconds between polls (reduces log noise)
let lastUpdatedAt: string | null = null; // Track last updated_at from server
let pollCount = 0;
// Last full poll response body — logged verbatim whenever we decide to fail/toast.
let lastPollResponse: Record<string, unknown> | null = null;
const _pollStartMs = Date.now();
// Helper: emit [SCAN_POLL_EXIT] then return — one line per poll loop end, low spam.
const pollExit = (
  reason: 'all_terminal' | 'timeout' | 'cancel' | 'network_error' | 'no_candidates',
  result: { status: 'completed' | 'failed' | 'canceled'; books: Book[] }
) => {
  logger.info('[SCAN_POLL_EXIT]', {
    reason,
    jobId,
    scanId,
    status: result.status,
    elapsedMs: Date.now() - _pollStartMs,
    pollCount,
    lastStatusSample: lastPollResponse ?? null,
  });
  return result;
};

// SCAN_POLL_START: emitted once per job when polling begins.
 // jobId = internal poll key (may be scan_jobs.job_uuid or canonical UUID).
 // cancelEpoch = cancelGenerationRef.current at the moment polling starts —
 //   if this changes before we finish, genOk() returns false and we discard results.
 logger.info('[SCAN_POLL_START]', {
   jobId,
   scanId,
   batchId: batchId.slice(-8),
   index,
   total,
   cancelEpoch: cancelGenerationRef.current,
   alreadyAborted: abortSignal?.aborted ?? false,
 });
 
// Poll until job completes, per-job timeout expires, or user cancels (abortSignal)
while (true) {
if (abortSignal?.aborted) {
if (LOG_TRACE) logger.debug('[BATCH] job polling stopped (canceled)');
return pollExit('cancel', { status: 'canceled', books: [] });
}
 const now = Date.now();
 const jobAge = now - jobCreatedAt;
 
 // Check per-job timeout (starts when job was created)
 if (jobAge >= JOB_TIMEOUT_MS) {
 // Timeout exceeded - check server status one more time
 try {
 const cacheBuster = Date.now();
 const pollUrl = `${baseUrl}/api/scan/${jobId}?t=${cacheBuster}`;
 const statusResp = await fetch(pollUrl, {
 method: 'GET',
 signal: abortSignal,
 headers: { 
 'Accept': 'application/json',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
 'Pragma': 'no-cache'
 },
 cache: 'no-store'
 });
 
 if (statusResp.ok && statusResp.status !== 304) {
 const statusData = await statusResp.json();
 const currentStatus = statusData.status;
 const serverBooks = Array.isArray(statusData.books) ? statusData.books : [];
 const updatedAt = statusData.updated_at || null;
 lastPollResponse = { status: currentStatus, stage: statusData.stage ?? null, updated_at: updatedAt, booksCount: serverBooks.length, error: statusData.error ?? null };
 
 // Rule: Only mark as failed if:
 // 1. Server status = failed, OR
 // 2. Server status is still pending/processing AND no updates for jobTimeoutMs
if (currentStatus === 'failed') {
logger.error('[SCAN_FAILED_TOAST]', 'job failed (server returned status=failed) — timeout check path', {
  reason: 'server_status_failed',
  jobId,
  scanId,
  batchId: batchId.slice(-8),
  stage: statusData.stage ?? null,
  pollCount,
  lastPollResponse,
});
if (LOG_TRACE) logger.debug('[BATCH] job failed (server status)');
return pollExit('timeout', { status: 'failed', books: serverBooks });
}
if (currentStatus === 'completed') {
return pollExit('timeout', { status: 'completed', books: serverBooks });
}
if (currentStatus === 'canceled') {
if (LOG_TRACE) logger.debug('[BATCH] job canceled (server status)');
return pollExit('timeout', { status: 'canceled', books: [] });
}
 
 // Still pending/processing - check if there have been updates
 if (currentStatus === 'pending' || currentStatus === 'processing') {
 // Check if job has been updated recently (within last 60 seconds)
 // If updated_at is recent, job is still making progress (e.g. switched to validating)
 let isStale = true;
 if (updatedAt) {
 try {
 const updatedAtTime = new Date(updatedAt).getTime();
 const timeSinceUpdate = now - updatedAtTime;
 // If job was updated within last 60 seconds, it's still active
 if (timeSinceUpdate < 60000) {
 isStale = false;
 if (LOG_TRACE) logger.debug('[BATCH] job still in progress, continuing');
 }
 } catch (e) {
 // If we can't parse updatedAt, assume stale
 }
 }
 
          if (isStale) {
            // No recent updates - do one final check after short delay (job may have just finished validating).
            // Use Promise.race so an abort signal cuts this wait immediately.
            await Promise.race([
              new Promise<void>(r => setTimeout(r, 15000)),
              abortSignal ? new Promise<never>((_, reject) => {
                if (abortSignal.aborted) reject(makeAbortError());
                abortSignal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
              }) : new Promise<never>(() => {}),
            ]).catch(() => { /* abort fires here — caught below */ });
            if (abortSignal?.aborted) {
              if (LOG_TRACE) logger.debug('[BATCH] stale-check delay aborted (cancel)');
              return { status: 'canceled', books: [] };
            }
            try {
 const finalCheckResp = await fetch(`${baseUrl}/api/scan/${jobId}?t=${Date.now()}`, {
 method: 'GET', signal: abortSignal,
 headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
 cache: 'no-store'
 });
 if (finalCheckResp.ok) {
 const finalData = await finalCheckResp.json();
 if (finalData.status === 'completed' && Array.isArray(finalData.books) && finalData.books.length > 0) {
 return { status: 'completed', books: finalData.books };
 }
 }
 } catch {
 // Ignore
 }
 logger.error('[SCAN_FAILED_TOAST]', 'job timed out with no recent updates — poll timeout path', {
   reason: 'job_timeout_stale',
   jobId,
   scanId,
   batchId: batchId.slice(-8),
   pollCount,
   jobAgeMs: Date.now() - jobCreatedAt,
   lastPollResponse,
 });
if (__DEV__) logger.warn('[BATCH] job timeout: no recent updates');
return pollExit('timeout', { status: 'failed', books: [] });
} else {
// Job has recent updates - continue polling (timeout check will happen again next iteration)
lastUpdatedAt = updatedAt;
// Break out of timeout check, continue normal polling
break;
}
}
}
 } catch (timeoutCheckError: any) {
   if (isAbortError(timeoutCheckError) || abortSignal?.aborted) {
     if (LOG_TRACE) logger.debug('[BATCH] job polling stopped (canceled)');
return pollExit('cancel', { status: 'canceled', books: [] });
}
logger.error(` [BATCH ${batchId}] [${index}/${total}] Error checking job ${jobId} on timeout:`, timeoutCheckError?.message || timeoutCheckError);
}

if (__DEV__) logger.warn('[BATCH] per-job timeout exceeded, marking failed');
return pollExit('timeout', { status: 'failed', books: [] });
}
 
 // Normal polling interval (abortable so cancel stops immediately)
 const delayPromise = new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
const abortPromise = abortSignal ? new Promise<never>((_, reject) => {
  if (abortSignal.aborted) reject(makeAbortError());
  abortSignal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
}) : null;
try {
await (abortPromise ? Promise.race([delayPromise, abortPromise]) : delayPromise);
} catch {
if (LOG_TRACE) logger.debug('[BATCH] job polling stopped (canceled)');
return pollExit('cancel', { status: 'canceled', books: [] });
}
if (abortSignal?.aborted) {
if (LOG_TRACE) logger.debug('[BATCH] job polling stopped (canceled)');
return pollExit('cancel', { status: 'canceled', books: [] });
}
 pollCount++;
 
 try {
 const cacheBuster = Date.now();
 const pollUrl = `${baseUrl}/api/scan/${jobId}?t=${cacheBuster}`;
 const statusResp = await fetch(pollUrl, {
 method: 'GET',
 signal: abortSignal,
 headers: { 
 'Accept': 'application/json',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
 'Pragma': 'no-cache'
 },
 cache: 'no-store'
 });
 
 if (statusResp.status === 304) {
 continue;
 }
 
 if (!statusResp.ok) {
 logger.error(` [BATCH ${batchId}] [${index}/${total}] Failed to poll job ${jobId}: ${statusResp.status}`);
 // Continue polling on error (don't break - let timeout handle it)
 continue;
 }
 
 const statusData = await statusResp.json();
 const currentStatus = statusData.status;
 const serverBooks = Array.isArray(statusData.books) ? statusData.books : [];
 const updatedAt = statusData.updated_at || null;
 lastPollResponse = { status: currentStatus, stage: statusData.stage ?? null, updated_at: updatedAt, booksCount: serverBooks.length, error: statusData.error ?? null };
 
 // Track updated_at to detect stale jobs
 if (updatedAt) {
 lastUpdatedAt = updatedAt;
 }
 
 // Check final statuses
 if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'canceled') {
if (currentStatus === 'failed') {
  logger.error('[SCAN_FAILED_TOAST]', 'job failed (server returned status=failed) — normal poll path', {
    reason: 'server_status_failed',
    jobId,
    scanId,
    batchId: batchId.slice(-8),
    stage: statusData.stage ?? null,
    pollCount,
    lastPollResponse,
  });
}
let finalBooks = serverBooks;
let finalStatus = currentStatus;
// [SCAN_POLL_EXIT] will be emitted below via pollExit() when we return.
 // When completed, poll for covers until ready === total or 10s timeout (async cover worker)
 if (currentStatus === 'completed' && serverBooks.length > 0) {
 const covers = statusData.covers as { total?: number; ready?: number } | undefined;
 const COVER_POLL_MS = 10000;
 const COVER_POLL_INTERVAL_MS = 3000;
 const coverPollStart = Date.now();
          while (covers && (covers.ready ?? 0) < (covers.total ?? 0) && (Date.now() - coverPollStart) < COVER_POLL_MS) {
            // Abortable cover-poll delay: exits immediately on cancel rather than waiting the full interval.
            await Promise.race([
              new Promise<void>(r => setTimeout(r, COVER_POLL_INTERVAL_MS)),
              abortSignal ? new Promise<never>((_, reject) => {
                if (abortSignal.aborted) reject(makeAbortError());
                abortSignal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
              }) : new Promise<never>(() => {}),
            ]).catch(() => {});
            if (abortSignal?.aborted) break;
 try {
 const refetchResp = await fetch(`${baseUrl}/api/scan/${jobId}?t=${Date.now()}`, {
 method: 'GET', signal: abortSignal,
 headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
 cache: 'no-store'
 });
 if (refetchResp.ok) {
 const refetchData = await refetchResp.json();
 if (refetchData.status === 'completed' && Array.isArray(refetchData.books)) {
 finalBooks = refetchData.books;
 const refetchCovers = refetchData.covers;
 if ((refetchCovers?.ready ?? 0) >= (refetchCovers?.total ?? 0)) break;
 }
 }
 } catch {
 break;
 }
 }
 }
return pollExit('all_terminal', {
status: finalStatus as 'completed' | 'failed' | 'canceled',
books: finalBooks,
});
}

// Still pending/processing - continue polling
 } catch (pollError: any) {
   if (isAbortError(pollError) || abortSignal?.aborted) {
     if (LOG_TRACE) logger.debug('[BATCH] job polling stopped (canceled)');
return pollExit('cancel', { status: 'canceled', books: [] });
}
logger.error(` [BATCH ${batchId}] [${index}/${total}] Error polling job ${jobId}:`, pollError?.message || pollError);
// Continue polling on error (don't break - let timeout handle it)
}
}
};

 const scanImageWithAI = async (primaryDataURL: string, fallbackDataURL: string, useBackground: boolean = false, scanId?: string, photoId?: string): Promise<{ books: Book[], fromVercel: boolean, jobId?: string, photoId?: string }> => {
 try {
 // Use getApiBaseUrl() so we never hit localhost in production (fixes App Store "unable to find connection")
 const baseUrl = getApiBaseUrl();
 
 // Client-side dedupe: check if same image was scanned recently
 try {
 let imageHash: string;
 if (USE_PURE_JS_HASH) {
 const sample = primaryDataURL.length > 200 ? primaryDataURL.slice(0, 100) + primaryDataURL.slice(-100) : primaryDataURL;
 imageHash = hashStringToHex16(sample);
 } else {
 imageHash = await sha256Hex16(primaryDataURL);
 }
 
 const now = Date.now();
 const activeScans = activeScansRef.current;
 const existingScan = activeScans.get(imageHash);
 
 if (existingScan && (now - existingScan.timestamp) < DEDUPE_WINDOW_MS) {
 logger.warn(` Duplicate scan detected (same image within ${DEDUPE_WINDOW_MS}ms), reusing jobId: ${existingScan.jobId}`);
 // Return the existing jobId - client should poll for it
 return { books: [], fromVercel: false, jobId: existingScan.jobId };
 }
 
 // Clean up old entries
 for (const [hash, scan] of activeScans.entries()) {
 if (now - scan.timestamp > DEDUPE_WINDOW_MS * 2) {
 activeScans.delete(hash);
 }
 }
 } catch (hashError) {
 logger.warn(' Failed to hash image for dedupe (continuing anyway):', hashError);
 }

 // Guest scan: no auth, no Supabase; server returns pendingBooks immediately
 if (user && isGuestUser(user)) {
 try {
 const scanUrl = `${baseUrl}/api/scan`;
 const guestBody = JSON.stringify({ imageDataURL: primaryDataURL, guest: true });
 const guestResp = await fetch(scanUrl, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
 body: guestBody,
 });
 const guestText = await guestResp.text().catch(() => '');
 if (!guestResp.ok) {
 if (guestResp.status === 429) {
   Alert.alert('Limit reached', 'You can do one guest scan. Sign in for more.');
 } else {
   logger.error('[SCAN_FAILED_TOAST]', 'guest scan HTTP error — showing "Scan failed" alert', {
     reason: 'guest_scan_http_error',
     status: guestResp.status,
     lastPollResponse: null,
   });
   Alert.alert('Scan failed', 'Guest scan failed. Try again or sign in.');
 }
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 let guestData: { ok?: boolean; pendingBooks?: Book[]; guestScanId?: string; expiresAt?: string };
 try {
 guestData = JSON.parse(guestText);
 } catch {
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 const books = Array.isArray(guestData?.pendingBooks) ? guestData.pendingBooks : [];
 const withGuest = books.map(b => ({ ...b, isGuest: true as const }));
 await AsyncStorage.setItem(PENDING_GUEST_KEY, JSON.stringify({
 books: withGuest,
 guestScanId: guestData?.guestScanId,
 expiresAt: guestData?.expiresAt,
 }));
 setPendingBooks(withGuest);
 if (books.length > 0) await AsyncStorage.setItem('guest_scan_used', 'true');
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 logger.debug(' Guest scan complete: saved to device only (pending_guest)');
 return { books: withGuest, fromVercel: true };
 } catch (guestErr: any) {
 logger.error('[SCAN_FAILED_TOAST]', 'guest scan threw — showing "Scan failed" alert', {
   reason: 'guest_scan_exception',
   err: guestErr?.message ?? String(guestErr),
   lastPollResponse: null,
 });
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 Alert.alert('Scan failed', 'Guest scan failed. Try again or sign in.');
 return { books: [], fromVercel: false };
 }
 }

 try {
 // Step 1: Create scan job (returns immediately with jobId)
 // Use canonical URL - no redirects allowed. Send auth token; server derives userId.
 const scanUrl = `${baseUrl}/api/scan`;
 logger.debug('[ENQUEUE_URL]', scanUrl);
 let scanHeaders: Record<string, string>;
 try {
 const { getScanAuthHeaders } = await import('../lib/authHeaders');
 scanHeaders = { 'Accept': 'application/json', ...(await getScanAuthHeaders()) };
 } catch {
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 Alert.alert('Sign in required', 'Please sign in again to scan.', [{ text: 'OK' }]);
 return { books: [], fromVercel: false };
 }

 setUploadDebug({ phase: 'uploading', progress: null, transport: 'fetch' });
 const scanBody = JSON.stringify({ imageDataURL: primaryDataURL, forceFresh: true, photoId: photoId ?? scanId });
 logger.debug('[SCAN_POST]', { photoId: photoId ?? scanId, base64Bytes: Math.round(((primaryDataURL?.length ?? 0) * 3) / 4) });
 let createResp: Response;
 let responseText = '';
 try {
 createResp = await fetch(scanUrl, {
 method: 'POST',
 headers: scanHeaders,
 body: scanBody,
 });
 responseText = await createResp.text().catch(() => '');
 logger.debug('[SCAN_POST_RES]', { status: createResp.status, ok: createResp.ok, bodyPrefix: responseText.slice(0, 200) });
 } catch (fetchErr: any) {
 logger.warn('[SCAN_POST_ERR]', { message: String(fetchErr), name: fetchErr?.name });
 throw fetchErr;
 }

 if (!createResp.ok) {
 const errorText = responseText;
 logger.warn('[SCAN_ENQUEUE_FAIL]', { status: createResp.status, error: errorText.slice(0, 200) });
 logger.error(` Failed to create scan job: ${createResp.status} - ${errorText.substring(0, 200)}`);
 
 if (createResp.status === 401) {
 try {
 const errBody = JSON.parse(errorText);
 if (errBody?.error === 'reauth_required') {
 Alert.alert('Session expired', 'Please sign in again to scan.', [{ text: 'OK' }]);
 }
 } catch (_) {}
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 
 // Kill "0 Books" Fallback: If server returns error, STOP everything
 // Do not proceed to client-side detection
 if (createResp.status === 500) {
 Alert.alert(
 'Server Error',
 'Server is busy, please try again.',
 [{ text: 'OK' }]
 );
 // Clear scanning bar on failure
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 
 // Check if it's a scan limit error
 if (createResp.status === 403) {
 try {
 const errorData = JSON.parse(errorText);
 if (errorData.error === 'scan_limit_reached') {
 if (!isSubscriptionUIHidden()) {
 Alert.alert(
 'Scan Limit Reached',
 errorData.message || 'You have reached your monthly scan limit. Please upgrade to Pro for unlimited scans.',
 [
 { text: 'OK', onPress: () => {
 if (!isSubscriptionUIHidden()) {
 setShowUpgradeModal(true);
 }
 }}
 ]
 );
 }
 if (user) {
 loadScanUsage();
 }
 // Clear scanning bar on failure
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 } catch (e) {
 // Not JSON, continue
 }
 }
 
 // For any other error, show alert and stop
 Alert.alert(
 'Scan Failed',
 'Unable to start scan. Please try again.',
 [{ text: 'OK' }]
 );
 // Clear scanning bar on failure
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 
 let jobData: { jobId?: string; job_id?: string; photoId?: string; photo_id?: string; [k: string]: unknown };
 try {
 jobData = JSON.parse(responseText);
 } catch {
 logger.warn('[SCAN_ENQUEUE_FAIL]', { error: 'Invalid JSON response', bodyPrefix: responseText.slice(0, 200) });
 logger.error(' Scan API returned non-JSON (camera)');
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 const rawJobIdCamera = jobData?.jobId ?? jobData?.job_id;
 const jobId = typeof rawJobIdCamera === 'string' ? rawJobIdCamera : null;
 // scanJobId = raw UUID for poll/cancel API calls (scan_jobs.id is uuid type)
 const UUID_RE_CAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const rawScanJobIdCamera = jobData?.scanJobId ?? jobData?.scan_job_id;
 const cameraScanJobId: string = (() => {
 if (typeof rawScanJobIdCamera === 'string' && UUID_RE_CAM.test(rawScanJobIdCamera)) return rawScanJobIdCamera;
 if (typeof jobId === 'string') {
 const s = jobId.startsWith('job_') ? jobId.slice(4) : jobId;
 return UUID_RE_CAM.test(s) ? s : jobId;
 }
 return jobId ?? '';
 })();
 const serverPhotoId = jobData?.photoId ?? jobData?.photo_id ?? undefined;
 setUploadDebug(prev => prev ? { ...prev, phase: 'scanning' } : { phase: 'scanning', progress: null, transport: 'fetch' });

 if (!jobId || typeof jobId !== 'string') {
 logger.warn('[SCAN_ENQUEUE_FAIL]', { error: 'No jobId returned' });
 logger.error(' No jobId returned from scan API (camera)');
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 
 logger.info('[SCAN_ENQUEUE_OK]', { scanJobId: cameraScanJobId, jobId, photoId: serverPhotoId ?? photoId ?? scanId ?? undefined, source: 'camera' });
 // Store jobId in scanProgress for cancel functionality — only if valid (avoid empty id in terminal handler).
 const validJobId = jobId && typeof jobId === 'string' && jobId.trim().length >= 8;
 if (validJobId) {
 const currentProgress = scanProgress;
 if (currentProgress) {
 const existingJobIds = ((currentProgress as any).jobIds || []).filter((id: string) => typeof id === 'string' && id.trim().length >= 8);
 if (!existingJobIds.includes(jobId)) {
 updateProgress({ jobIds: [...existingJobIds, jobId] } as any);
 }
 } else {
 setScanProgress({
 currentScanId: scanId || null,
 currentStep: 0,
 totalSteps: 10,
 totalScans: 1,
 completedScans: 0,
 failedScans: 0,
 startTimestamp: Date.now(),
 jobIds: [jobId],
 } as any);
 }
 }
 
 if (__DEV__) logger.debug('[SCAN] job created jobId=' + jobId);
 setIsUploading(false);
 try {
 let imageHash: string;
 if (USE_PURE_JS_HASH) {
 const sample = primaryDataURL.length > 200 ? primaryDataURL.slice(0, 100) + primaryDataURL.slice(-100) : primaryDataURL;
 imageHash = hashStringToHex16(sample);
 } else {
 imageHash = await sha256Hex16(primaryDataURL);
 }
 activeScansRef.current.set(imageHash, { jobId, timestamp: Date.now() });
 } catch {
 // Ignore hash errors
 }
 const MAX_POLL_TIME_MS = 360000;
 const startTime = Date.now();
 let lastStatus = jobData.status;
 let lastStage: string | null = null;
 const POLL_INTERVAL_MS = 3000;
 
 while (Date.now() - startTime < MAX_POLL_TIME_MS) {
 await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
 
 try {
 const cacheBuster = Date.now();
 // Use raw UUID (cameraScanJobId) in poll URL scan_jobs.id is uuid type
 const pollUrl = `${baseUrl}/api/scan/${cameraScanJobId}?t=${cacheBuster}`;
 const statusResp = await fetch(pollUrl, {
 method: 'GET',
 headers: { 
 'Accept': 'application/json',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
 'Pragma': 'no-cache'
 },
 cache: 'no-store' // Explicitly disable caching
 });
 
 // Handle 304 Not Modified (shouldn't happen with cache headers, but handle gracefully)
 if (statusResp.status === 304) {
 logger.warn(` Received 304 Not Modified for job ${jobId} - skipping this poll`);
 continue; // Skip this poll iteration, try again next time
 }
 
 if (!statusResp.ok) {
 logger.error(` Failed to check job status: ${statusResp.status}`);
 break;
 }
 
 // Only call json() if status is 200 (not 304)
 const statusData = await statusResp.json();
 const currentStatus = statusData.status;
 const serverBooks = Array.isArray(statusData.books) ? statusData.books : [];
 const stage = statusData.stage || null;
 const progress = statusData.progress !== null && statusData.progress !== undefined ? statusData.progress : null;
 const stageDetail = statusData.stage_detail || null;
 const stageLabel = stage ? (stageDetail ? `${stage} (${stageDetail})` : stage) : null;
 const elapsedMs = Date.now() - startTime;
 const pollError = statusData.error ?? null;

 const statusChanged = currentStatus !== lastStatus;
 const stageChanged = stageLabel !== lastStage;
 // Default: log only on state changes (status/stage transitions) to avoid poll-tick spam.
 // Set EXPO_PUBLIC_LOG_POLL=1 to log every tick.
 if (LOG_POLL || statusChanged || stageChanged) {
 logger.debug('[SCAN_POLL_TICK]', {
 jobId,
 status: currentStatus,
 stage: stageLabel ?? stage ?? null,
 elapsedSec: Math.round(elapsedMs / 1000),
 booksCount: serverBooks.length,
 statusChanged,
 stageChanged,
 });
 }

 if (statusChanged || stageChanged) {
 lastStatus = currentStatus;
 lastStage = stageLabel;
 const pct = progress != null ? ` ${progress}%` : '';
 logger.debug('[SCAN] job stage ' + (stage || currentStatus) + pct);
 }
 
 // CRITICAL: Stop polling and return results when status is 'completed' or 'failed'
 if (currentStatus === 'completed' || currentStatus === 'failed') {
 // STOP POLLING - job is done
 if (currentStatus === 'completed') {
 let finalBooks = serverBooks;
 // Poll for covers until ready === total or 10s timeout (async cover worker)
 const covers = statusData.covers as { total?: number; ready?: number } | undefined;
 if (serverBooks.length > 0 && covers && (covers.ready ?? 0) < (covers.total ?? 0)) {
 const COVER_POLL_MS = 10000;
 const COVER_POLL_INTERVAL_MS = 3000;
 const coverPollStart = Date.now();
 while ((Date.now() - coverPollStart) < COVER_POLL_MS) {
 await new Promise(r => setTimeout(r, COVER_POLL_INTERVAL_MS));
 try {
 const refetchResp = await fetch(`${baseUrl}/api/scan/${jobId}?t=${Date.now()}`, {
 method: 'GET',
 headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
 cache: 'no-store'
 });
 if (refetchResp.ok) {
 const refetchData = await refetchResp.json();
 if (refetchData.status === 'completed' && Array.isArray(refetchData.books)) {
 finalBooks = refetchData.books;
 const refetchCovers = refetchData.covers;
 if ((refetchCovers?.ready ?? 0) >= (refetchCovers?.total ?? 0)) break;
 }
 }
 } catch {
 break;
 }
 }
 }
 if (__DEV__) logger.debug('[SCAN] job completed books=' + finalBooks.length);

 // Track scan (skip for guest users)
 if (user && !isGuestUser(user)) {
 incrementScanCount(user.uid).catch(err => {
 logger.error(' Client-side scan tracking failed:', err);
 });
 }

 // Return results (even if 0 books, that's a valid completion). Include server photoId for single source of truth.
 return { books: finalBooks, fromVercel: true, jobId, photoId: serverPhotoId };
 } else {
 // Failed
 const errorInfo = statusData.error || {};
 const errorCode = errorInfo.code || 'unknown_error';
 const errorMessage = errorInfo.message || 'Scan failed';
 logger.error('[SCAN_FAILED_TOAST]', 'camera poll: server returned status=failed', {
   reason: 'server_status_failed',
   jobId,
   cameraScanJobId,
   errorCode,
   errorMessage,
   stage: statusData.stage ?? null,
   lastPollResponse: { status: currentStatus, stage: statusData.stage ?? null, error: errorInfo },
 });
 logger.error(` Scan job failed: [${errorCode}] ${errorMessage} [JOB ${jobId}]`);
 // Clear scanning bar on failure
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 // Return empty books on failure
 return { books: [], fromVercel: false, jobId };
 }
 }
 
 // Continue polling if still pending/processing
 // Status is 'pending' or 'processing', keep waiting
 lastStatus = currentStatus;
 } catch (pollError: any) {
 logger.error(` Error polling job status:`, pollError?.message || pollError);
 // Continue polling on network errors
 }
 }
 
 // Timeout - job took too long (still pending/processing)
 // Do one final fetch - job may have completed in the meantime
 try {
 const finalUrl = `${baseUrl}/api/scan/${cameraScanJobId}?t=${Date.now()}`;
 const finalResp = await fetch(finalUrl, {
 method: 'GET',
 headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
 cache: 'no-store'
 });
 if (finalResp.ok) {
 const finalData = await finalResp.json();
 if (finalData.status === 'completed' && Array.isArray(finalData.books) && finalData.books.length > 0) {
 logger.debug(` Scan job ${jobId} completed after timeout - returning ${finalData.books.length} books`);
 if (user && !isGuestUser(user)) {
 incrementScanCount(user.uid).catch(() => {});
 }
 return { books: finalData.books, fromVercel: true, jobId };
 }
 }
 } catch {
 // Ignore final fetch errors
 }
 // If user already canceled, don't show "Scan Timeout" they chose to stop
 if (canceledJobIdsRef.current.has(jobId)) {
 canceledJobIdsRef.current.delete(jobId);
 setIsUploading(false);
 setIsScanning(false);
 setScanProgress(null);
 return { books: [], fromVercel: false, jobId };
 }
 setIsUploading(false);
 setIsScanning(false);
 logger.error('[SCAN_FAILED_TOAST]', 'camera poll: job polling timeout — showing "Scan Timeout" alert', {
   reason: 'camera_poll_timeout',
   jobId,
   cameraScanJobId,
   lastStatus,
   elapsedMs: MAX_POLL_TIME_MS,
   lastPollResponse: null,
 });
 logger.warn(` Scan job ${jobId} polling timeout after ${MAX_POLL_TIME_MS / 1000}s (last status: ${lastStatus})`);
 Alert.alert(
 'Scan Timeout',
 'The scan is taking longer than expected. The scan may still be processing in the background. Please check your library later - books that finish scanning will appear when you refresh.'
 );
 // Clear scanning bar on timeout
 setScanProgress(null);
 return { books: [], fromVercel: false, jobId };
 
 } catch (e: any) {
 const errorMsg = e?.message || String(e);
 
 logger.error(' Scan job creation/polling failed:', errorMsg);
 logger.error(' Error details:', {
 message: errorMsg,
 name: e?.name,
 stack: e?.stack?.slice(0, 500),
 baseUrl: baseUrl
 });
 
 // Check if it's a network error vs other error
 if (errorMsg.includes('Network request failed') || errorMsg.includes('Failed to fetch')) {
   logger.error('[SCAN_FAILED_TOAST]', 'camera scan: network error — showing "Network Error" alert', {
     reason: 'network_error',
     err: errorMsg.slice(0, 200),
     lastPollResponse: null,
   });
   Alert.alert(
   'Network Error',
   'Unable to connect to the scan server. Please check your internet connection and try again.\n\nIf this persists, the server may be temporarily unavailable.'
   );
 } else {
   logger.error('[SCAN_FAILED_TOAST]', 'camera scan: exception — showing "Scan Failed" alert', {
     reason: 'scan_exception',
     err: errorMsg.slice(0, 200),
     lastPollResponse: null,
   });
   Alert.alert(
   'Scan Failed',
   `Error: ${errorMsg.substring(0, 100)}`
   );
 }
 // Clear scanning bar on error
 setScanProgress(null);
 setIsUploading(false);
 setIsScanning(false);
 return { books: [], fromVercel: false };
 }
 } finally {
 // Guarantee unlock so Confirm/Back buttons never stay disabled (even on error/throw).
 setIsUploading(false);
 setIsScanning(false);
 }
 };

 const processImage = async (uri: string, scanId: string, caption?: string, source?: 'camera' | 'library') => {
 if (processingUrisRef.current.has(uri)) return;
 processingUrisRef.current.add(uri);
 const traceId = makeScanTraceId();
 // Assign batchId to this queue item immediately so pendingCountByScanJobId never has "no-batch" (avoids bar with batchId: null).
 if (source === 'camera' && !cameraBatchIdRef.current) {
 cameraBatchIdRef.current = `camera_${Date.now()}`;
 }
 const earlyBatchId = cameraBatchIdRef.current ?? null;
 if (earlyBatchId) {
 setScanQueue((prev) => prev.map((item) => (item.id === scanId && !item.batchId ? { ...item, batchId: earlyBatchId } : item)));
 }
 if (__DEV__ && source === 'library') logger.debug('[SCAN] start scanId=' + scanId.slice(0, 8) + ' source=library');
 try {
 // Get latest progress to preserve totalScans - CRITICAL: never set totalScans to 0
 // Use ref to get latest value (avoids stale closure issue)
 const latestProgress = scanProgress;
 const refTotalScans = totalScansRef.current;
 const progressTotalScans = latestProgress?.totalScans || 0;
 const existingTotalScans = Math.max(refTotalScans, progressTotalScans);
 
 // Read queue length using functional update to get latest state
 let currentQueueLength = 0;
 let currentCompletedCount = 0;
 let currentFailedCount = 0;
 
 setScanQueue(prev => {
 currentQueueLength = prev.length;
 currentCompletedCount = prev.filter(item => item.status === 'completed' || item.status === 'failed' || item.status === 'canceled').length;
 currentFailedCount = prev.filter(item => item.status === 'failed').length; // Only actual failures, not canceled
 return prev; // Don't modify
 });
 
 // Derive totalScans from the action: we're processing at least one image, so never use 0.
 // State/queue may not have flushed yet when processImage runs, so existingTotalScans/currentQueueLength can be 0.
 const totalScans = Math.max(1, existingTotalScans, currentQueueLength);
 
 totalScansRef.current = totalScans;
 
 if (existingTotalScans === 0 && currentQueueLength === 0 && __DEV__) {
 logger.debug(' processImage: totalScans derived from invariant (state not flushed yet)', { scanId, totalScans });
 }
 
 logger.debug(' processImage starting:', {
 scanId,
 existingTotalScans,
 currentQueueLength,
 totalScans,
 });
 
 // Step 1: Initializing (1%) - update progress with correct totalScans (guaranteed >= 1 above)
 setScanProgress({
 currentScanId: scanId,
 currentStep: 1,
 totalSteps: 10, // More granular steps for better progress tracking
 totalScans, // Always >= 1 when processing
 completedScans: currentCompletedCount,
 failedScans: currentFailedCount,
 startTimestamp: latestProgress?.startTimestamp || Date.now(), // Preserve or set start timestamp
 });
 
 
 setCurrentScan({ id: scanId, uri, progress: { current: 1, total: 10 } });
 
 // Step 2: Optimize and convert image to base64 (10%)
 const optResult = await optimizeImageForUpload(uri);
 const outputFingerprintSingle = `${optResult.dataURL.length}B_${optResult.dataURL.slice(8, 48)}`;
 logger.debug('[PIPELINE_AFTER_OPTIMIZER]', {
 index: 1,
 inputUri: uri,
 outputUri: outputFingerprintSingle,
 bytes: optResult.bytes,
 hashInput: optResult.dataURL.length + ' chars',
 });
 const imageHash = await hashDataURL(optResult.dataURL);
 logger.debug('[PIPELINE_BEFORE_JOB]', { index: 1, outputUri: outputFingerprintSingle, imageHash });
 updateProgress({ currentStep: 2, totalScans: totalScans });
 setCurrentScan({ id: scanId, uri, progress: { current: 2, total: 10 } });

 const fallbackPromise = convertImageToBase64Resized(uri, 1400, 0.5).catch(() => null);

 // Step 3: Scanning with AI (40%)
 const fallbackDataURL = await fallbackPromise || optResult.dataURL;
 logger.debug(' Starting AI scan...');

 // Use UUID so photo id is valid for books.source_photo_id (uuid column); never use composite strings like "photo_123_abc"
 const photoId = uuidv4();
 const jobStartMs = Date.now();
 const scanResult = await scanImageWithAI(optResult.dataURL, fallbackDataURL, false, scanId, photoId);
 const durMs = Date.now() - jobStartMs;
 const provider = scanResult.fromVercel ? 'vercel' : 'client';
 const finalCount = scanResult.books?.length ?? 0;
 logger.debug('[JOB_SUMMARY] jobId=' + (scanResult.jobId ?? '') + ' imageHash=' + imageHash + ' orig=' + optResult.origW + 'x' + optResult.origH + ' opt=' + optResult.optW + 'x' + optResult.optH + ' bytes=' + optResult.bytes + ' provider=' + provider + ' durMs=' + durMs + ' candidates=- final=' + finalCount);

 // Camera/single-image flow: create or update activeBatch with jobId (canonical) so ScanningNotification can poll and progress bar works.
 const storedJobId = scanResult.jobId ? (canonicalJobId(scanResult.jobId) ?? scanResult.jobId) : null;
 if (storedJobId) {
 lastScanStartAtRef.current = Date.now();
 const batch = activeBatchRef.current;
 const batchIdForEnqueue = batch?.batchId ?? cameraBatchIdRef.current ?? `camera_${Date.now()}`;
 sendTelemetry('SCAN_ENQUEUE', { jobId: storedJobId, batchId: batchIdForEnqueue });
 if (batch) {
 if (!batch.jobIds.includes(storedJobId)) {
 const nextQueue = [...batch.jobIds, storedJobId];
 logQueueDelta('enqueue', nextQueue.length);
 const updatedBatch: ScanBatch = {
 ...batch,
 jobIds: nextQueue,
 scanIds: batch.scanIds.includes(scanId) ? batch.scanIds : [...batch.scanIds, scanId],
 };
 setActiveBatch(updatedBatch);
 persistBatch(updatedBatch);
 setScanQueue((prev) => prev.map((item) => (item.id === scanId ? { ...item, batchId: batch.batchId, jobId: storedJobId } : item)));
 }
 } else {
 const batchId = cameraBatchIdRef.current ?? `camera_${Date.now()}`;
 if (cameraBatchIdRef.current === null) setTraceId(makeBatchTraceId());
 cameraBatchIdRef.current = batchId;
 scanShowReasonRef.current = batchId.startsWith('camera_') ? 'queue_resume' : scanShowReasonRef.current;
 const nextQueue = [storedJobId];
 logQueueDelta('enqueue', nextQueue.length);
 const newBatch: ScanBatch = {
 batchId,
 createdAt: Date.now(),
 jobIds: nextQueue,
 scanIds: [scanId],
 status: 'processing',
 resultsByJobId: {},
 importedJobIds: [],
 expectedJobCount: nextQueue.length,
 };
 setActiveBatch(newBatch);
 persistBatch(newBatch);
 setScanQueue((prev) => prev.map((item) => (item.id === scanId ? { ...item, batchId, jobId: storedJobId } : item)));
 }
 }

 const detectedBooks = scanResult.books ?? [];
 const cameFromVercel = scanResult.fromVercel;
 const isGuestResult = cameFromVercel && !scanResult.jobId;

 if (isGuestResult) {
 setPendingImages([{ uri, scanId }]);
 setCurrentImageIndex(0);
 setPendingImageUri(uri);
 currentScanIdRef.current = scanId;
 setCaptionText('');
 processingUrisRef.current.delete(uri);
 setTimeout(() => openAddCaptionScreen(), 100);
 return;
 }

 logger.debug(` AI scan completed: ${detectedBooks.length} books detected (${cameFromVercel ? 'from Vercel API, already validated' : 'from client-side, needs validation'})`);

 // Kill "0 Books" Fallback: If server returned error (not fromVercel and no books), stop everything
 if (!cameFromVercel && detectedBooks.length === 0) {
 logger.error('[SCAN_FAILED_TOAST]', 'scan returned 0 books (not fromVercel) — showing "Scan Failed" alert', {
   reason: 'zero_books_not_from_vercel',
   jobId: scanResult.jobId ?? null,
   cameFromVercel,
   lastPollResponse: null,
 });
 logger.error(' WARNING: Server scan failed and returned 0 books - stopping (no client-side fallback)');
 Alert.alert(
 'Scan Failed',
 'Unable to detect books. Please try again with a clearer image.',
 [{ text: 'OK' }]
 );
 setIsUploading(false);
 setIsScanning(false);
 // Clear scanning bar on failure
 setScanProgress(null);
 // Remove from processing set
 processingUrisRef.current.delete(uri);
 return;
 }
 
 if (detectedBooks.length === 0 && cameFromVercel) {
 logger.error(' WARNING: Server scan completed but returned 0 books');
 logger.error(' Possible causes:');
 logger.error(' 1. Image quality too low or no books visible');
 logger.error(' 2. Validation filtered out all books as invalid');
 logger.error(' 3. Both OpenAI and Gemini returned 0 books');
 }
 
 updateProgress({ currentStep: 4, totalScans: totalScans });
 setCurrentScan({ id: scanId, uri, progress: { current: 4, total: 10 } });
 
 // Step 4: Books are already validated server-side (Vercel API handles validation)
 // If books came from Vercel API, they're already validated. If from client-side fallback, validate here.
 const analyzedBooks = [];
 const totalBooks = detectedBooks.length;
 
 if (totalBooks > 0) {
 if (cameFromVercel) {
 logger.debug(` Using ${totalBooks} validated books from server API (already validated server-side)`);
 analyzedBooks.push(...detectedBooks);
 // Books are already validated by server, move directly to finalizing
 updateProgress({ currentStep: 9, totalScans: totalScans });
 setCurrentScan({ id: scanId, uri, progress: { current: 9, total: 10 } });
 } else {
 // If server API is not available, we can't proceed (no client-side fallback for security)
 logger.error(' Server API not available and client-side API keys are not configured for security reasons');
 logger.error(' Please ensure EXPO_PUBLIC_API_BASE_URL is set correctly');
 // Still add the books but they won't be validated
 analyzedBooks.push(...detectedBooks);
 updateProgress({ currentStep: 9, totalScans: totalScans });
 setCurrentScan({ id: scanId, uri, progress: { current: 9, total: 10 } });
 }
 } else {
 logger.debug(` No books detected to validate`);
 }
 
 // Step 5: Finalizing (100%)
 setUploadDebug(prev => prev ? { ...prev, phase: 'importing' } : { phase: 'importing', progress: null, transport: 'fetch' });
 updateProgress({ currentStep: 10, totalScans: totalScans });
 setCurrentScan({ id: scanId, uri, progress: { current: 10, total: 10 } });

 // Convert analyzed books to proper structure and separate complete vs incomplete
 // Preserve server-enriched fields (googleBooksId, coverUrl, description, etc.) so covers load without re-fetch
 const bookTimestamp = Date.now();
 const scanRandomSuffix = Math.random().toString(36).substring(2, 9);
 const allBooks: Book[] = analyzedBooks.map((book, index) => ({
 ...book,
 id: book.id || `book_${bookTimestamp}_${index}_${scanRandomSuffix}_${Math.random().toString(36).substring(2, 7)}`,
 title: book.title ?? '',
 author: book.author ?? 'Unknown Author',
 isbn: book.isbn ?? '',
 confidence: book.confidence,
 status: 'pending' as const,
 scannedAt: Date.now(),
 }));
 
 // Check if no books were found - only treat as failure if scan actually completed with 0 books
 // If cameFromVercel is false, that means the scan failed (network error, etc.)
 // If cameFromVercel is true but books.length === 0, that means scan completed but found no books
 if (allBooks.length === 0) {
 // Only show failure alert if scan actually failed (not from Vercel) OR if it completed with 0 books
 if (!cameFromVercel) {
 // Network/server error - this is a real failure
 logger.error('[SCAN_FAILED_TOAST]', 'allBooks=0 and not fromVercel — showing "Scan Failed" (network) alert', {
   reason: 'zero_books_not_from_vercel_post_validate',
   jobId: scanResult.jobId ?? null,
   cameFromVercel,
   lastPollResponse: null,
 });
 logger.error(' Scan failed (not from Vercel) - not saving photo');
 Alert.alert(
 'Scan Failed',
 'Unable to connect to scan server. Please check your internet connection and try again.',
 [{ text: 'OK' }]
 );
 
 // Mark scan as failed in queue
 setScanQueue(prev => prev.map(item => 
 item.id === scanId ? { ...item, status: 'failed' as const } : item
 ));
 
 // Clear current scan state
 setCurrentScan(null);
 
 // Update progress to show failed scan
 const currentFailedCount = scanProgress?.failedScans || 0;
 updateProgress({
 currentScanId: null,
 currentStep: 0,
 failedScans: currentFailedCount + 1,
 totalScans: totalScans,
 });
 
 // Clean up caption ref
 scanCaptionsRef.current.delete(scanId);
 
 // Don't save the photo - just return
 return;
 } else {
 // Scan completed successfully but found 0 books - this is a valid result, not a failure
 logger.debug(' Scan completed but found 0 books - showing message');
 
 // Check if there are more photos to scan
 const hasMorePhotos = pendingImages.length > 1 && currentImageIndex < pendingImages.length - 1;
 
 if (hasMorePhotos) {
 // Automatically move to next photo without showing alert
 logger.debug(' No books found, automatically moving to next photo...');
 const nextIndex = currentImageIndex + 1;
 const nextImage = pendingImages[nextIndex];
 
 // Update to show next photo in caption modal
 setCurrentImageIndex(nextIndex);
 setPendingImageUri(nextImage.uri);
 currentScanIdRef.current = nextImage.scanId;
 setCaptionText(scanCaptionsRef.current.get(nextImage.scanId) || '');
 
 // Don't save the photo - just return (caption modal will show next photo)
 return;
 } else {
 // This is the last photo (or only photo), show informational message
 Alert.alert(
 'Couldn\'t Find Any Books',
 'The scan completed but no books were detected in this image.\n\nPossible reasons:\n Image quality is too low\n No books are visible in the photo\n Books are too blurry or obscured\n Try taking a clearer photo with better lighting',
 [{ text: 'OK' }]
 );
 }
 
 // Don't save the photo - just return
 return;
 }
 }
 
 // Mark guest scan as used if this is a successful scan
 // If user is null, treat as guest (shouldn't happen, but safety check)
 if ((!user || isGuestUser(user)) && allBooks.length > 0) {
 await AsyncStorage.setItem('guest_scan_used', 'true');
 logger.debug(' Guest scan marked as used');
 }
 
 // Separate complete and incomplete books
 const newPendingBooks = allBooks.filter(book => !isIncompleteBook(book));
 const newIncompleteBooks: Book[] = allBooks.filter(book => isIncompleteBook(book)).map(book => ({
 ...book,
 status: 'incomplete' as const
 }));
 
 if (newIncompleteBooks.length > 0) {
 logger.debug(` Found ${newIncompleteBooks.length} incomplete books`);
 }

 // Server-generated photoId per upload is single source of truth; fallback for backward compat
 const finalPhotoId = scanResult.photoId ?? photoId ?? scanId;
 const keyForDedupe = photoStableKey({ id: finalPhotoId, photoFingerprint: imageHash } as Photo);
 const prevPhotos = photosRef.current;
 const newPhotoBytes = optResult.bytes;
 const newPhotoWidth = optResult.optW;
 const newPhotoHeight = optResult.optH;
 const existing = prevPhotos.find(p => {
 if (photoStableKey(p) !== keyForDedupe) return false;
 if (newPhotoBytes != null && p.bytes != null && p.bytes !== newPhotoBytes) return false;
 if (newPhotoWidth != null && p.width != null && p.width !== newPhotoWidth) return false;
 if (newPhotoHeight != null && p.height != null && p.height !== newPhotoHeight) return false;
 return true;
 });
 // Option A: one photo per unique image per user dedupe by hash so we never create multiple local photos for same hash.
 const existingByHash = imageHash ? prevPhotos.find(p => p.photoFingerprint === imageHash) : null;
 const reused = !!existingByHash || !!existing;
 const canonicalPhotoId = existingByHash?.id ?? (reused ? (existing!.id ?? finalPhotoId) : finalPhotoId);
 const originPhotoId = canonicalPhotoId;
 const originScanJobId = scanResult.jobId ? (toRawScanJobUuid(scanResult.jobId) ?? undefined) : undefined;

 const photoBooks: Book[] = [
 ...newPendingBooks.map(book => ({
 ...book,
 status: 'pending' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 })),
 ...newIncompleteBooks.map(book => ({
 ...book,
 status: 'incomplete' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 }))
 ];

 const finalCaption = scanCaptionsRef.current.get(scanId) || caption || undefined;
 scanCaptionsRef.current.delete(scanId);
 scanIdToPhotoIdRef.current.set(scanId, canonicalPhotoId);

 const newPhoto: Photo = {
 id: canonicalPhotoId,
 uri,
 books: photoBooks,
 timestamp: Date.now(),
 caption: finalCaption,
 ...(scanResult.jobId && { jobId: scanResult.jobId }),
 status: 'draft',
 // Don't set approved_count: 0 — undefined = unknown.
 ...(imageHash && { photoFingerprint: imageHash }),
 bytes: newPhotoBytes,
 width: newPhotoWidth,
 height: newPhotoHeight,
 };
 logger.debug('[PHOTO_CREATE]', { traceId, photoId: canonicalPhotoId, jobId: scanResult.jobId ?? null, photoHash: (newPhoto.photoFingerprint ?? imageHash) ? String(newPhoto.photoFingerprint ?? imageHash).slice(0, 16) + '' : null, bytes: newPhotoBytes ?? null });
 logger.debug('[PHOTO_ATTACH_BOOKS]', { traceId, photoId: canonicalPhotoId, jobId: scanResult.jobId ?? null, booksCount: photoBooks.length });
 const jobIdForImport = scanResult.jobId ?? newPhoto.jobId;
 const photoImportKey = jobIdForImport ? jobIdForImport + ':' + (newPhoto.storage_path ?? newPhoto.id ?? '0') : null;
 // Do NOT skip applying results when importedKeys has this key — in production that caused pending books to never appear (race with sync or double callback). Always apply; dedupe below prevents duplicate books.

 // Compute updated photos list eagerly (outside state callbacks) so we can await the
 // photo DB write before any book writes reference it via source_photo_id FK.
 const prevPhotosSnap = photosRef.current;
 const photoKey = photoStableKey(newPhoto);
 const existingInStateSnap = prevPhotosSnap.find(p => photoStableKey(p) === photoKey);
 recordPhotoDedupe(!!reused);
 if (existingInStateSnap && existingInStateSnap.id !== canonicalPhotoId) {
 logger.warn('[PHOTO_DEDUPE]', 'mismatch', { imageHash: (newPhoto.photoFingerprint ?? imageHash ?? '').slice(0, 12), expectedId: existingInStateSnap.id, canonicalPhotoId });
 }
 let updatedPhotosEager: Photo[];
 if (reused && existingInStateSnap) {
 updatedPhotosEager = prevPhotosSnap.map(p =>
 photoStableKey(p) === photoKey ? { ...p, books: [...p.books, ...photoBooks] } : p
 );
 updatedPhotosEager = dedupBy(updatedPhotosEager, photoStableKey);
 } else {
 updatedPhotosEager = dedupBy([...prevPhotosSnap, newPhoto], photoStableKey);
 logger.debug(' Adding photo, total photos now:', updatedPhotosEager.length);
 }

 // CRITICAL: await photo save BEFORE any book saves that reference source_photo_id.
 // Fire-and-forget here would race with saveUserData writing books that reference this photo.
 if (user) {
 const userPhotosKey = `photos_${user.uid}`;
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotosEager)).catch(error => {
 logger.error('Error saving photos to AsyncStorage:', error);
 });
 if (!reused) {
 try {
 const saveResult = await savePhotoToSupabase(user.uid, newPhoto, { statusOverride: 'complete' });
 if (saveResult?.ok) clearDraftWatchdogForPhoto(newPhoto.id, saveResult.canonicalPhotoId ?? null);
 if (saveResult?.ok) {
 setPhotos(prev => prev.map(p => p.id === newPhoto.id ? { ...p, status: 'complete' as const, storage_path: saveResult?.canonicalStoragePath ?? p.storage_path } : p));
 }
 if (saveResult?.thumbnailLocalUri) {
 const withThumb = updatedPhotosEager.map(p => p.id === newPhoto.id ? { ...p, thumbnail_uri: saveResult.thumbnailLocalUri! } : p);
 setPhotos(prev => prev.map(p => p.id === newPhoto.id ? { ...p, thumbnail_uri: saveResult.thumbnailLocalUri! } : p));
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(withThumb)).catch(() => {});
 }
 } catch (photoSaveErr) {
 logger.error('Error uploading photo to Supabase:', photoSaveErr);
 }
 }
 } else {
 logger.warn(' No user found when saving photo - skipping AsyncStorage save');
 }

 // Photo row is now committed safe to write books that reference it.
 const newPendingWithProvenance = photoBooks.filter(b => b.status === 'pending');
 // Dedup by id (when present) OR book_key so id-less books from the same scan don't get
 // added twice on re-entry, while still allowing books with id=undefined to pass through.
 const existingPendingIds = new Set(pendingBooks.map(b => b.id).filter(Boolean));
 const existingPendingKeys = new Set(pendingBooks.map(b => (b as any).book_key ?? getStableBookKey(b)).filter(Boolean));
 const uniqueNewPendingBooks = newPendingWithProvenance.filter(book =>
 (book.id ? !existingPendingIds.has(book.id) : true) &&
 !existingPendingKeys.has((book as any).book_key ?? getStableBookKey(book))
 );
 const updatedPendingEager = [...pendingBooks, ...uniqueNewPendingBooks];
 if (newPendingWithProvenance.length > 0) {
 const importJobId = scanResult.jobId ?? jobIdForImport;
 logger.info('[SCAN_IMPORT]', { traceId, jobId: importJobId, bookCount: newPendingWithProvenance.length });
 if (importJobId) {
 sendTelemetry('SCAN_IMPORT', { jobId: importJobId, bookCount: newPendingWithProvenance.length });
 sendTelemetry('SCAN_DONE_CLIENT', { jobId: importJobId, reason: 'imported' });
 }
 }
 if (__DEV__ && uniqueNewPendingBooks.length > 0) logger.debug('[SCAN] pending updated +' + uniqueNewPendingBooks.length + ' totalPending=' + updatedPendingEager.length);
 // Snapshot immediately after scan result is merged into pending state.
 logger.debug('[PENDING_PIPELINE_SUMMARY]', {
 phase: 'scan_result',
 totalBooks: updatedPendingEager.length,
 pendingBooksCount: updatedPendingEager.filter(b => b.status === 'pending').length,
 newBooksThisScan: uniqueNewPendingBooks.length,
 photoId: canonicalPhotoId ?? null,
 });
 if (user) {
 saveUserData(updatedPendingEager, approvedBooks, rejectedBooks, updatedPhotosEager).catch(error => {
 logger.error('Error saving user data:', error);
 });
 }

 // Now update React state (pure UI no side-effect DB writes inside these callbacks).
 setPhotos(prevPhotos => {
 const existingInState = prevPhotos.find(p => photoStableKey(p) === photoKey);
 let updatedPhotos: Photo[];
 if (reused && existingInState) {
 updatedPhotos = prevPhotos.map(p =>
 photoStableKey(p) === photoKey ? { ...p, books: [...p.books, ...photoBooks] } : p
 );
 updatedPhotos = dedupBy(updatedPhotos, photoStableKey);
 } else {
 updatedPhotos = dedupBy([...prevPhotos, newPhoto], photoStableKey);
 }

 setPendingBooks(prevPending => {
 const existingBookIds = new Set(prevPending.map(b => b.id));
 const newUnique = newPendingWithProvenance.filter(book => !existingBookIds.has(book.id));
 return [...prevPending, ...newUnique];
 });

 return updatedPhotos;
 });
 if (photoImportKey && user) await addImportedPhotoKey(user.uid, photoImportKey);
 // No exceptions: after dedupe always patch scan_jobs.photo_id = canonicalPhotoId. Await so sync never sees job without photo_id.
 if (user && scanResult.jobId && canonicalPhotoId) {
 try {
 await patchScanJobPhotoId(user.uid, scanResult.jobId, canonicalPhotoId);
 } catch (err) {
 if (__DEV__) logger.warn('[SCAN] patchScanJobPhotoId failed:', err);
 }
 }

 // Ensure no book appears pre-selected after new results arrive
 clearSelection();

 // Auto-open the scan results modal so the user sees the detected books (fix: results not popping up in App Store).
 const photoToShow = updatedPhotosEager.find(p => photoStableKey(p) === photoKey);
 if (photoToShow && newPendingWithProvenance.length > 0) {
   requestAnimationFrame(() => {
     setTimeout(() => openScanModal(photoToShow), 150);
   });
 }

 // Covers are resolved in worker; client shows book.coverUrl or placeholder
 
 // Add books to selected folder if one was chosen
 if (selectedFolderId) {
 const scannedBookIds = newPendingBooks.map(book => book.id).filter((id): id is string => id !== undefined);
 await addBooksToSelectedFolder(scannedBookIds);
 }
 
 // NOTE: Scan count is already incremented by the API when the scan request is made
 // We should NOT increment again here to avoid double-counting
 // The API tracks scans at the point of request, not when books are found
 // This ensures 1 photo = 1 scan, regardless of how many books are found
 
 // Refresh scan limit banner and usage after successful scan
 // The API now tracks scans synchronously, so refresh after a short delay
 if (user) {
 // Refresh after 1 second to let the database update complete
 setTimeout(() => {
 if (scanLimitBannerRef.current) {
 scanLimitBannerRef.current.refresh();
 }
 loadScanUsage();
 }, 1000);
 
 // Also refresh after 3 seconds as a backup
 setTimeout(() => {
 if (scanLimitBannerRef.current) {
 scanLimitBannerRef.current.refresh();
 }
 loadScanUsage();
 }, 3000);
 }
 
 // Update queue status using functional update to get latest state
 setScanQueue(prev => {
 const updatedQueue = prev.map(item => 
 item.id === scanId ? { ...item, status: 'completed' as const } : item
 );
 
 // Progress will be updated automatically via useEffect watching scanQueue
 // No need to manually update here - the useEffect will handle it
 const pendingScans = updatedQueue.filter(item => item.status === 'queued' || item.status === 'pending');
 const stillProcessing = updatedQueue.some(item => item.status === 'processing');
 
 logger.debug(' Scan completion check:', {
 completedCount: updatedQueue.filter(item => item.status === 'completed' || item.status === 'failed' || item.status === 'canceled').length,
 pendingScans: pendingScans.length,
 stillProcessing,
 activeScans: updatedQueue.filter(item => item.status === 'queued' || item.status === 'pending' || item.status === 'processing').length,
 totalInQueue: updatedQueue.length,
 queue: updatedQueue.map(i => ({ id: i.id, status: i.status }))
 });
 
 // Check if there are more scans to process
 const hasMoreScans = pendingScans.length > 0 || stillProcessing;
 
 if (hasMoreScans) {
 // More scans to process - process next one
 logger.debug(' More scans to process, keeping notification visible');
 
 // Process next pending scan if available and not already processing
 if (!stillProcessing && pendingScans.length > 0) {
 const nextScan = pendingScans[0];
 logger.debug(' Starting next scan:', nextScan.id);
 setIsProcessing(true);
 setTimeout(() => {
 setScanQueue(currentQueue => {
 const updatedQueue = currentQueue.map(item => 
 item.id === nextScan.id ? { ...item, status: 'processing' as const } : item
 );
 // Progress will be updated automatically via useEffect watching scanQueue
 return updatedQueue;
 });
 processImage(nextScan.uri, nextScan.id, undefined, nextScan.source).catch(err => {
 logger.error('Error processing image:', err);
 });
 }, 500);
 }
 } else {
 setTimeout(() => {
 setScanProgress(null);
 totalScansRef.current = 0; // Reset ref when all scans complete
 // Clear completed scans from queue to prevent them from being counted in future scans
 setScanQueue(prev => prev.filter(item => item.status === 'queued' || item.status === 'pending' || item.status === 'processing'));
 // Refresh scan usage when all scans are complete
 if (user) {
 setTimeout(() => {
 loadScanUsage();
 scanLimitBannerRef.current?.refresh();
 }, 1000);
 }
 }, 500);
 }
 
 return updatedQueue;
 });
 
 logger.debug(` Scan complete: ${newPendingBooks.length} books ready, ${newIncompleteBooks.length} incomplete`);
 
 } catch (error: any) {
 logger.error(' Processing failed:', error);
 logger.error(' Error details:', {
 message: error?.message,
 name: error?.name,
 stack: error?.stack?.slice(0, 500),
 scanId,
 uri: uri?.substring(0, 50)
 });
 
 // Show user-friendly error message
 const errorMessage = error?.message || String(error) || 'Unknown error';
 if (errorMessage.includes('user') || errorMessage.includes('uid')) {
 Alert.alert(
 'Scan Error',
 'An error occurred while saving your scan. Please try signing in and scanning again.',
 [{ text: 'OK' }]
 );
 } else {
 Alert.alert(
 'Scan Failed',
 `An error occurred: ${errorMessage.substring(0, 100)}`,
 [{ text: 'OK' }]
 );
 }
 
 // Use functional update to get latest queue state
 setScanQueue(prev => {
 const failedQueue = prev.map(item => 
 item.id === scanId ? { ...item, status: 'failed' as const } : item
 );
 
 // Update progress with failed scan
 const newFailedCount = failedQueue.filter(item => item.status === 'failed').length;
 const pendingScans = failedQueue.filter(item => item.status === 'pending');
 const stillProcessing = failedQueue.some(item => item.status === 'processing');
 
 // Get totalScans from current progress
 const failedProgress = scanProgress || {
 currentScanId: null,
 currentStep: 0,
 totalSteps: 10,
 totalScans: failedQueue.length,
 completedScans: 0,
 failedScans: 0,
 };
 const failedTotalScans = Math.max(failedProgress.totalScans, failedQueue.length);
 
 if (stillProcessing || pendingScans.length > 0) {
 updateProgress({
 currentScanId: null,
 currentStep: 0,
 failedScans: newFailedCount,
 totalScans: failedTotalScans,
 });
 
 // Process next pending scan if available and not already processing
 if (!stillProcessing && pendingScans.length > 0) {
 const nextScan = pendingScans[0];
 setIsProcessing(true);
 setTimeout(() => {
 setScanQueue(currentQueue => 
 currentQueue.map(item => 
 item.id === nextScan.id ? { ...item, status: 'processing' as const } : item
 )
 );
 // Process sequentially - processImage is async, but we wrap it to ensure proper error handling
 processImage(nextScan.uri, nextScan.id, undefined, nextScan.source).catch(err => {
 logger.error('Error processing image:', err);
 });
 }, 500);
 }
 } else {
 setTimeout(() => {
 setScanProgress(null);
 // Refresh scan usage when all scans are complete
 if (user) {
 setTimeout(() => {
 loadScanUsage();
 scanLimitBannerRef.current?.refresh();
 }, 1000);
 }
 }, 500);
 }
 
 return failedQueue;
 });
 } finally {
 // Guarantee unlock so Confirm/Back buttons always respond (even on error/early return).
 setIsUploading(false);
 setIsScanning(false);
 processingUrisRef.current.delete(uri);
 setCurrentScan(null);
 // Compact end-of-camera-scan summary paste this + error blocks when filing bugs.
 logScanSummary({
 traceId,
 outcome: 'success',
 photoId: null,
 counts: { detected: 0, imported: 0, saved: 0, failed: 0 },
 });
 // Check if there are more scans to process
 const hasMorePending = scanQueue.some(item => item.status === 'pending');
 if (!hasMorePending) {
 setIsProcessing(false);
 }
 }
 };

 const approveBook = async (bookId: string) => {
 if (isApprovingRef.current || isApproving || isClearInProgress()) return;
 // Guest users: navigate to My Library (login screen) and store pending action
 if (user && isGuestUser(user)) {
 // Store the book ID to approve after login
 await AsyncStorage.setItem(PENDING_APPROVE_ACTION_KEY, JSON.stringify({ type: 'approve_book', bookId }));
 // Navigate to My Library tab which shows login screen
 navigation.navigate('MyLibrary' as never);
 return;
 }
 
 const bookToApprove = pendingBooks.find(book => book.id === bookId);
 if (!bookToApprove) return;

 // Provenance lives on the pending book (set at creation); only fall back to selectedPhoto for old data.
 const originPhotoId = (bookToApprove as any).source_photo_id ?? selectedPhoto?.id;
 const originScanJobId = (bookToApprove as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
 const approvedBook: Book = {
 ...bookToApprove,
 status: 'approved' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 };

 const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved([approvedBook], selectedPhoto?.jobId);
 const updatedPending = pendingBooks
 .filter(book => book.id !== bookId)
 .filter(b => {
 const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
 return !raw || !closedJobIdsRaw.has(raw);
 });
 const updatedApproved = ensureApprovedOnePerBookKey(deduplicateBooks(approvedBooks, [approvedBook]));
 lastLocalMutationAtRef.current = Date.now();
 const _now = Date.now();
 lastApprovedAtRef.current = _now;
 approvalGraceUntilRef.current = _now + 5000;
 setLastApprovedAt(_now);
 setPendingBooks(updatedPending);
 setApprovedBooks(updatedApproved);
 refreshProfileStats();
 try {
 await saveUserData(updatedPending, updatedApproved, rejectedBooks, photos, {
 photoIdForApproved: originPhotoId,
 photoIdsForApproved: originPhotoId ? [originPhotoId] : [],
 scanJobIdForApproved: originScanJobId,
 jobIdsToClose,
 source: 'scan',
 });
 } catch (err) {
 setPendingBooks(pendingBooks);
 setApprovedBooks(approvedBooks);
 Alert.alert('Approve failed', (err as Error)?.message ?? 'Could not save. Please retry. Nothing was changed.');
 }
 };

 const rejectBook = async (bookId: string) => {
 const bookToReject = pendingBooks.find(book => book.id === bookId);
 if (!bookToReject) return;

 const rejectedBook: Book = {
 ...bookToReject,
 status: 'rejected' as const
 };

 const updatedPending = pendingBooks.filter(book => book.id !== bookId);
 const updatedRejected = [...rejectedBooks, rejectedBook];

 lastDestructiveActionRef.current = { actionId: `reject_${Date.now()}`, reason: 'reject_book', at: Date.now(), bookCount: 1, photoCount: 0 };
 setPendingBooks(updatedPending);
 lastLocalMutationAtRef.current = Date.now();
 setRejectedBooks(updatedRejected);
 await saveUserData(updatedPending, approvedBooks, updatedRejected, photos);
 };

 const openScanModal = (photo: Photo) => {
 setSelectedPhoto(photo);
 // Ensure payload is set before presenting to avoid a blank first frame.
 requestAnimationFrame(() => setShowScanModal(true));
 };

 /** Open scan review (Books from this Photo) for a pending group. Uses real photo when available; otherwise builds a minimal photo so the modal can still open and show books. */
 const openScanReview = (group: PendingScanGroup) => {
 if (group.photo) {
 openScanModal(group.photo);
 return;
 }
 const jobId = group.scanJobId && group.scanJobId !== 'guest_scan' ? toScanJobId(group.scanJobId) : undefined;
 const syntheticPhoto: Photo = {
 id: group.photoId || group.scanJobId || `scan_${group.createdAt}`,
 uri: '',
 books: group.books,
 timestamp: group.createdAt,
 ...(jobId && { jobId }),
 };
 openScanModal(syntheticPhoto);
 };

const closeScanModal = () => {
  const photo = selectedPhoto;
  if (photo?.id && user) {
    const now = Date.now();
    const approvedCountForPhoto = approvedBooks.filter((b) => (b as any).source_photo_id === photo.id).length;
    // Only mark 'complete' if the photo has actually been uploaded to storage.
    // A local file:// URI means the upload hasn't happened yet — keep it as 'draft'
    // so it isn't classified as "corrupt" (no storage_path) on the next rehydrate.
    // The approve flow will stamp 'complete' later once savePhotoToSupabase confirms upload.
    const hasStorage = !!(
      ((photo as any).storage_path && ((photo as any).storage_path as string).trim().length > 0) ||
      ((photo as any).storage_url && ((photo as any).storage_url as string).startsWith('http'))
    );
    const nextStatus: Photo['status'] = approvedCountForPhoto === 0
      ? 'discarded'
      : hasStorage
        ? 'complete'
        : 'draft'; // uploaded but storage not yet confirmed — stay draft
    const updatedPhotos = photos.map((p) =>
      p.id === photo.id
        ? {
            ...p,
            finalizedAt: now,
            status: nextStatus,
            approved_count: approvedCountForPhoto,
          }
        : p
    );
    setPhotos(dedupBy(updatedPhotos, photoStableKey));
    AsyncStorage.setItem(`photos_${user.uid}`, JSON.stringify(updatedPhotos)).catch(() => {});
    saveUserData(pendingBooks, approvedBooks, rejectedBooks, updatedPhotos).catch(() => {});
  }
 setSelectedPhoto(null);
 setShowScanModal(false);
 setScanModalBooksFromJob(null);
 setScanModalBooksLoading(false);
 };

 // When Scan Details modal opens with a photo that has jobId, read books from scan_jobs.books (API), not from photo.books.
 // Stale requests are ignored via reqToken; only update books when status === 'completed'. Do NOT call setBooks from progress events.
 useEffect(() => {
 if (!showScanModal || !selectedPhoto?.jobId) {
 if (!showScanModal) {
 setScanModalBooksFromJob(null);
 setScanModalBooksLoading(false);
 }
 return;
 }
 const jobId = selectedPhoto.jobId;
 const reqToken = `${jobId}:${Date.now()}`;
 latestPendingReqRef.current = reqToken;
 setScanModalBooksLoading(true);
 setScanModalBooksFromJob(null);
 const baseUrl = getApiBaseUrl();
 const url = `${baseUrl}/api/scan/${jobId}?t=${Date.now()}`;
 fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
 .then(res => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
 .then(async (data: { status?: string; books?: Book[]; id?: string; jobId?: string }) => {
 if (latestPendingReqRef.current !== reqToken) return;
 logger.debug('[PENDING] requested jobId:', jobId);
 const scanJob = data;
 logger.debug('[PENDING]', 'fetched row', { id: scanJob?.id, status: scanJob?.status, booksCount: scanJob?.books?.length });

 // One source of truth: only set book list when status === 'completed'. Do not set from tile results, progress events, AsyncStorage, or "latest scan job".
 if (scanJob?.status !== 'completed') {
 setScanModalBooksLoading(false);
 return;
 }
 const books = Array.isArray(scanJob.books) ? scanJob.books : [];
 if (latestPendingReqRef.current !== reqToken) return;
 setScanModalBooksFromJob(books);

 let coverMap: Map<string, string>;
 try {
 coverMap = await loadCoversForBooks(books);
 } catch (e) {
 if (__DEV__) logger.warn('[COVERS] loadCoversForBooks failed', e);
 coverMap = new Map();
 }
 if (latestPendingReqRef.current !== reqToken) return;
 if (coverMap.size === 0) {
 const workKeys = books.map(b => (b as any).workKey ?? (b as any).work_key).filter(Boolean) as string[];
 const toFetch = books.some(b => !b.coverUrl) ? workKeys : [];
 for (let i = 0; i < toFetch.length; i += 100) {
 const chunk = toFetch.slice(i, i + 100);
 try {
 const res = await fetch(`${baseUrl}/api/cover-status?workKeys=${encodeURIComponent(chunk.join(','))}`, { cache: 'no-store' });
 const coverData = (await res.json()) as { resolved?: { work_key: string; coverUrl: string }[] };
 (coverData?.resolved ?? []).forEach((r: { work_key: string; coverUrl: string }) => {
 if (r.work_key && r.coverUrl) coverMap.set(r.work_key, r.coverUrl);
 });
 } catch {
 break;
 }
 }
 }
 let finalBooks = books;
 if (coverMap.size > 0) {
 const merged = books.map(b => {
 const key = (b as any).workKey ?? (b as any).work_key;
 const url = key ? coverMap.get(key) : undefined;
 if (url && !b.coverUrl) return { ...b, coverUrl: url };
 return b;
 });
 if (latestPendingReqRef.current === reqToken) setScanModalBooksFromJob(merged);
 finalBooks = merged;
 }
 logger.debug('[PENDING] after UI transforms:', finalBooks.length);
 if (latestPendingReqRef.current === reqToken) setScanModalBooksLoading(false);
 })
 .catch(() => {
 if (latestPendingReqRef.current !== reqToken) return;
 setScanModalBooksFromJob(null);
 setScanModalBooksLoading(false);
 });
 }, [showScanModal, selectedPhoto?.id, selectedPhoto?.jobId]);

 // When Scan Details modal opens with a library photo (no jobId), fetch books from server so we never rely on stale client merge (fixes "0 books" in TestFlight).
 useEffect(() => {
 if (!showScanModal || !selectedPhoto || selectedPhoto.jobId || !user) return;
 setScanModalBooksLoading(true);
 setScanModalBooksFromJob(null);
 const photoId = selectedPhoto.id;
 if ((global as any).__photoDebug) {
 runPhotoDetailsDebug(photoId, user.uid, photoIdAliasRef.current).catch(() => {});
 }
 fetchBooksForPhoto(user.uid, photoId)
 .then((books) => {
 setScanModalBooksFromJob(books);
 setScanModalBooksLoading(false);
 })
 .catch(() => {
 setScanModalBooksFromJob(null);
 setScanModalBooksLoading(false);
 });
 }, [showScanModal, selectedPhoto?.id, selectedPhoto?.jobId, user?.uid]);

 /** Remove a single book from the current scan (scan detail grid long-press). Updates photo.books, scanModalBooksFromJob, pendingBooks, and persists. */
 const removeBookFromScanDetail = useCallback(async (book: Book) => {
 if (!selectedPhoto) return;
 const bookId = book.id;
 if (!bookId) return;

 const updatedPhotos = photos.map(p =>
 p.id === selectedPhoto.id ? { ...p, books: p.books.filter(b => b.id !== bookId) } : p
 );
 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 setSelectedPhoto(prev => (prev && prev.id === selectedPhoto.id)
 ? { ...prev, books: prev.books.filter(b => b.id !== bookId) }
 : prev);

 if (selectedPhoto.jobId && scanModalBooksFromJob != null) {
 setScanModalBooksFromJob(scanModalBooksFromJob.filter(b => b.id !== bookId));
 }
 setPendingBooks(prev => prev.filter(b => b.id !== bookId));

 const updatedPending = pendingBooks.filter(b => b.id !== bookId);
 await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
 }, [selectedPhoto, photos, scanModalBooksFromJob, pendingBooks, approvedBooks, rejectedBooks]);

 /** Delete by photo row id only (photo.id). Never pass jobId or effective id API deletes by photos.id. */
 const deleteScan = async (photoId: string) => {
 try {
 const opId = generateOpId();
 const photoToDelete = photos.find(photo => photo.id === photoId);
 if (!photoToDelete) return;

 // Never cascade-delete approved books from Scans tab. Only clear pending, or delete photo when it has no approved books.
 const hasApprovedBooks = photoToDelete.books.some(b => b.status === 'approved');
 const isPendingScan = Boolean(photoToDelete.jobId) || hasApprovedBooks;
 const booksToDelete = photoToDelete.books.filter(book =>
 book.status === 'pending' || book.status === 'incomplete'
 );

 const pendingIdsLocalSample = booksToDelete.slice(0, 10).map(b => b.id).filter((id): id is string => !!id);
 const criteria = {
 status: 'pending' as const,
 source_scan_job_id: photoToDelete.jobId ? (toRawScanJobUuid(photoToDelete.jobId) ?? undefined) : undefined,
 source_photo_id: photoId,
 };
 logger.debug('[PENDING_REMOVE_INTENT]', JSON.stringify({
 action: 'CLEAR_PENDING',
 opId,
 userId: user?.uid ?? null,
 photoId,
 jobId: photoToDelete.jobId ?? null,
 batchId: (photoToDelete as any).batchId ?? undefined,
 pendingCountLocal: booksToDelete.length,
 pendingIdsLocalSample,
 criteria,
 }));

 // Flow A (pending scan): never remove approved/rejected books. Flow B (library photo): remove by source_photo_id.
 const updatedApproved = isPendingScan ? approvedBooks : approvedBooks.filter(b => b.source_photo_id !== photoId);
 const updatedRejected = isPendingScan ? rejectedBooks : rejectedBooks.filter(b => b.source_photo_id !== photoId);
 const removedApprovedCount = approvedBooks.length - updatedApproved.length;
 const removedRejectedCount = rejectedBooks.length - updatedRejected.length;

 const updatedPhotos = photos.filter(photo => photo.id !== photoId);
 const bookIdsToRemove = new Set(booksToDelete.map(book => book.id));
 const updatedPending = pendingBooks.filter(book => !bookIdsToRemove.has(book.id));
 const removedBookIds = isPendingScan
 ? []
 : [
 ...approvedBooks.filter(b => b.source_photo_id === photoId).map(b => b.id),
 ...rejectedBooks.filter(b => b.source_photo_id === photoId).map(b => b.id),
 ].filter((id): id is string => !!id);

 const prevPhotos = photos;
 const prevApproved = approvedBooks;
 const prevRejected = rejectedBooks;
 const prevPending = pendingBooks;

 const fnName = isPendingScan ? 'removePendingForScan' : 'deleteLibraryPhotoAndBooks';
 const payloadSample = isPendingScan ? { scanJobId: photoToDelete.jobId, photoId } : { photoId };
 // Stamp destructive action so the merge guard knows a count-drop is expected.
 lastDestructiveActionRef.current = { actionId: `delete_${photoId.slice(0, 8)}_${Date.now()}`, reason: isPendingScan ? 'delete_pending_scan' : 'delete_library_photo', at: Date.now(), bookCount: booksToDelete.length, photoCount: 1 };
 logger.info('[DELETE_INTENT]', { photoId, jobId: photoToDelete.jobId ?? null, reason: isPendingScan ? 'pending_scan' : 'library_photo' });
 logger.debug('[PENDING_REMOVE_CALL]', JSON.stringify({
 opId,
 fn: fnName,
 payloadKeys: isPendingScan ? ['userId', 'jobId'] : ['userId', 'photoId'],
 payloadSample,
 }));

 const approvedBefore = prevApproved.length;
 const approvedAfter = updatedApproved.length;
 const pendingBefore = prevPending.length;
 const pendingAfter = updatedPending.length;
 const approvedChanged = approvedAfter - approvedBefore;
 logger.debug('[PENDING_REMOVE_RESULT_LOCAL]', JSON.stringify({
 opId,
 approvedBefore,
 approvedAfter,
 pendingBefore,
 pendingAfter,
 approvedChanged,
 }));
 if (approvedChanged !== 0) {
 const removedApproved = prevApproved.filter(a => !updatedApproved.some(u => u.id === a.id));
 logger.debug('[APPROVED_DIFF_SAMPLE]', JSON.stringify({
 opId,
 removedApprovedIdsSample: removedApproved.slice(0, 20).map(b => b.id),
 removedApprovedTitlesSample: removedApproved.slice(0, 20).map(b => b.title ?? ''),
 }));
 }

 if (selectedPhoto?.id === photoId) {
 setSelectedPhoto(null);
 closeScanModal();
 }
 setPendingBooks(updatedPending);
 setApprovedBooks(updatedApproved);
 setRejectedBooks(updatedRejected);
 setPhotos(dedupBy(updatedPhotos, photoStableKey));

 // Remove from upload queue so worker doesn't re-create the photo after deletion.
 if (user) {
   import('../lib/photoUploadQueue').then(({ removeFromQueue }) => {
     removeFromQueue(user.uid, photoId).catch(() => {});
     // Also remove by localId in case photo was canonicalized
     if (photoToDelete.localId && photoToDelete.localId !== photoId) {
       removeFromQueue(user.uid, photoToDelete.localId).catch(() => {});
     }
   });
 }

 if (!isPendingScan) {
 logger.info('[DELETE_PHOTO_LOCAL_APPLY]', {
 photoId,
 removedBooks: removedApprovedCount,
 approvedBefore: prevApproved.length,
 approvedAfter: updatedApproved.length,
 photosBefore: prevPhotos.length,
 photosAfter: updatedPhotos.length,
 });
 }

 const rollback = () => {
 setPendingBooks(prevPending);
 setApprovedBooks(prevApproved);
 setRejectedBooks(prevRejected);
 setPhotos(dedupBy(prevPhotos, photoStableKey));
 };

 if (user) {
 if (isPendingScan && photoToDelete.jobId) {
   const pendingIds = booksToDelete.map(b => b.id).filter((id): id is string => !!id);
   const pendingStableKeys = booksToDelete.map(b => getPendingStableKeyScoped(b)).filter(Boolean);
   // Tombstone by BOTH UUID and stable key — stable key covers local-only books with no UUID.
   // Write both immediately so sync doesn't resurrect the deleted books on next rehydrate.
   await Promise.all([
     pendingIds.length > 0 ? addDeletedBookIdsTombstone(user.uid, pendingIds) : Promise.resolve(),
     pendingStableKeys.length > 0 ? addDeletedPendingStableKeysTombstone(user.uid, pendingStableKeys) : Promise.resolve(),
   ]);
   const result = await deletePendingScanOnly(user.uid, { jobId: canonicalJobId(photoToDelete.jobId) ?? photoToDelete.jobId ?? undefined, pendingBookIds: pendingIds });
 logger.info('[DELETE_RESULT]', { photoId, deletedPhotosCount: 0, deletedBooksCount: pendingIds.length, deletedStorageKeysCount: 0 });
 if (!result.ok) {
 rollback();
 Alert.alert('Error', result.error ?? 'Failed to delete scan. Please try again.');
 return;
 }
    } else if (!isPendingScan) {
      // Completed scan: ask the user whether to also delete the books.
      const imageHash = typeof photoToDelete.photoFingerprint === 'string' && photoToDelete.photoFingerprint.trim() ? photoToDelete.photoFingerprint.trim() : undefined;
      const approvedCount = booksToDelete.filter(b => (b as any).status === 'approved').length;
      const hasApproved = approvedCount > 0;
      const bookLabel = approvedCount === 1 ? 'book' : 'books';

      const doCascadeDelete = async (cascadeBooks: boolean) => {
        const result = await deleteLibraryPhotoAndBooks(user.uid, photoId, cascadeBooks, true, imageHash, 'ScansTab', approvedCount);
        if (!result.ok) {
          rollback();
          Alert.alert('Error', 'Failed to delete scan. Please try again.');
          return;
        }
        if (cascadeBooks) {
          await addDeletedBookIdsTombstone(user.uid, removedBookIds);
        }
        // Continue with AsyncStorage cleanup below by resolving the outer flow
      };

      if (hasApproved) {
        // Show choice — must await user response before continuing
        await new Promise<void>(resolve => {
          Alert.alert(
            'Delete scan photo',
            `This scan has ${approvedCount} approved ${bookLabel} in your library.`,
            [
              {
                text: 'Cancel',
                style: 'cancel',
                onPress: () => { rollback(); resolve(); },
              },
              {
                text: 'Photo Only',
                onPress: async () => { await doCascadeDelete(false); resolve(); },
              },
              {
                text: `Photo + ${bookLabel}`,
                style: 'destructive',
                onPress: async () => { await doCascadeDelete(true); resolve(); },
              },
            ]
          );
        });
        return; // AsyncStorage writes handled inside doCascadeDelete + rollback
      } else {
        // No approved books — safe to delete photo with default detach
        await doCascadeDelete(false);
      }
    }

 const userPendingKey = `pending_books_${user.uid}`;
 const userApprovedKey = `approved_books_${user.uid}`;
 const userRejectedKey = `rejected_books_${user.uid}`;
 const userPhotosKey = `photos_${user.uid}`;
 const deletedIdsKey = `deleted_photo_ids_${user.uid}`;
 let tombstoneIds: string[] = [];
 try {
 const saved = await AsyncStorage.getItem(deletedIdsKey);
 tombstoneIds = saved ? JSON.parse(saved) : [];
 } catch (_) { /* ignore */ }
 if (!tombstoneIds.includes(photoId)) tombstoneIds.push(photoId);
 await Promise.all([
 AsyncStorage.setItem(userPendingKey, JSON.stringify(updatedPending)),
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(ensureApprovedOnePerBookKey(updatedApproved))),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(updatedRejected)),
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos)),
 AsyncStorage.setItem(deletedIdsKey, JSON.stringify(tombstoneIds)),
 ]);
 if (!isPendingScan) {
 for (const book of booksToDelete) {
 await deleteBookFromSupabase(user.uid, book).catch(() => {});
 }
 }
 }

 await saveUserData(updatedPending, updatedApproved, updatedRejected, updatedPhotos);
 const deletedPendingCount = booksToDelete.length;
 const totalRemoved = deletedPendingCount + removedApprovedCount + removedRejectedCount;
 const _undoAction = lastDestructiveActionRef.current;
 const isPendingOnlyDelete = _undoAction?.reason === 'delete_pending_scan';
 if (!isPendingOnlyDelete && _undoAction && (_undoAction.bookIds?.length || _undoAction.photoIds?.length)) {
   const undoLabel = totalRemoved > 0
     ? `Deleted scan + ${totalRemoved} book${totalRemoved !== 1 ? 's' : ''}`
     : 'Deleted scan';
   showUndoToast(undoLabel, _undoAction);
 } else {
   const message = totalRemoved > 0
     ? `Scan deleted. ${totalRemoved} book${totalRemoved !== 1 ? 's' : ''} removed from your library.`
     : 'Scan deleted.';
   Alert.alert('Scan Deleted', message);
 }
 } catch (error) {
 logger.error('Error deleting scan:', error);
 Alert.alert('Error', 'Failed to delete scan. Please try again.');
 }
 };

 const toggleBookSelection = useCallback((bookId: string) => {
   if (selectAllMode) {
     setExcludedIds(prev => {
       const next = new Set(prev);
       if (next.has(bookId)) next.delete(bookId);
       else next.add(bookId);
       return next;
     });
   } else {
     setSelectedBooks(prev => {
       const newSelected = new Set(prev);
       if (newSelected.has(bookId)) newSelected.delete(bookId);
       else newSelected.add(bookId);
       return newSelected;
     });
   }
 }, [selectAllMode]);
 const toggleBookSelectionRef = useRef(toggleBookSelection);
 toggleBookSelectionRef.current = toggleBookSelection;

 const selectAllBooks = useCallback(() => {
   const tapAt = Date.now();
   const selectedCount = pendingBooks.filter(b => b.status !== 'incomplete').length;
   perfLog('select_all', 'tap', { tapAt, selectedCount });
   // Defer so tap responds immediately; bulk selection runs after interactions.
   InteractionManager.runAfterInteractions(() => {
     setSelectAllMode(true);
     setExcludedIds(new Set());
     setSelectedBooks(new Set());
     const stateCommittedAt = Date.now();
     perfLog('select_all', 'state_committed', { stateCommittedAt, selectedCount });
     requestAnimationFrame(() => {
       requestAnimationFrame(() => {
         perfLog('select_all', 'list_rendered', { listRenderedAt: Date.now(), selectedCount });
       });
     });
   });
 }, [pendingBooks]);

 const addAllBooks = async () => {
 if (isApprovingRef.current || isApproving || isClearInProgress()) return;
 if (user && isGuestUser(user)) {
 setShowAuthGateModal(true);
 return;
 }
 
 // Only approve books from THIS scan job (selected photo). When the same bookcase was scanned multiple times,
 // dedupe merges them into one photo; approving must only add books from the current scan, not all merged jobs.
 const selectedJobRaw = selectedPhoto?.jobId ? toRawScanJobUuid(selectedPhoto.jobId) ?? undefined : undefined;
 const bookBelongsToSelectedJob = (book: Book) => {
 if (!selectedJobRaw) return true;
 const bookRaw = toRawScanJobUuid((book as any).source_scan_job_id ?? '') ?? (book as any).source_scan_job_id ?? '';
 return !!bookRaw && bookRaw === selectedJobRaw;
 };
 const booksToApprove = pendingBooks.filter(book => book.status !== 'incomplete' && bookBelongsToSelectedJob(book));

 if (booksToApprove.length === 0) {
 Alert.alert('No Books', 'There are no books to add from this scan (excluding incomplete books).');
 return;
 }

 // Provenance lives on each pending book (set at creation); only fall back to selectedPhoto for old data.
 const approvedBooksData = booksToApprove.map(book => {
 const originPhotoId = (book as any).source_photo_id ?? selectedPhoto?.id;
 const originScanJobId = (book as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
 return {
 ...book,
 status: 'approved' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 };
 });
 const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved(
 approvedBooksData,
 selectedPhoto?.jobId
 );
 // Pending = all books we did not approve, minus any from closed jobs (stops zombie pending).
 const remainingPending = pendingBooks
 .filter(book => !booksToApprove.some(b => b.id === book.id))
 .filter(b => {
 const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
 return !raw || !closedJobIdsRaw.has(raw);
 });
 const updatedApproved = deduplicateBooks(approvedBooks, approvedBooksData);
 const addedCount = updatedApproved.length - approvedBooks.length;
 lastLocalMutationAtRef.current = Date.now();
 // Optimistic: update local books[] immediately so pending disappears from UI and profile shows approved.
 const prevPending = pendingBooks;
 const prevApproved = approvedBooks;
 setPendingBooks(remainingPending);
 setApprovedBooks(updatedApproved);
 clearSelection();
 try {
 await saveUserData(remainingPending, updatedApproved, rejectedBooks, photos, {
 photoIdForApproved: selectedPhoto?.id,
 photoIdsForApproved: Array.from(
 new Set(
 approvedBooksData
 .map((b) => (b as any).source_photo_id)
 .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
 )
 ),
 scanJobIdForApproved: selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined,
 batchIdForApproved: (selectedPhoto as any)?.batchId ?? activeBatch?.batchId ?? undefined,
 jobIdsToClose,
 source: 'scan',
 });
 Alert.alert('Success', `Added ${addedCount} book${addedCount !== 1 ? 's' : ''} to your library!`);
 } catch (err) {
 setPendingBooks(prevPending);
 setApprovedBooks(prevApproved);
 Alert.alert(
 'Approve failed',
 (err as Error)?.message ?? 'Could not save to library. Please retry. Nothing was changed.'
 );
 }
 };

 const unselectAllBooks = useCallback(() => {
   setSelectAllMode(false);
   setExcludedIds(new Set());
   setSelectedBooks(new Set());
 }, []);

 const clearAllBooks = useCallback(async () => {
 // Remove all pending books (including incomplete ones)
 setPendingBooks([]);
 clearSelection();

 // Remove photos that only had pending/incomplete books (no approved books).
 // Photos with approved books keep their approved books; others are fully removed.
 const updatedPhotos = photos
   .map(photo => {
     const approvedOnly = photo.books.filter(book => book.status === 'approved');
     if (approvedOnly.length > 0) return { ...photo, books: approvedOnly };
     return null; // Photo has no approved books — remove entirely
   })
   .filter((p): p is Photo => p !== null);

 // Remove cleared photos from the upload queue so badges don't persist.
 const removedPhotoIds = photos
   .filter(p => !updatedPhotos.some(u => u.id === p.id))
   .map(p => p.id)
   .filter((id): id is string => !!id);
 if (user && removedPhotoIds.length > 0) {
   import('../lib/photoUploadQueue').then(({ removeFromQueue }) => {
     for (const id of removedPhotoIds) {
       removeFromQueue(user.uid, id).catch(() => {});
     }
   });
 }

 setPhotos(dedupBy(updatedPhotos, photoStableKey));

 // Don't await - run in background
 saveUserData([], approvedBooks, rejectedBooks, updatedPhotos).catch(error => {
 logger.error('Error saving user data:', error);
 });
 }, [approvedBooks, rejectedBooks, photos, clearSelection, user]);

 const clearSelectedBooks = async () => {
 const removedBooks = pendingBooks.filter(book => isBookSelected(pendingBookStableKey(book)));
 const remainingBooks = pendingBooks.filter(book => !isBookSelected(pendingBookStableKey(book)));
 setPendingBooks(remainingBooks);
 clearSelection();

 // Remove photos whose pending books were ALL cleared and have no approved books.
 const removedPhotoIds = new Set(removedBooks.map(b => b.source_photo_id).filter(Boolean));
 const remainingPhotoIds = new Set(remainingBooks.map(b => b.source_photo_id).filter(Boolean));
 const approvedPhotoIds = new Set(approvedBooks.map(b => b.source_photo_id).filter(Boolean));
 const photosToRemove = [...removedPhotoIds].filter(id => !remainingPhotoIds.has(id) && !approvedPhotoIds.has(id));
 const updatedPhotos = photosToRemove.length > 0
   ? photos.filter(p => !photosToRemove.includes(p.id ?? ''))
   : photos;

 // Clean upload queue for removed photos.
 if (user && photosToRemove.length > 0) {
   import('../lib/photoUploadQueue').then(({ removeFromQueue }) => {
     for (const id of photosToRemove) {
       if (id) removeFromQueue(user.uid, id).catch(() => {});
     }
   });
 }

 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 await saveUserData(remainingBooks, approvedBooks, rejectedBooks, updatedPhotos);
 };

 // Helper to merge books from Supabase with existing state
 // Preserves all books - prefers Supabase data when there's a match, keeps local-only books
 const mergeBooks = (existingBooks: Book[], supabaseBooks: Book[]): Book[] => {
 // Create a map of existing books by ID and by title+author (for matching)
 const existingById = new Map<string, Book>();
 const existingByKey = new Map<string, Book>();
 
 existingBooks.forEach(book => {
 if (book.id) {
 existingById.set(book.id, book);
 }
 // Also index by title+author for matching books that might have different IDs
 const key = `${book.title}|${book.author || ''}`;
 if (!existingByKey.has(key)) {
 existingByKey.set(key, book);
 }
 });
 
 // Create a set of all matched keys/IDs
 const matched = new Set<string>();
 
 // Start with Supabase books (prefer Supabase data as source of truth)
 const merged: Book[] = supabaseBooks.map(supabaseBook => {
 const key = `${supabaseBook.title}|${supabaseBook.author || ''}`;
 
 // Try to match by ID first
 if (supabaseBook.id && existingById.has(supabaseBook.id)) {
 matched.add(supabaseBook.id);
 // Use Supabase data (it's more up-to-date) but preserve the ID
 return { ...supabaseBook, id: supabaseBook.id };
 }
 
 // Try to match by title+author
 if (existingByKey.has(key)) {
 const existing = existingByKey.get(key)!;
 matched.add(existing.id || key);
 // Use Supabase data but preserve the existing ID if it exists
 return { ...supabaseBook, id: existing.id || supabaseBook.id };
 }
 
 // New book from Supabase
 return supabaseBook;
 });
 
 // Add existing books that weren't matched (local-only books)
 existingBooks.forEach(book => {
 const key = `${book.title}|${book.author || ''}`;
 if (!matched.has(book.id || key)) {
 merged.push(book);
 }
 });
 
 return merged;
 };

 // Helper to deduplicate books when adding to library
 const deduplicateBooks = (existingBooks: Book[], newBooks: Book[]): Book[] => {
 const normalize = (s?: string) => {
 if (!s) return '';
 return s.trim()
 .toLowerCase()
 .replace(/[.,;:!?]/g, '')
 .replace(/\s+/g, ' ');
 };
 
 const normalizeTitle = (title?: string) => {
 return normalize(title).replace(/^(the|a|an)\s+/, '').trim();
 };
 
 const normalizeAuthor = (author?: string) => {
 return normalize(author).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
 };
 
 const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
 
 // Create a map of existing books by normalized key
 const existingMap = new Map<string, Book>();
 for (const book of existingBooks) {
 const key = makeKey(book);
 if (!existingMap.has(key)) {
 existingMap.set(key, book);
 }
 }
 
 // Filter out new books that already exist (also deduplicates within newBooks itself)
 const uniqueNewBooks = newBooks.filter(book => {
 const key = makeKey(book);
 if (existingMap.has(key)) return false;
 existingMap.set(key, book); // prevent within-newBooks duplicates
 return true;
 });
 
 return [...existingBooks, ...uniqueNewBooks];
 };

/**
 * flushScanQueue: wait for server jobs whose books are in the approve payload to reach
 * terminal status before approve proceeds. Transient stages (saving, validating,
 * openai_hedge, etc.) are actively writing book rows; racing them risks FK failures or
 * stale upserts.
 *
 * Key change: only wait for jobs that appear in approveJobIds (the set of
 * source_scan_job_ids on the books being approved). Jobs for OTHER scans that are still
 * running are irrelevant — waiting for them added ~1–2 s of dead time even when the
 * selected scan was already complete.
 *
 * Strategy: poll /api/sync-scans up to maxWaitMs. If all relevant jobs are terminal,
 * resolve immediately. If they don't drain in time, resolve anyway with a warning —
 * approve will still run the barrier check and fail cleanly rather than silently writing
 * bad data.
 */
const flushScanQueue = useCallback(async (
  approveJobIds: Set<string>,
): Promise<{ flushed: boolean; remainingJobs: string[] }> => {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl || !user?.uid || isGuestUser(user)) {
    return { flushed: true, remainingJobs: [] };
  }
  // Transient stages: the server is actively writing book rows. Terminal = done.
  const TRANSIENT_STAGES = new Set(['saving', 'validating', 'openai_hedge', 'starting', 'scanning']);
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'closed']);
  const maxWaitMs = 8000;
  const pollIntervalMs = 800;
  const t0 = Date.now();
  let remainingJobs: string[] = [];
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const { getScanAuthHeaders: _getScanAuthHeaders3 } = await import('../lib/authHeaders');
      const _pollHeaders = await _getScanAuthHeaders3();
      const res = await fetch(`${baseUrl}/api/sync-scans?active=1`, { headers: _pollHeaders });
      if (!res.ok) break;
      const data = await res.json() as { jobs?: Array<{ jobId?: string; id?: string; status?: string; stage?: string }> };
      const jobs = data?.jobs ?? [];
      // Only care about jobs whose books are in the approve payload.
      // Match full server jobId (UUID) against approveJobIds (full UUID or short prefix from books).
      const relevant = approveJobIds.size > 0
        ? jobs.filter(j => {
            const rawId = (j.jobId ?? j.id ?? '').replace(/^job_/, '');
            if (!rawId) return false;
            if (approveJobIds.has(rawId)) return true;
            for (const aid of approveJobIds) {
              if (rawId.startsWith(aid) || aid.startsWith(rawId)) return true;
            }
            return false;
          })
        : [];
      const transient = relevant.filter(j => {
        if (TERMINAL_STATUSES.has(j.status ?? '')) return false;
        if (TRANSIENT_STAGES.has(j.stage ?? '')) return true;
        return j.status === 'processing' || j.status === 'pending';
      });
      remainingJobs = transient.map(j => (j.jobId ?? j.id ?? '').slice(0, 8));
      if (transient.length === 0) {
        logger.info('[FLUSH_SCAN_QUEUE]', 'relevant jobs drained before approve', {
          elapsedMs: Date.now() - t0,
          approveJobIdsCount: approveJobIds.size,
          totalServerJobs: jobs.length,
          relevantChecked: relevant.length,
        });
        return { flushed: true, remainingJobs: [] };
      }
      logger.debug('[FLUSH_SCAN_QUEUE]', 'waiting for relevant transient jobs', {
        count: transient.length,
        stages: transient.map(j => j.stage),
        elapsedMs: Date.now() - t0,
      });
    } catch {
      break; // Network error — don't block approve
    }
    await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
  }
  logger.warn('[FLUSH_SCAN_QUEUE]', 'timed out waiting for relevant jobs; proceeding with barrier protection', {
    remainingJobs,
    waitedMs: Date.now() - t0,
  });
  return { flushed: false, remainingJobs };
}, [user]);

const approveSelectedBooks = useCallback(async () => {
  if (approveInProgress || isApprovingRef.current || isApproving || isClearInProgress()) return;
  if (user && isGuestUser(user)) {
    setShowAuthGateModal(true);
    return;
  }

  setApproveError(null);

  const currentSelected = selectAllMode ? new Set(completableKeys.filter(k => !excludedIds.has(k))) : selectedBooks;
  const selectedBookObjs = pendingBooks.filter(book => currentSelected.has(pendingBookStableKey(book)));
  const prevPending = pendingBooks;
  const prevApproved = approvedBooks;
  const prevSelected = new Set(currentSelected);

  logger.info('[APPROVE_CLICK]', {
    selectedKeys: currentSelected.size,
    selectedBookObjs: selectedBookObjs.length,
    selectedDbIds: selectedBookObjs.map(b => (b as any).dbId ?? b.id ?? null),
    selectedBookKeys: selectedBookObjs.map(b => (b as any).book_key ?? null),
    selectedStableKeys: selectedBookObjs.map(b => pendingBookStableKey(b)),
    missingDbId: selectedBookObjs.filter(b => !(b as any).dbId && !b.id).length,
    sourcePhotoIds: [...new Set(selectedBookObjs.map(b => (b as any).source_photo_id ?? null).filter(Boolean))],
  });

  // Use full UUIDs for job matching when available (toRawScanJobUuid returns null for short prefixes).
  const _approveJobIdsRaw = new Set(
    selectedBookObjs
      .map(b => (b as any).source_scan_job_id as string | undefined)
      .filter((id): id is string => Boolean(id))
  );
  const _approveJobIds = new Set<string>();
  _approveJobIdsRaw.forEach((id) => {
    const full = toRawScanJobUuid(id);
    if (full) _approveJobIds.add(full);
    else _approveJobIds.add(id);
  });
  logger.info('[APPROVE_PHASE0]', 'starting flush in background (scoped to payload jobs)', {
    approveJobIdsCount: _approveJobIds.size,
    approveJobIdsSample: [..._approveJobIds].slice(0, 3).map(id => id.slice(0, 8)),
    selectedBooksCount: selectedBookObjs.length,
  });

  // ── PHASE 1: Build approve payload ────────────────────────────────────────
  const newApprovedBooks = selectedBookObjs.map(book => {
    const originPhotoId = (book as any).source_photo_id ?? selectedPhoto?.id;
    const originScanJobId = (book as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
    return {
      ...book,
      status: 'approved' as const,
      ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
      ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
    };
  });
  const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved(newApprovedBooks, selectedPhoto?.jobId);
  const remainingBooks = pendingBooks
    .filter(book => !currentSelected.has(pendingBookStableKey(book)))
    .filter(b => {
      const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
      return !raw || !closedJobIdsRaw.has(raw);
    });
  const updatedApproved = deduplicateBooks(approvedBooks, newApprovedBooks);

  const saveOptions = {
    photoIdForApproved: selectedPhoto?.id,
    photoIdsForApproved: Array.from(
      new Set(
        newApprovedBooks
          .map((b) => (b as any).source_photo_id)
          .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      )
    ),
    scanJobIdForApproved: selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined,
    batchIdForApproved: (selectedPhoto as any)?.batchId ?? activeBatch?.batchId ?? undefined,
    jobIdsToClose,
    source: 'scan' as const,
    runInBackground: true as const,
  };

  // ── Optimistic update: apply immediately so tap returns in <300ms ───────────
  lastLocalMutationAtRef.current = Date.now();
  const userApprovedKey = `approved_books_${user!.uid}`;
  const userPendingKey = `pending_books_${user!.uid}`;
  const userRejectedKey = `rejected_books_${user!.uid}`;
  // Persist by book ID: do not collapse by book_key. User selected N books → N must stay approved (one row per photo).
  const selectedDbIds = selectedBookObjs
    .map((b) => (b as any).dbId ?? b.id ?? null)
    .filter((id): id is string => Boolean(id) && /^[0-9a-f-]{36}$/i.test(id));
  const action_id = `approve_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (selectedDbIds.length > 0) {
    import('../lib/approveMutationsOutbox').then(({ addApproveMutation }) =>
      addApproveMutation(user!.uid, { action_id, book_ids: selectedDbIds }).catch(() => {})
    );
  }
  const applyOptimistic = () => {
    const now = Date.now();
    const APPROVAL_GRACE_MS = 15000;
    lastApprovedAtRef.current = now;
    approvalGraceUntilRef.current = now + APPROVAL_GRACE_MS;
    setLastApprovedAt(now);

    setPendingBooks(remainingBooks);
    setApprovedBooks(updatedApproved);

    const approvedCountByPhotoId = updatedApproved.reduce<Record<string, number>>((acc, b) => {
      const pid = (b as any).source_photo_id ?? (b as any).sourcePhotoId ?? (b as any).photoId;
      if (pid) acc[pid] = (acc[pid] ?? 0) + 1;
      return acc;
    }, {});
    setPhotos((prev) =>
      prev.map((p) => {
        const count = p.id ? approvedCountByPhotoId[p.id] : undefined;
        if (count == null) return p;
        return {
          ...p,
          approved_count: count,
          ...(p.status === 'draft' && (p as any).storage_path ? { status: 'complete' as const } : {}),
        };
      })
    );

    clearSelection();
    // Pass approved books directly so counts update instantly (don't wait for AsyncStorage write).
    refreshProfileStats(updatedApproved);

    Promise.all([
      AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedApproved)),
      AsyncStorage.setItem(userPendingKey, JSON.stringify(remainingBooks)),
      AsyncStorage.setItem(userRejectedKey, JSON.stringify(rejectedBooks)),
    ]).catch(() => {});

    const approvedCountsByPhotoIdSample: Record<string, number> = {};
    updatedApproved.forEach((b) => {
      const pid = (b as any).source_photo_id ?? (b as any).sourcePhotoId ?? (b as any).photoId;
      if (pid) {
        // Join/key rule: use full UUID only; never slice(0, 8) as key.
        const key = canon(pid);
        approvedCountsByPhotoIdSample[key] = (approvedCountsByPhotoIdSample[key] ?? 0) + 1;
      }
    });
    logger.info('[APPROVE_VERIFY]', 'after optimistic', {
      selectedCount: selectedBookObjs.length,
      approvedCountAfter: updatedApproved.length,
      pendingCountAfter: remainingBooks.length,
      approvedCountsByPhotoIdSample: Object.keys(approvedCountsByPhotoIdSample).length ? approvedCountsByPhotoIdSample : undefined,
    });

    setTimeout(() => {
      approvalGraceUntilRef.current = 0;
      triggerDataRefreshRef.current?.();
    }, APPROVAL_GRACE_MS);
  };
  if (selectedBookObjs.length >= 50) {
    InteractionManager.runAfterInteractions(() => applyOptimistic());
  } else {
    applyOptimistic();
  }

  setApproveInProgress(true);

  // Enqueue approve job and return immediately; worker continues when user navigates away.
  void (async () => {
    try {
      const { flushed, remainingJobs } = await flushScanQueue(_approveJobIds);
      if (!flushed && remainingJobs.length > 0) {
        logger.warn('[APPROVE_PHASE0]', 'relevant jobs not fully drained; proceeding with barrier protection', { remainingJobs });
      } else {
        logger.info('[APPROVE_PHASE0]', 'relevant jobs clear');
      }
      const { addApproveJob } = await import('../lib/approveQueue');
      const payload = {
        newPending: remainingBooks,
        newApproved: updatedApproved,
        newRejected: rejectedBooks,
        newPhotos: photos,
        options: {
          action_id,
          selectedDbIds: selectedDbIds.length > 0 ? selectedDbIds : undefined,
          photoIdForApproved: saveOptions.photoIdForApproved,
          photoIdsForApproved: saveOptions.photoIdsForApproved,
          scanJobIdForApproved: saveOptions.scanJobIdForApproved,
          jobIdsToClose: saveOptions.jobIdsToClose,
        },
      };
      await addApproveJob(user!.uid, payload);
      setApproveInProgress(false);
      setApproveError(null);
      triggerDataRefreshRef.current?.();
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Could not save. Please retry.';
      logger.error('[APPROVE_FAILURE]', 'approve pipeline threw; reverting optimistic update', { msg });
      setPendingBooks(prevPending);
      setApprovedBooks(prevApproved);
      setSelectAllMode(false);
      setExcludedIds(new Set());
      setSelectedBooks(prevSelected);
      setApproveInProgress(false);
      setApproveError(msg);
    }
  })();
}, [pendingBooks, approvedBooks, rejectedBooks, photos, selectAllMode, excludedIds, selectedBooks, completableKeys, selectedPhoto, user, navigation, isApproving, approveInProgress, pendingBookStableKey, flushScanQueue, activeBatch?.batchId, clearSelection]);

 // Check for pending actions after login and complete them
const checkAndCompletePendingActions = useCallback(async () => {
  // Capture generation at entry; if the user cancels while we are mid-approve we bail out.
  const genOk = captureGen();
  try {
    const pendingActionData = await AsyncStorage.getItem(PENDING_APPROVE_ACTION_KEY);
    if (!pendingActionData) return;
    if (!genOk()) { logger.info('[PENDING_ACTION] skipped (cancelled during storage read)'); return; }

    const pendingAction = JSON.parse(pendingActionData);

    // Only complete if user is now authenticated (not guest)
    if (!user || isGuestUser(user)) return;
 
 logger.debug(' User logged in, completing pending action:', pendingAction.type);
 
 if (pendingAction.type === 'approve_book') {
 const bookToApprove = pendingBooks.find(book => book.id === pendingAction.bookId);
 if (bookToApprove) {
 const originPhotoId = (bookToApprove as any).source_photo_id ?? selectedPhoto?.id;
 const originScanJobId = (bookToApprove as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
 const approvedBook: Book = {
 ...bookToApprove,
 status: 'approved' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 };
 const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved([approvedBook], selectedPhoto?.jobId);
 const updatedPending = pendingBooks
 .filter(book => book.id !== pendingAction.bookId)
 .filter(b => {
 const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
 return !raw || !closedJobIdsRaw.has(raw);
 });
 const updatedApproved = deduplicateBooks(approvedBooks, [approvedBook]);
 lastLocalMutationAtRef.current = Date.now();
 if (!genOk()) { logger.info('[PENDING_ACTION] skipped (cancelled)'); return; }
 setPendingBooks(updatedPending);
 setApprovedBooks(updatedApproved);
 try {
 await saveUserData(updatedPending, updatedApproved, rejectedBooks, photos, {
 photoIdForApproved: selectedPhoto?.id,
 photoIdsForApproved: Array.from(
 new Set(
 [approvedBook]
 .map((b) => (b as any).source_photo_id)
 .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
 )
 ),
      scanJobIdForApproved: selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined,
        batchIdForApproved: (selectedPhoto as any)?.batchId ?? activeBatch?.batchId ?? undefined,
        jobIdsToClose,
        source: 'scan',
      });
      } catch (e) {
        logger.warn('Approve (pending action) failed:', (e as Error)?.message);
        setPendingBooks(pendingBooks);
        setApprovedBooks(approvedBooks);
      }
    }
  } else if (pendingAction.type === 'approve_selected') {
 const selectedBookObjs = pendingBooks.filter(book => pendingAction.bookIds.includes(book.id));
 const newApprovedBooks = selectedBookObjs.map(book => {
 const originPhotoId = (book as any).source_photo_id ?? selectedPhoto?.id;
 const originScanJobId = (book as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
 return {
 ...book,
 status: 'approved' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 };
 });
 const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved(newApprovedBooks, selectedPhoto?.jobId);
 const remainingBooks = pendingBooks
 .filter(book => !pendingAction.bookIds.includes(book.id))
 .filter(b => {
 const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
 return !raw || !closedJobIdsRaw.has(raw);
 });
 const updatedApproved = deduplicateBooks(approvedBooks, newApprovedBooks);
 lastLocalMutationAtRef.current = Date.now();
 if (!genOk()) { logger.info('[PENDING_ACTION] skipped (cancelled)'); return; }
 setPendingBooks(remainingBooks);
 setApprovedBooks(updatedApproved);
 clearSelection();
 try {
 await saveUserData(remainingBooks, updatedApproved, rejectedBooks, photos, {
 photoIdForApproved: selectedPhoto?.id,
 photoIdsForApproved: Array.from(
 new Set(
 newApprovedBooks
 .map((b) => (b as any).source_photo_id)
 .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
 )
 ),
 scanJobIdForApproved: selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined,
 batchIdForApproved: (selectedPhoto as any)?.batchId ?? activeBatch?.batchId ?? undefined,
 jobIdsToClose,
        source: 'scan',
      });
      } catch (e) {
        logger.warn('Approve selected (pending action) failed:', (e as Error)?.message);
        setPendingBooks(pendingBooks);
        setApprovedBooks(approvedBooks);
      }
  } else if (pendingAction.type === 'approve_all') {
 const booksToApprove = pendingBooks.filter(book => book.status !== 'incomplete');
 if (booksToApprove.length > 0) {
 const approvedBooksData = booksToApprove.map(book => {
 const originPhotoId = (book as any).source_photo_id ?? selectedPhoto?.id;
 const originScanJobId = (book as any).source_scan_job_id ?? (selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined);
 return {
 ...book,
 status: 'approved' as const,
 ...(originPhotoId ? { source_photo_id: originPhotoId } : {}),
 ...(originScanJobId ? { source_scan_job_id: originScanJobId } : {}),
 };
 });
 const { jobIdsToClose, closedJobIdsRaw } = getJobIdsToCloseFromApproved(approvedBooksData, selectedPhoto?.jobId);
 const remainingPending = pendingBooks
 .filter(book => book.status === 'incomplete')
 .filter(b => {
 const raw = toRawScanJobUuid((b as any).source_scan_job_id ?? '') ?? (b as any).source_scan_job_id ?? '';
 return !raw || !closedJobIdsRaw.has(raw);
 });
 const updatedApproved = deduplicateBooks(approvedBooks, approvedBooksData);
 lastLocalMutationAtRef.current = Date.now();
 if (!genOk()) { logger.info('[PENDING_ACTION] skipped (cancelled)'); return; }
 setApprovedBooks(updatedApproved);
 setPendingBooks(remainingPending);
 clearSelection();
 try {
 await saveUserData(remainingPending, updatedApproved, rejectedBooks, photos, {
 photoIdForApproved: selectedPhoto?.id,
 photoIdsForApproved: Array.from(
 new Set(
 approvedBooksData
 .map((b) => (b as any).source_photo_id)
 .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
 )
 ),
 scanJobIdForApproved: selectedPhoto?.jobId ? (toRawScanJobUuid(selectedPhoto.jobId) ?? undefined) : undefined,
 batchIdForApproved: (selectedPhoto as any)?.batchId ?? activeBatch?.batchId ?? undefined,
        jobIdsToClose,
        source: 'scan',
      });
      } catch (e) {
        logger.warn('Approve all (pending action) failed:', (e as Error)?.message);
        setApprovedBooks(approvedBooks);
        setPendingBooks(pendingBooks);
      }
    }
  }

  // Clear the pending action
  await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY);
 
 // Navigate back to Scans tab to show the result
 navigation.navigate('Scans' as never);
 } catch (error) {
 logger.error('Error completing pending action:', error);
 }
 }, [user, pendingBooks, approvedBooks, rejectedBooks, photos, navigation, deduplicateBooks, saveUserData]);

 useEffect(() => {
 checkAndCompletePendingActionsRef.current = checkAndCompletePendingActions;
 }, [checkAndCompletePendingActions]);

 // Edit functions for pending books
const handleRemoveCover = useCallback(async (bookId: string) => {
if (!user) return;

// bookId is a stable key (from pendingBookStableKey / selectedId)
const bookToUpdate = pendingBooks.find(book => pendingBookStableKey(book) === bookId);
if (!bookToUpdate) return;

const updatedBook: Book = {
...bookToUpdate,
coverUrl: undefined,
localCoverPath: undefined,
googleBooksId: undefined,
};

// Update in pending books
const updatedPending = pendingBooks.map(book =>
pendingBookStableKey(book) === bookId ? updatedBook : book
);
setPendingBooks(updatedPending);

// Update in photos
const updatedPhotos = photos.map(photo => ({
...photo,
books: photo.books.map(book =>
pendingBookStableKey(book) === bookId ? updatedBook : book
),
}));
 setPhotos(dedupBy(updatedPhotos, photoStableKey));

 // Save to Supabase; include provenance so approved books stay cascade-deletable
 const saveOptions = session?.access_token
 ? {
 apiBaseUrl: getApiBaseUrl(),
 accessToken: session.access_token,
 sourcePhotoId: (updatedBook as any).source_photo_id,
 sourceScanJobId: (updatedBook as any).source_scan_job_id,
 }
 : undefined;
 await saveBookToSupabase(user.uid, updatedBook, updatedBook.status ?? 'approved', saveOptions);
 await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

 // Clear selection and close edit mode
 clearSelection();

 // Cover removed silently (no popup)
 }, [pendingBooks, photos, approvedBooks, rejectedBooks, user]);

const handleSwitchCovers = useCallback(async (bookId: string) => {
// bookId is a stable key (from pendingBookStableKey / selectedId); must not use book.id for lookup
const bookToUpdate = pendingBooks.find(book => pendingBookStableKey(book) === bookId);
if (!bookToUpdate) {
  logger.warn('[SWITCH_COVERS_GUARD]', 'book not found for bookId', { bookId: bookId?.slice(0, 12) });
  Alert.alert('Not ready', 'Could not find the selected book. Try tapping it again.');
  return;
}
if (!postApproveIdsSettled) {
  logger.info('[SWITCH_COVERS_GUARD]', 'post-approve refresh not yet settled', { bookId: bookId?.slice(0, 12) });
  return;
}
if (!(bookToUpdate as any).source_photo_id) {
  logger.info('[SWITCH_COVERS_GUARD]', 'source_photo_id not yet set — book still syncing', {
    bookId: bookId?.slice(0, 12),
    bookTitle: bookToUpdate.title?.slice(0, 30),
  });
  return;
}

 setShowSwitchCoversModal(true);
 setIsLoadingCovers(true);
 setCoverSearchResults([]);

 try {
 logger.debug(` Searching for covers: "${bookToUpdate.title}" by ${bookToUpdate.author || 'unknown'}`);
 
 // Search for multiple books - try with author first, then without if needed
 let results = await searchMultipleBooks(bookToUpdate.title, bookToUpdate.author, 20);
 
 // If no results with author, try without author (broader search)
 if (results.length === 0 && bookToUpdate.author) {
 logger.debug(` No results with author, trying without author...`);
 results = await searchMultipleBooks(bookToUpdate.title, undefined, 20);
 }
 
 logger.debug(` Found ${results.length} total results`);
 
 // Filter to only show results with covers and googleBooksId
 const resultsWithCovers = results.filter(r => r.coverUrl && r.googleBooksId);
 logger.debug(` Found ${resultsWithCovers.length} results with covers`);
 
 // Only show alerts if we truly have no results at all
 // If we have results but no covers, still show them (user can see what's available)
 if (results.length === 0) {
 Alert.alert(
 'No Results',
 'No books found. Try searching with a different title or author.',
 [{ text: 'OK' }]
 );
 } else if (resultsWithCovers.length === 0) {
 // If we have results but no covers, log a warning but don't show alert
 // The user will see an empty list which is better than a blocking alert
 logger.warn(` Found ${results.length} results but none have covers`);
 }
 
 // Always set results (even if empty) so modal can show the current book
 setCoverSearchResults(
 resultsWithCovers
 .filter((r): r is typeof r & { googleBooksId: string } => Boolean(r.googleBooksId))
 .map(r => ({ googleBooksId: r.googleBooksId, coverUrl: r.coverUrl }))
 );
 } catch (error) {
 logger.error('Error searching for covers:', error);
 Alert.alert('Error', `Failed to search for covers: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
 } finally {
 setIsLoadingCovers(false);
 }
 }, [pendingBooks]);

 const handleSelectCover = useCallback(async (selectedCover: {googleBooksId: string, coverUrl?: string}) => {
 if (!user || !selectedCover.googleBooksId || !selectedCover.coverUrl) return;

 const bookKey = Array.from(selectedBooks)[0]; // stable key (may be book_key, not necessarily a DB uuid)
 const bookToUpdate = pendingBooks.find(book => pendingBookStableKey(book) === bookKey);
 if (!bookToUpdate) return;

 const bookData = await fetchBookData(bookToUpdate.title, bookToUpdate.author, selectedCover.googleBooksId, bookToUpdate.isbn);

 if (bookData.coverUrl) {
 // Save to our storage first (Google URLs expire; our URLs are stable and cached for everyone)
 let stableCoverUrl = bookData.coverUrl;
 const saved = await saveCoverToStorage({
 coverUrl: bookData.coverUrl,
 title: bookToUpdate.title,
 author: bookToUpdate.author,
 isbn: bookToUpdate.isbn,
 googleBooksId: selectedCover.googleBooksId,
 });
 if (saved?.coverUrl) stableCoverUrl = saved.coverUrl;

 const coverUri = await downloadAndCacheCover(stableCoverUrl, selectedCover.googleBooksId);
 
 const updatedBook: Book = {
 ...bookToUpdate,
 coverUrl: stableCoverUrl,
 localCoverPath: coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined,
 googleBooksId: selectedCover.googleBooksId,
 // Update other book data if available
 description: bookData.description || bookToUpdate.description,
 pageCount: bookData.pageCount || bookToUpdate.pageCount,
 categories: bookData.categories || bookToUpdate.categories,
 publisher: bookData.publisher || bookToUpdate.publisher,
 publishedDate: bookData.publishedDate || bookToUpdate.publishedDate,
 language: bookData.language || bookToUpdate.language,
 averageRating: bookData.averageRating || bookToUpdate.averageRating,
 ratingsCount: bookData.ratingsCount || bookToUpdate.ratingsCount,
 subtitle: bookData.subtitle || bookToUpdate.subtitle,
 };

 // Update in pending books
 const updatedPending = pendingBooks.map(book => 
 pendingBookStableKey(book) === bookKey ? updatedBook : book
 );
 setPendingBooks(updatedPending);

 // Update in photos
 const updatedPhotos = photos.map(photo => ({
 ...photo,
 books: photo.books.map(book => 
 pendingBookStableKey(book) === bookKey ? updatedBook : book
 ),
 }));
 setPhotos(dedupBy(updatedPhotos, photoStableKey));

 // Save to Supabase; include provenance so approved books stay cascade-deletable
 const saveOpts = session?.access_token
 ? {
 apiBaseUrl: getApiBaseUrl(),
 accessToken: session.access_token,
 sourcePhotoId: (updatedBook as any).source_photo_id,
 sourceScanJobId: (updatedBook as any).source_scan_job_id,
 }
 : undefined;
 await saveBookToSupabase(user.uid, updatedBook, updatedBook.status ?? 'approved', saveOpts);
 await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

 setShowSwitchCoversModal(false);
 clearSelection();

 Alert.alert('Cover Updated', 'The book cover has been updated.');
 }
 }, [pendingBooks, photos, approvedBooks, rejectedBooks, user, selectedBooks, clearSelection]);

const handleSwitchBook = useCallback(() => {
  if (!selectedPendingBook) {
    logger.warn('[SWITCH_BOOK_GUARD]', 'book not found for selectedId', { selectedId: selectedId?.slice(0, 12) });
    Alert.alert('Not ready', 'Could not find the selected book. Try tapping it again.');
    return;
  }
  if (!postApproveIdsSettled) {
    logger.info('[SWITCH_BOOK_GUARD]', 'post-approve refresh not yet settled', { selectedId: selectedId?.slice(0, 12) });
    return;
  }
  if (!(selectedPendingBook as any).source_photo_id) {
    logger.info('[SWITCH_BOOK_GUARD]', 'source_photo_id not yet set — book still syncing', {
      selectedId: selectedId?.slice(0, 12),
      bookTitle: selectedPendingBook.title?.slice(0, 30),
    });
    return;
  }
  setShowSwitchBookModal(true);
  setBookSearchQuery('');
  setBookSearchResults([]);
}, [selectedId, selectedPendingBook, postApproveIdsSettled]);

/** Single selection only: opens Edit Cover sheet (preview + Change Cover / Remove Cover). */
const handleEditCover = useCallback(() => {
  if (selectedId == null) return;
  if (!selectedPendingBook) {
    logger.warn('[EDIT_COVER_GUARD]', 'book not found for selectedId', { selectedId: selectedId?.slice(0, 12) });
    Alert.alert('Not ready', 'Could not find the selected book. Try tapping it again.');
    return;
  }
  if (!postApproveIdsSettled) {
    logger.info('[EDIT_COVER_GUARD]', 'post-approve refresh not yet settled — ids not ready', {
      selectedId: selectedId?.slice(0, 12),
    });
    return;
  }
  if (!selectedBookEditReady) {
    logger.info('[EDIT_COVER_GUARD]', 'source_photo_id not yet set — book still syncing', {
      selectedId: selectedId?.slice(0, 12),
      bookTitle: selectedPendingBook.title?.slice(0, 30),
    });
    return;
  }
  setShowEditCoverModal(true);
}, [selectedId, selectedPendingBook, selectedBookEditReady, postApproveIdsSettled]);

 const searchBooks = useCallback(async (query: string) => {
 if (!query.trim()) {
 setBookSearchResults([]);
 return;
 }

 setIsSearchingBooks(true);
 try {
 // searchBooksByQuery is now imported at top
 const results = await searchBooksByQuery(query, 20);
 setBookSearchResults(results);
 } catch (error) {
 logger.error('Error searching books:', error);
 Alert.alert('Error', 'Failed to search for books. Please try again.');
 } finally {
 setIsSearchingBooks(false);
 }
 }, []);

 const handleSelectBook = useCallback(async (selectedBook: {googleBooksId: string, title: string, author?: string, coverUrl?: string}) => {
 if (!user) return;

 const bookKey = Array.from(selectedBooks)[0]; // stable key (may be book_key, not necessarily a DB uuid)
 const bookToUpdate = pendingBooks.find(book => pendingBookStableKey(book) === bookKey);
 if (!bookToUpdate) return;

 const bookData = await fetchBookData(selectedBook.title, selectedBook.author, selectedBook.googleBooksId, bookToUpdate?.isbn);

 let coverUrlToUse = bookData.coverUrl || selectedBook.coverUrl;
 if (coverUrlToUse) {
 const saved = await saveCoverToStorage({
 coverUrl: coverUrlToUse,
 title: selectedBook.title,
 author: selectedBook.author,
 isbn: bookToUpdate?.isbn,
 googleBooksId: selectedBook.googleBooksId,
 });
 if (saved?.coverUrl) coverUrlToUse = saved.coverUrl;
 }

 let localCoverPath: string | undefined = undefined;
 if (coverUrlToUse) {
 const coverUri = await downloadAndCacheCover(coverUrlToUse, selectedBook.googleBooksId);
 localCoverPath = coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined;
 }

 const updatedBook: Book = {
 ...bookToUpdate,
 title: selectedBook.title,
 author: selectedBook.author || bookToUpdate.author,
 coverUrl: coverUrlToUse,
 localCoverPath,
 googleBooksId: selectedBook.googleBooksId,
 description: bookData.description,
 pageCount: bookData.pageCount,
 categories: bookData.categories,
 publisher: bookData.publisher,
 publishedDate: bookData.publishedDate,
 language: bookData.language,
 averageRating: bookData.averageRating,
 ratingsCount: bookData.ratingsCount,
 subtitle: bookData.subtitle,
 };

 // Update in pending books
 const updatedPending = pendingBooks.map(book => 
 pendingBookStableKey(book) === bookKey ? updatedBook : book
 );
 setPendingBooks(updatedPending);

 // Update in photos
 const updatedPhotos = photos.map(photo => ({
 ...photo,
 books: photo.books.map(book => 
 pendingBookStableKey(book) === bookKey ? updatedBook : book
 ),
 }));
 setPhotos(dedupBy(updatedPhotos, photoStableKey));

 // Save to Supabase; include provenance so approved books stay cascade-deletable
 const saveOpts = session?.access_token
 ? {
 apiBaseUrl: getApiBaseUrl(),
 accessToken: session.access_token,
 sourcePhotoId: (updatedBook as any).source_photo_id,
 sourceScanJobId: (updatedBook as any).source_scan_job_id,
 }
 : undefined;
 await saveBookToSupabase(user.uid, updatedBook, updatedBook.status ?? 'approved', saveOpts);
 await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

 setShowSwitchBookModal(false);
 clearSelection();

 Alert.alert('Book Updated', 'The book has been replaced.');
 }, [pendingBooks, photos, approvedBooks, rejectedBooks, user, selectedBooks, clearSelection]);

const rejectSelectedBooks = useCallback(async (actionId?: string) => {
if (!user) return;

 const currentSelected = selectAllMode ? new Set(completableKeys.filter(k => !excludedIds.has(k))) : selectedBooks;
 lastDestructiveActionRef.current = { actionId: `reject_bulk_${Date.now()}`, reason: 'reject_selected_books', at: Date.now(), bookCount: currentSelected.size, photoCount: 0 };
 const selectedBookObjs = pendingBooks.filter(book => currentSelected.has(pendingBookStableKey(book)));
 if (selectedBookObjs.length === 0) return;

// Partition into two buckets:
// withDbId have a real UUID row id; soft-delete by id (fastest, most reliable)
// byBookKey no DB id yet (fresh scan / never saved) or id is a local composite; soft-delete by book_key
// allStableKeys: every selected book gets a stableKey for the local-state removal (always runs)
const withDbId: string[] = [];
const byBookKey: string[] = [];
const allLocalIds: string[] = []; // for tombstone regardless of path
const allStableKeys: string[] = []; // used to remove from pendingBooks even if DB delete returns 0

for (const book of selectedBookObjs) {
const dbId = (book as any).dbId ?? (book.id && typeof book.id === 'string' && book.id.length === 36 ? book.id : null);
const stableKey = getPendingStableKeyScoped(book);
if (stableKey) allStableKeys.push(stableKey);
if (dbId) {
withDbId.push(dbId);
allLocalIds.push(dbId);
} else {
// No DB id — delete by book_key so the server row (if it exists) is cleaned up.
const bk = (book as any).book_key ?? getStableBookKey(book);
if (bk) byBookKey.push(bk);
if (book.id) allLocalIds.push(book.id);
}
}

const now = new Date().toISOString();
let deletedByIdCount = 0;
let deletedByKeyCount = 0;
const _deleteT0 = Date.now();

// Emit one structured audit line before any DB write.
logDeleteAudit(
  { reason: 'user_reject_pending', screen: 'ScansTab', gestureAt: Date.now() - 100, userConfirmed: true, actionId: actionId ?? `del_${Date.now()}_legacy` },
  { bookIds: [...withDbId, ...allLocalIds].slice(0, 10), bookCount: selectedBookObjs.length, userId: user.uid },
);

// 1) Soft-delete by UUID id (batch)
if (withDbId.length > 0 && supabase) {
logger.info('[SOFT_DELETE_AUDIT]', {
  caller: 'ScansTab.rejectSelectedBooks.byId',
  table: 'books',
  filter: { user_id: user.uid.slice(0, 8), id_in: withDbId.slice(0, 5), deleted_at: 'IS NULL' },
  setValue: { deleted_at: now, status: 'rejected' },
  idCount: withDbId.length,
  note: 'USER-INITIATED: reject selected pending books by DB id',
});
const { data: idRows, error: idErr } = await supabase
.from('books')
.update({ deleted_at: now, status: 'rejected', updated_at: now })
.eq('user_id', user.uid)
.in('id', withDbId)
.is('deleted_at', null)
.select('id');
if (idErr) {
logger.warn('[PENDING_DELETE_FAIL]', { path: 'by_id', error: idErr.message ?? String(idErr), ids: withDbId });
} else {
deletedByIdCount = idRows?.length ?? withDbId.length;
}
}

// 2) Soft-delete by book_key when no DB id is available (batch).
// Includes any status so recently-synced books with status:'pending' or 'incomplete' are caught.
if (byBookKey.length > 0 && supabase) {
logger.info('[SOFT_DELETE_AUDIT]', {
  caller: 'ScansTab.rejectSelectedBooks.byBookKey',
  table: 'books',
  filter: { user_id: user.uid.slice(0, 8), book_key_in: byBookKey.slice(0, 5), status_in: ['pending', 'incomplete'], deleted_at: 'IS NULL' },
  setValue: { deleted_at: now, status: 'rejected' },
  keyCount: byBookKey.length,
  note: 'USER-INITIATED: reject selected pending books by book_key (no DB id)',
});
const { data: keyRows, error: keyErr } = await supabase
.from('books')
.update({ deleted_at: now, status: 'rejected', updated_at: now })
.eq('user_id', user.uid)
.in('book_key', byBookKey)
.in('status', ['pending', 'incomplete'])
.is('deleted_at', null)
.select('id');
if (keyErr) {
logger.warn('[PENDING_DELETE_FAIL]', { path: 'by_book_key', error: keyErr.message ?? String(keyErr), keys: byBookKey });
} else {
deletedByKeyCount = keyRows?.length ?? 0;
if (deletedByKeyCount === 0 && byBookKey.length > 0) {
  // Server returned 0 rows: books may not exist on server yet (local-only scan result).
  // Local state is still removed below — this is not an error.
  logger.debug('[PENDING_DELETE_PATH]', 'by_book_key matched 0 server rows (local-only books ok)', { keys: byBookKey.slice(0, 5) });
}
}
}

const deleteStrategyChosen: string =
  withDbId.length > 0 && byBookKey.length === 0 ? 'db_delete_by_id' :
  withDbId.length === 0 && byBookKey.length > 0 ? 'db_delete_by_key+local' :
  withDbId.length > 0 && byBookKey.length > 0 ? 'db_delete_by_id+key+local' :
  'local_only';
const deletedCount = deletedByIdCount + deletedByKeyCount;
// One log per delete tap that answers "did server actually delete anything and why not?"
// strategy: what path(s) were attempted  serverCallMade: was supabase called at all
// serverDeletedCount: rows supabase confirmed deleted  serverCallErr: short error code if applicable
logger.info('[PENDING_DELETE_RESULT]', {
  strategy: deleteStrategyChosen,
  selectedCount: selectedBookObjs.length,
  hasDbIdsCount: withDbId.length,
  hasScanJobIdCount: selectedBookObjs.filter(b => !!(b as any).source_scan_job_id).length,
  serverCallMade: (withDbId.length > 0 || byBookKey.length > 0) && !!supabase,
  serverDeletedCount: deletedCount,
  localDeletedCount: selectedBookObjs.length,
  tombstoneAddedCount: allLocalIds.length + allStableKeys.length,
  timeMs: Date.now() - _deleteT0,
});

 // Tombstone by both UUID and stable key so rehydrate doesn't resurrect the book
 // regardless of whether the server row has a real UUID or not.
 if (allLocalIds.length > 0) {
   addDeletedBookIdsTombstone(user.uid, allLocalIds).catch(() => {});
 }
 if (allStableKeys.length > 0) {
   addDeletedPendingStableKeysTombstone(user.uid, allStableKeys).catch(() => {});
 }

 // Update local state
 const remainingBooks = pendingBooks.filter(book => !currentSelected.has(pendingBookStableKey(book)));

 // Remove from photos only strip pending/incomplete books, never touch approved
 const selectedStableKeys = new Set(selectedBookObjs.map(b => pendingBookStableKey(b)));
 const updatedPhotos = photos.map(photo => ({
 ...photo,
 books: photo.books.filter(book => {
 if (book.status === 'approved' || book.status === 'rejected') return true;
 return !selectedStableKeys.has(pendingBookStableKey(book));
 }),
 }));

 lastLocalMutationAtRef.current = Date.now();
 setPendingBooks(remainingBooks);
 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 clearSelection();

 saveUserData(remainingBooks, approvedBooks, rejectedBooks, updatedPhotos).catch(error => {
 logger.error('[PENDING_DELETE_SAVE_FAIL]', error);
 });
}, [user, pendingBooks, approvedBooks, rejectedBooks, photos, selectAllMode, excludedIds, selectedBooks, completableKeys, pendingBookStableKey, clearSelection]);

 const addImageToQueue = (uri: string, caption?: string, providedScanId?: string, source?: 'camera' | 'library') => {
 if (isCoverUpdateActive()) {
 logger.debug('[SCAN_EARLY_RETURN]', { reason: 'isCoverUpdateActive', context: 'addImageToQueue' });
 logger.error('[SCAN] addImageToQueue called during cover update; aborting. Cover update must not create scan queue or batch.');
 if (__DEV__) throw new Error('addImageToQueue must not be called during cover update');
 return;
 }
 const scanId = providedScanId ?? uuidv4();
 
 if (caption !== undefined) scanCaptionsRef.current.set(scanId, caption);
 clearSelection();
 
 setScanQueue(prevQueue => {
 const isAlreadyQueued = prevQueue.some(item => item.uri === uri && item.status === 'pending');
 if (isAlreadyQueued) {
 if (__DEV__) logger.warn('[SCAN] image already in queue, skip duplicate');
 return prevQueue;
 }
 const newScanItem: ScanQueueItem = {
 id: scanId,
 uri,
 status: 'pending',
 source: source ?? 'library',
 };

 // Calculate new queue state
 const updatedQueue = [...prevQueue, newScanItem];
 const totalScans = updatedQueue.length;
 const completedCount = updatedQueue.filter(item => item.status === 'completed' || item.status === 'failed' || item.status === 'canceled').length;
 
 
 // Return the updated queue
 return updatedQueue;
 });
 
 // Do NOT set scanProgress here: progress is derived from activeBatch only. Setting it here without batchId/jobIds causes phantom bar and corrupt state (queue_resume with no batch).
 // totalScansRef is updated when activeBatch effect runs.
 
 if (!isProcessing) {
 setIsProcessing(true);
 const src = source ?? 'library';
 setTimeout(() => processImage(uri, scanId, caption, src), 100);
 }
 };

 const handleCaptionSubmit = () => {
 const scanId = currentScanIdRef.current;
 const caption = captionText.trim();
 // Save caption for in-progress scans (read when photo is created)
 if (scanId) {
 scanCaptionsRef.current.set(scanId, caption);
 }
 // If photo was already created (scan completed fast), persist caption to that photo
 if (scanId && caption) {
 const photoId = scanIdToPhotoIdRef.current.get(scanId);
 if (photoId) {
 setPhotos((prev) => {
 const next = prev.map((p) => (p.id === photoId ? { ...p, caption } : p));
 if (user) saveUserData(pendingBooks, approvedBooks, rejectedBooks, next).catch((err) => logger.error('Error saving caption', err));
 return next;
 });
 scanIdToPhotoIdRef.current.delete(scanId);
 }
 }

 if (currentImageIndex < pendingImages.length - 1) {
 const nextIndex = currentImageIndex + 1;
 setCurrentImageIndex(nextIndex);
 setPendingImageUri(pendingImages[nextIndex].uri);
 currentScanIdRef.current = pendingImages[nextIndex].scanId;
 setCaptionText(scanCaptionsRef.current.get(pendingImages[nextIndex].scanId) || '');
 } else {
 setPendingImageUri(null);
 setCaptionText('');
 setPendingImages([]);
 setCurrentImageIndex(0);
 currentScanIdRef.current = null;
 }
 };

 const handleCaptionSkip = () => {
 const scanId = currentScanIdRef.current;
 if (scanId) scanIdToPhotoIdRef.current.delete(scanId);

 if (currentImageIndex < pendingImages.length - 1) {
 const nextIndex = currentImageIndex + 1;
 setCurrentImageIndex(nextIndex);
 setPendingImageUri(pendingImages[nextIndex].uri);
 currentScanIdRef.current = pendingImages[nextIndex].scanId;
 setCaptionText(scanCaptionsRef.current.get(pendingImages[nextIndex].scanId) || '');
 } else {
 currentScanIdRef.current = null;
 setPendingImageUri(null);
 setCaptionText('');
 setPendingImages([]);
 setCurrentImageIndex(0);
 }
 };

 const handleAddToFolder = () => {
 if (!user || !pendingImageUri) return;
 // When using AddCaption screen: onAddToFolder callback does goBack + show folder modal
 setShowFolderModal(true);
 };

 /** Start upload + scan enqueue after user has finished Caption (Continue or Skip). Called only when Caption screen completes. */
 const startUploadAfterCaption = useCallback((items: Array<{ uri: string; scanId: string }>) => {
 if (items.length === 0) return;
 pendingUploadBatchRef.current = null;
 setIsProcessing(true);
 setScanProgress({
 currentScanId: null,
 currentStep: 0,
 totalSteps: 10,
 totalScans: items.length,
 completedScans: 0,
 failedScans: 0,
 startTimestamp: Date.now(),
 jobIds: [],
 } as any);
 (async () => {
 try {
 await enqueueBatch(items);
 } catch (error: any) {
 logger.error(' Batch enqueue failed:', error);
 Alert.alert('Scan failed', (error?.message ?? String(error)).slice(0, 200));
 } finally {
 setIsProcessing(false);
 }
 })();
 }, [enqueueBatch]);

 /** Navigate to Add Caption screen (stack push). Pass imagesToShow when coming from Upload so we don't rely on state. */
 const openAddCaptionScreen = useCallback((imagesToShow?: Array<{ uri: string; scanId: string }>) => {
 const images = imagesToShow ?? pendingImages;
 if (images.length === 0) return;
 const initialIndex = 0;
 const initialCaption = scanCaptionsRef.current.get(images[initialIndex]?.scanId) ?? '';

 const onSubmit = async (scanId: string, caption: string, isLast: boolean) => {
 const normalizedCaption = caption.trim();
 if (scanId) scanCaptionsRef.current.set(scanId, normalizedCaption);
 if (scanId) {
 const photoId = scanIdToPhotoIdRef.current.get(scanId);
 if (photoId) {
 let nextPhotosSnapshot: Photo[] | null = null;
 setPhotos((prev) => {
 const next = prev.map((p) => (p.id === photoId ? { ...p, caption: normalizedCaption || undefined } : p));
 nextPhotosSnapshot = next;
 return next;
 });
 if (user && nextPhotosSnapshot) {
 try {
 await saveUserData(pendingBooks, approvedBooks, rejectedBooks, nextPhotosSnapshot);
 } catch (err) {
 logger.error('Error saving caption', err);
 }
 }
 scanIdToPhotoIdRef.current.delete(scanId);
 }
 }
 if (isLast) {
 setPendingImageUri(null);
 setCaptionText('');
 setPendingImages([]);
 setCurrentImageIndex(0);
 currentScanIdRef.current = null;
 const items = pendingUploadBatchRef.current;
 if (items && items.length > 0) startUploadAfterCaption(items);
 }
 };

 const onSkip = () => {
 const scanId = currentScanIdRef.current;
 if (scanId) scanIdToPhotoIdRef.current.delete(scanId);
 currentScanIdRef.current = null;
 setPendingImageUri(null);
 setCaptionText('');
 setPendingImages([]);
 setCurrentImageIndex(0);
 const items = pendingUploadBatchRef.current;
 if (items && items.length > 0) startUploadAfterCaption(items);
 };

    const onAddToFolder = () => {
      // Register the callback in the module-level registry and pass only the
      // serializable ID in params — avoids the "non-serializable value in params"
      // warning and prevents stale-closure / state-restore issues.
      const selectCallbackId = registerSelectCollectionCallback((folderId: string | null) => {
        setSelectedFolderId(folderId ?? null);
      });
      (navigation as any).navigate('SelectCollection', { callbackId: selectCallbackId });
    };
 const callbackId = registerAddCaptionCallbacks({
 onSubmit,
 onSkip,
 onAddToFolder,
 });

 // Use requestAnimationFrame to let the current frame finish before navigating,
 // preventing frame drops during the transition animation.
 requestAnimationFrame(() => {
 (navigation as { navigate: (name: string, params: object) => void }).navigate('AddCaption', {
 pendingImages: images,
 initialIndex,
 initialCaption,
 callbackId,
 });
 });
 }, [pendingImages, user, pendingBooks, approvedBooks, rejectedBooks, navigation, startUploadAfterCaption]);

 const saveFolders = async (updatedFolders: Folder[]) => {
 if (!user) return;
 try {
 const userFoldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(userFoldersKey, JSON.stringify(updatedFolders));
 setFolders(updatedFolders);
 } catch (error) {
 logger.error('Error saving folders:', error);
 }
 };

 const createFolder = async () => {
 const folderName = newFolderName.trim();
 if (!folderName || !user) return;
 
 const newFolder: Folder = {
 id: `folder_${Date.now()}`,
 name: folderName,
 bookIds: [],
 photoIds: [],
 createdAt: Date.now(),
 };
 
 const updatedFolders = [...folders, newFolder];
 await saveFolders(updatedFolders);
 setNewFolderName('');
 setSelectedFolderId(newFolder.id);
 };

  const handleFolderSelection = async (folderId: string | null) => {
    if (!user || !pendingImageUri) return;

    // Store (or clear) the folder selection and close the modal.
    // When opened from the AddCaption screen the user is returned to that screen
    // to finish captioning — do NOT call handleCaptionSkip/Submit here.
    setSelectedFolderId(folderId ?? null);
    setShowFolderModal(false);
    setNewFolderName('');
  };

 // Helper to add scanned books to selected folder after scan completes
 const addBooksToSelectedFolder = async (scannedBookIds: string[]) => {
 if (!user || !selectedFolderId || scannedBookIds.length === 0) return;
 
 try {
 const updatedFolders = folders.map(folder => {
 if (folder.id === selectedFolderId) {
 // Add new book IDs, avoiding duplicates
 const existingIds = new Set(folder.bookIds);
 scannedBookIds.forEach(id => {
 if (!existingIds.has(id)) {
 folder.bookIds.push(id);
 }
 });
 }
 return folder;
 });
 
 await saveFolders(updatedFolders);
 setSelectedFolderId(null); // Clear selection after adding
 } catch (error) {
 logger.error('Error adding books to folder:', error);
 }
 };

 const takePicture = async () => {
 if (!isCameraReady) {
 Alert.alert('Camera starting', 'Try again in a moment.');
 return;
 }
 if (!cameraRef) {
 logger.warn('Camera ref not available');
 return;
 }
 
 // Check if camera is still active before taking picture
 if (!isCameraActive) {
 logger.warn('Camera not active, cannot take picture');
 return;
 }
 
 try {
 // Store the camera ref locally to prevent issues if component unmounts
 const currentCameraRef = cameraRef;
 
 // Take photo and wait for it to complete before closing camera
 const photo = await currentCameraRef.takePictureAsync({
 quality: 0.8,
 base64: false,
 });
 
 if (photo?.uri) {
 logger.debug(' Photo taken:', photo.uri);
 const photoUri = photo.uri;
 // Close camera immediately so user sees scan bar and caption modal (they are hidden while camera is active)
 setIsCameraActive(false);
 // Start scanning and open Add Caption screen (handleImageSelected sets pendingImages then navigates in 100ms)
 handleImageSelected(photoUri);
 } else {
 logger.error('Photo captured but no URI returned');
 Alert.alert('Camera Error', 'Photo was taken but could not be saved. Please try again.');
 }
 } catch (error: any) {
 const msg = error?.message ?? '';
 const code = error?.code ?? '';
 const isNotReady =
 code === 'ERR_CAMERA_NOT_READY' ||
 /not ready|not ready yet|camera is not ready/i.test(msg);

 if (isNotReady) {
 const appState = AppState.currentState;
 logger.warn('[CAMERA] not_ready_on_capture', {
 isFocused,
 hasPermission: permission?.granted ?? false,
 isCameraReady,
 appState,
 });
 if (isCameraActive) {
 Alert.alert('Camera not ready yet', 'Try again in a second.');
 }
 return;
 }

 logger.error('Error taking picture:', error);

 // Only show alert if camera is still active (not unmounted)
 // Don't close camera on error - let user try again
 if (isCameraActive && msg.includes('unmounted')) {
 // Camera was unmounted - this is expected if user closed it manually
 logger.debug('Camera was unmounted during photo capture (expected if closed manually)');
 } else if (isCameraActive) {
 Alert.alert('Camera Error', 'Failed to take picture. Please try again.');
 }
 }
 };

 const pickImage = async () => {
 logger.debug('[PICK] start');
 // Check guest scan limit before opening image picker
 // If user is null, treat as guest (shouldn't happen, but safety check)
 if (!user || isGuestUser(user)) {
 const guestScanKey = 'guest_scan_used';
 const hasUsedScan = await AsyncStorage.getItem(guestScanKey);
 if (hasUsedScan === 'true') {
 // Navigate to My Library tab which shows login screen
 navigation.navigate('MyLibrary' as never);
 return;
 }
 }
 
 try {
 const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
 
 if (permissionResult.granted === false) {
 Alert.alert('Permission Required', 'Please grant photo library access to upload images.');
 return;
 }

 const result = await ImagePicker.launchImageLibraryAsync({
 mediaTypes: 'images',
 allowsEditing: false,
 quality: 0, // 0 = skip internal copy/read avoids ERR_FAILED_TO_READ_IMAGE on iCloud assets
 allowsMultipleSelection: true,
 selectionLimit: 0, // 0 = unlimited
 exif: false,
 });
 if (LOG_DEBUG) logger.debug('[PICK_DEBUG]', {
 canceled: result.canceled,
 assetsCount: result.assets?.length ?? 0,
 first: result.assets?.[0]
 ? {
 uri: result.assets[0].uri,
 uriScheme: result.assets[0].uri?.split('://')[0] ?? 'none',
 fileName: result.assets[0].fileName,
 type: (result.assets[0] as { type?: string }).type,
 mimeType: (result.assets[0] as { mimeType?: string }).mimeType,
 width: result.assets[0].width,
 height: result.assets[0].height,
 fileSize: (result.assets[0] as { fileSize?: number }).fileSize,
 }
 : null,
 allUriSchemes: (result.assets ?? []).map(a => a.uri?.split('://')[0] ?? 'none'),
 });

 if (!result.canceled && result.assets && result.assets.length > 0) {
 logger.debug(` ${result.assets.length} image(s) picked from library`);
 // Pipeline boundary log: after picker detect reused asset (same uri) or wrong asset order
 result.assets.forEach((asset, idx) => {
 const a = asset as { uri: string; width?: number; height?: number; assetId?: string; fileName?: string; filename?: string };
 logger.debug('[PIPELINE_AFTER_PICKER]', {
 index: idx + 1,
 uri: a.uri,
 assetId: a.assetId ?? (a as any).id,
 filename: a.fileName ?? a.filename,
 width: a.width,
 height: a.height,
 });
 });
 setCaptionText('');

 // Normalize all picked URIs to real local file:// paths before anything else touches them.
 // This resolves ph://, assets-library://, and iCloud stubs that haven't been downloaded yet.
 const normalizedAssets = await Promise.all(
 result.assets.map(async (asset) => ({
 ...asset,
 uri: await ensureLocalUri(asset.uri),
 }))
 );

 const scanItems: Array<{uri: string, scanId: string}> = [];
 normalizedAssets.forEach((asset) => {
 const scanId = uuidv4();
 scanCaptionsRef.current.set(scanId, '');
 scanItems.push({ uri: asset.uri, scanId });
 });
 
 // Filter to items not already in queue. Do NOT add to queue here enqueueBatch does atomic add (write records first, then kick async).
 const existingUris = new Set(
 scanQueue
 .filter((item) => item.status === 'pending' || item.status === 'processing' || item.status === 'queued')
 .map((item) => item.uri)
 );
 const actuallyAddedItems = scanItems.filter(({ uri }) => !existingUris.has(uri));
 if (LOG_DEBUG) logger.debug('[PICKER_DEDUP]', {
 incoming: scanItems.length,
 existingUrisCount: existingUris.size,
 actuallyAdded: actuallyAddedItems.length,
 rejectedSample: scanItems
 .filter(i => existingUris.has(i.uri))
 .slice(0, 3)
 .map(i => i.uri),
 });

 if (actuallyAddedItems.length === 0) {
 logger.debug('[SCAN_EARLY_RETURN]', { reason: 'actuallyAddedItems_empty' });
 logger.warn(' All selected images are already in the queue, skipping');
 return;
 }

 // Upload flow: go to Caption first; upload/enqueue only after user taps Continue or Skip on Caption screen.
 pendingUploadBatchRef.current = actuallyAddedItems;
 setPendingImages(actuallyAddedItems);
 setCurrentImageIndex(0);
 setPendingImageUri(actuallyAddedItems[0].uri);
 currentScanIdRef.current = actuallyAddedItems[0].scanId;
 setCaptionText('');
 actuallyAddedItems.forEach(({ scanId }) => {
 scanCaptionsRef.current.set(scanId, '');
 });
 openAddCaptionScreen(actuallyAddedItems);
 }
 } catch (error) {
 logger.error('[PICK] failed', error);
 Alert.alert('Error', 'Failed to pick image. Please try again.');
 }
 };

 const handleStartCamera = async () => {
 // Check guest scan limit before opening camera
 // If user is null, treat as guest (shouldn't happen, but safety check)
 if (!user || isGuestUser(user)) {
 const guestScanKey = 'guest_scan_used';
 const hasUsedScan = await AsyncStorage.getItem(guestScanKey);
 if (hasUsedScan === 'true') {
 // Navigate to My Library tab which shows login screen
 navigation.navigate('MyLibrary' as never);
 return;
 }
 }
 
 if (!permission?.granted) {
 const response = await requestPermission();
 if (!response.granted) {
 Alert.alert('Permission Required', 'Camera access is required to scan books.');
 return;
 }
 }
 setIsCameraActive(true);
 };

 // Pinch gesture for zoom
 const pinchGesture = Gesture.Pinch()
 .onStart(() => {
 lastZoomRef.current = zoom;
 })
 .onUpdate((e) => {
 // Scale from 1.0 (no change) - scale up = zoom in, scale down = zoom out
 // Map scale to zoom: scale 0.5 = zoom out, scale 2.0 = zoom in
 const baseZoom = lastZoomRef.current;
 const scaleChange = e.scale - 1.0; // Change from 1.0
 const newZoom = Math.max(0, Math.min(1, baseZoom + scaleChange * 0.5));
 setZoom(newZoom);
 })
 .onEnd(() => {
 lastZoomRef.current = zoom;
 });

 // Auth gating is at root only (AppWrapper: session ? TabNavigator : AuthStack). No per-screen "if (!session) go login".

// ─── BOTTOM DOCK ──────────────────────────────────────────────────────────────
// These hooks MUST be called unconditionally before any early-return (including
// the isCameraActive block below). React requires hooks to run in the same order
// on every render — placing them after a conditional return causes
// "Rendered fewer hooks than expected" when the camera activates.
const { setSelectionBarContent, setTabBarHeight } = useBottomDock();
const tabBarHeight = useBottomTabBarHeight();
useEffect(() => {
  setTabBarHeight(tabBarHeight);
}, [tabBarHeight, setTabBarHeight]);

// Inject selection bar content into BottomDockContext so TabNavigator's BottomDock
// can render it at the screen root. No positioning is applied here — the dock owns all
// layout (position:absolute, bottom:tabBarHeight). Content stacks naturally top-to-bottom:
//   [approveError banner]  [selection bar]  (dock then appends scan bar below)
// MUST be before the isCameraActive early-return (Rules of Hooks).
useEffect(() => {
  const showSelectionBar = pendingBooks.length > 0 && selectedCount > 0;
  const showApproveError = approveError !== null;
  if (!showSelectionBar && !showApproveError) {
    setSelectionBarContent(null);
    return;
  }
  setSelectionBarContent(
    <>
      {showApproveError && (
        <View
          pointerEvents="box-none"
          style={{
            backgroundColor: '#7f1d1d',
            paddingVertical: 10,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <WarningIcon size={16} color="#fca5a5" />
          <Text style={{ flex: 1, color: '#fecaca', fontSize: 13, lineHeight: 18 }} numberOfLines={3}>
            {approveError}
          </Text>
          <Pressable onPress={approveSelectedBooks} style={{ paddingVertical: 4, paddingHorizontal: 8, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 6 }}>
            <Text style={{ color: '#fecaca', fontSize: 13, fontWeight: '600' }}>Retry</Text>
          </Pressable>
          <Pressable onPress={() => setApproveError(null)} hitSlop={12}>
            <CloseIcon size={18} color="#fca5a5" />
          </Pressable>
        </View>
      )}
      {showSelectionBar && (
        <View
          pointerEvents="box-none"
          style={[
            styles.selectionBar,
            {
              backgroundColor: t.colors.surface,
              paddingBottom: 8,
              paddingLeft: Math.max(16, (insets.left ?? 0) + 16),
              paddingRight: Math.max(16, (insets.right ?? 0) + 16),
            },
          ]}
        >
          <View style={styles.selectionBarInner}>
            {selectedCount === 1 ? (
              <View style={styles.rowTop}>
                <Text style={[styles.countText, { color: t.colors.text }]} numberOfLines={1}>1 selected</Text>
                <Pressable
                  disabled={!selectedBookEditReady}
                  style={({ pressed }) => [
                    styles.selectionActionButton,
                    { borderColor: t.colors.border ?? t.colors.borderSoft, backgroundColor: (t.colors.surface ?? t.colors.surface2) as string },
                    !selectedBookEditReady && { opacity: 0.4 },
                    pressed && selectedBookEditReady && { opacity: 0.8 },
                  ]}
                  onPress={selectedBookEditReady ? handleEditCover : undefined}
                >
                  <ImageOutlineIcon size={14} color={t.colors.text ?? t.colors.textPrimary} style={styles.selectionActionIcon} />
                  <Text style={[styles.selectionActionLabel, { color: t.colors.text ?? t.colors.textPrimary }]}>
                    {selectedBookEditReady ? 'Edit Cover' : 'Edit Cover…'}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={!selectedBookEditReady}
                  style={({ pressed }) => [
                    styles.selectionActionButton,
                    { borderColor: t.colors.border ?? t.colors.borderSoft, backgroundColor: (t.colors.surface ?? t.colors.surface2) as string },
                    !selectedBookEditReady && { opacity: 0.4 },
                    pressed && selectedBookEditReady && { opacity: 0.8 },
                  ]}
                  onPress={selectedBookEditReady ? handleSwitchBook : undefined}
                >
                  <BookOutlineIcon size={14} color={t.colors.text ?? t.colors.textPrimary} style={styles.selectionActionIcon} />
                  <Text style={[styles.selectionActionLabel, { color: t.colors.text ?? t.colors.textPrimary }]}>Switch Book</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.rowTopCompact}>
                <Text style={[styles.countText, { color: t.colors.text }]} numberOfLines={1}>{selectedCount} selected</Text>
              </View>
            )}
            <View style={[styles.rowBottom, approveInProgress && { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
              <TouchableOpacity
                style={[
                  styles.stickyButton,
                  styles.actionBtn,
                  (approveInProgress || isApproving) && styles.stickyButtonDisabled,
                  (approveInProgress || isApproving) && { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.colors.secondary },
                ]}
                onPress={approveSelectedBooks}
                activeOpacity={0.8}
                disabled={approveInProgress || isApproving}
              >
                <Text style={[styles.stickyButtonText, (approveInProgress || isApproving) && { color: t.colors.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                  {approveInProgress ? 'Adding…' : isApproving ? 'Adding' : 'Add Selected'}
                </Text>
              </TouchableOpacity>
              {approveInProgress && (
                <View style={{ paddingVertical: 4 }}>
                  <ActivityIndicator size="small" color={t.colors.secondary ?? t.colors.text} />
                </View>
              )}
              <TouchableOpacity
                style={[styles.stickyDeleteButton, styles.actionBtn]}
                onPress={() => {
                  const _deleteIntent = createDeleteIntent('user_reject_pending', 'ScansTab');
                  Alert.alert(
                    'Delete pending books?',
                    selectedCount === 1 ? 'Delete 1 pending book from this scan?' : `Delete ${selectedCount} pending books from this scan?`,
                    [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => {
                      _deleteIntent.userConfirmed = true;
                      if (!assertDeleteAllowed(_deleteIntent)) return;
                      rejectSelectedBooks(_deleteIntent.actionId);
                    }}]
                  );
                }}
                activeOpacity={0.8}
              >
                <Text style={[styles.stickyDeleteButtonText, { color: '#FFFFFF' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                  Delete Selected
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </>
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [pendingBooks.length, selectedCount, approveError, isApproving, approveInProgress, insets.left, insets.right, t.colors.surface, t.colors.divider, t.colors.text, t.colors.border, t.colors.borderSoft, t.colors.surface2, t.colors.secondary, t.colors.textPrimary]);

// Clear selection bar content when tab unmounts so it doesn't persist on other tabs.
// MUST be before the isCameraActive early-return (Rules of Hooks).
useEffect(() => {
  return () => { setSelectionBarContent(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// All hooks MUST run before any conditional return (Rules of Hooks). Move pending list hooks here so isCameraActive return doesn't skip them.
const pendingContentWrap = useMemo(
  () => ({
    width: '100%' as const,
    maxWidth: pendingGridContainerWidth,
    alignSelf: 'center' as const,
    paddingHorizontal: PENDING_GRID_HORIZONTAL_PADDING,
  }),
  [pendingGridContainerWidth]
);

// Stable callbacks that delegate to refs — never change reference, so FlatList doesn't re-render all rows.
const stableIsBookSelected = useCallback((key: string) => isBookSelectedRef.current(key), []);
const stableToggleBookSelection = useCallback((key: string) => toggleBookSelectionRef.current(key), []);

const renderPendingRow = useCallback(({ item }: { item: PendingListRow }) => {
  if (item.type === 'group_header') {
    const { group, groupIndex } = item;
    return (
      <View style={pendingContentWrap}>
        <View style={styles.pendingGroupBlock}>
          <TouchableOpacity
            style={[styles.pendingGroupHeader, { borderBottomColor: t.colors.separator ?? t.colors.border }]}
            onPress={() => openScanReview(group)}
            activeOpacity={0.7}
          >
            <View style={styles.pendingGroupHeaderLeft}>
              <Text style={[styles.pendingGroupTitle, { color: t.colors.text }]} numberOfLines={1}>
                Scan {groupIndex + 1}
              </Text>
              <View style={[styles.pendingGroupPill, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}>
                <Text style={[styles.pendingGroupPillText, { color: t.colors.textMuted }]}>
                  ({group.books.length} books{(() => {
                    const selectedInGroup = group.books.filter(b => stableIsBookSelected(pendingBookStableKey(b))).length;
                    return selectedInGroup > 0 ? ` · ${selectedInGroup} selected` : '';
                  })()})
                </Text>
              </View>
            </View>
            <View style={[styles.pendingGroupThumb, { backgroundColor: t.colors.surface2 ?? t.colors.surface, borderColor: t.colors.border }]}>
              {group.storagePath || group.thumbUri ? (
                <PhotoTile
                  photoId={group.photo?.id}
                  localUri={(group.photo as { local_uri?: string })?.local_uri ?? (group.thumbUri?.startsWith?.('file://') ? group.thumbUri : null)}
                  storagePath={group.storagePath}
                  fallbackUri={group.thumbUri}
                  thumbnailUri={group.thumbnailUri}
                  signedUrl={group.photo?.signed_url}
                  signedUrlExpiresAt={group.photo?.signed_url_expires_at}
                  status={group.photo?.status}
                  onRetryUpload={group.photo?.id ? () => handleRetryUpload(group.photo!.id) : undefined}
                  style={StyleSheet.absoluteFill as any}
                  contentFit="cover"
                />
              ) : (
                <View style={styles.pendingGroupThumbPlaceholder}>
                  <Text style={[styles.pendingGroupThumbPlaceholderText, { color: t.colors.textMuted }]} numberOfLines={1}>Photo</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  const { books, group, groupIndex, rowIndex } = item;
  const isLastRowOfGroup = rowIndex === Math.ceil(group.books.length / pendingGridColumns) - 1;
  return (
    <View style={pendingContentWrap}>
      <View style={[styles.pendingGroupGrid, { marginBottom: isLastRowOfGroup ? 12 : 0 }]}>
        {books.map((book, index) => {
          const bookStableKey = pendingBookStableKey(book);
          const isSelected = stableIsBookSelected(bookStableKey);
          const coverUri = getBookCoverUri(book);
          const colIndex = rowIndex * pendingGridColumns + index;
          return (
            <View
              key={bookStableKey}
              style={[
                styles.pendingGridItem,
                {
                  width: pendingGridItemWidth,
                  marginRight: (colIndex + 1) % pendingGridColumns === 0 ? 0 : PENDING_GRID_GAP,
                  marginBottom: PENDING_GRID_GAP,
                },
              ]}
            >
              <TouchableOpacity
                style={styles.pendingGridCard}
                onPress={() => stableToggleBookSelection(bookStableKey)}
                activeOpacity={0.7}
              >
                <View style={styles.pendingGridCoverWrapper}>
                  {coverUri ? (
                    <Image source={{ uri: coverUri }} style={styles.pendingGridCover} />
                  ) : (
                    <View style={[styles.pendingGridCover, styles.placeholderCover, { backgroundColor: t.colors.surface2 }]}>
                      <Text style={[styles.placeholderText, { color: t.colors.textMuted }]} numberOfLines={3}>{book.title}</Text>
                    </View>
                  )}
                  {isSelected && (
                    <>
                      <View
                        pointerEvents="none"
                        style={[
                          styles.selectedCoverOverlay,
                          {
                            backgroundColor: t.colors.selectionOverlay ?? 'rgba(0,0,0,0.2)',
                            borderWidth: 2,
                            borderColor: t.colors.primary,
                          },
                        ]}
                      />
                      <View pointerEvents="none" style={styles.selectedCoverCheckWrap}>
                        <CheckmarkIcon size={14} color={t.colors.primary} style={styles.selectedCoverCheckIcon} />
                      </View>
                    </>
                  )}
                </View>
                <View style={styles.pendingGridTextBlock}>
                  <Text style={[styles.bookAuthorGrid, { color: t.colors.textMuted }, !book.author && (book.id ?? book.dbId) && { fontStyle: 'italic', opacity: 0.85 }]} numberOfLines={2} ellipsizeMode="tail">
                    {book.author ?? (book.id ?? book.dbId ? '—' : book.title ?? '')}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );
}, [t, openScanReview, stableIsBookSelected, pendingBookStableKey, getBookCoverUri, stableToggleBookSelection, pendingGridColumns, pendingGridItemWidth, pendingContentWrap, styles]);

const keyExtractorPendingRow = useCallback((item: PendingListRow): string => {
  if (item.type === 'group_header') return `h-${item.group.scanJobId || item.group.photoId || item.groupIndex}`;
  return `b-${item.group.scanJobId || item.group.photoId}-${item.groupIndex}-${item.rowIndex}`;
}, []);

// Photo IDs that have approved books in the library (not pending — only library books).
const approvedPhotoIds = useMemo(() => {
  const set = new Set<string>();
  for (const b of approvedBooks) {
    const pid = (b as any).source_photo_id ?? (b as any).sourcePhotoId ?? (b as any).photoId;
    if (pid) set.add(pid);
  }
  return set;
}, [approvedBooks]);

const recentScansFooter = useMemo(() => {
  // Only show photos that have approved books in the library.
  const completePhotos = photos.filter((photo) => {
    if (photo.status === 'discarded' || (photo as any).deleted_at) return false;
    const hasApprovedBooks = photo.id ? approvedPhotoIds.has(photo.id) : false;
    const hasApprovedCount = typeof photo.approved_count === 'number' && photo.approved_count > 0;
    const hasApprovedInSnapshot = (photo.books ?? []).some(b => b.status === 'approved');
    return hasApprovedBooks || hasApprovedCount || hasApprovedInSnapshot;
  });
  const recentCanonical = completePhotos.length === 0 ? [] : dedupBy(completePhotos, canonicalPhotoListKey);
  const recentListFull = recentCanonical.slice().reverse().map((p) => ({
    photo: p,
    thumbnailUri: p.thumbnail_uri ?? p.uri ?? null,
  }));
  const recentCount = recentListFull.length;
  const PREVIEW_THUMBS = 3;
  const previewList = recentListFull.slice(0, PREVIEW_THUMBS);
  if (__DEV__ && recentCount > 0) {
    logger.every('recent_scans_strip', 2000, 'debug', '[RECENT_SCANS]', '', { recentScansLength: recentCount });
  }
  const renderScanThumb = (item: { photo: Photo; thumbnailUri: string | null }, photoIndex: number, closeModal?: boolean) => (
    <TouchableOpacity
      key={canonicalPhotoListKey(item.photo) || `ph_${photoIndex}`}
      style={styles.recentThumbCard}
      onPress={() => {
        if (closeModal) {
          setShowAllScansModal(false);
          setTimeout(() => openScanModal(item.photo), 150);
        } else {
          openScanModal(item.photo);
        }
      }}
      activeOpacity={0.7}
    >
      <PhotoTile
        photoId={item.photo.id}
        localUri={(item.photo as { local_uri?: string }).local_uri ?? (item.photo.uri?.startsWith?.('file://') ? item.photo.uri : null)}
        storagePath={item.photo.storage_path}
        fallbackUri={item.photo.uri}
        thumbnailUri={item.thumbnailUri}
        signedUrl={item.photo.signed_url}
        signedUrlExpiresAt={item.photo.signed_url_expires_at}
        status={item.photo.status}
        onRetryUpload={() => handleRetryUpload(item.photo.id)}
        style={[styles.previewScanThumb, { borderColor: t.colors.border }]}
        contentFit="cover"
      />
      <Text style={[styles.recentThumbDate, { color: t.colors.textMuted }]} numberOfLines={1}>
        {new Date(item.photo.timestamp).toLocaleDateString()}
      </Text>
    </TouchableOpacity>
  );
  return (
    <View style={[styles.sectionBlock, styles.recentScansSection]}>
      <View style={styles.sectionHeaderWithAction}>
        <Text style={[styles.sectionTitle, { color: t.colors.text }]}>Recent Scans</Text>
        {recentCount > 0 && (
          <Text style={[styles.recentScansCount, { color: t.colors.textMuted }]}>{recentCount}</Text>
        )}
      </View>
      {recentCount === 0 ? (
        <TouchableOpacity
          style={[styles.sectionEmptyState, styles.recentScansEmptyState]}
          onPress={handleStartCamera}
          activeOpacity={0.7}
        >
          <View style={[styles.recentScansEmptyIconWrap, { borderColor: t.colors.border, backgroundColor: t.colors.surface2 ?? t.colors.surface }]}>
            <ImageOutlineIcon size={36} color={t.colors.textMuted} style={styles.sectionEmptyIcon} />
          </View>
          <Text style={[styles.sectionEmptyTitle, { color: t.colors.text }]}>No recent scans yet</Text>
          <Text style={[styles.sectionEmptyHint, { color: t.colors.textHint ?? t.colors.textMuted }]}>Scan a shelf or upload a photo to get started</Text>
          <TouchableOpacity onPress={(e) => { e.stopPropagation(); pickImage(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[styles.emptyStateLink, { color: t.colors.primary }]}>Upload a photo</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      ) : (
        <>
          <FlatList
            data={previewList}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item, index) => canonicalPhotoListKey(item.photo) || `ph_${index}`}
            renderItem={({ item, index }) => (
              <View style={styles.recentScanStripItem}>
                {renderScanThumb(item, index)}
              </View>
            )}
            contentContainerStyle={styles.recentScanStripContent}
            style={styles.recentScanStrip}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={5}
            removeClippedSubviews={true}
          />
          <TouchableOpacity
            style={[styles.photoRow, styles.seeAllScansRow, { borderBottomColor: t.colors.border }]}
            onPress={() => setShowAllScansModal(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.photoThumbnail, styles.seeAllScansIconWrap, { borderColor: t.colors.border }]}>
              <ListOutlineIcon size={24} color={t.colors.textMuted} />
            </View>
            <View style={styles.photoInfo}>
              <Text style={[styles.photoDate, { color: t.colors.text }]}>See all scans</Text>
              <Text style={[styles.photoBooks, { color: t.colors.textMuted }]}>{recentCount} total</Text>
            </View>
            <ChevronForwardIcon size={20} color={t.colors.textMuted} style={styles.photoRowChevron} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}, [photos, approvedPhotoIds, t, styles, handleStartCamera, pickImage, openScanModal, setShowAllScansModal]);

 if (isCameraActive) {
 return (
 <View style={styles.cameraContainer}>
 <GestureDetector gesture={pinchGesture}>
 <View style={styles.camera}>
 <CameraView
 style={StyleSheet.absoluteFill}
 facing="back"
 zoom={zoom}
 flash={flashOn ? 'on' : 'off'}
 ref={(ref) => setCameraRef(ref)}
 onCameraReady={() => setIsCameraReady(true)}
 />
 </View>
 </GestureDetector>
 {/* Overlay outside CameraView using absolute positioning */}
 <View style={styles.cameraOverlay}>
 {/* Soft side guides: subtle vertical gradients (68% dark overlay edges) */}
 <LinearGradient
 colors={['rgba(0,0,0,0.08)', 'transparent']}
 start={{ x: 0, y: 0 }}
 end={{ x: 1, y: 0 }}
 style={styles.cameraEdgeGradientLeft}
 pointerEvents="none"
 />
 <LinearGradient
 colors={['transparent', 'rgba(0,0,0,0.08)']}
 start={{ x: 0, y: 0 }}
 end={{ x: 1, y: 0 }}
 style={styles.cameraEdgeGradientRight}
 pointerEvents="none"
 />
 {/* Close top left text button (calm) */}
 <TouchableOpacity
 style={[styles.cameraCloseButton, { top: insets.top + 10 }]}
 onPress={() => setIsCameraActive(false)}
 activeOpacity={0.7}
 >
 <ChevronBackIcon size={20} color="rgba(255,255,255,0.95)" style={{ marginRight: 4 }} />
 <Text style={styles.cameraCloseButtonText}>Cancel</Text>
 </TouchableOpacity>

 {/* Gentle hint lower on screen, soft corners, fades out after ~3s */}
 <Animated.View style={[styles.cameraTipBanner, { marginTop: insets.top + 120, opacity: cameraTipOpacity }]}>
 <Text style={styles.cameraTipText}>Better lighting = better accuracy</Text>
 <Text style={[styles.cameraTipText, styles.cameraTipTextSecondary]}>Try to capture all book spines</Text>
 </Animated.View>
 
 {/* Single vertical control rail Flash, +, 1.0x, - in one rounded container */}
 <View style={styles.controlRail}>
 <TouchableOpacity
 style={styles.controlRailItem}
 onPress={() => setFlashOn((on) => !on)}
 activeOpacity={0.7}
 >
 <FlashIcon size={22} color={flashOn ? t.colors.accent2 : '#FFFFFF'} />
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.controlRailItem}
 onPress={() => setZoom((z) => Math.min(1, z + 0.1))}
 activeOpacity={0.7}
 >
 <AddIcon size={22} color="#FFFFFF" />
 </TouchableOpacity>
 <Text style={styles.controlRailZoomLabel}>{(1 + zoom).toFixed(1)}x</Text>
 <TouchableOpacity
 style={styles.controlRailItem}
 onPress={() => setZoom((z) => Math.max(0, z - 0.1))}
 activeOpacity={0.7}
 >
 <RemoveIcon size={22} color="#FFFFFF" />
 </TouchableOpacity>
 </View>
 
 {/* Capture button + helper text */}
 <View style={styles.cameraControls}>
 <TouchableOpacity
 style={[styles.captureButton, !isCameraReady && styles.captureButtonDisabled]}
 onPress={takePicture}
 activeOpacity={0.8}
 >
 <View style={styles.captureButtonInner} />
 </TouchableOpacity>
 <Text style={styles.cameraShutterHint}>Take multiple photos for large shelves</Text>
 </View>
 </View>
 </View>
 );
 }

// Pending tray: reserve space so scroll content clears the BottomDock.
// tabBarHeight already includes the safe-area bottom inset on iOS.
// PENDING_TRAY_RESERVE covers the selection bar + scan bar combined worst case.
const PENDING_TRAY_RESERVE = 120;

// isScanningBarVisible: used for scroll padding reservation and log telemetry.
const queueHasInFlightItem = scanQueue.some(
  (i) => i.status === 'queued' || i.status === 'pending' || i.status === 'processing'
);
const isScanningBarVisible = activeBatch !== null || jobsInProgress > 0 || queueHasInFlightItem;
const scanBarVisibilityKey = `${activeBatch?.batchId ?? 'null'}:${jobsInProgress}:${queueHasInFlightItem}:${isScanningBarVisible}`;
if (scanBarVisibilityLogKeyRef.current !== scanBarVisibilityKey) {
  scanBarVisibilityLogKeyRef.current = scanBarVisibilityKey;
  if (LOG_UI) logger.debug('[SCAN_BAR_VISIBILITY]', { activeBatch: activeBatch?.batchId ?? null, jobsInProgress, queueHasInFlightItem, isScanningBarVisible });
}

// DEV-only: detect duplicate React keys in pending grid (same formula as render)
 if (__DEV__ && groupedPendingBooks.length > 0) {
 const keys: string[] = [];
 groupedPendingBooks.forEach((group, groupIndex) => {
 group.books.forEach((book, bookIndex) => {
 keys.push(
 book.id
 ?? (book as any).tempId
 ?? `${group.photoId ?? (book as any).source_photo_id ?? 'noPhoto'}:${(book as any).book_key ?? getStableBookKey(book) ?? 'key'}:${groupIndex}:${bookIndex}`
 );
 });
 });
 const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) logger.logOnce(`dup_keys:${dupes[0]}`, 'info', '[DUP_KEYS]', 'pendingBooks duplicate keys', { dupes: dupes.slice(0, 10) });
 }

 const hasPendingRows = pendingListRows.length > 0;
 const pendingEmpty = pendingBooks.filter(b => b.status === 'pending' || b.status === 'incomplete').length === 0;

 return (
 <View style={[styles.safeContainer, { backgroundColor: t.colors.screenBackground }]}>
 <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
 <FlatList
 data={pendingListRows}
 renderItem={renderPendingRow}
 keyExtractor={keyExtractorPendingRow}
 initialNumToRender={6}
 maxToRenderPerBatch={4}
 windowSize={5}
 updateCellsBatchingPeriod={100}
 removeClippedSubviews={true}
 extraData={selectedBooks.size + excludedIds.size + (selectAllMode ? 1 : 0)}
 contentContainerStyle={[
 { backgroundColor: t.colors.screenBackground, paddingBottom: tabBarHeight + 24, flexGrow: 1 },
 pendingBooks.length > 0 && selectedCount > 0 && {
   paddingBottom: tabBarHeight + PENDING_TRAY_RESERVE + 8,
 },
 pendingBooks.length > 0 && selectedCount === 0 && {
   paddingBottom: tabBarHeight + PENDING_TRAY_RESERVE + 8,
 },
 ]}
 style={styles.container}
 ListHeaderComponent={
 <>
 {/* Scans canonical header uses shared header token so all screens match. */}
 <View style={[styles.scansHeader, { height: (typeof insets?.top === 'number' ? insets.top : 0) + HEADER_CONTENT_HEIGHT, paddingTop: typeof insets?.top === 'number' ? insets.top : 0, backgroundColor: t.colors.headerBg ?? t.colors.headerBackground }]}>
 <View style={styles.headerContent}>
 <Text style={[styles.title, { color: t.colors.text }]}>Book Scanner</Text>
 <Text style={[styles.subtitle, { color: t.colors.textMuted }]}>Scan your bookshelf to build your library</Text>
 </View>
 </View>

 {/* Scan Limit Banner */}
 {user && (
 <ScanLimitBanner
 ref={scanLimitBannerRef}
 onUpgradePress={() => setShowUpgradeModal(true)}
 />
 )}


    {/* Upload-failed banner: show when any photo has status failed_upload (e.g. Network request failed). Retry resumes from Step B. */}
    {failedUploadCount > 0 && (
      <TouchableOpacity
        onPress={handleRetryAllFailed}
        style={[styles.importFailedBanner, { marginHorizontal: 12, marginBottom: 8 }]}
        activeOpacity={0.75}
      >
        <View style={styles.importFailedBannerInner}>
          <Text style={styles.importFailedBannerText}>
            {failedUploadCount === 1 ? '1 upload failed' : `${failedUploadCount} uploads failed`} — Retry from upload
          </Text>
        </View>
        <View style={styles.importFailedRetryChip}>
          <Text style={styles.importFailedRetryText}>Retry all</Text>
        </View>
      </TouchableOpacity>
    )}

    {/* Import-failed banners: one per queue item that completed on server but failed to import locally.
        Each banner has a "Tap to retry" button that re-runs the import without re-scanning. */}
    {scanQueue
      .filter(item => item.status === 'import_failed')
      .map(item => (
        <TouchableOpacity
          key={item.id}
          onPress={() => retryImportJob(item.id)}
          style={styles.importFailedBanner}
          activeOpacity={0.75}
        >
          <View style={styles.importFailedBannerInner}>
            <WarningIcon size={18} color="#92400e" style={{ marginRight: 8 }} />
            <Text style={styles.importFailedBannerText}>
              {item.errorMessage ?? 'Scan completed, but results failed to import. Tap to retry.'}
            </Text>
          </View>
          <View style={styles.importFailedRetryChip}>
            <Text style={styles.importFailedRetryText}>Retry</Text>
          </View>
        </TouchableOpacity>
      ))}

    {/* Import guest pending into library (after sign-in) */}
 {user && !isGuestUser(user) && guestPendingToImport && guestPendingToImport.length > 0 && (
 <View style={styles.importGuestBanner}>
 <Text style={styles.importGuestBannerText}>
 Import {guestPendingToImport.length} book{guestPendingToImport.length !== 1 ? 's' : ''} from your guest scan into your library?
 </Text>
 <View style={styles.importGuestBannerButtons}>
 <TouchableOpacity
 style={[styles.importGuestButton, styles.importGuestButtonPrimary]}
 onPress={importGuestPending}
 disabled={importingGuestPending}
 >
 <Text style={styles.importGuestButtonText}>
 {importingGuestPending ? 'Importing' : 'Import'}
 </Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.importGuestButton, styles.importGuestButtonSecondary]}
 onPress={() => setGuestPendingToImport(null)}
 disabled={importingGuestPending}
 >
 <Text style={styles.importGuestButtonTextSecondary}>Not now</Text>
 </TouchableOpacity>
 </View>
 </View>
 )}

 {/* Scan Options one row, two equal buttons */}
 {(() => {
 const checkGuestScanLimit = async (): Promise<boolean> => {
 if (!user || !isGuestUser(user)) return true;
 const hasUsedScan = await AsyncStorage.getItem('guest_scan_used');
 if (hasUsedScan === 'true') {
 navigation.navigate('MyLibrary' as never);
 return false;
 }
 return true;
 };
 return (
 <View style={styles.scanOptions}>
 <TouchableOpacity
 style={[styles.scanButton, { backgroundColor: t.colors.primary }]}
 onPress={async () => { if (await checkGuestScanLimit()) handleStartCamera(); }}
 activeOpacity={0.8}
 >
 <Text style={[styles.scanButtonText, { color: t.colors.primaryText }]}>Take Photo</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.scanButton, { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.colors.secondary }]}
 onPress={async () => { if (await checkGuestScanLimit()) pickImage(); }}
 activeOpacity={0.7}
 >
 <Text style={[styles.scanButtonText, { color: t.colors.text }]}>Upload</Text>
 </TouchableOpacity>
 </View>
 );
 })()}

 {/* Guest Scan Notification Bar - Only show for guest users, not signed-in users */}
 {user && isGuestUser(user) && (
 <View style={styles.guestScanNotification}>
 <Text style={styles.guestScanNotificationText}>
 {guestHasUsedScan 
 ? '0 free scans remaining. Sign in to continue scanning!'
 : 'You have 1 free scan before signing in'}
 </Text>
 </View>
 )}

 <View style={styles.scanResultsBlock}>
 {/* Pending Books full grid, 4 per row, all items visible; no carousel, no "See all" */}
 <View style={[
 styles.sectionBlock,
 styles.pendingSectionBlock,
 isScanningBarVisible && styles.sectionBlockWithScanning
 ]}>
 <View style={styles.pendingSectionHeader}>
 <View style={styles.pendingSectionHeaderLeft}>
 <Text style={[styles.sectionTitle, { color: t.colors.text }]}>Pending Books</Text>
 {pendingBooks.length > 0 && (
 <View style={[styles.countBadge, { backgroundColor: t.colors.secondary }]}>
 <Text style={[styles.countBadgeText, { color: t.colors.textMuted }]}>{pendingBooks.length}</Text>
 </View>
 )}
 </View>
 {pendingBooks.filter(book => book.status === 'pending').length > 3 && (() => {
 const allSelected = selectAllMode && excludedIds.size === 0;
 return (
 <TouchableOpacity
 style={styles.selectAllButton}
 onPress={allSelected ? unselectAllBooks : selectAllBooks}
 >
 {allSelected ? <CloseIcon size={14} color={t.colors.text} style={{ marginRight: 4 }} /> : <CheckboxOutlineIcon size={14} color={t.colors.text} style={{ marginRight: 4 }} />}
 <Text style={[styles.selectAllButtonText, { color: t.colors.text }]}>
 {allSelected ? 'Clear' : 'Select all'}
 </Text>
 </TouchableOpacity>
 );
 })()}
 </View>
 {pendingUnattachedToPhotoCount > 0 && (
   <View style={[styles.pendingUnattachedWarning, { backgroundColor: (t.colors as any).warningBg ?? t.colors.surface2, marginTop: 6 }]}>
     <WarningIcon size={14} color={t.colors.textMuted} style={{ marginRight: 6 }} />
     <Text style={[styles.pendingUnattachedWarningText, { color: t.colors.textMuted }]}>
       {pendingUnattachedToPhotoCount} pending item{pendingUnattachedToPhotoCount !== 1 ? 's' : ''} not linked to photos (sync may fix)
     </Text>
   </View>
 )}
 {/* Empty state: use raw pendingBooks count so books that exist but aren't yet grouped
 (e.g. id still undefined, grouping key not yet resolved) never show "Scan to get started". */}
 {pendingBooks.filter(b => b.status === 'pending' || b.status === 'incomplete').length === 0 ? (
 <TouchableOpacity
 style={styles.sectionEmptyState}
 onPress={handleStartCamera}
 activeOpacity={0.7}
 >
 <View style={[styles.emptyStateIconWrap, { backgroundColor: t.colors.surface2 }]}>
 <BookOutlineIcon size={28} color={t.colors.textHint ?? t.colors.textMuted} style={styles.sectionEmptyIcon} />
 </View>
 <Text style={[styles.sectionEmptyTitle, { color: t.colors.text }]}>Scan to get started</Text>
 <Text style={[styles.sectionEmptyHint, { color: t.colors.textHint ?? t.colors.textMuted }]}>Tap to scan or upload above</Text>
 </TouchableOpacity>
 ) : hasPendingRows ? (
 <>
 <Text style={[styles.sectionSubtitle, { color: t.colors.textMuted, marginBottom: 8 }]}>Tap to select. Use Add/Delete below.</Text>
 <View style={styles.sectionContentSpacer} />
 </>
 ) : null}
 </View>
 </View>
 </>
 }
 ListFooterComponent={recentScansFooter}
 />

 {/* Full list modal opened by "See all scans" */}
 <Modal
 visible={showAllScansModal}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => setShowAllScansModal(false)}
 >
 <SafeAreaView style={[styles.allScansModalContainer, { backgroundColor: t.colors.bg }]} edges={['top', 'left', 'right']}>
 <View style={[styles.allScansModalHeader, { borderBottomColor: t.colors.separator }]}>
 <TouchableOpacity
 onPress={() => setShowAllScansModal(false)}
 hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
 style={styles.allScansModalDoneButton}
 >
 <ChevronBackIcon size={20} color={t.colors.primary} style={{ marginRight: 4 }} />
 <Text style={[styles.viewPhotoLink, { color: t.colors.primary }]}>Done</Text>
 </TouchableOpacity>
 <Text style={[styles.sectionTitle, styles.allScansModalTitleCentered, { color: t.colors.text }]}>Recent Scans</Text>
 <View style={styles.headerSpacer} />
 </View>
 <ScrollView
 style={styles.allScansModalList}
 contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
 >
 {photos.length === 0 ? null : (() => {
 // Only show photos with approved books in the library (same rule as footer strip).
 const completePhotos = photos.filter((photo) => {
 if (photo.status === 'discarded' || (photo as any).deleted_at) return false;
 const hasApprovedBooks = photo.id ? approvedPhotoIds.has(photo.id) : false;
 const hasApprovedCount = typeof photo.approved_count === 'number' && photo.approved_count > 0;
 const hasApprovedInSnapshot = (photo.books ?? []).some(b => b.status === 'approved');
 return hasApprovedBooks || hasApprovedCount || hasApprovedInSnapshot;
 });
 const recentCanonical = dedupBy(completePhotos, canonicalPhotoListKey);
 // Normalize thumbnailUri once so list render never throws; PhotoTile uses fallback chain.
 const recentListFull = recentCanonical.slice().reverse().map((p) => ({
 photo: p,
 thumbnailUri: p.thumbnail_uri ?? p.uri ?? null,
 }));
 return recentListFull.map((item, photoIndex) => (
 <TouchableOpacity
 key={canonicalPhotoListKey(item.photo) || `ph_${photoIndex}`}
 style={[styles.photoRow, { borderBottomColor: t.colors.border }]}
 onPress={() => {
 setShowAllScansModal(false);
 // Defer so "See all" modal closes first; avoids scan not opening until user leaves the page.
 setTimeout(() => openScanModal(item.photo), 150);
 }}
 activeOpacity={0.7}
 >
 <PhotoTile
 photoId={item.photo.id}
 localUri={(item.photo as { local_uri?: string }).local_uri ?? (item.photo.uri?.startsWith?.('file://') ? item.photo.uri : null)}
 storagePath={item.photo.storage_path}
 fallbackUri={item.photo.uri}
 thumbnailUri={item.thumbnailUri}
 signedUrl={item.photo.signed_url}
 signedUrlExpiresAt={item.photo.signed_url_expires_at}
 status={item.photo.status}
 onRetryUpload={() => handleRetryUpload(item.photo.id)}
 style={[styles.photoThumbnail, { borderColor: t.colors.border }]}
 contentFit="cover"
 />
 <View style={styles.photoInfo}>
 <Text style={[styles.photoDate, { color: t.colors.text }]} numberOfLines={1}>
 {new Date(item.photo.timestamp).toLocaleDateString()}
 </Text>
 <Text style={[styles.photoBooks, { color: t.colors.textMuted }]} numberOfLines={1}>
 {item.photo.books?.length || 0} books found
 {item.photo.caption ? ` · ${item.photo.caption}` : ''}
 </Text>
 </View>
 <ChevronForwardIcon size={20} color={t.colors.textMuted} style={styles.photoRowChevron} />
 </TouchableOpacity>
 ));
 })()}
 </ScrollView>
 </SafeAreaView>
 </Modal>

 {/* Rejected Books section removed per request */}

 {/* Scan Details full-screen modal: immersive image + subtle top bar, swipe-down feel via Done */}
 <Modal
 visible={showScanModal && !!selectedPhoto}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={closeScanModal}
 >
 {selectedPhoto && (
 <View style={[styles.scanFullScreenContainer, { backgroundColor: t.colors.bg }]}>
 <ScrollView
 style={styles.scanFullScreenScroll}
 contentContainerStyle={[
 styles.scanFullScreenScrollContent,
 { paddingBottom: insets.bottom + 14 },
 ]}
 showsVerticalScrollIndicator={false}
 >
 {/* Photo full-width, cover crop; Back (top left) / Delete (top right) overlay on photo. If no image, show placeholder but keep tap targets. */}
 <View style={styles.scanDetailPhotoWrap}>
 <View style={[styles.scanDetailImageWrap, { aspectRatio: 4 / 3 }]}>
 {selectedPhoto.storage_path || selectedPhoto.uri ? (
 <PhotoTile
 photoId={selectedPhoto.id}
 localUri={(selectedPhoto as { local_uri?: string }).local_uri ?? (selectedPhoto.uri?.startsWith?.('file://') ? selectedPhoto.uri : null)}
 storagePath={selectedPhoto.storage_path}
 fallbackUri={selectedPhoto.uri}
 signedUrl={selectedPhoto.signed_url}
 signedUrlExpiresAt={selectedPhoto.signed_url_expires_at}
 status={selectedPhoto.status}
 onRetryUpload={() => handleRetryUpload(selectedPhoto.id)}
 style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
 contentFit="cover"
 />
 ) : (
 <View style={[StyleSheet.absoluteFill, styles.scanDetailPlaceholder, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}>
 <Text style={[styles.scanDetailPlaceholderText, { color: t.colors.textMuted }]}>Photo</Text>
 </View>
 )}
 </View>
 <LinearGradient
 colors={['rgba(0,0,0,0.26)', 'rgba(0,0,0,0.08)', 'transparent']}
 start={{ x: 0.5, y: 0 }}
 end={{ x: 0.5, y: 1 }}
 style={[styles.scanFullScreenBar, { paddingTop: insets.top }]}
 >
 <TouchableOpacity
 onPress={closeScanModal}
 style={[styles.scanFullScreenBarButton, styles.scanFullScreenBarPill]}
 hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
 >
 <ChevronBackIcon size={20} color="#FFFFFF" />
 <Text style={styles.scanFullScreenBarDoneText}>Back</Text>
 </TouchableOpacity>
 <TouchableOpacity
 onPress={() => {
 const _scanDeleteIntent = createDeleteIntent('user_delete_scan', 'ScansTab');
 Alert.alert(
 'Delete Scan',
 'This will delete the scan and all its incomplete books. Pending books will be removed. Continue?',
 [
 { text: 'Cancel', style: 'cancel' },
 { text: 'Delete', style: 'destructive', onPress: () => {
   _scanDeleteIntent.userConfirmed = true;
   if (!assertDeleteAllowed(_scanDeleteIntent)) return;
   logDeleteAudit(_scanDeleteIntent, { photoIds: [selectedPhoto.id], userId: user.uid });
   deleteScan(selectedPhoto.id);
 }}
 ]
 );
 }}
 style={[
 styles.scanFullScreenBarButton,
 styles.scanFullScreenBarPill,
 {
 backgroundColor: 'rgba(0,0,0,0.5)',
 borderWidth: 1,
 borderColor: 'rgba(255,255,255,0.25)',
 },
 ]}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <TrashIcon size={20} color={t.colors.headerIcon ?? t.colors.headerText ?? 'rgba(0,0,0,0.85)'} />
 </TouchableOpacity>
 </LinearGradient>
 </View>
 {/* Books found · divider · Detected books grid */}
 <View style={[styles.scanFullScreenMetaWrap, { borderTopColor: t.colors.separator, backgroundColor: t.colors.bg }]}>
 {(() => {
 const displayBooks = scanModalBooksFromJob ?? selectedPhoto.books ?? [];
 const displayCount = displayBooks.length;
 return (
 <>
 <View style={[styles.scanSheetMeta, { borderBottomColor: t.colors.separator }]}>
 <Text style={[styles.scanSheetMetaLabel, { color: t.colors.text }]}>
 Books from this Photo ({scanModalBooksLoading ? '' : displayCount})
 </Text>
 </View>
 {scanModalBooksLoading ? (
 <Text style={[styles.scanSheetLoading, { color: t.colors.textMuted }]}>Loading books</Text>
 ) : (
 <>
 <Text style={[styles.scanSheetGridTitle, { color: t.colors.textMuted }]}>Detected books</Text>
 <View style={styles.scanSheetGrid}>
 {displayBooks.map((book, index) => (
 <TouchableOpacity
 key={book.id ?? (book as any).tempId ?? `${(book as any).source_photo_id ?? 'noPhoto'}:${(book as any).book_key ?? getStableBookKey(book) ?? 'key'}:${index}`}
 style={styles.scanSheetGridItem}
 onPress={() => {
 const currentPhoto = selectedPhoto;
 const selectedBook = book;
 setShowScanModal(false);
 requestAnimationFrame(() => {
 (navigation as any).push('BookDetail', {
 bookId: selectedBook.dbId ?? selectedBook.id,
 book: selectedBook,
 photo: currentPhoto ?? null,
 });
 });
 }}
 onLongPress={() => {
 Alert.alert(
 'Remove book?',
 `Remove "${book.title || 'this book'}" from this scan?`,
 [
 { text: 'Cancel', style: 'cancel' },
 { text: 'Remove', style: 'destructive', onPress: () => removeBookFromScanDetail(book) },
 ]
 );
 }}
 activeOpacity={0.8}
 >
 {getBookCoverUri(book) ? (
 <Image source={{ uri: getBookCoverUri(book) }} style={styles.scanSheetGridCover} />
 ) : (
 <View style={[styles.scanSheetGridCover, styles.placeholderCover, { backgroundColor: t.colors.surface2 }]}>
 <Text style={[styles.placeholderText, { color: t.colors.textMuted }]} numberOfLines={3}>{book.title || 'Untitled'}</Text>
 </View>
 )}
 <Text style={[styles.scanSheetGridAuthorLine, { color: t.colors.textMuted }, !(book.author?.trim()) && (book.id ?? book.dbId) && { fontStyle: 'italic', opacity: 0.85 }]} numberOfLines={2} ellipsizeMode="tail">
 {book.author?.trim() ?? '—'}
 </Text>
 </TouchableOpacity>
 ))}
 </View>
 </>
 )}
 </>
 );
 })()}
 </View>
 </ScrollView>
 </View>
 )}
 </Modal>

 {/* Edit Incomplete Book Modal */}
 <Modal
 visible={showEditModal}
 animationType="none"
 presentationStyle="fullScreen"
 onRequestClose={() => {
 setShowEditModal(false);
 setEditingBook(null);
 setSearchQuery('');
 setSearchResults([]);
 setManualTitle('');
 setManualAuthor('');
 }}
 >
 <SafeAreaView style={styles.modalContainer}>
 <View style={styles.modalHeader}>
 <Text style={styles.modalTitle}>Edit Book Details</Text>
 <TouchableOpacity
 style={styles.modalCloseButton}
 onPress={() => {
 setShowEditModal(false);
 setEditingBook(null);
 setSearchQuery('');
 setSearchResults([]);
 }}
 >
 <Text style={styles.modalCloseText}>Cancel</Text>
 </TouchableOpacity>
 </View>

 {editingBook && (
 <ScrollView style={styles.modalContent}>
 <View style={styles.editSection}>
 <Text style={styles.editLabel}>Edit Book Title and Author:</Text>
 <Text style={styles.editSubLabel}>Enter the correct information to move this book to pending. Results update as you type.</Text>
 
 <Text style={styles.editLabel}>Title:</Text>
 <TextInput
 style={styles.editInput}
 value={manualTitle}
 onChangeText={setManualTitle}
 placeholder="Enter book title..."
 autoCapitalize="words"
 />
 
 <Text style={styles.editLabel}>Author:</Text>
 <TextInput
 style={styles.editInput}
 value={manualAuthor}
 onChangeText={setManualAuthor}
 placeholder="Enter author name..."
 autoCapitalize="words"
 />
 
 <TouchableOpacity
 style={[styles.saveManualButton, (!manualTitle.trim() || !manualAuthor.trim()) && styles.saveManualButtonDisabled]}
 onPress={async () => {
 if (!manualTitle.trim() || !manualAuthor.trim() || !selectedPhoto || !editingBook) {
 Alert.alert('Error', 'Please enter both title and author');
 return;
 }
 
 try {
 // Try to fetch cover based on the new title/author
 let coverUrl = editingBook.coverUrl;
 let googleBooksId = editingBook.googleBooksId;
 let localCoverPath = editingBook.localCoverPath;
 
 let statsData: any = {};
 try {
 // Use centralized service instead of direct API call
 const bookData = await fetchBookData(manualTitle.trim(), manualAuthor.trim(), undefined, editingBook.isbn);
 
 if (bookData.coverUrl && bookData.googleBooksId) {
 coverUrl = bookData.coverUrl;
 googleBooksId = bookData.googleBooksId;
 localCoverPath = await downloadAndCacheCover(coverUrl, googleBooksId);
 
 // Extract all stats data
 statsData = {
 ...(bookData.pageCount !== undefined && { pageCount: bookData.pageCount }),
 ...(bookData.categories && { categories: bookData.categories }),
 ...(bookData.publisher && { publisher: bookData.publisher }),
 ...(bookData.publishedDate && { publishedDate: bookData.publishedDate }),
 ...(bookData.language && { language: bookData.language }),
 ...(bookData.averageRating !== undefined && { averageRating: bookData.averageRating }),
 ...(bookData.ratingsCount !== undefined && { ratingsCount: bookData.ratingsCount }),
 ...(bookData.subtitle && { subtitle: bookData.subtitle }),
 ...(bookData.printType && { printType: bookData.printType }),
 ...(bookData.description && { description: bookData.description }),
 };
 }
 } catch (error) {
 logger.warn('Failed to fetch cover, using existing or none');
 }

 const sourceBooks = (selectedPhoto.jobId && scanModalBooksFromJob != null) ? scanModalBooksFromJob : selectedPhoto.books;
 const updatedBooks = sourceBooks.map(b =>
 b.id === editingBook.id
 ? {
 ...b,
 title: manualTitle.trim(),
 author: manualAuthor.trim(),
 coverUrl: coverUrl || b.coverUrl,
 googleBooksId: googleBooksId || b.googleBooksId,
 ...(localCoverPath && { localCoverPath }),
 ...statsData, // Include all stats data
 status: 'pending' as const, // Change from incomplete to pending
 }
 : b
 );

 const updatedPhotos = photos.map(photo =>
 photo.id === selectedPhoto.id
 ? { ...photo, books: updatedBooks }
 : photo
 );

 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 setSelectedPhoto({ ...selectedPhoto, books: updatedBooks });
 if (selectedPhoto.jobId) setScanModalBooksFromJob(updatedBooks);
 
 // Move to pending books
 const updatedBook = updatedBooks.find(b => b.id === editingBook.id);
 if (updatedBook && updatedBook.status === 'pending') {
 const bookIdsFromScan = new Set(updatedBooks.map(b => b.id));
 const wasInPending = pendingBooks.some(b => b.id === updatedBook.id);
 if (!wasInPending) {
 const newPending = [...pendingBooks, updatedBook];
 setPendingBooks(newPending);
 await saveUserData(newPending, approvedBooks, rejectedBooks, updatedPhotos);
 } else {
 await saveUserData(pendingBooks, approvedBooks, rejectedBooks, updatedPhotos);
 }
 }

 Alert.alert('Success', 'Book details updated! It can now be added to your library.');
 setShowEditModal(false);
 setEditingBook(null);
 setSearchQuery('');
 setSearchResults([]);
 setManualTitle('');
 setManualAuthor('');
 } catch (error) {
 logger.error('Error updating book:', error);
 Alert.alert('Error', 'Failed to update book. Please try again.');
 }
 }}
 disabled={!manualTitle.trim() || !manualAuthor.trim()}
 >
 <Text style={styles.saveManualButtonText}>Save Changes</Text>
 </TouchableOpacity>
 </View>

 <View style={styles.editSection}>
 <Text style={styles.editDivider}>OR</Text>
 </View>

 <View style={styles.editSection}>
 <Text style={styles.editLabel}>Search for correct book:</Text>
 <TextInput
 style={styles.searchInput}
 value={searchQuery}
 onChangeText={setSearchQuery}
 placeholder="Enter book title..."
 autoCapitalize="words"
 />
 <TouchableOpacity
 style={styles.searchButton}
 onPress={async () => {
 // Manual trigger remains, but auto-search already runs as you type
 const titleQ = manualTitle.trim();
 const authorQ = manualAuthor.trim();
 const q = [titleQ, authorQ].filter(Boolean).join(' ');
 if (!q) return;
 setIsSearching(true);
 try {
 // Use proxy API route to get API key and rate limiting
 const baseUrl = getApiBaseUrl();
 const response = await fetch(
 `${baseUrl}/api/google-books?path=/volumes&q=${encodeURIComponent(q)}&maxResults=10`
 );
 const data = await response.json();
 setSearchResults(data.items || []);
 } catch (error) {
 logger.error('Search failed:', error);
 Alert.alert('Error', 'Failed to search books. Please try again.');
 } finally {
 setIsSearching(false);
 }
 }}
 >
 <Text style={styles.searchButtonText}>
 {isSearching ? 'Searching...' : 'Search'}
 </Text>
 </TouchableOpacity>
 </View>

 {searchResults.length > 0 && (
 <View style={styles.searchResultsSection}>
 <Text style={styles.editLabel}>Select the correct book:</Text>
 {searchResults.map((item, index) => {
 const volumeInfo = item.volumeInfo || {};
 const coverUrl = volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:');
 return (
 <TouchableOpacity
 key={item.id || index}
 style={styles.searchResultCard}
 onPress={async () => {
 // Update the book in the photo
 if (selectedPhoto && editingBook) {
 // Cache the cover if available
 let localCoverPath = null;
 if (coverUrl && item.id) {
 localCoverPath = await downloadAndCacheCover(coverUrl, item.id);
 }

 const sourceBooks = (selectedPhoto.jobId && scanModalBooksFromJob != null) ? scanModalBooksFromJob : selectedPhoto.books;
 const updatedBooks = sourceBooks.map(b =>
 b.id === editingBook.id
 ? {
 ...b,
 title: volumeInfo.title || editingBook.title,
 author: volumeInfo.authors?.[0] || 'Unknown',
 coverUrl: coverUrl || b.coverUrl,
 googleBooksId: item.id,
 ...(localCoverPath && { localCoverPath }),
 // Include all stats from Google Books API
 ...(volumeInfo.pageCount && { pageCount: volumeInfo.pageCount }),
 ...(volumeInfo.categories && { categories: volumeInfo.categories }),
 ...(volumeInfo.publisher && { publisher: volumeInfo.publisher }),
 ...(volumeInfo.publishedDate && { publishedDate: volumeInfo.publishedDate }),
 ...(volumeInfo.language && { language: volumeInfo.language }),
 ...(volumeInfo.averageRating && { averageRating: volumeInfo.averageRating }),
 ...(volumeInfo.ratingsCount && { ratingsCount: volumeInfo.ratingsCount }),
 ...(volumeInfo.subtitle && { subtitle: volumeInfo.subtitle }),
 ...(volumeInfo.printType && { printType: volumeInfo.printType }),
 ...(volumeInfo.description && { description: volumeInfo.description }),
 status: 'pending' as const, // Change from incomplete to pending
 }
 : b
 );

 // Update the photo in photos array
 const updatedPhotos = photos.map(photo =>
 photo.id === selectedPhoto.id
 ? { ...photo, books: updatedBooks }
 : photo
 );

 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 setSelectedPhoto({ ...selectedPhoto, books: updatedBooks });
 if (selectedPhoto.jobId) setScanModalBooksFromJob(updatedBooks);
 await saveUserData(pendingBooks, approvedBooks, rejectedBooks, updatedPhotos);

 // Also move it from incomplete to pending if needed
 const updatedBook = updatedBooks.find(b => b.id === editingBook.id);
 if (updatedBook && updatedBook.status === 'pending') {
 const bookIdsFromScan = new Set(updatedBooks.map(b => b.id));
 const wasInPending = pendingBooks.some(b => bookIdsFromScan.has(b.id));
 if (!wasInPending) {
 setPendingBooks([...pendingBooks, updatedBook]);
 await saveUserData([...pendingBooks, updatedBook], approvedBooks, rejectedBooks, updatedPhotos);
 }
 }

 Alert.alert('Success', 'Book details updated!');
 setShowEditModal(false);
 setEditingBook(null);
 setSearchQuery('');
 setSearchResults([]);
 }
 }}
 >
 {coverUrl && (
 <Image source={{ uri: coverUrl }} style={styles.searchResultCover} />
 )}
 <View style={styles.searchResultInfo}>
 <Text style={styles.bookTitle}>{volumeInfo.title || 'Unknown Title'}</Text>
 <Text style={styles.bookAuthor}>
 by {volumeInfo.authors?.[0] || 'Unknown Author'}
 </Text>
 {volumeInfo.publishedDate && (
 <Text style={styles.searchResultDate}>
 Published: {volumeInfo.publishedDate}
 </Text>
 )}
 </View>
 </TouchableOpacity>
 );
 })}
 </View>
 )}
 </ScrollView>
 )}
 </SafeAreaView>
 </Modal>

 {/* Collection Selection Modal */}
 <Modal
 visible={showFolderModal}
 animationType="fade"
 presentationStyle="fullScreen"
 onRequestClose={() => {
 setShowFolderModal(false);
 setNewFolderName('');
 }}
 transparent={false}
 >
      <SafeAreaView style={styles.folderModalContainer} edges={['top']}>
        <View style={[styles.folderModalHeader, { paddingTop: insets.top + 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.divider ?? t.colors.border }]}>
          <Text style={[styles.modalTitle, { color: t.colors.text }]}>Add to Collection</Text>
          <TouchableOpacity
            style={styles.folderModalBackButton}
            onPress={() => {
              setShowFolderModal(false);
              setNewFolderName('');
            }}
          >
            <Text style={[styles.folderModalBackText, { color: t.colors.primary }]}>Back</Text>
          </TouchableOpacity>
        </View>
 
 <ScrollView style={styles.folderModalContent} showsVerticalScrollIndicator={false}>
 {/* Create Collection Section - Always visible */}
 <View style={styles.createFolderSection}>
 <Text style={styles.createFolderTitle}>Create New Collection</Text>
 <View style={styles.createFolderRow}>
 <TextInput
 style={styles.createFolderInput}
 value={newFolderName}
 onChangeText={setNewFolderName}
 placeholder="Collection name..."
 autoCapitalize="words"
 autoFocus={folders.length === 0}
 />
 <TouchableOpacity
 style={[styles.createFolderButton, !newFolderName.trim() && styles.createFolderButtonDisabled]}
 onPress={createFolder}
 activeOpacity={0.8}
 disabled={!newFolderName.trim()}
 >
 <Text style={styles.createFolderButtonText}>Create</Text>
 </TouchableOpacity>
 </View>
 </View>

 {/* Existing Collections */}
 {folders.length > 0 && (
 <View style={styles.existingFoldersSection}>
 <Text style={styles.existingFoldersTitle}>Select Collection</Text>
 {folders.map((folder) => (
 <TouchableOpacity
 key={folder.id}
 style={[
 styles.folderItem,
 selectedFolderId === folder.id && styles.folderItemSelected
 ]}
 onPress={() => setSelectedFolderId(folder.id)}
 activeOpacity={0.7}
 >
 <FolderIcon size={24} color={selectedFolderId === folder.id ? t.colors.primary : t.colors.muted} style={{ marginRight: 12 }} />
 <View style={{ flex: 1 }}>
 <Text style={[
 styles.folderItemName,
 selectedFolderId === folder.id && styles.folderItemNameSelected
 ]}>
 {folder.name}
 </Text>
 <Text style={styles.folderItemCount}>
 {folder.bookIds.length} {folder.bookIds.length === 1 ? 'book' : 'books'}
 </Text>
 </View>
 {selectedFolderId === folder.id && (
 <CheckmarkCircleIcon size={24} color={t.colors.primary} />
 )}
 </TouchableOpacity>
 ))}
 </View>
 )}

 {/* Action Buttons */}
 <View style={styles.folderModalActions}>
 <TouchableOpacity
 style={[styles.folderActionButton, styles.folderSkipButton]}
 onPress={() => handleFolderSelection(null)}
 activeOpacity={0.8}
 >
 <Text style={styles.folderSkipButtonText}>Skip</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[
 styles.folderActionButton,
 styles.folderConfirmButton,
 !selectedFolderId && styles.folderConfirmButtonDisabled
 ]}
 onPress={() => handleFolderSelection(selectedFolderId || null)}
 activeOpacity={0.8}
 disabled={!selectedFolderId}
 >
 <Text style={styles.folderConfirmButtonText}>Continue</Text>
 </TouchableOpacity>
 </View>
 </ScrollView>
 </SafeAreaView>
 </Modal>

 </SafeAreaView>
 
{/* BottomDock is rendered at the TabNavigator root via BottomDockContext (injected
    by the useEffect above). No inline dock View here — that was the cause of the
    bar floating in the middle of the screen. */}

 {/* Upgrade Modal */}
 <UpgradeModal
 visible={showUpgradeModal}
 onClose={() => {
 setShowUpgradeModal(false);
 loadScanUsage(); // Refresh usage after closing
 }}
 onUpgradeComplete={() => {
 setShowUpgradeModal(false);
 loadScanUsage(); // Refresh usage after upgrade
 }}
 />

 <AuthGateModal
 visible={showAuthGateModal}
 onClose={() => setShowAuthGateModal(false)}
 onSignIn={() => {
 setShowAuthGateModal(false);
 navigation.navigate('MyLibrary' as never);
 }}
 onCreateAccount={() => {
 setShowAuthGateModal(false);
 navigation.navigate('MyLibrary' as never);
 }}
 />

 {/* Edit Cover Modal: current cover preview + Change Cover / Remove Cover. Themed, one-pane + dividers. */}
 <Modal
 visible={showEditCoverModal}
 animationType="slide"
 presentationStyle="pageSheet"
 onRequestClose={() => setShowEditCoverModal(false)}
 >
 <SafeAreaView style={[styles.modalContainer, { backgroundColor: t.colors.bg }]} edges={['top']}>
 <View style={[styles.modalHeader, { paddingTop: insets.top + 12, paddingBottom: 16, backgroundColor: t.colors.surface, borderBottomColor: t.colors.divider ?? t.colors.border }]}>
 <Text style={[styles.modalTitle, { color: t.colors.text }]}>Edit Cover</Text>
 <TouchableOpacity
 style={[styles.modalCloseButton, { backgroundColor: t.colors.primary }]}
 onPress={() => setShowEditCoverModal(false)}
 >
 <Text style={styles.modalCloseText}>Done</Text>
 </TouchableOpacity>
 </View>
{selectedPendingBook != null && (() => {
const book = selectedPendingBook;
return (
<ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
<View style={[styles.editCoverSection, { backgroundColor: t.colors.bg, borderBottomColor: t.colors.divider ?? t.colors.border }]}>
<Text style={[styles.editCoverSectionTitle, { color: t.colors.textMuted }]}>Current cover</Text>
 <View style={[styles.editCoverPreviewCard, { backgroundColor: t.colors.surface }]}>
 {getBookCoverUri(book) ? (
 <Image source={{ uri: getBookCoverUri(book) }} style={styles.editCoverPreviewImage} />
 ) : (
 <View style={[styles.editCoverPreviewImage, styles.editCoverPlaceholder, { backgroundColor: t.colors.surface2 }]}>
 <Text style={[styles.editCoverPlaceholderText, { color: t.colors.textMuted }]} numberOfLines={3}>{book.title}</Text>
 </View>
 )}
 <View style={styles.editCoverPreviewInfo}>
 <Text style={[styles.editCoverPreviewTitle, { color: t.colors.text }]} numberOfLines={2}>{book.title}</Text>
 {book.author ? <Text style={[styles.editCoverPreviewAuthor, { color: t.colors.textMuted }]} numberOfLines={1}>{book.author}</Text> : null}
 </View>
 </View>
 </View>
 <View style={[styles.editCoverSection, { backgroundColor: t.colors.surface, borderBottomColor: t.colors.divider ?? t.colors.border }]}>
 <Pressable
 style={({ pressed }) => [styles.editCoverActionRow, { backgroundColor: t.colors.surface }, pressed && { opacity: 0.7 }]}
 onPress={() => {
 setShowEditCoverModal(false);
 if (selectedId != null) handleSwitchCovers(selectedId);
 }}
 >
 <SwapHorizontalIcon size={22} color={t.colors.primary ?? t.colors.text} />
 <View style={styles.editCoverActionTextWrap}>
 <Text style={[styles.editCoverActionLabel, { color: t.colors.text }]}>Change Cover</Text>
 <Text style={[styles.editCoverActionHint, { color: t.colors.textMuted }]}>Search and choose another cover</Text>
 </View>
 <ChevronForwardIcon size={20} color={t.colors.textMuted} />
 </Pressable>
 </View>
 <View style={[styles.editCoverSection, { backgroundColor: t.colors.surface }]}>
 <Pressable
 style={({ pressed }) => [styles.editCoverActionRow, { backgroundColor: t.colors.surface }, pressed && { opacity: 0.7 }]}
 onPress={() => {
 if (selectedId != null) {
 setShowEditCoverModal(false);
 handleRemoveCover(selectedId);
 Alert.alert('Cover removed', 'The cover has been removed from this book.');
 }
 }}
 >
 <ImageOutlineIcon size={22} color={t.colors.text} />
 <View style={styles.editCoverActionTextWrap}>
 <Text style={[styles.editCoverActionLabel, { color: t.colors.text }]}>Remove Cover</Text>
 <Text style={[styles.editCoverActionHint, { color: t.colors.textMuted }]}>Set cover to placeholder</Text>
 </View>
 <ChevronForwardIcon size={20} color={t.colors.textMuted} />
 </Pressable>
 </View>
 </ScrollView>
 );
 })()}
 </SafeAreaView>
 </Modal>

 {/* Switch Covers Modal */}
 <Modal
 visible={showSwitchCoversModal}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => {
 setShowSwitchCoversModal(false);
 setCoverSearchResults([]);
 }}
 >
 <SafeAreaView style={styles.modalContainer} edges={['top']}>
 <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
 <Text style={styles.modalTitle}>Switch Cover</Text>
 <TouchableOpacity
 style={styles.modalCloseButton}
 onPress={() => {
 setShowSwitchCoversModal(false);
 setCoverSearchResults([]);
 }}
 >
 <Text style={styles.modalCloseText}>Done</Text>
 </TouchableOpacity>
 </View>
 
{selectionMode === 'single' && selectedPendingBook != null && (() => {
const book = selectedPendingBook;
return (
<ScrollView style={styles.modalContent}>
<View style={styles.switchCoversHeader}>
 <Text style={styles.switchCoversTitle}>Current Book</Text>
 <View style={styles.currentBookCard}>
 {getBookCoverUri(book) ? (
 <Image 
 source={{ uri: getBookCoverUri(book) }} 
 style={styles.currentBookCover}
 />
 ) : (
 <View style={[styles.currentBookCover, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={3}>
 {book.title}
 </Text>
 </View>
 )}
 <View style={styles.currentBookInfo}>
 <Text style={styles.currentBookTitle}>{book.title}</Text>
 <Text style={[styles.currentBookAuthor, !book.author && (book.id ?? book.dbId) && { fontStyle: 'italic', opacity: 0.85 }]}>{book.author ?? '—'}</Text>
 </View>
 </View>
 </View>

 <View style={styles.switchCoversSection}>
 <Text style={styles.switchCoversSectionTitle}>Available Covers</Text>
 {isLoadingCovers ? (
 <View style={styles.loadingContainer}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 <Text style={styles.loadingText}>Searching for covers...</Text>
 </View>
 ) : coverSearchResults.length === 0 ? (
 <View style={styles.emptyContainer}>
 <Text style={styles.emptyText}>No covers found</Text>
 </View>
 ) : (
 <View style={styles.coversGrid}>
 {coverSearchResults.map((result, index) => (
 <TouchableOpacity
 key={result.googleBooksId || index}
 style={styles.coverOption}
 onPress={() => handleSelectCover(result)}
 activeOpacity={0.7}
 >
 {result.coverUrl ? (
 <Image 
 source={{ uri: result.coverUrl }} 
 style={styles.coverOptionImage}
 />
 ) : (
 <View style={[styles.coverOptionImage, styles.placeholderCover]}>
 <Text style={styles.placeholderText}>No Cover</Text>
 </View>
 )}
 </TouchableOpacity>
 ))}
 </View>
 )}
 </View>
 </ScrollView>
 );
 })()}
 </SafeAreaView>
 </Modal>

 {/* Switch Book Modal */}
 <Modal
 visible={showSwitchBookModal}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => {
 // Clear search timeout
 if (searchTimeoutRef.current) {
 clearTimeout(searchTimeoutRef.current);
 searchTimeoutRef.current = null;
 }
 setShowSwitchBookModal(false);
 setBookSearchQuery('');
 setBookSearchResults([]);
 }}
 >
 <SafeAreaView style={styles.modalContainer} edges={['top']}>
 <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
 <Text style={styles.modalTitle}>Switch Book</Text>
 <TouchableOpacity
 style={styles.modalCloseButton}
 onPress={() => {
 // Clear search timeout
 if (searchTimeoutRef.current) {
 clearTimeout(searchTimeoutRef.current);
 searchTimeoutRef.current = null;
 }
 setShowSwitchBookModal(false);
 setBookSearchQuery('');
 setBookSearchResults([]);
 }}
 >
 <Text style={styles.modalCloseText}>Done</Text>
 </TouchableOpacity>
 </View>
 
 <View style={styles.modalContent}>
 <View style={styles.searchContainer}>
 <TextInput
 style={styles.switchBookSearchInput}
 placeholder="Search for a book..."
 value={bookSearchQuery}
 onChangeText={(text) => {
 setBookSearchQuery(text);
 // Debounce search
 if (searchTimeoutRef.current) {
 clearTimeout(searchTimeoutRef.current);
 }
 searchTimeoutRef.current = setTimeout(() => {
 searchBooks(text);
 }, 500);
 }}
 autoCapitalize="words"
 autoCorrect={false}
 />
 {isSearchingBooks && (
 <ActivityIndicator size="small" color={t.colors.primary} style={{ marginLeft: 10 }} />
 )}
 </View>

{selectionMode === 'single' && selectedPendingBook != null && (() => {
const book = selectedPendingBook;
return (
<View style={styles.switchBookHeader}>
 <Text style={styles.switchBookHeaderTitle}>Replacing:</Text>
 <View style={styles.currentBookCard}>
 {getBookCoverUri(book) ? (
 <Image 
 source={{ uri: getBookCoverUri(book) }} 
 style={styles.currentBookCoverSmall}
 />
 ) : (
 <View style={[styles.currentBookCoverSmall, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={2}>
 {book.title}
 </Text>
 </View>
 )}
 <View style={styles.currentBookInfo}>
 <Text style={styles.currentBookTitle}>{book.title}</Text>
 <Text style={[styles.currentBookAuthor, !book.author && (book.id ?? book.dbId) && { fontStyle: 'italic', opacity: 0.85 }]}>{book.author ?? '—'}</Text>
 </View>
 </View>
 </View>
 );
 })()}

 <ScrollView style={styles.searchResultsContainer}>
 {bookSearchResults.length === 0 && bookSearchQuery.trim() ? (
 <View style={styles.emptyContainer}>
 <Text style={styles.emptyText}>No books found</Text>
 </View>
 ) : (
 bookSearchResults.map((result, index) => (
 <TouchableOpacity
 key={result.googleBooksId || index}
 style={styles.bookSearchResult}
 onPress={() => handleSelectBook(result)}
 activeOpacity={0.7}
 >
 {result.coverUrl ? (
 <Image 
 source={{ uri: result.coverUrl }} 
 style={styles.bookSearchResultCover}
 />
 ) : (
 <View style={[styles.bookSearchResultCover, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={2}>
 {result.title}
 </Text>
 </View>
 )}
 <View style={styles.bookSearchResultInfo}>
 <Text style={styles.bookSearchResultTitle}>{result.title}</Text>
 {result.author && (
 <Text style={styles.bookSearchResultAuthor}>{result.author}</Text>
 )}
 {'publishedDate' in result && result.publishedDate && (
 <Text style={styles.bookSearchResultDate}>{String(result.publishedDate)}</Text>
 )}
 </View>
 </TouchableOpacity>
 ))
 )}
 </ScrollView>
 </View>
 </SafeAreaView>
 </Modal>

 {/* ── Undo toast ────────────────────────────────────────────────────────── */}
 {/* Floats above everything. Appears after any soft-delete for UNDO_TOAST_MS. */}
 {undoToast && (
   <View
     pointerEvents="box-none"
     style={{
       position: 'absolute',
       bottom: insets.bottom + 90,
       left: 16,
       right: 16,
       backgroundColor: '#1c1c1e',
       borderRadius: 14,
       paddingVertical: 12,
       paddingHorizontal: 16,
       flexDirection: 'row',
       alignItems: 'center',
       gap: 10,
       shadowColor: '#000',
       shadowOffset: { width: 0, height: 4 },
       shadowOpacity: 0.3,
       shadowRadius: 10,
       elevation: 8,
     }}
   >
     <Text style={{ flex: 1, color: '#f5f5f5', fontSize: 14, lineHeight: 20 }} numberOfLines={2}>
       {undoToast.label}
     </Text>
     <Pressable
       onPress={async () => {
         const toastAction = undoToast;
         setUndoToast(null);
         if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
         try {
           const { data: sessionData } = await supabase.auth.getSession();
           const token = sessionData?.session?.access_token;
           if (!token) { Alert.alert('Undo failed', 'No active session.'); return; }
           const result = await undoLastDelete(getApiBaseUrl(), token, toastAction.action);
           if (result.ok) {
             lastDestructiveActionRef.current = null;
             loadUserData().catch(() => {});
             Alert.alert('Undone', `Restored ${result.restoredBooks} book${result.restoredBooks !== 1 ? 's' : ''}${result.restoredPhotos > 0 ? ` and ${result.restoredPhotos} photo${result.restoredPhotos !== 1 ? 's' : ''}` : ''}.`);
           } else {
             Alert.alert('Undo failed', result.error === 'undo_window_expired' ? 'The undo window has expired.' : 'Could not restore your data. Please try again.');
           }
         } catch (e) {
           Alert.alert('Undo failed', 'An error occurred. Please try again.');
         }
       }}
       hitSlop={12}
       style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)' }}
     >
       <Text style={{ color: '#f5f5f5', fontWeight: '700', fontSize: 14 }}>Undo</Text>
     </Pressable>
     <Pressable onPress={() => { setUndoToast(null); if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current); }} hitSlop={12}>
       <CloseIcon size={18} color="#9ca3af" />
     </Pressable>
   </View>
 )}
 </View>
 );
};

const getStyles = (
 screenWidth: number,
 t: ThemeTokens,
 pendingGridColumns: number,
 typeScale: number
) => StyleSheet.create({
 safeContainer: {
 flex: 1,
 position: 'relative',
 },
 container: {
 flex: 1,
 },
 /** Scans canonical header: parchment/off-white (t.colors.bg). Height/paddingTop set inline with insets. */
 scansHeader: {
 paddingBottom: 22,
 paddingHorizontal: 20,
 marginBottom: 12,
 width: '100%',
 },
 headerContent: {
 paddingTop: 18,
 },
 title: {
 fontSize: 22 * typeScale,
 fontWeight: '700',
 letterSpacing: 0.5,
 marginBottom: 6,
 },
 subtitle: {
 fontSize: 14 * typeScale,
 fontWeight: '400',
 },
 scanOptions: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 14,
 marginBottom: 2,
 gap: 12,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 scanButton: {
 flex: 1,
 paddingVertical: 14,
 paddingHorizontal: 16,
 borderRadius: 14,
 alignItems: 'center',
 justifyContent: 'center',
 shadowOpacity: 0,
 elevation: 0,
 },
 scanButtonPrimary: {
 borderWidth: 0,
 },
 scanButtonText: {
 fontSize: 15,
 fontWeight: '600',
 letterSpacing: 0.3,
 },
 scanButtonSecondary: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 gap: 6,
 paddingVertical: 12,
 paddingHorizontal: 14,
 borderRadius: 14,
 borderWidth: 1,
 },
 scanButtonSecondaryText: {
 fontSize: 14,
 fontWeight: '500',
 },
 scanButtonDisabled: {
 backgroundColor: t.colors.secondary,
 opacity: 0.6,
 shadowOpacity: 0,
 elevation: 0,
 borderWidth: 1,
 borderColor: t.colors.secondary,
 },
 scanButtonTextDisabled: {
 color: t.colors.textMuted, // Darker gray text when disabled for better visibility
 textDecorationLine: 'line-through',
 },
 guestScanNotification: {
 backgroundColor: t.colors.pendingChipBg, // Light yellow/amber background
 paddingVertical: 12,
 paddingHorizontal: 20,
 marginHorizontal: 20,
 marginTop: -10,
 marginBottom: 10,
 borderRadius: 12,
 borderWidth: 1,
 borderColor: t.colors.accent2, // Amber border
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.05,
 shadowRadius: 3,
 elevation: 2,
 },
 guestScanNotificationText: {
 color: t.colors.pendingChipText, // Dark amber text
 fontSize: 14,
 fontWeight: '500',
 textAlign: 'center',
 letterSpacing: 0.2,
 },
  importFailedBanner: {
    backgroundColor: '#fffbeb',
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  importFailedBannerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    flexShrink: 1,
  },
  importFailedBannerText: {
    color: '#92400e',
    fontSize: 13,
    flexShrink: 1,
    lineHeight: 18,
  },
  importFailedRetryChip: {
    backgroundColor: '#f59e0b',
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginLeft: 10,
  },
  importFailedRetryText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  importGuestBanner: {
    backgroundColor: t.colors.approvedChipBg,
 paddingVertical: 12,
 paddingHorizontal: 16,
 marginHorizontal: 20,
 marginBottom: 10,
 borderRadius: 12,
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 importGuestBannerText: {
 color: t.colors.primary,
 fontSize: 14,
 fontWeight: '500',
 marginBottom: 10,
 },
 importGuestBannerButtons: {
 flexDirection: 'row',
 gap: 10,
 },
 importGuestButton: {
 paddingVertical: 8,
 paddingHorizontal: 16,
 borderRadius: 8,
 },
 importGuestButtonPrimary: {
 backgroundColor: t.colors.primary,
 },
 importGuestButtonText: {
 color: t.colors.primaryText,
 fontSize: 14,
 fontWeight: '600',
 },
 importGuestButtonSecondary: {
 backgroundColor: t.colors.surface2,
 },
 importGuestButtonTextSecondary: {
 color: t.colors.textMuted,
 fontSize: 14,
 fontWeight: '600',
 },
 cameraContainer: {
 flex: 1,
 backgroundColor: 'black',
 },
 camera: {
 flex: 1,
 },
 cameraOverlay: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 bottom: 0,
 backgroundColor: 'transparent',
 justifyContent: 'space-between',
 pointerEvents: 'box-none',
 },
 cameraEdgeGradientLeft: {
 position: 'absolute',
 left: 0,
 top: 0,
 bottom: 0,
 width: Math.round(screenWidth * 0.08),
 pointerEvents: 'none',
 },
 cameraEdgeGradientRight: {
 position: 'absolute',
 right: 0,
 top: 0,
 bottom: 0,
 width: Math.round(screenWidth * 0.08),
 pointerEvents: 'none',
 },
 cameraTipBanner: {
 backgroundColor: t.name === 'scriptoriumDark' ? 'rgba(0,0,0,0.42)' : 'rgba(0,0,0,0.3)',
 paddingHorizontal: 20,
 paddingVertical: 12,
 marginHorizontal: 16,
 maxWidth: '80%',
 borderRadius: 26,
 alignItems: 'center',
 alignSelf: 'center',
 pointerEvents: 'none',
 },
 cameraTipText: {
 color: '#FFFFFF',
 fontSize: 12,
 fontWeight: '400',
 textAlign: 'center',
 letterSpacing: 0.2,
 textShadowColor: 'rgba(0,0,0,0.5)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 cameraTipTextSecondary: {
 marginTop: 2,
 fontSize: 11,
 opacity: 0.95,
 color: '#FFFFFF',
 textShadowColor: 'rgba(0,0,0,0.5)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 cameraCloseButton: {
 position: 'absolute',
 left: 16,
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 10,
 paddingRight: 12,
 zIndex: 100,
 pointerEvents: 'auto',
 },
 cameraCloseButtonText: {
 color: 'rgba(255, 255, 255, 0.95)',
 fontSize: 17,
 fontWeight: '500',
 },
 controlRail: {
 position: 'absolute',
 right: 16,
 top: '50%',
 transform: [{ translateY: -100 }],
 backgroundColor: 'rgba(0,0,0,0.42)',
 borderWidth: 1,
 borderColor: 'rgba(255,255,255,0.15)',
 borderRadius: 20,
 paddingVertical: 12,
 paddingHorizontal: 10,
 alignItems: 'center',
 justifyContent: 'center',
 pointerEvents: 'auto',
 },
 controlRailItem: {
 width: 40,
 height: 36,
 justifyContent: 'center',
 alignItems: 'center',
 },
 controlRailZoomLabel: {
 color: '#FFFFFF',
 fontSize: 15,
 fontWeight: '600',
 marginVertical: 2,
 minWidth: 36,
 textAlign: 'center',
 },
 cameraControls: {
 alignItems: 'center',
 paddingBottom: 40,
 paddingTop: 20,
 pointerEvents: 'auto',
 },
 cameraShutterHint: {
 marginTop: 10,
 fontSize: 12,
 color: 'rgba(255, 255, 255, 0.6)',
 textAlign: 'center',
 paddingHorizontal: 24,
 },
 captureButton: {
 width: 80,
 height: 80,
 borderRadius: 40,
 backgroundColor: 'transparent',
 justifyContent: 'center',
 alignItems: 'center',
 borderWidth: 4,
 borderColor: t.colors.primary,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 6,
 elevation: 3,
 },
 captureButtonDisabled: {
 opacity: 0.5,
 },
 captureButtonInner: {
 width: 64,
 height: 64,
 borderRadius: 32,
 backgroundColor: '#FFFFFF',
 borderWidth: 0,
 },
 queueSection: {
 backgroundColor: t.colors.surface, // White card
 marginHorizontal: 15,
 marginBottom: 20,
 borderRadius: 16,
 padding: 20,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.06,
 shadowRadius: 8,
 elevation: 3,
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 },
 contentSection: {
 paddingHorizontal: 20,
 paddingTop: 20,
 paddingBottom: 20,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 /** Section on same background: spacing only, no card. */
 sectionBlock: {
 marginTop: 16,
 paddingHorizontal: 20,
 paddingTop: 16,
 paddingBottom: 16,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 /** Wrap all scan results so Pending + Recent read as one block. */
 scanResultsBlock: {
 marginTop: 0,
 },
 /** First section under scan options: spacing so Pending Books is clearly grouped. */
 pendingSectionBlock: {
 marginTop: 12,
 paddingTop: 12,
 paddingBottom: 4,
 },
 /** Subtle divider + tight spacing between Pending Books and Recent Scans (~20px total). */
 recentScansSection: {
 marginTop: 6,
 paddingTop: 12,
 borderTopWidth: 1,
 borderTopColor: t.colors.divider ?? t.colors.border,
 },
 sectionDivider: {
 height: StyleSheet.hairlineWidth,
 backgroundColor: t.colors.divider ?? t.colors.border,
 marginHorizontal: 20,
 marginVertical: 16,
 },
 sectionBlockWithScanning: {
 marginBottom: 0,
 paddingBottom: 0,
 },
 /** Space between helper text and content list/grid. */
 sectionContentSpacer: {
 height: 12,
 },
 /** Pending Books header: [Pending Books + count] left, [Select all] right. */
 pendingSectionHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 2,
 },
 pendingSectionHeaderLeft: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 8,
 },
 pendingTitleRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 flexWrap: 'wrap',
 gap: 8,
 marginBottom: 4,
 },
 pendingActionsInline: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 8,
 },
 sectionHeaderRow: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 10,
 marginBottom: 6,
 },
 /** Section header: title left, count pill right (e.g. Pending Books; no "See all" all items visible). */
 sectionHeaderWithAction: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 2,
 },
 sectionTitle: {
 fontSize: 18 * typeScale,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 recentScansCount: {
 fontSize: 15,
 fontWeight: '500',
 },
 countBadge: {
 paddingHorizontal: 8,
 paddingVertical: 4,
 borderRadius: 10,
 minWidth: 24,
 alignItems: 'center',
 },
 countBadgeText: {
 fontSize: 13,
 fontWeight: '600',
 },
 pendingUnattachedWarning: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 6,
 paddingHorizontal: 10,
 borderRadius: 8,
 },
 pendingUnattachedWarningText: {
 fontSize: 12,
 fontWeight: '500',
 flex: 1,
 },
 sectionSubtitle: {
 fontSize: 12 * typeScale,
 fontWeight: '500',
 marginBottom: 0,
 },
 /** Shared empty state: tight, right under section header; no floating panel feel. */
 sectionEmptyState: {
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 16,
 },
 /** Recent Scans empty: more breathing room, cleaner icon. */
 recentScansEmptyState: {
 paddingVertical: 24,
 paddingHorizontal: 24,
 minHeight: 120,
 },
 recentScansEmptyIconWrap: {
 alignSelf: 'center',
 width: 64,
 height: 64,
 borderRadius: 32,
 alignItems: 'center',
 justifyContent: 'center',
 marginBottom: 12,
 borderWidth: 1,
 },
 /** Faint wash behind icon only (not a card). */
 emptyStateIconWrap: {
 alignSelf: 'center',
 padding: 10,
 borderRadius: 16,
 marginBottom: 6,
 },
 sectionEmptyIcon: {
 marginBottom: 0,
 },
 sectionEmptyTitle: {
 fontSize: 14,
 fontWeight: '600',
 marginBottom: 2,
 },
 sectionEmptyHint: {
 fontSize: 12,
 fontWeight: '500',
 },
 /** Small link under empty state (e.g. "Upload instead"). */
 emptyStateLink: {
 marginTop: 8,
 fontSize: 13,
 fontWeight: '500',
 },
 /** Primary CTA in empty state (e.g. "Take Photo"). */
 emptyStateCta: {
 marginTop: 16,
 paddingVertical: 14,
 paddingHorizontal: 24,
 borderRadius: 14,
 alignItems: 'center',
 minWidth: 160,
 shadowOpacity: 0,
 elevation: 0,
 },
 emptyStateCtaText: {
 fontSize: 16,
 fontWeight: '700',
 },
 /** Horizontal preview row of covers/thumbs on dashboard. */
 previewRow: {
 flexDirection: 'row',
 gap: 12,
 paddingVertical: 4,
 },
 previewBookWrap: {
 width: 56,
 alignItems: 'center',
 },
 previewBookCover: {
 width: 56,
 aspectRatio: 2 / 3,
 borderRadius: 8,
 backgroundColor: t.colors.surface2,
 },
 previewScanThumb: {
 width: 56,
 height: 56,
 borderRadius: 10,
 borderWidth: 1,
 overflow: 'hidden',
 },
 recentThumbGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 12,
 paddingTop: 6,
 paddingBottom: 8,
 },
 /** Horizontal strip of scan cards (same left edge as "See all scans" row; no wrap). */
 recentScanStrip: {
 paddingTop: 6,
 paddingBottom: 8,
 },
 recentScanStripContent: {
 paddingRight: 20,
 },
 recentScanStripItem: {
 marginRight: 12,
 },
 recentThumbCard: {
 width: 56,
 alignItems: 'center',
 },
 recentThumbDate: {
 marginTop: 6,
 fontSize: 10,
 fontWeight: '500',
 },
 emptySectionText: {
 fontSize: 14,
 marginTop: 8,
 marginBottom: 8,
 paddingVertical: 8,
 },
 photoRow: {
 flexDirection: 'row',
 paddingVertical: 12,
 paddingHorizontal: 0,
 alignItems: 'center',
 borderBottomWidth: 1,
 },
 photoThumbnail: {
 width: 56,
 height: 56,
 borderRadius: 10,
 marginRight: 14,
 borderWidth: 1,
 overflow: 'hidden',
 },
 photoInfo: {
 flex: 1,
 minWidth: 0,
 },
 photoDate: {
 fontSize: 15,
 fontWeight: '600',
 letterSpacing: 0.2,
 },
 photoBooks: {
 fontSize: 13,
 marginTop: 2,
 fontWeight: '500',
 },
 photoRowChevron: {
 marginLeft: 8,
 },
 /** "See all scans" row looks like a list row, not a link. */
 seeAllScansRow: {
 // uses photoRow layout
 },
 seeAllScansIconWrap: {
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: 'transparent',
 },
 allScansModalContainer: {
 flex: 1,
 },
 allScansModalHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 16,
 borderBottomWidth: 1,
 minHeight: 44,
 },
 /** Done on top LEFT (consistent exit pattern app-wide). */
 allScansModalDoneButton: {
 flexDirection: 'row',
 alignItems: 'center',
 minHeight: 44,
 justifyContent: 'center',
 paddingRight: 12,
 },
 allScansModalTitleCentered: {
 flex: 1,
 textAlign: 'center',
 },
 headerSpacer: {
 width: 44,
 minWidth: 44,
 },
 allScansModalList: {
 flex: 1,
 paddingHorizontal: 20,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 photoGroup: {
 width: '100%',
 },
 groupHeaderRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 marginBottom: 8,
 marginTop: 8,
 paddingVertical: 2,
 minHeight: 28,
 },
 groupHeaderLabelWrap: {
 flex: 1,
 minWidth: 0,
 marginRight: 10,
 },
 groupHeaderLabel: {
 fontSize: 12,
 fontWeight: '500',
 letterSpacing: 0.2,
 },
 viewPhotoButton: {
 paddingVertical: 4,
 paddingHorizontal: 8,
 },
 viewPhotoLink: {
 fontSize: 13,
 fontWeight: '500',
 },
 pendingGroupBlock: {
 marginBottom: 12,
 },
 pendingGroupHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingVertical: 10,
 paddingRight: 16,
 paddingLeft: 0,
 borderBottomWidth: 1,
 marginBottom: 10,
 },
 pendingGroupHeaderLeft: {
 flexDirection: 'row',
 alignItems: 'center',
 flex: 1,
 gap: 8,
 minWidth: 0,
 },
 pendingGroupTitle: {
 fontSize: 14,
 fontWeight: '600',
 },
 pendingGroupPill: {
 paddingHorizontal: 8,
 paddingVertical: 4,
 borderRadius: 12,
 },
 pendingGroupPillText: {
 fontSize: 12,
 fontWeight: '500',
 },
 pendingGroupThumb: {
 width: 44,
 height: 44,
 borderRadius: 8,
 borderWidth: 1,
 overflow: 'hidden',
 marginLeft: 8,
 marginRight: 4,
 justifyContent: 'center',
 alignItems: 'center',
 },
 pendingGroupThumbPlaceholder: {
 ...StyleSheet.absoluteFillObject,
 justifyContent: 'center',
 alignItems: 'center',
 },
 pendingGroupThumbPlaceholderText: {
 fontSize: 10,
 fontWeight: '600',
 },
 pendingGroupGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 0,
 },
 pendingGridContent: {
 paddingBottom: 0,
 },
 pendingGridRow: {
 flexDirection: 'row',
 gap: 10,
 marginBottom: 10,
 },
 pendingGridItem: {
 width: `${100 / pendingGridColumns}%`,
 paddingHorizontal: 5,
 },
 pendingGridItemEnd: {
 marginRight: 0,
 },
 /** Cover in pending grid: fixed aspect ratio (book-ish 1 : 1.45). */
 pendingGridCoverWrapper: {
 width: '100%',
 position: 'relative',
 },
 pendingGridCover: {
 width: '100%',
 aspectRatio: 1 / 1.45,
 borderRadius: 8,
 marginBottom: 6,
 backgroundColor: t.colors.surface2,
 },
 /** Transparent tile: cover + author on page background (no white card). */
 pendingGridCard: {
 backgroundColor: 'transparent',
 width: '100%',
 alignItems: 'center',
 flexDirection: 'column',
 padding: 0,
 marginBottom: 0,
 },
 /** Author text directly on page background, no container. */
 pendingGridTextBlock: {
 width: '100%',
 alignItems: 'center',
 marginTop: 4,
 paddingHorizontal: 2,
 },
 bookAuthorGrid: {
 fontSize: 12,
 lineHeight: 15,
 color: t.colors.textMuted,
 marginBottom: 0,
 textAlign: 'center',
 fontWeight: '400',
 },
 booksGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 justifyContent: 'space-between', // Evenly distribute space
 width: '100%',
 },
 photoSeparator: {
 flexDirection: 'row',
 alignItems: 'center',
 marginVertical: 20,
 marginHorizontal: 0,
 width: '100%',
 paddingHorizontal: 0,
 },
 separatorLine: {
 flex: 1,
 height: 1.5,
 backgroundColor: t.colors.border,
 },
 separatorText: {
 marginHorizontal: 12,
 fontSize: 11,
 color: t.colors.textMuted,
 fontWeight: '600',
 textTransform: 'uppercase',
 letterSpacing: 0.5,
 },
 pendingBookCard: {
 backgroundColor: t.colors.surface,
 borderRadius: 10,
 padding: 0,
 marginBottom: 12,
 marginHorizontal: 0,
 flexDirection: 'column',
 borderWidth: 1,
 borderColor: t.colors.border,
 width: (screenWidth - 70) / 3 - 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.06,
 shadowRadius: 4,
 elevation: 1,
 },
 bookHeader: {
 flexDirection: 'row',
 justifyContent: 'flex-end',
 marginBottom: 6,
 },
 bookTopSection: {
 flexDirection: 'column',
 alignItems: 'center',
 marginBottom: 8,
 },
 coverWrapper: {
 position: 'relative',
 width: '100%',
 },
 /** Selected state: overlay with border + slight tint, doesn't change layout. */
 selectedCoverOverlay: {
 ...StyleSheet.absoluteFillObject,
 borderRadius: 8,
 },
 /** Dark scrim behind check so it reads on any cover; check icon fully opaque. */
 selectedCoverCheckWrap: {
 position: 'absolute',
 top: 6,
 right: 6,
 width: 26,
 height: 26,
 borderRadius: 13,
 backgroundColor: 'rgba(0,0,0,0.45)',
 alignItems: 'center',
 justifyContent: 'center',
 },
 selectedCoverCheckIcon: {
 opacity: 1,
 },
 bookCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 8,
 marginBottom: 6,
 backgroundColor: t.colors.surface2,
 },
 placeholderCover: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 backgroundColor: t.colors.bg, // Subtle gray
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 },
 placeholderText: {
 fontSize: 11,
 fontWeight: '600',
 color: t.colors.textMuted, // Medium gray
 textAlign: 'center',
 lineHeight: 14,
 },
 bookInfo: {
 width: '100%',
 alignItems: 'center',
 },
 bookTitle: {
 fontSize: 11,
 fontWeight: '600',
 color: t.colors.text,
 marginBottom: 2,
 textAlign: 'center',
 letterSpacing: 0.1,
 lineHeight: 13,
 },
 bookAuthor: {
 fontSize: 10,
 color: t.colors.textMuted,
 marginBottom: 0,
 textAlign: 'center',
 fontWeight: '500',
 lineHeight: 12,
 paddingHorizontal: 2,
 },
 bookActions: {
 flexDirection: 'row',
 gap: 8,
 alignItems: 'center',
 justifyContent: 'center',
 },
 approveButton: {
 backgroundColor: t.colors.primary, // Emerald accent
 paddingHorizontal: 12,
 paddingVertical: 12,
 borderRadius: 12,
 flex: 1,
 alignItems: 'center',
 shadowColor: '#059669',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 borderWidth: 0,
 marginRight: 6,
 },
 approveButtonText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.4,
 },
 rejectButton: {
 backgroundColor: t.colors.danger,
 paddingHorizontal: 12,
 paddingVertical: 12,
 borderRadius: 12,
 flex: 1,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.danger,
 marginLeft: 6,
 },
 rejectButtonText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.4,
 },
 deleteButton: {
 backgroundColor: t.colors.danger,
 paddingHorizontal: 16,
 paddingVertical: 10,
 borderRadius: 10,
 width: '100%',
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.danger,
 },
 deleteButtonText: {
 color: 'white',
 fontSize: 13,
 fontWeight: '700',
 letterSpacing: 0.5,
 },
 photoCard: {
 flexDirection: 'row',
 backgroundColor: t.colors.surface2,
 borderRadius: 12,
 padding: 16,
 marginBottom: 12,
 alignItems: 'center',
 borderWidth: 1,
 borderColor: t.colors.border,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.05,
 shadowRadius: 4,
 elevation: 2,
 },
 rejectedSection: {
 backgroundColor: t.colors.surface, // White card
 marginHorizontal: 15,
 marginBottom: 20,
 borderRadius: 16,
 padding: 20,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.06,
 shadowRadius: 8,
 elevation: 3,
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 },
 rejectedBookCard: {
 backgroundColor: t.colors.bg, // Subtle gray
 borderRadius: 12,
 padding: 16,
 marginBottom: 12,
 flexDirection: 'row',
 alignItems: 'center',
 borderLeftWidth: 4,
 borderLeftColor: t.colors.danger, // Red accent
 opacity: 0.85,
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 },
 modalContainer: {
 flex: 1,
 backgroundColor: t.colors.bg, // Warm cream background
 },
 scanDetailsModalContainer: {
 backgroundColor: t.colors.bg,
 },
 scanFullScreenContainer: {
 flex: 1,
 },
 scanFullScreenBar: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 zIndex: 10,
 minHeight: 72,
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 16,
 paddingBottom: 14,
 paddingTop: 0,
 },
 scanFullScreenBarButton: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 6,
 },
 /** Semi-transparent dark pill so Done/Delete stay readable over any photo. Min 44px touch target. */
 scanFullScreenBarPill: {
 backgroundColor: 'rgba(0,0,0,0.35)',
 borderRadius: 22,
 minHeight: 44,
 paddingHorizontal: 16,
 paddingVertical: 12,
 justifyContent: 'center',
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 6,
 elevation: 4,
 },
 scanFullScreenBarDoneText: {
 color: '#FFFFFF',
 fontSize: 15,
 fontWeight: '600',
 },
 scanFullScreenBarDeleteText: {
 color: '#FFFFFF',
 fontSize: 14,
 fontWeight: '500',
 },
 scanFullScreenScroll: {
 flex: 1,
 },
 scanFullScreenScrollContent: {
 paddingHorizontal: 0,
 },
 /** Wrapper for photo + overlay bar (position relative so bar can sit over photo). */
 scanDetailPhotoWrap: {
 width: '100%',
 position: 'relative',
 },
 scanDetailImageWrap: {
 width: '100%',
 overflow: 'hidden',
 backgroundColor: t.colors.surface2,
 },
 scanDetailPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 },
 scanDetailPlaceholderText: {
 fontSize: 16,
 fontWeight: '600',
 },
 scanFullScreenImageWrap: {
 width: '100%',
 overflow: 'hidden',
 },
 scanFullScreenImage: {
 width: '100%',
 height: '100%',
 minHeight: 400,
 },
 scanFullScreenMetaWrap: {
 paddingHorizontal: 16,
 paddingTop: 12,
 paddingBottom: 14,
 borderTopWidth: 1,
 },
 scanSheetBackdrop: {
 flex: 1,
 justifyContent: 'flex-end',
 backgroundColor: 'rgba(0,0,0,0.4)',
 },
 scanSheet: {
 backgroundColor: t.colors.surface,
 borderTopLeftRadius: 20,
 borderTopRightRadius: 20,
 overflow: 'hidden',
 },
 scanSheetHandleWrap: {
 alignItems: 'center',
 paddingTop: 10,
 paddingBottom: 6,
 },
 scanSheetHandle: {
 width: 40,
 height: 4,
 borderRadius: 2,
 },
 scanSheetHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 16,
 paddingVertical: 12,
 borderBottomWidth: 1,
 },
 scanSheetTitle: {
 fontSize: 18,
 fontWeight: '700',
 },
 scanSheetHeaderButtons: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 10,
 },
 scanSheetDeleteBtn: {
 paddingHorizontal: 14,
 paddingVertical: 8,
 borderRadius: 10,
 borderWidth: 1.5,
 },
 scanSheetDeleteText: {
 fontSize: 14,
 fontWeight: '600',
 },
 scanSheetDoneBtn: {
 paddingHorizontal: 18,
 paddingVertical: 8,
 borderRadius: 10,
 },
 scanSheetDoneText: {
 fontSize: 14,
 fontWeight: '700',
 },
 scanSheetScroll: {
 maxHeight: 420,
 },
 scanSheetScrollContent: {
 paddingHorizontal: 16,
 paddingBottom: 24,
 },
 scanSheetImageWrap: {
 width: '100%',
 height: 220,
 borderRadius: 14,
 overflow: 'hidden',
 marginBottom: 16,
 },
 scanSheetImage: {
 width: '100%',
 height: '100%',
 borderRadius: 14,
 },
 scanSheetMeta: {
 paddingVertical: 8,
 borderBottomWidth: 1,
 marginBottom: 8,
 },
 scanSheetMetaLabel: {
 fontSize: 16,
 fontWeight: '700',
 marginBottom: 0,
 },
 scanSheetMetaValue: {
 fontSize: 14,
 fontWeight: '500',
 },
 scanSheetLoading: {
 fontSize: 14,
 marginBottom: 12,
 },
 scanSheetGridTitle: {
 fontSize: 12,
 fontWeight: '600',
 marginBottom: 6,
 },
 scanSheetGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 0,
 },
 scanSheetGridItem: {
 width: `${100 / pendingGridColumns}%`,
 paddingHorizontal: 3,
 alignItems: 'center',
 },
 scanSheetGridCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 8,
 marginBottom: 2,
 backgroundColor: t.colors.surface2,
 },
 scanSheetGridCoverPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 },
 scanSheetGridTitleLine: {
 fontSize: 11,
 fontWeight: '500',
 width: '100%',
 textAlign: 'center',
 },
 scanSheetGridAuthorLine: {
 fontSize: 12,
 lineHeight: 16,
 fontWeight: '500',
 width: '100%',
 maxWidth: '100%',
 textAlign: 'center',
 },
 scanDetailsModalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 14,
 backgroundColor: t.colors.surface,
 borderBottomWidth: 0,
 },
 modalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 padding: 20,
 paddingBottom: 20,
 backgroundColor: t.colors.surface, // Match main app header color
 borderBottomWidth: 0,
 },
 modalHeaderButtons: {
 flexDirection: 'row',
 gap: 10,
 },
 modalDeleteButton: {
 backgroundColor: t.colors.danger,
 paddingHorizontal: 16,
 paddingVertical: 10,
 borderRadius: 10,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 modalDeleteText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 modalBooksGroup: {
 marginTop: 20,
 marginBottom: 10,
 },
 incompleteBooksGroup: {
 marginTop: 30,
 paddingTop: 20,
 borderTopWidth: 2,
 borderTopColor: t.colors.border,
 },
 modalGroupTitle: {
 fontSize: 18,
 fontWeight: '600',
 color: t.colors.text,
 marginBottom: 8,
 },
 modalGroupSubtitle: {
 fontSize: 13,
 color: t.colors.textMuted,
 marginBottom: 12,
 fontStyle: 'italic',
 },
 incompleteBookCardModal: {
 backgroundColor: t.colors.pendingChipBg,
 borderLeftColor: t.colors.accent2,
 borderLeftWidth: 4,
 },
 incompleteScanGroup: {
 marginBottom: 20,
 },
 incompleteScanHeader: {
 backgroundColor: t.colors.pendingChipBg,
 padding: 10,
 borderRadius: 8,
 marginBottom: 10,
 },
 incompleteScanDate: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.pendingChipText,
 },
 incompleteStatus: {
 color: t.colors.pendingChipText,
 backgroundColor: t.colors.pendingChipBg,
 },
 editButton: {
 backgroundColor: t.colors.primary,
 paddingHorizontal: 12,
 paddingVertical: 6,
 borderRadius: 6,
 marginLeft: 'auto',
 },
 editButtonText: {
 color: 'white',
 fontSize: 12,
 fontWeight: '600',
 },
 editSection: {
 marginBottom: 20,
 padding: 15,
 backgroundColor: t.colors.bg,
 borderRadius: 8,
 },
 editLabel: {
 fontSize: 16,
 fontWeight: '600',
 color: t.colors.text,
 marginBottom: 10,
 },
 editCurrentText: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontStyle: 'italic',
 marginBottom: 15,
 },
 searchInput: {
 backgroundColor: 'white',
 borderWidth: 1,
 borderColor: t.colors.border,
 borderRadius: 8,
 padding: 12,
 fontSize: 14,
 marginBottom: 10,
 },
 searchButton: {
 backgroundColor: t.colors.primary,
 paddingHorizontal: 20,
 paddingVertical: 12,
 borderRadius: 8,
 alignItems: 'center',
 },
 searchButtonText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '600',
 },
 editInput: {
 backgroundColor: 'white',
 borderWidth: 1,
 borderColor: t.colors.border,
 borderRadius: 8,
 padding: 12,
 fontSize: 14,
 marginBottom: 15,
 },
 editSubLabel: {
 fontSize: 13,
 color: t.colors.textMuted,
 marginBottom: 15,
 fontStyle: 'italic',
 },
 editDivider: {
 textAlign: 'center',
 fontSize: 14,
 color: t.colors.textMuted,
 fontWeight: '600',
 marginVertical: 10,
 },
 saveManualButton: {
 backgroundColor: t.colors.primary,
 paddingHorizontal: 20,
 paddingVertical: 14,
 borderRadius: 8,
 alignItems: 'center',
 marginTop: 10,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 saveManualButtonDisabled: {
 backgroundColor: t.colors.surface2,
 opacity: 0.6,
 },
 saveManualButtonText: {
 color: 'white',
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 searchResultsSection: {
 marginTop: 20,
 },
 searchResultCard: {
 backgroundColor: 'white',
 borderRadius: 8,
 padding: 15,
 marginBottom: 10,
 flexDirection: 'row',
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 searchResultCover: {
 width: 50,
 height: 75,
 borderRadius: 4,
 marginRight: 15,
 backgroundColor: t.colors.surface2,
 },
 searchResultInfo: {
 flex: 1,
 },
 searchResultDate: {
 fontSize: 12,
 color: t.colors.textMuted,
 marginTop: 4,
 },
 modalHeaderOld: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 padding: 20,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.border,
 },
 modalTitle: {
 fontSize: 24,
 fontWeight: '700',
 color: t.colors.primaryText,
 letterSpacing: 0.5,
 },
 modalCloseButton: {
 backgroundColor: t.colors.primary,
 paddingHorizontal: 16,
 paddingVertical: 10,
 borderRadius: 10,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 modalCloseText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 switchCoverModalDeleteButton: {
 backgroundColor: 'rgba(255, 255, 255, 0.2)',
 paddingHorizontal: 12,
 paddingVertical: 8,
 borderRadius: 20,
 minWidth: 44,
 alignItems: 'center',
 justifyContent: 'center',
 },
 modalContent: {
 flex: 1,
 padding: 20,
 backgroundColor: t.colors.bg,
 },
 scanDetailsScrollContent: {
 paddingTop: 28,
 paddingBottom: 32,
 },
 modalImage: {
 width: '100%',
 height: 300,
 borderRadius: 14,
 marginBottom: 20,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 3,
 },
 modalSection: {
 marginBottom: 20,
 backgroundColor: t.colors.surface,
 borderRadius: 16,
 padding: 18,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 2,
 },
 modalSectionTitle: {
 fontSize: 20,
 fontWeight: '800',
 color: t.colors.text,
 marginBottom: 8,
 letterSpacing: 0.3,
 },
 modalSectionSubtitle: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontWeight: '500',
 },
 modalBookCard: {
 backgroundColor: t.colors.surface,
 borderRadius: 12,
 padding: 14,
 marginBottom: 12,
 flexDirection: 'row',
 alignItems: 'center',
 borderLeftWidth: 4,
 borderLeftColor: t.colors.primary,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.06,
 shadowRadius: 4,
 elevation: 2,
 },
 modalBookCover: {
 width: 44,
 height: 66,
 borderRadius: 6,
 marginRight: 14,
 backgroundColor: t.colors.surface2,
 },
 modalBookCoverPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 backgroundColor: t.colors.surface2,
 },
 modalBookCardInfo: {
 flex: 1,
 justifyContent: 'center',
 marginRight: 12,
 minWidth: 0,
 },
 modalBookCardTitle: {
 fontSize: 15,
 fontWeight: '600',
 color: t.colors.text,
 marginBottom: 2,
 },
 modalBookCardAuthor: {
 fontSize: 13,
 color: t.colors.textMuted,
 fontWeight: '500',
 },
 bookStatusBadge: {
 paddingHorizontal: 12,
 paddingVertical: 6,
 borderRadius: 12,
 backgroundColor: t.colors.surface2,
 },
 bookStatusText: {
 fontSize: 12,
 fontWeight: '600',
 color: t.colors.textMuted,
 },
 approvedStatus: {
 backgroundColor: t.colors.surface2,
 },
 approvedStatusText: {
 color: t.colors.primary,
 },
 rejectedStatus: {
 backgroundColor: t.colors.surface2,
 },
 rejectedStatusText: {
 color: t.colors.danger,
 },
 pendingStatusText: {
 color: t.colors.accent2,
 },
 approvedStatusLegacy: {
 color: t.colors.primary,
 backgroundColor: t.colors.surface2,
 },
 rejectedStatusLegacy: {
 color: t.colors.danger,
 backgroundColor: t.colors.surface2,
 },
 incompleteSection: {
 backgroundColor: t.colors.surface,
 marginHorizontal: 15,
 marginBottom: 20,
 borderRadius: 16,
 padding: 20,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: 0.08,
 shadowRadius: 12,
 elevation: 5,
 },
 incompleteBookCard: {
 backgroundColor: t.colors.pendingChipBg,
 borderRadius: 16,
 padding: 16,
 marginBottom: 15,
 flexDirection: 'column',
 borderWidth: 2,
 borderColor: t.colors.accent2,
 width: '48%',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 3,
 },
 noCover: {
 justifyContent: 'center',
 alignItems: 'center',
 },
 noCoverText: {
 fontSize: 24,
 color: t.colors.textMuted,
 },
 pendingStatus: {
 backgroundColor: t.colors.pendingChipBg,
 },
 queueItem: {
 backgroundColor: t.colors.bg,
 padding: 10,
 marginBottom: 5,
 borderRadius: 5,
 },
 pendingHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'flex-start',
 marginBottom: 15,
 },
 pendingTitleContainer: {
 flex: 1,
 },
 headerButtons: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 10,
 },
 /** Outline pill does not compete with primary CTA; only shown when > 3 books. */
 selectAllButton: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: 'transparent',
 paddingHorizontal: 12,
 paddingVertical: 6,
 borderRadius: 12,
 borderWidth: 1,
 borderColor: t.colors.secondary ?? t.colors.border,
 shadowOpacity: 0,
 elevation: 0,
 },
 selectAllButtonText: {
 color: t.colors.text,
 fontSize: 13,
 fontWeight: '600',
 letterSpacing: 0.2,
 },
 selectedCountLabel: {
 fontSize: 13,
 fontWeight: '600',
 marginLeft: 'auto',
 },
 clearButton: {
 backgroundColor: t.colors.textMuted, // Medium gray
 paddingHorizontal: 14,
 paddingVertical: 8,
 borderRadius: 10,
 shadowColor: '#6b7280',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 3,
 elevation: 2,
 borderWidth: 0,
 },
 clearButtonText: {
 color: 'white',
 fontSize: 13,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 addAllButton: {
 flex: 1,
 backgroundColor: t.colors.primary, // Emerald accent
 paddingVertical: 14,
 paddingHorizontal: 16,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#059669',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 borderWidth: 0,
 marginRight: 5,
 },
 addAllButtonText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.4,
 },
 deleteAllButton: {
 flex: 1,
 backgroundColor: t.colors.danger, // Red for delete
 paddingVertical: 14,
 paddingHorizontal: 16,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.danger,
 marginLeft: 5,
 },
 deleteAllButtonText: {
 color: 'white',
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.4,
 },
 bulkActions: {
 backgroundColor: t.colors.surface2,
 padding: 18,
 borderRadius: 12,
 marginBottom: 15,
 borderWidth: 2,
 borderColor: t.colors.primary,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 3,
 },
 selectedCount: {
 fontSize: 15,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 12,
 letterSpacing: 0.3,
 },
 bulkButtonsRow: {
 flexDirection: 'row',
 gap: 10,
 },
 bulkApproveButton: {
 flex: 1,
 backgroundColor: t.colors.primary,
 paddingVertical: 12,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.primary,
 marginRight: 5,
 },
 bulkRejectButton: {
 flex: 1,
 backgroundColor: t.colors.danger,
 paddingVertical: 12,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.danger,
 marginHorizontal: 5,
 },
 bulkClearButton: {
 flex: 1,
 backgroundColor: t.colors.textMuted,
 paddingVertical: 12,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 4,
 borderWidth: 1,
 borderColor: t.colors.border,
 marginLeft: 5,
 },
 bulkButtonText: {
 color: 'white',
 fontSize: 13,
 fontWeight: '700',
 letterSpacing: 0.4,
 },
 selectedBookCard: {
 borderWidth: 1,
 borderColor: t.colors.primary,
 shadowColor: t.colors.primary,
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 6,
 elevation: 3,
 },
/** Selection bar: flows naturally inside the BottomDock container — no absolute
    positioning here. The BottomDock handles placement above the tab bar. */
selectionBar: {
borderTopLeftRadius: 16,
borderTopRightRadius: 16,
overflow: 'hidden',
shadowColor: '#000',
shadowOffset: { width: 0, height: -2 },
shadowOpacity: 0.06,
shadowRadius: 6,
elevation: 6,
paddingTop: 10,
},
 /** Inner content wrapper. */
 selectionBarInner: {
 paddingTop: 4,
 },
 /** Row 1 when 1 selected: count + Edit Cover + Switch Book. */
 rowTop: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 10,
 },
 /** Row 1 when 2+ selected: count only. */
 rowTopCompact: {
 flexDirection: 'row',
 alignItems: 'center',
 marginBottom: 10,
 },
 /** Row 2: Add / Delete. No space-between, no marginBottom hack. */
 rowBottom: {
 flexDirection: 'row',
 gap: 12,
 alignItems: 'center',
 },
 /** Multi: same row (title + buttons); barInner justifyContent: flex-end puts this at bottom. */
 stickyToolbarInner: {
 flexDirection: 'row',
 alignItems: 'flex-end',
 gap: 8,
 flexWrap: 'wrap',
 paddingBottom: 6,
 },
 /** Single-mode: two rows (utility + action), column. */
 selectionBarSingle: {
 flexDirection: 'column',
 width: '100%',
 paddingBottom: 10,
 },
 /** Utilities row: "1 selected" + Edit Cover + Switch Book. */
 utilityRow: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 8,
 },
 selectedLabel: {
 fontSize: 14,
 fontWeight: '700',
 marginRight: 4,
 },
 /** "X selected" label text only smaller, not the buttons. */
 selectedText: {
 fontSize: 14,
 fontWeight: '600',
 },
 /** Count text in selection bar (reduced from title size). */
 countText: {
 fontSize: 16,
 fontWeight: '600',
 },
 actionRowScroll: {
 flex: 1,
 maxHeight: 44,
 },
 /** Action row: Add Selected + Delete Selected (single-selection bar). */
 actionRow: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 gap: 12,
 marginBottom: 2,
 },
 /** Force Add/Delete buttons to equal width; do not size by text. */
 actionBtn: {
 flex: 1,
 },
 /** Row A: compact Edit Cover / Switch Book; smaller height and tighter radius. */
 selectionActionButton: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 height: 36,
 paddingVertical: 6,
 paddingHorizontal: 10,
 borderRadius: 8,
 borderWidth: 1,
 gap: 4,
 },
 selectionActionIcon: {
 marginRight: 0,
 },
 selectionActionLabel: {
 fontSize: 14,
 fontWeight: '600',
 },
 stickyToolbarTitle: {
 fontSize: 18,
 fontWeight: '600',
 color: t.colors.text,
 marginRight: 10,
 paddingBottom: 6,
 },
 stickyToolbarRow: {
 flexDirection: 'row',
 alignItems: 'flex-end',
 gap: 8,
 flex: 1,
 justifyContent: 'flex-end',
 },
 stickySelectedCount: {
 fontSize: 12,
 color: t.colors.textMuted,
 fontWeight: '600',
 },
 /** Add Selected: primary (tan). Slightly shorter so bar can shrink. */
 stickyButton: {
 paddingHorizontal: 14,
 paddingVertical: 10,
 borderRadius: 14,
 flex: 1,
 height: 46,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: t.colors.primary,
 borderWidth: 0,
 shadowColor: t.colors.primary,
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 6,
 elevation: 3,
 },
 stickyButtonDisabled: {
 opacity: 0.65,
 },
 stickyButtonText: {
 color: t.colors.primaryText,
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.2,
 textAlign: 'center',
 },
 /** Delete Selected: destructive (red). Same height/borderRadius as stickyButton. */
 stickyDeleteButton: {
 paddingHorizontal: 14,
 paddingVertical: 10,
 borderRadius: 14,
 flex: 1,
 height: 46,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: t.colors.danger,
 borderWidth: 0,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 stickyDeleteButtonText: {
 fontSize: 14,
 fontWeight: '700',
 letterSpacing: 0.2,
 textAlign: 'center',
 },
 selectionIndicator: {},
 selectedCheckbox: {},
 unselectedCheckbox: {},
 checkmark: {},
 captionSection: {
 backgroundColor: t.colors.surface, // White card
 borderRadius: 16,
 padding: 14,
 marginTop: 0,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.06,
 shadowRadius: 8,
 elevation: 2,
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 },
 captionLabel: {
 fontSize: 18,
 fontWeight: '600',
 color: t.colors.text, // Deep charcoal
 marginBottom: 6,
 letterSpacing: 0.3,
 },
 captionHint: {
 fontSize: 13,
 color: t.colors.textMuted, // Medium gray
 marginBottom: 8,
 fontStyle: 'italic',
 },
 scanningInBackgroundHint: {
 fontSize: 14,
 color: t.colors.primary,
 marginBottom: 16,
 fontWeight: '600',
 textAlign: 'center',
 },
 captionInput: {
 backgroundColor: t.colors.bg, // Subtle gray
 borderWidth: 0.5,
 borderColor: t.colors.border, // Subtle gray border
 borderRadius: 12,
 padding: 12,
 fontSize: 16,
 color: t.colors.text, // Deep charcoal
 minHeight: 88,
 textAlignVertical: 'top',
 marginBottom: 10,
 },
 captionSubmitButton: {
 backgroundColor: t.colors.primary,
 paddingVertical: 12,
 paddingHorizontal: 24,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 captionSubmitButtonText: {
 color: t.colors.primaryText,
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 captionFolderButton: {
 paddingVertical: 12,
 paddingHorizontal: 18,
 borderRadius: 12,
 alignItems: 'center',
 flexDirection: 'row',
 justifyContent: 'center',
 borderWidth: 1,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.06,
 shadowRadius: 3,
 elevation: 1,
 },
 captionFolderButtonText: {
 fontSize: 15,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 captionModalContainer: {
 flex: 1,
 backgroundColor: t.colors.bg, // Subtle gray background
 },
 captionModalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingVertical: 12,
 paddingHorizontal: 16,
 backgroundColor: t.colors.surface,
 borderBottomWidth: 0,
 },
 captionModalHeaderTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.text,
 },
 captionHeaderSkipButton: {
 paddingVertical: 8,
 paddingHorizontal: 4,
 marginLeft: 8,
 },
 captionHeaderSkipText: {
 fontSize: 16,
 fontWeight: '600',
 },
 captionProgressText: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.primaryText,
 marginLeft: 12,
 marginRight: 'auto',
 },
 captionSwipeHint: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 marginBottom: 10,
 paddingVertical: 6,
 paddingHorizontal: 12,
 backgroundColor: t.colors.surface2,
 borderRadius: 8,
 gap: 8,
 },
 captionSwipeHintText: {
 fontSize: 12,
 color: t.colors.textMuted,
 fontWeight: '500',
 },
 captionModalContent: {
 flex: 1,
 paddingVertical: 12,
 paddingHorizontal: 16,
 },
 captionModalContentContainer: {
 paddingBottom: 130,
 },
 captionActionBar: {
 position: 'absolute',
 left: 0,
 right: 0,
 paddingHorizontal: 16,
 paddingTop: 10,
 borderTopWidth: 1,
 gap: 12,
 },
 captionModalImage: {
 width: '100%',
 height: 180,
 borderRadius: 16,
 marginBottom: 12,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 3,
 },
 folderModalContainer: {
 flex: 1,
 backgroundColor: t.colors.bg, // Subtle gray background
 },
 folderModalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 padding: 20,
 paddingTop: Platform.OS === 'ios' ? 50 : 20,
 backgroundColor: t.colors.surface,
 borderBottomWidth: 0,
 },
 folderModalContent: {
 flex: 1,
 padding: 20,
 },
 createFolderSection: {
 backgroundColor: t.colors.surface,
 borderRadius: 16,
 padding: 20,
 marginBottom: 24,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 2,
 },
 createFolderTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 12,
 letterSpacing: 0.3,
 },
 createFolderRow: {
 flexDirection: 'row',
 gap: 12,
 },
 createFolderInput: {
 flex: 1,
 backgroundColor: t.colors.surface2,
 borderWidth: 1,
 borderColor: t.colors.border,
 borderRadius: 12,
 padding: 14,
 fontSize: 16,
 color: t.colors.text,
 },
 createFolderButton: {
 backgroundColor: t.colors.primary,
 paddingVertical: 14,
 paddingHorizontal: 20,
 borderRadius: 12,
 justifyContent: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 createFolderButtonDisabled: {
 backgroundColor: t.colors.surface2,
 opacity: 0.6,
 },
 createFolderButtonText: {
 color: t.colors.primaryText,
 fontSize: 15,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 existingFoldersSection: {
 marginBottom: 24,
 },
 existingFoldersTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 16,
 letterSpacing: 0.3,
 },
 folderItem: {
 backgroundColor: t.colors.surface,
 borderRadius: 12,
 padding: 16,
 marginBottom: 12,
 flexDirection: 'row',
 alignItems: 'center',
 borderWidth: 2,
 borderColor: t.colors.border,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.05,
 shadowRadius: 4,
 elevation: 1,
 },
 folderItemSelected: {
 borderColor: t.colors.primary,
 backgroundColor: t.colors.surface2,
 },
 folderItemName: {
 fontSize: 16,
 fontWeight: '600',
 color: t.colors.text,
 marginBottom: 4,
 },
 folderItemNameSelected: {
 color: t.colors.primary,
 },
 // Edit Cover Modal: one-pane + dividers, themed for light/dark
 editCoverSection: {
 paddingHorizontal: 20,
 paddingVertical: 16,
 borderBottomWidth: 1,
 },
 editCoverSectionTitle: {
 fontSize: 13,
 fontWeight: '600',
 marginBottom: 10,
 textTransform: 'uppercase',
 letterSpacing: 0.4,
 },
 editCoverPreviewCard: {
 flexDirection: 'row',
 borderRadius: 12,
 padding: 14,
 alignItems: 'center',
 },
 editCoverPreviewImage: {
 width: 72,
 height: 108,
 borderRadius: 8,
 marginRight: 14,
 },
 editCoverPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 },
 editCoverPlaceholderText: {
 fontSize: 12,
 textAlign: 'center',
 },
 editCoverPreviewInfo: {
 flex: 1,
 justifyContent: 'center',
 minWidth: 0,
 },
 editCoverPreviewTitle: {
 fontSize: 16,
 fontWeight: '700',
 marginBottom: 4,
 },
 editCoverPreviewAuthor: {
 fontSize: 14,
 },
 editCoverActionRow: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 14,
 paddingHorizontal: 4,
 gap: 12,
 },
 editCoverActionTextWrap: {
 flex: 1,
 minWidth: 0,
 },
 editCoverActionLabel: {
 fontSize: 16,
 fontWeight: '600',
 },
 editCoverActionHint: {
 fontSize: 13,
 marginTop: 2,
 },
 // Switch Covers Modal Styles
 switchCoversHeader: {
 padding: 20,
 backgroundColor: t.colors.bg,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.border,
 },
 switchCoversTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 12,
 },
 currentBookCard: {
 flexDirection: 'row',
 backgroundColor: t.colors.surface,
 borderRadius: 12,
 padding: 12,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 4,
 elevation: 2,
 },
 currentBookCover: {
 width: 80,
 height: 120,
 borderRadius: 8,
 marginRight: 12,
 },
 currentBookCoverSmall: {
 width: 60,
 height: 90,
 borderRadius: 6,
 marginRight: 12,
 },
 currentBookInfo: {
 flex: 1,
 justifyContent: 'center',
 },
 currentBookTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 4,
 },
 currentBookAuthor: {
 fontSize: 14,
 color: t.colors.textMuted,
 },
 switchCoversSection: {
 padding: 20,
 },
 switchCoversSectionTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 16,
 },
 coversGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 12,
 },
 coverOption: {
 width: (screenWidth - 80) / 3, // 3 columns with padding
 aspectRatio: 0.67, // Book cover ratio
 borderRadius: 8,
 overflow: 'hidden',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 4,
 elevation: 2,
 },
 coverOptionImage: {
 width: '100%',
 height: '100%',
 },
 // Switch Book Modal Styles
 searchContainer: {
 flexDirection: 'row',
 alignItems: 'center',
 padding: 16,
 backgroundColor: t.colors.surface,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.border,
 },
 switchBookSearchInput: {
 flex: 1,
 height: 44,
 backgroundColor: t.colors.bg,
 borderRadius: 12,
 paddingHorizontal: 16,
 fontSize: 16,
 color: t.colors.text,
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 switchBookHeader: {
 padding: 16,
 backgroundColor: t.colors.bg,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.border,
 },
 switchBookHeaderTitle: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.textMuted,
 marginBottom: 8,
 },
 searchResultsContainer: {
 flex: 1,
 padding: 16,
 },
 bookSearchResult: {
 flexDirection: 'row',
 backgroundColor: t.colors.surface,
 borderRadius: 12,
 padding: 12,
 marginBottom: 12,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.05,
 shadowRadius: 4,
 elevation: 1,
 },
 bookSearchResultCover: {
 width: 50,
 height: 75,
 borderRadius: 6,
 marginRight: 12,
 },
 bookSearchResultInfo: {
 flex: 1,
 justifyContent: 'center',
 },
 bookSearchResultTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 4,
 },
 bookSearchResultAuthor: {
 fontSize: 14,
 color: t.colors.textMuted,
 marginBottom: 2,
 },
 bookSearchResultDate: {
 fontSize: 12,
 color: t.colors.textMuted,
 },
 loadingContainer: {
 padding: 40,
 alignItems: 'center',
 },
 loadingText: {
 marginTop: 12,
 fontSize: 14,
 color: t.colors.textMuted,
 },
 emptyContainer: {
 padding: 40,
 alignItems: 'center',
 },
 emptyText: {
 fontSize: 14,
 color: t.colors.textMuted,
 },
 folderItemCount: {
 fontSize: 13,
 color: t.colors.textMuted,
 },
  folderModalActions: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 20,
  },
  folderModalBackButton: {
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  folderModalBackText: {
    fontSize: 16,
    fontWeight: '600',
  },
 folderActionButton: {
 flex: 1,
 paddingVertical: 16,
 borderRadius: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 folderSkipButton: {
 backgroundColor: t.colors.surface2,
 },
 folderSkipButtonText: {
 color: t.colors.textMuted,
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 folderConfirmButton: {
 backgroundColor: t.colors.primary,
 },
 folderConfirmButtonDisabled: {
 backgroundColor: t.colors.surface2,
 opacity: 0.6,
 },
 folderConfirmButtonText: {
 color: t.colors.primaryText,
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
});


