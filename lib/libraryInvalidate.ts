/**
 * Global event: library data is stale and should refresh (e.g. scan job went terminal).
 * ScansTab + MyLibraryTab subscribe and trigger loadUserData so the UI updates immediately
 * without waiting for tab focus.
 */

export type LibraryInvalidatePayload = {
  reason: 'scan_terminal' | 'approve';
  jobId?: string;
  photoId?: string;
  bookCount?: number;
};

type Subscriber = (payload: LibraryInvalidatePayload) => void;

const subscribers = new Set<Subscriber>();

export function subscribeLibraryInvalidate(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function emitLibraryInvalidate(payload: LibraryInvalidatePayload): void {
  subscribers.forEach(fn => {
    try {
      fn(payload);
    } catch (e) {
      if (__DEV__) console.warn('[LIBRARY_INVALIDATE] subscriber threw', e);
    }
  });
}
