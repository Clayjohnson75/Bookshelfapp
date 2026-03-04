import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef, ReactNode } from 'react';
import { useAuth } from '../auth/SimpleAuthContext';
import { getActiveScanJobIds, setActiveScanJobIds as persistActiveScanJobIds } from '../lib/activeScanJobsStore';
import { toScanJobId } from '../lib/scanId';
import { logger } from '../utils/logger';

/** Defer a setState call so it never runs during render (fixes "Cannot update X while rendering Y"). */
function deferSetState<T>(
  setter: React.Dispatch<React.SetStateAction<T>>,
  action: React.SetStateAction<T>
): void {
  if (typeof queueMicrotask !== 'undefined') {
    queueMicrotask(() => setter(action));
  } else {
    setTimeout(() => setter(action), 0);
  }
}

interface ScanProgress {
 /** Display-only; never authoritative. Results are keyed by jobId (or scanId) in batch.resultsByJobId. */
 currentScanId: string | null;
 currentStep: number;
 totalSteps: number;
 totalScans: number;
 completedScans: number;
 failedScans: number;
 canceledScans?: number; // User canceled not a failure, but counts as "done" for hiding bar
 startTimestamp?: number;
 batchId?: string; // Track batchId for robustness (persists even if auth fails)
 jobIds?: string[]; // Authoritative for cancel and progress; results stored by jobId
 progress?: number; // Server progress percentage (0-100)
 stage?: string; // Current stage from server
 /** Why the bar was shown (for logging): batch_start | queue_resume | mount_restore */
 showReason?: string;
}

/** Visible on-screen debug (TestFlight): upload progress, transport, phase. */
export interface UploadDebug {
 phase: 'uploading' | 'scanning' | 'importing';
 progress: number | null; // upload progress 0-100 or null if no events (e.g. fetch)
 transport: 'fetch' | 'xhr';
 bytesSent?: number;
 total?: number;
}

interface ScanningContextType {
  scanProgress: ScanProgress | null;
  setScanProgress: (progress: ScanProgress | null) => void;
  updateProgress: (update: Partial<ScanProgress>) => void;
  /** Upload queue in-flight count (queued/pending/processing). Derived from real state; bar shows when this > 0 OR activeScanJobIds.length > 0. */
  jobsInProgress: number;
  setJobsInProgress: (n: number) => void;
  /** Count of photos with status failed_upload (recoverable). When > 0 and no upload/scan work, show "N upload failed — Tap to retry" banner instead of scan bar. */
  failedUploadCount: number;
  setFailedUploadCount: (n: number) => void;
  uploadDebug: UploadDebug | null;
  setUploadDebug: (d: UploadDebug | null | ((prev: UploadDebug | null) => UploadDebug | null)) => void;
  onCancelComplete?: () => void; // Callback when user cancels batch
  setOnCancelComplete?: (callback: (() => void) | undefined) => void;
  onDismissComplete?: () => void; // Callback when user dismisses completed batch (clear batch state)
  setOnDismissComplete?: (callback: (() => void) | undefined) => void;
  /** Called when scan-status poll returns terminal status for a job. Use to drive completedScans from server, not from pending count. */
  onJobTerminalStatus?: (jobId: string, status: 'completed' | 'failed' | 'canceled') => void;
  setOnJobTerminalStatus?: (callback: ((jobId: string, status: 'completed' | 'failed' | 'canceled') => void) | undefined) => void;
  /** Server-reported active job IDs (from sync-scans). Normalized to [] when null so consumers never see null. */
  serverActiveJobIds: string[];
  setServerActiveJobIds: (ids: string[] | null | undefined) => void;
  /**
   * Active scan job IDs (added when Step C returns; removed only when server says terminal).
   * Bar stays visible while activeScanJobIds.length > 0. Prevents treating "job created" as "scan finished".
   */
  activeScanJobIds: string[];
  /** Rehydrate from durable store (call on mount/focus when userId available). Do not use for normal add/remove. */
  setActiveScanJobIds: (ids: string[]) => void;
  addActiveScanJobId: (id: string) => void;
  removeActiveScanJobId: (id: string) => void;
  /**
   * Monotonically-increasing cancel generation counter. Incremented by cancelAll().
   * Every async worker captures this at start and must check before writing any state:
   *   if (gen !== cancelGenerationRef.current) return;
   * Exposed as a ref so workers read the live value without re-subscribing.
   */
  cancelGenerationRef: React.MutableRefObject<number>;
  /**
   * Atomic "cancel everything" action. Synchronously:
   *   - increments cancelGeneration (invalidates all in-flight workers)
   *   - clears scanProgress, jobsInProgress, uploadDebug, serverActiveJobIds, activeScanJobIds
   * Then calls onCancelComplete() so ScansTab can clear its own state (batch, queue, AbortControllers).
   * UI goes dark immediately; server-side cancel requests fire afterwards in the background.
   */
  cancelAll: () => void;
}

const ScanningContext = createContext<ScanningContextType | undefined>(undefined);

export const useScanning = () => {
 const context = useContext(ScanningContext);
 if (!context) {
 throw new Error('useScanning must be used within a ScanningProvider');
 }
 return context;
};

interface ScanningProviderProps {
 children: ReactNode;
}

export const ScanningProvider: React.FC<ScanningProviderProps> = ({ children }) => {
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [jobsInProgress, setJobsInProgress] = useState<number>(0);
  const [failedUploadCount, setFailedUploadCount] = useState<number>(0);
  const [uploadDebug, setUploadDebugState] = useState<UploadDebug | null>(null);
  const setUploadDebug = useCallback((d: UploadDebug | null | ((prev: UploadDebug | null) => UploadDebug | null)) => {
    setUploadDebugState(prev => typeof d === 'function' ? d(prev) : d);
  }, []);
  const [onCancelComplete, setOnCancelComplete] = useState<(() => void) | undefined>(undefined);
  const [onDismissComplete, setOnDismissComplete] = useState<(() => void) | undefined>(undefined);
  const [onJobTerminalStatus, setOnJobTerminalStatus] = useState<((jobId: string, status: 'completed' | 'failed' | 'canceled') => void) | undefined>(undefined);
  // Normalize null/undefined -> [] at boundary so consumers never see null (avoids "visible then invisible" glitches).
  const [serverActiveJobIds, setServerActiveJobIdsState] = useState<string[]>([]);
  const [activeScanJobIds, setActiveScanJobIdsState] = useState<string[]>([]);
  const userId = useAuth()?.user?.uid ?? null;

  const setServerActiveJobIds = useCallback((ids: string[] | null | undefined) => {
    const safe = ids == null ? [] : (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : []);
    setServerActiveJobIdsState(safe);
  }, []);

  // Rehydrate from durable store on mount / userId change. Always set array (never undefined).
  useEffect(() => {
    if (!userId) return;
    getActiveScanJobIds(userId).then((ids) => {
      const safeIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [];
      setActiveScanJobIdsState(safeIds);
    });
  }, [userId]);

  const setActiveScanJobIds = useCallback((ids: string[]) => {
    const safeIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [];
    setActiveScanJobIdsState(safeIds);
    if (userId) persistActiveScanJobIds(userId, safeIds).catch(() => {});
  }, [userId]);

  const addActiveScanJobId = useCallback((id: string) => {
    if (!id || typeof id !== 'string' || !id.trim()) return;
    const canonicalId = toScanJobId(id.trim());
    if (canonicalId.length < 40) return; // full job_<uuid> is 40+ chars
    setActiveScanJobIdsState((prev) => {
      const safePrev = Array.isArray(prev) ? prev : [];
      if (safePrev.includes(canonicalId)) return safePrev;
      const next = [...safePrev, canonicalId];
      if (userId) persistActiveScanJobIds(userId, next).catch(() => {});
      return next;
    });
  }, [userId]);
  const removeActiveScanJobId = useCallback((id: string) => {
    if (id == null || typeof id !== 'string') return;
    const raw = id.trim();
    if (!raw || raw.length < 8) return;
    const canonicalId = toScanJobId(raw);
    if (canonicalId.length < 40) return;
    setActiveScanJobIdsState((prev) => {
      const safePrev = Array.isArray(prev) ? prev : [];
      const next = safePrev.filter((x) => x !== canonicalId);
      if (userId) persistActiveScanJobIds(userId, next).catch(() => {});
      return next;
    });
  }, [userId]);

  // Cancel generation: monotonically-increasing integer. Incremented on every hard cancel.
  // Kept in a ref so async workers can read the live value inside closures without re-subscribing.
  const cancelGenerationRef = useRef<number>(0);
  // Stable ref to onCancelComplete so cancelAll can call it without capturing a stale closure.
  const onCancelCompleteRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => { onCancelCompleteRef.current = onCancelComplete; }, [onCancelComplete]);

  const cancelAll = useCallback(() => {
    // 1. Increment generation — all async workers that captured the previous generation will no-op.
    cancelGenerationRef.current += 1;
    // 2. Atomically zero all context-owned scan UI state (in-memory only).
    //    Durable activeScanJobIds store is cleared by ScansTab's onCancelComplete so we don't need userId here.
    setScanProgress(null);
    setJobsInProgress(0);
    setFailedUploadCount(0);
    setUploadDebugState(null);
    setServerActiveJobIdsState([]);
    setActiveScanJobIdsState([]);
    // 3. Notify ScansTab so it can abort fetches, clear batch/queue, and clear durable active-job store.
    //    This fires after the React state updates above are queued, so the bar goes dark on the
    //    same render cycle as the context clear.
    onCancelCompleteRef.current?.();
  }, []);

  const updateProgress = useCallback((update: Partial<ScanProgress>) => {
    setScanProgress(prev => {
      const base = prev || ({} as ScanProgress);
      const start = base.startTimestamp || update.startTimestamp || Date.now();
      return { ...base, ...update, startTimestamp: start } as ScanProgress;
    });
  }, []);

  useEffect(() => {
    if (!scanProgress) setUploadDebug(null);
  }, [scanProgress]);

  // Expose only string[] so consumers never see undefined (avoids "Cannot read property 'slice' of undefined").
  const safeActiveScanJobIds = useMemo(
    () => (activeScanJobIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
    [activeScanJobIds]
  );

  // Deferred setters for context: never run during render (avoids "Cannot update X while rendering Y").
  // cancelAll and internal effects use the direct state setters above.
  const setScanProgressDeferred = useCallback((progress: ScanProgress | null) => {
    deferSetState(setScanProgress, progress);
  }, []);
  const setJobsInProgressDeferred = useCallback((n: number) => {
    deferSetState(setJobsInProgress, n);
  }, []);
  const setServerActiveJobIdsDeferred = useCallback((ids: string[] | null | undefined) => {
    const safe = ids == null ? [] : (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : []);
    deferSetState(setServerActiveJobIdsState, safe);
  }, []);
  const setFailedUploadCountDeferred = useCallback((n: number) => {
    deferSetState(setFailedUploadCount, n);
  }, []);
  const setUploadDebugDeferred = useCallback((d: UploadDebug | null | ((prev: UploadDebug | null) => UploadDebug | null)) => {
    if (typeof d === 'function') {
      deferSetState(setUploadDebugState, (prev: UploadDebug | null) => (d as (p: UploadDebug | null) => UploadDebug | null)(prev));
    } else {
      deferSetState(setUploadDebugState, d);
    }
  }, []);
  const setOnCancelCompleteDeferred = useCallback((callback: (() => void) | undefined) => {
    deferSetState(setOnCancelComplete, callback);
  }, []);
  const setOnDismissCompleteDeferred = useCallback((callback: (() => void) | undefined) => {
    deferSetState(setOnDismissComplete, callback);
  }, []);
  const setOnJobTerminalStatusDeferred = useCallback((callback: ((jobId: string, status: 'completed' | 'failed' | 'canceled') => void) | undefined) => {
    deferSetState(setOnJobTerminalStatus, callback);
  }, []);

  const value = useMemo(
    () => ({
      scanProgress,
      setScanProgress: setScanProgressDeferred,
      updateProgress,
      jobsInProgress,
      setJobsInProgress: setJobsInProgressDeferred,
      failedUploadCount,
      setFailedUploadCount: setFailedUploadCountDeferred,
      uploadDebug,
      setUploadDebug: setUploadDebugDeferred,
      onCancelComplete,
      setOnCancelComplete: setOnCancelCompleteDeferred,
      onDismissComplete,
      setOnDismissComplete: setOnDismissCompleteDeferred,
      onJobTerminalStatus,
      setOnJobTerminalStatus: setOnJobTerminalStatusDeferred,
      serverActiveJobIds,
      setServerActiveJobIds: setServerActiveJobIdsDeferred,
      activeScanJobIds: safeActiveScanJobIds,
      setActiveScanJobIds,
      addActiveScanJobId,
      removeActiveScanJobId,
      cancelGenerationRef,
      cancelAll,
    }),
    [
      scanProgress,
      jobsInProgress,
      failedUploadCount,
      uploadDebug,
      onCancelComplete,
      onDismissComplete,
      onJobTerminalStatus,
      serverActiveJobIds,
      safeActiveScanJobIds,
      setScanProgressDeferred,
      setJobsInProgressDeferred,
      setFailedUploadCountDeferred,
      setUploadDebugDeferred,
      setOnCancelCompleteDeferred,
      setOnDismissCompleteDeferred,
      setOnJobTerminalStatusDeferred,
      setServerActiveJobIdsDeferred,
      setActiveScanJobIds,
      addActiveScanJobId,
      removeActiveScanJobId,
      updateProgress,
      cancelAll,
      // cancelGenerationRef is a stable ref — intentionally omitted from deps
    ]
  );

 return (
 <ScanningContext.Provider value={value}>
 {children}
 </ScanningContext.Provider>
 );
};

