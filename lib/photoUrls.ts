/**
 * Signed URLs for the private photos bucket. storagePath is whatever you store in photos.storage_path (e.g. userId/somefile.jpg).
 *
 * Caching: Signed URLs are cached in memory for ~30 minutes (refresh 30s before expiry). That reduces:
 * - API calls to Supabase (createSignedUrl)
 * - Re-downloading the same image (fewer unique signed URLs = fewer GETs)
 * - Egress
 * Call clearSignedPhotoUrlCache() on sign-out / user switch.
 *
 * Auth: On failure that looks like expired/invalid JWT, we refresh the session and retry once.
 */
import { supabase } from './supabase';
import { logStorageUrlMode } from './securityBaseline';
import { logger } from '../utils/logger';

type CacheEntry = { url: string; expiresAt: number };
const signedUrlCache = new Map<string, CacheEntry>();
/** Photo-id-keyed cache so the same photo reuses its signed URL across mounts (e.g. scroll away and back). */
const signedUrlByPhotoIdCache = new Map<string, CacheEntry>();
type SignedPhotoTransform = {
  width?: number;
  height?: number;
  resize?: 'cover' | 'contain' | 'fill';
  quality?: number;
};

/** Refresh before expiry so we never serve an expired URL. Same path = same cached URL until ~30 min. */
const SAFETY_MS = 30_000;

/**
 * Get a signed URL for a photo object. Use for display and download; photos bucket is private.
 * @param storagePath - Value from photos.storage_path; must be canonical format from getCanonicalPhotoStoragePath (userId/photoId.jpg)
 * @param expiresInSec - Token lifetime in seconds (default 30 min)
 */
export async function getSignedPhotoUrl(
  storagePath: string,
  expiresInSec = 60 * 30,
  transform?: SignedPhotoTransform
): Promise<string> {
  const transformKey = transform ? JSON.stringify(transform) : '';
  const cacheKey = transformKey ? `${storagePath}::${transformKey}` : storagePath;
  const now = Date.now();
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAt - SAFETY_MS > now) return cached.url;

  const transformOptions = transform
    ? {
        transform: {
          width: transform.width,
          height: transform.height,
          resize: transform.resize ?? 'cover',
          quality: transform.quality ?? 70,
        },
      }
    : undefined;

  function doSign(): Promise<{ data: { signedUrl?: string }; error: { message?: string; status?: number } | null }> {
    return supabase.storage
      .from('photos')
      .createSignedUrl(storagePath, expiresInSec, transformOptions as any) as Promise<{
        data: { signedUrl?: string };
        error: { message?: string; status?: number } | null;
      }>;
  }

  let { data, error } = await doSign();

  const isAuthError = (e: { message?: string; status?: number } | null): boolean => {
    if (!e) return false;
    const msg = (e.message ?? '').toLowerCase();
    const status = (e as { status?: number }).status;
    return (
      status === 401 ||
      status === 403 ||
      msg.includes('jwt') ||
      msg.includes('session') ||
      msg.includes('expired') ||
      msg.includes('unauthorized') ||
      msg.includes('invalidjwt') ||
      msg.includes('token')
    );
  };

  let loggedSuccess = false;
  if (error && isAuthError(error)) {
    logger.warn('[PHOTO_SIGNED_URL]', {
      result: 'auth_failure',
      storagePath: storagePath.slice(0, 60),
      error: error.message ?? error,
      action: 'refreshing session and retrying once',
    });
    await supabase.auth.refreshSession();
    const retry = await doSign();
    data = retry.data;
    error = retry.error;
    if (!error && data?.signedUrl) {
      loggedSuccess = true;
      logger.info('[PHOTO_SIGNED_URL]', {
        result: 'ok_after_refresh',
        storagePath: storagePath.slice(0, 60),
        urlPrefix: data.signedUrl.slice(0, 50),
      });
    }
  }

  if (error || !data?.signedUrl) {
    logger.warn('[PHOTO_SIGNED_URL]', {
      result: 'error',
      storagePath: storagePath.slice(0, 60),
      error: error?.message ?? String(error),
    });
    throw new Error(
      `Failed to sign url for ${storagePath}: ${error?.message ?? 'unknown error'}`
    );
  }

  signedUrlCache.set(cacheKey, {
    url: data.signedUrl,
    expiresAt: now + expiresInSec * 1000,
  });

  logStorageUrlMode({ bucket: 'photos', mode: 'signed', expiresInSec, caller: 'getSignedPhotoUrl' });
  if (!loggedSuccess) {
    logger.info('[PHOTO_SIGNED_URL]', {
      result: 'ok',
      storagePath: storagePath.slice(0, 60),
      expiresInSec,
      urlPrefix: data.signedUrl.slice(0, 50),
    });
  }

  return data.signedUrl;
}

/**
 * Return a previously cached signed URL for this photo id, if valid.
 * PhotoTile should check this before kicking off getSignedPhotoUrl so remounts show the image immediately.
 */
export function getCachedSignedUrlForPhotoId(photoId: string): string | null {
  const entry = signedUrlByPhotoIdCache.get(photoId);
  if (!entry || entry.expiresAt - SAFETY_MS <= Date.now()) return null;
  return entry.url;
}

/**
 * Store a signed URL for this photo id so future renders (e.g. same tile remount) can use it without re-calling createSignedUrl.
 */
export function setCachedSignedUrlForPhotoId(photoId: string, url: string, expiresAt: number): void {
  signedUrlByPhotoIdCache.set(photoId, { url, expiresAt });
}

/** Call on sign-out / user switch so the next user doesn't see cached URLs from the previous session. */
export function clearSignedPhotoUrlCache(): void {
  signedUrlCache.clear();
  signedUrlByPhotoIdCache.clear();
}
