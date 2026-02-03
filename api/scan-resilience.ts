/**
 * Resilience utilities for scan pipeline
 * Handles retries, circuit breakers, time budgets, and scan job management
 */

// Circuit breaker state for Gemini overload
interface CircuitBreakerState {
  consecutive503s: number;
  last503Time: number;
  cooldownUntil: number;
  recent503Rate: number; // 0-1, percentage of last 10 requests that were 503
  recentRequests: Array<{ time: number; was503: boolean }>;
  quotaExceeded: boolean; // True if quota/billing error detected
  quotaCooldownUntil: number; // Cooldown for quota errors (longer - 30-60 minutes)
}

let geminiCircuitBreaker: CircuitBreakerState = {
  consecutive503s: 0,
  last503Time: 0,
  cooldownUntil: 0,
  recent503Rate: 0,
  recentRequests: [],
  quotaExceeded: false,
  quotaCooldownUntil: 0,
};

const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 consecutive 503s triggers cooldown
const CIRCUIT_BREAKER_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown
const CIRCUIT_BREAKER_RATE_THRESHOLD = 0.5; // 50% 503 rate in last 10 requests
const CIRCUIT_BREAKER_WINDOW = 10; // Track last 10 requests

/**
 * Check if Gemini is in cooldown (circuit breaker)
 * Returns true if either regular cooldown OR quota exceeded
 */
export function isGeminiInCooldown(): boolean {
  const now = Date.now();
  
  // Check quota cooldown first (longer, more serious)
  if (geminiCircuitBreaker.quotaExceeded && now < geminiCircuitBreaker.quotaCooldownUntil) {
    return true;
  }
  
  // Reset quota cooldown if expired
  if (geminiCircuitBreaker.quotaExceeded && now >= geminiCircuitBreaker.quotaCooldownUntil) {
    geminiCircuitBreaker.quotaExceeded = false;
    geminiCircuitBreaker.quotaCooldownUntil = 0;
  }
  
  // Check regular cooldown
  if (now < geminiCircuitBreaker.cooldownUntil) {
    return true;
  }
  
  // Reset if cooldown expired
  if (geminiCircuitBreaker.cooldownUntil > 0 && now >= geminiCircuitBreaker.cooldownUntil) {
    geminiCircuitBreaker.consecutive503s = 0;
    geminiCircuitBreaker.cooldownUntil = 0;
  }
  
  return false;
}

/**
 * Check if Gemini quota is exceeded (most serious - don't even try)
 */
export function isGeminiQuotaExceeded(): boolean {
  const now = Date.now();
  if (geminiCircuitBreaker.quotaExceeded && now < geminiCircuitBreaker.quotaCooldownUntil) {
    return true;
  }
  
  // Reset if cooldown expired
  if (geminiCircuitBreaker.quotaExceeded && now >= geminiCircuitBreaker.quotaCooldownUntil) {
    geminiCircuitBreaker.quotaExceeded = false;
    geminiCircuitBreaker.quotaCooldownUntil = 0;
  }
  
  return false;
}

/**
 * Record a Gemini quota/billing error - most serious, long cooldown
 */
export function recordGeminiQuotaError(scanId: string, cooldownMinutes: number = 30): void {
  const now = Date.now();
  geminiCircuitBreaker.quotaExceeded = true;
  geminiCircuitBreaker.quotaCooldownUntil = now + (cooldownMinutes * 60 * 1000);
  
  console.error(`[SCAN ${scanId}] 🔴 Gemini QUOTA EXCEEDED - disabling for ${cooldownMinutes} minutes. Falling back to OpenAI immediately.`);
}

/**
 * Record a Gemini 503 error and update circuit breaker state
 */
export function recordGemini503(scanId: string): void {
  const now = Date.now();
  geminiCircuitBreaker.consecutive503s++;
  geminiCircuitBreaker.last503Time = now;
  
  // Add to recent requests window
  geminiCircuitBreaker.recentRequests.push({ time: now, was503: true });
  // Keep only last N requests
  if (geminiCircuitBreaker.recentRequests.length > CIRCUIT_BREAKER_WINDOW) {
    geminiCircuitBreaker.recentRequests.shift();
  }
  
  // Calculate recent 503 rate
  const recent503s = geminiCircuitBreaker.recentRequests.filter(r => r.was503).length;
  geminiCircuitBreaker.recent503Rate = recent503s / geminiCircuitBreaker.recentRequests.length;
  
  // Trigger cooldown if threshold reached
  if (geminiCircuitBreaker.consecutive503s >= CIRCUIT_BREAKER_THRESHOLD ||
      geminiCircuitBreaker.recent503Rate >= CIRCUIT_BREAKER_RATE_THRESHOLD) {
    geminiCircuitBreaker.cooldownUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.log(`[SCAN ${scanId}] 🔴 Gemini circuit breaker triggered: ${geminiCircuitBreaker.consecutive503s} consecutive 503s, ${(geminiCircuitBreaker.recent503Rate * 100).toFixed(0)}% rate. Cooldown for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
  }
}

/**
 * Record a successful Gemini request (reset consecutive 503s)
 */
export function recordGeminiSuccess(scanId: string): void {
  const now = Date.now();
  geminiCircuitBreaker.consecutive503s = 0;
  
  // Add to recent requests window
  geminiCircuitBreaker.recentRequests.push({ time: now, was503: false });
  // Keep only last N requests
  if (geminiCircuitBreaker.recentRequests.length > CIRCUIT_BREAKER_WINDOW) {
    geminiCircuitBreaker.recentRequests.shift();
  }
  
  // Recalculate recent 503 rate
  const recent503s = geminiCircuitBreaker.recentRequests.filter(r => r.was503).length;
  geminiCircuitBreaker.recent503Rate = recent503s / geminiCircuitBreaker.recentRequests.length;
}

/**
 * Retry with exponential backoff + jitter
 * Handles 503 (model overloaded) and 429 (rate limit) errors
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  scanId: string,
  is503: boolean = false
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      // CRITICAL: Don't retry quota errors - fail immediately
      if (error?.isQuotaError || 
          (error?.status === 429 && error?.message?.toLowerCase().includes('quota'))) {
        console.error(`[SCAN ${scanId}] Quota error detected - not retrying, failing immediately`);
        throw error;
      }
      
      // Check if it's a retryable error (503 or 429 rate limit, not quota)
      const isRetryable = (error?.status === 503 || 
                          error?.status === 429 ||
                          error?.statusCode === 503 ||
                          error?.statusCode === 429 ||
                          error?.message?.includes('503') ||
                          error?.message?.includes('429')) && !error?.isQuotaError;
      
      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }
      
      // Calculate backoff: 1s ±30%, then 3s ±30%
      let baseDelay: number;
      if (attempt === 0) {
        baseDelay = 1000; // 1 second
      } else {
        baseDelay = 3000; // 3 seconds
      }
      
      // Add jitter (±30%)
      const jitter = baseDelay * 0.3 * (Math.random() * 2 - 1); // -30% to +30%
      const delay = Math.max(100, baseDelay + jitter);
      
      // Respect Retry-After header if present
      let finalDelay = delay;
      if (error?.retryAfter && typeof error.retryAfter === 'number') {
        finalDelay = error.retryAfter * 1000; // Convert seconds to ms
        console.log(`[SCAN ${scanId}] Using Retry-After header: ${error.retryAfter}s`);
      }
      
      console.log(`[SCAN ${scanId}] Retryable error (${error?.status || 'unknown'}): retrying in ${Math.ceil(finalDelay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      
      await new Promise(resolve => setTimeout(resolve, finalDelay));
    }
  }
  
  throw lastError;
}

/**
 * Time budget manager for scan operations
 */
export class ScanTimeBudget {
  private startTime: number;
  private totalBudget: number;
  private geminiBudget: number;
  private openaiBudget: number;
  private scanId: string;
  
  constructor(scanId: string, totalBudgetMs: number = 75000, geminiBudgetMs: number = 20000) {
    this.scanId = scanId;
    this.startTime = Date.now();
    this.totalBudget = totalBudgetMs;
    this.geminiBudget = geminiBudgetMs;
    this.openaiBudget = totalBudgetMs - geminiBudgetMs; // Remaining time for OpenAI
  }
  
  /**
   * Check if we've exceeded the total budget
   */
  hasExceededBudget(): boolean {
    const elapsed = Date.now() - this.startTime;
    return elapsed >= this.totalBudget;
  }
  
  /**
   * Check if we've exceeded Gemini budget
   */
  hasExceededGeminiBudget(): boolean {
    const elapsed = Date.now() - this.startTime;
    return elapsed >= this.geminiBudget;
  }
  
  /**
   * Get remaining time for OpenAI
   */
  getRemainingOpenAITime(): number {
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.openaiBudget - (elapsed - this.geminiBudget));
  }
  
  /**
   * Get elapsed time
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }
  
  /**
   * Create AbortController with timeout for remaining budget
   */
  createAbortController(provider: 'gemini' | 'openai'): { controller: AbortController; timeout: NodeJS.Timeout } {
    const controller = new AbortController();
    const remaining = provider === 'gemini' 
      ? Math.max(0, this.geminiBudget - this.getElapsedTime())
      : Math.max(0, this.getRemainingOpenAITime());
    
    const timeout = setTimeout(() => {
      controller.abort();
    }, remaining);
    
    return { controller, timeout };
  }
  
  logStatus(): void {
    const elapsed = this.getElapsedTime();
    const remaining = this.totalBudget - elapsed;
    console.log(`[SCAN ${this.scanId}] Time budget: ${elapsed}ms elapsed, ${remaining}ms remaining (total: ${this.totalBudget}ms)`);
  }
}

/**
 * Generate a unique scan ID
 */
export function generateScanId(imageDataURL?: string): string {
  if (imageDataURL) {
    // Use hash of image data for deterministic IDs (same image = same scanId)
    // Simple hash function
    let hash = 0;
    const str = imageDataURL.substring(0, 1000); // Use first 1000 chars for hash
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `scan_${Math.abs(hash)}_${Date.now()}`;
  }
  return `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

