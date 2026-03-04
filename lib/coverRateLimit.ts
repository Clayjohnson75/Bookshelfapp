/**
 * Global rate limiting and enqueue deduplication for cover resolution.
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 * Falls back to no-op when Redis is not configured.
 */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

/** Rate limit: max 8 cover resolutions per 5 seconds (global across workers). */
async function getCoverRateLimiter() {
  if (!HAS_REDIS) return null;
  try {
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(8, '5 s'),
      analytics: false,
    });
  } catch {
    return null;
  }
}

let limiterPromise: Promise<Awaited<ReturnType<typeof getCoverRateLimiter>>> | null = null;

/** Acquire a slot from global rate limiter. Returns true if allowed, false if limited. */
export async function acquireCoverRateLimit(): Promise<boolean> {
  const limiter = limiterPromise ?? (limiterPromise = getCoverRateLimiter());
  const rl = await limiter;
  if (!rl) return true; // No Redis: allow
  try {
    const { success } = await rl.limit('cover_resolve_global');
    return success;
  } catch {
    return true; // On error, allow to avoid blocking
  }
}

const ENQUEUE_DEDUPE_TTL = 300; // 5 minutes - don't re-enqueue same work_key

/** Try to claim enqueue for work_key. Returns true if we should enqueue, false if already enqueued recently. */
export async function tryClaimEnqueue(workKey: string): Promise<boolean> {
  if (!HAS_REDIS) return true; // No Redis: always enqueue
  try {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });
    const key = `cover_enqueue:${workKey}`;
    const ok = await redis.set(key, '1', { ex: ENQUEUE_DEDUPE_TTL, nx: true });
    return ok === 'OK';
  } catch {
    return true; // On error, enqueue to avoid losing work
  }
}

/** Filter items to only those we haven't enqueued recently (idempotent). */
export async function dedupeEnqueueItems<T extends { workKey: string }>(items: T[]): Promise<T[]> {
  const results = await Promise.all(items.map(async (item) => ({
    item,
    claim: await tryClaimEnqueue(item.workKey),
  })));
  return results.filter(r => r.claim).map(r => r.item);
}
