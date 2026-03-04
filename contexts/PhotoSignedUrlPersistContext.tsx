import React, { createContext, useContext, useRef } from 'react';

/**
 * When getSignedPhotoUrl(storagePath) succeeds, call this to persist the URL on the photo
 * in state and AsyncStorage. Hard rule: if photo.storage_path exists, the tile must render
 * via a signed URL; do not rely on local file:// surviving navigation.
 */
export type UpsertPhotoSignedUrlFn = (
  photoId: string,
  signedUrl: string,
  expiresInSec: number
) => void;

const PhotoSignedUrlPersistContext = createContext<React.MutableRefObject<UpsertPhotoSignedUrlFn | null> | null>(null);

export function usePhotoSignedUrlPersistRef(): React.MutableRefObject<UpsertPhotoSignedUrlFn | null> | null {
  return useContext(PhotoSignedUrlPersistContext);
}

/** Call this when you have a new signed URL so it gets persisted on the photo (state + AsyncStorage). */
export function usePhotoSignedUrlPersist(): UpsertPhotoSignedUrlFn | null {
  const ref = usePhotoSignedUrlPersistRef();
  return ref?.current ?? null;
}

export const PhotoSignedUrlPersistRefProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const persistRef = useRef<UpsertPhotoSignedUrlFn | null>(null);
  return (
    <PhotoSignedUrlPersistContext.Provider value={persistRef}>
      {children}
    </PhotoSignedUrlPersistContext.Provider>
  );
};
