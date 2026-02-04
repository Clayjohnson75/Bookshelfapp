# Bookshelf Scanner - Complete Technical Overview

## App Overview

**Bookshelf Scanner** is a React Native mobile application (iOS/Android) that uses AI to automatically identify and catalog books from photos of bookshelves. Users can take photos of their bookshelves, and the app uses vision AI models to detect book titles and authors from the spines, then enriches the data with book covers, descriptions, and metadata.

**Production URL**: https://www.bookshelfscan.app  
**App Store**: https://apps.apple.com/us/app/bookshelfscan/id6754891159  
**Version**: 1.0.6 (Build 48)

---

## Core Features

### 1. **Book Scanning**
- **Camera Integration**: Users can take photos directly in the app using Expo Camera
- **Photo Library**: Users can select existing photos from their device
- **AI Detection**: Uses Google Gemini 3 Flash and OpenAI GPT-4 Vision to detect books from images
- **Batch Processing**: Can detect 10-50+ books in a single scan
- **Async Job System**: Scans run as background jobs via QStash to handle long processing times

### 2. **Library Management**
- **Digital Library**: All detected books stored in Supabase database
- **Book Details**: Title, author, cover image, description, page count, categories, publisher, published date
- **Photo Gallery**: Stores original scan photos with books
- **Folders/Collections**: Organize books into custom folders
- **Search**: Full-text search across titles and authors
- **Auto-Sort**: AI-powered book organization suggestions

### 3. **Book Enrichment**
- **Google Books API**: Fetches book covers, descriptions, metadata
- **Cover Fetching**: Parallel cover downloads with concurrency limits (5 concurrent)
- **Caching**: Server-side Supabase cache + in-memory cache to reduce API calls
- **Resilient API**: Never crashes on cover fetch failures, always returns gracefully

### 4. **User Authentication**
- **Email/Password**: Custom auth system built on Supabase
- **Username System**: Unique usernames for public profiles
- **Guest Mode**: Users can scan without signing in (limited features)
- **Password Reset**: Email-based password reset via Resend
- **Email Confirmation**: Optional email verification

### 5. **Subscriptions** (Currently Free for All)
- **Pro Features**: Unlimited scans, advanced features (currently enabled for everyone)
- **Apple IAP**: In-app purchase integration via react-native-iap
- **Subscription Management**: Tracks subscription status in Supabase
- **Receipt Validation**: Server-side Apple receipt validation

### 6. **Public Profiles**
- **Username URLs**: Public profile pages at `/profile/:username`
- **Shareable Libraries**: Users can share their book collections
- **Profile Customization**: Avatar generation, bio editing

### 7. **Data Sync**
- **Real-time Sync**: Books and photos sync across devices via Supabase
- **Offline Support**: Local caching with AsyncStorage
- **Conflict Resolution**: Last-write-wins for concurrent edits

---

## Technical Architecture

### **Frontend (React Native)**
- **Framework**: Expo SDK 54 (React Native 0.81.5)
- **Language**: TypeScript
- **Navigation**: React Navigation (Stack + Bottom Tabs)
- **State Management**: React Hooks (useState, useEffect, Context API)
- **Storage**: 
  - AsyncStorage for local caching
  - Expo FileSystem for cover image caching
  - Supabase client for cloud sync

### **Backend (Serverless)**
- **Platform**: Vercel (serverless functions)
- **Runtime**: Node.js (Vercel Edge Functions)
- **API Routes**: Next.js-style API routes in `/api` directory
- **Language**: TypeScript

### **Database**
- **Primary DB**: Supabase (PostgreSQL)
- **Storage**: Supabase Storage (for scan images)
- **Real-time**: Supabase Realtime subscriptions (optional)

### **Job Queue**
- **Queue System**: QStash (Upstash) for async job processing
- **Worker Endpoint**: `/api/scan-worker` processes scan jobs
- **Job Storage**: `scan_jobs` table in Supabase

---

## Third-Party Services & Integrations

### 1. **Supabase** (Backend-as-a-Service)
- **Purpose**: Database, authentication, file storage
- **URL**: `https://cnlnrlzhhbrtehpkttqv.supabase.co`
- **Usage**:
  - PostgreSQL database for books, photos, users, scan_jobs
  - Row Level Security (RLS) for data isolation
  - Storage bucket `photos` for scan images
  - Auth system (custom implementation on top)
  - Service role key for server-side operations
- **Tables**:
  - `books`: User's book collection
  - `photos`: Scan photos
  - `users`: User accounts
  - `scan_jobs`: Async scan job tracking
  - `google_books_cache`: Shared cache for Google Books API responses
  - `subscriptions`: Subscription status
  - `folders`: Book organization folders

### 2. **Vercel** (Hosting & Serverless)
- **Purpose**: API hosting, serverless functions, edge network
- **URL**: `https://www.bookshelfscan.app`
- **Usage**:
  - Hosts all API routes (`/api/*`)
  - Serverless function execution
  - Automatic scaling
  - Edge network for low latency
- **Environment Variables**:
  - `OPENAI_API_KEY`: OpenAI API key
  - `GEMINI_API_KEY`: Google Gemini API key
  - `GOOGLE_BOOKS_API_KEY`: Google Books API key
  - `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role
  - `QSTASH_TOKEN`: QStash authentication token
  - `QSTASH_CURRENT_SIGNING_KEY`: QStash webhook signing key
  - `QSTASH_NEXT_SIGNING_KEY`: QStash webhook signing key (rotation)

### 3. **QStash (Upstash)** (Job Queue)
- **Purpose**: Async job processing for long-running scans
- **Usage**:
  - Enqueues scan jobs when user uploads image
  - Calls `/api/scan-worker` endpoint
  - Handles retries and failures
  - Allows jobs to run up to 5 minutes
- **Workflow**:
  1. User uploads image → `/api/scan` creates job
  2. Image saved to Supabase Storage
  3. Job enqueued to QStash with `jobId`
  4. QStash calls `/api/scan-worker` with `{ jobId }`
  5. Worker downloads image, processes with AI, saves results

### 4. **Google Gemini 3 Flash** (AI Vision Model)
- **Purpose**: Primary AI model for book detection
- **API**: Google Generative AI API
- **Model**: `gemini-3-flash-preview`
- **Usage**:
  - Receives base64 image data
  - Returns JSON array of detected books
  - Rate limited: 20 RPM (3 second intervals)
  - Global queue ensures single-flight execution
- **Configuration**:
  - `maxOutputTokens`: 4096+ for shelf scans
  - `temperature`: 0 (low for consistent JSON)
  - `responseMimeType`: "application/json"
  - Quality gate: Checks for clean JSON, minimum book count, response length

### 5. **OpenAI GPT-4 Vision** (AI Vision Model - Fallback)
- **Purpose**: Fallback AI model when Gemini fails or quality gate fails
- **API**: OpenAI API
- **Model**: `gpt-4o` or `gpt-4o-mini`
- **Usage**:
  - Runs in parallel with Gemini (hedge strategy)
  - Used when Gemini quality gate fails
  - Merges results with Gemini for best coverage
- **Configuration**:
  - Timeout: 60+ seconds
  - Parallel execution with Gemini

### 6. **Google Books API** (Book Metadata)
- **Purpose**: Fetch book covers, descriptions, metadata
- **API**: `https://www.googleapis.com/books/v1`
- **Usage**:
  - Search by title/author: `/volumes?q=...`
  - Lookup by ID: `/volumes/{googleBooksId}`
  - Returns: cover URLs, description, page count, categories, publisher, etc.
- **Proxy Endpoint**: `/api/google-books` (adds API key server-side)
- **Resilience**:
  - Always returns 200 (never throws 503)
  - Retries 429/5xx with exponential backoff (3 attempts: 500ms, 1500ms, 3500ms)
  - Respects `Retry-After` header
  - Server-side Supabase caching (shared across users)
  - In-memory cache fallback

### 7. **Resend** (Email Service)
- **Purpose**: Send transactional emails
- **Usage**:
  - Password reset emails
  - Email confirmation emails
  - Support emails
- **API**: Resend API
- **Templates**: Plain text emails with links

### 8. **Apple App Store** (Distribution & IAP)
- **Purpose**: App distribution and in-app purchases
- **Bundle ID**: `com.clayjohnson75.bookshelf-scanner`
- **IAP Product**: `com.bookshelfscanner.pro.monthly.v2`
- **Library**: `react-native-iap` v14.7.0
- **Receipt Validation**: Server-side validation via `/api/validate-apple-receipt`

### 9. **Expo** (Development & Build Platform)
- **Purpose**: React Native framework, build system, OTA updates
- **EAS Build**: Builds iOS/Android apps
- **Project ID**: `b558ee2d-5af2-481c-82af-669e79311aab`
- **Modules Used**:
  - `expo-camera`: Camera access
  - `expo-image-picker`: Photo library access
  - `expo-file-system`: File storage
  - `expo-image-manipulator`: Image processing
  - `expo-secure-store`: Secure credential storage
  - `expo-local-authentication`: Biometric auth

---

## Scan Pipeline (Guaranteed Order)

### **Step 1: Parse → rawBooks**
- User uploads image (camera or photo library)
- Image uploaded to Supabase Storage (`photos` bucket)
- Job created in `scan_jobs` table with `status='pending'`
- QStash enqueues job with `{ jobId }`
- Worker downloads image from storage
- AI models (Gemini + OpenAI) process image
- Returns raw book array from API responses

### **Step 2: Normalize + Validate → cleanBooks**
- **Always runs** before saving (guaranteed)
- Fix title/author swaps (detects common OCR errors)
- Deduplicate books (by normalized title+author)
- Cheap validation (filters invalid entries)
- Batch validation (confidence scoring)
- Final deduplication

### **Step 3: Save cleanBooks to scan_jobs.books**
- Updates `scan_jobs` table:
  - `status='completed'` (or `'failed'` if no books)
  - `books`: JSON array of clean books
  - `error`: null if successful, error object if failed
- Only saves after normalization/validation completes

### **Step 4: Cover Fetching (Client-Side)**
- Client polls `/api/scan/:jobId` until `status='completed'`
- Receives books array
- Triggers parallel cover fetching (max 5 concurrent)
- Fetches covers via `/api/google-books` proxy
- Caches covers locally in Expo FileSystem
- Updates UI as covers load

---

## API Endpoints

### **Scan Endpoints**
- `POST /api/scan`: Create scan job, upload image, enqueue to QStash
- `GET /api/scan/:jobId`: Poll job status, returns books when completed
- `POST /api/scan-worker`: QStash webhook, processes scan job (internal)

### **Google Books Proxy**
- `GET /api/google-books`: Proxy for Google Books API
  - Query params: `path` (e.g., `/volumes`), `q`, `maxResults`, etc.
  - Adds API key server-side
  - Returns: `{ ok: true, data: ... }` or `{ ok: false, error: ... }`
  - Always returns 200 (never throws 503)

### **Auth Endpoints**
- `POST /api/signin`: User login
- `POST /api/web-signin`: Web-based login
- `POST /api/password-reset`: Request password reset
- `POST /api/update-password`: Update password
- `POST /api/confirm-email`: Confirm email address
- `POST /api/refresh-token`: Refresh auth token

### **User Endpoints**
- `GET /api/profile/:username`: Get public profile
- `POST /api/profile/:username/edit`: Edit profile
- `GET /api/get-username`: Get username by user ID
- `GET /api/get-email-by-username`: Get email by username (for login)

### **Library Endpoints**
- `POST /api/search`: Search books across all users
- `POST /api/sync-scans`: Sync scans from client
- `POST /api/auto-sort-books`: AI-powered book organization

### **Subscription Endpoints**
- `GET /api/check-subscription`: Check subscription status
- `POST /api/validate-apple-receipt`: Validate Apple IAP receipt

### **Utility Endpoints**
- `GET /api/health`: Health check
- `GET /api/test`: Test endpoint

---

## Database Schema (Supabase)

### **books**
- `id`: UUID (primary key)
- `user_id`: UUID (foreign key to users)
- `title`: TEXT
- `author`: TEXT
- `google_books_id`: TEXT (for cover fetching)
- `cover_url`: TEXT
- `local_cover_path`: TEXT (local file path)
- `description`: TEXT
- `page_count`: INTEGER
- `categories`: TEXT[] (array)
- `publisher`: TEXT
- `published_date`: TEXT
- `spine_text`: TEXT (original OCR text)
- `spine_index`: INTEGER (position in scan)
- `folder_id`: UUID (optional, for folders)
- `is_read`: BOOLEAN
- `created_at`: TIMESTAMPTZ
- `updated_at`: TIMESTAMPTZ

### **photos**
- `id`: UUID (primary key)
- `user_id`: UUID (foreign key)
- `uri`: TEXT (Supabase Storage path)
- `caption`: TEXT
- `created_at`: TIMESTAMPTZ

### **users**
- `id`: UUID (primary key, matches Supabase auth.users)
- `email`: TEXT (unique)
- `username`: TEXT (unique, for public profiles)
- `avatar_url`: TEXT
- `bio`: TEXT
- `created_at`: TIMESTAMPTZ

### **scan_jobs**
- `id`: TEXT (primary key, format: `job_${timestamp}_${random}`)
- `user_id`: UUID (foreign key)
- `scan_id`: TEXT (for correlation logging)
- `status`: TEXT (`'pending' | 'processing' | 'completed' | 'failed'`)
- `books`: JSONB (array of Book objects, only set when completed)
- `error`: JSONB (error object if failed, null if successful)
- `image_path`: TEXT (Supabase Storage path)
- `image_hash`: TEXT (SHA256 for deduplication)
- `created_at`: TIMESTAMPTZ
- `updated_at`: TIMESTAMPTZ

### **google_books_cache**
- `cache_key`: TEXT (primary key, normalized query or volume ID)
- `data`: JSONB (cached API response)
- `created_at`: TIMESTAMPTZ

### **subscriptions**
- `user_id`: UUID (primary key)
- `tier`: TEXT (`'free' | 'pro'`)
- `apple_transaction_id`: TEXT
- `expires_at`: TIMESTAMPTZ
- `updated_at`: TIMESTAMPTZ

---

## Key Workflows

### **1. User Registration & Login**
1. User enters email/username and password
2. Client calls `/api/signin` or uses Supabase auth
3. Server validates credentials against Supabase `users` table
4. Returns JWT token for authenticated requests
5. Client stores token in SecureStore
6. User data loaded from Supabase

### **2. Book Scanning Workflow**
1. **User Action**: User takes photo or selects from library
2. **Image Processing**: Image compressed/resized client-side (max 1600-2000px, JPEG quality 0.7-0.8)
3. **Upload**: Image uploaded to Supabase Storage (`photos/{userId}/{imageHash}.jpg`)
4. **Job Creation**: `POST /api/scan` creates job in `scan_jobs` table
5. **QStash Enqueue**: Job enqueued to QStash with `{ jobId }` (image NOT sent to QStash)
6. **Response**: Returns `{ jobId, status: 'pending' }` immediately (202 Accepted)
7. **Client Polling**: Client polls `GET /api/scan/:jobId` every 1-2 seconds
8. **Worker Processing** (async):
   - QStash calls `POST /api/scan-worker` with `{ jobId }`
   - Worker downloads image from Supabase Storage
   - Runs Gemini + OpenAI in parallel
   - Normalizes and validates results
   - Saves `cleanBooks` to `scan_jobs.books`
   - Updates `status='completed'`
9. **Client Receives Results**: Polling returns `{ status: 'completed', books: [...] }`
10. **Cover Fetching**: Client triggers parallel cover fetching (max 5 concurrent)
11. **UI Update**: Books appear in library with covers loading progressively

### **3. Cover Fetching Workflow**
1. Client has books with `googleBooksId` or `title`+`author`
2. For each book needing cover:
   - Check local cache (Expo FileSystem)
   - Check Supabase cache (server-side, shared)
   - If cache miss, call `/api/google-books` proxy
3. Proxy workflow:
   - Check Supabase cache (shared across users)
   - Check in-memory cache
   - If miss, call Google Books API with retry/backoff
   - Cache result in Supabase + in-memory
   - Return `{ ok: true, data: ... }` or `{ ok: false, error: ... }`
4. Client downloads cover image
5. Saves to local FileSystem
6. Updates book record in Supabase with `cover_url` and `local_cover_path`

### **4. Subscription Purchase Workflow**
1. User taps "Upgrade to Pro"
2. Client calls `purchaseProSubscription()` from `appleIAPService`
3. Uses `react-native-iap` to initiate purchase
4. Apple handles payment flow
5. Receipt returned to client
6. Client calls `/api/validate-apple-receipt` with receipt
7. Server validates receipt with Apple
8. Updates `subscriptions` table in Supabase
9. Client refreshes subscription status

---

## Environment Variables

### **Client-Side (Expo)**
- `EXPO_PUBLIC_SUPABASE_URL`: Supabase project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`: Supabase anonymous key
- `EXPO_PUBLIC_API_BASE_URL`: API base URL (`https://www.bookshelfscan.app`)

### **Server-Side (Vercel)**
- `OPENAI_API_KEY`: OpenAI API key
- `GEMINI_API_KEY`: Google Gemini API key
- `GOOGLE_BOOKS_API_KEY`: Google Books API key
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key (bypasses RLS)
- `QSTASH_TOKEN`: QStash authentication token
- `QSTASH_CURRENT_SIGNING_KEY`: QStash webhook signing key
- `QSTASH_NEXT_SIGNING_KEY`: QStash webhook signing key (rotation)
- `RESEND_API_KEY`: Resend email API key

---

## Deployment Process

### **Frontend (Mobile App)**
1. **Development**: `expo start` (Expo Go or dev client)
2. **Build**: `eas build --platform ios` or `eas build --platform android`
3. **Submit**: `eas submit --platform ios` (to App Store)
4. **OTA Updates**: Expo Updates (optional, not currently used)

### **Backend (API)**
1. **Local Testing**: `vercel dev` (runs on localhost:3000)
2. **Deploy**: `vercel --prod` (deploys to production)
3. **Automatic**: Vercel auto-deploys on git push to `main` branch

### **Database (Supabase)**
- Managed service, no deployment needed
- Migrations run manually via Supabase SQL Editor
- Schema changes: Create migration SQL, run in dashboard

---

## Key Technical Decisions

### **1. Async Job System**
- **Why**: Scans take 30-90 seconds, exceed HTTP timeout limits
- **Solution**: QStash job queue with polling
- **Benefit**: No client timeouts, scalable, reliable

### **2. Dual AI Models (Gemini + OpenAI)**
- **Why**: Redundancy, quality gate, best coverage
- **Solution**: Run both in parallel, merge results
- **Benefit**: Higher accuracy, fallback on failures

### **3. Guaranteed Pipeline Order**
- **Why**: Ensure data quality before saving
- **Solution**: Always normalize/validate before saving
- **Benefit**: Clean data in database, no invalid books

### **4. Resilient Google Books API**
- **Why**: API failures shouldn't crash app
- **Solution**: Always return 200, retry with backoff, cache aggressively
- **Benefit**: Graceful degradation, better UX

### **5. Canonical Base URL**
- **Why**: Avoid redirects, ensure consistency
- **Solution**: All clients use `https://www.bookshelfscan.app`
- **Benefit**: No 307 redirects, faster requests

### **6. Server-Side Caching**
- **Why**: Reduce API costs, faster responses
- **Solution**: Supabase cache shared across all users
- **Benefit**: Popular books cached once, everyone benefits

---

## Performance Optimizations

1. **Image Compression**: Client-side compression before upload (reduces storage costs)
2. **Parallel Processing**: Gemini + OpenAI run simultaneously
3. **Concurrency Limits**: Cover fetching limited to 5 concurrent requests
4. **Caching**: Multi-layer caching (in-memory, Supabase, local FileSystem)
5. **Batch Updates**: UI updates batched every 300ms
6. **Lazy Loading**: Covers load progressively as they're fetched
7. **Deduplication**: Client and server-side dedupe prevents duplicate scans

---

## Security Measures

1. **API Keys**: Never exposed to client (server-side only)
2. **Row Level Security**: Supabase RLS ensures users only see their data
3. **Service Role Key**: Only used server-side for admin operations
4. **Image Hash Deduplication**: Prevents duplicate processing
5. **QStash Webhook Signing**: Validates webhook authenticity
6. **Secure Storage**: Sensitive data in Expo SecureStore
7. **HTTPS Only**: All API calls use HTTPS

---

## Monitoring & Logging

- **Client Logs**: Console logs in development, minimal in production
- **Server Logs**: Vercel function logs (accessible via Vercel dashboard)
- **Error Tracking**: Console.error for critical errors
- **Job Tracking**: `scan_jobs` table tracks all scan attempts
- **Metadata**: Each scan logs `received_image_bytes`, `content_type`, `parse_path`, `ended_reason`

---

## Future Enhancements (Not Yet Implemented)

- Real-time sync via Supabase Realtime
- Android support (currently iOS-focused)
- Export library (CSV, JSON)
- Social features (follow users, share collections)
- Reading progress tracking
- Book recommendations
- Integration with Goodreads, LibraryThing

---

## Contact & Support

- **Email**: bookshelfscanapp@gmail.com
- **Support Page**: https://www.bookshelfscan.app/support.html
- **Privacy Policy**: https://www.bookshelfscan.app/privacy.html
- **Terms**: https://www.bookshelfscan.app/terms.html

---

*Last Updated: 2025-01-27*

