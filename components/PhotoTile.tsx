/**
 * Photo tile: render from local_uri first, then signed_url, then request signed URL from storage_path.
 *
 * Display order (never "Loading thumbnail…" forever):
 * 1. photo.local_uri → render immediately.
 * 2. photo.signed_url (valid) → render.
 * 3. photo.storage_path → request signed_url and set it; while loading show spinner; on failure show "Tap to retry" overlay.
 * 4. Else → placeholder with "Uploading…" badge (tile still exists).
 * 5. status === 'failed_upload' → "Upload failed — tap to retry" overlay (pressable); keep tile visible.
 *
 * If signed_url fetch fails: retry with backoff; after retries show "Tap to retry" overlay (pressable).
 * When signed_url expires: regenerate on-demand (ensureSignedUrl); do not clear the tile.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { View, ActivityIndicator, StyleSheet, Text, Pressable } from 'react-native';
import { getSignedPhotoUrl, getCachedSignedUrlForPhotoId, setCachedSignedUrlForPhotoId } from '../lib/photoUrls';
import { useSignedPhotoUrlMap } from '../contexts/SignedPhotoUrlContext';
import { usePhotoSignedUrlPersistRef } from '../contexts/PhotoSignedUrlPersistContext';
import { logger } from '../utils/logger';
import type { ImageStyle } from 'react-native';

const SIGNED_URL_EXPIRY_SEC = 60 * 60 * 24 * 365; // 1 year — photos load even months after last sign-in

type Props = {
  photoId?: string | null;
  /** Client-only local file URI (photo.local_uri). Rendered first, always — never wait for signed URL when this exists. */
  localUri?: string | null;
  storagePath?: string | null;
  fallbackUri?: string | null;
  thumbnailUri?: string | null;
  thumb_uri?: string | null;
  localThumbUri?: string | null;
  uri?: string | null;
  storage_url?: string | null;
  signedUrl?: string | null;
  signedUrlExpiresAt?: number | null;
  status?: 'draft' | 'complete' | 'stalled' | 'local_pending' | 'failed_upload' | 'scan_failed' | string;
  style?: ImageStyle | ImageStyle[];
  contentFit?: 'cover' | 'contain' | 'fill' | 'none';
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  retryKey?: number;
  /** When status is failed_upload or scan_failed, call this on "tap to retry". */
  onRetryUpload?: () => void;
};

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const RESOLVE_TIMEOUT_MS = 20000; // Increased from 8s — sign-in bursts many concurrent requests

export function PhotoTile({
  photoId,
  localUri,
  storagePath,
  fallbackUri,
  thumbnailUri,
  thumb_uri,
  localThumbUri,
  uri,
  storage_url,
  signedUrl: signedUrlProp,
  signedUrlExpiresAt,
  status,
  style,
  contentFit = 'cover',
  thumbnailWidth,
  thumbnailHeight,
  retryKey = 0,
  onRetryUpload,
}: Props) {
  const { signedUrlMap, setSignedUrl, ensureSignedUrl } = useSignedPhotoUrlMap();
  const persistRef = usePhotoSignedUrlPersistRef();
  const [signedUri, setSignedUri] = useState<string | null>(() =>
    photoId ? getCachedSignedUrlForPhotoId(photoId) : null
  );
  const [resolving, setResolving] = useState(false);
  const [degraded, setDegraded] = useState(false);
  // When a local file:// URI fails (e.g. after reinstall or in Expo Go), skip all
  // local URIs and fall back to fetching the signed URL from Supabase storage.
  const [localFileFailed, setLocalFileFailed] = useState(false);
  const retryCountRef = useRef(0);
  const cancelledRef = useRef(false);
  // Use refs for dimensions so resolveSignedUrl doesn't recreate on every layout measurement,
  // which would cancel in-flight fetches and cause an infinite cancellation loop.
  const thumbnailWidthRef = useRef(thumbnailWidth);
  const thumbnailHeightRef = useRef(thumbnailHeight);
  thumbnailWidthRef.current = thumbnailWidth;
  thumbnailHeightRef.current = thumbnailHeight;

  const signedFromMap = photoId ? signedUrlMap[photoId] ?? null : null;
  const urlFromMap = signedFromMap;

  const resolveSignedUrl = useCallback(async () => {
    if (!storagePath || !storagePath.trim()) return;
    setResolving(true);
    setDegraded(false);
    const timeoutId = setTimeout(() => {
      if (cancelledRef.current) return;
      setDegraded(true);
      setResolving(false);
    }, RESOLVE_TIMEOUT_MS);
    try {
      const signed = await getSignedPhotoUrl(
        storagePath.trim(),
        SIGNED_URL_EXPIRY_SEC,
        thumbnailWidthRef.current && thumbnailHeightRef.current
          ? {
              width: Math.max(1, Math.round(thumbnailWidthRef.current)),
              height: Math.max(1, Math.round(thumbnailHeightRef.current)),
              resize: 'cover',
              quality: 70,
            }
          : undefined
      );
      if (!cancelledRef.current) {
        clearTimeout(timeoutId);
        logger.info('[PHOTO_SIGNED_URL_OK]', {
          photoId: photoId?.slice(0, 8),
          storagePath: storagePath ?? undefined,
          urlPrefix: signed.slice(0, 50),
        });
        const expiresAt = Date.now() + SIGNED_URL_EXPIRY_SEC * 1000;
        setSignedUri(signed);
        if (photoId) {
          setCachedSignedUrlForPhotoId(photoId, signed, expiresAt);
          setSignedUrl(photoId, signed);
          persistRef?.current?.(photoId, signed, SIGNED_URL_EXPIRY_SEC);
        }
        setResolving(false);
        setDegraded(false);
        retryCountRef.current = 0;
      }
    } catch {
      if (cancelledRef.current) return;
      clearTimeout(timeoutId);
      if (retryCountRef.current < MAX_RETRIES) {
        retryCountRef.current += 1;
        setTimeout(() => {
          if (!cancelledRef.current) resolveSignedUrl();
        }, RETRY_DELAY_MS * retryCountRef.current);
      } else {
        setDegraded(true);
        setResolving(false);
      }
    }
  }, [storagePath, photoId]); // eslint-disable-line react-hooks/exhaustive-deps — thumbnailWidth/Height accessed via refs to keep callback stable

  useEffect(() => {
    cancelledRef.current = false;
    retryCountRef.current = 0;
    // Reuse photo-id cache if present; otherwise we'll resolve and set state
    const cached = photoId ? getCachedSignedUrlForPhotoId(photoId) : null;
    setSignedUri(cached);
    setDegraded(false);
    if (cached && photoId) setSignedUrl(photoId, cached);

    if (!storagePath || !storagePath.trim()) {
      setResolving(false);
      return;
    }
    if (cached) {
      setResolving(false);
      return;
    }
    resolveSignedUrl();
    return () => {
      cancelledRef.current = true;
    };
    // NOTE: `degraded` intentionally excluded — including it caused an infinite loop:
    // fetch fails → setDegraded(true) → effect re-runs → setDegraded(false) → fetch starts → repeat.
    // Retry on failure is handled by the "Tap to retry" button calling resolveSignedUrl() directly.
  }, [storagePath, photoId, resolveSignedUrl, retryKey, setSignedUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // signed_url is first-class: when local URIs are null, tile must still render via signed_url.
  const signed_url = signedUrlProp;
  const signed_url_expires_at = signedUrlExpiresAt;
  const signedOk =
    !!signed_url &&
    typeof signed_url === 'string' &&
    signed_url.length > 0 &&
    (!signed_url_expires_at || signed_url_expires_at > Date.now());

  const cachedByPhotoId = photoId ? getCachedSignedUrlForPhotoId(photoId) : null;
  const signedCandidate =
    signedFromMap ?? urlFromMap ?? signedUri ?? cachedByPhotoId ?? null;

  // Order: local_uri first always, then other local URIs, then signed_url, then storage_url / map cache.
  // IMPORTANT: Use (x?.trim() || null) — NOT bare `x ??` — so empty strings ("") fall through to the
  // next candidate. photo.uri and photo.thumbnail_uri are stored as "" (not null) for synthetic/pending
  // photos and for DB rows where uri is null. Using `??` would treat "" as a valid URI and prevent the
  // fetched signed URL from ever being shown.
  const isLocalFileUri = (u: string | null | undefined) =>
    !!u?.trim() && (u.startsWith('file://') || (u.startsWith('/') && !u.startsWith('//')));
  const displayUri: string | null = localFileFailed
    ? // Local file missing — skip all file:// URIs and go straight to remote
      (signedOk ? signed_url : null) ??
      (storage_url?.trim() || null) ??
      signedCandidate ??
      null
    : (localUri?.trim() || null) ??
      (thumbnailUri?.trim() || null) ??
      (localThumbUri?.trim() || null) ??
      (thumb_uri?.trim() || null) ??
      (uri?.trim() || null) ??
      (fallbackUri?.trim() || null) ??
      (signedOk ? signed_url : null) ??
      (storage_url?.trim() || null) ??
      signedCandidate ??
      null;

  const displayUriSource: 'local' | 'signed' | 'none' =
    !displayUri
      ? 'none'
      : displayUri === localUri ||
        displayUri === thumbnailUri ||
        displayUri === localThumbUri ||
        displayUri === thumb_uri ||
        displayUri === uri ||
        displayUri === fallbackUri
        ? 'local'
        : 'signed';

  // When displayUri is null but storagePath exists: trigger fetch and show loading.
  // localFileFailed causes displayUri to be null (local URIs are excluded), so !displayUri already covers that case.
  const needsSignedUrl = !!storagePath?.trim() && !displayUri;
  useEffect(() => {
    if (photoId && storagePath?.trim() && !displayUri) {
      ensureSignedUrl(photoId, storagePath);
    }
  }, [photoId, storagePath, displayUri, ensureSignedUrl]);

  // Fetch when complete + storagePath but no valid persisted signed_url yet (ensures persist path runs).
  useEffect(() => {
    if (status === 'complete' && photoId && storagePath?.trim() && !signedOk) {
      ensureSignedUrl(photoId, storagePath);
    }
  }, [status, photoId, storagePath, signedOk, ensureSignedUrl]);

  // ph:// (and similar) cannot be rendered by <Image> directly; treat only http(s) and file:// as renderable.
  const isRenderableUri = (u: string) =>
    u.startsWith('https://') || u.startsWith('http://') || u.startsWith('file://');
  const safeUri =
    typeof displayUri === 'string' && isRenderableUri(displayUri.trim())
      ? displayUri.trim()
      : null;

  // Only fetch a new signed URL when we have storage_path and are not in degraded mode.
  const canFetchSignedUrl = !!storagePath && !degraded;

  // "Uploading" only when status is actually uploading (draft/stalled). Never when just waiting for signed URL.
  const isLocalUri =
    !!fallbackUri &&
    (fallbackUri.startsWith('file://') ||
      fallbackUri.startsWith('ph://') ||
      (fallbackUri.startsWith('/') && !fallbackUri.startsWith('//')));
  const isUploadFailed = status === 'failed_upload';
  const isScanFailed = status === 'scan_failed';
  const isFailed = isUploadFailed || isScanFailed;
  const isUploading =
    !isFailed &&
    (status === 'local_pending' ||
      status === 'uploading' ||
      status === 'draft' ||
      status === 'stalled' ||
      (status == null && isLocalUri && !storagePath));
  logger.cat('[PHOTO_TILE_URI]', '', {
    photoId: (photoId ?? '').slice(0, 8),
    status,
    hasStoragePath: !!storagePath,
    hasSignedUrl: !!signed_url,
    signedOk,
    displayUriSource,
    displayUriPrefix: displayUri?.slice(0, 30) ?? null,
    degraded,
    safeUriPrefix: safeUri ? safeUri.slice(0, 60) : null,
  }, 'trace');

  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width === 0 || height === 0) {
          logger.warn('[PHOTO_TILE_ZERO_LAYOUT]', {
            photoId: (photoId ?? '').slice(0, 8),
            width,
            height,
          });
        }
      }}
      style={[{ overflow: 'hidden' }, style as any]}
    >
      {/* Base: neutral placeholder always present so tile + count badge never wait on image */}
      <View style={[StyleSheet.absoluteFill, _styles.placeholder]} />
      {/* Image on top when we have a URI; load/error don't block the tile */}
      {safeUri ? (
        <Image
          key={safeUri ?? photoId ?? ''}
          source={{ uri: safeUri }}
          style={StyleSheet.absoluteFill}
          cachePolicy="memory-disk"
          contentFit="cover"
          onError={(e) => {
            logger.warn('[PHOTO_THUMB_ERROR]', {
              photoId: (photoId ?? '').slice(0, 8),
              uri: safeUri?.slice(0, 120),
              err: (e as { nativeEvent?: unknown })?.nativeEvent,
            });
            // Local file missing (reinstall / Expo Go sandbox / container change).
            // Fall back to fetching the signed URL from Supabase storage.
            if (safeUri?.startsWith('file://') || (safeUri?.startsWith('/') && !safeUri?.startsWith('//'))) {
              setLocalFileFailed(true);
              if (photoId && storagePath) ensureSignedUrl(photoId, storagePath);
            }
          }}
          onLoad={() =>
            logger.info('[PHOTO_THUMB_LOADED]', {
              photoId: (photoId ?? '').slice(0, 8),
              uri: safeUri?.slice(0, 80),
            })
          }
        />
      ) : null}
      {/* Loading when no URI yet but we have storagePath — show spinner only while resolving; never "Loading…" forever */}
      {needsSignedUrl && !degraded && (
        <View style={_styles.placeholderHint} pointerEvents="none">
          <ActivityIndicator size="small" color="rgba(255,255,255,0.8)" />
          <Text style={_styles.loadingThumbText} numberOfLines={1}>Loading…</Text>
        </View>
      )}
      {/* Signed URL fetch failed: show Tap to retry overlay (retry with backoff already ran) */}
      {needsSignedUrl && degraded && (
        <Pressable
          style={_styles.tapToRetryOverlay}
          onPress={() => {
            retryCountRef.current = 0;
            setDegraded(false);
            resolveSignedUrl();
          }}
        >
          <Text style={_styles.tapToRetryText}>Tap to retry</Text>
        </Pressable>
      )}
      {/* Uploading overlay: centered spinner + label over the photo tile */}
      {isUploading && (
        <View style={_styles.uploadingOverlay} pointerEvents="none">
          <ActivityIndicator size="small" color="#fff" />
          <Text style={_styles.uploadingLabel}>Uploading</Text>
        </View>
      )}
      {/* Upload/scan failed: keep tile visible, show "Upload failed — Retry" (or scan_failed message) */}
      {isFailed && (
        <Pressable
          style={_styles.tapToRetryOverlay}
          onPress={() => onRetryUpload?.()}
        >
          <Text style={_styles.uploadFailedText} numberOfLines={2}>
            {isUploadFailed ? 'Upload failed — Retry' : 'Failed — tap to retry'}
          </Text>
        </Pressable>
      )}
      {/* Resolving overlay: signed URL in flight but we already have a fallback image to show */}
      {!!storagePath && resolving && !signedUri && !!fallbackUri && (
        <View style={_styles.resolvingOverlay} pointerEvents="none" />
      )}
    </View>
  );
}

const _styles = StyleSheet.create({
  placeholder: {
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderHint: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 12,
  },
  uploadingLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  loadingThumbBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  loadingThumbText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
  },
  resolvingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  tapToRetryOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  tapToRetryText: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  uploadFailedText: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 8,
    textAlign: 'center',
  },
});
