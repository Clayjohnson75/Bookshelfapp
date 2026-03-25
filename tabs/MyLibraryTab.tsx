import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
 View, 
 Text, 
 StyleSheet, 
 ScrollView, 
 TouchableOpacity, 
 Pressable,
 Image,
 FlatList,
 Modal,
 TextInput,
 Alert,
 Keyboard,
 InteractionManager,
 ActivityIndicator,
 Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import {
  CheckmarkIcon,
  FolderIcon,
  TrashIcon,
  ChevronBackIcon,
  ArrowBackIcon,
  ChevronForwardIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  CloseCircleIcon,
} from '../components/Icons';
import { SettingsIcon } from '../components/SettingsIcon';
import { useFocusEffect, useNavigation, useIsFocused } from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Book, Photo, UserProfile, Folder, enforcePhotoStorageStatus } from '../types/BookTypes';
import { useAuth, isGuestUser } from '../auth/SimpleAuthContext';
import { useProfileStats, formatCountForDisplay } from '../contexts/ProfileStatsContext';
import { useBottomDock } from '../contexts/BottomDockContext';
import SettingsModal from '../components/SettingsModal';
import BookDetailModal from '../components/BookDetailModal';
import { AuthGateModal } from '../components/AuthGateModal';
import { LoginScreen } from '../auth/AuthScreens';
import { LibraryView } from '../screens/LibraryView';
import { loadBooksFromSupabase, loadFoldersFromSupabase, saveFoldersToSupabase, deleteLibraryPhotoAndBooks, getDeletedBookIds, addDeletedBookIdsTombstone, fetchAllApprovedBooks, fetchAllPhotos } from '../services/supabaseSync';
import { useResponsive } from '../lib/useResponsive';
import { getBookSourcePhotoId } from '../lib/bookKey';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit, getLastDestructiveAction } from '../lib/deleteGuard';
import { loadHighWaterMark, saveHighWaterMark, checkForSuspiciousDrop } from '../lib/dataSafetyMark';
import { isGoogleHotlink } from '../lib/coverUtils';
import { BookCoverImage } from '../components/BookCoverImage';
import { PhotoTile } from '../components/PhotoTile';
import { EntityRowCard } from '../components/EntityRowCard';
import { HeaderShelfCollage } from '../components/HeaderShelfCollage';
import { AppHeader } from '../components/AppHeader';
import { dedupeBooks } from '../lib/dedupeBooks';
import { mergeBookFieldLevel } from '../lib/mergeBooks';
import { dedupBy, photoStableKey, canonicalPhotoListKey } from '../lib/dedupBy';
import { getEnvVar } from '../lib/getEnvVar';
import { LOG_TRACE, LOG_DEBUG, LOG_UI, DEBUG_VERBOSE } from '../lib/logFlags';
import { logger, DEBUG_INTEGRITY, DEBUG_STACKS } from '../utils/logger';
import { perfLog } from '../lib/perfLogger';
import { shouldSkipCleanup } from '../lib/provenanceGuard';
import { canon, toPhotoKey } from '../lib/photoKey';
import { BOOK_GRID_VERTICAL_GAP } from '../lib/layoutConstants';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeTokens } from '../theme/tokens';
import { useScanning } from '../contexts/ScanningContext';
import { subscribeLibraryInvalidate } from '../lib/libraryInvalidate';

/**
 * My Library header: identity row (avatar + name | gear) + thin divider.
 * Single cohesive surface and typography hierarchy no pill, no big dark shapes.
 */

// Session cache: survives tab switches/navigation while JS runtime stays alive.
// Regenerates naturally on cold app restart.
const sessionHeaderCollageCacheByUser = new Map<string, string[]>();

/**
 * LOCKED PROFILE HEADER SPEC (final approved design).
 * Keep these values unchanged unless explicitly requested.
 */
const LOCKED_PROFILE_HEADER = {
 height: 184,
 marginBottom: 4,
 collageBlur: 0.5,
 collageOpacity: 0.9,
 collageMaxCovers: 50, // matches MAX_UNIQUE in HeaderShelfCollage; 2-row iPad needs ~40 slots
 coversDarkenOverlay: 'rgba(0,0,0,0.18)',
 gradientColors: ['rgba(0,0,0,0.34)', 'rgba(0,0,0,0.44)', 'rgba(0,0,0,0.56)'] as const,
} as const;

export const MyLibraryTab: React.FC = () => {
 const insets = useSafeAreaInsets();
 const { t } = useTheme();
 const { screenWidth, screenHeight, bookGridColumns: gridColumns, photoColumns, typeScale } = useResponsive();
 const hasLoggedGridDebugRef = useRef(false);
 const photosNavLockRef = useRef(false);
 const libraryContainerWidth = screenWidth;
 const approxGridItemWidth = (libraryContainerWidth - 40) / gridColumns; // booksSection horizontal padding is 20 + 20

 useEffect(() => {
 if (!__DEV__) return;
 if (!hasLoggedGridDebugRef.current) {
 hasLoggedGridDebugRef.current = true;
 // Gate behind LOG_UI logs once on mount, noisy across hot-reloads.
 if (LOG_UI) logger.debug('[MY_LIBRARY_GRID_DEV]', {
   screenWidth: Math.round(screenWidth),
   cols: gridColumns,
   itemWidth: approxGridItemWidth.toFixed(1),
 });
 }

 // Sanity guard: iPhone 390 snapshot width should always be 4 columns.
    if (Math.round(screenWidth) === 390 && gridColumns !== 4) {
      logger.logOnce(`grid_guard:390:${gridColumns}`, 'info', '[MY_LIBRARY_GRID_GUARD]', `Expected 4 columns at width 390, got ${gridColumns}`);
    }
 }, [screenWidth, gridColumns, approxGridItemWidth]);
 
 const styles = useMemo(
 () => getStyles(screenWidth, t, gridColumns, photoColumns, typeScale),
 [screenWidth, t, gridColumns, photoColumns, typeScale]
 );
 
  const { user, session, signOut, authReady, loading: authLoading } = useAuth();
  const { displayBookCount, displayPhotoCount, lastStableBookCount, lastStablePhotoCount, cachedAuthorCount, refreshProfileStats, mergeInProgress, libraryHydrated, lastApprovedAt } = useProfileStats();
  // Show the best available count immediately — prefer canonical, fall back to stable cache.
  const effectiveDisplayBookCount = displayBookCount ?? lastStableBookCount ?? null;
  const effectiveDisplayPhotoCount = displayPhotoCount ?? lastStablePhotoCount ?? null;
  const displayBookCountText = formatCountForDisplay(effectiveDisplayBookCount);
  const displayPhotoCountText = formatCountForDisplay(effectiveDisplayPhotoCount);
  const { onCancelComplete: cancelActiveBatch, activeScanJobIds } = useScanning();
  const { setTabBarHeight } = useBottomDock();
  // Height of the native bottom tab bar (includes safe-area inset on iOS).
  // Used to anchor the delete bar directly above the tab bar — never at top: 0.
  const tabBarHeight = useBottomTabBarHeight();
  useEffect(() => {
    setTabBarHeight(tabBarHeight);
  }, [tabBarHeight, setTabBarHeight]);

 const navigation = useNavigation();
 const [books, setBooks] = useState<Book[]>([]);
 const [photos, setPhotos] = useState<Photo[]>([]);

// ── Prime high-water marks from AsyncStorage when user changes ────────────────
React.useEffect(() => {
  if (!user?.uid) { hwApprovedRef.current = 0; hwPhotosRef.current = 0; return; }
  loadHighWaterMark(user.uid).then(mark => {
    if (!mark) return;
    if (mark.approved > hwApprovedRef.current) hwApprovedRef.current = mark.approved;
    if (mark.photos > hwPhotosRef.current) hwPhotosRef.current = mark.photos;
  }).catch(() => {});
}, [user?.uid]);
// ── END high-water prime ───────────────────────────────────────────────────────

// ── DEBUG: lightweight bulk-delete detector (cheap — one count query per open) ───────
// Runs on every user change. Expensive probes (PROBE_BOOKS_ANY_STATUS, DIAG_BOOKS_SAMPLE,
// DIAG_BOOKS_STATUS_UNIQUE) are only triggered from APPROVE_SANITY_CHECK mismatches in
// ScansTab — they are too costly to run on every tab open.
React.useEffect(() => {
  if (!__DEV__) return;
  if (!user?.uid) return;
  let cancelled = false;
  (async () => {
    try {
      const { supabase: sb } = await import('../lib/supabase');
      if (!sb || cancelled) return;

      // Cheap count queries — 3 head-only requests, no row data returned.
      const uid = user.uid;
      const [photosRes, booksRes, approvedRes] = await Promise.all([
        sb.from('photos').select('id', { count: 'exact', head: true }).eq('user_id', uid).is('deleted_at', null),
        sb.from('books').select('id', { count: 'exact', head: true }).eq('user_id', uid).is('deleted_at', null),
        sb.from('books').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'approved').is('deleted_at', null),
      ]);
      if (!cancelled) {
        logger.debug('[DB_RAW_COUNTS]', {
          totalPhotos: photosRes.count ?? null,
          totalBooks: booksRes.count ?? null,
          approvedBooksExactFilter: approvedRes.count ?? null,
        });
      }

      // ── DIAG: detect bulk-delete pattern — repeated deleted_at timestamp ──
      // Cheap: fetches only deleted_at values (no row data) to detect accidental bulk-delete.
      const { data: deletedRows, error: e4 } = await sb
        .from('books')
        .select('deleted_at')
        .eq('user_id', uid)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(50);
      if (!cancelled) {
        const uniqueDeletedAt = Array.from(new Set((deletedRows ?? []).map((r: any) => r.deleted_at)));
        const likelyBulkDelete = (deletedRows?.length ?? 0) > 3 && uniqueDeletedAt.length <= 2;
        // Elevate to warn when bulk-delete pattern detected — always actionable.
        const _diagFn = likelyBulkDelete ? logger.warn : logger.debug;
        _diagFn('[DIAG_DELETED_AT_PATTERN]', {
          e4: e4?.message ?? null,
          softDeletedRowCount: deletedRows?.length ?? null,
          uniqueDeletedAtCount: uniqueDeletedAt.length,
          likelyBulkDelete,
          uniqueDeletedAt,
        });
      }
    } catch (err: any) { logger.warn('[DB_RAW_COUNTS]', 'error', { err: (err as any)?.message ?? String(err) }); }
  })();
  return () => { cancelled = true; };
}, [user?.uid]);
// ── END DEBUG ───────────────────────────────────────────────────────────────
 /** In-memory high-water marks for drop detection. Primed from AsyncStorage on user change. */
 const hwApprovedRef = React.useRef<number>(0);
 const hwPhotosRef = React.useRef<number>(0);
 const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
 const [folders, setFolders] = useState<Folder[]>([]);
 const [showAuthorsView, setShowAuthorsView] = useState(false);
 const [showStatsView, setShowStatsView] = useState(false);
 const [showSettings, setShowSettings] = useState(false);
 const [selectedBook, setSelectedBook] = useState<Book | null>(null);
 const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
 const [showBookDetail, setShowBookDetail] = useState(false);
 const [showAuthGateModal, setShowAuthGateModal] = useState(false);
 const [showPhotos, setShowPhotos] = useState(false);
 const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
 const [photoCaption, setPhotoCaption] = useState('');
const [deleteConfirmPhoto, setDeleteConfirmPhoto] = useState<Photo | null>(null);
const [deleteGuard, setDeleteGuard] = useState(false);
// Holds the active delete intent while the photo-delete confirmation overlay is shown.
const photoDeleteIntentRef = React.useRef<ReturnType<typeof createDeleteIntent> | null>(null);
 const [librarySearch, setLibrarySearch] = useState('');
 const [bookSearchQuery, setBookSearchQuery] = useState('');
 const [bookSearchResults, setBookSearchResults] = useState<any[]>([]);
 const [bookSearchLoading, setBookSearchLoading] = useState(false);
 const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
 const [showFolderView, setShowFolderView] = useState(false);
 const [showLibraryView, setShowLibraryView] = useState(false);
 const [isSelectionMode, setIsSelectionMode] = useState(false);
 const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
 const [folderSearchQuery, setFolderSearchQuery] = useState('');
 const [isFolderSelectionMode, setIsFolderSelectionMode] = useState(false);
 const [selectedFolderBooks, setSelectedFolderBooks] = useState<Set<string>>(new Set());
 const [showFoldersExpanded, setShowFoldersExpanded] = useState(false);
 /** Author selected from list show AuthorDetailsScreen (modal). No inline expansion. */
 const [selectedAuthor, setSelectedAuthor] = useState<{ name: string; books: Book[] } | null>(null);
 const [authorsSortBy, setAuthorsSortBy] = useState<'name' | 'count'>('name');
 const [authorsSortDropdownOpen, setAuthorsSortDropdownOpen] = useState(false);
 const [authorsSearchQuery, setAuthorsSearchQuery] = useState('');
 const [isAutoSorting, setIsAutoSorting] = useState(false);
 const [isLoadingData, setIsLoadingData] = useState(false);
 const [sessionMissingForLibrary, setSessionMissingForLibrary] = useState(false);
 const [headerCollageCovers, setHeaderCollageCovers] = useState<string[]>([]);
 const scrollViewRef = useRef<ScrollView>(null);
 const booksSectionRef = useRef<View>(null);
 const searchBarRef = useRef<View>(null);
 /** Last known good author count; show during merge/load so we don't flash "--". */
 const lastStableUniqueAuthorsCountRef = useRef<number | null>(null);
 const [booksSectionY, setBooksSectionY] = useState(0);
 const searchBarScrollPosition = useRef<number | null>(null);
 const previousUserIdRef = useRef<string | null>(null);
 const loadUserDataInProgressRef = useRef<boolean>(false);
 const loadUserDataAgainAfterRef = useRef<boolean>(false);
 const lastLoadUserDataAtRef = useRef<number>(0);
  /** Fix #4: Monotonic token so only the latest load applies (older load can't overwrite). */
  const pendingLoadRequestIdRef = useRef<number>(0);
  /** tempId -> canonicalId for book IDs; used to resolve before presence checks. */
  const idAliasRef = useRef<Record<string, string>>({});
  /** local photoId -> canonical photoId; mirrors ScansTab's photo_id_aliases_${uid} key. */
  const photoIdAliasRef = useRef<Record<string, string>>({});
  /** Resolve a photo ID through the alias map (local → canonical). */
  const resolvePhotoId = useCallback((id: string | undefined | null): string | undefined => {
    if (!id) return undefined;
    return photoIdAliasRef.current[id] ?? id;
  }, []);
  /** At ingestion: normalize book.source_photo_id to canonical so grid/map use one namespace. */
  const normalizeBooksSourcePhotoIds = useCallback((booksList: Book[]): Book[] =>
    booksList.map((b) => {
      const canonical = resolvePhotoId((b as any).source_photo_id) ?? (b as any).source_photo_id;
      return canonical !== (b as any).source_photo_id ? { ...b, source_photo_id: canonical } : b;
    }), [resolvePhotoId]);
  /** At ingestion: normalize photo.id to DB uuid (canonical); store original in localId so attach uses photo.id = DB uuid. */
  const normalizePhotosToCanonicalIds = useCallback((photosList: Photo[]): Photo[] => {
    const byId = new Map<string, Photo>();
    photosList.forEach((p) => {
      const canonical = resolvePhotoId(p.id) ?? p.id ?? '';
      if (!canonical) return;
      const hadAlias = p.id !== canonical;
      const normalized = hadAlias ? { ...p, id: canonical, localId: p.localId ?? p.id } : p;
      const existing = byId.get(canonical);
      if (!existing) {
        byId.set(canonical, normalized);
        return;
      }
      byId.set(canonical, {
        ...existing,
        books: [...(existing.books ?? []), ...(normalized.books ?? [])],
      });
    });
    return Array.from(byId.values());
  }, [resolvePhotoId]);
  const LOAD_USER_DATA_DEBOUNCE_MS = 30000; // 30s: don't re-fetch from server on every tab switch

  // Profile: only approved books. Must be defined before filteredBooks/displayedBooks/authorsWithBooks.
  const approvedBooksOnly = useMemo(
    () => (books ?? []).filter((b) => (b as any).status === 'approved' && !(b as any).deleted_at),
    [books]
  );

 const filteredBooks = useMemo(() => {
 const q = librarySearch.trim().toLowerCase();
 if (!q) return approvedBooksOnly;
 const startsWithMatches = approvedBooksOnly.filter(b => {
 const title = (b.title || '').toLowerCase();
 const author = (b.author || '').toLowerCase();
 return title.startsWith(q) || author.startsWith(q);
 });
 const containsMatches = approvedBooksOnly.filter(b => {
 const title = (b.title || '').toLowerCase();
 const author = (b.author || '').toLowerCase();
 return (title.includes(q) || author.includes(q)) && !(title.startsWith(q) || author.startsWith(q));
 });
 return [...startsWithMatches, ...containsMatches];
 }, [approvedBooksOnly, librarySearch]);

 const displayedBooks = librarySearch.trim() ? filteredBooks : approvedBooksOnly;

 // Aggregate unique authors with book counts (Profile: approved books only).
 const authorsWithBooks = useMemo(() => {
 if (approvedBooksOnly.length === 0) return [];
 const byAuthor: { [key: string]: Book[] } = {};
 approvedBooksOnly.forEach(book => {
 if (book.author) {
 const normalizedAuthor = book.author.split(/,|&| and /i)[0].trim();
 if (normalizedAuthor) {
 if (!byAuthor[normalizedAuthor]) byAuthor[normalizedAuthor] = [];
 byAuthor[normalizedAuthor].push(book);
 }
 }
 });
 return Object.entries(byAuthor)
 .map(([name, authorBooks]) => ({ name, books: authorBooks, count: authorBooks.length }));
 }, [approvedBooksOnly]);

 const authorsAlphabetical = useMemo(() => {
 return [...authorsWithBooks].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
 }, [authorsWithBooks]);

 const topAuthorsByCount = useMemo(() => {
 return [...authorsWithBooks].sort((a, b) => b.count - a.count).slice(0, 5);
 }, [authorsWithBooks]);

 const authorsByCount = useMemo(() => {
 return [...authorsWithBooks].sort((a, b) => b.count - a.count);
 }, [authorsWithBooks]);

 const authorsSortedForView = useMemo(() => {
 return authorsSortBy === 'count' ? authorsByCount : authorsAlphabetical;
 }, [authorsSortBy, authorsAlphabetical, authorsByCount]);

 const authorsFilteredForView = useMemo(() => {
 const q = authorsSearchQuery.trim().toLowerCase();
 if (!q) return authorsSortedForView;
 return authorsSortedForView.filter(({ name }) => name.toLowerCase().includes(q));
 }, [authorsSortedForView, authorsSearchQuery]);

 const uniqueAuthorsCount = authorsWithBooks.length;
 // Use cached author count from previous session until full data loads.
 // This prevents the 3→39 flash on app reload.
 const booksFullyLoaded = approvedBooksOnly.length >= (effectiveDisplayBookCount ?? 0);
 const displayAuthorsCount = booksFullyLoaded
   ? uniqueAuthorsCount
   : (cachedAuthorCount ?? (uniqueAuthorsCount > 0 ? uniqueAuthorsCount : ''));

 // Sort by author's last name (fallback to title when author missing)
 const sortedDisplayedBooks = useMemo(() => {
 const extractLastName = (author?: string): string => {
 if (!author) return '';
 // Handle multiple authors by taking the first one
 const firstAuthor = author.split(/,|&| and /i)[0].trim();
 const parts = firstAuthor.split(/\s+/).filter(Boolean);
 if (parts.length === 0) return '';
 // Remove trailing commas from last token
 return parts[parts.length - 1].replace(/,/, '').toLowerCase();
 };
 const byLast = [...displayedBooks].sort((a, b) => {
 const aLast = extractLastName(a.author);
 const bLast = extractLastName(b.author);
 if (aLast && bLast) {
 if (aLast < bLast) return -1;
 if (aLast > bLast) return 1;
 } else if (aLast || bLast) {
 // Authors come before missing-author entries
 return aLast ? -1 : 1;
 }
 const aTitle = (a.title || '').toLowerCase();
 const bTitle = (b.title || '').toLowerCase();
 if (aTitle < bTitle) return -1;
 if (aTitle > bTitle) return 1;
 return 0;
 });
 return byLast;
 }, [displayedBooks]);

 // Load data only after auth is stable (authReady). Never clear data just because session is temporarily null.
 // Only clear when authReady and we know: signed out (no user / guest) or different user (user B must not see user A's data).
 useEffect(() => {
 if (!authReady) return; // Auth not stable do nothing, don't clear
 if (!user || isGuestUser(user)) {
 setBooks([]);
 setUserProfile(null);
 previousUserIdRef.current = null;
 return;
 }
 if (previousUserIdRef.current !== user.uid) {
 setBooks([]);
 setUserProfile(null);
 previousUserIdRef.current = user.uid;
 }
 logger.debug(' User changed in MyLibraryTab, loading data immediately...');
 const timeoutId = setTimeout(() => {
 loadUserData().catch(error => {
 logger.error(' Error loading user data in MyLibraryTab:', error);
 });
 }, 100);
 return () => clearTimeout(timeoutId);
 }, [user, authReady]);

 // Maintain scroll position when keyboard appears/disappears during search
 useEffect(() => {
 if (!librarySearch.trim()) {
 searchBarScrollPosition.current = null;
 return;
 }

 const keyboardWillShow = Keyboard.addListener('keyboardWillShow', () => {
 // Maintain scroll position when keyboard shows - keep "My Library" section at top
 if (searchBarScrollPosition.current !== null && booksSectionY > 0) {
 searchBarScrollPosition.current = booksSectionY - 10;
 
 // Use multiple timeouts to ensure scroll happens after keyboard animation
 setTimeout(() => {
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: false });
 }, 50);
 setTimeout(() => {
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: false });
 }, 200);
 setTimeout(() => {
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: false });
 }, 400);
 }
 });

 const keyboardDidShow = Keyboard.addListener('keyboardDidShow', () => {
 // Maintain scroll position when keyboard is fully shown - keep "My Library" section at top
 if (booksSectionY > 0) {
 searchBarScrollPosition.current = booksSectionY - 10;
 
 setTimeout(() => {
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: false });
 }, 100);
 }
 });

 return () => {
 keyboardWillShow.remove();
 keyboardDidShow.remove();
 };
 }, [librarySearch, booksSectionY, isSelectionMode, selectedBooks.size]);

 // Initialize userProfile immediately: try cached profile first (instant).
 useEffect(() => {
 if (user) {
 const cacheKey = `cached_profile_${user.uid}`;
 // Load cached profile for display name only (no "User" flash).
 // Do NOT restore totalBooks/totalPhotos from cache — they go stale.
 AsyncStorage.getItem(cacheKey).then((raw) => {
   if (!raw) return;
   try {
     const cached = JSON.parse(raw);
     setUserProfile(prev => {
       if (prev && prev.displayName !== 'User') return prev;
       return { ...prev, displayName: cached.displayName || 'User', email: cached.email || '', createdAt: cached.createdAt ? new Date(cached.createdAt) : new Date(), lastLogin: new Date(), totalBooks: prev?.totalBooks ?? 0, totalPhotos: prev?.totalPhotos ?? 0 };
     });
   } catch {}
 }).catch(() => {});

 // Set from user object (may still be 'User' if auth hasn't loaded profile)
 setUserProfile(prev => {
 const displayName = user.displayName || user.username || (prev?.displayName !== 'User' ? prev?.displayName : null) || 'User';
 if (prev) {
 return { ...prev, displayName, email: user.email || prev.email || '' };
 } else {
 return { displayName, email: user.email || '', createdAt: new Date(), lastLogin: new Date(), totalBooks: 0, totalPhotos: 0 };
 }
 });
 } else {
 setUserProfile(null);
 }
 }, [user]);

 // Reload data when tab is focused
 useFocusEffect(
 React.useCallback(() => {
 // Only load data if user is authenticated and auth init has finished
 if (user && !isGuestUser(user) && authReady) {
 loadUserData({ source: 'focus' });
 }
 }, [user, authReady, navigation])
 );

 // Sync on Open: Do NOT add completed scan_job books to the library here.
 // Those books are merged into PENDING in ScansTab when it loads, so they show in Scans for approval.
 // Adding them here was causing the library to repopulate after the user cleared it.

 const loadUserData = async (options?: { source?: string }) => {
 if (!authReady) return;
 if (authReady && session === null) return;
 if (!user) return;

 if (loadUserDataInProgressRef.current) {
 if (__DEV__ && LOG_TRACE) logger.debug('[MYLIB_LOAD_USER_DATA] skip: already in progress (will run again after current)');
 loadUserDataAgainAfterRef.current = true;
 return;
 }
 const now = Date.now();
 // Bypass debounce if user recently approved books — the book list needs to refresh.
 const recentlyApproved = lastApprovedAt > 0 && (now - lastApprovedAt < 15000);
 if (!recentlyApproved && now - lastLoadUserDataAtRef.current < LOAD_USER_DATA_DEBOUNCE_MS) {
 if (__DEV__ && LOG_TRACE) logger.debug('[MYLIB_LOAD_USER_DATA] skip: debounce', { ms: now - lastLoadUserDataAtRef.current });
 return;
 }
 loadUserDataInProgressRef.current = true;
 const requestId = ++pendingLoadRequestIdRef.current;
 const refreshStart = Date.now();
 const source = options?.source ?? 'user';
 const isFocusLoad = source === 'focus';
 if (isFocusLoad) perfLog('photos_tab_open', 'tap', { tapAt: Date.now() });
 if (__DEV__) logger.debug('[LIB] refresh start', { source, user: user.uid.slice(0, 6) });

 // Only show loading state if we don't already have data. This prevents the
 // profile/covers from blanking out when navigating back from a detail page.
 const hasExistingData = (books ?? []).length > 0;
 if (!hasExistingData) setIsLoadingData(true);
 setSessionMissingForLibrary(false);

 try {
 // Same singleton as AuthContext no second client
 const { supabase } = await import('../lib/supabase');
 let sess: { session: { access_token?: string } | null } | null = supabase ? (await supabase.auth.getSession()).data : null;
 // Right after sign-in, session can be briefly unavailable; retry a few times before showing "sign in again"
 for (let attempt = 0; attempt < 3 && !sess?.session?.access_token; attempt++) {
 await new Promise(r => setTimeout(r, 600));
 sess = supabase ? (await supabase.auth.getSession()).data : null;
 }
 if (!sess?.session?.access_token) {
 setSessionMissingForLibrary(true);
 setIsLoadingData(false);
 return;
 }

  const userApprovedKey = `approved_books_${user.uid}`;
  const userPhotosKey = `photos_${user.uid}`;
  const userFoldersKey = `folders_${user.uid}`;
  const libraryClearedAtKey = `library_cleared_at_${user.uid}`;
  const approvedBookIdAliasesKey = `approved_book_id_aliases_${user.uid}`;
  const photoIdAliasesKey = `photo_id_aliases_${user.uid}`;

  const [approvedData, photosData, foldersData, libraryClearedAt, savedAliases, savedPhotoAliases] = await Promise.all([
    AsyncStorage.getItem(userApprovedKey),
    AsyncStorage.getItem(userPhotosKey),
    AsyncStorage.getItem(userFoldersKey),
    AsyncStorage.getItem(libraryClearedAtKey),
    AsyncStorage.getItem(approvedBookIdAliasesKey),
    AsyncStorage.getItem(photoIdAliasesKey),
  ]);
  if (savedAliases) {
    try {
      const parsed = JSON.parse(savedAliases) as Record<string, string>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        idAliasRef.current = parsed;
      }
    } catch (_) { /* ignore */ }
  }
  if (savedPhotoAliases) {
    try {
      const parsed = JSON.parse(savedPhotoAliases) as Record<string, string>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        photoIdAliasRef.current = parsed;
        if (__DEV__) {
          const count = Object.keys(parsed).length;
          if (count > 0) {
            const sample = Object.entries(parsed).slice(0, 3).map(([k, v]) => `${k.slice(0, 8)}→${v.slice(0, 8)}`);
            logger.debug('[MYLIB_PHOTO_ALIAS_MAP_LOADED]', { aliasCount: count, sample });
          }
        }
      }
    } catch (_) { /* ignore */ }
  }

 const localBooks: Book[] = approvedData ? JSON.parse(approvedData) : [];
 const deletedBookIds = await getDeletedBookIds(user.uid);
 const localBooksFiltered = localBooks.filter(b => !b.id || !deletedBookIds.has(b.id));
 const loadedPhotos: Photo[] = photosData ? JSON.parse(photosData) : [];
 const loadedFolders: Folder[] = foldersData ? JSON.parse(foldersData) : [];
 if (__DEV__) logger.debug('[LIB] local approved=' + localBooksFiltered.length + ' pending=0 photos=' + loadedPhotos.length);

if (requestId === pendingLoadRequestIdRef.current) {
if (localBooksFiltered.length > 0) {
setBooks(normalizeBooksSourcePhotoIds(dedupeBooks(localBooksFiltered)));
setPhotos(normalizePhotosToCanonicalIds(dedupBy(loadedPhotos, photoStableKey)));
setFolders(loadedFolders);
} else {
// Local is empty (e.g. after clear): clear UI immediately so we never flash stale 251 books
setBooks([]);
setPhotos([]);
setFolders([]);
}
} else if (__DEV__) {
 if (LOG_TRACE) logger.debug('[MYLIB_LOAD_USER_DATA] skip initial apply: stale request', { requestId, current: pendingLoadRequestIdRef.current });
 }

 // Then load from Supabase — FULL snapshot via canonical fetchers.
 // fetchAllApprovedBooks uses count-guided pagination so a PostgREST max-rows cap
 // cannot truncate the result. This is the ONLY path allowed to overwrite the
 // canonical booksById / canonical library state.
 // "Recent" or limit(N) queries MUST NOT overwrite this; they may only be merged in.
 let supabaseBooks: { approved: Book[]; pending: Book[]; rejected: Book[] } | null = null;
 let supabaseError = null;
 let supabaseFolders: Folder[] = [];
 try {
   const TIMEOUT_MS = 30_000; // 30 s — longer than previous 20 s to let pagination finish
   const [booksResult, foldersResult] = await Promise.all([
     Promise.race([
       // Use loadBooksFromSupabase which now delegates to fetchAllApprovedBooks internally.
       // This guarantees a full snapshot even when the server cap is < 1000.
       loadBooksFromSupabase(user.uid),
       new Promise<never>((_, reject) =>
         setTimeout(() => reject(new Error('Supabase load timeout after ' + TIMEOUT_MS / 1000 + 's')), TIMEOUT_MS)
       ),
     ]),
     loadFoldersFromSupabase(user.uid),
   ]);
   supabaseBooks = booksResult as { approved: Book[]; pending: Book[]; rejected: Book[] };
   supabaseFolders = (foldersResult || []) as Folder[];
   const _snapshotApprovedCount = supabaseBooks?.approved?.length ?? 0;
   logger.info('[MYLIB_FULL_SNAPSHOT]', {
     approved: _snapshotApprovedCount,
     pending: supabaseBooks?.pending?.length ?? 0,
     rejected: supabaseBooks?.rejected?.length ?? 0,
   });
   // ── Drop detection ─────────────────────────────────────────────────────
   const _lastAction = getLastDestructiveAction(user.uid);
   const _dropCheck = checkForSuspiciousDrop({
     serverApproved: _snapshotApprovedCount,
     serverPhotos: 0, // MyLibraryTab doesn't fetch photos count — approved books are the signal
     highWaterApproved: hwApprovedRef.current,
     highWaterPhotos: 0,
     lastDestructiveAction: _lastAction,
     minDropThreshold: 2, // require at least 2 missing to avoid false positives on normal deletes
   });
   if (_dropCheck.suspicious) {
     logger.warn('[DATA_SAFETY_DROP]', 'MyLibraryTab: suspicious book count drop', _dropCheck);
   }
   if (!_dropCheck.suspicious) {
     // Advance high-water mark when snapshot looks healthy.
     if (_snapshotApprovedCount > hwApprovedRef.current) {
       hwApprovedRef.current = _snapshotApprovedCount;
       saveHighWaterMark(user.uid, { approved: hwApprovedRef.current, photos: hwPhotosRef.current }).catch(() => {});
     }
   }
 } catch (error: any) {
   logger.error(' Error loading books from Supabase:', error);
   supabaseError = error;
   // Continue with local data if Supabase fails — don't lose local books!
 }
 
 // Merge Supabase books (which have cover data) with local books
 // CRITICAL: Start with ALL local books, then merge in Supabase data
 // This ensures no local books are lost if Supabase is missing them
 let mergedBooks: Book[] = [];

 // If user cleared library, do NOT repopulate from server. The cleared state persists
 // until the user explicitly approves new books (which removes the key).
 // Previously used a 120s timer that expired and let stale server data flow back in.
 const recentlyCleared = !!libraryClearedAt;
 if (recentlyCleared) {
 mergedBooks = [];
 if (user) {
 try {
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify([]));
 await AsyncStorage.setItem(userPhotosKey, JSON.stringify([]));
 await AsyncStorage.setItem(userFoldersKey, JSON.stringify([]));
 } catch (e) {}
 }
 if (requestId === pendingLoadRequestIdRef.current) {
 setBooks([]);
 setPhotos([]);
 setFolders([]);
 setUserProfile(prev => prev ? { ...prev, totalBooks: 0, totalPhotos: 0 } : null);
 refreshProfileStats([]);
 setIsLoadingData(false);
 }
 return;
 }

 // Approval grace window: don't overwrite optimistic approved with stale server data
 // when user just approved and navigated to Profile. Server may not have the new books yet.
 const APPROVE_GRACE_MS = 15_000;
 const hasApprovalGraceWindow = lastApprovedAt > 0 && (Date.now() - lastApprovedAt < APPROVE_GRACE_MS);
 const serverApprovedCount = supabaseBooks?.approved?.length ?? 0;
 if (hasApprovalGraceWindow && localBooksFiltered.length > 0 && serverApprovedCount < localBooksFiltered.length) {
   mergedBooks = localBooksFiltered;
   if (__DEV__) logger.debug('[MYLIB_GRACE_WINDOW]', 'keeping local approved — server snapshot stale after approve', { localApproved: localBooksFiltered.length, serverApproved: serverApprovedCount });
   // Skip the full server merge below; fall through to final setBooks with mergedBooks = local.
 } else if (!recentlyCleared && supabaseBooks && (supabaseBooks.approved?.length ?? 0) > 0) {

 if (DEBUG_VERBOSE) {
 const _supabaseTotal = supabaseBooks?.approved?.length ?? 0;
 logger.debug(` Starting merge: ${localBooksFiltered.length} local books, ${_supabaseTotal} Supabase approved books${recentlyCleared ? ' (recently cleared)' : ''}`);
 }
 
 // Library display must ONLY show approved books. Pending books belong in ScansTab for user approval.
 // Previously this included pending, which caused unapproved books to appear in the library after scan.
 const allSupabaseBooks = [...(supabaseBooks.approved ?? [])];
 const hasAnySupabaseBooks = allSupabaseBooks.length > 0;

 if (!recentlyCleared && supabaseBooks && hasAnySupabaseBooks) {
   // Safety check: if server returned fewer approved than our local snapshot, log (merge still keeps local).
   if ((supabaseBooks.approved?.length ?? 0) < localBooksFiltered.length) {
     logger.warn('[MYLIB_SNAPSHOT_PARTIAL]', {
       serverApproved: supabaseBooks.approved?.length ?? 0,
       localApproved: localBooksFiltered.length,
       diff: localBooksFiltered.length - (supabaseBooks.approved?.length ?? 0),
       note: 'Server returned fewer books than local cache — using local as base, server enriches',
     });
   }
 // Create a map of Supabase books by title+author and ID for quick lookup (approved + pending)
 const supabaseBooksMap = new Map<string, Book>();
 const supabaseBooksById = new Map<string, Book>();

 allSupabaseBooks.forEach(sb => {
 const key = `${sb.title?.toLowerCase().trim()}|${sb.author?.toLowerCase().trim() || ''}`;
 if (!supabaseBooksMap.has(key)) {
 supabaseBooksMap.set(key, sb);
 }
 if (sb.id) {
 supabaseBooksById.set(sb.id, sb);
 }
 });
 
 if (DEBUG_VERBOSE) {
 logger.debug(` Supabase: ${supabaseBooksMap.size} unique books by title+author, ${supabaseBooksById.size} books with IDs`);
 }
 
 // Use local books excluding deleted tombstone so we don't resurrect deleted entities
 const localBooksList: Book[] = [];
 const seenIds = new Set<string>();
 
 localBooksFiltered.forEach(b => {
 // Only skip if we've seen this EXACT same ID before (same book object)
 if (b.id) {
 if (seenIds.has(b.id)) {
 logger.warn(` Duplicate book with same ID skipped: "${b.title}" by ${b.author || 'Unknown'} (ID: ${b.id})`);
 return; // Skip this exact duplicate
 }
 seenIds.add(b.id);
 }
 // Keep ALL books, even if title+author match (user might have multiple copies)
 localBooksList.push(b);
 });
 
 if (DEBUG_VERBOSE) {
 logger.debug(` Local: ${localBooksList.length} books (keeping all, including duplicates)`);
 }
 
 // Merge: For each local book, update with Supabase data if it exists
 // CRITICAL: Track which Supabase books we've already matched to prevent duplicates
 const matchedSupabaseIds = new Set<string>();
 const matchedSupabaseKeys = new Set<string>();
 
 mergedBooks = localBooksList.map(localBook => {
          // Try to match by ID first (most reliable)
          if (localBook.id && supabaseBooksById.has(localBook.id)) {
            const supabaseBook = supabaseBooksById.get(localBook.id)!;
            matchedSupabaseIds.add(localBook.id);
            const key = `${supabaseBook.title?.toLowerCase().trim()}|${supabaseBook.author?.toLowerCase().trim() || ''}`;
            matchedSupabaseKeys.add(key);
            if (localBook?.description && !supabaseBook?.description) {
              logger.debug('[DESC_MERGE_LOCAL_WINS]', { id: supabaseBook.id, title: supabaseBook.title });
            }
            if (!localBook?.description && supabaseBook?.description) {
              logger.debug('[DESC_MERGE_REMOTE_WINS]', { id: supabaseBook.id, title: supabaseBook.title, len: supabaseBook.description?.length ?? 0 });
            }
            // Field-level merge: server wins for ids/enrichment, local wins for identity (title/author).
            // Preserves approved title/author so server normalisation can never overwrite what user approved.
            return mergeBookFieldLevel(supabaseBook, localBook);
          }
          
          // Try to match by title+author (but only if not already matched)
          const key = `${localBook.title?.toLowerCase().trim()}|${localBook.author?.toLowerCase().trim() || ''}`;
          if (!matchedSupabaseKeys.has(key) && supabaseBooksMap.has(key)) {
            const supabaseBook = supabaseBooksMap.get(key)!;
            matchedSupabaseKeys.add(key);
            if (supabaseBook.id) {
              matchedSupabaseIds.add(supabaseBook.id);
            }
            if (localBook?.description && !supabaseBook?.description) {
              logger.debug('[DESC_MERGE_LOCAL_WINS]', { id: supabaseBook.id, title: supabaseBook.title });
            }
            if (!localBook?.description && supabaseBook?.description) {
              logger.debug('[DESC_MERGE_REMOTE_WINS]', { id: supabaseBook.id, title: supabaseBook.title, len: supabaseBook.description?.length ?? 0 });
            }
            // Field-level merge: server wins for ids/enrichment, local wins for identity (title/author).
            return mergeBookFieldLevel(supabaseBook, localBook);
          }
 
 // Local book not in Supabase - keep it as-is (IMPORTANT: Don't drop it!)
 if (DEBUG_VERBOSE) {
 logger.debug(` Keeping local-only book: "${localBook.title}" by ${localBook.author || 'Unknown'}`);
 }
 return localBook;
 });
 
 if (DEBUG_VERBOSE) {
 logger.debug(` After merging local with Supabase: ${mergedBooks.length} books`);
 }
 
 // Also add any Supabase books (approved or pending) that aren't in local
 const supabaseOnlyBooks = allSupabaseBooks.filter(sb => {
 if (sb.id && matchedSupabaseIds.has(sb.id)) return false;
 const key = `${sb.title?.toLowerCase().trim()}|${sb.author?.toLowerCase().trim() || ''}`;
 return !matchedSupabaseKeys.has(key);
 });
 
 if (supabaseOnlyBooks.length > 0) {
 mergedBooks = [...mergedBooks, ...supabaseOnlyBooks];
 if (DEBUG_VERBOSE) {
 logger.debug(` Adding ${supabaseOnlyBooks.length} Supabase-only books`);
 }
 }
 
 if (requestId === pendingLoadRequestIdRef.current && supabaseFolders.length > 0) {
 setFolders(supabaseFolders);
 try {
 await AsyncStorage.setItem(userFoldersKey, JSON.stringify(supabaseFolders));
 } catch (e) {}
 }
 
 } else {
 // Fallback to local books if Supabase has none (already filtered by deleted tombstone)
 mergedBooks = localBooksFiltered;
 if (DEBUG_VERBOSE) {
 logger.debug(` Using ${mergedBooks.length} local books (no Supabase data)`);
 }
 }
 } else {
 // Not in grace window and no server books (or supabaseBooks null): use local only
 mergedBooks = localBooksFiltered;
 }
 
 // CRITICAL: Log if we lost any books and identify which ones (compare to filtered local, not tombstoned)
 if (localBooksFiltered.length > 0 && mergedBooks.length < localBooksFiltered.length) {
 const lostCount = localBooksFiltered.length - mergedBooks.length;
 logger.error(` WARNING: Lost ${lostCount} books during merge! (${localBooksFiltered.length} ${mergedBooks.length})`);
 
 const mergedBookKeys = new Set(
 mergedBooks.map(b => `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`)
 );
 const lostBooks = localBooksFiltered.filter(b => {
 const key = `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`;
 return !mergedBookKeys.has(key);
 });
 
 if (lostBooks.length > 0) {
 logger.error(` Lost books:`, lostBooks.map(b => `"${b.title}" by ${b.author || 'Unknown'}`).join(', '));
 }
 }
 
  // Use merged result (local already excluded deleted tombstone; server excludes deleted_at rows).
  // Enforce that file:// photos with no remote storage cannot be marked 'complete'.
  const loadedPhotosGuarded = loadedPhotos.map(enforcePhotoStorageStatus);
  // Build a lookup keyed by BOTH raw photo id AND its canonical alias so a book referencing
  // a local/temp photoId is not falsely flagged as orphaned after dedupe.
  const photoIds = new Set<string>();
  loadedPhotosGuarded.forEach(p => {
    if (p.id) {
      photoIds.add(p.id);
      // Also register the alias target so canonical lookups hit even if the raw entry isn't stored.
      const canonical = photoIdAliasRef.current[p.id];
      if (canonical) photoIds.add(canonical);
    }
  });
  // Add all alias keys so a book whose source_photo_id is a local temp ID resolves correctly.
  Object.entries(photoIdAliasRef.current).forEach(([local, canonical]) => {
    if (photoIds.has(canonical)) photoIds.add(local);
  });

  // Integrity check: log only (action:'log_only') — no state mutation until canonical photo
  // insertion is stable. Pass books through unchanged; only warn if a photo is truly missing
  // even after alias resolution. Skip entirely if no photos are loaded yet (pre-hydration).
  const finalBooks = mergedBooks;
  if (loadedPhotosGuarded.length > 0) {
    const orphaned = finalBooks.filter(b => {
      const rawId = getBookSourcePhotoId(b);
      if (!rawId) return false;
      const resolvedId = photoIdAliasRef.current[rawId] ?? rawId;
      return !photoIds.has(rawId) && !photoIds.has(resolvedId);
    });
    if (orphaned.length > 0) {
      const missingPhotoIds = [...new Set(orphaned.map(b => getBookSourcePhotoId(b)).filter(Boolean))] as string[];
      const resolvedMissing = missingPhotoIds.map(id => photoIdAliasRef.current[id] ?? id);
      logger.logThrottle('integrity_library_view', 30_000, 'info', '[INTEGRITY_CLEANUP_DECISION]', 'summary', {
        phase: 'library_view',
        action: 'log_only',
        booksImpactedCount: orphaned.length,
        distinctMissingPhotoIds: missingPhotoIds.length,
        aliasesAvailable: Object.keys(photoIdAliasRef.current).length,
        ...(DEBUG_STACKS && { stack: new Error().stack?.split('\n').slice(1, 4).join(' | ') }),
      });
      if (DEBUG_INTEGRITY) {
        logger.info('[INTEGRITY_CLEANUP_DECISION]', {
          phase: 'library_view',
          missingPhotoIds: missingPhotoIds.slice(0, 5).map(id => id.slice(0, 8)),
          resolvedMissingPhotoIds: resolvedMissing.slice(0, 5).map(id => id.slice(0, 8)),
          reason: 'photo_missing_in_local_cache_after_alias_resolve',
          booksImpactedSample: orphaned.slice(0, 5).map(b => ({
            bookId: (b.id ?? '').slice(0, 8),
            photoIdRaw: (getBookSourcePhotoId(b) ?? '').slice(0, 8),
            photoIdResolved: (photoIdAliasRef.current[getBookSourcePhotoId(b) ?? ''] ?? getBookSourcePhotoId(b) ?? '').slice(0, 8),
          })),
        });
      }
    }
  }
 const total = finalBooks.length;
 const coversCount = finalBooks.filter(b => getBookCoverUri(b)).length;
 const missingCount = total - coversCount;
 if (__DEV__) {
 logger.debug('[LIB] merged total=' + total + ' covers=' + coversCount + ' missing=' + missingCount);
 if (missingCount > 0) {
 const missingCovers = finalBooks.filter(b => !getBookCoverUri(b)).slice(0, 5).map(b => ({ id: b.id ?? null, title: (b.title ?? '').slice(0, 40) }));
 logger.debug('[LIB] missingCovers sample=' + JSON.stringify(missingCovers));
 }
 }

 if (user) {
 const userApprovedKey = `approved_books_${user.uid}`;
 try {
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(finalBooks));
 } catch (error) {
 logger.error(' Error saving merged books to AsyncStorage:', error);
 // If save fails and we have books, this is critical - log it
 if (finalBooks.length > 0) {
 logger.error(' CRITICAL: Failed to save books to AsyncStorage! Books may be lost on next load.');
 }
 }
 }
 
 // Fix #4: Only apply if this request is still the latest (older load must not overwrite).
if (requestId === pendingLoadRequestIdRef.current) {
setBooks(normalizeBooksSourcePhotoIds(dedupeBooks(finalBooks)));
} else if (__DEV__) {
if (LOG_TRACE) logger.debug('[MYLIB_LOAD_USER_DATA] skip final apply: stale request', { requestId, current: pendingLoadRequestIdRef.current });
}
// Only keep photos that have at least one approved book (library = approved scans only)
 // Never prune non-finalized scans user may still approve. Only delete if finalized AND approvedCount === 0.
 const norm = (s: string | undefined) => (s ?? '').toLowerCase().trim();
 const photoHasApprovedBook = (photo: Photo, books: Book[]) => {
 if (!photo.books || photo.books.length === 0) return false;
 return photo.books.some(pb =>
 books.some(lb => norm(pb.title) === norm(lb.title) && norm(pb.author) === norm(lb.author))
 );
 };
 const photosWithApproved = loadedPhotos.filter(photo => {
 if (photo.finalizedAt == null) return true; // Keep non-finalized don't prune during sync
 return photoHasApprovedBook(photo, finalBooks);
 });
 if (photosWithApproved.length < loadedPhotos.length) {
 try {
 await AsyncStorage.setItem(userPhotosKey, JSON.stringify(photosWithApproved));
 } catch (e) {}
 }
if (requestId === pendingLoadRequestIdRef.current) {
setPhotos(normalizePhotosToCanonicalIds(dedupBy(photosWithApproved, photoStableKey)));
setFolders(supabaseFolders.length > 0 ? supabaseFolders : loadedFolders);
}
 
        setTimeout(() => {
          // LOCAL-ONLY: prune stale photos from AsyncStorage/local state only. No Supabase deletes.
          cleanupPhotosWithoutApprovedBooks(finalBooks, loadedPhotos).catch(error => {
 logger.error('Error cleaning up photos:', error);
 });
 }, 500);
 
 // Covers are resolved in worker (scan) or from Supabase (library); client shows book.coverUrl or placeholder
 
 // Helper to normalize strings for comparison (local to this function)
 const normalizeString = (str: string | undefined): string => {
 if (!str) return '';
 return str.trim().toLowerCase();
 };
 
 const booksMatch = (book1: Book, book2: Book): boolean => {
 const title1 = normalizeString(book1.title);
 const title2 = normalizeString(book2.title);
 const author1 = normalizeString(book1.author);
 const author2 = normalizeString(book2.author);
 
 if (title1 !== title2) return false;
 
 if (title1 && title2 && title1 === title2) {
 if (author1 && author2) {
 return author1 === author2;
 }
 return true;
 }
 
 return false;
 };

 const scansWithApprovedBooks = photosWithApproved.length;

 if (requestId === pendingLoadRequestIdRef.current) {
 // Update user profile with book/photo counts (preserve existing profile data)
 if (user) {
 setUserProfile(prev => {
 const profile: UserProfile = {
 displayName: prev?.displayName || user.displayName || user.username || 'User',
 email: prev?.email || user.email || '',
 createdAt: prev?.createdAt || new Date(),
 lastLogin: new Date(),
 totalBooks: mergedBooks.length,
 totalPhotos: scansWithApprovedBooks,
 };
 // Cache for instant load on next mount (prevents "User" and "0 authors" flash).
 AsyncStorage.setItem(`cached_profile_${user.uid}`, JSON.stringify(profile)).catch(() => {});
 return profile;
 });
 }
 logger.debug(` Successfully loaded ${mergedBooks.length} books, ${scansWithApprovedBooks} photos`);
 if (isFocusLoad) {
   const stateCommittedAt = Date.now();
   perfLog('photos_tab_open', 'state_committed', { stateCommittedAt, photosLength: scansWithApprovedBooks, booksLength: mergedBooks.length });
   requestAnimationFrame(() => {
     requestAnimationFrame(() => {
       perfLog('photos_tab_open', 'list_rendered', { listRenderedAt: Date.now(), photosLength: scansWithApprovedBooks, booksLength: mergedBooks.length });
     });
   });
 }
 setIsLoadingData(false);
 refreshProfileStats();
 }
 } catch (error) {
 logger.error('Error loading user data:', error);
 setIsLoadingData(false);
 // Do not show cached/local data on error avoid partial/stale library
 } finally {
 if (__DEV__) logger.debug('[LIB] refresh done', { ms: Date.now() - refreshStart });
 loadUserDataInProgressRef.current = false;
 lastLoadUserDataAtRef.current = Date.now();
 if (loadUserDataAgainAfterRef.current) {
 loadUserDataAgainAfterRef.current = false;
 loadUserData({ source: 'focus' }).catch(() => {});
 }
 }
 };

 const loadUserDataRef = useRef(loadUserData);
 loadUserDataRef.current = loadUserData;
 useEffect(() => {
 const unsub = subscribeLibraryInvalidate(() => {
 loadUserDataRef.current?.({ source: 'scan_terminal' }).catch(() => {});
 });
 return unsub;
 }, []);

 // Helper to get cover URI - stable fn to reduce re-renders; checks local cache first, then remote URL
 const getBookCoverUri = useCallback((book: Book): string | undefined => {
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
 }, []);

 // Cover resolution happens in worker; client renders book.coverUrl or localCoverPath or placeholder

 // Find which photo/scan the book came from (memoized to stabilize handleBookPress)
 const findBookPhoto = useCallback((book: Book): Photo | null => {
 return photos.find(photo =>
 photo.books.some(photoBook =>
 photoBook.title === book.title &&
 photoBook.author === book.author
 )
 ) || null;
 }, [photos]);

 const saveFolders = async (updatedFolders: Folder[]) => {
 if (!user) return;
 try {
 const userFoldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(userFoldersKey, JSON.stringify(updatedFolders));
 setFolders(updatedFolders);
 if (user.uid !== 'guest_user') {
 saveFoldersToSupabase(user.uid, updatedFolders).catch(() => {});
 }
 } catch (error) {
 logger.error('Error saving folders:', error);
 }
 };

 const deleteFolder = async (folderId: string) => {
 if (!user) return;
 
 Alert.alert(
 'Delete Collection',
 'Are you sure you want to delete this collection? This will not delete the books, they will remain in your library.',
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Delete',
 style: 'destructive',
 onPress: async () => {
 const updatedFolders = folders.filter(f => f.id !== folderId);
 await saveFolders(updatedFolders);
 
 // Close folder view if this folder was open
 if (selectedFolder?.id === folderId) {
 setShowFolderView(false);
 setSelectedFolder(null);
 }
 }
 }
 ]
 );
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
 'Auto-Sort Books by Genre',
 `This will organize ${booksToSort.length} unorganized books into collections by genre. Books will be matched to existing genre collections when possible. Your existing ${folders.length} collection${folders.length === 1 ? '' : 's'} will be preserved. Continue?`,
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Sort',
 onPress: async () => {
 setIsAutoSorting(true);
 try {
 // Get API base URL
 // Canonical URL: always use www.bookshelfscan.app
 const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
 
 if (!baseUrl) {
 throw new Error('API server URL not configured');
 }
 
 logger.debug(' Starting auto-sort via API...');
 
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
 
 // Update state immediately so UI reflects changes
 setFolders(finalFolders);
 
 // Then save to AsyncStorage
 await saveFolders(finalFolders);

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

 // Close folder view
 setShowFolderView(false);
 setSelectedFolder(null);
 } catch (error: any) {
 logger.error('Error auto-sorting books:', error);
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

 const addPhotoToFolder = async (photo: Photo, folderId: string) => {
 if (!user || !photo) return;
 
 try {
 // Get all approved books from this photo
 const photoApprovedBooks = photo.books.filter(photoBook => {
 return books.some(libraryBook => booksMatch(photoBook, libraryBook));
 });
 
 // Get their IDs
 const bookIdsToAdd = photoApprovedBooks
 .map(book => book.id)
 .filter((id): id is string => !!id);
 
 // Update folder to include this photo and its books
 const updatedFolders = folders.map(folder => {
 if (folder.id === folderId) {
 // Add photo ID if not already present
 const photoIds = folder.photoIds || [];
 if (!photoIds.includes(photo.id)) {
 photoIds.push(photo.id);
 }
 
 // Add book IDs that aren't already in the folder
 const existingBookIds = new Set(folder.bookIds || []);
 bookIdsToAdd.forEach(bookId => {
 if (!existingBookIds.has(bookId)) {
 folder.bookIds.push(bookId);
 }
 });
 
 return {
 ...folder,
 photoIds,
 bookIds: folder.bookIds
 };
 }
 return folder;
 });
 
 await saveFolders(updatedFolders);
 
 // Update selected folder if it's the one we just updated
 if (selectedFolder?.id === folderId) {
 setSelectedFolder(updatedFolders.find(f => f.id === folderId) || null);
 }
 } catch (error) {
 logger.error('Error adding photo to folder:', error);
 }
 };

 const [showFolderSelectModal, setShowFolderSelectModal] = useState(false);
 const [photoToAddToFolder, setPhotoToAddToFolder] = useState<Photo | null>(null);
 const [newFolderName, setNewFolderName] = useState('');
 const mergedPhotos = useMemo(
 () =>
 dedupBy(photos, canonicalPhotoListKey).filter((p) => {
 if (!p?.id) return false;
 if ((p as any)?.deleted_at) return false;
 return (p as any)?.status !== 'discarded';
 }),
 [photos]
 );

 const createFolder = async () => {
 if (!newFolderName.trim() || !user) return;
 
 try {
 const folderId = `folder_${Date.now()}`;
 const newFolder: Folder = {
 id: folderId,
 name: newFolderName.trim(),
 bookIds: [],
 photoIds: [],
 createdAt: Date.now(),
 };
 
 const updatedFolders = [...folders, newFolder];
 await saveFolders(updatedFolders);
 
 // Automatically add the photo to the newly created folder
 if (photoToAddToFolder) {
 await addPhotoToFolder(photoToAddToFolder, folderId);
 setShowFolderSelectModal(false);
 setPhotoToAddToFolder(null);
 setNewFolderName('');
 Alert.alert('Success', `Photo added to "${newFolder.name}"`);
 } else {
 setNewFolderName('');
 }
 } catch (error) {
 logger.error('Error creating folder:', error);
 Alert.alert('Error', 'Failed to create collection. Please try again.');
 }
 };

 const toggleBookSelection = useCallback((bookId: string) => {
 setSelectedBooks(prev => {
 const newSet = new Set(prev);
 if (newSet.has(bookId)) {
 newSet.delete(bookId);
 } else {
 newSet.add(bookId);
 }
 return newSet;
 });
 }, []);

 const handleBookPress = useCallback((book: Book) => {
 if (isSelectionMode) {
 toggleBookSelection(book.id || '');
 } else {
 setSelectedBook(book);
 setSelectedPhoto(null);
 setShowBookDetail(true);
 InteractionManager.runAfterInteractions(() => {
 const photo = findBookPhoto(book);
 setSelectedPhoto(photo);
 });
 }
 }, [isSelectionMode, findBookPhoto, toggleBookSelection]);

const deleteSelectedBooks = async () => {
if (!user || selectedBooks.size === 0) return;

const bookCount = selectedBooks.size;
const _intent = createDeleteIntent('user_delete_books_bulk', 'MyLibraryTab');
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
logDeleteAudit(_intent, { bookCount: booksToDelete.length, bookIds: booksToDelete.map(b => b.id).filter((id): id is string => !!id).slice(0, 10), userId: user.uid });

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
 await loadUserData();

 Alert.alert('Success', `${bookCount} book${bookCount === 1 ? '' : 's'} deleted.`);
 } catch (error) {
 logger.error('Error deleting books:', error);
 Alert.alert('Error', 'Failed to delete books. Please try again.');
 }
 },
 },
 ]
 );
 };

 // Organic-but-stable cover tilt: deterministic per book, bounded to ±1.5deg.
 const getCoverTiltDeg = useCallback((book: Book, index: number): number => {
 const seed = `${book.id || ''}|${book.title || ''}|${book.author || ''}|${index}`;
 let hash = 0;
 for (let i = 0; i < seed.length; i++) {
 hash = ((hash << 5) - hash) + seed.charCodeAt(i);
 hash |= 0; // keep 32-bit
 }
 return ((Math.abs(hash) % 301) - 150) / 100;
 }, []);

 const renderBook = useCallback(({ item, index }: { item: Book; index: number }) => {
 const bookId = item.id || `${item.title}_${item.author || ''}`;
 const isSelected = selectedBooks.has(bookId);
 const coverTiltDeg = getCoverTiltDeg(item, index);
 return (
 <TouchableOpacity
 style={[
 styles.bookCard,
 isSelectionMode && isSelected && styles.selectedBookCard
 ]}
 onPress={() => handleBookPress(item)}
 activeOpacity={0.7}
 >
 {isSelectionMode && (
 <View style={styles.selectionOverlay}>
 {isSelected && (
 <View style={styles.selectionCheckmark}>
 <CheckmarkIcon size={18} color={t.colors.primary} />
 </View>
 )}
 </View>
 )}
 <View style={[styles.coverWrap, { transform: [{ rotate: `${coverTiltDeg}deg` }] }]}>
 <BookCoverImage
 book={item}
 style={[
 styles.bookCover,
 styles.bookCoverInWrap,
 isSelectionMode && isSelected && styles.selectedBookCover
 ]}
 placeholderStyle={styles.placeholderCover}
 resizeMode="cover"
 onError={__DEV__ ? (e: any) => {
 const status = e?.nativeEvent?.error ?? e?.nativeEvent?.code ?? e?.message ?? 'unknown';
 logger.warn('[BOOK_CARD] image load failed:', item.title ?? item.id, status);
 } : undefined}
 />
 {isSelectionMode && isSelected && <View style={styles.selectionCoverOverlay} pointerEvents="none" />}
 </View>
 {item.author && (
 <Text style={styles.bookAuthor}>
 {item.author}
 </Text>
 )}
 </TouchableOpacity>
 );
 }, [getBookCoverUri, getCoverTiltDeg, handleBookPress, isSelectionMode, selectedBooks, styles, t]);

 const renderFolderBook = ({ item, index }: { item: Book; index: number }) => {
 const bookId = item.id || `${item.title}_${item.author || ''}`;
 const isSelected = selectedFolderBooks.has(bookId);
 const coverTiltDeg = getCoverTiltDeg(item, index);
 
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
 <CheckmarkIcon size={18} color={t.colors.primary} />
 </View>
 )}
 </View>
 )}
 <View style={[styles.coverWrap, { transform: [{ rotate: `${coverTiltDeg}deg` }] }]}>
 {getBookCoverUri(item) ? (
 <Image 
 source={{ uri: getBookCoverUri(item) }} 
 style={[
 styles.bookCover,
 styles.bookCoverInWrap,
 isFolderSelectionMode && isSelected && styles.selectedBookCover
 ]}
 resizeMode="cover"
 />
 ) : (
 <View style={[styles.bookCover, styles.bookCoverInWrap, styles.placeholderCover]}>
 <Text style={styles.placeholderText} numberOfLines={(item.title?.trim().split(/\s+/).length ?? 1) <= 1 ? 1 : (item.title?.trim().split(/\s+/).length ?? 2) <= 3 ? 3 : 4} adjustsFontSizeToFit minimumFontScale={0.3}>
 {item.title}
 </Text>
 </View>
 )}
 {isFolderSelectionMode && isSelected && <View style={styles.selectionCoverOverlay} pointerEvents="none" />}
 </View>
 {item.author && (
 <Text style={styles.bookAuthor}>
 {item.author}
 </Text>
 )}
 </TouchableOpacity>
 );
 };

 // Helper function to normalize strings for comparison
 const normalizeString = (str: string | undefined): string => {
 if (!str) return '';
 return str.trim().toLowerCase();
 };

 // Helper function to compare if two books match
 const booksMatch = (book1: Book, book2: Book): boolean => {
 const title1 = normalizeString(book1.title);
 const title2 = normalizeString(book2.title);
 const author1 = normalizeString(book1.author);
 const author2 = normalizeString(book2.author);
 
 // Books match if titles match and either authors match or both are empty
 if (title1 !== title2) return false;
 
 // If titles match, check authors
 if (title1 && title2 && title1 === title2) {
 if (author1 && author2) {
 return author1 === author2;
 }
 // If one or both authors are empty but titles match, still consider it a match
 return true;
 }
 
 return false;
 };

 // Canonical approved-by-key map from approved books only (NOT pending). approvedBooksOnly defined earlier. Filter uses this so profile never shows pending as approved.
 const approvedByTitleAuthorKey = useMemo(() => {
 const m = new Map<string, Book>();
 if (!approvedBooksOnly.length) return m;
 const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
 approvedBooksOnly.forEach((b) => {
 const key = `${norm(b.title)}|${norm(b.author)}`;
 if (key && key !== '|') m.set(key, b);
 });
 return m;
 }, [approvedBooksOnly]);

 /** Temporary: set to true to filter only by photo.books?.length > 0 (confirms if filter + book jitter caused missing photo). */
 const PHOTO_FILTER_BOOKS_ONLY = false;

// Failed/Processing: photos without scan results (draft, stalled, scan_failed). Excludes complete/local_pending
// so those show in the main grid with "Processing results…" when 0 books (Fix C).
const failedOrProcessingPhotos = useMemo(() => {
  const aliasMap = photoIdAliasRef.current;
  const booksByPhotoId = new Map<string, Book[]>();
  (books ?? []).forEach(b => {
    const pid = getBookSourcePhotoId(b);
    if (!pid) return;
    const key = toPhotoKey(pid, aliasMap);
    if (!key) return;
    const arr = booksByPhotoId.get(key) ?? [];
    arr.push(b);
    booksByPhotoId.set(key, arr);
  });
  return photos.filter(photo => {
    if ((photo as any).deleted_at) return false;
    if ((photo as any).status === 'discarded') return false;
    if ((photo as any).status === 'complete' || (photo as any).status === 'local_pending') return false;
    const lookupKey = toPhotoKey(photo.id ?? '', aliasMap);
    const linkedBooks = booksByPhotoId.get(lookupKey) ?? [];
    const hasBooks = (photo.books?.length ?? 0) > 0 || linkedBooks.length > 0;
    return !hasBooks;
  });
}, [photos, books]);

  // Selectors: approvedBooks = status==='approved' only; pendingBooks = pending|incomplete. Profile MUST use approvedBooks only.
  const approvedBooks = approvedBooksOnly;
  const pendingBooks = useMemo(
    () => (books ?? []).filter((b) => ((b as any).status === 'pending' || (b as any).status === 'incomplete') && !(b as any).deleted_at),
    [books]
  );

  // Approved-only: Profile and collage header use this. Do NOT use for Pending or scan grouping — use booksByCanonicalPhotoId / pendingBooksByPhotoId or photosToShowInLibrary (pending+approved).
  const approvedBooksByPhotoId = useMemo(() => {
    const m = new Map<string, Book[]>();
    const aliasMap = photoIdAliasRef.current;
    approvedBooks.forEach(b => {
      const pid = getBookSourcePhotoId(b);
      if (!pid) return;
      const key = toPhotoKey(pid, aliasMap);
      if (!key) return;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    });
    return m;
  }, [approvedBooks]);

  const approvedCountsByPhotoId = useMemo(() => {
    const m = new Map<string, number>();
    approvedBooksByPhotoId.forEach((arr, key) => m.set(key, arr.length));
    return m;
  }, [approvedBooksByPhotoId]);

  // Legacy/diagnostic: photos with ≥1 approved book only. "Approved match" filter belongs only in My Library / Approved collage header. Pending and library grid use photosToShowInLibrary (pending+approved).
  const photosWithApprovedBooks = useMemo(() => {
    if (PHOTO_FILTER_BOOKS_ONLY) {
      return photos.filter(photo => (typeof photo.approved_count === 'number' && photo.approved_count > 0) || (photo.books?.length ?? 0) > 0);
    }
    const aliasMap = photoIdAliasRef.current;
    return photos.filter(photo => {
      if ((photo as any).deleted_at || (photo as any).status === 'discarded' || (photo as any).status === 'scan_failed') return false;
      const count = approvedCountsByPhotoId.get(toPhotoKey(photo.id ?? '', aliasMap)) ?? 0;
      return count > 0;
    });
  }, [photos, approvedCountsByPhotoId, PHOTO_FILTER_BOOKS_ONLY]);

  // Pending-only: for Scans/pending UI. status === 'pending' | 'incomplete', !deleted_at.
  const pendingBooksByPhotoId = useMemo(() => {
    const m = new Map<string, Book[]>();
    const aliasMap = photoIdAliasRef.current;
    (books ?? []).forEach(b => {
      const status = (b as any).status;
      if (status !== 'pending' && status !== 'incomplete') return;
      if ((b as any).deleted_at != null) return;
      const pid = getBookSourcePhotoId(b);
      if (!pid) return;
      const key = toPhotoKey(pid, aliasMap);
      if (!key) return;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    });
    return m;
  }, [books]);

  const pendingCountsByPhotoId = useMemo(() => {
    const m = new Map<string, number>();
    pendingBooksByPhotoId.forEach((arr, key) => m.set(key, arr.length));
    return m;
  }, [pendingBooksByPhotoId]);

  // All books by photo (pending + approved). Library grid uses photosToShowInLibrary which includes photos with any books.
  const booksByCanonicalPhotoId = useMemo(() => {
    const m = new Map<string, Book[]>();
    const aliasMap = photoIdAliasRef.current;
    (books ?? []).forEach(b => {
      const pid = getBookSourcePhotoId(b);
      if (!pid) return;
      const key = toPhotoKey(pid, aliasMap);
      if (!key) return;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    });
    photos.forEach(photo => {
      const key = toPhotoKey(photo.id ?? '', aliasMap);
      if (!key) return;
      const arr = m.get(key) ?? [];
      const byId = new Set(arr.map(x => x.id).filter((x): x is string => Boolean(x)));
      const byTitleAuthor = new Set(arr.map(x => `${(x.title ?? '').toLowerCase().trim()}|${(x.author ?? '').toLowerCase().trim()}`));
      (photo.books ?? []).forEach(pb => {
        if (pb.id && byId.has(pb.id)) return;
        const pk = `${(pb.title ?? '').toLowerCase().trim()}|${(pb.author ?? '').toLowerCase().trim()}`;
        if (!pb.id && byTitleAuthor.has(pk)) return;
        if (pb.id) byId.add(pb.id);
        byTitleAuthor.add(pk);
        arr.push(pb);
      });
      if (arr.length > 0) m.set(key, arr);
    });
    return m;
  }, [books, photos]);

  // Library grid: include photos with pending OR approved books (from books-by-photo join), OR photos that have books attached (server join), or complete/draft/stalled.
  // Never require "approved only" — when everything is pending, show photos that have pending books. If join fails (joinKeyMismatch), photo.books?.length > 0 still shows the photo.
  const photosToShowInLibrary = useMemo(() => {
    const aliasMap = photoIdAliasRef.current;
    return photos.filter(photo => {
      if ((photo as any).deleted_at || (photo as any).status === 'discarded' || (photo as any).status === 'scan_failed') return false;
      const attachedCount = (photo.books?.length ?? 0) > 0;
      if (attachedCount) return true;
      const key = toPhotoKey(photo.id ?? '', aliasMap);
      const approved = approvedCountsByPhotoId.get(key) ?? 0;
      const pending = pendingCountsByPhotoId.get(key) ?? 0;
      if (approved > 0 || pending > 0) return true;
      const showableStatus = (photo as any).status === 'complete' || (photo as any).status === 'draft' || (photo as any).status === 'stalled';
      return showableStatus;
    });
  }, [photos, approvedCountsByPhotoId, pendingCountsByPhotoId]);

  // One diagnostic log to pinpoint when photo grid flips to 0: approvedBooks size, photos size,
  // counts map existence/size, and sample counts for 2 visible photoIds (alias/canonical / overwrite detection).
  const isFocused = useIsFocused();
  useEffect(() => {
    const approvedCount = approvedBooksOnly.length;
    const photosCount = photos.length;
    const countsExists = approvedBooksByPhotoId != null;
    const countsKeyCount = approvedBooksByPhotoId?.size ?? 0;
    const visible = photosToShowInLibrary;
    const samplePhotoIds = visible.slice(0, 2).map(p => p.id ?? (p as any).jobId ?? '');
    const aliasMap = photoIdAliasRef.current;
    const sampleCounts = samplePhotoIds.map(photoId => {
      const key = toPhotoKey(photoId ?? '', aliasMap);
      const arr = key ? (approvedBooksByPhotoId?.get(key) ?? []) : [];
      return { photoId: (photoId ?? '').slice(0, 8), key: (key ?? '').slice(0, 8), count: arr.length };
    });
    logger.cat('[PHOTO_GRID_DIAG]', '', {
      approvedBooks: approvedCount,
      photos: photosCount,
      countsByPhotoIdExists: countsExists,
      countsByPhotoIdKeyCount: countsKeyCount,
      photosToShowInLibraryLength: visible.length,
      sampleCountsFor2Visible: sampleCounts,
    }, 'trace');
  }, [isFocused, photos.length, approvedBooksOnly.length, photosToShowInLibrary.length, approvedBooksByPhotoId, photosToShowInLibrary]);

 // Keep the old function name as a thin wrapper so call-sites that use it as a function still work.
 const getPhotosWithApprovedBooks = () => photosToShowInLibrary;

 // Diagnostic: merged vs filtered counts and dropped photo ids + reason.
 // Same rule as photosWithApprovedBooks: filtered = photos with ≥1 approved book (approvedBooksByPhotoId).
 const profilePhotosDiagnostic = useMemo(() => {
 const mergedPhotosCount = photos.length;
 const aliasMap = photoIdAliasRef.current;
 const _diagBooksByPhotoId = approvedBooksByPhotoId;
 const filtered = PHOTO_FILTER_BOOKS_ONLY
   ? photos.filter((p) => !(p as any).deleted_at && (p as any).status !== 'discarded' && (p as any).status !== 'scan_failed' && (typeof p.approved_count === 'number' && p.approved_count > 0))
   : photos.filter(photo => {
       if ((photo as any).deleted_at || (photo as any).status === 'discarded' || (photo as any).status === 'scan_failed') return false;
       const count = _diagBooksByPhotoId.get(toPhotoKey(photo.id ?? '', aliasMap))?.length ?? 0;
       return count > 0;
     });
 const filteredPhotosCount = filtered.length;
 const filteredIds = new Set(filtered.map(p => p.id).filter(Boolean));
 const approvedIds = new Set(approvedBooksOnly.map(b => b.id).filter((x): x is string => Boolean(x)));
 const resolveAlias = (bookId: string) => idAliasRef.current[bookId] ?? bookId;
 const norm = (s: string | undefined) => (s ?? '').toLowerCase().trim();
 const dropped: { photoId: string; jobId?: string; reason: 'no_books' | 'no_match' | 'missing_approved_id' | 'no_books_linked' }[] = [];
 photos.forEach(photo => {
 const id = photo.id ?? (photo as any).jobId ?? '';
 const jobId = (photo as any).jobId ?? undefined;
 if (filteredIds.has(id)) return;
 const key = toPhotoKey(photo.id ?? '', aliasMap);
 const linkedBooks = _diagBooksByPhotoId.get(key) ?? [];
 // no_books: neither photo.books nor source_photo_id links exist
 if (!photo.books?.length && linkedBooks.length === 0) {
   dropped.push({ photoId: id, jobId, reason: 'no_books' });
   return;
 }
 // no_books_linked: photo.books is empty but linked books exist — means denorm not backfilled
 if (!photo.books?.length && linkedBooks.length > 0) {
   dropped.push({ photoId: id, jobId, reason: 'no_books_linked' });
   return;
 }
 const hasKeyMatch = photo.books.some((pb: { title?: string; author?: string; id?: string }) => {
 const key = `${norm(pb.title)}|${norm(pb.author)}`;
 return approvedByTitleAuthorKey.has(key);
 });
 // Resolve id through alias before presence check so temp IDs don't drop during transitional state.
 const hasMissingApprovedId = photo.books.some((pb: { id?: string }) => pb.id && !approvedIds.has(resolveAlias(pb.id)));
 if (hasKeyMatch && hasMissingApprovedId) {
 dropped.push({ photoId: id, jobId, reason: 'missing_approved_id' });
 } else if (!hasKeyMatch) {
 dropped.push({ photoId: id, jobId, reason: 'no_match' });
 } else {
 dropped.push({ photoId: id, jobId, reason: 'missing_approved_id' });
 }
 });
 return { mergedPhotosCount, filteredPhotosCount, dropped };
 }, [photos, approvedBooksOnly, approvedByTitleAuthorKey, PHOTO_FILTER_BOOKS_ONLY, approvedBooksByPhotoId]);

 useEffect(() => {
 if (profilePhotosDiagnostic.mergedPhotosCount === 0) return;
 logger.debug('[PROFILE_PHOTOS]', 'before render', {
 mergedPhotosCount: profilePhotosDiagnostic.mergedPhotosCount,
 filteredPhotosCount: profilePhotosDiagnostic.filteredPhotosCount,
 dropped: profilePhotosDiagnostic.dropped.length > 0
 ? profilePhotosDiagnostic.dropped.map(d => ({ photoId: d.photoId, jobId: d.jobId, reason: d.reason }))
 : undefined,
 });
 }, [profilePhotosDiagnostic]);

  // Invariant check: every displayed photo has books; every displayed book has source_photo_id and that photo exists.
  // Log first failures to distinguish data-model vs merge-logic issues.
  useEffect(() => {
    // Skip the check before any photos are loaded — would produce false positives.
    if (photos.length === 0) return;

    const displayedPhotos = getPhotosWithApprovedBooks();
    // Index by canonical full UUID only (canon). Never use slice(0, 8) or prefix as join key.
    const photosById = new Map<string, Photo>();
    photos.forEach(p => {
      const k = canon(p.id);
      if (k) photosById.set(k, p);
    });
    Object.entries(photoIdAliasRef.current).forEach(([local, canonical]) => {
      const photo = photosById.get(canon(canonical));
      if (photo && !photosById.has(canon(local))) photosById.set(canon(local), photo);
    });

    const bookList = books ?? [];
    const missingPhotoRow: { bookId: string; photoId: string; resolvedPhotoId: string }[] = [];
    const bookWithNullPhotoId: { bookId: string }[] = [];
    const photoWithNoBooks: { photoId: string }[] = [];
    displayedPhotos.forEach(photo => {
      if ((photo.books?.length ?? 0) === 0) {
        photoWithNoBooks.push({ photoId: photo.id ?? (photo as any).jobId ?? '' });
      }
    });
    bookList.forEach(book => {
      const photoId = getBookSourcePhotoId(book as Book);
      const bookId = (book.id ?? book.book_key ?? '').toString();
      if (!photoId) {
        bookWithNullPhotoId.push({ bookId });
      } else {
        if (!photosById.get(canon(photoId))) {
          const resolvedPhotoId = photoIdAliasRef.current[photoId] ?? photoId;
          missingPhotoRow.push({ bookId, photoId, resolvedPhotoId });
        }
      }
    });
 const hasFailures = missingPhotoRow.length > 0 || bookWithNullPhotoId.length > 0 || photoWithNoBooks.length > 0;
 if (hasFailures) {
 // Summary: throttled info (not warn) so LogBox overlays don't fire.
 const _invariantSig = `photo_book_invariant:${missingPhotoRow.length}:${bookWithNullPhotoId.length}:${photoWithNoBooks.length}`;
 logger.logOnce(_invariantSig, 'info', '[PHOTO_BOOK_INVARIANT]', 'relationship check failed (summary)', {
 counts: { missingPhotoRow: missingPhotoRow.length, bookWithNullPhotoId: bookWithNullPhotoId.length, photoWithNoBooks: photoWithNoBooks.length },
 });
 // Detail: throttled to 30 s so renders don't spam. Only fires when DEBUG_INTEGRITY=true.
 if (DEBUG_INTEGRITY) {
 const missingPhotoIds = [...new Set(missingPhotoRow.map((r) => r.photoId))];
 logger.logThrottle('photo_book_invariant_detail', 30_000, 'info', '[PHOTO_BOOK_INVARIANT_CONTEXT]', 'detail', {
 phase: 'library_view',
 missingPhotoIds,
 missingPhotoRow: missingPhotoRow.slice(0, 5),
 bookWithNullPhotoId: bookWithNullPhotoId.slice(0, 5),
 photoWithNoBooks: photoWithNoBooks.slice(0, 5),
 });
 }
    }
  }, [photos, books, approvedByTitleAuthorKey, PHOTO_FILTER_BOOKS_ONLY, resolvePhotoId]);

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const isStableBookId = (id: string) => UUID_REGEX.test(id);
 const isTempBookId = (id: string) => /^book_/.test(id) || (!UUID_REGEX.test(id) && id.length > 0);

 // Debug: log photo filter steps, approved checksum, missing book ids (canonical minus used-by-filter)
 useEffect(() => {
 if (photos.length === 0) return;
 const norm = (s: string | undefined) => (s ?? '').toLowerCase().trim();
 const step1Total = photos.length;
 const step2HasBooks = photos.filter((p) => p.books && p.books.length > 0).length;
 // My Library / Profile: use ONLY approved books for filter and count (pending must not leak).
 const canonicalList = approvedBooksOnly;
 const mergedApprovedIds = new Set<string>(canonicalList.map((b) => b.id).filter((x): x is string => Boolean(x)));
 const sortedIds = [...mergedApprovedIds].sort();
 const approvedIdsChecksum = sortedIds.length <= 10 ? sortedIds : [...sortedIds.slice(0, 5), '', ...sortedIds.slice(-5)];
 const booksWithStableId = canonicalList.filter((b) => b.id && isStableBookId(b.id)).length;
 const booksWithTempId = canonicalList.filter((b) => b.id && isTempBookId(b.id)).length;
 const booksWithNoId = canonicalList.filter((b) => !b.id || b.id.trim() === '').length;

 // Invariant: if we claim approved count > 0, every item must have status === 'approved'.
 if (canonicalList.length > 0) {
   const offenders = canonicalList.filter((b) => (b as any).status !== 'approved');
   if (offenders.length > 0) {
     logger.warn('[APPROVED_INVARIANT]', 'approvedBooksCount > 0 but some items are not status===approved', {
       approvedBooksCount: canonicalList.length,
       offendersCount: offenders.length,
       offenderStatuses: offenders.slice(0, 5).map((b) => ({ id: (b.id ?? '').slice(0, 8), status: (b as any).status })),
     });
   }
 }

 // Same rule as photosWithApprovedBooks: Profile Photos = photos with ≥1 approved book (by approvedBooksByPhotoId).
 const aliasMapForDiag = photoIdAliasRef.current;
 const photosPassingFilter = photos.filter((photo) => {
 if ((photo as any).deleted_at || (photo as any).status === 'discarded' || (photo as any).status === 'scan_failed') return false;
 const count = approvedBooksByPhotoId.get(toPhotoKey(photo.id ?? '', aliasMapForDiag))?.length ?? 0;
 return count > 0;
 });
 const step3WithApprovedMatch = photosPassingFilter.length;

 const approvedIdsUsedByFilter = new Set<string>();
 photosPassingFilter.forEach((photo) => {
 const key = toPhotoKey(photo.id ?? '', aliasMapForDiag);
 (approvedBooksByPhotoId.get(key) ?? []).forEach((b) => { if (b.id) approvedIdsUsedByFilter.add(b.id); });
 });
 const resolveAliasForFilter = (bookId: string) => idAliasRef.current[bookId] ?? bookId;
 const missingBookIds = [...mergedApprovedIds].filter((id) => !approvedIdsUsedByFilter.has(resolveAliasForFilter(id)));
 // Classify: droppedHasBooksNoApprovedMatch = photos that have books attached but 0 approved (pending-only).
 const photosNoBooks = photos.filter(p => !p.books?.length);
 const photosHasBooksNoMatch = photos.filter(p => {
 if (!p.books?.length) return false;
 const count = approvedBooksByPhotoId.get(toPhotoKey(p.id ?? '', aliasMapForDiag))?.length ?? 0;
 return count === 0;
 });
  // A photo is considered displayable if it has: http uri, storage_path, storage_url, OR local uri (file://) while upload completes.
  // Only flag as "no storage" if ALL are absent — draft with file:// is displayable and should not be counted as droppedNoStorage.
  const photosNoStorage = photos.filter(p => {
    const uri = (p as any).uri ?? null;
    const storageUrl = (p as any).storage_url ?? null;
    const storagePath = (p as any).storage_path ?? null;
    const hasHttpUri = uri && typeof uri === 'string' && uri.startsWith('http');
    const hasLocalUri = uri && typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('ph://'));
    const hasLegacyUrl = storageUrl && typeof storageUrl === 'string' && storageUrl.startsWith('http');
    const hasStoragePath = storagePath && typeof storagePath === 'string' && storagePath.trim().length > 0;
    return !hasHttpUri && !hasLocalUri && !hasLegacyUrl && !hasStoragePath;
  });
  // Legacy alias — kept so the log key below doesn't break existing log parsers.
  const photosNoStorageUrl = photosNoStorage;

 // Rule: Profile "Photos" count = photos with ≥1 approved book (approvedCountsByPhotoId > 0). Do not mix with "photos scanned".
 // photosFiltered = that count. droppedHasBooksNoApprovedMatch = photos that have books attached but 0 approved (pending-only).
 const filterLogKey = `${step1Total}:${step2HasBooks}:${step3WithApprovedMatch}:${canonicalList.length}`;
 logger.whenChanged(filterLogKey, 'info', '[PHOTO_FILTER_STEPS]', `photosWithApprovedBooks=${step3WithApprovedMatch} of merged=${step1Total} (photosWithBooksAttached=${step2HasBooks})`, {
 photosWithApprovedBooks: step3WithApprovedMatch,
 mergedPhotos: step1Total,
 photosWithBooksAttached: step2HasBooks,
 approvedBooksCount: canonicalList.length,
 approvedBooksWithStableId: booksWithStableId,
 approvedBooksWithTempId: booksWithTempId,
 approvedBooksWithNoId: booksWithNoId,
 droppedNoBooks: photosNoBooks.length,
 droppedHasBooksNoApprovedMatch: photosHasBooksNoMatch.length,
  // droppedNoStorage: photos with NO storage at all (no http uri, no storage_path, no storage_url).
  // storage_path alone is sufficient — PhotoTile derives a signed URL at display time.
  // A non-zero count here means photos that were never uploaded or whose upload never completed.
  droppedNoStorage: photosNoStorage.length,
  // Full detail on photos with no storage at all
  ...(photosNoStorage.length > 0 && {
    noStoragePhotos: photosNoStorage.map(p => ({
      id: p.id,
      storage_url: (p as any).storage_url ?? null,
      storage_path: (p as any).storage_path ?? null,
      uri: (p as any).uri ?? null,
      status: (p as any).status ?? null,
      deleted_at: (p as any).deleted_at ?? null,
      photoBooksAttached: p.books?.length ?? 0,
    })),
  }),
 // Photos that have books but no approved match title/author mismatch?
 ...(LOG_DEBUG && photosHasBooksNoMatch.length > 0 && {
 photosWithBooksNoMatch: photosHasBooksNoMatch.map(p => ({
 id: p.id,
 bookKeys: p.books?.map(b => `${norm(b.title)}|${norm(b.author)}`).slice(0, 3),
 })).slice(0, 5),
 }),
 ...(LOG_DEBUG && missingBookIds.length > 0 && { missingCount: missingBookIds.length, missingBookIdsSample: missingBookIds.slice(0, 5) }),
 });
 }, [photos, approvedBooksOnly, approvedByTitleAuthorKey, approvedBooksByPhotoId]);

  // LOCAL-ONLY PRUNE — never calls Supabase delete or soft-delete.
  // Removes stale photo entries from local React state and AsyncStorage only.
  // Background auto-delete was previously causing canonical photos to vanish while
  // books that referenced them were still being imported.
  // Rule: photo deletes must only happen via explicit user action
  //   ("Delete photo" confirm dialog in Library or "Remove" in Scans tab).
  // This function is intentionally non-destructive and safe to call from rehydrate.
  const cleanupPhotosWithoutApprovedBooks = async (currentBooks: Book[], currentPhotos: Photo[]) => {
 if (!user || currentPhotos.length === 0) return;
 if (shouldSkipCleanup()) {
 logger.debug('[PHOTO_PRUNE]', 'skipped (provenance missing this session)', {});
 return;
 }

 try {
 // Helper function to check if a photo has approved books
 const photoHasApprovedBooks = (photo: Photo): boolean => {
 if (!photo.books || photo.books.length === 0) {
 return false;
 }
 
 return photo.books.some(photoBook => {
 return currentBooks.some(libraryBook => {
 return booksMatch(photoBook, libraryBook);
 });
 });
 };
 
 // Only delete if finalized AND approvedCount === 0. Never remove a photo that any book references (invariant: no book missing photo).
 const photosToDelete = currentPhotos.filter(photo =>
 photo.finalizedAt != null &&
 !photoHasApprovedBooks(photo) &&
 !currentBooks.some(b => getBookSourcePhotoId(b) === photo.id)
 );
 
 if (photosToDelete.length === 0) {
 return;
 }
 
 // Local/AsyncStorage only do NOT call deleteLibraryPhotoAndBooks. Auto-delete during sync was deleting canonical photos.
 // Only allow photo deletes via explicit user action (Library "Delete photo" or Scans "Remove").
 const updatedPhotos = currentPhotos.filter(photo =>
 photo.finalizedAt == null || photoHasApprovedBooks(photo)
 );
 logger.debug('[PHOTO_PRUNE]', {
 before: currentPhotos.length,
 after: updatedPhotos.length,
 removed: currentPhotos.length - updatedPhotos.length,
 reason: 'local only (no Supabase delete)',
 });
 setPhotos(dedupBy(updatedPhotos, photoStableKey));
 const userPhotosKey = `photos_${user.uid}`;
 await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
 } catch (error) {
 logger.error('Error cleaning up photos:', error);
 }
 };

 // Profile "Photos" count = photos with ≥1 approved book (same definition as ProfileStatsContext.displayPhotoCount).
 const getScansWithBooks = () => photosWithApprovedBooks.length;
 // Header collage: only approved library books (pending must not show in profile).
 const activeBooksForHeader = useMemo(
 () =>
 approvedBooksOnly.filter((b) => {
 if ((b as any)?.status === 'deleted') return false;
 if ((b as any)?.deleted_at != null) return false;
 return true;
 }),
 [approvedBooksOnly]
 );
 // Show collage as soon as we have approved books — don't wait for libraryHydrated
 // (which depends on ScansTab's loadUserData completing the full server merge).
 // Books from AsyncStorage cache are available almost instantly.
 const showHeaderCovers = activeBooksForHeader.length > 0;

 const stableHash = useCallback((input: string): number => {
 let h = 2166136261;
 for (let i = 0; i < input.length; i++) {
 h ^= input.charCodeAt(i);
 h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
 }
 return h >>> 0;
 }, []);

 const normalizeCoverKey = useCallback((s: string | undefined): string => (s ?? '').trim().toLowerCase(), []);

 const computeHeaderCollageCovers = useCallback(() => {
 const userSeed = user?.uid ?? 'anonymous';
 const unique = new Map<string, string>();

 const addBookCover = (coverUri: string | undefined, fallbackIdentity?: string) => {
 const normalizedCover = normalizeCoverKey(coverUri);
 // Guardrail: only allow non-empty remote URLs and explicitly reject scan/photo/camera paths.
 if (!normalizedCover) return;
 if (!/^https?:\/\//.test(normalizedCover)) return;
 if (
 normalizedCover.includes('/scans/') ||
 normalizedCover.includes('scan_photos') ||
 normalizedCover.includes('/photos/') ||
 normalizedCover.includes('camera') ||
 normalizedCover.includes('assets-library://') ||
 normalizedCover.includes('content://') ||
 normalizedCover.includes('file://')
 ) {
 return;
 }
 const identity = fallbackIdentity?.trim();
 const dedupeKey = normalizedCover || identity;
 if (!dedupeKey || unique.has(dedupeKey)) return;
 if (coverUri && coverUri.trim()) unique.set(dedupeKey, coverUri.trim());
 };

 // Only approved library books with real cover URLs.
 activeBooksForHeader.forEach((book) => {
 const coverUri = (book as any).coverUrl || (book as any).cover_url;
 const fallbackIdentity = [book.work_key, book.book_key, book.dbId, book.id, book.isbn]
 .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
 .join('|');
 addBookCover(coverUri, fallbackIdentity);
 });

 const stableOrdered = Array.from(unique.values()).sort((a, b) => {
 const ka = stableHash(`${userSeed}|${a}`);
 const kb = stableHash(`${userSeed}|${b}`);
 return ka - kb;
 });

 // Keep enough candidates for both rows.
 return stableOrdered.slice(0, LOCKED_PROFILE_HEADER.collageMaxCovers);
 }, [activeBooksForHeader, normalizeCoverKey, stableHash, user?.uid]);

 // Generate collage selection once per app session/user.
 // Do not regenerate on focus/tab switching.
 useEffect(() => {
 const userKey = user?.uid ?? 'anonymous';
 if (!showHeaderCovers) {
 sessionHeaderCollageCacheByUser.delete(userKey);
 setHeaderCollageCovers([]);
 return;
 }
 // Wait until full data has loaded before generating collage.
 // If we have a known book count from the stats cache, don't generate until
 // approvedBooksOnly has at least that many books (prevents 3-cover flash).
 const expectedCount = effectiveDisplayBookCount ?? 0;
 const haveFullData = expectedCount === 0 || activeBooksForHeader.length >= expectedCount;

 const cached = sessionHeaderCollageCacheByUser.get(userKey);
 if (cached && haveFullData) {
   // Regenerate if cached covers are fewer than available (previous partial generation)
   const booksWithCovers = activeBooksForHeader.filter(b => (b as any).coverUrl || (b as any).cover_url).length;
   if (cached.length >= Math.min(booksWithCovers, 10)) {
     setHeaderCollageCovers(cached);
     return;
   }
 } else if (cached && !haveFullData) {
   // Partial data — use existing cache temporarily but don't regenerate yet
   setHeaderCollageCovers(cached);
   return;
 }

 // Wait until books are loaded before first generation.
 if (!haveFullData || !activeBooksForHeader || activeBooksForHeader.length === 0) return;

 const generated = computeHeaderCollageCovers();
 sessionHeaderCollageCacheByUser.set(userKey, generated);
 setHeaderCollageCovers(generated);
 }, [user?.uid, activeBooksForHeader, showHeaderCovers, computeHeaderCollageCovers]);

 // Library requires sign-in: show login when no session (guest). Other tabs allow guest (e.g. one free scan on Scans).
 if (!authReady || authLoading) {
 return (
 <View style={{ flex: 1, backgroundColor: t.colors.bg, justifyContent: 'center', alignItems: 'center' }}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 <Text style={{ marginTop: 12, color: t.colors.textMuted }}>Loading</Text>
 </View>
 );
 }
 if (!session) {
 return (
 <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
 <LoginScreen onAuthSuccess={() => {
 setTimeout(() => { navigation.navigate('Scans' as never); }, 100);
 }} />
 </View>
 );
 }
 if (user && isGuestUser(user)) {
 return (
 <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
 <LoginScreen onAuthSuccess={() => {
 setTimeout(() => { navigation.navigate('Scans' as never); }, 100);
 }} />
 </View>
 );
 }

 if (sessionMissingForLibrary) {
 return (
 <View style={{ flex: 1, backgroundColor: t.colors.bg, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
 <Text style={{ fontSize: 18, color: t.colors.text, textAlign: 'center', marginBottom: 16 }}>
 Please sign in again
 </Text>
 <Text style={{ fontSize: 14, color: t.colors.textMuted, textAlign: 'center', marginBottom: 24 }}>
 Your session may have expired. Sign out and sign back in to load your library.
 </Text>
 <TouchableOpacity
 onPress={async () => {
 setSessionMissingForLibrary(false);
 await signOut();
 }}
 style={{ backgroundColor: t.colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 }}
 >
 <Text style={{ color: t.colors.primaryText, fontSize: 16 }}>Sign out and sign in again</Text>
 </TouchableOpacity>
 </View>
 );
 }

 return (
 <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
 <ScrollView 
 ref={scrollViewRef} 
 style={styles.container} 
 showsVerticalScrollIndicator={false}
 bounces={false}
 overScrollMode="never"
 keyboardShouldPersistTaps="handled"
 keyboardDismissMode="none"
 contentContainerStyle={
 librarySearch.trim()
 ? { paddingTop: 0, paddingBottom: screenHeight * 0.6 }
 : { paddingTop: 0 }
 }
 >
 {/* Editorial profile hero: subtle collage + warm dark overlay + centered identity. */}
 <View
 style={[
 styles.profileHeroHeader,
 {
 backgroundColor: t.colors.headerBg ?? t.colors.headerBackground ?? t.colors.surface,
 },
 ]}
 >
 {showHeaderCovers ? (
 <HeaderShelfCollage
 covers={headerCollageCovers}
 height={LOCKED_PROFILE_HEADER.height}
 blurRadius={LOCKED_PROFILE_HEADER.collageBlur}
 muted
 opacity={LOCKED_PROFILE_HEADER.collageOpacity}
 twoRows
 />
 ) : null}
 <View pointerEvents="none" style={styles.coversDarkenOverlay} />
 <LinearGradient
 pointerEvents="none"
 colors={LOCKED_PROFILE_HEADER.gradientColors}
 start={{ x: 0.5, y: 0 }}
 end={{ x: 0.5, y: 1 }}
 style={styles.profileHeroOverlay}
 />

 <View style={[styles.profileHeaderInner, { paddingTop: 14 + insets.top }]}>
 <Pressable
 style={({ pressed }) => [
 styles.headerGearButton,
 pressed && styles.headerGearButtonPressed,
 ]}
 onPress={() => setShowSettings(true)}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <View style={styles.headerGearIconWrap}>
 <SettingsIcon size={22} color="#FFFFFF" />
 </View>
 </Pressable>

 <View style={styles.headerIdentityRow}>
 <View style={styles.headerNameStack}>
 <Text style={styles.headerName} numberOfLines={1}>
 {userProfile?.displayName || user?.username || 'User'}
 </Text>
 {user?.username ? (
 <Text style={styles.headerUsername} numberOfLines={1}>
 @{user.username}
 </Text>
 ) : null}
 </View>
 </View>
 </View>
 </View>
 
 {/* Profile count debug: prove mismatch between list length and entity map when present */}
 {(() => {
 const approvedIdsArr = approvedBooksOnly.map(b => b.id).filter((x): x is string => Boolean(x));
 const localApprovedLen = 0;
 const serverApprovedLen = 0;
 const mergedApprovedLen = approvedBooksOnly.length;
 const booksById: Record<string, Book> = {};
 approvedBooksOnly.forEach(b => { if (b.id) booksById[b.id] = b; });
 const booksByIdLen = Object.keys(booksById).length;
 const resolveAliasForDebug = (id: string) => idAliasRef.current[id] ?? id;
 const booksByIdHasApproved = approvedIdsArr.filter(id => !!booksById[id]).length;
 const booksByIdHasApprovedAfterAlias = approvedIdsArr.map(resolveAliasForDebug).filter(id => !!booksById[id]).length;
 const hasMissingId = approvedIdsArr.some(id => !booksById[resolveAliasForDebug(id)]);
 logger.trace('[PROFILE_COUNT_DEBUG]', {
 approvedLen: approvedIdsArr.length,
 localApprovedLen,
 serverApprovedLen,
 mergedApprovedLen,
 booksByIdLen,
 booksByIdHasApproved,
 booksByIdHasApprovedAfterAlias,
 hasMissingId,
 hydration: { bootstrapped: undefined, hasServerHydrated: undefined, mergeInProgress },
 });
 return null;
 })()}
 {/* Library Statistics: inline section, theme background, no card/shadow */}
 <View style={styles.statsSection}>
 <View style={styles.statsHeader}>
 <Text style={styles.statsTitle}>Library Overview</Text>
 </View>
 {/* iPad: all 4 stats in one row. Phone: 2 rows of 2. */}
 {screenWidth >= 768 ? (
 <View style={styles.statsRow}>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowLibraryView(true)}>
 <Text style={styles.statLabel}>Books</Text>
 <Text style={styles.statNumber}>{displayBookCountText}</Text>
 </Pressable>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => { if (photosNavLockRef.current) return; photosNavLockRef.current = true; (navigation as any).navigate('Photos'); setTimeout(() => { photosNavLockRef.current = false; }, 700); }}>
 <Text style={styles.statLabel}>Photos</Text>
 <Text style={styles.statNumber}>{displayPhotoCountText}</Text>
 </Pressable>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowAuthorsView(true)}>
 <Text style={styles.statLabel}>Authors</Text>
 <Text style={styles.statNumber}>{displayAuthorsCount}</Text>
 </Pressable>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowStatsView(true)}>
 <Text style={styles.statLabel}>Stats</Text>
 </Pressable>
 </View>
 ) : (
 <>
 <View style={styles.statsRow}>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowLibraryView(true)}>
 <Text style={styles.statLabel}>Books</Text>
 <Text style={styles.statNumber}>{displayBookCountText}</Text>
 </Pressable>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => { if (photosNavLockRef.current) return; photosNavLockRef.current = true; (navigation as any).navigate('Photos'); setTimeout(() => { photosNavLockRef.current = false; }, 700); }}>
 <Text style={styles.statLabel}>Photos</Text>
 <Text style={styles.statNumber}>{displayPhotoCountText}</Text>
 </Pressable>
 </View>
 <View style={styles.statsRow}>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowAuthorsView(true)}>
 <Text style={styles.statLabel}>Authors</Text>
 <Text style={styles.statNumber}>{displayAuthorsCount}</Text>
 </Pressable>
 <Pressable style={({ pressed, hovered }) => [styles.statCard, styles.statCardInteractive, hovered && styles.statCardHover, pressed && styles.statCardPressed]} onPress={() => setShowStatsView(true)}>
 <Text style={styles.statLabel}>Stats</Text>
 </Pressable>
 </View>
 </>
 )}
 </View>


 {/* Folders: section with soft separator (no floating card) */}
 {folders.length > 0 && (
 <View style={styles.foldersSection}>
 <TouchableOpacity
 style={styles.foldersSectionHeader}
 onPress={() => setShowFoldersExpanded(!showFoldersExpanded)}
 activeOpacity={0.7}
 >
 <Text style={styles.foldersSectionHeaderText}>Collections</Text>
 {showFoldersExpanded ? <ChevronUpIcon size={20} color={t.colors.primary} style={{ marginLeft: 8 }} /> : <ChevronDownIcon size={20} color={t.colors.primary} style={{ marginLeft: 8 }} />}
 </TouchableOpacity>
 {showFoldersExpanded && (
 <View style={styles.foldersGrid}>
 {folders.map((folder) => {
 const folderBooks = approvedBooksOnly.filter(book =>
 book.id && folder.bookIds.includes(book.id)
 );
 return (
 <TouchableOpacity
 key={folder.id}
 style={styles.folderCard}
 activeOpacity={0.7}
 onPress={() => {
 setSelectedFolder(folder);
 setShowFolderView(true);
 }}
 onLongPress={() => {
 Alert.alert(
 'Delete Collection',
 `Are you sure you want to delete "${folder.name}"? This will not delete the books, they will remain in your library.`,
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Delete',
 style: 'destructive',
 onPress: () => deleteFolder(folder.id),
 },
 ]
 );
 }}
 >
 <View style={styles.folderIcon}>
 <FolderIcon size={32} color={t.colors.primary} />
 </View>
 <Text style={styles.folderName} numberOfLines={1}>
 {folder.name}
 </Text>
 <Text style={styles.folderBookCount}>
 {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
 </Text>
 </TouchableOpacity>
 );
 })}
 </View>
 )}
 </View>
 )}

 {/* My Library: inline section, no card title, count, separator, search, grid; theme bg */}
 <View 
 ref={booksSectionRef} 
 style={styles.booksSection}
 onLayout={(event) => {
 const { y } = event.nativeEvent.layout;
 setBooksSectionY(y);
 }}
 >
 <View style={styles.sectionHeader}>
 <View style={styles.sectionHeaderLeft}>
 <Text style={styles.sectionTitle}>My Library</Text>
 <Text style={styles.sectionSubtitle}>{sortedDisplayedBooks.length} {sortedDisplayedBooks.length === 1 ? 'book' : 'books'}</Text>
 </View>
 </View>

 {/* Library Search Bar */}
 <View ref={searchBarRef} style={styles.librarySearchContainer}>
 <TextInput
 style={styles.librarySearchInput}
 placeholderTextColor={t.colors.textMuted}
 value={librarySearch}
 onChangeText={(text) => {
 setLibrarySearch(text);
 const scrollToLibrarySection = () => {
 if (booksSectionY > 0) {
 searchBarScrollPosition.current = booksSectionY - 10;
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: false });
 }
 };
 scrollToLibrarySection();
 setTimeout(scrollToLibrarySection, 50);
 setTimeout(scrollToLibrarySection, 150);
 setTimeout(scrollToLibrarySection, 300);
 setTimeout(scrollToLibrarySection, 500);
 InteractionManager.runAfterInteractions(() => {
 scrollToLibrarySection();
 setTimeout(scrollToLibrarySection, 100);
 });
 }}
 placeholder="Search by title or author..."
 autoCapitalize="none"
 autoCorrect={false}
 clearButtonMode="never"
 onFocus={() => {
 const scrollToLibrarySection = () => {
 if (booksSectionY > 0) {
 scrollViewRef.current?.scrollTo({ y: booksSectionY - 10, animated: true });
 }
 };
 InteractionManager.runAfterInteractions(() => {
 setTimeout(scrollToLibrarySection, 100);
 setTimeout(scrollToLibrarySection, 300);
 });
 }}
 />
 {librarySearch.length > 0 && (
 <TouchableOpacity
 onPress={() => setLibrarySearch('')}
 style={styles.librarySearchClear}
 hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
 <Text style={styles.librarySearchClearText}>×</Text>
 </TouchableOpacity>
 )}
 </View>

 {displayedBooks.length === 0 ? (
 <View style={styles.emptyState}>
 <View style={styles.emptyStateIcon} />
 <Text style={styles.emptyStateText}>{librarySearch.trim() ? 'No results' : 'Your Library Awaits'}</Text>
 <Text style={styles.emptyStateSubtext}>
 {librarySearch.trim() ? 'Try a different search term' : 'Start scanning to build your collection'}
 </Text>
 </View>
 ) : (
 <FlatList
 key={`books-grid-${gridColumns}`}
 data={sortedDisplayedBooks}
 renderItem={renderBook}
 keyExtractor={(item, index) => item.id || `${item.title}-${item.author || ''}-${index}`}
 extraData={isSelectionMode ? selectedBooks : 0}
 numColumns={gridColumns}
 scrollEnabled={false}
 showsVerticalScrollIndicator={false}
 contentContainerStyle={styles.booksGrid}
 columnWrapperStyle={styles.bookRow}
 initialNumToRender={12}
 maxToRenderPerBatch={8}
 windowSize={7}
 removeClippedSubviews={true}
 />
 )}
 </View>
 </ScrollView>

 {/* Bottom Delete Bar - Appears when books are selected.
     Anchored bottom:tabBarHeight so it sits directly above the native tab bar.
     SafeAreaView with no edges here — tabBarHeight already includes the safe-area
     bottom inset, so we must not double-add it. */}
 {isSelectionMode && selectedBooks.size > 0 && (
 <SafeAreaView style={[styles.bottomDeleteBarContainer, { bottom: tabBarHeight }]} edges={[]}>
 <View style={styles.bottomDeleteBar}>
 <View style={styles.bottomDeleteBarLeft}>
 <Text style={styles.bottomDeleteBarCount}>
 {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'} selected
 </Text>
 </View>
 <View style={styles.bottomDeleteBarRight}>
 <TouchableOpacity
 style={[styles.bottomDeleteBarClearButton, { marginRight: 12 }]}
 onPress={() => setSelectedBooks(new Set())}
 activeOpacity={0.7}
 >
 <Text style={styles.bottomDeleteBarClearText}>Clear</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.bottomDeleteBarDeleteButton}
 onPress={deleteSelectedBooks}
 activeOpacity={0.7}
 >
 <TrashIcon size={20} color={t.colors.textOnDark ?? t.colors.textPrimary} style={{ marginRight: 6 }} />
 <Text style={styles.bottomDeleteBarDeleteText}>Delete</Text>
 </TouchableOpacity>
 </View>
 </View>
 </SafeAreaView>
 )}

 {/* Settings Modal */}
      <SettingsModal
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        onCancelBatch={cancelActiveBatch}
        onDataCleared={() => {
          logger.debug(' Clearing local state after account clear...');
          setBooks([]);
          setPhotos([]);
          setFolders([]);
          setUserProfile(prev => prev ? { ...prev, totalBooks: 0, totalPhotos: 0 } : null);
          refreshProfileStats([]);
          // Do NOT call loadUserData() here — the useFocusEffect will fire
          // when the settings modal closes and the tab regains focus. The
          // recentlyCleared guard (library_cleared_at) ensures it returns
          // empty. Calling it here with a delay caused a race where stale
          // server data repopulated the cleared profile.
        }}
      />

 {/* Photos Modal clean 2-column grid, themed; viewer stacks on top (no flicker) */}
 <Modal
 visible={showPhotos}
 animationType="none"
 transparent={false}
 onRequestClose={() => setShowPhotos(false)}
 >
 <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
 <View style={[styles.photosModalHeader, { backgroundColor: t.colors.headerBg ?? t.colors.headerBackground, paddingTop: insets.top }]}>
 <TouchableOpacity
 style={[styles.photosHeaderBackButton, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}
 onPress={() => setShowPhotos(false)}
 activeOpacity={0.7}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <ChevronBackIcon size={18} color={t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text} style={{ marginRight: 4 }} />
 <Text style={[styles.photosHeaderBackText, { color: t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text }]}>Back</Text>
 </TouchableOpacity>
 <Text style={[styles.photosModalTitle, { color: t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text }]}>My Photos</Text>
 <View style={styles.photosHeaderSpacer} />
 </View>

 {photosToShowInLibrary.length === 0 ? (
 <View style={styles.emptyState}>
 {(() => {
   const hasActiveScan = (activeScanJobIds?.length ?? 0) > 0;
   const hasPhotosNoApproved = photos.length > 0 && approvedBooksOnly.length === 0;
   const hasApprovedNoPhotosWithBooks = approvedBooksOnly.length > 0;
   const emptyTitle = hasActiveScan
     ? 'Processing'
     : hasPhotosNoApproved
       ? 'Approve books to see photos'
       : hasApprovedNoPhotosWithBooks
         ? 'No photos with approved books yet'
         : 'No Photos Yet';
   const emptySubtext = hasActiveScan
     ? 'Scan results will appear here when ready'
     : hasPhotosNoApproved
       ? 'Approve books from your scans to link them to photos'
       : hasApprovedNoPhotosWithBooks
         ? 'Photos that have approved books attached will appear here'
         : 'Photos with books in your library will appear here';
   return (
     <>
       <Text style={[styles.emptyStateText, { color: t.colors.textPrimary ?? t.colors.text }]}>{emptyTitle}</Text>
       <Text style={[styles.emptyStateSubtext, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>{emptySubtext}</Text>
     </>
   );
 })()}
 </View>
 ) : (
 <FlatList
 key={`photos-grid-${photoColumns}`}
 data={photosToShowInLibrary}
 keyExtractor={(item, index) => canonicalPhotoListKey(item) || `ph_${index}`}
 numColumns={photoColumns}
 contentContainerStyle={styles.photosGridContent}
 columnWrapperStyle={styles.photosGridRow}
 initialNumToRender={8}
 maxToRenderPerBatch={6}
 windowSize={6}
 removeClippedSubviews={true}
 renderItem={({ item: photo, index: photoIndex }) => {
 const key = toPhotoKey(photo.id ?? '', photoIdAliasRef.current);
 const booksForPhoto = key ? (approvedBooksByPhotoId.get(key) ?? []) : [];
 const bookCount = booksForPhoto.length;
 return (
 <TouchableOpacity
 style={styles.photosGridItem}
 onPress={() => {
 if (deleteGuard) { setDeleteGuard(false); return; }
 const nextPhoto = photo;
 setShowPhotos(false);
 requestAnimationFrame(() => {
 InteractionManager.runAfterInteractions(() => {
 (navigation as any).push('PhotoDetail', { photoId: nextPhoto.id, photo: nextPhoto });
 });
 });
 }}
 activeOpacity={0.9}
 >
 <View style={styles.photosGridTile}>
 <PhotoTile photoId={photo.id} localUri={(photo as { local_uri?: string }).local_uri ?? (photo.uri?.startsWith?.('file://') ? photo.uri : null)} storagePath={photo.storage_path} fallbackUri={photo.uri} thumbnailUri={photo.thumbnail_uri ?? photo.uri ?? null} signedUrl={photo.signed_url} signedUrlExpiresAt={photo.signed_url_expires_at} status={photo.status} style={[StyleSheet.absoluteFill as any]} contentFit="cover" />
 <TouchableOpacity
 style={styles.photoDeleteButton}
onPressIn={() => setDeleteGuard(true)}
onPress={() => {
  photoDeleteIntentRef.current = createDeleteIntent('user_delete_photo', 'MyLibraryTab');
  setDeleteConfirmPhoto(photo);
}}
 activeOpacity={0.7}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <Text style={styles.photoDeleteButtonText}>×</Text>
 </TouchableOpacity>
 <View style={styles.photosGridOverlay}>
 <Text style={styles.photosGridOverlayDate} numberOfLines={1}>
 {new Date(photo.timestamp).toLocaleDateString()}
 </Text>
 {photo.caption ? (
 <Text style={styles.photosGridOverlayCaption} numberOfLines={1}>{photo.caption}</Text>
 ) : null}
 {(photo.status === 'draft' || (photo as any).status === 'stalled') && (bookCount === undefined || bookCount === 0) ? (
  <View style={styles.photosGridOverlayScanningRow}>
    <ActivityIndicator size="small" color="rgba(255,255,255,0.9)" />
    <Text style={styles.photosGridOverlayBooks}>Scanning…</Text>
  </View>
) : ((photo as any).status === 'complete' || (photo as any).status === 'local_pending') && (bookCount === undefined || bookCount === 0) ? (
  <Text style={styles.photosGridOverlayBooks}>Processing results…</Text>
) : (
  <Text style={styles.photosGridOverlayBooks}>
    {bookCount === undefined ? '—' : `${bookCount} book${bookCount !== 1 ? 's' : ''}`}
  </Text>
)}
 </View>
 </View>
 </TouchableOpacity>
 );
 }}
 />
 )}

 {failedOrProcessingPhotos.length > 0 ? (
 <View style={styles.photosSection}>
 <Text style={[styles.photosSectionHeader, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>Failed / Processing</Text>
 <FlatList
 key={`photos-failed-${photoColumns}`}
 data={failedOrProcessingPhotos}
 keyExtractor={(item, index) => item.id ?? `failed_ph_${index}`}
 numColumns={photoColumns}
 scrollEnabled={false}
 contentContainerStyle={styles.photosGridContent}
 columnWrapperStyle={styles.photosGridRow}
 initialNumToRender={6}
 renderItem={({ item: photo }) => (
 <View style={styles.photosGridItem}>
 <PhotoTile photoId={photo.id} localUri={(photo as { local_uri?: string }).local_uri ?? (photo.uri?.startsWith?.('file://') ? photo.uri : null)} storagePath={photo.storage_path} fallbackUri={photo.uri} thumbnailUri={photo.thumbnail_uri ?? photo.uri ?? null} signedUrl={photo.signed_url} signedUrlExpiresAt={photo.signed_url_expires_at} status={photo.status} style={[StyleSheet.absoluteFill as any]} contentFit="cover" />
 <View style={styles.photosGridOverlay}>
 <Text style={styles.photosGridOverlayDate} numberOfLines={1}>{new Date(photo.timestamp).toLocaleDateString()}</Text>
 {(photo.status === 'draft' || photo.status === 'stalled') ? (
 <View style={styles.photosGridOverlayScanningRow}>
 <ActivityIndicator size="small" color="rgba(255,255,255,0.9)" />
 <Text style={styles.photosGridOverlayBooks}>Scanning…</Text>
 </View>
 ) : (photo as any).status === 'scan_failed' ? (
 <Text style={styles.photosGridOverlayBooks}>Scan failed</Text>
 ) : (
 <Text style={styles.photosGridOverlayBooks}>No books</Text>
 )}
 </View>
 </View>
 )}
 />
 </View>
 ) : null}

    {/* Inline Delete Confirmation Overlay (renders over Photos screen) */}
        {deleteConfirmPhoto && (() => {
          const photoId = deleteConfirmPhoto.id;
          const imageHash = typeof deleteConfirmPhoto.photoFingerprint === 'string' && deleteConfirmPhoto.photoFingerprint.trim() ? deleteConfirmPhoto.photoFingerprint.trim() : undefined;
          const canonicalKey = toPhotoKey(photoId ?? '', photoIdAliasRef.current);
          const linkedBooks = canonicalKey ? (books ?? []).filter(b => toPhotoKey(getBookSourcePhotoId(b), photoIdAliasRef.current) === canonicalKey) : [];
          const hasBooks = linkedBooks.length > 0;
          const bookLabel = linkedBooks.length === 1 ? 'book' : 'books';

          const doDeletePhoto = async (cascadeBooks: boolean) => {
            if (!user || !deleteConfirmPhoto) return;
            // Confirm and validate the delete intent created when the "×" button was tapped.
            const _intent = photoDeleteIntentRef.current ?? createDeleteIntent(cascadeBooks ? 'user_delete_photo_cascade' : 'user_delete_photo', 'MyLibraryTab');
            _intent.reason = cascadeBooks ? 'user_delete_photo_cascade' : 'user_delete_photo';
            _intent.userConfirmed = true;
            if (!assertDeleteAllowed(_intent)) return;
            logDeleteAudit(_intent, { photoIds: [photoId], bookCount: linkedBooks.length, cascadeBooks, userId: user.uid });
            const prevPhotos = photos;
            const prevBooks = books;
            const updatedPhotos = prevPhotos.filter(p => p.id !== photoId);
            // Optimistic local update depends on cascade choice
            const updatedBooks = cascadeBooks
              ? prevBooks.filter(b => getBookSourcePhotoId(b) !== photoId)
              : prevBooks.map(b => getBookSourcePhotoId(b) === photoId ? { ...b, source_photo_id: undefined, photoId: undefined } : b);
            const removedBookIds = cascadeBooks
              ? prevBooks.filter(b => b.source_photo_id === photoId).map(b => b.id).filter((id): id is string => !!id)
              : [];
            setPhotos(dedupBy(updatedPhotos, photoStableKey));
            setBooks(updatedBooks);
            if (editingPhoto && editingPhoto.id === photoId) {
              setEditingPhoto(null);
              setPhotoCaption('');
            }
            setDeleteConfirmPhoto(null);
            logger.info('[DELETE_PHOTO_LOCAL_APPLY]', {
              photoId, cascadeBooks,
              removedBooks: removedBookIds.length,
              approvedBefore: prevBooks.length,
              approvedAfter: updatedBooks.length,
              photosBefore: prevPhotos.length,
              photosAfter: updatedPhotos.length,
            });
            try {
              const result = await deleteLibraryPhotoAndBooks(user.uid, photoId, cascadeBooks, true, imageHash, 'MyLibraryTab', linkedBooks.length);
              if (result.ok) {
                if (cascadeBooks) await addDeletedBookIdsTombstone(user.uid, removedBookIds);
                const userApprovedKey = `approved_books_${user.uid}`;
                const userPhotosKey = `photos_${user.uid}`;
                await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
                refreshProfileStats();
                if (__DEV__) {
                  logger.debug('[DELETE_PHOTO] success', { photoId, cascadeBooks, booksDeleted: result.booksDeleted, booksDetached: result.booksDetached, photoDeleted: result.photoDeleted });
                }
              } else {
                const errMsg = result.error ?? 'Delete failed';
                logger.warn('[DELETE_PHOTO] failed', { photoId, error: errMsg });
                const isNotFound = /not found|photo_not_found|404/i.test(errMsg);
                if (!isNotFound) {
                  setPhotos(dedupBy(prevPhotos, photoStableKey));
                  setBooks(prevBooks);
                  Alert.alert('Delete failed', errMsg);
                } else {
                  if (cascadeBooks) await addDeletedBookIdsTombstone(user.uid, removedBookIds);
                  await AsyncStorage.setItem(`approved_books_${user.uid}`, JSON.stringify(updatedBooks));
                  await AsyncStorage.setItem(`photos_${user.uid}`, JSON.stringify(updatedPhotos));
                }
              }
            } catch (error) {
              setPhotos(dedupBy(prevPhotos, photoStableKey));
              setBooks(prevBooks);
              const errMsg = error instanceof Error ? error.message : String(error);
              logger.error('[DELETE_PHOTO] error', { photoId, error: errMsg });
              Alert.alert('Delete failed', errMsg);
            }
          };

          return (
            <View style={styles.confirmModalOverlay}>
              <View style={styles.confirmModalContent}>
                <Text style={styles.confirmModalTitle}>Delete Photo</Text>
                <Text style={styles.confirmModalMessage}>
                  {hasBooks
                    ? `This photo has ${linkedBooks.length} ${bookLabel} in your library. Choose what to delete.`
                    : 'Remove this photo from your library?'}
                </Text>
                <View style={styles.confirmModalButtons}>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalButtonCancel, { marginRight: 12 }]}
                    onPress={() => setDeleteConfirmPhoto(null)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.confirmModalButtonCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalButtonDelete]}
                    onPress={() => doDeletePhoto(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.confirmModalButtonDeleteText}>
                      {hasBooks ? 'Photo Only' : 'Delete'}
                    </Text>
                  </TouchableOpacity>
                  {hasBooks && (
                    <TouchableOpacity
                      style={[styles.confirmModalButton, styles.confirmModalButtonDelete, { marginLeft: 8 }]}
                      onPress={() => doDeletePhoto(true)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.confirmModalButtonDeleteText}>Photo + {bookLabel}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          );
        })()}
 </SafeAreaView>
 </Modal>

 

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
 }}
 >
 <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
 <View style={[styles.folderViewHeader, { paddingTop: insets.top + 5 }]}>
 <TouchableOpacity
 style={styles.folderViewBackButton}
 onPress={() => {
 setShowFolderView(false);
 setSelectedFolder(null);
 setIsFolderSelectionMode(false);
 setSelectedFolderBooks(new Set());
 setFolderSearchQuery('');
 }}
 activeOpacity={0.7}
 hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
 >
 <ArrowBackIcon size={24} color={t.colors.textOnDark ?? t.colors.textPrimary} />
 </TouchableOpacity>
 <Text style={styles.folderViewHeaderTitle}>
 {selectedFolder?.name || 'Collection'}
 </Text>
 <View style={styles.folderViewHeaderRight}>
 {selectedFolder && (
 <TouchableOpacity
 style={styles.folderViewDeleteButton}
 onPress={() => deleteFolder(selectedFolder.id)}
 activeOpacity={0.7}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <TrashIcon size={22} color={t.colors.textOnDark ?? t.colors.textPrimary} />
 </TouchableOpacity>
 )}
 </View>
 </View>

 {selectedFolder && (
 <ScrollView style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 20 }}>
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
 style={styles.librarySearchClear}
 hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
 <Text style={styles.librarySearchClearText}>×</Text>
 </TouchableOpacity>
 )}
 </View>

 {/* Select Button */}
 <View style={styles.folderSelectButtonContainer}>
 <TouchableOpacity
 style={styles.selectButton}
 onPress={() => {
 setIsFolderSelectionMode(!isFolderSelectionMode);
 if (isFolderSelectionMode) {
 setSelectedFolderBooks(new Set());
 }
 }}
 activeOpacity={0.7}
 >
 <Text style={styles.selectButtonText}>
 {isFolderSelectionMode ? 'Cancel' : 'Select'}
 </Text>
 </TouchableOpacity>
 </View>

 {/* Selection Mode Indicator */}
 {isFolderSelectionMode && selectedFolderBooks.size > 0 && (
 <View style={styles.selectionBar}>
 <Text style={styles.selectionCount}>
 {selectedFolderBooks.size} {selectedFolderBooks.size === 1 ? 'book' : 'books'} selected
 </Text>
 <View style={{ flexDirection: 'row', gap: 8 }}>
 <TouchableOpacity
 style={styles.clearSelectionButton}
 onPress={() => setSelectedFolderBooks(new Set())}
 activeOpacity={0.7}
 >
 <Text style={styles.clearSelectionText}>Cancel</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={styles.removeFromFolderButton}
 onPress={async () => {
 if (!selectedFolder || !user || selectedFolderBooks.size === 0) return;
 
 const bookCount = selectedFolderBooks.size;
 Alert.alert(
 'Remove from Collection',
 `Remove ${bookCount} book${bookCount === 1 ? '' : 's'} from "${selectedFolder.name}"? The books will remain in your library.`,
 [
 { text: 'Cancel', style: 'cancel' },
 {
 text: 'Remove',
 style: 'destructive',
 onPress: async () => {
 try {
 // Remove selected books from folder
 const updatedBookIds = selectedFolder.bookIds.filter(
 bookId => !selectedFolderBooks.has(bookId)
 );
 
 // Update folder
 const updatedFolder = {
 ...selectedFolder,
 bookIds: updatedBookIds,
 };
 
 // Update folders array
 const updatedFolders = folders.map(f =>
 f.id === selectedFolder.id ? updatedFolder : f
 );
 setFolders(updatedFolders);
 
 // Save to AsyncStorage
 const foldersKey = `folders_${user.uid}`;
 await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
 
 // Clear selection
 setSelectedFolderBooks(new Set());
 setIsFolderSelectionMode(false);
 
 // Update selectedFolder if it's still being viewed
 setSelectedFolder(updatedFolder);
 
 Alert.alert('Success', `${bookCount} book${bookCount === 1 ? '' : 's'} removed from collection.`);
 } catch (error) {
 logger.error('Error removing books from folder:', error);
 Alert.alert('Error', 'Failed to remove books from collection. Please try again.');
 }
 },
 },
 ]
 );
 }}
 activeOpacity={0.7}
 >
 <Text style={styles.removeFromFolderButtonText}>Remove</Text>
 </TouchableOpacity>
 </View>
 </View>
 )}

 {(() => {
 const folderPhotoIds = selectedFolder.photoIds || [];
 const folderPhotos = photos.filter(photo => folderPhotoIds.includes(photo.id));
 let folderBooks = approvedBooksOnly.filter(book =>
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
 
 // Show Photos section if there are photos
 if (folderPhotos.length > 0) {
 return (
 <>
 <View style={styles.booksSection}>
 <View style={styles.sectionHeader}>
 <Text style={styles.sectionTitle}>Photos</Text>
 <Text style={styles.sectionSubtitle}>{folderPhotos.length} {folderPhotos.length === 1 ? 'photo' : 'photos'}</Text>
 </View>
 {((): React.ReactNode => {
 const byCanonical = dedupBy(folderPhotos, canonicalPhotoListKey);
 return byCanonical.map((photo, photoIndex) => (
 <View key={canonicalPhotoListKey(photo) || `ph_${photoIndex}`} style={styles.photoCard}>
 <PhotoTile photoId={photo.id} localUri={(photo as { local_uri?: string }).local_uri ?? (photo.uri?.startsWith?.('file://') ? photo.uri : null)} storagePath={photo.storage_path} fallbackUri={photo.uri} thumbnailUri={photo.thumbnail_uri ?? photo.uri ?? null} signedUrl={photo.signed_url} signedUrlExpiresAt={photo.signed_url_expires_at} status={photo.status} style={styles.photoImage} contentFit="cover" />
 <View style={styles.photoInfo}>
 <Text style={styles.photoDate}>
 {new Date(photo.timestamp).toLocaleDateString()}
 </Text>
 {photo.caption && (
 <Text style={styles.photoCaption}>{photo.caption}</Text>
 )}
 <Text style={styles.photoBooksCount}>
 {(() => {
 const key = toPhotoKey(photo.id ?? '', photoIdAliasRef.current);
 const booksForPhoto = approvedBooksByPhotoId.get(key) ?? [];
 const n = booksForPhoto.length;
 return `${n} ${n === 1 ? 'book' : 'books'}`;
 })()}
 </Text>
 </View>
 </View>
 ));
 })()}
 </View>
 
 {folderBooks.length > 0 && (
 <View style={styles.booksSection}>
 <View style={styles.sectionHeader}>
 <Text style={styles.sectionTitle}>
 Books ({folderBooks.length})
 </Text>
 </View>
 <FlatList
 key={`folder-books-with-photos-${gridColumns}`}
 data={folderBooks}
 renderItem={renderFolderBook}
 keyExtractor={(item, index) => item.id || `${item.title}-${item.author || ''}-${index}`}
 numColumns={gridColumns}
 scrollEnabled={false}
 showsVerticalScrollIndicator={false}
 contentContainerStyle={styles.booksGrid}
 columnWrapperStyle={styles.bookRow}
 initialNumToRender={12}
 maxToRenderPerBatch={8}
 windowSize={7}
 removeClippedSubviews={true}
 />
 </View>
 )}
 </>
 );
 }
 
 // No photos, just show books (or empty state)
 if (folderBooks.length === 0) {
 return (
 <View style={styles.emptyState}>
 <Text style={styles.emptyStateText}>No Books in Folder</Text>
 <Text style={styles.emptyStateSubtext}>Books you add to this folder will appear here</Text>
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
 key={`folder-books-${gridColumns}`}
 data={folderBooks}
 renderItem={renderFolderBook}
 keyExtractor={(item, index) => item.id || `${item.title}-${item.author || ''}-${index}`}
 numColumns={gridColumns}
 scrollEnabled={false}
 showsVerticalScrollIndicator={false}
 contentContainerStyle={styles.booksGrid}
 columnWrapperStyle={styles.bookRow}
 initialNumToRender={12}
 maxToRenderPerBatch={8}
 windowSize={7}
 removeClippedSubviews={true}
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
 setSelectedPhoto(null);
 }}
 onRequireAuth={() => setShowAuthGateModal(true)}
 onRequestSync={loadUserData}
 onRemove={async () => {
 // Immediately update local state to remove the book
 if (selectedBook) {
 setBooks(prev => prev.filter(b => {
 // Match by ID if both have IDs
 if (selectedBook.id && b.id && selectedBook.id === b.id) return false;
 // Match by title and author
 if (b.title === selectedBook.title && b.author === selectedBook.author) return false;
 return true;
 }));
 }
 // Then reload from Supabase to ensure sync
 await loadUserData();
 }}
 onBookUpdate={(updatedBook) => {
 // Update the book in state when description/stats are fetched
 setBooks(prev => prev.map(b => 
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 ));
 setSelectedBook(updatedBook); // Update the selected book too
 }}
 onEditBook={async (updatedBook) => {
 // Update book when cover is changed
 if (!user) return;
 try {
 // Update local state immediately
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.map(b => 
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 );
 setBooks(prev => dedupeBooks([...prev, ...updatedBooks]));
 setSelectedBook(updatedBook);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 
 // Reload from Supabase to ensure all views are updated
 setTimeout(() => {
 loadUserData();
 }, 500);
 } catch (error) {
 logger.error('Error updating book:', error);
 }
 }}
 />
 </SafeAreaView>
 </Modal>

 {/* Folder Selection Modal for Photos */}
 <Modal
 visible={showFolderSelectModal}
 animationType="fade"
 transparent={false}
 onRequestClose={() => {
 setShowFolderSelectModal(false);
 setPhotoToAddToFolder(null);
 setNewFolderName('');
 }}
 >
 <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
 <LinearGradient
 colors={[t.colors.bg, t.colors.surface2 ?? t.colors.bg]}
 style={{ height: insets.top }}
 start={{ x: 0, y: 0 }}
 end={{ x: 0, y: 1 }}
 />
 <View style={styles.modalHeader}>
 <TouchableOpacity
 style={styles.modalBackButton}
 onPress={() => {
 setShowFolderSelectModal(false);
 setPhotoToAddToFolder(null);
 setNewFolderName('');
 }}
 activeOpacity={0.7}
 hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
 >
 <Text style={styles.modalBackButtonLabel}>Cancel</Text>
 </TouchableOpacity>
 <Text style={styles.modalHeaderTitle}>Add Photo to Folder</Text>
 <View style={styles.modalHeaderSpacer} />
 </View>

 <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
 {/* Create Folder Section - Always visible */}
 <View style={styles.createFolderSection}>
 <Text style={styles.createFolderTitle}>Create New Folder</Text>
 <View style={styles.createFolderRow}>
 <TextInput
 style={styles.createFolderInput}
 value={newFolderName}
 onChangeText={setNewFolderName}
 placeholder="Collection name..."
 autoCapitalize="words"
 autoFocus={folders.length === 0}
 />
 <TouchableOpacity
 style={[styles.createFolderButton, !newFolderName.trim() && styles.createFolderButtonDisabled]}
 onPress={createFolder}
 activeOpacity={0.8}
 disabled={!newFolderName.trim()}
 >
 <Text style={styles.createFolderButtonText}>Create</Text>
 </TouchableOpacity>
 </View>
 </View>

 {/* Existing Folders */}
 {folders.length > 0 && (
 <View style={styles.existingFoldersSection}>
 <Text style={styles.existingFoldersTitle}>Select Folder</Text>
 {folders.map((folder) => (
 <TouchableOpacity
 key={folder.id}
 style={styles.folderItem}
 onPress={async () => {
 if (photoToAddToFolder) {
 await addPhotoToFolder(photoToAddToFolder, folder.id);
 setShowFolderSelectModal(false);
 setPhotoToAddToFolder(null);
 setNewFolderName('');
 Alert.alert('Success', `Photo added to "${folder.name}"`);
 }
 }}
 activeOpacity={0.7}
 >
 <FolderIcon size={24} color={t.colors.primary} style={{ marginRight: 12 }} />
 <View style={{ flex: 1 }}>
 <Text style={styles.folderItemName}>{folder.name}</Text>
 <Text style={styles.folderItemCount}>
 {(folder.photoIds || []).length} {(folder.photoIds || []).length === 1 ? 'photo' : 'photos'} {folder.bookIds.length} {folder.bookIds.length === 1 ? 'book' : 'books'}
 </Text>
 </View>
 <ChevronForwardIcon size={20} color={t.colors.icon ?? t.colors.textMuted} />
 </TouchableOpacity>
 ))}
 </View>
 )}
 </ScrollView>
 </SafeAreaView>
 </Modal>

 {/* Library View Modal */}
 <Modal
 visible={showLibraryView}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => setShowLibraryView(false)}
 >
 <LibraryView onClose={() => setShowLibraryView(false)} />
 </Modal>

 {/* Authors View Modal themed; EntityRowCard list; navigate to AuthorDetailsScreen on tap */}
 <Modal
 visible={showAuthorsView}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => { setSelectedAuthor(null); setAuthorsSortDropdownOpen(false); setAuthorsSearchQuery(''); setShowAuthorsView(false); }}
 >
 <SafeAreaView style={[styles.safeContainer, { backgroundColor: t.colors.bg ?? t.colors.backgroundPrimary }]} edges={['left','right']}>
 {selectedAuthor ? (
 <>
 <View style={[styles.authorDetailsHeader, { backgroundColor: t.colors.headerBg ?? t.colors.headerBackground, paddingTop: insets.top + 8 }]}>
 <TouchableOpacity onPress={() => setSelectedAuthor(null)} style={{ flexDirection: 'row', alignItems: 'center', padding: 12, marginLeft: 8 }} activeOpacity={0.8} hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}>
 <ChevronBackIcon size={24} color={t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text} style={{ marginRight: 4 }} />
 <Text style={[styles.authorDetailsBackLabel, { color: t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text }]}>Back</Text>
 </TouchableOpacity>
 <Text style={[styles.authorDetailsTitle, { color: t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text }]} numberOfLines={1}>{selectedAuthor.name}</Text>
 <View style={{ width: 80 }} />
 </View>
 <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
 <Text style={[styles.authorDetailsBooksLabel, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>{selectedAuthor.books.length} {selectedAuthor.books.length === 1 ? 'book' : 'books'}</Text>
 <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topAuthorBooksRow} nestedScrollEnabled>
 {selectedAuthor.books.map((book) => {
 const coverUri = getBookCoverUri(book);
 return (
 <TouchableOpacity
 key={book.id ?? book.book_key ?? `${book.title}-${book.author}`}
 style={styles.topAuthorBookCard}
 onPress={() => { setSelectedBook(book); setShowBookDetail(true); }}
 activeOpacity={0.8}
 hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
 {coverUri ? (
 <Image source={{ uri: coverUri }} style={styles.topAuthorBookCover} resizeMode="cover" />
 ) : (
 <View style={[styles.topAuthorBookCover, styles.topAuthorBookCoverPlaceholder, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}>
 <Text style={[styles.topAuthorBookPlaceholderText, { color: t.colors.textMuted }]} numberOfLines={2}>{book.title || 'No title'}</Text>
 </View>
 )}
 <Text style={[styles.topAuthorBookTitle, { color: t.colors.textPrimary ?? t.colors.text }]} numberOfLines={2}>{book.title || 'No title'}</Text>
 </TouchableOpacity>
 );
 })}
 </ScrollView>
 </ScrollView>
 </>
 ) : (
 <>
 <View style={[styles.authorViewHeader, { backgroundColor: t.colors.headerBg ?? t.colors.headerBackground, paddingTop: insets.top + 8 }, authorsSortDropdownOpen && { zIndex: 2 }]}>
 <TouchableOpacity
 onPress={() => { setAuthorsSortDropdownOpen(false); setAuthorsSearchQuery(''); setShowAuthorsView(false); }}
 style={{ padding: 12, marginLeft: 8 }}
 activeOpacity={0.8}
 hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
 >
 <ArrowBackIcon size={24} color={t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text} />
 </TouchableOpacity>
 <Text style={[styles.authorViewHeaderTitle, { color: t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text }]}>Authors</Text>
 <View style={styles.authorViewSortWrap}>
 <TouchableOpacity
 onPress={() => setAuthorsSortDropdownOpen(prev => !prev)}
 style={[styles.authorViewSortButton, { borderColor: t.colors.border }]}
 activeOpacity={0.8}
 >
 <Text style={[styles.authorViewSortLabel, { color: t.colors.textSecondary ?? t.colors.text }]}>Sort</Text>
 {authorsSortDropdownOpen ? <ChevronUpIcon size={16} color={t.colors.textSecondary ?? t.colors.text} style={{ marginLeft: 4 }} /> : <ChevronDownIcon size={16} color={t.colors.textSecondary ?? t.colors.text} style={{ marginLeft: 4 }} />}
 </TouchableOpacity>
 {authorsSortDropdownOpen && (
 <View style={[styles.authorViewSortDropdown, { backgroundColor: t.colors.surface, borderColor: t.colors.border }]}>
 <TouchableOpacity
 style={[styles.authorViewSortOption, authorsSortBy === 'name' && { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}
 onPress={() => { setAuthorsSortBy('name'); setAuthorsSortDropdownOpen(false); }}
 activeOpacity={0.7}
 >
 <Text style={[styles.authorViewSortOptionText, { color: t.colors.textPrimary ?? t.colors.text }, authorsSortBy === 'name' && { fontWeight: '600', color: t.colors.primary }]}>Last name</Text>
 {authorsSortBy === 'name' && <CheckmarkIcon size={18} color={t.colors.primary} />}
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.authorViewSortOption, authorsSortBy === 'count' && { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}
 onPress={() => { setAuthorsSortBy('count'); setAuthorsSortDropdownOpen(false); }}
 activeOpacity={0.7}
 >
 <Text style={[styles.authorViewSortOptionText, { color: t.colors.textPrimary ?? t.colors.text }, authorsSortBy === 'count' && { fontWeight: '600', color: t.colors.primary }]}>Amount of books</Text>
 {authorsSortBy === 'count' && <CheckmarkIcon size={18} color={t.colors.primary} />}
 </TouchableOpacity>
 </View>
 )}
 </View>
 </View>
 {authorsSortDropdownOpen && (
 <Pressable style={[StyleSheet.absoluteFillObject, { top: insets.top + 8 + 52, zIndex: 1 }]} onPress={() => setAuthorsSortDropdownOpen(false)} />
 )}
 <View style={[styles.authorsSearchWrap, { backgroundColor: t.colors.inputBg ?? t.colors.surface2 ?? t.colors.surface, borderColor: t.colors.inputBorder ?? t.colors.border }]}>
 <SearchIcon size={18} color={t.colors.textMuted} style={styles.authorsSearchIcon} />
 <TextInput
 style={[styles.authorsSearchInput, { color: t.colors.textPrimary ?? t.colors.text }]}
 value={authorsSearchQuery}
 onChangeText={setAuthorsSearchQuery}
 placeholder="Search authors..."
 placeholderTextColor={t.colors.textMuted}
 autoCapitalize="none"
 autoCorrect={false}
 />
 {authorsSearchQuery.length > 0 && (
 <TouchableOpacity onPress={() => setAuthorsSearchQuery('')} style={styles.authorsSearchClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
 <CloseCircleIcon size={20} color={t.colors.textMuted} />
 </TouchableOpacity>
 )}
 </View>
 <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
 {topAuthorsByCount.length > 0 && authorsFilteredForView.length > 0 && authorsSearchQuery.trim() === '' && (
 <View style={{ marginBottom: 16 }}>
 <Text style={[styles.topAuthorsSectionTitle, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>Top authors</Text>
 <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topAuthorsChipsRow}>
 {topAuthorsByCount.map(({ name, count }) => (
 <TouchableOpacity
 key={name}
 style={[styles.topAuthorChip, { backgroundColor: t.colors.surface, borderColor: t.colors.border }]}
 onPress={() => setSelectedAuthor({ name, books: authorsWithBooks.find(a => a.name === name)?.books ?? [] })}
 activeOpacity={0.8}
 >
 <Text style={[styles.topAuthorChipName, { color: t.colors.textPrimary ?? t.colors.text }]} numberOfLines={1}>{name}</Text>
 <Text style={[styles.topAuthorChipCount, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>{count} {count === 1 ? 'book' : 'books'}</Text>
 </TouchableOpacity>
 ))}
 </ScrollView>
 </View>
 )}
 {authorsFilteredForView.length > 0 ? (
 authorsFilteredForView.map(({ name, books: authorBooks, count }) => (
 <EntityRowCard
 key={name}
 title={name}
 subtext={`${count} ${count === 1 ? 'book' : 'books'}`}
 coverUris={authorBooks.slice(0, 3).map(b => getBookCoverUri(b))}
 onPress={() => setSelectedAuthor({ name, books: authorBooks })}
 />
 ))
 ) : (
 <View style={styles.authorsEmptyState}>
 <Text style={[styles.authorsEmptyTitle, { color: t.colors.textPrimary ?? t.colors.text }]}>
 {authorsSortedForView.length === 0 ? 'No authors yet' : 'No authors found'}
 </Text>
 <Text style={[styles.authorsEmptySubtext, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>
 {authorsSortedForView.length === 0 ? 'Authors appear when you add books to your library.' : 'Try a different search.'}
 </Text>
 </View>
 )}
 </ScrollView>
 </>
 )}
 {/* Book detail inside Authors modal so it opens on top when tapping a book */}
 <BookDetailModal
 visible={showBookDetail && showAuthorsView}
 book={selectedBook}
 photo={selectedPhoto}
 onClose={() => {
 setShowBookDetail(false);
 setSelectedBook(null);
 setSelectedPhoto(null);
 }}
 onRequireAuth={() => setShowAuthGateModal(true)}
 onRequestSync={loadUserData}
 onRemove={async () => {
 if (selectedBook) {
 setBooks(prev => prev.filter(b => {
 if (selectedBook.id && b.id && selectedBook.id === b.id) return false;
 if (b.title === selectedBook.title && b.author === selectedBook.author) return false;
 return true;
 }));
 }
 await loadUserData();
 }}
 onBookUpdate={(updatedBook) => {
 setBooks(prev => prev.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 ));
 setSelectedBook(updatedBook);
 }}
 onEditBook={async (updatedBook) => {
 if (!user) return;
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 );
 setBooks(prev => dedupeBooks([...prev, ...updatedBooks]));
 setSelectedBook(updatedBook);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 setTimeout(() => loadUserData(), 500);
 } catch (error) {
 logger.error('Error updating book:', error);
 }
 }}
 />
 </SafeAreaView>
 </Modal>

 <AuthGateModal
 visible={showAuthGateModal}
 onClose={() => setShowAuthGateModal(false)}
 onSignIn={() => setShowAuthGateModal(false)}
 onCreateAccount={() => setShowAuthGateModal(false)}
 />

 {/* Stats View Modal */}
 <Modal
 visible={showStatsView}
 animationType="slide"
 presentationStyle="fullScreen"
 onRequestClose={() => setShowStatsView(false)}
 >
 <SafeAreaView style={styles.safeContainer} edges={['left', 'right', 'bottom']}>
 <AppHeader title="Stats" onBack={() => setShowStatsView(false)} />
 <ScrollView style={{ flex: 1, backgroundColor: t.colors.bg }} contentContainerStyle={styles.statsScrollContent}>
 <Text style={styles.statsComingSoon}>Coming soon</Text>
 </ScrollView>
 </SafeAreaView>
 </Modal>

 {/* Book Detail Modal - for library/folder; Authors has its own instance inside Authors modal */}
 <BookDetailModal
 visible={showBookDetail && !showAuthorsView}
 book={selectedBook}
 photo={selectedPhoto}
 onClose={() => {
 setShowBookDetail(false);
 setSelectedBook(null);
 setSelectedPhoto(null);
 }}
 onRequireAuth={() => setShowAuthGateModal(true)}
 onRequestSync={loadUserData}
 onRemove={async () => {
 if (selectedBook) {
 setBooks(prev => prev.filter(b => {
 if (selectedBook.id && b.id && selectedBook.id === b.id) return false;
 if (b.title === selectedBook.title && b.author === selectedBook.author) return false;
 return true;
 }));
 }
 await loadUserData();
 }}
 onBookUpdate={(updatedBook) => {
 setBooks(prev => prev.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 ));
 setSelectedBook(updatedBook);
 }}
 onEditBook={async (updatedBook) => {
 if (!user) return;
 try {
 const userApprovedKey = `approved_books_${user.uid}`;
 const updatedBooks = books.map(b =>
 b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
 ? updatedBook
 : b
 );
 setBooks(prev => dedupeBooks([...prev, ...updatedBooks]));
 setSelectedBook(updatedBook);
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
 setTimeout(() => loadUserData(), 500);
 } catch (error) {
 logger.error('Error updating book:', error);
 }
 }}
 />

 </SafeAreaView>
 );
};

const getStyles = (
 screenWidth: number,
 t: ThemeTokens,
 gridColumns: number,
 photoColumns: number,
 typeScale: number
) => StyleSheet.create({
 safeContainer: {
 flex: 1,
 backgroundColor: t.colors.screenBackground,
 position: 'relative',
 },
 container: {
 flex: 1,
 },
 // One pane: profile section on page bg with soft separator (no dark header, no floating card)
 profileSection: {
 paddingTop: 12,
 paddingBottom: 16,
 paddingHorizontal: 20,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.separator ?? t.colors.border,
 },
 profileHeroHeader: {
 height: LOCKED_PROFILE_HEADER.height,
 marginBottom: LOCKED_PROFILE_HEADER.marginBottom,
 overflow: 'hidden',
 width: '100%',
 },
 profileHeroOverlay: {
 ...StyleSheet.absoluteFillObject,
 },
 headerBlank: {
 ...StyleSheet.absoluteFillObject,
 },
 coversDarkenOverlay: {
 ...StyleSheet.absoluteFillObject,
 backgroundColor: LOCKED_PROFILE_HEADER.coversDarkenOverlay,
 },
 /** Profile hero inner layer: centered identity, subtle gear at top-right. */
 profileHeaderInner: {
 ...StyleSheet.absoluteFillObject,
 paddingHorizontal: 18,
 paddingTop: 14,
 paddingBottom: 14,
 justifyContent: 'center',
 },
 /** Identity row centered in hero block. */
 headerIdentityRow: {
 alignItems: 'center',
 justifyContent: 'center',
 },
 /** Name + username hierarchy: hero title + subtle metadata. */
 headerNameStack: {
 width: '100%',
 maxWidth: 520,
 alignItems: 'center',
 },
 headerName: {
 fontSize: 32,
 fontWeight: '800',
 color: '#FFFFFF',
 lineHeight: 36,
 letterSpacing: -0.15,
 textAlign: 'center',
 textShadowColor: 'rgba(0,0,0,0.28)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 3,
 },
 headerUsername: {
 fontSize: 14,
 fontWeight: '500',
 color: '#FFFFFF',
 lineHeight: 18,
 marginTop: 10,
 opacity: 0.82,
 textAlign: 'center',
 },
 /** Settings: quiet ghost icon button. */
 headerGearButton: {
 position: 'absolute',
 top: 44,
 right: 16,
 width: 36,
 height: 36,
 borderRadius: 18,
 backgroundColor: 'rgba(0,0,0,0.35)',
 alignItems: 'center',
 justifyContent: 'center',
 flexDirection: 'row',
 shadowColor: '#000',
 shadowOpacity: 0.25,
 shadowRadius: 4,
 shadowOffset: { width: 0, height: 2 },
 elevation: 3,
 },
 headerGearButtonPressed: {
 backgroundColor: 'rgba(0,0,0,0.48)',
 },
 /** Icon: textPrimary at 0.9 opacity. */
 headerGearIconWrap: {
 opacity: 1,
 },
 headerInfoBar: {
 position: 'absolute',
 left: 0,
 right: 0,
 bottom: 0,
 height: 56,
 justifyContent: 'center',
 zIndex: 11,
 },
 headerInfoBarContent: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 16,
 paddingVertical: 12,
 },
 headerUsernameText: {
 fontSize: 14,
 fontWeight: '500',
 color: '#FFFFFF',
 opacity: 0.9,
 },
 headerSettingsButton: {
 width: 44,
 height: 44,
 borderRadius: 22,
 alignItems: 'center',
 justifyContent: 'center',
 },
 profileHeaderContent: {
 position: 'relative',
 zIndex: 10,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingBottom: 12,
 },
 profileImage: {
 width: 56,
 height: 56,
 borderRadius: 28,
 borderWidth: 2,
 borderColor: t.colors.border,
 },
 profileImagePlaceholder: {
 width: 56,
 height: 56,
 borderRadius: 28,
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 justifyContent: 'center',
 alignItems: 'center',
 borderWidth: 2,
 borderColor: t.colors.border,
 },
 profileInitial: {
 color: t.colors.text,
 fontSize: 22,
 fontWeight: '700',
 letterSpacing: 1,
 },
 profileInfo: {
 marginLeft: 14,
 flex: 1,
 },
 /** Header overlay: name (left anchor), username under; no avatar. */
 profileInfoNoAvatar: {
 flex: 1,
 },
 profileName: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.textOnDark ?? t.colors.textPrimary,
 letterSpacing: 0.3,
 marginBottom: 2,
 textShadowColor: t.colors.overlay ?? 'rgba(0,0,0,0.75)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 3,
 },
 profileEmail: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontWeight: '400',
 },
 profileUsername: {
 fontSize: 13,
 fontWeight: '400',
 color: t.colors.textSecondary,
 marginTop: 0,
 textShadowColor: t.colors.overlay ?? 'rgba(0,0,0,0.75)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 settingsButton: {
 width: 44,
 height: 44,
 borderRadius: 22,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: 'rgba(0,0,0,0.25)',
 },
 settingsButtonIcon: {
 fontSize: 24,
 },
 // Stats: section with soft separator (no floating card, no shadow)
 statsSection: {
 marginTop: 10,
 paddingVertical: 14,
 paddingHorizontal: 20,
 width: '100%',
 borderBottomWidth: 1,
 borderBottomColor: t.colors.separator ?? t.colors.border,
 },
 statsHeader: {
 flexDirection: 'row',
 justifyContent: 'flex-start',
 alignItems: 'center',
 marginBottom: 10,
 },
 statsTitle: {
 fontSize: 20 * typeScale,
 fontWeight: '800',
 color: t.colors.text,
 letterSpacing: 0.3,
 textAlign: 'left',
 },
 statsToggle: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontWeight: '600',
 },
 statsRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 marginBottom: 8,
 },
 /** Library Stats cards Scans darker surface (surface2) so tiles dont blend; borderSubtle, textPrimary/textSecondary. */
 statCard: {
 flex: 1,
 backgroundColor: t.colors.controlBg ?? t.colors.surfaceStrong ?? t.colors.surface2 ?? t.colors.surface,
 borderRadius: 10,
 paddingHorizontal: 14,
 paddingVertical: 14,
 alignItems: 'center',
 justifyContent: 'center',
 borderWidth: 1,
 borderColor: t.colors.borderSubtle,
 marginHorizontal: 4,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: t.name === 'scriptoriumDark' ? 0 : 0.03,
 shadowRadius: 2,
 elevation: t.name === 'scriptoriumDark' ? 0 : 1,
 },
 /** Web hover affordance only; rest state stays identical across all cards. */
 statCardHover: {
 backgroundColor: t.colors.controlBgPressed ?? t.colors.surface2 ?? t.colors.surface,
 },
 /** Press animation + pressed surface to reinforce "button". */
 statCardPressed: {
 backgroundColor: t.colors.controlBgPressed ?? t.colors.surface2 ?? t.colors.surface,
 transform: [{ scale: 0.985 }],
 },
 /** Web pointer cursor for button affordance. */
 statCardInteractive: {
 ...(Platform.OS === 'web' ? { cursor: 'pointer' as const } : {}),
 },
 statNumber: {
 fontSize: 24 * typeScale,
 fontWeight: '700',
 color: t.colors.textPrimary,
 marginTop: 4,
 letterSpacing: -0.5,
 },
 statLabel: {
 fontSize: 12,
 color: t.colors.textSecondary,
 fontWeight: '500',
 letterSpacing: 0.3,
 },
 statAuthorName: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.textPrimary,
 textAlign: 'center',
 marginBottom: 8,
 lineHeight: 24,
 },
 // Analytics Section
 analyticsSection: {
 backgroundColor: t.colors.surface2 ?? t.colors.bg,
 borderRadius: 12,
 padding: 18,
 marginTop: 12,
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 },
 analyticsTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.textPrimary,
 marginBottom: 16,
 letterSpacing: 0.3,
 },
 analyticsSubtitle: {
 fontSize: 13,
 color: t.colors.textMuted,
 marginBottom: 12,
 },
 authorViewHeader: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 paddingVertical: 12,
 paddingHorizontal: 16,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 },
 authorViewHeaderTitle: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.textPrimary,
 letterSpacing: 0.3,
 },
 authorViewSortLabel: {
 fontSize: 14,
 color: t.colors.textPrimary,
 fontWeight: '600',
 },
 authorViewSortWrap: {
 position: 'relative',
 marginRight: 8,
 },
 authorViewSortButton: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 12,
 paddingHorizontal: 12,
 borderRadius: 10,
 borderWidth: 1,
 },
 authorViewSortDropdown: {
 position: 'absolute',
 top: '100%',
 right: 0,
 marginTop: 4,
 minWidth: 180,
 backgroundColor: t.colors.surface,
 borderRadius: 8,
 shadowColor: t.colors.overlay ?? '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 8,
 elevation: 4,
 zIndex: 2,
 overflow: 'hidden',
 },
 authorViewSortOption: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingVertical: 12,
 paddingHorizontal: 14,
 },
 authorViewSortOptionActive: {
 backgroundColor: t.colors.accentSurface ?? t.colors.surface2 ?? t.colors.bg,
 },
 authorViewSortOptionText: {
 fontSize: 15,
 color: t.colors.textPrimary,
 },
 authorViewSortOptionTextActive: {
 fontWeight: '600',
 color: t.colors.linkMuted ?? t.colors.primary,
 },
 authorsSearchWrap: {
 flexDirection: 'row',
 alignItems: 'center',
 marginHorizontal: 20,
 marginTop: 12,
 marginBottom: 8,
 backgroundColor: t.colors.inputBg ?? t.colors.surface2 ?? t.colors.bg,
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 borderRadius: 14,
 paddingHorizontal: 14,
 paddingVertical: 12,
 },
 authorsSearchIcon: {
 marginRight: 8,
 },
 authorsSearchInput: {
 flex: 1,
 fontSize: 16,
 color: t.colors.textPrimary,
 paddingVertical: 0,
 },
 authorsSearchClear: {
 padding: 4,
 },
 topAuthorsSectionTitle: {
 fontSize: 13,
 fontWeight: '600',
 textTransform: 'uppercase',
 letterSpacing: 0.5,
 marginBottom: 10,
 },
 topAuthorsChipsRow: {
 gap: 10,
 paddingRight: 16,
 },
 topAuthorChip: {
 paddingVertical: 8,
 paddingHorizontal: 12,
 borderRadius: 8,
 backgroundColor: 'transparent',
 borderWidth: StyleSheet.hairlineWidth,
 minWidth: 80,
 maxWidth: 150,
 },
 topAuthorChipName: {
 fontSize: 14,
 fontWeight: '600',
 marginBottom: 2,
 },
 topAuthorChipCount: {
 fontSize: 12,
 fontWeight: '500',
 },
 authorsEmptyState: {
 paddingVertical: 40,
 paddingHorizontal: 24,
 alignItems: 'center',
 },
 authorsEmptyTitle: {
 fontSize: 18,
 fontWeight: '700',
 marginBottom: 8,
 textAlign: 'center',
 },
 authorsEmptySubtext: {
 fontSize: 14,
 textAlign: 'center',
 },
 authorDetailsHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 8,
 paddingBottom: 12,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.divider ?? t.colors.border,
 },
 authorDetailsBackLabel: {
 fontSize: 15,
 fontWeight: '700',
 },
 authorDetailsTitle: {
 fontSize: 18,
 fontWeight: '700',
 flex: 1,
 textAlign: 'center',
 marginHorizontal: 8,
 },
 authorDetailsBooksLabel: {
 fontSize: 13,
 fontWeight: '600',
 marginBottom: 12,
 textTransform: 'uppercase',
 letterSpacing: 0.5,
 },
 analyticsItem: {
 marginBottom: 16,
 paddingBottom: 14,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.divider ?? t.colors.border,
 },
 analyticsLabel: {
 fontSize: 14,
 fontWeight: '700',
 color: t.colors.textSecondary,
 marginBottom: 8,
 letterSpacing: 0.2,
 },
 analyticsValue: {
 fontSize: 13,
 color: t.colors.textMuted,
 marginLeft: 4,
 marginBottom: 4,
 lineHeight: 20,
 },
 statsScrollContent: {
 padding: 16,
 paddingBottom: 40,
 flexGrow: 1,
 justifyContent: 'center',
 alignItems: 'center',
 },
 statsComingSoon: {
 fontSize: 24,
 fontWeight: '600',
 color: t.colors.textMuted,
 },
 topAuthorCard: {
 marginBottom: 20,
 paddingBottom: 16,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.divider ?? t.colors.border,
 },
 topAuthorCardLast: {
 marginBottom: 0,
 paddingBottom: 0,
 borderBottomWidth: 0,
 },
 topAuthorBar: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 alignSelf: 'stretch',
 paddingVertical: 12,
 paddingHorizontal: 4,
 },
 topAuthorBooksContainer: {
 marginTop: 4,
 marginBottom: 8,
 },
 topAuthorTitleRow: {
 flexDirection: 'row',
 alignItems: 'baseline',
 flex: 1,
 minWidth: 0,
 },
 topAuthorName: {
 fontSize: 15,
 fontWeight: '700',
 color: t.colors.textPrimary,
 letterSpacing: 0.2,
 },
 topAuthorCount: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontWeight: '500',
 marginLeft: 2,
 },
 topAuthorBooksRow: {
 flexDirection: 'row',
 gap: 12,
 paddingRight: 4,
 },
 topAuthorBookCard: {
 width: 72,
 alignItems: 'center',
 },
 topAuthorBookCover: {
 width: 72,
 aspectRatio: 2 / 3,
 borderRadius: 8,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2,
 },
 topAuthorBookCoverPlaceholder: {
 alignItems: 'center',
 justifyContent: 'center',
 padding: 4,
 },
 topAuthorBookPlaceholderText: {
 fontSize: 9,
 color: t.colors.textMuted,
 textAlign: 'center',
 fontWeight: '600',
 },
 topAuthorBookTitle: {
 fontSize: 11,
 color: t.colors.textSecondary,
 fontWeight: '600',
 marginTop: 6,
 textAlign: 'center',
 lineHeight: 14,
 },
 // Books: section (no floating card, no shadow); last section so no bottom border
 booksSection: {
 paddingHorizontal: 20,
 marginTop: 18,
 paddingTop: 12,
 paddingBottom: 24,
 width: '100%',
 },
 sectionHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'flex-start',
 marginBottom: 10,
 paddingBottom: 10,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.separator ?? t.colors.border,
 },
 sectionHeaderLeft: {
 flex: 1,
 },
 selectButton: {
 paddingHorizontal: 16,
 paddingVertical: 8,
 backgroundColor: t.colors.primary,
 borderRadius: 8,
 justifyContent: 'center',
 alignItems: 'center',
 },
 selectButtonText: {
 color: t.colors.primaryText,
 fontSize: 14,
 fontWeight: '600',
 },
 cancelSelectButton: {
 paddingHorizontal: 16,
 paddingVertical: 8,
 backgroundColor: 'transparent',
 borderRadius: 8,
 justifyContent: 'center',
 alignItems: 'center',
 borderWidth: 1,
 borderColor: t.colors.border ?? t.colors.textMuted,
 },
 cancelSelectButtonText: {
 color: t.colors.textMuted,
 fontSize: 14,
 fontWeight: '600',
 },
 selectionBar: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 12,
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 marginBottom: 12,
 borderRadius: 8,
 marginHorizontal: 15,
 },
 selectionCount: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.primary,
 },
 clearSelectionButton: {
 paddingHorizontal: 12,
 paddingVertical: 6,
 backgroundColor: 'transparent',
 borderRadius: 6,
 borderWidth: 1,
 borderColor: t.colors.primary,
 },
 clearSelectionText: {
 color: t.colors.primary,
 fontSize: 12,
 fontWeight: '600',
 },
 removeFromFolderButton: {
 paddingHorizontal: 12,
 paddingVertical: 6,
 backgroundColor: t.colors.danger,
 borderRadius: 6,
 },
 removeFromFolderButtonText: {
 color: t.colors.textPrimary,
 fontSize: 12,
 fontWeight: '600',
 },
 // Bottom Delete Bar — bottom is set via inline style (tabBarHeight) at render time.
 // Never rely on bottom:0 here: that places the bar at the bottom of its containing
 // view's coordinate space, which on some layouts resolves to the top of the screen.
 bottomDeleteBarContainer: {
 position: 'absolute',
 left: 0,
 right: 0,
 backgroundColor: 'transparent',
 },
 bottomDeleteBar: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 16,
 backgroundColor: t.colors.surfaceRaised ?? t.colors.surface2 ?? t.colors.surface,
 borderTopWidth: 1,
 borderTopColor: t.colors.border,
 },
 bottomDeleteBarLeft: {
 flex: 1,
 },
 bottomDeleteBarCount: {
 fontSize: 16,
 fontWeight: '600',
 color: t.colors.text,
 },
 bottomDeleteBarRight: {
 flexDirection: 'row',
 alignItems: 'center',
 },
 bottomDeleteBarClearButton: {
 paddingHorizontal: 16,
 paddingVertical: 10,
 backgroundColor: 'transparent',
 borderRadius: 8,
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 bottomDeleteBarClearText: {
 color: t.colors.text,
 fontSize: 14,
 fontWeight: '600',
 },
 bottomDeleteBarDeleteButton: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 20,
 paddingVertical: 10,
 backgroundColor: t.colors.danger,
 borderRadius: 8,
 },
 bottomDeleteBarDeleteText: {
 color: t.colors.textPrimary,
 fontSize: 14,
 fontWeight: '600',
 },
 librarySearchContainer: {
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 flexDirection: 'row',
 alignItems: 'center',
 marginBottom: 12,
 backgroundColor: t.colors.surfaceStrong ?? t.colors.surface2 ?? t.colors.backgroundSecondary ?? t.colors.bg,
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 borderRadius: 16,
 paddingHorizontal: 12,
 paddingVertical: 8,
 minHeight: 40,
 },
 folderSelectButtonContainer: {
 flexDirection: 'row',
 gap: 12,
 paddingHorizontal: 20,
 marginBottom: 12,
 },
 autoSortButton: {
 backgroundColor: t.colors.primary,
 flex: 1,
 },
 librarySearchInput: {
 flex: 1,
 fontSize: 14,
 color: t.colors.text,
 paddingVertical: 0,
 },
 librarySearchClear: {
 width: 24,
 height: 24,
 borderRadius: 12,
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: t.colors.border,
 },
 librarySearchClearText: {
 fontSize: 18,
 color: t.colors.textMuted,
 lineHeight: 20,
 marginTop: -2,
 },
 sectionTitle: {
 fontSize: 20,
 fontWeight: '800',
 color: t.colors.text,
 letterSpacing: 0.3,
 },
 sectionSubtitle: {
 fontSize: 13,
 color: t.colors.textMuted,
 fontWeight: '400',
 opacity: 0.85,
 },
 favoritesSection: {
 marginHorizontal: 15,
 marginBottom: 15,
 },
 favoritesSectionHeaderText: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.textPrimary,
 letterSpacing: 0.3,
 marginBottom: 12,
 },
 favoritesAddButton: {
 width: 72,
 height: 108,
 borderRadius: 8,
 backgroundColor: t.colors.primary,
 alignItems: 'center',
 justifyContent: 'center',
 shadowColor: t.colors.primary,
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 6,
 elevation: 4,
 },
 favoritesBar: {
 flexDirection: 'row',
 alignItems: 'flex-start',
 gap: 12,
 paddingVertical: 4,
 },
 favoriteBookCard: {
 width: 72,
 alignItems: 'center',
 },
 favoriteBookCover: {
 width: 72,
 aspectRatio: 2 / 3,
 borderRadius: 8,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2,
 },
 favoriteBookCoverPlaceholder: {
 alignItems: 'center',
 justifyContent: 'center',
 padding: 4,
 },
 favoriteBookPlaceholderText: {
 fontSize: 9,
 color: t.colors.textMuted,
 textAlign: 'center',
 fontWeight: '600',
 },
 favoriteBookTitle: {
 fontSize: 10,
 color: t.colors.textPrimary,
 fontWeight: '600',
 marginTop: 4,
 textAlign: 'center',
 lineHeight: 12,
 },
 foldersSection: {
 paddingVertical: 16,
 paddingHorizontal: 20,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.separator ?? t.colors.border,
 },
 foldersSectionHeader: {
 flexDirection: 'row',
 justifyContent: 'center',
 alignItems: 'center',
 marginBottom: 12,
 },
 foldersSectionHeaderText: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.textMuted,
 letterSpacing: 0.3,
 textTransform: 'uppercase',
 },
 foldersGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 justifyContent: 'space-between',
 },
 folderCard: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 borderRadius: 12,
 padding: 16,
 width: (screenWidth - 52) / 2,
 marginBottom: 10,
 alignItems: 'center',
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 folderIcon: {
 marginBottom: 10,
 },
 folderName: {
 fontSize: 15,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 4,
 textAlign: 'center',
 letterSpacing: 0.2,
 },
 folderBookCount: {
 fontSize: 12,
 color: t.colors.textMuted,
 fontWeight: '500',
 },
 booksGrid: {
 paddingTop: 4,
 width: '100%',
 },
 bookRow: {
 justifyContent: 'flex-start',
 marginBottom: BOOK_GRID_VERTICAL_GAP,
 },
 bookCard: {
 width: `${100 / gridColumns}%`,
 alignItems: 'center',
 marginBottom: 0,
 paddingHorizontal: 4,
 position: 'relative',
 },
 selectedBookCard: {
 borderWidth: 2,
 borderColor: t.colors.primary,
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
 backgroundColor: t.colors.surface,
 justifyContent: 'center',
 alignItems: 'center',
 },
 coverWrap: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 9,
 marginBottom: 8,
 overflow: 'hidden',
 position: 'relative',
 // Premium cover depth: subtle, light-mode only.
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: t.name === 'scriptoriumDark' ? 0 : 0.08,
 shadowRadius: 6,
 elevation: t.name === 'scriptoriumDark' ? 0 : 2,
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
 borderRadius: 9,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2,
 marginBottom: 8,
 },
 selectedBookCover: {
 opacity: 0.7,
 },
 placeholderCover: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 borderWidth: 0,
 },
 placeholderText: {
 fontSize: 11,
 fontWeight: '700',
 color: t.colors.textMuted,
 textAlign: 'center',
 lineHeight: 14,
 paddingHorizontal: 6,
 textTransform: 'uppercase',
 letterSpacing: 0.3,
 },
 bookAuthor: {
 fontSize: 11,
 color: t.colors.textMuted,
 textAlign: 'center',
 fontWeight: '500',
 lineHeight: 14,
 width: '100%',
 },
 bookDescriptionHint: {
 fontSize: 10,
 color: t.colors.textMuted,
 textAlign: 'center',
 marginTop: 2,
 width: '100%',
 },
 emptyState: {
 alignItems: 'center',
 padding: 60,
 },
 emptyStateIcon: {
 width: 80,
 height: 80,
 borderRadius: 40,
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 justifyContent: 'center',
 alignItems: 'center',
 marginBottom: 20,
 borderWidth: 2,
 borderColor: t.colors.border,
 },
 emptyStateIconText: {
 fontSize: 40,
 },
 emptyStateText: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.text,
 marginBottom: 8,
 letterSpacing: 0.3,
 },
 emptyStateSubtext: {
 fontSize: 15,
 color: t.colors.textMuted,
 fontWeight: '500',
 textAlign: 'center',
 },
 // Photo Modal Styles
 folderViewHeader: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 paddingTop: 0,
 paddingBottom: 6,
 paddingHorizontal: 12,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 },
 folderViewBackButton: {
 padding: 6,
 marginLeft: -6,
 minWidth: 36,
 minHeight: 36,
 justifyContent: 'center',
 alignItems: 'center',
 },
 folderViewHeaderTitle: {
 fontSize: 17,
 fontWeight: '700',
 color: t.colors.textPrimary,
 flex: 1,
 textAlign: 'center',
 },
 folderViewHeaderRight: {
 width: 40,
 alignItems: 'flex-end',
 },
 folderViewDeleteButton: {
 padding: 6,
 minWidth: 36,
 minHeight: 36,
 justifyContent: 'center',
 alignItems: 'center',
 },
 modalHeader: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 paddingVertical: 16,
 paddingHorizontal: 20,
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 },
 modalBackButton: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 8,
 paddingHorizontal: 12,
 borderRadius: 20,
 backgroundColor: t.colors.borderSoft ?? t.colors.border ?? 'rgba(255,255,255,0.15)',
 minWidth: 80,
 },
 modalBackButtonText: {
 fontSize: 20,
 color: t.colors.textPrimary,
 fontWeight: '600',
 marginRight: 6,
 },
 modalBackButtonLabel: {
 fontSize: 15,
 color: t.colors.textPrimary,
 fontWeight: '600',
 },
 modalHeaderTitle: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.textPrimary,
 letterSpacing: 0.3,
 flex: 1,
 textAlign: 'center',
 },
 modalHeaderSpacer: {
 minWidth: 80,
 },
 modalHeaderButtons: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 8,
 },
 modalHeaderButton: {
 backgroundColor: t.colors.surface2 ?? t.colors.controlBg ?? 'rgba(255,255,255,0.2)',
 paddingHorizontal: 12,
 paddingVertical: 8,
 borderRadius: 20,
 alignItems: 'center',
 justifyContent: 'center',
 },
 modalHeaderButtonText: {
 color: t.colors.textPrimary,
 fontSize: 14,
 fontWeight: '600',
 },
 autoSortHeaderButton: {
 backgroundColor: t.colors.accentSurface ?? t.colors.surface2 ?? 'rgba(72,187,120,0.3)',
 },
 modalDeleteButton: {
 backgroundColor: t.colors.surface2 ?? t.colors.controlBg ?? 'rgba(255,255,255,0.2)',
 paddingHorizontal: 12,
 paddingVertical: 8,
 borderRadius: 20,
 minWidth: 44,
 alignItems: 'center',
 justifyContent: 'center',
 },
 modalCloseButton: {
 backgroundColor: t.colors.surface2 ?? t.colors.controlBg ?? 'rgba(255,255,255,0.2)',
 paddingHorizontal: 16,
 paddingVertical: 8,
 borderRadius: 20,
 },
 modalCloseButtonText: {
 color: t.colors.textPrimary,
 fontSize: 15,
 fontWeight: '600',
 },
 photosModalHeader: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 alignItems: 'center',
 paddingHorizontal: 16,
 paddingBottom: 12,
 },
 photosHeaderBackButton: {
 flexDirection: 'row',
 alignItems: 'center',
 minHeight: 36,
 paddingHorizontal: 10,
 borderRadius: 18,
 },
 photosHeaderBackText: {
 fontSize: 15,
 fontWeight: '600',
 },
 photosModalTitle: {
 fontSize: 20,
 fontWeight: '700',
 letterSpacing: 0.3,
 flex: 1,
 textAlign: 'center',
 },
 photosHeaderSpacer: {
 minWidth: 64,
 },
 photosGridContent: {
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 paddingHorizontal: 12,
 paddingTop: 12,
 paddingBottom: 24,
 },
 photosSection: {
 paddingHorizontal: 12,
 paddingTop: 16,
 paddingBottom: 8,
 },
 photosSectionHeader: {
 fontSize: 13,
 fontWeight: '600',
 marginBottom: 8,
 },
 photosGridRow: {
 justifyContent: 'flex-start',
 marginBottom: 8,
 },
 photosGridItem: {
 width: `${100 / photoColumns}%`,
 paddingHorizontal: 4,
 marginBottom: 0,
 },
 photosGridTile: {
 aspectRatio: 3 / 4,
 borderRadius: 12,
 overflow: 'hidden',
 backgroundColor: t.colors.surface2 ?? t.colors.controlBg,
 },
 photosGridOverlay: {
 position: 'absolute',
 left: 0,
 right: 0,
 bottom: 0,
 paddingVertical: 8,
 paddingHorizontal: 10,
 backgroundColor: t.colors.overlay ?? 'rgba(0,0,0,0.55)',
 },
 photosGridOverlayDate: {
 fontSize: 11,
 color: t.colors.textPrimary,
 fontWeight: '600',
 textTransform: 'uppercase',
 letterSpacing: 0.4,
 marginBottom: 2,
 },
 photosGridOverlayCaption: {
 fontSize: 12,
 color: t.colors.textPrimary,
 fontWeight: '500',
 marginBottom: 2,
 },
 photosGridOverlayScanningRow: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 6,
 },
 photosGridOverlayBooks: {
 fontSize: 11,
 color: t.colors.textSecondary,
 fontWeight: '500',
 },
 /** Photo Detail: one-pane screen (real header + hero + content on same bg) */
 photoDetailScreen: {
 flex: 1,
 },
 photoDetailHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 paddingHorizontal: 8,
 paddingBottom: 12,
 borderBottomWidth: 1,
 minHeight: 44,
 },
 photoDetailBackButton: {
 flexDirection: 'row',
 alignItems: 'center',
 minWidth: 44,
 minHeight: 44,
 justifyContent: 'flex-start',
 paddingLeft: 8,
 },
 photoDetailBackLabel: {
 fontSize: 17,
 fontWeight: '600',
 },
 photoDetailTitle: {
 flex: 1,
 fontSize: 17,
 fontWeight: '600',
 marginLeft: 8,
 marginRight: 8,
 },
 photoDetailHeaderRight: {
 minWidth: 44,
 minHeight: 44,
 },
 photoDetailScroll: {
 flex: 1,
 },
 photoDetailHeroWrap: {
 width: '100%',
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 position: 'relative',
 overflow: 'hidden',
 },
 photoDetailHeroImage: {
 width: '100%',
 height: '100%',
 },
 photoDetailHeroScrim: {
 ...StyleSheet.absoluteFillObject,
 },
 photoDetailHeroOverlay: {
 position: 'absolute',
 left: 16,
 right: 16,
 bottom: 16,
 },
 photoDetailHeroDate: {
 fontSize: 12,
 color: t.colors.textSecondary,
 fontWeight: '600',
 textTransform: 'uppercase',
 letterSpacing: 0.4,
 marginBottom: 4,
 },
 photoDetailHeroCaption: {
 fontSize: 15,
 color: t.colors.textPrimary,
 fontWeight: '600',
 marginBottom: 4,
 lineHeight: 20,
 },
 photoDetailHeroBooksCount: {
 fontSize: 14,
 color: t.colors.textPrimary,
 fontWeight: '600',
 },
 photoDetailContent: {
 paddingHorizontal: 20,
 paddingTop: 20,
 paddingBottom: 24,
 },
 viewerScrim: {
 ...StyleSheet.absoluteFillObject,
 backgroundColor: t.colors.overlay ?? 'rgba(0,0,0,0.92)',
 },
 viewerTopBar: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 flexDirection: 'row',
 alignItems: 'center',
 paddingHorizontal: 12,
 paddingBottom: 12,
 zIndex: 10,
 },
 viewerBackButton: {
 flexDirection: 'row',
 alignItems: 'center',
 paddingVertical: 8,
 paddingHorizontal: 12,
 borderRadius: 20,
 backgroundColor: t.colors.surface2 ?? t.colors.controlBg ?? 'rgba(255,255,255,0.12)',
 minWidth: 80,
 },
 viewerBackLabel: {
 fontSize: 15,
 fontWeight: '700',
 },
 viewerImageWrap: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 bottom: 120,
 backgroundColor: 'transparent',
 },
 viewerBottomSheet: {
 position: 'absolute',
 left: 0,
 right: 0,
 bottom: 0,
 borderTopLeftRadius: 20,
 borderTopRightRadius: 20,
 maxHeight: '55%',
 paddingBottom: 24,
 },
 viewerBottomScroll: {
 flexGrow: 0,
 paddingHorizontal: 16,
 paddingTop: 16,
 },
 photoCard: {
 backgroundColor: t.colors.surface,
 borderRadius: 16,
 marginHorizontal: 15,
 marginBottom: 15,
 overflow: 'hidden',
 shadowColor: t.colors.overlay ?? '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.08,
 shadowRadius: 8,
 elevation: 3,
 },
 photoCardContent: {
 width: '100%',
 },
 photoImageContainer: {
 position: 'relative',
 width: '100%',
 },
 photoImage: {
 width: '100%',
 height: 250,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2,
 },
 photoDeleteButton: {
 position: 'absolute',
 top: 10,
 right: 10,
 width: 32,
 height: 32,
 borderRadius: 16,
 backgroundColor: t.colors.overlay ?? 'rgba(0,0,0,0.6)',
 justifyContent: 'center',
 alignItems: 'center',
 zIndex: 10,
 },
 photoDeleteButtonText: {
 color: t.colors.textPrimary,
 fontSize: 24,
 fontWeight: '300',
 lineHeight: 28,
 },
 photoInfo: {
 padding: 16,
 },
 photoDate: {
 fontSize: 13,
 color: t.colors.textMuted,
 fontWeight: '600',
 marginBottom: 6,
 textTransform: 'uppercase',
 letterSpacing: 0.5,
 },
 photoCaption: {
 fontSize: 16,
 color: t.colors.textPrimary,
 fontWeight: '600',
 marginBottom: 8,
 lineHeight: 22,
 },
 photoCaptionPlaceholder: {
 fontSize: 14,
 color: t.colors.textMuted,
 fontStyle: 'italic',
 marginBottom: 8,
 },
 photoBooksCount: {
 fontSize: 13,
 color: t.colors.textMuted,
 fontWeight: '500',
 marginBottom: 8,
 },
 addToFolderSection: {
 borderRadius: 12,
 padding: 16,
 marginBottom: 16,
 borderWidth: 1,
 },
 addToFolderButtonLarge: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: 'transparent',
 borderWidth: 1,
 borderColor: t.colors.primary,
 borderRadius: 12,
 paddingVertical: 14,
 paddingHorizontal: 20,
 },
 addToFolderButtonTextLarge: {
 fontSize: 15,
 color: t.colors.primary,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 editPhotoImage: {
 width: '100%',
 height: 300,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2,
 marginBottom: 20,
 },
 captionSection: {
 borderRadius: 12,
 padding: 16,
 marginBottom: 16,
 borderWidth: 1,
 },
 captionLabel: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text ?? t.colors.textPrimary,
 marginBottom: 12,
 letterSpacing: 0.3,
 },
 captionInput: {
 backgroundColor: t.colors.inputBg ?? t.colors.bg,
 borderWidth: 1,
 borderRadius: 12,
 padding: 14,
 fontSize: 15,
 color: t.colors.text ?? t.colors.textPrimary,
 marginBottom: 16,
 minHeight: 60,
 textAlignVertical: 'top',
 },
 saveCaptionButton: {
 backgroundColor: t.colors.primary,
 borderRadius: 12,
 paddingVertical: 14,
 alignItems: 'center',
 shadowColor: t.colors.primary,
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 6,
 elevation: 3,
 },
 saveCaptionButtonText: {
 color: t.colors.primaryText,
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 addBooksSection: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 borderRadius: 12,
 padding: 16,
 marginBottom: 16,
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 addBooksTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text ?? t.colors.textPrimary,
 marginBottom: 12,
 letterSpacing: 0.3,
 },
 addBooksSearchRow: {
 flexDirection: 'row',
 alignItems: 'center',
 marginBottom: 10,
 },
 addBooksSearchInput: {
 flex: 1,
 backgroundColor: t.colors.inputBg ?? t.colors.bg,
 borderWidth: 1,
 borderColor: t.colors.inputBorder ?? t.colors.border,
 borderRadius: 10,
 paddingHorizontal: 12,
 paddingVertical: 10,
 fontSize: 14,
 color: t.colors.text ?? t.colors.textPrimary,
 marginRight: 8,
 },
 addBooksSearchButton: {
 backgroundColor: t.colors.primary,
 paddingHorizontal: 14,
 paddingVertical: 10,
 borderRadius: 10,
 },
 addBooksSearchButtonText: {
 color: t.colors.primaryText,
 fontSize: 14,
 fontWeight: '700',
 },
 addBooksResults: {
 borderTopWidth: 1,
 borderTopColor: t.colors.border ?? t.colors.divider,
 paddingTop: 8,
 },
 addBooksResultRow: {
 paddingVertical: 10,
 borderBottomWidth: 1,
 borderBottomColor: t.colors.border ?? t.colors.divider,
 },
 addBooksResultInfo: {
 flexDirection: 'column',
 },
 addBooksResultTitle: {
 fontSize: 14,
 fontWeight: '700',
 color: t.colors.text ?? t.colors.textPrimary,
 },
 addBooksResultAuthor: {
 fontSize: 12,
 color: t.colors.textMuted ?? t.colors.textSecondary,
 },
 addedViaSearchSection: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 borderRadius: 12,
 padding: 16,
 marginBottom: 16,
 borderWidth: 1,
 borderColor: t.colors.border,
 },
 addedViaSearchTitle: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text ?? t.colors.textPrimary,
 marginBottom: 10,
 },
 addedViaSearchChips: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 8,
 },
 addedChip: {
 flexDirection: 'row',
 alignItems: 'center',
 backgroundColor: t.colors.inputBg ?? t.colors.bg,
 borderWidth: 1,
 borderColor: t.colors.border,
 borderRadius: 16,
 paddingVertical: 6,
 paddingHorizontal: 10,
 maxWidth: '48%',
 },
 addedChipText: {
 fontSize: 12,
 color: t.colors.text ?? t.colors.textPrimary,
 flexShrink: 1,
 marginRight: 8,
 },
 addedChipRemove: {
 width: 20,
 height: 20,
 borderRadius: 10,
 backgroundColor: t.colors.controlBg ?? t.colors.surface2 ?? (t.name === 'scriptoriumDark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)'),
 alignItems: 'center',
 justifyContent: 'center',
 },
 addedChipRemoveText: {
 fontSize: 14,
 color: t.colors.textMuted ?? t.colors.textSecondary,
 lineHeight: 18,
 marginTop: -1,
 },
 photoBooksSection: {
 marginBottom: 24,
 },
 photoBooksTitleRow: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 marginBottom: 8,
 },
 photoBooksTitle: {
 fontSize: 18,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 photoBooksCountBadge: {
 paddingHorizontal: 10,
 paddingVertical: 4,
 borderRadius: 12,
 },
 photoBooksCountBadgeText: {
 fontSize: 14,
 fontWeight: '700',
 },
 photoBooksConfidenceChip: {
 alignSelf: 'flex-start',
 paddingHorizontal: 10,
 paddingVertical: 6,
 borderRadius: 10,
 borderWidth: 1,
 marginBottom: 12,
 },
 photoBooksConfidenceChipText: {
 fontSize: 12,
 fontWeight: '600',
 },
 /** Mini book cards: 3 columns, gap 12, cover radius 12, title/author from theme tokens */
 photoBooksGrid: {
 flexDirection: 'row',
 flexWrap: 'wrap',
 gap: 12,
 },
 photoBookCard: {
 width: (screenWidth - 20 * 2 - 12 * 2) / 3,
 alignItems: 'center',
 },
 photoBookCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 12,
 marginBottom: 6,
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 overflow: 'hidden',
 },
 photoBookCoverPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 6,
 },
 photoBookPlaceholderText: {
 fontSize: 10,
 fontWeight: '600',
 color: t.colors.textMuted ?? t.colors.textSecondary,
 textAlign: 'center',
 },
 photoBookTitle: {
 fontSize: 13,
 fontWeight: '600',
 color: t.colors.text ?? t.colors.textPrimary,
 textAlign: 'center',
 marginBottom: 2,
 lineHeight: 16,
 },
 photoBookAuthor: {
 fontSize: 12,
 fontWeight: '400',
 color: t.colors.textMuted ?? t.colors.textSecondary,
 textAlign: 'center',
 lineHeight: 14,
 },
 confirmModalOverlay: {
 position: 'absolute',
 top: 0,
 right: 0,
 bottom: 0,
 left: 0,
 backgroundColor: 'transparent',
 justifyContent: 'center',
 alignItems: 'center',
 zIndex: 999,
 paddingHorizontal: 16,
 },
 confirmModalContent: {
 backgroundColor: t.colors.surface,
 borderRadius: 16,
 padding: 24,
 width: '85%',
 maxWidth: 400,
 shadowColor: t.colors.overlay ?? '#000',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: 0.25,
 shadowRadius: 12,
 elevation: 10,
 },
 confirmModalTitle: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.textPrimary,
 marginBottom: 12,
 },
 confirmModalMessage: {
 fontSize: 15,
 color: t.colors.textSecondary,
 lineHeight: 22,
 marginBottom: 24,
 },
 confirmModalButtons: {
 flexDirection: 'row',
 justifyContent: 'flex-end',
 },
 confirmModalButton: {
 paddingVertical: 12,
 paddingHorizontal: 24,
 borderRadius: 8,
 minWidth: 100,
 alignItems: 'center',
 },
 confirmModalButtonCancel: {
 backgroundColor: t.colors.inputBg ?? t.colors.surface2 ?? t.colors.bg,
 },
 confirmModalButtonCancelText: {
 color: t.colors.textSecondary,
 fontSize: 15,
 fontWeight: '600',
 },
 confirmModalButtonDelete: {
 backgroundColor: t.colors.danger,
 },
 confirmModalButtonDeleteText: {
 color: t.colors.textPrimary,
 fontSize: 15,
 fontWeight: '600',
 },
 placeholderTextSmall: {
 fontSize: 9,
 fontWeight: '700',
 color: t.colors.textSecondary,
 textAlign: 'center',
 lineHeight: 11,
 padding: 4,
 },
 folderItem: {
 backgroundColor: t.colors.surface,
 borderRadius: 12,
 padding: 16,
 marginBottom: 12,
 marginHorizontal: 15,
 flexDirection: 'row',
 alignItems: 'center',
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 shadowColor: t.colors.overlay ?? '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.05,
 shadowRadius: 4,
 elevation: 1,
 },
 folderItemName: {
 fontSize: 16,
 fontWeight: '600',
 color: t.colors.textPrimary,
 marginBottom: 4,
 },
 folderItemCount: {
 fontSize: 13,
 color: t.colors.textMuted,
 },
 createFolderSection: {
 backgroundColor: t.colors.surface,
 borderRadius: 16,
 padding: 20,
 marginBottom: 24,
 marginHorizontal: 15,
 shadowColor: t.colors.overlay ?? '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.05,
 shadowRadius: 8,
 elevation: 2,
 },
 createFolderTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.textPrimary,
 marginBottom: 12,
 letterSpacing: 0.3,
 },
 createFolderRow: {
 flexDirection: 'row',
 gap: 12,
 },
 createFolderInput: {
 flex: 1,
 backgroundColor: t.colors.inputBg ?? t.colors.surface2 ?? t.colors.bg,
 borderWidth: 1,
 borderColor: t.colors.borderSubtle ?? t.colors.border,
 borderRadius: 12,
 padding: 14,
 fontSize: 16,
 color: t.colors.textPrimary,
 },
 createFolderButton: {
 backgroundColor: t.colors.primary,
 paddingVertical: 14,
 paddingHorizontal: 20,
 borderRadius: 12,
 justifyContent: 'center',
 shadowColor: t.colors.primary,
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.2,
 shadowRadius: 4,
 elevation: 3,
 },
 createFolderButtonDisabled: {
 backgroundColor: t.colors.surface2 ?? t.colors.surface,
 opacity: 0.6,
 },
 createFolderButtonText: {
 color: t.colors.primaryText,
 fontSize: 15,
 fontWeight: '700',
 letterSpacing: 0.3,
 },
 existingFoldersSection: {
 marginBottom: 24,
 marginHorizontal: 15,
 },
 existingFoldersTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.textPrimary,
 marginBottom: 16,
 letterSpacing: 0.3,
 },
});


