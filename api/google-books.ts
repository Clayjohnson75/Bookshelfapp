import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Resilient Google Books API Proxy
 * 
 * CRITICAL: Never throws 503 to client. Always returns 200 with { ok: false } on errors.
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

// Rate limiting: track last request time
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1200; // 1.2 seconds between requests

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastRequestTime = Date.now();
}

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3500]; // ms, exponential backoff

// Initialize Supabase client for shared caching
let supabaseClient: any = null;
function initSupabaseClient() {
  if (supabaseClient !== null) return;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      supabaseClient = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
  } catch (e) {
    // Supabase not available - that's fine, use in-memory cache only
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
  
  // Add new params
  if (params && typeof params === 'object') {
    try {
      Object.entries(params).forEach(([key, value]) => {
        if (key && value !== undefined && value !== null) {
          urlParams.append(key, String(value));
        }
      });
    } catch (e) {
      // Silently fail if params is not iterable
    }
  }
  
  // Add API key if available
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  if (apiKey) {
    urlParams.append('key', apiKey);
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
    const { path, ...queryParams } = req.query;
    
    // Validate path
    if (!path || typeof path !== 'string') {
      // CRITICAL: Return 200 with ok:false instead of 400
      return res.status(200).json({ ok: false, error: 'path parameter required' });
    }

    // Build cache key from path and params
    const cacheKey = `${path}?${new URLSearchParams(queryParams as Record<string, string>).toString()}`;
    
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
        // Rate limit between attempts
        if (attempt > 0) {
          const delay = RETRY_DELAYS[attempt - 1] || 5000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await waitForRateLimit();

        // Build URL with API key
        const url = buildGoogleBooksUrl(path, queryParams as Record<string, string>);

        // Make request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let response: Response;
        try {
          response = await fetch(url, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'BookshelfScanner/1.0' }
          });
          clearTimeout(timeoutId);
        } catch (fetchError: any) {
          clearTimeout(timeoutId);
          if (fetchError.name === 'AbortError') {
            lastError = { error: 'Request timeout', code: 'timeout' };
            continue; // Retry
          }
          throw fetchError;
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

        // Success! Parse and cache
        const data = await response.json();
        
        // Cache in memory
        cache.set(cacheKey, { data, timestamp: Date.now(), isError: false });
        
        // Cache in Supabase (shared across users)
        await saveToSupabaseCache(cacheKey, data);
        
        // CRITICAL: Always return 200 with ok:true
        return res.status(200).json({ ok: true, data });

      } catch (attemptError: any) {
        lastError = { error: attemptError?.message || String(attemptError), code: 'network_error' };
        if (attempt < MAX_RETRIES) continue; // Retry
      }
    }

    // All retries exhausted - return error gracefully
    // CRITICAL: Always return 200 with ok:false, never throw 503
    const errorResponse = {
      ok: false,
      ...lastError,
      retryAfterMs: retryAfterMs
    };
    
    // Cache error (short TTL)
    cache.set(cacheKey, { data: errorResponse, timestamp: Date.now(), isError: true });
    
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

