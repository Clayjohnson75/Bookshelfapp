import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Proxy API route for Google Books API requests
 * 
 * This route:
 * - Adds GOOGLE_BOOKS_API_KEY to all requests (server-side only)
 * - Rate-limits requests to prevent 429 errors
 * - Caches responses to reduce API calls
 * - Handles 429 errors with proper retry logic
 */

// Simple in-memory cache (7 days for success, 1 hour for errors)
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
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { path, ...queryParams } = req.query;
    
    // Validate path
    if (!path || typeof path !== 'string') {
      return res.status(400).json({ error: 'path parameter required (e.g., /volumes or /volumes/{id})' });
    }

    // Build cache key from path and params
    const cacheKey = `${path}?${new URLSearchParams(queryParams as Record<string, string>).toString()}`;
    
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ttl = cached.isError ? CACHE_TTL_ERROR_MS : CACHE_TTL_SUCCESS_MS;
      if (age < ttl) {
        return res.status(cached.isError ? 500 : 200).json(cached.data);
      }
      // Cache expired, remove it
      cache.delete(cacheKey);
    }

    // Rate limit
    await waitForRateLimit();

    // Build URL with API key
    const url = buildGoogleBooksUrl(path, queryParams as Record<string, string>);

    // Make request to Google Books API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    let response: Response;
    try {
      response = await fetch(url, { 
        signal: controller.signal,
        headers: {
          'User-Agent': 'BookshelfScanner/1.0',
        }
      });
      clearTimeout(timeoutId);
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        const errorData = { error: 'Request timeout' };
        cache.set(cacheKey, { data: errorData, timestamp: Date.now(), isError: true });
        return res.status(500).json(errorData);
      }
      throw fetchError;
    }

    // Handle rate limiting (429) with Retry-After header support
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
      const errorData = { 
        error: 'Rate limited',
        retryAfter: retryAfterSeconds,
        message: `Google Books API rate limited${retryAfterSeconds ? ` (Retry-After: ${retryAfterSeconds}s)` : ''}`
      };
      cache.set(cacheKey, { data: errorData, timestamp: Date.now(), isError: true });
      return res.status(429).json(errorData);
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: any = { error: `Google Books API error: ${response.status}`, status: response.status };
      try {
        errorData = { ...errorData, ...JSON.parse(errorText) };
      } catch (e) {
        errorData.message = errorText;
      }
      cache.set(cacheKey, { data: errorData, timestamp: Date.now(), isError: true });
      return res.status(response.status).json(errorData);
    }

    const data = await response.json();
    
    // Cache successful response
    cache.set(cacheKey, { data, timestamp: Date.now(), isError: false });
    
    return res.status(200).json(data);
  } catch (error: any) {
    console.error('[GoogleBooks Proxy] Error:', error?.message || error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || String(error)
    });
  }
}

