/**
 * Canonical photo ID registry — the authoritative in-memory mapping of
 * local (client-generated) photo IDs to the server's canonical photo ID.
 *
 * Rules:
 *   1. A "canonical" ID is any photo ID returned by the server as the
 *      deduplicated/authoritative row (hash match, job adoption, or
 *      23505 recovery).
 *   2. Local IDs that were never persisted to the DB must NEVER be treated
 *      as canonical and are safe to discard.
 *   3. Canonical IDs must NEVER be treated as cleanup-eligible.
 *
 * Usage:
 *   // On save/dedupe — called by savePhotoToSupabase for every path
 *   registerDedupe(localId, canonicalId);       // localId → canonicalId
 *   markCanonical(canonicalId);                  // protect canonical from cleanup
 *
 *   // At approve / patch time
 *   resolveCanonical(localId)                    // → canonicalId or localId
 *   isCanonical(photoId)                         // → true if this ID is protected
 *
 *   // At delete time
 *   getCanonicalInfo(photoId)                    // → { isCanonical, aliases }
 *
 *   // On sign-out / user switch
 *   clearCanonicalPhotoMap();
 */

/** localId → canonicalId. Also contains canonical → canonical (identity) for fast lookup. */
const dedupeMap = new Map<string, string>();

/** All IDs that ARE canonical rows in the DB. Never cleanup-eligible. */
const canonicalSet = new Set<string>();

/**
 * Record that `localId` was deduped to `canonicalId`.
 * Also marks `canonicalId` as protected.
 */
export function registerDedupe(localId: string, canonicalId: string): void {
  if (!localId || !canonicalId) return;
  dedupeMap.set(localId, canonicalId);
  markCanonical(canonicalId);
}

/**
 * Mark `photoId` as a canonical (server-persisted) row that must not be
 * treated as cleanup-eligible. Call this any time you successfully upsert
 * or confirm a photo row exists in the DB.
 */
export function markCanonical(photoId: string): void {
  if (!photoId) return;
  canonicalSet.add(photoId);
  dedupeMap.set(photoId, photoId);
}

/**
 * Resolve a photo ID through the dedupe map.
 * Returns the canonical ID if known, otherwise returns `photoId` unchanged.
 * Safe to call on any ID — if it's already canonical it returns itself.
 */
export function resolveCanonical(photoId: string): string {
  return dedupeMap.get(photoId) ?? photoId;
}

/**
 * Returns true if `photoId` is registered as a canonical server row.
 * Canonical IDs must never be auto-deleted or treated as orphans.
 */
export function isCanonical(photoId: string): boolean {
  return canonicalSet.has(photoId);
}

/**
 * Returns rich info about a photo ID for use in delete/audit logs:
 * - `isCanonical`: whether the ID is a protected server row
 * - `canonicalId`: what it resolves to (may equal photoId)
 * - `aliases`: any local IDs that map TO this canonical ID
 * - `isLocalOnly`: true if this ID has never been registered as canonical
 *   and is not present as a target in any dedupe mapping
 */
export function getCanonicalInfo(photoId: string): {
  isCanonical: boolean;
  canonicalId: string;
  aliases: string[];
  isLocalOnly: boolean;
} {
  const canonicalId = resolveCanonical(photoId);
  const aliases: string[] = [];
  for (const [local, canonical] of dedupeMap.entries()) {
    if (canonical === photoId && local !== photoId) aliases.push(local);
  }
  return {
    isCanonical: canonicalSet.has(photoId),
    canonicalId,
    aliases,
    isLocalOnly: !canonicalSet.has(photoId) && canonicalId === photoId,
  };
}

/**
 * Returns all local IDs that are NOT canonical — i.e. safe to discard from
 * local state once the canonical ID is confirmed.
 */
export function getLocalOnlyIds(): string[] {
  const result: string[] = [];
  for (const [local, canonical] of dedupeMap.entries()) {
    if (local !== canonical && !canonicalSet.has(local)) result.push(local);
  }
  return result;
}

/** Clear the registry on sign-out or user switch to prevent stale mappings. */
export function clearCanonicalPhotoMap(): void {
  dedupeMap.clear();
  canonicalSet.clear();
}

/** For debugging only — returns a snapshot of current state. */
export function __debugDumpCanonicalMap(): {
  dedupeMap: Record<string, string>;
  canonicalSet: string[];
} {
  return {
    dedupeMap: Object.fromEntries(dedupeMap),
    canonicalSet: [...canonicalSet],
  };
}
