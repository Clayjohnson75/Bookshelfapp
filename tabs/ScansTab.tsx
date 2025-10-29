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
  TextInput
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../auth/SimpleAuthContext';
import { useScanning } from '../contexts/ScanningContext';
import { Book, Photo } from '../types/BookTypes';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface ScanQueueItem {
  id: string;
  uri: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export const ScansTab: React.FC = () => {
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
      if (savedPhotos) {
        setPhotos(JSON.parse(savedPhotos));
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
      console.log(`Analyzing book with ChatGPT: "${book.title}" by "${book.author}"`);
      
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
      console.error(` ChatGPT analysis failed for "${book.title}":`, error);
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
        console.log(' Image converted to base64');
        return `data:image/jpeg;base64,${manipulatedImage.base64}`;
      }
      
      throw new Error('Failed to get base64 from ImageManipulator');
    } catch (error) {
      console.error(' Image conversion failed:', error);
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
        console.log(` Cover already cached: ${localPath}`);
        return localPath;
      }

      // Download the image
      console.log(` Downloading and caching cover: ${coverUrl}`);
      const downloadResult = await FileSystem.downloadAsync(coverUrl, fullPath);

      if (downloadResult.uri) {
        console.log(` Cover cached to: ${localPath}`);
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
      console.log(' Fetching book covers in background...');
      
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
      console.log(` Fetching cover for: ${title} by ${author || 'Unknown'}`);
      
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
          
          console.log(` Found cover for: ${title}`);
          return {
            coverUrl: httpsUrl,
            googleBooksId: book.id
          };
        }
      }
      
      console.log(` No cover found for: ${title}`);
      return {};
    } catch (error) {
      console.error('Error fetching book cover:', error);
      return {};
    }
  };

  const scanImageWithOpenAI = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log(' OpenAI scanning image...');
      
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
        console.warn(' OpenAI returned non-JSON content, returning empty array');
        return [];
      }

      const parsedBooks = JSON.parse(content);
      console.log(' OpenAI scan completed:', parsedBooks);
      return Array.isArray(parsedBooks) ? parsedBooks : [];
      
    } catch (error) {
      console.error(' OpenAI scan failed:', error);
      return [];
    }
  };

  const scanImageWithGemini = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log(' Gemini scanning image...');
      
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
        throw new Error(`Gemini API error: ${response.status} - ${await response.text()}`);
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
        console.log(`Gemini scan completed: ${parsedBooks.length} books`);
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
              console.log(`Gemini scan completed (extracted ${completeBooks.length} complete entries from truncated response)`);
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
              console.log(`Gemini scan completed (fixed truncated): ${parsedBooks.length} books`);
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
    console.log(` Merging results: ${openaiBooks.length} from OpenAI + ${geminiBooks.length} from Gemini`);
    
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
    
    console.log(` Merged total: ${merged.length} unique books`);
    return merged;
  };

  const scanImageWithAI = async (imageDataURL: string): Promise<Book[]> => {
    try {
      console.log(' Starting dual AI scan...');
      
      // Start OpenAI scan (primary)
      const openaiPromise = scanImageWithOpenAI(imageDataURL);
      
      // Try Gemini scan (optional - don't fail if it errors)
      const geminiPromise = scanImageWithGemini(imageDataURL).catch(error => {
        console.warn(' Gemini scan failed, continuing with OpenAI only:', error.message);
        return []; // Return empty array if Gemini fails
      });
      
      // Wait for both (Gemini won't block if it fails)
      const [openaiResults, geminiResults] = await Promise.all([
        openaiPromise,
        geminiPromise
      ]);
      
      // Merge the results (will just use OpenAI if Gemini failed)
      const mergedResults = mergeBookResults(openaiResults, geminiResults);
      
      console.log(' Dual AI scan completed');
      return mergedResults;
      
    } catch (error) {
      console.error(' Dual AI scan failed:', error);
      return [];
    }
  };

  const processImage = async (uri: string, scanId: string) => {
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
      });
      
      setCurrentScan({ id: scanId, uri, progress: { current: 1, total: 10 } });
      
      // Step 2: Converting to base64 (10%)
      const imageDataURL = await convertImageToBase64(uri);
      updateProgress({ currentStep: 2, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 2, total: 10 } });
      
      // Step 3: Scanning with AI (40%)
      const detectedBooks = await scanImageWithAI(imageDataURL);
      updateProgress({ currentStep: 4, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 4, total: 10 } });
      
      // Step 4: Validate each book with ChatGPT (40-90%, with incremental updates)
      console.log(' Starting ChatGPT validation for all detected books...');
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
          console.log(`Error analyzing book "${book.title}":`, error);
          analyzedBooks.push(book); // Keep original if analysis fails
          
          // Still update progress even on error
          const validationProgress = 4 + Math.floor(((i + 1) / totalBooks) * 5);
          updateProgress({ currentStep: Math.min(validationProgress, 9), totalScans: totalScans });
          setCurrentScan({ id: scanId, uri, progress: { current: validationProgress, total: 10 } });
        }
      }
      
      console.log(` ChatGPT validation complete: ${analyzedBooks.length} books analyzed`);
      // Step 5: Finalizing (100%)
      updateProgress({ currentStep: 10, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 10, total: 10 } });
      
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
      
      console.log(` Created ${newPendingBooks.length} pending books and ${newIncompleteBooks.length} incomplete books`);
      if (newIncompleteBooks.length > 0) {
        console.log(' Incomplete books detected:', newIncompleteBooks.map(b => `${b.title} by ${b.author}`));
      }
      
      // Create combined books array with correct statuses for the photo
      const photoBooks: Book[] = [
        ...newPendingBooks.map(book => ({ ...book, status: 'pending' as const })),
        ...newIncompleteBooks.map(book => ({ ...book, status: 'incomplete' as const }))
      ];
      
      // Save results
      const newPhoto: Photo = {
        id: scanId,
        uri,
        books: photoBooks, // Store all books with correct statuses for scan modal
        timestamp: Date.now(),
      };
      
      const updatedPhotos = [...photos, newPhoto];
      const updatedPending = [...pendingBooks, ...newPendingBooks];
      
      setPhotos(updatedPhotos);
      setPendingBooks(updatedPending);
      console.log(' Setting pending books:', updatedPending);
      console.log(' Incomplete books stored in photo:', newIncompleteBooks.length);
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
      
      // Fetch covers for books in background (don't wait for this)
      fetchCoversForBooks(newPendingBooks);
      
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
      
      console.log(` Scan completed: ${detectedBooks.length} books found → ${analyzedBooks.length} after ChatGPT → (${newPendingBooks.length} complete, ${newIncompleteBooks.length} incomplete)`);
      
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
    const updatedApproved = [...approvedBooks, approvedBook];

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

      const updatedPhotos = photos.filter(photo => photo.id !== photoId);
      
      // Also remove any pending books that were from this scan
      const bookIdsFromScan = new Set(photoToDelete.books.map(book => book.id));
      const updatedPending = pendingBooks.filter(book => !bookIdsFromScan.has(book.id));
      
      setPendingBooks(updatedPending);
      setPhotos(updatedPhotos);
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
      
      // Close modal if we deleted the currently selected scan
      if (selectedPhoto?.id === photoId) {
        closeScanModal();
      }
      
      Alert.alert('Scan Deleted', 'The scan and its incomplete books have been deleted.');
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
    const updatedApproved = [...approvedBooks, ...approvedBooksData];
    const remainingPending = pendingBooks.filter(book => book.status === 'incomplete');
    
    setApprovedBooks(updatedApproved);
    setPendingBooks(remainingPending);
    setSelectedBooks(new Set());
    await saveUserData(remainingPending, updatedApproved, rejectedBooks, photos);
    
    Alert.alert('Success', `Added ${approvedBooksData.length} book${approvedBooksData.length > 1 ? 's' : ''} to your library!`);
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

  const approveSelectedBooks = async () => {
    const selectedBookObjs = pendingBooks.filter(book => selectedBooks.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    
    const newApprovedBooks = selectedBookObjs.map(book => ({ ...book, status: 'approved' as const }));
    const updatedApproved = [...approvedBooks, ...newApprovedBooks];
    
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

  const addImageToQueue = (uri: string) => {
    const scanId = Date.now().toString();
    const newScanItem: ScanQueueItem = {
      id: scanId,
      uri,
      status: 'pending'
    };
    
    setScanQueue(prev => {
      const updatedQueue = [...prev, newScanItem];
      
      // Initialize or update scanning progress
      const totalScans = updatedQueue.length;
      const completedCount = updatedQueue.filter(item => item.status === 'completed' || item.status === 'failed').length;
      
      setScanProgress({
        currentScanId: null,
        currentStep: 0,
        totalSteps: 10,
        totalScans: totalScans,
        completedScans: completedCount,
        failedScans: updatedQueue.filter(item => item.status === 'failed').length,
      });
      
      return updatedQueue;
    });
    
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
      console.log(' Starting image picker...');
      
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
        console.log(' Selected image URI:', result.assets[0].uri);
        addImageToQueue(result.assets[0].uri);
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
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
            
            <View style={styles.cameraControls}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={takePicture}
              >
                <Text style={styles.captureButtonText}>Capture</Text>
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

          {/* Bulk Action Buttons - Only show when books are selected */}
          {selectedBooks.size > 0 && (
            <View style={styles.bulkActions}>
              <Text style={styles.selectedCount}>{selectedBooks.size} selected</Text>
              <View style={styles.bulkButtonsRow}>
                <TouchableOpacity 
                  style={styles.addAllButton}
                  onPress={approveSelectedBooks}
                  activeOpacity={0.8}
                >
                  <Text style={styles.addAllButtonText}>
                    Add {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.deleteAllButton}
                  onPress={rejectSelectedBooks}
                  activeOpacity={0.8}
                >
                  <Text style={styles.deleteAllButtonText}>
                    Delete {selectedBooks.size} {selectedBooks.size === 1 ? 'book' : 'books'}
                  </Text>
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
                {getBookCoverUri(book) && (
                  <Image 
                    source={{ uri: getBookCoverUri(book) }} 
                    style={styles.bookCover}
                  />
                )}
                <View style={styles.bookInfo}>
                  <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                  {book.author && <Text style={styles.bookAuthor} numberOfLines={1}>by {book.author}</Text>}
                </View>
              </View>
              
              {/* Bottom Half: Delete Button */}
              <TouchableOpacity 
                style={styles.deleteButton}
                onPress={(e) => {
                  e.stopPropagation();
                  rejectBook(book.id);
                }}
                activeOpacity={0.8}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
          </View>
        </View>
      )}

      {/* Incomplete Books - Grouped by Scan */}
      {(() => {
        // Get all incomplete books from all photos
        const allIncompleteBooks = photos.flatMap(photo => 
          photo.books.filter(book => book.status === 'incomplete')
        );
        
        // Group by photo/scan
        const incompleteByScan = photos
          .filter(photo => photo.books.some(book => book.status === 'incomplete'))
          .map(photo => ({
            photo,
            incompleteBooks: photo.books.filter(book => book.status === 'incomplete')
          }));
        
        if (incompleteByScan.length === 0) return null;
        
        return (
          <View style={styles.incompleteSection}>
            <Text style={styles.sectionTitle}>Incomplete ({allIncompleteBooks.length})</Text>
            <Text style={styles.sectionSubtitle}>Books with missing or unclear information - grouped by scan</Text>
            
            {incompleteByScan.map(({ photo, incompleteBooks }) => (
              <View key={photo.id} style={styles.incompleteScanGroup}>
                <View style={styles.incompleteScanHeader}>
                  <Text style={styles.incompleteScanDate}>
                    Scan from {new Date(photo.timestamp).toLocaleDateString()} ({incompleteBooks.length} incomplete)
                  </Text>
                </View>
                <View style={styles.booksGrid}>
                  {incompleteBooks.map((book) => (
                    <TouchableOpacity
                      key={book.id}
                      style={styles.incompleteBookCard}
                      onPress={() => {
                        setEditingBook(book);
                        setShowEditModal(true);
                      }}
                    >
                      <View style={styles.bookTopSection}>
                        {getBookCoverUri(book) ? (
                          <Image source={{ uri: getBookCoverUri(book) }} style={styles.bookCover} />
                        ) : (
                          <View style={[styles.bookCover, styles.noCover]}>
                            <Text style={styles.noCoverText}></Text>
                          </View>
                        )}
                        <View style={styles.bookInfo}>
                          <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                          <Text style={styles.bookAuthor} numberOfLines={1}>{book.author}</Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={styles.editButton}
                        onPress={(e) => {
                          e.stopPropagation();
                          setEditingBook(book);
                          setShowEditModal(true);
                        }}
                      >
                        <Text style={styles.editButtonText}>Edit</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </View>
        );
      })()}

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


      {/* Rejected Books - At Bottom */}
      {rejectedBooks.length > 0 && (
        <View style={styles.rejectedSection}>
          <Text style={styles.sectionTitle}>Rejected Books ({rejectedBooks.length})</Text>
          <Text style={styles.sectionSubtitle}>Books you chose not to add to your library</Text>
          {rejectedBooks.map((book) => (
            <View key={book.id} style={styles.rejectedBookCard}>
              {getBookCoverUri(book) && (
                <Image 
                  source={{ uri: getBookCoverUri(book) }} 
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
                <Text style={styles.editLabel}>Current Title:</Text>
                <Text style={styles.editCurrentText}>{editingBook.title}</Text>
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
                    if (!searchQuery.trim()) return;
                    setIsSearching(true);
                    try {
                      const query = encodeURIComponent(searchQuery.trim());
                      const response = await fetch(
                        `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=10`
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
    </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f5f7fa',
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
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
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
    height: 140,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#e0e0e0',
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
    color: '#718096',
    fontStyle: 'italic',
    marginBottom: 6,
    textAlign: 'center',
    fontWeight: '500',
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
    backgroundColor: '#f0fdf4',
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


