import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
 View,
 Text,
 StyleSheet,
 Modal,
 ScrollView,
 TouchableOpacity,
 Image,
 ActivityIndicator,
 Alert,
 TextInput,
 Share,
 useWindowDimensions,
 InteractionManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, Photo, Folder } from '../types/BookTypes';
import { PhotoTile } from '../components/PhotoTile';
import { useAuth, isGuestUser } from '../auth/SimpleAuthContext';
import { supabase } from '../lib/supabase';
import { isGoogleHotlink } from '../lib/coverUtils';
import { getApiBaseUrl } from '../lib/getEnvVar';
import { getStableBookKey } from '../lib/bookKey';
import { logger } from '../utils/logger';
import { useCoverUpdate } from '../contexts/CoverUpdateContext';
import { ChevronUpIcon, ChevronDownIcon, FolderOpenIcon, ChevronForwardIcon, ShareOutlineIcon, TrashIcon } from './Icons';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeTokens } from '../theme/tokens';
import { AppHeader } from './AppHeader';

/** Supabase books.id is UUID. Only book.dbId is the true DB id; book.id may be local. Never send local id to enrich. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(s: string | undefined): boolean {
 return typeof s === 'string' && UUID_REGEX.test(s);
}
/** Returns the book's DB row id only (from server). Never returns local/composite id. */
function getServerBookId(book: Book): string | null {
 if (book.dbId && isUuid(book.dbId)) return book.dbId;
 return null;
}

interface BookDetailModalProps {
 visible: boolean;
 book: Book | null;
 photo: Photo | null;
 onClose: () => void;
 onRemove?: () => void; // Callback to refresh library after removal
 onDeleteBook?: (book: Book) => Promise<void>; // Callback to delete book (used by LibraryView)
 onBookUpdate?: (updatedBook: Book) => void; // Callback to update book data (e.g., when description is fetched)
 onEditBook?: (updatedBook: Book) => void; // Callback to update book (for cover changes)
 onAddBookToFolder?: () => void;
 onRequestSync?: () => void | Promise<void>; // Call when enrich needs dbId/bookKey (e.g. "Needs sync")
 /** When guest tries to persist (e.g. save cover), show auth gate instead */
 onRequireAuth?: () => void;
 folders?: Folder[];
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
 visible,
 book,
 photo,
 onClose,
 onRemove,
 onDeleteBook,
 onBookUpdate,
 onEditBook,
 onAddBookToFolder,
 onRequestSync,
 onRequireAuth,
 folders = [],
}) => {
 const { user } = useAuth();
 const { t } = useTheme();
 const { width: windowWidth } = useWindowDimensions();
 const screenWidth = windowWidth || 375;
 const styles = React.useMemo(() => getStyles(t, screenWidth), [t, screenWidth]);
 const { setCoverUpdateActive } = useCoverUpdate();
 const [description, setDescription] = useState<string | null>(null);
 const [loadingDescription, setLoadingDescription] = useState(false);
 const [removing, setRemoving] = useState(false);
 const [isRead, setIsRead] = useState(false);
 const [togglingRead, setTogglingRead] = useState(false);
 const [showCoverOptions, setShowCoverOptions] = useState(false);
 const [showReplaceCoverModal, setShowReplaceCoverModal] = useState(false);
 const [showScanPhoto, setShowScanPhoto] = useState(false);
 const [coverSearchResults, setCoverSearchResults] = useState<Array<{googleBooksId: string, coverUrl?: string}>>([]);
 const [isLoadingCovers, setIsLoadingCovers] = useState(false);
 const [updatingCover, setUpdatingCover] = useState(false);
 const [isHandlingPhoto, setIsHandlingPhoto] = useState(false); // Guard to prevent multiple simultaneous calls
 const [needsSyncForEnrich, setNeedsSyncForEnrich] = useState(false);

 // Stable id for this book (key all load/display by this so we don't show stale data when book changes)
 const bookId = book?.id ?? book?.dbId ?? null;
 const prevBookIdRef = useRef<string | null>(null);

 // Reset local state when the book id changes so we never show the previous book's data
 useEffect(() => {
 if (!visible) return;
 if (bookId !== prevBookIdRef.current) {
 prevBookIdRef.current = bookId ?? null;
 setDescription(null);
 setLoadingDescription(true);
 setIsRead(false);
 setNeedsSyncForEnrich(false);
 setShowScanPhoto(false);
 }
 }, [visible, bookId]);

 /** Call server to enrich description. Send dbId when present; also send book_key (and title/author) when available so server can fall back to (user_id, book_key) or upsert stub when id is missing in DB (e.g. DB wiped / devprod mismatch). Never send local id. */
 const triggerEnrichDescription = useCallback(async (dbId: string | null, bookKey: string | null) => {
 if (!book || !user) return;
 const hasKey = bookKey && String(bookKey).trim();
 const hasDbId = dbId && isUuid(dbId);
 if (!hasKey && !hasDbId) return;
 setLoadingDescription(true);
 try {
 const { data: { session } } = await supabase.auth.getSession();
 const token = session?.access_token;
 if (!token) {
 setLoadingDescription(false);
 setDescription(null);
 return;
 }
 const baseUrl = getApiBaseUrl();
 const endpoint = `${baseUrl}/api/books/enrich-description`;
 const supabaseRef = (() => {
 try {
 const supabaseUrl = ((supabase as any)?.supabaseUrl || process?.env?.EXPO_PUBLIC_SUPABASE_URL || process?.env?.SUPABASE_URL || '') as string;
 if (!supabaseUrl) return null;
 return new URL(supabaseUrl).hostname;
 } catch {
 return null;
 }
 })();
 console.info('[ENRICH_CONTEXT]', {
 env: typeof __DEV__ !== 'undefined' && __DEV__ ? 'dev' : 'prod',
 supabaseRef,
 apiBase: baseUrl,
 userId: user.uid,
 });
 const body: Record<string, unknown> = {};
 if (hasDbId) body.dbId = dbId!;
 if (hasKey) {
 body.book_key = bookKey!;
 if (book.title != null) body.title = book.title;
 if (book.author != null) body.author = book.author;
 if (book.isbn != null) body.isbn = book.isbn;
 }
 logger.info('[ENRICH_DESCRIPTION_REQUEST]', { endpoint, payload: body });
 const res = await fetch(endpoint, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
 body: JSON.stringify(body),
 });
 const data = await res.json().catch(() => ({}));
 const parsed = (data ?? {}) as Record<string, unknown>;
 const bookObj = parsed.book as { description?: string } | undefined;
 console.info('[ENRICH_PARSED_BODY]', {
 keys: Object.keys(parsed),
 typeof_description: typeof parsed.description,
 description_length: typeof parsed.description === 'string' ? parsed.description.length : null,
 book_description_length: bookObj?.description != null ? (typeof bookObj.description === 'string' ? bookObj.description.length : null) : undefined,
 });
 const returnedDescLen = typeof data?.description === 'string' ? data.description.trim().length : 0;
 const returnedStatus = (data?.enrichment_status ?? data?.status ?? (res.ok && data?.ok ? 'complete' : 'failed')) as string;
 const returnedSource = (data?.description_source ?? data?.source ?? null) as string | null;
 const returnedBookId = (data?.bookId ?? data?.id ?? null) as string | null;
 console.info('[ENRICH_DESCRIPTION_RESPONSE]', {
 httpStatus: res.status,
 ok: !!(res.ok && data?.ok),
 returnedDescLen,
 returnedStatus,
 returnedSource,
 returnedBookId,
 });
 if (!res.ok) {
 logger.warn('[ENRICH_DESCRIPTION_RESPONSE]', { status: res.status, statusText: res.statusText, body: data });
 }
 if (res.ok && data.ok) {
 const beforeDescLen = typeof book.description === 'string' ? book.description.trim().length : 0;
 const beforeStatus = book.enrichment_status ?? null;
 const resolvedBookId = data.bookId ?? data.id;
 const resolvedStatus = (data.enrichment_status ?? data.status ?? 'not_found') as Book['enrichment_status'];
 const updatedBook = {
 ...book,
 ...(resolvedBookId && { dbId: resolvedBookId }),
 ...(data.description != null && String(data.description).trim() ? { description: data.description, enrichment_status: 'complete' as const } : { enrichment_status: resolvedStatus }),
 };
 const afterDescLen = typeof updatedBook.description === 'string' ? updatedBook.description.trim().length : 0;
 const afterStatus = updatedBook.enrichment_status ?? null;
 if (data.description && String(data.description).trim()) {
 setDescription(cleanDescription(data.description));
 } else {
 setDescription(null);
 }
 let parentHasBook = false;
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 parentHasBook = true;
 }
 console.info('[BOOK_UPDATE_MERGE]', {
 dbId: updatedBook.dbId ?? null,
 before: { descLen: beforeDescLen, status: beforeStatus },
 after: { descLen: afterDescLen, status: afterStatus },
 parentHasBook,
 });
 } else {
 const beforeDescLen = typeof book.description === 'string' ? book.description.trim().length : 0;
 const beforeStatus = book.enrichment_status ?? null;
 const mergedFallback = { ...book, enrichment_status: 'failed' as const };
 if (onBookUpdate) {
 onBookUpdate(mergedFallback);
 }
 console.info('[BOOK_UPDATE_MERGE]', {
 dbId: book.dbId ?? null,
 before: { descLen: beforeDescLen, status: beforeStatus },
 after: { descLen: beforeDescLen, status: 'failed' },
 parentHasBook: !!onBookUpdate,
 });
 setDescription(null);
 }
 } catch (err) {
 console.error('Error enriching description:', err);
 if (onBookUpdate) {
 onBookUpdate({ ...book, enrichment_status: 'failed' });
 }
 setDescription(null);
 } finally {
 setLoadingDescription(false);
 }
 }, [book, user, onBookUpdate]);

 useEffect(() => {
 const loadReadStatus = async () => {
 if (!visible || !book || !user) {
 setIsRead(false);
 return;
 }

 // Try to load read status from Supabase first (for production sync)
 if (supabase) {
 try {
 const authorForQuery = book.author || '';
 const { data, error } = await supabase
 .from('books')
 .select('read_at')
 .eq('user_id', user.uid)
 .eq('title', book.title)
 .eq('author', authorForQuery)
 .maybeSingle();

 if (!error && data && data.read_at) {
 setIsRead(true);
 // Update the book object with the readAt from Supabase
 if (book) {
 book.readAt = data.read_at;
 }
 return;
 }
 } catch (error) {
 console.warn('Error loading read status from Supabase, using local:', error);
 }
 }

 // Fallback to local storage (book.readAt from AsyncStorage)
 setIsRead(!!book.readAt);
 };

 if (!visible || !book) {
 setDescription(null);
 setIsRead(false);
 setLoadingDescription(false);
 setNeedsSyncForEnrich(false);
 return;
 }

 // Keep initial render light; defer read/enrichment work until transition settles.
 let cancelled = false;
 const interactionTask = InteractionManager.runAfterInteractions(() => {
 if (cancelled) return;
 const dbId = getServerBookId(book);
 const bookKey = getStableBookKey(book);
 const inputDbId = book.dbId ?? null;
 const isDbIdUuid = isUuid(book.dbId);
 const hasBookKey = !!(bookKey && String(bookKey).trim().length > 0);
 const fallbackToBookKey = !isDbIdUuid && hasBookKey;
 console.info('[DESC_ID_RESOLUTION]', {
 input: { dbId: inputDbId },
 isUuid: isDbIdUuid,
 fallbackToBookKey,
 bookKeyPresent: hasBookKey,
 });
 const descriptionLength = typeof book.description === 'string' ? book.description.trim().length : 0;
 const hasDescription = descriptionLength > 0;
 const shouldAutoEnrich =
 !hasDescription &&
 (book.enrichment_status === 'pending' || (!book.enrichment_status && !book.description));
 console.info('[DESC_DETAIL_OPEN]', {
 title: book.title ?? null,
 author: book.author ?? null,
 localId: book.id,
 dbId: book.dbId ?? null,
 bookKey: bookKey ?? null,
 hasDbId: !!dbId,
 hasBookKey,
 descriptionLength,
 hasDescription,
 enrichmentStatus: book.enrichment_status,
 shouldAutoEnrich,
 // Metadata fields present on client object if DB has them but these are null, fix the DBclient mapping
 metadata: {
 publisher: book.publisher ?? null,
 publishedDate: book.publishedDate ?? null,
 pageCount: book.pageCount ?? null,
 language: book.language ?? null,
 subtitle: book.subtitle ?? null,
 printType: book.printType ?? null,
 googleBooksId: book.googleBooksId ?? null,
 averageRating: book.averageRating ?? null,
 ratingsCount: book.ratingsCount ?? null,
 categoriesLen: Array.isArray(book.categories) ? book.categories.length : null,
 },
 });

 loadReadStatus();

 // If book has description already, show it.
 if (hasDescription) {
 setDescription(cleanDescription(book.description));
 setLoadingDescription(false);
 setNeedsSyncForEnrich(false);
 } else if (shouldAutoEnrich) {
 if (dbId) {
 const payloadType = bookKey ? 'dbId+book_key' : 'dbId';
 console.info('[ENRICH_DESCRIPTION_TRIGGER]', {
 reason: 'no_desc_and_pending',
 payloadType,
 dbId: `${dbId.slice(0, 8)}...`,
 bookKey: bookKey ? `${bookKey.slice(0, 20)}...` : null,
 });
 setNeedsSyncForEnrich(false);
 // Always include book_key/title/author fallback with dbId when available.
 triggerEnrichDescription(dbId, bookKey);
 } else if (bookKey) {
 // dbId null (local-only): call enrich with book_key; server upserts stub by (user_id, book_key) when no row exists.
 console.info('[ENRICH_DESCRIPTION_TRIGGER]', {
 reason: 'no_desc_and_pending',
 payloadType: 'book_key',
 dbId: null,
 bookKey: `${bookKey.slice(0, 20)}...`,
 });
 setNeedsSyncForEnrich(false);
 triggerEnrichDescription(null, bookKey);
 } else {
 setNeedsSyncForEnrich(true);
 setDescription(null);
 setLoadingDescription(false);
 }
 } else {
 setDescription(null);
 setLoadingDescription(false);
 setNeedsSyncForEnrich(false);
 }
 });

 return () => {
 cancelled = true;
 interactionTask.cancel?.();
 };
 }, [visible, book, user, bookId, triggerEnrichDescription]);

 // Clean HTML from description
 const cleanDescription = (html: string): string => {
 if (!html) return '';
 
 // Replace HTML line breaks with newlines
 let cleaned = html.replace(/<br\s*\/?>/gi, '\n');
 cleaned = cleaned.replace(/<\/p>/gi, '\n\n');
 cleaned = cleaned.replace(/<\/div>/gi, '\n');
 
 // Remove all HTML tags
 cleaned = cleaned.replace(/<[^>]+>/g, '');
 
 // Decode HTML entities
 cleaned = cleaned.replace(/&nbsp;/g, ' ');
 cleaned = cleaned.replace(/&amp;/g, '&');
 cleaned = cleaned.replace(/&lt;/g, '<');
 cleaned = cleaned.replace(/&gt;/g, '>');
 cleaned = cleaned.replace(/&quot;/g, '"');
 cleaned = cleaned.replace(/&#39;/g, "'");
 cleaned = cleaned.replace(/&apos;/g, "'");
 cleaned = cleaned.replace(/&hellip;/g, '...');
 cleaned = cleaned.replace(/&mdash;/g, '');
 cleaned = cleaned.replace(/&ndash;/g, '');
 
 // Decode numeric HTML entities (e.g., &#8217;)
 cleaned = cleaned.replace(/&#(\d+);/g, (match, dec) => {
 return String.fromCharCode(parseInt(dec, 10));
 });
 
 // Decode hex HTML entities (e.g., &#x2019;)
 cleaned = cleaned.replace(/&#x([a-f\d]+);/gi, (match, hex) => {
 return String.fromCharCode(parseInt(hex, 16));
 });
 
 // Clean up extra whitespace
 cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n'); // Multiple newlines to double newline
 cleaned = cleaned.replace(/[ \t]+/g, ' '); // Multiple spaces to single space
 cleaned = cleaned.trim();
 
 return cleaned;
 };

 const handleToggleReadStatus = async () => {
 if (!book || !user) return;

 setTogglingRead(true);
 const newReadAt = isRead ? null : Date.now();
 
 try {
 // Update AsyncStorage (for offline/backwards compatibility)
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 
 // Find and update the book
 const updatedBooks = approvedBooks.map((b) => {
 // Match by title and author (or just title if author missing)
 const matchesTitle = b.title === book.title;
 const matchesAuthor = (!b.author && !book.author) || (b.author === book.author);
 
 if (matchesTitle && matchesAuthor) {
 // Toggle read status
 return {
 ...b,
 readAt: newReadAt || undefined,
 };
 }
 return b;
 });
 
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }
 
 // Save to Supabase for production cross-device sync
 if (supabase) {
 try {
 // Convert scannedAt to BIGINT (timestamp in milliseconds) for Supabase
 // scanned_at is BIGINT in database, not TIMESTAMPTZ
 const scannedAtValue = book.scannedAt 
 ? (typeof book.scannedAt === 'number' ? book.scannedAt : new Date(book.scannedAt).getTime())
 : null;

 // Upsert book read status to Supabase
 const bookData = {
 user_id: user.uid,
 title: book.title,
 author: book.author || null,
 isbn: book.isbn || null,
 confidence: book.confidence || null,
 status: book.status || 'approved',
 scanned_at: scannedAtValue, // BIGINT timestamp in milliseconds
 cover_url: book.coverUrl || null,
 local_cover_path: book.localCoverPath || null,
 google_books_id: book.googleBooksId || null,
 description: book.description || null,
 read_at: newReadAt, // This is the key field we're updating
 updated_at: new Date().toISOString(),
 };

 // Use upsert to insert or update based on user_id + title + author
 // First try to find existing book (handle null authors by using empty string)
 const authorForQuery = book.author || '';
 const { data: existingBook, error: findError } = await supabase
 .from('books')
 .select('id')
 .eq('user_id', user.uid)
 .eq('title', book.title)
 .eq('author', authorForQuery)
 .maybeSingle();

 if (findError) {
 console.warn('Error finding book in Supabase:', findError);
 }

 if (existingBook) {
 // Update existing book's read status
 const { error: updateError } = await supabase
 .from('books')
 .update({
 read_at: newReadAt,
 updated_at: new Date().toISOString(),
 })
 .eq('id', existingBook.id);
 
 if (updateError) {
 console.warn('Error updating in Supabase (will use local storage):', updateError);
 }
 } else {
 // Insert new book record with read status
 // Use empty string for null author to match unique constraint
 const insertData = {
 ...bookData,
 author: authorForQuery || null, // Store as null but query with empty string
 };
 
 const { error: insertError } = await supabase
 .from('books')
 .insert(insertData);
 
 if (insertError) {
 console.warn('Error inserting to Supabase (will use local storage):', insertError);
 }
 }
 } catch (supabaseError) {
 console.warn('Error connecting to Supabase (will use local storage):', supabaseError);
 // Continue anyway - local storage is updated
 }
 }
 
 // Update local state
 setIsRead(!isRead);
 
 // Update the book object if onRemove callback is available (to refresh parent)
 if (onRemove) {
 onRemove();
 }
 } catch (error) {
 console.error('Error toggling read status:', error);
 Alert.alert('Error', 'Failed to update read status');
 } finally {
 setTogglingRead(false);
 }
 };

 const handleRemoveFromLibrary = async () => {
 if (!book || !user) return;

 Alert.alert(
 'Remove from Library',
 `Are you sure you want to remove "${book.title}" from your library?`,
 [
 {
 text: 'Cancel',
 style: 'cancel',
 },
 {
 text: 'Remove',
 style: 'destructive',
 onPress: async () => {
 setRemoving(true);
 try {
 // Delete from Supabase first
 if (supabase) {
 try {
 const { deleteBookFromSupabase } = await import('../services/supabaseSync');
 await deleteBookFromSupabase(user.uid, book);
 console.log(' Book deleted from Supabase');
 } catch (supabaseError) {
 console.warn('Error deleting book from Supabase:', supabaseError);
 // Continue with local deletion even if Supabase fails
 }
 }
 
 // Remove from AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 // Remove book by matching ID first, then by title and author
 const updatedBooks = approvedBooks.filter((b) => {
 // Match by ID if both have IDs
 if (book.id && b.id && book.id === b.id) return false;
 // Match by title and author
 if (b.title === book.title && b.author === book.author) return false;
 return true;
 });
 
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 console.log(` Book removed from AsyncStorage. ${approvedBooks.length} -> ${updatedBooks.length} books`);
 }
 
 // Call the refresh callback if provided (this will reload from Supabase)
 if (onRemove) {
 onRemove();
 }
 
 // Close the modal
 onClose();
 
 Alert.alert('Success', 'Book removed from library');
 } catch (error) {
 console.error('Error removing book:', error);
 Alert.alert('Error', 'Failed to remove book from library');
 } finally {
 setRemoving(false);
 }
 },
 },
 ]
 );
 };

 const handleShareBook = useCallback(async () => {
 if (!book) return;
 try {
 const title = book.title?.trim() || 'Untitled';
 const author = book.author?.trim();
 const message = author ? `${title} by ${author}` : title;
 await Share.share({ title, message });
 } catch (error) {
 console.error('Error sharing book:', error);
 Alert.alert('Error', 'Failed to share this book');
 }
 }, [book]);

 const fetchBookDescription = async (googleBooksId: string) => {
 if (!book || !user) return;
 
 setLoadingDescription(true);
 try {
 // Use centralized service - it handles rate limiting and caching
 const { fetchBookData } = await import('../services/googleBooksService');
 const bookData = await fetchBookData(book.title, book.author, googleBooksId, book.isbn);
 
 if (bookData.description) {
 const cleanedDesc = cleanDescription(bookData.description);
 setDescription(cleanedDesc);
 
 // Save the description to the book object and persist it
 const updatedBook: Book = {
 ...book,
 description: bookData.description, // Save raw description (with HTML) for future use
 // Also update any other missing stats
 ...(bookData.pageCount !== undefined && !book.pageCount && { pageCount: bookData.pageCount }),
 ...(bookData.categories && !book.categories && { categories: bookData.categories }),
 ...(bookData.publisher && !book.publisher && { publisher: bookData.publisher }),
 ...(bookData.publishedDate && !book.publishedDate && { publishedDate: bookData.publishedDate }),
 ...(bookData.language && !book.language && { language: bookData.language }),
 ...(bookData.averageRating !== undefined && book.averageRating === undefined && { averageRating: bookData.averageRating }),
 ...(bookData.ratingsCount !== undefined && book.ratingsCount === undefined && { ratingsCount: bookData.ratingsCount }),
 ...(bookData.subtitle && !book.subtitle && { subtitle: bookData.subtitle }),
 ...(bookData.printType && !book.printType && { printType: bookData.printType }),
 };
 
 // Save to Supabase
 const { saveBookToSupabase } = await import('../services/supabaseSync');
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');
 
 // Save to AsyncStorage
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const storedApproved = await AsyncStorage.getItem(userApprovedKey);
 const approvedBooks: Book[] = storedApproved ? JSON.parse(storedApproved) : [];
 
 const updatedBooks = approvedBooks.map(b => 
 (b.id === book.id || (b.title === book.title && b.author === book.author))
 ? updatedBook
 : b
 );
 
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 } catch (storageError) {
 console.error('Error saving description to AsyncStorage:', storageError);
 }
 
 // Notify parent component if callback provided
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 }
 } else {
 setDescription(null);
 }
 } catch (error) {
 console.error('Error fetching book description:', error);
 setDescription(null);
 } finally {
 setLoadingDescription(false);
 }
 };

 const getBookCoverUri = (book: Book): string | undefined => {
 if (book.coverUrl) {
 const url = book.coverUrl.trim();
 if (isGoogleHotlink(url)) return undefined; // Never render Google hotlinks - they fail in RN
 if (url.startsWith('http://') || url.startsWith('https://')) return url;
 }
 // Fall back to local path only if no remote URL
 if (book.localCoverPath && FileSystem.documentDirectory) {
 try {
 const localPath = `${FileSystem.documentDirectory}${book.localCoverPath}`;
 return localPath;
 } catch (error) {
 console.warn('Error getting local cover path:', error);
 }
 }
 return undefined;
 };

 const handleCoverPress = () => {
 if (!book) return;
 setShowCoverOptions(true);
 };

 const handleRemoveCover = async () => {
 if (!book || !user) return;
 
 setShowCoverOptions(false);
 setUpdatingCover(true);
 
 try {
 const updatedBook: Book = {
 ...book,
 coverUrl: undefined,
 localCoverPath: undefined,
 };

 // Update in AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 const updatedBooks = approvedBooks.map(b => 
 (b.id === book.id || (b.title === book.title && b.author === book.author))
 ? updatedBook
 : b
 );
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }

 // Update in Supabase
 const { saveBookToSupabase } = await import('../services/supabaseSync');
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

 // Notify parent to update everywhere
 if (onEditBook) {
 onEditBook(updatedBook);
 }
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 }

 // Cover removed silently (no popup)
 } catch (error) {
 console.error('Error removing cover:', error);
 Alert.alert('Error', 'Failed to remove cover. Please try again.');
 } finally {
 setUpdatingCover(false);
 }
 };

 const handleReplaceCover = async () => {
 if (!book) return;
 
 setShowCoverOptions(false);
 setShowReplaceCoverModal(true);
 setIsLoadingCovers(true);
 setCoverSearchResults([]);

 try {
 const { searchMultipleBooks } = await import('../services/googleBooksService');
 // Search using only the book title to find alternative covers
 const results = await searchMultipleBooks(book.title, undefined, 20);
 
 // Filter to only show results with covers
 const resultsWithCovers = results
 .filter((r): r is typeof r & { googleBooksId: string } => Boolean(r.coverUrl && r.googleBooksId))
 .map(r => ({ googleBooksId: r.googleBooksId, coverUrl: r.coverUrl }));
 setCoverSearchResults(resultsWithCovers);
 } catch (error) {
 console.error('Error searching for covers:', error);
 Alert.alert('Error', 'Failed to search for covers. Please try again.');
 } finally {
 setIsLoadingCovers(false);
 }
 };

 const downloadAndCacheCover = async (coverUrl: string, googleBooksId: string): Promise<string | null> => {
 if (!FileSystem.documentDirectory) return null;
 
 try {
 const coversDir = `${FileSystem.documentDirectory}covers`;
 const dirInfo = await FileSystem.getInfoAsync(coversDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
 }

 const fileUri = `${coversDir}/${googleBooksId}.jpg`;
 const downloadResult = await FileSystem.downloadAsync(coverUrl, fileUri);
 
 if (downloadResult.uri) {
 // Return relative path
 return downloadResult.uri.replace(FileSystem.documentDirectory || '', '');
 }
 
 return null;
 } catch (error) {
 console.error('Error downloading cover:', error);
 return null;
 }
 };

 const handleSelectCover = async (selectedCover: {googleBooksId: string, coverUrl?: string}) => {
 if (!user || !book || !selectedCover.googleBooksId || !selectedCover.coverUrl) return;
 if (isGuestUser(user)) {
 onRequireAuth?.();
 return;
 }

 const bookId = getServerBookId(book) ?? book.id ?? 'unknown';
 logger.debug('[COVER_UPDATE] start', { bookId });
 setCoverUpdateActive(true);
 setUpdatingCover(true);

 try {
 const { fetchBookData, saveCoverToStorage } = await import('../services/googleBooksService');
 const bookData = await fetchBookData(book.title, book.author, selectedCover.googleBooksId, book.isbn);

 if (bookData.coverUrl) {
 // Save to our storage first (Google URLs expire; our URLs are stable and cached for everyone)
 let stableCoverUrl = bookData.coverUrl;
 const saved = await saveCoverToStorage({
 coverUrl: bookData.coverUrl,
 title: book.title,
 author: book.author,
 isbn: book.isbn,
 googleBooksId: selectedCover.googleBooksId,
 });
 if (saved?.coverUrl) stableCoverUrl = saved.coverUrl;

 const coverUri = await downloadAndCacheCover(stableCoverUrl, selectedCover.googleBooksId);
 
 const updatedBook: Book = {
 ...book,
 coverUrl: stableCoverUrl,
 localCoverPath: coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined,
 googleBooksId: selectedCover.googleBooksId,
 // Update other book data if available
 description: bookData.description || book.description,
 pageCount: bookData.pageCount || book.pageCount,
 categories: bookData.categories || book.categories,
 publisher: bookData.publisher || book.publisher,
 publishedDate: bookData.publishedDate || book.publishedDate,
 language: bookData.language || book.language,
 averageRating: bookData.averageRating || book.averageRating,
 ratingsCount: bookData.ratingsCount || book.ratingsCount,
 subtitle: bookData.subtitle || book.subtitle,
 };

 // Update in AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 const updatedBooks = approvedBooks.map(b => 
 (b.id === book.id || (b.title === book.title && b.author === book.author))
 ? updatedBook
 : b
 );
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }

 // Update in Supabase
 const { saveBookToSupabase } = await import('../services/supabaseSync');
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

 // Notify parent to update everywhere
 if (onEditBook) {
 onEditBook(updatedBook);
 }
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 }

 setShowReplaceCoverModal(false);
 Alert.alert('Cover Updated', 'The book cover has been updated everywhere.');
 }
 } catch (error) {
 console.error('Error updating cover:', error);
 Alert.alert('Error', 'Failed to update cover. Please try again.');
 } finally {
 setCoverUpdateActive(false);
 setUpdatingCover(false);
 }
 };

 const handleTakePhotoForCover = async () => {
 if (!user || !book) return;
 if (isGuestUser(user)) {
 onRequireAuth?.();
 return;
 }
 if (isHandlingPhoto || updatingCover) {
 console.log('Take photo handler: Already processing or invalid state', { isHandlingPhoto, updatingCover });
 return;
 }

 const bookId = getServerBookId(book) ?? book.id ?? 'unknown';
 logger.debug('[COVER_UPDATE] start', { bookId });
 setCoverUpdateActive(true);
 setIsHandlingPhoto(true);
 console.log('Take photo handler: Starting...');

 try {
 const { status } = await ImagePicker.requestCameraPermissionsAsync();
 if (status !== 'granted') {
 Alert.alert('Permission Required', 'Camera permission is required to take a photo of the book cover.');
 setIsHandlingPhoto(false);
 return;
 }

 console.log('Take photo handler: Launching camera...');
 const result = await ImagePicker.launchCameraAsync({
 mediaTypes: ImagePicker.MediaTypeOptions.Images,
 allowsEditing: true,
 aspect: [3, 4],
 quality: 0.8,
 });

 console.log('Take photo handler: Camera result', { canceled: result.canceled, hasAssets: !!result.assets?.[0] });
 
 if (!result.canceled && result.assets[0]) {
 setUpdatingCover(true);
 
 try {
 // Resize and optimize the image
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 result.assets[0].uri,
 [{ resize: { width: 600 } }],
 { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
 );

 // Save to local storage
 if (FileSystem.documentDirectory) {
 const coversDir = `${FileSystem.documentDirectory}covers`;
 const dirInfo = await FileSystem.getInfoAsync(coversDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
 }

 const fileName = `custom_${book.id || Date.now()}.jpg`;
 const fileUri = `${coversDir}/${fileName}`;
 
 // Copy the image to our covers directory
 await FileSystem.copyAsync({
 from: manipulatedImage.uri,
 to: fileUri,
 });

 const localCoverPath = fileUri.replace(FileSystem.documentDirectory || '', '');

 // Upload cover to Supabase Storage so it's accessible on the web
 const { uploadBookCoverToStorage, saveBookToSupabase } = await import('../services/supabaseSync');
 const bookId = getServerBookId(book) ?? `${book.title}_${book.author || ''}_${Date.now()}`;
 const uploadResult = await uploadBookCoverToStorage(user.uid, bookId, fileUri);
 
 // Use storage URL if upload succeeded, otherwise fall back to local path
 const coverUrl = uploadResult?.storagePath || uploadResult?.storageUrl || fileUri;

 const updatedBook: Book = {
 ...book,
 coverUrl: coverUrl, // Use storage URL for web access, or local path as fallback
 localCoverPath: localCoverPath,
 };

 // Update in AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 const updatedBooks = approvedBooks.map(b => 
 (b.id === book.id || (b.title === book.title && b.author === book.author))
 ? updatedBook
 : b
 );
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }

 // Update in Supabase (this will save the storage URL to cover_url)
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

 // Notify parent
 if (onEditBook) {
 onEditBook(updatedBook);
 }
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 }

 setShowReplaceCoverModal(false);
 Alert.alert('Cover Updated', 'Your photo has been set as the book cover everywhere.');
 }
 } catch (processingError) {
 console.error('Error processing photo for cover:', processingError);
 Alert.alert('Error', 'Failed to process photo. Please try again.');
 } finally {
 setUpdatingCover(false);
 }
 } else {
 console.log('Take photo handler: User canceled or no asset');
 }
 } catch (error) {
 console.error('Error taking photo for cover:', error);
 Alert.alert('Error', 'Failed to take photo. Please try again.');
 } finally {
 setCoverUpdateActive(false);
 setIsHandlingPhoto(false);
 setUpdatingCover(false);
 }
 };

 const handleUploadPhotoForCover = async () => {
 // Guard: Prevent multiple simultaneous calls
 if (isHandlingPhoto || updatingCover || !book || !user) {
 console.log('Upload photo handler: Already processing or invalid state', { isHandlingPhoto, updatingCover, hasBook: !!book, hasUser: !!user });
 return;
 }

 const bookId = getServerBookId(book) ?? book.id ?? 'unknown';
 logger.debug('[COVER_UPDATE] start', { bookId });
 setCoverUpdateActive(true);
 setIsHandlingPhoto(true);
 console.log('Upload photo handler: Starting...');

 try {
 const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
 if (status !== 'granted') {
 Alert.alert('Permission Required', 'Photo library permission is required to upload a photo.');
 setIsHandlingPhoto(false);
 return;
 }

 console.log('Upload photo handler: Launching image library...');
 const result = await ImagePicker.launchImageLibraryAsync({
 mediaTypes: ImagePicker.MediaTypeOptions.Images,
 allowsEditing: true,
 aspect: [3, 4],
 quality: 0.8,
 });

 console.log('Upload photo handler: Image library result', { canceled: result.canceled, hasAssets: !!result.assets?.[0] });
 
 if (!result.canceled && result.assets[0]) {
 setUpdatingCover(true);
 
 try {
 // Resize and optimize the image
 const manipulatedImage = await ImageManipulator.manipulateAsync(
 result.assets[0].uri,
 [{ resize: { width: 600 } }],
 { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
 );

 // Save to local storage
 if (FileSystem.documentDirectory) {
 const coversDir = `${FileSystem.documentDirectory}covers`;
 const dirInfo = await FileSystem.getInfoAsync(coversDir);
 if (!dirInfo.exists) {
 await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
 }

 const fileName = `custom_${book.id || Date.now()}.jpg`;
 const fileUri = `${coversDir}/${fileName}`;
 
 // Copy the image to our covers directory
 await FileSystem.copyAsync({
 from: manipulatedImage.uri,
 to: fileUri,
 });

 const localCoverPath = fileUri.replace(FileSystem.documentDirectory || '', '');

 // Upload cover to Supabase Storage so it's accessible on the web
 const { uploadBookCoverToStorage, saveBookToSupabase } = await import('../services/supabaseSync');
 const bookId = getServerBookId(book) ?? `${book.title}_${book.author || ''}_${Date.now()}`;
 const uploadResult = await uploadBookCoverToStorage(user.uid, bookId, fileUri);
 
 // Use storage URL if upload succeeded, otherwise fall back to local path
 const coverUrl = uploadResult?.storagePath || uploadResult?.storageUrl || fileUri;

 const updatedBook: Book = {
 ...book,
 coverUrl: coverUrl, // Use storage URL for web access, or local path as fallback
 localCoverPath: localCoverPath,
 };

 // Update in AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 const updatedBooks = approvedBooks.map(b => 
 (b.id === book.id || (b.title === book.title && b.author === book.author))
 ? updatedBook
 : b
 );
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }

 // Update in Supabase (this will save the storage URL to cover_url)
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

 // Notify parent to update everywhere
 if (onEditBook) {
 onEditBook(updatedBook);
 }
 if (onBookUpdate) {
 onBookUpdate(updatedBook);
 }

 setShowReplaceCoverModal(false);
 Alert.alert('Cover Updated', 'Your photo has been set as the book cover everywhere.');
 }
 } catch (processingError) {
 console.error('Error processing photo for cover:', processingError);
 Alert.alert('Error', 'Failed to process photo. Please try again.');
 } finally {
 setUpdatingCover(false);
 }
 } else {
 console.log('Upload photo handler: User canceled or no asset');
 }
 } catch (error) {
 console.error('Error uploading photo for cover:', error);
 Alert.alert('Error', 'Failed to upload photo. Please try again.');
 } finally {
 setCoverUpdateActive(false);
 setIsHandlingPhoto(false);
 setUpdatingCover(false);
 }
 };

 if (!visible) return null;

 // When visible but book not yet set (e.g. navigation param delay), show skeleton so UI never looks empty
 if (!book) {
 return (
 <Modal visible={visible} animationType="none" transparent={false} onRequestClose={onClose}>
 <SafeAreaView style={[styles.safeContainer, { backgroundColor: t.colors.bg }]} edges={['left','right','bottom']}>
 <AppHeader title="Book Details" onBack={onClose} />
 <ScrollView style={[styles.container, { backgroundColor: t.colors.bg }]} showsVerticalScrollIndicator={false}>
 <View style={styles.bookHeader}>
 <View style={[styles.bookCover, styles.placeholderCover]} />
 <View style={styles.bookInfo}>
 <View style={[styles.skeletonLine, styles.skeletonHeaderTitle]} />
 <View style={[styles.skeletonLine, styles.skeletonLineShort, styles.skeletonHeaderSub]} />
 <View style={[styles.skeletonLine, styles.skeletonHeaderSub]} />
 </View>
 </View>
 </ScrollView>
 </SafeAreaView>
 </Modal>
 );
 }

 const canRetryEnrich = Boolean(
 book.enrichment_status === 'failed' && (getServerBookId(book) || (getStableBookKey(book) && (book.title ?? book.author)))
 );
 const trimmedDescription = typeof description === 'string' ? description.trim() : '';
 const infoRows = [
 book.language?.trim() ? { label: 'Language', value: book.language.trim().toUpperCase() } : null,
 book.publisher?.trim() ? { label: 'Publisher', value: book.publisher.trim() } : null,
 book.isbn?.trim() ? { label: 'ISBN', value: book.isbn.trim() } : null,
 typeof book.pageCount === 'number' && book.pageCount > 0 ? { label: 'Pages', value: book.pageCount.toLocaleString() } : null,
 book.publishedDate?.trim() ? { label: 'Published', value: book.publishedDate.trim() } : null,
 typeof book.averageRating === 'number'
 ? { label: 'Rating', value: `${book.averageRating.toFixed(1)}${book.ratingsCount ? ` (${book.ratingsCount.toLocaleString()} reviews)` : ''}` }
 : null,
 book.printType?.trim() ? { label: 'Type', value: book.printType.trim() } : null,
 book.subtitle?.trim() ? { label: 'Subtitle', value: book.subtitle.trim() } : null,
 Array.isArray(book.categories) && book.categories.length > 0
 ? { label: 'Genres', value: book.categories.filter((x) => typeof x === 'string' && x.trim().length > 0).join(', ') }
 : null,
 ].filter((row): row is { label: string; value: string } => Boolean(row && row.value && row.value.trim().length > 0));
 const useInfoGrid = windowWidth >= 768;

 return (
 <Modal
 visible={visible}
 animationType="none"
 transparent={false}
 onRequestClose={onClose}
 >
 <SafeAreaView style={[styles.safeContainer, { backgroundColor: t.colors.bg }]} edges={['left','right','bottom']}>
 <AppHeader title="Book Details" onBack={onClose} />

 <ScrollView style={[styles.container, { backgroundColor: t.colors.bg }]} showsVerticalScrollIndicator={false}>
 {/* Editorial hero card: cover + core identity */}
 <View style={styles.bookHeroCard}>
 <View style={styles.bookHeader}>
 <TouchableOpacity
 onPress={handleCoverPress}
 activeOpacity={0.8}
 disabled={updatingCover}
 style={styles.bookCoverContainer}
 >
 {getBookCoverUri(book) ? (
 <View pointerEvents="none" collapsable={false} style={styles.bookCover}>
 <Image
 source={{ uri: getBookCoverUri(book) }}
 style={styles.bookCover}
 />
 </View>
 ) : (
 <View style={[styles.bookCover, styles.placeholderCover]}>
 <Text style={styles.placeholderCoverText}>Tap to add cover</Text>
 </View>
 )}
 </TouchableOpacity>
 <View style={styles.bookInfo}>
 <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
 {book.author && (
 <Text style={styles.bookAuthor} numberOfLines={2}>{book.author}</Text>
 )}
 <TouchableOpacity
 style={[
 styles.readTogglePill,
 isRead
 ? {
 backgroundColor: t.colors.accent ?? t.colors.primary,
 borderColor: t.colors.accent ?? t.colors.primary,
 }
 : {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 },
 ]}
 onPress={() => !togglingRead && handleToggleReadStatus()}
 disabled={togglingRead}
 activeOpacity={0.8}
 >
 {togglingRead ? (
 <ActivityIndicator size="small" color={isRead ? (t.colors.accentTextOn ?? t.colors.primaryText) : (t.colors.textSecondary ?? t.colors.textMuted)} />
 ) : (
 <Text
 style={[
 styles.readTogglePillText,
 {
 color: isRead
 ? (t.colors.accentTextOn ?? t.colors.primaryText)
 : (t.colors.textSecondary ?? t.colors.text),
 },
 ]}
 >
 {isRead ? 'Read' : 'Mark as Read'}
 </Text>
 )}
 </TouchableOpacity>
 {isRead && book.readAt && (
 <Text style={[styles.readDateText, { color: t.colors.textTertiary ?? t.colors.textMuted }]}>
 Finished {new Date(book.readAt).toLocaleDateString()}
 </Text>
 )}
 {book.isbn && (
 <Text style={styles.bookIsbn}>ISBN: {book.isbn}</Text>
 )}
 </View>
 </View>
 </View>

 {/* Description render only when loading or when text exists */}
 {(loadingDescription || trimmedDescription.length > 0) && (
 <View style={[styles.sectionCard, styles.descriptionCard]}>
 <Text style={styles.descriptionLabel}>Description</Text>
 {loadingDescription ? (
 <View style={styles.descriptionSkeleton}>
 <View style={styles.skeletonLine} />
 <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
 <View style={styles.skeletonLine} />
 <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
 <ActivityIndicator size="small" color={t.colors.textMuted} style={styles.loader} />
 </View>
 ) : trimmedDescription.length > 0 ? (
 <Text style={styles.description}>{trimmedDescription}</Text>
 ) : null}
 </View>
 )}
 
 {/* Book Information render only when at least one value exists */}
 {infoRows.length > 0 && (
 <View style={[styles.sectionCard, styles.statsContainer]}>
 <Text style={styles.statsTableTitle}>Book Information</Text>
 <View style={[styles.statsTable, useInfoGrid && styles.statsTableGrid]}>
 {infoRows.map(({ label, value }) => (
 <View key={label} style={[styles.statRow, useInfoGrid && styles.statRowHalf]}>
 <View style={styles.statRowLabelWrap}>
 <Text style={styles.statRowLabel}>{label}</Text>
 </View>
 <Text style={styles.statRowValue} numberOfLines={2}>{value}</Text>
 </View>
 ))}
 </View>
 </View>
 )}

 {/* Scan Photo - Below Description, Above Remove Button */}
 {photo && (
 <View style={[styles.sectionCard, styles.scanCard]}>
 <TouchableOpacity
 style={styles.scanSectionHeader}
 onPress={() => setShowScanPhoto((prev) => !prev)}
 activeOpacity={0.8}
 >
 <Text style={[styles.sectionTitle, styles.scanSectionTitle]}>Scan Photo</Text>
 {showScanPhoto ? <ChevronUpIcon size={18} color={t.colors.textMuted} /> : <ChevronDownIcon size={18} color={t.colors.textMuted} />}
 </TouchableOpacity>
 {showScanPhoto ? (
 <>
 <PhotoTile photoId={photo.id} localUri={(photo as { local_uri?: string }).local_uri ?? (photo.uri?.startsWith?.('file://') ? photo.uri : null)} storagePath={photo.storage_path} fallbackUri={photo.uri} signedUrl={photo.signed_url} signedUrlExpiresAt={photo.signed_url_expires_at} status={photo.status} style={styles.scanPhoto} contentFit="cover" />
 <Text style={styles.scanDate}>
 Scanned: {new Date(photo.timestamp).toLocaleDateString()}
 </Text>
 </>
 ) : (
 <Text style={styles.scanCollapsedHint}>Tap to view scan photo</Text>
 )}
 </View>
 )}

 {/* Actions keep utility below reading experience */}
 <View style={[styles.sectionCard, styles.actionsCard]}>
 <Text style={styles.sectionTitle}>Actions</Text>
 {onAddBookToFolder && (
 <TouchableOpacity
 style={styles.addToFolderRow}
 onPress={onAddBookToFolder}
 activeOpacity={0.7}
 >
 <FolderOpenIcon size={18} color={t.colors.textPrimary ?? t.colors.text} style={styles.addToFolderIcon} />
 <Text style={[styles.addToFolderLabel, { color: t.colors.textPrimary ?? t.colors.text }]}>Move to collection</Text>
 <ChevronForwardIcon size={18} color={t.colors.textMuted} />
 </TouchableOpacity>
 )}
 <TouchableOpacity
 style={styles.addToFolderRow}
 onPress={handleShareBook}
 activeOpacity={0.7}
 >
 <ShareOutlineIcon size={18} color={t.colors.textPrimary ?? t.colors.text} style={styles.addToFolderIcon} />
 <Text style={[styles.addToFolderLabel, { color: t.colors.textPrimary ?? t.colors.text }]}>Share</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.addToFolderRow}
 onPress={handleRemoveFromLibrary}
 disabled={removing}
 activeOpacity={0.7}
 >
 {removing ? (
 <ActivityIndicator size="small" color={t.colors.danger} />
 ) : (
 <>
 <TrashIcon size={18} color={t.colors.danger} style={styles.addToFolderIcon} />
 <Text style={[styles.addToFolderLabel, { color: t.colors.danger }]}>Delete</Text>
 </>
 )}
 </TouchableOpacity>
 </View>
 </ScrollView>
 </SafeAreaView>

 {/* Cover Options Action Sheet */}
 <Modal
 visible={showCoverOptions}
 transparent={true}
 animationType="fade"
 onRequestClose={() => setShowCoverOptions(false)}
 >
 <TouchableOpacity
 style={styles.actionSheetOverlay}
 activeOpacity={1}
 onPress={() => setShowCoverOptions(false)}
 >
 <View style={styles.actionSheet}>
 <TouchableOpacity
 style={styles.actionSheetButton}
 onPress={handleReplaceCover}
 activeOpacity={0.7}
 >
 <Text style={styles.actionSheetButtonText}>Replace Cover</Text>
 </TouchableOpacity>
 {getBookCoverUri(book) && (
 <TouchableOpacity
 style={[styles.actionSheetButton, styles.actionSheetButtonDanger]}
 onPress={handleRemoveCover}
 activeOpacity={0.7}
 >
 <Text style={[styles.actionSheetButtonText, styles.actionSheetButtonTextDanger]}>Remove Cover</Text>
 </TouchableOpacity>
 )}
 <TouchableOpacity
 style={styles.actionSheetCancelButton}
 onPress={() => setShowCoverOptions(false)}
 activeOpacity={0.7}
 >
 <Text style={styles.actionSheetCancelText}>Cancel</Text>
 </TouchableOpacity>
 </View>
 </TouchableOpacity>
 </Modal>

 {/* Replace Cover Modal */}
 <Modal
 visible={showReplaceCoverModal}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => {
 setShowReplaceCoverModal(false);
 setCoverSearchResults([]);
 }}
 >
 <SafeAreaView style={styles.modalContainer} edges={['top']}>
 <AppHeader
 title="Replace Cover"
 onBack={() => {
 setShowReplaceCoverModal(false);
 setCoverSearchResults([]);
 }}
 rightSlot={(
 <TouchableOpacity
 style={styles.modalCloseButton}
 onPress={() => {
 setShowReplaceCoverModal(false);
 setCoverSearchResults([]);
 }}
 >
 <Text style={styles.modalCloseText}>Done</Text>
 </TouchableOpacity>
 )}
 />
 
 {book && (
 <ScrollView style={styles.modalContent}>
 <View style={styles.switchCoversHeader}>
 <Text style={styles.switchCoversTitle}>Current Book</Text>
 <View style={styles.currentBookCard}>
 {getBookCoverUri(book) ? (
 <Image 
 source={{ uri: getBookCoverUri(book) }} 
 style={styles.currentBookCover}
 />
 ) : (
 <View style={[styles.currentBookCover, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={3}>
 {book.title}
 </Text>
 </View>
 )}
 <View style={styles.currentBookInfo}>
 <Text style={styles.currentBookTitle}>{book.title}</Text>
 {book.author && (
 <Text style={styles.currentBookAuthor}>{book.author}</Text>
 )}
 </View>
 </View>
 </View>

 {/* Photo Options */}
 <View style={styles.photoOptionsSection}>
 <Text style={styles.switchCoversSectionTitle}>Take or Upload Photo</Text>
 <View style={styles.photoOptionsRow}>
 <TouchableOpacity
 style={styles.photoOptionButton}
 onPress={handleTakePhotoForCover}
 disabled={updatingCover || isHandlingPhoto}
 activeOpacity={0.7}
 >
 <Text style={styles.photoOptionButtonText}>Take Photo</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.photoOptionButton}
 onPress={handleUploadPhotoForCover}
 disabled={updatingCover || isHandlingPhoto}
 activeOpacity={0.7}
 >
 <Text style={styles.photoOptionButtonText}>Upload Photo</Text>
 </TouchableOpacity>
 </View>
 </View>

 <View style={styles.switchCoversSection}>
 <Text style={styles.switchCoversSectionTitle}>Available Covers</Text>
 {isLoadingCovers ? (
 <View style={styles.loadingContainer}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 <Text style={styles.loadingText}>Searching for covers...</Text>
 </View>
 ) : coverSearchResults.length === 0 ? (
 <View style={styles.emptyContainer}>
 <Text style={styles.emptyText}>No covers found</Text>
 </View>
 ) : (
 <View style={styles.coversGrid}>
 {coverSearchResults.map((result, index) => (
 <TouchableOpacity
 key={result.googleBooksId || index}
 style={styles.coverOption}
 onPress={() => handleSelectCover(result)}
 activeOpacity={0.7}
 disabled={updatingCover}
 >
 {result.coverUrl ? (
 <Image 
 source={{ uri: result.coverUrl }} 
 style={styles.coverOptionImage}
 />
 ) : (
 <View style={[styles.coverOptionImage, styles.placeholderCover]}>
 <Text style={styles.placeholderText}>No Cover</Text>
 </View>
 )}
 </TouchableOpacity>
 ))}
 </View>
 )}
 </View>
 </ScrollView>
 )}
 </SafeAreaView>
 </Modal>
 </Modal>
 );
};

function getStyles(t: ThemeTokens, screenWidth: number) {
 const c = t.colors;
 const scale = screenWidth / 375; // 1.0 on iPhone SE, ~1.05 on iPhone 15, ~1.15 on Pro Max
 return StyleSheet.create({
 safeContainer: { flex: 1, backgroundColor: c.bg },
 container: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
 bookHeroCard: {
 backgroundColor: c.surface,
 borderRadius: 20,
 padding: 16,
 marginBottom: 8,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: t.name === 'scriptoriumDark' ? 0.18 : 0.06,
 shadowRadius: 12,
 elevation: 3,
 },
 bookHeader: {
 flexDirection: 'row',
 alignItems: 'flex-start',
 paddingVertical: 0,
 paddingHorizontal: 0,
 },
 bookCoverContainer: { marginRight: 16 },
 bookCover: {
 width: 120,
 aspectRatio: 0.66,
 borderRadius: 13,
 backgroundColor: c.surface2,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 3 },
 shadowOpacity: t.name === 'scriptoriumDark' ? 0.22 : 0.12,
 shadowRadius: 8,
 elevation: 4,
 },
 bookInfo: {
 flex: 1,
 justifyContent: 'flex-start',
 alignItems: 'flex-start',
 minWidth: 0,
 paddingTop: 2,
 paddingBottom: 2,
 },
 bookTitle: {
 fontSize: 22,
 fontWeight: '700',
 color: c.textPrimary ?? c.text,
 marginBottom: 8,
 letterSpacing: 0.1,
 lineHeight: 28,
 },
 bookAuthor: {
 fontSize: 13,
 color: c.textTertiary ?? c.textSecondary ?? c.textMuted,
 fontWeight: '600',
 marginBottom: 10,
 letterSpacing: 1.1,
 textTransform: 'uppercase',
 },
 readTogglePill: {
 minHeight: 34,
 paddingHorizontal: 14,
 borderRadius: 17,
 borderWidth: 1,
 alignItems: 'center',
 justifyContent: 'center',
 alignSelf: 'flex-start',
 marginBottom: 8,
 },
 readTogglePillText: {
 fontSize: 13,
 fontWeight: '700',
 letterSpacing: 0.2,
 },
 bookIsbn: { fontSize: 13, color: c.textSecondary ?? c.text, fontWeight: '500', marginTop: 4 },
 sectionCard: {
 marginTop: 12,
 paddingVertical: 14,
 paddingHorizontal: 14,
 backgroundColor: c.surface,
 borderRadius: 16,
 borderWidth: 1,
 borderColor: c.borderSubtle ?? c.border,
 },
 descriptionCard: { marginTop: 10 },
 actionsCard: { marginBottom: 8 },
 scanCard: {},
 scanSectionHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 8,
 },
 sectionTitle: { fontSize: 13, fontWeight: '700', color: c.textSecondary ?? c.textMuted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
 scanSectionTitle: { marginBottom: 0 },
 descriptionLabel: { fontSize: 15, fontWeight: '600', color: c.textPrimary ?? c.text, marginBottom: 8 },
 description: { fontSize: 15, color: c.textSecondary ?? c.text, lineHeight: 24, fontWeight: '400' },
 noDescription: { fontSize: 15, color: c.textMuted, fontWeight: '400' },
 loader: { marginVertical: 20 },
 descriptionSkeleton: { marginTop: 4 },
 skeletonLine: { height: 12, backgroundColor: c.surface2, borderRadius: 4, marginBottom: 10, width: '100%' },
 skeletonLineShort: { width: '75%' },
 skeletonHeaderTitle: { height: 26, marginBottom: 12 },
 skeletonHeaderSub: { height: 16, marginBottom: 8 },
 retryButton: { marginTop: 12, paddingVertical: 10, paddingHorizontal: 16, alignSelf: 'flex-start', backgroundColor: c.surface2, borderRadius: 8 },
 retryButtonText: { fontSize: 14, color: c.textSecondary ?? c.textMuted, fontWeight: '600' },
 scanPhoto: { width: '100%', height: Math.round(Math.min(240, 180 * scale)), borderRadius: 12, marginBottom: 10, backgroundColor: c.surface2 },
 scanDate: { fontSize: 14, color: c.textSecondary ?? c.textMuted, fontWeight: '500' },
 scanCollapsedHint: { fontSize: 13, color: c.textMuted, fontWeight: '500' },
 removeTextButton: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 0,
 },
 removeTextButtonIcon: { marginRight: 6 },
 removeTextButtonLabel: { fontSize: 15, fontWeight: '600' },
 readDateText: { fontSize: 12, marginTop: 8, fontWeight: '500', color: c.textTertiary ?? c.textMuted },
 statsContainer: {},
 statsTableTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary ?? c.text, marginBottom: 12 },
 statsTable: { gap: 8 },
 statsTableGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 justifyContent: 'space-between',
 gap: 10,
 },
 statRow: {
 paddingVertical: 8,
 paddingHorizontal: 10,
 borderRadius: 10,
 backgroundColor: c.surface2 ?? c.surface,
 minHeight: 56,
 },
 statRowHalf: {
 width: '48.5%',
 },
 statRowLabelWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
 statRowIcon: { marginRight: 6 },
 statRowLabel: { fontSize: 12, color: c.textSecondary ?? c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
 statRowValue: { fontSize: 14, color: c.textPrimary ?? c.text, fontWeight: '500', flex: 1 },
 addToFolderRow: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 12,
 minHeight: 44,
 },
 addToFolderIcon: { marginRight: 10 },
 addToFolderLabel: { fontSize: 17, fontWeight: '500', flex: 1 },
 subtitleContainer: { marginTop: 8, marginBottom: 16 },
 subtitleLabel: { fontSize: 12, color: c.textSecondary ?? c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
 subtitleText: { fontSize: 15, color: c.textSecondary ?? c.text, fontStyle: 'italic', fontWeight: '500' },
 categoriesContainer: { marginTop: 8 },
 categoriesLabel: { fontSize: 12, color: c.textSecondary ?? c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
 categoriesList: { flexDirection: 'row', flexWrap: 'wrap' },
 categoryTag: { backgroundColor: c.surface2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 8, marginBottom: 8 },
 categoryText: { fontSize: 13, color: c.textPrimary ?? c.text, fontWeight: '500' },
 placeholderCover: { backgroundColor: c.surface2, justifyContent: 'center', alignItems: 'center' },
 placeholderCoverText: { fontSize: 12, color: c.textMuted, textAlign: 'center', fontWeight: '500' },
 placeholderText: { fontSize: 12, color: c.textMuted, textAlign: 'center', padding: 10 },
 actionSheetOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
 actionSheet: { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
 actionSheetButton: { paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: c.border },
 actionSheetButtonDanger: { borderBottomWidth: 0 },
 actionSheetButtonText: { fontSize: 18, color: c.primary, fontWeight: '600', textAlign: 'center' },
 actionSheetButtonTextDanger: { color: c.danger },
 actionSheetCancelButton: { paddingVertical: 16, paddingHorizontal: 20, marginTop: 8 },
 actionSheetCancelText: { fontSize: 18, color: c.textSecondary ?? c.textMuted, fontWeight: '600', textAlign: 'center' },
 modalContainer: { flex: 1, backgroundColor: c.bg },
 modalCloseButton: { paddingVertical: 8, paddingHorizontal: 12 },
 modalCloseText: { fontSize: 16, color: c.textPrimary ?? c.text, fontWeight: '600' },
 modalContent: { flex: 1, padding: 20 },
 switchCoversHeader: { marginBottom: 24 },
 switchCoversTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary ?? c.text, marginBottom: 12 },
 currentBookCard: {
 flexDirection: 'row',
 backgroundColor: c.surface,
 borderRadius: 12,
 padding: 16,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.08,
 shadowRadius: 8,
 elevation: 3,
 },
 currentBookCover: { width: Math.round(80 * Math.min(scale, 1.3)), height: Math.round(120 * Math.min(scale, 1.3)), borderRadius: 8, marginRight: 16, backgroundColor: c.surface2 },
 currentBookInfo: { flex: 1, justifyContent: 'center' },
 currentBookTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary ?? c.text, marginBottom: 6 },
 currentBookAuthor: { fontSize: 14, color: c.textSecondary ?? c.text, fontStyle: 'italic' },
 photoOptionsSection: { marginBottom: 24 },
 photoOptionsRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
 photoOptionButton: {
 flex: 1,
 backgroundColor: c.primary,
 paddingVertical: 14,
 paddingHorizontal: 16,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 },
 photoOptionButtonText: { fontSize: 16, color: c.primaryText, fontWeight: '600' },
 switchCoversSection: { marginBottom: 24 },
 switchCoversSectionTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary ?? c.text, marginBottom: 16 },
 loadingContainer: { padding: 40, alignItems: 'center' },
 loadingText: { marginTop: 12, fontSize: 14, color: c.textSecondary ?? c.textMuted },
 emptyContainer: { padding: 40, alignItems: 'center' },
 emptyText: { fontSize: 14, color: c.textSecondary ?? c.textMuted },
 coversGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
 coverOption: { width: '30%', aspectRatio: 2/3, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surface2 },
 coverOptionImage: { width: '100%', height: '100%', resizeMode: 'cover' },
 });
}

export default BookDetailModal;

