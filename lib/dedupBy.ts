import type { Photo } from '../types/BookTypes';

/**
 * Deduplicate items by a stable key; later entries win.
 * Use when merging lists (e.g. photos) to enforce uniqueness.
 */
export function dedupBy<T>(items: T[], keyFn: (t: T) => string): T[] {
  const m = new Map<string, T>();
  for (const it of items) m.set(keyFn(it), it);
  return [...m.values()];
}

/**
 * Derive a canonical storage path for identity (same for local + remote).
 * - If storage_path exists, normalize it (strip leading slashes).
 * - If uri is a Supabase public URL, derive bucket/path from it.
 */
function canonicalStoragePath(p: Photo): string | null {
  if (p.storage_path) return p.storage_path.replace(/^\/+/, '').replace(/^photos\//, 'photos/');

  const u = p.uri ?? '';
  const m = u.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (m) {
    const bucket = m[1];
    const path = m[2].replace(/^\/+/, '');
    return `${bucket}/${path}`;
  }

  return null;
}

/**
 * Stable key for a photo for deduplication. Prefer id so every capture/import keeps its own row (no dedupe by content).
 * Each library photo must have a unique ID per capture; never collapse two photos with different ids based on hash.
 */
export function photoStableKey(p: Photo): string {
  if (p.id) return `id:${p.id}`;
  if (p.photoFingerprint) return `fp:${p.photoFingerprint}`;

  const sp = canonicalStoragePath(p);
  if (sp) return `sp:${sp}`;

  return `fallback:${p.jobId ?? 'local'}`;
}

/** Match method used when deduping photos (for [PHOTO_DEDUPE_CHECK] logging). */
export function photoStableKeyMatchMethod(key: string): 'hash' | 'filename' | 'id' | 'fallback' | 'none' {
  if (key.startsWith('fp:')) return 'hash';
  if (key.startsWith('sp:')) return 'filename';
  if (key.startsWith('id:')) return 'id';
  if (key.startsWith('fallback:')) return 'fallback';
  return 'none';
}

/**
 * Canonical key for photo list rendering. Use for keyExtractor and to dedupe before render.
 * Prefer: remote id > canonicalPhotoId (id) > image_hash (photoFingerprint). Rule: if two items map to same key, only keep one.
 */
export function canonicalPhotoListKey(p: Photo): string {
  return p.id ?? p.photoFingerprint ?? p.jobId ?? (String(p.timestamp ?? '') || 'photo');
}

/**
 * Merge local + remote photos by stable id (photoId). Prefer remote when same id; keep local-only so we never drop local accepted.
 * Never replace with server snapshot: local-only items (e.g. just-accepted, not yet on server) are kept.
 * Cleanup may only remove state in ('captured','pending') and only if never persisted server-side; never touch accepted.
 */
export function mergePhotosPreferRemote(local: Photo[], remote: Photo[]): Photo[] {
  const remoteIds = new Set(remote.map(p => p.id).filter(Boolean));
  const localOnly = local.filter(p => !(p.id && remoteIds.has(p.id)));
  return dedupBy([...remote, ...localOnly], photoStableKey);
}

/**
 * Merge local + remote photos; prefer local when same key (e.g. during approval grace window so just-accepted photo is not overwritten).
 */
export function mergePhotosPreferLocal(local: Photo[], remote: Photo[]): Photo[] {
  const localKeys = new Set(local.map(photoStableKey));
  const remoteOnly = remote.filter(p => !localKeys.has(photoStableKey(p)));
  return dedupBy([...local, ...remoteOnly], photoStableKey);
}

/** True if the string is a displayable URI (Image can render it). */
function isDisplayableUri(u: string | null | undefined): boolean {
  if (!u || typeof u !== 'string') return false;
  const t = u.trim();
  return t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://');
}

/** Status precedence: never downgrade complete/uploaded/uploading -> draft. complete=4, uploaded=3, processing=2.5, stalled=2, uploading=1.5, draft=1, else 0. */
function statusRank(s: string | null | undefined): number {
  if (s === 'complete') return 4;
  if (s === 'uploaded') return 3;
  if (s === 'processing') return 2.5;
  if (s === 'stalled') return 2;
  if (s === 'uploading') return 1.5;
  if (s === 'local_pending' || s === 'draft') return 1;
  return 0;
}

/**
 * Resolve photo id to canonical (e.g. via alias map). When merging, always match by canonical id
 * so the same photo isn't treated as two (complete vs draft) due to alias vs canonical id.
 */
export type ResolveToCanonicalId = (id: string) => string;

/**
 * After merging local + remote photos: server row is DB truth, but we MUST preserve client-only fields
 * (deep merge, not replace). Match identity by: canonical id, else storage_path, else photo_hash,
 * so we don't miss the same photo when one side has alias id and the other canonical.
 * Output photos with canonical id when resolveToCanonicalId is provided.
 */
export function mergePreserveLocalUris(
  merged: Photo[],
  local: Photo[],
  resolveToCanonicalId?: ResolveToCanonicalId
): Photo[] {
  const resolve = resolveToCanonicalId ?? ((id: string) => id);

  const localByCanonicalId = new Map<string, Photo>();
  const localByStoragePath = new Map<string, Photo>();
  const localByHash = new Map<string, Photo>();
  for (const p of local) {
    const canonicalId = p.id ? resolve(p.id) : p.id;
    if (canonicalId) localByCanonicalId.set(canonicalId, p);
    const sp = canonicalStoragePath(p);
    if (sp) localByStoragePath.set(sp, p);
    const hash = (p as Photo & { photoFingerprint?: string }).photoFingerprint;
    if (hash && typeof hash === 'string' && hash.trim()) localByHash.set(hash.trim(), p);
  }

  const findPrev = (server: Photo): Photo | undefined => {
    const canonicalId = server.id ? resolve(server.id) : undefined;
    if (canonicalId) {
      const byId = localByCanonicalId.get(canonicalId);
      if (byId) return byId;
    }
    const sp = canonicalStoragePath(server);
    if (sp) {
      const byPath = localByStoragePath.get(sp);
      if (byPath) return byPath;
    }
    const hash = (server as Photo & { photoFingerprint?: string }).photoFingerprint;
    if (hash && typeof hash === 'string' && hash.trim()) {
      const byHash = localByHash.get(hash.trim());
      if (byHash) return byHash;
    }
    return undefined;
  };

  const enforceStorageImpliesComplete = (photo: Photo): Photo =>
    photo.storage_path?.trim?.() ? { ...photo, status: 'complete' as const } : photo;

  const result = merged.map((p) => {
    if (!p.id) return enforceStorageImpliesComplete(p);
    const server = p;
    const canonicalId = resolve(server.id);
    const prevLocal = findPrev(server);

    const prev = prevLocal as (Photo & { localThumbUri?: string; fallbackUri?: string; thumbnailUri?: string; local_uri?: string }) | undefined;
    const serverHasStorage = !!(server.storage_path && typeof server.storage_path === 'string' && server.storage_path.trim());
    const out: Photo & { localThumbUri?: string; fallbackUri?: string; thumbnailUri?: string; local_uri?: string } = {
      ...server,
      id: canonicalId,
      // Preserve signed_url from prev even when expired so tile can regenerate on-demand (do not clear the tile).
      signed_url: server.signed_url ?? prev?.signed_url ?? undefined,
      signed_url_expires_at: server.signed_url_expires_at ?? prev?.signed_url_expires_at ?? undefined,
      localThumbUri: (server as { localThumbUri?: string }).localThumbUri ?? prev?.localThumbUri ?? undefined,
      thumbnailUri: (server as { thumbnailUri?: string }).thumbnailUri ?? prev?.thumbnailUri ?? undefined,
      fallbackUri: (server as { fallbackUri?: string }).fallbackUri ?? prev?.fallbackUri ?? undefined,
      local_uri: serverHasStorage ? (server as { local_uri?: string }).local_uri : (prev?.local_uri ?? (server as { local_uri?: string }).local_uri),
    };

    out.storage_path = server.storage_path ?? prev?.storage_path ?? server.storage_path;
    const mergedStoragePath = out.storage_path;

    const serverRank = statusRank(server.status);
    const prevRank = statusRank(prev?.status);
    out.status = serverRank >= prevRank ? server.status : (prev?.status ?? server.status);
    if (mergedStoragePath?.trim?.()) out.status = 'complete';
    // When server has no storage_path, keep local status (uploading/uploaded) — do not drop to draft.
    if (!serverHasStorage && prev && (prev.status === 'uploading' || prev.status === 'uploaded' || prev.status === 'local_pending')) {
      out.status = prev.status === 'uploaded' ? 'complete' : prev.status;
    }

    const hasDisplayableUri =
      isDisplayableUri(server.uri) || isDisplayableUri(server.thumbnail_uri) ||
      isDisplayableUri(out.thumbnailUri) || isDisplayableUri(out.fallbackUri) || isDisplayableUri(out.localThumbUri);
    if (!hasDisplayableUri && prev) {
      if (prev.uri) out.uri = out.uri && isDisplayableUri(out.uri) ? out.uri : prev.uri;
      if (prev.thumbnail_uri != null) out.thumbnail_uri = (out.thumbnail_uri && isDisplayableUri(out.thumbnail_uri)) ? out.thumbnail_uri : prev.thumbnail_uri;
      if (prev.local_uri) (out as Photo & { local_uri?: string }).local_uri = prev.local_uri;
    }

    return enforceStorageImpliesComplete(out);
  });

  // When using canonical id, server row and local alias row can both become same canonical id; keep one per id.
  if (resolveToCanonicalId) {
    const byCanonicalId = new Map<string, Photo>();
    for (const photo of result) {
      const id = photo.id ?? '';
      if (id && !byCanonicalId.has(id)) byCanonicalId.set(id, photo);
    }
    return [...byCanonicalId.values()];
  }
  return result;
}

/**
 * One library photo per scan job. Restore/sync must not show multiple photos for the same job.
 * Keeps the first photo per jobId; photos without jobId are kept (keyed by id).
 */
export function dedupePhotosByJobId(photos: Photo[]): Photo[] {
  const byJobId = new Map<string, Photo>();
  const withoutJobId: Photo[] = [];
  for (const p of photos) {
    const jobId = p.jobId ?? (p as { jobId?: string }).jobId;
    if (jobId && typeof jobId === 'string' && jobId.trim()) {
      if (!byJobId.has(jobId)) byJobId.set(jobId, p);
    } else {
      withoutJobId.push(p);
    }
  }
  return [...byJobId.values(), ...withoutJobId];
}
