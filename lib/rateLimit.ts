/**
 * Shared API rate limiting via Upstash Redis.
 * Use per IP (unauthenticated) or per userId (authenticated).
 * When Redis is not configured, all requests are allowed.
 */

import type { VercelRequest } from '@vercel/node';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

export type RateLimitNamespace = 'scan' | 'scan_guest' | 'enrich' | 'auth' | 'llm' | 'telemetry';

/** Default limits: requests per window. Window is 1 minute for all. Guest scan: low per IP. */
const DEFAULT_LIMITS: Record<RateLimitNamespace, { max: number; window: string }> = {
  scan: { max: 10, window: '1 m' },
  scan_guest: { max: 2, window: '1 m' },
  enrich: { max: 30, window: '1 m' },
  auth: { max: 10, window: '1 m' },
  llm: { max: 20, window: '1 m' },
  telemetry: { max: 60, window: '1 m' },
};

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSeconds: number;
};

/** Get client IP from Vercel request (x-forwarded-for, x-real-ip). */
export function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === 'string') {
    const ip = first.split(',')[0].trim();
    if (ip) return ip;
  }
  const real = req.headers['x-real-ip'];
  const rip = Array.isArray(real) ? real[0] : real;
  if (typeof rip === 'string' && rip.trim()) return rip.trim();
  return 'unknown';
}

let limiterCache: Partial<Record<RateLimitNamespace, Promise<{ limit: (id: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> } | null>>> = {};

async function getLimiter(namespace: RateLimitNamespace): Promise<{ limit: (id: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> } | null> {
  if (!HAS_REDIS) return null;
  const cached = limiterCache[namespace];
  if (cached !== undefined) return cached;
  try {
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });
    const opts = DEFAULT_LIMITS[namespace];
    const rl = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(opts.max, opts.window as import('@upstash/ratelimit').Duration),
      analytics: false,
    });
    const p = Promise.resolve(rl);
    limiterCache[namespace] = p;
    return p;
  } catch {
    limiterCache[namespace] = Promise.resolve(null);
    return null;
  }
}

/**
 * Check rate limit for this request.
 * Identifier: userId if provided (authenticated), otherwise client IP.
 * Returns result; when success is false, send 429 with Retry-After: retryAfterSeconds.
 */
export async function checkRateLimit(
  req: VercelRequest,
  namespace: RateLimitNamespace,
  options?: { userId?: string | null }
): Promise<RateLimitResult> {
  const identifier = options?.userId ?? getClientIp(req);
  const key = `${namespace}:${identifier}`;

  const limiter = await getLimiter(namespace);
  if (!limiter) {
    return { success: true, limit: 0, remaining: -1, reset: 0, retryAfterSeconds: 0 };
  }

  try {
    const result = await limiter.limit(key);
    const reset = result.reset;
    const resetMs = reset > 1e12 ? reset : reset * 1000;
    const retryAfterSeconds = Math.max(1, Math.min(60, Math.ceil((resetMs - Date.now()) / 1000)));
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfterSeconds,
    };
  } catch {
    return { success: true, limit: 0, remaining: -1, reset: 0, retryAfterSeconds: 0 };
  }
}

/**
 * Send 429 response with Retry-After and JSON body. Call when checkRateLimit returned success: false.
 */
export function sendRateLimitResponse(res: import('@vercel/node').VercelResponse, result: RateLimitResult): void {
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: result.retryAfterSeconds,
  });
}
