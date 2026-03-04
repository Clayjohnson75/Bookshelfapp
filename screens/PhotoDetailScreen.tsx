/**
 * Photo Detail: one-pane screen keyed by photoId.
 * Single navigation; stable state (do not clear on blur). useFocusEffect for refresh only.
 * Skeleton while loading; empty state when no books; theme tokens throughout.
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  InteractionManager,
  Alert,
} from 'react-native';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { TrashIcon } from '../components/Icons';
import { Image as ExpoImage } from 'expo-image';
import { Book, Photo } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { isGoogleHotlink } from '../lib/coverUtils';
import { getBookSourcePhotoId } from '../lib/bookKey';
import { dedupBy, photoStableKey } from '../lib/dedupBy';
import { getSignedPhotoUrl } from '../lib/photoUrls';
import { AppHeader } from '../components/AppHeader';
import { deleteLibraryPhotoAndBooks } from '../services/supabaseSync';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit } from '../lib/deleteGuard';
import { useProfileStats } from '../contexts/ProfileStatsContext';

type PhotoDetailParams = { photoId: string; photo?: Photo };

function normalizeString(str: string | undefined): string {
  if (!str) return '';
  return str.trim().toLowerCase();
}

function booksMatch(book1: Book, book2: Book): boolean {
  const title1 = normalizeString(book1.title);
  const title2 = normalizeString(book2.title);
  const author1 = normalizeString(book1.author);
  const author2 = normalizeString(book2.author);
  if (title1 !== title2) return false;
  if (title1 && title2 && title1 === title2) {
    if (author1 && author2) return author1 === author2;
    return true;
  }
  return false;
}

function getBookCoverUri(book: Book): string | undefined {
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

const SKELETON_CARD_COUNT = 8;

export function PhotoDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useTheme();
  const { user } = useAuth();
  const { refreshProfileStats } = useProfileStats();
  const params = route.params as PhotoDetailParams;
  const photoId = params?.photoId;
  const initialPhoto = params?.photo ?? null;

  const [dimensions, setDimensions] = useState(Dimensions.get('window'));
  const screenWidth = dimensions.width || 375;
  const screenHeight = dimensions.height || 667;

  const [photo, setPhoto] = useState<Photo | null>(initialPhoto);
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(!initialPhoto);
  const [heroUri, setHeroUri] = useState<string | null>(initialPhoto?.uri ?? null);
  const [showHeroImage, setShowHeroImage] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchPhotoDetail = useCallback(async (cancelledRef?: { cancelled: boolean }) => {
    if (!user || !photoId) return;
    if (!initialPhoto) setLoading(true);
    try {
      const [photosJson, booksJson] = await Promise.all([
        AsyncStorage.getItem(`photos_${user.uid}`),
        AsyncStorage.getItem(`approved_books_${user.uid}`),
      ]);
      if (cancelledRef?.cancelled) return;
      const photos: Photo[] = photosJson ? JSON.parse(photosJson) : [];
      const approved: Book[] = booksJson ? JSON.parse(booksJson) : [];
      const found = dedupBy(photos, photoStableKey).find(p => (p.id ?? (p as any).jobId) === photoId);
      setBooks(approved);
      if (found) setPhoto(found);
    } catch {
      // keep current state
    } finally {
      if (!cancelledRef?.cancelled) setLoading(false);
    }
  }, [user, photoId, initialPhoto]);

  // Refresh when this screen is focused (includes initial mount focus).
  useFocusEffect(
    useCallback(() => {
      const cancelledRef = { cancelled: false };
      const interactionTask = InteractionManager.runAfterInteractions(() => {
        fetchPhotoDetail(cancelledRef);
      });
      return () => {
        cancelledRef.cancelled = true;
        interactionTask.cancel?.();
      };
    }, [fetchPhotoDetail])
  );

  // Keep a local hero URI in this screen so image renders immediately and updates in-place.
  useEffect(() => {
    if (!photo) {
      setHeroUri(null);
      setShowHeroImage(false);
      return;
    }
    let cancelled = false;
    setShowHeroImage(false);
    setHeroUri(photo.uri ?? null);
    const interactionTask = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) setShowHeroImage(true);
    });
    const storagePath = photo.storage_path?.trim();
    if (storagePath) {
      getSignedPhotoUrl(storagePath)
        .then((signed) => {
          if (!cancelled && signed) setHeroUri(signed);
        })
        .catch(() => {
          // Keep fallback URI if signing fails.
        });
    }
    return () => {
      cancelled = true;
      interactionTask.cancel?.();
    };
  }, [photo?.id, photo?.uri, photo?.storage_path]);

  const styles = useMemo(() => getStyles(screenWidth, t), [screenWidth, t]);
  const isDark = t.name === 'scriptoriumDark';

  const booksFromPhoto = useMemo(() => {
    if (!photo?.books?.length) return [];
    // Return the library book objects (which have coverUrl, localCoverPath, etc.)
    // rather than the raw photo.books objects which lack cover data.
    return books.filter(libraryBook =>
      photo.books!.some(photoBook => booksMatch(photoBook, libraryBook))
    );
  }, [photo, books]);

  const heroHeight = Math.min(340, Math.max(280, screenHeight * 0.4));

  const handleDeletePhoto = useCallback(() => {
    if (!user?.uid || !photo || isDeleting) return;
    const affectedBooks = booksFromPhoto.length;
    const hasBooks = affectedBooks > 0;
    const bookLabel = affectedBooks === 1 ? 'book' : 'books';
    // Create intent at gesture time so gestureAt reflects when the user tapped "Delete".
    const _intent = createDeleteIntent('user_delete_photo', 'PhotoDetailScreen');

    const doDelete = async (cascadeBooks: boolean) => {
      _intent.reason = cascadeBooks ? 'user_delete_photo_cascade' : 'user_delete_photo';
      _intent.userConfirmed = true;
      if (!assertDeleteAllowed(_intent)) return;
      logDeleteAudit(_intent, { photoIds: [photo.id], bookCount: affectedBooks, cascadeBooks, userId: user?.uid });
      try {
        setIsDeleting(true);
        const result = await deleteLibraryPhotoAndBooks(
          user.uid,
          photo.id,
          cascadeBooks,
          true,
          photo.photoFingerprint ?? null,
          'PhotoDetailScreen',
          affectedBooks,
        );
        if (!result.ok) {
          Alert.alert('Delete failed', result.error ?? 'Could not delete this scan photo.');
          return;
        }
        const photosKey = `photos_${user.uid}`;
        const approvedKey = `approved_books_${user.uid}`;
        const [photosJson, approvedJson] = await Promise.all([
          AsyncStorage.getItem(photosKey),
          AsyncStorage.getItem(approvedKey),
        ]);
        const photosArr: Photo[] = photosJson ? JSON.parse(photosJson) : [];
        const approvedArr: Book[] = approvedJson ? JSON.parse(approvedJson) : [];
        const nextPhotos = (Array.isArray(photosArr) ? photosArr : []).filter((p) => p.id !== photo.id);
        // Only remove from local approved list if cascade — otherwise books survive detached
        const nextApproved = cascadeBooks
          ? (Array.isArray(approvedArr) ? approvedArr : []).filter((b) => getBookSourcePhotoId(b) !== photo.id)
          : approvedArr;
        await Promise.all([
          AsyncStorage.setItem(photosKey, JSON.stringify(nextPhotos)),
          AsyncStorage.setItem(approvedKey, JSON.stringify(nextApproved)),
        ]);
        refreshProfileStats().catch(() => {});
        navigation.goBack();
      } finally {
        setIsDeleting(false);
      }
    };

    if (hasBooks) {
      Alert.alert(
        'Delete scan photo',
        `This photo has ${affectedBooks} ${bookLabel} in your library.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete Photo Only',
            onPress: () => doDelete(false),
          },
          {
            text: `Delete Photo + ${bookLabel}`,
            style: 'destructive',
            onPress: () => doDelete(true),
          },
        ]
      );
    } else {
      Alert.alert(
        'Delete scan photo',
        'Remove this photo from your library?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => doDelete(false) },
        ]
      );
    }
  }, [user?.uid, photo, booksFromPhoto.length, isDeleting, refreshProfileStats, navigation]);

  if (!photoId) {
    return (
      <View style={[styles.screen, { backgroundColor: t.colors.bg }]}>
        <Text style={{ color: t.colors.text }}>Invalid photo</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: t.colors.primary }}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: t.colors.bg }]}>
      <AppHeader
        title={photo?.caption?.trim() || (photo ? new Date(photo.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '') || 'Photo'}
        onBack={() => navigation.goBack()}
        rightSlot={
          photo ? (
            <TouchableOpacity
              onPress={handleDeletePhoto}
              style={[styles.headerDeleteButton, { backgroundColor: 'rgba(0,0,0,0.42)', borderColor: 'rgba(255,255,255,0.2)' }]}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              disabled={isDeleting}
            >
              <TrashIcon
                size={16}
                color={t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878'}
              />
            </TouchableOpacity>
          ) : null
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
      >
        {loading && !photo ? (
          <View style={[styles.heroWrap, { height: heroHeight }]}>
            <View style={[styles.heroSkeleton, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]} />
          </View>
        ) : photo ? (
          <View style={[styles.heroWrap, { height: heroHeight }]}>
            {heroUri && showHeroImage ? (
              <ExpoImage
                key={`${photoId}-${heroUri}`}
                source={{ uri: heroUri }}
                style={[StyleSheet.absoluteFill as any]}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={120}
              />
            ) : (
              <View style={[styles.heroSkeleton, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]} />
            )}
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} locations={[0.3, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
            <View style={styles.heroOverlay}>
              <Text style={styles.heroDate}>{new Date(photo.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
              {photo.caption?.trim() ? <Text style={styles.heroCaption} numberOfLines={2}>{photo.caption.trim()}</Text> : null}
              <Text style={styles.heroBooksCount}>{booksFromPhoto.length} books found</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.content}>
          {loading && !photo ? (
            <View style={styles.skeletonGrid}>
              {Array.from({ length: SKELETON_CARD_COUNT }).map((_, i) => (
                <View key={i} style={[styles.skeletonCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
                  <View style={[styles.skeletonCover, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]} />
                  <View style={[styles.skeletonLine, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]} />
                  <View style={[styles.skeletonLineShort, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }]} />
                </View>
              ))}
            </View>
          ) : photo && booksFromPhoto.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyTitle, { color: t.colors.text }]}>No books detected yet</Text>
              <Text style={[styles.emptySubtext, { color: t.colors.textMuted ?? t.colors.textSecondary }]}>Add books from this scan to your library</Text>
              <TouchableOpacity
                style={[styles.emptyButton, { borderColor: t.colors.border, backgroundColor: t.colors.surface2 ?? t.colors.surface }]}
                onPress={() => navigation.goBack()}
                activeOpacity={0.7}
              >
                <Text style={[styles.emptyButtonText, { color: t.colors.text }]}>Add books manually</Text>
              </TouchableOpacity>
            </View>
          ) : photo && booksFromPhoto.length > 0 ? (
            <>
              <View style={styles.sectionDivider} />
              <View style={styles.booksTitleRow}>
                <Text style={[styles.booksTitle, { color: t.colors.text }]}>Books from this photo</Text>
                <View style={[styles.countBadge, { backgroundColor: t.colors.surface2 ?? t.colors.surface }]}>
                  <Text style={[styles.countBadgeText, { color: t.colors.textMuted }]}>{booksFromPhoto.length}</Text>
                </View>
              </View>
              <View style={styles.booksGrid}>
                {booksFromPhoto.map((book, index) => (
                  <View key={book.id ?? book.book_key ?? index} style={styles.bookCard}>
                    {getBookCoverUri(book) ? (
                      <ExpoImage
                        source={{ uri: getBookCoverUri(book) }}
                        style={styles.bookCover}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={100}
                      />
                    ) : (
                      <View style={[styles.bookCover, styles.bookCoverPlaceholder]}>
                        <Text style={[styles.bookPlaceholderText, { color: t.colors.textMuted }]} numberOfLines={2} ellipsizeMode="tail">{book.title}</Text>
                      </View>
                    )}
                    <Text style={[styles.bookTitle, { color: t.colors.text }]} numberOfLines={1} ellipsizeMode="tail">{book.title}</Text>
                    <Text style={[styles.bookAuthor, { color: t.colors.textMuted }]} numberOfLines={1} ellipsizeMode="tail">{book.author?.trim() || 'Unknown author'}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function getStyles(screenWidth: number, t: import('../theme/tokens').ThemeTokens) {
  const contentPadding = 16;
  const NUM_COLS = 4;
  const gap = 8;
  const cardWidth = (screenWidth - contentPadding * 2 - gap * (NUM_COLS - 1)) / NUM_COLS;
  return StyleSheet.create({
    screen: { flex: 1 },
    scroll: { flex: 1 },
    heroWrap: { width: '100%', position: 'relative', overflow: 'hidden' },
    heroSkeleton: { width: '100%', height: '100%' },
    heroOverlay: { position: 'absolute', left: 16, right: 16, bottom: 16 },
    heroDate: { fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
    heroCaption: { fontSize: 15, color: '#FFFFFF', fontWeight: '600', marginBottom: 4, lineHeight: 20 },
    heroBooksCount: { fontSize: 14, color: 'rgba(255,255,255,0.9)', fontWeight: '600' },
    content: { paddingHorizontal: contentPadding, paddingTop: 20, paddingBottom: 24 },
    sectionDivider: {
      height: 1,
      backgroundColor: t.colors.separator ?? t.colors.border,
      marginTop: 8,
      marginBottom: 16,
    },
    skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap },
    skeletonCard: { width: cardWidth, alignItems: 'center' },
    skeletonCover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 12, marginBottom: 6 },
    skeletonLine: { width: '80%', height: 10, borderRadius: 4, marginBottom: 4 },
    skeletonLineShort: { width: '60%', height: 8, borderRadius: 4 },
    emptyState: { alignItems: 'center', paddingVertical: 32 },
    emptyTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
    emptySubtext: { fontSize: 14, marginBottom: 20 },
    emptyButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, borderWidth: 1 },
    emptyButtonText: { fontSize: 15, fontWeight: '600' },
    booksTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    booksTitle: { fontSize: 18, fontWeight: '700' },
    countBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
    countBadgeText: { fontSize: 14, fontWeight: '700' },
    headerDeleteButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    booksGrid: { flexDirection: 'row', flexWrap: 'wrap', gap },
    bookCard: { width: cardWidth, alignItems: 'center' },
    bookCover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
    bookCoverPlaceholder: { justifyContent: 'center', alignItems: 'center', padding: 6, backgroundColor: t.colors.surface2 ?? t.colors.surface },
    bookPlaceholderText: { fontSize: 10, fontWeight: '600', textAlign: 'center' },
    bookTitle: { fontSize: 11, fontWeight: '600', textAlign: 'center', marginBottom: 2, lineHeight: 14 },
    bookAuthor: { fontSize: 10, fontWeight: '400', textAlign: 'center', lineHeight: 13 },
  });
}
