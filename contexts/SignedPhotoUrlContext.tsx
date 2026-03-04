import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/SimpleAuthContext';
import { getSignedPhotoUrl } from '../lib/photoUrls';
import { usePhotoSignedUrlPersistRef } from './PhotoSignedUrlPersistContext';

/** Map photoId -> signed URL so React state updates trigger re-renders. Never mutate the map; use setSignedUrl. */
type SignedPhotoUrlContextType = {
  signedUrlMap: Record<string, string>;
  setSignedUrl: (photoId: string, url: string) => void;
  /** Fetch signed URL for photo if not already in map; writes to map on success. */
  ensureSignedUrl: (photoId: string, storagePath: string) => Promise<void>;
};

const SignedPhotoUrlContext = createContext<SignedPhotoUrlContextType | undefined>(undefined);

export function useSignedPhotoUrlMap(): SignedPhotoUrlContextType {
  const ctx = useContext(SignedPhotoUrlContext);
  if (!ctx) {
    return {
      signedUrlMap: {},
      setSignedUrl: () => {},
      ensureSignedUrl: async () => {},
    };
  }
  return ctx;
}

const SIGNED_URL_EXPIRY_SEC = 60 * 60 * 24 * 365; // 1 year — matches PhotoTile expiry

export const SignedPhotoUrlProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [signedUrlMap, setSignedUrlMap] = useState<Record<string, string>>({});
  const mapRef = useRef<Record<string, string>>({});
  mapRef.current = signedUrlMap;
  const { user } = useAuth();
  const prevUidRef = useRef<string | undefined>(undefined);
  const persistRef = usePhotoSignedUrlPersistRef();
  /** In-flight fetch set: prevents duplicate concurrent requests for the same photoId. */
  const pendingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const uid = user?.uid;
    if (prevUidRef.current !== uid) {
      prevUidRef.current = uid;
      setSignedUrlMap({});
      pendingRef.current.clear();
    }
  }, [user?.uid]);

  // ✅ Always setState so React re-renders. Never: signedUrlMap[photoId] = url (no re-render).
  const setSignedUrl = useCallback((photoId: string, url: string) => {
    setSignedUrlMap((prev) => {
      if (prev[photoId] === url) return prev;
      return { ...prev, [photoId]: url };
    });
  }, []);

  const ensureSignedUrl = useCallback(async (photoId: string, storagePath: string) => {
    if (mapRef.current[photoId]) return;
    if (!storagePath?.trim()) return;
    // Deduplicate: if a fetch is already in-flight for this photoId, skip — the first one will update state for all tiles.
    if (pendingRef.current.has(photoId)) return;
    pendingRef.current.add(photoId);
    try {
      const url = await getSignedPhotoUrl(storagePath.trim(), SIGNED_URL_EXPIRY_SEC);
      setSignedUrl(photoId, url);
      persistRef?.current?.(photoId, url, SIGNED_URL_EXPIRY_SEC);
    } catch {
      // Tile can retry via retryKey or effect re-run
    } finally {
      pendingRef.current.delete(photoId);
    }
  }, [setSignedUrl, persistRef]);

  return (
    <SignedPhotoUrlContext.Provider value={{ signedUrlMap, setSignedUrl, ensureSignedUrl }}>
      {children}
    </SignedPhotoUrlContext.Provider>
  );
};
