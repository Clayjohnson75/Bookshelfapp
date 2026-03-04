/**
 * Cover URL utilities.
 * Never persist or render raw Google Books "content" image links - they expire,
 * fail in RN (non-browser client), and are not meant for hotlinking.
 */

/** Returns true if URL is a Google Books hotlink (unstable, not for persistence/display). */
export function isGoogleHotlink(url?: string): boolean {
  return !!url && url.includes('books.google.com');
}
