import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  TouchableOpacity, 
  Image,
  Dimensions,
  FlatList,
  Modal,
  TextInput,
  Alert
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Book, Photo, UserProfile, Folder } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import SettingsModal from '../components/SettingsModal';
import BookDetailModal from '../components/BookDetailModal';
import { LibraryView } from '../screens/LibraryView';

const { width: screenWidth } = Dimensions.get('window');

export const MyLibraryTab: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const navigation = useNavigation();
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showBookDetail, setShowBookDetail] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [photoCaption, setPhotoCaption] = useState('');
  const [deleteConfirmPhoto, setDeleteConfirmPhoto] = useState<Photo | null>(null);
  const [deleteGuard, setDeleteGuard] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [bookSearchQuery, setBookSearchQuery] = useState('');
  const [bookSearchResults, setBookSearchResults] = useState<any[]>([]);
  const [bookSearchLoading, setBookSearchLoading] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const [showFolderView, setShowFolderView] = useState(false);
  const [showLibraryView, setShowLibraryView] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const booksSectionRef = useRef<View>(null);
  const [booksSectionY, setBooksSectionY] = useState(0);

  const filteredBooks = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return books;

    // Prioritize starts-with matches on title or author, then fallback to contains
    const startsWithMatches = books.filter(b => {
      const title = (b.title || '').toLowerCase();
      const author = (b.author || '').toLowerCase();
      return title.startsWith(q) || author.startsWith(q);
    });

    const containsMatches = books.filter(b => {
      const title = (b.title || '').toLowerCase();
      const author = (b.author || '').toLowerCase();
      return (title.includes(q) || author.includes(q)) && !(title.startsWith(q) || author.startsWith(q));
    });

    return [...startsWithMatches, ...containsMatches];
  }, [books, librarySearch]);

  const displayedBooks = librarySearch.trim() ? filteredBooks : books;

  // Calculate top author (author with most books)
  const topAuthor = useMemo(() => {
    if (books.length === 0) return null;
    
    const authorCounts: { [key: string]: number } = {};
    
    books.forEach(book => {
      if (book.author) {
        // Normalize author name (handle multiple authors by taking first one)
        const normalizedAuthor = book.author.split(/,|&| and /i)[0].trim();
        if (normalizedAuthor) {
          authorCounts[normalizedAuthor] = (authorCounts[normalizedAuthor] || 0) + 1;
        }
      }
    });
    
    if (Object.keys(authorCounts).length === 0) return null;
    
    // Find author with highest count
    const entries = Object.entries(authorCounts);
    entries.sort((a, b) => b[1] - a[1]); // Sort by count descending
    
    const [authorName, count] = entries[0];
    return { name: authorName, count };
  }, [books]);

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

  useEffect(() => {
    loadUserData();
  }, []);

  // Update userProfile when user changes (display name, username)
  useEffect(() => {
    if (user && userProfile) {
      setUserProfile(prev => prev ? {
        ...prev,
        displayName: user.displayName || user.username || 'User',
      } : null);
    }
  }, [user?.displayName, user?.username]);

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
      const userFoldersKey = `folders_${user.uid}`;
      
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      const photosData = await AsyncStorage.getItem(userPhotosKey);
      const foldersData = await AsyncStorage.getItem(userFoldersKey);
      
      const loadedBooks: Book[] = approvedData ? JSON.parse(approvedData) : [];
      const loadedPhotos: Photo[] = photosData ? JSON.parse(photosData) : [];
      const loadedFolders: Folder[] = foldersData ? JSON.parse(foldersData) : [];
      
      setBooks(loadedBooks);
      setPhotos(loadedPhotos);
      setFolders(loadedFolders);
      
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

      // Count scans that have at least one approved book
      const scansWithApprovedBooks = loadedPhotos.filter(photo => {
        // Skip photos with no books
        if (!photo.books || photo.books.length === 0) {
          return false;
        }
        
        // Check if any book from this photo matches an approved book
        return photo.books.some(photoBook => 
          loadedBooks.some(approvedBook => booksMatch(photoBook, approvedBook))
        );
      }).length;
      
      // Create user profile from auth user
      if (user) {
        const profile: UserProfile = {
          displayName: user.displayName || user.username || 'User',
          email: user.email || '',
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

  const saveFolders = async (updatedFolders: Folder[]) => {
    if (!user) return;
    try {
      const userFoldersKey = `folders_${user.uid}`;
      await AsyncStorage.setItem(userFoldersKey, JSON.stringify(updatedFolders));
      setFolders(updatedFolders);
    } catch (error) {
      console.error('Error saving folders:', error);
    }
  };

  const deleteFolder = async (folderId: string) => {
    if (!user) return;
    
    Alert.alert(
      'Delete Folder',
      'Are you sure you want to delete this folder? This will not delete the books, they will remain in your library.',
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
      console.error('Error adding photo to folder:', error);
    }
  };

  const [showFolderSelectModal, setShowFolderSelectModal] = useState(false);
  const [photoToAddToFolder, setPhotoToAddToFolder] = useState<Photo | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  const createFolder = async () => {
    if (!newFolderName.trim() || !user) return;
    
    try {
      const folderId = `folder_${Date.now()}`;
      const newFolder: Folder = {
        id: folderId,
        name: newFolderName.trim(),
        bookIds: [],
        photoIds: [],
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
      console.error('Error creating folder:', error);
      Alert.alert('Error', 'Failed to create folder. Please try again.');
    }
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
          <Text style={styles.placeholderText} numberOfLines={3}>
            {item.title}
          </Text>
        </View>
      )}
      {item.author && (
        <Text style={styles.bookAuthor} numberOfLines={2}>
          {item.author}
        </Text>
      )}
    </TouchableOpacity>
  );

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

  // Get photos that have approved books (only these should show in Photos section)
  // A photo should only appear if at least one book from that photo is in the library
  const getPhotosWithApprovedBooks = () => {
    if (!books || books.length === 0) {
      return []; // No approved books means no photos
    }
    
    return photos.filter(photo => {
      // Skip photos with no books
      if (!photo.books || photo.books.length === 0) {
        return false;
      }
      
      // Check if any book from this photo matches an approved book in the library
      // The book must actually be in the books array (approved and in library)
      const hasApprovedBook = photo.books.some(photoBook => {
        // Check if this photoBook exists in the approved books (library)
        return books.some(libraryBook => {
          // Both title and author must match (using normalized comparison)
          return booksMatch(photoBook, libraryBook);
        });
      });
      
      return hasApprovedBook;
    });
  };

  // Count scans that resulted in approved books
  const getScansWithBooks = () => {
    return getPhotosWithApprovedBooks().length;
  };

  const handleStatsClick = () => {
    setShowAnalytics(!showAnalytics);
  };

  // Get books with covers for collage (max 100)
  const booksWithCovers = useMemo(() => {
    return books.filter(book => getBookCoverUri(book)).slice().sort(() => Math.random() - 0.5); // Shuffle for randomness
  }, [books]);

  const collageBookCount = useMemo(() => {
    const count = booksWithCovers.length;
    // Show max 7 books in a single row
    return Math.min(count, 7);
  }, [booksWithCovers.length]);

  const collageBooks = useMemo(() => {
    return booksWithCovers.slice(0, collageBookCount);
  }, [booksWithCovers, collageBookCount]);

  // Calculate dynamic cover size - even smaller covers to prevent overlap
  const collageLayout = useMemo(() => {
    const count = collageBookCount;
    if (count === 0) return { coverWidth: 30, coverHeight: 45 };
    
    // Even smaller size - around 30px wide
    const coverWidth = 30;
    const coverHeight = coverWidth * 1.5; // Maintain 2:3 aspect ratio
    
    return { coverWidth, coverHeight };
  }, [collageBookCount]);

  // Pre-calculate positions to avoid overlap and profile area
  const bookPositions = useMemo(() => {
    if (collageBooks.length === 0) return [];
    
    const { coverWidth, coverHeight } = collageLayout;
    const headerWidth = screenWidth - 40;
    const headerHeight = 100;
    
    // Books can extend into the gradient area (above header)
    const gradientHeight = insets.top;
    const totalAvailableHeight = gradientHeight + headerHeight;
    
    // Avoid the center area where profile info is (approximately center 40% of width, middle section)
    // Profile area is in the blue header section, not the gradient
    const profileArea = {
      left: screenWidth * 0.25,
      right: screenWidth * 0.75,
      top: gradientHeight + 30, // Start below gradient
      bottom: gradientHeight + 70 // End before bottom of header
    };
    
    // Minimum spacing between books - ensure NO overlap
    const minSpacing = coverWidth + 6; // Cover width plus padding
    const positions: Array<{ x: number; y: number; rotation: number }> = [];
    const usedPositions: Array<{ x: number; y: number }> = [];
    
    // Helper to check if two rectangles overlap
    const rectanglesOverlap = (x1: number, y1: number, w1: number, h1: number,
                              x2: number, y2: number, w2: number, h2: number): boolean => {
      return !(x1 + w1 + 6 < x2 || x2 + w2 + 6 < x1 ||
               y1 + h1 + 6 < y2 || y2 + h2 + 6 < y1);
    };
    
    // Check if position is valid (not overlapping and not in profile area)
    const isPositionValid = (x: number, y: number): boolean => {
      // Check bounds - allow books in gradient area (y can be negative to go into gradient)
      if (x < 20 || x > screenWidth - 20 - coverWidth) return false;
      if (y < 5 || y > headerHeight + gradientHeight - coverHeight - 10) return false;
      
      // Check if overlaps with existing books
      for (const used of usedPositions) {
        if (rectanglesOverlap(x, y, coverWidth, coverHeight, used.x, used.y, coverWidth, coverHeight)) {
          return false;
        }
      }
      
      // Check if in profile area (where name/username is)
      const centerX = x + coverWidth / 2;
      const centerY = y + coverHeight / 2;
      if (centerX >= profileArea.left && centerX <= profileArea.right &&
          centerY >= profileArea.top && centerY <= profileArea.bottom) {
        return false;
      }
      
      return true;
    };
    
    // Create a visible staggered/zigzag pattern instead of a straight line
    const totalBooks = collageBooks.length;
    const availableWidth = headerWidth - coverWidth;
    const availableHeight = totalAvailableHeight - coverHeight;
    const centerY = (availableHeight - coverHeight) / 2 + 10; // Center vertically
    
    // Create a zigzag pattern - alternate between higher and lower positions
    const staggerAmplitude = 20; // How much books move up/down from center
    
    collageBooks.forEach((book, index) => {
      // Distribute books evenly across the width
      const progress = totalBooks > 1 ? index / (totalBooks - 1) : 0;
      let x = 20 + progress * availableWidth;
      
      // Create zigzag/staggered pattern - alternate between higher and lower
      // Avoid center area (where profile is) by keeping center books more level
      const centerDistance = Math.abs(progress - 0.5); // Distance from center (0 to 0.5)
      const staggerPhase = index % 2 === 0 ? 1 : -1; // Alternates: 1, -1, 1, -1, ...
      const staggerOffset = staggerPhase * staggerAmplitude;
      
      // Reduce stagger in the center area (where profile info is)
      const centerBlend = Math.min(1, centerDistance * 4); // 0 at center, 1 at edges
      const finalOffset = staggerOffset * centerBlend;
      
      let y = centerY + finalOffset;
      
      // Add small random variation for organic feel
      const randomVariation = (Math.random() - 0.5) * 5;
      y = y + randomVariation;
      
      // Try to find a valid position if the initial position is invalid or overlaps
      if (!isPositionValid(x, y)) {
        // Try positions in a spiral pattern around the initial position
        let foundValid = false;
        let attempts = 0;
        const maxAttempts = 15;
        const angleStep = (Math.PI * 2) / 8; // 8 directions
        
        while (!foundValid && attempts < maxAttempts) {
          const radius = minSpacing * (attempts + 1) / 2;
          
          // Try 8 directions around the initial point
          for (let dir = 0; dir < 8; dir++) {
            const angle = dir * angleStep;
            const testX = x + Math.cos(angle) * radius;
            const testY = y + Math.sin(angle) * radius;
            
            if (isPositionValid(testX, testY)) {
              x = testX;
              y = testY;
              foundValid = true;
              break;
            }
          }
          attempts++;
        }
      }
      
      // Final bounds check
      x = Math.max(20, Math.min(screenWidth - 20 - coverWidth, x));
      y = Math.max(5, Math.min(headerHeight + gradientHeight - coverHeight - 10, y));
      
      // Add rotation that varies with position (more rotation at arch extremes)
      const rotationIntensity = Math.abs((progress - 0.5) * 2); // 0 at center, 1 at edges
      const rotation = (Math.random() - 0.5) * 8 * rotationIntensity; // More rotation at edges
      
      positions.push({ x, y, rotation });
      usedPositions.push({ x, y });
    });
    
    return positions;
  }, [collageBooks, collageLayout, screenWidth, insets.top]);

  return (
    <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
      <ScrollView 
        ref={scrollViewRef} 
        style={styles.container} 
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
      {/* Header - Match Scans tab design */}
      <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
      <View style={{ position: 'relative', overflow: 'visible' }}>
        {/* User Profile Header */}
        <View style={styles.profileHeader}>
          {/* Book Cover Collage Background - Fixed, over blue background */}
          {collageBooks.length > 0 && (
            <View style={[styles.collageContainer, { top: -insets.top }]} pointerEvents="none">
            {collageBooks.map((book, index) => {
              const coverUri = getBookCoverUri(book);
              if (!coverUri) return null;
              
              const { coverWidth, coverHeight } = collageLayout;
              const position = bookPositions[index];
              
              if (!position) return null;
              
              return (
                <Image
                  key={`${book.id}-${index}`}
                  source={{ uri: coverUri }}
                  style={[
                    styles.collageCover,
                    {
                      width: coverWidth,
                      height: coverHeight,
                      left: position.x,
                      top: position.y + insets.top, // Account for safe area
                      transform: [{ rotate: `${position.rotation}deg` }],
                    }
                  ]}
                  resizeMode="cover"
                />
              );
            })}
          </View>
        )}
        
        <View style={styles.profileHeaderContent}>
          <View style={styles.profileImagePlaceholder}>
            <Text style={styles.profileInitial}>
              {(userProfile?.displayName || user?.username || 'U').charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>
              {userProfile?.displayName || user?.username || 'User'}
            </Text>
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
            <Ionicons name="settings-outline" size={22} color="#ffffff" />
          </TouchableOpacity>
        </View>
        </View>
      </View>
      
      {/* Removed gradient fade - matching Scans tab design */}
        
      {/* Stats Section - Elegant Cards */}
      <View style={styles.statsSection}>
        <TouchableOpacity style={styles.statsContainer} onPress={handleStatsClick} activeOpacity={0.8}>
          <View style={styles.statsHeader}>
            <Text style={styles.statsTitle}>Library Statistics</Text>
            <Text style={styles.statsToggle}>{showAnalytics ? '▼' : '▶'}</Text>
          </View>
          <View style={styles.statsRow}>
            <TouchableOpacity 
              style={styles.statCard}
              onPress={() => {
                // Navigate to dedicated library view
                setShowLibraryView(true);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.statNumber}>{books.length}</Text>
              <Text style={styles.statLabel}>Books</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.statCard}
              onPress={() => setShowPhotos(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.statNumber}>{getPhotosWithApprovedBooks().length}</Text>
              <Text style={styles.statLabel}>Photos</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>

        {/* Top Author - Expandable */}
        {showAnalytics && (
          <View style={styles.analyticsSection}>
            <Text style={styles.analyticsTitle}>Top Author</Text>
            {topAuthor ? (
              <View style={styles.analyticsItem}>
                <Text style={styles.analyticsLabel}>{topAuthor.name}</Text>
                <Text style={styles.analyticsValue}>
                  {topAuthor.count} {topAuthor.count === 1 ? 'book' : 'books'} in your library
                </Text>
              </View>
            ) : (
              <View style={styles.analyticsItem}>
                <Text style={styles.analyticsValue}>No authors yet</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Folders Section - Only show if folders exist */}
      {folders.length > 0 && (
        <View style={styles.foldersSection}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Folders</Text>
          </View>
          <View style={styles.foldersGrid}>
            {folders.map((folder) => {
              // Get books that belong to this folder
              const folderBooks = books.filter(book => 
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
                >
                  <View style={styles.folderIcon}>
                    <Ionicons name="folder" size={32} color="#0056CC" />
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
        </View>
      )}

      {/* Books Collection */}
      <View 
        ref={booksSectionRef} 
        style={styles.booksSection}
        onLayout={(event) => {
          const { y } = event.nativeEvent.layout;
          setBooksSectionY(y);
        }}
      >
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>My Library</Text>
          <Text style={styles.sectionSubtitle}>{sortedDisplayedBooks.length} {sortedDisplayedBooks.length === 1 ? 'book' : 'books'}</Text>
        </View>
        {/* Library Search Bar */}
        <View style={styles.librarySearchContainer}>
          <TextInput
            style={styles.librarySearchInput}
            value={librarySearch}
            onChangeText={setLibrarySearch}
            placeholder="Search by title or author..."
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="never"
            onFocus={() => {
              // Scroll to "My Library" section when search input is focused
              const scrollToSection = () => {
                if (booksSectionY > 0) {
                  scrollViewRef.current?.scrollTo({ y: booksSectionY - 20, animated: true });
                } else {
                  // Measure and scroll if Y not available
                  booksSectionRef.current?.measure((x, y, width, height, pageX, pageY) => {
                    // pageY is relative to window, but we need relative to ScrollView content
                    // Try using y directly (relative to parent) or calculate offset
                    scrollViewRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: true });
                  });
                }
              };
              
              // Try immediately, then with a delay as fallback
              scrollToSection();
              setTimeout(scrollToSection, 100);
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
            data={sortedDisplayedBooks}
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
        onRemove={() => {
          loadUserData(); // Refresh library after removal
        }}
      />

      {/* Photos Modal */}
      <Modal
        visible={showPhotos}
        animationType="none"
        transparent={false}
        onRequestClose={() => setShowPhotos(false)}
      >
        <SafeAreaView style={styles.safeContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>My Photos</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowPhotos(false)}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.modalCloseButtonText}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
            {getPhotosWithApprovedBooks().length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>No Photos Yet</Text>
                <Text style={styles.emptyStateSubtext}>Photos with books in your library will appear here</Text>
              </View>
            ) : (
              getPhotosWithApprovedBooks().map((photo) => (
                <View key={photo.id} style={styles.photoCard}>
                  <TouchableOpacity
                    style={styles.photoCardContent}
                    onPress={() => {
                      if (deleteGuard) { setDeleteGuard(false); return; }
                      setEditingPhoto(photo);
                      setPhotoCaption(photo.caption || '');
                      setShowPhotos(false); // Close Photos modal to show Edit modal
                    }}
                    activeOpacity={0.8}
                  >
                    <View style={styles.photoImageContainer}>
                      <Image source={{ uri: photo.uri }} style={styles.photoImage} />
                      <TouchableOpacity
                        style={styles.photoDeleteButton}
                        onPressIn={() => setDeleteGuard(true)}
                        onPress={() => {
                          setDeleteConfirmPhoto(photo);
                        }}
                        activeOpacity={0.7}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={styles.photoDeleteButtonText}>×</Text>
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                  <View style={styles.photoInfo}>
                    <Text style={styles.photoDate}>
                      {new Date(photo.timestamp).toLocaleDateString()}
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        if (deleteGuard) { setDeleteGuard(false); return; }
                        setEditingPhoto(photo);
                        setPhotoCaption(photo.caption || '');
                        setShowPhotos(false); // Close Photos modal to show Edit modal
                      }}
                      activeOpacity={0.7}
                    >
                      {photo.caption ? (
                        <Text style={styles.photoCaption}>{photo.caption}</Text>
                      ) : (
                        <Text style={styles.photoCaptionPlaceholder}>Tap to add caption...</Text>
                      )}
                    </TouchableOpacity>
                    <Text style={styles.photoBooksCount}>
                      {photo.books.filter(photoBook => {
                        return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                      }).length} book{photo.books.filter(photoBook => {
                        return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                      }).length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
          {/* Inline Delete Confirmation Overlay (renders over Photos screen) */}
          {deleteConfirmPhoto && (
            <View style={styles.confirmModalOverlay}>
              <View style={styles.confirmModalContent}>
                <Text style={styles.confirmModalTitle}>Delete Photo</Text>
                <Text style={styles.confirmModalMessage}>
                  Are you sure you want to delete this photo? This will not remove the books from your library.
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
                    onPress={async () => {
                      if (!user || !deleteConfirmPhoto) return;
                      try {
                        const updatedPhotos = photos.filter(p => p.id !== deleteConfirmPhoto.id);
                        setPhotos(updatedPhotos);
                        // If currently editing the same photo, close editor state
                        if (editingPhoto && editingPhoto.id === deleteConfirmPhoto.id) {
                          setEditingPhoto(null);
                          setPhotoCaption('');
                        }
                        const userPhotosKey = `photos_${user.uid}`;
                        await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
                        setDeleteConfirmPhoto(null);
                        // No reload here; rely on optimistic state for instant UI update
                      } catch (error) {
                        console.error('Error deleting photo:', error);
                        setDeleteConfirmPhoto(null);
                      }
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.confirmModalButtonDeleteText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      

      {/* Edit Photo Caption Modal */}
      <Modal
        visible={editingPhoto !== null}
        animationType="none"
        transparent={false}
        onRequestClose={() => {
          setEditingPhoto(null);
          setPhotoCaption('');
        }}
      >
        <SafeAreaView style={styles.safeContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity
              style={styles.modalBackButton}
              onPress={() => {
                setEditingPhoto(null);
                setPhotoCaption('');
                setShowPhotos(true); // Reopen Photos modal when going back
              }}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
            <Text style={styles.modalBackButtonLabel}>Back</Text>
            </TouchableOpacity>
            <Text style={styles.modalHeaderTitle}>Edit Photo</Text>
            <View style={styles.modalHeaderSpacer} />
          </View>

          {editingPhoto && (
            <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
              <Image source={{ uri: editingPhoto.uri }} style={styles.editPhotoImage} />
              
              <View style={styles.captionSection}>
                <Text style={styles.captionLabel}>Caption / Location</Text>
                <TextInput
                  style={styles.captionInput}
                  value={photoCaption}
                  onChangeText={setPhotoCaption}
                  placeholder="e.g., Living Room Bookshelf, Office, Bedroom..."
                  multiline
                  numberOfLines={2}
                />
                <TouchableOpacity
                  style={styles.saveCaptionButton}
                  onPress={async () => {
                    if (!user || !editingPhoto) return;
                    
                    try {
                      const updatedPhotos = photos.map(p =>
                        p.id === editingPhoto.id
                          ? { ...p, caption: photoCaption.trim() || undefined }
                          : p
                      );
                      
                      setPhotos(updatedPhotos);
                      
                      const userPhotosKey = `photos_${user.uid}`;
                      await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
                      
                      // Reload data to refresh the filtered photos
                      loadUserData();
                      
                      setEditingPhoto(null);
                      setPhotoCaption('');
                      setShowPhotos(true); // Return to Photos modal after saving
                    } catch (error) {
                      console.error('Error saving caption:', error);
                      // Error handling without slow Alert
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.saveCaptionButtonText}>Save Caption</Text>
                </TouchableOpacity>
              </View>

              {/* Add to Folder */}
              <View style={styles.addToFolderSection}>
                <TouchableOpacity
                  style={styles.addToFolderButtonLarge}
                  onPress={() => {
                    if (editingPhoto) {
                      setPhotoToAddToFolder(editingPhoto);
                      setShowFolderSelectModal(true);
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Ionicons name="folder-outline" size={20} color="#0056CC" style={{ marginRight: 8 }} />
                  <Text style={styles.addToFolderButtonTextLarge}>Add to Folder</Text>
                </TouchableOpacity>
              </View>

              {/* Add Books That We Missed */}
              <View style={styles.addBooksSection}>
                <Text style={styles.addBooksTitle}>Add Books That We Missed</Text>
                <View style={styles.addBooksSearchRow}>
                  <TextInput
                    style={styles.addBooksSearchInput}
                    value={bookSearchQuery}
                    onChangeText={setBookSearchQuery}
                    placeholder="Search by title or author..."
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    style={styles.addBooksSearchButton}
                    onPress={async () => {
                      const q = bookSearchQuery.trim();
                      if (!q) return;
                      try {
                        setBookSearchLoading(true);
                        const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`);
                        const data = await response.json();
                        setBookSearchResults(data.items || []);
                      } catch (e) {
                        setBookSearchResults([]);
                      } finally {
                        setBookSearchLoading(false);
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.addBooksSearchButtonText}>{bookSearchLoading ? 'Searching…' : 'Search'}</Text>
                  </TouchableOpacity>
                </View>
                {bookSearchResults.length > 0 && (
                  <View style={styles.addBooksResults}>
                    {bookSearchResults.map((item, idx) => {
                      const vi = item.volumeInfo || {};
                      const title = vi.title || 'Unknown Title';
                      const author = (vi.authors && vi.authors[0]) || 'Unknown';
                      const coverUrl = vi.imageLinks?.thumbnail?.replace('http:', 'https:');
                      return (
                        <TouchableOpacity
                          key={item.id || idx}
                          style={styles.addBooksResultRow}
                          onPress={async () => {
                            if (!user || !editingPhoto) return;
                            try {
                              const newBook: Book = {
                                id: `${editingPhoto.id}_added_${Date.now()}`,
                                title,
                                author,
                                status: 'approved',
                                scannedAt: Date.now(),
                                coverUrl: coverUrl,
                                googleBooksId: item.id,
                              } as any;

                              // Deduplicate: check if book already exists
                              const normalize = (s?: string) => {
                                if (!s) return '';
                                return s.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ');
                              };
                              const normalizeTitle = (t?: string) => normalize(t).replace(/^(the|a|an)\s+/, '').trim();
                              const normalizeAuthor = (a?: string) => normalize(a).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
                              const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
                              
                              const newBookKey = makeKey(newBook);
                              const alreadyExists = books.some(b => makeKey(b) === newBookKey);
                              
                              if (alreadyExists) {
                                Alert.alert('Duplicate Book', `"${newBook.title}" is already in your library.`);
                                return;
                              }

                              const updatedPhotos = photos.map(p =>
                                p.id === editingPhoto.id
                                  ? { ...p, books: [...p.books, { ...newBook, addedViaSearch: true }] }
                                  : p
                              );
                              setPhotos(updatedPhotos);

                              const newApproved = [...books, newBook];
                              setBooks(newApproved);

                              const userPhotosKey = `photos_${user.uid}`;
                              const userApprovedKey = `approved_books_${user.uid}`;
                              await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
                              await AsyncStorage.setItem(userApprovedKey, JSON.stringify(newApproved));

                              setEditingPhoto({ ...editingPhoto, books: [...editingPhoto.books, { ...newBook, addedViaSearch: true }] });
                              setBookSearchQuery('');
                              setBookSearchResults([]);
                            } catch (err) {
                              // noop
                            }
                          }}
                        >
                          <View style={styles.addBooksResultInfo}>
                            <Text style={styles.addBooksResultTitle} numberOfLines={1}>{title}</Text>
                            <Text style={styles.addBooksResultAuthor} numberOfLines={1}>{author}</Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>

              {/* Books from this photo that are in the library */}
              {editingPhoto.books.filter(photoBook => {
                // Only show books that are actually in the library (approved)
                return books.some(libraryBook => booksMatch(photoBook, libraryBook));
              }).length > 0 && (
                <View style={styles.photoBooksSection}>
                  <Text style={styles.photoBooksTitle}>
                    Books from this Photo ({editingPhoto.books.filter(photoBook => {
                      return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                    }).length})
                  </Text>
                  <View style={styles.photoBooksGrid}>
                    {editingPhoto.books.filter(photoBook => {
                      // Only show books that are actually in the library (approved)
                      return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                    }).map((book, index) => (
                      <View key={`${book.id || index}`} style={styles.photoBookCard}>
                        {getBookCoverUri(book) ? (
                          <Image 
                            source={{ uri: getBookCoverUri(book) }} 
                            style={styles.photoBookCover}
                          />
                        ) : (
                          <View style={[styles.photoBookCover, styles.placeholderCover]}>
                            <Text style={styles.placeholderTextSmall} numberOfLines={2}>
                              {book.title}
                            </Text>
                          </View>
                        )}
                        <Text style={styles.photoBookTitle} numberOfLines={2}>{book.title}</Text>
                        {book.author && (
                          <Text style={styles.photoBookAuthor} numberOfLines={1}>{book.author}</Text>
                        )}
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Added Via Search */}
              {editingPhoto.books.filter(b => (b as any).addedViaSearch).length > 0 && (
                <View style={styles.addedViaSearchSection}>
                  <Text style={styles.addedViaSearchTitle}>Added Via Search</Text>
                  <View style={styles.addedViaSearchChips}>
                    {editingPhoto.books.filter(b => (b as any).addedViaSearch).map((book, index) => (
                      <View key={`${book.id || index}`} style={styles.addedChip}>
                        <Text style={styles.addedChipText} numberOfLines={1}>{book.title}</Text>
                        <TouchableOpacity
                          style={styles.addedChipRemove}
                          onPress={async () => {
                            if (!user || !editingPhoto) return;
                            const updatedPhotoBooks = editingPhoto.books.filter(b => b.id !== book.id);
                            const updatedPhotos = photos.map(p => p.id === editingPhoto.id ? { ...p, books: updatedPhotoBooks } : p);
                            setPhotos(updatedPhotos);
                            setEditingPhoto({ ...editingPhoto, books: updatedPhotoBooks });

                            // Remove from library too
                            const updatedApproved = books.filter(b => !(b.title === book.title && b.author === book.author));
                            setBooks(updatedApproved);
                            const userPhotosKey = `photos_${user.uid}`;
                            const userApprovedKey = `approved_books_${user.uid}`;
                            await AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos));
                            await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedApproved));
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={styles.addedChipRemoveText}>×</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Folder View Modal */}
      <Modal
        visible={showFolderView}
        animationType="none"
        transparent={false}
        onRequestClose={() => {
          setShowFolderView(false);
          setSelectedFolder(null);
        }}
      >
        <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
          <LinearGradient
            colors={['#f5f7fa', '#1a1a2e']}
            style={{ height: insets.top }}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          />
          <View style={styles.modalHeader}>
            <TouchableOpacity
              style={styles.modalBackButton}
              onPress={() => {
                setShowFolderView(false);
                setSelectedFolder(null);
              }}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.modalBackButtonLabel}>Back</Text>
            </TouchableOpacity>
            <Text style={styles.modalHeaderTitle}>
              {selectedFolder?.name || 'Folder'}
            </Text>
            {selectedFolder && (
              <TouchableOpacity
                style={styles.modalDeleteButton}
                onPress={() => deleteFolder(selectedFolder.id)}
                activeOpacity={0.7}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="trash-outline" size={22} color="#ffffff" />
              </TouchableOpacity>
            )}
          </View>

          {selectedFolder && (
            <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
              {(() => {
                const folderPhotoIds = selectedFolder.photoIds || [];
                const folderPhotos = photos.filter(photo => folderPhotoIds.includes(photo.id));
                const folderBooks = books.filter(book => 
                  book.id && selectedFolder.bookIds.includes(book.id)
                );
                
                // Show Photos section if there are photos
                if (folderPhotos.length > 0) {
                  return (
                    <>
                      <View style={styles.booksSection}>
                        <View style={styles.sectionHeader}>
                          <Text style={styles.sectionTitle}>Photos</Text>
                          <Text style={styles.sectionSubtitle}>{folderPhotos.length} {folderPhotos.length === 1 ? 'photo' : 'photos'}</Text>
                        </View>
                        {folderPhotos.map((photo) => (
                          <View key={photo.id} style={styles.photoCard}>
                            <Image source={{ uri: photo.uri }} style={styles.photoImage} />
                            <View style={styles.photoInfo}>
                              <Text style={styles.photoDate}>
                                {new Date(photo.timestamp).toLocaleDateString()}
                              </Text>
                              {photo.caption && (
                                <Text style={styles.photoCaption}>{photo.caption}</Text>
                              )}
                              <Text style={styles.photoBooksCount}>
                                {photo.books.filter(photoBook => {
                                  return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                                }).length} {photo.books.filter(photoBook => {
                                  return books.some(libraryBook => booksMatch(photoBook, libraryBook));
                                }).length === 1 ? 'book' : 'books'}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                      
                      {folderBooks.length > 0 && (
                        <View style={styles.booksSection}>
                          <View style={styles.sectionHeader}>
                            <Text style={styles.sectionTitle}>
                              Books ({folderBooks.length})
                            </Text>
                          </View>
                          <FlatList
                            data={folderBooks}
                            renderItem={renderBook}
                            keyExtractor={(item, index) => `${item.title}-${item.author || ''}-${index}`}
                            numColumns={4}
                            scrollEnabled={false}
                            showsVerticalScrollIndicator={false}
                            contentContainerStyle={styles.booksGrid}
                            columnWrapperStyle={styles.bookRow}
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
                      data={folderBooks}
                      renderItem={renderBook}
                      keyExtractor={(item, index) => `${item.title}-${item.author || ''}-${index}`}
                      numColumns={4}
                      scrollEnabled={false}
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={styles.booksGrid}
                      columnWrapperStyle={styles.bookRow}
                    />
                  </View>
                );
              })()}
            </ScrollView>
          )}
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
            colors={['#f5f7fa', '#1a1a2e']}
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
                  placeholder="Folder name..."
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
                    <Ionicons name="folder" size={24} color="#0056CC" style={{ marginRight: 12 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.folderItemName}>{folder.name}</Text>
                      <Text style={styles.folderItemCount}>
                        {(folder.photoIds || []).length} {(folder.photoIds || []).length === 1 ? 'photo' : 'photos'} • {folder.bookIds.length} {folder.bookIds.length === 1 ? 'book' : 'books'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color="#718096" />
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
      
    </SafeAreaView>
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
  // Profile Header - Match Scans tab design
  profileHeader: {
    backgroundColor: '#2d3748', // Match Scans tab
    paddingTop: 20,
    paddingBottom: 30,
    paddingHorizontal: 20,
    position: 'relative',
    overflow: 'visible', // Allow books to extend
  },
  collageContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
    overflow: 'visible', // Allow books to extend beyond container
  },
  collageCover: {
    position: 'absolute',
    borderRadius: 4,
    opacity: 0.55, // More visible
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.2)',
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
    backgroundColor: 'rgba(74, 85, 104, 0.6)',
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
    color: '#ffffff',
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
    marginTop: 10,
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
  statAuthorName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 24,
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
  librarySearchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  librarySearchInput: {
    flex: 1,
    fontSize: 14,
    color: '#1a202c',
  },
  librarySearchClear: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e2e8f0',
  },
  librarySearchClearText: {
    fontSize: 18,
    color: '#4a5568',
    lineHeight: 20,
    marginTop: -2,
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
  foldersSection: {
    marginHorizontal: 15,
    marginBottom: 20,
  },
  foldersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  folderCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    width: (screenWidth - 60) / 2,
    marginBottom: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  folderIcon: {
    marginBottom: 12,
  },
  folderName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 6,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  folderBookCount: {
    fontSize: 13,
    color: '#718096',
    fontWeight: '500',
  },
  booksGrid: {
    paddingTop: 4,
  },
  bookRow: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  bookCard: {
    width: (screenWidth - 94) / 4, // 4 columns with padding and gaps (8px gap between each)
    alignItems: 'center',
    marginBottom: 12,
    marginHorizontal: 4,
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
    padding: 8,
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  placeholderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4a5568',
    textAlign: 'center',
    lineHeight: 14,
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
  // Photo Modal Styles
  modalHeader: {
    backgroundColor: '#1a1a2e',
    paddingVertical: 16,
    paddingHorizontal: 20,
    paddingTop: 60,
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
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    minWidth: 80,
  },
  modalBackButtonText: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '600',
    marginRight: 6,
  },
  modalBackButtonLabel: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '600',
  },
  modalHeaderTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
    flex: 1,
    textAlign: 'center',
  },
  modalHeaderSpacer: {
    minWidth: 80,
  },
  modalDeleteButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  modalCloseButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  photoCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    marginHorizontal: 15,
    marginBottom: 15,
    overflow: 'hidden',
    shadowColor: '#000',
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
    backgroundColor: '#e2e8f0',
  },
  photoDeleteButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  photoDeleteButtonText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '300',
    lineHeight: 28,
  },
  photoInfo: {
    padding: 16,
  },
  photoDate: {
    fontSize: 13,
    color: '#718096',
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  photoCaption: {
    fontSize: 16,
    color: '#1a202c',
    fontWeight: '600',
    marginBottom: 8,
    lineHeight: 22,
  },
  photoCaptionPlaceholder: {
    fontSize: 14,
    color: '#a0aec0',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  photoBooksCount: {
    fontSize: 13,
    color: '#718096',
    fontWeight: '500',
    marginBottom: 8,
  },
  addToFolderSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    marginHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  addToFolderButtonLarge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#0056CC',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  addToFolderButtonTextLarge: {
    fontSize: 15,
    color: '#0056CC',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  editPhotoImage: {
    width: '100%',
    height: 300,
    backgroundColor: '#e2e8f0',
    marginBottom: 20,
  },
  captionSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    marginHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  captionLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  captionInput: {
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#1a202c',
    marginBottom: 16,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  saveCaptionButton: {
    backgroundColor: '#4caf50',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#4caf50',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  saveCaptionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  addBooksSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    marginHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  addBooksTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
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
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1a202c',
    marginRight: 8,
  },
  addBooksSearchButton: {
    backgroundColor: '#0056CC',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  addBooksSearchButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  addBooksResults: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 8,
  },
  addBooksResultRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  addBooksResultInfo: {
    flexDirection: 'column',
  },
  addBooksResultTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1a202c',
  },
  addBooksResultAuthor: {
    fontSize: 12,
    color: '#718096',
  },
  addedViaSearchSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 15,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  addedViaSearchTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
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
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    maxWidth: '48%',
  },
  addedChipText: {
    fontSize: 12,
    color: '#1a202c',
    flexShrink: 1,
    marginRight: 8,
  },
  addedChipRemove: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addedChipRemoveText: {
    fontSize: 14,
    color: '#4a5568',
    lineHeight: 18,
    marginTop: -1,
  },
  photoBooksSection: {
    marginHorizontal: 15,
    marginBottom: 20,
  },
  photoBooksTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a202c',
    marginBottom: 16,
    letterSpacing: 0.3,
  },
  photoBooksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  photoBookCard: {
    width: (screenWidth - 78) / 4,
    marginBottom: 12,
    marginHorizontal: 4,
    alignItems: 'center',
  },
  photoBookCover: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#e2e8f0',
  },
  photoBookTitle: {
    fontSize: 10,
    color: '#1a202c',
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 2,
    lineHeight: 12,
  },
  photoBookAuthor: {
    fontSize: 9,
    color: '#718096',
    textAlign: 'center',
    lineHeight: 11,
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
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 10,
  },
  confirmModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
  },
  confirmModalMessage: {
    fontSize: 15,
    color: '#4a5568',
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
    backgroundColor: '#f7fafc',
  },
  confirmModalButtonCancelText: {
    color: '#4a5568',
    fontSize: 15,
    fontWeight: '600',
  },
  confirmModalButtonDelete: {
    backgroundColor: '#e53e3e',
  },
  confirmModalButtonDeleteText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  placeholderTextSmall: {
    fontSize: 9,
    fontWeight: '700',
    color: '#4a5568',
    textAlign: 'center',
    lineHeight: 11,
    padding: 4,
  },
  folderItem: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    marginHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  folderItemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 4,
  },
  folderItemCount: {
    fontSize: 13,
    color: '#718096',
  },
  createFolderSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    marginHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  createFolderTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  createFolderRow: {
    flexDirection: 'row',
    gap: 12,
  },
  createFolderInput: {
    flex: 1,
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#1a202c',
  },
  createFolderButton: {
    backgroundColor: '#0056CC',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  createFolderButtonDisabled: {
    backgroundColor: '#cbd5e0',
    opacity: 0.6,
  },
  createFolderButtonText: {
    color: '#ffffff',
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
    color: '#1a202c',
    marginBottom: 16,
    letterSpacing: 0.3,
  },
});


