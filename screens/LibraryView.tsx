import React, { useState, useEffect, useMemo } from 'react';
import {
 View,
 Text,
 StyleSheet,
 ScrollView,
 Pressable,
 TouchableOpacity,
 TextInput,
 Dimensions,
 useWindowDimensions,
 FlatList,
 Modal,
 Alert,
 Share,
 InteractionManager,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CheckmarkIcon,
  ChevronDownIcon,
  CloseIcon,
  SearchIcon,
  DownloadIcon,
  LibraryOutlineIcon,
  BookOutlineIcon,
  TrashIcon,
  FolderIcon,
  StarIcon,
} from '../components/Icons';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Book, Photo, Folder } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import BookDetailModal from '../components/BookDetailModal';
import { AuthGateModal } from '../components/AuthGateModal';
import { dedupeBooks } from '../lib/dedupeBooks';
import { dedupBy, photoStableKey } from '../lib/dedupBy';
import { isGoogleHotlink } from '../lib/coverUtils';
import { BOOK_GRID_VERTICAL_GAP } from '../lib/layoutConstants';
import { getEnvVar } from '../lib/getEnvVar';
import { logger } from '../utils/logger';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit } from '../lib/deleteGuard';
import { useTheme } from '../theme/ThemeProvider';
import { AppHeader } from '../components/AppHeader';

interface LibraryViewProps {
 onClose?: () => void;
 filterReadStatus?: 'read' | 'unread';
 onBooksUpdated?: () => void; // Callback to notify parent when books are updated
 mode?: 'library' | 'addToFavorites'; // addToFavorites: select books to add to favorites
}

type SortedBooksResult = {
 booksWithData: Book[];
 booksWithoutData: Book[];
};

const SEARCH_DEBOUNCE_MS = 200;

function extractAuthorLastName(author?: string): string {
 if (!author) return '';
 const firstAuthor = author.split(/,|&| and /i)[0].trim();
 const parts = firstAuthor.split(/\s+/).filter(Boolean);
 if (parts.length === 0) return '';
 return parts[parts.length - 1].replace(/,/, '').toLowerCase();
}

function computeSortedBooks(
 sourceBooks: Book[],
 query: string,
 filterReadStatus: 'read' | 'unread' | undefined,
 sortBy: 'author' | 'oldest' | 'length'
): SortedBooksResult {
 let filtered = sourceBooks;
 if (filterReadStatus === 'read') {
 filtered = sourceBooks.filter((b) =>
 b.readAt !== undefined && b.readAt !== null && typeof b.readAt === 'number' && b.readAt > 0
 );
 } else if (filterReadStatus === 'unread') {
 filtered = sourceBooks.filter((b) =>
 !b.readAt || b.readAt === null || (typeof b.readAt === 'number' && b.readAt <= 0)
 );
 }

 const normalizedQuery = query.trim().toLowerCase();
 if (normalizedQuery) {
 const startsWithMatches = filtered.filter((b) => {
 const title = (b.title || '').toLowerCase();
 const author = (b.author || '').toLowerCase();
 return title.startsWith(normalizedQuery) || author.startsWith(normalizedQuery);
 });

 const containsMatches = filtered.filter((b) => {
 const title = (b.title || '').toLowerCase();
 const author = (b.author || '').toLowerCase();
 return (
 (title.includes(normalizedQuery) || author.includes(normalizedQuery)) &&
 !(title.startsWith(normalizedQuery) || author.startsWith(normalizedQuery))
 );
 });

 filtered = [...startsWithMatches, ...containsMatches];
 }

 const books = [...filtered];
 const booksWithData: Book[] = [];
 const booksWithoutData: Book[] = [];

 if (sortBy === 'author') {
 books.forEach((book) => {
 if (extractAuthorLastName(book.author)) booksWithData.push(book);
 else booksWithoutData.push(book);
 });

 booksWithData.sort((a, b) => {
 const comparison = extractAuthorLastName(a.author).localeCompare(extractAuthorLastName(b.author));
 if (comparison === 0) return (a.title || '').localeCompare(b.title || '');
 return comparison;
 });
 booksWithoutData.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
 return { booksWithData, booksWithoutData };
 }

 if (sortBy === 'oldest') {
 books.forEach((book) => {
 const publishedDate = book.publishedDate;
 if (!publishedDate || !publishedDate.trim()) {
 booksWithoutData.push(book);
 return;
 }
 const yearMatch = publishedDate.match(/\d{4}/);
 if (!yearMatch) {
 booksWithoutData.push(book);
 return;
 }
 const year = parseInt(yearMatch[0], 10);
 if (year > 0 && year <= new Date().getFullYear() + 10) booksWithData.push(book);
 else booksWithoutData.push(book);
 });

 booksWithData.sort((a, b) => {
 const aYear = parseInt(a.publishedDate?.match(/\d{4}/)?.[0] || '0', 10);
 const bYear = parseInt(b.publishedDate?.match(/\d{4}/)?.[0] || '0', 10);
 if (aYear === bYear && aYear > 0) {
 const aDate = new Date(a.publishedDate || '').getTime();
 const bDate = new Date(b.publishedDate || '').getTime();
 if (!isNaN(aDate) && !isNaN(bDate)) return aDate - bDate;
 }
 return aYear - bYear;
 });
 booksWithoutData.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
 return { booksWithData, booksWithoutData };
 }

 if (sortBy === 'length') {
 books.forEach((book) => {
 if ((book.pageCount || 0) > 0) booksWithData.push(book);
 else booksWithoutData.push(book);
 });
 booksWithData.sort((a, b) => (b.pageCount || 0) - (a.pageCount || 0));
 booksWithoutData.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
 return { booksWithData, booksWithoutData };
 }

 return { booksWithData: books, booksWithoutData: [] };
}

export const LibraryView: React.FC<LibraryViewProps> = ({ onClose, filterReadStatus, onBooksUpdated, mode = 'library' }) => {
 const GRID_PHONE_COLUMNS = 4;
 const GRID_HORIZONTAL_PADDING = 16;
 const GRID_GAP = 12;
 const GRID_MIN_ITEM_WIDTH = 64;
 const navigation = useNavigation();
 const insets = useSafeAreaInsets();
 const { user } = useAuth();
 const { t } = useTheme();
 const { width: screenWidthRaw, height: screenHeightRaw } = useWindowDimensions();
 const screenWidth = screenWidthRaw || 375; // Fallback to default width
 const screenHeight = screenHeightRaw || 667; // Fallback to default height
 // Hard requirement: never drop below 4 columns on phone portrait.
 // Wider layouts can scale up.
 const gridColumns = screenWidth > 1200 ? 6 : screenWidth > 900 ? 5 : GRID_PHONE_COLUMNS;
 const gridContainerWidth = Math.min(screenWidth, 900);
 const available = gridContainerWidth - (GRID_HORIZONTAL_PADDING * 2) - (GRID_GAP * (gridColumns - 1));
 const gridItemWidth = Math.max(1, Math.floor(available / gridColumns));
 const typeScale = screenWidth > 1000 ? 1.14 : screenWidth > 800 ? 1.1 : screenWidth > 600 ? 1.05 : 1;

 useEffect(() => {
 if (!__DEV__) return;
 if (gridItemWidth < GRID_MIN_ITEM_WIDTH) {
 console.warn(
 '[LIBRARY_GRID_WIDTH_GUARD]',
 `itemWidth=${gridItemWidth} is below minimum=${GRID_MIN_ITEM_WIDTH}. Keep columns fixed; reduce typography/spacing instead of dropping below 4 columns.`
 );
 }
 }, [gridItemWidth]);
 
 const styles = useMemo(
 () => getStyles(screenWidth, screenHeight, t, gridColumns, typeScale, gridItemWidth, GRID_HORIZONTAL_PADDING, GRID_GAP),
 [screenWidth, screenHeight, t, gridColumns, typeScale, gridItemWidth]
 );
 
 const [books, setBooks] = useState<Book[]>([]);
 const [photos, setPhotos] = useState<Photo[]>([]);
 const [folders, setFolders] = useState<Folder[]>([]);
 const [searchQuery, setSearchQuery] = useState('');
 const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
 const [selectedBook, setSelectedBook] = useState<Book | null>(null);
 const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
 const [showBookDetail, setShowBookDetail] = useState(false);
 const [showAuthGateModal, setShowAuthGateModal] = useState(false);
 const [showExportModal, setShowExportModal] = useState(false);
 const [exportFormat, setExportFormat] = useState<'MLA' | 'APA' | 'Chicago'>('MLA');
 const [selectedBooksForExport, setSelectedBooksForExport] = useState<Set<string>>(new Set());
 const [selectedFolderForExport, setSelectedFolderForExport] = useState<string | null>(null);
 const [exportAll, setExportAll] = useState(true);
 const [newFolderName, setNewFolderName] = useState('');
 const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
 const [showFolderView, setShowFolderView] = useState(false);
 const [folderSearchQuery, setFolderSearchQuery] = useState('');
 const [isFolderSelectionMode, setIsFolderSelectionMode] = useState(false);
 const [selectedFolderBooks, setSelectedFolderBooks] = useState<Set<string>>(new Set());
 const [isSelectionMode, setIsSelectionMode] = useState(false);
 const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
 const [isFolderListSelectionMode, setIsFolderListSelectionMode] = useState(false);
 const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
 const [sortBy, setSortBy] = useState<'author' | 'oldest' | 'length'>('author');
 const [showSortModal, setShowSortModal] = useState(false);
 const [isCreatingFolder, setIsCreatingFolder] = useState(false);
 const [selectedBooksForNewFolder, setSelectedBooksForNewFolder] = useState<Set<string>>(new Set());
 const [newFolderNameInput, setNewFolderNameInput] = useState('');
 const [showFolderNameInput, setShowFolderNameInput] = useState(false);
 const [isAutoSorting, setIsAutoSorting] = useState(false);
 const [createFolderSearchQuery, setCreateFolderSearchQuery] = useState('');
 const [debouncedCreateFolderSearchQuery, setDebouncedCreateFolderSearchQuery] = useState('');
 const [sortedBooks, setSortedBooks] = useState<SortedBooksResult>({ booksWithData: [], booksWithoutData: [] });

 useEffect(() => {
 if (user) {
 loadBooks();
 }
 }, [user]);

 // Reload books when filter changes to ensure fresh data
 useEffect(() => {
 if (user && filterReadStatus) {
 loadBooks();
 }
 }, [filterReadStatus, user]);

 useEffect(() => {
 let cancelled = false;
 let interactionTask: { cancel?: () => void } | null = null;
 const timeout = setTimeout(() => {
 interactionTask = InteractionManager.runAfterInteractions(() => {
 if (!cancelled) setDebouncedSearchQuery(searchQuery);
 });
 }, SEARCH_DEBOUNCE_MS);

 return () => {
 cancelled = true;
 clearTimeout(timeout);
 interactionTask?.cancel?.();
 };
 }, [searchQuery]);

 useEffect(() => {
 let cancelled = false;
 let interactionTask: { cancel?: () => void } | null = null;
 const timeout = setTimeout(() => {
 interactionTask = InteractionManager.runAfterInteractions(() => {
 if (cancelled) return;
 const nextSortedBooks = computeSortedBooks(books, debouncedSearchQuery, filterReadStatus, sortBy);
 if (!cancelled) setSortedBooks(nextSortedBooks);
 });
 }, 16);

 return () => {
 cancelled = true;
 clearTimeout(timeout);
 interactionTask?.cancel?.();
 };
 }, [books, debouncedSearchQuery, filterReadStatus, sortBy]);

 useEffect(() => {
 let cancelled = false;
 let interactionTask: { cancel?: () => void } | null = null;
 const timeout = setTimeout(() => {
 interactionTask = InteractionManager.runAfterInteractions(() => {
 if (!cancelled) setDebouncedCreateFolderSearchQuery(createFolderSearchQuery);
 });
 }, SEARCH_DEBOUNCE_MS);

 return () => {
 cancelled = true;
 clearTimeout(timeout);
 interactionTask?.cancel?.();
 };
 }, [createFolderSearchQuery]);

 // In addToFavorites mode, start in selection mode
 useEffect(() => {
 if (mode === 'addToFavorites') {
 setIsSelectionMode(true);
 }
 }, [mode]);

const deleteSelectedBooks = async () => {
if (!user || selectedBooks.size === 0) return;

const bookCount = selectedBooks.size;
const _intent = createDeleteIntent('user_delete_books_bulk', 'LibraryView');
Alert.alert(
'Delete Books',
`Are you sure you want to delete ${bookCount} book${bookCount === 1 ? '' : 's'} from your library? This action cannot be undone.`,
[
{ text: 'Cancel', style: 'cancel' },
{
text: 'Delete',
style: 'destructive',
onPress: async () => {
_intent.userConfirmed = true;
if (!assertDeleteAllowed(_intent)) return;
try {
// Get the books to delete
const booksToDelete = books.filter(book => {
const bookId = book.id || `${book.title}_${book.author || ''}`;
return selectedBooks.has(bookId);
});
logDeleteAudit(_intent, { bookCount: booksToDelete.length, bookIds: booksToDelete.map(b => b.id).filter((id): id is string => !!id).slice(0, 10), userId: user?.uid });

// Delete from Supabase
const { deleteBookFromSupabase } = await import('../services/supabaseSync');
for (const book of booksToDelete) {
await deleteBookFromSupabase(user.uid, book);
}

 // Update local state immediately
 setBooks(prev => prev.filter(book => {
 const bookId = book.id || `${book.title}_${book.author || ''}`;
 return !selectedBooks.has(bookId);
 }));

 // Clear selection and exit selection mode
 setSelectedBooks(new Set());
 setIsSelectionMode(false);

 // Reload to ensure sync
 await loadBooks();

 Alert.alert('Success', `${bookCount} book${bookCount === 1 ? '' : 's'} deleted.`);
 } catch (error) {
 console.error('Error deleting books:', error);
 Alert.alert('Error', 'Failed to delete books. Please try again.');
 }
 },
 },
 ]
 );
 };

 const addSelectedToFavorites = async () => {
 if (!user || selectedBooks.size === 0) return;
 try {
 const booksToUpdate = books.filter(book => {
 const bookId = book.id || `${book.title}_${book.author || ''}`;
 return selectedBooks.has(bookId);
 });
 const { saveBookToSupabase } = await import('../services/supabaseSync');
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 const approvedBooks: Book[] = approvedData ? JSON.parse(approvedData) : [];
 const updatedMap = new Map(approvedBooks.map(b => {
 const id = b.id || `${b.title}_${b.author || ''}`;
 return [id, b];
 }));
 for (const book of booksToUpdate) {
 const updatedBook: Book = { ...book, is_favorite: true };
 await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');
 const id = book.id || `${book.title}_${book.author || ''}`;
 updatedMap.set(id, updatedBook);
 }
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(Array.from(updatedMap.values())));
 setBooks(prev => prev.map(b => {
 const id = b.id || `${b.title}_${b.author || ''}`;
 return updatedMap.get(id) || b;
 }));
 setSelectedBooks(new Set());
 setIsSelectionMode(false);
 onBooksUpdated?.();
 onClose?.();
 } catch (error) {
 console.error('Error adding to favorites:', error);
 Alert.alert('Error', 'Failed to add to favorites. Please try again.');
 }
 };

 const loadBooks = async () => {
 if (!user) return;
 try {
 const { supabase } = await import('../lib/supabase');
 const { data: sess } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
 if (!sess?.session?.access_token) {
 setBooks([]);
 return;
 }

 let supabaseBooks = null;
 try {
 const { loadBooksFromSupabase } = await import('../services/supabaseSync');
 supabaseBooks = await loadBooksFromSupabase(user.uid);
 } catch (error) {
 console.error('Error loading books from Supabase:', error);
 }

 // Merge with AsyncStorage only when we have a valid session (no guest fallback)
 const userApprovedKey = `approved_books_${user.uid}`;
 const storedApproved = await AsyncStorage.getItem(userApprovedKey);
 const localBooks: Book[] = storedApproved ? JSON.parse(storedApproved) : [];

 // Merge Supabase books (which have readAt) with local books
 // Prioritize Supabase data as source of truth, but preserve readAt from local if more recent
 let mergedBooks: Book[] = [];
 if (supabaseBooks && supabaseBooks.approved && supabaseBooks.approved.length > 0) {
 // Create a map of local books by title+author for quick lookup
 const localBooksMap = new Map<string, Book>();
 localBooks.forEach(b => {
 const key = `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`;
 if (!localBooksMap.has(key)) {
 localBooksMap.set(key, b);
 }
 });
 
 // Use Supabase books as primary, but merge readAt from local if it's more recent
 mergedBooks = supabaseBooks.approved.map(supabaseBook => {
 const key = `${supabaseBook.title?.toLowerCase().trim()}|${supabaseBook.author?.toLowerCase().trim() || ''}`;
 const localBook = localBooksMap.get(key);
 if (localBook) {
 if (localBook?.description && !supabaseBook?.description) {
 logger.debug('[DESC_MERGE_LOCAL_WINS]', { id: supabaseBook.id, title: supabaseBook.title });
 }
 if (!localBook?.description && supabaseBook?.description) {
 logger.debug('[DESC_MERGE_REMOTE_WINS]', { id: supabaseBook.id, title: supabaseBook.title, len: supabaseBook.description?.length ?? 0 });
 }
 }
 // If local book has a more recent readAt, use it
 if (localBook && localBook.readAt) {
 if (!supabaseBook.readAt || (localBook.readAt > supabaseBook.readAt)) {
 return { ...supabaseBook, readAt: localBook.readAt };
 }
 }
 return supabaseBook;
 });
 
 // Merge in any local books that aren't in Supabase
 const supabaseBookKeys = new Set(
 mergedBooks.map(b => `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`)
 );
 
 const localOnlyBooks = localBooks.filter(b => {
 const key = `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`;
 return !supabaseBookKeys.has(key);
 });
 
 if (localOnlyBooks.length > 0) {
 mergedBooks = [...mergedBooks, ...localOnlyBooks];
 }
 } else {
 mergedBooks = localBooks;
 }
 
 // Use canonical merge result only do NOT merge with prev or same book can appear twice (different ids)
 setBooks(dedupeBooks(mergedBooks));

 // Load photos to find source photo for books
 const photosKey = `@${user.uid}:photos`;
 const storedPhotos = await AsyncStorage.getItem(photosKey);
 if (storedPhotos) {
 try {
 const parsed = JSON.parse(storedPhotos);
 const loadedPhotos = Array.isArray(parsed) ? parsed : [];
 setPhotos(dedupBy(loadedPhotos, photoStableKey));
 } catch (_) {
 setPhotos([]);
 }
 }

 // Load folders
 const foldersKey = `folders_${user.uid}`;
 const storedFolders = await AsyncStorage.getItem(foldersKey);
 if (storedFolders) {
 const loadedFolders: Folder[] = JSON.parse(storedFolders);
 setFolders(loadedFolders);
 }
 } catch (error) {
 console.error('Error loading books:', error);
 }
 };

 // Separate books with and without data for rendering
 const { booksWithData = [], booksWithoutData = [] } = sortedBooks;
 const allSortedBooks = useMemo(() => [...booksWithData, ...booksWithoutData], [booksWithData, booksWithoutData]);
 const createFolderFilteredBooks = useMemo(() => {
 const query = debouncedCreateFolderSearchQuery.trim().toLowerCase();
 if (!query) return allSortedBooks;
 return allSortedBooks.filter((book) => {
 const title = (book.title || '').toLowerCase();
 const author = (book.author || '').toLowerCase();
 return title.includes(query) || author.includes(query);
 });
 }, [allSortedBooks, debouncedCreateFolderSearchQuery]);

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

 const findBookPhoto = (book: Book): Photo | null => {
 return photos.find(photo => 
 photo.books && photo.books.some(photoBook => 
 photoBook.title === book.title && 
 photoBook.author === book.author
 )
 ) || null;
 };

 const handleCreateFolder = async (bookIds?: string[]) => {
 const folderName = bookIds ? newFolderNameInput.trim() : newFolderName.trim();
 if (!folderName || !user) return;
 
 try {
 const folderId = `folder_${Date.now()}`;
 const newFolder: Folder = {
 id: folderId,
 name: folderName,
 bookIds: bookIds || Array.from(selectedBooksForNewFolder),
 photoIds: [],
 createdAt: Date.now(),
 };
 
 const updatedFolders = [...folders, newFolder];
 setFolders(updatedFolders);
 
 const foldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
 
 setNewFolderName('');
 setNewFolderNameInput('');
 setSelectedBooksForNewFolder(new Set());
 setIsCreatingFolder(false);
 setShowFolderNameInput(false);
 Alert.alert('Success', `Collection "${newFolder.name}" created with ${newFolder.bookIds.length} book${newFolder.bookIds.length === 1 ? '' : 's'}!`);
 } catch (error) {
 console.error('Error creating folder:', error);
 Alert.alert('Error', 'Failed to create collection. Please try again.');
 }
 };

 const autoSortBooksIntoFolders = async () => {
 if (!user || books.length === 0) {
 Alert.alert('No Books', 'You need books in your library to auto-sort them.');
 return;
 }

 // Get all book IDs that are already in existing folders
 const booksInExistingFolders = new Set<string>();
 folders.forEach(folder => {
 folder.bookIds.forEach(bookId => {
 booksInExistingFolders.add(bookId);
 });
 });

 // Only include books that are NOT already in folders
 const booksToSort = books.filter(book => {
 const bookId = book.id || `${book.title}_${book.author || ''}`;
 return !booksInExistingFolders.has(bookId);
 });

 if (booksToSort.length === 0) {
 Alert.alert('All Books Organized', 'All your books are already in collections. No books to sort.');
 return;
 }

 Alert.alert(
 'Auto-organize Books',
 `This will organize ${booksToSort.length} unorganized books into collections by genre. Your existing ${folders.length} collection${folders.length === 1 ? '' : 's'} will be preserved. Continue?`,
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Sort',
 onPress: async () => {
 setIsAutoSorting(true);
 try {
 // Get API base URL
 const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://bookshelfscan.app';
 
 if (!baseUrl) {
 throw new Error('API server URL not configured');
 }
 
 console.log(' Starting auto-sort via API...');
 
 // Prepare existing folders info for the API
 const existingFoldersInfo = folders.map(folder => ({
 name: folder.name,
 bookIds: folder.bookIds,
 }));

 const response = await fetch(`${baseUrl}/api/auto-sort-books`, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 books: booksToSort.map(book => ({
 id: book.id || `${book.title}_${book.author || ''}`,
 title: book.title,
 author: book.author,
 })),
 existingFolders: existingFoldersInfo,
 }),
 });

 if (!response.ok) {
 const errorText = await response.text();
 throw new Error(errorText || 'Failed to sort books');
 }

 const data = await response.json();
 
 if (!data.success || !data.folders || !Array.isArray(data.folders)) {
 throw new Error('Invalid response from server');
 }

 // Update existing folders with new book assignments
 const updatedFolders = folders.map(folder => {
 const update = data.existingFolderUpdates?.find((u: any) => 
 u.folderName.toLowerCase() === folder.name.toLowerCase()
 );
 if (update && update.bookIds.length > 0) {
 // Add new books to existing folder (avoid duplicates)
 const existingBookIds = new Set(folder.bookIds);
 const newBookIds = update.bookIds.filter((id: string) => !existingBookIds.has(id));
 return {
 ...folder,
 bookIds: [...folder.bookIds, ...newBookIds],
 };
 }
 return folder;
 });

 // Create new folders from the AI response
 const newFolders: Folder[] = (data.newFolders || data.folders || []).map((group: { folderName: string; bookIds: string[] }) => ({
 id: `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
 name: group.folderName,
 bookIds: group.bookIds,
 photoIds: [],
 createdAt: Date.now(),
 }));

 // Merge updated existing folders with new folders
 const finalFolders = [...updatedFolders, ...newFolders];
 setFolders(finalFolders);
 
 // Save to AsyncStorage
 const foldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(foldersKey, JSON.stringify(finalFolders));

 const updatedCount = data.existingFolderUpdates?.length || 0;
 const newCount = newFolders.length;
 const updatedBooksCount = data.existingFolderUpdates?.reduce((sum: number, u: any) => sum + u.bookIds.length, 0) || 0;
 const newBooksCount = newFolders.reduce((sum, f) => sum + f.bookIds.length, 0);

 let message = `Organized ${booksToSort.length} book${booksToSort.length === 1 ? '' : 's'}: `;
 if (updatedCount > 0) {
 message += `Added ${updatedBooksCount} to ${updatedCount} existing collection${updatedCount === 1 ? '' : 's'}`;
 if (newCount > 0) {
 message += `, created ${newCount} new collection${newCount === 1 ? '' : 's'}`;
 }
 } else {
 message += `Created ${newCount} new collection${newCount === 1 ? '' : 's'}`;
 }
 message += '.';

 Alert.alert('Success!', message, [{ text: 'OK' }]);

 // Notify parent if callback exists
 if (onBooksUpdated) {
 onBooksUpdated();
 }
 } catch (error: any) {
 console.error('Error auto-sorting books:', error);
 Alert.alert(
 'Error',
 error?.message || 'Failed to auto-sort books. Please try again.'
 );
 } finally {
 setIsAutoSorting(false);
 }
 },
 },
 ]
 );
 };

 const openBookDetail = (book: Book) => {
 setSelectedBook(book);
 const sourcePhoto = findBookPhoto(book);
 setSelectedPhoto(sourcePhoto);
 setShowBookDetail(true);
 };

 const renderFolderBook = ({ item, index }: { item: Book; index: number }) => {
 const bookId = item.id || `${item.title}_${item.author || ''}`;
 const isSelected = selectedFolderBooks.has(bookId);
 
 return (
 <TouchableOpacity
 style={[
 styles.bookCard,
 isFolderSelectionMode && isSelected && styles.selectedBookCard
 ]}
 onPress={() => {
 if (isFolderSelectionMode) {
 setSelectedFolderBooks(prev => {
 const newSet = new Set(prev);
 if (newSet.has(bookId)) {
 newSet.delete(bookId);
 } else {
 newSet.add(bookId);
 }
 return newSet;
 });
 } else {
 const photo = findBookPhoto(item);
 setSelectedBook(item);
 setSelectedPhoto(photo);
 setShowBookDetail(true);
 }
 }}
 activeOpacity={0.7}
 >
 {isFolderSelectionMode && (
 <View style={styles.selectionOverlay}>
 {isSelected && (
 <View style={styles.selectionCheckmark}>
 <CheckmarkIcon size={18} color="#0056CC" />
 </View>
 )}
 </View>
 )}
 <View style={styles.coverWrap}>
 {getBookCoverUri(item) ? (
 <ExpoImage 
 source={{ uri: getBookCoverUri(item) }} 
 style={[
 styles.bookCover,
 styles.bookCoverInWrap,
 isFolderSelectionMode && isSelected && styles.selectedBookCover
 ]}
 contentFit="cover"
 cachePolicy="memory-disk"
 />
 ) : (
 <View style={[styles.bookCover, styles.bookCoverInWrap, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={Math.min(item.title?.trim().split(/\s+/).length ?? 1, 5)} adjustsFontSizeToFit minimumFontScale={0.45}>
 {item.title}
 </Text>
 </View>
 )}
 {isFolderSelectionMode && isSelected && <View style={styles.selectionCoverOverlay} pointerEvents="none" />}
 </View>
 {item.author && (
 <Text style={styles.bookAuthor} numberOfLines={2}>
 {item.author}
 </Text>
 )}
 </TouchableOpacity>
 );
 };

 const fetchBookDetails = async (book: Book): Promise<{
 publisher?: string;
 publishedDate?: string;
 publisherLocation?: string;
 }> => {
 // If book already has publisher data, return it (no API call needed)
 if (book.publisher && book.publishedDate) {
 return {
 publisher: book.publisher,
 publishedDate: book.publishedDate,
 publisherLocation: undefined, // Not stored in book object
 };
 }

 // If we have googleBooksId, use centralized service
 if (book.googleBooksId) {
 try {
 const { fetchBookData } = await import('../services/googleBooksService');
 const bookData = await fetchBookData(book.title, book.author, book.googleBooksId, book.isbn);
 
 return {
 publisher: bookData.publisher,
 publishedDate: bookData.publishedDate,
 publisherLocation: undefined, // Not available in Google Books API
 };
 } catch (error) {
 console.warn('Error fetching book details:', error);
 return {};
 }
 }

 return {};
 };

 const formatAuthorName = (author: string, format: 'MLA' | 'APA' | 'Chicago'): string => {
 if (!author || author === 'Unknown Author') return '';
 
 const authorParts = author.split(/\s+/).filter(Boolean);
 if (authorParts.length === 0) return '';
 
 const lastName = authorParts[authorParts.length - 1];
 const firstParts = authorParts.slice(0, -1);
 
 if (format === 'APA') {
 // APA: LastName, F. M.
 const initials = firstParts.map(n => n[0]?.toUpperCase() || '').join('. ');
 return `${lastName}, ${initials}${initials ? '.' : ''}`;
 } else {
 // MLA and Chicago: LastName, FirstName
 const firstName = firstParts.join(' ');
 return `${lastName}, ${firstName}`;
 }
 };

 const extractYear = (dateString?: string): string => {
 if (!dateString) return 'n.d.';
 // Extract year from various date formats (e.g., "2023", "2023-01-15", "January 2023")
 const yearMatch = dateString.match(/\d{4}/);
 return yearMatch ? yearMatch[0] : 'n.d.';
 };

 const formatMLA = (book: Book, details?: { publisher?: string; publishedDate?: string }): string => {
 const author = formatAuthorName(book.author || '', 'MLA');
 const title = book.title || 'Untitled';
 const publisher = details?.publisher || 'n.p.';
 const year = extractYear(details?.publishedDate);
 
 if (!author) {
 return `"${title}." ${publisher}, ${year}.`;
 }
 
 // MLA: Author Last, First. Title. Publisher, Publication Date.
 return `${author}. ${title}. ${publisher}, ${year}.`;
 };

 const formatAPA = (book: Book, details?: { publisher?: string; publishedDate?: string }): string => {
 const author = formatAuthorName(book.author || '', 'APA');
 const title = book.title || 'Untitled';
 const year = extractYear(details?.publishedDate);
 const publisher = details?.publisher || 'n.p.';
 
 if (!author) {
 return `${title}. (${year}). ${publisher}.`;
 }
 
 // APA: Author Last, F. M. (Year). Title. Publisher.
 return `${author} (${year}). ${title}. ${publisher}.`;
 };

 const formatChicago = (book: Book, details?: { publisher?: string; publishedDate?: string; publisherLocation?: string }): string => {
 const author = formatAuthorName(book.author || '', 'Chicago');
 const title = book.title || 'Untitled';
 const place = details?.publisherLocation || 'n.p.';
 const publisher = details?.publisher || 'n.p.';
 const year = extractYear(details?.publishedDate);
 
 if (!author) {
 return `${title}. ${place}: ${publisher}, ${year}.`;
 }
 
 // Chicago: Author Last, First. Title. Place: Publisher, Year.
 return `${author}. ${title}. ${place}: ${publisher}, ${year}.`;
 };

 const formatBook = (book: Book, details?: { publisher?: string; publishedDate?: string; publisherLocation?: string }): string => {
 switch (exportFormat) {
 case 'MLA':
 return formatMLA(book, details);
 case 'APA':
 return formatAPA(book, details);
 case 'Chicago':
 return formatChicago(book, details);
 default:
 return formatMLA(book, details);
 }
 };

 const handleExport = async () => {
 let booksToExport: Book[] = [];

 if (selectedFolderForExport) {
 // Export books from selected folder
 const folder = folders.find(f => f.id === selectedFolderForExport);
 if (folder) {
 booksToExport = books.filter(book => 
 book.id && folder.bookIds.includes(book.id)
 );
 }
 } else if (exportAll) {
 booksToExport = allSortedBooks;
 } else {
 booksToExport = allSortedBooks.filter(book => 
 selectedBooksForExport.has(book.id || `${book.title}_${book.author}`)
 );
 }

 if (booksToExport.length === 0) {
 Alert.alert('No Books Selected', 'Please select at least one book or collection to export.');
 return;
 }

 // Show loading alert
 Alert.alert('Exporting...', 'Fetching book details for proper citations. This may take a moment.');

 try {
 // Fetch details for all books (in parallel, but with rate limiting)
 const bookDetailsPromises = booksToExport.map(async (book) => {
 const details = await fetchBookDetails(book);
 // Small delay to avoid rate limiting
 await new Promise(resolve => setTimeout(resolve, 100));
 return details;
 });

 const allDetails = await Promise.all(bookDetailsPromises);

 // Format all books with their details
 const formattedCitations = booksToExport
 .map((book, index) => {
 const details = allDetails[index];
 const citation = formatBook(book, details);
 return `${index + 1}. ${citation}`;
 })
 .join('\n\n');

 // Use appropriate header based on format
 const header = exportFormat === 'MLA' 
 ? 'Works Cited' 
 : exportFormat === 'APA' 
 ? 'References' 
 : 'Bibliography';
 
 const exportText = `${header}\n\n${formattedCitations}`;

 // Copy to clipboard
 await Clipboard.setStringAsync(exportText);
 
 // Also offer to share
 const result = await Share.share({
 message: exportText,
 title: `Exported ${booksToExport.length} Book${booksToExport.length === 1 ? '' : 's'}`,
 });

 if (result.action === Share.sharedAction) {
 Alert.alert('Success', 'Books exported and copied to clipboard!');
 setShowExportModal(false);
 } else {
 Alert.alert('Success', 'Books copied to clipboard!');
 setShowExportModal(false);
 }
 } catch (error) {
 console.error('Error exporting books:', error);
 Alert.alert('Error', 'Failed to export books. Please try again.');
 }
 };

 const sortLabel = sortBy === 'oldest' ? 'Oldest' : sortBy === 'length' ? 'Length' : 'Author';

 return (
 <View style={styles.safeContainer}>
 <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
 <AppHeader
 title={mode === 'addToFavorites' ? 'Add to Favorites' :
 filterReadStatus === 'read' ? 'Read Books' :
 filterReadStatus === 'unread' ? 'Unread Books' :
 `Books (${allSortedBooks.length})`}
 onBack={() => {
 if (onClose) {
 onClose();
 } else {
 navigation.goBack();
 }
 }}
 rightSlot={mode !== 'addToFavorites' ? (
 <TouchableOpacity
 style={styles.headerSortButton}
 onPress={() => setShowSortModal(true)}
 activeOpacity={0.8}
 >
 <Text style={[styles.headerSortText, { color: t.colors.textPrimary ?? t.colors.text }]}>Sort: {sortLabel}</Text>
 <ChevronDownIcon size={14} color={t.colors.textPrimary ?? t.colors.text} style={{ marginLeft: 4 }} />
 </TouchableOpacity>
 ) : undefined}
 />

 <ScrollView 
 style={styles.mainScrollView}
 contentContainerStyle={isSelectionMode && selectedBooks.size > 0 ? { paddingBottom: 100 } : undefined}
 showsVerticalScrollIndicator={true}
 nestedScrollEnabled={false}
 >
 {/* Export Modal - Appears inline between buttons and search */}
 {showExportModal && (
 <View style={styles.exportModalInline}>
 <View style={styles.exportModalHeader}>
 <Text style={styles.exportModalTitle}>Export Books</Text>
 <TouchableOpacity
 onPress={() => setShowExportModal(false)}
 style={styles.exportModalCloseButton}
 >
 <CloseIcon size={20} color="#718096" />
 </TouchableOpacity>
 </View>

 <View style={styles.exportModalBody}>
 {/* Format Selection */}
 <View style={styles.formatSection}>
 <Text style={styles.sectionLabel}>Citation Format</Text>
 <View style={styles.formatButtons}>
 {(['MLA', 'APA', 'Chicago'] as const).map((format) => (
 <TouchableOpacity
 key={format}
 style={[
 styles.formatButton,
 exportFormat === format && styles.formatButtonActive,
 ]}
 onPress={() => setExportFormat(format)}
 >
 <Text
 style={[
 styles.formatButtonText,
 exportFormat === format && styles.formatButtonTextActive,
 ]}
 >
 {format}
 </Text>
 </TouchableOpacity>
 ))}
 </View>
 </View>

 {/* Selection Mode */}
 <View style={styles.selectionSection}>
 <Text style={styles.sectionLabel}>Select Books</Text>
 <TouchableOpacity
 style={styles.selectionOption}
 onPress={() => {
 setExportAll(true);
 setSelectedBooksForExport(new Set());
 setSelectedFolderForExport(null);
 }}
 >
 <View style={styles.radioButton}>
 {exportAll && !selectedFolderForExport && <View style={styles.radioButtonInner} />}
 </View>
 <Text style={styles.selectionOptionText}>All Books ({allSortedBooks.length})</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.selectionOption}
 onPress={() => {
 setExportAll(false);
 setSelectedFolderForExport(null);
 }}
 >
 <View style={styles.radioButton}>
 {!exportAll && !selectedFolderForExport && <View style={styles.radioButtonInner} />}
 </View>
 <Text style={styles.selectionOptionText}>Select Individual Books</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.selectionOption}
 onPress={() => {
 setExportAll(false);
 setSelectedBooksForExport(new Set());
 setShowFolderView(true);
 setSelectedFolder(null);
 }}
 >
 <View style={styles.radioButton}>
 {selectedFolderForExport !== null && <View style={styles.radioButtonInner} />}
 </View>
 <Text style={styles.selectionOptionText}>
 {folders.length > 0 ? 'Select a Collection' : 'Select a Collection (No collections yet)'}
 </Text>
 </TouchableOpacity>
 </View>

 {/* Folder Selection */}
 {folders.length > 0 && (
 <View style={styles.folderSelectionSection}>
 <Text style={styles.sectionLabel}>Collections</Text>
 <View style={styles.foldersList}>
 {folders.map((folder) => {
 const folderBooks = books.filter(book => 
 book.id && folder.bookIds.includes(book.id)
 );
 const isSelected = selectedFolderForExport === folder.id;
 return (
 <TouchableOpacity
 key={folder.id}
 style={[
 styles.folderSelectItem,
 isSelected && styles.folderSelectItemActive,
 ]}
 onPress={() => {
 if (isSelected) {
 setSelectedFolderForExport(null);
 } else {
 setSelectedFolderForExport(folder.id);
 setExportAll(false);
 setSelectedBooksForExport(new Set());
 }
 }}
 >
 <View style={styles.checkbox}>
 {isSelected && <CheckmarkIcon size={18} color="#ffffff" />}
 </View>
<FolderIcon size={24} color={isSelected ? '#0056CC' : '#718096'} style={{ marginRight: 12 }} />
 <View style={styles.folderSelectInfo}>
 <Text style={styles.folderSelectName}>{folder.name}</Text>
 <Text style={styles.folderSelectCount}>
 {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
 </Text>
 </View>
 </TouchableOpacity>
 );
 })}
 </View>
 </View>
 )}

 {/* Book Selection Info */}
 {!exportAll && !selectedFolderForExport && (
 <View style={styles.booksListSection}>
 <Text style={styles.sectionLabel}>
 Select Books ({selectedBooksForExport.size} selected)
 </Text>
 </View>
 )}
 </View>

 {/* Export Button */}
 <View style={styles.exportModalFooter}>
 <TouchableOpacity
 style={[
 styles.exportActionButton,
 (!exportAll && selectedBooksForExport.size === 0 && !selectedFolderForExport) && styles.exportActionButtonDisabled,
 ]}
 onPress={handleExport}
 disabled={!exportAll && selectedBooksForExport.size === 0 && !selectedFolderForExport}
 activeOpacity={0.8}
 >
 <DownloadIcon size={18} color="#ffffff" />
 <Text style={styles.exportActionButtonText}>Export</Text>
 </TouchableOpacity>
 </View>
 </View>
 )}

 {/* Primary row: Search full-width with Sort button embedded on right */}
 <View style={[styles.searchRow, { borderBottomColor: t.colors.divider ?? t.colors.border }]}>
 <View style={[styles.searchInputShell, { backgroundColor: t.colors.controlBg ?? t.colors.surface2, borderColor: t.colors.borderSubtle ?? t.colors.border }]}>
 <SearchIcon size={18} color={t.colors.textTertiary ?? t.colors.textMuted} style={styles.searchRowIcon} />
 <TextInput
 style={[styles.searchInput, { color: t.colors.text }]}
 placeholder={mode === 'addToFavorites' ? "Search books to add to favorites..." : "Search your library..."}
 placeholderTextColor={t.colors.textTertiary ?? t.colors.textMuted}
 value={searchQuery}
 onChangeText={setSearchQuery}
 />
 </View>
 </View>

 {/* Secondary row: Collections (left) / Export (right) */}
 {mode !== 'addToFavorites' && (
 <View style={styles.topActionRow}>
 <TouchableOpacity
 style={styles.topActionButton}
 onPress={() => {
 setShowFolderView(true);
 setSelectedFolder(null);
 }}
 activeOpacity={0.8}
 >
 <LibraryOutlineIcon size={18} color={t.colors.controlText ?? t.colors.text} />
 <Text style={[styles.topActionButtonText, { color: t.colors.controlText ?? t.colors.text }]}>Collections</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.topActionButton}
 onPress={() => setShowExportModal(true)}
 activeOpacity={0.8}
 >
 <DownloadIcon size={18} color={t.colors.controlText ?? t.colors.text} />
 <Text style={[styles.topActionButtonText, { color: t.colors.controlText ?? t.colors.text }]}>Export</Text>
 </TouchableOpacity>
 </View>
 )}

 {/* Compact selection bar only when selecting; no extra heading/divider in normal browsing state. */}
 {(mode === 'addToFavorites' || isSelectionMode) && (
 <View style={styles.gridHeaderRow}>
 <Text style={[styles.gridHeaderCount, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>
 {mode === 'addToFavorites'
 ? `${selectedBooks.size} selected`
 : `${selectedBooks.size} selected`}
 </Text>
 <TouchableOpacity
 style={[styles.chip, { backgroundColor: t.colors.controlBg ?? t.colors.surface2 }]}
 onPress={() => {
 if (mode === 'addToFavorites') {
 onClose?.();
 return;
 }
 setIsSelectionMode(false);
 setSelectedBooks(new Set());
 }}
 activeOpacity={0.7}
 >
 <Text style={[styles.chipText, { color: t.colors.controlText ?? t.colors.text }]}>Cancel</Text>
 </TouchableOpacity>
 </View>
 )}

 {allSortedBooks.length > 0 ? (
 <View style={styles.booksContainer}>
 {/* Books with data */}
 {booksWithData.length > 0 && booksWithData.map((item, index) => {
 if (index % gridColumns === 0) {
 return (
 <View key={`row-${index}`} style={styles.bookGrid}>
 {booksWithData.slice(index, index + gridColumns).map((book) => {
 const bookId = book.id ?? book.book_key ?? `${book.title}_${book.author}`;
 const isSelectedForExport = !exportAll && !selectedFolderForExport && selectedBooksForExport.has(bookId);
 const isSelectedForRead = isSelectionMode && selectedBooks.has(bookId);
 const isSelected = isSelectedForExport || isSelectedForRead;
 return (
 <Pressable
 key={book.id ?? book.book_key ?? book.title + book.author}
 style={({ pressed }) => [
 styles.bookCard,
 isSelected && styles.bookCardSelected,
 pressed && { opacity: 0.85 },
 ]}
 android_ripple={{ color: 'rgba(200,170,120,0.25)' }}
 onPress={() => {
 if (isSelectionMode) {
 setSelectedBooks(prev => {
 const newSet = new Set(prev);
 if (newSet.has(bookId)) {
 newSet.delete(bookId);
 } else {
 if (mode === 'addToFavorites' && newSet.size >= 10) {
 Alert.alert('Limit Reached', 'You can add up to 10 books at a time.');
 return prev;
 }
 newSet.add(bookId);
 }
 return newSet;
 });
 } else if (showExportModal && !exportAll && !selectedFolderForExport) {
 // In export mode, toggle selection
 const newSet = new Set(selectedBooksForExport);
 if (isSelectedForExport) {
 newSet.delete(bookId);
 } else {
 newSet.add(bookId);
 }
 setSelectedBooksForExport(newSet);
 } else {
 // Normal mode, open book detail
 openBookDetail(book);
 }
 }}
 onLongPress={() => {
 // Long-press enters selection mode (iOS-native behavior).
 if (mode === 'addToFavorites' || showExportModal) return;
 setIsSelectionMode(true);
 setSelectedBooks(prev => {
 const newSet = new Set(prev);
 newSet.add(bookId);
 return newSet;
 });
 }}
 delayLongPress={220}
 >
 {isSelectionMode && isSelectedForRead && (
 <View style={styles.bookSelectionIndicator}>
 <View style={styles.bookSelectionCheckmark}>
 <CheckmarkIcon size={16} color="#ffffff" />
 </View>
 </View>
 )}
 {getBookCoverUri(book) ? (
 <ExpoImage source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} contentFit="cover" cachePolicy="memory-disk" />
 ) : (
 <View style={[styles.bookCover, styles.placeholderCover]}>
 <BookOutlineIcon size={32} color="#a0aec0" />
 </View>
 )}
 <View style={styles.bookInfo}>
 <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
 {book.author && (
 <Text style={styles.bookAuthor} numberOfLines={2}>{book.author}</Text>
 )}
 </View>
 </Pressable>
 );
 })}
 </View>
 );
 }
 return null;
 })}

 {/* Separator for books without data */}
 {booksWithData.length > 0 && booksWithoutData.length > 0 && (
 <View style={styles.noDataSeparator}>
 <View style={styles.noDataSeparatorLine} />
 <Text style={styles.noDataSeparatorText}>
 {sortBy === 'author' && 'Books without author'}
 {sortBy === 'oldest' && 'Books without published date'}
 {sortBy === 'length' && 'Books without page count'}
 </Text>
 <View style={styles.noDataSeparatorLine} />
 </View>
 )}

 {/* Books without data */}
 {booksWithoutData.length > 0 && booksWithoutData.map((item, index) => {
 if (index % gridColumns === 0) {
 return (
 <View key={`row-no-data-${index}`} style={styles.bookGrid}>
 {booksWithoutData.slice(index, index + gridColumns).map((book) => {
 const bookId = book.id ?? book.book_key ?? `${book.title}_${book.author}`;
 const isSelectedForExport = !exportAll && !selectedFolderForExport && selectedBooksForExport.has(bookId);
 const isSelectedForRead = isSelectionMode && selectedBooks.has(bookId);
 const isSelected = isSelectedForExport || isSelectedForRead;
 return (
 <Pressable
 key={book.id ?? book.book_key ?? book.title + book.author}
 style={({ pressed }) => [
 styles.bookCard,
 isSelected && styles.bookCardSelected,
 pressed && { opacity: 0.85 },
 ]}
 android_ripple={{ color: 'rgba(200,170,120,0.25)' }}
 onPress={() => {
 if (isSelectionMode) {
 setSelectedBooks(prev => {
 const newSet = new Set(prev);
 if (newSet.has(bookId)) {
 newSet.delete(bookId);
 } else {
 if (mode === 'addToFavorites' && newSet.size >= 10) {
 Alert.alert('Limit Reached', 'You can add up to 10 books at a time.');
 return prev;
 }
 newSet.add(bookId);
 }
 return newSet;
 });
 } else if (showExportModal && !exportAll && !selectedFolderForExport) {
 // In export mode, toggle selection
 const newSet = new Set(selectedBooksForExport);
 if (isSelectedForExport) {
 newSet.delete(bookId);
 } else {
 newSet.add(bookId);
 }
 setSelectedBooksForExport(newSet);
 } else {
 // Normal mode, open book detail
 openBookDetail(book);
 }
 }}
 onLongPress={() => {
 // Long-press enters selection mode (iOS-native behavior).
 if (mode === 'addToFavorites' || showExportModal) return;
 setIsSelectionMode(true);
 setSelectedBooks(prev => {
 const newSet = new Set(prev);
 newSet.add(bookId);
 return newSet;
 });
 }}
 delayLongPress={220}
 >
 {isSelectionMode && isSelectedForRead && (
 <View style={styles.bookSelectionIndicator}>
 <View style={styles.bookSelectionCheckmark}>
 <CheckmarkIcon size={16} color="#ffffff" />
 </View>
 </View>
 )}
 {getBookCoverUri(book) ? (
 <ExpoImage source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} contentFit="cover" cachePolicy="memory-disk" />
 ) : (
 <View style={[styles.bookCover, styles.placeholderCover]}>
 <BookOutlineIcon size={32} color="#a0aec0" />
 </View>
 )}
 <View style={styles.bookInfo}>
 <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
 {book.author && (
 <Text style={styles.bookAuthor} numberOfLines={2}>{book.author}</Text>
 )}
 </View>
 </Pressable>
 );
 })}
 </View>
 );
 }
 return null;
 })}
 </View>
 ) : (
 <View style={styles.emptyContainer}>
 <LibraryOutlineIcon size={64} color="#cbd5e0" />
 <Text style={styles.emptyText}>
 {searchQuery ? 'No books found' : 'No books in your library yet'}
 </Text>
 </View>
 )}
 </ScrollView>

 {/* Bottom Action Bar for Read/Unread Selection */}
 {isSelectionMode && filterReadStatus && selectedBooks.size > 0 && (
 <View style={[styles.bottomActionBar, { paddingBottom: insets.bottom }]}>
 <Text style={styles.bottomActionBarText}>
 {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'} selected
 </Text>
 <TouchableOpacity
 style={styles.bottomActionButton}
 onPress={async () => {
 if (!user) return;
 
 const newReadAt = filterReadStatus === 'unread' ? Date.now() : null;
 const booksToUpdate = allSortedBooks.filter(book => {
 const bookId = book.id || `${book.title}_${book.author}`;
 return selectedBooks.has(bookId);
 });

 try {
 // Update AsyncStorage
 const userApprovedKey = `approved_books_${user.uid}`;
 const approvedData = await AsyncStorage.getItem(userApprovedKey);
 
 if (approvedData) {
 const approvedBooks: Book[] = JSON.parse(approvedData);
 
 const updatedBooks = approvedBooks.map((b) => {
 const matches = booksToUpdate.some(bookToUpdate => 
 b.title === bookToUpdate.title && 
 ((!b.author && !bookToUpdate.author) || (b.author === bookToUpdate.author))
 );
 
 if (matches) {
 return {
 ...b,
 readAt: newReadAt || undefined,
 };
 }
 return b;
 });
 
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 }

 // Update Supabase - CRITICAL: This must succeed for data to persist
 const { supabase } = await import('../lib/supabase');
 if (supabase) {
 const updatePromises = booksToUpdate.map(async (book) => {
 const authorForQuery = book.author || '';
 const { data: existingBook, error: findError } = await supabase
 .from('books')
 .select('id')
 .eq('user_id', user.uid)
 .eq('title', book.title)
 .eq('author', authorForQuery)
 .maybeSingle();

 if (findError) {
 console.error(` Error finding book "${book.title}" in Supabase:`, findError);
 return false;
 }

 if (existingBook) {
 // Ensure newReadAt is either a number (BIGINT) or null for Supabase
 const readAtValue = newReadAt && typeof newReadAt === 'number' && newReadAt > 0 
 ? newReadAt 
 : null;
 
 const { data, error: updateError } = await supabase
 .from('books')
 .update({
 read_at: readAtValue, // BIGINT timestamp or null
 updated_at: new Date().toISOString(),
 })
 .eq('id', existingBook.id)
 .select(); // Select to verify update

 if (updateError) {
 // Log full error details
 console.error(` Error updating book "${book.title}" in Supabase:`, JSON.stringify(updateError, null, 2));
 console.error(` - Message:`, updateError.message);
 console.error(` - Code:`, updateError.code);
 console.error(` - Details:`, updateError.details);
 console.error(` - Hint:`, updateError.hint);
 console.error(` - Book ID:`, existingBook.id);
 console.error(` - ReadAt Value:`, readAtValue, `(type: ${typeof readAtValue})`);
 console.error(` - User ID:`, user.uid);
 return false;
 }
 
 if (!data || data.length === 0) {
 console.warn(` Book "${book.title}" update returned no data - update may have failed`);
 return false;
 }
 
 console.log(` Updated book "${book.title}" read_at to:`, readAtValue);
 console.log(` - Updated record:`, data[0]);
 return true;
 } else {
 console.warn(` Book "${book.title}" not found in Supabase, cannot update read_at`);
 return false;
 }
 });

 const results = await Promise.all(updatePromises);
 const successCount = results.filter(r => r === true).length;
 console.log(` Supabase update: ${successCount}/${booksToUpdate.length} books updated successfully`);
 }

 // Update local state immediately with proper readAt values
 // This ensures books disappear/appear in the correct view right away
 // Use functional update to ensure we're working with latest state
 setBooks(prevBooks => {
 const updatedBooksList = prevBooks.map(b => {
 const matches = booksToUpdate.some(bookToUpdate => 
 b.title === bookToUpdate.title && 
 ((!b.author && !bookToUpdate.author) || (b.author === bookToUpdate.author))
 );
 
 if (matches) {
 // Ensure readAt is a number (timestamp) or undefined (not null)
 const readAtValue = newReadAt && typeof newReadAt === 'number' && newReadAt > 0 
 ? newReadAt 
 : undefined;
 const updatedBook = {
 ...b,
 readAt: readAtValue,
 };
 console.log(` Updated book "${b.title}" readAt from ${b.readAt} to:`, readAtValue);
 return updatedBook;
 }
 return b;
 });
 
 // Debug: log how many books have readAt after update
 const readCount = updatedBooksList.filter(b => b.readAt && typeof b.readAt === 'number' && b.readAt > 0).length;
 const unreadCount = updatedBooksList.filter(b => !b.readAt || (typeof b.readAt === 'number' && b.readAt <= 0)).length;
 console.log(` After state update - Read: ${readCount}, Unread: ${unreadCount}, Total: ${updatedBooksList.length}`);
 
 // Debug: log which books are read
 const readBooks = updatedBooksList.filter(b => b.readAt && typeof b.readAt === 'number' && b.readAt > 0);
 if (readBooks.length > 0) {
 console.log(` Read books:`, readBooks.map(b => `"${b.title}" (readAt: ${b.readAt})`));
 }
 
 return updatedBooksList;
 });

 // Clear selection and exit selection mode
 setSelectedBooks(new Set());
 setIsSelectionMode(false);
 
 // Notify parent component immediately so counts update
 if (onBooksUpdated) {
 onBooksUpdated();
 }
 
 // DON'T reload immediately - the state update above is sufficient
 // Reloading too quickly can cause race conditions where Supabase hasn't
 // processed the update yet, causing books to revert to their old state
 // The state update above ensures UI reflects changes immediately
 // Supabase will sync in the background, and we'll reload when switching views
 } catch (error) {
 console.error('Error updating read status:', error);
 Alert.alert('Error', 'Failed to update read status. Please try again.');
 }
 }}
 activeOpacity={0.8}
 >
 <Text style={styles.bottomActionButtonText}>
 {filterReadStatus === 'unread' ? 'Add to Read' : 'Remove from Read'}
 </Text>
 </TouchableOpacity>
 </View>
 )}

 <BookDetailModal
 visible={showBookDetail}
 book={selectedBook}
 photo={selectedPhoto}
 onClose={() => {
 setShowBookDetail(false);
 setSelectedBook(null);
 }}
 onRequireAuth={() => setShowAuthGateModal(true)}
 onRequestSync={loadBooks}
 onBookUpdate={(updatedBook) => {
 setBooks(prev => prev.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 ));
 setSelectedBook(updatedBook);
 }}
 onDeleteBook={async (book) => {
 if (!user) return;
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.filter(b => b.id !== book.id);
 setBooks(updatedBooks);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 setShowBookDetail(false);
 setSelectedBook(null);
 } catch (error) {
 console.error('Error deleting book:', error);
 }
 }}
 onEditBook={async (book) => {
 if (!user) return;
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.map(b => 
 b.id === book.id || (b.title === book.title && b.author === book.author)
 ? book
 : b
 );
 setBooks(prev => dedupeBooks([...prev, ...updatedBooks]));
 setSelectedBook(book);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 setTimeout(() => {
 loadBooks();
 }, 500);
 } catch (error) {
 console.error('Error editing book:', error);
 }
 }}
 onAddBookToFolder={() => {}}
 folders={[]}
 />

 <AuthGateModal
 visible={showAuthGateModal}
 onClose={() => setShowAuthGateModal(false)}
 onSignIn={() => setShowAuthGateModal(false)}
 onCreateAccount={() => setShowAuthGateModal(false)}
 />

 {/* Folder View - Full Screen Page */}
 <Modal
 visible={showFolderView}
 animationType="slide"
 presentationStyle="fullScreen"
 transparent={false}
 onRequestClose={() => {
 setShowFolderView(false);
 setSelectedFolder(null);
 setIsFolderSelectionMode(false);
 setSelectedFolderBooks(new Set());
 setFolderSearchQuery('');
 setIsFolderListSelectionMode(false);
 setSelectedFolders(new Set());
 }}
 >
 <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
 <AppHeader
 title={selectedFolder?.name || (isCreatingFolder ? 'Create Collection' : 'Collections')}
 onBack={() => {
 if (isCreatingFolder) {
 // If creating folder, just go back to folders list
 setIsCreatingFolder(false);
 setSelectedBooksForNewFolder(new Set());
 setNewFolderNameInput('');
 setShowFolderNameInput(false);
 } else if (selectedFolder) {
 // If viewing a folder, go back to folders list
 setSelectedFolder(null);
 setIsFolderSelectionMode(false);
 setSelectedFolderBooks(new Set());
 setFolderSearchQuery('');
 } else {
 // Otherwise, close the folder view entirely
 setShowFolderView(false);
 setSelectedFolder(null);
 setIsFolderSelectionMode(false);
 setSelectedFolderBooks(new Set());
 setFolderSearchQuery('');
 setIsFolderListSelectionMode(false);
 setSelectedFolders(new Set());
 }
 }}
 />

 {!selectedFolder && !isCreatingFolder && (
 <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.centeredContent, { paddingTop: 4, paddingHorizontal: 20 }]}>
 {/* Action Buttons Row */}
 {!isFolderListSelectionMode && (
 <>
 <View style={styles.collectionsIntro}>
 <Text style={styles.collectionsIntroTitle}>Collections</Text>
 <Text style={styles.collectionsIntroSubtitle}>Organize your library into custom shelves.</Text>
 </View>
 <TouchableOpacity
 style={styles.createFolderMainButton}
 onPress={() => {
 setIsCreatingFolder(true);
 setSelectedBooksForNewFolder(new Set());
 }}
 activeOpacity={0.85}
 >
 <Text style={styles.createFolderMainButtonText}> Create Collection</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[
 styles.autoSortButtonFullPage,
 (isAutoSorting || books.length === 0) && styles.autoSortButtonDisabled,
 ]}
 onPress={autoSortBooksIntoFolders}
 activeOpacity={0.8}
 disabled={isAutoSorting || books.length === 0}
 >
 <Text style={styles.autoSortButtonText}>
 {isAutoSorting ? 'Sorting...' : 'Auto-organize by author or genre'}
 </Text>
 </TouchableOpacity>
 {folders.length > 0 && (
 <TouchableOpacity
 style={styles.manageCollectionsButton}
 onPress={() => {
 setIsFolderListSelectionMode(!isFolderListSelectionMode);
 if (isFolderListSelectionMode) {
 setSelectedFolders(new Set());
 }
 }}
 activeOpacity={0.7}
 >
 <Text style={styles.manageCollectionsButtonText}>
 {isFolderListSelectionMode ? 'Cancel selection' : 'Select collections'}
 </Text>
 </TouchableOpacity>
 )}
 </>
 )}
 {isFolderListSelectionMode && selectedFolders.size > 0 && (
 <View style={styles.foldersActionButtonsRow}>
 <TouchableOpacity
 style={styles.deleteFoldersButton}
 onPress={async () => {
 const folderCount = selectedFolders.size;
 Alert.alert(
 'Delete Collections',
 `Are you sure you want to delete ${folderCount} collection${folderCount === 1 ? '' : 's'}? This will not delete the books, they will remain in your library.`,
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Delete',
 style: 'destructive',
 onPress: async () => {
 if (!user) return;
 const updatedFolders = folders.filter(f => !selectedFolders.has(f.id));
 setFolders(updatedFolders);
 
 const foldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
 
 setSelectedFolders(new Set());
 setIsFolderListSelectionMode(false);
 
 Alert.alert('Success', `${folderCount} collection${folderCount === 1 ? '' : 's'} deleted.`);
 },
 },
 ]
 );
 }}
 activeOpacity={0.7}
 >
 <TrashIcon size={20} color="#ffffff" style={{ marginRight: 6 }} />
 <Text style={styles.deleteFoldersButtonText}>
 Delete ({selectedFolders.size})
 </Text>
 </TouchableOpacity>
 </View>
 )}

 {folders.length > 0 ? (
 <>
 {isFolderListSelectionMode && selectedFolders.size > 0 && (
 <View style={[styles.selectionBar, { marginHorizontal: 20, marginTop: 20, marginBottom: 10 }]}>
 <Text style={styles.selectionCount}>
 {selectedFolders.size} collection{selectedFolders.size === 1 ? '' : 's'} selected
 </Text>
 </View>
 )}
 <Text style={[styles.sectionLabel, { marginTop: 24 }]}>Your Collections</Text>
 <View style={styles.foldersGrid}>
 {folders.map((folder) => {
 const folderBooks = books.filter(book => 
 book.id && folder.bookIds.includes(book.id)
 );
 const isSelected = isFolderListSelectionMode && selectedFolders.has(folder.id);
 return (
 <TouchableOpacity
 key={folder.id}
 style={[
 styles.folderCard,
 isFolderListSelectionMode && styles.folderCardSmall,
 isSelected && { backgroundColor: '#0056CC40', borderColor: '#0056CC', borderWidth: 2 }
 ]}
 onPress={() => {
 if (isFolderListSelectionMode) {
 const newSelected = new Set(selectedFolders);
 if (isSelected) {
 newSelected.delete(folder.id);
 } else {
 newSelected.add(folder.id);
 }
 setSelectedFolders(newSelected);
 } else {
 setSelectedFolder(folder);
 }
 }}
 activeOpacity={0.7}
 >
 {isFolderListSelectionMode && (
 <View style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}>
 <View style={{
 width: 24,
 height: 24,
 borderRadius: 12,
 borderWidth: 2,
 borderColor: isSelected ? '#0056CC' : '#718096',
 backgroundColor: isSelected ? '#0056CC' : '#ffffff',
 justifyContent: 'center',
 alignItems: 'center',
 }}>
 {isSelected && <CheckmarkIcon size={14} color="#ffffff" />}
 </View>
 </View>
 )}
 <View style={styles.folderIcon}>
 <LibraryOutlineIcon size={32} color="#0056CC" />
 </View>
 <Text 
 style={[styles.folderName, isFolderListSelectionMode && styles.folderNameSmall]} 
 numberOfLines={isFolderListSelectionMode ? 2 : 1}
 >
 {folder.name}
 </Text>
 <Text style={styles.folderBookCount}>
 {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
 </Text>
 </TouchableOpacity>
 );
 })}
 </View>
 </>
 ) : (
 <View style={styles.emptyContainer}>
 <LibraryOutlineIcon size={64} color={t.colors.textTertiary ?? t.colors.textMuted} />
 <Text style={styles.emptyText}>No collections yet</Text>
 <Text style={styles.emptyCollectionsText}>
 Create collections like "Favorites", "To Read", or "Sci-Fi".
 </Text>
 </View>
 )}

 </ScrollView>
 )}

 {isCreatingFolder && !selectedFolder && (
 <>
 <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.centeredContent, { paddingTop: 20, paddingBottom: 100 }]}>
 {!showFolderNameInput ? (
 <>
 {/* Select Books Section */}
 <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
 <Text style={styles.sectionLabel}>Select Books for Collection</Text>
 <Text style={{ fontSize: 14, color: '#718096', marginTop: 8 }}>
 Tap books below to select them, then name your collection
 </Text>
 </View>

 {/* Search Bar */}
 <View style={[styles.searchContainer, { marginHorizontal: 20, marginBottom: 20 }]}>
 <SearchIcon size={20} color="#718096" style={styles.searchIcon} />
 <TextInput
 style={styles.searchInput}
 value={createFolderSearchQuery}
 onChangeText={setCreateFolderSearchQuery}
 placeholder="Search by title or author..."
 autoCapitalize="none"
 autoCorrect={false}
 clearButtonMode="never"
 />
 {createFolderSearchQuery.length > 0 && (
 <TouchableOpacity
 onPress={() => setCreateFolderSearchQuery('')}
 style={styles.librarySearchClear}
 hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
 <Text style={styles.librarySearchClearText}>×</Text>
 </TouchableOpacity>
 )}
 </View>

 {/* Books Grid for Selection */}
 <View style={styles.booksContainer}>
 {createFolderFilteredBooks.map((_, index) => {
 if (index % gridColumns === 0) {
 return (
 <View key={`row-${index}`} style={styles.bookGrid}>
 {createFolderFilteredBooks.slice(index, index + gridColumns).map((book) => {
 const bookId = book.id ?? book.book_key ?? `${book.title}_${book.author}`;
 const isSelected = selectedBooksForNewFolder.has(bookId);
 return (
 <Pressable
 key={book.id ?? book.book_key ?? book.title + book.author}
 style={({ pressed }) => [
 styles.bookCard,
 isSelected && styles.bookCardSelected,
 pressed && { opacity: 0.85 },
 ]}
 android_ripple={{ color: 'rgba(200,170,120,0.25)' }}
 onPress={() => {
 setSelectedBooksForNewFolder(prev => {
 const newSet = new Set(prev);
 if (newSet.has(bookId)) {
 newSet.delete(bookId);
 } else {
 newSet.add(bookId);
 }
 return newSet;
 });
 }}
 >
 {getBookCoverUri(book) ? (
 <ExpoImage source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} contentFit="cover" cachePolicy="memory-disk" />
 ) : (
 <View style={[styles.bookCover, styles.placeholderCover]}>
 <BookOutlineIcon size={32} color="#a0aec0" />
 </View>
 )}
 <View style={styles.bookInfo}>
 <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
 {book.author && (
 <Text style={styles.bookAuthor} numberOfLines={2}>{book.author}</Text>
 )}
 </View>
 </Pressable>
 );
 })}
 </View>
 );
 }
 return null;
 })}
 </View>
 </>
 ) : (
 <>
 {/* Name Folder Section */}
 <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
 <Text style={styles.sectionLabel}>Name Your Collection</Text>
 <Text style={{ fontSize: 14, color: '#718096', marginTop: 8 }}>
 {selectedBooksForNewFolder.size} {selectedBooksForNewFolder.size === 1 ? 'book' : 'books'} selected
 </Text>
 </View>

 <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
 <TextInput
 style={[styles.createFolderInput, { width: '100%', padding: 16, fontSize: 16 }]}
 placeholder="Collection name"
 placeholderTextColor="#a0aec0"
 value={newFolderNameInput}
 onChangeText={setNewFolderNameInput}
 autoFocus={true}
 />
 </View>

 <View style={{ paddingHorizontal: 20, flexDirection: 'row', gap: 12 }}>
 <TouchableOpacity
 style={[styles.createFolderActionButton, styles.createFolderCancelButton]}
 onPress={() => {
 setIsCreatingFolder(false);
 setSelectedBooksForNewFolder(new Set());
 setNewFolderNameInput('');
 setShowFolderNameInput(false);
 }}
 activeOpacity={0.8}
 >
 <Text style={styles.createFolderCancelButtonText}>Cancel</Text>
 </TouchableOpacity>

 <TouchableOpacity
 style={[
 styles.createFolderActionButton,
 styles.createFolderConfirmButton,
 !newFolderNameInput.trim() && styles.createFolderButtonDisabled,
 ]}
 onPress={() => handleCreateFolder()}
 disabled={!newFolderNameInput.trim()}
 activeOpacity={0.8}
 >
 <Text style={styles.createFolderConfirmButtonText}>Create</Text>
 </TouchableOpacity>
 </View>
 </>
 )}
 </ScrollView>
 
 {/* Bottom Create Folder Button - Only show when selecting books */}
 {!showFolderNameInput && selectedBooksForNewFolder.size > 0 && (
 <View style={styles.createFolderBottomTab}>
 <TouchableOpacity
 style={styles.createFolderBottomButton}
 onPress={() => {
 setShowFolderNameInput(true);
 }}
 activeOpacity={0.8}
 >
 <Text style={styles.createFolderBottomButtonText}>
 Create Collection ({selectedBooksForNewFolder.size} {selectedBooksForNewFolder.size === 1 ? 'book' : 'books'})
 </Text>
 </TouchableOpacity>
 </View>
 )}
 </>
 )}

 {selectedFolder && (
 <ScrollView style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.centeredContent, { paddingTop: 20 }]}>
 {/* Search Bar */}
 <View style={[styles.librarySearchContainer, { marginHorizontal: 20, marginTop: 0 }]}>
 <TextInput
 style={styles.librarySearchInput}
 value={folderSearchQuery}
 onChangeText={setFolderSearchQuery}
 placeholder="Search by title or author..."
 autoCapitalize="none"
 autoCorrect={false}
 clearButtonMode="never"
 />
 {folderSearchQuery.length > 0 && (
 <TouchableOpacity
 onPress={() => setFolderSearchQuery('')}
 style={styles.folderLibrarySearchClear}
 hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
 <Text style={styles.folderLibrarySearchClearText}>×</Text>
 </TouchableOpacity>
 )}
 </View>

 {/* Select Button */}
 <View style={styles.folderSelectButtonContainer}>
 <TouchableOpacity
 style={styles.folderSelectButton}
 onPress={() => {
 setIsFolderSelectionMode(!isFolderSelectionMode);
 if (isFolderSelectionMode) {
 setSelectedFolderBooks(new Set());
 }
 }}
 activeOpacity={0.7}
 >
 <Text style={styles.folderSelectButtonText}>
 {isFolderSelectionMode ? 'Cancel' : 'Select'}
 </Text>
 </TouchableOpacity>
 </View>

 {/* Selection Mode Indicator */}
 {isFolderSelectionMode && selectedFolderBooks.size > 0 && (
 <View style={styles.folderSelectionBar}>
 <Text style={styles.folderSelectionCount}>
 {selectedFolderBooks.size} {selectedFolderBooks.size === 1 ? 'book' : 'books'} selected
 </Text>
 <TouchableOpacity
 style={styles.clearSelectionButton}
 onPress={() => setSelectedFolderBooks(new Set())}
 activeOpacity={0.7}
 >
 <Text style={styles.clearSelectionText}>Clear</Text>
 </TouchableOpacity>
 </View>
 )}

 {(() => {
 let folderBooks = books.filter(book => 
 book.id && selectedFolder.bookIds.includes(book.id)
 );

 // Filter books by search query if provided
 if (folderSearchQuery.trim()) {
 const query = folderSearchQuery.trim().toLowerCase();
 folderBooks = folderBooks.filter(book => {
 const title = (book.title || '').toLowerCase();
 const author = (book.author || '').toLowerCase();
 return title.includes(query) || author.includes(query);
 });
 }

 // No photos, just show books (or empty state)
 if (folderBooks.length === 0) {
 return (
 <View style={styles.emptyState}>
 <Text style={styles.emptyStateText}>
 {folderSearchQuery ? 'No books found' : 'No Books in Collection'}
 </Text>
 <Text style={styles.emptyStateSubtext}>
 {folderSearchQuery ? 'Try a different search term' : 'Books you add to this collection will appear here'}
 </Text>
 </View>
 );
 }

 return (
 <View style={styles.booksSection}>
 <View style={styles.sectionHeader}>
 <Text style={styles.sectionTitle}>
 {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
 </Text>
 </View>
 <FlatList
 key={`library-folder-grid-${gridColumns}`}
 data={folderBooks}
 renderItem={renderFolderBook}
 keyExtractor={(item, index) => `${item.title}-${item.author || ''}-${index}`}
 numColumns={gridColumns}
 scrollEnabled={false}
 showsVerticalScrollIndicator={false}
 contentContainerStyle={styles.booksGrid}
 columnWrapperStyle={styles.bookRow}
 />
 </View>
 );
 })()}
 </ScrollView>
 )}

 {/* Book Detail Modal - Inside folder view so it appears on top */}
 <BookDetailModal
 visible={showBookDetail}
 book={selectedBook}
 photo={selectedPhoto}
 onClose={() => {
 setShowBookDetail(false);
 setSelectedBook(null);
 }}
 onRequireAuth={() => setShowAuthGateModal(true)}
 onRequestSync={loadBooks}
 onBookUpdate={(updatedBook) => {
 // Update the book in state when description/stats are fetched
 setBooks(prev => prev.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 ));
 setSelectedBook(updatedBook); // Update the selected book too
 }}
 onDeleteBook={async (book) => {
 if (!user) return;
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.filter(b => b.id !== book.id);
 setBooks(updatedBooks);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 setShowBookDetail(false);
 setSelectedBook(null);
 } catch (error) {
 console.error('Error deleting book:', error);
 }
 }}
 onEditBook={async (book) => {
 if (!user) return;
 try {
 // Update local state immediately
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.map(b => 
 b.id === book.id || (b.title === book.title && b.author === book.author)
 ? book
 : b
 );
 setBooks(prev => dedupeBooks([...prev, ...updatedBooks]));
 setSelectedBook(book);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 
 // Reload from Supabase to ensure all views are updated
 setTimeout(() => {
 loadBooks();
 }, 500);
 } catch (error) {
 console.error('Error editing book:', error);
 }
 }}
 onAddBookToFolder={() => {}}
 folders={[]}
 />
 </SafeAreaView>
 </Modal>

 {/* Sort Modal */}
 <Modal
 visible={showSortModal}
 transparent={true}
 animationType="fade"
 onRequestClose={() => setShowSortModal(false)}
 >
 <TouchableOpacity
 style={styles.modalOverlay}
 activeOpacity={1}
 onPress={() => setShowSortModal(false)}
 >
 <View style={styles.sortModalContent}>
 <Text style={styles.sortModalTitle}>Sort Books</Text>
 
 <TouchableOpacity
 style={[styles.sortOption, sortBy === 'author' && styles.sortOptionSelected]}
 onPress={() => {
 setSortBy('author');
 setShowSortModal(false);
 }}
 activeOpacity={0.7}
 >
 <Text style={[styles.sortOptionText, sortBy === 'author' && styles.sortOptionTextSelected]}>
 By Author (Last Name)
 </Text>
 {sortBy === 'author' && <CheckmarkIcon size={20} color="#0056CC" />}
 </TouchableOpacity>

 <TouchableOpacity
 style={[styles.sortOption, sortBy === 'oldest' && styles.sortOptionSelected]}
 onPress={() => {
 setSortBy('oldest');
 setShowSortModal(false);
 }}
 activeOpacity={0.7}
 >
 <Text style={[styles.sortOptionText, sortBy === 'oldest' && styles.sortOptionTextSelected]}>
 Oldest to Newest
 </Text>
 {sortBy === 'oldest' && <CheckmarkIcon size={20} color="#0056CC" />}
 </TouchableOpacity>

 <TouchableOpacity
 style={[styles.sortOption, sortBy === 'length' && styles.sortOptionSelected]}
 onPress={() => {
 setSortBy('length');
 setShowSortModal(false);
 }}
 activeOpacity={0.7}
 >
 <Text style={[styles.sortOptionText, sortBy === 'length' && styles.sortOptionTextSelected]}>
 By Length (Pages)
 </Text>
 {sortBy === 'length' && <CheckmarkIcon size={20} color="#0056CC" />}
 </TouchableOpacity>

 <TouchableOpacity
 style={styles.sortModalCancel}
 onPress={() => setShowSortModal(false)}
 activeOpacity={0.7}
 >
 <Text style={styles.sortModalCancelText}>Cancel</Text>
 </TouchableOpacity>
 </View>
 </TouchableOpacity>
 </Modal>

 {/* Bottom Delete Bar - Appears when books are selected */}
 {isSelectionMode && selectedBooks.size > 0 && (
 <View style={styles.bottomDeleteBarContainer}>
 <View style={[styles.bottomDeleteBar, { paddingBottom: insets.bottom }]}>
 <View style={styles.bottomDeleteBarLeft}>
 <Text style={styles.bottomDeleteBarCount} numberOfLines={1}>
 {mode === 'addToFavorites'
 ? `${selectedBooks.size} of 10 selected`
 : `${selectedBooks.size} ${selectedBooks.size === 1 ? 'book' : 'books'} selected`}
 </Text>
 </View>
 <View style={styles.bottomDeleteBarRight}>
 <TouchableOpacity
 style={[styles.bottomDeleteBarCancelButton, { marginRight: 12 }]}
 onPress={() => {
 setSelectedBooks(new Set());
 setIsSelectionMode(false);
 }}
 activeOpacity={0.7}
 >
 <Text style={styles.bottomDeleteBarCancelText}>Cancel</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.bottomDeleteBarDeleteButton, mode === 'addToFavorites' && { backgroundColor: '#4caf50' }]}
 onPress={mode === 'addToFavorites' ? addSelectedToFavorites : deleteSelectedBooks}
 activeOpacity={0.7}
 >
 {mode === 'addToFavorites' ? (
 <>
 <StarIcon size={20} color={t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878'} style={{ marginRight: 6 }} />
 <Text style={styles.bottomDeleteBarDeleteText}>Add to Favorites</Text>
 </>
 ) : (
 <>
 <TrashIcon size={20} color={t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878'} style={{ marginRight: 6 }} />
 <Text style={styles.bottomDeleteBarDeleteText}>Delete</Text>
 </>
 )}
 </TouchableOpacity>
 </View>
 </View>
 </View>
 )}
 </SafeAreaView>
 </View>
 );
};

const getStyles = (
 screenWidth: number,
 screenHeight: number,
 t: { colors: Record<string, string | undefined> },
 gridColumns: number,
 typeScale: number,
 gridItemWidth: number,
 gridHorizontalPadding: number,
 gridGap: number
) => StyleSheet.create({
 safeContainer: {
 flex: 1,
 backgroundColor: t.colors.bg ?? t.colors.backgroundPrimary ?? '#f8f9fa',
 position: 'relative',
 },
 mainScrollView: {
 flex: 1,
 },
 container: {
 flex: 1,
 },
 centeredContent: {
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 headerSortButton: {
 minHeight: 32,
 minWidth: 96,
 paddingHorizontal: 8,
 borderRadius: 10,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'flex-end',
 backgroundColor: 'transparent',
 },
 headerSortText: {
 fontSize: 12,
 fontWeight: '600',
 },
 /** Secondary top action row: Folders (left) / Export (right). */
 topActionRow: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 16,
 paddingVertical: 8,
 minHeight: 44,
 },
 topActionButton: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 gap: 6,
 paddingVertical: 10,
 paddingHorizontal: 14,
 borderRadius: 12,
 minHeight: 40,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2 ?? '#f0ece6',
 },
 topActionButtonText: {
 fontSize: 15,
 fontWeight: '600',
 },
 /** Primary row: full-width search with sort embedded on right. */
 searchRow: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 16,
 paddingVertical: 8,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.divider ?? t.colors.border ?? '#e2e8f0',
 },
 searchInputShell: {
 flex: 1,
 flexDirection: 'row',
 alignItems: 'center',
 borderRadius: 14,
 borderWidth: 1,
 minHeight: 38,
 paddingHorizontal: 10,
 },
 searchRowIcon: {
 marginRight: 8,
 },
 searchInput: {
 flex: 1,
 paddingVertical: 6,
 paddingHorizontal: 0,
 fontSize: 15,
 minHeight: 36,
 },
 sortIconButton: {
 width: 30,
 height: 30,
 borderRadius: 10,
 alignItems: 'center',
 justifyContent: 'center',
 },
 /** Grid header keeps selection control near content, not in global top controls. */
 gridHeaderRow: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 16,
 paddingVertical: 8,
 },
 gridHeaderCount: {
 fontSize: 13,
 fontWeight: '600',
 letterSpacing: 0.2,
 },
 /** Compact chip row: Select (or Cancel in addToFavorites) */
 chipRow: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 16,
 paddingVertical: 8,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.divider ?? t.colors.border ?? '#e2e8f0',
 gap: 8,
 },
 chip: {
 paddingVertical: 8,
 paddingHorizontal: 14,
 borderRadius: 12,
 minHeight: 36,
 justifyContent: 'center',
 },
 chipText: {
 fontSize: 14,
 fontWeight: '600',
 },
 searchContainer: {
 paddingHorizontal: 20,
 paddingTop: 12,
 paddingBottom: 8,
 position: 'relative',
 },
 searchIcon: {
 position: 'absolute',
 right: 35,
 top: 30,
 },
 librarySearchClear: {
 position: 'absolute',
 right: 15,
 top: 18,
 width: 24,
 height: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: '#e2e8f0',
 },
 librarySearchClearText: {
 fontSize: 18,
 color: '#718096',
 lineHeight: 20,
 },
 booksContainer: {
 paddingHorizontal: gridHorizontalPadding,
 paddingBottom: 20,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
 bookGrid: {
 flexDirection: 'row',
 justifyContent: 'flex-start',
 gap: gridGap,
 marginBottom: BOOK_GRID_VERTICAL_GAP,
 },
 bookCard: {
 width: gridItemWidth,
 alignItems: 'center',
 marginBottom: 0,
 paddingHorizontal: 0,
 position: 'relative',
 },
 bookCardSelected: {
 // No style changes to avoid layout shifts - selection is indicated by checkmark overlay
 },
 bookSelectionIndicator: {
 position: 'absolute',
 top: 4,
 right: 4,
 zIndex: 10,
 },
 bookSelectionCheckmark: {
 width: 24,
 height: 24,
 borderRadius: 12,
 backgroundColor: '#4299e1',
 justifyContent: 'center',
 alignItems: 'center',
 borderWidth: 2,
 borderColor: '#ffffff',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.3,
 shadowRadius: 4,
 elevation: 4,
 },
 selectedBookCard: {
 borderWidth: 2,
 borderColor: '#4299e1',
 borderRadius: 8,
 padding: 2,
 },
 selectionOverlay: {
 position: 'absolute',
 top: 4,
 right: 4,
 zIndex: 10,
 },
 selectionCheckmark: {
 width: 28,
 height: 28,
 borderRadius: 14,
 backgroundColor: '#ffffff',
 justifyContent: 'center',
 alignItems: 'center',
 },
 coverWrap: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 8,
 marginBottom: 6,
 overflow: 'hidden',
 position: 'relative',
 },
 selectionCoverOverlay: {
 ...StyleSheet.absoluteFillObject,
 backgroundColor: 'rgba(0,0,0,0.2)',
 borderRadius: 8,
 },
 bookCoverInWrap: { marginBottom: 0 },
 bookCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 8,
 backgroundColor: '#e2e8f0',
 marginBottom: 6,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 4,
 elevation: 3,
 },
 selectedBookCover: {
 opacity: 0.7,
 },
 placeholderCover: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 backgroundColor: '#f7fafc',
 borderWidth: 0,
 },
 bookInfo: {
 width: '100%',
 alignItems: 'center',
 marginTop: 4,
 flexShrink: 1,
 minHeight: 0,
 },
 bookTitle: {
 fontSize: 13 * typeScale,
 fontWeight: '500',
 color: t.colors.textPrimary ?? '#1a202c',
 textAlign: 'center',
 marginBottom: 4,
 lineHeight: 17,
 textTransform: 'none',
 width: '100%',
 flexShrink: 1,
 },
 bookAuthor: {
 fontSize: 11 * typeScale,
 color: t.colors.textSecondary ?? t.colors.textMuted ?? '#718096',
 textAlign: 'center',
 fontWeight: '400',
 lineHeight: 14,
 opacity: 0.7,
 textTransform: 'none',
 width: '100%',
 flexShrink: 1,
 },
 bookDescriptionHint: {
 fontSize: 10,
 color: '#a0aec0',
 textAlign: 'center',
 marginTop: 2,
 width: '100%',
 },
 emptyContainer: {
 flex: 1,
 justifyContent: 'center',
 alignItems: 'center',
 paddingVertical: 52,
 paddingHorizontal: 20,
 },
 emptyText: {
 fontSize: 22,
 color: t.colors.textPrimary ?? t.colors.text,
 marginTop: 14,
 fontWeight: '700',
 },
 emptyCollectionsText: {
 fontSize: 15,
 color: t.colors.textSecondary ?? t.colors.textMuted ?? t.colors.text,
 marginTop: 8,
 textAlign: 'center',
 lineHeight: 22,
 },
 exportButtonContainer: {
 paddingHorizontal: 20,
 paddingTop: 10,
 paddingBottom: 8,
 position: 'relative',
 zIndex: 100,
 },
 topActionButtonsRow: {
 flexDirection: 'row',
 gap: 10,
 },
 exportButton: {
 flex: 1,
 backgroundColor: '#718096',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 20,
 borderRadius: 12,
 gap: 8,
 },
 foldersButton: {
 flex: 1,
 backgroundColor: '#718096',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 20,
 borderRadius: 12,
 gap: 8,
 },
 autoSortButton: {
 flex: 1,
 backgroundColor: '#48bb78',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 20,
 borderRadius: 12,
 gap: 8,
 opacity: 1,
 },
 exportButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 modalBackdrop: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 bottom: 0,
 backgroundColor: 'rgba(0, 0, 0, 0.3)',
 zIndex: 998,
 },
 modalContent: {
 position: 'absolute',
 top: 58, // Position below export button (10 padding + 38 button height + 8 padding + 2 margin)
 left: 0,
 right: 0,
 backgroundColor: '#ffffff',
 borderRadius: 16,
 maxHeight: 500,
 paddingBottom: 20,
 zIndex: 1001,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: 0.2,
 shadowRadius: 12,
 elevation: 10,
 marginHorizontal: 0,
 },
 modalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 padding: 20,
 borderBottomWidth: 1,
 borderBottomColor: '#e2e8f0',
 },
 modalTitle: {
 fontSize: 22,
 fontWeight: '700',
 color: '#1a202c',
 },
 modalCloseButton: {
 padding: 5,
 },
 modalBody: {
 flex: 1,
 padding: 20,
 },
 formatSection: {
 marginBottom: 24,
 },
 selectionSection: {
 marginBottom: 24,
 },
 sectionLabel: {
 fontSize: 16,
 fontWeight: '600',
 color: '#2d3748',
 marginBottom: 12,
 },
 formatButtons: {
 flexDirection: 'row',
 gap: 10,
 },
 formatButton: {
 flex: 1,
 paddingVertical: 12,
 paddingHorizontal: 16,
 borderRadius: 10,
 backgroundColor: '#f7fafc',
 borderWidth: 2,
 borderColor: '#e2e8f0',
 alignItems: 'center',
 },
 formatButtonActive: {
 backgroundColor: '#2d3748',
 borderColor: '#2d3748',
 },
 formatButtonText: {
 fontSize: 15,
 fontWeight: '600',
 color: '#4a5568',
 },
 formatButtonTextActive: {
 color: '#ffffff',
 },
 selectionOption: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 12,
 marginBottom: 8,
 },
 radioButton: {
 width: 24,
 height: 24,
 borderRadius: 12,
 borderWidth: 2,
 borderColor: '#cbd5e0',
 marginRight: 12,
 justifyContent: 'center',
 alignItems: 'center',
 backgroundColor: '#ffffff',
 },
 radioButtonInner: {
 width: 12,
 height: 12,
 borderRadius: 6,
 backgroundColor: '#2d3748',
 },
 selectionOptionText: {
 fontSize: 16,
 color: '#1a202c',
 fontWeight: '500',
 },
 booksListSection: {
 marginBottom: 20,
 },
 booksList: {
 maxHeight: 300,
 backgroundColor: '#f7fafc',
 borderRadius: 12,
 padding: 10,
 },
 bookSelectItem: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 12,
 paddingHorizontal: 10,
 marginBottom: 4,
 backgroundColor: '#ffffff',
 borderRadius: 8,
 },
 checkbox: {
 width: 24,
 height: 24,
 borderRadius: 6,
 borderWidth: 2,
 borderColor: '#cbd5e0',
 marginRight: 12,
 justifyContent: 'center',
 alignItems: 'center',
 backgroundColor: '#ffffff',
 },
 bookSelectInfo: {
 flex: 1,
 },
 bookSelectTitle: {
 fontSize: 15,
 fontWeight: '600',
 color: '#1a202c',
 marginBottom: 2,
 },
 bookSelectAuthor: {
 fontSize: 13,
 color: '#718096',
 },
 modalFooter: {
 padding: 20,
 borderTopWidth: 1,
 borderTopColor: '#e2e8f0',
 },
 exportActionButton: {
 backgroundColor: '#2d3748',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 16,
 borderRadius: 12,
 gap: 8,
 },
 exportActionButtonDisabled: {
 backgroundColor: '#cbd5e0',
 opacity: 0.6,
 },
 exportActionButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '700',
 },
 folderSelectionSection: {
 marginBottom: 24,
 },
 foldersList: {
 backgroundColor: '#f7fafc',
 borderRadius: 12,
 padding: 10,
 },
 folderSelectItem: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 12,
 paddingHorizontal: 10,
 marginBottom: 4,
 backgroundColor: '#ffffff',
 borderRadius: 8,
 },
 folderSelectItemActive: {
 backgroundColor: '#f0f8ff',
 borderWidth: 2,
 borderColor: '#0056CC',
 },
 folderSelectInfo: {
 flex: 1,
 },
 folderSelectName: {
 fontSize: 15,
 fontWeight: '600',
 color: '#1a202c',
 marginBottom: 2,
 },
 folderSelectCount: {
 fontSize: 13,
 color: '#718096',
 },
 autoSortSection: {
 marginBottom: 24,
 paddingBottom: 20,
 borderBottomWidth: 1,
 borderBottomColor: '#e2e8f0',
 },
 autoSortButtonModal: {
 backgroundColor: '#48bb78',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 14,
 paddingHorizontal: 20,
 borderRadius: 12,
 gap: 8,
 marginBottom: 8,
 },
 autoSortButtonDisabled: {
 opacity: 0.45,
 },
 autoSortButtonText: {
 color: t.colors.textSecondary ?? t.colors.text,
 fontSize: 14,
 fontWeight: '500',
 textAlign: 'center',
 },
 autoSortDescription: {
 fontSize: 13,
 color: '#718096',
 textAlign: 'center',
 marginTop: 4,
 },
 createFolderSection: {
 marginBottom: 24,
 },
 createFolderInputRow: {
 flexDirection: 'row',
 gap: 10,
 },
 createFolderInput: {
 flex: 1,
 backgroundColor: '#f7fafc',
 borderRadius: 10,
 padding: 12,
 fontSize: 16,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 color: '#1a202c',
 },
 createFolderButton: {
 backgroundColor: '#0056CC',
 paddingVertical: 12,
 paddingHorizontal: 20,
 borderRadius: 10,
 justifyContent: 'center',
 },
 createFolderButtonDisabled: {
 backgroundColor: '#cbd5e0',
 opacity: 0.6,
 },
 createFolderButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 foldersListSection: {
 marginBottom: 20,
 },
 foldersGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 justifyContent: 'space-between',
 marginTop: 12,
 },
 folderCard: {
 backgroundColor: '#ffffff',
 borderRadius: 16,
 padding: 20,
 width: (screenWidth - 60) / 2,
 marginBottom: 12,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 2,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 },
 folderCardSmall: {
 padding: 12,
 borderRadius: 12,
 width: (screenWidth - 60) / 3, // 3 columns instead of 2 when in selection mode
 },
 folderIconSmall: {
 marginBottom: 4,
 },
 folderIcon: {
 marginBottom: 12,
 },
 folderName: {
 fontSize: 16,
 fontWeight: '700',
 color: '#1a202c',
 marginBottom: 6,
 textAlign: 'center',
 letterSpacing: 0.2,
 },
 folderNameSmall: {
 fontSize: 11,
 marginTop: 4,
 marginBottom: 2,
 lineHeight: 14,
 fontWeight: '600',
 },
 folderBookCountSmall: {
 fontSize: 10,
 marginTop: 2,
 },
 folderBookCount: {
 fontSize: 13,
 color: '#718096',
 fontWeight: '500',
 },
 folderListItem: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 16,
 paddingHorizontal: 12,
 marginBottom: 8,
 backgroundColor: '#ffffff',
 borderRadius: 12,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 },
 folderListItemName: {
 fontSize: 16,
 fontWeight: '600',
 color: '#1a202c',
 marginBottom: 4,
 },
 folderListItemCount: {
 fontSize: 14,
 color: '#718096',
 },
 emptyFoldersContainer: {
 alignItems: 'center',
 paddingVertical: 40,
 },
 emptyFoldersText: {
 fontSize: 18,
 fontWeight: '600',
 color: '#4a5568',
 marginTop: 16,
 },
 emptyFoldersSubtext: {
 fontSize: 14,
 color: '#718096',
 marginTop: 8,
 },
 exportModalInline: {
 backgroundColor: '#ffffff',
 borderRadius: 12,
 marginHorizontal: 20,
 marginTop: 8,
 marginBottom: 8,
 maxHeight: Dimensions.get('window').height * 0.7,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 4,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 },
 exportModalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 padding: 16,
 borderBottomWidth: 1,
 borderBottomColor: '#e2e8f0',
 },
 exportModalTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: '#1a202c',
 },
 exportModalCloseButton: {
 padding: 4,
 },
 exportModalBody: {
 padding: 16,
 flexGrow: 1,
 },
 exportModalFooter: {
 padding: 16,
 paddingTop: 12,
 borderTopWidth: 1,
 borderTopColor: '#e2e8f0',
 gap: 10,
 },
 exportBookGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 paddingHorizontal: 4,
 paddingVertical: 8,
 },
 exportBookCard: {
 width: `${100 / gridColumns}%`,
 marginBottom: 12,
 paddingHorizontal: 2,
 backgroundColor: '#f7fafc',
 borderRadius: 8,
 padding: 6,
 position: 'relative',
 borderWidth: 2,
 borderColor: 'transparent',
 },
 exportBookCardSelected: {
 borderColor: '#0056CC',
 backgroundColor: '#f0f8ff',
 },
 exportBookCheckmark: {
 position: 'absolute',
 top: 4,
 right: 4,
 zIndex: 10,
 backgroundColor: '#ffffff',
 borderRadius: 12,
 },
 exportBookCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 4,
 marginBottom: 4,
 backgroundColor: '#e2e8f0',
 },
 exportPlaceholderCover: {
 justifyContent: 'center',
 alignItems: 'center',
 backgroundColor: '#e2e8f0',
 },
 exportBookTitle: {
 fontSize: 10,
 fontWeight: '600',
 color: '#1a202c',
 marginBottom: 2,
 lineHeight: 12,
 },
 exportBookAuthor: {
 fontSize: 9,
 color: '#718096',
 lineHeight: 11,
 },
 selectButton: {
 backgroundColor: '#4299e1',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 12,
 paddingHorizontal: 20,
 borderRadius: 12,
 marginHorizontal: 20,
 },
 selectButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 selectionBar: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 12,
 backgroundColor: '#e6f2ff',
 marginBottom: 12,
 borderRadius: 8,
 marginHorizontal: 15,
 },
 selectionCount: {
 fontSize: 14,
 fontWeight: '600',
 color: '#4299e1',
 },
 bottomActionBar: {
 position: 'absolute',
 bottom: 0,
 left: 0,
 right: 0,
 backgroundColor: t.colors.surfaceRaised ?? 'rgba(20,20,20,0.95)',
 borderTopWidth: 1,
 borderTopColor: t.colors.borderSoft ?? t.colors.border ?? 'rgba(255,255,255,0.08)',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 20,
 paddingTop: 12,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: -2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 8,
 },
 bottomActionBarText: {
 fontSize: 14,
 color: t.colors.textOnDark ?? '#FFFFFF',
 fontWeight: '600',
 flex: 1,
 },
 bottomActionButton: {
 backgroundColor: t.colors.surfaceRaised ?? 'rgba(20,20,20,0.95)',
 borderWidth: 1,
 borderColor: t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878',
 paddingVertical: 12,
 paddingHorizontal: 24,
 borderRadius: 12,
 },
 bottomActionButtonText: {
 color: t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878',
 fontSize: 16,
 fontWeight: '700',
 },
 actionButtonsRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 paddingHorizontal: 20,
 paddingBottom: 12,
 gap: 12,
 },
 actionButton: {
 flex: 1,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: '#718096',
 paddingVertical: 12,
 paddingHorizontal: 16,
 borderRadius: 12,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.1,
 shadowRadius: 4,
 elevation: 1,
 },
 actionButtonText: {
 fontSize: 16,
 fontWeight: '600',
 color: '#ffffff',
 },
 modalOverlay: {
 flex: 1,
 backgroundColor: 'rgba(0, 0, 0, 0.5)',
 justifyContent: 'center',
 alignItems: 'center',
 },
 sortModalContent: {
 backgroundColor: '#ffffff',
 borderRadius: 20,
 padding: 20,
 width: '85%',
 maxWidth: 400,
 },
 sortModalTitle: {
 fontSize: 20,
 fontWeight: '700',
 color: '#1a202c',
 marginBottom: 20,
 textAlign: 'center',
 },
 sortOption: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingVertical: 16,
 paddingHorizontal: 16,
 borderRadius: 12,
 marginBottom: 8,
 backgroundColor: '#f8f9fa',
 },
 sortOptionSelected: {
 backgroundColor: '#e6f2ff',
 borderWidth: 2,
 borderColor: '#0056CC',
 },
 sortOptionText: {
 fontSize: 16,
 color: '#1a202c',
 fontWeight: '500',
 },
 sortOptionTextSelected: {
 color: '#0056CC',
 fontWeight: '600',
 },
 sortModalCancel: {
 marginTop: 12,
 paddingVertical: 16,
 alignItems: 'center',
 },
 sortModalCancelText: {
 fontSize: 16,
 color: '#718096',
 fontWeight: '600',
 },
 foldersActionButtonsRow: {
 flexDirection: 'row',
 marginBottom: 20,
 },
 autoSortButtonFullPage: {
 alignSelf: 'center',
 width: '100%',
 maxWidth: 360,
 backgroundColor: 'transparent',
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.divider ?? t.colors.border,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 10,
 paddingHorizontal: 16,
 borderRadius: 10,
 minHeight: 42,
 },
 autoSortWrap: {
 flex: 1,
 },
 autoSortHelperText: {
 fontSize: 12,
 color: '#718096',
 marginTop: 6,
 paddingHorizontal: 4,
 },
 createFolderMainButton: {
 alignSelf: 'center',
 width: '100%',
 maxWidth: 360,
 backgroundColor: t.colors.primary,
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 16,
 paddingHorizontal: 16,
 borderRadius: 14,
 height: 52,
 marginBottom: 10,
 },
 createFolderMainButtonText: {
 color: '#ffffff',
 fontSize: 17,
 fontWeight: '600',
 },
 collectionsIntro: {
 marginBottom: 14,
 },
 collectionsIntroTitle: {
 fontSize: 24 * typeScale,
 fontWeight: '800',
 color: t.colors.textPrimary ?? t.colors.text,
 marginBottom: 6,
 letterSpacing: 0.2,
 },
 collectionsIntroSubtitle: {
 fontSize: 15,
 lineHeight: 22,
 color: t.colors.textSecondary ?? t.colors.textMuted ?? t.colors.text,
 },
 manageCollectionsButton: {
 alignSelf: 'center',
 marginTop: 10,
 paddingVertical: 6,
 paddingHorizontal: 8,
 },
 manageCollectionsButtonText: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.textSecondary ?? t.colors.textMuted ?? t.colors.text,
 },
 selectFolderButton: {
 flex: 1,
 maxWidth: (screenWidth - 30 - 12) / 2, // Match Create button width: (screen - margins - gap) / 2
 backgroundColor: '#4299e1',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 16,
 paddingHorizontal: 16,
 borderRadius: 12,
 height: 52,
 },
 selectFolderButtonText: {
 color: '#ffffff',
 fontSize: 18,
 fontWeight: '600',
 },
 deleteFoldersButton: {
 width: '100%',
 backgroundColor: '#e53e3e',
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 16,
 paddingHorizontal: 16,
 borderRadius: 12,
 marginBottom: 20,
 },
 deleteFoldersButtonText: {
 color: '#ffffff',
 fontSize: 18,
 fontWeight: '600',
 },
 // Bottom Delete Bar
 bottomDeleteBarContainer: {
 position: 'absolute',
 bottom: 0,
 left: 0,
 right: 0,
 zIndex: 1000,
 },
 bottomDeleteBar: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingTop: 16,
 paddingBottom: 16,
 minHeight: 60,
 backgroundColor: t.colors.surfaceRaised ?? 'rgba(20,20,20,0.95)',
 borderTopWidth: 1,
 borderTopColor: t.colors.borderSoft ?? t.colors.border ?? 'rgba(255,255,255,0.08)',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: -2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 8,
 },
 bottomDeleteBarLeft: {
 flex: 1,
 minWidth: 120,
 },
 bottomDeleteBarCount: {
 fontSize: 16,
 fontWeight: '600',
 color: t.colors.textOnDark ?? '#FFFFFF',
 flexShrink: 1,
 },
 bottomDeleteBarRight: {
 flexDirection: 'row',
 alignItems: 'center',
 flexShrink: 0,
 },
 bottomDeleteBarCancelButton: {
 paddingHorizontal: 16,
 paddingVertical: 10,
 minHeight: 40,
 backgroundColor: 'transparent',
 borderRadius: 8,
 borderWidth: 1,
 borderColor: t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878',
 justifyContent: 'center',
 alignItems: 'center',
 },
 bottomDeleteBarCancelText: {
 color: t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878',
 fontSize: 14,
 fontWeight: '600',
 },
 bottomDeleteBarDeleteButton: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 10,
 minHeight: 40,
 backgroundColor: '#e53e3e',
 borderRadius: 8,
 justifyContent: 'center',
 },
 bottomDeleteBarDeleteText: {
 color: t.colors.textOnDark ?? '#FFFFFF',
 fontSize: 14,
 fontWeight: '600',
 },
 createFolderContinueButton: {
 backgroundColor: '#718096',
 paddingVertical: 14,
 paddingHorizontal: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 },
 createFolderContinueButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 createFolderBackButton: {
 backgroundColor: '#e2e8f0',
 paddingVertical: 12,
 paddingHorizontal: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 },
 createFolderBackButtonText: {
 color: '#4a5568',
 fontSize: 16,
 fontWeight: '600',
 },
 createFolderActionButton: {
 flex: 1,
 paddingVertical: 14,
 paddingHorizontal: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 },
 createFolderCancelButton: {
 backgroundColor: '#e2e8f0',
 },
 createFolderCancelButtonText: {
 color: '#4a5568',
 fontSize: 16,
 fontWeight: '600',
 },
 createFolderConfirmButton: {
 backgroundColor: '#718096',
 },
 createFolderConfirmButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 noDataSeparator: {
 flexDirection: 'row',
 alignItems: 'center',
 marginVertical: 20,
 marginHorizontal: 20,
 },
 noDataSeparatorLine: {
 flex: 1,
 height: 1,
 backgroundColor: '#e2e8f0',
 },
 noDataSeparatorText: {
 fontSize: 12,
 color: '#a0aec0',
 fontWeight: '500',
 marginHorizontal: 12,
 fontStyle: 'italic',
 },
 createFolderBottomTab: {
 position: 'absolute',
 bottom: 0,
 left: 0,
 right: 0,
 backgroundColor: '#ffffff',
 paddingTop: 12,
 paddingBottom: 20,
 paddingHorizontal: 20,
 borderTopWidth: 1,
 borderTopColor: '#e2e8f0',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: -2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 10,
 },
 createFolderBottomButton: {
 backgroundColor: '#0056CC',
 paddingVertical: 16,
 paddingHorizontal: 20,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 },
 createFolderBottomButtonText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '600',
 },
 // Folder view styles (matching MyLibraryTab)
 librarySearchContainer: {
 flexDirection: 'row',
 alignItems: 'center',
 marginBottom: 14,
 backgroundColor: '#f7fafc',
 borderWidth: 1,
 borderColor: '#e2e8f0',
 borderRadius: 12,
 paddingHorizontal: 12,
 paddingVertical: 10,
 },
 librarySearchInput: {
 flex: 1,
 fontSize: 14,
 color: '#1a202c',
 },
 folderLibrarySearchClear: {
 width: 24,
 height: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: '#e2e8f0',
 },
 folderLibrarySearchClearText: {
 fontSize: 18,
 color: '#4a5568',
 lineHeight: 20,
 marginTop: -2,
 },
 folderSelectButtonContainer: {
 flexDirection: 'row',
 gap: 12,
 paddingHorizontal: 20,
 marginBottom: 12,
 },
 folderSelectButton: {
 paddingHorizontal: 16,
 paddingVertical: 8,
 backgroundColor: '#4299e1',
 borderRadius: 8,
 justifyContent: 'center',
 alignItems: 'center',
 },
 folderSelectButtonText: {
 color: '#ffffff',
 fontSize: 14,
 fontWeight: '600',
 },
 folderSelectionBar: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 12,
 backgroundColor: '#e6f2ff',
 marginBottom: 12,
 borderRadius: 8,
 marginHorizontal: 15,
 },
 folderSelectionCount: {
 fontSize: 14,
 fontWeight: '600',
 color: '#4299e1',
 },
 clearSelectionButton: {
 paddingHorizontal: 12,
 paddingVertical: 6,
 backgroundColor: '#ffffff',
 borderRadius: 6,
 borderWidth: 1,
 borderColor: '#4299e1',
 },
 clearSelectionText: {
 color: '#4299e1',
 fontSize: 12,
 fontWeight: '600',
 },
 booksSection: {
 backgroundColor: '#ffffff',
 marginHorizontal: 15,
 marginBottom: 20,
 borderRadius: 16,
 padding: 20,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: 0.08,
 shadowRadius: 12,
 elevation: 5,
 },
 sectionHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'flex-start',
 marginBottom: 20,
 paddingBottom: 16,
 borderBottomWidth: 1,
 borderBottomColor: '#e2e8f0',
 },
 sectionTitle: {
 fontSize: 22 * typeScale,
 fontWeight: '800',
 color: '#1a202c',
 letterSpacing: 0.3,
 },
 sectionSubtitle: {
 fontSize: 14,
 fontWeight: '600',
 color: '#718096',
 },
 placeholderText: {
 fontSize: 10,
 fontWeight: '600',
 color: '#4a5568',
 textAlign: 'center',
 lineHeight: 13,
 paddingHorizontal: 4,
 },
 emptyState: {
 flex: 1,
 justifyContent: 'center',
 alignItems: 'center',
 paddingVertical: 60,
 paddingHorizontal: 20,
 },
 emptyStateText: {
 fontSize: 18,
 fontWeight: '600',
 color: '#1a202c',
 marginBottom: 8,
 textAlign: 'center',
 },
 emptyStateSubtext: {
 fontSize: 14,
 color: '#718096',
 textAlign: 'center',
 },
 booksGrid: {
 paddingTop: 4,
 width: '100%',
 },
 bookRow: {
 justifyContent: 'flex-start',
 marginBottom: BOOK_GRID_VERTICAL_GAP,
 },
});

