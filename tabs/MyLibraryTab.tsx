import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  TouchableOpacity, 
  Image,
  Dimensions,
  FlatList
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Book, Photo, UserProfile } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import SettingsModal from '../components/SettingsModal';
import BookDetailModal from '../components/BookDetailModal';

const { width: screenWidth } = Dimensions.get('window');

export const MyLibraryTab: React.FC = () => {
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showBookDetail, setShowBookDetail] = useState(false);

  useEffect(() => {
    loadUserData();
  }, []);

  // Reload data when tab is focused
  useFocusEffect(
    React.useCallback(() => {
      loadUserData();
    }, [user])
  );

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      const userApprovedKey = `approved_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      const photosData = await AsyncStorage.getItem(userPhotosKey);
      
      const loadedBooks: Book[] = approvedData ? JSON.parse(approvedData) : [];
      const loadedPhotos: Photo[] = photosData ? JSON.parse(photosData) : [];
      
      setBooks(loadedBooks);
      setPhotos(loadedPhotos);
      
      // Count scans that have at least one approved book
      const scansWithApprovedBooks = loadedPhotos.filter(photo => {
        // Check if any book from this photo matches an approved book
        return photo.books.some(photoBook => 
          loadedBooks.some(approvedBook => 
            approvedBook.title === photoBook.title && 
            approvedBook.author === photoBook.author
          )
        );
      }).length;
      
      // Create user profile from auth user
      if (user) {
        const profile: UserProfile = {
          displayName: user.displayName || user.email || 'User',
          email: user.email || '',
          photoURL: user.photoURL,
          createdAt: new Date(),
          lastLogin: new Date(),
          totalBooks: loadedBooks.length,
          totalPhotos: scansWithApprovedBooks,
        };
        setUserProfile(profile);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  // Helper to get cover URI - checks local cache first, then remote URL
  const getBookCoverUri = (book: Book): string | undefined => {
    if (book.localCoverPath && FileSystem.documentDirectory) {
      try {
        const localPath = `${FileSystem.documentDirectory}${book.localCoverPath}`;
        return localPath;
      } catch (error) {
        console.warn('Error getting local cover path:', error);
      }
    }
    return book.coverUrl;
  };

  // Find which photo/scan the book came from
  const findBookPhoto = (book: Book): Photo | null => {
    return photos.find(photo => 
      photo.books.some(photoBook => 
        photoBook.title === book.title && 
        photoBook.author === book.author
      )
    ) || null;
  };

  const handleBookPress = (book: Book) => {
    const photo = findBookPhoto(book);
    setSelectedBook(book);
    setSelectedPhoto(photo);
    setShowBookDetail(true);
  };

  const renderBook = ({ item, index }: { item: Book; index: number }) => (
    <TouchableOpacity
      style={styles.bookCard}
      onPress={() => handleBookPress(item)}
      activeOpacity={0.7}
    >
      {getBookCoverUri(item) ? (
        <Image 
          source={{ uri: getBookCoverUri(item) }} 
          style={styles.bookCover}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.bookCover, styles.placeholderCover]}>
          <Text style={styles.placeholderText}>📖</Text>
        </View>
      )}
      {item.author && (
        <Text style={styles.bookAuthor} numberOfLines={2}>
          {item.author}
        </Text>
      )}
    </TouchableOpacity>
  );

  // Count scans that resulted in approved books
  const getScansWithBooks = () => {
    return photos.filter(photo => {
      return photo.books.some(photoBook => 
        books.some(approvedBook => 
          approvedBook.title === photoBook.title && 
          approvedBook.author === photoBook.author
        )
      );
    }).length;
  };

  const handleStatsClick = () => {
    setShowAnalytics(!showAnalytics);
  };

  return (
    <SafeAreaView style={styles.safeContainer}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* User Profile Header */}
      <View style={styles.profileHeader}>
        <View style={styles.profileHeaderContent}>
          {userProfile?.photoURL ? (
            <Image source={{ uri: userProfile.photoURL }} style={styles.profileImage} />
          ) : (
            <View style={styles.profileImagePlaceholder}>
              <Text style={styles.profileInitial}>
                {(userProfile?.displayName || 'U').charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{userProfile?.displayName || 'User'}</Text>
            <Text style={styles.profileEmail}>{userProfile?.email}</Text>
            {user?.username && (
              <Text style={styles.profileUsername}>@{user.username}</Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => setShowSettings(true)}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.settingsButtonIcon}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>
        
      {/* Stats Section - Elegant Cards */}
      <View style={styles.statsSection}>
        <TouchableOpacity style={styles.statsContainer} onPress={handleStatsClick} activeOpacity={0.8}>
          <View style={styles.statsHeader}>
            <Text style={styles.statsTitle}>Library Statistics</Text>
            <Text style={styles.statsToggle}>{showAnalytics ? '▼' : '▶'}</Text>
          </View>
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statNumber}>{books.length}</Text>
              <Text style={styles.statLabel}>Books</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statNumber}>{getScansWithBooks()}</Text>
              <Text style={styles.statLabel}>Scans</Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* Analytics Breakdown - Expandable */}
        {showAnalytics && (
          <View style={styles.analyticsSection}>
            <Text style={styles.analyticsTitle}>Detailed Analytics</Text>
            
            <View style={styles.analyticsItem}>
              <Text style={styles.analyticsLabel}>Reading Patterns</Text>
              <Text style={styles.analyticsValue}>
                Average books per scan: {getScansWithBooks() > 0 ? (books.length / getScansWithBooks()).toFixed(1) : '0'}
              </Text>
            </View>

            <View style={styles.analyticsItem}>
              <Text style={styles.analyticsLabel}>Scanning Activity</Text>
              <Text style={styles.analyticsValue}>
                Successful scans: {getScansWithBooks()}
              </Text>
              <Text style={styles.analyticsValue}>
                Books in library: {books.length}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Books Collection */}
      <View style={styles.booksSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>My Library</Text>
          <Text style={styles.sectionSubtitle}>{books.length} {books.length === 1 ? 'book' : 'books'}</Text>
        </View>
        
        {books.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyStateIcon}>
              <Text style={styles.emptyStateIconText}>📖</Text>
            </View>
            <Text style={styles.emptyStateText}>Your Library Awaits</Text>
            <Text style={styles.emptyStateSubtext}>Start scanning to build your collection</Text>
          </View>
        ) : (
          <FlatList
            data={books}
            renderItem={renderBook}
            keyExtractor={(item, index) => `${item.title}-${item.author || ''}-${index}`}
            numColumns={4}
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.booksGrid}
            columnWrapperStyle={styles.bookRow}
          />
        )}
      </View>
    </ScrollView>

      {/* Settings Modal */}
      <SettingsModal
        visible={showSettings}
        onClose={() => setShowSettings(false)}
      />

      {/* Book Detail Modal */}
      <BookDetailModal
        visible={showBookDetail}
        book={selectedBook}
        photo={selectedPhoto}
        onClose={() => {
          setShowBookDetail(false);
          setSelectedBook(null);
          setSelectedPhoto(null);
        }}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  container: {
    flex: 1,
  },
  // Profile Header - Elegant Top Section
  profileHeader: {
    backgroundColor: '#1a1a2e',
    paddingTop: 20,
    paddingBottom: 30,
    paddingHorizontal: 20,
  },
  profileHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  profileImage: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  profileImagePlaceholder: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: '#4a5568',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  profileInitial: {
    color: 'white',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 1,
  },
  profileInfo: {
    marginLeft: 18,
    flex: 1,
  },
  profileName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 15,
    color: '#cbd5e0',
    fontWeight: '400',
  },
  profileUsername: {
    fontSize: 14,
    color: '#a0aec0',
    fontWeight: '400',
    marginTop: 2,
  },
  settingsButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  settingsButtonIcon: {
    fontSize: 24,
  },
  // Stats Section
  statsSection: {
    marginTop: -15,
    marginHorizontal: 15,
    marginBottom: 15,
  },
  statsContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 5,
  },
  statsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  statsTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    letterSpacing: 0.3,
  },
  statsToggle: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statCard: {
    flex: 1,
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginHorizontal: 6,
  },
  statNumber: {
    fontSize: 28,
    fontWeight: '800',
    color: '#2d3748',
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 12,
    color: '#718096',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Analytics Section
  analyticsSection: {
    backgroundColor: '#f8f9fb',
    borderRadius: 12,
    padding: 18,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  analyticsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2d3748',
    marginBottom: 16,
    letterSpacing: 0.3,
  },
  analyticsItem: {
    marginBottom: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  analyticsLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4a5568',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  analyticsValue: {
    fontSize: 13,
    color: '#718096',
    marginLeft: 4,
    marginBottom: 4,
    lineHeight: 20,
  },
  // Books Section
  booksSection: {
    backgroundColor: '#ffffff',
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 5,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a202c',
    letterSpacing: 0.3,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
  },
  booksGrid: {
    paddingTop: 4,
  },
  bookRow: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  bookCard: {
    width: (screenWidth - 70) / 4, // 4 columns with padding
    alignItems: 'center',
    marginBottom: 12,
  },
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
  placeholderCover: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontSize: 24,
  },
  bookAuthor: {
    fontSize: 11,
    color: '#718096',
    textAlign: 'center',
    fontWeight: '500',
    lineHeight: 14,
    width: '100%',
  },
  // Empty State
  emptyState: {
    alignItems: 'center',
    padding: 60,
  },
  emptyStateIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f7fafc',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#e2e8f0',
  },
  emptyStateIconText: {
    fontSize: 40,
  },
  emptyStateText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2d3748',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  emptyStateSubtext: {
    fontSize: 15,
    color: '#718096',
    fontWeight: '500',
    textAlign: 'center',
  },
});


