import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  Alert, 
  Dimensions,
  ScrollView,
  ActivityIndicator,
  Modal,
  Image,
  SafeAreaView
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../auth/SimpleAuthContext';
import { Book, Photo } from '../types/BookTypes';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface ScanQueueItem {
  id: string;
  uri: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export const ScansTab: React.FC = () => {
  const { user } = useAuth();
  
  // Camera states
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  
  // Processing states
  const [isProcessing, setIsProcessing] = useState(false);
  const [scanQueue, setScanQueue] = useState<ScanQueueItem[]>([]);
  const [currentScan, setCurrentScan] = useState<{id: string, uri: string, progress: {current: number, total: number}} | null>(null);
  
  // Data states  
  const [pendingBooks, setPendingBooks] = useState<Book[]>([]);
  const [approvedBooks, setApprovedBooks] = useState<Book[]>([]);
  const [rejectedBooks, setRejectedBooks] = useState<Book[]>([]);
  const [incompleteBooks, setIncompleteBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  
  // Modal states
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showScanModal, setShowScanModal] = useState(false);
  
  // Selection states
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (user) {
      loadUserData();
    }
  }, [user]);

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userIncompleteKey = `incomplete_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      const savedPending = await AsyncStorage.getItem(userPendingKey);
      const savedApproved = await AsyncStorage.getItem(userApprovedKey);
      const savedRejected = await AsyncStorage.getItem(userRejectedKey);
      const savedIncomplete = await AsyncStorage.getItem(userIncompleteKey);
      const savedPhotos = await AsyncStorage.getItem(userPhotosKey);
      
      if (savedPending) {
        setPendingBooks(JSON.parse(savedPending));
      }
      if (savedApproved) {
        setApprovedBooks(JSON.parse(savedApproved));
      }
      if (savedRejected) {
        setRejectedBooks(JSON.parse(savedRejected));
      }
      if (savedIncomplete) {
        setIncompleteBooks(JSON.parse(savedIncomplete));
      }
      if (savedPhotos) {
        setPhotos(JSON.parse(savedPhotos));
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const saveUserData = async (newPending: Book[], newApproved: Book[], newRejected: Book[], newIncomplete: Book[], newPhotos: Photo[]) => {
    if (!user) return;
    
    try {
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userIncompleteKey = `incomplete_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      await AsyncStorage.setItem(userPendingKey, JSON.stringify(newPending));
      await AsyncStorage.setItem(userApprovedKey, JSON.stringify(newApproved));
      await AsyncStorage.setItem(userRejectedKey, JSON.stringify(newRejected));
      await AsyncStorage.setItem(userIncompleteKey, JSON.stringify(newIncomplete));
      await AsyncStorage.setItem(userPhotosKey, JSON.stringify(newPhotos));
    } catch (error) {
      console.error('Error saving user data:', error);
    }
  };

  // Helper function to determine if a book is incomplete
  const isIncompleteBook = (book: any): boolean => {
    const title = book.title?.toLowerCase() || '';
    const author = book.author?.toLowerCase() || '';
    
    // Check for missing or invalid data
    if (!book.title || !book.author) return true;
    if (title.trim() === '' || author.trim() === '') return true;
    if (author === 'unknown' || author === 'n/a' || author === 'not found') return true;
    if (title === 'unknown' || title === 'n/a' || title === 'not found') return true;
    if (book.confidence === 'low') return true;
    
    // Check for common OCR errors or invalid text
    if (title.length < 2 || author.length < 2) return true;
    if (/^[^a-zA-Z0-9\s]+$/.test(title) || /^[^a-zA-Z0-9\s]+$/.test(author)) return true;
    
    return false;
  };

  // Copy the ChatGPT validation function from App.tsx
  const analyzeBookWithChatGPT = async (book: any): Promise<any> => {
    try {
      console.log(`🧠 Analyzing book with ChatGPT: "${book.title}" by "${book.author}"`);
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author}"
Confidence: ${book.confidence}

TASK: Analyze this book and determine if it's a real book. If it is, correct any OCR errors and return the proper title and author.

RULES:
1. If the title and author are swapped, fix them
2. Fix obvious OCR errors (e.g., "owmen" → "women")
3. Clean up titles (remove publisher prefixes, series numbers)
4. Validate that the author looks like a real person's name
5. If it's not a real book, mark it as invalid

RETURN FORMAT (JSON only):
{
  "isValid": true/false,
  "title": "Corrected Title",
  "author": "Corrected Author Name",
  "confidence": "high/medium/low",
  "reason": "Brief explanation of changes made"
}

EXAMPLES:
Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author"}

Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book"}

Input: Title="The Great Gatsby", Author="F. Scott Fitzgerald"
Output: {"isValid": true, "title": "The Great Gatsby", "author": "F. Scott Fitzgerald", "confidence": "high", "reason": "Already correct"}`
            }
          ],
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content?.trim();

      if (!content) {
        throw new Error('No content in response');
      }

      let analysis;
      try {
        analysis = JSON.parse(content);
      } catch (parseError) {
        console.log('Failed to parse ChatGPT response, trying to extract JSON...');
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No valid JSON found in response');
        }
      }

      if (analysis.isValid) {
        return {
          ...book,
          title: analysis.title,
          author: analysis.author,
          confidence: analysis.confidence,
        };
      } else {
        // Mark as invalid - this will be caught by our incomplete filter
        return {
          ...book,
          title: analysis.title,
          author: analysis.author,
          confidence: 'low', // This triggers our incomplete filter
          chatgptReason: analysis.reason
        };
      }
    } catch (error) {
      console.error(`❌ ChatGPT analysis failed for "${book.title}":`, error);
      return book; // Return original if analysis fails
    }
  };

  const convertImageToBase64 = async (uri: string): Promise<string> => {
    try {
      console.log('🔄 Converting image to base64...');
      
      const manipulatedImage = await ImageManipulator.manipulateAsync(
        uri,
        [],
        { 
          compress: 0.6, 
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true 
        }
      );
      
      if (manipulatedImage.base64) {
        console.log('✅ Image converted to base64');
        return `data:image/jpeg;base64,${manipulatedImage.base64}`;
      }
      
      throw new Error('Failed to get base64 from ImageManipulator');
    } catch (error) {
      console.error('❌ Image conversion failed:', error);
      throw error;
    }
  };

  const fetchCoversForBooks = async (books: Book[]) => {
    try {
      console.log('🎨 Fetching book covers in background...');
      
      for (const book of books) {
        try {
          const coverData = await fetchBookCover(book.title, book.author);
          
          if (coverData.coverUrl) {
            // Update the book in pending state
            setPendingBooks(prev => 
              prev.map(pendingBook => 
                pendingBook.id === book.id 
                  ? { ...pendingBook, coverUrl: coverData.coverUrl, googleBooksId: coverData.googleBooksId }
                  : pendingBook
              )
            );
            
            // Also update photos
            setPhotos(prev =>
              prev.map(photo => ({
                ...photo,
                books: photo.books.map(photoBook =>
                  photoBook.id === book.id
                    ? { ...photoBook, coverUrl: coverData.coverUrl, googleBooksId: coverData.googleBooksId }
                    : photoBook
                )
              }))
            );
          }
        } catch (error) {
          console.error(`Error fetching cover for ${book.title}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in fetchCoversForBooks:', error);
    }
  };

  const fetchBookCover = async (title: string, author?: string): Promise<{coverUrl?: string, googleBooksId?: string}> => {
    try {
      console.log(`📖 Fetching cover for: ${title} by ${author || 'Unknown'}`);
      
      // Clean up the title for better search results
      const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
      const query = author ? `${cleanTitle} ${author}` : cleanTitle;
      
      const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`);
      
      if (!response.ok) {
        console.warn('Google Books API request failed');
        return {};
      }
      
      const data = await response.json();
      
      if (data.items && data.items.length > 0) {
        const book = data.items[0];
        const volumeInfo = book.volumeInfo;
        
        if (volumeInfo.imageLinks) {
          // Prefer larger thumbnail, fallback to smaller one
          const coverUrl = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
          // Convert to HTTPS for better compatibility
          const httpsUrl = coverUrl?.replace('http:', 'https:');
          
          console.log(`✅ Found cover for: ${title}`);
          return {
            coverUrl: httpsUrl,
            googleBooksId: book.id
          };
        }
      }
      
      console.log(`❌ No cover found for: ${title}`);
      return {};
    } catch (error) {
      console.error('Error fetching book cover:', error);
      return {};
    }
  };

  const scanImageWithOpenAI = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log('🤖 OpenAI scanning image...');
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Scan this image and return ALL visible book spines as JSON.

Read each book spine from left to right. For each spine:
- Extract the title (larger text, usually at top)
- Extract the author (smaller text, usually at bottom, or "Unknown" if not visible)
- Assign confidence: "high" (both clear), "medium" (title clear), "low" (unclear)

RETURN ONLY JSON (no explanations):
[
  {"title": "Book Title", "author": "Author Name or Unknown", "confidence": "high/medium/low"},
  {"title": "Next Book", "author": "Next Author", "confidence": "high"}
]

Return the JSON array now. Do not include any text before or after the array.`
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataURL
                  }
                }
              ]
            }
          ],
          max_tokens: 4000,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
      }

      const data = await response.json();
      let content = data.choices[0].message.content;

      // Clean up markdown formatting if present
      if (content.includes('```json')) {
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }

      content = content.trim();
      
      if (!content.startsWith('[') && !content.startsWith('{')) {
        console.warn('⚠️ OpenAI returned non-JSON content, returning empty array');
        return [];
      }

      const parsedBooks = JSON.parse(content);
      console.log('✅ OpenAI scan completed:', parsedBooks);
      return Array.isArray(parsedBooks) ? parsedBooks : [];
      
    } catch (error) {
      console.error('❌ OpenAI scan failed:', error);
      return [];
    }
  };

  const scanImageWithGemini = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log('🧠 Gemini scanning image...');
      
      // Convert data URL to base64
      const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
      
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.EXPO_PUBLIC_GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Scan this image and return ALL visible book spines as JSON.

Read each book spine from left to right. For each spine:
- Extract the title (larger text, usually at top)
- Extract the author (smaller text, usually at bottom, or "Unknown" if not visible)
- Assign confidence: "high" (both clear), "medium" (title clear), "low" (unclear)

RETURN ONLY JSON (no explanations):
[
  {"title": "Book Title", "author": "Author Name or Unknown", "confidence": "high/medium/low"},
  {"title": "Next Book", "author": "Next Author", "confidence": "high"}
]

Return the JSON array now. Do not include any text before or after the array.`
                },
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: base64Data
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4000,
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} - ${await response.text()}`);
      }

      const data = await response.json();
      let content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Clean up markdown formatting if present
      if (content.includes('```json')) {
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }

      content = content.trim();
      
      if (!content.startsWith('[') && !content.startsWith('{')) {
        console.warn('⚠️ Gemini returned non-JSON content, returning empty array');
        return [];
      }

      const parsedBooks = JSON.parse(content);
      console.log('✅ Gemini scan completed:', parsedBooks);
      return Array.isArray(parsedBooks) ? parsedBooks : [];
      
    } catch (error) {
      console.error('❌ Gemini scan failed:', error);
      return [];
    }
  };

  const mergeBookResults = (openaiBooks: Book[], geminiBooks: Book[]): Book[] => {
    console.log(`🔀 Merging results: ${openaiBooks.length} from OpenAI + ${geminiBooks.length} from Gemini`);
    
    const merged = [...openaiBooks];
    
    // Add Gemini books that aren't already detected by OpenAI
    for (const geminiBook of geminiBooks) {
      const isDuplicate = merged.some(book => 
        book.title.toLowerCase().includes(geminiBook.title.toLowerCase()) ||
        geminiBook.title.toLowerCase().includes(book.title.toLowerCase())
      );
      
      if (!isDuplicate) {
        merged.push(geminiBook);
      }
    }
    
    console.log(`✅ Merged total: ${merged.length} unique books`);
    return merged;
  };

  const scanImageWithAI = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log('🤖🧠 Starting dual AI scan...');
      
      // Run both AI scans in parallel
      const [openaiResults, geminiResults] = await Promise.all([
        scanImageWithOpenAI(imageDataURL),
        scanImageWithGemini(imageDataURL)
      ]);
      
      // Merge the results
      const mergedResults = mergeBookResults(openaiResults, geminiResults);
      
      console.log('✅ Dual AI scan completed');
      return mergedResults;
      
    } catch (error) {
      console.error('❌ Dual AI scan failed:', error);
      return [];
    }
  };

  const processImage = async (uri: string, scanId: string) => {
    try {
      setCurrentScan({ id: scanId, uri, progress: { current: 1, total: 4 } });
      
      // Convert to base64
      const imageDataURL = await convertImageToBase64(uri);
      setCurrentScan({ id: scanId, uri, progress: { current: 2, total: 4 } });
      
      // Scan with AI
      const detectedBooks = await scanImageWithAI(imageDataURL);
      setCurrentScan({ id: scanId, uri, progress: { current: 3, total: 4 } });
      
      // Validate each book with ChatGPT
      console.log('🧠 Starting ChatGPT validation for all detected books...');
      const analyzedBooks = [];
      for (const book of detectedBooks) {
        try {
          const analyzedBook = await analyzeBookWithChatGPT(book);
          analyzedBooks.push(analyzedBook);
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.log(`Error analyzing book "${book.title}":`, error);
          analyzedBooks.push(book); // Keep original if analysis fails
        }
      }
      
      console.log(`✅ ChatGPT validation complete: ${analyzedBooks.length} books analyzed`);
      setCurrentScan({ id: scanId, uri, progress: { current: 4, total: 4 } });
      
      // Convert analyzed books to proper structure and separate complete vs incomplete
      const allBooks: Book[] = analyzedBooks.map((book, index) => ({
        id: `${scanId}_${index}`,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        confidence: book.confidence,
        status: 'pending' as const,
        scannedAt: Date.now(),
      }));
      
      // Separate complete and incomplete books
      const newPendingBooks = allBooks.filter(book => !isIncompleteBook(book));
      const newIncompleteBooks: Book[] = allBooks.filter(book => isIncompleteBook(book)).map(book => ({
        ...book,
        status: 'incomplete' as const
      }));
      
      console.log(`✅ Created ${newPendingBooks.length} pending books and ${newIncompleteBooks.length} incomplete books`);
      
      // Save results
      const newPhoto: Photo = {
        id: scanId,
        uri,
        books: allBooks, // Store all books in photo for scan modal
        timestamp: Date.now(),
      };
      
      const updatedPhotos = [...photos, newPhoto];
      const updatedPending = [...pendingBooks, ...newPendingBooks];
      const updatedIncomplete = [...incompleteBooks, ...newIncompleteBooks];
      
      setPhotos(updatedPhotos);
      setPendingBooks(updatedPending);
      setIncompleteBooks(updatedIncomplete);
      console.log('📋 Setting pending books:', updatedPending);
      console.log('📋 Setting incomplete books:', updatedIncomplete);
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedIncomplete, updatedPhotos);
      
      // Fetch covers for books in background (don't wait for this)
      fetchCoversForBooks(newPendingBooks);
      
      // Update queue status
      setScanQueue(prev => 
        prev.map(item => 
          item.id === scanId ? { ...item, status: 'completed' } : item
        )
      );
      
      console.log(`✅ Scan completed: ${detectedBooks.length} books found → ${analyzedBooks.length} after ChatGPT → (${newPendingBooks.length} complete, ${newIncompleteBooks.length} incomplete)`);
      
    } catch (error) {
      console.error('❌ Processing failed:', error);
      setScanQueue(prev => 
        prev.map(item => 
          item.id === scanId ? { ...item, status: 'failed' } : item
        )
      );
    } finally {
      setCurrentScan(null);
      setIsProcessing(false);
    }
  };

  const approveBook = async (bookId: string) => {
    const bookToApprove = pendingBooks.find(book => book.id === bookId);
    if (!bookToApprove) return;

    const approvedBook: Book = {
      ...bookToApprove,
      status: 'approved' as const
    };

    const updatedPending = pendingBooks.filter(book => book.id !== bookId);
    const updatedApproved = [...approvedBooks, approvedBook];

    setPendingBooks(updatedPending);
    setApprovedBooks(updatedApproved);
    await saveUserData(updatedPending, updatedApproved, rejectedBooks, incompleteBooks, photos);
  };

  const rejectBook = async (bookId: string) => {
    const bookToReject = pendingBooks.find(book => book.id === bookId);
    if (!bookToReject) return;

    const rejectedBook: Book = {
      ...bookToReject,
      status: 'rejected' as const
    };

    const updatedPending = pendingBooks.filter(book => book.id !== bookId);
    const updatedRejected = [...rejectedBooks, rejectedBook];

    setPendingBooks(updatedPending);
    setRejectedBooks(updatedRejected);
    await saveUserData(updatedPending, approvedBooks, updatedRejected, incompleteBooks, photos);
  };

  const openScanModal = (photo: Photo) => {
    setSelectedPhoto(photo);
    setShowScanModal(true);
  };

  const closeScanModal = () => {
    setSelectedPhoto(null);
    setShowScanModal(false);
  };

  const toggleBookSelection = (bookId: string) => {
    const newSelected = new Set(selectedBooks);
    if (newSelected.has(bookId)) {
      newSelected.delete(bookId);
    } else {
      newSelected.add(bookId);
    }
    setSelectedBooks(newSelected);
  };

  const clearAllBooks = async () => {
    setPendingBooks([]);
    setSelectedBooks(new Set());
    await saveUserData([], approvedBooks, rejectedBooks, incompleteBooks, photos);
  };

  const clearSelectedBooks = async () => {
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    setPendingBooks(remainingBooks);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, approvedBooks, rejectedBooks, incompleteBooks, photos);
  };

  const approveSelectedBooks = async () => {
    const selectedBookObjs = pendingBooks.filter(book => selectedBooks.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    
    const newApprovedBooks = selectedBookObjs.map(book => ({ ...book, status: 'approved' as const }));
    const updatedApproved = [...approvedBooks, ...newApprovedBooks];
    
    setPendingBooks(remainingBooks);
    setApprovedBooks(updatedApproved);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, updatedApproved, rejectedBooks, incompleteBooks, photos);
  };

  const rejectSelectedBooks = async () => {
    const selectedBookObjs = pendingBooks.filter(book => selectedBooks.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    
    const newRejectedBooks = selectedBookObjs.map(book => ({ ...book, status: 'rejected' as const }));
    const updatedRejected = [...rejectedBooks, ...newRejectedBooks];
    
    setPendingBooks(remainingBooks);
    setRejectedBooks(updatedRejected);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, approvedBooks, updatedRejected, incompleteBooks, photos);
  };

  const addImageToQueue = (uri: string) => {
    const scanId = Date.now().toString();
    const newScanItem: ScanQueueItem = {
      id: scanId,
      uri,
      status: 'pending'
    };
    
    setScanQueue(prev => [...prev, newScanItem]);
    
    if (!isProcessing) {
      setIsProcessing(true);
      setTimeout(() => {
        setScanQueue(prev => 
          prev.map(item => 
            item.id === scanId ? { ...item, status: 'processing' } : item
          )
        );
        processImage(uri, scanId);
      }, 1000);
    }
  };

  const takePicture = async () => {
    if (cameraRef) {
      try {
        const photo = await cameraRef.takePictureAsync({
          quality: 0.8,
          base64: false,
        });
        
        if (photo?.uri) {
          console.log('Photo taken:', photo.uri);
          addImageToQueue(photo.uri);
          setIsCameraActive(false);
        }
      } catch (error) {
        console.error('Error taking picture:', error);
        Alert.alert('Camera Error', 'Failed to take picture. Please try again.');
      }
    }
  };

  const pickImage = async () => {
    try {
      console.log('📁 Starting image picker...');
      
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      
      if (permissionResult.granted === false) {
        Alert.alert('Permission Required', 'Please grant photo library access to upload images.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsEditing: false,
        quality: 1.0, // No compression = faster
        presentationStyle: 'pageSheet', // Faster presentation on iOS
        selectionLimit: 1,
      });

      if (!result.canceled && result.assets[0]) {
        console.log('📁 Selected image URI:', result.assets[0].uri);
        addImageToQueue(result.assets[0].uri);
      }
    } catch (error) {
      console.error('❌ Error picking image:', error);
      Alert.alert('Error', 'Failed to pick image. Please try again.');
    }
  };

  const handleStartCamera = async () => {
    if (!permission?.granted) {
      const response = await requestPermission();
      if (!response.granted) {
        Alert.alert('Permission Required', 'Camera access is required to scan books.');
        return;
      }
    }
    setIsCameraActive(true);
  };

  if (isCameraActive) {
    return (
      <SafeAreaView style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          ref={(ref) => setCameraRef(ref)}
        >
          <View style={styles.cameraOverlay}>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setIsCameraActive(false)}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
            
            <View style={styles.cameraControls}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={takePicture}
              >
                <Text style={styles.captureButtonText}>📸</Text>
              </TouchableOpacity>
            </View>
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeContainer}>
      <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>📚 Book Scanner</Text>
        <Text style={styles.subtitle}>Scan your bookshelf to build your library</Text>
      </View>

      {/* Scan Options */}
      <View style={styles.scanOptions}>
        <TouchableOpacity style={styles.scanButton} onPress={handleStartCamera}>
          <Text style={styles.scanButtonText}>📸 Take Photo</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.scanButton} onPress={pickImage}>
          <Text style={styles.scanButtonText}>🖼️ Upload Image</Text>
        </TouchableOpacity>
      </View>



      {/* Pending Books - Need Approval */}
      {pendingBooks.length > 0 && (
        <View style={styles.pendingSection}>
          <View style={styles.pendingHeader}>
            <View style={styles.pendingTitleContainer}>
              <Text style={styles.sectionTitle}>📋 Pending Books ({pendingBooks.length})</Text>
              <Text style={styles.sectionSubtitle}>Tap books to select • Use buttons to approve/reject</Text>
            </View>
            
            <View style={styles.headerButtons}>
              <TouchableOpacity 
                style={styles.clearButton}
                onPress={clearAllBooks}
              >
                <Text style={styles.clearButtonText}>🗑️ Clear All</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Bulk Action Buttons */}
          {selectedBooks.size > 0 && (
            <View style={styles.bulkActions}>
              <Text style={styles.selectedCount}>{selectedBooks.size} selected</Text>
              <View style={styles.bulkButtonsRow}>
                <TouchableOpacity 
                  style={styles.bulkApproveButton}
                  onPress={approveSelectedBooks}
                >
                  <Text style={styles.bulkButtonText}>✓ Approve Selected</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.bulkRejectButton}
                  onPress={rejectSelectedBooks}
                >
                  <Text style={styles.bulkButtonText}>✕ Reject Selected</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.bulkClearButton}
                  onPress={clearSelectedBooks}
                >
                  <Text style={styles.bulkButtonText}>🗑️ Clear Selected</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          <View style={styles.booksGrid}>
            {pendingBooks.map((book) => (
              <TouchableOpacity 
                key={book.id} 
                style={[
                  styles.pendingBookCard,
                  selectedBooks.has(book.id) && styles.selectedBookCard
                ]}
                onPress={() => toggleBookSelection(book.id)}
                activeOpacity={0.7}
              >
              <View style={styles.bookHeader}>
                {/* Selection Indicator */}
                <View style={styles.selectionIndicator}>
                  {selectedBooks.has(book.id) ? (
                    <View style={styles.selectedCheckbox}>
                      <Text style={styles.checkmark}>✓</Text>
                    </View>
                  ) : (
                    <View style={styles.unselectedCheckbox} />
                  )}
                </View>
              </View>

              {/* Top Half: Cover on left, Text on right */}
              <View style={styles.bookTopSection}>
                {book.coverUrl && (
                  <Image 
                    source={{ uri: book.coverUrl }} 
                    style={styles.bookCover}
                  />
                )}
                <View style={styles.bookInfo}>
                  <Text style={styles.bookTitle}>{book.title}</Text>
                  {book.author && <Text style={styles.bookAuthor}>by {book.author}</Text>}
                </View>
              </View>
              
              {/* Bottom Half: Buttons */}
              <View style={styles.bookActions}>
                <TouchableOpacity 
                  style={styles.approveButton}
                  onPress={(e) => {
                    e.stopPropagation();
                    approveBook(book.id);
                  }}
                >
                  <Text style={styles.approveButtonText}>✓ Add</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.rejectButton}
                  onPress={(e) => {
                    e.stopPropagation();
                    rejectBook(book.id);
                  }}
                >
                  <Text style={styles.rejectButtonText}>✕ Skip</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
          </View>
        </View>
      )}

      {/* Recent Scans */}
      {photos.length > 0 && (
        <View style={styles.recentSection}>
          <Text style={styles.sectionTitle}>📸 Recent Scans</Text>
          {photos.slice(-3).reverse().map((photo) => (
      <TouchableOpacity 
              key={photo.id} 
              style={styles.photoCard}
              onPress={() => openScanModal(photo)}
            >
              <Image source={{ uri: photo.uri }} style={styles.photoThumbnail} />
              <View style={styles.photoInfo}>
                <Text style={styles.photoDate}>
                  {new Date(photo.timestamp).toLocaleDateString()}
                </Text>
                <Text style={styles.photoBooks}>
                  {photo.books.length} books found
                </Text>
                <Text style={styles.tapToView}>Tap to view details</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}


      {/* Rejected Books - At Bottom */}
      {rejectedBooks.length > 0 && (
        <View style={styles.rejectedSection}>
          <Text style={styles.sectionTitle}>🗑️ Rejected Books ({rejectedBooks.length})</Text>
          <Text style={styles.sectionSubtitle}>Books you chose not to add to your library</Text>
          {rejectedBooks.map((book) => (
            <View key={book.id} style={styles.rejectedBookCard}>
              {book.coverUrl && (
                <Image 
                  source={{ uri: book.coverUrl }} 
                  style={styles.bookCover}
                />
              )}
              <View style={styles.bookInfo}>
                <Text style={styles.bookTitle}>{book.title}</Text>
                {book.author && <Text style={styles.bookAuthor}>by {book.author}</Text>}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Scan Details Modal */}
      <Modal
        visible={showScanModal}
        animationType="none"
        presentationStyle="fullScreen"
        onRequestClose={closeScanModal}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Scan Details</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={closeScanModal}
            >
              <Text style={styles.modalCloseText}>Done</Text>
      </TouchableOpacity>
    </View>
          
          {selectedPhoto && (
            <ScrollView style={styles.modalContent}>
              <Image source={{ uri: selectedPhoto.uri }} style={styles.modalImage} />
              
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>
                  📚 Books Found ({selectedPhoto.books.length})
                </Text>
                <Text style={styles.modalSectionSubtitle}>
                  Scanned on {new Date(selectedPhoto.timestamp).toLocaleDateString()}
                </Text>
              </View>

              {selectedPhoto.books.map((book, index) => (
                <View key={`${book.id || index}`} style={styles.modalBookCard}>
                  {book.coverUrl && (
                    <Image 
                      source={{ uri: book.coverUrl }} 
                      style={styles.modalBookCover}
                    />
                  )}
                  <View style={styles.bookInfo}>
                    <Text style={styles.bookTitle}>{book.title}</Text>
                    {book.author && <Text style={styles.bookAuthor}>by {book.author}</Text>}
                  </View>
                  <View style={styles.bookStatusBadge}>
                    <Text style={[
                      styles.bookStatusText,
                      book.status === 'approved' && styles.approvedStatus,
                      book.status === 'rejected' && styles.rejectedStatus,
                      book.status === 'pending' && styles.pendingStatus
                    ]}>
                      {book.status === 'approved' ? '✓ Added' : 
                       book.status === 'rejected' ? '✕ Rejected' : 
                       '⏳ Pending'}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Incomplete Books */}
      {incompleteBooks.length > 0 && (
        <View style={styles.incompleteSection}>
          <Text style={styles.sectionTitle}>⚠️ Incomplete ({incompleteBooks.length})</Text>
          <Text style={styles.sectionSubtitle}>Books with missing or unclear information</Text>
          <View style={styles.booksGrid}>
            {incompleteBooks.map((book) => (
              <View key={book.id} style={styles.incompleteBookCard}>
                <View style={styles.bookTopSection}>
                  {book.coverUrl ? (
                    <Image source={{ uri: book.coverUrl }} style={styles.bookCover} />
                  ) : (
                    <View style={[styles.bookCover, styles.noCover]}>
                      <Text style={styles.noCoverText}>📖</Text>
                    </View>
                  )}
                  <View style={styles.bookInfo}>
                    <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                    <Text style={styles.bookAuthor} numberOfLines={1}>{book.author}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}
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
  header: {
    padding: 20,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#2c3e50',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 5,
  },
  scanOptions: {
    flexDirection: 'row',
    padding: 20,
    gap: 15,
  },
  scanButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
  },
  scanButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  cameraContainer: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 25,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
  },
  cameraControls: {
    alignItems: 'center',
    paddingBottom: 50,
  },
  captureButton: {
    backgroundColor: 'white',
    borderRadius: 35,
    width: 70,
    height: 70,
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureButtonText: {
    fontSize: 30,
  },
  queueSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  pendingSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  recentSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 15,
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
    marginBottom: 10,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 15,
  },
  booksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  pendingBookCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    padding: 12,
    marginBottom: 15,
    flexDirection: 'column',
    borderWidth: 2,
    borderColor: '#FFA500',
    width: '48%',
  },
  bookHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 10,
  },
  bookTopSection: {
    flexDirection: 'column',
    alignItems: 'center',
    marginBottom: 12,
  },
  bookCover: {
    width: '100%',
    height: 180,
    borderRadius: 8,
    marginBottom: 10,
    backgroundColor: '#e0e0e0',
  },
  bookInfo: {
    width: '100%',
    alignItems: 'center',
  },
  bookTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 4,
    textAlign: 'center',
  },
  bookAuthor: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 8,
    textAlign: 'center',
  },
  bookActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButton: {
    backgroundColor: '#28a745',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  approveButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  rejectButton: {
    backgroundColor: '#dc3545',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  rejectButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  photoCard: {
    flexDirection: 'row',
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    alignItems: 'center',
  },
  photoThumbnail: {
    width: 60,
    height: 60,
    borderRadius: 8,
    marginRight: 15,
  },
  photoInfo: {
    flex: 1,
  },
  photoDate: {
    fontSize: 14,
    color: '#2c3e50',
    fontWeight: '500',
  },
  photoBooks: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  tapToView: {
    fontSize: 10,
    color: '#007AFF',
    marginTop: 4,
    fontStyle: 'italic',
  },
  rejectedSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  rejectedBookCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#dc3545',
    opacity: 0.7,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: 'white',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2c3e50',
  },
  modalCloseButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 6,
  },
  modalCloseText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  modalContent: {
    flex: 1,
    padding: 15,
  },
  modalImage: {
    width: '100%',
    height: 120,
    borderRadius: 12,
    marginBottom: 15,
  },
  modalSection: {
    marginBottom: 15,
  },
  modalSectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2c3e50',
    marginBottom: 5,
  },
  modalSectionSubtitle: {
    fontSize: 14,
    color: '#666',
  },
  modalBookCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  modalBookCover: {
    width: 40,
    height: 60,
    borderRadius: 4,
    marginRight: 15,
    backgroundColor: '#e0e0e0',
  },
  bookStatusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#f0f0f0',
  },
  bookStatusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  approvedStatus: {
    color: '#28a745',
    backgroundColor: '#d4edda',
  },
  rejectedStatus: {
    color: '#dc3545',
    backgroundColor: '#f8d7da',
  },
  incompleteSection: {
    backgroundColor: 'white',
    margin: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  incompleteBookCard: {
    backgroundColor: '#fff3cd',
    borderRadius: 12,
    padding: 12,
    marginBottom: 15,
    flexDirection: 'column',
    borderWidth: 2,
    borderColor: '#ffc107',
    width: '48%',
  },
  noCover: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  noCoverText: {
    fontSize: 24,
    color: '#666',
  },
  pendingStatus: {
    color: '#ffc107',
    backgroundColor: '#fff3cd',
  },
  queueItem: {
    backgroundColor: '#f8f9fa',
    padding: 10,
    marginBottom: 5,
    borderRadius: 5,
  },
  pendingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 15,
  },
  pendingTitleContainer: {
    flex: 1,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  clearButton: {
    backgroundColor: '#6c757d',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  clearButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  bulkActions: {
    backgroundColor: '#e3f2fd',
    padding: 15,
    borderRadius: 8,
    marginBottom: 15,
    borderWidth: 2,
    borderColor: '#2196f3',
  },
  selectedCount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1976d2',
    marginBottom: 10,
  },
  bulkButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  bulkApproveButton: {
    flex: 1,
    backgroundColor: '#28a745',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  bulkRejectButton: {
    flex: 1,
    backgroundColor: '#dc3545',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  bulkClearButton: {
    flex: 1,
    backgroundColor: '#6c757d',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  bulkButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  selectedBookCard: {
    backgroundColor: '#e8f5e9',
    borderColor: '#4caf50',
    borderWidth: 2,
  },
  selectionIndicator: {
    alignSelf: 'flex-end',
  },
  selectedCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#4caf50',
    justifyContent: 'center',
    alignItems: 'center',
  },
  unselectedCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#ccc',
    backgroundColor: 'white',
  },
  checkmark: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
});


