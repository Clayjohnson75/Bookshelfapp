import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  TextInput,
  Dimensions,
  FlatList,
  Modal,
  Alert,
  Share,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Book, Photo, Folder } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import BookDetailModal from '../components/BookDetailModal';

// Helper to read env vars
const getEnvVar = (key: string): string => {
  return Constants.expoConfig?.extra?.[key] || 
         Constants.manifest?.extra?.[key] || 
         process.env[key] || 
         '';
};

interface LibraryViewProps {
  onClose?: () => void;
  filterReadStatus?: 'read' | 'unread';
  onBooksUpdated?: () => void; // Callback to notify parent when books are updated
}

export const LibraryView: React.FC<LibraryViewProps> = ({ onClose, filterReadStatus, onBooksUpdated }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [dimensions, setDimensions] = useState(Dimensions.get('window'));
  
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setDimensions(window);
    });
    return () => subscription?.remove();
  }, []);
  
  const screenWidth = dimensions.width || 375; // Fallback to default width
  const screenHeight = dimensions.height || 667; // Fallback to default height
  
  const styles = useMemo(() => getStyles(screenWidth, screenHeight), [screenWidth, screenHeight]);
  
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showBookDetail, setShowBookDetail] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState<'MLA' | 'APA' | 'Chicago'>('MLA');
  const [selectedBooksForExport, setSelectedBooksForExport] = useState<Set<string>>(new Set());
  const [selectedFolderForExport, setSelectedFolderForExport] = useState<string | null>(null);
  const [exportAll, setExportAll] = useState(true);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const [showFolderView, setShowFolderView] = useState(false);
  const [folderSearchQuery, setFolderSearchQuery] = useState('');
  const [isFolderSelectionMode, setIsFolderSelectionMode] = useState(false);
  const [selectedFolderBooks, setSelectedFolderBooks] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [isFolderListSelectionMode, setIsFolderListSelectionMode] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'author' | 'oldest' | 'length'>('author');
  const [showSortModal, setShowSortModal] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [selectedBooksForNewFolder, setSelectedBooksForNewFolder] = useState<Set<string>>(new Set());
  const [newFolderNameInput, setNewFolderNameInput] = useState('');
  const [showFolderNameInput, setShowFolderNameInput] = useState(false);
  const [isAutoSorting, setIsAutoSorting] = useState(false);
  const [createFolderSearchQuery, setCreateFolderSearchQuery] = useState('');

  useEffect(() => {
    if (user) {
      loadBooks();
    }
  }, [user]);

  // Reload books when filter changes to ensure fresh data
  useEffect(() => {
    if (user && filterReadStatus) {
      loadBooks();
    }
  }, [filterReadStatus, user]);

  const deleteSelectedBooks = async () => {
    if (!user || selectedBooks.size === 0) return;

    const bookCount = selectedBooks.size;
    Alert.alert(
      'Delete Books',
      `Are you sure you want to delete ${bookCount} book${bookCount === 1 ? '' : 's'} from your library? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Get the books to delete
              const booksToDelete = books.filter(book => {
                const bookId = book.id || `${book.title}_${book.author || ''}`;
                return selectedBooks.has(bookId);
              });

              // Delete from Supabase
              const { deleteBookFromSupabase } = await import('../services/supabaseSync');
              for (const book of booksToDelete) {
                await deleteBookFromSupabase(user.uid, book);
              }

              // Update local state immediately
              setBooks(prev => prev.filter(book => {
                const bookId = book.id || `${book.title}_${book.author || ''}`;
                return !selectedBooks.has(bookId);
              }));

              // Clear selection and exit selection mode
              setSelectedBooks(new Set());
              setIsSelectionMode(false);

              // Reload to ensure sync
              await loadBooks();

              Alert.alert('Success', `${bookCount} book${bookCount === 1 ? '' : 's'} deleted.`);
            } catch (error) {
              console.error('Error deleting books:', error);
              Alert.alert('Error', 'Failed to delete books. Please try again.');
            }
          },
        },
      ]
    );
  };

  const loadBooks = async () => {
    if (!user) return;
    try {
      // Load from Supabase first (primary source of truth)
      let supabaseBooks = null;
      try {
        const { loadBooksFromSupabase } = await import('../services/supabaseSync');
        supabaseBooks = await loadBooksFromSupabase(user.uid);
      } catch (error) {
        console.error('Error loading books from Supabase:', error);
      }

      // Also load from AsyncStorage for backwards compatibility
      const userApprovedKey = `approved_books_${user.uid}`;
      const storedApproved = await AsyncStorage.getItem(userApprovedKey);
      const localBooks: Book[] = storedApproved ? JSON.parse(storedApproved) : [];

      // Merge Supabase books (which have readAt) with local books
      // Prioritize Supabase data as source of truth, but preserve readAt from local if more recent
      let mergedBooks: Book[] = [];
      if (supabaseBooks && supabaseBooks.approved && supabaseBooks.approved.length > 0) {
        // Create a map of local books by title+author for quick lookup
        const localBooksMap = new Map<string, Book>();
        localBooks.forEach(b => {
          const key = `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`;
          if (!localBooksMap.has(key)) {
            localBooksMap.set(key, b);
          }
        });
        
        // Use Supabase books as primary, but merge readAt from local if it's more recent
        mergedBooks = supabaseBooks.approved.map(supabaseBook => {
          const key = `${supabaseBook.title?.toLowerCase().trim()}|${supabaseBook.author?.toLowerCase().trim() || ''}`;
          const localBook = localBooksMap.get(key);
          
          // If local book has a more recent readAt, use it
          if (localBook && localBook.readAt) {
            if (!supabaseBook.readAt || (localBook.readAt > supabaseBook.readAt)) {
              return { ...supabaseBook, readAt: localBook.readAt };
            }
          }
          
          return supabaseBook;
        });
        
        // Merge in any local books that aren't in Supabase
        const supabaseBookKeys = new Set(
          mergedBooks.map(b => `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`)
        );
        
        const localOnlyBooks = localBooks.filter(b => {
          const key = `${b.title?.toLowerCase().trim()}|${b.author?.toLowerCase().trim() || ''}`;
          return !supabaseBookKeys.has(key);
        });
        
        if (localOnlyBooks.length > 0) {
          mergedBooks = [...mergedBooks, ...localOnlyBooks];
        }
      } else {
        mergedBooks = localBooks;
      }
      
      setBooks(mergedBooks);

      // Load photos to find source photo for books
      const photosKey = `@${user.uid}:photos`;
      const storedPhotos = await AsyncStorage.getItem(photosKey);
      if (storedPhotos) {
        const loadedPhotos: Photo[] = JSON.parse(storedPhotos);
        setPhotos(loadedPhotos);
      }

      // Load folders
      const foldersKey = `folders_${user.uid}`;
      const storedFolders = await AsyncStorage.getItem(foldersKey);
      if (storedFolders) {
        const loadedFolders: Folder[] = JSON.parse(storedFolders);
        setFolders(loadedFolders);
      }
    } catch (error) {
      console.error('Error loading books:', error);
    }
  };

  const filteredBooks = useMemo(() => {
    // First filter by read status if specified
    let filtered = books;
    if (filterReadStatus === 'read') {
      // Show only books that have been marked as read (readAt is a valid timestamp)
      filtered = books.filter(b => {
        // Check if readAt exists and is a valid positive number
        const isRead = b.readAt !== undefined && 
                      b.readAt !== null && 
                      typeof b.readAt === 'number' && 
                      b.readAt > 0;
        if (!isRead && filterReadStatus === 'read') {
          // Debug: log why book isn't showing
          console.log(`⚠️ Book "${b.title}" filtered out of read view - readAt:`, b.readAt, 'type:', typeof b.readAt);
        }
        return isRead;
      });
      console.log(`📖 Filtered to ${filtered.length} read books from ${books.length} total books`);
      if (filtered.length > 0) {
        console.log(`📖 Read books:`, filtered.map(b => `"${b.title}" (readAt: ${b.readAt})`));
      }
    } else if (filterReadStatus === 'unread') {
      // Show only books that haven't been marked as read
      filtered = books.filter(b => {
        // Book is unread if readAt is undefined, null, or not a valid positive number
        const isUnread = !b.readAt || 
                        b.readAt === null || 
                        (typeof b.readAt === 'number' && b.readAt <= 0);
        if (!isUnread && filterReadStatus === 'unread') {
          // Debug: log why book isn't showing
          console.log(`⚠️ Book "${b.title}" filtered out of unread view - readAt:`, b.readAt, 'type:', typeof b.readAt);
        }
        return isUnread;
      });
      console.log(`📚 Filtered to ${filtered.length} unread books from ${books.length} total books`);
    }

    // Then filter by search query
    const q = searchQuery.trim().toLowerCase();
    if (!q) return filtered;

    const startsWithMatches = filtered.filter(b => {
      const title = (b.title || '').toLowerCase();
      const author = (b.author || '').toLowerCase();
      return title.startsWith(q) || author.startsWith(q);
    });

    const containsMatches = filtered.filter(b => {
      const title = (b.title || '').toLowerCase();
      const author = (b.author || '').toLowerCase();
      return (title.includes(q) || author.includes(q)) && !(title.startsWith(q) || author.startsWith(q));
    });

    return [...startsWithMatches, ...containsMatches];
  }, [books, searchQuery, filterReadStatus]);

  const sortedBooks = useMemo(() => {
    const extractLastName = (author?: string): string => {
      if (!author) return '';
      const firstAuthor = author.split(/,|&| and /i)[0].trim();
      const parts = firstAuthor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '';
      return parts[parts.length - 1].replace(/,/, '').toLowerCase();
    };

    const books = [...filteredBooks];
    const booksWithData: Book[] = [];
    const booksWithoutData: Book[] = [];

    if (sortBy === 'author') {
      // Sort by author last name (default)
      books.forEach(book => {
        const lastName = extractLastName(book.author);
        if (lastName) {
          booksWithData.push(book);
        } else {
          booksWithoutData.push(book);
        }
      });

      booksWithData.sort((a, b) => {
        const aLast = extractLastName(a.author);
        const bLast = extractLastName(b.author);
        const comparison = aLast.localeCompare(bLast);
        // If last names are the same, sort by title
        if (comparison === 0) {
          return (a.title || '').localeCompare(b.title || '');
        }
        return comparison;
      });

      // Sort books without data by title
      booksWithoutData.sort((a, b) => {
        return (a.title || '').localeCompare(b.title || '');
      });

      return { booksWithData, booksWithoutData };
    } else if (sortBy === 'oldest') {
      // Sort by oldest to newest (by publishedDate)
      books.forEach(book => {
        const publishedDate = book.publishedDate;
        if (publishedDate && publishedDate.trim()) {
          // Try to extract year from publishedDate (could be "2023", "2023-01-15", etc.)
          const yearMatch = publishedDate.match(/\d{4}/);
          if (yearMatch) {
            const year = parseInt(yearMatch[0], 10);
            if (year > 0 && year <= new Date().getFullYear() + 10) { // Reasonable year range
              booksWithData.push(book);
            } else {
              booksWithoutData.push(book);
            }
          } else {
            booksWithoutData.push(book);
          }
        } else {
          booksWithoutData.push(book);
        }
      });

      booksWithData.sort((a, b) => {
        // Extract year from publishedDate
        const aYearMatch = a.publishedDate?.match(/\d{4}/);
        const bYearMatch = b.publishedDate?.match(/\d{4}/);
        
        const aYear = aYearMatch ? parseInt(aYearMatch[0], 10) : 0;
        const bYear = bYearMatch ? parseInt(bYearMatch[0], 10) : 0;
        
        // If years are the same, try to compare full dates if available
        if (aYear === bYear && aYear > 0) {
          try {
            const aDate = new Date(a.publishedDate || '').getTime();
            const bDate = new Date(b.publishedDate || '').getTime();
            if (!isNaN(aDate) && !isNaN(bDate)) {
              return aDate - bDate; // Oldest first
            }
          } catch (e) {
            // Fall back to year comparison
          }
        }
        
        return aYear - bYear; // Oldest first
      });

      // Sort books without data by title
      booksWithoutData.sort((a, b) => {
        return (a.title || '').localeCompare(b.title || '');
      });

      return { booksWithData, booksWithoutData };
    } else if (sortBy === 'length') {
      // Sort by length (pageCount)
      books.forEach(book => {
        const pages = book.pageCount || 0;
        if (pages > 0) {
          booksWithData.push(book);
        } else {
          booksWithoutData.push(book);
        }
      });

      booksWithData.sort((a, b) => {
        const aPages = a.pageCount || 0;
        const bPages = b.pageCount || 0;
        return bPages - aPages; // Longest first
      });

      // Sort books without data by title
      booksWithoutData.sort((a, b) => {
        return (a.title || '').localeCompare(b.title || '');
      });

      return { booksWithData, booksWithoutData };
    }

    return { booksWithData: books, booksWithoutData: [] };
  }, [filteredBooks, sortBy]);

  // Separate books with and without data for rendering
  const { booksWithData = [], booksWithoutData = [] } = sortedBooks || { booksWithData: [], booksWithoutData: [] };
  const allSortedBooks = [...booksWithData, ...booksWithoutData];

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

  const findBookPhoto = (book: Book): Photo | null => {
    return photos.find(photo => 
      photo.books && photo.books.some(photoBook => 
        photoBook.title === book.title && 
        photoBook.author === book.author
      )
    ) || null;
  };

  const handleCreateFolder = async (bookIds?: string[]) => {
    const folderName = bookIds ? newFolderNameInput.trim() : newFolderName.trim();
    if (!folderName || !user) return;
    
    try {
      const folderId = `folder_${Date.now()}`;
      const newFolder: Folder = {
        id: folderId,
        name: folderName,
        bookIds: bookIds || Array.from(selectedBooksForNewFolder),
        photoIds: [],
        createdAt: Date.now(),
      };
      
      const updatedFolders = [...folders, newFolder];
      setFolders(updatedFolders);
      
      const foldersKey = `folders_${user.uid}`;
      await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
      
      setNewFolderName('');
      setNewFolderNameInput('');
      setSelectedBooksForNewFolder(new Set());
      setIsCreatingFolder(false);
      setShowFolderNameInput(false);
      Alert.alert('Success', `Folder "${newFolder.name}" created with ${newFolder.bookIds.length} book${newFolder.bookIds.length === 1 ? '' : 's'}!`);
    } catch (error) {
      console.error('Error creating folder:', error);
      Alert.alert('Error', 'Failed to create folder. Please try again.');
    }
  };

  const autoSortBooksIntoFolders = async () => {
    if (!user || books.length === 0) {
      Alert.alert('No Books', 'You need books in your library to auto-sort them.');
      return;
    }

    // Get all book IDs that are already in existing folders
    const booksInExistingFolders = new Set<string>();
    folders.forEach(folder => {
      folder.bookIds.forEach(bookId => {
        booksInExistingFolders.add(bookId);
      });
    });

    // Only include books that are NOT already in folders
    const booksToSort = books.filter(book => {
      const bookId = book.id || `${book.title}_${book.author || ''}`;
      return !booksInExistingFolders.has(bookId);
    });

    if (booksToSort.length === 0) {
      Alert.alert('All Books Organized', 'All your books are already in folders. No books to sort.');
      return;
    }

    Alert.alert(
      'Auto-Sort Books by Genre',
      `This will organize ${booksToSort.length} unorganized books into folders by genre. Your existing ${folders.length} folder${folders.length === 1 ? '' : 's'} will be preserved. Continue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sort',
          onPress: async () => {
            setIsAutoSorting(true);
            try {
              // Get API base URL
              const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://bookshelfscan.app';
              
              if (!baseUrl) {
                throw new Error('API server URL not configured');
              }
              
              console.log('🤖 Starting auto-sort via API...');
              
              // Prepare existing folders info for the API
              const existingFoldersInfo = folders.map(folder => ({
                name: folder.name,
                bookIds: folder.bookIds,
              }));

              const response = await fetch(`${baseUrl}/api/auto-sort-books`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  books: booksToSort.map(book => ({
                    id: book.id || `${book.title}_${book.author || ''}`,
                    title: book.title,
                    author: book.author,
                  })),
                  existingFolders: existingFoldersInfo,
                }),
              });

              if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || 'Failed to sort books');
              }

              const data = await response.json();
              
              if (!data.success || !data.folders || !Array.isArray(data.folders)) {
                throw new Error('Invalid response from server');
              }

              // Update existing folders with new book assignments
              const updatedFolders = folders.map(folder => {
                const update = data.existingFolderUpdates?.find((u: any) => 
                  u.folderName.toLowerCase() === folder.name.toLowerCase()
                );
                if (update && update.bookIds.length > 0) {
                  // Add new books to existing folder (avoid duplicates)
                  const existingBookIds = new Set(folder.bookIds);
                  const newBookIds = update.bookIds.filter((id: string) => !existingBookIds.has(id));
                  return {
                    ...folder,
                    bookIds: [...folder.bookIds, ...newBookIds],
                  };
                }
                return folder;
              });

              // Create new folders from the AI response
              const newFolders: Folder[] = (data.newFolders || data.folders || []).map((group: { folderName: string; bookIds: string[] }) => ({
                id: `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                name: group.folderName,
                bookIds: group.bookIds,
                photoIds: [],
                createdAt: Date.now(),
              }));

              // Merge updated existing folders with new folders
              const finalFolders = [...updatedFolders, ...newFolders];
              setFolders(finalFolders);
              
              // Save to AsyncStorage
              const foldersKey = `folders_${user.uid}`;
              await AsyncStorage.setItem(foldersKey, JSON.stringify(finalFolders));

              const updatedCount = data.existingFolderUpdates?.length || 0;
              const newCount = newFolders.length;
              const updatedBooksCount = data.existingFolderUpdates?.reduce((sum: number, u: any) => sum + u.bookIds.length, 0) || 0;
              const newBooksCount = newFolders.reduce((sum, f) => sum + f.bookIds.length, 0);

              let message = `Organized ${booksToSort.length} book${booksToSort.length === 1 ? '' : 's'}: `;
              if (updatedCount > 0) {
                message += `Added ${updatedBooksCount} to ${updatedCount} existing folder${updatedCount === 1 ? '' : 's'}`;
                if (newCount > 0) {
                  message += `, created ${newCount} new folder${newCount === 1 ? '' : 's'}`;
                }
              } else {
                message += `Created ${newCount} new folder${newCount === 1 ? '' : 's'}`;
              }
              message += '.';

              Alert.alert('Success!', message, [{ text: 'OK' }]);

              // Notify parent if callback exists
              if (onBooksUpdated) {
                onBooksUpdated();
              }
            } catch (error: any) {
              console.error('Error auto-sorting books:', error);
              Alert.alert(
                'Error',
                error?.message || 'Failed to auto-sort books. Please try again.'
              );
            } finally {
              setIsAutoSorting(false);
            }
          },
        },
      ]
    );
  };

  const openBookDetail = (book: Book) => {
    setSelectedBook(book);
    const sourcePhoto = findBookPhoto(book);
    setSelectedPhoto(sourcePhoto);
    setShowBookDetail(true);
  };

  const renderFolderBook = ({ item, index }: { item: Book; index: number }) => {
    const bookId = item.id || `${item.title}_${item.author || ''}`;
    const isSelected = selectedFolderBooks.has(bookId);
    
    return (
      <TouchableOpacity
        style={[
          styles.bookCard,
          isFolderSelectionMode && isSelected && styles.selectedBookCard
        ]}
        onPress={() => {
          if (isFolderSelectionMode) {
            setSelectedFolderBooks(prev => {
              const newSet = new Set(prev);
              if (newSet.has(bookId)) {
                newSet.delete(bookId);
              } else {
                newSet.add(bookId);
              }
              return newSet;
            });
          } else {
            const photo = findBookPhoto(item);
            setSelectedBook(item);
            setSelectedPhoto(photo);
            setShowBookDetail(true);
          }
        }}
        activeOpacity={0.7}
      >
        {isFolderSelectionMode && (
          <View style={styles.selectionOverlay}>
            {isSelected && (
              <View style={styles.selectionCheckmark}>
                <Ionicons name="checkmark-circle" size={24} color="#4299e1" />
              </View>
            )}
          </View>
        )}
        {getBookCoverUri(item) ? (
          <Image 
            source={{ uri: getBookCoverUri(item) }} 
            style={[
              styles.bookCover,
              isFolderSelectionMode && isSelected && styles.selectedBookCover
            ]}
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
  };

  const fetchBookDetails = async (book: Book): Promise<{
    publisher?: string;
    publishedDate?: string;
    publisherLocation?: string;
  }> => {
    // If book already has publisher data, return it (no API call needed)
    if (book.publisher && book.publishedDate) {
      return {
        publisher: book.publisher,
        publishedDate: book.publishedDate,
        publisherLocation: undefined, // Not stored in book object
      };
    }

    // If we have googleBooksId, use centralized service
    if (book.googleBooksId) {
      try {
        const { fetchBookData } = await import('../services/googleBooksService');
        const bookData = await fetchBookData(book.title, book.author, book.googleBooksId);
        
        return {
          publisher: bookData.publisher,
          publishedDate: bookData.publishedDate,
          publisherLocation: undefined, // Not available in Google Books API
        };
      } catch (error) {
        console.warn('Error fetching book details:', error);
        return {};
      }
    }

    return {};
  };

  const formatAuthorName = (author: string, format: 'MLA' | 'APA' | 'Chicago'): string => {
    if (!author || author === 'Unknown Author') return '';
    
    const authorParts = author.split(/\s+/).filter(Boolean);
    if (authorParts.length === 0) return '';
    
    const lastName = authorParts[authorParts.length - 1];
    const firstParts = authorParts.slice(0, -1);
    
    if (format === 'APA') {
      // APA: LastName, F. M.
      const initials = firstParts.map(n => n[0]?.toUpperCase() || '').join('. ');
      return `${lastName}, ${initials}${initials ? '.' : ''}`;
    } else {
      // MLA and Chicago: LastName, FirstName
      const firstName = firstParts.join(' ');
      return `${lastName}, ${firstName}`;
    }
  };

  const extractYear = (dateString?: string): string => {
    if (!dateString) return 'n.d.';
    // Extract year from various date formats (e.g., "2023", "2023-01-15", "January 2023")
    const yearMatch = dateString.match(/\d{4}/);
    return yearMatch ? yearMatch[0] : 'n.d.';
  };

  const formatMLA = (book: Book, details?: { publisher?: string; publishedDate?: string }): string => {
    const author = formatAuthorName(book.author || '', 'MLA');
    const title = book.title || 'Untitled';
    const publisher = details?.publisher || 'n.p.';
    const year = extractYear(details?.publishedDate);
    
    if (!author) {
      return `"${title}." ${publisher}, ${year}.`;
    }
    
    // MLA: Author Last, First. Title. Publisher, Publication Date.
    return `${author}. ${title}. ${publisher}, ${year}.`;
  };

  const formatAPA = (book: Book, details?: { publisher?: string; publishedDate?: string }): string => {
    const author = formatAuthorName(book.author || '', 'APA');
    const title = book.title || 'Untitled';
    const year = extractYear(details?.publishedDate);
    const publisher = details?.publisher || 'n.p.';
    
    if (!author) {
      return `${title}. (${year}). ${publisher}.`;
    }
    
    // APA: Author Last, F. M. (Year). Title. Publisher.
    return `${author} (${year}). ${title}. ${publisher}.`;
  };

  const formatChicago = (book: Book, details?: { publisher?: string; publishedDate?: string; publisherLocation?: string }): string => {
    const author = formatAuthorName(book.author || '', 'Chicago');
    const title = book.title || 'Untitled';
    const place = details?.publisherLocation || 'n.p.';
    const publisher = details?.publisher || 'n.p.';
    const year = extractYear(details?.publishedDate);
    
    if (!author) {
      return `${title}. ${place}: ${publisher}, ${year}.`;
    }
    
    // Chicago: Author Last, First. Title. Place: Publisher, Year.
    return `${author}. ${title}. ${place}: ${publisher}, ${year}.`;
  };

  const formatBook = (book: Book, details?: { publisher?: string; publishedDate?: string; publisherLocation?: string }): string => {
    switch (exportFormat) {
      case 'MLA':
        return formatMLA(book, details);
      case 'APA':
        return formatAPA(book, details);
      case 'Chicago':
        return formatChicago(book, details);
      default:
        return formatMLA(book, details);
    }
  };

  const handleExport = async () => {
    let booksToExport: Book[] = [];

    if (selectedFolderForExport) {
      // Export books from selected folder
      const folder = folders.find(f => f.id === selectedFolderForExport);
      if (folder) {
        booksToExport = books.filter(book => 
          book.id && folder.bookIds.includes(book.id)
        );
      }
    } else if (exportAll) {
      booksToExport = sortedBooks;
    } else {
      booksToExport = sortedBooks.filter(book => 
        selectedBooksForExport.has(book.id || `${book.title}_${book.author}`)
      );
    }

    if (booksToExport.length === 0) {
      Alert.alert('No Books Selected', 'Please select at least one book or folder to export.');
      return;
    }

    // Show loading alert
    Alert.alert('Exporting...', 'Fetching book details for proper citations. This may take a moment.');

    try {
      // Fetch details for all books (in parallel, but with rate limiting)
      const bookDetailsPromises = booksToExport.map(async (book) => {
        const details = await fetchBookDetails(book);
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        return details;
      });

      const allDetails = await Promise.all(bookDetailsPromises);

      // Format all books with their details
      const formattedCitations = booksToExport
        .map((book, index) => {
          const details = allDetails[index];
          const citation = formatBook(book, details);
          return `${index + 1}. ${citation}`;
        })
        .join('\n\n');

      // Use appropriate header based on format
      const header = exportFormat === 'MLA' 
        ? 'Works Cited' 
        : exportFormat === 'APA' 
        ? 'References' 
        : 'Bibliography';
      
      const exportText = `${header}\n\n${formattedCitations}`;

      // Copy to clipboard
      await Clipboard.setStringAsync(exportText);
      
      // Also offer to share
      const result = await Share.share({
        message: exportText,
        title: `Exported ${booksToExport.length} Book${booksToExport.length === 1 ? '' : 's'}`,
      });

      if (result.action === Share.sharedAction) {
        Alert.alert('Success', 'Books exported and copied to clipboard!');
        setShowExportModal(false);
      } else {
        Alert.alert('Success', 'Books copied to clipboard!');
        setShowExportModal(false);
      }
    } catch (error) {
      console.error('Error exporting books:', error);
      Alert.alert('Error', 'Failed to export books. Please try again.');
    }
  };

  return (
    <View style={styles.safeContainer}>
      <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
        <View style={[styles.header, { paddingTop: insets.top + 5 }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            if (onClose) {
              onClose();
            } else {
              navigation.goBack();
            }
          }}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        >
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {filterReadStatus === 'read' ? 'Read Books' : 
           filterReadStatus === 'unread' ? 'Unread Books' : 
           'My Library'}
        </Text>
        <View style={styles.headerRight} />
      </View>

      {/* Always show Folders/Export buttons at the top */}
      <View style={styles.exportButtonContainer}>
        <View style={styles.topActionButtonsRow}>
          <TouchableOpacity
            style={styles.foldersButton}
            onPress={() => {
              setShowFolderView(true);
              setSelectedFolder(null);
            }}
            activeOpacity={0.8}
          >
            <Ionicons name="folder-outline" size={20} color="#ffffff" />
            <Text style={styles.exportButtonText}>Folders</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.exportButton}
            onPress={() => setShowExportModal(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={20} color="#ffffff" />
            <Text style={styles.exportButtonText}>Export</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView 
        style={styles.mainScrollView}
        contentContainerStyle={isSelectionMode && filterReadStatus && selectedBooks.size > 0 ? { paddingBottom: 100 } : undefined}
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={false}
      >
        {/* Export Modal - Appears inline between buttons and search */}
        {showExportModal && (
          <View style={styles.exportModalInline}>
              <View style={styles.exportModalHeader}>
                <Text style={styles.exportModalTitle}>Export Books</Text>
                <TouchableOpacity
                  onPress={() => setShowExportModal(false)}
                  style={styles.exportModalCloseButton}
                >
                  <Ionicons name="close" size={20} color="#718096" />
                </TouchableOpacity>
              </View>

              <View style={styles.exportModalBody}>
              {/* Format Selection */}
              <View style={styles.formatSection}>
                <Text style={styles.sectionLabel}>Citation Format</Text>
                <View style={styles.formatButtons}>
                  {(['MLA', 'APA', 'Chicago'] as const).map((format) => (
                    <TouchableOpacity
                      key={format}
                      style={[
                        styles.formatButton,
                        exportFormat === format && styles.formatButtonActive,
                      ]}
                      onPress={() => setExportFormat(format)}
                    >
                      <Text
                        style={[
                          styles.formatButtonText,
                          exportFormat === format && styles.formatButtonTextActive,
                        ]}
                      >
                        {format}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Selection Mode */}
              <View style={styles.selectionSection}>
                <Text style={styles.sectionLabel}>Select Books</Text>
                <TouchableOpacity
                  style={styles.selectionOption}
                  onPress={() => {
                    setExportAll(true);
                    setSelectedBooksForExport(new Set());
                    setSelectedFolderForExport(null);
                  }}
                >
                  <View style={styles.radioButton}>
                    {exportAll && !selectedFolderForExport && <View style={styles.radioButtonInner} />}
                  </View>
                  <Text style={styles.selectionOptionText}>All Books ({allSortedBooks.length})</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.selectionOption}
                  onPress={() => {
                    setExportAll(false);
                    setSelectedFolderForExport(null);
                  }}
                >
                  <View style={styles.radioButton}>
                    {!exportAll && !selectedFolderForExport && <View style={styles.radioButtonInner} />}
                  </View>
                  <Text style={styles.selectionOptionText}>Select Individual Books</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.selectionOption}
                  onPress={() => {
                    setExportAll(false);
                    setSelectedBooksForExport(new Set());
                    setShowFolderView(true);
                    setSelectedFolder(null);
                  }}
                >
                  <View style={styles.radioButton}>
                    {selectedFolderForExport !== null && <View style={styles.radioButtonInner} />}
                  </View>
                  <Text style={styles.selectionOptionText}>
                    {folders.length > 0 ? 'Select a Folder' : 'Select a Folder (No folders yet)'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Folder Selection */}
              {folders.length > 0 && (
                <View style={styles.folderSelectionSection}>
                  <Text style={styles.sectionLabel}>Folders</Text>
                  <View style={styles.foldersList}>
                    {folders.map((folder) => {
                      const folderBooks = books.filter(book => 
                        book.id && folder.bookIds.includes(book.id)
                      );
                      const isSelected = selectedFolderForExport === folder.id;
                      return (
                        <TouchableOpacity
                          key={folder.id}
                          style={[
                            styles.folderSelectItem,
                            isSelected && styles.folderSelectItemActive,
                          ]}
                          onPress={() => {
                            if (isSelected) {
                              setSelectedFolderForExport(null);
                            } else {
                              setSelectedFolderForExport(folder.id);
                              setExportAll(false);
                              setSelectedBooksForExport(new Set());
                            }
                          }}
                        >
                          <View style={styles.checkbox}>
                            {isSelected && <Ionicons name="checkmark" size={18} color="#ffffff" />}
                          </View>
                          <Ionicons 
                            name={isSelected ? "folder" : "folder-outline"} 
                            size={24} 
                            color={isSelected ? "#0056CC" : "#718096"} 
                            style={{ marginRight: 12 }}
                          />
                          <View style={styles.folderSelectInfo}>
                            <Text style={styles.folderSelectName}>{folder.name}</Text>
                            <Text style={styles.folderSelectCount}>
                              {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* Book Selection Info */}
              {!exportAll && !selectedFolderForExport && (
                <View style={styles.booksListSection}>
                  <Text style={styles.sectionLabel}>
                    Select Books ({selectedBooksForExport.size} selected)
                  </Text>
                </View>
              )}
            </View>

            {/* Export Button */}
            <View style={styles.exportModalFooter}>
              <TouchableOpacity
                style={[
                  styles.exportActionButton,
                  (!exportAll && selectedBooksForExport.size === 0 && !selectedFolderForExport) && styles.exportActionButtonDisabled,
                ]}
                onPress={handleExport}
                disabled={!exportAll && selectedBooksForExport.size === 0 && !selectedFolderForExport}
                activeOpacity={0.8}
              >
                <Ionicons name="download" size={18} color="#ffffff" />
                <Text style={styles.exportActionButtonText}>Export</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.searchContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search your library..."
            placeholderTextColor="#a0aec0"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          <Ionicons name="search" size={20} color="#a0aec0" style={styles.searchIcon} />
        </View>

        {/* Select and Sort Buttons */}
        <View style={styles.actionButtonsRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              setIsSelectionMode(!isSelectionMode);
              if (isSelectionMode) {
                setSelectedBooks(new Set());
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.actionButtonText}>
              {isSelectionMode ? 'Cancel' : 'Select'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => setShowSortModal(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="swap-vertical" size={16} color="#ffffff" style={{ marginRight: 6 }} />
            <Text style={styles.actionButtonText}>Sort</Text>
          </TouchableOpacity>
        </View>

        {allSortedBooks.length > 0 ? (
          <View style={styles.booksContainer}>
            {/* Books with data */}
            {booksWithData.length > 0 && booksWithData.map((item, index) => {
              if (index % 4 === 0) {
                return (
                  <View key={`row-${index}`} style={styles.bookGrid}>
                      {booksWithData.slice(index, index + 4).map((book) => {
                        const bookId = book.id || `${book.title}_${book.author}`;
                        const isSelectedForExport = !exportAll && !selectedFolderForExport && selectedBooksForExport.has(bookId);
                        const isSelectedForRead = isSelectionMode && selectedBooks.has(bookId);
                        const isSelected = isSelectedForExport || isSelectedForRead;
                      return (
                        <TouchableOpacity
                          key={book.id || book.title + book.author}
                          style={[
                            styles.bookCard,
                            isSelected && styles.bookCardSelected,
                          ]}
                          onPress={() => {
                            if (isSelectionMode) {
                              // In selection mode, toggle selection
                              setSelectedBooks(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(bookId)) {
                                  newSet.delete(bookId);
                                } else {
                                  newSet.add(bookId);
                                }
                                return newSet;
                              });
                            } else if (showExportModal && !exportAll && !selectedFolderForExport) {
                              // In export mode, toggle selection
                              const newSet = new Set(selectedBooksForExport);
                              if (isSelectedForExport) {
                                newSet.delete(bookId);
                              } else {
                                newSet.add(bookId);
                              }
                              setSelectedBooksForExport(newSet);
                            } else {
                              // Normal mode, open book detail
                              openBookDetail(book);
                            }
                          }}
                        >
                          {isSelectionMode && isSelectedForRead && (
                            <View style={styles.bookSelectionIndicator}>
                              <View style={styles.bookSelectionCheckmark}>
                                <Ionicons name="checkmark" size={16} color="#ffffff" />
                              </View>
                            </View>
                          )}
                          {getBookCoverUri(book) ? (
                            <Image source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} />
                          ) : (
                            <View style={[styles.bookCover, styles.placeholderCover]}>
                              <Ionicons name="book-outline" size={32} color="#a0aec0" />
                            </View>
                          )}
                          <View style={styles.bookInfo}>
                            <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                            {book.author && (
                              <Text style={styles.bookAuthor} numberOfLines={1}>{book.author}</Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              }
              return null;
            })}

            {/* Separator for books without data */}
            {booksWithData.length > 0 && booksWithoutData.length > 0 && (
              <View style={styles.noDataSeparator}>
                <View style={styles.noDataSeparatorLine} />
                <Text style={styles.noDataSeparatorText}>
                  {sortBy === 'author' && 'Books without author'}
                  {sortBy === 'oldest' && 'Books without published date'}
                  {sortBy === 'length' && 'Books without page count'}
                </Text>
                <View style={styles.noDataSeparatorLine} />
              </View>
            )}

            {/* Books without data */}
            {booksWithoutData.length > 0 && booksWithoutData.map((item, index) => {
              if (index % 4 === 0) {
                return (
                  <View key={`row-no-data-${index}`} style={styles.bookGrid}>
                      {booksWithoutData.slice(index, index + 4).map((book) => {
                        const bookId = book.id || `${book.title}_${book.author}`;
                        const isSelectedForExport = !exportAll && !selectedFolderForExport && selectedBooksForExport.has(bookId);
                        const isSelectedForRead = isSelectionMode && selectedBooks.has(bookId);
                        const isSelected = isSelectedForExport || isSelectedForRead;
                      return (
                        <TouchableOpacity
                          key={book.id || book.title + book.author}
                          style={[
                            styles.bookCard,
                            isSelected && styles.bookCardSelected,
                          ]}
                          onPress={() => {
                            if (isSelectionMode) {
                              // In selection mode, toggle selection
                              setSelectedBooks(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(bookId)) {
                                  newSet.delete(bookId);
                                } else {
                                  newSet.add(bookId);
                                }
                                return newSet;
                              });
                            } else if (showExportModal && !exportAll && !selectedFolderForExport) {
                              // In export mode, toggle selection
                              const newSet = new Set(selectedBooksForExport);
                              if (isSelectedForExport) {
                                newSet.delete(bookId);
                              } else {
                                newSet.add(bookId);
                              }
                              setSelectedBooksForExport(newSet);
                            } else {
                              // Normal mode, open book detail
                              openBookDetail(book);
                            }
                          }}
                        >
                          {isSelectionMode && isSelectedForRead && (
                            <View style={styles.bookSelectionIndicator}>
                              <View style={styles.bookSelectionCheckmark}>
                                <Ionicons name="checkmark" size={16} color="#ffffff" />
                              </View>
                            </View>
                          )}
                          {getBookCoverUri(book) ? (
                            <Image source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} />
                          ) : (
                            <View style={[styles.bookCover, styles.placeholderCover]}>
                              <Ionicons name="book-outline" size={32} color="#a0aec0" />
                            </View>
                          )}
                          <View style={styles.bookInfo}>
                            <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                            {book.author && (
                              <Text style={styles.bookAuthor} numberOfLines={1}>{book.author}</Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              }
              return null;
              })}
        </View>
        ) : (
          <View style={styles.emptyContainer}>
            <Ionicons name="library-outline" size={64} color="#cbd5e0" />
            <Text style={styles.emptyText}>
              {searchQuery ? 'No books found' : 'No books in your library yet'}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Bottom Action Bar for Read/Unread Selection */}
      {isSelectionMode && filterReadStatus && selectedBooks.size > 0 && (
        <View style={[styles.bottomActionBar, { paddingBottom: insets.bottom }]}>
          <Text style={styles.bottomActionBarText}>
            {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'} selected
          </Text>
          <TouchableOpacity
            style={styles.bottomActionButton}
            onPress={async () => {
              if (!user) return;
              
              const newReadAt = filterReadStatus === 'unread' ? Date.now() : null;
              const booksToUpdate = sortedBooks.filter(book => {
                const bookId = book.id || `${book.title}_${book.author}`;
                return selectedBooks.has(bookId);
              });

              try {
                // Update AsyncStorage
                const userApprovedKey = `approved_books_${user.uid}`;
                const approvedData = await AsyncStorage.getItem(userApprovedKey);
                
                if (approvedData) {
                  const approvedBooks: Book[] = JSON.parse(approvedData);
                  
                  const updatedBooks = approvedBooks.map((b) => {
                    const matches = booksToUpdate.some(bookToUpdate => 
                      b.title === bookToUpdate.title && 
                      ((!b.author && !bookToUpdate.author) || (b.author === bookToUpdate.author))
                    );
                    
                    if (matches) {
                      return {
                        ...b,
                        readAt: newReadAt || undefined,
                      };
                    }
                    return b;
                  });
                  
                  await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                }

                // Update Supabase - CRITICAL: This must succeed for data to persist
                const { supabase } = await import('../lib/supabaseClient');
                if (supabase) {
                  const updatePromises = booksToUpdate.map(async (book) => {
                    const authorForQuery = book.author || '';
                    const { data: existingBook, error: findError } = await supabase
                      .from('books')
                      .select('id')
                      .eq('user_id', user.uid)
                      .eq('title', book.title)
                      .eq('author', authorForQuery)
                      .maybeSingle();

                    if (findError) {
                      console.error(`❌ Error finding book "${book.title}" in Supabase:`, findError);
                      return false;
                    }

                    if (existingBook) {
                      // Ensure newReadAt is either a number (BIGINT) or null for Supabase
                      const readAtValue = newReadAt && typeof newReadAt === 'number' && newReadAt > 0 
                        ? newReadAt 
                        : null;
                      
                      const { data, error: updateError } = await supabase
                        .from('books')
                        .update({
                          read_at: readAtValue, // BIGINT timestamp or null
                          updated_at: new Date().toISOString(),
                        })
                        .eq('id', existingBook.id)
                        .select(); // Select to verify update

                      if (updateError) {
                        // Log full error details
                        console.error(`❌ Error updating book "${book.title}" in Supabase:`, JSON.stringify(updateError, null, 2));
                        console.error(`   - Message:`, updateError.message);
                        console.error(`   - Code:`, updateError.code);
                        console.error(`   - Details:`, updateError.details);
                        console.error(`   - Hint:`, updateError.hint);
                        console.error(`   - Book ID:`, existingBook.id);
                        console.error(`   - ReadAt Value:`, readAtValue, `(type: ${typeof readAtValue})`);
                        console.error(`   - User ID:`, user.uid);
                        return false;
                      }
                      
                      if (!data || data.length === 0) {
                        console.warn(`⚠️ Book "${book.title}" update returned no data - update may have failed`);
                        return false;
                      }
                      
                      console.log(`✅ Updated book "${book.title}" read_at to:`, readAtValue);
                      console.log(`   - Updated record:`, data[0]);
                      return true;
                    } else {
                      console.warn(`⚠️ Book "${book.title}" not found in Supabase, cannot update read_at`);
                      return false;
                    }
                  });

                  const results = await Promise.all(updatePromises);
                  const successCount = results.filter(r => r === true).length;
                  console.log(`📊 Supabase update: ${successCount}/${booksToUpdate.length} books updated successfully`);
                }

                // Update local state immediately with proper readAt values
                // This ensures books disappear/appear in the correct view right away
                // Use functional update to ensure we're working with latest state
                setBooks(prevBooks => {
                  const updatedBooksList = prevBooks.map(b => {
                    const matches = booksToUpdate.some(bookToUpdate => 
                      b.title === bookToUpdate.title && 
                      ((!b.author && !bookToUpdate.author) || (b.author === bookToUpdate.author))
                    );
                    
                    if (matches) {
                      // Ensure readAt is a number (timestamp) or undefined (not null)
                      const readAtValue = newReadAt && typeof newReadAt === 'number' && newReadAt > 0 
                        ? newReadAt 
                        : undefined;
                      const updatedBook = {
                        ...b,
                        readAt: readAtValue,
                      };
                      console.log(`📖 Updated book "${b.title}" readAt from ${b.readAt} to:`, readAtValue);
                      return updatedBook;
                    }
                    return b;
                  });
                  
                  // Debug: log how many books have readAt after update
                  const readCount = updatedBooksList.filter(b => b.readAt && typeof b.readAt === 'number' && b.readAt > 0).length;
                  const unreadCount = updatedBooksList.filter(b => !b.readAt || (typeof b.readAt === 'number' && b.readAt <= 0)).length;
                  console.log(`📚 After state update - Read: ${readCount}, Unread: ${unreadCount}, Total: ${updatedBooksList.length}`);
                  
                  // Debug: log which books are read
                  const readBooks = updatedBooksList.filter(b => b.readAt && typeof b.readAt === 'number' && b.readAt > 0);
                  if (readBooks.length > 0) {
                    console.log(`📖 Read books:`, readBooks.map(b => `"${b.title}" (readAt: ${b.readAt})`));
                  }
                  
                  return updatedBooksList;
                });

                // Clear selection and exit selection mode
                setSelectedBooks(new Set());
                setIsSelectionMode(false);
                
                // Notify parent component immediately so counts update
                if (onBooksUpdated) {
                  onBooksUpdated();
                }
                
                // DON'T reload immediately - the state update above is sufficient
                // Reloading too quickly can cause race conditions where Supabase hasn't
                // processed the update yet, causing books to revert to their old state
                // The state update above ensures UI reflects changes immediately
                // Supabase will sync in the background, and we'll reload when switching views
              } catch (error) {
                console.error('Error updating read status:', error);
                Alert.alert('Error', 'Failed to update read status. Please try again.');
              }
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.bottomActionButtonText}>
              {filterReadStatus === 'unread' ? 'Add to Read' : 'Remove from Read'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <BookDetailModal
        visible={showBookDetail}
        book={selectedBook}
        photo={selectedPhoto}
        onClose={() => {
          setShowBookDetail(false);
          setSelectedBook(null);
        }}
        onBookUpdate={(updatedBook) => {
          // Update the book in state when description/stats are fetched
          setBooks(prev => prev.map(b => 
            b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
              ? updatedBook
              : b
          ));
          setSelectedBook(updatedBook); // Update the selected book too
        }}
        onDeleteBook={async (book) => {
          if (!user) return;
          try {
            const userApprovedKey = `approved_books_${user.uid}`;
            const updatedBooks = books.filter(b => b.id !== book.id);
            setBooks(updatedBooks);
            await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
            setShowBookDetail(false);
            setSelectedBook(null);
          } catch (error) {
            console.error('Error deleting book:', error);
          }
        }}
        onEditBook={async (book) => {
          if (!user) return;
          try {
            // Update local state immediately
            const userApprovedKey = `approved_books_${user.uid}`;
            const updatedBooks = books.map(b => 
              b.id === book.id || (b.title === book.title && b.author === book.author)
                ? book
                : b
            );
            setBooks(updatedBooks);
            setSelectedBook(book);
            await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
            
            // Reload from Supabase to ensure all views are updated
            setTimeout(() => {
              loadBooks();
            }, 500);
          } catch (error) {
            console.error('Error editing book:', error);
          }
        }}
        onBookUpdate={(updatedBook) => {
          // Update the book in state when cover is changed
          setBooks(prev => prev.map(b => 
            b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
              ? updatedBook
              : b
          ));
          setSelectedBook(updatedBook);
        }}
        onAddBookToFolder={() => {}}
        folders={[]}
      />

      {/* Folder View - Full Screen Page */}
      <Modal
        visible={showFolderView}
        animationType="slide"
        presentationStyle="fullScreen"
        transparent={false}
        onRequestClose={() => {
          setShowFolderView(false);
          setSelectedFolder(null);
          setIsFolderSelectionMode(false);
          setSelectedFolderBooks(new Set());
          setFolderSearchQuery('');
          setIsFolderListSelectionMode(false);
          setSelectedFolders(new Set());
        }}
      >
        <SafeAreaView style={styles.safeContainer} edges={['left','right']}>
          <View style={[styles.header, { paddingTop: insets.top + 5 }]}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => {
                if (isCreatingFolder) {
                  // If creating folder, just go back to folders list
                  setIsCreatingFolder(false);
                  setSelectedBooksForNewFolder(new Set());
                  setNewFolderNameInput('');
                  setShowFolderNameInput(false);
                } else if (selectedFolder) {
                  // If viewing a folder, go back to folders list
                  setSelectedFolder(null);
                  setIsFolderSelectionMode(false);
                  setSelectedFolderBooks(new Set());
                  setFolderSearchQuery('');
                } else {
                  // Otherwise, close the folder view entirely
                  setShowFolderView(false);
                  setSelectedFolder(null);
                  setIsFolderSelectionMode(false);
                  setSelectedFolderBooks(new Set());
                  setFolderSearchQuery('');
                  setIsFolderListSelectionMode(false);
                  setSelectedFolders(new Set());
                }
              }}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Ionicons name="arrow-back" size={24} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>
              {selectedFolder?.name || (isCreatingFolder ? 'Create Folder' : 'Folders')}
            </Text>
            <View style={styles.headerRight} />
          </View>

          {!selectedFolder && !isCreatingFolder && (
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 20, paddingHorizontal: 20 }}>
              {/* Action Buttons Row */}
              {!isFolderListSelectionMode && (
                <>
                  <View style={styles.foldersActionButtonsRow}>
                    <TouchableOpacity
                      style={styles.createFolderMainButton}
                      onPress={() => {
                        setIsCreatingFolder(true);
                        setSelectedBooksForNewFolder(new Set());
                      }}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="add-circle-outline" size={20} color="#ffffff" />
                      <Text style={styles.createFolderMainButtonText}>Create</Text>
                    </TouchableOpacity>
                    
                    <TouchableOpacity
                      style={[
                        styles.autoSortButtonFullPage,
                        { marginLeft: 12 },
                        (isAutoSorting || books.length === 0) && styles.autoSortButtonDisabled,
                      ]}
                      onPress={autoSortBooksIntoFolders}
                      activeOpacity={0.8}
                      disabled={isAutoSorting || books.length === 0}
                    >
                      <Ionicons name="sparkles" size={20} color="#ffffff" />
                      <Text style={styles.autoSortButtonText}>
                        {isAutoSorting ? 'Sorting...' : 'Auto-Sort'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  
                  <View style={styles.foldersActionButtonsRow}>
                    <TouchableOpacity
                      style={styles.selectFolderButton}
                      onPress={() => {
                        setIsFolderListSelectionMode(!isFolderListSelectionMode);
                        if (isFolderListSelectionMode) {
                          setSelectedFolders(new Set());
                        }
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.selectFolderButtonText}>
                        {isFolderListSelectionMode ? 'Cancel' : 'Select'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
              {isFolderListSelectionMode && selectedFolders.size > 0 && (
                <View style={styles.foldersActionButtonsRow}>
                  <TouchableOpacity
                    style={styles.deleteFoldersButton}
                    onPress={async () => {
                      const folderCount = selectedFolders.size;
                      Alert.alert(
                        'Delete Folders',
                        `Are you sure you want to delete ${folderCount} folder${folderCount === 1 ? '' : 's'}? This will not delete the books, they will remain in your library.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: async () => {
                              if (!user) return;
                              const updatedFolders = folders.filter(f => !selectedFolders.has(f.id));
                              setFolders(updatedFolders);
                              
                              const foldersKey = `folders_${user.uid}`;
                              await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
                              
                              setSelectedFolders(new Set());
                              setIsFolderListSelectionMode(false);
                              
                              Alert.alert('Success', `${folderCount} folder${folderCount === 1 ? '' : 's'} deleted.`);
                            },
                          },
                        ]
                      );
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="trash-outline" size={20} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.deleteFoldersButtonText}>
                      Delete ({selectedFolders.size})
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {folders.length > 0 ? (
                <>
                  {isFolderListSelectionMode && selectedFolders.size > 0 && (
                    <View style={[styles.selectionBar, { marginHorizontal: 20, marginTop: 20, marginBottom: 10 }]}>
                      <Text style={styles.selectionCount}>
                        {selectedFolders.size} folder{selectedFolders.size === 1 ? '' : 's'} selected
                      </Text>
                    </View>
                  )}
                  <Text style={[styles.sectionLabel, { marginTop: 24 }]}>Your Folders</Text>
                  <View style={styles.foldersGrid}>
                    {folders.map((folder) => {
                      const folderBooks = books.filter(book => 
                        book.id && folder.bookIds.includes(book.id)
                      );
                      const isSelected = isFolderListSelectionMode && selectedFolders.has(folder.id);
                      return (
                        <TouchableOpacity
                          key={folder.id}
                          style={[
                            styles.folderCard,
                            isFolderListSelectionMode && styles.folderCardSmall,
                            isSelected && { backgroundColor: '#0056CC40', borderColor: '#0056CC', borderWidth: 2 }
                          ]}
                          onPress={() => {
                            if (isFolderListSelectionMode) {
                              const newSelected = new Set(selectedFolders);
                              if (isSelected) {
                                newSelected.delete(folder.id);
                              } else {
                                newSelected.add(folder.id);
                              }
                              setSelectedFolders(newSelected);
                            } else {
                              setSelectedFolder(folder);
                            }
                          }}
                          activeOpacity={0.7}
                        >
                          {isFolderListSelectionMode && (
                            <View style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}>
                              <View style={{
                                width: 24,
                                height: 24,
                                borderRadius: 12,
                                borderWidth: 2,
                                borderColor: isSelected ? '#0056CC' : '#718096',
                                backgroundColor: isSelected ? '#0056CC' : '#ffffff',
                                justifyContent: 'center',
                                alignItems: 'center',
                              }}>
                                {isSelected && <Ionicons name="checkmark" size={14} color="#ffffff" />}
                              </View>
                            </View>
                          )}
                          <View style={styles.folderIcon}>
                            <Ionicons name="folder" size={32} color="#0056CC" />
                          </View>
                          <Text 
                            style={[styles.folderName, isFolderListSelectionMode && styles.folderNameSmall]} 
                            numberOfLines={isFolderListSelectionMode ? 2 : 1}
                          >
                            {folder.name}
                          </Text>
                          <Text style={styles.folderBookCount}>
                            {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : (
                <View style={styles.emptyContainer}>
                  <Ionicons name="folder-outline" size={64} color="#cbd5e0" />
                  <Text style={styles.emptyText}>No folders yet</Text>
                  <Text style={{ fontSize: 14, color: '#718096', marginTop: 8, textAlign: 'center' }}>
                    Create a folder to organize your books
                  </Text>
                </View>
              )}

            </ScrollView>
          )}

          {isCreatingFolder && !selectedFolder && (
            <>
              <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 20, paddingBottom: 100 }}>
                {!showFolderNameInput ? (
                  <>
                    {/* Select Books Section */}
                    <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
                      <Text style={styles.sectionLabel}>Select Books for Folder</Text>
                      <Text style={{ fontSize: 14, color: '#718096', marginTop: 8 }}>
                        Tap books below to select them, then name your folder
                      </Text>
                    </View>

                    {/* Search Bar */}
                    <View style={[styles.searchContainer, { marginHorizontal: 20, marginBottom: 20 }]}>
                      <Ionicons name="search" size={20} color="#718096" style={styles.searchIcon} />
                      <TextInput
                        style={styles.searchInput}
                        value={createFolderSearchQuery}
                        onChangeText={setCreateFolderSearchQuery}
                        placeholder="Search by title or author..."
                        autoCapitalize="none"
                        autoCorrect={false}
                        clearButtonMode="never"
                      />
                      {createFolderSearchQuery.length > 0 && (
                        <TouchableOpacity
                          onPress={() => setCreateFolderSearchQuery('')}
                          style={styles.librarySearchClear}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={styles.librarySearchClearText}>×</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* Books Grid for Selection */}
                    <View style={styles.booksContainer}>
                      {(() => {
                        // Filter books based on search query
                        let filteredBooks = allSortedBooks;
                        if (createFolderSearchQuery.trim()) {
                          const query = createFolderSearchQuery.trim().toLowerCase();
                          filteredBooks = allSortedBooks.filter(book => {
                            const title = (book.title || '').toLowerCase();
                            const author = (book.author || '').toLowerCase();
                            return title.includes(query) || author.includes(query);
                          });
                        }
                        return filteredBooks.map((item, index) => {
                          if (index % 4 === 0) {
                            return (
                              <View key={`row-${index}`} style={styles.bookGrid}>
                                {filteredBooks.slice(index, index + 4).map((book) => {
                                  const bookId = book.id || `${book.title}_${book.author}`;
                                  const isSelected = selectedBooksForNewFolder.has(bookId);
                                  return (
                                    <TouchableOpacity
                                      key={book.id || book.title + book.author}
                                      style={[
                                        styles.bookCard,
                                        isSelected && styles.bookCardSelected,
                                      ]}
                                      onPress={() => {
                                        setSelectedBooksForNewFolder(prev => {
                                          const newSet = new Set(prev);
                                          if (newSet.has(bookId)) {
                                            newSet.delete(bookId);
                                          } else {
                                            newSet.add(bookId);
                                          }
                                          return newSet;
                                        });
                                      }}
                                    >
                                      {getBookCoverUri(book) ? (
                                        <Image source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} />
                                      ) : (
                                        <View style={[styles.bookCover, styles.placeholderCover]}>
                                          <Ionicons name="book-outline" size={32} color="#a0aec0" />
                                        </View>
                                      )}
                                      <View style={styles.bookInfo}>
                                        <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                                        {book.author && (
                                          <Text style={styles.bookAuthor} numberOfLines={1}>{book.author}</Text>
                                        )}
                                      </View>
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>
                            );
                          }
                          return null;
                        });
                      })()}
                    </View>
                  </>
                ) : (
                  <>
                    {/* Name Folder Section */}
                  <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
                    <Text style={styles.sectionLabel}>Name Your Folder</Text>
                    <Text style={{ fontSize: 14, color: '#718096', marginTop: 8 }}>
                      {selectedBooksForNewFolder.size} {selectedBooksForNewFolder.size === 1 ? 'book' : 'books'} selected
                    </Text>
                  </View>

                  <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
                    <TextInput
                      style={[styles.createFolderInput, { width: '100%', padding: 16, fontSize: 16 }]}
                      placeholder="Folder name"
                      placeholderTextColor="#a0aec0"
                      value={newFolderNameInput}
                      onChangeText={setNewFolderNameInput}
                      autoFocus={true}
                    />
                  </View>

                  <View style={{ paddingHorizontal: 20, flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity
                      style={[styles.createFolderActionButton, styles.createFolderCancelButton]}
                      onPress={() => {
                        setIsCreatingFolder(false);
                        setSelectedBooksForNewFolder(new Set());
                        setNewFolderNameInput('');
                        setShowFolderNameInput(false);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.createFolderCancelButtonText}>Cancel</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.createFolderActionButton,
                        styles.createFolderConfirmButton,
                        !newFolderNameInput.trim() && styles.createFolderButtonDisabled,
                      ]}
                      onPress={() => handleCreateFolder()}
                      disabled={!newFolderNameInput.trim()}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.createFolderConfirmButtonText}>Create</Text>
                    </TouchableOpacity>
                  </View>
                  </>
                )}
              </ScrollView>
              
              {/* Bottom Create Folder Button - Only show when selecting books */}
              {!showFolderNameInput && selectedBooksForNewFolder.size > 0 && (
                <View style={styles.createFolderBottomTab}>
                  <TouchableOpacity
                    style={styles.createFolderBottomButton}
                    onPress={() => {
                      setShowFolderNameInput(true);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.createFolderBottomButtonText}>
                      Create Folder ({selectedBooksForNewFolder.size} {selectedBooksForNewFolder.size === 1 ? 'book' : 'books'})
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}

          {selectedFolder && (
            <ScrollView style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 20 }}>
              {/* Search Bar */}
              <View style={[styles.librarySearchContainer, { marginHorizontal: 20, marginTop: 0 }]}>
                <TextInput
                  style={styles.librarySearchInput}
                  value={folderSearchQuery}
                  onChangeText={setFolderSearchQuery}
                  placeholder="Search by title or author..."
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="never"
                />
                {folderSearchQuery.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setFolderSearchQuery('')}
                    style={styles.librarySearchClear}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.librarySearchClearText}>×</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Select Button */}
              <View style={styles.folderSelectButtonContainer}>
                <TouchableOpacity
                  style={styles.selectButton}
                  onPress={() => {
                    setIsFolderSelectionMode(!isFolderSelectionMode);
                    if (isFolderSelectionMode) {
                      setSelectedFolderBooks(new Set());
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.selectButtonText}>
                    {isFolderSelectionMode ? 'Cancel' : 'Select'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Selection Mode Indicator */}
              {isFolderSelectionMode && selectedFolderBooks.size > 0 && (
                <View style={styles.selectionBar}>
                  <Text style={styles.selectionCount}>
                    {selectedFolderBooks.size} {selectedFolderBooks.size === 1 ? 'book' : 'books'} selected
                  </Text>
                  <TouchableOpacity
                    style={styles.clearSelectionButton}
                    onPress={() => setSelectedFolderBooks(new Set())}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.clearSelectionText}>Clear</Text>
                  </TouchableOpacity>
                </View>
              )}

              {(() => {
                let folderBooks = books.filter(book => 
                  book.id && selectedFolder.bookIds.includes(book.id)
                );

                // Filter books by search query if provided
                if (folderSearchQuery.trim()) {
                  const query = folderSearchQuery.trim().toLowerCase();
                  folderBooks = folderBooks.filter(book => {
                    const title = (book.title || '').toLowerCase();
                    const author = (book.author || '').toLowerCase();
                    return title.includes(query) || author.includes(query);
                  });
                }

                // No photos, just show books (or empty state)
                if (folderBooks.length === 0) {
                  return (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyStateText}>
                        {folderSearchQuery ? 'No books found' : 'No Books in Folder'}
                      </Text>
                      <Text style={styles.emptyStateSubtext}>
                        {folderSearchQuery ? 'Try a different search term' : 'Books you add to this folder will appear here'}
                      </Text>
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
                      renderItem={renderFolderBook}
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

          {/* Book Detail Modal - Inside folder view so it appears on top */}
          <BookDetailModal
            visible={showBookDetail}
            book={selectedBook}
            photo={selectedPhoto}
            onClose={() => {
              setShowBookDetail(false);
              setSelectedBook(null);
            }}
            onBookUpdate={(updatedBook) => {
              // Update the book in state when description/stats are fetched
              setBooks(prev => prev.map(b => 
                b.id === updatedBook.id || (b.title === updatedBook.title && b.author === updatedBook.author)
                  ? updatedBook
                  : b
              ));
              setSelectedBook(updatedBook); // Update the selected book too
            }}
            onDeleteBook={async (book) => {
              if (!user) return;
              try {
                const userApprovedKey = `approved_books_${user.uid}`;
                const updatedBooks = books.filter(b => b.id !== book.id);
                setBooks(updatedBooks);
                await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                setShowBookDetail(false);
                setSelectedBook(null);
              } catch (error) {
                console.error('Error deleting book:', error);
              }
            }}
            onEditBook={async (book) => {
              if (!user) return;
              try {
                // Update local state immediately
                const userApprovedKey = `approved_books_${user.uid}`;
                const updatedBooks = books.map(b => 
                  b.id === book.id || (b.title === book.title && b.author === book.author)
                    ? book
                    : b
                );
                setBooks(updatedBooks);
                setSelectedBook(book);
                await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                
                // Reload from Supabase to ensure all views are updated
                setTimeout(() => {
                  loadBooks();
                }, 500);
              } catch (error) {
                console.error('Error editing book:', error);
              }
            }}
            onAddBookToFolder={() => {}}
            folders={[]}
          />
        </SafeAreaView>
      </Modal>

      {/* Sort Modal */}
      <Modal
        visible={showSortModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowSortModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowSortModal(false)}
        >
          <View style={styles.sortModalContent}>
            <Text style={styles.sortModalTitle}>Sort Books</Text>
            
            <TouchableOpacity
              style={[styles.sortOption, sortBy === 'author' && styles.sortOptionSelected]}
              onPress={() => {
                setSortBy('author');
                setShowSortModal(false);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.sortOptionText, sortBy === 'author' && styles.sortOptionTextSelected]}>
                By Author (Last Name)
              </Text>
              {sortBy === 'author' && <Ionicons name="checkmark" size={20} color="#0056CC" />}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sortOption, sortBy === 'oldest' && styles.sortOptionSelected]}
              onPress={() => {
                setSortBy('oldest');
                setShowSortModal(false);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.sortOptionText, sortBy === 'oldest' && styles.sortOptionTextSelected]}>
                Oldest to Newest
              </Text>
              {sortBy === 'oldest' && <Ionicons name="checkmark" size={20} color="#0056CC" />}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sortOption, sortBy === 'length' && styles.sortOptionSelected]}
              onPress={() => {
                setSortBy('length');
                setShowSortModal(false);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.sortOptionText, sortBy === 'length' && styles.sortOptionTextSelected]}>
                By Length (Pages)
              </Text>
              {sortBy === 'length' && <Ionicons name="checkmark" size={20} color="#0056CC" />}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sortModalCancel}
              onPress={() => setShowSortModal(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.sortModalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Bottom Delete Bar - Appears when books are selected */}
      {isSelectionMode && selectedBooks.size > 0 && (
        <View style={styles.bottomDeleteBarContainer}>
          <View style={[styles.bottomDeleteBar, { paddingBottom: insets.bottom }]}>
            <View style={styles.bottomDeleteBarLeft}>
              <Text style={styles.bottomDeleteBarCount} numberOfLines={1}>
                {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'} selected
              </Text>
            </View>
            <View style={styles.bottomDeleteBarRight}>
              <TouchableOpacity
                style={[styles.bottomDeleteBarCancelButton, { marginRight: 12 }]}
                onPress={() => {
                  setSelectedBooks(new Set());
                  setIsSelectionMode(false);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.bottomDeleteBarCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomDeleteBarDeleteButton}
                onPress={deleteSelectedBooks}
                activeOpacity={0.7}
              >
                <Ionicons name="trash-outline" size={20} color="#ffffff" style={{ marginRight: 6 }} />
                <Text style={styles.bottomDeleteBarDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      </SafeAreaView>
    </View>
  );
};

const getStyles = (screenWidth: number, screenHeight: number) => StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    position: 'relative',
  },
  header: {
    backgroundColor: '#2d3748',
    paddingTop: 0,
    paddingBottom: 6,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    padding: 6,
    marginLeft: -6,
    minWidth: 36,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#ffffff',
    flex: 1,
    textAlign: 'center',
  },
  headerRight: {
    width: 40,
  },
  searchContainer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
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
    color: '#1a202c',
  },
  searchIcon: {
    position: 'absolute',
    right: 35,
    top: 30,
  },
  librarySearchClear: {
    position: 'absolute',
    right: 15,
    top: 18,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e2e8f0',
  },
  librarySearchClearText: {
    fontSize: 18,
    color: '#718096',
    lineHeight: 20,
  },
  booksContainer: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  bookGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  bookCard: {
    width: (screenWidth - 94) / 4, // 4 columns with padding and gaps (8px gap between each)
    alignItems: 'center',
    marginBottom: 12,
    marginHorizontal: 4,
    position: 'relative',
  },
  bookCardSelected: {
    // No style changes to avoid layout shifts - selection is indicated by checkmark overlay
  },
  bookSelectionIndicator: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 10,
  },
  bookSelectionCheckmark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#4299e1',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  selectedBookCard: {
    borderWidth: 2,
    borderColor: '#4299e1',
    borderRadius: 8,
    padding: 2,
  },
  selectionOverlay: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 10,
  },
  selectionCheckmark: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 12,
    padding: 2,
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
  selectedBookCover: {
    opacity: 0.7,
  },
  placeholderCover: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bookInfo: {
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
  },
  bookTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 4,
    lineHeight: 16,
    width: '100%',
  },
  bookAuthor: {
    fontSize: 11,
    color: '#718096',
    textAlign: 'center',
    fontWeight: '500',
    lineHeight: 14,
    width: '100%',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 100,
  },
  emptyText: {
    fontSize: 18,
    color: '#718096',
    marginTop: 16,
    fontWeight: '500',
  },
  exportButtonContainer: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 8,
    position: 'relative',
    zIndex: 100,
  },
  topActionButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  exportButton: {
    flex: 1,
    backgroundColor: '#718096',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
  },
  foldersButton: {
    flex: 1,
    backgroundColor: '#718096',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
  },
  autoSortButton: {
    flex: 1,
    backgroundColor: '#48bb78',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
    opacity: 1,
  },
  exportButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    zIndex: 998,
  },
  modalContent: {
    position: 'absolute',
    top: 58, // Position below export button (10 padding + 38 button height + 8 padding + 2 margin)
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    maxHeight: 500,
    paddingBottom: 20,
    zIndex: 1001,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 10,
    marginHorizontal: 0,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a202c',
  },
  modalCloseButton: {
    padding: 5,
  },
  modalBody: {
    flex: 1,
    padding: 20,
  },
  formatSection: {
    marginBottom: 24,
  },
  selectionSection: {
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2d3748',
    marginBottom: 12,
  },
  formatButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  formatButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#f7fafc',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    alignItems: 'center',
  },
  formatButtonActive: {
    backgroundColor: '#2d3748',
    borderColor: '#2d3748',
  },
  formatButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#4a5568',
  },
  formatButtonTextActive: {
    color: '#ffffff',
  },
  selectionOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 8,
  },
  radioButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#cbd5e0',
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  radioButtonInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2d3748',
  },
  selectionOptionText: {
    fontSize: 16,
    color: '#1a202c',
    fontWeight: '500',
  },
  booksListSection: {
    marginBottom: 20,
  },
  booksList: {
    maxHeight: 300,
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 10,
  },
  bookSelectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginBottom: 4,
    backgroundColor: '#ffffff',
    borderRadius: 8,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#cbd5e0',
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  bookSelectInfo: {
    flex: 1,
  },
  bookSelectTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 2,
  },
  bookSelectAuthor: {
    fontSize: 13,
    color: '#718096',
  },
  modalFooter: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  exportActionButton: {
    backgroundColor: '#2d3748',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  exportActionButtonDisabled: {
    backgroundColor: '#cbd5e0',
    opacity: 0.6,
  },
  exportActionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  folderSelectionSection: {
    marginBottom: 24,
  },
  foldersList: {
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 10,
  },
  folderSelectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginBottom: 4,
    backgroundColor: '#ffffff',
    borderRadius: 8,
  },
  folderSelectItemActive: {
    backgroundColor: '#f0f8ff',
    borderWidth: 2,
    borderColor: '#0056CC',
  },
  folderSelectInfo: {
    flex: 1,
  },
  folderSelectName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 2,
  },
  folderSelectCount: {
    fontSize: 13,
    color: '#718096',
  },
  autoSortSection: {
    marginBottom: 24,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  autoSortButtonModal: {
    backgroundColor: '#48bb78',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
    marginBottom: 8,
  },
  autoSortButtonDisabled: {
    backgroundColor: '#cbd5e0',
    opacity: 0.6,
  },
  autoSortButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  autoSortDescription: {
    fontSize: 13,
    color: '#718096',
    textAlign: 'center',
    marginTop: 4,
  },
  createFolderSection: {
    marginBottom: 24,
  },
  createFolderInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  createFolderInput: {
    flex: 1,
    backgroundColor: '#f7fafc',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    color: '#1a202c',
  },
  createFolderButton: {
    backgroundColor: '#0056CC',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    justifyContent: 'center',
  },
  createFolderButtonDisabled: {
    backgroundColor: '#cbd5e0',
    opacity: 0.6,
  },
  createFolderButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  foldersListSection: {
    marginBottom: 20,
  },
  foldersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 12,
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
  folderCardSmall: {
    padding: 12,
    borderRadius: 12,
    width: (screenWidth - 60) / 3, // 3 columns instead of 2 when in selection mode
  },
  folderIconSmall: {
    marginBottom: 4,
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
  folderNameSmall: {
    fontSize: 11,
    marginTop: 4,
    marginBottom: 2,
    lineHeight: 14,
    fontWeight: '600',
  },
  folderBookCountSmall: {
    fontSize: 10,
    marginTop: 2,
  },
  folderBookCount: {
    fontSize: 13,
    color: '#718096',
    fontWeight: '500',
  },
  folderListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  folderListItemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 4,
  },
  folderListItemCount: {
    fontSize: 14,
    color: '#718096',
  },
  emptyFoldersContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyFoldersText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#4a5568',
    marginTop: 16,
  },
  emptyFoldersSubtext: {
    fontSize: 14,
    color: '#718096',
    marginTop: 8,
  },
  exportModalInline: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 8,
    maxHeight: Dimensions.get('window').height * 0.7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  exportModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  exportModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
  },
  exportModalCloseButton: {
    padding: 4,
  },
  exportModalBody: {
    padding: 16,
    flexGrow: 1,
  },
  exportModalFooter: {
    padding: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    gap: 10,
  },
  exportBookGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  exportBookCard: {
    width: (screenWidth - 40 - 32 - 16 - 12) / 4, // 4 columns: screen - 40 (modal margins) - 32 (body padding) - 16 (grid padding) - 12 (3 gaps of 4px)
    marginBottom: 12,
    marginHorizontal: 2,
    backgroundColor: '#f7fafc',
    borderRadius: 8,
    padding: 6,
    position: 'relative',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  exportBookCardSelected: {
    borderColor: '#0056CC',
    backgroundColor: '#f0f8ff',
  },
  exportBookCheckmark: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 10,
    backgroundColor: '#ffffff',
    borderRadius: 12,
  },
  exportBookCover: {
    width: '100%',
    height: ((screenWidth - 80) / 4 - 8) * 1.5, // Aspect ratio 1:1.5
    borderRadius: 4,
    marginBottom: 4,
    backgroundColor: '#e2e8f0',
  },
  exportPlaceholderCover: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
  },
  exportBookTitle: {
    fontSize: 10,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 2,
    lineHeight: 12,
  },
  exportBookAuthor: {
    fontSize: 9,
    color: '#718096',
    lineHeight: 11,
  },
  selectButton: {
    backgroundColor: '#4299e1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginHorizontal: 20,
  },
  selectButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  bottomActionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  bottomActionBarText: {
    fontSize: 14,
    color: '#1a202c',
    fontWeight: '600',
    flex: 1,
  },
  bottomActionButton: {
    backgroundColor: '#4299e1',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  bottomActionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#718096',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 1,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sortModalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 20,
    width: '85%',
    maxWidth: 400,
  },
  sortModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 20,
    textAlign: 'center',
  },
  sortOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: '#f8f9fa',
  },
  sortOptionSelected: {
    backgroundColor: '#e6f2ff',
    borderWidth: 2,
    borderColor: '#0056CC',
  },
  sortOptionText: {
    fontSize: 16,
    color: '#1a202c',
    fontWeight: '500',
  },
  sortOptionTextSelected: {
    color: '#0056CC',
    fontWeight: '600',
  },
  sortModalCancel: {
    marginTop: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  sortModalCancelText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '600',
  },
  foldersActionButtonsRow: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  autoSortButtonFullPage: {
    flex: 1,
    backgroundColor: '#48bb78',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    minHeight: 52,
  },
  createFolderMainButton: {
    flex: 1,
    backgroundColor: '#718096',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 52,
  },
  createFolderMainButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    marginLeft: 6,
  },
  selectFolderButton: {
    flex: 1,
    maxWidth: (screenWidth - 30 - 12) / 2, // Match Create button width: (screen - margins - gap) / 2
    backgroundColor: '#4299e1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 52,
  },
  selectFolderButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  deleteFoldersButton: {
    width: '100%',
    backgroundColor: '#e53e3e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  deleteFoldersButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  // Bottom Delete Bar
  bottomDeleteBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
  },
  bottomDeleteBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    minHeight: 60,
    backgroundColor: '#2d3748',
    borderTopWidth: 1,
    borderTopColor: '#4a5568',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  bottomDeleteBarLeft: {
    flex: 1,
    minWidth: 120,
  },
  bottomDeleteBarCount: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
    flexShrink: 1,
  },
  bottomDeleteBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  bottomDeleteBarCancelButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 40,
    backgroundColor: 'transparent',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#718096',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bottomDeleteBarCancelText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  bottomDeleteBarDeleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    minHeight: 40,
    backgroundColor: '#e53e3e',
    borderRadius: 8,
    justifyContent: 'center',
  },
  bottomDeleteBarDeleteText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  createFolderContinueButton: {
    backgroundColor: '#718096',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createFolderContinueButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  createFolderBackButton: {
    backgroundColor: '#e2e8f0',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createFolderBackButtonText: {
    color: '#4a5568',
    fontSize: 16,
    fontWeight: '600',
  },
  createFolderActionButton: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createFolderCancelButton: {
    backgroundColor: '#e2e8f0',
  },
  createFolderCancelButtonText: {
    color: '#4a5568',
    fontSize: 16,
    fontWeight: '600',
  },
  createFolderConfirmButton: {
    backgroundColor: '#718096',
  },
  createFolderConfirmButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  noDataSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    marginHorizontal: 20,
  },
  noDataSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  noDataSeparatorText: {
    fontSize: 12,
    color: '#a0aec0',
    fontWeight: '500',
    marginHorizontal: 12,
    fontStyle: 'italic',
  },
  createFolderBottomTab: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    paddingTop: 12,
    paddingBottom: 20,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 10,
  },
  createFolderBottomButton: {
    backgroundColor: '#0056CC',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createFolderBottomButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  // Folder view styles (matching MyLibraryTab)
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
  folderSelectButtonContainer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  selectButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#4299e1',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  selectionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#e6f2ff',
    marginBottom: 12,
    borderRadius: 8,
    marginHorizontal: 15,
  },
  selectionCount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4299e1',
  },
  clearSelectionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#ffffff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#4299e1',
  },
  clearSelectionText: {
    color: '#4299e1',
    fontSize: 12,
    fontWeight: '600',
  },
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
    alignItems: 'flex-start',
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
    fontWeight: '600',
    color: '#718096',
  },
  placeholderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4a5568',
    textAlign: 'center',
    lineHeight: 14,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyStateText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#718096',
    textAlign: 'center',
  },
  booksGrid: {
    paddingTop: 4,
  },
  bookRow: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },
});

