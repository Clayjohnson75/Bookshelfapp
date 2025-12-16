import React, { useState, useEffect, useMemo } from 'react';
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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/SimpleAuthContext';
import UserProfileModal from '../components/UserProfileModal';
import { Ionicons } from '@expo/vector-icons';

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

  useEffect(() => {
    const delayedSearch = setTimeout(async () => {
      if (searchQuery.length >= 2) {
        setLoading(true);
        const results: SearchResult[] = [];
        
        // Search users if searchType is 'all' or 'users'
        if (searchType === 'all' || searchType === 'users') {
          const userResults = await searchUsers(searchQuery);
          results.push(...userResults.map(user => ({ type: 'user' as const, data: user })));
        }
        
        // Search books if searchType is 'all' or 'books'
        if (searchType === 'all' || searchType === 'books') {
          try {
            const response = await fetch(
              `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=10`
            );
            const data = await response.json();
            if (data.items) {
              results.push(...data.items.map((book: BookResult) => ({ type: 'book' as const, data: book })));
            }
          } catch (error) {
            console.error('Book search failed:', error);
          }
        }
        
        // Search authors if searchType is 'all' or 'authors'
        if (searchType === 'all' || searchType === 'authors') {
          try {
            const response = await fetch(
              `https://www.googleapis.com/books/v1/volumes?q=inauthor:${encodeURIComponent(searchQuery)}&maxResults=10`
            );
            const data = await response.json();
            if (data.items) {
              results.push(...data.items.map((book: BookResult) => ({ type: 'book' as const, data: book })));
            }
          } catch (error) {
            console.error('Author search failed:', error);
          }
        }
        
        setSearchResults(results);
        setLoading(false);
      } else {
        setSearchResults([]);
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

  const renderBookItem = ({ item }: { item: BookResult }) => {
    const vi = item.volumeInfo;
    const title = vi.title || 'Unknown Title';
    const author = (vi.authors && vi.authors[0]) || 'Unknown Author';
    const coverUrl = vi.imageLinks?.thumbnail?.replace('http:', 'https:');
    
    return (
      <TouchableOpacity style={styles.bookGridCard} activeOpacity={0.7}>
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

  const renderHeader = () => (
    <>
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

      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.searchContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search users, books, or authors..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={Keyboard.dismiss}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              style={styles.clearButton}
              onPress={() => {
                setSearchQuery('');
                Keyboard.dismiss();
              }}
            >
              <Ionicons name="close-circle" size={24} color="#718096" />
            </TouchableOpacity>
          )}
        </View>
      </TouchableWithoutFeedback>
    </>
  );

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
            <Text style={styles.sectionTitle}>Users ({users.length})</Text>
            {users.map((user) => (
              <View key={user.uid}>
                {renderUserItem({ item: user })}
              </View>
            ))}
          </View>
        )}
        
        {books.length > 0 && (
          <View style={styles.sectionContainer}>
            <Text style={styles.sectionTitle}>Books ({books.length})</Text>
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
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.safeContainer}>
      <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
        <FlatList
          data={[]}
          renderItem={() => null}
          ListHeaderComponent={renderHeader}
          ListFooterComponent={renderContent}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={Keyboard.dismiss}
          style={styles.container}
          contentContainerStyle={{ flexGrow: 1 }}
        />
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
});
