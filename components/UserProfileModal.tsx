import React, { useState, useEffect } from 'react';
import {
 View,
 Text,
 StyleSheet,
 Modal,
 ScrollView,
 TouchableOpacity,
 Image,
 FlatList,
 ActivityIndicator,
 useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { HeartIcon, BookOutlineIcon } from './Icons';
import { useAuth } from '../auth/SimpleAuthContext';
import { useProfileStats, formatCountForDisplay } from '../contexts/ProfileStatsContext';
import { useTheme } from '../theme/ThemeProvider';
import { Book, WishlistItem } from '../types/BookTypes';
import { isGoogleHotlink } from '../lib/coverUtils';
import { AppHeader } from './AppHeader';

interface User {
 uid: string;
 email: string;
 username: string;
 displayName?: string;
}

interface UserProfileModalProps {
 visible: boolean;
 user: User | null;
 onClose: () => void;
 currentUserId?: string;
}

const UserProfileModal: React.FC<UserProfileModalProps> = ({
 visible,
 user,
 onClose,
 currentUserId,
}) => {
 const { user: currentUser } = useAuth();
 const { t } = useTheme();
 const { displayBookCount: profileDisplayBookCount, refreshProfileStats } = useProfileStats();
 const [userBooks, setUserBooks] = useState<Book[]>([]);
 const [currentUserBooks, setCurrentUserBooks] = useState<Book[]>([]);
 const [commonBooks, setCommonBooks] = useState<Book[]>([]);
 const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
 const [loading, setLoading] = useState(true);
 const isOwnProfile = currentUser && user && currentUser.uid === user.uid;
 // Single source: own profile = displayBookCount (gated during rehydrate); other profile = their loaded list length. null = unknown.
 const displayBookCount = isOwnProfile ? profileDisplayBookCount : (loading ? null : userBooks.length);
 const displayBookCountText = formatCountForDisplay(displayBookCount);

 useEffect(() => {
 if (visible && user) {
 if (isOwnProfile) refreshProfileStats();
 loadUserData();
 }
 }, [visible, user, isOwnProfile, refreshProfileStats]);

 const loadUserData = async () => {
 if (!user) return;
 
 setLoading(true);
 try {
 // Load user's approved books
 const userBooksKey = `approved_books_${user.uid}`;
 const userBooksData = await AsyncStorage.getItem(userBooksKey);
 const booksRaw = userBooksData ? (() => { try { return JSON.parse(userBooksData); } catch { return []; } })() : [];
 const books = Array.isArray(booksRaw) ? booksRaw : [];
 setUserBooks(books);

 // Load current user's approved books for comparison
 if (currentUser && currentUser.uid !== user.uid) {
 const currentBooksKey = `approved_books_${currentUser.uid}`;
 const currentBooksData = await AsyncStorage.getItem(currentBooksKey);
 const currentBooksRaw = currentBooksData ? (() => { try { return JSON.parse(currentBooksData); } catch { return []; } })() : [];
 const currentBooks = Array.isArray(currentBooksRaw) ? currentBooksRaw : [];
 setCurrentUserBooks(currentBooks);

 // Calculate common books
 const common = books.filter((book: Book) =>
 currentBooks.some(
 (currentBook: Book) =>
 currentBook.title === book.title &&
 currentBook.author === book.author
 )
 );
 setCommonBooks(common);
 }

 // Load wishlist if viewing own profile
 if (isOwnProfile) {
 const wishlistKey = `wishlist_${user.uid}`;
 const wishlistData = await AsyncStorage.getItem(wishlistKey);
 const wishlistRaw = wishlistData ? (() => { try { return JSON.parse(wishlistData); } catch { return []; } })() : [];
 setWishlist(Array.isArray(wishlistRaw) ? wishlistRaw : []);
 }
 } catch (error) {
 console.error('Error loading user data:', error);
 } finally {
 setLoading(false);
 }
 };

 const getBookCoverUri = (book: Book): string | undefined => {
 // In production builds, prefer remote URL (more reliable)
 if (book.coverUrl) {
 if (isGoogleHotlink(book.coverUrl)) return undefined; // Never render Google hotlinks - they fail in RN
 return book.coverUrl;
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

 const { width: screenWidth } = useWindowDimensions();
 const profileGridItemWidth = (screenWidth - 40 - 10 * 3) / 4; // content padding 20*2, gap 10*3

 const renderBook = ({ item }: { item: Book }) => (
 <View style={styles.bookCard}>
 {getBookCoverUri(item) && (
 <Image source={{ uri: getBookCoverUri(item) }} style={styles.bookCover} />
 )}
 <View style={styles.bookInfo}>
 <Text style={styles.bookTitle}>{item.title}</Text>
 {item.author && <Text style={styles.bookAuthor}>by {item.author}</Text>}
 </View>
 </View>
 );

 /** Same grid tile as Pending Books: cover + author (4 per row). */
 const renderBookGridItem = ({ item, index }: { item: Book; index: number }) => {
 const coverUri = getBookCoverUri(item);
 return (
 <View style={[styles.profileGridItem, { width: profileGridItemWidth }, index % 4 === 3 && styles.profileGridItemEnd]}>
 <View style={styles.profileGridCoverWrapper}>
 {coverUri ? (
 <Image source={{ uri: coverUri }} style={styles.profileGridCover} />
 ) : (
 <View style={[styles.profileGridCover, styles.profileGridPlaceholder]}>
 <Text style={[styles.profileGridPlaceholderText, { color: t.colors.textMuted }]} numberOfLines={3}>{item.title}</Text>
 </View>
 )}
 </View>
 <View style={styles.profileGridTextBlock}>
 {item.author ? (
 <Text style={[styles.profileBookAuthor, { color: t.colors.textMuted }]} numberOfLines={2} ellipsizeMode="tail">
 {item.author}
 </Text>
 ) : item.title ? (
 <Text style={[styles.profileBookAuthor, { color: t.colors.textMuted }]} numberOfLines={2} ellipsizeMode="tail">
 {item.title}
 </Text>
 ) : null}
 </View>
 </View>
 );
 };

 if (!user) return null;

 return (
 <Modal
 visible={visible}
 animationType="none"
 presentationStyle="fullScreen"
 onRequestClose={onClose}
 >
 <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg ?? '#F6F3EE' }]} edges={['left', 'right', 'bottom']}>
 <AppHeader title="Profile" onBack={onClose} />

 {loading ? (
 <View style={styles.loadingContainer}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 </View>
 ) : (
 <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
 {/* Single profile card: avatar, name, stats (warm beige, same family as Pending Books) */}
 <View style={[styles.profileCard, { backgroundColor: t.colors.surface2 ?? t.colors.surface ?? '#F0ECE6' }]}>
 <View style={[styles.avatarContainer, { backgroundColor: t.colors.primary }]}>
 <Text style={styles.avatarText}>
 {user.displayName?.charAt(0).toUpperCase() || user.username.charAt(0).toUpperCase()}
 </Text>
 </View>
 <Text style={[styles.username, { color: t.colors.text ?? '#1a202c' }]}>@{user.username}</Text>
 {user.displayName && (
 <Text style={[styles.displayName, { color: t.colors.textMuted ?? '#718096' }]}>{user.displayName}</Text>
 )}
 <View style={styles.statsRow}>
 <View style={styles.statCard}>
 <Text style={[styles.statNumber, { color: t.colors.text ?? '#1a202c' }]}>{displayBookCountText}</Text>
 <Text style={[styles.statLabel, { color: t.colors.textMuted ?? '#718096' }]}>Books</Text>
 </View>
 {isOwnProfile && (
 <View style={styles.statCard}>
 <Text style={[styles.statNumber, { color: t.colors.text ?? '#1a202c' }]}>{wishlist.length}</Text>
 <Text style={[styles.statLabel, { color: t.colors.textMuted ?? '#718096' }]}>Wishlist</Text>
 </View>
 )}
 {!isOwnProfile && (
 <View style={styles.statCard}>
 <Text style={[styles.statNumber, { color: t.colors.text ?? '#1a202c' }]}>{commonBooks.length}</Text>
 <Text style={[styles.statLabel, { color: t.colors.textMuted ?? '#718096' }]}>In Common</Text>
 </View>
 )}
 </View>
 </View>

 {/* Common Books Section (if viewing another user) */}
 {currentUser && currentUser.uid !== user.uid && commonBooks.length > 0 && (
 <View style={[styles.section, { backgroundColor: t.colors.surface ?? '#FFFFFF' }]}>
 <Text style={[styles.sectionTitle, { color: t.colors.text ?? '#1a202c' }]}>Books in Common ({commonBooks.length})</Text>
 <FlatList
 data={commonBooks}
 renderItem={renderBook}
 keyExtractor={(item, index) => item.id || `common-${index}`}
 horizontal
 showsHorizontalScrollIndicator={false}
 contentContainerStyle={styles.booksList}
 />
 </View>
 )}

 {/* Wishlist Section (only for own profile) */}
 {isOwnProfile && (
 <View style={[styles.section, { backgroundColor: t.colors.surface ?? '#FFFFFF' }]}>
 <View style={styles.sectionHeader}>
 <HeartIcon size={24} color="#ed64a6" />
 <Text style={[styles.sectionTitle, { color: t.colors.text ?? '#1a202c' }]}>My Wishlist ({wishlist.length})</Text>
 </View>
 {wishlist.length === 0 ? (
 <View style={styles.emptyState}>
 <Text style={[styles.emptyText, { color: t.colors.textMuted }]}>Your wishlist is empty</Text>
 <Text style={[styles.emptySubtext, { color: t.colors.textMuted }]}>Add books from the Explore tab</Text>
 </View>
 ) : (
 <FlatList
 data={wishlist}
 renderItem={renderBookGridItem}
 keyExtractor={(item, index) => item.id || `wishlist-${index}`}
 numColumns={4}
 scrollEnabled={false}
 contentContainerStyle={styles.profileGridContent}
 columnWrapperStyle={styles.profileGridRow}
 />
 )}
 </View>
 )}

 {/* All Books / Their Books 4-col grid (same as Pending Books): cover + author */}
 <View style={[styles.section, { backgroundColor: t.colors.surface ?? '#FFFFFF' }]}>
 <Text style={[styles.sectionTitle, { color: t.colors.text ?? '#1a202c' }]}>
 {isOwnProfile ? 'My Books' : 'Their Books'} ({displayBookCountText})
 </Text>
 {userBooks.length === 0 ? (
 <View style={styles.emptyState}>
 <BookOutlineIcon size={40} color={t.colors.textMuted ?? '#9A9A9A'} style={styles.emptyStateIcon} />
 <Text style={[styles.emptyText, { color: t.colors.text ?? '#1a202c' }]}>No books yet</Text>
 <Text style={[styles.emptySubtext, { color: t.colors.textMuted }]}>
 {isOwnProfile ? 'Add books by scanning or from Explore.' : "This reader hasn't added any books."}
 </Text>
 </View>
 ) : (
 <FlatList
 data={userBooks}
 renderItem={renderBookGridItem}
 keyExtractor={(item, index) => item.id || `book-${index}`}
 numColumns={4}
 scrollEnabled={false}
 contentContainerStyle={styles.profileGridContent}
 columnWrapperStyle={styles.profileGridRow}
 />
 )}
 </View>
 </ScrollView>
 )}
 </SafeAreaView>
 </Modal>
 );
};

const styles = StyleSheet.create({
 container: {
 flex: 1,
 },
 loadingContainer: {
 flex: 1,
 justifyContent: 'center',
 alignItems: 'center',
 },
 content: {
 flex: 1,
 },
 contentContainer: {
 paddingHorizontal: 20,
 paddingBottom: 24,
 },
 /** Single rounded profile card (avatar + name + stats), warm beige like Pending Books. */
 profileCard: {
 borderRadius: 18,
 padding: 20,
 marginBottom: 20,
 alignItems: 'center',
 },
 avatarContainer: {
 width: 80,
 height: 80,
 borderRadius: 40,
 justifyContent: 'center',
 alignItems: 'center',
 marginBottom: 12,
 },
 avatarText: {
 fontSize: 36,
 fontWeight: '700',
 color: '#ffffff',
 },
 username: {
 fontSize: 20,
 fontWeight: '700',
 marginBottom: 4,
 },
 displayName: {
 fontSize: 16,
 marginBottom: 16,
 },
 statsRow: {
 flexDirection: 'row',
 justifyContent: 'center',
 gap: 24,
 flexWrap: 'wrap',
 },
 statCard: {
 alignItems: 'center',
 minWidth: 80,
 },
 statNumber: {
 fontSize: 34,
 fontWeight: '800',
 marginBottom: 4,
 },
 statLabel: {
 fontSize: 14,
 fontWeight: '500',
 opacity: 0.82,
 },
 section: {
 marginBottom: 20,
 padding: 20,
 borderRadius: 16,
 },
 sectionHeader: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 8,
 marginBottom: 15,
 },
 sectionTitle: {
 fontSize: 20,
 fontWeight: '800',
 color: '#1a202c',
 letterSpacing: 0.3,
 },
 booksList: {
 paddingVertical: 10,
 },
 bookRow: {
 justifyContent: 'space-between',
 },
 /** 4-col grid (same as Pending Books): cover + author below. */
 profileGridContent: {
 paddingBottom: 24,
 },
 profileGridRow: {
 flexDirection: 'row',
 gap: 10,
 marginBottom: 10,
 },
 profileGridItem: {},
 profileGridItemEnd: {
 marginRight: 0,
 },
 profileGridCoverWrapper: {
 width: '100%',
 position: 'relative',
 },
 profileGridCover: {
 width: '100%',
 aspectRatio: 1 / 1.45,
 borderRadius: 8,
 marginBottom: 6,
 backgroundColor: 'rgba(0,0,0,0.05)',
 },
 profileGridPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 backgroundColor: 'rgba(0,0,0,0.06)',
 borderRadius: 8,
 },
 profileGridPlaceholderText: {
 fontSize: 11,
 fontWeight: '600',
 textAlign: 'center',
 lineHeight: 14,
 },
 profileGridTextBlock: {
 width: '100%',
 alignItems: 'center',
 marginTop: 4,
 paddingHorizontal: 2,
 },
 profileBookAuthor: {
 fontSize: 12,
 lineHeight: 15,
 marginBottom: 0,
 textAlign: 'center',
 fontWeight: '400',
 },
 bookCard: {
 width: '48%',
 backgroundColor: '#f7fafc',
 borderRadius: 12,
 padding: 12,
 marginBottom: 15,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 },
 bookCover: {
 width: '100%',
 height: 200,
 borderRadius: 8,
 marginBottom: 10,
 backgroundColor: '#e0e0e0',
 },
 bookInfo: {
 alignItems: 'center',
 },
 bookTitle: {
 fontSize: 14,
 fontWeight: '700',
 color: '#1a202c',
 textAlign: 'center',
 marginBottom: 4,
 },
 bookAuthor: {
 fontSize: 12,
 color: '#718096',
 textAlign: 'center',
 fontStyle: 'italic',
 },
 emptyState: {
 padding: 40,
 alignItems: 'center',
 },
 emptyStateIcon: {
 marginBottom: 12,
 },
 emptyText: {
 fontSize: 16,
 fontWeight: '600',
 textAlign: 'center',
 },
 emptySubtext: {
 fontSize: 14,
 textAlign: 'center',
 marginTop: 6,
 },
});

export default UserProfileModal;
