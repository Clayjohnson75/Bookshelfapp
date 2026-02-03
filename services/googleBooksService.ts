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

// Rate limiting: queue requests with delays
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1 second between requests

/**
 * Wait for rate limit cooldown
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
 * Pick the best matching book from Google Books results that has a valid cover
 */
function pickBestBookWithCover(
  items: any[],
  inputTitle: string,
  inputAuthor?: string
): { googleBooksId?: string; coverUrl?: string } {
  let best: { id?: string; coverUrl?: string; score: number } | null = null;

  for (const book of items || []) {
    const v = book.volumeInfo || {};
    const title = v.title || "";
    const authors: string[] = v.authors || [];

    const titleScore = tokenOverlapScore(inputTitle, title); // 0..1
    const authorScore = inputAuthor
      ? Math.max(0, ...authors.map(a => tokenOverlapScore(inputAuthor, a)))
      : 0;

    const links = v.imageLinks || {};
    const raw = links.thumbnail || links.smallThumbnail;
    const coverUrl = raw ? raw.replace("http:", "https:") : "";

    // Require a cover to win
    if (!coverUrl || !isValidBookCover(coverUrl)) continue;

    // Weighted score (title 75%, author 25%)
    const score = (titleScore * 0.75) + (authorScore * 0.25);

    if (!best || score > best.score) {
      best = { id: book.id, coverUrl, score };
    }
  }

  return best ? { googleBooksId: best.id, coverUrl: best.coverUrl } : {};
}

/**
 * Validate that a cover URL is actually a book cover (not a placeholder or old paper image)
 */
function isValidBookCover(coverUrl: string): boolean {
  if (!coverUrl) return false;
  
  // Must be from Google Books API
  if (!coverUrl.includes('books.google.com') && !coverUrl.includes('googleapis.com')) {
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
      
      // Add timeout to prevent hanging requests (reduced to 5 seconds to fail faster)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

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
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      // Handle rate limiting (429) with exponential backoff
      if (response.status === 429) {
        const maxRetries = 3;
        if (retryCount < maxRetries) {
          const backoffDelay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          console.warn(
            `Google Books API rate limited (429), retrying in ${backoffDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          return fetchByGoogleBooksId(googleBooksId, retryCount + 1);
        } else {
          console.warn(`Google Books API rate limited (429), max retries reached for ID: ${googleBooksId}`);
          return {};
        }
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return {};
      }

      const data = await response.json() as GoogleBooksVolumeResponse;
      const volumeInfo = data.volumeInfo || {};

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
          // Validate that it's a real book cover (not placeholder/default image)
          if (isValidBookCover(coverUrl)) {
            result.coverUrl = coverUrl;
          } else {
            console.log(`⚠️ Skipping invalid cover URL for "${volumeInfo.title}": ${coverUrl}`);
          }
        }
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
 * Search for book by title and author
 */
async function searchBook(
  title: string,
  author?: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  // Try multiple query strategies for better matching
  // Strategy 1: Exact title with quotes (most precise)
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  let query = author ? `intitle:"${cleanTitle}" ${author}` : `intitle:"${cleanTitle}"`;
  const cacheKey = `search:${query}`;
  
  // Log the query being used (for debugging)
  if (isDev) {
    console.log(`[GoogleBooks] Searching: "${query}" (title: "${title}", author: "${author || 'none'}")`);
  }

  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    // Cache for single book search should always be a single object, not array
    if (!Array.isArray(cached)) {
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

  const requestPromise = (async () => {
    try {
      await waitForRateLimit();

      // Add timeout to prevent hanging requests (reduced to 5 seconds to fail faster)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`; // Get multiple candidates for scoring
      
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('Request timeout - please check your internet connection');
        }
        throw fetchError;
      }

      // Handle rate limiting (429) with exponential backoff
      if (response.status === 429) {
        const maxRetries = 3;
        if (retryCount < maxRetries) {
          const backoffDelay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          console.warn(
            `Google Books API rate limited (429), retrying in ${backoffDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          return searchBook(title, author, retryCount + 1);
        } else {
          console.warn(`Google Books API rate limited (429), max retries reached for: ${title}`);
          return {};
        }
      }

      if (!response.ok) {
        console.warn(`Google Books API request failed: ${response.status} ${response.statusText}`);
        return {};
      }

      const data = await response.json() as GoogleBooksResponse;

      // Logging for debugging
      console.log(`[GB] query=`, url);
      console.log(`[GB] totalItems=`, data.totalItems || 0, `items=`, data.items?.length ?? 0);

      if (data.items?.length) {
        // Log top 5 candidates
        for (const [i, it] of data.items.slice(0, 5).entries()) {
          const v = it.volumeInfo || {};
          const raw = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "";
          console.log(`[GB] #${i} title="${v.title}" authors="${(v.authors||[]).join(",")}" cover=${!!raw}`);
        }

        // Pick best book with cover using scoring
        const picked = pickBestBookWithCover(data.items, title, author);

        if (picked.coverUrl && picked.googleBooksId) {
          // Get full volume info for the picked book
          const pickedBook = data.items.find(b => b.id === picked.googleBooksId) || data.items[0];
          const volumeInfo = pickedBook.volumeInfo || {};
          
          if (isDev) {
            console.log(`[GoogleBooks] ✅ Picked best match: "${volumeInfo.title}" by ${volumeInfo.authors?.[0] || 'unknown'} (ID: ${picked.googleBooksId})`);
          }

          // Extract all data
          const result: GoogleBooksData = {
            googleBooksId: picked.googleBooksId,
            coverUrl: picked.coverUrl,
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

          // Cache the result
          cache.set(cacheKey, result);
          // Also cache by ID for future lookups
          if (picked.googleBooksId) {
            cache.set(`id:${picked.googleBooksId}`, result);
          }
          return result;
        }

        // Fallback: return top item id even if no cover, for debugging/metadata
        if (isDev) {
          console.log(`[GoogleBooks] ⚠️ No book with valid cover found, returning top result without cover`);
        }
        const topBook = data.items[0];
        const topVolumeInfo = topBook.volumeInfo || {};
        return {
          googleBooksId: topBook.id,
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
        // Only log unexpected errors
        console.error(`Error searching for book "${title}":`, error);
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
  // If we have googleBooksId, use that (much more efficient - no search needed)
  if (googleBooksId) {
    return fetchByGoogleBooksId(googleBooksId);
  }

  // Otherwise, search by title/author
  return searchBook(title, author);
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

