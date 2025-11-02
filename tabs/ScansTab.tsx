import React, { useState, useEffect, useMemo } from 'react';
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
  TextInput,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Keyboard
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/SimpleAuthContext';
import { useScanning } from '../contexts/ScanningContext';
import { Book, Photo, Folder } from '../types/BookTypes';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// Utility: wait for ms
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: retry a scan function that returns Book[]
async function withRetries(fn: () => Promise<Book[]>, tries = 2, backoffMs = 1200): Promise<Book[]> {
  let last: Book[] = [];
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fn();
      if (Array.isArray(res) && res.length > 0) return res;
      last = res;
    } catch (e) {
      // ignore and backoff
    }
    if (attempt < tries - 1) await delay(backoffMs * (attempt + 1));
  }
  return last;
}

interface ScanQueueItem {
  id: string;
  uri: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export const ScansTab: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { scanProgress, setScanProgress, updateProgress } = useScanning();
  
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
  const [photos, setPhotos] = useState<Photo[]>([]);
  
  // Modal states
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showScanModal, setShowScanModal] = useState(false);
  
  // Edit incomplete book states
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');

  // Smart search for editing incomplete books: auto-search as user types title/author
  // Show caption modal when image is ready (either from camera or picker)
  // Start scanning immediately when image is ready, show caption modal after
  const handleImageSelected = (uri: string) => {
    console.log('🖼️ Image selected, starting scan and showing caption modal', uri);
    
    // Generate scanId before adding to queue so we can track it
    const scanId = Date.now().toString();
    currentScanIdRef.current = scanId;
    scanCaptionsRef.current.set(scanId, ''); // Initialize with empty caption
    
    // Set the URI first so the modal can display it
    setPendingImageUri(uri);
    
    // Start scanning IMMEDIATELY - this will trigger the notification
    addImageToQueue(uri, undefined, scanId);
    
    // Show caption modal after a brief delay to ensure scanning has started
    setTimeout(() => {
      console.log('📝 Showing caption modal');
      setShowCaptionModal(true);
    }, 100);
  };

  useEffect(() => {
    const titleQ = manualTitle.trim();
    const authorQ = manualAuthor.trim();
    const q = [titleQ, authorQ].filter(Boolean).join(' ');
    if (!showEditModal) return; // Only when modal open
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        setIsSearching(true);
        const response = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10`
        );
        const data = await response.json();
        setSearchResults(data.items || []);
      } catch (err) {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [manualTitle, manualAuthor, showEditModal]);
  
  // Selection states
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());

  // Caption modal state
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  const [captionText, setCaptionText] = useState<string>('');
  const [showCaptionModal, setShowCaptionModal] = useState(false);
  // Store the scanId for the current pending image so we can update its caption later
  const currentScanIdRef = React.useRef<string | null>(null);
  // Store caption for each scan (keyed by scanId)
  const scanCaptionsRef = React.useRef<Map<string, string>>(new Map());
  
  // Folder management state
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Orientation state for camera tip
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  
  // Scroll tracking for sticky toolbar
  const scrollY = React.useRef(new Animated.Value(0)).current;

  // Sort pending books by author's last name (moved outside conditional render to fix hooks error)
  const sortedPendingBooks = useMemo(() => {
    const extractLastName = (author?: string): string => {
      if (!author) return '';
      const firstAuthor = author.split(/,|&| and /i)[0].trim();
      const parts = firstAuthor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '';
      return parts[parts.length - 1].replace(/,/, '').toLowerCase();
    };
    
    return [...pendingBooks].sort((a, b) => {
      const aLast = extractLastName(a.author);
      const bLast = extractLastName(b.author);
      if (aLast && bLast) {
        if (aLast < bLast) return -1;
        if (aLast > bLast) return 1;
      } else if (aLast || bLast) {
        return aLast ? -1 : 1;
      }
      const aTitle = (a.title || '').toLowerCase();
      const bTitle = (b.title || '').toLowerCase();
      if (aTitle < bTitle) return -1;
      if (aTitle > bTitle) return 1;
      return 0;
    });
  }, [pendingBooks]);

  // Detect orientation changes when camera is active
  useEffect(() => {
    if (!isCameraActive) return;

    const updateOrientation = () => {
      const { width, height } = Dimensions.get('window');
      const isLandscape = width > height;
      setOrientation(isLandscape ? 'landscape' : 'portrait');
    };

    // Set initial orientation
    updateOrientation();

    // Listen for dimension changes
    const subscription = Dimensions.addEventListener('change', updateOrientation);

    return () => {
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
    };
  }, [isCameraActive]);

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
      const userFoldersKey = `folders_${user.uid}`;
      
      const savedPending = await AsyncStorage.getItem(userPendingKey);
      const savedApproved = await AsyncStorage.getItem(userApprovedKey);
      const savedRejected = await AsyncStorage.getItem(userRejectedKey);
      const savedPhotos = await AsyncStorage.getItem(userPhotosKey);
      const savedFolders = await AsyncStorage.getItem(userFoldersKey);
      
      if (savedPending) {
        setPendingBooks(JSON.parse(savedPending));
      }
      if (savedApproved) {
        setApprovedBooks(JSON.parse(savedApproved));
      }
      if (savedRejected) {
        setRejectedBooks(JSON.parse(savedRejected));
      }
      if (savedPhotos) {
        setPhotos(JSON.parse(savedPhotos));
      }
      if (savedFolders) {
        setFolders(JSON.parse(savedFolders));
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const saveUserData = async (newPending: Book[], newApproved: Book[], newRejected: Book[], newPhotos: Photo[]) => {
    if (!user) return;
    
    try {
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      await AsyncStorage.setItem(userPendingKey, JSON.stringify(newPending));
      await AsyncStorage.setItem(userApprovedKey, JSON.stringify(newApproved));
      await AsyncStorage.setItem(userRejectedKey, JSON.stringify(newRejected));
      await AsyncStorage.setItem(userPhotosKey, JSON.stringify(newPhotos));
    } catch (error) {
      console.error('Error saving user data:', error);
    }
  };

  // Helper function to determine if a book is incomplete
  const isIncompleteBook = (book: any): boolean => {
    const title = (book.title || '').trim();
    const author = (book.author || '').trim();
    const titleLower = title.toLowerCase();
    const authorLower = author.toLowerCase();
    
    // Check for missing or invalid data
    if (!title || !author) return true;
    if (title === '' || author === '') return true;
    
    // Check for Unknown author (case-insensitive) - main case for ChatGPT failures
    if (authorLower === 'unknown' || authorLower === 'n/a' || authorLower === 'not found' || authorLower === '') return true;
    if (titleLower === 'unknown' || titleLower === 'n/a' || titleLower === 'not found') return true;
    
    // Check if ChatGPT marked it as invalid with Unknown author
    if (book.confidence === 'low' && (authorLower === 'unknown' || !author || author.trim() === '')) return true;
    if (book.chatgptReason && (book.chatgptReason.toLowerCase().includes('not a real book') || book.chatgptReason.toLowerCase().includes('unknown'))) return true;
    
    // Check for common OCR errors or invalid text
    if (title.length < 2 || author.length < 2) return true;
    if (/^[^a-zA-Z0-9\s]+$/.test(title) || /^[^a-zA-Z0-9\s]+$/.test(author)) return true;
    
    return false;
  };

  // Copy the ChatGPT validation function from App.tsx
  const analyzeBookWithChatGPT = async (book: any): Promise<any> => {
    try {
      // Analyzing book with ChatGPT
      
      // Hard timeout so OpenAI cannot hang the scan
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        signal: controller.signal,
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

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES:
Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author"}

Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book"}

Input: Title="The Great Gatsby", Author="F. Scott Fitzgerald"
Output: {"isValid": true, "title": "The Great Gatsby", "author": "F. Scott Fitzgerald", "confidence": "high", "reason": "Already correct"}

Remember: Respond with ONLY the JSON object, nothing else.`
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
        // Try direct parse first
        analysis = JSON.parse(content);
      } catch (parseError) {
        console.log(` Failed to parse ChatGPT response for "${book.title}". Response:`, content.substring(0, 200));
        
        // Try to extract JSON from markdown code blocks
        const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
          analysis = JSON.parse(codeBlockMatch[1]);
          console.log(' Extracted JSON from code block');
        } else {
          // Try to find JSON object in response
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            analysis = JSON.parse(jsonMatch[0]);
            console.log(' Extracted JSON from response');
          } else {
            console.error(` No valid JSON found in response for "${book.title}"`);
            // Fallback: return original book with low confidence
            return {
              ...book,
              confidence: 'low',
              chatgptError: 'Failed to parse response'
            };
          }
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
      // Silently handle validation errors - book will be marked incomplete if needed
      console.log(`Issue with "${book.title}"`);
      return book; // Return original if analysis fails
    }
  };

  const convertImageToBase64 = async (uri: string): Promise<string> => {
    try {
      // Converting image to base64
      
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
        return `data:image/jpeg;base64,${manipulatedImage.base64}`;
      }
      
      throw new Error('Failed to get base64 from ImageManipulator');
    } catch (error) {
      console.error(' Image conversion failed:', error);
      throw error;
    }
  };

  // Downscale and convert to base64 for fallback attempts
  const convertImageToBase64Resized = async (uri: string, maxWidth: number, quality: number): Promise<string> => {
    try {
      // Converting resized image to base64
      const manipulatedImage = await ImageManipulator.manipulateAsync(
        uri,
        [
          { resize: { width: maxWidth } },
        ],
        {
          compress: quality,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );
      if (manipulatedImage.base64) {
        return `data:image/jpeg;base64,${manipulatedImage.base64}`;
      }
      throw new Error('Failed to get base64 from resized ImageManipulator');
    } catch (error) {
      console.error(' Resized image conversion failed:', error);
      throw error;
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

  // Download and cache cover image to local storage
  const downloadAndCacheCover = async (coverUrl: string, googleBooksId: string): Promise<string | null> => {
    try {
      if (!FileSystem.documentDirectory) {
        console.warn('FileSystem document directory not available');
        return null;
      }
      
      // Create covers directory if it doesn't exist
      const coversDirPath = `${FileSystem.documentDirectory}covers/`;
      const dirInfo = await FileSystem.getInfoAsync(coversDirPath);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(coversDirPath, { intermediates: true });
      }

      // Generate filename from googleBooksId or hash the URL
      const filename = googleBooksId ? `${googleBooksId}.jpg` : `${coverUrl.split('/').pop() || Date.now()}.jpg`;
      const localPath = `covers/${filename}`;
      const fullPath = `${FileSystem.documentDirectory}${localPath}`;

      // Check if already cached
      const existingFile = await FileSystem.getInfoAsync(fullPath);
      if (existingFile.exists) {
        return localPath;
      }

      // Download the image
      const downloadResult = await FileSystem.downloadAsync(coverUrl, fullPath);

      if (downloadResult.uri) {
        return localPath;
      }

      return null;
    } catch (error) {
      console.error('Error caching cover:', error);
      return null;
    }
  };

  const fetchCoversForBooks = async (books: Book[]) => {
    try {
      
      for (const book of books) {
        try {
          // Skip if already has local cache
          if (book.localCoverPath && FileSystem.documentDirectory) {
            try {
              const fullPath = `${FileSystem.documentDirectory}${book.localCoverPath}`;
              const fileInfo = await FileSystem.getInfoAsync(fullPath);
              if (fileInfo.exists) {
                continue; // Already cached, skip
              }
            } catch (error) {
              // File doesn't exist, continue to fetch
            }
          }

          const coverData = await fetchBookCover(book.title, book.author);
          
          if (coverData.coverUrl && coverData.googleBooksId) {
            // Download and cache the cover
            const localPath = await downloadAndCacheCover(coverData.coverUrl, coverData.googleBooksId);
            
            const updatedBook = {
              coverUrl: coverData.coverUrl,
              googleBooksId: coverData.googleBooksId,
              ...(localPath && { localCoverPath: localPath })
            };

            // Update the book in pending state
            setPendingBooks(prev => 
              prev.map(pendingBook => 
                pendingBook.id === book.id 
                  ? { ...pendingBook, ...updatedBook }
                  : pendingBook
              )
            );
            
            // Also update photos
            setPhotos(prev =>
              prev.map(photo => ({
                ...photo,
                books: photo.books.map(photoBook =>
                  photoBook.id === book.id
                    ? { ...photoBook, ...updatedBook }
                    : photoBook
                )
              }))
            );

            // Update approved books if applicable
            setApprovedBooks(prev =>
              prev.map(approvedBook =>
                approvedBook.id === book.id
                  ? { ...approvedBook, ...updatedBook }
                  : approvedBook
              )
            );
          }
        } catch (error) {
          console.error(`Error fetching cover for ${book.title}:`, error);
        }
      }

      // Save updated data with cached paths
      await saveUserData(pendingBooks, approvedBooks, rejectedBooks, photos);
    } catch (error) {
      console.error('Error in fetchCoversForBooks:', error);
    }
  };

  const fetchBookCover = async (title: string, author?: string): Promise<{coverUrl?: string, googleBooksId?: string}> => {
    try {
      
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
          
          return {
            coverUrl: httpsUrl,
            googleBooksId: book.id
          };
        }
      }
      
      return {};
    } catch (error) {
      console.error('Error fetching book cover:', error);
      return {};
    }
  };

  const scanImageWithOpenAI = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log('🔵 OpenAI scanning image...');
      
      // Prevent long hangs from the API by aborting after 15s
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        signal: controller.signal,
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
          max_tokens: 1200,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
      }

      const data = await response.json();
      clearTimeout(timeoutId);
      let content = data.choices?.[0]?.message?.content?.trim() || '';

      if (content.includes('```')) {
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }

      if (!content.startsWith('[') && !content.startsWith('{')) {
        return [];
      }

      try {
        const parsedBooks = JSON.parse(content);
        const books = Array.isArray(parsedBooks) ? parsedBooks : [];
        return books;
      } catch (_) {
        console.warn('❌ OpenAI JSON parse failed');
        return [];
      }
      
    } catch (error) {
      console.error('❌ OpenAI scan failed:', error);
      return [];
    }
  };

  const scanImageWithGemini = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log('🟣 Gemini scanning image...');
      
      // Convert data URL to base64
      const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
      
      // Use gemini-2.5-pro (more accurate, supports vision) - verified available models
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.EXPO_PUBLIC_GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Scan book spines. Return JSON array only:
[{"title":"Book Title","author":"Author or Unknown","confidence":"high/medium/low"}]
No explanations, just JSON.`
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
            maxOutputTokens: 8000, // Increased to handle more books without truncation
            topP: 0.95,
            topK: 40,
          }
        }),
      });

      if (!response.ok) {
        // If overloaded (503), suggest retry by returning [] to withRetries
        const bodyText = await response.text();
        console.warn(`Gemini error ${response.status}: ${bodyText.slice(0, 180)}`);
        return [];
      }

      const data = await response.json();
      
      // Check if response was truncated
      const wasTruncated = data.candidates?.[0]?.finishReason === 'MAX_TOKENS';
      if (wasTruncated) {
        console.warn('Gemini response truncated due to token limit');
      }
      
      // Try multiple ways to extract content
      let content = '';
      
      // Method 1: Standard structure
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        content = data.candidates[0].content.parts[0].text;
      }
      // Method 2: Alternative structure
      else if (data.candidates?.[0]?.text) {
        content = data.candidates[0].text;
      }
      // Method 3: Direct text
      else if (data.text) {
        content = data.text;
      }
      // Method 4: Check all parts
      else if (data.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.text) {
            content += part.text;
          }
        }
      }

      if (!content) {
        console.warn('Gemini returned empty content');
        return [];
      }

      // Clean up markdown formatting if present
      if (content.includes('```json')) {
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (content.includes('```')) {
        // Handle generic code blocks
        content = content.replace(/```[a-z]*\n?/g, '').replace(/```\n?/g, '');
      }

      content = content.trim();
      
      // Try to extract JSON from the response
      let jsonContent = content.trim();
      
      // Remove any leading/trailing text that's not JSON
      // Find the first [ or { and the last matching ] or }
      const firstBracket = jsonContent.indexOf('[');
      const firstBrace = jsonContent.indexOf('{');
      
      let startIndex = -1;
      let isArray = false;
      
      if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        startIndex = firstBracket;
        isArray = true;
      } else if (firstBrace !== -1) {
        startIndex = firstBrace;
        isArray = false;
      }
      
      if (startIndex === -1) {
        console.warn('Gemini returned non-JSON content. Content preview:', content.substring(0, 200));
        return [];
      }
      
      // Extract from the start bracket to the end
      jsonContent = jsonContent.substring(startIndex);
      
      // Try to find the matching closing bracket
      if (isArray) {
        // Count brackets to find the end
        let bracketCount = 0;
        let endIndex = -1;
        for (let i = 0; i < jsonContent.length; i++) {
          if (jsonContent[i] === '[') bracketCount++;
          if (jsonContent[i] === ']') bracketCount--;
          if (bracketCount === 0 && jsonContent[i] === ']') {
            endIndex = i + 1;
            break;
          }
        }
        if (endIndex > 0) {
          jsonContent = jsonContent.substring(0, endIndex);
        }
      }
      
      // Try parsing
      try {
        const parsedBooks = JSON.parse(jsonContent);
        return Array.isArray(parsedBooks) ? parsedBooks : [];
      } catch (parseError) {
        // If parsing fails and was truncated, try to extract complete entries
        if (wasTruncated) {
          console.warn('Attempting to extract complete entries from truncated JSON...');
          
          // Find all complete book objects using regex - handle escaped quotes and various formats
          // This pattern matches: {"title":"...","author":"...","confidence":"..."}
          const bookPattern = /\{"title":\s*"[^"\\]*(?:\\.[^"\\]*)*",\s*"author":\s*"[^"\\]*(?:\\.[^"\\]*)*",\s*"confidence":\s*"[^"]+"\}/g;
          const matches = jsonContent.match(bookPattern);
          
          if (matches && matches.length > 0) {
            try {
              const completeBooks = matches.map(match => {
                // Fix any incomplete matches by escaping quotes properly
                const fixed = match.replace(/'/g, '"');
                return JSON.parse(fixed);
              });
              return completeBooks;
            } catch (extractError) {
              console.warn('Failed to extract complete entries from truncated JSON');
            }
          }
          
          // Fallback: try removing the last incomplete entry
          const lastCompleteEntry = jsonContent.lastIndexOf('}]');
          if (lastCompleteEntry > 0) {
            try {
              const fixedJson = jsonContent.substring(0, lastCompleteEntry + 2) + ']';
              const parsedBooks = JSON.parse(fixedJson);
              return Array.isArray(parsedBooks) ? parsedBooks : [];
            } catch (fixError) {
              // Ignore and continue to final return
            }
          }
        }
        
        console.warn('Failed to parse Gemini JSON. Content preview:', jsonContent.substring(0, 300));
        return [];
      }
      
    } catch (error) {
      console.error(' Gemini scan failed:', error);
      return [];
    }
  };

  const mergeBookResults = (openaiBooks: Book[], geminiBooks: Book[]): Book[] => {
    // Aggressive normalization to catch duplicates with slight variations
    const normalize = (s?: string) => {
      if (!s) return '';
      return s.trim()
        .toLowerCase()
        .replace(/[.,;:!?]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize whitespace
    };
    
    // Remove leading articles from titles for better matching
    const normalizeTitle = (title?: string) => {
      const normalized = normalize(title);
      // Remove "the", "a", "an" from the beginning
      return normalized.replace(/^(the|a|an)\s+/, '').trim();
    };
    
    // Normalize author names more aggressively
    const normalizeAuthor = (author?: string) => {
      const normalized = normalize(author);
      // Remove common suffixes and normalize
      return normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
    };

    const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;

    const unique: Record<string, Book> = {};
    
    // Process all books from both sources
    const allBooks = [...openaiBooks, ...geminiBooks];
    
    for (const b of allBooks) {
      const k = makeKey(b);
      // Only add if we haven't seen this exact key before
      if (!unique[k]) {
        unique[k] = b;
      }
    }
    
    const merged = Object.values(unique);
    
    // Final pass: check for near-duplicates using similarity
    const final: Book[] = [];
    for (const book of merged) {
      const bookTitle = normalizeTitle(book.title);
      const bookAuthor = normalizeAuthor(book.author);
      
      let isDuplicate = false;
      for (const existing of final) {
        const existingTitle = normalizeTitle(existing.title);
        const existingAuthor = normalizeAuthor(existing.author);
        
        // Exact match on normalized title + author
        if (bookTitle === existingTitle && bookAuthor === existingAuthor) {
          isDuplicate = true;
          break;
        }
        
        // If titles are very similar (one contains the other) and authors match
        if (bookAuthor === existingAuthor && bookAuthor && bookAuthor !== 'unknown' && bookAuthor !== 'unknown author') {
          if (bookTitle.includes(existingTitle) && existingTitle.length > 3) {
            isDuplicate = true;
            break;
          }
          if (existingTitle.includes(bookTitle) && bookTitle.length > 3) {
            isDuplicate = true;
            break;
          }
        }
      }
      
      if (!isDuplicate) {
        final.push(book);
      }
    }
    
    return final;
  };

  const scanImageWithAI = async (primaryDataURL: string, fallbackDataURL: string): Promise<Book[]> => {
    console.log('🚀 Starting AI scan with OpenAI and Gemini...');
    const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    // Try server first if configured
    if (baseUrl) {
      console.log(`📡 Attempting Vercel API scan at: ${baseUrl}/api/scan`);
      try {
        const resp = await fetch(`${baseUrl}/api/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageDataURL: primaryDataURL }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const serverBooks = Array.isArray(data.books) ? data.books : [];
          
          // Log API status if available
          if (data.apiResults) {
            const { openai, gemini } = data.apiResults;
            console.log(`✅ Vercel API Status: OpenAI=${openai.working ? '✅' : '❌'} (${openai.count} books), Gemini=${gemini.working ? '✅' : '❌'} (${gemini.count} books)`);
          } else {
            console.log(`✅ Vercel API returned ${serverBooks.length} books (API status not available - Vercel may need redeployment)`);
          }
          
          if (serverBooks.length > 0) {
            console.log(`✅ Using Vercel API results: ${serverBooks.length} books found`);
            return serverBooks;
          } else {
            console.log('⚠️ Vercel API returned 0 books, falling back to client-side APIs...');
          }
        } else {
          console.warn(`❌ Vercel API error: ${resp.status}`);
        }
      } catch (e) {
        console.warn('❌ Vercel API request failed, falling back to client providers:', e?.message || e);
      }
    } else {
      console.log('⚠️ No Vercel API URL configured, using client-side APIs...');
    }

    // Fallback: run client-side providers (requires local .env keys)
    try {
      console.log('🔄 Using client-side fallback APIs...');
      const [openaiPrimary, geminiPrimary] = await Promise.all([
        withRetries(() => scanImageWithOpenAI(primaryDataURL), 1, 800).catch((e) => {
          console.warn('❌ OpenAI primary attempt failed:', e?.message || e);
          return [];
        }),
        withRetries(() => scanImageWithGemini(primaryDataURL), 1, 800).catch((e) => {
          console.warn('❌ Gemini primary attempt failed:', e?.message || e);
          return [];
        }),
      ]);

      let openaiResults = openaiPrimary;
      let geminiResults = geminiPrimary;
      
      
      if (openaiResults.length === 0 && geminiResults.length === 0) {
        console.log('⚠️ Both APIs returned 0 books, trying with downscaled image...');
        const [openaiFallback, geminiFallback] = await Promise.all([
          withRetries(() => scanImageWithOpenAI(fallbackDataURL), 2, 1200).catch((e) => {
            console.warn('❌ OpenAI fallback attempt failed:', e?.message || e);
            return [];
          }),
          withRetries(() => scanImageWithGemini(fallbackDataURL), 2, 1200).catch((e) => {
            console.warn('❌ Gemini fallback attempt failed:', e?.message || e);
            return [];
          }),
        ]);
        openaiResults = openaiFallback;
        geminiResults = geminiFallback;
      }

      const mergedResults = mergeBookResults(openaiResults, geminiResults);
      // mergeBookResults already does aggressive deduplication, so this is just a safety pass
      const normalizeKey = (s?: string) => {
        if (!s) return '';
        return s.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ');
      };
      const normalizeTitle = (title?: string) => {
        return normalizeKey(title).replace(/^(the|a|an)\s+/, '');
      };
      const normalizeAuthor = (author?: string) => {
        return normalizeKey(author).replace(/\s+(jr|sr|iii?|iv)$/i, '');
      };
      
      const seen = new Set<string>();
      const final = mergedResults.filter(b => {
        const key = `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
        if (seen.has(key)) {
          console.log(`🔄 Filtered duplicate: "${b.title}" by ${b.author}`);
          return false;
        }
        seen.add(key);
        return true;
      });
      
      console.log(`✅ Client-side API Status: OpenAI=${openaiResults.length > 0 ? '✅' : '❌'} (${openaiResults.length} books), Gemini=${geminiResults.length > 0 ? '✅' : '❌'} (${geminiResults.length} books), Merged=${final.length} unique`);
      
      return final;
    } catch (err) {
      console.error('❌ Client-side fallback failed:', err);
      return [];
    }
  };

  const processImage = async (uri: string, scanId: string, caption?: string) => {
    try {
      // Get current progress to preserve totalScans
      const currentProgress = scanProgress || {
        currentScanId: null,
        currentStep: 0,
        totalSteps: 10,
        totalScans: scanQueue.length,
        completedScans: 0,
        failedScans: 0,
      };
      
      // Ensure totalScans reflects the actual queue length
      const totalScans = Math.max(currentProgress.totalScans, scanQueue.length);
      const completedCount = scanQueue.filter(item => item.status === 'completed' || item.status === 'failed').length;
      
      // Step 1: Initializing (1%)
      setScanProgress({
        currentScanId: scanId,
        currentStep: 1,
        totalSteps: 10, // More granular steps for better progress tracking
        totalScans: totalScans,
        completedScans: completedCount,
        failedScans: scanQueue.filter(item => item.status === 'failed').length,
        startTimestamp: scanProgress?.startTimestamp || Date.now(), // Preserve or set start timestamp
      });
      
      setCurrentScan({ id: scanId, uri, progress: { current: 1, total: 10 } });
      
      // Step 2: Converting to base64 (10%)
      const imageDataURL = await convertImageToBase64(uri);
      updateProgress({ currentStep: 2, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 2, total: 10 } });
      
      // Prepare a downscaled fallback (done in parallel to save time)
      const fallbackPromise = convertImageToBase64Resized(uri, 1400, 0.5).catch(() => null);

      // Step 3: Scanning with AI (40%)
      const fallbackDataURL = await fallbackPromise || imageDataURL;
      const detectedBooks = await scanImageWithAI(imageDataURL, fallbackDataURL);
      updateProgress({ currentStep: 4, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 4, total: 10 } });
      
      // Step 4: Validate each book with ChatGPT (40-90%, with incremental updates)
      const analyzedBooks = [];
      const totalBooks = detectedBooks.length;
      for (let i = 0; i < detectedBooks.length; i++) {
        const book = detectedBooks[i];
        try {
          const analyzedBook = await analyzeBookWithChatGPT(book);
          analyzedBooks.push(analyzedBook);
          
          // Update progress: 4 (start) + (i+1)/totalBooks * 5 (remaining steps to 9)
          const validationProgress = 4 + Math.floor(((i + 1) / totalBooks) * 5);
          updateProgress({ currentStep: Math.min(validationProgress, 9), totalScans: totalScans });
          setCurrentScan({ id: scanId, uri, progress: { current: validationProgress, total: 10 } });
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          analyzedBooks.push(book); // Keep original if analysis fails
          
          // Still update progress even on error
          const validationProgress = 4 + Math.floor(((i + 1) / totalBooks) * 5);
          updateProgress({ currentStep: Math.min(validationProgress, 9), totalScans: totalScans });
          setCurrentScan({ id: scanId, uri, progress: { current: validationProgress, total: 10 } });
        }
      }
      
      // Step 5: Finalizing (100%)
      updateProgress({ currentStep: 10, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 10, total: 10 } });
      
      // Convert analyzed books to proper structure and separate complete vs incomplete
      // Use timestamp + index for stable IDs that can be used for folder membership
      const bookTimestamp = Date.now();
      const allBooks: Book[] = analyzedBooks.map((book, index) => ({
        id: `book_${bookTimestamp}_${index}`,
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
      
      if (newIncompleteBooks.length > 0) {
        console.log(`⚠️ Found ${newIncompleteBooks.length} incomplete books`);
      }
      
      // Create combined books array with correct statuses for the photo
      const photoBooks: Book[] = [
        ...newPendingBooks.map(book => ({ ...book, status: 'pending' as const })),
        ...newIncompleteBooks.map(book => ({ ...book, status: 'incomplete' as const }))
      ];
      
      // Get the caption that was set during scanning (from ref or parameter)
      const finalCaption = scanCaptionsRef.current.get(scanId) || caption || undefined;
      // Clean up the ref
      scanCaptionsRef.current.delete(scanId);
      
      // Save results
      const newPhoto: Photo = {
        id: scanId,
        uri,
        books: photoBooks, // Store all books with correct statuses for scan modal
        timestamp: Date.now(),
        caption: finalCaption, // Include caption if provided
      };
      
      const updatedPhotos = [...photos, newPhoto];
      const updatedPending = [...pendingBooks, ...newPendingBooks];
      
      setPhotos(updatedPhotos);
      setPendingBooks(updatedPending);
      // Ensure no book appears pre-selected after new results arrive
      setSelectedBooks(new Set());
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
      
      // Fetch covers for books in background (don't wait for this)
      fetchCoversForBooks(newPendingBooks);
      
      // Add books to selected folder if one was chosen
      if (selectedFolderId) {
        const scannedBookIds = newPendingBooks.map(book => book.id).filter((id): id is string => id !== undefined);
        await addBooksToSelectedFolder(scannedBookIds);
      }
      
      // Update queue status
      const updatedQueue = scanQueue.map(item => 
        item.id === scanId ? { ...item, status: 'completed' as const } : item
      );
      setScanQueue(updatedQueue);
      
      // Update scanning progress
      const newCompletedCount = updatedQueue.filter(item => item.status === 'completed').length;
      const pendingScans = updatedQueue.filter(item => item.status === 'pending');
      const stillProcessing = updatedQueue.some(item => item.status === 'processing');
      
      if (stillProcessing || pendingScans.length > 0) {
        // More scans to process
        updateProgress({
          currentScanId: null,
          currentStep: 0,
          completedScans: newCompletedCount,
          totalScans: totalScans,
        });
        
        // Process next pending scan if available and not already processing
        if (!stillProcessing && pendingScans.length > 0) {
          const nextScan = pendingScans[0];
          setIsProcessing(true);
          setTimeout(() => {
            setScanQueue(prev => 
              prev.map(item => 
                item.id === nextScan.id ? { ...item, status: 'processing' as const } : item
              )
            );
            processImage(nextScan.uri, nextScan.id);
          }, 500);
        }
      } else {
        // All scans complete, hide notification after a brief delay
        setTimeout(() => {
          setScanProgress(null);
        }, 500);
      }
      
      console.log(`✅ Scan complete: ${newPendingBooks.length} books ready, ${newIncompleteBooks.length} incomplete`);
      
    } catch (error) {
      console.error(' Processing failed:', error);
      const failedQueue = scanQueue.map(item => 
        item.id === scanId ? { ...item, status: 'failed' as const } : item
      );
      setScanQueue(failedQueue);
      
      // Update progress with failed scan
      const newFailedCount = failedQueue.filter(item => item.status === 'failed').length;
      const pendingScans = failedQueue.filter(item => item.status === 'pending');
      const stillProcessing = failedQueue.some(item => item.status === 'processing');
      
      // Get totalScans from current progress
      const failedProgress = scanProgress || {
        currentScanId: null,
        currentStep: 0,
        totalSteps: 10,
        totalScans: failedQueue.length,
        completedScans: 0,
        failedScans: 0,
      };
      const failedTotalScans = Math.max(failedProgress.totalScans, failedQueue.length);
      
      if (stillProcessing || pendingScans.length > 0) {
        updateProgress({
          currentScanId: null,
          currentStep: 0,
          failedScans: newFailedCount,
          totalScans: failedTotalScans,
        });
        
        // Process next pending scan if available and not already processing
        if (!stillProcessing && pendingScans.length > 0) {
          const nextScan = pendingScans[0];
          setIsProcessing(true);
          setTimeout(() => {
            setScanQueue(prev => 
              prev.map(item => 
                item.id === nextScan.id ? { ...item, status: 'processing' as const } : item
              )
            );
            processImage(nextScan.uri, nextScan.id);
          }, 500);
        }
      } else {
        // All scans complete (including failures), hide notification
        setTimeout(() => {
          setScanProgress(null);
        }, 500);
      }
    } finally {
      setCurrentScan(null);
      // Check if there are more scans to process
      const hasMorePending = scanQueue.some(item => item.status === 'pending');
      // Only set to false if there are no more pending scans and we're not starting a new one
      if (!hasMorePending) {
        setIsProcessing(false);
      }
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
    const updatedApproved = deduplicateBooks(approvedBooks, [approvedBook]);

    setPendingBooks(updatedPending);
    setApprovedBooks(updatedApproved);
    await saveUserData(updatedPending, updatedApproved, rejectedBooks, photos);
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
    await saveUserData(updatedPending, approvedBooks, updatedRejected, photos);
  };

  const openScanModal = (photo: Photo) => {
    setSelectedPhoto(photo);
    setShowScanModal(true);
  };

  const closeScanModal = () => {
    setSelectedPhoto(null);
    setShowScanModal(false);
  };

  const deleteScan = async (photoId: string) => {
    try {
      // Remove the photo (which contains all its books including incomplete ones)
      const photoToDelete = photos.find(photo => photo.id === photoId);
      if (!photoToDelete) return;

      // Remove the photo completely (including all incomplete books)
      const updatedPhotos = photos.filter(photo => photo.id !== photoId);
      
      // Also remove any pending books that were from this scan
      const bookIdsFromScan = new Set(photoToDelete.books.map(book => book.id));
      const updatedPending = pendingBooks.filter(book => !bookIdsFromScan.has(book.id));
      
      // Clear selected photo if we're deleting it
      if (selectedPhoto?.id === photoId) {
        setSelectedPhoto(null);
        closeScanModal();
      }
      
      setPendingBooks(updatedPending);
      setPhotos(updatedPhotos);
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
      
      Alert.alert('Scan Deleted', 'The scan and all its books (including incomplete ones) have been deleted.');
    } catch (error) {
      console.error('Error deleting scan:', error);
      Alert.alert('Error', 'Failed to delete scan. Please try again.');
    }
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

  const selectAllBooks = () => {
    // Select all pending books (exclude incomplete ones)
    const allPendingIds = pendingBooks
      .filter(book => book.status !== 'incomplete')
      .map(book => book.id)
      .filter((id): id is string => id !== undefined);
    
    setSelectedBooks(new Set(allPendingIds));
  };

  const addAllBooks = async () => {
    // Approve all pending books except incomplete ones
    const booksToApprove = pendingBooks.filter(book => book.status !== 'incomplete');
    
    if (booksToApprove.length === 0) {
      Alert.alert('No Books', 'There are no books to add (excluding incomplete books).');
      return;
    }

    const approvedBooksData = booksToApprove.map(book => ({ ...book, status: 'approved' as const }));
    const updatedApproved = deduplicateBooks(approvedBooks, approvedBooksData);
    const remainingPending = pendingBooks.filter(book => book.status === 'incomplete');
    
    const addedCount = updatedApproved.length - approvedBooks.length;
    setApprovedBooks(updatedApproved);
    setPendingBooks(remainingPending);
    setSelectedBooks(new Set());
    await saveUserData(remainingPending, updatedApproved, rejectedBooks, photos);
    
    Alert.alert('Success', `Added ${addedCount} book${addedCount !== 1 ? 's' : ''} to your library!`);
  };

  const unselectAllBooks = () => {
    setSelectedBooks(new Set());
  };

  const clearAllBooks = async () => {
    // Remove all pending books (including incomplete ones)
    setPendingBooks([]);
    setSelectedBooks(new Set());
    
    // Also remove incomplete books from photos
    const updatedPhotos = photos.map(photo => ({
      ...photo,
      books: photo.books.filter(book => book.status !== 'incomplete')
    }));
    
    setPhotos(updatedPhotos);
    await saveUserData([], approvedBooks, rejectedBooks, updatedPhotos);
  };

  const clearSelectedBooks = async () => {
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    setPendingBooks(remainingBooks);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, approvedBooks, rejectedBooks, photos);
  };

  // Helper to deduplicate books when adding to library
  const deduplicateBooks = (existingBooks: Book[], newBooks: Book[]): Book[] => {
    const normalize = (s?: string) => {
      if (!s) return '';
      return s.trim()
        .toLowerCase()
        .replace(/[.,;:!?]/g, '')
        .replace(/\s+/g, ' ');
    };
    
    const normalizeTitle = (title?: string) => {
      return normalize(title).replace(/^(the|a|an)\s+/, '').trim();
    };
    
    const normalizeAuthor = (author?: string) => {
      return normalize(author).replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
    };
    
    const makeKey = (b: Book) => `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
    
    // Create a map of existing books by normalized key
    const existingMap = new Map<string, Book>();
    for (const book of existingBooks) {
      const key = makeKey(book);
      if (!existingMap.has(key)) {
        existingMap.set(key, book);
      }
    }
    
    // Filter out new books that already exist
    const uniqueNewBooks = newBooks.filter(book => {
      const key = makeKey(book);
      return !existingMap.has(key);
    });
    
    return [...existingBooks, ...uniqueNewBooks];
  };

  const approveSelectedBooks = async () => {
    const selectedBookObjs = pendingBooks.filter(book => selectedBooks.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    
    const newApprovedBooks = selectedBookObjs.map(book => ({ ...book, status: 'approved' as const }));
    const updatedApproved = deduplicateBooks(approvedBooks, newApprovedBooks);
    
    setPendingBooks(remainingBooks);
    setApprovedBooks(updatedApproved);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, updatedApproved, rejectedBooks, photos);
  };

  const rejectSelectedBooks = async () => {
    const selectedBookObjs = pendingBooks.filter(book => selectedBooks.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    
    const newRejectedBooks = selectedBookObjs.map(book => ({ ...book, status: 'rejected' as const }));
    const updatedRejected = [...rejectedBooks, ...newRejectedBooks];
    
    setPendingBooks(remainingBooks);
    setRejectedBooks(updatedRejected);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, approvedBooks, updatedRejected, photos);
  };

  const addImageToQueue = (uri: string, caption?: string, providedScanId?: string) => {
    const scanId = providedScanId || Date.now().toString();
    // Store caption if provided
    if (caption !== undefined) {
      scanCaptionsRef.current.set(scanId, caption);
    }
    const newScanItem: ScanQueueItem = {
      id: scanId,
      uri,
      status: 'pending'
    };
    
    // Clear any lingering selections before a new scan starts
    setSelectedBooks(new Set());

    // Calculate new queue state BEFORE updating state
    const updatedQueue = [...scanQueue, newScanItem];
    const totalScans = updatedQueue.length;
    const completedCount = updatedQueue.filter(item => item.status === 'completed' || item.status === 'failed').length;
    
    console.log('📸 Adding image to queue, setting scan progress immediately', {
      totalScans,
      completedCount,
      scanId,
      queueLength: scanQueue.length
    });
    
    // Update queue state
    setScanQueue(updatedQueue);
    
    // Set scan progress IMMEDIATELY (outside of setState to avoid render conflicts)
    setScanProgress({
      currentScanId: null,
      currentStep: 0,
      totalSteps: 10,
      totalScans: totalScans,
      completedScans: completedCount,
      failedScans: 0, // No failed scans yet when adding new item
      startTimestamp: Date.now(), // Add start timestamp for ETA calculation
    });
    
    if (!isProcessing) {
      setIsProcessing(true);
      setScanQueue(prev => 
        prev.map(item => 
          item.id === scanId ? { ...item, status: 'processing' } : item
        )
      );
      // Small delay to ensure notification renders before processing starts
      setTimeout(() => {
        processImage(uri, scanId, caption);
      }, 50);
    }
  };

  const handleCaptionSubmit = () => {
    // Scanning already started in background - save caption for the current scan
    if (currentScanIdRef.current) {
      scanCaptionsRef.current.set(currentScanIdRef.current, captionText.trim());
      currentScanIdRef.current = null; // Clear after saving
    }
    
    setPendingImageUri(null);
    setCaptionText('');
    setShowCaptionModal(false);
    // Scanning notification will automatically appear if scanning is still in progress
  };

  const handleCaptionSkip = () => {
    // Scanning already started in background - just close modal
    // Caption stays empty (already initialized in useEffect)
    currentScanIdRef.current = null; // Clear ref
    setPendingImageUri(null);
    setCaptionText('');
    setShowCaptionModal(false);
    // Scanning notification will automatically appear if scanning is still in progress
  };

  const handleAddToFolder = () => {
    if (!user || !pendingImageUri) return;
    // Close caption modal first, then show folder modal
    setShowCaptionModal(false);
    // Small delay to ensure caption modal closes before folder modal opens
    setTimeout(() => {
      setShowFolderModal(true);
    }, 100);
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

  const createFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName || !user) return;
    
    const newFolder: Folder = {
      id: `folder_${Date.now()}`,
      name: folderName,
      bookIds: [],
      photoIds: [],
      createdAt: Date.now(),
    };
    
    const updatedFolders = [...folders, newFolder];
    await saveFolders(updatedFolders);
    setNewFolderName('');
    setSelectedFolderId(newFolder.id);
  };

  const handleFolderSelection = async (folderId: string | null) => {
    if (!user || !pendingImageUri) return;
    
    if (folderId === null) {
      // Skip folder assignment - just close folder modal and caption modal
      setSelectedFolderId(null);
      setShowFolderModal(false);
      handleCaptionSkip();
      return;
    }
    
    // The books will be added to the folder after scanning completes
    // Store the selected folder ID and add books to it later
    setSelectedFolderId(folderId);
    setShowFolderModal(false);
    
    // Close caption modal - scanning already started in background
    handleCaptionSubmit();
  };

  // Helper to add scanned books to selected folder after scan completes
  const addBooksToSelectedFolder = async (scannedBookIds: string[]) => {
    if (!user || !selectedFolderId || scannedBookIds.length === 0) return;
    
    try {
      const updatedFolders = folders.map(folder => {
        if (folder.id === selectedFolderId) {
          // Add new book IDs, avoiding duplicates
          const existingIds = new Set(folder.bookIds);
          scannedBookIds.forEach(id => {
            if (!existingIds.has(id)) {
              folder.bookIds.push(id);
            }
          });
        }
        return folder;
      });
      
      await saveFolders(updatedFolders);
      setSelectedFolderId(null); // Clear selection after adding
    } catch (error) {
      console.error('Error adding books to folder:', error);
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
          console.log('📷 Photo taken:', photo.uri);
          // Close camera first
          setIsCameraActive(false);
          // Reset caption modal state
          setShowCaptionModal(false);
          setCaptionText('');
          // Start scanning and show modal immediately
          // Small delay to ensure camera closes first
          setTimeout(() => {
            handleImageSelected(photo.uri);
          }, 100);
        }
      } catch (error) {
        console.error('Error taking picture:', error);
        Alert.alert('Camera Error', 'Failed to take picture. Please try again.');
      }
    }
  };

  const pickImage = async () => {
    try {
      
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      
      if (permissionResult.granted === false) {
        Alert.alert('Permission Required', 'Please grant photo library access to upload images.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsEditing: false,
        quality: 1.0, // No compression = faster
        selectionLimit: 1,
      });

      if (!result.canceled && result.assets[0]) {
        console.log('📂 Image picked from library:', result.assets[0].uri);
        // Reset caption modal state
        setShowCaptionModal(false);
        setCaptionText('');
        // Start scanning and show modal immediately
        handleImageSelected(result.assets[0].uri);
      }
    } catch (error) {
      console.error(' Error picking image:', error);
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
      <View style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          ref={(ref) => setCameraRef(ref)}
        />
        {/* Overlay outside CameraView using absolute positioning */}
        <View style={styles.cameraOverlay}>
          {/* Close button (X) - Top right corner, at the very top */}
          <TouchableOpacity 
            style={[styles.closeButton, { top: insets.top + 10 }]}
            onPress={() => setIsCameraActive(false)}
          >
            <Text style={styles.closeButtonText}>×</Text>
          </TouchableOpacity>

          {/* Top tip message - Centered, below the X */}
          <View style={[styles.cameraTipBanner, { marginTop: insets.top + 55 }]}>
            <Text style={styles.cameraTipText}>
              {orientation === 'landscape' 
                ? 'Better lighting = better accuracy'
                : 'Better lighting and smaller area = better accuracy'}
            </Text>
          </View>
        
          {/* Capture button at bottom (iPhone style) */}
          <View style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.captureButton}
              onPress={takePicture}
              activeOpacity={0.8}
            >
              <View style={styles.captureButtonInner} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // Sticky toolbar at bottom - always visible when there are pending books
  // Position it directly above the React Navigation tab bar with zero gap
  // React Navigation handles tab bar safe area, so we position at 0 and let it sit below
  const stickyBottomPosition = 0; // Directly at bottom, no gap

  return (
    <View style={styles.safeContainer}>
      <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
        <LinearGradient
          colors={['#f5f7fa', '#1a1a2e']}
          style={{ height: insets.top }}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
        />
        <ScrollView 
          style={styles.container}
          contentContainerStyle={[
            pendingBooks.length > 0 && { paddingBottom: 100 } // Add padding so content isn't hidden behind sticky toolbar
          ]}
          bounces={false}
          overScrollMode="never"
        >
      <View style={styles.header}>
        <Text style={styles.title}>Book Scanner</Text>
        <Text style={styles.subtitle}>Scan your bookshelf to build your library</Text>
      </View>

      {/* Scan Options */}
      <View style={styles.scanOptions}>
        <TouchableOpacity style={styles.scanButton} onPress={handleStartCamera}>
          <Text style={styles.scanButtonText}>Take Photo</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.scanButton} onPress={pickImage}>
          <Text style={styles.scanButtonText}>Upload Image</Text>
        </TouchableOpacity>
      </View>

      {/* Pending Books - Need Approval */}
      {pendingBooks.length > 0 && (
        <View style={styles.pendingSection}>
          <View style={styles.pendingHeader}>
            <View style={styles.pendingTitleContainer}>
              <Text style={styles.sectionTitle}>Pending Books ({pendingBooks.length})</Text>
              <Text style={styles.sectionSubtitle}>Tap books to select • Use buttons to approve/reject</Text>
            </View>
            
            <View style={styles.headerButtons}>
              <TouchableOpacity 
                style={styles.selectAllButton}
                onPress={selectAllBooks}
              >
                <Text style={styles.selectAllButtonText}>Select All</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.clearButton}
                onPress={selectedBooks.size > 0 ? unselectAllBooks : clearAllBooks}
              >
                <Text style={styles.clearButtonText}>
                  {selectedBooks.size > 0 ? 'Unselect All' : 'Clear All'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.booksGrid}>
            {sortedPendingBooks.map((book) => (
              <TouchableOpacity 
                key={book.id} 
                style={[
                  styles.pendingBookCard,
                  selectedBooks.has(book.id) && styles.selectedBookCard
                ]}
                onPress={() => toggleBookSelection(book.id)}
                activeOpacity={0.7}
              >
              {/* Header removed: no circular selection indicator */}

              {/* Cover area: show cover or placeholder with title text; author below */}
              <View style={styles.bookTopSection}>
                {getBookCoverUri(book) ? (
                  <Image 
                    source={{ uri: getBookCoverUri(book) }} 
                    style={styles.bookCover}
                  />
                ) : (
                  <View style={[styles.bookCover, styles.placeholderCover]}>
                    <Text style={styles.placeholderText} numberOfLines={3}>
                      {book.title}
                    </Text>
                  </View>
                )}
                <View style={styles.bookInfo}>
                  {book.author && (
                    <Text style={styles.bookAuthor} numberOfLines={2} ellipsizeMode="tail">
                      {book.author}
                    </Text>
                  )}
                </View>
              </View>
              
            </TouchableOpacity>
          ))}
          </View>
        </View>
      )}

      {/* Recent Scans */}
      {photos.length > 0 && (
        <View style={styles.recentSection}>
          <Text style={styles.sectionTitle}>Recent Scans</Text>
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

        </ScrollView>

      {/* Rejected Books section removed per request */}

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
            <View style={styles.modalHeaderButtons}>
              <TouchableOpacity
                style={styles.modalDeleteButton}
                onPress={() => {
                  if (selectedPhoto) {
                    Alert.alert(
                      'Delete Scan',
                      'This will delete the scan and all its incomplete books. Pending books will be removed. Continue?',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete', style: 'destructive', onPress: () => deleteScan(selectedPhoto.id) }
                      ]
                    );
                  }
                }}
              >
                <Text style={styles.modalDeleteText}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={closeScanModal}
              >
                <Text style={styles.modalCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
    </View>
          
          {selectedPhoto && (
            <ScrollView style={styles.modalContent}>
              <Image source={{ uri: selectedPhoto.uri }} style={styles.modalImage} />
              
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>
                  Books Found ({selectedPhoto.books.length})
                </Text>
                <Text style={styles.modalSectionSubtitle}>
                  Scanned on {new Date(selectedPhoto.timestamp).toLocaleDateString()}
                </Text>
              </View>

              {/* Complete books section */}
              {selectedPhoto.books.filter(book => book.status !== 'incomplete').length > 0 && (
                <View style={styles.modalBooksGroup}>
                  <Text style={styles.modalGroupTitle}>Complete Books</Text>
                  {selectedPhoto.books.filter(book => book.status !== 'incomplete').map((book, index) => (
                    <View key={`${book.id || index}`} style={styles.modalBookCard}>
                      {getBookCoverUri(book) && (
                        <Image 
                          source={{ uri: getBookCoverUri(book) }} 
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
                          {book.status === 'approved' ? 'Added' : 
                           book.status === 'rejected' ? 'Rejected' : 
                           'Pending'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
              
              {/* Incomplete books section - Always at the bottom */}
              {selectedPhoto.books.filter(book => book.status === 'incomplete').length > 0 && (
                <View style={[styles.modalBooksGroup, styles.incompleteBooksGroup]}>
                  <Text style={styles.modalGroupTitle}>Incomplete Books</Text>
                  <Text style={styles.modalGroupSubtitle}>Books that need editing or were rejected by validation</Text>
                  {selectedPhoto.books.filter(book => book.status === 'incomplete').map((book, index) => (
                    <View key={`${book.id || index}`} style={[styles.modalBookCard, styles.incompleteBookCardModal]}>
                      {getBookCoverUri(book) && (
                        <Image 
                          source={{ uri: getBookCoverUri(book) }} 
                          style={styles.modalBookCover}
                        />
                      )}
                      <View style={styles.bookInfo}>
                        <Text style={styles.bookTitle}>{book.title}</Text>
                        {book.author && <Text style={styles.bookAuthor}>by {book.author}</Text>}
                      </View>
                      <TouchableOpacity
                        style={styles.editButton}
                        onPress={() => {
                          setEditingBook(book);
                          setShowEditModal(true);
                          setSearchQuery(book.title);
                          setManualTitle(book.title);
                          setManualAuthor(book.author || '');
                        }}
                      >
                        <Text style={styles.editButtonText}>Edit</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Edit Incomplete Book Modal */}
      <Modal
        visible={showEditModal}
        animationType="none"
        presentationStyle="fullScreen"
              onRequestClose={() => {
          setShowEditModal(false);
          setEditingBook(null);
          setSearchQuery('');
          setSearchResults([]);
          setManualTitle('');
          setManualAuthor('');
        }}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Book Details</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                setShowEditModal(false);
                setEditingBook(null);
                setSearchQuery('');
                setSearchResults([]);
              }}
            >
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {editingBook && (
            <ScrollView style={styles.modalContent}>
              <View style={styles.editSection}>
                <Text style={styles.editLabel}>Edit Book Title and Author:</Text>
                <Text style={styles.editSubLabel}>Enter the correct information to move this book to pending. Results update as you type.</Text>
                
                <Text style={styles.editLabel}>Title:</Text>
                <TextInput
                  style={styles.editInput}
                  value={manualTitle}
                  onChangeText={setManualTitle}
                  placeholder="Enter book title..."
                  autoCapitalize="words"
                />
                
                <Text style={styles.editLabel}>Author:</Text>
                <TextInput
                  style={styles.editInput}
                  value={manualAuthor}
                  onChangeText={setManualAuthor}
                  placeholder="Enter author name..."
                  autoCapitalize="words"
                />
                
                <TouchableOpacity
                  style={[styles.saveManualButton, (!manualTitle.trim() || !manualAuthor.trim()) && styles.saveManualButtonDisabled]}
                  onPress={async () => {
                    if (!manualTitle.trim() || !manualAuthor.trim() || !selectedPhoto || !editingBook) {
                      Alert.alert('Error', 'Please enter both title and author');
                      return;
                    }
                    
                    try {
                      // Try to fetch cover based on the new title/author
                      let coverUrl = editingBook.coverUrl;
                      let googleBooksId = editingBook.googleBooksId;
                      let localCoverPath = editingBook.localCoverPath;
                      
                      try {
                        const query = `${manualTitle.trim()} ${manualAuthor.trim()}`;
                        const response = await fetch(
                          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`
                        );
                        const data = await response.json();
                        if (data.items && data.items.length > 0) {
                          const book = data.items[0];
                          const volumeInfo = book.volumeInfo;
                          if (volumeInfo.imageLinks) {
                            coverUrl = volumeInfo.imageLinks.thumbnail?.replace('http:', 'https:');
                            googleBooksId = book.id;
                            if (coverUrl) {
                              localCoverPath = await downloadAndCacheCover(coverUrl, book.id);
                            }
                          }
                        }
                      } catch (error) {
                        console.warn('Failed to fetch cover, using existing or none');
                      }

                      const updatedBooks = selectedPhoto.books.map(b =>
                        b.id === editingBook.id
                          ? {
                              ...b,
                              title: manualTitle.trim(),
                              author: manualAuthor.trim(),
                              coverUrl: coverUrl || b.coverUrl,
                              googleBooksId: googleBooksId || b.googleBooksId,
                              ...(localCoverPath && { localCoverPath }),
                              status: 'pending' as const, // Change from incomplete to pending
                            }
                          : b
                      );

                      const updatedPhotos = photos.map(photo =>
                        photo.id === selectedPhoto.id
                          ? { ...photo, books: updatedBooks }
                          : photo
                      );

                      setPhotos(updatedPhotos);
                      setSelectedPhoto({ ...selectedPhoto, books: updatedBooks });
                      
                      // Move to pending books
                      const updatedBook = updatedBooks.find(b => b.id === editingBook.id);
                      if (updatedBook && updatedBook.status === 'pending') {
                        const bookIdsFromScan = new Set(updatedBooks.map(b => b.id));
                        const wasInPending = pendingBooks.some(b => b.id === updatedBook.id);
                        if (!wasInPending) {
                          const newPending = [...pendingBooks, updatedBook];
                          setPendingBooks(newPending);
                          await saveUserData(newPending, approvedBooks, rejectedBooks, updatedPhotos);
                        } else {
                          await saveUserData(pendingBooks, approvedBooks, rejectedBooks, updatedPhotos);
                        }
                      }

                      Alert.alert('Success', 'Book details updated! It can now be added to your library.');
                      setShowEditModal(false);
                      setEditingBook(null);
                      setSearchQuery('');
                      setSearchResults([]);
                      setManualTitle('');
                      setManualAuthor('');
                    } catch (error) {
                      console.error('Error updating book:', error);
                      Alert.alert('Error', 'Failed to update book. Please try again.');
                    }
                  }}
                  disabled={!manualTitle.trim() || !manualAuthor.trim()}
                >
                  <Text style={styles.saveManualButtonText}>Save Changes</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.editSection}>
                <Text style={styles.editDivider}>OR</Text>
              </View>

              <View style={styles.editSection}>
                <Text style={styles.editLabel}>Search for correct book:</Text>
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Enter book title..."
                  autoCapitalize="words"
                />
                <TouchableOpacity
                  style={styles.searchButton}
                  onPress={async () => {
                    // Manual trigger remains, but auto-search already runs as you type
                    const titleQ = manualTitle.trim();
                    const authorQ = manualAuthor.trim();
                    const q = [titleQ, authorQ].filter(Boolean).join(' ');
                    if (!q) return;
                    setIsSearching(true);
                    try {
                      const response = await fetch(
                        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10`
                      );
                      const data = await response.json();
                      setSearchResults(data.items || []);
                    } catch (error) {
                      console.error('Search failed:', error);
                      Alert.alert('Error', 'Failed to search books. Please try again.');
                    } finally {
                      setIsSearching(false);
                    }
                  }}
                >
                  <Text style={styles.searchButtonText}>
                    {isSearching ? 'Searching...' : 'Search'}
                  </Text>
                </TouchableOpacity>
              </View>

              {searchResults.length > 0 && (
                <View style={styles.searchResultsSection}>
                  <Text style={styles.editLabel}>Select the correct book:</Text>
                  {searchResults.map((item, index) => {
                    const volumeInfo = item.volumeInfo || {};
                    const coverUrl = volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:');
                    return (
                      <TouchableOpacity
                        key={item.id || index}
                        style={styles.searchResultCard}
                        onPress={async () => {
                          // Update the book in the photo
                          if (selectedPhoto && editingBook) {
                            // Cache the cover if available
                            let localCoverPath = null;
                            if (coverUrl && item.id) {
                              localCoverPath = await downloadAndCacheCover(coverUrl, item.id);
                            }

                            const updatedBooks = selectedPhoto.books.map(b =>
                              b.id === editingBook.id
                                ? {
                                    ...b,
                                    title: volumeInfo.title || editingBook.title,
                                    author: volumeInfo.authors?.[0] || 'Unknown',
                                    coverUrl: coverUrl || b.coverUrl,
                                    googleBooksId: item.id,
                                    ...(localCoverPath && { localCoverPath }),
                                    status: 'pending' as const, // Change from incomplete to pending
                                  }
                                : b
                            );

                            // Update the photo in photos array
                            const updatedPhotos = photos.map(photo =>
                              photo.id === selectedPhoto.id
                                ? { ...photo, books: updatedBooks }
                                : photo
                            );

                            setPhotos(updatedPhotos);
                            setSelectedPhoto({ ...selectedPhoto, books: updatedBooks });
                            await saveUserData(pendingBooks, approvedBooks, rejectedBooks, updatedPhotos);

                            // Also move it from incomplete to pending if needed
                            const updatedBook = updatedBooks.find(b => b.id === editingBook.id);
                            if (updatedBook && updatedBook.status === 'pending') {
                              const bookIdsFromScan = new Set(updatedBooks.map(b => b.id));
                              const wasInPending = pendingBooks.some(b => bookIdsFromScan.has(b.id));
                              if (!wasInPending) {
                                setPendingBooks([...pendingBooks, updatedBook]);
                                await saveUserData([...pendingBooks, updatedBook], approvedBooks, rejectedBooks, updatedPhotos);
                              }
                            }

                            Alert.alert('Success', 'Book details updated!');
                            setShowEditModal(false);
                            setEditingBook(null);
                            setSearchQuery('');
                            setSearchResults([]);
                          }
                        }}
                      >
                        {coverUrl && (
                          <Image source={{ uri: coverUrl }} style={styles.searchResultCover} />
                        )}
                        <View style={styles.searchResultInfo}>
                          <Text style={styles.bookTitle}>{volumeInfo.title || 'Unknown Title'}</Text>
                          <Text style={styles.bookAuthor}>
                            by {volumeInfo.authors?.[0] || 'Unknown Author'}
                          </Text>
                          {volumeInfo.publishedDate && (
                            <Text style={styles.searchResultDate}>
                              Published: {volumeInfo.publishedDate}
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Caption Modal - Appears after taking/uploading photo */}
      <Modal
        visible={showCaptionModal}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={handleCaptionSkip}
        transparent={false}
      >
        <View style={styles.captionModalContainer}>
          <View style={styles.captionModalHeader}>
            <Text style={styles.modalTitle}>Add Caption</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={handleCaptionSkip}
            >
              <Text style={styles.modalCloseText}>Skip</Text>
            </TouchableOpacity>
          </View>
          
          {pendingImageUri && (
            <KeyboardAvoidingView 
              style={{ flex: 1 }} 
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
            >
              <ScrollView 
                style={styles.captionModalContent}
                contentContainerStyle={styles.captionModalContentContainer}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Image source={{ uri: pendingImageUri }} style={styles.captionModalImage} />
                
                <View style={styles.captionSection}>
                  <Text style={styles.captionLabel}>Caption / Location</Text>
                  <Text style={styles.captionHint}>e.g., Living Room Bookshelf, Office, Bedroom...</Text>
                <TextInput
                  style={styles.captionInput}
                  value={captionText}
                  onChangeText={setCaptionText}
                  placeholder="Add a caption to remember where this is..."
                  multiline
                  numberOfLines={3}
                  autoFocus
                  blurOnSubmit={true}
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    Keyboard.dismiss();
                    handleCaptionSubmit();
                  }}
                />
                  <TouchableOpacity
                    style={styles.captionFolderButton}
                    onPress={handleAddToFolder}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="folder-outline" size={20} color="#ffffff" style={{ marginRight: 8 }} />
                    <Text style={styles.captionFolderButtonText}>Add to Folder</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.captionSubmitButton}
                    onPress={handleCaptionSubmit}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.captionSubmitButtonText}>Done</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          )}
        </View>
      </Modal>

      {/* Folder Selection Modal */}
      <Modal
        visible={showFolderModal}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setShowFolderModal(false);
          setNewFolderName('');
        }}
        transparent={false}
      >
        <View style={styles.folderModalContainer}>
          <LinearGradient
            colors={['#f5f7fa', '#1a1a2e']}
            style={{ height: insets.top }}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          />
          <View style={styles.folderModalHeader}>
            <Text style={styles.modalTitle}>Add to Folder</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                setShowFolderModal(false);
                setNewFolderName('');
              }}
            >
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
          
          <ScrollView style={styles.folderModalContent} showsVerticalScrollIndicator={false}>
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
                    style={[
                      styles.folderItem,
                      selectedFolderId === folder.id && styles.folderItemSelected
                    ]}
                    onPress={() => setSelectedFolderId(folder.id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons 
                      name={selectedFolderId === folder.id ? "folder" : "folder-outline"} 
                      size={24} 
                      color={selectedFolderId === folder.id ? "#007AFF" : "#4a5568"} 
                      style={{ marginRight: 12 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[
                        styles.folderItemName,
                        selectedFolderId === folder.id && styles.folderItemNameSelected
                      ]}>
                        {folder.name}
                      </Text>
                      <Text style={styles.folderItemCount}>
                        {folder.bookIds.length} {folder.bookIds.length === 1 ? 'book' : 'books'}
                      </Text>
                    </View>
                    {selectedFolderId === folder.id && (
                      <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Action Buttons */}
            <View style={styles.folderModalActions}>
              <TouchableOpacity
                style={[styles.folderActionButton, styles.folderSkipButton]}
                onPress={() => handleFolderSelection(null)}
                activeOpacity={0.8}
              >
                <Text style={styles.folderSkipButtonText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.folderActionButton,
                  styles.folderConfirmButton,
                  !selectedFolderId && styles.folderConfirmButtonDisabled
                ]}
                onPress={() => handleFolderSelection(selectedFolderId || null)}
                activeOpacity={0.8}
                disabled={!selectedFolderId}
              >
                <Text style={styles.folderConfirmButtonText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      </SafeAreaView>
      
      {/* Sticky toolbar at bottom - positioned at absolute bottom, tab bar will be directly below */}
      {pendingBooks.length > 0 && (
        <View 
          style={[
            styles.stickyToolbar,
            styles.stickyToolbarBottom,
            {
              bottom: stickyBottomPosition,
            }
          ]}
        >
          <View style={styles.stickyToolbarHeader}>
            <Text style={styles.stickyToolbarTitle}>Pending Books</Text>
            <Text style={styles.stickySelectedCount}>{selectedBooks.size} selected</Text>
          </View>
          <View style={styles.stickyToolbarRow}>
            <TouchableOpacity 
              style={[styles.stickyButton, selectedBooks.size === 0 && styles.stickyButtonDisabled]}
              onPress={approveSelectedBooks}
              activeOpacity={0.8}
              disabled={selectedBooks.size === 0}
            >
              <Text style={styles.stickyButtonText}>Add Selected</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.stickyDeleteButton, selectedBooks.size === 0 && styles.stickyButtonDisabled]}
              onPress={rejectSelectedBooks}
              activeOpacity={0.8}
              disabled={selectedBooks.size === 0}
            >
              <Text style={styles.stickyDeleteButtonText}>Delete Selected</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
    position: 'relative',
  },
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#1a1a2e',
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
    color: '#cbd5e0',
    fontWeight: '400',
  },
  scanOptions: {
    flexDirection: 'row',
    padding: 20,
    gap: 15,
    marginTop: -15,
  },
  scanButton: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 18,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  scanButtonText: {
    color: '#1a202c',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: 'black',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
    pointerEvents: 'box-none',
  },
  cameraTipBanner: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    alignSelf: 'center',
    pointerEvents: 'auto',
  },
  cameraTipText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '400',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  closeButton: {
    position: 'absolute',
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
    pointerEvents: 'auto',
  },
  closeButtonText: {
    color: 'white',
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 36,
  },
  cameraControls: {
    alignItems: 'center',
    paddingBottom: 40,
    paddingTop: 20,
    pointerEvents: 'auto',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255, 255, 255, 0.6)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  captureButtonInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(0, 0, 0, 0.1)',
  },
  queueSection: {
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
  pendingSection: {
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
  recentSection: {
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
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a202c',
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
    marginBottom: 15,
  },
  booksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  pendingBookCard: {
    backgroundColor: 'transparent',
    borderRadius: 8,
    padding: 0,
    marginBottom: 12,
    marginHorizontal: 4,
    flexDirection: 'column',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    width: (screenWidth - 94) / 4,
    alignItems: 'center',
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  bookHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 6,
  },
  bookTopSection: {
    flexDirection: 'column',
    alignItems: 'center',
    marginBottom: 8,
  },
  bookCover: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#e0e0e0',
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
  bookInfo: {
    width: '100%',
    alignItems: 'center',
  },
  bookTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 2,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  bookAuthor: {
    fontSize: 11,
    color: '#4a5568',
    marginBottom: 6,
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: 14,
    paddingHorizontal: 2,
  },
  bookActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButton: {
    backgroundColor: '#4caf50',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#45a049',
    marginRight: 6,
  },
  approveButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  rejectButton: {
    backgroundColor: '#f44336',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#e53935',
    marginLeft: 6,
  },
  rejectButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  deleteButton: {
    backgroundColor: '#f44336',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#e53935',
  },
  deleteButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  photoCard: {
    flexDirection: 'row',
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  photoThumbnail: {
    width: 60,
    height: 60,
    borderRadius: 10,
    marginRight: 15,
  },
  photoInfo: {
    flex: 1,
  },
  photoDate: {
    fontSize: 15,
    color: '#1a202c',
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  photoBooks: {
    fontSize: 13,
    color: '#718096',
    marginTop: 4,
    fontWeight: '500',
  },
  tapToView: {
    fontSize: 11,
    color: '#007AFF',
    marginTop: 4,
    fontStyle: 'italic',
    fontWeight: '600',
  },
  rejectedSection: {
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
  rejectedBookCard: {
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#dc3545',
    opacity: 0.85,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 0,
  },
  modalHeaderButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  modalDeleteButton: {
    backgroundColor: '#dc3545',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  modalDeleteText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  modalBooksGroup: {
    marginTop: 20,
    marginBottom: 10,
  },
  incompleteBooksGroup: {
    marginTop: 30,
    paddingTop: 20,
    borderTopWidth: 2,
    borderTopColor: '#e2e8f0',
  },
  modalGroupTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 8,
  },
  modalGroupSubtitle: {
    fontSize: 13,
    color: '#718096',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  incompleteBookCardModal: {
    backgroundColor: '#fff9e6',
    borderLeftColor: '#ffa500',
    borderLeftWidth: 4,
  },
  incompleteScanGroup: {
    marginBottom: 20,
  },
  incompleteScanHeader: {
    backgroundColor: '#fff3cd',
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
  },
  incompleteScanDate: {
    fontSize: 14,
    fontWeight: '600',
    color: '#856404',
  },
  incompleteStatus: {
    color: '#856404',
    backgroundColor: '#fff3cd',
  },
  editButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 'auto',
  },
  editButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  editSection: {
    marginBottom: 20,
    padding: 15,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
  },
  editLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 10,
  },
  editCurrentText: {
    fontSize: 14,
    color: '#666',
    fontStyle: 'italic',
    marginBottom: 15,
  },
  searchInput: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    marginBottom: 10,
  },
  searchButton: {
    backgroundColor: '#28a745',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  searchButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  editInput: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    marginBottom: 15,
  },
  editSubLabel: {
    fontSize: 13,
    color: '#718096',
    marginBottom: 15,
    fontStyle: 'italic',
  },
  editDivider: {
    textAlign: 'center',
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
    marginVertical: 10,
  },
  saveManualButton: {
    backgroundColor: '#4caf50',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  saveManualButtonDisabled: {
    backgroundColor: '#ccc',
    opacity: 0.6,
  },
  saveManualButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  searchResultsSection: {
    marginTop: 20,
  },
  searchResultCard: {
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  searchResultCover: {
    width: 50,
    height: 75,
    borderRadius: 4,
    marginRight: 15,
    backgroundColor: '#e0e0e0',
  },
  searchResultInfo: {
    flex: 1,
  },
  searchResultDate: {
    fontSize: 12,
    color: '#999',
    marginTop: 4,
  },
  modalHeaderOld: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  modalCloseButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  modalCloseText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
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
  modalContent: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f7fa',
  },
  modalImage: {
    width: '100%',
    height: 300,
    borderRadius: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  modalSection: {
    marginBottom: 20,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  modalSectionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a202c',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  modalSectionSubtitle: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '500',
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
  incompleteBookCard: {
    backgroundColor: '#fff9e6',
    borderRadius: 16,
    padding: 16,
    marginBottom: 15,
    flexDirection: 'column',
    borderWidth: 2,
    borderColor: '#FFA500',
    width: '48%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 3,
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
  selectAllButton: {
    backgroundColor: '#4caf50',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  selectAllButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  clearButton: {
    backgroundColor: '#718096',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  clearButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  addAllButton: {
    flex: 1,
    backgroundColor: '#4caf50',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#45a049',
    marginRight: 5,
  },
  addAllButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  deleteAllButton: {
    flex: 1,
    backgroundColor: '#f44336',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#e53935',
    marginLeft: 5,
  },
  deleteAllButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  bulkActions: {
    backgroundColor: '#f7fafc',
    padding: 18,
    borderRadius: 12,
    marginBottom: 15,
    borderWidth: 2,
    borderColor: '#007AFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 3,
  },
  selectedCount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  bulkButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bulkApproveButton: {
    flex: 1,
    backgroundColor: '#4caf50',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#45a049',
    marginRight: 5,
  },
  bulkRejectButton: {
    flex: 1,
    backgroundColor: '#f44336',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#e53935',
    marginHorizontal: 5,
  },
  bulkClearButton: {
    flex: 1,
    backgroundColor: '#718096',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#5a6c7d',
    marginLeft: 5,
  },
  bulkButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  selectedBookCard: {
    backgroundColor: 'transparent',
    borderColor: '#4caf50',
    borderWidth: 2,
  },
  stickyToolbar: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  stickyToolbarBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1000,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  stickyToolbarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  stickyToolbarTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
  },
  stickyToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stickySelectedCount: {
    fontSize: 13,
    color: '#4a5568',
    fontWeight: '600',
  },
  stickyButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#005FCC',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 3,
  },
  stickyButtonDisabled: {
    opacity: 0.5,
  },
  stickyButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  stickyDeleteButton: {
    backgroundColor: '#E53935',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#C62828',
    shadowColor: '#E53935',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 3,
  },
  stickyDeleteButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  selectionIndicator: {},
  selectedCheckbox: {},
  unselectedCheckbox: {},
  checkmark: {},
  captionSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginTop: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  captionLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  captionHint: {
    fontSize: 13,
    color: '#718096',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  scanningInBackgroundHint: {
    fontSize: 14,
    color: '#007AFF',
    marginBottom: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  captionInput: {
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#1a202c',
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  captionSubmitButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  captionSubmitButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  captionFolderButton: {
    backgroundColor: '#718096',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  captionFolderButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  captionModalContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  captionModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 0,
  },
  captionModalContent: {
    flex: 1,
    padding: 20,
  },
  captionModalContentContainer: {
    paddingBottom: 100,
  },
  captionModalImage: {
    width: '100%',
    height: 200,
    borderRadius: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  folderModalContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  folderModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 0,
  },
  folderModalContent: {
    flex: 1,
    padding: 20,
  },
  createFolderSection: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
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
    backgroundColor: '#007AFF',
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
  },
  existingFoldersTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
    letterSpacing: 0.3,
  },
  folderItem: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  folderItemSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#f0f8ff',
  },
  folderItemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 4,
  },
  folderItemNameSelected: {
    color: '#007AFF',
  },
  folderItemCount: {
    fontSize: 13,
    color: '#718096',
  },
  folderModalActions: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 20,
  },
  folderActionButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  folderSkipButton: {
    backgroundColor: '#e2e8f0',
  },
  folderSkipButtonText: {
    color: '#4a5568',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  folderConfirmButton: {
    backgroundColor: '#007AFF',
  },
  folderConfirmButtonDisabled: {
    backgroundColor: '#cbd5e0',
    opacity: 0.6,
  },
  folderConfirmButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});


