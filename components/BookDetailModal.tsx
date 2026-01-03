import React, { useState, useEffect, useCallback } from 'react';
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
  TextInput,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
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
  onEditBook?: (updatedBook: Book) => void; // Callback to update book (for cover changes)
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  visible,
  book,
  photo,
  onClose,
  onRemove,
  onBookUpdate,
  onEditBook,
}) => {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [description, setDescription] = useState<string | null>(null);
  const [loadingDescription, setLoadingDescription] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [isRead, setIsRead] = useState(false);
  const [togglingRead, setTogglingRead] = useState(false);
  const [showCoverOptions, setShowCoverOptions] = useState(false);
  const [showReplaceCoverModal, setShowReplaceCoverModal] = useState(false);
  const [coverSearchResults, setCoverSearchResults] = useState<Array<{googleBooksId: string, coverUrl?: string}>>([]);
  const [isLoadingCovers, setIsLoadingCovers] = useState(false);
  const [updatingCover, setUpdatingCover] = useState(false);
  const [isHandlingPhoto, setIsHandlingPhoto] = useState(false); // Guard to prevent multiple simultaneous calls

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
          // Convert scannedAt to BIGINT (timestamp in milliseconds) for Supabase
          // scanned_at is BIGINT in database, not TIMESTAMPTZ
          const scannedAtValue = book.scannedAt 
            ? (typeof book.scannedAt === 'number' ? book.scannedAt : new Date(book.scannedAt).getTime())
            : null;

          // Upsert book read status to Supabase
          const bookData = {
            user_id: user.uid,
            title: book.title,
            author: book.author || null,
            isbn: book.isbn || null,
            confidence: book.confidence || null,
            status: book.status || 'approved',
            scanned_at: scannedAtValue, // BIGINT timestamp in milliseconds
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
              // Delete from Supabase first
              if (supabase) {
                try {
                  const { deleteBookFromSupabase } = await import('../services/supabaseSync');
                  await deleteBookFromSupabase(user.uid, book);
                  console.log('✅ Book deleted from Supabase');
                } catch (supabaseError) {
                  console.warn('Error deleting book from Supabase:', supabaseError);
                  // Continue with local deletion even if Supabase fails
                }
              }
              
              // Remove from AsyncStorage
              const userApprovedKey = `approved_books_${user.uid}`;
              const approvedData = await AsyncStorage.getItem(userApprovedKey);
              
              if (approvedData) {
                const approvedBooks: Book[] = JSON.parse(approvedData);
                // Remove book by matching ID first, then by title and author
                const updatedBooks = approvedBooks.filter((b) => {
                  // Match by ID if both have IDs
                  if (book.id && b.id && book.id === b.id) return false;
                  // Match by title and author
                  if (b.title === book.title && b.author === book.author) return false;
                  return true;
                });
                
                await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
                console.log(`✅ Book removed from AsyncStorage. ${approvedBooks.length} -> ${updatedBooks.length} books`);
              }
              
              // Call the refresh callback if provided (this will reload from Supabase)
              if (onRemove) {
                onRemove();
              }
              
              // Close the modal
              onClose();
              
              Alert.alert('Success', 'Book removed from library');
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

  const handleCoverPress = () => {
    if (!book) return;
    setShowCoverOptions(true);
  };

  const handleRemoveCover = async () => {
    if (!book || !user) return;
    
    setShowCoverOptions(false);
    setUpdatingCover(true);
    
    try {
      const updatedBook: Book = {
        ...book,
        coverUrl: undefined,
        localCoverPath: undefined,
      };

      // Update in AsyncStorage
      const userApprovedKey = `approved_books_${user.uid}`;
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      if (approvedData) {
        const approvedBooks: Book[] = JSON.parse(approvedData);
        const updatedBooks = approvedBooks.map(b => 
          (b.id === book.id || (b.title === book.title && b.author === book.author))
            ? updatedBook
            : b
        );
        await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
      }

      // Update in Supabase
      const { saveBookToSupabase } = await import('../services/supabaseSync');
      await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

      // Notify parent to update everywhere
      if (onEditBook) {
        onEditBook(updatedBook);
      }
      if (onBookUpdate) {
        onBookUpdate(updatedBook);
      }

      Alert.alert('Cover Removed', 'The cover has been removed from this book everywhere.');
    } catch (error) {
      console.error('Error removing cover:', error);
      Alert.alert('Error', 'Failed to remove cover. Please try again.');
    } finally {
      setUpdatingCover(false);
    }
  };

  const handleReplaceCover = async () => {
    if (!book) return;
    
    setShowCoverOptions(false);
    setShowReplaceCoverModal(true);
    setIsLoadingCovers(true);
    setCoverSearchResults([]);

    try {
      const { searchMultipleBooks } = await import('../services/googleBooksService');
      // Search using only the book title to find alternative covers
      const results = await searchMultipleBooks(book.title, undefined, 20);
      
      // Filter to only show results with covers
      const resultsWithCovers = results.filter(r => r.coverUrl && r.googleBooksId);
      setCoverSearchResults(resultsWithCovers);
    } catch (error) {
      console.error('Error searching for covers:', error);
      Alert.alert('Error', 'Failed to search for covers. Please try again.');
    } finally {
      setIsLoadingCovers(false);
    }
  };

  const downloadAndCacheCover = async (coverUrl: string, googleBooksId: string): Promise<string | null> => {
    if (!FileSystem.documentDirectory) return null;
    
    try {
      const coversDir = `${FileSystem.documentDirectory}covers`;
      const dirInfo = await FileSystem.getInfoAsync(coversDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
      }

      const fileUri = `${coversDir}/${googleBooksId}.jpg`;
      const downloadResult = await FileSystem.downloadAsync(coverUrl, fileUri);
      
      if (downloadResult.uri) {
        // Return relative path
        return downloadResult.uri.replace(FileSystem.documentDirectory || '', '');
      }
      
      return null;
    } catch (error) {
      console.error('Error downloading cover:', error);
      return null;
    }
  };

  const handleSelectCover = async (selectedCover: {googleBooksId: string, coverUrl?: string}) => {
    if (!user || !book || !selectedCover.googleBooksId || !selectedCover.coverUrl) return;

    setUpdatingCover(true);

    try {
      const { fetchBookData } = await import('../services/googleBooksService');
      const bookData = await fetchBookData(book.title, book.author, selectedCover.googleBooksId);

      if (bookData.coverUrl) {
        // Download the cover
        const coverUri = await downloadAndCacheCover(bookData.coverUrl, selectedCover.googleBooksId);
        
        const updatedBook: Book = {
          ...book,
          coverUrl: bookData.coverUrl,
          localCoverPath: coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined,
          googleBooksId: selectedCover.googleBooksId,
          // Update other book data if available
          description: bookData.description || book.description,
          pageCount: bookData.pageCount || book.pageCount,
          categories: bookData.categories || book.categories,
          publisher: bookData.publisher || book.publisher,
          publishedDate: bookData.publishedDate || book.publishedDate,
          language: bookData.language || book.language,
          averageRating: bookData.averageRating || book.averageRating,
          ratingsCount: bookData.ratingsCount || book.ratingsCount,
          subtitle: bookData.subtitle || book.subtitle,
        };

        // Update in AsyncStorage
        const userApprovedKey = `approved_books_${user.uid}`;
        const approvedData = await AsyncStorage.getItem(userApprovedKey);
        if (approvedData) {
          const approvedBooks: Book[] = JSON.parse(approvedData);
          const updatedBooks = approvedBooks.map(b => 
            (b.id === book.id || (b.title === book.title && b.author === book.author))
              ? updatedBook
              : b
          );
          await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
        }

        // Update in Supabase
        const { saveBookToSupabase } = await import('../services/supabaseSync');
        await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

        // Notify parent to update everywhere
        if (onEditBook) {
          onEditBook(updatedBook);
        }
        if (onBookUpdate) {
          onBookUpdate(updatedBook);
        }

        setShowReplaceCoverModal(false);
        Alert.alert('Cover Updated', 'The book cover has been updated everywhere.');
      }
    } catch (error) {
      console.error('Error updating cover:', error);
      Alert.alert('Error', 'Failed to update cover. Please try again.');
    } finally {
      setUpdatingCover(false);
    }
  };

  const handleTakePhotoForCover = async () => {
    // Guard: Prevent multiple simultaneous calls
    if (isHandlingPhoto || updatingCover || !book || !user) {
      console.log('Take photo handler: Already processing or invalid state', { isHandlingPhoto, updatingCover, hasBook: !!book, hasUser: !!user });
      return;
    }

    setIsHandlingPhoto(true);
    console.log('Take photo handler: Starting...');

    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Camera permission is required to take a photo of the book cover.');
        setIsHandlingPhoto(false);
        return;
      }

      console.log('Take photo handler: Launching camera...');
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [3, 4],
        quality: 0.8,
      });

      console.log('Take photo handler: Camera result', { canceled: result.canceled, hasAssets: !!result.assets?.[0] });
      
      if (!result.canceled && result.assets[0]) {
        setUpdatingCover(true);
        
        try {
          // Resize and optimize the image
          const manipulatedImage = await ImageManipulator.manipulateAsync(
            result.assets[0].uri,
            [{ resize: { width: 600 } }],
            { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
          );

          // Save to local storage
          if (FileSystem.documentDirectory) {
            const coversDir = `${FileSystem.documentDirectory}covers`;
            const dirInfo = await FileSystem.getInfoAsync(coversDir);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
            }

            const fileName = `custom_${book.id || Date.now()}.jpg`;
            const fileUri = `${coversDir}/${fileName}`;
            
            // Copy the image to our covers directory
            await FileSystem.copyAsync({
              from: manipulatedImage.uri,
              to: fileUri,
            });

            const localCoverPath = fileUri.replace(FileSystem.documentDirectory || '', '');

            const updatedBook: Book = {
              ...book,
              coverUrl: fileUri, // Use local file URI
              localCoverPath: localCoverPath,
            };

            // Update in AsyncStorage
            const userApprovedKey = `approved_books_${user.uid}`;
            const approvedData = await AsyncStorage.getItem(userApprovedKey);
            if (approvedData) {
              const approvedBooks: Book[] = JSON.parse(approvedData);
              const updatedBooks = approvedBooks.map(b => 
                (b.id === book.id || (b.title === book.title && b.author === book.author))
                  ? updatedBook
                  : b
              );
              await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
            }

            // Update in Supabase
            const { saveBookToSupabase } = await import('../services/supabaseSync');
            await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

            // Notify parent
            if (onEditBook) {
              onEditBook(updatedBook);
            }
            if (onBookUpdate) {
              onBookUpdate(updatedBook);
            }

            setShowReplaceCoverModal(false);
            Alert.alert('Cover Updated', 'Your photo has been set as the book cover everywhere.');
          }
        } catch (processingError) {
          console.error('Error processing photo for cover:', processingError);
          Alert.alert('Error', 'Failed to process photo. Please try again.');
        } finally {
          setUpdatingCover(false);
        }
      } else {
        console.log('Take photo handler: User canceled or no asset');
      }
    } catch (error) {
      console.error('Error taking photo for cover:', error);
      Alert.alert('Error', 'Failed to take photo. Please try again.');
    } finally {
      setIsHandlingPhoto(false);
      setUpdatingCover(false);
    }
  };

  const handleUploadPhotoForCover = async () => {
    // Guard: Prevent multiple simultaneous calls
    if (isHandlingPhoto || updatingCover || !book || !user) {
      console.log('Upload photo handler: Already processing or invalid state', { isHandlingPhoto, updatingCover, hasBook: !!book, hasUser: !!user });
      return;
    }

    setIsHandlingPhoto(true);
    console.log('Upload photo handler: Starting...');

    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Photo library permission is required to upload a photo.');
        setIsHandlingPhoto(false);
        return;
      }

      console.log('Upload photo handler: Launching image library...');
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [3, 4],
        quality: 0.8,
      });

      console.log('Upload photo handler: Image library result', { canceled: result.canceled, hasAssets: !!result.assets?.[0] });
      
      if (!result.canceled && result.assets[0]) {
        setUpdatingCover(true);
        
        try {
          // Resize and optimize the image
          const manipulatedImage = await ImageManipulator.manipulateAsync(
            result.assets[0].uri,
            [{ resize: { width: 600 } }],
            { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
          );

          // Save to local storage
          if (FileSystem.documentDirectory) {
            const coversDir = `${FileSystem.documentDirectory}covers`;
            const dirInfo = await FileSystem.getInfoAsync(coversDir);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
            }

            const fileName = `custom_${book.id || Date.now()}.jpg`;
            const fileUri = `${coversDir}/${fileName}`;
            
            // Copy the image to our covers directory
            await FileSystem.copyAsync({
              from: manipulatedImage.uri,
              to: fileUri,
            });

            const localCoverPath = fileUri.replace(FileSystem.documentDirectory || '', '');

            const updatedBook: Book = {
              ...book,
              coverUrl: fileUri, // Use local file URI
              localCoverPath: localCoverPath,
            };

            // Update in AsyncStorage
            const userApprovedKey = `approved_books_${user.uid}`;
            const approvedData = await AsyncStorage.getItem(userApprovedKey);
            if (approvedData) {
              const approvedBooks: Book[] = JSON.parse(approvedData);
              const updatedBooks = approvedBooks.map(b => 
                (b.id === book.id || (b.title === book.title && b.author === book.author))
                  ? updatedBook
                  : b
              );
              await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
            }

            // Update in Supabase
            const { saveBookToSupabase } = await import('../services/supabaseSync');
            await saveBookToSupabase(user.uid, updatedBook, book.status || 'approved');

            // Notify parent to update everywhere
            if (onEditBook) {
              onEditBook(updatedBook);
            }
            if (onBookUpdate) {
              onBookUpdate(updatedBook);
            }

            setShowReplaceCoverModal(false);
            Alert.alert('Cover Updated', 'Your photo has been set as the book cover everywhere.');
          }
        } catch (processingError) {
          console.error('Error processing photo for cover:', processingError);
          Alert.alert('Error', 'Failed to process photo. Please try again.');
        } finally {
          setUpdatingCover(false);
        }
      } else {
        console.log('Upload photo handler: User canceled or no asset');
      }
    } catch (error) {
      console.error('Error uploading photo for cover:', error);
      Alert.alert('Error', 'Failed to upload photo. Please try again.');
    } finally {
      setIsHandlingPhoto(false);
      setUpdatingCover(false);
    }
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
            <TouchableOpacity
              onPress={handleCoverPress}
              activeOpacity={0.8}
              disabled={updatingCover}
              style={styles.bookCoverContainer}
            >
              {getBookCoverUri(book) ? (
                <Image
                  source={{ uri: getBookCoverUri(book) }}
                  style={styles.bookCover}
                  pointerEvents="none"
                />
              ) : (
                <View style={[styles.bookCover, styles.placeholderCover]}>
                  <Text style={styles.placeholderCoverText}>Tap to add cover</Text>
                </View>
              )}
            </TouchableOpacity>
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
                        {book.ratingsCount ? ` (${book.ratingsCount.toLocaleString()} reviews)` : ''}
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

      {/* Cover Options Action Sheet */}
      <Modal
        visible={showCoverOptions}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowCoverOptions(false)}
      >
        <TouchableOpacity
          style={styles.actionSheetOverlay}
          activeOpacity={1}
          onPress={() => setShowCoverOptions(false)}
        >
          <View style={styles.actionSheet}>
            <TouchableOpacity
              style={styles.actionSheetButton}
              onPress={handleReplaceCover}
              activeOpacity={0.7}
            >
              <Text style={styles.actionSheetButtonText}>Replace Cover</Text>
            </TouchableOpacity>
            {getBookCoverUri(book) && (
              <TouchableOpacity
                style={[styles.actionSheetButton, styles.actionSheetButtonDanger]}
                onPress={handleRemoveCover}
                activeOpacity={0.7}
              >
                <Text style={[styles.actionSheetButtonText, styles.actionSheetButtonTextDanger]}>Remove Cover</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.actionSheetCancelButton}
              onPress={() => setShowCoverOptions(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.actionSheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Replace Cover Modal */}
      <Modal
        visible={showReplaceCoverModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setShowReplaceCoverModal(false);
          setCoverSearchResults([]);
        }}
      >
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
            <Text style={styles.modalTitle}>Replace Cover</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                setShowReplaceCoverModal(false);
                setCoverSearchResults([]);
              }}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          
          {book && (
            <ScrollView style={styles.modalContent}>
              <View style={styles.switchCoversHeader}>
                <Text style={styles.switchCoversTitle}>Current Book</Text>
                <View style={styles.currentBookCard}>
                  {getBookCoverUri(book) ? (
                    <Image 
                      source={{ uri: getBookCoverUri(book) }} 
                      style={styles.currentBookCover}
                    />
                  ) : (
                    <View style={[styles.currentBookCover, styles.placeholderCover]}>
                      <Text style={styles.placeholderText} numberOfLines={3}>
                        {book.title}
                      </Text>
                    </View>
                  )}
                  <View style={styles.currentBookInfo}>
                    <Text style={styles.currentBookTitle}>{book.title}</Text>
                    {book.author && (
                      <Text style={styles.currentBookAuthor}>{book.author}</Text>
                    )}
                  </View>
                </View>
              </View>

              {/* Photo Options */}
              <View style={styles.photoOptionsSection}>
                <Text style={styles.switchCoversSectionTitle}>Take or Upload Photo</Text>
                <View style={styles.photoOptionsRow}>
                  <TouchableOpacity
                    style={styles.photoOptionButton}
                    onPress={handleTakePhotoForCover}
                    disabled={updatingCover || isHandlingPhoto}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.photoOptionButtonText}>Take Photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.photoOptionButton}
                    onPress={handleUploadPhotoForCover}
                    disabled={updatingCover || isHandlingPhoto}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.photoOptionButtonText}>Upload Photo</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.switchCoversSection}>
                <Text style={styles.switchCoversSectionTitle}>Available Covers</Text>
                {isLoadingCovers ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#0056CC" />
                    <Text style={styles.loadingText}>Searching for covers...</Text>
                  </View>
                ) : coverSearchResults.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No covers found</Text>
                  </View>
                ) : (
                  <View style={styles.coversGrid}>
                    {coverSearchResults.map((result, index) => (
                      <TouchableOpacity
                        key={result.googleBooksId || index}
                        style={styles.coverOption}
                        onPress={() => handleSelectCover(result)}
                        activeOpacity={0.7}
                        disabled={updatingCover}
                      >
                        {result.coverUrl ? (
                          <Image 
                            source={{ uri: result.coverUrl }} 
                            style={styles.coverOptionImage}
                          />
                        ) : (
                          <View style={[styles.coverOptionImage, styles.placeholderCover]}>
                            <Text style={styles.placeholderText}>No Cover</Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
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
  bookCoverContainer: {
    marginRight: 20,
  },
  bookCover: {
    width: 120,
    height: 180,
    borderRadius: 8,
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
  placeholderCover: {
    backgroundColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderCoverText: {
    fontSize: 12,
    color: '#718096',
    textAlign: 'center',
    fontWeight: '500',
  },
  placeholderText: {
    fontSize: 12,
    color: '#718096',
    textAlign: 'center',
    padding: 10,
  },
  actionSheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  actionSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20,
  },
  actionSheetButton: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  actionSheetButtonDanger: {
    borderBottomWidth: 0,
  },
  actionSheetButtonText: {
    fontSize: 18,
    color: '#0056CC',
    fontWeight: '600',
    textAlign: 'center',
  },
  actionSheetButtonTextDanger: {
    color: '#e53e3e',
  },
  actionSheetCancelButton: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginTop: 8,
  },
  actionSheetCancelText: {
    fontSize: 18,
    color: '#718096',
    fontWeight: '600',
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  modalHeader: {
    backgroundColor: '#2d3748',
    paddingHorizontal: 20,
    paddingBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  modalCloseButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  modalCloseText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
  },
  modalContent: {
    flex: 1,
    padding: 20,
  },
  switchCoversHeader: {
    marginBottom: 24,
  },
  switchCoversTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
  },
  currentBookCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  currentBookCover: {
    width: 80,
    height: 120,
    borderRadius: 8,
    marginRight: 16,
    backgroundColor: '#e2e8f0',
  },
  currentBookInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  currentBookTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 6,
  },
  currentBookAuthor: {
    fontSize: 14,
    color: '#718096',
    fontStyle: 'italic',
  },
  photoOptionsSection: {
    marginBottom: 24,
  },
  photoOptionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  photoOptionButton: {
    flex: 1,
    backgroundColor: '#0056CC',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoOptionButtonText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
  },
  switchCoversSection: {
    marginBottom: 24,
  },
  switchCoversSectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#718096',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#a0aec0',
  },
  coversGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  coverOption: {
    width: '30%',
    aspectRatio: 2/3,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
  },
  coverOptionImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
});

export default BookDetailModal;

