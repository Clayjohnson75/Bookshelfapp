import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  generateScanId,
  retryWithBackoff,
  isGeminiInCooldown,
  isGeminiQuotaExceeded,
  recordGemini503,
  recordGeminiQuotaError,
  recordGeminiSuccess,
  ScanTimeBudget,
} from './scan-resilience';

// Basic helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Log level system
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logLevels: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function log(level: keyof typeof logLevels, ...args: any[]) {
  const currentLevel = logLevels[LOG_LEVEL] ?? logLevels.info;
  if (logLevels[level] <= currentLevel) {
    console.log(`[${level.toUpperCase()}]`, ...args);
  }
}

// Gemini rate limiter: GLOBAL queue with single-flight execution
// HARD RULE: Only ONE Gemini request at a time, globally
// This prevents burst RPM limits (Gemini 3 Pro = 25 RPM, but burst tolerance is lower)

interface GeminiQueueItem {
  imageDataURL: string;
  resolve: (value: any[]) => void;
  reject: (error: any) => void;
  retryCount: number;
  timestamp: number;
  scanId?: string; // Add scanId to queue items
}

let geminiQueue: GeminiQueueItem[] = [];
let geminiProcessing = false;
let lastGeminiRequestTime = 0;
// Target 20 RPM (safely under Gemini 3 Pro's 25 RPM limit)
const MIN_GEMINI_INTERVAL_MS = 3000; // 3 seconds minimum between requests = 20 RPM max
const MAX_GEMINI_RETRIES = 2; // Max retries (but with proper delays, not immediate)
let geminiModelVerified = false; // Track if we've verified the model exists

// Track finalized scans to prevent late results from updating state
const finalizedScans = new Set<string>();

/**
 * Process Gemini queue - ensures single-flight execution
 * Only ONE Gemini request runs at a time, globally
 */
async function processGeminiQueue(): Promise<void> {
  // If already processing or queue is empty, return
  if (geminiProcessing || geminiQueue.length === 0) {
    return;
  }
  
  geminiProcessing = true;
  
  while (geminiQueue.length > 0) {
    const item = geminiQueue.shift()!;
    const now = Date.now();
    
    // Enforce minimum interval between requests
    const timeSinceLastRequest = now - lastGeminiRequestTime;
    if (timeSinceLastRequest < MIN_GEMINI_INTERVAL_MS) {
      const waitTime = MIN_GEMINI_INTERVAL_MS - timeSinceLastRequest;
      console.log(`[API] Gemini queue: waiting ${Math.ceil(waitTime/1000)}s before next request (enforcing ${MIN_GEMINI_INTERVAL_MS}ms interval, ${geminiQueue.length} in queue)...`);
      await delay(waitTime);
    }
    
    const logPrefix = item.scanId ? `[SCAN ${item.scanId}]` : '[API]';
    
    // CRITICAL: Check if quota exceeded - don't even try, resolve empty immediately
    if (isGeminiQuotaExceeded()) {
      console.log(`${logPrefix} Gemini quota exceeded - skipping request, returning empty (will use OpenAI)`);
      item.resolve([]);
      continue; // Skip to next item
    }
    
    try {
      console.log(`${logPrefix} Gemini queue: processing request (${geminiQueue.length} remaining, retry ${item.retryCount})...`);
      lastGeminiRequestTime = Date.now();
      
      const result = await scanWithGeminiDirect(item.imageDataURL, item.scanId);
      item.resolve(result.books); // Extract books array for queue compatibility
    } catch (error: any) {
      // CRITICAL: If quota error, don't retry - resolve empty immediately
      if (error?.isQuotaError || (error?.status === 429 && error?.message?.toLowerCase().includes('quota'))) {
        console.error(`${logPrefix} Gemini quota error - not retrying, returning empty (will use OpenAI)`);
        item.resolve([]); // Return empty, will fallback to OpenAI
        continue; // Skip to next item
      }
      
      // Handle 429 errors (rate limit, not quota) - re-queue with delay
      if (error?.status === 429 || error?.message?.includes('429') || error?.statusCode === 429) {
        if (item.retryCount < MAX_GEMINI_RETRIES) {
          // Use Retry-After header if provided, otherwise use longer backoff (30s/90s)
          let retryDelay: number;
          if (error?.retryAfter && typeof error.retryAfter === 'number') {
            retryDelay = error.retryAfter * 1000; // Convert seconds to ms
            console.log(`[API] Gemini 429: Using Retry-After header: ${error.retryAfter}s`);
          } else {
            // Longer backoff: 30s, 90s (more conservative)
            retryDelay = item.retryCount === 0 ? 30000 : 90000; // 30s first retry, 90s second
            const jitter = Math.random() * 5000; // 0-5s random
            retryDelay += jitter;
          }
          
          console.log(`[API] Gemini 429: re-queuing with ${Math.ceil(retryDelay/1000)}s delay (retry ${item.retryCount + 1}/${MAX_GEMINI_RETRIES})...`);
          
          // Add back to queue with delay
          setTimeout(() => {
            geminiQueue.push({
              ...item,
              retryCount: item.retryCount + 1,
              timestamp: Date.now(),
            });
            processGeminiQueue(); // Process queue again
          }, retryDelay);
        } else {
          console.error(`[API] Gemini failed after ${MAX_GEMINI_RETRIES} retries, returning empty array`);
          item.resolve([]); // Return empty instead of failing
        }
      } else {
        // Non-429 error - fail immediately
        console.error(`[API] Gemini non-429 error:`, error?.message || error);
        item.resolve([]); // Return empty on other errors too
      }
    }
  }
  
  geminiProcessing = false;
}

/**
 * Queue a Gemini request (single-flight execution)
 */
function queueGeminiRequest(imageDataURL: string, retryCount = 0, scanId?: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    geminiQueue.push({
      imageDataURL,
      resolve,
      reject,
      retryCount,
      timestamp: Date.now(),
      scanId,
    });
    
    // Start processing if not already running
    processGeminiQueue();
  });
}

/**
 * List available Gemini models - verifies model availability and quota surface
 */
async function listGeminiModels(): Promise<{ success: boolean; models?: string[]; endpoint?: string; error?: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { success: false, error: 'No API key' };
  }
  
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
  
  try {
    const res = await fetch(`${endpoint}?key=${key}`);
    if (!res.ok) {
      const errorText = await res.text();
      return {
        success: false,
        endpoint: 'generativelanguage.googleapis.com',
        error: `Status ${res.status}: ${errorText.slice(0, 200)}`,
      };
    }
    
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = data.models?.map(m => m.name.replace('models/', '')) || [];
    
    return {
      success: true,
      models,
      endpoint: 'generativelanguage.googleapis.com',
    };
  } catch (error: any) {
    return {
      success: false,
      endpoint: 'generativelanguage.googleapis.com',
      error: error?.message || String(error),
    };
  }
}

/**
 * Health check for Gemini API - confirms endpoint and quota surface
 */
async function pingGeminiAPI(model: string): Promise<{ success: boolean; endpoint?: string; model?: string; error?: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { success: false, error: 'No API key' };
  }
  
  // Verify URL format: POST /v1beta/models/<model>:generateContent
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  
  try {
    const res = await fetch(`${endpoint}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
      }),
    });
    
    const errorText = res.ok ? undefined : await res.text();
    
    return {
      success: res.ok,
      endpoint: 'generativelanguage.googleapis.com',
      model,
      error: res.ok ? undefined : `Status ${res.status}: ${errorText?.slice(0, 200) || 'Unknown error'}`,
    };
  } catch (error: any) {
    return {
      success: false,
      endpoint: 'generativelanguage.googleapis.com',
      model,
      error: error?.message || String(error),
    };
  }
}

/**
 * Direct Gemini API call (no queue, used by queue processor)
 * Now includes retry logic for 503 and 429 errors
 */
interface GeminiScanResult {
  books: any[];
  usedRepair: boolean;
  rawLength: number;
  needsOpenAI?: boolean; // Optional flag for quality gate failures
}

async function scanWithGeminiDirect(imageDataURL: string, scanId?: string): Promise<GeminiScanResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { books: [], usedRepair: false, rawLength: 0 };
  
  const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
  
  // Use valid model name - gemini-3-flash-preview (as per Google docs)
  // Verify model exists via ListModels call on startup
  const model = 'gemini-3-flash-preview'; // Valid model for generateContent
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  
  console.log(`${logPrefix} Gemini request: endpoint=generativelanguage.googleapis.com, model=${model}, client=vanilla-fetch, URL=POST /v1beta/models/${model}:generateContent`);
  
  const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
  
  // Log image payload being sent to Gemini
  const imageBytesLengthSentToGemini = base64Data.length;
  const imageMimeSentToGemini = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
  console.log(`${logPrefix} Sending to Gemini: imageBytes=${imageBytesLengthSentToGemini}, mime=${imageMimeSentToGemini}, scanId=${scanId || 'none'}`);
  
  // Wrap fetch in retry logic for 503 and 429
  try {
    const result = await retryWithBackoff(async () => {
      const res = await fetch(
        `${endpoint}?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Scan book spines in this image and return ONLY a JSON array. No markdown. No explanations.

CRITICAL RULES:
- TITLE is the book name (usually larger text on spine)
- AUTHOR is the person's name who wrote it (usually smaller text)
- DO NOT swap title and author - titles are book names, authors are people's names
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy)
- Detect language: "en", "es", "fr", or "unknown"

Return only a JSON array like:
[{"title":"Book Title","author":"Author Name","confidence":"high","spine_text":"raw text","language":"en","reason":"brief reason","spine_index":0}]`,
                  },
                  { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
                ],
              },
            ],
            generationConfig: { 
              responseMimeType: "application/json", // Force JSON-only output at API level
              temperature: 0, // Minimize randomness and formatting drift
              maxOutputTokens: 16000, // Increased significantly for shelf scans (was 8000, now 16000)
              // Note: responseJsonSchema is not supported for this endpoint/model
              // responseMimeType: "application/json" forces JSON format and prevents markdown/prose
            },
          }),
        }
      );
      
      // Check for Retry-After header
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
      
      // Handle 429 errors FIRST - check if it's quota/billing (most serious)
      if (res.status === 429) {
        const errorText = await res.text();
        let errorData: any = null;
        try {
          errorData = errorText ? JSON.parse(errorText) : null;
        } catch (e) {
          // Error text is not JSON, that's fine
        }
        const errorMessage = (errorData?.error?.message || errorText || '').toLowerCase();
        
        // CRITICAL: Detect quota/billing errors - don't retry, fallback immediately
        if (errorMessage.includes('quota') || errorMessage.includes('billing') || errorMessage.includes('exceeded')) {
          if (scanId) {
            // Set long cooldown (30-60 minutes) for quota errors
            const cooldownMinutes = errorMessage.includes('daily') ? 60 : 30;
            recordGeminiQuotaError(scanId, cooldownMinutes);
          }
          
          const error: any = new Error(`Gemini 429 QUOTA EXCEEDED: ${errorData?.error?.message || errorText}`);
          error.status = 429;
          error.statusCode = 429;
          error.isQuotaError = true; // Mark as quota error - don't retry
          throw error;
        }
        
        // Regular 429 (rate limit) - can retry
        console.error(`${logPrefix} Gemini 429 Rate Limit:`, {
          endpoint: 'generativelanguage.googleapis.com',
          model,
          retryAfter: retryAfterSeconds ? `${retryAfterSeconds}s` : 'not provided',
          errorMessage: errorData?.error?.message?.slice(0, 200) || '',
          quotaSurface: 'Gemini API (AI Studio)',
          clientLibrary: 'vanilla-fetch',
        });
        
        const error: any = new Error(`Gemini 429: ${errorData?.error?.message || errorText}`);
        error.status = 429;
        error.statusCode = 429;
        error.retryAfter = retryAfterSeconds; // Include Retry-After for queue handler
        error.isQuotaError = false; // Regular rate limit, can retry
        throw error;
      }
      
      // Handle 503 (model overloaded) - record for circuit breaker
      if (res.status === 503) {
        if (scanId) recordGemini503(scanId);
        const errorText = await res.text();
        let errorData: any = null;
        try {
          errorData = errorText ? JSON.parse(errorText) : null;
        } catch (e) {
          // Error text is not JSON, that's fine
        }
        const errorMessage = errorData?.error?.message || '';
        
        const error: any = new Error(`Gemini 503: ${errorMessage}`);
        error.status = 503;
        error.statusCode = 503;
        error.retryAfter = retryAfterSeconds;
        throw error;
      }
      
      if (!res.ok) {
        const errorText = await res.text();
        let errorData: any = null;
        try {
          errorData = errorText ? JSON.parse(errorText) : null;
        } catch (e) {
          // Error text is not JSON, that's fine
        }
        const errorMessage = errorData?.error?.message || errorText || '';
        console.error(`${logPrefix} Gemini scan failed: ${res.status} ${res.statusText} - ${errorMessage.slice(0, 200)}`);
        return [];
      }
      
      // Success - record for circuit breaker
      if (scanId) recordGeminiSuccess(scanId);
      
      // Parse response
      const data = await res.json() as any;
      return data;
    }, 2, scanId || 'unknown', false);
    
    // Parse response from result
    const data = result;
    const rawGeminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!rawGeminiText) {
      console.error(`${logPrefix} Gemini returned empty content`);
      return { books: [], usedRepair: false, rawLength: 0 };
    }
    
    // Store raw text for debugging (redact API keys)
    const rawGeminiTextForLog = rawGeminiText.replace(/AIza[^\s"]+/g, '[REDACTED]');
    
    // Track if we used JSON repair
    let usedRepair = false;
    
    // Step 1: Try parsing raw text directly
    try {
      const parsed = JSON.parse(rawGeminiText);
      if (Array.isArray(parsed)) {
        console.log(`${logPrefix} Gemini parsed ${parsed.length} books (direct JSON)`);
        return { books: parsed, usedRepair: false, rawLength: rawGeminiText.length };
      }
      // If it's an object with a books array, use that
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.books)) {
        console.log(`${logPrefix} Gemini parsed ${parsed.books.length} books (from books property)`);
        return { books: parsed.books, usedRepair: false, rawLength: rawGeminiText.length };
      }
    } catch (e) {
      // Continue to next parsing strategy
    }
    
    // Step 2: Remove markdown code blocks if present
    let cleaned = rawGeminiText;
    if (cleaned.includes('```')) {
      cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }
    
    // Step 3: Try parsing cleaned text
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        console.log(`${logPrefix} Gemini parsed ${parsed.length} books (cleaned JSON)`);
        return { books: parsed, usedRepair: false, rawLength: rawGeminiText.length };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.books)) {
        console.log(`${logPrefix} Gemini parsed ${parsed.books.length} books (from books property, cleaned)`);
        return { books: parsed.books, usedRepair: false, rawLength: rawGeminiText.length };
      }
    } catch (e) {
      // Continue to next parsing strategy
    }
    
    // Step 4: Regex-extract the first [...] block
    const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          console.log(`${logPrefix} Gemini parsed ${parsed.length} books (extracted array)`);
          return { books: parsed, usedRepair: false, rawLength: rawGeminiText.length };
        }
      } catch (e2) {
        // Try JSON repair on extracted array
        console.warn(`${logPrefix} Gemini JSON parse failed on extracted array, attempting repair...`);
        try {
          const repaired = await repairJSON(arrayMatch[0], 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
          if (repaired && Array.isArray(repaired)) {
            console.log(`${logPrefix} Gemini parsed ${repaired.length} books (repaired extracted array)`);
            usedRepair = true;
            return { books: repaired, usedRepair: true, rawLength: rawGeminiText.length };
          }
        } catch (repairError) {
          console.error(`${logPrefix} Gemini JSON repair failed:`, repairError);
        }
      }
    }
    
    // Step 5: Final attempt - try repairing the entire cleaned content
    console.warn(`${logPrefix} Gemini attempting final JSON repair on full content...`);
    try {
      const repaired = await repairJSON(cleaned, 'array of book objects');
      if (repaired && Array.isArray(repaired)) {
        console.log(`${logPrefix} Gemini parsed ${repaired.length} books (final repair)`);
        usedRepair = true;
        return { books: repaired, usedRepair: true, rawLength: rawGeminiText.length };
      }
    } catch (repairError) {
      console.error(`${logPrefix} Gemini final JSON repair failed:`, repairError);
    }
    
    // All parsing attempts failed - log for debugging and treat as provider failure
    console.error(`${logPrefix} Gemini response doesn't contain valid JSON array`);
    console.error(`${logPrefix} Raw response preview (first 300 chars, API keys redacted): ${rawGeminiTextForLog.substring(0, 300)}`);
    console.error(`${logPrefix} Full content length: ${rawGeminiText.length} chars`);
    console.error(`${logPrefix} Treating as provider failure, will fallback to OpenAI`);
    return { books: [], usedRepair: false, rawLength: rawGeminiText.length };
  } catch (error: any) {
    // If retries exhausted, return empty array (fallback to OpenAI)
    if (error?.status === 503 || error?.status === 429) {
      console.error(`${logPrefix} Gemini failed after retries (${error.status}), falling back to OpenAI`);
    }
    return { books: [], usedRepair: false, rawLength: 0 };
  }
}

/**
 * Continuation strategy: if Gemini response was truncated/incomplete, make a follow-up call
 */
async function continueGeminiScan(
    imageDataURL: string,
    previousBooks: any[],
    scanId?: string
  ): Promise<GeminiScanResult> {
    const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
    const lastSpineIndex = previousBooks.length > 0 
      ? Math.max(...previousBooks.map(b => b.spine_index ?? -1)) + 1
      : 0;
    
    console.log(`${logPrefix} 🔄 Gemini continuation: requesting books starting from spine_index ${lastSpineIndex}`);
    
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { books: [], usedRepair: false, rawLength: 0 };
    
    const model = 'gemini-3-flash-preview';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
    
    // Log image payload being sent to Gemini (continuation)
    const imageBytesLengthSentToGemini = base64Data.length;
    const imageMimeSentToGemini = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
    console.log(`${logPrefix} Sending continuation to Gemini: imageBytes=${imageBytesLengthSentToGemini}, mime=${imageMimeSentToGemini}, scanId=${scanId || 'none'}`);
    
    try {
      const res = await fetch(
        `${endpoint}?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Continue scanning book spines in this image. You already found ${previousBooks.length} books (spine_index 0 through ${lastSpineIndex - 1}).

Return ONLY the remaining books starting from spine_index ${lastSpineIndex} as a JSON array. No markdown. No explanations. Pure JSON only.

CRITICAL RULES:
- Continue numbering from spine_index ${lastSpineIndex} (left-to-right)
- TITLE is the book name (usually larger text on spine)
- AUTHOR is the person's name who wrote it (usually smaller text)
- DO NOT swap title and author
- Capture raw spine_text exactly as you see it
- Detect language: "en", "es", "fr", or "unknown"

Return only a JSON array like:
[{"title":"Book Title","author":"Author Name","confidence":"high","spine_text":"raw text","language":"en","reason":"brief reason","spine_index":${lastSpineIndex}}]`,
                  },
                  { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
                ],
              },
            ],
            generationConfig: { 
              responseMimeType: "application/json",
              temperature: 0,
              maxOutputTokens: 16000,
            },
          }),
        }
      );
      
      if (!res.ok) {
        console.warn(`${logPrefix} Gemini continuation failed: ${res.status}`);
        return { books: [], usedRepair: false, rawLength: 0 };
      }
      
      const data = await res.json() as any;
      const rawGeminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      if (!rawGeminiText) {
        console.warn(`${logPrefix} Gemini continuation returned empty content`);
        return { books: [], usedRepair: false, rawLength: 0 };
      }
      
      // Parse continuation response (same logic as main scan)
      let cleaned = rawGeminiText;
      if (cleaned.includes('```')) {
        cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      }
      
      // Try parsing directly
      try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          console.log(`${logPrefix} ✅ Gemini continuation parsed ${parsed.length} books (direct JSON)`);
          return { books: parsed, usedRepair: false, rawLength: rawGeminiText.length };
        }
      } catch (e) {
        // Continue to repair
      }
      
      // Try extracting array
      const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
      if (arrayMatch) {
        try {
          const parsed = JSON.parse(arrayMatch[0]);
          if (Array.isArray(parsed)) {
            console.log(`${logPrefix} ✅ Gemini continuation parsed ${parsed.length} books (extracted array)`);
            return { books: parsed, usedRepair: false, rawLength: rawGeminiText.length };
          }
        } catch (e2) {
          // Try repair
          try {
            const repaired = await repairJSON(arrayMatch[0], 'array of book objects');
            if (repaired && Array.isArray(repaired)) {
              console.log(`${logPrefix} ✅ Gemini continuation parsed ${repaired.length} books (repaired)`);
              return { books: repaired, usedRepair: true, rawLength: rawGeminiText.length };
            }
          } catch (repairError) {
            console.error(`${logPrefix} Gemini continuation repair failed:`, repairError);
          }
        }
      }
      
      // Final repair attempt
      try {
        const repaired = await repairJSON(cleaned, 'array of book objects');
        if (repaired && Array.isArray(repaired)) {
          console.log(`${logPrefix} ✅ Gemini continuation parsed ${repaired.length} books (final repair)`);
          return { books: repaired, usedRepair: true, rawLength: rawGeminiText.length };
        }
      } catch (repairError) {
        console.error(`${logPrefix} Gemini continuation final repair failed:`, repairError);
      }
      
      return { books: [], usedRepair: false, rawLength: rawGeminiText.length };
    } catch (error: any) {
      console.error(`${logPrefix} Gemini continuation error:`, error?.message || error);
      return { books: [], usedRepair: false, rawLength: 0 };
  }
}

/**
 * Enhanced normalization: trim, collapse spaces, normalize quotes/dashes, strip punctuation
 */
function normalize(s?: string) {
  if (!s) return '';
  return s.trim()
    .toLowerCase()
    .replace(/[""]/g, '"') // Normalize quotes
    .replace(/['']/g, "'") // Normalize apostrophes
    .replace(/[–—]/g, '-') // Normalize dashes
    .replace(/[.,;:!?]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}

/**
 * Enhanced normalization with OCR artifact removal
 */
function normalizeWithOCR(s?: string): string {
  if (!s) return '';
  let normalized = normalize(s);
  // Remove common OCR artifacts
  normalized = normalized
    .replace(/\|/g, '') // Remove pipe characters (common OCR error)
    .replace(/^VOL\s+/i, '') // Remove leading "VOL" (volume indicators)
    .replace(/\s+VOL\s*$/i, '') // Remove trailing "VOL"
    .replace(/^[0-9]+\s*$/, '') // Remove pure numbers
    .replace(/^[%@#$&*]+\s*$/, '') // Remove pure symbols
    .trim();
  return normalized;
}

/**
 * Format author name: capitalize first letter of first and last name, use full name
 * Examples:
 * - "JOHN SMITH" -> "John Smith"
 * - "jane doe" -> "Jane Doe"
 * - "MARY J. JONES" -> "Mary J. Jones"
 * - "smith, john" -> "John Smith" (handle comma-separated)
 */
function formatAuthorName(author?: string | null): string | null {
  if (!author) return null;
  
  // Handle comma-separated names (e.g., "Smith, John" -> "John Smith")
  let name = author.trim();
  if (name.includes(',')) {
    const parts = name.split(',').map(p => p.trim());
    if (parts.length === 2) {
      name = `${parts[1]} ${parts[0]}`; // Swap last, first to first last
    }
  }
  
  // Split into words and capitalize each word properly
  const words = name.split(/\s+/).filter(w => w.length > 0);
  const formatted = words.map(word => {
    // Handle initials (e.g., "J." stays as "J.")
    if (word.length === 1 || (word.length === 2 && word.endsWith('.'))) {
      return word.toUpperCase();
    }
    // Capitalize first letter, lowercase the rest
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
  
  return formatted;
}

function normalizeTitle(title?: string) {
  if (!title) return '';
  const normalized = normalize(title);
  // Remove "the", "a", "an" from the beginning
  let cleaned = normalized.replace(/^(the|a|an)\s+/, '').trim();
  // Remove common prefixes/suffixes that might vary
  cleaned = cleaned.replace(/^(a|an|the)\s+/i, '');
  // Remove extra whitespace and normalize
  return cleaned.replace(/\s+/g, ' ').trim();
}

function normalizeAuthor(author?: string) {
  if (!author) return '';
  const normalized = normalize(author);
  // Remove common suffixes
  let cleaned = normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
  // Handle "and" in author names (e.g., "Hoffman and Casnocha" vs "Reid Hoffman and Ben Casnocha")
  // For deduplication, we'll use a simpler approach - just normalize the string
  cleaned = cleaned.replace(/\s+and\s+/gi, ' & ');
  // Remove extra whitespace
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Build canonical key for deterministic deduplication
 * Format: normalized_title::normalized_author_last
 */
function buildCanonicalKey(book: any): string {
  const title = normalizeTitle(book.title || '');
  const author = normalizeAuthor(book.author || '');
  // Extract last name from author (first word after "and" or last word)
  const authorLast = author.split(' & ').pop()?.split(' ').pop() || '';
  return `${title}::${authorLast}`;
}

/**
 * Merge book results from multiple providers and deduplicate
 */
function mergeBookResults(geminiBooks: any[], openaiBooks: any[]): any[] {
  const combined = [...geminiBooks, ...openaiBooks];
  return dedupeBooks(combined);
}

/**
 * Improved merge/dedupe with canonical keys + fuzzy matching
 */
function dedupeBooks(books: any[]): any[] {
  if (!books || books.length === 0) return [];
  
  // First pass: exact match by canonical key
  const canonicalMap: Record<string, any> = {};
  for (const b of books) {
    if (!b || !b.title) continue;
    const key = buildCanonicalKey(b);
    // Keep the one with higher confidence, or one with both title+author
    if (!canonicalMap[key]) {
      canonicalMap[key] = b;
    } else {
      const existing = canonicalMap[key];
      const hasBoth = b.title && b.author;
      const existingHasBoth = existing.title && existing.author;
      if ((hasBoth && !existingHasBoth) || 
          (b.confidence === 'high' && existing.confidence !== 'high')) {
        canonicalMap[key] = b;
      }
    }
  }
  
  const deduped = Object.values(canonicalMap);
  
  // Second pass: fuzzy match titles within same spine_index neighborhood
  const final: any[] = [];
  for (const book of deduped) {
    const bookTitle = normalizeTitle(book.title);
    const bookAuthor = normalizeAuthor(book.author);
    const bookSpineIndex = book.spine_index ?? 999; // Default to end if missing
    
    if (!bookTitle || bookTitle.length < 2) continue;
    
    let isDuplicate = false;
    for (const existing of final) {
      const existingTitle = normalizeTitle(existing.title);
      const existingAuthor = normalizeAuthor(existing.author);
      const existingSpineIndex = existing.spine_index ?? 999;
      
      // Exact match
      if (bookTitle === existingTitle && bookAuthor === existingAuthor) {
            isDuplicate = true;
            break;
          }
      
      // Fuzzy match: similar titles, same author, nearby spine positions
      const authorsMatch = bookAuthor === existingAuthor || 
                          (!bookAuthor && !existingAuthor) ||
                          (bookAuthor && existingAuthor && (
                            bookAuthor === existingAuthor ||
                            bookAuthor.includes(existingAuthor) ||
                            existingAuthor.includes(bookAuthor)
                          ));
      
      const spineNearby = Math.abs(bookSpineIndex - existingSpineIndex) <= 2;
      
      if (authorsMatch && spineNearby && bookTitle.length > 3 && existingTitle.length > 3) {
        // Token-set similarity: check if titles share significant words
        const bookWords = new Set(bookTitle.split(/\s+/).filter(w => w.length > 2));
        const existingWords = new Set(existingTitle.split(/\s+/).filter(w => w.length > 2));
        const intersection = new Set([...bookWords].filter(w => existingWords.has(w)));
        const union = new Set([...bookWords, ...existingWords]);
        const similarity = intersection.size / union.size;
        
        // Also check if one contains the other
        const containsMatch = bookTitle.includes(existingTitle) || 
                              existingTitle.includes(bookTitle);
        
        if (similarity > 0.5 || containsMatch) {
          isDuplicate = true;
          // Prefer higher confidence or more complete data
          if (book.confidence === 'high' && existing.confidence !== 'high') {
            const index = final.indexOf(existing);
            if (index !== -1) {
              final[index] = book;
            }
          }
          break;
        }
      }
    }
    
    if (!isDuplicate) {
      final.push(book);
    }
  }
  
  return final;
}

async function withRetries<T>(fn: () => Promise<T>, tries = 2, backoffMs = 800): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await delay(backoffMs * (i + 1));
    }
  }
  throw last;
}

/**
 * Cheap validator: filter obvious junk before LLM validation
 * Returns { isValid: boolean, normalizedBook: any }
 */
function cheapValidate(book: any): { isValid: boolean; normalizedBook: any } {
  const spineText = normalizeWithOCR(book.spine_text || book.title || '');
  const title = normalizeWithOCR(book.title || '');
  const author = normalizeWithOCR(book.author || '');
  
  // Filter: spine_text too short AND no title/author
  if (spineText.length < 3 && !title && !author) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'spine_text_too_short' } };
  }
  
  // Filter: title is only digits/punctuation
  if (title && /^[0-9\s.,;:!?]+$/.test(title)) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_is_digits_only' } };
  }
  
  // Filter: obvious nonsense patterns
  if (title && /^(IIII|@@@@|%%%%|####|\|\|\|\|)$/.test(title)) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'nonsense_pattern' } };
  }
  
  // Filter: single generic word with no author and low confidence
  if (title && !author && book.confidence === 'low') {
    const words = title.split(/\s+/);
    if (words.length === 1 && ['the', 'a', 'an', 'book', 'volume', 'vol'].includes(words[0])) {
      return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'generic_word_no_author' } };
    }
  }
  
  // Normalize the book
  const normalizedBook = {
    ...book,
    title: book.title?.trim() || null,
    author: formatAuthorName(book.author), // Format author name properly
    spine_text: book.spine_text?.trim() || spineText,
    language: book.language || 'en',
    spine_index: book.spine_index ?? 0,
  };
  
  return { isValid: true, normalizedBook };
}

/**
 * JSON repair: attempt to fix invalid JSON using LLM
 */
async function repairJSON(invalidJSON: string, schema: string): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Fix this invalid JSON to match the schema: ${schema}\n\nInvalid JSON:\n${invalidJSON}\n\nReturn ONLY valid JSON, no explanations.`,
        }],
        max_tokens: 2000,
        temperature: 0,
      }),
    });
    
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    
    // Remove markdown if present
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function scanWithOpenAI(imageDataURL: string, retryCount = 0, abortController?: AbortController, scanId?: string): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

  const logPrefix = scanId ? `[SCAN ${scanId}]` : '[API]';
  
  // Log image payload being sent to OpenAI
  const imageBytesLengthSentToOpenAI = imageDataURL.length;
  const imageMimeSentToOpenAI = imageDataURL.match(/^data:([^;]+);base64,/)?.[1] || 'unknown';
  console.log(`${logPrefix} Sending to OpenAI: imageBytes=${imageBytesLengthSentToOpenAI}, mime=${imageMimeSentToOpenAI}, scanId=${scanId || 'none'}`);

  const startTime = Date.now();
  // Use provided abort controller or create new one
  const controller = abortController || new AbortController();
  const timeout = abortController ? null : setTimeout(() => {
    console.warn('[API] OpenAI request timeout after 60 seconds - aborting');
    controller.abort();
  }, 60000); // 60 seconds - reduced to fail faster and avoid long waits
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o', // Using gpt-4o instead of gpt-5 - faster and more reliable for vision tasks
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Scan this image and return ALL visible book spines as a strict JSON array.

CRITICAL RULES:
- TITLE is the book name (usually larger text, on the spine)
- AUTHOR is the person's name who wrote it (usually smaller text, below or above title)
- DO NOT swap title and author - titles are book names, authors are people's names
- If you see "John Smith" and "The Great Novel", "John Smith" is the AUTHOR, "The Great Novel" is the TITLE
- Format author names: capitalize first letter of first and last name, use full name (e.g., "John Smith" not "JOHN SMITH" or "john smith")
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy)
- Detect language: "en", "es", "fr", or "unknown"

Return ONLY valid JSON array (no markdown, no code blocks, no explanations):
[{
  "title": "Book Title Here or null",
  "author": "Author Name Here or null",
  "confidence": "high|medium|low",
  "spine_text": "raw text from spine",
  "language": "en|es|fr|unknown",
  "reason": "brief reason for confidence",
  "spine_index": 0
}]`,
              },
              { type: 'image_url', image_url: { url: imageDataURL } },
            ],
          },
        ],
        max_tokens: 3000, // Reduced from 4000 to speed up response time
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      const elapsed = Date.now() - startTime;
      
      // Handle rate limiting (429) or server errors (500-599) with retry
      if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && retryCount < 2 && !controller.signal.aborted) {
        const backoffDelay = Math.pow(2, retryCount) * 3000; // 3s, 6s
        console.warn(`${logPrefix} OpenAI ${res.status} error, retrying in ${backoffDelay/1000}s... (attempt ${retryCount + 1}/2) after ${elapsed}ms`);
        await delay(backoffDelay);
        return scanWithOpenAI(imageDataURL, retryCount + 1, controller, scanId);
      }
      
      console.error(`[API] OpenAI scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)} (after ${elapsed}ms)`);
      return [];
    }
      const requestTime = Date.now() - startTime;
      const data = await res.json() as {
        choices?: Array<{ 
          message?: { content?: string; text?: string }; 
          content?: string;
          text?: string;
          finish_reason?: string 
        }>;
        error?: any;
        model?: string;
        usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      
      // Log request timing
      console.log(`[API] OpenAI request completed in ${requestTime}ms`);
      
      // Log full response structure for debugging
      console.log(`[API] OpenAI response structure:`, JSON.stringify({
        hasChoices: !!data.choices,
        choicesLength: data.choices?.length || 0,
        firstChoice: data.choices?.[0] ? {
          hasMessage: !!data.choices[0].message,
          hasContent: !!data.choices[0].message?.content,
          finishReason: data.choices[0].finish_reason,
          contentLength: data.choices[0].message?.content?.length || 0
        } : null,
        error: data.error,
        model: data.model
      }, null, 2));
      
      // Check for API errors
      if (data.error) {
        console.error(`[API] OpenAI API error:`, data.error);
        return [];
      }
      
      // Try multiple ways to extract content
      let content = '';
      const finishReason = data.choices?.[0]?.finish_reason;
    
    // Method 1: Standard path
    content = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Method 2: Try alternative paths if standard is empty
    if (!content && data.choices?.[0]) {
      const choice = data.choices[0];
      // Try different possible structures
      content = choice.content?.trim() || 
                choice.text?.trim() || 
                choice.message?.text?.trim() || 
                '';
    }
    
    // Method 3: If finish_reason is "length", the response was truncated
    // gpt-5 uses reasoning tokens - if all tokens were used for reasoning, we need more tokens
    if (!content && finishReason === 'length') {
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
      const totalTokens = data.usage?.completion_tokens || 0;
      console.warn(`[API] OpenAI response truncated: used ${totalTokens} tokens (${reasoningTokens} for reasoning). Increase max_completion_tokens.`);
    }
    
    console.log(`[API] OpenAI raw response length: ${content.length} chars, finish_reason: ${finishReason}`);
    if (content.length > 0) {
      console.log(`[API] OpenAI response preview: ${content.slice(0, 200)}...`);
    }
    
    if (!content) {
      console.error(`[API] OpenAI returned empty content. Full response keys:`, Object.keys(data));
      console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
      // If finish_reason is 'length', the response was truncated - this is still an error for our use case
      if (finishReason === 'length') {
        console.error(`[API] Response was truncated due to token limit`);
      }
      return [];
    }
    
    // Remove markdown code blocks
    if (content.includes('```')) {
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }
    
    // Try to extract JSON array from response (might have text before/after)
    let parsed: any = null;
    
    // First try: parse entire content if it's pure JSON
    try {
      parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        console.log(`[API] OpenAI parsed ${parsed.length} books (direct JSON)`);
        return parsed;
      }
    } catch {}
    
    // Second try: find JSON array in content
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          console.log(`[API] OpenAI parsed ${parsed.length} books (extracted from text)`);
          return parsed;
        }
      } catch (e) {
        // Try JSON repair
        console.warn(`[API] OpenAI JSON parse failed, attempting repair...`);
        const repaired = await repairJSON(arrayMatch[0], 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
        if (repaired && Array.isArray(repaired)) {
          console.log(`[API] OpenAI parsed ${repaired.length} books (repaired JSON)`);
          return repaired;
        }
        console.error(`[API] OpenAI failed to parse/extract JSON:`, e);
      }
    }
    
    // Final attempt: try repairing the entire content
    console.warn(`[API] OpenAI attempting final JSON repair...`);
    const finalRepaired = await repairJSON(content, 'array of book objects');
    if (finalRepaired && Array.isArray(finalRepaired)) {
      console.log(`[API] OpenAI parsed ${finalRepaired.length} books (final repair)`);
      return finalRepaired;
    }
    
    console.error(`[API] OpenAI response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
    return [];
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    
    // Handle abort errors specifically (timeouts)
    if (e.name === 'AbortError' || e.message?.includes('aborted') || e.message?.includes('AbortError')) {
      // Retry on timeout if we haven't retried yet
      if (retryCount < 1) {
        console.warn(`${logPrefix} OpenAI request timeout after ${elapsed}ms, retrying once...`);
        await delay(5000); // Wait 5s before retry
        return scanWithOpenAI(imageDataURL, retryCount + 1, undefined, scanId);
      }
      console.error(`${logPrefix} OpenAI request was aborted (timeout after 60 seconds, ${elapsed}ms elapsed)`);
      return [];
    }
    
    // Retry on network errors
    const errorMessage = e?.message || String(e);
    if ((errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('ECONNRESET')) && retryCount < 1) {
      console.warn(`${logPrefix} OpenAI network error after ${elapsed}ms, retrying once...`);
      await delay(3000);
      return scanWithOpenAI(imageDataURL, retryCount + 1, undefined, scanId);
    }
    
    console.error(`[API] OpenAI scan exception after ${elapsed}ms:`, errorMessage);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
/**
 * Public interface for Gemini scanning - uses queue for single-flight execution
 */
async function scanWithGemini(imageDataURL: string, scanId?: string): Promise<GeminiScanResult> {
  // Call direct to get full result object (not just books array)
  return scanWithGeminiDirect(imageDataURL, scanId);
}

/**
 * Early external lookup for ambiguous items (before batch validation)
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Scan book spines in this image and return ONLY a strict JSON array.

CRITICAL RULES:
- TITLE is the book name (usually larger text on spine)
- AUTHOR is the person's name who wrote it (usually smaller text)
- DO NOT swap title and author - titles are book names, authors are people's names
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy)
- Detect language: "en", "es", "fr", or "unknown"

Return ONLY valid JSON array (no markdown, no code blocks, no explanations):
[{
  "title": "Book Title Here or null",
  "author": "Author Name Here or null",
  "confidence": "high|medium|low",
  "spine_text": "raw text from spine",
  "language": "en|es|fr|unknown",
  "reason": "brief reason for confidence",
  "spine_index": 0
}]`,
              },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
            ],
          },
        ],
        generationConfig: { 
          responseMimeType: "application/json", // Force JSON-only output at API level
          temperature: 0, // Minimize randomness and formatting drift (changed from 0.1)
          maxOutputTokens: 16000, // Increased significantly for shelf scans (was 8000, now 16000)
        },
      }),
    }
  );
  
  // Handle rate limiting (429) with exponential backoff
  if (res.status === 429) {
    const maxRetries = 3; // Retry up to 3 times
    if (retryCount < maxRetries) {
      // Longer backoff: 5s, 10s, 20s (more conservative for rate limits)
      const backoffDelay = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
      console.warn(
        `[API] Gemini rate limited (429), retrying in ${backoffDelay/1000}s... (attempt ${retryCount + 1}/${maxRetries})`
      );
      await delay(backoffDelay);
      // Reset rate limiter before retry to allow the request
      geminiRequestTimes = geminiRequestTimes.slice(0, -1); // Remove the failed request from tracking
      return scanWithGemini(imageDataURL, retryCount + 1);
    } else {
      const errorText = await res.text();
      let errorData: any = null;
      try {
        errorData = errorText ? JSON.parse(errorText) : null;
      } catch (e) {
        // Error text is not JSON, that's fine
      }
      
      // Gemini's API returns "quota" in the error message even for rate limits
      // This is misleading - check if it's actually a burst rate limit
      const errorMessage = errorData?.error?.message || '';
      const mentionsQuota = errorMessage.toLowerCase().includes('quota');
      
      // Since user is well under quota limits, this is almost certainly a rate limit (burst)
      if (mentionsQuota) {
        console.error(`[API] Gemini rate limited (429) - Error message mentions "quota" but this is likely a burst rate limit, not actual quota. Message: ${errorMessage.slice(0, 200)}`);
        console.warn(`[API] Note: Gemini API often returns "quota" errors for rate limits. Check your RPM (requests per minute) limits, not just daily quota.`);
      } else {
        console.error(`[API] Gemini rate limited (429) after ${maxRetries} retries - ${errorMessage.slice(0, 200)}`);
      }
      // Return empty array instead of throwing - let OpenAI handle it
      return [];
    }
  }
  
  if (!res.ok) {
    const errorText = await res.text();
    // Parse error to check message
    let errorData: any = null;
    try {
      errorData = errorText ? JSON.parse(errorText) : null;
    } catch (e) {
      // Error text is not JSON, that's fine
    }
    const errorMessage = errorData?.error?.message || errorText || '';
    
    // Better error logging
    if (res.status === 429) {
      const mentionsQuota = errorMessage.toLowerCase().includes('quota');
      if (mentionsQuota) {
        console.error(`[API] Gemini rate limited (429) - Error mentions "quota" but this is likely a burst rate limit. Message: ${errorMessage.slice(0, 200)}`);
      } else {
        console.error(`[API] Gemini rate limited (429) - ${errorMessage.slice(0, 200)}`);
      }
    } else {
      console.error(`[API] Gemini scan failed: ${res.status} ${res.statusText} - ${errorMessage.slice(0, 200)}`);
    }
    return [];
  }
  const data = await res.json() as any;
  
  // Log full response structure for debugging
  console.log(`[API] Gemini response structure:`, JSON.stringify({
    hasCandidates: !!data.candidates,
    candidatesLength: data.candidates?.length || 0,
    firstCandidate: data.candidates?.[0] ? {
      hasContent: !!data.candidates[0].content,
      hasParts: !!data.candidates[0].content?.parts,
      partsLength: data.candidates[0].content?.parts?.length || 0,
      hasText: !!data.candidates[0].text,
      firstPartText: data.candidates[0].content?.parts?.[0]?.text?.substring(0, 50) || null
    } : null,
    error: data.error
  }, null, 2));
  
  let content = '';
  // Try multiple extraction methods
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    content = data.candidates[0].content.parts[0].text;
  } else if (data.candidates?.[0]?.text) {
    content = data.candidates[0].text;
  } else if (data.candidates?.[0]?.content?.text) {
    content = data.candidates[0].content.text;
  } else if (data.text) {
    content = data.text;
  }
  
  // Check if content object exists but is empty (Gemini used all tokens for reasoning)
  if (!content && data.candidates?.[0]?.content) {
    const contentObj = data.candidates[0].content;
    // Try to extract from nested structures
    if (contentObj.parts && Array.isArray(contentObj.parts)) {
      for (const part of contentObj.parts) {
        if (part.text) {
          content = part.text;
          break;
        }
      }
    }
  }
  
  content = content.trim();
  
  console.log(`[API] Gemini raw response length: ${content.length} chars`);
  if (content.length > 0) {
    console.log(`[API] Gemini response preview: ${content.slice(0, 200)}...`);
  }
  
  if (!content) {
    // Check if Gemini used all tokens for reasoning (thoughtsTokenCount > 0 but no output)
    const usageMetadata = data.usageMetadata;
    if (usageMetadata?.thoughtsTokenCount && usageMetadata.thoughtsTokenCount > 0) {
      console.error(`[API] Gemini used ${usageMetadata.thoughtsTokenCount} tokens for reasoning but produced no output`);
      console.error(`[API] Total tokens: ${usageMetadata.totalTokenCount}, Output tokens: ${usageMetadata.totalTokenCount - usageMetadata.thoughtsTokenCount}`);
      console.error(`[API] This suggests the model needs more maxOutputTokens or a more direct prompt`);
    }
    console.error(`[API] Gemini returned empty content. Full response keys:`, Object.keys(data));
    console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
    return [];
  }
  
  // Remove markdown code blocks more aggressively
  // Handle both ```json\n...\n``` and ```\n...\n``` formats
  content = content
    .replace(/^```json\s*\n?/i, '')  // Remove opening ```json (case insensitive)
    .replace(/^```\s*\n?/g, '')       // Remove opening ```
    .replace(/\n?```\s*$/g, '')      // Remove closing ```
    .replace(/```json\s*\n?/gi, '')  // Remove any ```json in middle
    .replace(/```\s*\n?/g, '')        // Remove any remaining ```
    .trim();
  
  // Try to extract JSON array from response
  let parsed: any = null;
  
  // First try: parse entire content if it's pure JSON
  try {
    parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      console.log(`[API] Gemini parsed ${parsed.length} books (direct JSON)`);
      return parsed;
    }
  } catch {}
  
  // Second try: find complete JSON array in content (must have closing bracket)
  const completeArrayMatch = content.match(/\[[\s\S]*\]/);
  if (completeArrayMatch) {
    try {
      const arrayStr = completeArrayMatch[0];
      parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) {
        console.log(`[API] Gemini parsed ${parsed.length} books (extracted from text)`);
        return parsed;
      }
    } catch (e: any) {
      // If complete array fails, log the error and try partial extraction
      console.log(`[API] Gemini complete array parse failed: ${e?.message}, array length: ${completeArrayMatch[0].length}, trying partial extraction...`);
    }
  } else {
    console.log(`[API] Gemini: No complete array match found (no closing bracket)`);
  }
  
  // Third try: find incomplete JSON array and try to complete it
  // Look for array start and extract all complete objects
  const arrayStart = content.indexOf('[');
  if (arrayStart !== -1) {
    const arrayContent = content.substring(arrayStart);
    // Try to find all complete JSON objects in the array
    const objectMatches = arrayContent.match(/\{[^}]*"title"[^}]*"author"[^}]*\}/g);
    if (objectMatches && objectMatches.length > 0) {
      try {
        // Reconstruct array from complete objects
        const reconstructed = '[' + objectMatches.join(',') + ']';
        parsed = JSON.parse(reconstructed);
        if (Array.isArray(parsed)) {
          console.log(`[API] Gemini parsed ${parsed.length} books (reconstructed from partial)`);
        return parsed;
      }
    } catch (e) {
        // Try JSON repair
        console.warn(`[API] Gemini reconstruction failed, attempting repair...`);
        const reconstructedForRepair = '[' + objectMatches.join(',') + ']';
        const repaired = await repairJSON(reconstructedForRepair, 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
        if (repaired && Array.isArray(repaired)) {
          console.log(`[API] Gemini parsed ${repaired.length} books (repaired JSON)`);
          return repaired;
        }
        console.log(`[API] Gemini reconstruction failed:`, e);
      }
    }
  }
  
  // Final attempt: try repairing the entire content
  console.warn(`[API] Gemini attempting final JSON repair...`);
  const repaired = await repairJSON(content, 'array of book objects');
  if (repaired && Array.isArray(repaired)) {
    console.log(`[API] Gemini parsed ${repaired.length} books (final repair)`);
    return repaired;
  }
  
  console.error(`[API] Gemini response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
  return [];
}

/**
 * Early external lookup for ambiguous items (before batch validation)
 * Returns book with external_match data if found
 */
async function earlyLookup(book: any): Promise<any> {
  // Lookup ALL books to get covers and googleBooksId, not just ambiguous ones
  // This ensures we have googleBooksId for fast cover fetching on the client
  
  try {
    // Dynamic import to avoid circular dependencies
    const { fetchBookData } = await import('../services/googleBooksService');
    
    const title = book.title || book.spine_text || '';
    if (!title || title.length < 2) {
      console.log(`[API] Early lookup SKIP for "${book.title}": title too short or missing`);
      return book;
    }
    
    const author = book.author || undefined;
    console.log(`[API] Early lookup trying: "${title}" by ${author || 'no author'}`);
    
    // Try fetchBookData first (most accurate)
    let result = await fetchBookData(title, author);
    
    // If that fails, try searchMultipleBooks and take the first result (more flexible)
    if (!result || !result.googleBooksId) {
      try {
        const { searchMultipleBooks } = await import('../services/googleBooksService');
        const multipleResults = await searchMultipleBooks(title, author, 5);
        if (multipleResults && multipleResults.length > 0) {
          // Take the first result
          result = multipleResults[0];
          console.log(`[API] Early lookup found via searchMultipleBooks: "${title}"`);
        }
      } catch (error) {
        // Ignore errors from searchMultipleBooks
      }
    }
    
    // Log lookup result for debugging
    if (result && result.googleBooksId) {
      console.log(`[API] Early lookup SUCCESS for "${title}": found googleBooksId=${result.googleBooksId.substring(0, 20)}..., coverUrl=${result.coverUrl ? 'yes' : 'no'}`);
    } else {
      console.log(`[API] Early lookup NO MATCH for "${title}" by ${author || 'no author'}`);
    }
    
    // GoogleBooksData doesn't have title/author directly, but fetchBookData returns data with googleBooksId
    // We'll use the original book data but mark that we found a match
    if (result && result.googleBooksId) {
      // Strong match found - attach external data
      // Note: We'll use the book's original title/author but mark it as externally validated
      return {
        ...book,
        external_match: {
          googleBooksId: result.googleBooksId,
          confidence: 'high', // External match is high confidence
        },
        // Keep original title/author but mark as externally validated
        googleBooksId: result.googleBooksId,
        // Add cover URL if available (so covers load immediately)
        coverUrl: result.coverUrl || book.coverUrl,
      };
    }
  } catch (error) {
    // Silently fail - we'll validate with LLM anyway
    console.log(`[API] Early lookup failed for "${book.title}":`, error?.message || error);
  }
  
  return book;
}

/**
 * Batch validation: validate multiple books in one LLM call
 */
async function batchValidateBooks(books: any[]): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || books.length === 0) return books;
  
  // Chunk into batches of 20 to avoid token limits
  const BATCH_SIZE = 20;
  const results: any[] = [];
  
  for (let i = 0; i < books.length; i += BATCH_SIZE) {
    const batch = books.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(books.length / BATCH_SIZE);
    
    console.log(`[API] Batch validating ${batchNum}/${totalBatches} (${batch.length} books)...`);
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s per batch
      
      const batchInput = batch.map((b, idx) => ({
        canonical_key: buildCanonicalKey(b),
        title: b.title || null,
        author: b.author || null,
        spine_text: b.spine_text || b.title || '',
        confidence: b.confidence || 'medium',
        external_match: b.external_match || null,
      }));
      
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `You are a book expert validating detected books from a bookshelf scan.

DETECTED BOOKS (JSON array):
${JSON.stringify(batchInput, null, 2)}

TASK: For each book, determine if it's valid and correct any errors. Be LENIENT - only mark as invalid if clearly junk.

RULES:
1. Books WITHOUT authors are VALID if title is distinctive
2. Partial titles are VALID
3. Only mark INVALID if clearly not a real book (random words, OCR garbage)
4. If title/author are swapped, fix them
5. Fix OCR errors
6. Prefer external_match data if provided (from Google Books lookup)

Return ONLY valid JSON array (no markdown, no code blocks):
[{
  "canonical_key": "same as input",
  "is_valid": true,
  "final_title": "corrected title or null",
  "final_author": "corrected author or null",
  "final_confidence": "high|medium|low",
  "fixes": ["title_author_swap", "ocr_cleanup", "filled_author", "none"],
  "notes": "brief explanation"
}]`,
          }],
          max_tokens: 2000,
          temperature: 0.1,
        }),
      });
      
      clearTimeout(timeout);
      
      if (!res.ok) {
        console.error(`[API] Batch validation failed: ${res.status}`);
        results.push(...batch); // Return originals on failure
        continue;
      }
      
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      let content = data.choices?.[0]?.message?.content?.trim() || '';
      
      // Remove markdown
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      let validated: any[];
      try {
        validated = JSON.parse(content);
      } catch {
        // Try repair
        const repaired = await repairJSON(content, 'array of validation results');
        validated = repaired || [];
      }
      
      // Map validation results back to books
      const validatedMap = new Map(validated.map((v: any) => [v.canonical_key, v]));
      
      for (const book of batch) {
        const key = buildCanonicalKey(book);
        const validation = validatedMap.get(key);
        
        if (validation && validation.is_valid) {
          results.push({
            ...book,
            title: validation.final_title || book.title,
            author: formatAuthorName(validation.final_author || book.author), // Format author name
            confidence: validation.final_confidence || book.confidence,
            validationFixes: validation.fixes || [],
            validationNotes: validation.notes,
            // Explicitly preserve googleBooksId, coverUrl, and external_match from early lookup
            googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
            coverUrl: book.coverUrl, // Preserve cover URL from early lookup
            external_match: book.external_match,
          });
        } else {
          // Invalid book - mark for filtering
          console.log(`[API] Batch validation marked as INVALID: "${book.title}" by ${book.author || 'no author'}`);
          results.push({
            ...book,
            isValid: false,
            confidence: 'invalid',
            // Preserve googleBooksId and coverUrl even for invalid books (might be useful for debugging)
            googleBooksId: book.googleBooksId || book.external_match?.googleBooksId,
            coverUrl: book.coverUrl, // Preserve cover URL
          });
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        console.warn(`[API] Batch validation timeout for batch ${batchNum}`);
      } else {
        console.error(`[API] Batch validation error:`, error?.message || error);
      }
      results.push(...batch); // Return originals on error
    }
  }
  
  return results;
}

async function validateBookWithChatGPT(book: any): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return book; // Return original if no key

  const controller = new AbortController();
  const timeoutMs = 35000; // 35 seconds per book - increased to reduce timeouts
  const timeout = setTimeout(() => {
    console.log(`[API] AbortController timeout triggered for "${book.title}" after ${timeoutMs}ms`);
    controller.abort();
  }, timeoutMs);

  const startTime = Date.now();
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Faster model for validation
        messages: [
          {
            role: 'user',
            content: `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author || '(no author)'}"
Confidence: ${book.confidence}

TASK: Determine if this is a real book. Be LENIENT - only mark as invalid if it's clearly junk (random words, obvious OCR garbage, not a real book title). If it's a real book (even with partial info), keep it and correct any obvious errors.

IMPORTANT RULES - BE LENIENT:
1. Books WITHOUT authors are VALID if the title is distinctive (e.g., "Fallingwater", "The Revolution", "Villareal")
2. Partial titles are VALID (e.g., "The Revolution" might be "Hamilton: The Revolution" - that's fine, keep it)
3. Only mark as INVALID if it's clearly not a real book (random words, obvious garbage, nonsensical titles)
4. CRITICAL: If title and author are swapped, ALWAYS fix them. Titles are book names, authors are people's names.
   - If "title" looks like a person's name (e.g., "John Smith", "Diana Gabaldon") and "author" looks like a book title, SWAP THEM
   - If "author" is clearly a book title (e.g., "The Great Gatsby", "Dragonfly in Amber") and "title" is a person's name, SWAP THEM
5. Fix obvious OCR errors (e.g., "owmen" → "women")
6. Clean up titles (remove publisher prefixes, series numbers) but keep the core title

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name or null", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES OF VALID BOOKS (KEEP THESE):
Input: Title="The Revolution", Author="Hamilton"
Output: {"isValid": true, "title": "Hamilton: The Revolution", "author": "Lin-Manuel Miranda", "confidence": "high", "reason": "Real book, expanded title"}

Input: Title="Fallingwater", Author=""
Output: {"isValid": true, "title": "Fallingwater", "author": null, "confidence": "high", "reason": "Real book about famous building, author not required"}

Input: Title="Villareal", Author=""
Output: {"isValid": true, "title": "Villareal", "author": null, "confidence": "medium", "reason": "Could be real book, keep it"}

Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author - Diana Gabaldon is author, Dragonfly in Amber is title"}

Input: Title="John Smith", Author="The Great Novel"
Output: {"isValid": true, "title": "The Great Novel", "author": "John Smith", "confidence": "high", "reason": "Swapped title and author - John Smith is author, The Great Novel is title"}

EXAMPLES OF INVALID BOOKS (REJECT THESE):
Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book, random words"}

Input: Title="Kaufmann's", Author=""
Output: {"isValid": false, "title": "Kaufmann's", "author": "", "confidence": "low", "reason": "Not a book title, appears to be store name"}

Input: Title="Friendship", Author=""
Output: {"isValid": false, "title": "Friendship", "author": "", "confidence": "low", "reason": "Too generic, not a distinctive book title"}

Remember: When in doubt, KEEP IT. Only reject if clearly not a real book. Respond with ONLY the JSON object, nothing else.`,
          },
        ],
        max_tokens: 500,
        temperature: 0.1, // Lower temperature = more consistent
      }),
    });

    const elapsed = Date.now() - startTime;
    console.log(`[API] Validation API call completed for "${book.title}" in ${elapsed}ms`);

    if (!res.ok) {
      console.error(`[API] Validation failed for "${book.title}": ${res.status}`);
      clearTimeout(timeout);
      return book;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) return book;

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      // Try extracting from code blocks
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        return book;
      }
    }

    if (analysis.isValid) {
      // Valid book - return corrected version
      // Preserve null/empty authors if validation returns null
      const correctedAuthor = analysis.author === null || analysis.author === '' ? null : (analysis.author || book.author);
      return {
        ...book,
        title: analysis.title || book.title,
        author: formatAuthorName(correctedAuthor), // Format author name
        confidence: analysis.confidence || book.confidence,
      };
    } else {
      // Invalid book - mark as invalid so it can be filtered out
      console.log(`[API] Validation marked book as INVALID: "${book.title}" by ${book.author || 'no author'} - Reason: ${analysis.reason}`);
      return {
        ...book,
        title: analysis.title || book.title,
        author: analysis.author || book.author,
        confidence: 'invalid', // Mark as invalid
        isValid: false,
        chatgptReason: analysis.reason,
      };
    }
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
      console.warn(`[API] Validation aborted for "${book.title}" after ${elapsed}ms (timeout or network issue)`);
    } else {
      console.error(`[API] Validation error for "${book.title}" after ${elapsed}ms:`, e?.message || e);
    }
    return book;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Process a scan job - runs Gemini/OpenAI and updates Supabase
 * This function is called by the worker endpoint (/api/scan-worker)
 * Exported so it can be imported by the worker
 */
export async function processScanJob(
  imageDataURL: string,
  userId: string | undefined,
  scanId: string,
  jobId: string
): Promise<void> {
  // Initialize Supabase client for job updates
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error(`[API] [SCAN ${scanId}] Database not configured for job updates`);
    return;
  }
  
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  
  // Track scan metadata for logging and error reporting
  const scanMetadata: {
    received_image_bytes?: number;
    content_type?: string;
    parse_path?: string[];
    ended_reason?: string;
  } = {};
  
  // Validate and log image data
  try {
    if (!imageDataURL || typeof imageDataURL !== 'string') {
      scanMetadata.ended_reason = 'missing_image';
      await supabase
        .from('scan_jobs')
        .update({
          status: 'failed',
          error: JSON.stringify({ code: 'missing_image', message: 'imageDataURL is required' }),
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      console.error(`[API] [SCAN ${scanId}] Missing image data`);
      return;
    }
    
    // Extract image metadata
    const imageBytes = imageDataURL.length; // Approximate size
    scanMetadata.received_image_bytes = imageBytes;
    
    // Detect content type from data URL
    const dataUrlMatch = imageDataURL.match(/^data:([^;]+);base64,/);
    scanMetadata.content_type = dataUrlMatch ? dataUrlMatch[1] : 'unknown';
    
    console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image received: ${imageBytes} bytes, type: ${scanMetadata.content_type}`);
    
    // Validate base64 data
    const base64Data = imageDataURL.split(',')[1];
    if (!base64Data || base64Data.length < 100) {
      scanMetadata.ended_reason = 'invalid_image';
      await supabase
        .from('scan_jobs')
        .update({
          status: 'failed',
          error: JSON.stringify({ code: 'invalid_image', message: 'Image data too small or invalid' }),
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      console.error(`[API] [SCAN ${scanId}] Invalid image data (too small)`);
      return;
    }
    
    scanMetadata.parse_path = ['image_validated'];
  } catch (imageError: any) {
    scanMetadata.ended_reason = 'image_validation_failed';
    await supabase
      .from('scan_jobs')
      .update({
        status: 'failed',
        error: JSON.stringify({ code: 'image_validation_failed', message: imageError?.message || 'Image validation error' }),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    console.error(`[API] [SCAN ${scanId}] Image validation error:`, imageError);
    return;
  }
  
  // Update job status to processing
  await supabase
    .from('scan_jobs')
    .update({
      status: 'processing',
      updated_at: new Date().toISOString()
    })
    .eq('id', jobId);
  
  try {
    // Call the existing scan processing logic
    // We'll need to extract this into a reusable function
    // For now, we'll create a minimal wrapper that calls the scan endpoint internally
    // OR we can inline the logic here
    
    // Since the scan logic is complex and embedded in the handler,
    // we'll make an internal call to process it
    // But actually, we should extract the logic - for now, let's call the existing handler logic
    // by creating a mock request/response
    
    // Actually, the best approach is to extract all the scan logic into this function
    // But that's a large refactor. For now, let's use a simpler approach:
    // Call the scan processing via an internal function call
    
    // Extract and run the scan processing logic
    // Check if API keys are configured
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;
    
    if (!hasOpenAIKey && !hasGeminiKey) {
      scanMetadata.ended_reason = 'api_keys_missing';
      await supabase
        .from('scan_jobs')
        .update({
          status: 'failed',
          error: JSON.stringify({ code: 'api_keys_missing', message: 'No API keys configured' }),
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      console.error(`[API] [SCAN ${scanId}] ERROR: No API keys configured!`);
      return;
    }
  
  // Initialize time budget (75s total)
    const timeBudget = new ScanTimeBudget(scanId, 75000, 30000);
    timeBudget.logStatus();
    
  // PARALLEL EXECUTION: Start Gemini + OpenAI immediately (no 30s hedge)
    let gemini: any[] = [];
    let openai: any[] = [];
    let scanFailed = false;
    
    // Check circuit breaker before trying Gemini
    const geminiQuotaExceeded = isGeminiQuotaExceeded();
    const geminiInCooldown = isGeminiInCooldown();
    
    // AbortControllers for cancellation
    const geminiController = new AbortController();
    const openaiController = new AbortController();
    let geminiTimeout: NodeJS.Timeout | null = null;
    let openaiTimeout: NodeJS.Timeout | null = null;
  
  // Monotonic clock for accurate elapsed time tracking
  const scanStartTime = Date.now();
  const getElapsedMs = () => Date.now() - scanStartTime;
  const getElapsedSeconds = () => Math.round((Date.now() - scanStartTime) / 1000);
  
  // Track whether OpenAI was actually attempted
  let openaiAttempted = false;
  let geminiAttempted = false;
  
  // Update job progress helper
  const updateProgress = async (stage: string, booksFound?: number) => {
    try {
      if (!scanMetadata.parse_path) scanMetadata.parse_path = [];
      if (!scanMetadata.parse_path.includes(stage)) {
        scanMetadata.parse_path.push(stage);
      }
      await supabase
        .from('scan_jobs')
        .update({
          progress: { stage, booksFound: booksFound || 0 },
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
    } catch (e) {
      // Ignore progress update errors
    }
  };
  
  try {
    // Start Gemini + OpenAI in PARALLEL immediately (no hedge delay)
    await updateProgress('starting', 0);
    
      const geminiPromise = hasGeminiKey && !geminiQuotaExceeded && !geminiInCooldown && !timeBudget.hasExceededBudget()
        ? (async () => {
          geminiAttempted = true;
          log('info', `[SCAN ${scanId}] Starting Gemini scan (parallel, t=0s)...`);
          await updateProgress('gemini', 0);
            try {
              geminiTimeout = setTimeout(() => {
                geminiController.abort();
              }, timeBudget.totalBudget);
              
              const result = await scanWithGemini(imageDataURL, scanId);
              if (geminiTimeout) clearTimeout(geminiTimeout);
            
            // Update progress with initial results
            if (result.books.length > 0) {
              await updateProgress('gemini', result.books.length);
            }
            
            // Quality gate and continuation logic
            const MIN_EXPECTED_BOOKS_LOCAL = 12;
            const MIN_RESPONSE_LENGTH_LOCAL = 2000;
            
            const qualityGateFailed = 
              result.usedRepair ||
              result.books.length < MIN_EXPECTED_BOOKS_LOCAL ||
              result.rawLength < MIN_RESPONSE_LENGTH_LOCAL;
            
            // Only do continuation if quality gate failed AND we have some books
            if (qualityGateFailed && result.books.length > 0) {
              console.warn(`[SCAN ${scanId}] ⚠️ Gemini response looks incomplete, attempting continuation...`);
              await updateProgress('gemini_continuation', result.books.length);
              try {
                const continuation = await continueGeminiScan(imageDataURL, result.books, scanId);
                if (continuation.books.length > 0) {
                  const merged = [...result.books, ...continuation.books];
                  const deduped = dedupeBooks(merged);
                  result.books = deduped;
                  result.rawLength = result.rawLength + continuation.rawLength;
                  result.usedRepair = result.usedRepair || continuation.usedRepair;
                  await updateProgress('gemini', result.books.length);
                }
              } catch (continuationError: any) {
                console.error(`[SCAN ${scanId}] Gemini continuation failed:`, continuationError?.message || continuationError);
              }
            }
            
            log('info', `[SCAN ${scanId}] Gemini completed: ${result.books.length} books`);
              return result;
            } catch (err: any) {
              if (geminiTimeout) clearTimeout(geminiTimeout);
            if (err?.name === 'AbortError') {
                scanMetadata.ended_reason = scanMetadata.ended_reason || 'model_timeout';
                console.warn(`[SCAN ${scanId}] Gemini scan aborted (timeout)`);
              } else {
                console.error(`[SCAN ${scanId}] Gemini scan failed:`, err?.message || err);
                scanMetadata.ended_reason = scanMetadata.ended_reason || 'gemini_api_error';
              }
            return { books: [], usedRepair: false, rawLength: 0, needsOpenAI: false };
            }
          })()
      : Promise.resolve({ books: [], usedRepair: false, rawLength: 0, needsOpenAI: false });
      
    // Start OpenAI IMMEDIATELY in parallel (no delay)
      const openaiPromise = hasOpenAIKey && !timeBudget.hasExceededBudget()
      ? (async () => {
          openaiAttempted = true;
          log('info', `[SCAN ${scanId}] [JOB ${jobId}] Starting OpenAI scan (parallel, t=0s)...`);
          await updateProgress('openai', 0);
          try {
            const remainingTime = Math.max(0, timeBudget.totalBudget - getElapsedMs());
            const openaiRequestTimeout = Math.max(60000, remainingTime);
                  openaiTimeout = setTimeout(() => {
                    openaiController.abort();
            }, openaiRequestTimeout);
                  
                  const result = await scanWithOpenAI(imageDataURL, 0, openaiController, scanId);
                  if (openaiTimeout) clearTimeout(openaiTimeout);
            
            if (result.length > 0) {
              await updateProgress('openai', result.length);
            }
            
            log('info', `[SCAN ${scanId}] OpenAI completed: ${result.length} books`);
            return result;
                } catch (err: any) {
                  if (openaiTimeout) clearTimeout(openaiTimeout);
                  if (err?.name === 'AbortError') {
                    scanMetadata.ended_reason = scanMetadata.ended_reason || 'model_timeout';
                    console.warn(`[SCAN ${scanId}] OpenAI scan aborted (timeout)`);
                  } else {
                    console.error(`[SCAN ${scanId}] OpenAI scan failed:`, err?.message || err);
                    scanMetadata.ended_reason = scanMetadata.ended_reason || 'openai_api_error';
                  }
            return [];
          }
        })()
        : Promise.resolve([]);
      
    // Wait for both to complete (or race to first result for early UI)
    // Use Promise.allSettled to get both results regardless of which finishes first
    await updateProgress('processing', 0);
    
    const [geminiResult, openaiResult] = await Promise.allSettled([
      geminiPromise,
      openaiPromise
    ]);
    
    finalizedScans.add(scanId);
    
    // Extract results from settled promises
    const geminiData = geminiResult.status === 'fulfilled' ? geminiResult.value : { books: [], usedRepair: false, rawLength: 0, needsOpenAI: false };
    const openaiData = openaiResult.status === 'fulfilled' ? openaiResult.value : [];
    
    gemini = geminiData.books || [];
    openai = Array.isArray(openaiData) ? openaiData : [];
    
    // Merge results - always merge for best coverage
    if (gemini.length > 0 || openai.length > 0) {
      const merged = mergeBookResults(gemini, openai);
      gemini = merged;
          openai = [];
      await updateProgress('merging', merged.length);
        } else {
          scanFailed = true;
          scanMetadata.ended_reason = scanMetadata.ended_reason || 'no_books_detected';
      console.warn(`[SCAN ${scanId}] Both providers returned empty results`);
      }
      
    } catch (err: any) {
      console.error(`[SCAN ${scanId}] Scan error:`, err?.message || err);
      scanFailed = true;
      scanMetadata.ended_reason = scanMetadata.ended_reason || 'scan_exception';
      if (err?.name === 'AbortError') {
        scanMetadata.ended_reason = 'request_aborted';
      }
    finalizedScans.add(scanId);
  } finally {
    // Cleanup
      if (geminiTimeout) clearTimeout(geminiTimeout);
      if (openaiTimeout) clearTimeout(openaiTimeout);
    if (!geminiController.signal.aborted) geminiController.abort();
    if (!openaiController.signal.aborted) openaiController.abort();
  }
      
  // Process and validate results
    const openaiCount = openai?.length || 0;
    const geminiCount = gemini?.length || 0;
    
  await updateProgress('validating', gemini.length);
  
  // Fix title/author swaps
    const fixSwappedBooks = (books: any[]) => {
      return books.map(book => {
        const title = book.title?.trim() || '';
        const author = book.author?.trim() || '';
      const titleLooksLikeName = title && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(title) && title.split(' ').length <= 4;
      const authorLooksLikeTitle = author && (author.toLowerCase().startsWith('the ') || author.length > 20);
        if (titleLooksLikeName && authorLooksLikeTitle) {
        return { ...book, title: author, author: formatAuthorName(title) };
      }
        return book;
      });
    };
    
  const fixedBooks = fixSwappedBooks(gemini || []);
  const merged = dedupeBooks(fixedBooks);
  
  // Apply cheap validator
  const cheapValidated = merged.map(book => cheapValidate(book).normalizedBook);
  const cheapFiltered = cheapValidated.filter(book => !book.cheapFilterReason);
  
  // Batch validate
  await updateProgress('batch_validating', cheapFiltered.length);
  const validatedBooks = await batchValidateBooks(cheapFiltered);
  const validBooks = validatedBooks.filter(book => book.confidence !== 'invalid' && book.isValid !== false);
  const finalBooks = dedupeBooks(validBooks);
  
  // Check if validation filtered everything out
  if (finalBooks.length === 0 && (gemini.length > 0 || openai.length > 0)) {
    scanMetadata.ended_reason = 'validation_failed';
    console.warn(`[SCAN ${scanId}] All books filtered out by validation`);
  } else if (finalBooks.length === 0) {
    scanMetadata.ended_reason = scanMetadata.ended_reason || 'no_books_detected';
  } else {
    scanMetadata.ended_reason = 'completed';
  }
  
    const apiResults = {
      openai: {
        working: hasOpenAIKey && openaiCount > 0,
        count: openaiCount,
        hasKey: hasOpenAIKey,
      error: openai.length === 0 && hasOpenAIKey && openaiAttempted ? 'No books returned' : null
      },
      gemini: {
        working: hasGeminiKey && geminiCount > 0,
        count: geminiCount,
        hasKey: hasGeminiKey,
      error: gemini.length === 0 && hasGeminiKey && geminiAttempted ? 'No books returned' : null
    }
  };
  
  // Log final metadata with jobId correlation
  console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Scan completed:`, {
    received_image_bytes: scanMetadata.received_image_bytes,
    content_type: scanMetadata.content_type,
    parse_path: scanMetadata.parse_path,
    ended_reason: scanMetadata.ended_reason,
    books_found: finalBooks.length
  });
  
  // Update job with final results
  await supabase
    .from('scan_jobs')
    .update({
      status: finalBooks.length > 0 ? 'completed' : 'failed',
      books: finalBooks,
      api_results: apiResults,
      progress: { stage: 'completed', booksFound: finalBooks.length },
      error: finalBooks.length === 0 ? JSON.stringify({
        code: scanMetadata.ended_reason || 'no_books_detected',
        message: 'No books detected after validation',
        metadata: scanMetadata
      }) : null,
      updated_at: new Date().toISOString()
    })
    .eq('id', jobId);
  
  console.log(`[API] Scan job ${jobId} completed with ${finalBooks.length} books`);
  } catch (error: any) {
    // Update job with error
    scanMetadata.ended_reason = scanMetadata.ended_reason || 'scan_exception';
    const errorCode = error?.name === 'AbortError' ? 'request_aborted' : 
                     error?.code || 'scan_exception';
    
    console.error(`[API] Scan job ${jobId} failed:`, error);
    console.error(`[API] [SCAN ${scanId}] Error metadata:`, {
      received_image_bytes: scanMetadata.received_image_bytes,
      content_type: scanMetadata.content_type,
      parse_path: scanMetadata.parse_path,
      ended_reason: scanMetadata.ended_reason,
      error_message: error?.message || String(error)
    });
    
    await supabase
      .from('scan_jobs')
      .update({
        status: 'failed',
        error: JSON.stringify({
          code: errorCode,
          message: error?.message || String(error),
          metadata: scanMetadata
        }),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { imageDataURL, userId } = req.body || {};
    if (!imageDataURL || typeof imageDataURL !== 'string') {
      return res.status(400).json({ 
        status: 'error',
        error: { code: 'missing_image', message: 'imageDataURL is required' }
      });
    }

    // Generate jobId for this scan
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Create job in Supabase immediately
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ 
        status: 'error',
        error: { code: 'database_not_configured', message: 'Database not configured' }
      });
    }
    
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    // Server-side dedupe: hash image bytes and check for recent duplicate
    let imageHash: string | null = null;
    try {
      const crypto = await import('crypto');
      imageHash = crypto.createHash('sha256').update(imageDataURL).digest('hex').substring(0, 16);
      console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Image hash: ${imageHash}, userId: ${userId || 'guest'}`);
      
      // Check Supabase for recent duplicate job (same user within 5 seconds)
      const { data: duplicateJobs } = await supabase
        .from('scan_jobs')
        .select('id, status, created_at')
        .eq('user_id', userId || null)
        .gte('created_at', new Date(Date.now() - 5000).toISOString())
        .order('created_at', { ascending: false })
        .limit(5);
      
      if (duplicateJobs && duplicateJobs.length > 0) {
        console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Found ${duplicateJobs.length} recent scan jobs (possible duplicate)`);
        for (const dup of duplicateJobs) {
          if (dup.id !== jobId) {
            console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Recent job found: ${dup.id} (status: ${dup.status}, created: ${dup.created_at})`);
          }
        }
      }
    } catch (hashError) {
      // Hash calculation failed, continue anyway
      console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] Failed to hash image for duplicate detection:`, hashError);
    }
    
    // Create job record in durable storage (Supabase)
    // This ensures all instances can read the same job state
    const { error: insertError } = await supabase
      .from('scan_jobs')
      .insert({
        id: jobId,
        user_id: userId || null,
        image_data: imageDataURL,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    
    console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Job created in durable storage (Supabase)`);
    
    if (insertError) {
      console.error('[API] Error creating scan job:', insertError);
      return res.status(500).json({ 
        status: 'error',
        error: { code: 'job_creation_failed', message: 'Failed to create scan job' }
      });
    }
    
    // Return jobId immediately (202 Accepted) - only jobId and status, NEVER books
    res.status(202).json({
      jobId,
      status: 'pending'
    });
    
    // Enqueue job to worker via QStash (or fallback to direct call if QStash not configured)
    const qstashUrl = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2/publish/';
    const qstashToken = process.env.QSTASH_TOKEN;
    const workerUrl = process.env.WORKER_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/scan-worker`;
    
    if (qstashToken) {
      // Use QStash to trigger worker asynchronously
      // QStash URL format: https://qstash.upstash.io/v2/publish/{destination_url}
      try {
        const qstashPublishUrl = qstashUrl.endsWith('/') 
          ? `${qstashUrl}${workerUrl}` 
          : `${qstashUrl}/${workerUrl}`;
        
        console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Enqueuing to QStash: ${qstashPublishUrl}`);
        
        const qstashResponse = await fetch(qstashPublishUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${qstashToken}`,
            'Content-Type': 'application/json',
            'Upstash-Delay': '0', // Process immediately
          },
          body: JSON.stringify({
            jobId,
            scanId,
            userId,
            imageDataURL
          })
        });
        
        if (!qstashResponse.ok) {
          console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash enqueue failed: ${qstashResponse.status}`);
          // Fallback: try direct call (not ideal but better than nothing)
          processScanJob(imageDataURL, userId, scanId, jobId).catch((error) => {
            console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Fallback worker error:`, error);
          });
        } else {
          console.log(`[API] [SCAN ${scanId}] [JOB ${jobId}] Job enqueued to QStash worker`);
        }
      } catch (qstashError: any) {
        console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash error:`, qstashError?.message || qstashError);
        // Fallback: try direct call
        processScanJob(imageDataURL, userId, scanId, jobId).catch((error) => {
          console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Fallback worker error:`, error);
        });
      }
    } else {
      // QStash not configured - use direct call as fallback
      // WARNING: This may not work reliably in Vercel serverless
      console.warn(`[API] [SCAN ${scanId}] [JOB ${jobId}] QStash not configured, using direct call (may not work reliably)`);
      processScanJob(imageDataURL, userId, scanId, jobId).catch((error) => {
        console.error(`[API] [SCAN ${scanId}] [JOB ${jobId}] Direct worker error:`, error);
      });
    }
    
  } catch (e: any) {
    console.error('[API] Error in scan handler:', e);
    return res.status(500).json({ 
      status: 'error',
      error: { code: 'scan_failed', message: e?.message || String(e) }
    });
  }
}
