/**
 * Centralized Google Books API Service
 * 
 * This service consolidates all Google Books API calls to:
 * 1. Avoid duplicate requests for the same book
 * 2. Fetch all data (cover, description, stats) in one call
 * 3. Implement proper rate limiting and caching
 * 4. Use googleBooksId when available instead of searching again
 */

export interface GoogleBooksData {
  coverUrl?: string;
  googleBooksId?: string;
  pageCount?: number;
  categories?: string[];
  publisher?: string;
  publishedDate?: string;
  language?: string;
  averageRating?: number;
  ratingsCount?: number;
  subtitle?: string;
  printType?: string;
  description?: string;
}

// Google Books API response types
interface GoogleBooksVolume {
  id: string;
  volumeInfo: {
    title?: string;
    authors?: string[];
    pageCount?: number;
    categories?: string[];
    publisher?: string;
    publishedDate?: string;
    language?: string;
    averageRating?: number;
    ratingsCount?: number;
    subtitle?: string;
    printType?: string;
    description?: string;
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
    };
  };
}

interface GoogleBooksResponse {
  kind?: string;
  totalItems?: number;
  items?: GoogleBooksVolume[];
  volumeInfo?: GoogleBooksVolume['volumeInfo'];
  id?: string;
}

// Single volume response (for fetchByGoogleBooksId)
interface GoogleBooksVolumeResponse {
  id: string;
  volumeInfo: GoogleBooksVolume['volumeInfo'];
}

// Define __DEV__ for TypeScript if not available
declare const __DEV__: boolean;

// In-memory cache to avoid duplicate API calls
const cache = new Map<string, GoogleBooksData | GoogleBooksData[]>();
const pendingRequests = new Map<string, Promise<GoogleBooksData | GoogleBooksData[]>>();

// Helper to check if we're in dev mode (for __DEV__ replacement)
const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

// Log level system
const LOG_LEVEL = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

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

// Google Books API queue (single-flight execution, like Gemini)
interface GoogleBooksQueueItem {
  title: string;
  author?: string;
  googleBooksId?: string;
  resolve: (value: GoogleBooksData) => void;
  reject: (error: any) => void;
  retryCount: number;
  timestamp: number;
}

let googleBooksQueue: GoogleBooksQueueItem[] = [];
let googleBooksProcessing = false;
let lastGoogleBooksRequestTime = 0;
const MIN_GOOGLE_BOOKS_INTERVAL_MS = 1200; // 1.2 seconds minimum between requests (very conservative to prevent 429s)
const MAX_GOOGLE_BOOKS_RETRIES = 2; // Max 2 retries for 429 errors

/**
 * Clear the Google Books queue (cancel all pending requests)
 * Called when screen loses focus or component unmounts
 */
export function clearGoogleBooksQueue() {
  log('debug', '[GoogleBooks] Clearing queue, cancelling all pending requests');
  
  // Resolve all pending queue items with empty result (don't reject - that causes errors)
  // This silently cancels them without throwing errors
  for (const item of googleBooksQueue) {
    try {
      item.resolve({}); // Resolve with empty object instead of rejecting
    } catch (error) {
      // Ignore errors from resolving (item might already be resolved)
    }
  }
  
  // Clear the queue
  googleBooksQueue = [];
  
  // Stop processing
  googleBooksProcessing = false;
}

// Cache for cover results (7 days for success, 24h for no match)
interface CacheEntry {
  data: GoogleBooksData;
  timestamp: number;
  isNegative: boolean; // true if "no match found"
}
const coverCache = new Map<string, CacheEntry>();
const CACHE_TTL_SUCCESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_TTL_NEGATIVE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting: queue requests with delays (legacy, kept for backward compatibility)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1 second between requests

/**
 * Wait for rate limit cooldown (legacy function, kept for backward compatibility)
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastRequestTime = Date.now();
}

/**
 * Process Google Books queue - ensures single-flight execution
 * Only ONE Google Books request runs at a time, globally
 * With proper spacing and exponential backoff on 429
 */
async function processGoogleBooksQueue(): Promise<void> {
  // If already processing or queue is empty, return
  if (googleBooksProcessing || googleBooksQueue.length === 0) {
    return;
  }
  
  googleBooksProcessing = true;
  
  while (googleBooksQueue.length > 0) {
    const item = googleBooksQueue.shift()!;
    const now = Date.now();
    
    // Enforce minimum interval between requests (CRITICAL: prevents burst 429s)
    const timeSinceLastRequest = now - lastGoogleBooksRequestTime;
    if (timeSinceLastRequest < MIN_GOOGLE_BOOKS_INTERVAL_MS) {
      const waitTime = MIN_GOOGLE_BOOKS_INTERVAL_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    try {
      lastGoogleBooksRequestTime = Date.now();
      
      // Use the direct search function (bypassing queue to avoid recursion)
      const result = await searchBookDirect(item.title, item.author, item.googleBooksId, item.retryCount);
      item.resolve(result);
      
      // Add spacing after successful request (prevents burst - increased to 400ms)
      await new Promise(resolve => setTimeout(resolve, 400));
    } catch (error: any) {
      // Handle 429 errors - re-queue with exponential backoff
      if (error?.status === 429 || error?.message?.includes('429') || error?.statusCode === 429) {
        if (item.retryCount < MAX_GOOGLE_BOOKS_RETRIES) {
          // Check for Retry-After header first
          let retryDelay: number;
          if (error?.retryAfter && typeof error.retryAfter === 'number') {
            retryDelay = error.retryAfter * 1000; // Convert seconds to ms
            log('warn', `[GoogleBooks] Rate limited (429), using Retry-After: ${error.retryAfter}s`);
          } else {
            // Exponential backoff: 2s → 4s → 8s (cap at 30s)
            retryDelay = Math.min(2000 * Math.pow(2, item.retryCount), 30000);
            const jitter = Math.random() * 1000; // 0-1s random
            retryDelay += jitter;
            
            // Only log once per batch to avoid spam
            if (item.retryCount === 0) {
              log('warn', `[GoogleBooks] Rate limited (429), throttling cover fetch queue`);
            }
          }
          
          log('debug', `[GoogleBooks] Re-queuing "${item.title}" with ${Math.ceil(retryDelay/1000)}s delay (retry ${item.retryCount + 1}/${MAX_GOOGLE_BOOKS_RETRIES})`);
          
          // Add back to queue with delay (don't continue processing immediately)
          setTimeout(() => {
            googleBooksQueue.push({
              ...item,
              retryCount: item.retryCount + 1,
              timestamp: Date.now(),
            });
            processGoogleBooksQueue(); // Process queue again
          }, retryDelay);
          
          // Stop processing this batch - wait for retry
          break;
        } else {
          log('warn', `[GoogleBooks] Failed after ${MAX_GOOGLE_BOOKS_RETRIES} retries for: "${item.title}"`);
          item.resolve({}); // Return empty instead of failing
        }
      } else {
        // Non-429 error - fail immediately
        log('error', `[GoogleBooks] Non-429 error for "${item.title}":`, error?.message || error);
        item.resolve({}); // Return empty on other errors too
      }
      
      // Add spacing after error (prevents hammering)
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  googleBooksProcessing = false;
}

/**
 * Queue a Google Books request (single-flight execution)
 */
function queueGoogleBooksRequest(
  title: string,
  author?: string,
  googleBooksId?: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  return new Promise((resolve, reject) => {
    googleBooksQueue.push({
      title,
      author,
      googleBooksId,
      resolve,
      reject,
      retryCount,
      timestamp: Date.now(),
    });
    
    // Start processing if not already running
    processGoogleBooksQueue();
  });
}

/**
 * Normalize string for comparison (lowercase, remove punctuation, normalize whitespace)
 */
const norm = (s: string): string =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Calculate token overlap score between two strings (0..1)
 */
function tokenOverlapScore(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size); // 0..1
}

/**
 * Pick the best matching volume from Google Books results
 * Scores all items by title/author similarity, then adds bonuses for rich metadata
 * Returns the full item (or null if no items)
 */
function pickBestVolume(
  items: any[],
  inputTitle: string,
  inputAuthor?: string
): { id: string; volumeInfo: any } | null {
  const DEBUG_GOOGLE_BOOKS = process.env.DEBUG_GOOGLE_BOOKS === 'true' || isDev;
  const candidates: Array<{ item: any; score: number; titleScore: number; authorScore: number; bonuses: { imageLinks: number; description: number; categories: number } }> = [];

  for (const book of items || []) {
    const v = book.volumeInfo || {};
    const title = v.title || "";
    const authors: string[] = v.authors || [];

    // Base similarity scores (0..1)
    const titleScore = tokenOverlapScore(inputTitle, title);
    const authorScore = inputAuthor
      ? Math.max(0, ...authors.map(a => tokenOverlapScore(inputAuthor, a)))
      : 0;

    // Base weighted score (title 75%, author 25%)
    let score = (titleScore * 0.75) + (authorScore * 0.25);

    // Bonuses for rich metadata (small bonuses to prefer richer items)
    const bonuses = {
      imageLinks: 0,
      description: 0,
      categories: 0,
    };

    // Bonus for having imageLinks (0.05 bonus)
    if (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) {
      bonuses.imageLinks = 0.05;
      score += 0.05;
    }

    // Bonus for having description (0.03 bonus, more if longer)
    if (v.description) {
      bonuses.description = 0.03;
      if (v.description.length > 200) {
        bonuses.description = 0.05; // Longer descriptions get bigger bonus
      }
      score += bonuses.description;
    }

    // Bonus for having categories (0.02 bonus)
    if (v.categories && v.categories.length > 0) {
      bonuses.categories = 0.02;
      score += 0.02;
    }

    candidates.push({
      item: book,
      score,
      titleScore,
      authorScore,
      bonuses,
    });
  }

  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score);

  // Debug logging for top 3 candidates
  if (DEBUG_GOOGLE_BOOKS) {
    console.log(`[DEBUG_GOOGLE_BOOKS] Scoring Results (top ${Math.min(3, candidates.length)} candidates):`);
    for (const [i, candidate] of candidates.slice(0, 3).entries()) {
      const v = candidate.item.volumeInfo || {};
      const hasImageLinks = !!(v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail));
      console.log(`[DEBUG_GOOGLE_BOOKS]   Candidate #${i}:`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     ID: ${candidate.item.id}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     Title: "${v.title || 'NO TITLE'}"`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     Authors: ${(v.authors || []).join(', ') || 'NO AUTHORS'}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     titleScore: ${candidate.titleScore.toFixed(3)}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     authorScore: ${candidate.authorScore.toFixed(3)}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     hasImageLinks: ${hasImageLinks ? 'YES' : 'NO'}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     hasDescription: ${v.description ? `YES (${v.description.length} chars)` : 'NO'}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     hasCategories: ${v.categories ? `YES [${v.categories.join(', ')}]` : 'NO'}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     Bonuses: imageLinks=+${candidate.bonuses.imageLinks.toFixed(3)}, description=+${candidate.bonuses.description.toFixed(3)}, categories=+${candidate.bonuses.categories.toFixed(3)}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     finalScore: ${candidate.score.toFixed(3)}`);
      console.log(`[DEBUG_GOOGLE_BOOKS]     ${i === 0 ? '✅ WINNER' : ''}`);
    }
  }

  // Return the best item (or null if no candidates)
  if (candidates.length === 0) {
    return null;
  }

  const best = candidates[0];
  return {
    id: best.item.id,
    volumeInfo: best.item.volumeInfo,
  };
}

/**
 * Validate that a cover URL is actually a book cover (not a placeholder or old paper image)
 */
function isValidBookCover(coverUrl: string): boolean {
  if (!coverUrl) return false;
  
  // Must be from Google Books API (allow all Google domains)
  if (
    !coverUrl.includes('books.google.com') &&
    !coverUrl.includes('googleapis.com') &&
    !coverUrl.includes('googleusercontent.com') &&
    !coverUrl.includes('gstatic.com')
  ) {
    return false;
  }
  
  const urlLower = coverUrl.toLowerCase();
  
  // Reject common placeholder patterns
  const invalidPatterns = [
    'nocover',           // No cover placeholder
    'nophoto',           // No photo placeholder
    'no-image',          // No image placeholder
    'placeholder',       // Generic placeholder
    'default',           // Default image
    'blank',             // Blank image
    'missing',           // Missing image
    'not-available',     // Not available
    'unavailable',       // Unavailable
  ];
  
  for (const pattern of invalidPatterns) {
    if (urlLower.includes(pattern)) {
      return false;
    }
  }
  
  // CRITICAL: Reject URLs that show book content pages (old paper) instead of covers
  // These have "content=bks" parameter and show actual book pages, not covers
  if (urlLower.includes('content=bks')) {
    // Only allow if it explicitly says it's a front cover
    if (!urlLower.includes('printsec=frontcover') && !urlLower.includes('img=1')) {
      return false; // This is a content page, not a cover
    }
  }
  
  // Must contain image format indicators or be a valid Google Books image URL
  const hasImageFormat = urlLower.includes('jpg') || urlLower.includes('jpeg') || 
                        urlLower.includes('png') || urlLower.includes('webp') ||
                        urlLower.includes('books/content'); // Google Books content URLs
  
  if (!hasImageFormat) {
    return false;
  }
  
  return true;
}

/**
 * Fetch book data by Google Books ID (most efficient)
 */
async function fetchByGoogleBooksId(
  googleBooksId: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  const cacheKey = `id:${googleBooksId}`;
  
  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    // Cache for ID lookup should always be a single object, not array
    if (!Array.isArray(cached)) {
      return cached;
    }
  }

  // Check if there's already a pending request for this ID
  if (pendingRequests.has(cacheKey)) {
    const pending = await pendingRequests.get(cacheKey)!;
    // Pending request for ID lookup should always be a single object, not array
    if (!Array.isArray(pending)) {
      return pending;
    }
  }

  const requestPromise = (async () => {
    try {
      await waitForRateLimit();
      
      // Add timeout to prevent hanging requests (8 second timeout)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      let response: Response;
      try {
        response = await fetch(
          `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          // Let queue retry once, then fail gracefully
          if (retryCount < 1) {
            throw new Error('Request timeout - retrying...');
          }
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      // Handle rate limiting (429) - throw error so queue can handle it
      if (response.status === 429) {
        const error: any = new Error(`Google Books 429: Rate limited`);
        error.status = 429;
        error.statusCode = 429;
        throw error; // Let queue handle retry logic
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return {};
      }

      const data = await response.json() as GoogleBooksVolumeResponse;
      const volumeInfo = data.volumeInfo || {};

      // Enhanced DEBUG_GOOGLE_BOOKS logging for direct ID lookup
      const DEBUG_GOOGLE_BOOKS = process.env.DEBUG_GOOGLE_BOOKS === 'true' || isDev;
      
      if (DEBUG_GOOGLE_BOOKS) {
        console.log(`[DEBUG_GOOGLE_BOOKS] ========================================`);
        console.log(`[DEBUG_GOOGLE_BOOKS] Direct ID Lookup:`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Google Books ID: ${googleBooksId}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Full URL: https://www.googleapis.com/books/v1/volumes/${googleBooksId}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Response Status: ${response.status} ${response.statusText}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Title: "${volumeInfo.title || 'NO TITLE'}"`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Authors: ${(volumeInfo.authors || []).join(', ') || 'NO AUTHORS'}`);
      }

      // Extract all data
      const result: GoogleBooksData = {
        googleBooksId: data.id || undefined,
        pageCount: volumeInfo.pageCount,
        categories: volumeInfo.categories,
        publisher: volumeInfo.publisher,
        publishedDate: volumeInfo.publishedDate,
        language: volumeInfo.language,
        averageRating: volumeInfo.averageRating,
        ratingsCount: volumeInfo.ratingsCount,
        subtitle: volumeInfo.subtitle,
        printType: volumeInfo.printType,
        description: volumeInfo.description,
      };

      // Extract cover URL - only use if it's a valid book cover (not placeholder)
      if (volumeInfo.imageLinks) {
        const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
        if (rawCoverUrl) {
          const coverUrl = rawCoverUrl.replace('http:', 'https:');
          
          if (DEBUG_GOOGLE_BOOKS) {
            console.log(`[DEBUG_GOOGLE_BOOKS]   imageLinks.thumbnail: ${volumeInfo.imageLinks.thumbnail ? 'YES' : 'NO'}`);
            console.log(`[DEBUG_GOOGLE_BOOKS]   imageLinks.smallThumbnail: ${volumeInfo.imageLinks.smallThumbnail ? 'YES' : 'NO'}`);
            console.log(`[DEBUG_GOOGLE_BOOKS]   Raw Cover URL: ${rawCoverUrl.substring(0, 100)}...`);
            console.log(`[DEBUG_GOOGLE_BOOKS]   Valid Cover: ${isValidBookCover(coverUrl) ? 'YES' : 'NO'}`);
          }
          
          // Validate that it's a real book cover (not placeholder/default image)
          if (isValidBookCover(coverUrl)) {
            result.coverUrl = coverUrl;
            if (DEBUG_GOOGLE_BOOKS) {
              console.log(`[DEBUG_GOOGLE_BOOKS]   ✅ Cover URL accepted: ${coverUrl.substring(0, 100)}...`);
            }
          } else {
            if (DEBUG_GOOGLE_BOOKS) {
              console.log(`[DEBUG_GOOGLE_BOOKS]   ⚠️ Skipping invalid cover URL: ${coverUrl.substring(0, 100)}...`);
            } else {
              console.log(`⚠️ Skipping invalid cover URL for "${volumeInfo.title}": ${coverUrl}`);
            }
          }
        } else {
          if (DEBUG_GOOGLE_BOOKS) {
            console.log(`[DEBUG_GOOGLE_BOOKS]   ❌ No cover URL in imageLinks`);
          }
        }
      } else {
        if (DEBUG_GOOGLE_BOOKS) {
          console.log(`[DEBUG_GOOGLE_BOOKS]   ❌ No imageLinks in volumeInfo`);
        }
      }
      
      if (DEBUG_GOOGLE_BOOKS) {
        console.log(`[DEBUG_GOOGLE_BOOKS]   Description: ${volumeInfo.description ? `YES (${volumeInfo.description.length} chars)` : 'NO'}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Categories: ${volumeInfo.categories ? `YES [${volumeInfo.categories.join(', ')}]` : 'NO'}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Result: ${result.coverUrl ? '✅ SUCCESS (has cover)' : '❌ FAILED (no cover)'}`);
        console.log(`[DEBUG_GOOGLE_BOOKS] ========================================`);
      }

      // Cache the result
      cache.set(cacheKey, result);
      return result;
    } catch (error: any) {
      // Handle network errors more gracefully - don't log as errors, just return empty
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('Network request failed') || 
          errorMessage.includes('fetch failed') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('AbortError')) {
        // Silently handle network/timeout errors - they're expected in poor network conditions
        // Only log in development mode
        if (isDev) {
          console.warn(`Network/timeout error fetching book by ID ${googleBooksId}:`, errorMessage);
        }
      } else {
        // Only log unexpected errors
        console.error(`Error fetching book by ID ${googleBooksId}:`, error);
      }
      return {};
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Direct search function (bypasses queue, used by queue processor)
 * This is the actual implementation that makes the API call
 */
async function searchBookDirect(
  title: string,
  author?: string,
  googleBooksId?: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  // If we have googleBooksId, use that (much more efficient - no search needed)
  if (googleBooksId) {
    return fetchByGoogleBooksId(googleBooksId, retryCount);
  }

  // Otherwise, search by title/author (use the existing searchBook function)
  return searchBook(title, author, retryCount);
}

/**
 * Search for book by title and author
 */
async function searchBook(
  title: string,
  author?: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  // Normalize for cache key (aggressive caching)
  const normalizedTitle = norm(title);
  const normalizedAuthor = author ? norm(author) : '';
  const cacheKey = `search:${normalizedTitle}|${normalizedAuthor}`;
  
  // Check cache first (aggressive caching - huge win)
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    // Cache for single book search should always be a single object, not array
    if (!Array.isArray(cached) && cached) {
      log('debug', `[GoogleBooks] ✅ Cache HIT for: "${title}"${author ? ` by ${author}` : ''}`);
      return cached;
    }
  }

  // Check if there's already a pending request for this search
  if (pendingRequests.has(cacheKey)) {
    const pending = await pendingRequests.get(cacheKey)!;
    // Pending request for single book search should always be a single object, not array
    if (!Array.isArray(pending)) {
      return pending;
    }
  }
  
  // Try multiple query strategies for better matching
  // Strategy 1: Exact title with quotes, author with quotes (most precise)
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  const cleanAuthor = author ? author.replace(/[^\w\s]/g, '').trim() : '';
  let query = author 
    ? `intitle:"${cleanTitle}" inauthor:"${cleanAuthor}"` 
    : `intitle:"${cleanTitle}"`;
  
  // Log the query being used (for debugging)
  log('debug', `[GoogleBooks] Searching: "${query}" (title: "${title}", author: "${author || 'none'}")`);

  const requestPromise = (async () => {
    try {
      await waitForRateLimit();

      // Add timeout to prevent hanging requests (8 second timeout)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      // Add fields parameter to limit payload to only needed fields
      // Add projection=full to improve chances of getting description/categories
      const fields = 'items(id,volumeInfo(title,authors,pageCount,categories,publisher,publishedDate,language,averageRating,ratingsCount,subtitle,printType,description,imageLinks))';
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&fields=${encodeURIComponent(fields)}&projection=full`; // Get multiple candidates for scoring

      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          // Let queue retry once, then fail gracefully
          if (retryCount < 1) {
            throw new Error('Request timeout - retrying...');
          }
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      // Handle rate limiting (429) - throw error so queue can handle it
      if (response.status === 429) {
        const error: any = new Error(`Google Books 429: Rate limited`);
        error.status = 429;
        error.statusCode = 429;
        throw error; // Let queue handle retry logic
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return {};
      }

      const data = await response.json() as GoogleBooksResponse;

      // Enhanced DEBUG_GOOGLE_BOOKS logging
      const DEBUG_GOOGLE_BOOKS = process.env.DEBUG_GOOGLE_BOOKS === 'true' || isDev;
      
      if (DEBUG_GOOGLE_BOOKS) {
        console.log(`[DEBUG_GOOGLE_BOOKS] ========================================`);
        console.log(`[DEBUG_GOOGLE_BOOKS] Search Request:`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Title: "${title}"`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Author: "${author || 'none'}"`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Query: "${query}"`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Full URL: ${url}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Response Status: ${response.status} ${response.statusText}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Total Items: ${data.totalItems || 0}`);
        console.log(`[DEBUG_GOOGLE_BOOKS]   Items Returned: ${data.items?.length || 0}`);
      }

      if (data.items?.length) {
        // Pick best volume using improved scoring (no hard cover requirement)
        // This function includes detailed debug logging for top 3 candidates
        const picked = pickBestVolume(data.items, title, author);
        
        if (DEBUG_GOOGLE_BOOKS) {
          console.log(`[DEBUG_GOOGLE_BOOKS] ========================================`);
        }

        if (picked) {
          const volumeInfo = picked.volumeInfo || {};
          
          log('debug', `[GoogleBooks] ✅ Picked best match: "${volumeInfo.title}" by ${volumeInfo.authors?.[0] || 'unknown'} (ID: ${picked.id})`);

          // Extract cover URL - only set if valid
          let coverUrl: string | undefined = undefined;
          if (volumeInfo.imageLinks) {
            const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
            if (rawCoverUrl) {
              const normalizedCoverUrl = rawCoverUrl.replace('http:', 'https:');
              // Only set coverUrl if it passes validation
              if (isValidBookCover(normalizedCoverUrl)) {
                coverUrl = normalizedCoverUrl;
              } else if (DEBUG_GOOGLE_BOOKS) {
                console.log(`[DEBUG_GOOGLE_BOOKS] ⚠️ Cover URL failed validation: ${normalizedCoverUrl.substring(0, 100)}...`);
              }
            }
          }

          // Extract all data from the best volume
          const result: GoogleBooksData = {
            googleBooksId: picked.id,
            coverUrl, // Only set if valid, otherwise undefined
            pageCount: volumeInfo.pageCount,
            categories: volumeInfo.categories,
            publisher: volumeInfo.publisher,
            publishedDate: volumeInfo.publishedDate,
            language: volumeInfo.language,
            averageRating: volumeInfo.averageRating,
            ratingsCount: volumeInfo.ratingsCount,
            subtitle: volumeInfo.subtitle,
            printType: volumeInfo.printType,
            description: volumeInfo.description,
          };

          // Cache the result (aggressive caching - normalize for cache key)
          const normalizedTitle = norm(title);
          const normalizedAuthor = author ? norm(author) : '';
          const normalizedCacheKey = `search:${normalizedTitle}|${normalizedAuthor}`;
          cache.set(normalizedCacheKey, result);
          cache.set(cacheKey, result); // Also cache with original query
          // Also cache by ID for future lookups
          if (picked.id) {
            cache.set(`id:${picked.id}`, result);
          }
          return result;
        }

        // Fallback: if pickBestVolume returned null (shouldn't happen if items.length > 0)
        log('debug', `[GoogleBooks] ⚠️ No volume selected, returning top result`);
        const topBook = data.items[0];
        const topVolumeInfo = topBook.volumeInfo || {};
        
        // Extract cover URL if valid
        let coverUrl: string | undefined = undefined;
        if (topVolumeInfo.imageLinks) {
          const rawCoverUrl = topVolumeInfo.imageLinks.thumbnail || topVolumeInfo.imageLinks.smallThumbnail;
          if (rawCoverUrl) {
            const normalizedCoverUrl = rawCoverUrl.replace('http:', 'https:');
            if (isValidBookCover(normalizedCoverUrl)) {
              coverUrl = normalizedCoverUrl;
            }
          }
        }
        
        return {
          googleBooksId: topBook.id,
          coverUrl,
          pageCount: topVolumeInfo.pageCount,
          categories: topVolumeInfo.categories,
          publisher: topVolumeInfo.publisher,
          publishedDate: topVolumeInfo.publishedDate,
          language: topVolumeInfo.language,
          averageRating: topVolumeInfo.averageRating,
          ratingsCount: topVolumeInfo.ratingsCount,
          subtitle: topVolumeInfo.subtitle,
          printType: topVolumeInfo.printType,
          description: topVolumeInfo.description,
        };
      }

      // No results found - log for debugging
      console.log(`[GB] ❌ No results for query: "${query}"`);
      return {};
    } catch (error: any) {
      // Handle network errors more gracefully - don't log as errors, just return empty
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('Network request failed') || 
          errorMessage.includes('fetch failed') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('AbortError')) {
        // Silently handle network/timeout errors - they're expected in poor network conditions
        // Only log in development mode
        if (isDev) {
          console.warn(`Network/timeout error searching for book "${title}":`, errorMessage);
        }
      } else {
        // Only log unexpected errors (but not 429s - those are handled by queue)
        if (error?.status !== 429 && error?.statusCode !== 429) {
          log('error', `Error searching for book "${title}":`, error);
        }
      }
      return {};
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Main function to fetch book data
 * 
 * If googleBooksId is provided, uses that (most efficient).
 * Otherwise, searches by title/author.
 * 
 * @param title - Book title
 * @param author - Book author (optional)
 * @param googleBooksId - Google Books ID if already known (optional, but preferred)
 */
export async function fetchBookData(
  title: string,
  author?: string,
  googleBooksId?: string
): Promise<GoogleBooksData> {
  // Normalize for cache key (aggressive caching)
  const normalizedTitle = norm(title);
  const normalizedAuthor = author ? norm(author) : '';
  const cacheKey = googleBooksId 
    ? `id:${googleBooksId}` 
    : `search:${normalizedTitle}|${normalizedAuthor}`;
  
  // Check cache first (aggressive caching - huge win, reduces API calls by 80-90%)
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (!Array.isArray(cached) && cached) {
      if (isDev) {
        console.log(`[GoogleBooks] ✅ Cache HIT for: "${title}"${author ? ` by ${author}` : ''}`);
      }
      return cached;
    }
  }
  
  // If we have googleBooksId, use that directly (no queue needed, already cached if available)
  if (googleBooksId) {
    const result = await fetchByGoogleBooksId(googleBooksId);
    // Cache the result
    if (result && result.googleBooksId) {
      cache.set(cacheKey, result);
      cache.set(`id:${result.googleBooksId}`, result);
    }
    return result;
  }

  // Queue the search request (single-flight execution, prevents 429 bursts)
  const result = await queueGoogleBooksRequest(title, author, undefined, 0);
  
  // Cache the result (aggressive caching)
  if (result && (result.googleBooksId || result.coverUrl)) {
    cache.set(cacheKey, result);
    if (result.googleBooksId) {
      cache.set(`id:${result.googleBooksId}`, result);
    }
  }
  
  return result;
}

/**
 * Search for multiple books by title and author (returns up to 20 results)
 * Used for "Switch Covers" feature to show all available covers for a book
 */
export async function searchMultipleBooks(
  title: string,
  author?: string,
  maxResults: number = 20
): Promise<GoogleBooksData[]> {
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  const query = author ? `${cleanTitle} ${author}` : cleanTitle;
  const cacheKey = `searchMultiple:${query}:${maxResults}`;

  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    // If cached result is an array, return it
    if (Array.isArray(cached)) {
      return cached;
    }
  }

  // Check if there's already a pending request for this search
  if (pendingRequests.has(cacheKey)) {
    const pending = await pendingRequests.get(cacheKey)!;
    // If pending result is an array, return it
    if (Array.isArray(pending)) {
      return pending;
    }
  }

  const requestPromise = (async () => {
    try {
      await waitForRateLimit();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout for multiple results

      let response: Response;
      try {
        response = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json() as GoogleBooksResponse;

      if (data.items && data.items.length > 0) {
        const results: GoogleBooksData[] = data.items.map((book: GoogleBooksVolume) => {
          const volumeInfo = book.volumeInfo;

          const result: GoogleBooksData = {
            googleBooksId: book.id,
            pageCount: volumeInfo.pageCount,
            categories: volumeInfo.categories,
            publisher: volumeInfo.publisher,
            publishedDate: volumeInfo.publishedDate,
            language: volumeInfo.language,
            averageRating: volumeInfo.averageRating,
            ratingsCount: volumeInfo.ratingsCount,
            subtitle: volumeInfo.subtitle,
            printType: volumeInfo.printType,
            description: volumeInfo.description,
          };

          // Extract cover URL - only use if it's a valid book cover (not placeholder)
          if (volumeInfo.imageLinks) {
            const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
            if (rawCoverUrl) {
              const coverUrl = rawCoverUrl.replace('http:', 'https:');
              // Validate that it's a real book cover (not placeholder/default image)
              if (isValidBookCover(coverUrl)) {
                result.coverUrl = coverUrl;
              } else {
                console.log(`⚠️ Skipping invalid cover URL for "${volumeInfo.title}": ${coverUrl}`);
              }
            }
          }

          return result;
        });

        // Cache the results as an array (cast to satisfy cache type)
        cache.set(cacheKey, results as any);
        return results;
      }

      return [];
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('Network request failed') || 
          errorMessage.includes('fetch failed') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('AbortError')) {
        if (isDev) {
          console.warn(`Network/timeout error searching for multiple books "${title}":`, errorMessage);
        }
      } else {
        console.error(`Error searching for multiple books "${title}":`, error);
      }
      return [];
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Search for books by query string (for "Switch Book" feature)
 * Returns up to 20 results with title, author, and cover
 */
export async function searchBooksByQuery(
  query: string,
  maxResults: number = 20
): Promise<Array<{
  googleBooksId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  subtitle?: string;
  publishedDate?: string;
}>> {
  const cacheKey = `searchQuery:${query}:${maxResults}`;

  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Array.isArray(cached)) {
      // Cast to return type - cached results have title property (from searchBooksByQuery)
      return cached as Array<{
        googleBooksId: string;
        title: string;
        author?: string;
        coverUrl?: string;
        subtitle?: string;
        publishedDate?: string;
      }>;
    }
  }

  // Check if there's already a pending request
  if (pendingRequests.has(cacheKey)) {
    const pending = await pendingRequests.get(cacheKey)!;
    if (Array.isArray(pending)) {
      // Cast to return type - pending results have title property (from searchBooksByQuery)
      return pending as Array<{
        googleBooksId: string;
        title: string;
        author?: string;
        coverUrl?: string;
        subtitle?: string;
        publishedDate?: string;
      }>;
    }
  }

  const requestPromise = (async () => {
    try {
      await waitForRateLimit();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let response: Response;
      try {
        response = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json() as GoogleBooksResponse;

      if (data.items && data.items.length > 0) {
        const results = data.items.map((book: GoogleBooksVolume) => {
          const volumeInfo = book.volumeInfo;
          return {
            googleBooksId: book.id,
            title: volumeInfo.title || 'Unknown Title',
            author: volumeInfo.authors?.[0] || undefined,
            coverUrl: (() => {
              const rawUrl = volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:') || 
                           volumeInfo.imageLinks?.smallThumbnail?.replace('http:', 'https:');
              return rawUrl && isValidBookCover(rawUrl) ? rawUrl : undefined;
            })(),
            subtitle: volumeInfo.subtitle,
            publishedDate: volumeInfo.publishedDate,
          };
        });

        // Cache the results (cast to satisfy cache type which expects GoogleBooksData | GoogleBooksData[])
        cache.set(cacheKey, results as any);
        return results;
      }

      return [];
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('Network request failed') || 
          errorMessage.includes('fetch failed') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('AbortError')) {
        if (isDev) {
          console.warn(`Network/timeout error searching books by query "${query}":`, errorMessage);
        }
      } else {
        console.error(`Error searching books by query "${query}":`, error);
      }
      return [];
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Clear the cache (useful for testing or memory management)
 */
export function clearCache(): void {
  cache.clear();
  pendingRequests.clear();
}

/**
 * Get cache size (for debugging)
 */
export function getCacheSize(): number {
  return cache.size;
}

