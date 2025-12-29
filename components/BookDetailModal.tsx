import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, Photo } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import { supabase } from '../lib/supabaseClient';

interface BookDetailModalProps {
  visible: boolean;
  book: Book | null;
  photo: Photo | null;
  onClose: () => void;
  onRemove?: () => void; // Callback to refresh library after removal
  onBookUpdate?: (updatedBook: Book) => void; // Callback to update book data (e.g., when description is fetched)
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  visible,
  book,
  photo,
  onClose,
  onRemove,
  onBookUpdate,
}) => {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [description, setDescription] = useState<string | null>(null);
  const [loadingDescription, setLoadingDescription] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [isRead, setIsRead] = useState(false);
  const [togglingRead, setTogglingRead] = useState(false);

  useEffect(() => {
    const loadReadStatus = async () => {
      if (!visible || !book || !user) {
        setIsRead(false);
        return;
      }

      // Try to load read status from Supabase first (for production sync)
      if (supabase) {
        try {
          const authorForQuery = book.author || '';
          const { data, error } = await supabase
            .from('books')
            .select('read_at')
            .eq('user_id', user.uid)
            .eq('title', book.title)
            .eq('author', authorForQuery)
            .maybeSingle();

          if (!error && data && data.read_at) {
            setIsRead(true);
            // Update the book object with the readAt from Supabase
            if (book) {
              book.readAt = data.read_at;
            }
            return;
          }
        } catch (error) {
          console.warn('Error loading read status from Supabase, using local:', error);
        }
      }

      // Fallback to local storage (book.readAt from AsyncStorage)
      setIsRead(!!book.readAt);
    };

    if (visible && book) {
      loadReadStatus();
      
      // If book has description already, use it (don't fetch again)
      if (book.description) {
        setDescription(cleanDescription(book.description));
        setLoadingDescription(false);
      } else if (book.googleBooksId) {
        // Only fetch if we don't have description yet
        // Check if description is already being loaded (avoid duplicate requests)
        if (!loadingDescription) {
          fetchBookDescription(book.googleBooksId);
        }
      } else {
        setDescription(null);
        setLoadingDescription(false);
      }
    } else {
      setDescription(null);
      setIsRead(false);
      setLoadingDescription(false);
    }
  }, [visible, book, user]);

  // Clean HTML from description
  const cleanDescription = (html: string): string => {
    if (!html) return '';
    
    // Replace HTML line breaks with newlines
    let cleaned = html.replace(/<br\s*\/?>/gi, '\n');
    cleaned = cleaned.replace(/<\/p>/gi, '\n\n');
    cleaned = cleaned.replace(/<\/div>/gi, '\n');
    
    // Remove all HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');
    
    // Decode HTML entities
    cleaned = cleaned.replace(/&nbsp;/g, ' ');
    cleaned = cleaned.replace(/&amp;/g, '&');
    cleaned = cleaned.replace(/&lt;/g, '<');
    cleaned = cleaned.replace(/&gt;/g, '>');
    cleaned = cleaned.replace(/&quot;/g, '"');
    cleaned = cleaned.replace(/&#39;/g, "'");
    cleaned = cleaned.replace(/&apos;/g, "'");
    cleaned = cleaned.replace(/&hellip;/g, '...');
    cleaned = cleaned.replace(/&mdash;/g, '—');
    cleaned = cleaned.replace(/&ndash;/g, '–');
    
    // Decode numeric HTML entities (e.g., &#8217;)
    cleaned = cleaned.replace(/&#(\d+);/g, (match, dec) => {
      return String.fromCharCode(parseInt(dec, 10));
    });
    
    // Decode hex HTML entities (e.g., &#x2019;)
    cleaned = cleaned.replace(/&#x([a-f\d]+);/gi, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n'); // Multiple newlines to double newline
    cleaned = cleaned.replace(/[ \t]+/g, ' '); // Multiple spaces to single space
    cleaned = cleaned.trim();
    
    return cleaned;
  };

  const handleToggleReadStatus = async () => {
    if (!book || !user) return;

    setTogglingRead(true);
    const newReadAt = isRead ? null : Date.now();
    
    try {
      // Update AsyncStorage (for offline/backwards compatibility)
      const userApprovedKey = `approved_books_${user.uid}`;
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      
      if (approvedData) {
        const approvedBooks: Book[] = JSON.parse(approvedData);
        
        // Find and update the book
        const updatedBooks = approvedBooks.map((b) => {
          // Match by title and author (or just title if author missing)
          const matchesTitle = b.title === book.title;
          const matchesAuthor = (!b.author && !book.author) || (b.author === book.author);
          
          if (matchesTitle && matchesAuthor) {
            // Toggle read status
            return {
              ...b,
              readAt: newReadAt || undefined,
            };
          }
          return b;
        });
        
        await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
      }
      
      // Save to Supabase for production cross-device sync
      if (supabase) {
        try {
          // Upsert book read status to Supabase
          const bookData = {
            user_id: user.uid,
            title: book.title,
            author: book.author || null,
            isbn: book.isbn || null,
            confidence: book.confidence || null,
            status: book.status || 'approved',
            scanned_at: book.scannedAt || null,
            cover_url: book.coverUrl || null,
            local_cover_path: book.localCoverPath || null,
            google_books_id: book.googleBooksId || null,
            description: book.description || null,
            read_at: newReadAt, // This is the key field we're updating
            updated_at: new Date().toISOString(),
          };

          // Use upsert to insert or update based on user_id + title + author
          // First try to find existing book (handle null authors by using empty string)
          const authorForQuery = book.author || '';
          const { data: existingBook, error: findError } = await supabase
            .from('books')
            .select('id')
            .eq('user_id', user.uid)
            .eq('title', book.title)
            .eq('author', authorForQuery)
            .maybeSingle();

          if (findError) {
            console.warn('Error finding book in Supabase:', findError);
          }

          if (existingBook) {
            // Update existing book's read status
            const { error: updateError } = await supabase
              .from('books')
              .update({
                read_at: newReadAt,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existingBook.id);
            
            if (updateError) {
              console.warn('Error updating in Supabase (will use local storage):', updateError);
            }
          } else {
            // Insert new book record with read status
            // Use empty string for null author to match unique constraint
            const insertData = {
              ...bookData,
              author: authorForQuery || null, // Store as null but query with empty string
            };
            
            const { error: insertError } = await supabase
              .from('books')
              .insert(insertData);
            
            if (insertError) {
              console.warn('Error inserting to Supabase (will use local storage):', insertError);
            }
          }
        } catch (supabaseError) {
          console.warn('Error connecting to Supabase (will use local storage):', supabaseError);
          // Continue anyway - local storage is updated
        }
      }
      
      // Update local state
      setIsRead(!isRead);
      
      // Update the book object if onRemove callback is available (to refresh parent)
      if (onRemove) {
        onRemove();
      }
    } catch (error) {
      console.error('Error toggling read status:', error);
      Alert.alert('Error', 'Failed to update read status');
    } finally {
      setTogglingRead(false);
    }
  };

  const handleRemoveFromLibrary = async () => {
    if (!book || !user) return;

    Alert.alert(
      'Remove from Library',
      `Are you sure you want to remove "${book.title}" from your library?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemoving(true);
            try {
              const userApprovedKey = `approved_books_${user.uid}`;
              const approvedData = await AsyncStorage.getItem(userApprovedKey);
              
              if (approvedData) {
                const approvedBooks: Book[] = JSON.parse(approvedData);
                // Remove book by matching title and author
                const updatedBooks = approvedBooks.filter(
                  (b) => !(b.title === book.title && b.author === book.author)
                );
                
                await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                
                // Call the refresh callback if provided
                if (onRemove) {
                  onRemove();
                }
                
                // Close the modal
                onClose();
                
                Alert.alert('Success', 'Book removed from library');
              }
            } catch (error) {
              console.error('Error removing book:', error);
              Alert.alert('Error', 'Failed to remove book from library');
            } finally {
              setRemoving(false);
            }
          },
        },
      ]
    );
  };

  const fetchBookDescription = async (googleBooksId: string) => {
    if (!book || !user) return;
    
    setLoadingDescription(true);
    try {
      // Use centralized service - it handles rate limiting and caching
      const { fetchBookData } = await import('../services/googleBooksService');
      const bookData = await fetchBookData(book.title, book.author, googleBooksId);
      
      if (bookData.description) {
        const cleanedDesc = cleanDescription(bookData.description);
        setDescription(cleanedDesc);
        
        // Save the description to the book object and persist it
        const updatedBook: Book = {
          ...book,
          description: bookData.description, // Save raw description (with HTML) for future use
          // Also update any other missing stats
          ...(bookData.pageCount !== undefined && !book.pageCount && { pageCount: bookData.pageCount }),
          ...(bookData.categories && !book.categories && { categories: bookData.categories }),
          ...(bookData.publisher && !book.publisher && { publisher: bookData.publisher }),
          ...(bookData.publishedDate && !book.publishedDate && { publishedDate: bookData.publishedDate }),
          ...(bookData.language && !book.language && { language: bookData.language }),
          ...(bookData.averageRating !== undefined && book.averageRating === undefined && { averageRating: bookData.averageRating }),
          ...(bookData.ratingsCount !== undefined && book.ratingsCount === undefined && { ratingsCount: bookData.ratingsCount }),
          ...(bookData.subtitle && !book.subtitle && { subtitle: bookData.subtitle }),
          ...(bookData.printType && !book.printType && { printType: bookData.printType }),
        };
        
        // Save to Supabase
        const { saveBookToSupabase } = await import('../services/supabaseSync');
        await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');
        
        // Save to AsyncStorage
        try {
          const userApprovedKey = `approved_books_${user.uid}`;
          const storedApproved = await AsyncStorage.getItem(userApprovedKey);
          const approvedBooks: Book[] = storedApproved ? JSON.parse(storedApproved) : [];
          
          const updatedBooks = approvedBooks.map(b => 
            (b.id === book.id || (b.title === book.title && b.author === book.author))
              ? updatedBook
              : b
          );
          
          await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
        } catch (storageError) {
          console.error('Error saving description to AsyncStorage:', storageError);
        }
        
        // Notify parent component if callback provided
        if (onBookUpdate) {
          onBookUpdate(updatedBook);
        }
      } else {
        setDescription(null);
      }
    } catch (error) {
      console.error('Error fetching book description:', error);
      setDescription(null);
    } finally {
      setLoadingDescription(false);
    }
  };

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

  if (!book) return null;

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeContainer} edges={['left','right','bottom']}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={onClose}
            activeOpacity={0.7}
            hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
          >
            <Text style={styles.backButtonText}>←</Text>
            <Text style={styles.backButtonLabel}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Book Details</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
          {/* Book Cover and Basic Info */}
          <View style={styles.bookHeader}>
            {getBookCoverUri(book) && (
              <Image
                source={{ uri: getBookCoverUri(book) }}
                style={styles.bookCover}
              />
            )}
            <View style={styles.bookInfo}>
              <Text style={styles.bookTitle}>{book.title}</Text>
              {book.author && (
                <Text style={styles.bookAuthor}>by {book.author}</Text>
              )}
              {book.isbn && (
                <Text style={styles.bookIsbn}>ISBN: {book.isbn}</Text>
              )}
            </View>
          </View>

          {/* Mark as Read Button */}
          <View style={styles.section}>
            <TouchableOpacity
              style={[
                styles.readButton,
                isRead && styles.readButtonActive,
                togglingRead && styles.readButtonDisabled,
              ]}
              onPress={handleToggleReadStatus}
              disabled={togglingRead}
              activeOpacity={0.8}
            >
              {togglingRead ? (
                <ActivityIndicator size="small" color={isRead ? "#ffffff" : "#2d3748"} />
              ) : (
                <>
                  <Text style={[styles.readButtonText, isRead && styles.readButtonTextActive]}>
                    {isRead ? '✓ Mark as Unread' : "I've Read This"}
                  </Text>
                  {isRead && book.readAt && (
                    <Text style={styles.readDateText}>
                      Finished {new Date(book.readAt).toLocaleDateString()}
                    </Text>
                  )}
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Description */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Description</Text>
            {loadingDescription ? (
              <ActivityIndicator size="small" color="#4a5568" style={styles.loader} />
            ) : description ? (
              <Text style={styles.description}>{description}</Text>
            ) : (
              <Text style={styles.noDescription}>No description available</Text>
            )}
            
            {/* Book Stats - At bottom of description section */}
            {(book.pageCount || book.categories || book.publisher || book.publishedDate || 
              book.language || book.averageRating || book.ratingsCount || book.subtitle || book.printType) && (
              <View style={styles.statsContainer}>
                <Text style={styles.statsTitle}>Book Information</Text>
                <View style={styles.statsGrid}>
                  {book.pageCount && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Pages</Text>
                      <Text style={styles.statValue}>{book.pageCount.toLocaleString()}</Text>
                    </View>
                  )}
                  {book.publishedDate && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Published</Text>
                      <Text style={styles.statValue}>{book.publishedDate}</Text>
                    </View>
                  )}
                  {book.publisher && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Publisher</Text>
                      <Text style={styles.statValue} numberOfLines={2}>{book.publisher}</Text>
                    </View>
                  )}
                  {book.language && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Language</Text>
                      <Text style={styles.statValue}>{book.language.toUpperCase()}</Text>
                    </View>
                  )}
                  {book.averageRating && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Rating</Text>
                      <Text style={styles.statValue}>
                        {book.averageRating.toFixed(1)} ⭐
                        {book.ratingsCount && ` (${book.ratingsCount.toLocaleString()} reviews)`}
                      </Text>
                    </View>
                  )}
                  {book.printType && (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Type</Text>
                      <Text style={styles.statValue}>{book.printType}</Text>
                    </View>
                  )}
                </View>
                {book.subtitle && (
                  <View style={styles.subtitleContainer}>
                    <Text style={styles.subtitleLabel}>Subtitle</Text>
                    <Text style={styles.subtitleText}>{book.subtitle}</Text>
                  </View>
                )}
                {book.categories && book.categories.length > 0 && (
                  <View style={styles.categoriesContainer}>
                    <Text style={styles.categoriesLabel}>Genres</Text>
                    <View style={styles.categoriesList}>
                      {book.categories.map((category, index) => (
                        <View key={index} style={styles.categoryTag}>
                          <Text style={styles.categoryText}>{category}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Scan Photo - Below Description, Above Remove Button */}
          {photo && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>From Scan</Text>
              <Image source={{ uri: photo.uri }} style={styles.scanPhoto} />
              <Text style={styles.scanDate}>
                Scanned: {new Date(photo.timestamp).toLocaleDateString()}
              </Text>
            </View>
          )}

          {/* Remove Button */}
          <View style={styles.section}>
            <TouchableOpacity
              style={[styles.removeButton, removing && styles.removeButtonDisabled]}
              onPress={handleRemoveFromLibrary}
              disabled={removing}
              activeOpacity={0.8}
            >
              {removing ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={styles.removeButtonText}>Remove from Library</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa', // Subtle gray background
  },
  header: {
    backgroundColor: '#2d3748', // Slate header
    paddingVertical: 16,
    paddingTop: 20,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    minWidth: 80,
  },
  backButtonText: {
    fontSize: 20,
    color: '#ffffff',
    fontWeight: '600',
    marginRight: 6,
  },
  backButtonLabel: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    minWidth: 80,
  },
  container: {
    flex: 1,
    padding: 20,
  },
  bookHeader: {
    flexDirection: 'row',
    marginBottom: 24,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  bookCover: {
    width: 120,
    height: 180,
    borderRadius: 8,
    marginRight: 20,
    backgroundColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  bookInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  bookTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  bookAuthor: {
    fontSize: 18,
    color: '#718096',
    fontStyle: 'italic',
    marginBottom: 8,
    fontWeight: '500',
  },
  bookIsbn: {
    fontSize: 14,
    color: '#a0aec0',
    fontWeight: '500',
  },
  section: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  description: {
    fontSize: 15,
    color: '#4a5568',
    lineHeight: 24,
    fontWeight: '400',
  },
  noDescription: {
    fontSize: 14,
    color: '#a0aec0',
    fontStyle: 'italic',
  },
  loader: {
    marginVertical: 20,
  },
  scanPhoto: {
    width: '100%',
    height: 300,
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: '#e2e8f0',
  },
  scanDate: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '500',
  },
  removeButton: {
    backgroundColor: '#e53e3e',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#e53e3e',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  removeButtonDisabled: {
    opacity: 0.6,
  },
  removeButtonText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  readButton: {
    backgroundColor: '#f7fafc',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  readButtonActive: {
    backgroundColor: '#48bb78',
    borderColor: '#48bb78',
    shadowColor: '#48bb78',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  readButtonDisabled: {
    opacity: 0.6,
  },
  readButtonText: {
    fontSize: 16,
    color: '#2d3748',
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  readButtonTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  readDateText: {
    fontSize: 12,
    color: '#ffffff',
    marginTop: 4,
    opacity: 0.9,
    fontWeight: '500',
  },
  statsContainer: {
    marginTop: 24,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  statsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
    letterSpacing: 0.2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  statItem: {
    width: '50%',
    marginBottom: 16,
    paddingRight: 12,
  },
  statLabel: {
    fontSize: 12,
    color: '#718096',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 15,
    color: '#2d3748',
    fontWeight: '500',
  },
  subtitleContainer: {
    marginTop: 8,
    marginBottom: 16,
  },
  subtitleLabel: {
    fontSize: 12,
    color: '#718096',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  subtitleText: {
    fontSize: 15,
    color: '#4a5568',
    fontStyle: 'italic',
    fontWeight: '500',
  },
  categoriesContainer: {
    marginTop: 8,
  },
  categoriesLabel: {
    fontSize: 12,
    color: '#718096',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  categoriesList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  categoryTag: {
    backgroundColor: '#edf2f7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
    marginBottom: 8,
  },
  categoryText: {
    fontSize: 13,
    color: '#2d3748',
    fontWeight: '500',
  },
});

export default BookDetailModal;

