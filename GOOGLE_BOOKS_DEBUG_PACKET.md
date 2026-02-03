# Google Books Debug Packet

## 1. Request Builders

### Search Request Builder
**File:** `services/googleBooksService.ts`  
**Function:** `searchBook()` lines 538-718

```typescript
// Query construction
const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
let query = author ? `intitle:"${cleanTitle}" ${author}` : `intitle:"${cleanTitle}"`;

// Full URL with fields parameter (limits payload size)
const fields = 'items(id,volumeInfo(title,authors,pageCount,categories,publisher,publishedDate,language,averageRating,ratingsCount,subtitle,printType,description,imageLinks))';
const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&fields=${encodeURIComponent(fields)}`;

// Example URLs:
// Title only: https://www.googleapis.com/books/v1/volumes?q=intitle:"The Great Gatsby"&maxResults=10&fields=items(id,volumeInfo(...))
// Title + Author: https://www.googleapis.com/books/v1/volumes?q=intitle:"The Great Gatsby" F. Scott Fitzgerald&maxResults=10&fields=items(id,volumeInfo(...))
```

### By ID Request Builder
**File:** `services/googleBooksService.ts`  
**Function:** `fetchByGoogleBooksId()` lines 390-514

```typescript
// Direct volume lookup (most efficient)
const url = `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`;

// Example URL:
// https://www.googleapis.com/books/v1/volumes/abc123xyz
// No query params needed - direct ID lookup
```

---

## 2. Core Functions

### fetchBookData (Main Entry Point)
**File:** `services/googleBooksService.ts` lines 730-776

```typescript
export async function fetchBookData(
  title: string,
  author?: string,
  googleBooksId?: string
): Promise<GoogleBooksData> {
  // Cache key generation
  const normalizedTitle = norm(title);
  const normalizedAuthor = author ? norm(author) : '';
  const cacheKey = googleBooksId 
    ? `id:${googleBooksId}` 
    : `search:${normalizedTitle}|${normalizedAuthor}`;
  
  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (!Array.isArray(cached) && cached) {
      return cached; // Cache hit
    }
  }
  
  // If googleBooksId provided, use direct lookup (fastest)
  if (googleBooksId) {
    return await fetchByGoogleBooksId(googleBooksId);
  }
  
  // Otherwise, queue search request
  return await queueGoogleBooksRequest(title, author, undefined, 0);
}
```

### searchBook (Search Implementation)
**File:** `services/googleBooksService.ts` lines 538-718

```typescript
async function searchBook(
  title: string,
  author?: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  // Cache key: normalized title|author
  const normalizedTitle = norm(title);
  const normalizedAuthor = author ? norm(author) : '';
  const cacheKey = `search:${normalizedTitle}|${normalizedAuthor}`;
  
  // Check cache
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (!Array.isArray(cached) && cached) {
      return cached;
    }
  }
  
  // Build query
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  let query = author ? `intitle:"${cleanTitle}" ${author}` : `intitle:"${cleanTitle}"`;
  
  // Build URL with fields parameter
  const fields = 'items(id,volumeInfo(title,authors,pageCount,categories,publisher,publishedDate,language,averageRating,ratingsCount,subtitle,printType,description,imageLinks))';
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&fields=${encodeURIComponent(fields)}`;
  
  // Make request
  const response = await fetch(url, { signal: controller.signal });
  
  // Parse response
  const data = await response.json() as GoogleBooksResponse;
  
  // Pick best match with cover
  if (data.items?.length) {
    const picked = pickBestBookWithCover(data.items, title, author);
    // Extract and return data...
  }
  
  return {};
}
```

### fetchByGoogleBooksId (Direct Lookup)
**File:** `services/googleBooksService.ts` lines 390-514

```typescript
async function fetchByGoogleBooksId(
  googleBooksId: string,
  retryCount = 0
): Promise<GoogleBooksData> {
  const cacheKey = `id:${googleBooksId}`;
  
  // Check cache
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (!Array.isArray(cached) && cached) {
      return cached;
    }
  }
  
  // Direct volume lookup
  const url = `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`;
  const response = await fetch(url, { signal: controller.signal });
  
  // Parse single volume response
  const data = await response.json() as GoogleBooksVolumeResponse;
  const volumeInfo = data.volumeInfo || {};
  
  // Extract all data
  const result: GoogleBooksData = {
    googleBooksId: data.id,
    coverUrl: /* extracted from imageLinks */,
    description: volumeInfo.description,
    categories: volumeInfo.categories,
    // ... other fields
  };
  
  // Cache result
  cache.set(cacheKey, result);
  return result;
}
```

---

## 3. pickBestBookWithCover Implementation

**File:** `services/googleBooksService.ts` lines 291-327

```typescript
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

    // Calculate title similarity (0..1)
    const titleScore = tokenOverlapScore(inputTitle, title);
    
    // Calculate author similarity (0..1)
    const authorScore = inputAuthor
      ? Math.max(0, ...authors.map(a => tokenOverlapScore(inputAuthor, a)))
      : 0;

    // Extract cover URL
    const links = v.imageLinks || {};
    const raw = links.thumbnail || links.smallThumbnail;
    const coverUrl = raw ? raw.replace("http:", "https:") : "";

    // CRITICAL: Require a valid cover to win
    if (!coverUrl || !isValidBookCover(coverUrl)) continue;

    // Weighted score (title 75%, author 25%)
    const score = (titleScore * 0.75) + (authorScore * 0.25);

    // Keep best match
    if (!best || score > best.score) {
      best = { id: book.id, coverUrl, score };
    }
  }

  return best ? { googleBooksId: best.id, coverUrl: best.coverUrl } : {};
}
```

**Scoring Logic:**
- `titleScore`: Token overlap between input title and result title (0..1)
- `authorScore`: Best token overlap between input author and any result author (0..1)
- `finalScore = (titleScore * 0.75) + (authorScore * 0.25)`
- **Requirement:** Must have valid cover URL to be considered

---

## 4. Mapping/Extraction Code

### Cover URL Extraction
**File:** `services/googleBooksService.ts` lines 472-484 (fetchByGoogleBooksId) and 311-313 (pickBestBookWithCover)

```typescript
// From volumeInfo.imageLinks
const links = volumeInfo.imageLinks || {};
const rawCoverUrl = links.thumbnail || links.smallThumbnail;

// Convert HTTP to HTTPS (iOS ATS requirement)
const coverUrl = rawCoverUrl ? rawCoverUrl.replace('http:', 'https:') : '';

// Validate it's a real cover (not placeholder)
if (coverUrl && isValidBookCover(coverUrl)) {
  result.coverUrl = coverUrl;
}
```

### Description Extraction
**File:** `services/googleBooksService.ts` lines 469, 653

```typescript
description: volumeInfo.description || undefined
```

### Categories Extraction
**File:** `services/googleBooksService.ts` lines 461, 645

```typescript
categories: volumeInfo.categories || undefined
// categories is an array of strings, e.g., ["Fiction", "Science Fiction"]
```

### Full Data Mapping
**File:** `services/googleBooksService.ts` lines 458-470, 641-654

```typescript
const result: GoogleBooksData = {
  googleBooksId: data.id || undefined,
  coverUrl: /* extracted and validated */,
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
```

---

## 5. Caching + Negative Cache Logic

**File:** `services/googleBooksService.ts` lines 66-68, 131-139, 543-556, 656-665

### Cache Structure
```typescript
// In-memory cache (Map)
const cache = new Map<string, GoogleBooksData | GoogleBooksData[]>();

// Cache keys:
// - `id:${googleBooksId}` - Direct ID lookup
// - `search:${normalizedTitle}|${normalizedAuthor}` - Search result
```

### Cache Check Flow
```typescript
// 1. Generate cache key
const normalizedTitle = norm(title); // lowercase, remove punctuation
const normalizedAuthor = author ? norm(author) : '';
const cacheKey = googleBooksId 
  ? `id:${googleBooksId}` 
  : `search:${normalizedTitle}|${normalizedAuthor}`;

// 2. Check cache
if (cache.has(cacheKey)) {
  const cached = cache.get(cacheKey);
  if (!Array.isArray(cached) && cached) {
    return cached; // Cache hit - return immediately
  }
}

// 3. Check pending requests (deduplication)
if (pendingRequests.has(cacheKey)) {
  return await pendingRequests.get(cacheKey)!; // Wait for in-flight request
}

// 4. Make request and cache result
const result = await fetch(...);
cache.set(cacheKey, result);
if (result.googleBooksId) {
  cache.set(`id:${result.googleBooksId}`, result); // Also cache by ID
}
```

### Negative Cache (No Results)
**Current Implementation:** Returns empty object `{}` for no results, but doesn't explicitly cache negative results.

**Note:** The cache stores successful results only. Empty results are not cached (would need negative cache TTL logic).

---

## 6. Enhanced Debug Logging

Adding `DEBUG_GOOGLE_BOOKS` logs that print:
- Full URL
- Response status
- Top 2 items with imageLinks/description/categories presence
- Selected item + scoring reason

