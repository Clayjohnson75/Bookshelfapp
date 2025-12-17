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
import { Book, Photo, Folder } from '../types/BookTypes';
import { useAuth } from '../auth/SimpleAuthContext';
import BookDetailModal from '../components/BookDetailModal';

const { width: screenWidth } = Dimensions.get('window');

interface LibraryViewProps {
  onClose?: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({ onClose }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showBookDetail, setShowBookDetail] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showFoldersModal, setShowFoldersModal] = useState(false);
  const [exportFormat, setExportFormat] = useState<'MLA' | 'APA' | 'Chicago'>('MLA');
  const [selectedBooksForExport, setSelectedBooksForExport] = useState<Set<string>>(new Set());
  const [selectedFolderForExport, setSelectedFolderForExport] = useState<string | null>(null);
  const [exportAll, setExportAll] = useState(true);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    if (user) {
      loadBooks();
    }
  }, [user]);

  const loadBooks = async () => {
    if (!user) return;
    try {
      const userApprovedKey = `approved_books_${user.uid}`;
      const storedApproved = await AsyncStorage.getItem(userApprovedKey);
      if (storedApproved) {
        const approvedBooks: Book[] = JSON.parse(storedApproved);
        setBooks(approvedBooks);
      }

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
    const q = searchQuery.trim().toLowerCase();
    if (!q) return books;

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
  }, [books, searchQuery]);

  const sortedBooks = useMemo(() => {
    const extractLastName = (author?: string): string => {
      if (!author) return 'zzz'; // Books without authors go to the end
      const firstAuthor = author.split(/,|&| and /i)[0].trim();
      const parts = firstAuthor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return 'zzz';
      return parts[parts.length - 1].replace(/,/, '').toLowerCase();
    };

    return [...filteredBooks].sort((a, b) => {
      const aLast = extractLastName(a.author);
      const bLast = extractLastName(b.author);
      const comparison = aLast.localeCompare(bLast);
      // If last names are the same, sort by title
      if (comparison === 0) {
        return (a.title || '').localeCompare(b.title || '');
      }
      return comparison;
    });
  }, [filteredBooks]);

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

  const handleCreateFolder = async () => {
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
      setFolders(updatedFolders);
      
      const foldersKey = `folders_${user.uid}`;
      await AsyncStorage.setItem(foldersKey, JSON.stringify(updatedFolders));
      
      setNewFolderName('');
      Alert.alert('Success', `Folder "${newFolder.name}" created!`);
    } catch (error) {
      console.error('Error creating folder:', error);
      Alert.alert('Error', 'Failed to create folder. Please try again.');
    }
  };

  const openBookDetail = (book: Book) => {
    setSelectedBook(book);
    const sourcePhoto = findBookPhoto(book);
    setSelectedPhoto(sourcePhoto);
    setShowBookDetail(true);
  };

  const fetchBookDetails = async (book: Book): Promise<{
    publisher?: string;
    publishedDate?: string;
    publisherLocation?: string;
  }> => {
    if (!book.googleBooksId) {
      return {};
    }

    try {
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes/${book.googleBooksId}`
      );
      if (!response.ok) return {};
      
      const data = await response.json();
      const volumeInfo = data.volumeInfo || {};
      
      return {
        publisher: volumeInfo.publisher,
        publishedDate: volumeInfo.publishedDate,
        publisherLocation: volumeInfo.publisherLocation || volumeInfo.publishedLocation,
      };
    } catch (error) {
      console.warn('Error fetching book details:', error);
      return {};
    }
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
        <Text style={styles.headerTitle}>My Library</Text>
        <View style={styles.headerRight} />
      </View>

      <View style={styles.exportButtonContainer} ref={(ref) => {
        if (ref) {
          ref.measure((x, y, width, height, pageX, pageY) => {
            // Store position for modal placement
          });
        }
      }}>
        <View style={styles.actionButtonsRow}>
          <TouchableOpacity
            style={[styles.foldersButton, styles.actionButton]}
            onPress={() => setShowFoldersModal(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="folder-outline" size={20} color="#ffffff" />
            <Text style={styles.exportButtonText}>Folders</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[styles.exportButton, styles.actionButton]}
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
                  <Text style={styles.selectionOptionText}>All Books ({sortedBooks.length})</Text>
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
                    setShowFoldersModal(true);
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

        {sortedBooks.length > 0 ? (
          <View style={styles.booksContainer}>
            {sortedBooks.map((item, index) => {
              if (index % 4 === 0) {
                return (
                  <View key={`row-${index}`} style={styles.bookGrid}>
                    {sortedBooks.slice(index, index + 4).map((book) => {
                      const isSelected = !exportAll && !selectedFolderForExport && selectedBooksForExport.has(book.id || `${book.title}_${book.author}`);
                      return (
                        <TouchableOpacity
                          key={book.id || book.title + book.author}
                          style={[
                            styles.bookCard,
                            isSelected && styles.bookCardSelected,
                          ]}
                          onPress={() => {
                            if (showExportModal && !exportAll && !selectedFolderForExport) {
                              // In export mode, toggle selection
                              const newSet = new Set(selectedBooksForExport);
                              const bookId = book.id || `${book.title}_${book.author}`;
                              if (isSelected) {
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
                          {isSelected && (
                            <View style={styles.bookSelectionCheckmark}>
                              <Ionicons name="checkmark-circle" size={28} color="#0056CC" />
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

      <BookDetailModal
        visible={showBookDetail}
        book={selectedBook}
        photo={selectedPhoto}
        onClose={() => {
          setShowBookDetail(false);
          setSelectedBook(null);
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
            const userApprovedKey = `approved_books_${user.uid}`;
            const updatedBooks = books.map(b => b.id === book.id ? book : b);
            setBooks(updatedBooks);
            await AsyncStorage.setItem(userApprovedKey, JSON.stringify(updatedBooks));
          } catch (error) {
            console.error('Error editing book:', error);
          }
        }}
        onAddBookToFolder={() => {}}
        folders={[]}
      />

      {/* Folders Modal */}
      {showFoldersModal && (
        <>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowFoldersModal(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Folders</Text>
              <TouchableOpacity
                onPress={() => setShowFoldersModal(false)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={24} color="#1a202c" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalBody}>
              {/* Create New Folder */}
              <View style={styles.createFolderSection}>
                <Text style={styles.sectionLabel}>Create New Folder</Text>
                <View style={styles.createFolderInputRow}>
                  <TextInput
                    style={styles.createFolderInput}
                    placeholder="Folder name"
                    placeholderTextColor="#a0aec0"
                    value={newFolderName}
                    onChangeText={setNewFolderName}
                  />
                  <TouchableOpacity
                    style={[
                      styles.createFolderButton,
                      !newFolderName.trim() && styles.createFolderButtonDisabled,
                    ]}
                    onPress={handleCreateFolder}
                    disabled={!newFolderName.trim()}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.createFolderButtonText}>Create</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Existing Folders */}
              {folders.length > 0 ? (
                <View style={styles.foldersListSection}>
                  <Text style={styles.sectionLabel}>Your Folders</Text>
                  {folders.map((folder) => {
                    const folderBooks = books.filter(book => 
                      book.id && folder.bookIds.includes(book.id)
                    );
                    return (
                      <TouchableOpacity
                        key={folder.id}
                        style={styles.folderListItem}
                        onPress={() => {
                          // Select this folder for export
                          setSelectedFolderForExport(folder.id);
                          setExportAll(false);
                          setSelectedBooksForExport(new Set());
                          setShowFoldersModal(false);
                        }}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="folder" size={28} color="#0056CC" style={{ marginRight: 12 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.folderListItemName}>{folder.name}</Text>
                          <Text style={styles.folderListItemCount}>
                            {folderBooks.length} {folderBooks.length === 1 ? 'book' : 'books'}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color="#718096" />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.emptyFoldersContainer}>
                  <Ionicons name="folder-outline" size={64} color="#cbd5e0" />
                  <Text style={styles.emptyFoldersText}>No folders yet</Text>
                  <Text style={styles.emptyFoldersSubtext}>Create a folder to organize your books</Text>
                </View>
              )}
            </ScrollView>
          </View>
        </>
      )}
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
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
    padding: 10,
    paddingTop: 6,
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
    top: 38,
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
    width: (screenWidth - 70) / 4,
    alignItems: 'center',
    marginBottom: 15,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
    overflow: 'hidden',
    position: 'relative',
  },
  bookCardSelected: {
    borderWidth: 3,
    borderColor: '#0056CC',
    backgroundColor: '#f0f8ff',
  },
  bookSelectionCheckmark: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 10,
    backgroundColor: '#ffffff',
    borderRadius: 14,
  },
  bookCover: {
    width: '100%',
    aspectRatio: 2 / 3,
    backgroundColor: '#e2e8f0',
  },
  placeholderCover: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f7fafc',
  },
  bookInfo: {
    padding: 10,
    width: '100%',
    alignItems: 'center',
  },
  bookTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a202c',
    textAlign: 'center',
    marginBottom: 2,
  },
  bookAuthor: {
    fontSize: 11,
    color: '#6b7280',
    textAlign: 'center',
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
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
  },
  exportButton: {
    backgroundColor: '#2d3748',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
  },
  foldersButton: {
    backgroundColor: '#0056CC',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
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
  selectFolderButton: {
    backgroundColor: '#f0f8ff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
    borderWidth: 2,
    borderColor: '#0056CC',
    marginBottom: 10,
  },
  selectFolderButtonText: {
    color: '#0056CC',
    fontSize: 16,
    fontWeight: '700',
  },
  exportBookGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  exportBookCard: {
    width: (Dimensions.get('window').width - 40 - 32 - 16 - 12) / 4, // 4 columns: screen - 40 (modal margins) - 32 (body padding) - 16 (grid padding) - 12 (3 gaps of 4px)
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
    height: ((Dimensions.get('window').width - 80) / 4 - 8) * 1.5, // Aspect ratio 1:1.5
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
});

