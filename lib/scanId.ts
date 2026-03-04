const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Always store and pass the full scan job id including the job_ prefix.
 * Use when: saving into queue/activeBatch, calling scan-status, comparing job ids.
 * Do not compare raw ids; always compare canonical ids.
 */
export function canonicalJobId(id: string | null | undefined): string | null {
  if (id == null || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('job_') ? trimmed : `job_${trimmed}`;
}

/** Normalize to scan_jobs.id format (job_<uuid>). Use for API calls and client state. */
export function toScanJobId(rawOrPrefixed: string): string {
  return rawOrPrefixed.startsWith('job_') ? rawOrPrefixed : `job_${rawOrPrefixed}`;
}

/**
 * Normalize to raw UUID only. Use only when writing to DB columns that store UUID (e.g. books.source_scan_job_id, scan_job_imports.scan_job_id).
 * Do not use for API query params or comparisons.
 */
export function toRawScanJobUuid(jobId: string): string | null {
  const raw = jobId.startsWith('job_') ? jobId.slice(4) : jobId;
  return raw && UUID_REGEX.test(raw) ? raw : null;
}

/**
 * Generate a unique scanId per image enqueue (UUID v4).
 * Ensures uniqueness across sessions and quick successive actions; stored in batch, mapped to jobId when server returns.
 */
export function uuidv4(): string {
  if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.randomUUID) {
    return (globalThis as any).crypto.randomUUID();
  }
  // Fallback: UUID v4 format with Math.random (uniqueness across sessions)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
