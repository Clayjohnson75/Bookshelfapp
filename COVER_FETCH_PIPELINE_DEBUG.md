# Cover Fetching Pipeline - Debug Summary

## 1. Entry Point After Scan Completes

### File: `tabs/ScansTab.tsx`
### Location: Line 2154-2159

After a scan completes and books are added to `pendingBooks`, the cover fetching is triggered:

```typescript
// Fetch covers for books immediately (don't wait for this)
// Start fetching right away for faster cover loading
console.log('🖼️ Fetching covers for', newPendingBooks.length, 'books');
fetchCoversForBooks(newPendingBooks).catch(error => {
  console.error('❌ Error fetching covers:', error);
});
```

**Context**: This is called in `processImage()` after:
- Books are validated and added to `pendingBooks` state (line 2124-2145)
- Photos are saved to state (line 2087-2148)
- Books are saved to AsyncStorage/Supabase

**Note**: The server-side API (`api/scan.ts`) also attempts background cover fetching (line 1704-1753), but this is **fire-and-forget** and doesn't block the response. The client-side fetch is the primary mechanism.

---

## 2. Cover Fetch Queue + Concurrency Behavior

### File: `tabs/ScansTab.tsx`
### Location: Line 1373-1505

**Function**: `fetchCoversForBooks(books: Book[])`

**Concurrency**: **SEQUENTIAL (one at a time)**
- Processes books one by one in a `for` loop (line 1396)
- **800ms delay** between each book (line 1496-1500)
- No parallel processing - prevents rate limits

```typescript
// Process books ONE AT A TIME (sequentially) to prevent rate limits and allow incremental loading
// This ensures covers load one by one and the UI updates as each cover arrives
for (const book of booksNeedingCovers) {
  try {
    // ... fetch cover for this book ...
    
    // Small delay between books to respect rate limits (800ms between each book)
    // This prevents 429 errors and allows UI to update incrementally
    if (booksNeedingCovers.indexOf(book) < booksNeedingCovers.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } catch (error) {
    // Continue to next book even if this one fails
  }
}
```

**Filtering Logic** (line 1378-1390):
- Skips books that already have `coverUrl` + `googleBooksId` + `localCoverPath`
- Skips books that already have `description` + `googleBooksId` + stats

---

### File: `services/googleBooksService.ts`
### Location: Line 100-218

**Google Books API Queue**: Single-flight execution with rate limiting

**Queue Structure**:
```typescript
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
const MIN_GOOGLE_BOOKS_INTERVAL_MS = 1200; // 1.2 seconds minimum between requests
const MAX_GOOGLE_BOOKS_RETRIES = 2;
```

**Queue Processing** (`processGoogleBooksQueue`, line 140-218):
- **Single-flight**: Only one request processed at a time (`googleBooksProcessing` flag)
- **Minimum interval**: 1.2 seconds between requests (line 152-156)
- **400ms spacing** after successful requests (line 166)
- **Exponential backoff** on 429 errors: 2s → 4s → 8s (capped at 30s) (line 178)
- **Retry-After header support** (line 173-175)
- Re-queues failed requests instead of failing immediately (line 191-198)

**Queue Entry Point** (`queueGoogleBooksRequest`, line 223-240):
- Wraps all Google Books API calls
- Adds requests to queue and triggers processing

---

## 3. Google Books API Call + Fields Used

### File: `services/googleBooksService.ts`
### Location: Line 240-500

**Main Function**: `fetchBookData(title: string, author?: string, googleBooksId?: string)`

**Strategy** (line 240-280):
1. **If `googleBooksId` provided**: Direct lookup via `fetchByGoogleBooksId()` (fastest)
2. **Otherwise**: Search via `searchBook()` with multiple fallback strategies

**Direct Lookup** (`fetchByGoogleBooksId`, line 400-450):
```typescript
const url = `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`;
const response = await fetch(url);
const data = await response.json() as GoogleBooksVolumeResponse;
```

**Search Strategy** (`searchBook`, line 500-650):
1. Try: `intitle:"cleanTitle" author:"author"` (line 520)
2. Fallback: `intitle:"cleanTitle"` (line 530)
3. Fallback: `searchMultipleBooks()` with broader query (line 540)

**API Endpoint**:
```
GET https://www.googleapis.com/books/v1/volumes?q={query}&maxResults=10
```

**Fields Extracted** (line 300-380):
```typescript
interface GoogleBooksData {
  coverUrl?: string;           // From imageLinks.thumbnail (HTTPS converted)
  googleBooksId?: string;     // From volume.id
  pageCount?: number;          // From volumeInfo.pageCount
  categories?: string[];        // From volumeInfo.categories
  publisher?: string;          // From volumeInfo.publisher
  publishedDate?: string;      // From volumeInfo.publishedDate
  language?: string;          // From volumeInfo.language
  averageRating?: number;      // From volumeInfo.averageRating
  ratingsCount?: number;       // From volumeInfo.ratingsCount
  subtitle?: string;           // From volumeInfo.subtitle
  printType?: string;          // From volumeInfo.printType
  description?: string;        // From volumeInfo.description
}
```

**Cover URL Processing** (line 320-340):
- Extracts from `volumeInfo.imageLinks.thumbnail` or `smallThumbnail`
- Converts HTTP → HTTPS (iOS ATS requirement)
- Validates URL format
- Uses `pickBestBookWithCover()` to select best match from multiple results (line 550-600)

**Caching** (line 250-280):
- In-memory cache by `normalizedTitle|normalizedAuthor` or `googleBooksId`
- 7-day cache for successful lookups
- 24-hour negative cache for "no match" results

---

## 4. Where Cover URL is Stored in State

### File: `tabs/ScansTab.tsx`
### Location: Line 1443-1471

**State Updates** (after cover is fetched):

1. **`pendingBooks` state** (line 1444-1450):
```typescript
setPendingBooks(prev => 
  prev.map(pendingBook => 
    pendingBook.id === book.id 
      ? { ...pendingBook, ...updatedBook }  // updatedBook contains coverUrl, googleBooksId, etc.
      : pendingBook
  )
);
```

2. **`photos` state** (line 1453-1462):
```typescript
setPhotos(prev =>
  prev.map(photo => ({
    ...photo,
    books: photo.books.map(photoBook =>
      photoBook.id === book.id
        ? { ...photoBook, ...updatedBook }  // Update book in photo's books array
        : photoBook
    )
  }))
);
```

3. **`approvedBooks` state** (line 1465-1471):
```typescript
setApprovedBooks(prev =>
  prev.map(approvedBook =>
    approvedBook.id === book.id
      ? { ...approvedBook, ...updatedBook }
      : approvedBook
  )
);
```

**`updatedBook` Object** (line 1426-1441):
```typescript
const updatedBook = {
  coverUrl: bookData.coverUrl,                    // Primary cover URL
  googleBooksId: bookData.googleBooksId,         // Google Books ID
  ...(localPath && { localCoverPath: localPath }), // Local cached path
  // Plus all stats fields (pageCount, publisher, description, etc.)
};
```

**Persistence** (line 1473-1489):
- Saved to Supabase immediately via `saveBookToSupabase()` (non-blocking)
- Saved to AsyncStorage via `saveUserData()` (called in `setPendingBooks` callback)

---

## 5. UI Component That Renders Covers

### File: `tabs/ScansTab.tsx`
### Location: Line 3725-3749

**Cover URI Resolution** (`getBookCoverUri`, line 1304-1320):
```typescript
const getBookCoverUri = (book: Book): string | undefined => {
  // Validate coverUrl (must be http:// or https://)
  if (book.coverUrl) {
    const url = book.coverUrl.trim();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return undefined; // Invalid URL format
  }
  
  // Fall back to local path
  if (book.localCoverPath && FileSystem.documentDirectory) {
    return `${FileSystem.documentDirectory}${book.localCoverPath}`;
  }
  
  return undefined; // No cover available
};
```

**Rendering** (line 3725-3749):
```typescript
const coverUri = getBookCoverUri(book);

{coverUri ? (
  <Image 
    source={{ uri: coverUri }} 
    style={styles.bookCover}
  />
) : (
  <View style={[styles.bookCover, styles.placeholderCover]}>
    <Text style={styles.placeholderText} numberOfLines={3}>
      {book.title}
    </Text>
  </View>
)}
```

**Component Context**: 
- Rendered in "Pending Books" section (line 3678-3766)
- Each book card shows cover or placeholder
- Updates reactively when `pendingBooks` state changes (React state update triggers re-render)

**Other Render Locations**:
- `MyLibraryTab.tsx` (line 613-637): Similar `getBookCoverUri` + conditional rendering
- `BookDetailModal.tsx`: Cover display in book detail view
- Scan modal: Books from photos also use `getBookCoverUri`

---

## Summary Flow Diagram

```
Scan Completes (processImage)
    ↓
setPendingBooks(newPendingBooks)
    ↓
fetchCoversForBooks(newPendingBooks) [ASYNC, non-blocking]
    ↓
For each book (SEQUENTIAL, 800ms delay):
    ↓
    fetchBookData(title, author, googleBooksId)
        ↓
        queueGoogleBooksRequest() → Google Books Queue
            ↓
            processGoogleBooksQueue() [Single-flight, 1.2s interval]
                ↓
                searchBookDirect() or fetchByGoogleBooksId()
                    ↓
                    GET https://www.googleapis.com/books/v1/volumes?q=...
                    ↓
                    Extract: coverUrl, googleBooksId, stats
                    ↓
                    Return GoogleBooksData
        ↓
    downloadAndCacheCover(coverUrl, googleBooksId) [Local cache]
        ↓
    setPendingBooks(prev => map with updatedBook) [State update]
    setPhotos(prev => map with updatedBook) [State update]
    setApprovedBooks(prev => map with updatedBook) [State update]
        ↓
    saveBookToSupabase() [Persistence, async]
        ↓
    UI Re-renders (React state change)
        ↓
    getBookCoverUri(book) → Returns coverUrl or localPath
        ↓
    <Image source={{ uri: coverUri }} /> or <View placeholder />
```

---

## Key Configuration Values

- **Client-side delay**: 800ms between books
- **Queue minimum interval**: 1200ms (1.2 seconds)
- **Queue spacing**: 400ms after successful requests
- **Max retries**: 2 attempts
- **Backoff**: 2s → 4s → 8s (capped at 30s)
- **Cache duration**: 7 days (success), 24 hours (no match)
- **Max search results**: 10 candidates per query

