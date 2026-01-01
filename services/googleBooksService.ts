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

// In-memory cache to avoid duplicate API calls
const cache = new Map<string, GoogleBooksData>();
const pendingRequests = new Map<string, Promise<GoogleBooksData>>();

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
 * Fetch book data by Google Books ID (most efficient)
 */
async function fetchByGoogleBooksId(
  googleBooksId: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  const cacheKey = `id:${googleBooksId}`;
  
  // Check cache first
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  // Check if there's already a pending request for this ID
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
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

      const data = await response.json();
      const volumeInfo = data.volumeInfo || {};

      // Extract all data
      const result: GoogleBooksData = {
        googleBooksId: data.id,
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

      // Extract cover URL
      if (volumeInfo.imageLinks) {
        const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
        result.coverUrl = rawCoverUrl?.replace('http:', 'https:');
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
        if (__DEV__) {
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
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  const query = author ? `${cleanTitle} ${author}` : cleanTitle;
  const cacheKey = `search:${query}`;

  // Check cache first
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  // Check if there's already a pending request for this search
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
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
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`,
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

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        const book = data.items[0];
        const volumeInfo = book.volumeInfo;

        // Extract all data
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

        // Extract cover URL
        if (volumeInfo.imageLinks) {
          const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
          result.coverUrl = rawCoverUrl?.replace('http:', 'https:');
        }

        // Cache the result
        cache.set(cacheKey, result);
        // Also cache by ID for future lookups
        if (book.id) {
          cache.set(`id:${book.id}`, result);
        }
        return result;
      }

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
        if (__DEV__) {
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

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        const results: GoogleBooksData[] = data.items.map((book: any) => {
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

          // Extract cover URL
          if (volumeInfo.imageLinks) {
            const rawCoverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
            result.coverUrl = rawCoverUrl?.replace('http:', 'https:');
          }

          return result;
        });

        // Cache the results as an array
        cache.set(cacheKey, results);
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
        if (__DEV__) {
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
      return cached;
    }
  }

  // Check if there's already a pending request
  if (pendingRequests.has(cacheKey)) {
    const pending = await pendingRequests.get(cacheKey)!;
    if (Array.isArray(pending)) {
      return pending;
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

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        const results = data.items.map((book: any) => {
          const volumeInfo = book.volumeInfo;
          return {
            googleBooksId: book.id,
            title: volumeInfo.title || 'Unknown Title',
            author: volumeInfo.authors?.[0] || undefined,
            coverUrl: volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:') || 
                     volumeInfo.imageLinks?.smallThumbnail?.replace('http:', 'https:') || 
                     undefined,
            subtitle: volumeInfo.subtitle,
            publishedDate: volumeInfo.publishedDate,
          };
        });

        // Cache the results
        cache.set(cacheKey, results);
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
        if (__DEV__) {
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

