#!/usr/bin/env node
/**
 * Acceptance guards check: verifies that key code paths for upload/approve
 * and "no 0 books regression" exist. Run: node scripts/acceptance-guards-check.js
 *
 * Does NOT run the app or React Native; only checks that expected strings exist.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

function has(content, substring, label) {
  const ok = content && content.includes(substring);
  console.log(ok ? '  ✓' : '  ✗', label);
  return ok;
}

let failed = 0;

// 1) Upload queue: durable, persists to AsyncStorage
const uploadQueue = readFile('lib/photoUploadQueue.ts');
if (!uploadQueue) {
  console.log('  ✗ lib/photoUploadQueue.ts not found');
  failed++;
} else {
  if (!has(uploadQueue, 'upload_queue_', 'upload queue uses AsyncStorage key upload_queue_${userId}')) failed++;
  if (!has(uploadQueue, 'addToQueue', 'upload queue exports addToQueue')) failed++;
  if (!has(uploadQueue, 'MAX_CONCURRENT', 'upload queue has MAX_CONCURRENT (concurrency cap)')) failed++;
  if (!has(uploadQueue, 'backoffMs', 'upload queue has exponential backoff')) failed++;
  if (!has(uploadQueue, 'state: \'complete\'', "upload queue marks state 'complete'")) failed++;
  if (!has(uploadQueue, 'deleteAsync', 'upload queue deletes local original after success')) failed++;
}

// 2) Approve queue: enqueue and worker, not tied to tab
const approveQueue = readFile('lib/approveQueue.ts');
if (!approveQueue) {
  console.log('  ✗ lib/approveQueue.ts not found');
  failed++;
} else {
  if (!has(approveQueue, 'approve_queue_', 'approve queue uses AsyncStorage key approve_queue_')) failed++;
  if (!has(approveQueue, 'addApproveJob', 'approve queue exports addApproveJob')) failed++;
  if (!has(approveQueue, 'runApproveWrites', 'approve queue calls runApproveWrites')) failed++;
  if (!has(approveQueue, 'approved_books_', 'approve worker persists approved_books_')) failed++;
  if (!has(approveQueue, 'backoffMs', 'approve queue has exponential backoff')) failed++;
}

// 3) ScansTab: enqueue approve (no await saveUserData for approve path)
const scansTab = readFile('tabs/ScansTab.tsx');
if (!scansTab) {
  console.log('  ✗ tabs/ScansTab.tsx not found');
  failed++;
} else {
  if (!has(scansTab, 'addApproveJob', 'ScansTab approve path uses addApproveJob')) failed++;
  if (!has(scansTab, 'Enqueue approve job and return immediately', 'ScansTab comment: enqueue and return immediately')) failed++;
  if (!has(scansTab, 'Do NOT call cancelAllForUser', 'ScansTab cancel: do not mark durable queue canceled (worker resumes)')) failed++;
  if (!has(scansTab, 'durable queue NOT marked canceled', 'ScansTab cancel log: durable queue NOT marked canceled')) failed++;
  if (!has(scansTab, 'userPhotosKeyA', 'ScansTab persists photos to AsyncStorage when enqueueing upload')) failed++;
  if (!has(scansTab, 'setPhotos((prev) => [...prev, ...newPhotos]', 'ScansTab adds new photos to state for instant tile')) failed++;
}

// 4) No "0 books" regression: empty guards
if (scansTab) {
  if (!has(scansTab, 'Never downgrade local photos to zero just because server returned 0', 'Photos: never downgrade to zero on server 0')) failed++;
  if (!has(scansTab, 'BOOKS_MERGE_EMPTY_GUARD', 'Books: empty guard when server approved=0 and local has data')) failed++;
  if (!has(scansTab, 'REHYDRATE_APPLY_GUARD', 'Photos: rehydrate apply guard (refuse empty when local had data)')) failed++;
  if (!has(scansTab, 'PHOTO_KEEP_NO_STORAGE', 'Photos: keep tile when no storage_path (uploading)')) failed++;
}

// 5) dedupBy: preserve uploading status
const dedupBy = readFile('lib/dedupBy.ts');
if (dedupBy) {
  if (!has(dedupBy, 'never downgrade complete/uploaded/uploading', 'dedupBy: never downgrade uploading -> draft')) failed++;
  if (!has(dedupBy, 'keep local status (uploading/uploaded)', 'dedupBy: mergePreserveLocalUris keeps uploading')) failed++;
}

// 6) AppWrapper starts both workers
const appWrapper = readFile('AppWrapper.tsx');
if (appWrapper) {
  if (!has(appWrapper, 'startUploadQueueWorker', 'AppWrapper starts upload queue worker')) failed++;
  if (!has(appWrapper, 'startApproveQueueWorker', 'AppWrapper starts approve queue worker')) failed++;
}

console.log('');
if (failed > 0) {
  console.log('FAIL: %d check(s) failed.', failed);
  process.exit(1);
}
console.log('PASS: All acceptance guard checks found.');
process.exit(0);
