import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, AppState, AppStateStatus } from 'react-native';
import { CloseIcon } from './Icons';
import { getApiBaseUrl } from '../lib/getEnvVar';
import { canonicalJobId, toScanJobId } from '../lib/scanId';
import { getScanAuthHeaders } from '../lib/authHeaders';
import { useScanning } from '../contexts/ScanningContext';
import { useCamera } from '../contexts/CameraContext';
import { useTheme } from '../theme/ThemeProvider';
import { logger } from '../utils/logger';
import { sendTelemetry } from '../lib/clientTelemetry';
import { supabase } from '../lib/supabase';

interface ScanningNotificationProps {
  onCancelComplete?: () => void; // Deprecated: use cancelAll from context instead
}

export const ScanningNotification: React.FC<ScanningNotificationProps> = ({ onCancelComplete: propOnCancelComplete }) => {
  const { scanProgress, jobsInProgress, onCancelComplete: contextOnCancelComplete, onDismissComplete, onJobTerminalStatus, serverActiveJobIds, activeScanJobIds, cancelAll } = useScanning();
  const { isCameraActive } = useCamera();
  const { t } = useTheme();
  // cancelAll is the primary cancel path: it atomically clears context state + calls ScansTab's callback.
  // Fall back to prop/context onCancelComplete for backwards compat if cancelAll is somehow unavailable.
  const onCancelComplete = propOnCancelComplete || contextOnCancelComplete;

  // Hard guard: never call handler with "" or invalid id (stops log spam and wrong state order).
  const safeNotifyTerminal = useCallback((jobId: string | null | undefined, status: 'completed' | 'failed' | 'canceled', _caller: string, _payload?: Record<string, unknown>) => {
    if (jobId == null || typeof jobId !== 'string') return;
    const raw = jobId.trim();
    if (!raw || raw.length < 8) return;
    const full = toScanJobId(raw);
    if (full.length < 40) return;
    onJobTerminalStatus?.(full, status);
  }, [onJobTerminalStatus]);

 // Hooks must run unconditionally (Rules of Hooks). Early return for camera is after all hooks, before main JSX.
 const [serverProgress, setServerProgress] = useState<number | null>(null);
 const [serverStage, setServerStage] = useState<string | null>(null);
 /** Which job we're currently polling (first pending/processing). Kept in sync so progress doesn't reset when we switch jobs. */
 const [currentJobId, setCurrentJobId] = useState<string | null>(null);
 /** Progress 0100 per job so switching polled job doesn't reset the bar. */
 const [progressByJobId, setProgressByJobId] = useState<Record<string, number>>({});


 // Single poller: one setInterval, cleared on unmount and paused when app is backgrounded
 const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
 const appStateRef = useRef<AppStateStatus>(AppState.currentState);
 const sawSavingOrHighProgressRef = useRef(false);
 /** Only log SCAN_BAR when state changes (avoid spam every render). */
 const lastBarStateRef = useRef<{ show: boolean; activeScans: number; batchId: string | null } | null>(null);
 /** Deterministic job we're polling; survives closure re-creations so progress updates apply to the same job. */
 const trackedJobIdRef = useRef<string | null>(null);
 /** Per-job last status (log only on change per job). */
 const lastByJobRef = useRef<Record<string, { status: any; stage: any; progress: any }>>({});
 /** Last [SCAN_POLL_TARGETS] key (log only when targets change). */
 const lastPollTargetsKeyRef = useRef<string>('');
 /** Last tracked job (log [SCAN_TRACKED_JOB_CHANGE] only when it changes). */
 const lastTrackedRef = useRef<string | null>(null);
 /** Last SCAN_BAR_VARIANT logged (transition-only). */
 const lastBarVariantRef = useRef<string>('');
 /** Last [SCAN_BAR_INPUTS] snapshot (log only on change). */
 const lastBarInputsRef = useRef<{ activeJobId: string | null; p_progressByJob: number | undefined; p_serverProgress: number | null; doneCount: number; total: number } | null>(null);
 /** Base URL used for scan-status polling (diagnostic: compare to SCAN_JOB_POST baseUrl to detect mismatch). */
 const pollBaseUrlRef = useRef<string | null>(null);
 /** Fast poll (750ms) until we see progress > 0 or stage != queued/starting; then back off to 2.5s. */
 const pollIntervalMsRef = useRef(750);
 const sawRealProgressRef = useRef(false);
 /** Reschedule interval with current pollIntervalMsRef (switch fast slow). */
 const reschedulePollRef = useRef<(() => void) | null>(null);
 /** Mutex: skip tick if a fetch is already in flight to prevent double terminal handler / overlapping applies. */
 const inFlightRef = useRef(false);
 /** When server progress is 0, ramp start time for client-side 2%20% over ~10s so bar doesn't look frozen. */
 const rampStartMsRef = useRef<number>(0);
 /** Last [SCAN_BAR_PERCENT] log key; only log when percent delta >= 5 or stage change. */
 const lastPercentLogKeyRef = useRef<string>('');
 const lastPercentLoggedRef = useRef<number>(-1);
 const lastStageLoggedRef = useRef<string | null>(null);
 /** Last [SCAN_TICK] key: log only when tracked or candidates change. */
 const lastTickLogKeyRef = useRef<string>('');
 /** Keep bar visible at 100% briefly after all jobs complete before hiding. */
 const completionHoldUntilRef = useRef<number>(0);
 /** Last non-zero progress percent — used to show 100% exit animation. */
 const lastProgressPercentRef = useRef<number>(0);
 /** Whether we're in the "show 100%" exit phase. */
 const [showExitAt100, setShowExitAt100] = useState(false);
 const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Poll count for SCAN_STATUS_FETCH: log only every N polls or on error. */
  const pollCountRef = useRef(0);
  /** Where the UI last got progress (proves wiring: poll vs realtime). */
  const lastProgressSourceRef = useRef<'poll' | 'realtime' | null>(null);
  /** Last [SCAN_BAR_RENDER] log time; throttle to once per 2s. */
  const lastBarRenderLogMsRef = useRef<number>(0);
  /**
   * Stable batch total: set when we have work and a non-zero total; never reset to 0 until batch finishes/cancels.
   * Prevents "Scanning 1/0" when queue/job counts are briefly 0 (e.g. worker restart) while we're still processing.
   */
  const stableBatchTotalRef = useRef<number>(0);
  /**
   * Cancel epoch: incremented on every hard cancel. Every async callback (poll tick,
   * setTimeout completions, findActiveJob chains) captures the epoch at creation time
   * and no-ops if the current epoch has advanced. This prevents stale completions from
   * re-opening the bar after the user pressed X.
   */
  const cancelEpochRef = useRef(0);

  /**
   * Per-job terminal latch. Once a jobId is added here (on any terminal status:
   * completed | failed | canceled), all subsequent poll ticks for that job are
   * immediately ignored — even if a stale server response arrives late and claims
   * the job is back to "saving" or "processing".
   *
   * Cleared on hard-cancel / new scan so the next batch starts fresh.
   */
  const terminalJobsRef = useRef<Set<string>>(new Set());

  const clearPolling = useCallback(() => {
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
  }, []);

  /** Tracks whether the auto-dismiss callback has fired for the current batch. Reset on cancel so next batch can auto-dismiss. */
  const didAutoDismissRef = React.useRef(false);

  /**
   * Hard-cancel: immediately stops all local async work (polling, ramp timers, deferred
   * terminal handlers) by advancing the cancel epoch. Any async callback that captured an
   * earlier epoch will no-op when it resolves. Also resets all local display state so the
   * bar disappears synchronously without waiting for a React re-render cycle.
   *
   * Fix E: ONLY call hardCancel on explicit user action (Alert "Yes, Cancel"). Never call
   * on timeout, blur, or terminal status — otherwise the UI desyncs (job still real on server).
   */
  const hardCancel = useCallback(() => {
    cancelEpochRef.current += 1;
    clearPolling();
    inFlightRef.current = false;
    trackedJobIdRef.current = null;
    lastTrackedRef.current = null;
    sawSavingOrHighProgressRef.current = false;
    rampStartMsRef.current = 0;
    sawRealProgressRef.current = false;
    // Reset so the next scan batch can auto-dismiss without being blocked by this cancel.
    didAutoDismissRef.current = false;
    // Clear terminal latch so the next batch's jobs aren't pre-blocked.
    terminalJobsRef.current.clear();
    setCurrentJobId(null);
    setServerProgress(null);
    setServerStage(null);
    setProgressByJobId({});
    logger.info('[CANCEL_HARD]', 'scan bar hard-cancelled', { epoch: cancelEpochRef.current });
  }, [clearPolling]);

 // Progress is batch-scoped: scanProgress is derived from active ScanBatch (completedJobs / totalJobs). Never merge across batches.
 // Candidates must be real scan job IDs (from server: scan_jobs.id), not client scanId. Poll and terminal callbacks use these; passing scanId would corrupt active job state.
 const jobIds = (scanProgress as any)?.jobIds as string[] | undefined;
 const localQueueJobIds = (jobIds ?? []).map((id) => canonicalJobId(id) ?? id).filter((id): id is string => !!id);
 const fromServer = (serverActiveJobIds ?? []).map((id) => canonicalJobId(id) ?? id).filter((id): id is string => !!id);
 const fromActive = (activeScanJobIds ?? []).map((id) => canonicalJobId(id) ?? id).filter((id): id is string => !!id);
 // Rule 2: candidates = uniq(local + server + activeScanJobIds). activeScanJobIds keeps bar visible until server says terminal (no hard-cancel when Step C returns).
 // Fix D failsafe: exclude jobs we already know are terminal so bar hides even if removeActiveJob is delayed.
 const rawCandidates = Array.from(new Set([...localQueueJobIds, ...(jobIds ?? []).map((id) => canonicalJobId(id) ?? id).filter((id): id is string => !!id), ...fromServer, ...fromActive]));
 const MIN_JOB_ID_LEN = 8;
 const candidates = rawCandidates
   .filter((id): id is string => typeof id === 'string' && id.trim().length >= MIN_JOB_ID_LEN)
   .filter((id) => !terminalJobsRef.current.has(id) && !terminalJobsRef.current.has(canonicalJobId(id) ?? id));
 const jobIdsKey = candidates.length ? candidates.length + ':' + [...candidates].sort().join(',') : '';
 const serverActive = fromServer;

 // Poll for progress updates from server. Use deterministic trackedJobId (ref) so we don't lose it across ticks.
 useEffect(() => {
 // When candidates become empty, clear tracking and polling so we don't show stale activeJobId=null or weird percent.
 if (candidates.length === 0) {
 trackedJobIdRef.current = null;
 lastTrackedRef.current = null;
 setCurrentJobId(null);
 setServerProgress(null);
 setServerStage(null);
 setProgressByJobId({});
 sawSavingOrHighProgressRef.current = false;
 rampStartMsRef.current = 0;
 clearPolling();
 return;
 }

 sawSavingOrHighProgressRef.current = false;
 const batchId = (scanProgress as any)?.batchId;
 if (batchId) logger.debug('[ScanningNotification]', 'batchId', { batchId, jobCount: candidates.length });
 const baseUrl = getApiBaseUrl();
 pollBaseUrlRef.current = baseUrl;
 console.log('[SCAN_POLL_START]', { baseUrl, candidatesCount: candidates.length, firstCandidate: candidates[0] ?? null, ts: Date.now() });

 const pollTargetsKey = JSON.stringify([...candidates].sort());
 if (pollTargetsKey !== lastPollTargetsKeyRef.current) {
 lastPollTargetsKeyRef.current = pollTargetsKey;
 sendTelemetry('SCAN_POLL_TARGETS', { targetsLength: candidates.length, jobIds: candidates });
 }

 function logTrackedJob(trackedJobId: string | null, reason: string, details: { localQueueJobIds: string[]; serverActiveJobIds: string[]; status: { status: any; stage: any; progress: any } | null }) {
 if (trackedJobId !== lastTrackedRef.current) {
 const from = lastTrackedRef.current;
 logger.trace('[SCAN_TRACK_SELECT]', 'chosen', { candidates: [...candidates], chosen: trackedJobId, reason });
 logger.trace('[SCAN_TRACKED_JOB_CHANGE]', 'tracked job', { trackedJobId, reason, ...details });
 sendTelemetry('SCAN_TRACKED_JOB_CHANGE', { trackedJobId, reason, from, to: trackedJobId, ...details });
 lastTrackedRef.current = trackedJobId;
 }
 }

 const findActiveJob = async (): Promise<string | null> => {
 // Iterate latest-first so the bar switches to the newest scan when a second one starts.
 for (const jobId of [...candidates].reverse()) {
 try {
 const statusUrl = `${baseUrl}/api/scan-status?jobId=${encodeURIComponent(jobId)}`;
 const response = await fetch(statusUrl, {
 method: 'GET',
 headers: {
 'Accept': 'application/json',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
 'Pragma': 'no-cache'
 },
 cache: 'no-store'
 });

 if (response.ok) {
 const data = await response.json();
 if (data.status === 'pending' || data.status === 'processing') {
 return jobId;
 }
 }
 } catch (error) {
 logger.error('[SCAN_STATUS]', 'Error checking job status', { jobId, error });
 }
 }
 return null;
 };

  const pollProgress = async () => {
    if (appStateRef.current !== 'active') return;
    if (inFlightRef.current) return; // Prevent overlapping scan-status requests and double terminal handling.
    const epochAtStart = cancelEpochRef.current; // capture epoch; abort if it advances during await
    inFlightRef.current = true;
    pollCountRef.current += 1;
 const trackedBefore = trackedJobIdRef.current;
 const candidatesKey = candidates.length + ':' + (candidates[0] ?? '');
 const tickLogKey = `${trackedBefore ?? ''}:${candidatesKey}`;
 if (tickLogKey !== lastTickLogKeyRef.current) {
 lastTickLogKeyRef.current = tickLogKey;
 logger.trace('[SCAN_TICK]', 'tracked or candidates changed', { tracked: trackedBefore, candidatesCount: candidates.length, first: candidates[0] ?? null });
 }

 // If we have a tracked job, always fetch its status first. Only pick a new candidate when we have none.
    let trackedJobId = trackedJobIdRef.current;
    if (!trackedJobId) {
      const firstActive = await findActiveJob();
      if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
      if (!firstActive) {
        inFlightRef.current = false;
        return; // Do nothing; don't clear. Server may still have active job we haven't seen yet.
      }
      trackedJobId = firstActive;
 trackedJobIdRef.current = trackedJobId;
 sawRealProgressRef.current = false;
 rampStartMsRef.current = Date.now(); // Start client ramp when we pick a job (progress=0 until server responds).
 setCurrentJobId(trackedJobId);
 logTrackedJob(trackedJobId, 'select', {
 localQueueJobIds,
 serverActiveJobIds: serverActive,
 status: lastByJobRef.current[trackedJobId] ?? null,
 });
 }

 try {
 const statusUrl = `${baseUrl}/api/scan-status?jobId=${encodeURIComponent(trackedJobId)}`;
 const logFetch = pollCountRef.current === 1 || pollCountRef.current % 5 === 0;
 if (logFetch) logger.trace('[SCAN_STATUS_FETCH]', `poll #${pollCountRef.current}`, { baseUrl, jobId: trackedJobId });
 const response = await fetch(statusUrl, {
 method: 'GET',
 headers: {
 'Accept': 'application/json',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
 'Pragma': 'no-cache'
 },
 cache: 'no-store'
 });

        if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
      const data = response.ok ? await response.json() : null;
      const status = data?.status ?? null;
      const stage = data?.stage ?? null;
      const progress = data?.progress ?? null;
      const lastByJob = lastByJobRef.current;
      const prev = lastByJob[trackedJobId];
      const statusChanged = !prev || prev.status !== status || prev.stage !== stage || prev.progress !== progress;
      const stageOrStatusChanged = !prev || prev.status !== status || prev.stage !== stage;

      // ── Terminal latch ─────────────────────────────────────────────────────────
      // Once a job is terminal (completed | failed | canceled | not_found), ignore every further
      // poll response for it — including late server responses that still say "saving"
      // or "completed" after we already processed the terminal event.
      if (terminalJobsRef.current.has(trackedJobId)) {
        logger.trace('[SCAN_STATUS_LATCHED]', 'ignoring update for already-terminal job', {
          jobId: trackedJobId, status, stage,
        });
        inFlightRef.current = false;
        return;
      }
      // ──────────────────────────────────────────────────────────────────────────

      if (stageOrStatusChanged) {
        logger.info('[SCAN_STATUS_APPLY]', 'stage/status changed', { jobId: trackedJobId, status, stage, progress: progress ?? 'null' });
      }
      if (!response.ok) {
        const message = await response.text().catch(() => '');
        sendTelemetry('SCAN_STATUS_HTTP_ERROR', { jobId: trackedJobId, statusCode: response.status, message: (message ?? '').slice(0, 200) });
      }
      if (statusChanged) {
        sendTelemetry('SCAN_STATUS_CHANGE', { jobId: trackedJobId, status, stage, progress });
        lastByJobRef.current = { ...lastByJob, [trackedJobId]: { status, stage, progress } };
      }

      if (response.ok && data) {
        // Treat not_found as terminal (race/replica lag/RLS) so we remove from active list and bar can hide.
        const isTerminal = data.status === 'canceled' || data.status === 'completed' || data.status === 'failed' || data.status === 'not_found';
        if (isTerminal) {
          // Latch this job immediately so any concurrent or future poll tick is a no-op.
          const canonicalTerminal = canonicalJobId(trackedJobId) ?? trackedJobId;
          terminalJobsRef.current.add(canonicalTerminal);
          if (canonicalTerminal !== trackedJobId) terminalJobsRef.current.add(trackedJobId);
          logger.info('[SCAN_TERMINAL_HANDLER]', 'terminal', {
            jobId: trackedJobId,
            status: data.status,
            stage: stage ?? 'completed',
            progress: progress != null ? progress : 100,
          });
          sendTelemetry('SCAN_DONE_CLIENT', { jobId: trackedJobId, reason: 'status_complete', status: data.status });

          // ── CANCELED: hard-exit, no visual flash, no linger ─────────────────
          // A canceled job must NEVER show 100%, play the "save" animation, or
          // wait 1.2s — any of those re-open the bar after the user pressed X.
          if (data.status === 'canceled') {
            if (!trackedJobId || typeof trackedJobId !== 'string' || !trackedJobId.trim() || trackedJobId.trim().length < 8) {
              rampStartMsRef.current = 0;
              trackedJobIdRef.current = null;
              setCurrentJobId(null);
              setServerProgress(null);
              setServerStage(null);
              inFlightRef.current = false;
              return;
            }
            logger.info('[SCAN_TERMINAL_HANDLER]', 'canceled — clearing immediately', { jobId: trackedJobId });
            safeNotifyTerminal(trackedJobId, 'canceled', 'poll_tick_canceled', { responseStatus: data?.status, responseStage: stage });
            rampStartMsRef.current = 0;
            trackedJobIdRef.current = null;
            setCurrentJobId(null);
            setServerProgress(null);
            setServerStage(null);
            // No findActiveJob here: if the whole batch was canceled, candidates will be
            // empty on the next tick and the bar will hide naturally.
            inFlightRef.current = false;
            return;
          }

          // not_found: poll returned no such job (race/replica lag/RLS). Remove from active so bar can hide.
          if (data.status === 'not_found') {
            if (!trackedJobId || typeof trackedJobId !== 'string' || !trackedJobId.trim() || trackedJobId.trim().length < 8) {
              rampStartMsRef.current = 0;
              trackedJobIdRef.current = null;
              setCurrentJobId(null);
              setServerProgress(null);
              setServerStage(null);
              inFlightRef.current = false;
              return;
            }
            logger.info('[SCAN_TERMINAL_HANDLER]', 'not_found — clearing from active list', { jobId: trackedJobId });
            safeNotifyTerminal(trackedJobId, 'failed', 'poll_tick_not_found', { responseStatus: data?.status, responseStage: stage });
            rampStartMsRef.current = 0;
            trackedJobIdRef.current = null;
            setCurrentJobId(null);
            setServerProgress(null);
            setServerStage(null);
            findActiveJob().then((nextActiveJob) => {
              if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
              if (!nextActiveJob) {
                logTrackedJob(null, 'all_done', { localQueueJobIds, serverActiveJobIds: serverActive, status: null });
                inFlightRef.current = false;
                return;
              }
              sawRealProgressRef.current = false;
              rampStartMsRef.current = Date.now();
              trackedJobIdRef.current = nextActiveJob;
              setCurrentJobId(nextActiveJob);
              setProgressByJobId((p) => ({ ...p, [nextActiveJob]: 0 }));
              logTrackedJob(nextActiveJob, 'select', { localQueueJobIds, serverActiveJobIds: serverActive, status: lastByJobRef.current[nextActiveJob] ?? null });
              pollProgress();
            });
            inFlightRef.current = false;
            return;
          }

          const neverSawProgress = (prev?.progress == null || prev?.progress === 0) && (progress == null || progress === 0);
          const isCompleted = data.status === 'completed';

          // Fast job: completed before we ever saw progress — show 100% for 1.2s then dismiss.
          if (isCompleted && neverSawProgress) {
            rampStartMsRef.current = 0;
            setProgressByJobId((prev) => ({ ...prev, [trackedJobId]: 100 }));
            setServerProgress(100);
            setServerStage('completed');
            const delayMs = 1200;
            const epochAtTerminal = cancelEpochRef.current;
            setTimeout(() => {
              if (cancelEpochRef.current !== epochAtTerminal) return;
              if (!trackedJobId || typeof trackedJobId !== 'string' || !trackedJobId.trim() || trackedJobId.trim().length < 8) {
                trackedJobIdRef.current = null;
                setCurrentJobId(null);
                setServerProgress(null);
                setServerStage(null);
                return;
              }
              safeNotifyTerminal(trackedJobId, 'completed', 'poll_tick_fast_completed', { responseStatus: data?.status, responseStage: stage });
              trackedJobIdRef.current = null;
              setCurrentJobId(null);
              setServerProgress(null);
              setServerStage(null);
              findActiveJob().then((nextActiveJob) => {
                if (cancelEpochRef.current !== epochAtTerminal) return;
                if (nextActiveJob) {
                  sawRealProgressRef.current = false;
                  rampStartMsRef.current = Date.now();
                  trackedJobIdRef.current = nextActiveJob;
                  setCurrentJobId(nextActiveJob);
                  setProgressByJobId((p) => ({ ...p, [nextActiveJob]: 0 }));
                  logTrackedJob(nextActiveJob, 'select', {
                    localQueueJobIds,
                    serverActiveJobIds: serverActive,
                    status: lastByJobRef.current[nextActiveJob] ?? null,
                  });
                  pollProgress();
                }
              });
            }, delayMs);
            return;
          }

          // Normal terminal (completed with prior progress, or failed): show 100% then linger 1.2s.
          rampStartMsRef.current = 0;
          setProgressByJobId((prev) => ({ ...prev, [trackedJobId]: 100 }));
          setServerProgress(100);
          setServerStage(data.status);
          if (!trackedJobId || typeof trackedJobId !== 'string' || !trackedJobId.trim() || trackedJobId.trim().length < 8) {
            await new Promise((r) => setTimeout(r, 1200));
            if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
            trackedJobIdRef.current = null;
            const nextActiveJob = await findActiveJob();
            if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
            if (!nextActiveJob) {
              setCurrentJobId(null);
              setServerProgress(null);
              setServerStage(null);
              inFlightRef.current = false;
              return;
            }
            sawRealProgressRef.current = false;
            rampStartMsRef.current = Date.now();
            trackedJobIdRef.current = nextActiveJob;
            setCurrentJobId(nextActiveJob);
            setProgressByJobId((p) => ({ ...p, [nextActiveJob]: 0 }));
            pollProgress();
            inFlightRef.current = false;
            return;
          }
          safeNotifyTerminal(trackedJobId, data.status as 'completed' | 'failed', 'poll_tick_terminal', { responseStatus: data?.status, responseStage: stage });
          await new Promise((r) => setTimeout(r, 1200));
          if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
          trackedJobIdRef.current = null;
          const nextActiveJob = await findActiveJob();
          if (cancelEpochRef.current !== epochAtStart) { inFlightRef.current = false; return; }
          if (!nextActiveJob) {
            logTrackedJob(null, 'all_done', { localQueueJobIds, serverActiveJobIds: serverActive, status: null });
            setCurrentJobId(null);
            setServerProgress(null);
            setServerStage(null);
            return;
          }
          sawRealProgressRef.current = false;
          rampStartMsRef.current = Date.now();
          trackedJobIdRef.current = nextActiveJob;
          setCurrentJobId(nextActiveJob);
          setProgressByJobId((prev) => ({ ...prev, [nextActiveJob]: 0 }));
          logger.trace('[SCAN_TRACK_SELECT]', 'after_terminal', { candidates: [...candidates], chosen: nextActiveJob });
          logTrackedJob(nextActiveJob, 'select', {
            localQueueJobIds,
            serverActiveJobIds: serverActive,
            status: lastByJobRef.current[nextActiveJob] ?? null,
          });
          pollProgress();
          return;
        }

        // Non-terminal: update progress.
        // Guard again: if the job somehow became terminal (via a concurrent tick) between
        // the latch check above and here, discard this update.
        if (terminalJobsRef.current.has(trackedJobId)) {
          inFlightRef.current = false;
          return;
        }

        lastProgressSourceRef.current = 'poll';
        setServerStage(stage);
        if (data.stage === 'saving') sawSavingOrHighProgressRef.current = true;
        if (data.progress !== null && data.progress !== undefined) {
          const p = Math.min(100, Math.max(0, Number(data.progress)));
          const canonical = canonicalJobId(trackedJobId!) ?? trackedJobId!;
          setProgressByJobId((prev) => ({ ...prev, [canonical]: p }));
          setServerProgress(p);
          if (p > 0) rampStartMsRef.current = 0;
          if (p === 0 && !rampStartMsRef.current) rampStartMsRef.current = Date.now();
          if (p >= 95) sawSavingOrHighProgressRef.current = true;
          logger.trace('[SCAN_BAR_PROGRESS]', 'progress update', { jobId: trackedJobId, progress: p, stage });
        }

        // Switch to slow polling once we see real progress or non-queued stage.
        const stageLower = (stage ?? '').toLowerCase();
        const isQueuedOrStarting = stageLower === 'queued' || stageLower === 'starting';
        const hasRealProgress = (progress != null && progress > 0) || (stage && !isQueuedOrStarting);
        if (hasRealProgress && !sawRealProgressRef.current) {
          sawRealProgressRef.current = true;
          pollIntervalMsRef.current = 2500;
          reschedulePollRef.current?.();
        }
      }
    } catch (error) {
 logger.error('[SCAN_STATUS]', 'Error polling progress', { error });
 } finally {
 inFlightRef.current = false;
 }
 };

 const FAST_POLL_MS = 750;
 const SLOW_POLL_MS = 2500;
 pollIntervalMsRef.current = FAST_POLL_MS;
 sawRealProgressRef.current = false;
 clearPolling();
 pollProgress(); // immediate first poll as soon as we have candidates
 intervalIdRef.current = setInterval(pollProgress, pollIntervalMsRef.current);
 reschedulePollRef.current = () => {
 clearPolling();
 intervalIdRef.current = setInterval(pollProgress, pollIntervalMsRef.current);
 };

 const appStateSub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
 const prevState = appStateRef.current;
 appStateRef.current = nextState;
 sendTelemetry('APP_STATE_CHANGE', { state: nextState, previousState: prevState });
 if (nextState !== 'active') {
 clearPolling();
 setServerProgress(null);
 setServerStage(null);
 } else if (candidates.length > 0) {
 sendTelemetry('SCAN_POLL_RESUME', { jobCount: candidates.length, jobIds: candidates });
 pollIntervalMsRef.current = FAST_POLL_MS;
 sawRealProgressRef.current = false;
 clearPolling();
 pollProgress();
 intervalIdRef.current = setInterval(pollProgress, pollIntervalMsRef.current);
 }
 });

 return () => {
 clearPolling();
 appStateSub.remove();
 };
 }, [jobIdsKey, clearPolling]);

 // Optional: Supabase realtime on scan_jobs. When server updates progress/status we get it without waiting for next poll.
 const REALTIME_MAX_IDS = 20;
 useEffect(() => {
 if (candidates.length === 0) return;
 const safeCandidates = Array.isArray(candidates) ? candidates : [];
 const ids = safeCandidates.filter((id): id is string => typeof id === 'string').slice(0, REALTIME_MAX_IDS);
 const filter = ids.length === 1 ? `id=eq.${ids[0]}` : `id=in.(${ids.join(',')})`;
 const channel = supabase.channel(`scan_jobs:${ids.slice(0, 2).join(',')}`).on(
 'postgres_changes',
 { event: 'UPDATE', schema: 'public', table: 'scan_jobs', filter },
 (payload: { new: { id?: string; status?: string; progress?: number; stage?: string } }) => {
 const row = payload?.new;
 const rawId = row?.id != null && typeof row.id === 'string' ? row.id.trim() : '';
 if (!rawId || rawId.length < 8) return;
 const jobId = rawId;
 if (!ids.includes(jobId)) return; // only react to our active jobs (filter may not apply on all backends)
 const status = row.status;
 const progress = row.progress;
 const stage = row.stage;
        if (status === 'completed' || status === 'failed' || status === 'canceled') {
        if (!jobId || typeof jobId !== 'string' || !jobId.trim() || jobId.trim().length < 8) {
          return;
        }
        const canonicalTerminalRealtime = canonicalJobId(jobId) ?? jobId;
        if (!terminalJobsRef.current.has(jobId) && !terminalJobsRef.current.has(canonicalTerminalRealtime)) {
        terminalJobsRef.current.add(canonicalTerminalRealtime);
        terminalJobsRef.current.add(jobId);
        safeNotifyTerminal(jobId, status as 'completed' | 'failed' | 'canceled', 'realtime_postgres');
        }
 return;
 }
 lastProgressSourceRef.current = 'realtime';
 const canonical = canonicalJobId(jobId) ?? jobId;
 setProgressByJobId((prev) => ({ ...prev, [canonical]: progress != null ? Math.min(100, Math.max(0, progress)) : prev[canonical] }));
 if (trackedJobIdRef.current === jobId) {
 setServerProgress(progress != null ? progress : null);
 setServerStage(stage ?? null);
 }
 }
 ).subscribe((status) => {
 if (status === 'CHANNEL_ERROR') logger.warn('[SCAN_REALTIME]', 'subscribe error', { status });
 });
 return () => {
 supabase.removeChannel(channel);
 };
 }, [jobIdsKey, candidates.length, safeNotifyTerminal]);

  // Handle cancel with confirmation
  const handleCancel = () => {
    // Capture jobIds NOW, before any async work, so they survive state clearing.
    const jobIds = (scanProgress as any)?.jobIds as string[] | undefined;
    const idsToCancel: Array<{ displayId: string; dbId: string }> = (jobIds ?? [])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id: string) => {
        const raw = (id ?? '').startsWith('job_') ? (id ?? '').slice(4) : (id ?? '');
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
        return isUuid ? { displayId: id, dbId: raw } : null;
      })
      .filter((x): x is { displayId: string; dbId: string } => x !== null);

    Alert.alert(
      'Cancel Scan',
      'Are you sure you want to cancel this scan? This action cannot be undone.',
      [
        {
          text: 'No',
          style: 'cancel'
        },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            // Fix E: ONLY path that may call hardCancel/cancelAll — explicit user "Yes, Cancel".
            // Atomic cancel:
            //   1. hardCancel() — kills local polling, invalidates epoch, clears display state
            //   2. cancelAll()  — increments cancelGeneration (invalidates all async workers in
            //                     ScansTab), atomically zeros all context scan UI state, and
            //                     calls ScansTab's onCancelComplete to abort fetches + clear batch/queue.
            // Both fire synchronously so the bar disappears on this frame.
            hardCancel();
            cancelAll();
            if (idsToCancel.length === 0) {
              return;
            }
 logger.debug('[CANCEL]', 'Aborting in-flight requests and canceling on server', { jobCount: idsToCancel.length });
 const baseUrl = getApiBaseUrl();
 // Get auth headers once for all cancel requests (Bearer token for server ownership check).
 let cancelAuthHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
 try {
 cancelAuthHeaders = { ...cancelAuthHeaders, ...(await getScanAuthHeaders()) };
 } catch (_) { /* non-fatal: server still accepts cancel without auth for the job owner */ }

 for (const { displayId, dbId } of idsToCancel) {
 // Required pre-cancel log: shows which id is sent to server vs displayed in UI
 console.log('[CANCEL_REQUEST]', JSON.stringify({ jobId: displayId, scanJobId: dbId, usingId: dbId }));
 try {
 const response = await fetch(`${baseUrl}/api/scan-cancel`, {
 method: 'POST',
 headers: cancelAuthHeaders,
 // Always send the raw UUID (dbId) server's scan_jobs.id is uuid type
 body: JSON.stringify({ jobId: dbId }),
 });
 if (response.ok) {
 logger.debug('[CANCEL]', 'Canceled job', { jobId: displayId, dbId });
 } else {
 const errText = await response.text().catch(() => '');
 logger.error('[CANCEL]', 'Failed to cancel job', { jobId: displayId, dbId, status: response.status, body: (errText ?? '').slice(0, 200) });
 }
 } catch (error) {
 logger.error('[CANCEL]', 'Error canceling job', { jobId: displayId, dbId, error });
 }
 }
 }
 }
 ]
 );
 };

// Extract values from scanProgress (safe when null) so we can run auto-dismiss hook unconditionally
const totalScans = (scanProgress as any)?.totalScans ?? 0;
const completedScans = (scanProgress as any)?.completedScans ?? 0;
const failedScans = (scanProgress as any)?.failedScans ?? 0;
const canceledScans = (scanProgress as any)?.canceledScans ?? 0;
const currentScanId = (scanProgress as any)?.currentScanId;
const doneCount = completedScans + failedScans + canceledScans;
// isCompleted = all jobs done AND at least one job actually completed or failed (not a pure-cancel).
// Pure-cancel (all jobs canceled, none completed) hides the bar silently without triggering dismiss callback.
const isCompleted = !!scanProgress && totalScans > 0 && doneCount >= totalScans && !currentScanId
  && (completedScans + failedScans) > 0;

// didAutoDismissRef is declared above (hoisted before hardCancel) so it can be reset on hard-cancel.
React.useEffect(() => {
  if (isCompleted && onDismissComplete && !didAutoDismissRef.current) {
    didAutoDismissRef.current = true;
    onDismissComplete();
  }
  // Reset so next scan batch can auto-dismiss independently.
  if (!scanProgress) {
    didAutoDismissRef.current = false;
  }
}, [isCompleted, onDismissComplete, scanProgress]);

 // When no scanProgress, only hide if no work in flight. Otherwise show minimal bar (queue has work, batch not yet created).
 const inFlightCountForEarly = Math.max(jobsInProgress, (scanProgress as any)?.jobIds?.length ?? 0);
 if (!scanProgress && inFlightCountForEarly === 0) {
 if (lastBarVariantRef.current !== 'hidden') {
 sendTelemetry('SCAN_BAR_VARIANT', { variant: 'hidden', reason: 'no_progress' });
 lastBarVariantRef.current = 'hidden';
 }
 const prev = lastBarStateRef.current;
 if (prev?.show) {
 logger.once('scanbar_hide_no_progress', 'debug', '[SCAN_BAR]', 'hide', { reason: 'no_progress', activeScans: 0 });
 lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
 } else if (!prev) lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
 return null;
 }
 // Minimal progress when queue has work but derive effect hasn't set scanProgress yet (e.g. camera flow before jobId returns).
 const effectiveProgress = scanProgress ?? {
 totalScans: jobsInProgress,
 completedScans: 0,
 failedScans: 0,
 canceledScans: 0,
 currentScanId: null,
 jobIds: [],
 batchId: null,
 startTimestamp: Date.now(),
 };
const totalScansDisplay = effectiveProgress.totalScans ?? 0;
const completedScansDisplay = effectiveProgress.completedScans ?? 0;
const failedScansDisplay = effectiveProgress.failedScans ?? 0;
const canceledScansDisplay = (effectiveProgress as any).canceledScans ?? 0;
const doneCountDisplay = completedScansDisplay + failedScansDisplay + canceledScansDisplay;
// In-flight count: used to keep bar visible and to stabilize denominator (never show "1/0").
const effectiveJobIds = ((effectiveProgress as any)?.jobIds ?? []).map(canonicalJobId).filter((id): id is string => id != null);
const activeSet = new Set([...effectiveJobIds, ...(activeScanJobIds ?? []).map((id) => canonicalJobId(id) ?? id).filter(Boolean)]);
const inFlightCountEarly = Math.max(jobsInProgress, activeSet.size);
// Stable denominator: set once when we have work; never drop to 0 until batch finishes/cancels (avoids "Scanning 1/0" on worker restart).
if (inFlightCountEarly > 0) {
  if (totalScansDisplay > 0) {
    stableBatchTotalRef.current = Math.max(stableBatchTotalRef.current, totalScansDisplay);
  }
} else {
  stableBatchTotalRef.current = 0;
}
const totalScansDisplayStable = totalScansDisplay > 0
  ? totalScansDisplay
  : inFlightCountEarly > 0
    ? Math.max(stableBatchTotalRef.current, inFlightCountEarly, 1)
    : 0;
const isCompletedFromEffective = totalScansDisplayStable > 0 && doneCountDisplay >= totalScansDisplayStable && !(effectiveProgress as any).currentScanId
  && (completedScansDisplay + failedScansDisplay) > 0;
// Hide immediately for pure-cancel (all jobs canceled, none completed/failed).
const isPureCanceledFromEffective = totalScansDisplayStable > 0 && doneCountDisplay >= totalScansDisplayStable
  && completedScansDisplay === 0 && failedScansDisplay === 0;
if (isCompletedFromEffective || isPureCanceledFromEffective) {
  const hideReason = isPureCanceledFromEffective ? 'canceled' : 'completed';
  if (lastBarVariantRef.current !== 'hidden') {
    sendTelemetry('SCAN_BAR_VARIANT', { variant: 'hidden', reason: hideReason });
    lastBarVariantRef.current = 'hidden';
  }
  const prev = lastBarStateRef.current;
  if (prev?.show) {
    logger.once(`scanbar_hide_${hideReason}`, 'debug', '[SCAN_BAR]', 'hide', { reason: hideReason, activeScans: 0 });
    lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
  } else if (!prev) lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
  return null;
}

 // Reuse in-flight count from above (effectiveJobIds/activeSet already set for stable denominator).
 const inFlightCount = inFlightCountEarly;
 const activeScans = inFlightCount;
 const batchId = (effectiveProgress as any)?.batchId ?? null; // Metadata only, never a condition for showing.
 const showReason = (effectiveProgress as any)?.showReason ?? 'unknown';
 // Show bar when any in-flight queue item exists (jobsInProgress > 0).
 // When work finishes (inFlightCount drops to 0 from >0), show 100% for 2s then hide.
 const wasShowingWork = lastProgressPercentRef.current > 0;
 if (inFlightCount > 0) {
   // Active work — cancel any exit timer
   if (exitTimerRef.current) { clearTimeout(exitTimerRef.current); exitTimerRef.current = null; }
   if (showExitAt100) setShowExitAt100(false);
 } else if (inFlightCount === 0 && wasShowingWork && !showExitAt100 && !exitTimerRef.current) {
   // Just finished — enter exit phase (show 100% briefly)
   setShowExitAt100(true);
   exitTimerRef.current = setTimeout(() => {
     setShowExitAt100(false);
     lastProgressPercentRef.current = 0;
     exitTimerRef.current = null;
   }, 2000);
 }
 const shouldShow = inFlightCount > 0 || showExitAt100;
 if (!shouldShow) {
   lastProgressPercentRef.current = 0;
 if (lastBarVariantRef.current !== 'hidden') {
 sendTelemetry('SCAN_BAR_VARIANT', { variant: 'hidden', reason: 'no_work' });
 lastBarVariantRef.current = 'hidden';
 }
 const prev = lastBarStateRef.current;
 if (prev?.show) {
 logger.once('scanbar_hide_no_work', 'debug', '[SCAN_BAR]', 'hide', { reason: 'no_work', jobsInProgress, batchId });
 lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
 } else if (!prev) lastBarStateRef.current = { show: false, activeScans: 0, batchId: null };
 return null;
 }
 const prev = lastBarStateRef.current;
 const stateChanged = !prev || prev.show !== true || prev.activeScans !== activeScans || prev.batchId !== batchId;
 if (stateChanged) {
 logger.once(`scanbar_show_${batchId ?? 'queue'}`, 'debug', '[SCAN_BAR]', 'show', { reason: showReason, batchId, activeScans, jobsInProgress });
 lastBarStateRef.current = { show: true, activeScans, batchId };
 }

 // Diagnostic: prove wiring every time bar renders (throttle 2s). Shows if UI is never fetching or throwing away updates.
 if (shouldShow && candidates.length > 0) {
 const now = Date.now();
 if (now - lastBarRenderLogMsRef.current >= 2000) {
 lastBarRenderLogMsRef.current = now;
 const activeJobIds = [...candidates];
 const byJob = activeJobIds.map((id) => {
 const canonical = canonicalJobId(id) ?? id;
 const last = lastByJobRef.current[id] ?? lastByJobRef.current[canonical];
 const progress = progressByJobId[canonical] ?? progressByJobId[id];
 return {
 id: typeof id === 'string' ? id.slice(0, 8) : '(?)',
 progress: progress ?? last?.progress ?? null,
 stage: last?.stage ?? null,
 status: last?.status ?? null,
 updated_at: (last as { updated_at?: string })?.updated_at ?? null,
 };
 });
 logger.cat('[SCAN_BAR_RENDER]', '', {
  activeJobIds: activeJobIds.length,
  byJob,
  progressSource: lastProgressSourceRef.current,
 }, 'trace');
 }
 }

 // Batch-aware percent: never decrease unless batch resets. progressByJobId is keyed by canonical job id.
 // Never compute with activeJobId=null when we have a tracked job or any candidate (fixes stuck 2%).
 const firstCandidate = candidates?.length ? candidates[0] : null;
 const activeJobId = currentJobId ?? trackedJobIdRef.current ?? firstCandidate ?? null;
 const total = totalScansDisplayStable;
 const doneCountForPercent = doneCountDisplay;
 const progressKey = activeJobId != null ? (canonicalJobId(activeJobId) ?? activeJobId) : null;
 const p_progressByJob = progressKey != null ? progressByJobId[progressKey] : undefined;
 // Raw server progress 0–100 (same value we log in SCAN_BAR_RENDER). Prefer progressByJobId then serverProgress.
 let rawProgress: number | null = progressKey != null ? (progressByJobId[progressKey] ?? serverProgress ?? null) : (serverProgress ?? null);
 if (rawProgress === null) rawProgress = 0;
 const serverHasSentProgress = serverProgress !== null && serverProgress !== undefined;
 if (!serverHasSentProgress && rawProgress === 0 && activeJobId != null && rampStartMsRef.current) {
   const elapsed = Date.now() - rampStartMsRef.current;
   rawProgress = Math.min(20, 2 + (elapsed / 10_000) * 18);
 }
 const barInputs = { activeJobId, p_progressByJob, p_serverProgress: serverProgress, doneCount: doneCountForPercent, total };
 const lastInputs = lastBarInputsRef.current;
 const inputsChanged = !lastInputs || lastInputs.activeJobId !== barInputs.activeJobId || lastInputs.p_progressByJob !== barInputs.p_progressByJob || lastInputs.p_serverProgress !== barInputs.p_serverProgress || lastInputs.doneCount !== barInputs.doneCount || lastInputs.total !== barInputs.total;
 if (inputsChanged) {
   lastBarInputsRef.current = barInputs;
   logger.trace('[SCAN_BAR_INPUTS]', 'inputs changed', { activeJobId: barInputs.activeJobId, p_progressByJob: barInputs.p_progressByJob, p_serverProgress: barInputs.p_serverProgress, doneCount: barInputs.doneCount, total: barInputs.total, source: serverHasSentProgress ? 'server' : 'ramp' });
 }
 // Bar must use the same 0–100 value we log. When total===0 (e.g. activeScanJobIds only, no batch), use raw server progress; else batch-weighted.
 // When all jobs are done (doneCount === total && total > 0), force 100% so the bar
 // visually completes instead of jumping from ~43% to hidden.
 const allJobsDone = total > 0 && doneCountForPercent >= total;
 const overall = allJobsDone ? 1 : (total > 0 ? (doneCountForPercent + Math.min(1, Math.max(0, rawProgress / 100))) / total : rawProgress / 100);
 const normalizedProgress = total > 0 ? overall * 100 : rawProgress;
 const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
 const clampedProgress = clamp(Number(normalizedProgress ?? 0), 0, 100);
 // During exit phase, force 100%. Otherwise use calculated progress.
 const progressPercent = showExitAt100 ? 100 : Math.round(clampedProgress);
 // Track last non-zero progress for exit detection.
 if (progressPercent > 0 && !showExitAt100) lastProgressPercentRef.current = progressPercent;
 // Diagnostic: ensure bar fill uses same value we log (0–100, not fraction).
 if (__DEV__ && shouldShow && (progressPercent > 0 || rawProgress > 0)) {
   logger.trace('[SCAN_BAR_PROGRESS_WIRE]', {
     rawProgress,
     normalizedProgress,
     progressType: typeof normalizedProgress,
     clampedProgress,
     progressPercent,
     total,
     doneCountForPercent,
   });
 }

 // Server progress as optional "detail" for display (stage label + percent when available)
 const displayProgress = serverProgress !== null ? serverProgress : null;
 const displayStage = serverStage || null;
 // Map server stages to user-visible labels. Never show internal names (e.g. queue, openai_hedge) to users.
 const isIntensiveStage =
 displayStage === 'tiles' ||
 (typeof displayStage === 'string' && /openai|hedge/i.test(displayStage));
 const stageLabel =
 isIntensiveStage
 ? 'Intensive Scanning'
 : displayStage === 'saving'
 ? 'Fetching Covers'
 : displayStage === 'validating'
 ? 'Validating'
 : displayStage === 'scanning' || displayStage === 'claimed' || displayStage === 'downloading' || displayStage === 'downloaded' || displayStage === 'optimizing' || displayStage === 'optimized'
 ? 'Scanning'
 : displayStage === 'queue' || displayStage === 'queued'
 ? 'Starting'
 : displayStage && !/openai|hedge/i.test(displayStage)
 ? displayStage
 : 'Scanning';
 const showLargeScanNotice = isIntensiveStage;
 // Show "Fetching Covers" when we're in saving/high progress, or when percentage just disappeared (job completed) after we saw saving/95%
 const isFetchingCovers =
 displayStage === 'saving' ||
 (displayProgress !== null && displayProgress >= 95) ||
 (displayProgress === null && sawSavingOrHighProgressRef.current);
 // Show "Finishing" when we're near or at 100% (not when progress is unknown/low that stays "Scanning" or percentage).
 const isNearComplete = progressPercent >= 90 || (displayProgress != null && displayProgress >= 90);
 const finishingLabel = isNearComplete ? 'Finishing' : null;

 const barVariantKey = `progress:${activeJobId ?? ''}:${progressPercent}:${displayStage ?? ''}`;
 if (lastBarVariantRef.current !== barVariantKey) {
 sendTelemetry('SCAN_BAR_VARIANT', {
 variant: 'progress',
 jobId: activeJobId ?? null,
 statusSnapshot: { progressPercent, stage: displayStage ?? null, completedScansDisplay, totalScansDisplay: totalScansDisplayStable },
 });
 lastBarVariantRef.current = barVariantKey;
 }

 const percentLogKey = `${progressPercent}:${rawProgress}:${displayStage ?? ''}`;
 const stageNow = displayStage ?? null;
 const percentDelta = lastPercentLoggedRef.current >= 0 ? Math.abs(progressPercent - lastPercentLoggedRef.current) : 99;
 const stageChanged = lastStageLoggedRef.current !== stageNow;
 const shouldLogPercent = percentDelta >= 5 || stageChanged;
 if (lastPercentLogKeyRef.current !== percentLogKey && shouldLogPercent) {
 lastPercentLogKeyRef.current = percentLogKey;
 lastPercentLoggedRef.current = progressPercent;
 lastStageLoggedRef.current = stageNow;
 logger.debug('[SCAN_BAR_PERCENT]', 'percent or stage changed', { progressPercent, rawProgress, serverProgress, stage: displayStage, activeJobId });
 } else if (lastPercentLogKeyRef.current !== percentLogKey) {
 lastPercentLogKeyRef.current = percentLogKey;
 }

// Hide scan bar when user is taking a photo so it doesn't cover the take-photo button (after all hooks).
if (isCameraActive) return null;

// Phase 1: upload queue has work but no job id yet (bar shows "Uploading…"). Phase 2: job id exists ("Scanning…").
const isPhase1Uploading = jobsInProgress > 0 && activeScanJobIds.length === 0;

const barBg = t.colors.accentSurface ?? t.colors.surface2 ?? t.colors.surface;
return (
<View style={[styles.container, { backgroundColor: barBg, borderTopWidth: 1, borderTopColor: t.colors.border }]}>
 <View style={[styles.progressBarTrack, { backgroundColor: t.colors.border }]}>
 <View style={[styles.progressBarFill, { width: `${progressPercent}%`, backgroundColor: t.colors.accent }]} />
 </View>
 <View style={styles.content}>
 <View style={styles.headerRow}>
 <View style={styles.textContainer}>
 <Text style={[styles.title, { color: t.colors.text }]}>
 {isPhase1Uploading
   ? (jobsInProgress === 1 ? 'Uploading 1 image' : `Uploading ${jobsInProgress} images`)
   : activeScans > 0
     ? `Scanning ${activeScans} ${activeScans === 1 ? 'image' : 'images'}`
     : 'Scanning...'}
 </Text>
 {isPhase1Uploading ? (
   <Text style={[styles.eta, { color: t.colors.textMuted }]}>Uploading…</Text>
 ) : (progressPercent > 0 || displayStage || finishingLabel) ? (
 <Text style={[styles.progressText, { color: t.colors.text }]}>
 {finishingLabel ?? `${progressPercent}%${stageLabel ? ` ${stageLabel}` : ''}`}
 </Text>
 ) : activeScans > 0 && progressPercent === 0 && !displayStage && !finishingLabel ? (
 <Text style={[styles.eta, { color: t.colors.textMuted }]}>
 {isFetchingCovers ? 'Fetching Covers' : 'Starting'}
 </Text>
 ) : null}
 <Text style={[styles.subtitle, { color: t.colors.textMuted }]}>
 {isPhase1Uploading
   ? 'Preparing for scan…'
   : activeScans > 0
     ? `Processing scan ${completedScansDisplay + failedScansDisplay + 1}/${totalScansDisplayStable}`
     : totalScansDisplayStable > 0
       ? `${completedScansDisplay + failedScansDisplay}/${totalScansDisplayStable} completed`
       : ''}
 </Text>
 </View>
 <View style={styles.rightSection}>
 {showLargeScanNotice && (
 <Text style={[styles.largeScanNotice, { color: t.colors.textMuted }]}>Large Scan will delay results.</Text>
 )}
 <TouchableOpacity
 style={[styles.cancelButton, { backgroundColor: t.colors.accent }]}
 onPress={handleCancel}
 activeOpacity={0.7}
 >
 <CloseIcon size={20} color={t.colors.accentTextOn ?? t.colors.primaryText} />
 </TouchableOpacity>
 </View>
 </View>
 </View>
 </View>
 );
};

const styles = StyleSheet.create({
 container: {
 paddingHorizontal: 20,
 paddingVertical: 14,
 elevation: 0,
 shadowOpacity: 0,
 },
 progressBarTrack: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 height: 3,
 overflow: 'hidden',
 },
 progressBarFill: {
 height: '100%',
 },
 content: {
 width: '100%',
 },
 headerRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'flex-start',
 },
 textContainer: {
 flex: 1,
 marginRight: 12,
 },
 rightSection: {
 alignItems: 'flex-end',
 justifyContent: 'space-between',
 },
 largeScanNotice: {
 fontSize: 12,
 fontWeight: '500',
 marginBottom: 8,
 },
 title: {
 fontSize: 14,
 fontWeight: '600',
 letterSpacing: 0.3,
 marginBottom: 2,
 },
 progressText: {
 fontSize: 13,
 fontWeight: '600',
 marginBottom: 4,
 },
 eta: {
 fontSize: 12,
 marginBottom: 6,
 fontWeight: '500',
 },
 subtitle: {
 fontSize: 12,
 fontWeight: '400',
 },
 cancelButton: {
 width: 32,
 height: 32,
 borderRadius: 16,
 justifyContent: 'center',
 alignItems: 'center',
 marginTop: -2,
 },
});

