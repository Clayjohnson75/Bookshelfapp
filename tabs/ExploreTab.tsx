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
import { useAuth } from '../auth/SimpleAuthContext';
import UserProfileModal from '../components/UserProfileModal';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book } from '../types/BookTypes';

const { width: screenWidth } = Dimensions.get('window');

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
  };
}

type SearchResult = { type: 'user'; data: User } | { type: 'book'; data: BookResult };

export const ExploreTab: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { searchUsers, user: currentUser } = useAuth();
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

  const loadBooks = async (query: string, page: number, isAuthorSearch: boolean = false) => {
    try {
      const startIndex = page * 20;
      const queryParam = isAuthorSearch 
        ? `inauthor:${encodeURIComponent(query)}`
        : encodeURIComponent(query);
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${queryParam}&maxResults=20&startIndex=${startIndex}&orderBy=relevance`
      );
      const data = await response.json();
      return {
        items: data.items || [],
        totalItems: data.totalItems || 0,
        hasMore: (data.items?.length || 0) === 20 && (startIndex + 20) < (data.totalItems || 0)
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
      <Text style={styles.arrow}>›</Text>
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
            <Ionicons name="book-outline" size={24} color="#a0aec0" />
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
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      );
    }

    if (searchQuery.length < 2) {
      return (
        <View style={styles.placeholderContainer}>
          <Text style={styles.placeholderText}>
            Start typing to search for users, books, or authors...
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
      <View style={{ flex: 1 }}>
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
                    {rowBooks.map((book) => (
                      <View key={book.id} style={styles.bookGridCardWrapper}>
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
                  <ActivityIndicator size="small" color="#007AFF" />
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

  return (
    <View style={styles.safeContainer}>
      <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.header}>
          <Text style={styles.title}>Explore</Text>
          <Text style={styles.subtitle}>Search for users, books, or authors</Text>
        </View>

        <View style={styles.searchTypeContainer}>
          <TouchableOpacity
            style={[styles.searchTypeButton, searchType === 'all' && styles.searchTypeButtonActive]}
            onPress={() => {
              setSearchType('all');
              setSearchResults([]);
            }}
          >
            <Text style={[styles.searchTypeText, searchType === 'all' && styles.searchTypeTextActive]}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.searchTypeButton, searchType === 'users' && styles.searchTypeButtonActive]}
            onPress={() => {
              setSearchType('users');
              setSearchResults([]);
            }}
          >
            <Text style={[styles.searchTypeText, searchType === 'users' && styles.searchTypeTextActive]}>Users</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.searchTypeButton, searchType === 'books' && styles.searchTypeButtonActive]}
            onPress={() => {
              setSearchType('books');
              setSearchResults([]);
            }}
          >
            <Text style={[styles.searchTypeText, searchType === 'books' && styles.searchTypeTextActive]}>Books</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.searchTypeButton, searchType === 'authors' && styles.searchTypeButtonActive]}
            onPress={() => {
              setSearchType('authors');
              setSearchResults([]);
            }}
          >
            <Text style={[styles.searchTypeText, searchType === 'authors' && styles.searchTypeTextActive]}>Authors</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchContainer}>
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Search users, books, or authors..."
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
              <Ionicons name="close-circle" size={24} color="#718096" />
            </TouchableOpacity>
          )}
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

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa', // Match Scans tab
    position: 'relative',
  },
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#2d3748', // Match Scans tab
    paddingTop: 20,
    paddingBottom: 30,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#cbd5e0',
    fontWeight: '400',
  },
  searchTypeContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 15,
    paddingBottom: 5,
    gap: 10,
  },
  searchTypeButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#e2e8f0',
  },
  searchTypeButtonActive: {
    backgroundColor: '#007AFF',
  },
  searchTypeText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4a5568',
  },
  searchTypeTextActive: {
    color: '#ffffff',
  },
  searchContainer: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 20,
    position: 'relative',
  },
  searchInput: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 18,
    paddingRight: 50,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  clearButton: {
    position: 'absolute',
    right: 30,
    top: 25,
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '500',
  },
  placeholderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  placeholderText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '500',
    textAlign: 'center',
  },
  resultsList: {
    flex: 1,
  },
  resultsContent: {
    padding: 20,
  },
  userCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  avatarContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  userInfo: {
    flex: 1,
  },
  username: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
  },
  displayName: {
    fontSize: 14,
    color: '#718096',
  },
  arrow: {
    fontSize: 24,
    color: '#cbd5e0',
    fontWeight: '300',
  },
  sectionContainer: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 15,
  },
  bookGridContainer: {
    paddingBottom: 20,
  },
  bookGridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
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
    backgroundColor: '#e2e8f0',
  },
  bookGridPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bookGridInfo: {
    width: '100%',
    alignItems: 'center',
  },
  bookGridTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 2,
    lineHeight: 16,
  },
  bookGridAuthor: {
    fontSize: 11,
    color: '#718096',
    textAlign: 'center',
    lineHeight: 14,
  },
  loadMoreButton: {
    marginTop: 20,
    marginBottom: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: '#007AFF',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  loadMoreText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
