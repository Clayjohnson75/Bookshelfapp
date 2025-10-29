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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { Book, Photo } from '../types/BookTypes';

interface BookDetailModalProps {
  visible: boolean;
  book: Book | null;
  photo: Photo | null;
  onClose: () => void;
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  visible,
  book,
  photo,
  onClose,
}) => {
  const [description, setDescription] = useState<string | null>(null);
  const [loadingDescription, setLoadingDescription] = useState(false);

  useEffect(() => {
    if (visible && book) {
      // If book has description already, use it
      if (book.description) {
        setDescription(cleanDescription(book.description));
      } else if (book.googleBooksId) {
        // Fetch description from Google Books API
        fetchBookDescription(book.googleBooksId);
      } else {
        setDescription(null);
      }
    } else {
      setDescription(null);
    }
  }, [visible, book]);

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

  const fetchBookDescription = async (googleBooksId: string) => {
    setLoadingDescription(true);
    try {
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes/${googleBooksId}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch book description');
      }
      const data = await response.json();
      const desc = data.volumeInfo?.description;
      if (desc) {
        setDescription(cleanDescription(desc));
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
      <SafeAreaView style={styles.safeContainer}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Book Details</Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>
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
          </View>

          {/* Scan Photo */}
          {photo && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>From Scan</Text>
              <Image source={{ uri: photo.uri }} style={styles.scanPhoto} />
              <Text style={styles.scanDate}>
                Scanned: {new Date(photo.timestamp).toLocaleDateString()}
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  header: {
    backgroundColor: '#1a1a2e',
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: '600',
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
});

export default BookDetailModal;

