/**
 * Resolve book cover URI for display. When coverUrl is a storage path (photos bucket),
 * returns a signed URL; otherwise returns getBookCoverUri(book) (http or local path).
 */
import { useState, useEffect, useMemo } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { getSignedPhotoUrl } from '../lib/photoUrls';
import { isGoogleHotlink } from '../lib/coverUtils';
import type { Book } from '../types/BookTypes';

function getSyncCoverUri(book: Book): string | undefined {
  if (book.coverUrl) {
    const url = book.coverUrl.trim();
    if (isGoogleHotlink(url)) return undefined;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
  }
  if (book.localCoverPath && FileSystem.documentDirectory) {
    try {
      return `${FileSystem.documentDirectory}${book.localCoverPath}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True if book has a cover (http URL, local path, or storage path). Use with BookCoverImage. */
export function hasBookCover(book: Book): boolean {
  return !!(getSyncCoverUri(book) || isStoragePath(book));
}

/** True if coverUrl is a storage path (photos bucket) that needs signed URL. Export for "has cover" checks. */
export function isStoragePath(book: Book): boolean {
  return !!(
    book.coverUrl &&
    typeof book.coverUrl === 'string' &&
    book.coverUrl.trim().length > 0 &&
    !book.coverUrl.startsWith('http') &&
    !book.coverUrl.startsWith('file')
  );
}

/**
 * Returns [uri, loading]. Use uri for Image source; loading when resolving signed URL for storage path.
 */
export function useSignedBookCoverUri(book: Book | null | undefined): [string | undefined, boolean] {
  const syncUri = useMemo(() => (book ? getSyncCoverUri(book) : undefined), [book?.coverUrl, book?.localCoverPath]);
  const [signedUri, setSignedUri] = useState<string | null>(null);
  const needsSigned = book && !syncUri && isStoragePath(book);

  useEffect(() => {
    if (!needsSigned || !book?.coverUrl?.trim()) {
      setSignedUri(null);
      return;
    }
    let cancelled = false;
    getSignedPhotoUrl(book.coverUrl.trim())
      .then((url) => {
        if (!cancelled && url) setSignedUri(url);
      })
      .catch(() => {
        if (!cancelled) setSignedUri(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSigned, book?.coverUrl]);

  const uri = syncUri ?? (needsSigned ? signedUri ?? undefined : undefined);
  const loading = !!needsSigned && !signedUri && !syncUri;
  return [uri ?? undefined, loading];
}
