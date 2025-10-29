import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  TouchableOpacity, 
  Image,
  Dimensions,
  FlatList,
  SafeAreaView
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, Photo, UserProfile } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';

const { width: screenWidth } = Dimensions.get('window');

export const MyLibraryTab: React.FC = () => {
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  useEffect(() => {
    loadUserData();
  }, []);

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      const userApprovedKey = `approved_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      const photosData = await AsyncStorage.getItem(userPhotosKey);
      
      if (approvedData) setBooks(JSON.parse(approvedData));
      if (photosData) setPhotos(JSON.parse(photosData));
      
      // Create user profile from auth user
      if (user) {
        const profile: UserProfile = {
          displayName: user.displayName || user.email || 'User',
          email: user.email || '',
          photoURL: user.photoURL,
          createdAt: new Date(),
          lastLogin: new Date(),
          totalBooks: books.length,
          totalPhotos: photos.length,
        };
        setUserProfile(profile);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const renderBook = ({ item, index }: { item: Book; index: number }) => (
    <View style={styles.bookCard}>
      {item.coverUrl && (
        <Image 
          source={{ uri: item.coverUrl }} 
          style={styles.bookCover}
        />
      )}
      <View style={styles.bookInfo}>
        <Text style={styles.bookTitle}>{item.title}</Text>
        {item.author && <Text style={styles.bookAuthor}>by {item.author}</Text>}
        {item.isbn && <Text style={styles.bookIsbn}>ISBN: {item.isbn}</Text>}
      </View>
    </View>
  );

  const getGenreStats = () => {
    // Simple genre analysis based on book titles (this could be enhanced)
    const genres = books.map(() => 'General').reduce((acc, genre) => {
      acc[genre] = (acc[genre] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return genres;
  };

  const handleStatsClick = () => {
    setShowAnalytics(!showAnalytics);
  };

  return (
    <SafeAreaView style={styles.safeContainer}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* User Profile Section */}
      <View style={styles.profileSection}>
        <View style={styles.profileHeader}>
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
          </View>
        </View>
        
        {/* Stats Section - Clickable */}
        <TouchableOpacity style={styles.statsContainer} onPress={handleStatsClick}>
          <Text style={styles.statsTitle}>📊 Library Stats {showAnalytics ? '▼' : '▶'}</Text>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{books.length}</Text>
              <Text style={styles.statLabel}>Books</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{photos.length}</Text>
              <Text style={styles.statLabel}>Scans</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{Object.keys(getGenreStats()).length}</Text>
              <Text style={styles.statLabel}>Categories</Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* Analytics Breakdown - Expandable */}
        {showAnalytics && (
          <View style={styles.analyticsSection}>
            <Text style={styles.analyticsTitle}>📈 Detailed Analytics</Text>
            
            <View style={styles.analyticsItem}>
              <Text style={styles.analyticsLabel}>📚 Genre Distribution</Text>
              {Object.entries(getGenreStats()).map(([genre, count]) => (
                <Text key={genre} style={styles.analyticsValue}>
                  {genre}: {count} books
                </Text>
              ))}
            </View>

            <View style={styles.analyticsItem}>
              <Text style={styles.analyticsLabel}>📖 Reading Patterns</Text>
              <Text style={styles.analyticsValue}>
                Average books per scan: {photos.length > 0 ? (books.length / photos.length).toFixed(1) : '0'}
              </Text>
            </View>

            <View style={styles.analyticsItem}>
              <Text style={styles.analyticsLabel}>🎯 Scanning Activity</Text>
              <Text style={styles.analyticsValue}>
                Total photos taken: {photos.length}
              </Text>
              <Text style={styles.analyticsValue}>
                Books identified: {books.length}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Books Collection */}
      <View style={styles.booksSection}>
        <Text style={styles.sectionTitle}>📚 My Books ({books.length})</Text>
        
        {books.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>No books in your library yet</Text>
            <Text style={styles.emptyStateSubtext}>Start scanning to build your collection!</Text>
          </View>
        ) : (
          <FlatList
            data={books}
            renderItem={renderBook}
            keyExtractor={(item, index) => `${item.title}-${index}`}
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  container: {
    flex: 1,
  },
  profileSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  profileImage: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  profileImagePlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInitial: {
    color: 'white',
    fontSize: 24,
    fontWeight: 'bold',
  },
  profileInfo: {
    marginLeft: 15,
    flex: 1,
  },
  profileName: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#2c3e50',
  },
  profileEmail: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  statsContainer: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
  },
  statsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 10,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  analyticsSection: {
    backgroundColor: '#f0f8ff',
    borderRadius: 8,
    padding: 15,
    marginTop: 10,
  },
  analyticsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 15,
  },
  analyticsItem: {
    marginBottom: 15,
  },
  analyticsLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#34495e',
    marginBottom: 5,
  },
  analyticsValue: {
    fontSize: 13,
    color: '#666',
    marginLeft: 10,
    marginBottom: 2,
  },
  booksSection: {
    backgroundColor: 'white',
    margin: 15,
    marginTop: 0,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2c3e50',
    marginBottom: 15,
  },
  bookCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  bookCover: {
    width: 50,
    height: 75,
    borderRadius: 4,
    marginRight: 15,
    backgroundColor: '#e0e0e0',
  },
  bookInfo: {
    flex: 1,
  },
  bookTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 5,
  },
  bookAuthor: {
    fontSize: 14,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 3,
  },
  bookIsbn: {
    fontSize: 12,
    color: '#999',
    marginBottom: 3,
  },
  emptyState: {
    alignItems: 'center',
    padding: 40,
  },
  emptyStateText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 5,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#999',
  },
});


