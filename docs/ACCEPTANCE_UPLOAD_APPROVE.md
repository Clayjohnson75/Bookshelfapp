# Acceptance: Upload & Approve (durable queue, no tab coupling, no 0-books regression)

This doc maps each acceptance criterion to code and manual test steps.

---

## 1. Pick a photo → tile appears instantly with "Uploading…"

**Code:**
- **Tile from state:** New photo is appended to `photos` state and persisted to `photos_${userId}` before the upload queue runs.  
  `tabs/ScansTab.tsx`: create `newPhotos`, persist to AsyncStorage (lines ~7335–7341), then `addToQueue` (7345–7353), then `setPhotos(prev => [...prev, ...newPhotos])` (7354).
- **"Uploading…" label:** `components/PhotoTile.tsx`: `isUploading` when status is `uploading` / `draft` / `stalled` and no display URL (lines 234–236, 311–315). New photos from pick have no `storage_path` so they show as uploading.

**Manual test:**
1. Open Scans tab, pick a photo from library (or camera).
2. **Expect:** A new tile appears within ~1s with an "Uploading…" badge.
3. Tile remains visible (not replaced by a spinner or empty state).

---

## 2. Leave the page immediately → come back → tile still there, progresses to complete

**Code:**
- **Persistence:** Picked photos are written to `photos_${userId}` in AsyncStorage when enqueued (`tabs/ScansTab.tsx` ~7340). Upload queue is stored in `upload_queue_${userId}` (`lib/photoUploadQueue.ts`). Worker runs globally from `AppWrapper` and is not tied to the tab.
- **Rehydration:** On focus, `loadUserData()` runs (`tabs/ScansTab.tsx`); it loads from AsyncStorage and merges with server. Empty-photos guard prevents overwriting local photos when server returns 0 (`tabs/ScansTab.tsx` ~4286–4317).
- **Progress:** Upload worker continues in background; when job completes, `onPhotoComplete` can update UI if tab is mounted; if user was away, next `loadUserData()` (on focus) fetches server photos and merge brings in the completed photo.

**Manual test:**
1. Pick a photo so a tile shows "Uploading…".
2. Immediately switch to another tab (e.g. My Library or Explore).
3. Wait 30–60s (or until upload would normally complete).
4. Return to Scans tab.
5. **Expect:** Same tile is still visible; it shows as complete (photo visible) or still "Uploading…" if upload is slow, then completes after a short wait.

---

## 3. Kill app mid-upload → reopen → upload resumes → tile still there

**Code:**
- **Queue durability:** `upload_queue_${userId}` in AsyncStorage (`lib/photoUploadQueue.ts`: `getQueue`, `persistQueue`, `addToQueue`). Worker started in `AppWrapper.tsx` when `userId` is set; runs every `WORKER_INTERVAL_MS`, processes up to `MAX_CONCURRENT` (2) items.
- **Photos durability:** Photo list is in `photos_${userId}`; rehydration loads it so the tile is present after reopen.

**Manual test:**
1. Pick a photo; wait until "Uploading…" is visible.
2. Force-kill the app (swipe away or stop in dev).
3. Reopen the app and go to Scans tab.
4. **Expect:** The same tile is still there; upload resumes (may show "Uploading…" then complete). No duplicate tiles; no lost photo.

---

## 4. Approve books → leave → reopen → approved books + photo still present

**Code:**
- **Enqueue and return:** Approve tap does optimistic state + AsyncStorage update, then `addApproveJob(userId, payload)` and returns (`tabs/ScansTab.tsx` ~10560–10585). No `await saveUserData` for the approve path.
- **Background worker:** `lib/approveQueue.ts`: worker runs from `AppWrapper`, calls `runApproveWrites`, then persists `approved_books_${userId}` and `photos_${userId}` and calls `scan-mark-imported`.
- **Reopen:** On next open/focus, `loadUserData()` loads from AsyncStorage (and server); approved list and photos include the result of the background approve.

**Manual test:**
1. Have a scan with detected books; tap Approve (all or selected).
2. Immediately leave the Scans tab or kill the app.
3. Reopen app (or return to Scans tab).
4. **Expect:** Approved books appear in library; the photo for that scan is still present. No "pending" revert; counts are correct.

---

## 5. No "0 books" regression when server snapshots are slow/partial

**Code:**
- **Books:** When server returns 0 approved but local has approved and user did not just clear library, we keep local and do not apply empty.  
  `tabs/ScansTab.tsx`: `untrustedEmptySnapshot` (3064), `[BOOKS_MERGE_EMPTY_GUARD]` (3069–3078), and empty-apply guard (3202–3216).
- **Photos:** We never downgrade local photos to zero just because server returned 0; only apply empty when there was a recent user clear.  
  `tabs/ScansTab.tsx`: `wouldApplyEmptyPhotos` / `isRecentClearLibraryPhotos` (4292–4317), `[REHYDRATE_APPLY_GUARD]`.
- **Merge:** `lib/dedupBy.ts`: `statusRank` avoids downgrading complete/uploaded/uploading to draft (line 90); `mergePreserveLocalUris` keeps local status/URI when server has no `storage_path` (181–182). Photos with null `storage_path` are not filtered out (ScansTab ~3937–3972, `[PHOTO_KEEP_NO_STORAGE]`).

**Manual test:**
1. Have a non-empty library (several approved books and photos).
2. Simulate a slow or partial server response (e.g. throttle network, or use a build where the server sometimes returns 0 for a request).
3. Trigger rehydration (switch tab and back, or pull-to-refresh if applicable).
4. **Expect:** Library still shows your books and photos; no momentary "0 books" or empty grid. Counts may lag but must not drop to zero unless you explicitly cleared library.

---

## Automated checks (guards present)

Run:

```bash
node scripts/acceptance-guards-check.js
```

This script verifies that the key "no 0 books/photos" and "durable queue" code paths exist in the repo (string checks). It does not run the app or React Native.
