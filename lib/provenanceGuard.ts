/**
 * Provenance drift guard: do not run cleanup (delete orphan photos / prune) when
 * we've seen provenanceMissing > 0 this session. Prevents deleting canonical photos
 * or books when linkage (source_photo_id / source_scan_job_id) is inconsistent.
 *
 * Rule: Cleanup should only run after a "provenance integrity pass" succeeds.
 * Quick hard stop: if provenanceMissing > 0, skip all cleanup this session.
 */

let provenanceMissingThisSession = false;

/** Call when approve completes with provenanceMissing > 0. Disables cleanup for this session. */
export function setProvenanceMissingThisSession(): void {
  provenanceMissingThisSession = true;
}

/** Call when a provenance integrity pass succeeds (e.g. verified all books have source_photo_id/source_scan_job_id). Enables cleanup again. */
export function clearProvenanceIntegrityPassSucceeded(): void {
  provenanceMissingThisSession = false;
}

/** True if we should skip cleanup this session (provenance was missing after approve). */
export function shouldSkipCleanup(): boolean {
  return provenanceMissingThisSession;
}
