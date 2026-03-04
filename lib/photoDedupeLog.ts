/**
 * Per-batch PHOTO_DEDUPE summary: aggregate reused vs created, log once at batch end.
 * Cuts per-photo "[PHOTO_DEDUPE] reused=true" spam.
 */

let reused = 0;
let created = 0;

export function recordPhotoDedupe(reusedPhoto: boolean): void {
  if (reusedPhoto) reused++;
  else created++;
}

export function getDedupeStats(): { reused: number; created: number } {
  return { reused, created };
}

export function resetDedupeStats(): void {
  reused = 0;
  created = 0;
}
