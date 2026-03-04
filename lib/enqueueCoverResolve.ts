/**
 * Enqueue cover resolution jobs to QStash.
 * Used when cache miss occurs: upsert pending, then enqueue. Worker resolves async and updates to ready.
 * Idempotent: dedupes by work_key via Redis (avoids duplicate jobs for same book).
 */

import { dedupeEnqueueItems } from './coverRateLimit';

export interface CoverResolveItem {
  workKey: string;
  isbn?: string;
  title?: string;
  author?: string;
}

const COVER_RESOLVE_WORKER_URL = process.env.COVER_RESOLVE_WORKER_URL || 'https://www.bookshelfscan.app/api/cover-resolve-worker';

export async function enqueueCoverResolve(
  items: CoverResolveItem[],
  jobId?: string
): Promise<boolean> {
  const token = process.env.QSTASH_TOKEN;
  const base = process.env.QSTASH_URL?.replace(/\/+$/, '');
  if (!token || !base) return false;
  if (items.length === 0) return true;

  const toEnqueue = await dedupeEnqueueItems(items);
  if (toEnqueue.length === 0) {
    return true; // All were recently enqueued
  }

  const publishUrl = `${base}/v2/publish/${COVER_RESOLVE_WORKER_URL}`;
  const body = jobId ? { items: toEnqueue, jobId } : { items: toEnqueue };
  try {
    const resp = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn('[enqueueCoverResolve] QStash publish failed:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('[enqueueCoverResolve] QStash publish error:', err?.message);
    return false;
  }
}
