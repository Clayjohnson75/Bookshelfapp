import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useWindowDimensions, InteractionManager, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { FlashList, ListRenderItem } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { TrashIcon } from '../components/Icons';
import { useAuth } from '../auth/SimpleAuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { Book, Photo } from '../types/BookTypes';
import { getBookSourcePhotoId, getBookSourceScanJobId } from '../lib/bookKey';
import { canon, normalizeId } from '../lib/photoKey';
import { dedupBy, canonicalPhotoListKey } from '../lib/dedupBy';
import { PhotoTile } from '../components/PhotoTile';
import { AppHeader } from '../components/AppHeader';
import { getSignedPhotoUrl } from '../lib/photoUrls';
import { deleteLibraryPhotoAndBooks } from '../services/supabaseSync';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit } from '../lib/deleteGuard';
import { useProfileStats } from '../contexts/ProfileStatsContext';
import { logger } from '../utils/logger';

export default function PhotosScreen() {
 const navigation = useNavigation();
 const { user } = useAuth();
 const { t } = useTheme();
 const insets = useSafeAreaInsets();
 const [photos, setPhotos] = useState<Photo[]>([]);
 const [approvedBooks, setApprovedBooks] = useState<Book[]>([]);
 const [pendingBooks, setPendingBooks] = useState<Book[]>([]);
 const [photoIdAliasMap, setPhotoIdAliasMap] = useState<Record<string, string>>({});
 const [isLoading, setIsLoading] = useState(true);
 const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
 const detailNavLockRef = useRef(false);
 const { width: screenWidth } = useWindowDimensions();
 const { refreshProfileStats, displayBookCount } = useProfileStats();

 useFocusEffect(
 useCallback(() => {
 let cancelled = false;
 const load = async () => {
 if (!user?.uid) return;
 try {
 const [photosJson, approvedJson, pendingJson, photoAliasesJson] = await Promise.all([
 AsyncStorage.getItem(`photos_${user.uid}`),
 AsyncStorage.getItem(`approved_books_${user.uid}`),
 AsyncStorage.getItem(`pending_books_${user.uid}`),
 AsyncStorage.getItem(`photo_id_aliases_${user.uid}`),
 ]);
 if (cancelled) return;
 const aliasMap = photoAliasesJson ? (() => { try { const o = JSON.parse(photoAliasesJson); return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, string> : {}; } catch { return {}; } })() : {};
 setPhotoIdAliasMap(aliasMap);
 const rawPhotos: Photo[] = photosJson ? JSON.parse(photosJson) : [];
 const normalizedPhotos = rawPhotos.map((p) => {
 const canonical = (aliasMap[p.id] ?? p.id).trim();
 if (!canonical) return p;
 if (p.id !== canonical) return { ...p, id: canonical, localId: p.localId ?? p.id };
 return p;
 });
 setPhotos(normalizedPhotos);
 const rawApproved = approvedJson ? (() => { try { return JSON.parse(approvedJson); } catch { return []; } })() : [];
 const rawPending = pendingJson ? (() => { try { return JSON.parse(pendingJson); } catch { return []; } })() : [];
 setApprovedBooks(Array.isArray(rawApproved) ? rawApproved : []);
 setPendingBooks(Array.isArray(rawPending) ? rawPending : []);
 setIsLoading(false);
} catch {
 if (!cancelled) {
 setPhotos([]);
 setApprovedBooks([]);
 setPendingBooks([]);
 setPhotoIdAliasMap({});
 setIsLoading(false);
}
 }
 };
 setIsLoading(true);
 const task = InteractionManager.runAfterInteractions(() => {
 load();
 });
 return () => {
 cancelled = true;
 task.cancel?.();
 detailNavLockRef.current = false;
 };
 }, [user?.uid])
 );

 const sw = screenWidth || 375;
 const photoColumns = sw > 900 ? 3 : sw >= 600 ? 3 : 2;
 const gridPadding = 12;
 const gridGap = 8;
 const maxGridWidth = 900;
 const gridContainerWidth = Math.min(screenWidth || 375, maxGridWidth);
 const gridItemWidth = Math.max(
 1,
 Math.floor((gridContainerWidth - (gridPadding * 2) - (gridGap * (photoColumns - 1))) / photoColumns)
 );
 const gridItemHeight = Math.max(1, Math.floor((gridItemWidth * 4) / 3));
 const estimatedItemSize = gridItemHeight + gridGap;

// Canonical join: book.source_photo_id === photo.id. Full UUID only (canon). Pending + approved for Photos tab.
const countsByPhotoId = useMemo(() => {
 const map = new Map<string, number>();
 const allBooks = [
   ...approvedBooks.filter((b) => (b as any).status === 'approved' && !(b as any).deleted_at),
   ...pendingBooks.filter((b) => !(b as any).deleted_at),
 ];
 allBooks.forEach((book) => {
 const pid = getBookSourcePhotoId(book);
 if (pid) {
  const canonicalPid = photoIdAliasMap[pid] ?? pid;
  const key = canon(canonicalPid);
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
  return;
 }
 const jobId = getBookSourceScanJobId(book);
 if (!jobId) return;
 const photoForJob = photos.find((p) => (p as { scan_job_id?: string }).scan_job_id === jobId || p.jobId === jobId);
 if (photoForJob) {
  const canonicalPid = photoIdAliasMap[photoForJob.id] ?? photoForJob.id;
  const key = canon(canonicalPid);
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
 }
 });
 return map;
}, [approvedBooks, pendingBooks, photoIdAliasMap, photos]);

// Show ONLY photos that have live books (pending or approved). Photos from cleared/deleted
// scans that have no books are filtered out — they're just stale entries in AsyncStorage.
// Sort by timestamp desc so recent scans appear first.
const displayedPhotos = useMemo(() => {
 const list = dedupBy(photos, canonicalPhotoListKey)
   .filter((photo) => {
     if ((photo as any)?.deleted_at) return false;
     if (photo.status === 'discarded' || photo.status === 'rejected' || (photo as any).status === 'scan_failed') return false;
     const key = canon(photo.id);
     const bookCount = countsByPhotoId.get(key) ?? 0;
     return bookCount > 0;
   })
   .map((photo) => {
     const key = canon(photo.id);
     const bookCount = countsByPhotoId.get(key) ?? 0;
     const thumbnailUri = photo.thumbnail_uri ?? photo.uri ?? null;
     return { photo, bookCount, thumbnailUri, isProcessingZeroBooks: false };
   });
 const byTimestamp = (a: { photo: Photo }, b: { photo: Photo }) =>
   ((b.photo as { timestamp?: number }).timestamp ?? 0) - ((a.photo as { timestamp?: number }).timestamp ?? 0);
 return [...list].sort(byTimestamp);
}, [photos, countsByPhotoId]);

// Diagnostic: confirm photo.id (DB uuid after normalize) matches book.source_photo_id. Invariant: photo.id === book.sourcePhotoId for attach.
useEffect(() => {
 if (displayedPhotos.length === 0 || approvedBooks.length === 0) return;
 const onePhoto = displayedPhotos[0];
 const oneBook = approvedBooks.find((b) => getBookSourcePhotoId(b)) ?? approvedBooks[0];
 const photoIdDb = onePhoto?.photo?.id ?? '';
 const bookSourcePhotoId = oneBook ? getBookSourcePhotoId(oneBook) ?? '' : '';
 const match = photoIdDb && bookSourcePhotoId && photoIdDb === bookSourcePhotoId;
 logger.info('[PHOTO_BOOK_ID_CHECK]', {
 photoId: photoIdDb.slice(0, 12),
 photoLocalId: onePhoto?.photo?.localId?.slice(0, 12),
 bookSourcePhotoId: bookSourcePhotoId.slice(0, 12),
 match,
 });
}, [displayedPhotos, approvedBooks]);

useEffect(() => {
 let cancelled = false;
 const preload = async () => {
 const candidates = displayedPhotos.slice(0, 12);
 if (candidates.length === 0) return;
 const urls = await Promise.all(
 candidates.map(async ({ photo }) => {
 if (photo.storage_path) {
 try {
 return await getSignedPhotoUrl(photo.storage_path, 60 * 30, {
 width: gridItemWidth * 2,
 height: gridItemHeight * 2,
 resize: 'cover',
 quality: 70,
 });
 } catch {
 return photo.uri ?? '';
 }
 }
 return photo.uri ?? '';
 })
 );
 if (cancelled) return;
 const prefetchUrls = urls.filter(Boolean);
 if (prefetchUrls.length > 0) {
 await ExpoImage.prefetch(prefetchUrls, 'memory-disk');
 }
 };
 const task = InteractionManager.runAfterInteractions(() => {
 preload().catch(() => {});
 });
 return () => {
 cancelled = true;
 task.cancel?.();
 };
 }, [displayedPhotos, gridItemWidth, gridItemHeight]);

 const listContentStyle = useMemo(
 () => [styles.gridContent, { paddingBottom: insets.bottom + 24, paddingHorizontal: gridPadding }],
 [insets.bottom, gridPadding]
 );

 const openPhotoDetail = useCallback((photo: Photo) => {
 if (detailNavLockRef.current) return;
 detailNavLockRef.current = true;
 (navigation as any).navigate('PhotoDetail', { photoId: photo.id, photo });
 setTimeout(() => { detailNavLockRef.current = false; }, 700);
 }, [navigation]);

 const removePhotoLocally = useCallback(async (photoId: string, affectedBooks: number) => {
 if (!user?.uid) return;
 try {
 const photosKey = `photos_${user.uid}`;
 const approvedKey = `approved_books_${user.uid}`;
 const [photosJson, approvedJson] = await Promise.all([
 AsyncStorage.getItem(photosKey),
 AsyncStorage.getItem(approvedKey),
 ]);
 const photosArr: Photo[] = photosJson ? JSON.parse(photosJson) : [];
 const approvedArr: any[] = approvedJson ? JSON.parse(approvedJson) : [];
 const nextPhotos = (Array.isArray(photosArr) ? photosArr : []).filter((p) => p.id !== photoId);
 const nextApproved = (Array.isArray(approvedArr) ? approvedArr : []).filter((b) => getBookSourcePhotoId(b) !== photoId);
 await Promise.all([
 AsyncStorage.setItem(photosKey, JSON.stringify(nextPhotos)),
 AsyncStorage.setItem(approvedKey, JSON.stringify(nextApproved)),
 ]);
 setPhotos(nextPhotos);
 refreshProfileStats().catch(() => {});
 } catch {
 setPhotos((prev) => prev.filter((p) => p.id !== photoId));
 }
 }, [user?.uid, refreshProfileStats]);

  const confirmDeletePhoto = useCallback((photo: Photo, bookCount: number | undefined) => {
    if (!user?.uid || deletingPhotoId != null) return;
    const affected = Math.max(0, bookCount ?? 0);
    const hasBooks = affected > 0;
    const bookLabel = affected === 1 ? 'book' : 'books';
    const imageHash = photo.photoFingerprint ?? null;
    // Create the intent at gesture time (before the Alert) so gestureAt is accurate.
    const _intent = createDeleteIntent('user_delete_photo', 'PhotosScreen');

    const doDelete = async (cascadeBooks: boolean) => {
      _intent.reason = cascadeBooks ? 'user_delete_photo_cascade' : 'user_delete_photo';
      _intent.userConfirmed = true;
      if (!assertDeleteAllowed(_intent)) return;
      logDeleteAudit(_intent, { photoIds: [photo.id], bookCount: affected, cascadeBooks, userId: user?.uid });
      try {
        setDeletingPhotoId(photo.id);
        const result = await deleteLibraryPhotoAndBooks(user.uid, photo.id, cascadeBooks, true, imageHash, 'PhotosScreen', affected);
        if (!result.ok) {
          Alert.alert('Delete failed', result.error ?? 'Could not delete this scan photo.');
          return;
        }
        // Only remove local approved books if cascade; detach-only keeps them
        await removePhotoLocally(photo.id, cascadeBooks ? affected : 0);
      } finally {
        setDeletingPhotoId(null);
      }
    };

    if (hasBooks) {
      Alert.alert(
        'Delete scan photo',
        `This photo has ${affected} ${bookLabel} in your library.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete Photo Only', onPress: () => doDelete(false) },
          { text: `Delete Photo + ${bookLabel}`, style: 'destructive', onPress: () => doDelete(true) },
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
  }, [user?.uid, deletingPhotoId, removePhotoLocally]);


 const keyExtractor = useCallback((item: { photo: Photo }, index: number) => {
 return canonicalPhotoListKey(item.photo) || item.photo.id || `ph_${index}`;
 }, []);

 const renderPhotoItem = useCallback<ListRenderItem<{ photo: Photo; bookCount: number; thumbnailUri: string | null; isProcessingZeroBooks: boolean }>>(({ item }) => {
 const count = item.bookCount ?? countsByPhotoId.get(canon(item.photo.id)) ?? 0;
 return (
 <PhotoGridItem
 photo={item.photo}
 count={count}
 thumbnailUri={item.thumbnailUri}
 isProcessingZeroBooks={item.isProcessingZeroBooks}
 itemWidth={gridItemWidth}
 itemHeight={gridItemHeight}
 gridGap={gridGap}
 onOpen={openPhotoDetail}
 onDelete={confirmDeletePhoto}
 isDeleting={deletingPhotoId === item.photo.id}
 surfaceColor={t.colors.surface2 ?? t.colors.surface}
 deleteIconColor={t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878'}
 />
 );
 }, [countsByPhotoId, openPhotoDetail, confirmDeletePhoto, deletingPhotoId, gridItemWidth, gridItemHeight, gridGap, t.colors.surface, t.colors.surface2, t.colors.accentPrimary, t.colors.accent]);

 // Sanity check: confirm we don't treat "signedUrl not ready" as screen loading.
 const photosNeedingSignedUrl = displayedPhotos.filter((d) => !!d.photo.storage_path).length;
 const loadingReason = isLoading ? 'data_fetch' : 'idle';
 logger.debug('[PHOTOS_TAB_SKELETON]', {
 photos: photos.length,
 approvedBooks: displayBookCount ?? 'null',
 photosNeedingSignedUrl,
 signedUrlCount: 'N/A (per-tile)',
 isLoading,
 reason: loadingReason,
 });

 return (
 <View style={[styles.screen, { backgroundColor: t.colors.bg }]}>
 <AppHeader title="My Photos" onBack={() => navigation.goBack()} />
 {isLoading ? (
 <View style={styles.emptyState}>
 <Text style={[styles.emptySubtext, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>Loading photos</Text>
 </View>
 ) : displayedPhotos.length === 0 ? (
 <View style={styles.emptyState}>
 <Text style={[styles.emptyTitle, { color: t.colors.textPrimary ?? t.colors.text }]}>No Photos Yet</Text>
 <Text style={[styles.emptySubtext, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>
 Your uploaded photos will appear here
 </Text>
 </View>
 ) : (
 <>
 <View style={[styles.recentScansHeader, { borderBottomColor: t.colors.border }]}>
   <Text style={[styles.recentScansTitle, { color: t.colors.textMuted ?? t.colors.textSecondary }]}>Recent scans</Text>
   <Text style={[styles.recentScansSubtext, { color: t.colors.textMuted ?? t.colors.textSecondary }]}>
     {displayedPhotos.length} photo{displayedPhotos.length !== 1 ? 's' : ''} · newest first
   </Text>
 </View>
 <FlashList
   key={`photos-grid-${photoColumns}`}
   data={displayedPhotos}
   keyExtractor={keyExtractor}
   numColumns={photoColumns}
   removeClippedSubviews={true}
   drawDistance={screenWidth}
   contentContainerStyle={listContentStyle}
   renderItem={renderPhotoItem}
 />
 </>
 )}
 </View>
 );
}

type PhotoGridItemProps = {
 photo: Photo;
 /** Book count from counts map; badge shows this and is not gated on image loading. */
 count: number;
 thumbnailUri: string | null;
 /** True when photo is complete/draft/stalled but has 0 books — show "Processing / Tap to view results". */
 isProcessingZeroBooks: boolean;
 itemWidth: number;
 itemHeight: number;
 gridGap: number;
 onOpen: (photo: Photo) => void;
 onDelete: (photo: Photo, bookCount: number) => void;
 isDeleting: boolean;
 surfaceColor: string;
 deleteIconColor: string;
};

const PhotoGridItem = memo(function PhotoGridItem({
 photo,
 count,
 thumbnailUri,
 isProcessingZeroBooks,
 itemWidth,
 itemHeight,
 gridGap,
 onOpen,
 onDelete,
 isDeleting,
 surfaceColor,
 deleteIconColor,
}: PhotoGridItemProps) {
 return (
 <TouchableOpacity
 style={[
 styles.gridItem,
 {
 width: itemWidth,
 marginBottom: gridGap,
 },
 ]}
 onPress={() => onOpen(photo)}
 activeOpacity={0.9}
 >
 <View style={[styles.gridTile, { width: itemWidth, height: itemHeight, backgroundColor: surfaceColor }]}>
 <PhotoTile
 photoId={photo.id}
 localUri={(photo as { local_uri?: string }).local_uri ?? (photo.uri?.startsWith?.('file://') ? photo.uri : null)}
 storagePath={photo.storage_path}
 fallbackUri={photo.uri}
 thumbnailUri={thumbnailUri}
 signedUrl={photo.signed_url}
 signedUrlExpiresAt={photo.signed_url_expires_at}
 status={photo.status}
 style={[StyleSheet.absoluteFill as any]}
 contentFit="cover"
 thumbnailWidth={itemWidth * 2}
 thumbnailHeight={itemHeight * 2}
 />
 <TouchableOpacity
 style={styles.deleteBadge}
 onPress={() => onDelete(photo, count)}
 activeOpacity={0.85}
 disabled={isDeleting}
 >
 {isDeleting ? (
 <Text style={[styles.deleteBadgeIcon, { color: deleteIconColor }]}></Text>
 ) : (
 <TrashIcon size={14} color={deleteIconColor} />
 )}
 </TouchableOpacity>
 <LinearGradient
 pointerEvents="none"
 colors={['transparent', 'rgba(0,0,0,0.55)']}
 start={{ x: 0.5, y: 0 }}
 end={{ x: 0.5, y: 1 }}
 style={styles.gridOverlayGradient}
 />
 <View style={styles.gridOverlay} pointerEvents="none">
 <Text style={styles.gridOverlayDate}>
 {new Date(photo.timestamp).toLocaleDateString()}
 </Text>
 {photo.caption ? (
 <Text style={styles.gridOverlayCaption} numberOfLines={1}>
 {photo.caption}
 </Text>
 ) : null}
{(photo.status === 'draft' || photo.status === 'stalled') && count === 0 ? (
 <View style={styles.gridOverlayScanningRow}>
  <ActivityIndicator size="small" color="rgba(255,255,255,0.9)" />
  <Text style={styles.gridOverlayBooks}>Scanning…</Text>
 </View>
) : isProcessingZeroBooks ? (
 <Text style={styles.gridOverlayBooks}>Processing / Results pending</Text>
) : (
 <Text style={styles.gridOverlayBooks}>
  {count > 0 ? `${count} book${count !== 1 ? 's' : ''}` : '0 books'}
 </Text>
)}
 </View>
 </View>
 </TouchableOpacity>
 );
}, (prev, next) => {
 return prev.photo.id === next.photo.id
 && prev.photo.storage_path === next.photo.storage_path
 && prev.photo.uri === next.photo.uri
 && prev.photo.caption === next.photo.caption
 && prev.photo.timestamp === next.photo.timestamp
 && prev.photo.status === next.photo.status
 && prev.count === next.count
 && prev.isProcessingZeroBooks === next.isProcessingZeroBooks
 && prev.itemWidth === next.itemWidth
 && prev.itemHeight === next.itemHeight
 && prev.gridGap === next.gridGap
 && prev.surfaceColor === next.surfaceColor
 && prev.deleteIconColor === next.deleteIconColor
 && prev.isDeleting === next.isDeleting
 && prev.onOpen === next.onOpen
 && prev.onDelete === next.onDelete;
});

const styles = StyleSheet.create({
 screen: {
 flex: 1,
 },
 emptyState: {
 flex: 1,
 alignItems: 'center',
 justifyContent: 'center',
 paddingHorizontal: 20,
 },
 emptyTitle: {
 fontSize: 22,
 fontWeight: '700',
 marginBottom: 8,
 },
 emptySubtext: {
 fontSize: 14,
 textAlign: 'center',
 },
 gridContent: {
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 paddingTop: 12,
 },
 recentScansHeader: {
 paddingHorizontal: 12,
 paddingTop: 12,
 paddingBottom: 8,
 borderBottomWidth: StyleSheet.hairlineWidth,
 marginBottom: 4,
 },
 recentScansTitle: {
 fontSize: 15,
 fontWeight: '600',
 marginBottom: 2,
 },
 recentScansSubtext: {
 fontSize: 12,
 },
 gridRow: {
 justifyContent: 'flex-start',
 gap: 8,
 },
 gridItem: {
 },
 gridTile: {
 borderRadius: 12,
 overflow: 'hidden',
 },
 gridOverlayGradient: {
 position: 'absolute',
 left: 0,
 right: 0,
 bottom: 0,
 height: 68,
 zIndex: 1,
 },
 gridOverlay: {
 position: 'absolute',
 left: 0,
 right: 0,
 bottom: 0,
 paddingVertical: 10,
 paddingHorizontal: 12,
 zIndex: 2,
 },
 gridOverlayDate: {
 fontSize: 12,
 color: '#FFFFFF',
 opacity: 0.9,
 fontWeight: '600',
 marginBottom: 2,
 textShadowColor: 'rgba(0,0,0,0.35)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 gridOverlayCaption: {
 fontSize: 14,
 color: '#FFFFFF',
 fontWeight: '600',
 marginBottom: 2,
 textShadowColor: 'rgba(0,0,0,0.35)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 gridOverlayScanningRow: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 6,
 },
 gridOverlayBooks: {
 fontSize: 12,
 color: 'rgba(255,255,255,0.88)',
 fontWeight: '500',
 textShadowColor: 'rgba(0,0,0,0.3)',
 textShadowOffset: { width: 0, height: 1 },
 textShadowRadius: 2,
 },
 deleteBadge: {
 position: 'absolute',
 top: 8,
 right: 8,
 width: 26,
 height: 26,
 borderRadius: 13,
 alignItems: 'center',
 justifyContent: 'center',
 backgroundColor: 'rgba(0,0,0,0.42)',
 borderWidth: 1,
 borderColor: 'rgba(255,255,255,0.2)',
 zIndex: 5,
 },
 deleteBadgeIcon: {
 fontSize: 14,
 fontWeight: '700',
 lineHeight: 16,
 },
});
