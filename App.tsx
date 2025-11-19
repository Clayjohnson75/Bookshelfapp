import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  Dimensions,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { AuthProvider, useAuth } from './auth/SimpleAuthContext';
import { LoginScreen } from './auth/AuthScreens';
import { TabNavigator } from './TabNavigator';
import { Book, Photo } from './types/BookTypes';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const BookshelfScannerAppInner: React.FC = () => {
  const { user, signOut, loading: authLoading } = useAuth();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Camera and image states
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 12 });

  // Library states
  const [books, setBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLibrary, setShowLibrary] = useState(true);
  const [showScanner, setShowScanner] = useState(false);

  // Replace modal states
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replaceOptions, setReplaceOptions] = useState<Book[]>([]);
  const [currentBookToReplace, setCurrentBookToReplace] = useState<Book | null>(null);

  // Notification scanning states
  const [scanQueue, setScanQueue] = useState<Array<{id: string, uri: string, status: 'pending' | 'processing' | 'completed' | 'failed'}>>([]);
  const [currentScan, setCurrentScan] = useState<{id: string, uri: string, progress: {current: number, total: number}} | null>(null);
  const [showScanNotification, setShowScanNotification] = useState(false);
  
  // Section selector states
  const [showSectionSelector, setShowSectionSelector] = useState(false);
  const [selectedImageUri, setSelectedImageUri] = useState<string | null>(null);
  const [selectedSections, setSelectedSections] = useState<number>(1); // Default: scan whole image (fastest)
  
  // Author editing states
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [editAuthorText, setEditAuthorText] = useState('');

  // Load user data when component mounts or user changes
  useEffect(() => {
    if (user) {
      loadUserData();
    }
  }, [user]);

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      const userBooksKey = `books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      const savedBooks = await AsyncStorage.getItem(userBooksKey);
      const savedPhotos = await AsyncStorage.getItem(userPhotosKey);
      
      if (savedBooks) {
        setBooks(JSON.parse(savedBooks));
      }
      if (savedPhotos) {
        setPhotos(JSON.parse(savedPhotos));
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const convertImageToBase64 = async (uri: string): Promise<string> => {
    try {
      console.log('🔄 Converting image to base64...');
      
      // Optimize image for faster processing
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

  const cropImageToSection = async (uri: string, section: { x: number; y: number; width: number; height: number }): Promise<string> => {
    try {
      // If it's a whole image scan (no crop needed), return as-is
      if (section.width >= 100 && section.height >= 100) {
        return await convertImageToBase64(uri);
      }
      
      console.log(`✂️ Cropping section: ${section.x}%, ${section.y}%, ${section.width}%, ${section.height}%`);
      
      // Crop the image to the section
      const croppedImage = await ImageManipulator.manipulateAsync(
        uri,
        [{
          type: 'crop',
          originX: section.x,
          originY: section.y,
          width: section.width,
          height: section.height,
        }],
        { 
          compress: 0.7, 
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true 
        }
      );
      
      if (croppedImage.base64) {
        console.log('✅ Section cropped successfully');
        return `data:image/jpeg;base64,${croppedImage.base64}`;
      }
      
      throw new Error('Failed to get base64 from cropped image');
    } catch (error) {
      console.error('❌ Image crop failed:', error);
      // Fallback to full image if cropping fails
      return await convertImageToBase64(uri);
    }
  };

  const scanImageWithAI = async (imageDataURL: string, sectionInfo: string = ''): Promise<Book[]> => {
    try {
      console.log('🤖 Scanning image with AI...');
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5',
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

Return the JSON array now. Do not include any text before or after the array.${sectionInfo}`
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

      // Additional cleanup for common issues
      content = content.trim();
      
      // Handle cases where AI returns non-JSON content
      if (!content.startsWith('[') && !content.startsWith('{')) {
        console.warn('⚠️ AI returned non-JSON content, attempting to extract JSON...');
        
        // Try to extract JSON array from the response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          content = jsonMatch[0];
          console.log('✅ Extracted JSON from response');
        } else {
          console.error('❌ Could not extract JSON from AI response:', content.substring(0, 200));
          return [];
        }
      }

      const detectedBooks = JSON.parse(content);
      console.log('✅ AI detected books:', detectedBooks);
      
      return Array.isArray(detectedBooks) ? detectedBooks : [];
    } catch (error) {
      console.error('AI scanning error:', error);
      if (error instanceof SyntaxError) {
        console.error('JSON parsing failed. Raw content may be:', error.message);
      }
      return [];
    }
  };

  const scanImageSection = async (imageDataURL: string, sectionIndex: number, sectionInfo?: any): Promise<Book[]> => {
    const row = sectionInfo?.row ?? Math.floor(sectionIndex / 4);
    const col = sectionInfo?.col ?? sectionIndex % 4;
    const position = sectionIndex + 1;
    const priority = sectionInfo?.priority ?? 0.5;
    
    const sectionContext = `\n\nThis is section ${position} of 12 (row ${row + 1}, column ${col + 1}) with priority ${priority.toFixed(2)}. 
    Focus only on the books visible in this specific section. 
    This section has 10% overlap with neighboring sections for better accuracy.
    ${priority > 0.7 ? 'HIGH PRIORITY: This is a center section - scan very carefully!' : ''}
    Look carefully at book spines, even partially visible ones.`;
    
    // For now, use the full image - sections aren't being cropped properly
    // The AI prompt context will tell it which area to focus on
    return await scanImageWithAI(imageDataURL, sectionContext);
  };

  const removeDuplicateBooks = (allBooks: Book[]): Book[] => {
    const uniqueBooks: Book[] = [];
    
    for (const book of allBooks) {
      let isDuplicate = false;
      
      // Check against all existing unique books
      for (const existingBook of uniqueBooks) {
        // Multiple duplicate detection methods
        const title1 = book.title.toLowerCase().trim();
        const title2 = existingBook.title.toLowerCase().trim();
        
        // 1. Exact match
        if (title1 === title2) {
          isDuplicate = true;
          break;
        }
        
        // 2. Very similar titles (70%+ similarity) - more aggressive
        if (isSimilarTitle(title1, title2)) {
          isDuplicate = true;
          break;
        }
        
        // 3. One title contains the other (for partial matches) - more aggressive
        if (title1.includes(title2) && title2.length > 2) {
          isDuplicate = true;
          break;
        }
        if (title2.includes(title1) && title1.length > 2) {
          isDuplicate = true;
          break;
        }
        
        // 4. Same author and very similar title - more aggressive
        if (book.author === existingBook.author && 
            book.author !== 'Unknown' && 
            book.author !== 'Unknown Author' &&
            calculateSimilarity(title1, title2) > 0.5) { // Lowered from 0.6 to 0.5
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        uniqueBooks.push(book);
      }
    }
    
    console.log(`🔄 Removed ${allBooks.length - uniqueBooks.length} duplicate books (${allBooks.length} → ${uniqueBooks.length})`);
    return uniqueBooks;
  };

  const isSimilarTitle = (title1: string, title2: string): boolean => {
    // More aggressive similarity detection
    const words1 = title1.split(' ').filter(w => w.length > 0);
    const words2 = title2.split(' ').filter(w => w.length > 0);
    
    // If word count difference is too large, not similar
    if (Math.abs(words1.length - words2.length) > 2) return false;
    
    let matches = 0;
    for (const word1 of words1) {
      for (const word2 of words2) {
        // Exact word match
        if (word1 === word2) {
          matches++;
          break;
        }
        // Partial word match (for OCR errors)
        if (word1.length > 3 && word2.length > 3) {
          if (word1.includes(word2) || word2.includes(word1)) {
            matches += 0.5;
            break;
          }
        }
      }
    }
    
    const similarity = matches / Math.max(words1.length, words2.length);
    return similarity >= 0.7; // 70% similarity threshold (more aggressive)
  };

  const analyzeBookWithChatGPT = async (book: Book): Promise<Book> => {
    try {
      console.log(`🧠 Analyzing book with ChatGPT: "${book.title}" by "${book.author}"`);
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5',
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
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices[0].message.content.trim();
      
      // Clean up JSON if needed
      let jsonContent = content;
      if (content.includes('```json')) {
        jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }
      
      const analysis = JSON.parse(jsonContent);
      
      if (analysis.isValid) {
        console.log(`✅ ChatGPT validated: "${book.title}" → "${analysis.title}" by ${analysis.author} (${analysis.reason})`);
        return {
          title: analysis.title,
          author: analysis.author,
          confidence: analysis.confidence,
          isbn: book.isbn || ''
        };
      } else {
        console.log(`❌ ChatGPT rejected: "${book.title}" by ${book.author} (${analysis.reason})`);
        return { ...book, confidence: 'low' };
      }
      
    } catch (error) {
      console.log(`Error analyzing book "${book.title}":`, error);
      return book; // Return original if analysis fails
    }
  };

  const calculateSimilarity = (str1: string, str2: string): number => {
    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);
    
    let matches = 0;
    for (const word1 of words1) {
      for (const word2 of words2) {
        if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
          matches++;
          break;
        }
      }
    }
    
    return matches / Math.max(words1.length, words2.length);
  };

  const validateAndFixBook = (book: Book): Book | null => {
    let { title, author, confidence } = book;
    
    // REJECT OBVIOUSLY FAKE BOOKS IMMEDIATELY
    const fakeAuthorPatterns = [
      'unknown author', 
      'john doe',
      'jane doe',
      'unknown',
      'duel without end',  // Clearly not a person's name
      'according to queeneys',  // This seems to be a title
    ];
    
    if (author && fakeAuthorPatterns.some(pattern => author.toLowerCase().includes(pattern))) {
      console.log(`❌ Rejecting fake book: "${title}" by "${author}"`);
      return null; // Return null to filter it out
    }
    
    // Fix common title/author confusion - be MORE aggressive
    if (title && author) {
      const titleWords = title.toLowerCase().split(/\s+/);
      const authorWords = author.toLowerCase().split(/\s+/);
      
      // Check if they're swapped by looking for book title indicators
      const bookTitleIndicators = ['the', 'of', 'and', 'in', 'on', 'at', 'for', 'with', 'a', 'an', 'how', 'why', 'what', 'when', 'where'];
      const looksLikeBookTitle = (text: string) => {
        const words = text.toLowerCase().split(/\s+/);
        return words.some(word => bookTitleIndicators.includes(word));
      };
      
      const looksLikePersonName = (text: string) => {
        const words = text.toLowerCase().split(/\s+/);
        // Person names typically: 2-3 words, starts with capital letters, no title indicators
        return words.length >= 2 && words.length <= 3 && 
               !looksLikeBookTitle(text) &&
               words.every(word => !bookTitleIndicators.includes(word));
      };
      
      // Swap if title looks like a person's name AND author looks like a book title
      if (looksLikePersonName(title) && looksLikeBookTitle(author)) {
        console.log(`🔄 Swapping title/author: "${title}" ↔ "${author}"`);
        [title, author] = [author, title];
      }
      
      // Swap if author looks like a person's name but is shorter than title (suspicious)
      if (looksLikePersonName(author) && !looksLikePersonName(title) && title.length > author.length + 5) {
        console.log(`🔄 Swapping title/author: "${title}" ↔ "${author}"`);
        [title, author] = [author, title];
      }
    }
    
    // Clean up titles
    if (title) {
      title = title.trim();
      // Remove common publisher prefixes
      title = title.replace(/^(Penguin|Random House|HarperCollins|Simon & Schuster|Macmillan|Hachette|Scholastic|Disney|Marvel|DC Comics)\s*/i, '');
      // Remove series numbers at the end
      title = title.replace(/\s*#\d+$/, '').replace(/\s*Vol\.\s*\d+$/i, '');
    }
    
    // Clean up authors
    if (author && author !== 'Unknown') {
      author = author.trim();
      // Remove common suffixes
      author = author.replace(/\s*(Jr\.|Sr\.|III|IV|V)$/i, '');
      
      // Fix obvious OCR errors
      author = author.replace(/owmen/gi, 'women');
      
      // Only mark as unknown if it's clearly the problematic pattern
      if (author.toLowerCase().includes('controlling')) {
        author = 'Unknown Author';
      }
    }
    
    // Validate confidence based on content quality
    if (confidence === 'high' && (!title || title.length < 2)) {
      confidence = 'medium';
    }
    if (confidence === 'medium' && (!title || title.length < 3)) {
      confidence = 'low';
    }
    
    // BE STRICT BUT REALISTIC WITH HIGH CONFIDENCE - only downgrade obvious errors
    if (confidence === 'high') {
      // Only downgrade if title is extremely short (under 2 chars) or author is clearly fake
      if (title.replace(/\s+/g, '').length < 2) {
        confidence = 'medium';
      }
      // Downgrade if author is clearly fake (John Doe, etc)
      if (author && author.toLowerCase().includes('john doe')) {
        console.log(`⚠️ Downgrading "${title}" by "${author}" - fake author`);
        confidence = 'low';
      }
    }
    
    return { title, author: author || 'Unknown Author', confidence, isbn: book.isbn || '' };
  };

  const filterBooksByConfidence = (books: Book[]): Book[] => {
    return books.filter(book => {
      // Only reject the specific problematic patterns
      if (book.author && (
        book.author.toLowerCase().includes('controlling') ||
        book.author.toLowerCase().includes('owmen')
      )) {
        return false;
      }
      
      // Keep high confidence books
      if (book.confidence === 'high') return true;
      
      // Keep medium confidence books if title is substantial
      if (book.confidence === 'medium' && book.title.length >= 3) return true;
      
      // Keep low confidence books if title is substantial
      if (book.confidence === 'low' && book.title.length >= 5) return true;
      
      return false;
    });
  };

  const sortBooksByConfidence = (books: Book[]): Book[] => {
    return books.sort((a, b) => {
      const confidenceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
      const aOrder = confidenceOrder[a.confidence as keyof typeof confidenceOrder] || 0;
      const bOrder = confidenceOrder[b.confidence as keyof typeof confidenceOrder] || 0;
      
      // Sort by confidence (high to low)
      if (aOrder !== bOrder) {
        return bOrder - aOrder;
      }
      
      // If same confidence, sort by title length (longer titles first)
      return b.title.length - a.title.length;
    });
  };

  const performScanPass = async (imageDataURL: string, sectionsX: number, sectionsY: number, scanId?: string): Promise<{ books: Book[] }> => {
    console.log(`🔍 Starting ${sectionsX}x${sectionsY} scanning with adaptive overlapping sections...`);
    
    const allBooks: Book[] = [];
    const totalSections = sectionsX * sectionsY;
    const overlapPercentage = 10; // 10% overlap - just enough to catch books on borders
    
    // Create adaptive overlapping sections for better coverage
    const sections: Array<{ x: number; y: number; width: number; height: number; row: number; col: number; priority: number }> = [];
    
    for (let row = 0; row < sectionsY; row++) {
      for (let col = 0; col < sectionsX; col++) {
        // Calculate overlap offset
        const xOverlap = col > 0 ? (overlapPercentage / 100) * (1 / sectionsX) * 100 : 0;
        const yOverlap = row > 0 ? (overlapPercentage / 100) * (1 / sectionsY) * 100 : 0;
        
        // Adaptive sizing based on position (center sections get more attention)
        const centerX = sectionsX / 2;
        const centerY = sectionsY / 2;
        const distanceFromCenter = Math.sqrt(Math.pow(col - centerX, 2) + Math.pow(row - centerY, 2));
        const maxDistance = Math.sqrt(Math.pow(centerX, 2) + Math.pow(centerY, 2));
        const priority = 1 - (distanceFromCenter / maxDistance); // Higher priority for center sections
        
        // Adjust section size based on priority (center sections are slightly larger)
        const sizeMultiplier = 0.8 + (priority * 0.4); // Range: 0.8 to 1.2
        
        sections.push({
          x: Math.max(0, (col / sectionsX) * 100 - xOverlap),
          y: Math.max(0, (row / sectionsY) * 100 - yOverlap),
          width: Math.min(100, (1 / sectionsX) * 100 * sizeMultiplier + xOverlap),
          height: Math.min(100, (1 / sectionsY) * 100 * sizeMultiplier + yOverlap),
          row,
          col,
          priority
        });
      }
    }

    // Sort sections by priority (center sections first)
    sections.sort((a, b) => b.priority - a.priority);

    // Process each section with improved context (center sections first)
    for (let i = 0; i < sections.length; i++) {
      // Update progress in notification
      if (scanId) {
        setCurrentScan(prev => {
          if (prev && prev.id === scanId) {
            return {
              ...prev,
              progress: { current: i + 1, total: totalSections }
            };
          }
          return prev;
        });
      }
      
      try {
        const sectionBooks = await scanImageSection(imageDataURL, i, sections[i]);
        allBooks.push(...sectionBooks);
        console.log(`✅ Section ${i + 1}/${totalSections} (Row ${sections[i].row + 1}, Col ${sections[i].col + 1}) [Priority: ${sections[i].priority.toFixed(2)}]: Found ${sectionBooks.length} books`);
        if (sectionBooks.length > 0) {
          console.log(`   Books: ${sectionBooks.slice(0, 3).map(b => `"${b.title}"`).join(', ')}${sectionBooks.length > 3 ? '...' : ''}`);
        }
      } catch (error) {
        console.error(`❌ Section ${i + 1} failed:`, error);
      }
    }

    // SIMPLIFIED POST-SCANNING LOGIC WITH CHATGPT ANALYSIS
    console.log(`📚 Raw books detected: ${allBooks.length}`);
    
    // Step 1: Basic cleanup - filter out fake books
    const cleanedBooks = allBooks
      .map(book => validateAndFixBook(book))
      .filter((book): book is Book => book !== null);
    console.log(`🧹 After cleanup: ${cleanedBooks.length}`);
    
    // Step 2: Remove duplicates BEFORE ChatGPT analysis (save API calls)
    const uniqueBooks = removeDuplicateBooks(cleanedBooks);
    console.log(`🔄 After duplicate removal: ${uniqueBooks.length}`);
    
    // Step 3: ChatGPT analysis ONLY for questionable books (save time & money!)
    console.log(`🧠 Analyzing ${uniqueBooks.length} unique books with ChatGPT...`);
    const analyzedBooks = [];
    
    for (let i = 0; i < uniqueBooks.length; i++) {
      const book = uniqueBooks[i];
      
      // ONLY send to ChatGPT if it needs validation (low confidence, suspicious patterns)
      const needsValidation = 
        book.confidence === 'low' || 
        !book.author || 
        book.author === 'Unknown' ||
        book.title.length < 3 ||
        book.title.split(' ').length === 1; // Single word titles
      
      if (!needsValidation) {
        // High confidence books with clear titles/authors don't need ChatGPT
        analyzedBooks.push(book);
        continue;
      }
      
      console.log(`🔍 Validating book ${i + 1}/${uniqueBooks.length}: "${book.title}" by ${book.author}`);
      
      try {
        const analyzedBook = await analyzeBookWithChatGPT(book);
        analyzedBooks.push(analyzedBook);
        
        // Reduced delay to speed things up
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.log(`Error analyzing book "${book.title}":`, error);
        analyzedBooks.push(book); // Keep original if analysis fails
      }
    }
    
    // Step 4: Filter out invalid books (confidence = 'low' from ChatGPT rejection)
    const validBooks = analyzedBooks.filter(book => book.confidence !== 'low');
    console.log(`✅ After ChatGPT validation: ${validBooks.length}`);
    
    // Step 5: Final duplicate removal (ChatGPT might have created new duplicates)
    const finalUniqueBooks = removeDuplicateBooks(validBooks);
    console.log(`🔄 Final duplicate removal: ${finalUniqueBooks.length}`);
    
    // Step 6: Sort by confidence
    const sortedBooks = sortBooksByConfidence(finalUniqueBooks);
    
    console.log(`📚 FINAL RESULT: ${sortedBooks.length} books`);
    return { books: sortedBooks };
  };

  const addImageToQueue = (uri: string) => {
    const scanId = Date.now().toString();
    const newScanItem = {
      id: scanId,
      uri,
      status: 'pending' as const
    };
    
    console.log(`📷 Adding image to scan queue: ${scanId}`);
    
    setScanQueue(prev => {
      const updatedQueue = [...prev, newScanItem];
      
      // Start processing if this is the first item in queue
      if (prev.length === 0) {
        console.log('🚀 Starting queue processing...');
        setTimeout(() => processNextInQueue(updatedQueue), 100);
      }
      
      return updatedQueue;
    });
    
    setShowScanNotification(true);
    
    // Navigate back to library immediately
    console.log('🔄 Navigating back to library...');
    setShowScanner(false);
    setShowLibrary(true);
    
    console.log(`📷 Added image to scan queue: ${scanId}`);
  };

  const processNextInQueue = async (queue?: Array<{id: string, uri: string, status: 'pending' | 'processing' | 'completed' | 'failed'}>) => {
    const currentQueue = queue || scanQueue;
    const nextItem = currentQueue.find(item => item.status === 'pending');
    
    console.log(`🔍 Looking for next item in queue. Queue length: ${currentQueue.length}`);
    
    if (!nextItem) {
      console.log('❌ No pending items in queue');
      return;
    }
    
    console.log(`🎯 Processing item: ${nextItem.id}`);

    try {
      // Update queue status
      setScanQueue(prev => prev.map(item => 
        item.id === nextItem.id ? { ...item, status: 'processing' } : item
      ));

      // Always use 1 section (whole image scan) for speed and accuracy
      const sectionsX = 1;
      const sectionsY = 1;

      // Set current scan for notification
      setCurrentScan({
        id: nextItem.id,
        uri: nextItem.uri,
        progress: { current: 0, total: selectedSections }
      });

      console.log('🔄 Processing queued image...');
      const imageDataURL = await convertImageToBase64(nextItem.uri);
      
      console.log(`🤖 Scanning image with AI (whole image, single pass)...`);
      const scanResults = await performScanPass(imageDataURL, sectionsX, sectionsY, nextItem.id);
      
      const newBooks = scanResults.books.map(book => ({
        ...book,
        author: book.author || 'Unknown Author',
        isbn: book.isbn || '',
      }));

      if (newBooks.length > 0 && user) {
        const updatedBooks = [...books, ...newBooks];
        setBooks(updatedBooks);
        await AsyncStorage.setItem(`books_${user.uid}`, JSON.stringify(updatedBooks));

        const newPhoto: Photo = {
          id: nextItem.id,
          uri: nextItem.uri,
          books: newBooks,
          timestamp: Date.now(),
        };
        
        const updatedPhotos = [...photos, newPhoto];
        setPhotos(updatedPhotos);
        await AsyncStorage.setItem(`photos_${user.uid}`, JSON.stringify(updatedPhotos));

        Alert.alert(
          'Scan Complete!',
          `Found ${newBooks.length} books and added them to your library.`,
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert(
          'No Books Found',
          'No books were detected in this image. Try taking a clearer photo or adjusting the angle.',
          [{ text: 'OK' }]
        );
      }

      // Mark as completed
      setScanQueue(prev => prev.map(item => 
        item.id === nextItem.id ? { ...item, status: 'completed' } : item
      ));

    } catch (error) {
      console.error('Error processing queued image:', error);
      
      // Mark as failed
      setScanQueue(prev => prev.map(item => 
        item.id === nextItem.id ? { ...item, status: 'failed' } : item
      ));
      
      Alert.alert(
        'Processing Error',
        'There was an error processing your image. Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      // Clear current scan
      setCurrentScan(null);
      
      // Process next item in queue
      setTimeout(() => {
        setScanQueue(prev => {
          const updatedQueue = prev.filter(item => item.id !== nextItem.id);
          // Hide notification if queue is now empty
          if (updatedQueue.length === 0) {
            setShowScanNotification(false);
          }
          return updatedQueue;
        });
        processNextInQueue();
      }, 1000);
    }
  };

  const handleImageResponse = async (uri: string) => {
    addImageToQueue(uri);
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
          // Add directly to queue - always use 1 section (whole image scan)
          addImageToQueue(photo.uri);
          setShowScanner(false);
          setShowLibrary(true);
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
      
      // Request permissions first
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      console.log('📁 Permission result:', permissionResult);
      
      if (permissionResult.granted === false) {
        Alert.alert('Permission Required', 'Please grant photo library access to upload images.');
        return;
      }

      console.log('📁 Launching image library...');
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      console.log('📁 Image picker result:', result);

      if (!result.canceled && result.assets[0]) {
        console.log('📁 Selected image URI:', result.assets[0].uri);
        // Add directly to queue - always use 1 section (whole image scan)
        addImageToQueue(result.assets[0].uri);
        setShowScanner(false);
        setShowLibrary(true);
      } else {
        console.log('📁 No image selected or picker was canceled');
        Alert.alert('No Image Selected', 'Please select an image to scan.');
      }
    } catch (error) {
      console.error('❌ Error picking image:', error);
      Alert.alert('Image Picker Error', `Failed to pick image: ${error.message}`);
    }
  };


  const startCamera = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Camera Permission', 'Camera permission is required to scan books.');
        return;
      }
    }
    setIsCameraActive(true);
  };

  const stopCamera = () => {
    setIsCameraActive(false);
  };

  const removeBook = (bookToRemove: Book) => {
    Alert.alert(
      'Remove Book',
      `Are you sure you want to remove "${bookToRemove.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (!user) return;
            const updatedBooks = books.filter(book => book.title !== bookToRemove.title);
            setBooks(updatedBooks);
            await AsyncStorage.setItem(`books_${user.uid}`, JSON.stringify(updatedBooks));
          },
        },
      ]
    );
  };

  const searchSimilarBooks = async (bookTitle: string) => {
    try {
      const response = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(bookTitle)}&limit=10`);
      const data = await response.json();
      
      const similarBooks: Book[] = data.docs.map((doc: any) => ({
        title: doc.title || 'Unknown Title',
        author: doc.author_name?.[0] || 'Unknown Author',
        isbn: doc.isbn?.[0] || '',
      }));

      setReplaceOptions(similarBooks);
      setCurrentBookToReplace({ title: bookTitle, author: 'Unknown Author' });
      setShowReplaceModal(true);
    } catch (error) {
      console.error('Error searching similar books:', error);
      Alert.alert('Search Error', 'Failed to search for similar books.');
    }
  };

  const replaceBook = async (oldBook: Book, newBook: Book) => {
    if (!user) return;
    const updatedBooks = books.map(book => 
      book.title === oldBook.title ? newBook : book
    );
    setBooks(updatedBooks);
    await AsyncStorage.setItem(`books_${user.uid}`, JSON.stringify(updatedBooks));
    setShowReplaceModal(false);
  };

  const updateBookAuthor = async (bookToUpdate: Book, newAuthor: string) => {
    if (!user || !newAuthor.trim()) return;
    
    const updatedBook = { ...bookToUpdate, author: newAuthor.trim() };
    const updatedBooks = books.map(book => 
      book.title === bookToUpdate.title && book.author === bookToUpdate.author 
        ? updatedBook 
        : book
    );
    setBooks(updatedBooks);
    await AsyncStorage.setItem(`books_${user.uid}`, JSON.stringify(updatedBooks));
    setEditingBook(null);
    setEditAuthorText('');
  };

  const startEditingAuthor = (book: Book) => {
    setEditingBook(book);
    setEditAuthorText(book.author);
  };

  const getBookCoverUrl = (book: Book): string => {
    // Try multiple cover sources
    if (book.isbn) {
      return `https://covers.openlibrary.org/b/isbn/${book.isbn}-M.jpg`;
    }
    // Fallback to title-based search
    const titleEncoded = encodeURIComponent(book.title);
    return `https://covers.openlibrary.org/b/title/${titleEncoded}-M.jpg`;
  };

  const clearLibrary = () => {
    Alert.alert(
      'Clear Library',
      'Are you sure you want to clear all books and photos? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            if (!user) return;
            setBooks([]);
            setPhotos([]);
            await AsyncStorage.setItem(`books_${user.uid}`, JSON.stringify([]));
            await AsyncStorage.setItem(`photos_${user.uid}`, JSON.stringify([]));
          },
        },
      ]
    );
  };

  const filteredBooks = books.filter(book =>
    book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (book.author && book.author.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const renderScanNotification = () => {
    // Hide notification if queue is empty and no active scan
    if (!showScanNotification || (scanQueue.length === 0 && !currentScan)) return null;

    return (
      <View style={styles.scanNotificationBottom}>
        <View style={styles.scanNotificationContent}>
          <View style={styles.scanNotificationHeader}>
            <Text style={styles.scanNotificationTitle}>
              {currentScan ? 'Scanning Books...' : 'Preparing to scan...'}
            </Text>
            <TouchableOpacity 
              style={styles.scanNotificationClose}
              onPress={() => setShowScanNotification(false)}
            >
              <Text style={styles.scanNotificationCloseText}>×</Text>
            </TouchableOpacity>
          </View>
          
          {currentScan ? (
            <View style={styles.scanProgressContainer}>
              <View style={styles.scanProgressBar}>
                <View 
                  style={[
                    styles.scanProgressFill, 
                    { width: `${(currentScan.progress.current / currentScan.progress.total) * 100}%` }
                  ]} 
                />
              </View>
              <Text style={styles.scanProgressText}>
                Section {currentScan.progress.current} of {currentScan.progress.total}
              </Text>
            </View>
          ) : (
            <View style={styles.scanProgressContainer}>
              <View style={styles.scanProgressBar}>
                <View style={[styles.scanProgressFill, { width: '0%' }]} />
              </View>
              <Text style={styles.scanProgressText}>
                Starting scan...
              </Text>
            </View>
          )}
          
          <View style={styles.scanQueueInfo}>
            <Text style={styles.scanQueueText}>
              {scanQueue.length} image{scanQueue.length !== 1 ? 's' : ''} in queue
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderUserProfile = () => {
    const handleSignOut = async () => {
      Alert.alert(
        'Sign Out',
        'Are you sure you want to sign out?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign Out',
            onPress: async () => {
              setBooks([]);
              setPhotos([]);
              await signOut();
            },
          },
        ]
      );
    };

    return (
      <View style={styles.userProfileContainer}>
        <View style={styles.userProfileContent}>
          <View style={styles.userAvatar}>
            <Text style={styles.userAvatarText}>
              {user?.displayName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}
            </Text>
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{user?.displayName || 'Book Collector'}</Text>
            <Text style={styles.userStats}>{books.length} books • {photos.length} scans</Text>
          </View>
          <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
            <Text style={styles.signOutButtonText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderLibrary = () => {
    return (
      <ScrollView style={styles.libraryContainer}>
        <View style={styles.libraryHeader}>
          <Text style={styles.libraryTitle}>My Library ({books.length} books)</Text>
        </View>

        <View style={styles.actionButtonsContainer}>
          <TouchableOpacity 
            style={styles.addToLibraryButton} 
            onPress={() => {
              console.log('Add Books button pressed');
              setShowScanner(true);
              setShowLibrary(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.addToLibraryButtonText}>Add Books to Library</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.clearLibraryButton} 
            onPress={() => {
              console.log('Clear All button pressed');
              clearLibrary();
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.clearLibraryButtonText}>Clear All</Text>
          </TouchableOpacity>
        </View>

        <TextInput
          style={styles.searchInput}
          placeholder="Search books..."
          value={searchQuery}
          onChangeText={setSearchQuery}
        />

        <View style={styles.booksGrid}>
          {filteredBooks.map((book, index) => (
            <View key={index} style={styles.bookBubble}>
              <Image
                source={{ 
                  uri: getBookCoverUrl(book),
                  cache: 'force-cache'
                }}
                style={styles.bookBubbleImage}
                onError={() => console.log('Failed to load book cover for:', book.title)}
                resizeMode="cover"
              />
              <View style={styles.bookBubbleContent}>
                <Text style={styles.bookBubbleTitle} numberOfLines={2}>
                  {book.title}
                </Text>
                <TouchableOpacity 
                  onPress={() => startEditingAuthor(book)}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.bookBubbleAuthor, 
                    (book.author === 'Unknown Author' || book.author === 'Unknown') && styles.unknownAuthorText
                  ]} numberOfLines={1}>
                    {book.author}
                    {(book.author === 'Unknown Author' || book.author === 'Unknown') && ' (Tap to edit)'}
                  </Text>
                </TouchableOpacity>
                <View style={styles.confidenceIndicator}>
                  <View style={[
                    styles.confidenceDot, 
                    { backgroundColor: book.confidence === 'high' ? '#27ae60' : book.confidence === 'medium' ? '#f39c12' : '#e74c3c' }
                  ]} />
                  <Text style={styles.confidenceText}>
                    {book.confidence === 'high' ? 'High' : book.confidence === 'medium' ? 'Medium' : 'Low'} Confidence
                  </Text>
                </View>
                <View style={styles.bookBubbleActions}>
                  <TouchableOpacity
                    style={[styles.bubbleActionButton, styles.removeButton]}
                    onPress={() => {
                      console.log('Remove book button pressed for:', book.title);
                      removeBook(book);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.bubbleActionButtonText}>Remove</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bubbleActionButton, styles.replaceButton]}
                    onPress={() => {
                      console.log('Replace book button pressed for:', book.title);
                      searchSimilarBooks(book.title);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.bubbleActionButtonText}>Replace</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  const renderSectionSelector = () => {
    if (!showSectionSelector || !selectedImageUri) return null;

    return (
      <Modal visible={showSectionSelector} animationType="none" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Choose Scan Detail</Text>
            <Text style={styles.modalSubtitle}>
              How many sections should we scan? More sections = more accurate but slower.
            </Text>
            
            <View style={styles.sectionOptions}>
              <TouchableOpacity
                style={[styles.sectionOption, selectedSections === 1 && styles.sectionOptionSelected]}
                onPress={() => setSelectedSections(1)}
                activeOpacity={0.7}
              >
                <Text style={[styles.sectionOptionText, selectedSections === 1 && styles.sectionOptionTextSelected]}>
                  1 Section (Whole Image)
                </Text>
                <Text style={styles.sectionOptionSubtext}>Fastest • Best for most photos</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.sectionOption, selectedSections === 4 && styles.sectionOptionSelected]}
                onPress={() => setSelectedSections(4)}
                activeOpacity={0.7}
              >
                <Text style={[styles.sectionOptionText, selectedSections === 4 && styles.sectionOptionTextSelected]}>
                  4 Sections (2x2)
                </Text>
                <Text style={styles.sectionOptionSubtext}>Fast • Good accuracy</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.sectionOption, selectedSections === 12 && styles.sectionOptionSelected]}
                onPress={() => setSelectedSections(12)}
                activeOpacity={0.7}
              >
                <Text style={[styles.sectionOptionText, selectedSections === 12 && styles.sectionOptionTextSelected]}>
                  12 Sections (4x3)
                </Text>
                <Text style={styles.sectionOptionSubtext}>Slow • Maximum detail</Text>
              </TouchableOpacity>
            </View>
            
            <View style={styles.sectionSelectorActions}>
              <TouchableOpacity
                style={styles.sectionSelectorCancel}
                onPress={() => {
                  setShowSectionSelector(false);
                  setSelectedImageUri(null);
                  setShowScanner(true);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.sectionSelectorCancelText}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={styles.sectionSelectorConfirm}
                onPress={() => {
                  if (selectedImageUri) {
                    addImageToQueue(selectedImageUri);
                    setShowSectionSelector(false);
                    setSelectedImageUri(null);
                  }
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.sectionSelectorConfirmText}>Start Scan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  const renderReplaceModal = () => {
    if (!showReplaceModal || !currentBookToReplace) return null;

    return (
      <Modal visible={showReplaceModal} animationType="none" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Replace Book</Text>
            <Text style={styles.modalSubtitle}>
              Replace "{currentBookToReplace.title}" with:
            </Text>
            
            <ScrollView style={styles.modalBookList}>
              {replaceOptions.map((book, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.modalBookOption}
                  onPress={() => {
                    console.log('Modal book option pressed:', book.title);
                    replaceBook(currentBookToReplace, book);
                  }}
                  activeOpacity={0.7}
                >
                  <Image
                    source={{ 
                      uri: getBookCoverUrl(book),
                      cache: 'force-cache'
                    }}
                    style={styles.modalBookCover}
                    onError={() => console.log('Failed to load book cover for:', book.title)}
                    resizeMode="cover"
                  />
                  <View style={styles.modalBookInfo}>
                    <Text style={styles.modalBookTitle} numberOfLines={2}>
                      {book.title}
                    </Text>
                    <Text style={styles.modalBookAuthor} numberOfLines={1}>
                      {book.author}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={() => {
                console.log('Modal cancel button pressed');
                setShowReplaceModal(false);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.modalCancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  const renderEditAuthorModal = () => {
    if (!editingBook) return null;

    return (
      <Modal visible={!!editingBook} animationType="none" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Edit Author</Text>
            <Text style={styles.modalSubtitle}>
              Book: "{editingBook.title}"
            </Text>
            
            <TextInput
              style={styles.modalTextInput}
              placeholder="Author name"
              value={editAuthorText}
              onChangeText={setEditAuthorText}
              autoCapitalize="words"
              autoFocus
            />

            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { flex: 1, marginRight: 10 }]}
                onPress={() => {
                  setEditingBook(null);
                  setEditAuthorText('');
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, { flex: 1 }]}
                onPress={() => {
                  updateBookAuthor(editingBook, editAuthorText);
                }}
                activeOpacity={0.7}
                disabled={!editAuthorText.trim()}
              >
                <Text style={styles.modalButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  if (isProcessing) {
    return (
      <View style={styles.processingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.processingText}>
          Processing section {processingProgress.current}/{processingProgress.total}...
        </Text>
        <Text style={styles.processingSubtext}>
          Analyzing books with AI
        </Text>
      </View>
    );
  }

  const renderScanner = () => {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
        <TouchableOpacity
            style={styles.topLeftBackButton} 
            onPress={() => {
              console.log('Back button pressed');
              setShowScanner(false);
              setShowLibrary(true);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.topLeftBackButtonText}>←</Text>
        </TouchableOpacity>
          <View style={styles.headerContent}>
            <Text style={styles.title}>Add Books to Library</Text>
        <Text style={styles.subtitle}>Scan and catalog your books with ease</Text>
          </View>
      </View>

      <View style={styles.mainContent}>
        {isCameraActive ? (
          <View style={styles.cameraContainer}>
            <CameraView
              ref={setCameraRef}
              style={styles.camera}
              facing={CameraType.back}
            />
            <View style={styles.cameraControls}>
                <TouchableOpacity 
                  style={styles.captureButton} 
                  onPress={() => {
                    console.log('Capture button pressed');
                    takePicture();
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.captureButtonText}>Capture</Text>
              </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.stopButton} 
                  onPress={() => {
                    console.log('Stop button pressed');
                    stopCamera();
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.stopButtonText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.inputOptions}>
              <TouchableOpacity 
                style={styles.primaryButton} 
                onPress={() => {
                  console.log('Start Camera button pressed');
                  startCamera();
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.primaryButtonText}>Start Camera</Text>
            </TouchableOpacity>
              <TouchableOpacity 
                style={styles.secondaryButton} 
                onPress={() => {
                  console.log('Upload Photo button pressed');
                  pickImage();
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.secondaryButtonText}>Upload Photo</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {showLibrary && (
        <>
          {renderUserProfile()}
          {renderLibrary()}
          {renderReplaceModal()}
          {renderEditAuthorModal()}
        </>
      )}
      {showScanner && renderScanner()}
      {renderSectionSelector()}
      {renderScanNotification()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f6f0',
  },
  header: {
    padding: 20,
    paddingTop: 60,
    backgroundColor: '#2c3e50',
    alignItems: 'center',
    borderBottomWidth: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  title: {
    fontSize: 32,
    fontWeight: '300',
    color: '#ecf0f1',
    marginBottom: 8,
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 16,
    color: '#bdc3c7',
    fontStyle: 'italic',
  },
  mainContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
    backgroundColor: '#f8f6f0',
  },
  inputOptions: {
    alignItems: 'center',
    gap: 25,
  },
  primaryButton: {
    backgroundColor: '#34495e',
    paddingHorizontal: 50,
    paddingVertical: 18,
    borderRadius: 30,
    minWidth: 220,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#2c3e50',
  },
  primaryButtonText: {
    color: '#ecf0f1',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  secondaryButton: {
    backgroundColor: '#27ae60',
    paddingHorizontal: 50,
    paddingVertical: 18,
    borderRadius: 30,
    minWidth: 220,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#229954',
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  cameraContainer: {
    flex: 1,
    width: '100%',
  },
  camera: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  cameraControls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 25,
    backgroundColor: '#f8f6f0',
  },
  captureButton: {
    backgroundColor: '#34495e',
    paddingHorizontal: 35,
    paddingVertical: 18,
    borderRadius: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#2c3e50',
  },
  captureButtonText: {
    color: '#ecf0f1',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  stopButton: {
    backgroundColor: '#e74c3c',
    paddingHorizontal: 35,
    paddingVertical: 18,
    borderRadius: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#c0392b',
  },
  stopButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  footer: {
    padding: 25,
    backgroundColor: '#2c3e50',
    borderTopWidth: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  libraryButton: {
    backgroundColor: '#34495e',
    paddingVertical: 18,
    borderRadius: 30,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#2c3e50',
  },
  libraryButtonText: {
    color: '#ecf0f1',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  processingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
  },
  processingText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginTop: 20,
  },
  processingSubtext: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
  },
  userProfileContainer: {
    backgroundColor: '#2c3e50',
    padding: 20,
    paddingTop: 60,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  userProfileContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#34495e',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  userAvatarText: {
    fontSize: 24,
    color: '#ecf0f1',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 22,
    fontWeight: '600',
    color: '#ecf0f1',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  userStats: {
    fontSize: 14,
    color: '#bdc3c7',
    fontStyle: 'italic',
  },
  libraryContainer: {
    flex: 1,
    backgroundColor: '#f8f6f0',
  },
  libraryHeader: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    alignItems: 'center',
  },
  actionButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  userWelcome: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  signOutButton: {
    backgroundColor: '#8E44AD',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 15,
  },
  signOutButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  headerContent: {
    flex: 1,
    alignItems: 'center',
  },
  userInfo: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  signOutButtonSmall: {
    backgroundColor: '#8E44AD',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    position: 'absolute',
    top: 60,
    right: 20,
  },
  signOutButtonTextSmall: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  libraryTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  addToLibraryButton: {
    backgroundColor: '#27ae60',
    paddingHorizontal: 25,
    paddingVertical: 15,
    borderRadius: 25,
    flex: 1,
    marginRight: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#229954',
  },
  addToLibraryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  clearLibraryButton: {
    backgroundColor: '#e74c3c',
    paddingHorizontal: 25,
    paddingVertical: 15,
    borderRadius: 25,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#c0392b',
  },
  clearLibraryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  searchInput: {
    backgroundColor: '#fff',
    paddingHorizontal: 15,
    paddingVertical: 12,
    margin: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    fontSize: 16,
  },
  booksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 10,
    justifyContent: 'space-between',
  },
  bookBubble: {
    width: (screenWidth - 40) / 2,
    backgroundColor: '#fff',
    borderRadius: 15,
    marginBottom: 15,
    padding: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  bookBubbleImage: {
    width: 80,
    height: 120,
    borderRadius: 8,
    marginBottom: 10,
  },
  bookBubbleContent: {
    alignItems: 'center',
    flex: 1,
  },
  bookBubbleTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
    marginBottom: 4,
  },
  bookBubbleAuthor: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    marginBottom: 10,
  },
  bookBubbleActions: {
    flexDirection: 'row',
    gap: 8,
  },
  bubbleActionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    flex: 1,
  },
  removeButton: {
    backgroundColor: '#FF3B30',
  },
  replaceButton: {
    backgroundColor: '#007AFF',
  },
  bubbleActionButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  backButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    margin: 20,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    width: screenWidth * 0.9,
    maxHeight: screenHeight * 0.8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 10,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  modalBookList: {
    maxHeight: 400,
  },
  modalBookOption: {
    flexDirection: 'row',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    alignItems: 'center',
  },
  modalBookCover: {
    width: 50,
    height: 75,
    borderRadius: 5,
    marginRight: 15,
  },
  modalBookInfo: {
    flex: 1,
  },
  modalBookTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  modalBookAuthor: {
    fontSize: 14,
    color: '#666',
  },
  modalCancelButton: {
    backgroundColor: '#8E44AD',
    paddingVertical: 15,
    borderRadius: 25,
    alignItems: 'center',
    marginTop: 20,
  },
  modalCancelButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  // Section selector styles
  sectionOptions: {
    marginVertical: 20,
  },
  sectionOption: {
    backgroundColor: '#f8f9fa',
    padding: 20,
    borderRadius: 15,
    marginBottom: 15,
    borderWidth: 2,
    borderColor: '#e9ecef',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionOptionSelected: {
    backgroundColor: '#e3f2fd',
    borderColor: '#2196f3',
  },
  sectionOptionText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 5,
  },
  sectionOptionTextSelected: {
    color: '#1976d2',
  },
  sectionOptionSubtext: {
    fontSize: 14,
    color: '#7f8c8d',
    fontStyle: 'italic',
  },
  sectionSelectorActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  sectionSelectorCancel: {
    backgroundColor: '#95a5a6',
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 25,
    flex: 0.45,
    alignItems: 'center',
  },
  sectionSelectorCancelText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  sectionSelectorConfirm: {
    backgroundColor: '#27ae60',
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 25,
    flex: 0.45,
    alignItems: 'center',
  },
  sectionSelectorConfirmText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  // Scan notification styles
  scanNotificationBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#2c3e50',
    paddingHorizontal: 20,
    paddingVertical: 15,
    paddingBottom: 30, // Extra padding for safe area
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    borderTopWidth: 1,
    borderTopColor: '#34495e',
  },
  scanNotificationContent: {
    flex: 1,
  },
  scanNotificationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  scanNotificationTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ecf0f1',
    letterSpacing: 0.5,
  },
  scanNotificationClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#34495e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanNotificationCloseText: {
    color: '#ecf0f1',
    fontSize: 18,
    fontWeight: 'bold',
  },
  scanProgressContainer: {
    marginBottom: 8,
  },
  scanProgressBar: {
    height: 6,
    backgroundColor: '#34495e',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 5,
  },
  scanProgressFill: {
    height: '100%',
    backgroundColor: '#27ae60',
    borderRadius: 3,
  },
  scanProgressText: {
    fontSize: 12,
    color: '#bdc3c7',
    textAlign: 'center',
  },
  scanQueueInfo: {
    alignItems: 'center',
  },
  scanQueueText: {
    fontSize: 11,
    color: '#95a5a6',
    fontStyle: 'italic',
  },
  // Confidence indicator styles
  confidenceIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  confidenceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  confidenceText: {
    fontSize: 10,
    color: '#666',
    fontWeight: '500',
  },
  // Top left back button styles
  topLeftBackButton: {
    position: 'absolute',
    top: 50,
    left: 20,
    zIndex: 10,
    backgroundColor: 'rgba(52, 73, 94, 0.9)',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  topLeftBackButtonText: {
    color: '#ecf0f1',
    fontSize: 24,
    fontWeight: 'bold',
  },
  // Edit author modal styles
  modalTextInput: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#dee2e6',
    borderRadius: 10,
    paddingHorizontal: 15,
    paddingVertical: 12,
    fontSize: 16,
    marginVertical: 20,
    minHeight: 50,
  },
  modalButtonRow: {
    flexDirection: 'row',
    marginTop: 20,
  },
  modalButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 15,
    borderRadius: 25,
    alignItems: 'center',
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  unknownAuthorText: {
    color: '#e74c3c',
    fontStyle: 'italic',
    textDecorationLine: 'underline',
  },
});

// Show Login if not authenticated, otherwise show the app
const AppWithAuth: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8f6f0' }}>
        <ActivityIndicator size="large" color="#2c3e50" />
      </View>
    );
  }

  if (!user) {
    return <LoginScreen onAuthSuccess={() => {}} />;
  }

  return (
    <NavigationContainer>
      <TabNavigator />
    </NavigationContainer>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <AppWithAuth />
    </AuthProvider>
  );
}
