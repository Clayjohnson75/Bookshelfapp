import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Resilient Google Books API Proxy
 * 
 * CRITICAL: Never throws 503 to client. Always returns 200 with { ok: false } on errors.
 * 
 * API key: Set GOOGLE_BOOKS_API_KEY in Vercel project env (Dashboard Settings Environment Variables).
 * The proxy adds this key to all requests to Google Books API (server-side only; client never sees the key).
 * 
 * Features:
 * - Adds GOOGLE_BOOKS_API_KEY to all requests (server-side only)
 * - Rate-limits requests to prevent 429 errors
 * - Caches responses in Supabase (shared across users) and in-memory
 * - Retries 429/5xx with exponential backoff
 * - Always returns 200 status (never 503) with { ok: false } on errors
 */

// In-memory cache (7 days for success, 1 hour for errors)
interface CacheEntry {
 data: any;
 timestamp: number;
 isError: boolean;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_SUCCESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_TTL_ERROR_MS = 60 * 60 * 1000; // 1 hour

// Serialize all Google requests: only one in flight, with spacing (avoids 429 from concurrent bursts)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 800; // 800ms between *starts* of requests
let googleRequestTail: Promise<unknown> = Promise.resolve();

async function waitForRateLimit(): Promise<void> {
 const now = Date.now();
 const elapsed = now - lastRequestTime;
 if (elapsed < MIN_REQUEST_INTERVAL_MS) {
 await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
 }
 lastRequestTime = Date.now();
}

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3500]; // ms, exponential backoff

// Initialize Supabase client for shared caching only when service role is available.
// SECURITY: Cache read/write requires service role (bypasses RLS). Do NOT fall back to anon key —
// that would mix concerns and can violate RLS or write to tables that anon cannot safely write.
// If SUPABASE_SERVICE_ROLE_KEY is missing: we do not create a client; Supabase cache is skipped;
// the route still works (in-memory cache + live Google Books API).
let supabaseClient: any = null;
function initSupabaseClient() {
  if (supabaseClient !== null) return;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Service role only. No anon fallback — skip Supabase cache when service role is missing.
    if (supabaseUrl && serviceKey) {
      supabaseClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
  } catch (e) {
    // Supabase not available - use in-memory cache only
  }
}
initSupabaseClient();

// Check Supabase cache (shared across all users)
async function checkSupabaseCache(cacheKey: string): Promise<any | null> {
 if (!supabaseClient) return null;
 try {
 const { data, error } = await supabaseClient
 .from('google_books_cache')
 .select('data, created_at')
 .eq('cache_key', cacheKey)
 .single();
 
 if (error || !data) return null;
 
 // Check if cache is still valid (7 days)
 const age = Date.now() - new Date(data.created_at).getTime();
 if (age > CACHE_TTL_SUCCESS_MS) return null;
 
 return data.data;
 } catch (e) {
 return null;
 }
}

// Save to Supabase cache
async function saveToSupabaseCache(cacheKey: string, data: any): Promise<void> {
 if (!supabaseClient) return;
 try {
 await supabaseClient
 .from('google_books_cache')
 .upsert({
 cache_key: cacheKey,
 data: data,
 created_at: new Date().toISOString()
 }, { onConflict: 'cache_key' });
 } catch (e) {
 // Silently fail - cache is best-effort
 }
}

// Google Books API only accepts these query params for volumes list; "fields" is NOT supported and can cause 400
const ALLOWED_GOOGLE_PARAMS = new Set(['q', 'maxResults', 'projection', 'startIndex', 'orderBy', 'filter', 'langRestrict', 'printType', 'download', 'key']);

function buildGoogleBooksUrl(path: string, params?: Record<string, string>): string {
 const baseUrl = `https://www.googleapis.com/books/v1${path}`;
 const urlParams = new URLSearchParams();
 
 // Add existing query params if path already has them
 const [pathPart, existingQuery] = path.split('?');
 if (existingQuery) {
 existingQuery.split('&').forEach(param => {
 const [key, value] = param.split('=');
 if (key && value) {
 urlParams.append(key, decodeURIComponent(value));
 }
 });
 }
 
 // Add only allowed params (strip "fields" and other unknown params that can cause 400)
 if (params && typeof params === 'object') {
 try {
 Object.entries(params).forEach(([key, value]) => {
 if (key && value !== undefined && value !== null && ALLOWED_GOOGLE_PARAMS.has(key)) {
 urlParams.append(key, String(value));
 }
 });
 } catch (e) {
 // Silently fail if params is not iterable
 }
 }
 
 // Add API key if available (required for reliable quota; without it Google may return 403 or empty)
 const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
 if (apiKey) {
 urlParams.set('key', apiKey);
 }
 
 const queryString = urlParams.toString();
 return queryString ? `${baseUrl.split('?')[0]}?${queryString}` : baseUrl;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
 // Add CORS headers
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

 // Handle OPTIONS preflight request
 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 if (req.method !== 'GET' && req.method !== 'POST') {
 // CRITICAL: Return 200 with ok:false instead of 405
 return res.status(200).json({ ok: false, error: 'Method not allowed' });
 }

 try {
 const rawPath = req.query.path;
 const path = Array.isArray(rawPath) ? rawPath[0] : rawPath;
 const rawQuery = { ...req.query };
 delete rawQuery.path;
 // Normalize to Record<string, string> (Vercel can give string | string[])
 const queryParams: Record<string, string> = {};
 Object.entries(rawQuery).forEach(([k, v]) => {
 if (v !== undefined && v !== null) {
 queryParams[k] = Array.isArray(v) ? v[0] : String(v);
 }
 });

 if (!path || typeof path !== 'string') {
 return res.status(200).json({ ok: false, error: 'path parameter required' });
 }

 const cacheKey = `${path}?${new URLSearchParams(queryParams).toString()}`;
 
 // Step 1: Check in-memory cache
 const cached = cache.get(cacheKey);
 if (cached) {
 const age = Date.now() - cached.timestamp;
 const ttl = cached.isError ? CACHE_TTL_ERROR_MS : CACHE_TTL_SUCCESS_MS;
 if (age < ttl) {
 // CRITICAL: Always return 200, even for cached errors
 if (cached.isError) {
 return res.status(200).json({ ok: false, ...cached.data });
 }
 return res.status(200).json({ ok: true, data: cached.data });
 }
 cache.delete(cacheKey);
 }

 // Step 2: Check Supabase cache (shared across users)
 const supabaseCached = await checkSupabaseCache(cacheKey);
 if (supabaseCached) {
 // Cache in memory for faster access
 cache.set(cacheKey, { data: supabaseCached, timestamp: Date.now(), isError: false });
 return res.status(200).json({ ok: true, data: supabaseCached });
 }

 // Step 3: Fetch from Google Books API with retry
 let lastError: any = null;
 let retryAfterMs: number | null = null;
 
 for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
 try {
 if (attempt > 0) {
 const delay = RETRY_DELAYS[attempt - 1] || 5000;
 await new Promise(resolve => setTimeout(resolve, delay));
 }

 const url = buildGoogleBooksUrl(path, queryParams);
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 25000);

 // Serialize: only one request to Google at a time, with spacing (avoids 429)
 const runFetch = async (): Promise<Response> => {
 await waitForRateLimit();
 return fetch(url, {
 signal: controller.signal,
 headers: { 'User-Agent': 'BookshelfScanner/1.0' }
 });
 };
 const myOp = googleRequestTail.then(runFetch);
 googleRequestTail = myOp.then(() => {}, () => {});

 let response: Response;
 try {
 response = await myOp;
 } catch (fetchError: any) {
 clearTimeout(timeoutId);
 if (fetchError.name === 'AbortError') {
 lastError = { error: 'Request timeout', code: 'timeout' };
 continue;
 }
 throw fetchError;
 }
 clearTimeout(timeoutId);

 if (response.status === 403) {
 console.error('[GoogleBooks Proxy] 403 from Google Books API - check GOOGLE_BOOKS_API_KEY is set in Vercel and enabled for Books API');
 lastError = { error: 'Forbidden', code: 'forbidden', status: 403 };
 break;
 }

 // Handle 429 (rate limit) - retry with backoff
 if (response.status === 429) {
 const retryAfter = response.headers.get('Retry-After');
 retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
 lastError = { 
 error: 'Rate limited', 
 code: 'rate_limited',
 retryAfter: retryAfterMs ? Math.floor(retryAfterMs / 1000) : null
 };
 
 // If Retry-After is provided and we have retries left, wait and retry
 if (retryAfterMs && attempt < MAX_RETRIES) {
 await new Promise(resolve => setTimeout(resolve, retryAfterMs!));
 continue;
 }
 continue; // Will retry with exponential backoff
 }

 // Handle 5xx errors - retry
 if (response.status >= 500 && response.status < 600) {
 lastError = { error: `Google Books API error: ${response.status}`, code: 'server_error', status: response.status };
 if (attempt < MAX_RETRIES) continue; // Retry
 }

 // Handle other non-OK responses
 if (!response.ok) {
 const errorText = await response.text();
 let errorData: any = { error: `Google Books API error: ${response.status}`, code: 'api_error', status: response.status };
 try {
 errorData = { ...errorData, ...JSON.parse(errorText) };
 } catch (e) {
 errorData.message = errorText;
 }
 lastError = errorData;
 // Don't retry 4xx errors (except 429)
 break;
 }

 const data = (await response.json()) as { totalItems?: number; items?: unknown[] };
 const totalItems = (data && typeof data.totalItems === 'number') ? data.totalItems : (data?.items?.length ?? -1);
 if (totalItems === 0) {
 console.log('[GoogleBooks Proxy] Google returned 0 results for q=', (queryParams.q || '').substring(0, 60));
 }

 cache.set(cacheKey, { data, timestamp: Date.now(), isError: false });
 await saveToSupabaseCache(cacheKey, data);
 return res.status(200).json({ ok: true, data });

 } catch (attemptError: any) {
 lastError = { error: attemptError?.message || String(attemptError), code: 'network_error' };
 if (attempt < MAX_RETRIES) continue; // Retry
 }
 }

 const errorResponse = {
 ok: false,
 ...lastError,
 retryAfterMs: retryAfterMs
 };

 // Do NOT cache 429 (rate_limited) so retries can hit Google again and succeed
 if ((lastError as { code?: string })?.code !== 'rate_limited') {
 cache.set(cacheKey, { data: errorResponse, timestamp: Date.now(), isError: true });
 }

 return res.status(200).json(errorResponse);

 } catch (error: any) {
 // CRITICAL: Catch all errors and return 200 with ok:false, never throw 503
 console.error('[GoogleBooks Proxy] Unexpected error:', error?.message || error);
 return res.status(200).json({ 
 ok: false,
 error: 'Internal server error',
 code: 'internal_error',
 message: error?.message || String(error)
 });
 }
}

