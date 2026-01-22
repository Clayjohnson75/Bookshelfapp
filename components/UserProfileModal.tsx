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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { useAuth } from '../auth/SimpleAuthContext';
import { Book, WishlistItem } from '../types/BookTypes';

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
  const [userBooks, setUserBooks] = useState<Book[]>([]);
  const [currentUserBooks, setCurrentUserBooks] = useState<Book[]>([]);
  const [commonBooks, setCommonBooks] = useState<Book[]>([]);
  const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const isOwnProfile = currentUser && user && currentUser.uid === user.uid;

  useEffect(() => {
    if (visible && user) {
      loadUserData();
    }
  }, [visible, user]);

  const loadUserData = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      // Load user's approved books
      const userBooksKey = `approved_books_${user.uid}`;
      const userBooksData = await AsyncStorage.getItem(userBooksKey);
      const books = userBooksData ? JSON.parse(userBooksData) : [];
      setUserBooks(books);

      // Load current user's approved books for comparison
      if (currentUser && currentUser.uid !== user.uid) {
        const currentBooksKey = `approved_books_${currentUser.uid}`;
        const currentBooksData = await AsyncStorage.getItem(currentBooksKey);
        const currentBooks = currentBooksData ? JSON.parse(currentBooksData) : [];
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
        const wishlistItems = wishlistData ? JSON.parse(wishlistData) : [];
        setWishlist(wishlistItems);
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

  if (!user) return null;

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Profile</Text>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : (
          <ScrollView style={styles.content}>
            {/* User Info */}
            <View style={styles.userInfoSection}>
              <View style={styles.avatarContainer}>
                <Text style={styles.avatarText}>
                  {user.displayName?.charAt(0).toUpperCase() || user.username.charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.username}>@{user.username}</Text>
              {user.displayName && (
                <Text style={styles.displayName}>{user.displayName}</Text>
              )}
            </View>

            {/* Stats */}
            <View style={styles.statsSection}>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{userBooks.length}</Text>
                <Text style={styles.statLabel}>Books</Text>
              </View>
              {isOwnProfile && (
                <View style={styles.statCard}>
                  <Text style={styles.statNumber}>{wishlist.length}</Text>
                  <Text style={styles.statLabel}>Wishlist</Text>
                </View>
              )}
              {!isOwnProfile && (
                <View style={styles.statCard}>
                  <Text style={styles.statNumber}>{commonBooks.length}</Text>
                  <Text style={styles.statLabel}>In Common</Text>
                </View>
              )}
            </View>

            {/* Common Books Section (if viewing another user) */}
            {currentUser && currentUser.uid !== user.uid && commonBooks.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Books in Common ({commonBooks.length})</Text>
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
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="heart" size={24} color="#ed64a6" />
                  <Text style={styles.sectionTitle}>My Wishlist ({wishlist.length})</Text>
                </View>
                {wishlist.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>Your wishlist is empty</Text>
                    <Text style={styles.emptySubtext}>Add books from the Explore tab</Text>
                  </View>
                ) : (
                  <FlatList
                    data={wishlist}
                    renderItem={renderBook}
                    keyExtractor={(item, index) => item.id || `wishlist-${index}`}
                    numColumns={2}
                    scrollEnabled={false}
                    columnWrapperStyle={styles.bookRow}
                  />
                )}
              </View>
            )}

            {/* All Books Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {isOwnProfile ? 'My Books' : 'Their Books'} ({userBooks.length})
              </Text>
              {userBooks.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>No books yet</Text>
                </View>
              ) : (
                <FlatList
                  data={userBooks}
                  renderItem={renderBook}
                  keyExtractor={(item, index) => item.id || `book-${index}`}
                  numColumns={2}
                  scrollEnabled={false}
                  columnWrapperStyle={styles.bookRow}
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
    backgroundColor: '#f5f7fa',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#1a1a2e',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  closeButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  closeButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  userInfoSection: {
    alignItems: 'center',
    padding: 30,
    backgroundColor: '#ffffff',
    marginBottom: 15,
  },
  avatarContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 15,
  },
  avatarText: {
    fontSize: 36,
    fontWeight: '700',
    color: '#ffffff',
  },
  username: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 5,
  },
  displayName: {
    fontSize: 16,
    color: '#718096',
  },
  statsSection: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    padding: 20,
    backgroundColor: '#ffffff',
    marginBottom: 15,
  },
  statCard: {
    alignItems: 'center',
    minWidth: 100,
  },
  statNumber: {
    fontSize: 32,
    fontWeight: '800',
    color: '#1a202c',
    marginBottom: 5,
  },
  statLabel: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
  },
  section: {
    backgroundColor: '#ffffff',
    marginBottom: 15,
    padding: 20,
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
  emptyText: {
    fontSize: 16,
    color: '#718096',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#a0aec0',
    marginTop: 4,
  },
});

export default UserProfileModal;
