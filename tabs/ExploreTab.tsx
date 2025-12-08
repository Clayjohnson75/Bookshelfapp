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
  Alert,
  ScrollView,
  Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/SimpleAuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Book, WishlistItem } from '../types/BookTypes';
import { Ionicons } from '@expo/vector-icons';
import UserProfileModal from '../components/UserProfileModal';

interface User {
  uid: string;
  email: string;
  username: string;
  displayName?: string;
}

interface GoogleBookResult {
  id: string;
  volumeInfo: {
    title: string;
    authors?: string[];
    description?: string;
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
    };
    industryIdentifiers?: Array<{
      type: string;
      identifier: string;
    }>;
    publishedDate?: string;
    pageCount?: number;
    categories?: string[];
    printType?: string;
    averageRating?: number;
    ratingsCount?: number;
    publisher?: string;
    language?: string;
  };
}

interface AuthorResult {
  name: string;
  photoUrl?: string;
  bookCount: number;
  firstBook?: GoogleBookResult; // For fetching author info
}

type SearchFilter = 'books' | 'authors' | 'users';

export const ExploreTab: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { user, searchUsers } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('books');
  const [searchResults, setSearchResults] = useState<GoogleBookResult[]>([]);
  const [authorResults, setAuthorResults] = useState<AuthorResult[]>([]);
  const [userResults, setUserResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreBooks, setHasMoreBooks] = useState(false);
  const [bookSearchStartIndex, setBookSearchStartIndex] = useState(0);
  const [bookSearchTotalItems, setBookSearchTotalItems] = useState(0);
  const searchLockRef = React.useRef(false);
  const [selectedBook, setSelectedBook] = useState<GoogleBookResult | null>(null);
  const [showBookDetail, setShowBookDetail] = useState(false);
  const [libraryBooks, setLibraryBooks] = useState<Book[]>([]);
  const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
  const [selectedAuthor, setSelectedAuthor] = useState<string | null>(null);
  const [authorBooks, setAuthorBooks] = useState<GoogleBookResult[]>([]);
  const [showAuthorView, setShowAuthorView] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Load library and wishlist
  useEffect(() => {
    loadLibraryAndWishlist();
  }, [user]);

  const loadLibraryAndWishlist = async () => {
    if (!user) return;
    
    try {
      const userApprovedKey = `approved_books_${user.uid}`;
      const wishlistKey = `wishlist_${user.uid}`;
      
      const approvedData = await AsyncStorage.getItem(userApprovedKey);
      const wishlistData = await AsyncStorage.getItem(wishlistKey);
      
      if (approvedData) {
        setLibraryBooks(JSON.parse(approvedData));
      }
      if (wishlistData) {
        setWishlist(JSON.parse(wishlistData));
      }
    } catch (error) {
      console.error('Error loading library/wishlist:', error);
    }
  };

  // Search based on filter
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setAuthorResults([]);
      setUserResults([]);
      setHasMoreBooks(false);
      setBookSearchStartIndex(0);
      setBookSearchTotalItems(0);
      return;
    }

    const delayedSearch = setTimeout(async () => {
      setLoading(true);
      setBookSearchStartIndex(0); // Reset pagination on new search
      setHasMoreBooks(false);
      try {
        if (searchFilter === 'books') {
          await searchBooks(0, true); // Start from beginning, reset results
        } else if (searchFilter === 'authors') {
          await searchAuthors();
        } else if (searchFilter === 'users') {
          await searchUsersList();
        }
      } catch (error) {
        console.error('Error searching:', error);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(delayedSearch);
  }, [searchQuery, searchFilter]);

  const searchBooks = async (startIndex: number = 0, reset: boolean = false, retryCount: number = 0) => {
    try {
      const query = encodeURIComponent(searchQuery.trim());
      const maxResults = 40; // Google Books API max per request
      
      // Fetch books with pagination
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${query}&orderBy=relevance&maxResults=${maxResults}&startIndex=${startIndex}`
      );
      
      // Handle rate limiting (503) with retry
      if (response.status === 503 && retryCount < 3) {
        const delay = (retryCount + 1) * 1000; // Exponential backoff: 1s, 2s, 3s
        console.log(`⏳ Rate limited (503), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return searchBooks(startIndex, reset, retryCount + 1);
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      const totalItems = data.totalItems || 0;
      setBookSearchTotalItems(totalItems);
      
      if (!data.items || data.items.length === 0) {
        if (reset) {
          setSearchResults([]);
        }
        setHasMoreBooks(false);
        return;
      }
      
      // Get existing results if loading more
      const existingIds = reset ? new Set<string>() : new Set(searchResults.map(b => b.id));
      const newResults: GoogleBookResult[] = [];
      
      // Smart filtering to exclude manuscripts and academic papers, keep real books
      data.items.forEach((item: GoogleBookResult) => {
        if (!item || !item.id) return; // Skip invalid items
        
        if (existingIds.has(item.id)) {
          // Duplicate found - skip
          return;
        }
        
        const volumeInfo = item.volumeInfo || {};
        const title = (volumeInfo.title || '').toLowerCase();
        const authors = volumeInfo.authors || [];
        const categories = (volumeInfo.categories || []).join(' ').toLowerCase();
        const printType = (volumeInfo.printType || '').toLowerCase();
        const ratingsCount = volumeInfo.ratingsCount || 0;
        const hasISBN = volumeInfo.industryIdentifiers?.some(id => id.type.includes('ISBN'));
        const publishedDate = volumeInfo.publishedDate;
        
        // Must have a title
        if (!title || title.trim().length < 2) return;
        
        // Skip obvious non-books
        if (printType === 'magazine' || printType === 'journal') return;
        
        // Filter out academic papers, medical documents, and manuscripts - STRICT filtering
        const isAcademicPaper = 
          title.includes('proceedings of') ||
          title.includes('conference proceedings') ||
          title.includes('dissertation') ||
          title.includes('thesis') ||
          title.includes('manuscript') ||
          title.includes('volume') && title.match(/\bvolume\s+\d+\s+(of|in)\s+\d+\b/i) ||
          categories.includes('proceedings') ||
          categories.includes('dissertation') ||
          categories.includes('thesis');
        
        // Filter out medical/clinical documents and papers
        const isMedicalDocument = 
          categories.includes('medical') && !categories.includes('fiction') ||
          categories.includes('clinical') ||
          categories.includes('medicine') && !categories.includes('history') ||
          title.includes('clinical study') ||
          title.includes('medical journal') ||
          title.includes('case study') ||
          title.includes('clinical trial') ||
          (categories.includes('health') && !categories.includes('fiction')) ||
          printType === 'journal';
        
        if (isAcademicPaper || isMedicalDocument) return;
        
        // Filter out manuscripts and obscure books more aggressively
        const year = publishedDate ? parseInt(publishedDate.substring(0, 4)) : null;
        
        // Require at least ONE of these to be a real book:
        // 1. Has ISBN (published book)
        // 2. Has ratings (people read it)
        // 3. Has author + reasonable publication date (1900+)
        // 4. Has publisher info
        const hasRatings = ratingsCount > 0;
        const hasAuthorAndDate = authors.length > 0 && year && year >= 1900;
        const hasPublisher = volumeInfo.publisher && volumeInfo.publisher.trim().length > 0;
        
        const isRealBook = hasISBN || hasRatings || hasAuthorAndDate || hasPublisher;
        
        // Filter out anything that doesn't look like a real published book
        if (!isRealBook) {
          // Exception: Allow classic books even without modern indicators
          const isClassic = year && year >= 1800 && year < 1900 && authors.length > 0;
          if (!isClassic) {
            return; // Not a real book
          }
        }
        
        // Additional filters for manuscripts
        // Filter out very old items (before 1800) unless they're famous classics
        if (year && year < 1800) {
          return; // Too old to be relevant
        }
        
        // Filter out items with no author, no ISBN, no ratings, no publisher
        if (!authors.length && !hasISBN && !hasRatings && !hasPublisher) {
          return; // Missing all indicators of a real book
        }
        
        // Include the book - it passed all filters
        existingIds.add(item.id);
        newResults.push(item);
      });
      
      // Sort by popularity (ratings count first, then average rating)
      newResults.sort((a, b) => {
        const aRatings = a.volumeInfo.ratingsCount || 0;
        const bRatings = b.volumeInfo.ratingsCount || 0;
        
        // First sort by number of ratings (popularity)
        if (bRatings !== aRatings) {
          return bRatings - aRatings;
        }
        
        // Then by average rating
        const aAvg = a.volumeInfo.averageRating || 0;
        const bAvg = b.volumeInfo.averageRating || 0;
        if (bAvg !== aAvg) {
          return bAvg - aAvg;
        }
        
        // Finally by publication date (newer first)
        const aDate = a.volumeInfo.publishedDate || '';
        const bDate = b.volumeInfo.publishedDate || '';
        return bDate.localeCompare(aDate);
      });
      
      // Combine with existing results or replace, then re-sort combined results
      let combinedResults = reset ? newResults : [...searchResults, ...newResults];
      
      // Re-sort combined results by popularity
      combinedResults.sort((a, b) => {
        const aRatings = a.volumeInfo.ratingsCount || 0;
        const bRatings = b.volumeInfo.ratingsCount || 0;
        
        if (bRatings !== aRatings) {
          return bRatings - aRatings;
        }
        
        const aAvg = a.volumeInfo.averageRating || 0;
        const bAvg = b.volumeInfo.averageRating || 0;
        if (bAvg !== aAvg) {
          return bAvg - aAvg;
        }
        
        const aDate = a.volumeInfo.publishedDate || '';
        const bDate = b.volumeInfo.publishedDate || '';
        return bDate.localeCompare(aDate);
      });
      
      // Check if there are more results available
      const itemsReturned = data.items.length;
      const nextStartIndex = startIndex + itemsReturned;
      
      // We have more if: API returned items AND we haven't reached the total AND we got new results
      const hasMore = itemsReturned > 0 && nextStartIndex < totalItems;
      
      setHasMoreBooks(hasMore);
      setBookSearchStartIndex(nextStartIndex);
      
      setSearchResults(combinedResults);
      
      // Better logging
      const duplicates = itemsReturned - newResults.length;
      if (duplicates > 0) {
        console.log(`📚 Loaded ${newResults.length} new books from ${itemsReturned} API results (${duplicates} duplicates skipped, ${combinedResults.length} total)`);
      } else {
        console.log(`📚 Loaded ${newResults.length} books from ${itemsReturned} API results (${combinedResults.length} total, ${totalItems} total available)`);
      }
    } catch (error: any) {
      console.error('Error searching books:', error);
      if (reset) {
        setSearchResults([]);
      }
      setHasMoreBooks(false);
    }
  };

  const loadMoreBooks = async () => {
    if (loadingMore || !hasMoreBooks || loading || !searchQuery.trim()) {
      return;
    }
    
    console.log(`🔄 Loading more books: startIndex=${bookSearchStartIndex}, hasMore=${hasMoreBooks}`);
    setLoadingMore(true);
    try {
      await searchBooks(bookSearchStartIndex, false);
    } catch (error) {
      console.error('Error loading more books:', error);
      setHasMoreBooks(false);
    } finally {
      setLoadingMore(false);
    }
  };

  // Load author photos asynchronously
  const loadAuthorPhotos = async (authors: AuthorResult[]): Promise<AuthorResult[]> => {
    const updatedAuthors = await Promise.all(
      authors.map(async (author) => {
        if (author.photoUrl) return author; // Already has photo
        
        try {
          const authorNameForUrl = encodeURIComponent(author.name.replace(/\s+/g, '_'));
          const openLibResponse = await fetch(
            `https://openlibrary.org/search/authors.json?q=${authorNameForUrl}&limit=1`
          );
          
          if (openLibResponse.ok) {
            const openLibData = await openLibResponse.json();
            if (openLibData.docs && openLibData.docs.length > 0) {
              const authorKey = openLibData.docs[0].key;
              if (authorKey) {
                return {
                  ...author,
                  photoUrl: `https://covers.openlibrary.org/a/olid/${authorKey.replace('/authors/', '')}-M.jpg`,
                };
              }
            }
          }
        } catch (photoError) {
          // Silently fail if we can't get photo
        }
        
        return author;
      })
    );
    
    return updatedAuthors;
  };

  // Helper function to identify classic books
  const isClassicBook = (title: string, authors: string[]): boolean => {
    const classicTitles = [
      'pride and prejudice', 'moby dick', 'war and peace', '1984',
      'to kill a mockingbird', 'the great gatsby', 'hamlet', 'romeo and juliet',
      'the odyssey', 'the iliad', 'don quixote', 'les miserables',
      'crime and punishment', 'anna karenina', 'the count of monte cristo'
    ];
    
    const classicAuthors = [
      'shakespeare', 'dickens', 'austen', 'twain', 'dostoevsky',
      'tolstoy', 'hemingway', 'fitzgerald', 'steinbeck', 'orwell'
    ];
    
    return classicTitles.some(ct => title.includes(ct)) ||
           authors.some(a => classicAuthors.some(ca => a.toLowerCase().includes(ca)));
  };

  const searchAuthors = async () => {
    try {
      const query = encodeURIComponent(`inauthor:"${searchQuery.trim()}"`);
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=40&orderBy=relevance&printType=books`
      );
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      // Filter to get unique authors and their books
      const authorMap = new Map<string, GoogleBookResult[]>();
      
      (data.items || []).forEach((book: GoogleBookResult) => {
        const authors = book.volumeInfo.authors || [];
        authors.forEach(author => {
          if (!authorMap.has(author)) {
            authorMap.set(author, []);
          }
          authorMap.get(author)?.push(book);
        });
      });

      // Convert to author results (photos will be loaded lazily)
      const results: AuthorResult[] = [];
      
      for (const [authorName, books] of authorMap.entries()) {
        if (!authorName.toLowerCase().includes(searchQuery.toLowerCase())) {
          continue;
        }
        
        results.push({
          name: authorName,
          photoUrl: undefined, // Will be loaded lazily in the component
          bookCount: books.length,
          firstBook: books[0],
        });
      }
      
      setAuthorResults(results);
      setSearchResults([]); // Clear book results when searching authors
      
      // Load photos asynchronously after setting initial results
      if (results.length > 0) {
        loadAuthorPhotos(results).then(updatedResults => {
          setAuthorResults(updatedResults);
        });
      }
    } catch (error: any) {
      console.error('Error searching authors:', error);
      setAuthorResults([]);
      setSearchResults([]);
    }
  };

  const searchUsersList = async () => {
    try {
      const results = await searchUsers(searchQuery);
      setUserResults(results);
    } catch (error) {
      console.error('Error searching users:', error);
      setUserResults([]);
    }
  };

  // Check if book is in library or wishlist
  const isInLibrary = (book: GoogleBookResult): boolean => {
    const title = book.volumeInfo.title?.toLowerCase().trim() || '';
    return libraryBooks.some(b => b.title?.toLowerCase().trim() === title);
  };

  const isInWishlist = (book: GoogleBookResult): boolean => {
    const title = book.volumeInfo.title?.toLowerCase().trim() || '';
    return wishlist.some(b => b.title?.toLowerCase().trim() === title);
  };

  const handleBookPress = (book: GoogleBookResult) => {
    setSelectedBook(book);
    setShowBookDetail(true);
  };

  const handleAuthorPress = async (author: string) => {
    setSelectedAuthor(author);
    setLoading(true);
    try {
      // Search for books by exact author name
      const query = encodeURIComponent(`inauthor:"${author}"`);
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=40&orderBy=relevance&printType=books`
      );
      
      if (response.ok) {
        const data = await response.json();
        
        // Filter to only show books where this author is actually in the authors list
        // Apply strict filtering like regular book search
        const normalizedSearchAuthor = author.toLowerCase().trim();
        const filtered = (data.items || [])
          .filter((item: GoogleBookResult) => {
            const volumeInfo = item.volumeInfo || {};
            const printType = volumeInfo.printType?.toLowerCase();
            const title = (volumeInfo.title || '').toLowerCase();
            const authors = volumeInfo.authors || [];
            const categories = (volumeInfo.categories || []).join(' ').toLowerCase();
            const ratingsCount = volumeInfo.ratingsCount || 0;
            const hasISBN = volumeInfo.industryIdentifiers?.some(id => id.type.includes('ISBN'));
            const publishedDate = volumeInfo.publishedDate;
            
            // Must have authors
            if (authors.length === 0) return false;
            
            // Check if the exact author name is in the authors list (STRICT matching)
            const hasExactAuthor = authors.some(a => {
              const normalizedAuthor = a.toLowerCase().trim();
              // Exact match or last name match (for name variations)
              return normalizedAuthor === normalizedSearchAuthor ||
                     normalizedAuthor.includes(normalizedSearchAuthor) ||
                     normalizedSearchAuthor.includes(normalizedAuthor.split(' ').pop() || '');
            });
            
            if (!hasExactAuthor) return false;
            
            // Apply same filtering as regular book search
            if (printType === 'magazine' || printType === 'journal') return false;
            
            // Filter out academic papers and medical documents
            const isAcademicPaper = 
              title.includes('proceedings of') ||
              title.includes('conference proceedings') ||
              title.includes('dissertation') ||
              title.includes('thesis') ||
              title.includes('manuscript') ||
              categories.includes('proceedings') ||
              categories.includes('dissertation') ||
              categories.includes('thesis');
            
            const isMedicalDocument = 
              categories.includes('medical') && !categories.includes('fiction') ||
              categories.includes('clinical') ||
              categories.includes('medicine') && !categories.includes('history') ||
              title.includes('clinical study') ||
              title.includes('medical journal') ||
              title.includes('case study') ||
              printType === 'journal';
            
            if (isAcademicPaper || isMedicalDocument) return false;
            
            // Require at least one indicator of a real book
            const year = publishedDate ? parseInt(publishedDate.substring(0, 4)) : null;
            const hasRatings = ratingsCount > 0;
            const hasAuthorAndDate = authors.length > 0 && year && year >= 1900;
            const hasPublisher = volumeInfo.publisher && volumeInfo.publisher.trim().length > 0;
            const isRealBook = hasISBN || hasRatings || hasAuthorAndDate || hasPublisher;
            
            if (!isRealBook) {
              const isClassic = year && year >= 1800 && year < 1900 && authors.length > 0;
              if (!isClassic) return false;
            }
            
            return true;
          })
          .sort((a, b) => {
            // Sort by popularity (ratings count)
            const aRating = a.volumeInfo.ratingsCount || 0;
            const bRating = b.volumeInfo.ratingsCount || 0;
            
            if (bRating !== aRating) {
              return bRating - aRating;
            }
            
            // Then by publication date (newer first)
            const aDate = a.volumeInfo.publishedDate || '';
            const bDate = b.volumeInfo.publishedDate || '';
            return bDate.localeCompare(aDate);
          });
        
        setAuthorBooks(filtered);
        setShowAuthorView(true);
      }
    } catch (error) {
      console.error('Error loading author books:', error);
    } finally {
      setLoading(false);
    }
  };

  const addToLibrary = async (book: GoogleBookResult) => {
    if (!user) return;

    try {
      const newBook: Book = {
        id: `explore_${Date.now()}`,
        title: book.volumeInfo.title || 'Unknown Title',
        author: book.volumeInfo.authors?.[0] || 'Unknown Author',
        isbn: book.volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier ||
              book.volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier,
        coverUrl: book.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:'),
        googleBooksId: book.id,
        description: book.volumeInfo.description,
        status: 'approved',
        scannedAt: Date.now(),
      };

      // Check for duplicates
      const normalize = (s?: string) => {
        if (!s) return '';
        return s.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ');
      };
      const normalizeTitle = (t?: string) => normalize(t).replace(/^(the|a|an)\s+/, '').trim();
      const normalizeAuthor = (a?: string) => normalize(a).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
      const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
      
      const newBookKey = makeKey(newBook);
      const alreadyExists = libraryBooks.some(b => makeKey(b) === newBookKey);

      if (alreadyExists) {
        Alert.alert('Already in Library', `"${newBook.title}" is already in your library.`);
        return;
      }

      const updatedBooks = [...libraryBooks, newBook];
      setLibraryBooks(updatedBooks);
      
      const userApprovedKey = `approved_books_${user.uid}`;
      await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
      
      Alert.alert('Success', `"${newBook.title}" added to your library!`);
    } catch (error) {
      console.error('Error adding to library:', error);
      Alert.alert('Error', 'Failed to add book to library.');
    }
  };

  const addToWishlist = async (book: GoogleBookResult) => {
    if (!user) return;

    try {
      const wishlistItem: WishlistItem = {
        id: `wishlist_${Date.now()}`,
        title: book.volumeInfo.title || 'Unknown Title',
        author: book.volumeInfo.authors?.[0] || 'Unknown Author',
        isbn: book.volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier ||
              book.volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier,
        coverUrl: book.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:'),
        googleBooksId: book.id,
        description: book.volumeInfo.description,
        addedAt: Date.now(),
      };

      // Check for duplicates
      const normalize = (s?: string) => {
        if (!s) return '';
        return s.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ');
      };
      const normalizeTitle = (t?: string) => normalize(t).replace(/^(the|a|an)\s+/, '').trim();
      const normalizeAuthor = (a?: string) => normalize(a).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
      const makeKey = (b: WishlistItem) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
      
      const newItemKey = makeKey(wishlistItem);
      const alreadyExists = wishlist.some(b => makeKey(b) === newItemKey);

      if (alreadyExists) {
        Alert.alert('Already in Wishlist', `"${wishlistItem.title}" is already in your wishlist.`);
        return;
      }

      const updatedWishlist = [...wishlist, wishlistItem];
      setWishlist(updatedWishlist);
      
      const wishlistKey = `wishlist_${user.uid}`;
      await AsyncStorage.setItem(wishlistKey, JSON.stringify(updatedWishlist));
      
      Alert.alert('Success', `"${wishlistItem.title}" added to your wishlist!`);
    } catch (error) {
      console.error('Error adding to wishlist:', error);
      Alert.alert('Error', 'Failed to add book to wishlist.');
    }
  };

  const renderBookItem = ({ item }: { item: GoogleBookResult }) => {
    const title = item.volumeInfo.title || 'Unknown Title';
    const author = item.volumeInfo.authors?.[0] || 'Unknown Author';
    const coverUrl = item.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:');
    const inLibrary = isInLibrary(item);
    const inWishlist = isInWishlist(item);

    return (
      <TouchableOpacity
        style={styles.bookCard}
        onPress={() => handleBookPress(item)}
        activeOpacity={0.8}
      >
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={styles.bookCover} />
        ) : (
          <View style={[styles.bookCover, styles.placeholderCover]}>
            <Ionicons name="book" size={32} color="#cbd5e0" />
          </View>
        )}
        <View style={styles.bookInfo}>
          <Text style={styles.bookTitle} numberOfLines={2}>{title}</Text>
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation();
              handleAuthorPress(author);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.bookAuthor} numberOfLines={1}>by {author}</Text>
          </TouchableOpacity>
          <View style={styles.bookBadges}>
            {inLibrary && (
              <View style={styles.badge}>
                <Ionicons name="checkmark-circle" size={12} color="#48bb78" />
                <Text style={styles.badgeText}>Library</Text>
              </View>
            )}
            {inWishlist && (
              <View style={[styles.badge, styles.wishlistBadge]}>
                <Ionicons name="heart" size={12} color="#ed64a6" />
                <Text style={styles.badgeText}>Wishlist</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderAuthorItem = ({ item }: { item: AuthorResult }) => {
    const initials = item.name
      .split(' ')
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();

    return (
      <TouchableOpacity
        style={styles.authorCard}
        onPress={() => handleAuthorPress(item.name)}
        activeOpacity={0.8}
      >
        {item.photoUrl ? (
          <Image source={{ uri: item.photoUrl }} style={styles.authorAvatar} />
        ) : (
          <View style={styles.authorAvatarPlaceholder}>
            <Text style={styles.authorAvatarText}>{initials}</Text>
          </View>
        )}
        <View style={styles.authorInfo}>
          <Text style={styles.authorNameText} numberOfLines={2}>{item.name}</Text>
          <Text style={styles.authorBookCount}>{item.bookCount} {item.bookCount === 1 ? 'book' : 'books'}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderUserItem = ({ item }: { item: User }) => (
    <TouchableOpacity
      style={styles.userCard}
      onPress={() => {
        setSelectedUser(item);
        setShowProfileModal(true);
      }}
      activeOpacity={0.8}
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
      <Ionicons name="chevron-forward" size={20} color="#cbd5e0" />
    </TouchableOpacity>
  );

  const hasResults = searchFilter === 'users' 
    ? userResults.length > 0 
    : searchFilter === 'authors'
    ? authorResults.length > 0
    : searchResults.length > 0;

  return (
    <SafeAreaView style={styles.safeContainer} edges={['left','right','bottom']}>
      <View style={styles.container}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.header}>
          <Text style={styles.title}>Explore</Text>
          <Text style={styles.subtitle}>Search for books, authors, or users</Text>
        </View>

        {/* Filter Tabs - Above Search */}
        <View style={styles.filterContainer}>
          <TouchableOpacity
            style={[styles.filterTab, searchFilter === 'books' && styles.filterTabActive]}
            onPress={() => {
              setSearchFilter('books');
              setSearchQuery('');
              setSearchResults([]);
              setAuthorResults([]);
              setUserResults([]);
            }}
          >
            <Ionicons 
              name="book" 
              size={18} 
              color={searchFilter === 'books' ? '#ffffff' : '#718096'} 
            />
            <Text style={[styles.filterText, searchFilter === 'books' && styles.filterTextActive]}>
              Books
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterTab, searchFilter === 'authors' && styles.filterTabActive]}
            onPress={() => {
              setSearchFilter('authors');
              setSearchQuery('');
              setSearchResults([]);
              setAuthorResults([]);
              setUserResults([]);
            }}
          >
            <Ionicons 
              name="person" 
              size={18} 
              color={searchFilter === 'authors' ? '#ffffff' : '#718096'} 
            />
            <Text style={[styles.filterText, searchFilter === 'authors' && styles.filterTextActive]}>
              Authors
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterTab, searchFilter === 'users' && styles.filterTabActive]}
            onPress={() => {
              setSearchFilter('users');
              setSearchQuery('');
              setSearchResults([]);
              setAuthorResults([]);
              setUserResults([]);
            }}
          >
            <Ionicons 
              name="people" 
              size={18} 
              color={searchFilter === 'users' ? '#ffffff' : '#718096'} 
            />
            <Text style={[styles.filterText, searchFilter === 'users' && styles.filterTextActive]}>
              Users
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder={`Search ${searchFilter}...`}
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

        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        )}

        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            {!loading && searchQuery.length >= 2 && !hasResults && (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No {searchFilter} found</Text>
              </View>
            )}

            {!loading && searchFilter === 'books' && searchResults.length > 0 && (
              <FlatList
                data={searchResults}
                renderItem={renderBookItem}
                keyExtractor={(item) => item.id}
                style={styles.resultsList}
                contentContainerStyle={styles.resultsContent}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={Keyboard.dismiss}
                numColumns={3}
                columnWrapperStyle={styles.row}
                onEndReached={loadMoreBooks}
                onEndReachedThreshold={0.3}
                removeClippedSubviews={false}
                ListFooterComponent={
                  loadingMore ? (
                    <View style={styles.loadingMoreContainer}>
                      <ActivityIndicator size="small" color="#007AFF" />
                      <Text style={styles.loadingMoreText}>Loading more books...</Text>
                    </View>
                  ) : null
                }
              />
            )}

            {!loading && searchFilter === 'authors' && authorResults.length > 0 && (
              <FlatList
                data={authorResults}
                renderItem={renderAuthorItem}
                keyExtractor={(item) => item.name}
                style={styles.resultsList}
                contentContainerStyle={styles.resultsContent}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={Keyboard.dismiss}
                numColumns={3}
                columnWrapperStyle={styles.row}
              />
            )}

            {!loading && searchFilter === 'users' && userResults.length > 0 && (
              <FlatList
                data={userResults}
                renderItem={renderUserItem}
                keyExtractor={(item) => item.uid}
                style={styles.resultsList}
                contentContainerStyle={styles.resultsContent}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={Keyboard.dismiss}
              />
            )}

            {searchQuery.length < 2 && (
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={styles.placeholderContainer}>
                  <Ionicons name="search" size={64} color="#cbd5e0" />
                  <Text style={styles.placeholderText}>
                    Start typing to search for {searchFilter}...
                  </Text>
                </View>
              </TouchableWithoutFeedback>
            )}
          </View>
        </TouchableWithoutFeedback>
      </View>

      {/* Book Detail Modal */}
      {selectedBook && (
        <BookDetailModal
          visible={showBookDetail}
          book={selectedBook}
          onClose={() => {
            setShowBookDetail(false);
            setSelectedBook(null);
          }}
          onAddToLibrary={() => addToLibrary(selectedBook)}
          onAddToWishlist={() => addToWishlist(selectedBook)}
          isInLibrary={isInLibrary(selectedBook)}
          isInWishlist={isInWishlist(selectedBook)}
          onAuthorPress={handleAuthorPress}
        />
      )}

      {/* Author Books View */}
      {selectedAuthor && (
        <AuthorBooksModal
          visible={showAuthorView}
          author={selectedAuthor}
          books={authorBooks}
          onClose={() => {
            setShowAuthorView(false);
            setSelectedAuthor(null);
            setAuthorBooks([]);
          }}
          onBookPress={handleBookPress}
          isInLibrary={isInLibrary}
          isInWishlist={isInWishlist}
        />
      )}

      {/* User Profile Modal */}
      <UserProfileModal
        visible={showProfileModal}
        user={selectedUser}
        onClose={() => {
          setShowProfileModal(false);
          setSelectedUser(null);
        }}
        currentUserId={user?.uid}
      />
    </SafeAreaView>
  );
};

// Book Detail Modal Component
interface BookDetailModalProps {
  visible: boolean;
  book: GoogleBookResult;
  onClose: () => void;
  onAddToLibrary: () => void;
  onAddToWishlist: () => void;
  isInLibrary: boolean;
  isInWishlist: boolean;
  onAuthorPress: (author: string) => void;
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  visible,
  book,
  onClose,
  onAddToLibrary,
  onAddToWishlist,
  isInLibrary,
  isInWishlist,
  onAuthorPress,
}) => {
  const insets = useSafeAreaInsets();
  const volumeInfo = book.volumeInfo;
  const title = volumeInfo.title || 'Unknown Title';
  const authors = volumeInfo.authors || [];
  const coverUrl = volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:');
  const description = volumeInfo.description || 'No description available.';
  const isbn = volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier ||
               volumeInfo.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier;
  const publishedDate = volumeInfo.publishedDate;
  const pageCount = volumeInfo.pageCount;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafeContainer} edges={['left','right','bottom']}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.modalHeader}>
          <TouchableOpacity 
            onPress={onClose} 
            style={styles.modalBackButton}
            activeOpacity={0.7}
            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
          >
            <Ionicons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.modalTitle}>Book Details</Text>
          <View style={styles.modalHeaderSpacer} />
        </View>

        <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
          <View style={styles.bookDetailHeader}>
            {coverUrl ? (
              <Image source={{ uri: coverUrl }} style={styles.bookDetailCover} />
            ) : (
              <View style={[styles.bookDetailCover, styles.placeholderCover]}>
                <Ionicons name="book" size={60} color="#cbd5e0" />
              </View>
            )}
            <View style={styles.bookDetailInfo}>
              <Text style={styles.bookDetailTitle}>{title}</Text>
              {authors.length > 0 && (
                <View style={styles.authorsContainer}>
                  {authors.map((author, index) => (
                    <TouchableOpacity
                      key={index}
                      onPress={() => {
                        onClose();
                        onAuthorPress(author);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.bookDetailAuthor}>
                        {index > 0 ? ', ' : 'by '}{author}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {publishedDate && (
                <Text style={styles.bookDetailMeta}>Published: {publishedDate}</Text>
              )}
              {pageCount && (
                <Text style={styles.bookDetailMeta}>{pageCount} pages</Text>
              )}
              {isbn && (
                <Text style={styles.bookDetailMeta}>ISBN: {isbn}</Text>
              )}
            </View>
          </View>

          <View style={styles.modalActions}>
            {!isInLibrary && (
              <TouchableOpacity
                style={[styles.actionButton, styles.libraryButton]}
                onPress={onAddToLibrary}
                activeOpacity={0.8}
              >
                <Ionicons name="add-circle" size={20} color="#ffffff" />
                <Text style={styles.actionButtonText}>Add to Library</Text>
              </TouchableOpacity>
            )}
            {!isInWishlist && (
              <TouchableOpacity
                style={[styles.actionButton, styles.wishlistButton]}
                onPress={onAddToWishlist}
                activeOpacity={0.8}
              >
                <Ionicons name="heart-outline" size={20} color="#ffffff" />
                <Text style={styles.actionButtonText}>Add to Wishlist</Text>
              </TouchableOpacity>
            )}
            {(isInLibrary || isInWishlist) && (
              <View style={styles.statusMessage}>
                <Ionicons
                  name={isInLibrary ? "checkmark-circle" : "heart"}
                  size={20}
                  color={isInLibrary ? "#059669" : "#2563eb"}
                />
                <Text style={styles.statusText}>
                  {isInLibrary ? 'In your library' : 'In your wishlist'}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.modalSection}>
            <Text style={styles.sectionTitle}>Description</Text>
            <Text style={styles.descriptionText}>{description}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

// Author Books Modal Component
interface AuthorBooksModalProps {
  visible: boolean;
  author: string;
  books: GoogleBookResult[];
  onClose: () => void;
  onBookPress: (book: GoogleBookResult) => void;
  isInLibrary: (book: GoogleBookResult) => boolean;
  isInWishlist: (book: GoogleBookResult) => boolean;
}

const AuthorBooksModal: React.FC<AuthorBooksModalProps> = ({
  visible,
  author,
  books,
  onClose,
  onBookPress,
  isInLibrary,
  isInWishlist,
}) => {
  const [authorBio, setAuthorBio] = useState<string | null>(null);
  const [authorPhoto, setAuthorPhoto] = useState<string | null>(null);
  const [loadingBio, setLoadingBio] = useState(false);

  // Fetch author bio and photo when modal opens
  useEffect(() => {
    if (visible && author && books.length > 0) {
      fetchAuthorInfo();
    } else {
      setAuthorBio(null);
      setAuthorPhoto(null);
    }
  }, [visible, author, books]);

  const fetchAuthorInfo = async () => {
    setLoadingBio(true);
    try {
      // First try Google Books API for author info
      try {
        const query = encodeURIComponent(`inauthor:"${author}"`);
        const booksResponse = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&orderBy=relevance`
        );
        
        if (booksResponse.ok) {
          const booksData = await booksResponse.json();
          if (booksData.items && booksData.items.length > 0) {
            // Google Books doesn't provide author photos directly, but we can use Open Library
            // We'll get bio from book descriptions if available
          }
        }
      } catch (booksError) {
        console.log('Google Books fetch failed:', booksError);
      }
      
      // Try Open Library for author photo and bio
      try {
        const openLibResponse = await fetch(
          `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(author)}&limit=1`
        );
        
        if (openLibResponse.ok) {
          const openLibData = await openLibResponse.json();
          if (openLibData.docs && openLibData.docs.length > 0) {
            const authorDoc = openLibData.docs[0];
            
            // Get author key and fetch full details
            if (authorDoc.key) {
              const authorKey = authorDoc.key.replace('/authors/', '');
              const authorDetailResponse = await fetch(
                `https://openlibrary.org/authors/${authorKey}.json`
              );
              
              if (authorDetailResponse.ok) {
                const authorDetail = await authorDetailResponse.json();
                
                // Get bio
                if (authorDetail.bio) {
                  const bio = typeof authorDetail.bio === 'string' 
                    ? authorDetail.bio 
                    : authorDetail.bio.value || '';
                  if (bio && !authorBio) setAuthorBio(bio);
                }
                
                // Get photo - try multiple photo formats
                if (authorDetail.photos && authorDetail.photos.length > 0) {
                  const photoId = authorDetail.photos[0];
                  // Try large size first
                  setAuthorPhoto(`https://covers.openlibrary.org/a/id/${photoId}-L.jpg`);
                } else if (authorKey) {
                  // Try OLID format for author photos
                  const olidKey = authorKey.startsWith('/authors/') 
                    ? authorKey.replace('/authors/', '') 
                    : authorKey;
                  if (olidKey) {
                    setAuthorPhoto(`https://covers.openlibrary.org/a/olid/${olidKey}-L.jpg`);
                  }
                }
              }
            }
          }
        }
      } catch (openLibError) {
        console.log('Open Library fetch failed:', openLibError);
      }

      // Fallback: Get bio from first book's description if it mentions the author
      if (!authorBio && books.length > 0) {
        const firstBook = books[0];
        const description = firstBook.volumeInfo.description || '';
        
        // Try to extract author bio from book description
        if (description.toLowerCase().includes(author.toLowerCase())) {
          // Use part of description as bio
          const sentences = description.split(/[.!?]+/);
          const relevantSentences = sentences
            .filter(s => s.toLowerCase().includes(author.toLowerCase()))
            .slice(0, 3)
            .join('. ');
          
          if (relevantSentences.length > 50) {
            setAuthorBio(relevantSentences + '.');
          }
        }
      }
    } catch (error) {
      console.error('Error fetching author info:', error);
    } finally {
      setLoadingBio(false);
    }
  };

  // Get total books count and other stats
  const totalBooks = books.length;
  const averageRating = books.reduce((sum, book) => {
    return sum + (book.volumeInfo.averageRating || 0);
  }, 0) / (books.filter(b => b.volumeInfo.averageRating).length || 1);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafeContainer} edges={['left','right','bottom']}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.modalHeader}>
          <TouchableOpacity 
            onPress={onClose} 
            style={styles.modalBackButton}
            activeOpacity={0.7}
            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
          >
            <Ionicons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.modalTitle} numberOfLines={1}>{author}</Text>
          <View style={styles.modalHeaderSpacer} />
        </View>

        <ScrollView 
          style={styles.authorBooksList}
          contentContainerStyle={styles.authorBooksContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Author Header with Photo and Bio */}
          <View style={styles.authorHeader}>
            {authorPhoto ? (
              <Image source={{ uri: authorPhoto }} style={styles.authorPhoto} />
            ) : (
              <View style={styles.authorPhotoPlaceholder}>
                <Text style={styles.authorPhotoText}>
                  {author.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={styles.authorName}>{author}</Text>
            <View style={styles.authorStats}>
              <View style={styles.authorStatItem}>
                <Text style={styles.authorStatNumber}>{totalBooks}</Text>
                <Text style={styles.authorStatLabel}>Books</Text>
              </View>
              {averageRating > 0 && (
                <View style={styles.authorStatItem}>
                  <Ionicons name="star" size={16} color="#fbbf24" />
                  <Text style={styles.authorStatNumber}>{averageRating.toFixed(1)}</Text>
                  <Text style={styles.authorStatLabel}>Avg Rating</Text>
                </View>
              )}
            </View>
          </View>

          {/* Author Bio */}
          {(authorBio || loadingBio) && (
            <View style={styles.authorBioSection}>
              <Text style={styles.sectionTitle}>About</Text>
              {loadingBio ? (
                <ActivityIndicator size="small" color="#4a5568" />
              ) : authorBio ? (
                <Text style={styles.authorBioText}>{authorBio}</Text>
              ) : null}
            </View>
          )}

          {/* Books List */}
          <View style={styles.authorBooksSection}>
            <Text style={styles.sectionTitle}>Books ({totalBooks})</Text>
            {books.map((item) => {
              const title = item.volumeInfo.title || 'Unknown Title';
              const coverUrl = item.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:');
              const inLibrary = isInLibrary(item);
              const inWishlist = isInWishlist(item);
              const rating = item.volumeInfo.averageRating;
              const ratingsCount = item.volumeInfo.ratingsCount;
              const publishedDate = item.volumeInfo.publishedDate;

              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.authorBookCard}
                  onPress={() => {
                    onClose();
                    onBookPress(item);
                  }}
                  activeOpacity={0.8}
                >
                  {coverUrl ? (
                    <Image source={{ uri: coverUrl }} style={styles.authorBookCover} />
                  ) : (
                    <View style={[styles.authorBookCover, styles.placeholderCover]}>
                      <Ionicons name="book" size={30} color="#cbd5e0" />
                    </View>
                  )}
                  <View style={styles.authorBookInfo}>
                    <Text style={styles.authorBookTitle} numberOfLines={2}>{title}</Text>
                    {publishedDate && (
                      <Text style={styles.authorBookYear}>{publishedDate.substring(0, 4)}</Text>
                    )}
                    {rating && ratingsCount && (
                      <View style={styles.ratingRow}>
                        <Ionicons name="star" size={14} color="#fbbf24" />
                        <Text style={styles.ratingText}>{rating.toFixed(1)}</Text>
                        <Text style={styles.ratingCount}>({ratingsCount.toLocaleString()})</Text>
                      </View>
                    )}
                    <View style={styles.bookBadges}>
                      {inLibrary && (
                        <View style={styles.badge}>
                          <Ionicons name="checkmark-circle" size={12} color="#48bb78" />
                          <Text style={[styles.badgeText, styles.badgeTextSmall]}>Library</Text>
                        </View>
                      )}
                      {inWishlist && (
                        <View style={[styles.badge, styles.wishlistBadge]}>
                          <Ionicons name="heart" size={12} color="#ed64a6" />
                          <Text style={[styles.badgeText, styles.badgeTextSmall]}>Wishlist</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="#cbd5e0" />
                </TouchableOpacity>
              );
            })}
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
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#2d3748', // Slate header
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
    color: '#cbd5e0', // Light gray text
    fontWeight: '400',
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 15,
    paddingBottom: 12,
    gap: 8,
    backgroundColor: '#ffffff', // White
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e7eb', // Subtle gray border
  },
  filterTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#e8e6e3', // Grey marble (same as Take Photo buttons)
    gap: 6,
    borderWidth: 0.5,
    borderColor: '#d4d2cf', // Slightly darker grey border
  },
  filterTabActive: {
    backgroundColor: '#2563eb', // Deep blue accent (active state)
    borderColor: '#1d4ed8', // Darker blue border when active
  },
  filterText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2d3748', // Slate text (darker for contrast on marble)
  },
  filterTextActive: {
    color: '#ffffff', // White text when active
  },
  searchContainer: {
    padding: 20,
    paddingTop: 10,
    position: 'relative',
  },
  searchInput: {
    backgroundColor: '#ffffff', // White
    borderRadius: 16,
    padding: 18,
    paddingRight: 50,
    fontSize: 16,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
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
  loadingMoreContainer: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingMoreText: {
    marginTop: 8,
    fontSize: 14,
    color: '#718096',
    fontWeight: '500',
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
    marginTop: 16,
  },
  resultsList: {
    flex: 1,
  },
  resultsContent: {
    padding: 10,
  },
  row: {
    justifyContent: 'space-between',
    paddingHorizontal: 5,
  },
  bookCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
    width: '31%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bookCover: {
    width: '100%',
    height: 140,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    marginBottom: 8,
  },
  placeholderCover: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f7fafc',
  },
  bookInfo: {
    flex: 1,
  },
  bookTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
    minHeight: 32,
  },
  bookAuthor: {
    fontSize: 11,
    color: '#007AFF',
    marginBottom: 6,
  },
  bookBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0fff4',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
  },
  wishlistBadge: {
    backgroundColor: '#fff5f7',
  },
  badgeText: {
    fontSize: 9,
    color: '#48bb78',
    fontWeight: '600',
  },
  badgeTextSmall: {
    fontSize: 9,
  },
  userCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    marginHorizontal: 20,
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
  // Author Card Styles
  authorCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
    width: '31%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
  },
  authorAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e2e8f0',
    marginBottom: 8,
  },
  authorAvatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  authorAvatarText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
  },
  authorInfo: {
    alignItems: 'center',
    width: '100%',
  },
  authorNameText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 4,
  },
  authorBookCount: {
    fontSize: 10,
    color: '#718096',
    textAlign: 'center',
  },
  // Modal Styles
  modalSafeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa', // Subtle gray background
  },
  modalHeader: {
    backgroundColor: '#2d3748', // Slate header
    paddingTop: 20, // Lowered from 12
    paddingBottom: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalBackButton: {
    padding: 12, // Increased padding for better touch target
    marginTop: -5, // Lower the button slightly
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    flex: 1,
    textAlign: 'center',
  },
  modalHeaderSpacer: {
    width: 40,
  },
  modalContent: {
    flex: 1,
    padding: 20,
  },
  bookDetailHeader: {
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
  bookDetailCover: {
    width: 120,
    height: 180,
    borderRadius: 8,
    marginRight: 20,
    backgroundColor: '#e2e8f0',
  },
  bookDetailInfo: {
    flex: 1,
  },
  bookDetailTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 8,
  },
  authorsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  bookDetailAuthor: {
    fontSize: 18,
    color: '#007AFF',
    fontStyle: 'italic',
    fontWeight: '500',
  },
  bookDetailMeta: {
    fontSize: 14,
    color: '#718096',
    marginBottom: 4,
  },
  modalSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
  },
  descriptionText: {
    fontSize: 15,
    color: '#4a5568',
    lineHeight: 24,
  },
  modalActions: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    marginTop: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginBottom: 12,
    gap: 8,
  },
  libraryButton: {
    backgroundColor: '#059669', // Emerald (same as approve button)
  },
  wishlistButton: {
    backgroundColor: '#2563eb', // Deep blue (same as other action buttons)
  },
  actionButtonText: {
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '700',
  },
  statusMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  statusText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '600',
  },
  // Author Books Modal
  authorBooksList: {
    flex: 1,
  },
  authorBooksContent: {
    padding: 20,
  },
  authorBookCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  authorBookCover: {
    width: 60,
    height: 90,
    borderRadius: 6,
    marginRight: 16,
    backgroundColor: '#e2e8f0',
  },
  authorBookInfo: {
    flex: 1,
  },
  authorBookTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
  },
  authorBookYear: {
    fontSize: 13,
    color: '#718096',
    marginBottom: 4,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 4,
  },
  ratingText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a202c',
    marginRight: 4,
  },
  ratingCount: {
    fontSize: 12,
    color: '#718096',
  },
  // Author Header Styles
  authorHeader: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  authorPhoto: {
    width: 120,
    height: 120,
    borderRadius: 60,
    marginBottom: 16,
    backgroundColor: '#e2e8f0',
  },
  authorPhotoPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  authorPhotoText: {
    fontSize: 36,
    fontWeight: '700',
    color: '#ffffff',
  },
  authorName: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
    textAlign: 'center',
  },
  authorStats: {
    flexDirection: 'row',
    gap: 32,
    alignItems: 'center',
  },
  authorStatItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  authorStatNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
  },
  authorStatLabel: {
    fontSize: 14,
    color: '#718096',
    marginLeft: 4,
  },
  authorBioSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  authorBioText: {
    fontSize: 15,
    color: '#4a5568',
    lineHeight: 24,
  },
  authorBooksSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
});
