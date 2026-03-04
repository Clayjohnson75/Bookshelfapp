/**
 * Standardize photo ID keys for maps and lookups so the UI never shows "0 books"
 * due to key mismatch (e.g. alias vs canonical, case, or whitespace).
 *
 * Rules:
 *   - Join must always use full UUIDs: photo.id exactly equals book.source_photo_id
 *     (after alias resolution). Never use id.slice(0, 8) or any prefix as a join key.
 *   - Map keys for photo→books / photo→count must use the same normalized full-UUID key everywhere.
 *   - normalizeId / canon: use for all join/map keys — KEEP FULL UUID (no truncation).
 *   - Shorten only when logging (e.g. key.slice(0, 8)), never as map keys or in join logic.
 */

const UUID_LEN = 36;
const UUID_HYPHEN = '-';

/**
 * Normalize an id for use as a map/join key. Same key for same logical id (case, trim).
 * KEEP FULL UUID — do not use 8-char prefixes or any truncation for keys.
 *
 * Use this (or toPhotoKey when you have an aliasMap) everywhere photo→book joins/maps are built or read.
 */
export function normalizeId(id?: string | null): string {
  return (id ?? '').trim().toLowerCase();
}

/**
 * Canonical photo ID for joins: full UUID only. Alias for normalizeId for clarity at call sites.
 * Never use slice(0, 8) or any prefix as a join key — use canon(id) everywhere.
 */
export const canon = normalizeId;

/**
 * Returns true if the string looks like a full UUID (length 36, contains '-').
 * Use to enforce that photo→books maps are never keyed by shortened or invalid ids.
 */
export function isPhotoKeyValid(key: string): boolean {
  return typeof key === 'string' && key.length === UUID_LEN && key.includes(UUID_HYPHEN);
}

/**
 * Normalize a photo ID for use as a map key. Resolves through aliasMap then normalizes
 * so alias and canonical id produce the same key. Never truncates (full UUID).
 *
 * @param photoId - Raw id (may be alias or full UUID from book.source_photo_id / photo.id)
 * @param aliasMap - Optional local→canonical map (e.g. photoIdAliasRef.current)
 * @returns Normalized full id to use as key: normalizeId(aliasMap[photoId] ?? photoId)
 */
export function toPhotoKey(
  photoId: string | undefined | null,
  aliasMap?: Record<string, string> | null
): string {
  const id = (photoId ?? '').trim();
  if (!id) return '';
  const resolved = aliasMap?.[id] ?? id;
  return normalizeId(resolved);
}
