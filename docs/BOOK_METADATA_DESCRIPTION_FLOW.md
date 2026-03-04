# Book Description and Metadata Flow

Reference for debugging why book descriptions or metadata are not loading.

## TL;DR

- Description loads from two server paths:
  - `POST /api/books/enrich-description` — single book, triggered when Book Detail modal opens
  - `POST /api/meta-enrich-worker` — batch worker, runs after scan pipelines
- Provider order differs by path (see sections 2 and 3 below).
- UI only auto-triggers enrich when `book.enrichment_status === 'pending'` or status is missing and `book.description` is empty.
- If a row is saved with `enrichment_status = 'complete'` but an empty description, the UI will not re-fetch.

---

## 1. Where description is loaded in the UI

### Book Detail modal (`components/BookDetailModal.tsx`)

When the modal opens:
- If `book.description` exists: show it immediately.
- Else if `book.enrichment_status === 'pending'` (or missing + no description): call `triggerEnrichDescription(...)`.

API called: `POST /api/books/enrich-description`

Payload:
- `dbId` if a UUID exists (`book.dbId`)
- else `book_key` (+ title/author/isbn fallback)

On success: updates local book with `description` and `enrichment_status`, calls `onBookUpdate(updatedBook)` to refresh parent state.

Note: `getServerBookId()` only accepts UUIDs from `book.dbId`. Local/composite IDs are intentionally rejected.

---

## 2. Single-book enrich endpoint

**File:** `api/books/enrich-description.ts`
**Route:** `POST /api/books/enrich-description`

### Lookup order
1. `(id, user_id)` using `dbId` / `bookId`
2. `(user_id, book_key)`
3. If still missing and `book_key` provided: upsert a stub row by `(user_id, book_key)`

Then:
- If row already has description: marks `enrichment_status='complete'` and returns (including the existing description in the response).
- Else: calls `fetchDescriptionForBook(...)` from `lib/enrichDescription.ts`.

### Provider order
1. Google Books (`google_books_id` direct, else title/author search)
2. Open Library (ISBN path, then title/author work lookup)
3. `not_found`

Writes to `books`: `description`, `description_source`, `enrichment_status`, `enrichment_updated_at`.

---

## 3. Batch metadata enrichment worker

**File:** `api/meta-enrich-worker.ts` / `lib/workers/metaEnrich.ts`
**Route:** `POST /api/meta-enrich-worker`

### Candidate selection
Worker only enriches rows where:
- description is empty
- `enrichment_status` is `NULL`, `pending`, or `failed`
- `failed` rows are backoff-limited by `enrichment_updated_at` (1 hour)

If `scanJobId` is provided, worker queries `books.source_scan_job_id = scanJobId`. If provenance is missing, worker logs "no candidates" even if books exist.

### Provider order
`lib/enrichBookMetadata.ts` → `fetchFullMetadataForBook(...)`:
1. `book_metadata_cache` lookup (global cache table)
2. Open Library full metadata (`lib/openLibraryMetadata.ts`)
3. Google Books fallback only if OL did not provide description

Writes: `description`, `description_source`, `enrichment_status`, `enrichment_updated_at`, `publisher`, `published_date`, `page_count`, `categories`, `language`, `subtitle`, `isbn`, `google_books_id`, ratings fields.

---

## 4. How metadata is persisted

**File:** `services/supabaseSync.ts`, function `saveBookToSupabase(...)`

- Save logic preserves existing metadata if the new payload does not include fields.
- Approve/update paths can set/merge description and metadata.
- `loadBooksFromSupabase(...)` maps DB columns into the `Book` object used by the UI.

---

## 5. Common breakpoints

1. **enrichment_status gating** — Books stuck with `enrichment_status='complete'` but empty `description`. UI will not auto-fetch.
2. **No DB UUID on client row** — BookDetailModal only sends UUID db ids. If approved items still have local IDs and no `book.dbId`, enrich relies on `book_key` fallback.
3. **Missing `source_scan_job_id` provenance** — `meta-enrich-worker` with `scanJobId` finds 0 candidates when rows lack `source_scan_job_id`.
4. **Provider config/network** — Missing `GOOGLE_BOOKS_API_KEY` reduces Google success. Open Library / Google fetch failures return `not_found` / `failed`.
5. **Description exists but UI not updated** — API succeeds but parent state / local storage merge does not replace the stale row displayed in the UI.

---

## 6. Debug checklist

For one broken book:
1. Inspect DB row in `books`: `id`, `book_key`, `description`, `enrichment_status`, `description_source`, `source_scan_job_id`, `google_books_id`
2. Open Book Detail and check app logs: `[DESC_DETAIL_OPEN]`, `[ENRICH_DESCRIPTION_REQUEST]`, `[ENRICH_DESCRIPTION_RESPONSE]`
3. Manually call single enrich: `POST /api/books/enrich-description` with `dbId` or `book_key`
4. Check worker candidate filtering: `[META] candidate check`, `[meta-enrich-worker] No candidates ...`
5. Confirm final UI object has `book.dbId` populated, `book.description` non-empty, `book.enrichment_status` not stale.

---

## 7. Files involved

| Role | File |
|---|---|
| UI trigger | `components/BookDetailModal.tsx` |
| Single enrich API | `api/books/enrich-description.ts` |
| Batch enrich API | `api/books/enrich-batch.ts` |
| Metadata worker API | `api/meta-enrich-worker.ts` |
| Worker implementation | `lib/workers/metaEnrich.ts` |
| Description provider chain | `lib/enrichDescription.ts` |
| Full metadata provider chain | `lib/enrichBookMetadata.ts` |
| Open Library metadata fetch | `lib/openLibraryMetadata.ts` |
| Book persistence / load | `services/supabaseSync.ts` |
