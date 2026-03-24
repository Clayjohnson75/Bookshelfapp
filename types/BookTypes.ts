export interface Book {
  id?: string;
  /** Supabase books.id (UUID). Use for server APIs; id may be local composite. Server id is an attribute; identity is book_key. */
  dbId?: string;
  /** Stable identity key (e.g. isbn13:xxx or normalized title|author). Primary key for dedupe; id/dbId are aliases. */
  book_key?: string;
  title: string;
  author?: string;
  isbn?: string;
  confidence?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'incomplete';
  scannedAt?: number;
  coverUrl?: string;
  localCoverPath?: string; // Local cached path for offline access
  googleBooksId?: string;
  work_key?: string; // Canonical lookup key for cover resolution (isbn13:xxx, ta:sha1)
  description?: string; // Book description from Google Books API
  /** pending = not yet fetched; complete = filled; failed = fetch error; not_found = no source had it */
  enrichment_status?: 'pending' | 'complete' | 'failed' | 'not_found';
  // Google Books API stats fields
  pageCount?: number; // Total number of pages
  categories?: string[]; // Genres/categories
  publisher?: string; // Publisher name
  publishedDate?: string; // Publication date (e.g., "2023" or "2023-01-15")
  language?: string; // Language code (e.g., "en")
  averageRating?: number; // Average rating (0-5)
  ratingsCount?: number; // Total number of ratings
  subtitle?: string; // Book subtitle
  printType?: string; // Print type (e.g., "BOOK")
  readAt?: number; // Timestamp when book was marked as read (null/undefined = unread)
  is_favorite?: boolean; // Shown in Favorites bar on profile (synced to Supabase)
  /** Origin photo (scan) this book was imported from; set at approve time. DB column: source_photo_id. Use this for books-per-photo grouping. */
  source_photo_id?: string;
  /** CamelCase alias for source_photo_id (set when mapping from DB). Use with getBookSourcePhotoId() for attach/counts. */
  sourcePhotoId?: string;
  /** Alias for source_photo_id (set when mapping from DB so code using photoId still works). Do not use book.photo_id — it does not exist. */
  photoId?: string;
  /** Origin scan job (raw UUID). Set at approve time for provenance. DB column: source_scan_job_id. */
  source_scan_job_id?: string;
  /** Alias for source_scan_job_id (set when mapping from DB). Do not use book.scan_job_id — it does not exist. */
  scanJobId?: string;
  /** Pending sync: set when user approves; cleared when server confirms. Merge must never drop pending. */
  sync_state?: 'pending' | 'synced';
  sync_pending_at?: number;
  /** When true (approved books), merge must not replace title/author/book_key/source_photo_id/source_scan_job_id with server values. */
  identity_locked?: boolean;
  /**
   * Set to 'orphaned' when source_photo_id cannot be resolved to a known photo row after alias
   * resolution. This is a soft marker — the book is NOT deleted. A rehydrate from server should
   * clear it once the photo row is confirmed. Only hard-deleted when the server explicitly
   * confirms the photo is gone AND the book is pending/unapproved AND the user confirms.
   */
  integrity_state?: 'ok' | 'orphaned';
}

/** Persistence state for photos. Cleanup may only remove 'captured' | 'pending'; never touch 'accepted'. */
export type PhotoState = 'captured' | 'pending' | 'accepted' | 'deleted';

/**
 * Formal Photo lifecycle for 3-step pipeline: local → upload → process.
 * Do NOT filter photos out just because storage_path is null — those are "uploading" / "local_pending" photos.
 */
export type PhotoLifecycleStatus =
  | 'local_pending'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'complete'
  | 'failed_upload'
  | 'failed_processing'
  | 'scan_failed'
  | 'draft'
  | 'stalled'
  | 'discarded'
  | 'errored';

export interface Photo {
  /** DB uuid; use this for attach/counts (booksByPhotoId[photo.id]). Normalize at ingest so id is always DB uuid; store alias in localId. */
  id: string;
  /** Local/alias id before normalization (e.g. short id or temp id). Set at ingest when we replace id with canonical. */
  localId?: string;
  /** Display URI (legacy). Prefer local_uri for client-only file; signed_url when storage_path exists. */
  uri: string;
  books: Book[];
  timestamp: number;
  caption?: string;
  /** Server: required on DB row. Client: optional until synced. */
  user_id?: string;
  /**
   * Lifecycle status. Only `complete` should appear in Recent Scans.
   * Do NOT filter out photos with null storage_path — they are local_pending/uploading.
   */
  status?: PhotoLifecycleStatus;
  /** Client-only: local file URI (file://). Never expected on server. */
  local_uri?: string;
  /** Server storage path. Nullable until upload completes; DB row can exist before upload. */
  storage_path?: string;
  /** Cached in state, expires; can be regenerated from storage_path. */
  signed_url?: string | null;
  /** Unix ms when signed_url expires; refresh ~1 min before. */
  signed_url_expires_at?: number | null;
  /** ISO string or ms; when photo was created. */
  created_at?: number | string;
  /** Scan job UUID (optional). Set when processing step starts. */
  scan_job_id?: string;
  /** Hash for dedupe/retry; recommended. Server column image_hash. */
  image_hash?: string;
  /** Precomputed thumbnail file URI (cache) for grids. Prefer over uri for grid display. */
  thumbnail_uri?: string;
  /** When set, UI reads books from GET /api/scan/[jobId] (scan_jobs.books), not from books table, until user confirms import. */
  jobId?: string;
  finalizedAt?: number;
  /** Hash of image bytes (e.g. from hashDataURL) for dedupe; client-side. Server uses image_hash. */
  photoFingerprint?: string;
  bytes?: number;
  width?: number;
  height?: number;
  state?: PhotoState;
  source?: 'camera' | 'library';
  accepted_at?: number;
  sync_state?: 'pending' | 'synced';
  sync_pending_at?: number;
  /** Number of approved books tied to this photo when scan review is finalized. */
  approved_count?: number;
  /** When status is failed_upload: optional error message from upload queue (e.g. "Upload to Storage failed"). */
  errorMessage?: string;
}

export interface User {
  uid: string;
  email: string;
  username: string; // Required unique identifier for speculation/search
  displayName?: string;
  photoURL?: string;
}

export interface UserProfile {
  displayName: string;
  email: string;
  photoURL?: string;
  createdAt: Date;
  lastLogin: Date;
  totalBooks: number;
  totalPhotos: number;
}

export interface Folder {
  id: string;
  name: string;
  bookIds: string[]; // Array of book IDs that belong to this folder
  photoIds: string[]; // Array of photo IDs that belong to this folder
  createdAt: number;
}

/** Wishlist entry (same shape as Book for display). */
export type WishlistItem = Book;

/**
 * Returns true if a photo has confirmed remote storage (storage_path or storage_url).
 * A photo with only a file:// URI has no remote storage and must not be marked 'complete'.
 */
export function photoHasStorage(photo: Photo): boolean {
  const storagePath = (photo as any).storage_path as string | undefined;
  const storageUrl = (photo as any).storage_url as string | undefined;
  return (
    (typeof storagePath === 'string' && storagePath.trim().length > 0) ||
    (typeof storageUrl === 'string' && storageUrl.startsWith('http'))
  );
}

/**
 * Reconcile a photo's status with its actual storage fields.
 *
 * Two invariants enforced:
 *   A) 'complete' with no storage → demote to 'draft'
 *      (local placeholder that hasn't uploaded yet; 'complete' would make the filter drop it)
 *   B) 'draft' with confirmed storage → promote to 'complete'
 *      (the DB row has storage_path set, meaning the upload finished; status just wasn't updated.
 *       This happens when the lifecycle patch is deferred or the row was loaded directly from DB.)
 *
 * A file:// URI is NOT considered "confirmed storage" — only storage_path or an http storage_url.
 * Returns the same object reference when no change is needed.
 */
export function enforcePhotoStorageStatus(photo: Photo): Photo {
  const hasStorage = photoHasStorage(photo);

  if (photo.status === 'complete' && !hasStorage) {
    // A: demote — complete without storage is a contradiction
    return { ...photo, status: 'draft' };
  }

  if (photo.status === 'draft' && hasStorage) {
    // B: promote — storage confirmed, status is just stale
    return { ...photo, status: 'complete' };
  }

  // C: demote stale in-flight states from AsyncStorage reload.
  // On app restart, photos stuck in 'local_pending', 'uploading', or 'stalled'
  // should be demoted to 'draft' so the upload queue worker can re-process them
  // instead of the badge showing "Uploading…" forever.
  if (
    (photo.status === 'local_pending' || photo.status === 'uploading' || photo.status === 'stalled') &&
    !hasStorage
  ) {
    return { ...photo, status: 'draft' };
  }

  // D: in-flight state but storage is confirmed — promote to complete
  if (
    (photo.status === 'local_pending' || photo.status === 'uploading' || photo.status === 'stalled') &&
    hasStorage
  ) {
    return { ...photo, status: 'complete' };
  }

  return photo;
}
