import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
 View,
 Text,
 StyleSheet,
 TextInput,
 FlatList,
 TouchableOpacity,
 ActivityIndicator,
 Keyboard,
 TouchableWithoutFeedback,
 Image,
 Dimensions,
 Alert,
 ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { getEnvVar } from '../lib/getEnvVar';
import { useAuth } from '../auth/SimpleAuthContext';
import UserProfileModal from '../components/UserProfileModal';
import { TabHeader } from '../components/TabHeader';
import { BookOutlineIcon, CloseCircleIcon, SearchIcon } from '../components/Icons';
import { useTheme } from '../theme/ThemeProvider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book } from '../types/BookTypes';

interface User {
 uid: string;
 email: string;
 username: string;
 displayName?: string;
}

interface BookResult {
 id: string;
 volumeInfo: {
 title: string;
 authors?: string[];
 imageLinks?: {
 thumbnail?: string;
 };
 averageRating?: number;
 ratingsCount?: number;
 description?: string;
 };
}

type SearchResult = { type: 'user'; data: User } | { type: 'book'; data: BookResult };

export const ExploreTab: React.FC = () => {
 const insets = useSafeAreaInsets();
 const { searchUsers, user: currentUser } = useAuth();
 const [dimensions, setDimensions] = useState(Dimensions.get('window'));
 
 useEffect(() => {
 const subscription = Dimensions.addEventListener('change', ({ window }) => {
 setDimensions(window);
 });
 return () => subscription?.remove();
 }, []);
 
 const screenWidth = dimensions.width || 375; // Fallback to default width
 const screenHeight = dimensions.height || 667; // Fallback to default height
 
 const [searchQuery, setSearchQuery] = useState('');
 const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
 const [loading, setLoading] = useState(false);
 const [selectedUser, setSelectedUser] = useState<User | null>(null);
 const [showProfileModal, setShowProfileModal] = useState(false);
 const [searchType, setSearchType] = useState<'all' | 'users' | 'books' | 'authors'>('all');
 const searchInputRef = useRef<TextInput>(null);
 const [bookPage, setBookPage] = useState(0);
 const [hasMoreBooks, setHasMoreBooks] = useState(true);
 const [isLoadingMore, setIsLoadingMore] = useState(false);
 const { t } = useTheme();

 const styles = useMemo(() => getStyles(screenWidth, t), [screenWidth, t]);

 const loadBooks = async (query: string, page: number, isAuthorSearch: boolean = false) => {
 try {
 const startIndex = page * 20;
 let queryParam: string;
 
 if (isAuthorSearch) {
 queryParam = `inauthor:${encodeURIComponent(query)}`;
 } else {
 // For book searches, try to find popular editions by searching for the title
 // and prioritizing books with ratings and more metadata
 queryParam = `intitle:${encodeURIComponent(query)}`;
 }
 
 // Use 'newest' orderBy first to get more complete/popular editions, 
 // but we'll also try 'relevance' as a fallback
 // Actually, 'relevance' should work better for popular books, but let's add langRestrict for English
 // Use proxy API route to get API key and rate limiting
 // Canonical URL: always use www.bookshelfscan.app
 const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
 const response = await fetch(
 `${baseUrl}/api/google-books?path=/volumes&q=${encodeURIComponent(queryParam)}&maxResults=20&startIndex=${startIndex}&orderBy=relevance&langRestrict=en`
 );
 
 if (!response.ok) {
 console.error(`Google Books API error: ${response.status} ${response.statusText}`);
 return { items: [], totalItems: 0, hasMore: false };
 }
 
 const data = await response.json();
 
 // Sort results to prioritize popular books (those with ratings, descriptions, etc.)
 let items = data.items || [];
 if (items.length > 0 && !isAuthorSearch) {
 // Sort by: has rating > has description > has more metadata
 items.sort((a: BookResult, b: BookResult) => {
 const aRating = a.volumeInfo?.averageRating || 0;
 const bRating = b.volumeInfo?.averageRating || 0;
 const aHasDesc = a.volumeInfo?.description ? 1 : 0;
 const bHasDesc = b.volumeInfo?.description ? 1 : 0;
 const aHasImage = a.volumeInfo?.imageLinks ? 1 : 0;
 const bHasImage = b.volumeInfo?.imageLinks ? 1 : 0;
 
 // Prioritize books with ratings
 if (aRating > 0 && bRating === 0) return -1;
 if (bRating > 0 && aRating === 0) return 1;
 if (aRating > 0 && bRating > 0) {
 // If both have ratings, sort by rating count or rating value
 const aRatingsCount = a.volumeInfo?.ratingsCount || 0;
 const bRatingsCount = b.volumeInfo?.ratingsCount || 0;
 if (aRatingsCount !== bRatingsCount) {
 return bRatingsCount - aRatingsCount; // More ratings = more popular
 }
 return bRating - aRating; // Higher rating = better
 }
 
 // Then prioritize books with descriptions
 if (aHasDesc !== bHasDesc) {
 return bHasDesc - aHasDesc;
 }
 
 // Then prioritize books with images
 if (aHasImage !== bHasImage) {
 return bHasImage - aHasImage;
 }
 
 return 0;
 });
 }
 
 return {
 items: items,
 totalItems: data.totalItems || 0,
 hasMore: (items.length === 20 && (startIndex + 20) < (data.totalItems || 0))
 };
 } catch (error) {
 console.error('Book search failed:', error);
 return { items: [], totalItems: 0, hasMore: false };
 }
 };

 useEffect(() => {
 const delayedSearch = setTimeout(async () => {
 if (searchQuery.length >= 2) {
 setLoading(true);
 setBookPage(0);
 setHasMoreBooks(true);
 const results: SearchResult[] = [];
 
 // Search users if searchType is 'all' or 'users'
 if (searchType === 'all' || searchType === 'users') {
 const userResults = await searchUsers(searchQuery);
 results.push(...userResults.map(user => ({ type: 'user' as const, data: user })));
 }
 
 // Search books if searchType is 'all' or 'books'
 if (searchType === 'all' || searchType === 'books') {
 const bookData = await loadBooks(searchQuery, 0, false);
 results.push(...bookData.items.map((book: BookResult) => ({ type: 'book' as const, data: book })));
 setHasMoreBooks(bookData.hasMore);
 }
 
 // Search authors if searchType is 'authors' (not 'all' to avoid duplicate books)
 if (searchType === 'authors') {
 const bookData = await loadBooks(searchQuery, 0, true);
 results.push(...bookData.items.map((book: BookResult) => ({ type: 'book' as const, data: book })));
 setHasMoreBooks(bookData.hasMore);
 }
 
 setSearchResults(results);
 setLoading(false);
 } else {
 setSearchResults([]);
 setBookPage(0);
 setHasMoreBooks(true);
 }
 }, 300);

 return () => clearTimeout(delayedSearch);
 }, [searchQuery, searchUsers, searchType]);

 const handleUserPress = (user: User) => {
 setSelectedUser(user);
 setShowProfileModal(true);
 };

 const { users, books } = useMemo(() => {
 const userResults = searchResults.filter(r => r.type === 'user').map(r => r.data as User);
 const bookResults = searchResults.filter(r => r.type === 'book').map(r => r.data as BookResult);
 return { users: userResults, books: bookResults };
 }, [searchResults]);

 const contextualSearchPlaceholder = useMemo(() => {
 if (searchType === 'authors') return 'Search authors';
 if (searchType === 'users') return 'Search people';
 if (searchType === 'books') return 'Search books';
 return 'Search books, people, authors';
 }, [searchType]);

 const contextualPlaceholderSubtext = useMemo(() => {
 if (searchType === 'authors') return 'Search authors to discover libraries that love them.';
 if (searchType === 'users') return 'Search people to discover their libraries.';
 if (searchType === 'books') return 'Search books to add to your library.';
 return 'Start typing to explore';
 }, [searchType]);

 const renderUserItem = ({ item }: { item: User }) => (
 <TouchableOpacity
 style={styles.userCard}
 onPress={() => handleUserPress(item)}
 >
 <View style={styles.avatarContainer}>
 <Text style={styles.avatarText}>
 {item.displayName?.charAt(0).toUpperCase() || item.username.charAt(0).toUpperCase()}
 </Text>
 </View>
 <View style={styles.userInfo}>
 <Text style={styles.username}>@{item.username}</Text>
 {item.displayName && (
 <Text style={styles.displayName}>{item.displayName}</Text>
 )}
 </View>
 <Text style={styles.arrow}></Text>
 </TouchableOpacity>
 );

 const handleBookPress = async (book: BookResult) => {
 if (!currentUser) {
 Alert.alert('Error', 'You must be logged in to add books to your library.');
 return;
 }

 const vi = book.volumeInfo;
 const title = vi.title || 'Unknown Title';
 const author = (vi.authors && vi.authors[0]) || 'Unknown Author';
 const coverUrl = vi.imageLinks?.thumbnail?.replace('http:', 'https:');
 
 // Check if book already exists in library
 try {
 const userApprovedKey = `approved_books_${currentUser.uid}`;
 const storedApproved = await AsyncStorage.getItem(userApprovedKey);
 const approvedBooks: Book[] = storedApproved ? JSON.parse(storedApproved) : [];
 
 // Normalize for comparison
 const normalize = (s?: string) => {
 if (!s) return '';
 return s.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ');
 };
 const normalizeTitle = (t?: string) => normalize(t).replace(/^(the|a|an)\s+/, '').trim();
 const normalizeAuthor = (a?: string) => normalize(a).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
 const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
 
 const newBookKey = `${normalizeTitle(title)}|${normalizeAuthor(author)}`;
 const alreadyExists = approvedBooks.some(b => makeKey(b) === newBookKey);
 
 if (alreadyExists) {
 Alert.alert('Duplicate Book', `"${title}" is already in your library.`);
 return;
 }
 
 Alert.alert(
 title,
 `Author: ${author}\n\nWould you like to add this book to your library?`,
 [
 {
 text: 'Cancel',
 style: 'cancel',
 },
 {
 text: 'Add to Library',
 onPress: async () => {
 try {
 const newBook: Book = {
 id: `explore_${book.id}_${Date.now()}`,
 title,
 author,
 status: 'approved',
 scannedAt: Date.now(),
 coverUrl: coverUrl,
 googleBooksId: book.id,
 } as Book;

 const updatedApproved = [...approvedBooks, newBook];
 await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedApproved));
 Alert.alert('Success', `"${title}" has been added to your library!`);
 } catch (error) {
 console.error('Error adding book to library:', error);
 Alert.alert('Error', 'Failed to add book to library. Please try again.');
 }
 },
 },
 ]
 );
 } catch (error) {
 console.error('Error checking library:', error);
 Alert.alert('Error', 'Failed to check library. Please try again.');
 }
 };

 const renderBookItem = ({ item }: { item: BookResult }) => {
 const vi = item.volumeInfo;
 const title = vi.title || 'Unknown Title';
 const author = (vi.authors && vi.authors[0]) || 'Unknown Author';
 const coverUrl = vi.imageLinks?.thumbnail?.replace('http:', 'https:');
 
 return (
 <TouchableOpacity 
 style={styles.bookGridCard} 
 activeOpacity={0.7}
 onPress={() => handleBookPress(item)}
 >
 {coverUrl ? (
 <Image source={{ uri: coverUrl }} style={styles.bookGridCover} />
 ) : (
 <View style={[styles.bookGridCover, styles.bookGridPlaceholder]}>
 <BookOutlineIcon size={24} color="#a0aec0" />
 </View>
 )}
 <View style={styles.bookGridInfo}>
 <Text style={styles.bookGridTitle} numberOfLines={2}>{title}</Text>
 {author && (
 <Text style={styles.bookGridAuthor} numberOfLines={1}>{author}</Text>
 )}
 </View>
 </TouchableOpacity>
 );
 };


 const renderContent = () => {
 if (loading) {
 return (
 <View style={styles.loadingContainer}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 </View>
 );
 }

 if (searchQuery.length < 2) {
 return (
 <View style={styles.placeholderContainer}>
 <BookOutlineIcon size={40} color={t.colors.textMuted ?? '#6B6B6B'} style={styles.placeholderIcon} />
 <Text style={[styles.placeholderHeadline, { color: t.colors.text }]}>
 Discover libraries, books, and readers
 </Text>
 <Text style={[styles.placeholderSubtext, { color: t.colors.textMuted }]}>
 {contextualPlaceholderSubtext}
 </Text>
 </View>
 );
 }

 if (searchResults.length === 0) {
 return (
 <View style={styles.emptyContainer}>
 <Text style={styles.emptyText}>No results found</Text>
 </View>
 );
 }

 // Show users and books separately - render directly to avoid nested VirtualizedList
 return (
 <View style={[styles.resultsList, styles.resultsContent]}>
 {users.length > 0 && (
 <View style={styles.sectionContainer}>
 <Text style={styles.sectionTitle}>Users</Text>
 {users.map((user) => (
 <View key={user.uid}>
 {renderUserItem({ item: user })}
 </View>
 ))}
 </View>
 )}
 
 {books.length > 0 && (
 <View style={styles.sectionContainer}>
 <Text style={styles.sectionTitle}>Books</Text>
 <View style={styles.bookGridContainer}>
 {Array.from({ length: Math.ceil(books.length / 3) }).map((_, rowIndex) => {
 const startIndex = rowIndex * 3;
 const rowBooks = books.slice(startIndex, startIndex + 3);
 return (
 <View key={`row-${rowIndex}`} style={styles.bookGridRow}>
 {rowBooks.map((book, bi) => (
 <View key={book.id ?? bi} style={styles.bookGridCardWrapper}>
 {renderBookItem({ item: book })}
 </View>
 ))}
 {/* Fill empty slots to maintain grid alignment */}
 {rowBooks.length < 3 && Array.from({ length: 3 - rowBooks.length }).map((_, i) => (
 <View key={`empty-${i}`} style={styles.bookGridCardWrapper} />
 ))}
 </View>
 );
 })}
 </View>
 {hasMoreBooks && (searchType === 'books' || searchType === 'authors' || searchType === 'all') && (
 <TouchableOpacity
 style={styles.loadMoreButton}
 onPress={async () => {
 if (isLoadingMore) return;
 setIsLoadingMore(true);
 const nextPage = bookPage + 1;
 const isAuthorSearch = searchType === 'authors';
 const bookData = await loadBooks(searchQuery, nextPage, isAuthorSearch);
 if (bookData.items.length > 0) {
 const newBooks = bookData.items.map((book: BookResult) => ({ type: 'book' as const, data: book }));
 setSearchResults(prev => [...prev, ...newBooks]);
 setBookPage(nextPage);
 setHasMoreBooks(bookData.hasMore);
 } else {
 setHasMoreBooks(false);
 }
 setIsLoadingMore(false);
 }}
 disabled={isLoadingMore}
 >
 {isLoadingMore ? (
 <ActivityIndicator size="small" color={t.colors.primary} />
 ) : (
 <Text style={styles.loadMoreText}>Load More Books</Text>
 )}
 </TouchableOpacity>
 )}
 </View>
 )}
 </View>
 );
 };

 // Auth gating is at root only (AppWrapper: session ? TabNavigator : AuthStack). No per-screen "if (!session) go login".

 return (
 <View style={styles.safeContainer}>
 <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
 <TabHeader>
 <View style={styles.headerContent}>
 <Text style={styles.title}>Explore</Text>
 <Text style={styles.subtitle}>Search for users, books, or authors</Text>
 </View>
 </TabHeader>

 <View style={styles.headerRail}>
 <View style={styles.searchTypeContainer}>
 <TouchableOpacity
 style={[styles.searchTypeButton, searchType === 'all' && styles.searchTypeButtonActive]}
 onPress={() => {
 setSearchType('all');
 setSearchResults([]);
 }}
 >
 <Text style={[styles.searchTypeText, searchType === 'all' && styles.searchTypeTextActive]} numberOfLines={1} ellipsizeMode="tail">All</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.searchTypeButton, searchType === 'users' && styles.searchTypeButtonActive]}
 onPress={() => {
 setSearchType('users');
 setSearchResults([]);
 }}
 >
 <Text style={[styles.searchTypeText, searchType === 'users' && styles.searchTypeTextActive]} numberOfLines={1} ellipsizeMode="tail">Users</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.searchTypeButton, searchType === 'books' && styles.searchTypeButtonActive]}
 onPress={() => {
 setSearchType('books');
 setSearchResults([]);
 }}
 >
 <Text style={[styles.searchTypeText, searchType === 'books' && styles.searchTypeTextActive]} numberOfLines={1} ellipsizeMode="tail">Books</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.searchTypeButton, searchType === 'authors' && styles.searchTypeButtonActive]}
 onPress={() => {
 setSearchType('authors');
 setSearchResults([]);
 }}
 >
 <Text style={[styles.searchTypeText, searchType === 'authors' && styles.searchTypeTextActive]} numberOfLines={1} ellipsizeMode="tail">Authors</Text>
 </TouchableOpacity>
 </View>
 <View style={[styles.headerRailInnerDivider, { backgroundColor: t.colors.border }]} />
 <View style={styles.searchContainer}>
 <SearchIcon size={18} color={t.colors.textMuted ?? '#718096'} style={styles.searchIcon} />
 <TextInput
 ref={searchInputRef}
 style={styles.searchInput}
 placeholder={contextualSearchPlaceholder}
 value={searchQuery}
 onChangeText={setSearchQuery}
 autoCapitalize="none"
 autoCorrect={false}
 returnKeyType="search"
 onSubmitEditing={() => Keyboard.dismiss()}
 blurOnSubmit={false}
 />
 {searchQuery.length > 0 && (
 <TouchableOpacity
 style={styles.clearButton}
 onPress={() => {
 setSearchQuery('');
 searchInputRef.current?.focus();
 }}
 >
 <CloseCircleIcon size={24} color={t.colors.textMuted ?? '#718096'} />
 </TouchableOpacity>
 )}
 </View>
 <View style={[styles.headerRailBottomDivider, { backgroundColor: t.colors.border }]} />
 </View>

 <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
 <ScrollView
 keyboardShouldPersistTaps="handled"
 keyboardDismissMode="on-drag"
 style={styles.container}
 contentContainerStyle={{ flexGrow: 1 }}
 >
 {renderContent()}
 </ScrollView>
 </TouchableWithoutFeedback>
 </SafeAreaView>
 <UserProfileModal
 visible={showProfileModal}
 user={selectedUser}
 onClose={() => {
 setShowProfileModal(false);
 setSelectedUser(null);
 }}
 currentUserId={currentUser?.uid}
 />
 </View>
 );
};

const getStyles = (screenWidth: number, t: { name?: string; colors: { primary: string; bg?: string; screenBackground?: string; surface?: string; surface2?: string; text?: string; textMuted?: string; border?: string; accentTextOn?: string; primaryText?: string } }) => StyleSheet.create({
 safeContainer: {
 flex: 1,
 backgroundColor: t.colors.screenBackground ?? t.colors.bg ?? '#F6F3EE',
 position: 'relative',
 },
 container: {
 flex: 1,
 backgroundColor: t.colors.screenBackground ?? t.colors.bg ?? '#F6F3EE',
 },
 headerContent: {
 paddingTop: 18,
 },
 title: {
 fontSize: 22,
 fontWeight: '700',
 color: t.colors.text ?? '#1F1F1F',
 letterSpacing: 0.5,
 marginBottom: 6,
 },
 subtitle: {
 fontSize: 14,
 color: t.colors.textMuted ?? '#6B6B6B',
 fontWeight: '400',
 },
 headerRail: {
 marginHorizontal: 20,
 marginTop: 12,
 marginBottom: 0,
 paddingTop: 4,
 paddingBottom: 0,
 backgroundColor: 'transparent',
 },
 headerRailInnerDivider: {
 height: StyleSheet.hairlineWidth,
 marginVertical: 12,
 marginHorizontal: 0,
 },
 headerRailBottomDivider: {
 height: StyleSheet.hairlineWidth,
 marginTop: 12,
 marginHorizontal: -20,
 },
 searchTypeContainer: {
 flexDirection: 'row',
 gap: 8,
 paddingHorizontal: 0,
 paddingTop: 0,
 paddingBottom: 0,
 },
 searchTypeButton: {
 flex: 1,
 minWidth: 0,
 paddingVertical: 10,
 paddingHorizontal: 8,
 minHeight: 40,
 borderRadius: 12,
 backgroundColor: t.colors.surface2 ?? '#F0ECE6',
 borderWidth: StyleSheet.hairlineWidth,
 borderColor: t.colors.border ?? '#E8E4DE',
 alignItems: 'center',
 justifyContent: 'center',
 },
 searchTypeButtonActive: {
 backgroundColor: t.colors.primary,
 borderWidth: 0,
 },
 searchTypeText: {
 fontSize: 14,
 fontWeight: '600',
 color: t.colors.textMuted ?? '#505050',
 textAlign: 'center',
 },
 searchTypeTextActive: {
 color: t.colors.accentTextOn ?? t.colors.primaryText ?? '#1F1F1F',
 },
 searchContainer: {
 paddingHorizontal: 0,
 paddingTop: 0,
 paddingBottom: 0,
 position: 'relative',
 },
 searchIcon: {
 position: 'absolute',
 left: 12,
 top: 11,
 zIndex: 2,
 },
 searchInput: {
 backgroundColor: t.colors.surface ?? '#FFFFFF',
 borderRadius: 12,
 paddingVertical: 10,
 paddingHorizontal: 12,
 paddingLeft: 36,
 paddingRight: 46,
 fontSize: 16,
 borderWidth: StyleSheet.hairlineWidth,
 borderColor: t.colors.border ?? '#E8E4DE',
 shadowColor: 'transparent',
 shadowOpacity: 0,
 elevation: 0,
 },
 clearButton: {
 position: 'absolute',
 right: 12,
 top: 8,
 padding: 4,
 },
 loadingContainer: {
 flex: 1,
 justifyContent: 'center',
 alignItems: 'center',
 padding: 32,
 },
 emptyContainer: {
 flex: 1,
 justifyContent: 'flex-start',
 alignItems: 'center',
 paddingTop: 42,
 paddingHorizontal: 32,
 paddingBottom: 32,
 },
 emptyText: {
 fontSize: 16,
 color: t.colors.textMuted ?? '#6B6B6B',
 fontWeight: '500',
 },
 placeholderContainer: {
 flex: 1,
 justifyContent: 'flex-start',
 alignItems: 'center',
 paddingTop: 42,
 paddingHorizontal: 32,
 paddingBottom: 32,
 },
 placeholderIcon: {
 marginBottom: 12,
 },
 placeholderHeadline: {
 fontSize: 17,
 fontWeight: '600',
 textAlign: 'center',
 marginBottom: 6,
 paddingHorizontal: 24,
 color: t.colors.text ?? '#1F1F1F',
 },
 placeholderSubtext: {
 fontSize: 15,
 fontWeight: '400',
 textAlign: 'center',
 paddingHorizontal: 24,
 color: t.colors.textMuted ?? '#6B6B6B',
 },
 placeholderText: {
 fontSize: 16,
 color: t.colors.textMuted ?? '#6B6B6B',
 fontWeight: '500',
 textAlign: 'center',
 },
 resultsList: {
 flex: 1,
 },
 resultsContent: {
 paddingHorizontal: 20,
 paddingTop: 16,
 paddingBottom: 24,
 },
 userCard: {
 backgroundColor: t.colors.surface ?? '#FFFFFF',
 borderRadius: 14,
 padding: 14,
 marginBottom: 10,
 flexDirection: 'row',
 alignItems: 'center',
 borderWidth: StyleSheet.hairlineWidth,
 borderColor: t.colors.border ?? '#E6E1D8',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.04,
 shadowRadius: 6,
 elevation: 1,
 },
 avatarContainer: {
 width: 50,
 height: 50,
 borderRadius: 25,
 backgroundColor: t.colors.primary,
 justifyContent: 'center',
 alignItems: 'center',
 marginRight: 14,
 },
 avatarText: {
 fontSize: 20,
 fontWeight: '700',
 color: t.colors.accentTextOn ?? t.colors.primaryText ?? '#1F1F1F',
 },
 userInfo: {
 flex: 1,
 },
 username: {
 fontSize: 16,
 fontWeight: '700',
 color: t.colors.text ?? '#1F1F1F',
 marginBottom: 4,
 },
 displayName: {
 fontSize: 14,
 color: t.colors.textMuted ?? '#6B6B6B',
 },
 arrow: {
 fontSize: 24,
 color: t.colors.textMuted ?? '#9A9A9A',
 fontWeight: '300',
 },
 sectionContainer: {
 paddingHorizontal: 20,
 paddingTop: 16,
 paddingBottom: 8,
 },
 sectionTitle: {
 fontSize: 18,
 fontWeight: '700',
 color: t.colors.text ?? '#1F1F1F',
 marginBottom: 12,
 },
 bookGridContainer: {
 paddingBottom: 16,
 },
 bookGridRow: {
 flexDirection: 'row',
 justifyContent: 'space-between',
 marginBottom: 12,
 },
 bookGridCardWrapper: {
 width: (screenWidth - 70) / 3 - 12,
 },
 bookGridCard: {
 width: (screenWidth - 70) / 3 - 12,
 alignItems: 'center',
 marginBottom: 12,
 },
 bookGridCover: {
 width: '100%',
 aspectRatio: 2 / 3,
 borderRadius: 8,
 marginBottom: 6,
 backgroundColor: t.colors.surface2 ?? '#F0ECE6',
 },
 bookGridPlaceholder: {
 justifyContent: 'center',
 alignItems: 'center',
 backgroundColor: t.colors.surface2 ?? '#F0ECE6',
 borderWidth: StyleSheet.hairlineWidth,
 borderColor: t.colors.border ?? '#E6E1D8',
 },
 bookGridInfo: {
 width: '100%',
 alignItems: 'center',
 },
 bookGridTitle: {
 fontSize: 13,
 fontWeight: '600',
 color: t.colors.text ?? '#1F1F1F',
 textAlign: 'center',
 marginBottom: 2,
 lineHeight: 16,
 },
 bookGridAuthor: {
 fontSize: 11,
 color: t.colors.textMuted ?? '#6B6B6B',
 textAlign: 'center',
 lineHeight: 14,
 },
 loadMoreButton: {
 marginTop: 16,
 marginBottom: 8,
 paddingVertical: 12,
 paddingHorizontal: 20,
 backgroundColor: t.colors.primary,
 borderRadius: 10,
 alignItems: 'center',
 justifyContent: 'center',
 minHeight: 44,
 },
 loadMoreText: {
 color: t.colors.accentTextOn ?? t.colors.primaryText ?? '#1F1F1F',
 fontSize: 16,
 fontWeight: '600',
 },
});
