import type { Book } from './BookTypes';

/** Per-job result within a batch. jobIds[i] and scanIds[i] are 1:1. */
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

export interface JobResult {
 status: JobStatus;
 books?: Book[];
}

/** Aggregate status for the whole batch. */
export type BatchStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

/**
 * Batch model: primary key for scan UI state.
 * Immutable per batch; never merge across batches.
 * Persisted in AsyncStorage keyed by batchId (user-scoped: scan_batch_${userId}_${batchId}).
 */
export interface ScanBatch {
 batchId: string;
 createdAt: number;
 /** Server job IDs (same order as scanIds). */
 jobIds: string[];
 /** Client scan IDs (same order as jobIds). */
 scanIds: string[];
 status: BatchStatus;
 /** Result per jobId; updated as jobs complete. */
 resultsByJobId: Record<string, JobResult>;
 /** Job IDs that have been imported to library (e.g. after "Done"). */
 importedJobIds: string[];
 /** Total expected number of jobs (set at batch creation from scanIds/records count).
  *  Use instead of jobIds.length for progress total, since jobIds may not be fully
  *  populated until all uploads complete and receive server job IDs. */
 expectedJobCount?: number;
}

export function isTerminalJobStatus(s: JobStatus): boolean {
 return s === 'completed' || s === 'failed' || s === 'canceled';
}

export function isTerminalBatchStatus(s: BatchStatus): boolean {
 return s === 'completed' || s === 'failed' || s === 'canceled';
}

/** Completed jobs count / total jobs (01). Use for single progress bar. */
export function batchProgress(batch: ScanBatch): { completed: number; total: number; fraction: number } {
 const total = batch.expectedJobCount ?? batch.jobIds.length;
 if (total === 0) return { completed: 0, total: 0, fraction: 0 };
 const completed = batch.jobIds.filter(
 (jid) => isTerminalJobStatus(batch.resultsByJobId[jid]?.status ?? 'queued')
 ).length;
 return { completed, total, fraction: completed / total };
}

/** Derive batch status from results: if any job still running processing; else terminal. */
export function deriveBatchStatus(batch: ScanBatch): BatchStatus {
 const expectedTotal = batch.expectedJobCount ?? batch.jobIds.length;
 const total = batch.jobIds.length;
 if (total === 0) return batch.status;
 // Not all jobs have server IDs yet — batch is still processing
 if (expectedTotal > total) return 'processing';
 let hasCanceled = false;
 let hasFailed = false;
 let allTerminal = true;
 for (const jid of batch.jobIds) {
 const s = batch.resultsByJobId[jid]?.status ?? 'queued';
 if (!isTerminalJobStatus(s)) {
 allTerminal = false;
 break;
 }
 if (s === 'canceled') hasCanceled = true;
 if (s === 'failed') hasFailed = true;
 }
 if (!allTerminal) return 'processing';
 if (hasCanceled) return 'canceled';
 if (hasFailed) return 'failed';
 return 'completed';
}
