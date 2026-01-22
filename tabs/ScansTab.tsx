import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
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
  Keyboard,
  GestureResponderEvent
} from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/SimpleAuthContext';
import { useScanning } from '../contexts/ScanningContext';
import { Book, Photo, Folder } from '../types/BookTypes';
import {
  loadBooksFromSupabase,
  loadPhotosFromSupabase,
  saveBookToSupabase,
  savePhotoToSupabase,
  deletePhotoFromSupabase,
  deleteBookFromSupabase,
} from '../services/supabaseSync';
import { canUserScan, getUserScanUsage, incrementScanCount, ScanUsage, isSubscriptionUIHidden } from '../services/subscriptionService';
import { ScanLimitBanner, ScanLimitBannerRef } from '../components/ScanLimitBanner';
import { UpgradeModal } from '../components/UpgradeModal';

// Helper to read env vars in both development and production builds
const getEnvVar = (key: string): string => {
  return Constants.expoConfig?.extra?.[key] || 
         Constants.manifest?.extra?.[key] || 
         process.env[key] || 
         '';
};

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
  const [dimensions, setDimensions] = useState(Dimensions.get('window'));
  
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setDimensions(window);
    });
    return () => subscription?.remove();
  }, []);
  
  const screenWidth = dimensions.width || 375; // Fallback to default width
  const screenHeight = dimensions.height || 667; // Fallback to default height
  
  const styles = useMemo(() => getStyles(screenWidth), [screenWidth]);
  
  const { scanProgress, setScanProgress, updateProgress } = useScanning();
  
  // Camera states
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0); // Zoom level (0 = no zoom, 1 = max zoom)
  const lastZoomRef = useRef(0); // Track last zoom for pinch gesture
  
  // Processing states
  const [isProcessing, setIsProcessing] = useState(false);
  const [scanQueue, setScanQueue] = useState<ScanQueueItem[]>([]);
  const [currentScan, setCurrentScan] = useState<{id: string, uri: string, progress: {current: number, total: number}} | null>(null);
  
  // Ref to track latest totalScans to avoid stale closure issues
  const totalScansRef = useRef<number>(0);
  
  // Ref to track which URIs are currently being processed to prevent duplicates
  const processingUrisRef = useRef<Set<string>>(new Set());
  
  // Ref to refresh scan limit banner after scans
  const scanLimitBannerRef = useRef<ScanLimitBannerRef>(null);
  
  // Ref for search debounce timeout
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Data states  
  const [pendingBooks, setPendingBooks] = useState<Book[]>([]);
  const [approvedBooks, setApprovedBooks] = useState<Book[]>([]);
  const [rejectedBooks, setRejectedBooks] = useState<Book[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  
  // Background scan jobs
  const [backgroundScanJobs, setBackgroundScanJobs] = useState<Map<string, { jobId: string, scanId: string, photoId: string }>>(new Map());
  
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

  // Edit mode states for pending books
  const [showEditActions, setShowEditActions] = useState(false);
  const [showSwitchCoversModal, setShowSwitchCoversModal] = useState(false);
  const [showSwitchBookModal, setShowSwitchBookModal] = useState(false);
  const [coverSearchResults, setCoverSearchResults] = useState<Array<{googleBooksId: string, coverUrl?: string}>>([]);
  const [isLoadingCovers, setIsLoadingCovers] = useState(false);
  const [bookSearchResults, setBookSearchResults] = useState<Array<{googleBooksId: string, title: string, author?: string, coverUrl?: string}>>([]);
  const [isSearchingBooks, setIsSearchingBooks] = useState(false);
  const [bookSearchQuery, setBookSearchQuery] = useState('');

  // Smart search for editing incomplete books: auto-search as user types title/author
  // Show caption modal when image is ready (either from camera or picker)
  // Start scanning immediately when image is ready, show caption modal after
  const handleImageSelected = async (uri: string) => {
    console.log('🖼️ Image selected, checking scan limit...', uri);
    
    // Check if user can scan
    if (user) {
      const canScan = await canUserScan(user.uid);
      if (!canScan) {
        // Limit reached, show upgrade modal (only if subscription UI is not hidden)
        if (!isSubscriptionUIHidden()) {
          Alert.alert(
            'Scan Limit Reached',
            'You\'ve used all 5 free scans this month. Upgrade to Pro for unlimited scans!',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Upgrade', onPress: () => setShowUpgradeModal(true) },
            ]
          );
        }
        return;
      }
    }
    
    console.log('🖼️ Scan limit check passed, starting scan...');
    
    // Generate unique scanId with counter to prevent duplicates when multiple images selected quickly
    scanIdCounterRef.current += 1;
    const scanId = `${Date.now()}_${scanIdCounterRef.current}_${Math.random().toString(36).substring(2, 9)}`;
    currentScanIdRef.current = scanId;
    scanCaptionsRef.current.set(scanId, ''); // Initialize with empty caption
    
    // Set up single image for caption modal
    setPendingImages([{ uri, scanId }]);
    setCurrentImageIndex(0);
    setPendingImageUri(uri);
    currentScanIdRef.current = scanId;
    setCaptionText('');
    
    // Start scanning IMMEDIATELY - this will trigger the notification
    addImageToQueue(uri, undefined, scanId);
    
    // Refresh scan usage after starting scan
    if (user) {
      loadScanUsage();
    }
    
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
  // Store multiple pending images for caption modal navigation
  const [pendingImages, setPendingImages] = useState<Array<{uri: string, scanId: string}>>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState<number>(0);
  // Store the scanId for the current pending image so we can update its caption later
  const currentScanIdRef = React.useRef<string | null>(null);
  // Store caption for each scan (keyed by scanId)
  const scanCaptionsRef = React.useRef<Map<string, string>>(new Map());
  // Counter to ensure unique scan IDs even when multiple images selected at once
  const scanIdCounterRef = React.useRef<number>(0);
  
  // Folder management state
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Subscription and scan limit state
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [scanUsage, setScanUsage] = useState<ScanUsage | null>(null);
  const [canScan, setCanScan] = useState<boolean>(true); // Track if user can scan

  // Orientation state for camera tip
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  
  // Scroll tracking for sticky toolbar
  const scrollY = React.useRef(new Animated.Value(0)).current;

  // Create a memoized photo map for fast lookups
  const photoMap = useMemo(() => {
    const map = new Map<string, Photo>();
    photos.forEach(photo => {
      if (photo.id) {
        map.set(photo.id, photo);
      }
    });
    return map;
  }, [photos]);

  // Group and sort pending books by photo, then by author's last name
  const groupedPendingBooks = useMemo(() => {
    const extractLastName = (author?: string): string => {
      if (!author) return '';
      const firstAuthor = author.split(/,|&| and /i)[0].trim();
      const parts = firstAuthor.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '';
      return parts[parts.length - 1].replace(/,/, '').toLowerCase();
    };
    
    // Create a map of book IDs to photo IDs by checking which photo contains each book
    // Map ALL books (not just pending) to ensure we can find them even if status changes
    const bookToPhotoMap = new Map<string, string>();
    photos.forEach(photo => {
      photo.books.forEach(book => {
        if (book.id) {
          bookToPhotoMap.set(book.id, photo.id);
        }
      });
    });
    
    // Group books by photo - ONLY include books that are in the pendingBooks state
    // This prevents old photos with pending books from showing up
    const grouped = new Map<string, Book[]>();
    
    // Create a set of pending book IDs for fast lookup
    const pendingBookIds = new Set(pendingBooks.map(book => book.id).filter((id): id is string => id !== undefined));
    
    // Only get books from photos that are actually in the pendingBooks state
    photos.forEach(photo => {
      // Filter to only include books that are in pendingBooks state AND have pending/incomplete status
      const pendingBooksFromPhoto = photo.books.filter(book => {
        const isPending = book.status === 'pending' || book.status === 'incomplete';
        const isInPendingState = book.id && pendingBookIds.has(book.id);
        return isPending && isInPendingState;
      });
      
      if (pendingBooksFromPhoto.length > 0) {
        grouped.set(photo.id, pendingBooksFromPhoto);
      }
    });
    
    // Add any pending books that aren't in any photo yet (shouldn't happen, but safety check)
    pendingBooks.forEach(book => {
      // Check if this book is already in a group from photos
      let alreadyInGroup = false;
      for (const [photoId, books] of grouped.entries()) {
        if (books.some(b => b.id === book.id)) {
          alreadyInGroup = true;
          break;
        }
      }
      
      if (!alreadyInGroup) {
        // Try to find which photo this book came from
        let photoId = 'unknown';
        if (book.id) {
          photoId = bookToPhotoMap.get(book.id) || 'unknown';
          // Fallback: search all photos if not found in map
          if (photoId === 'unknown') {
            for (const photo of photos) {
              if (photo.books.some(b => b.id === book.id)) {
                photoId = photo.id;
                break;
              }
            }
          }
        }
        if (!grouped.has(photoId)) {
          grouped.set(photoId, []);
        }
        grouped.get(photoId)!.push(book);
      }
    });
    
    // Sort books within each group by author
    const sortedGroups: Array<{ photoId: string; books: Book[] }> = [];
    grouped.forEach((books, photoId) => {
      const sorted = books.sort((a, b) => {
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
      sortedGroups.push({ photoId, books: sorted });
    });
    
    return sortedGroups;
  }, [pendingBooks, photos]);

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
      // Load data immediately on mount/user change
      // Don't await - let it load in background so UI is responsive
      // CRITICAL: Load data immediately on first mount to ensure books and buttons work
      console.log('🔄 User changed, loading data immediately...');
      loadUserData().catch(error => {
        console.error('❌ Error loading user data:', error);
        // On error, still try to load from AsyncStorage as fallback
        loadUserDataFromStorage().catch(e => {
          console.error('❌ Error loading from AsyncStorage fallback:', e);
        });
      });
      loadScanUsage().catch(error => {
        console.error('❌ Error loading scan usage:', error);
        // Default to allowing scans if we can't load usage
        setCanScan(true);
      });
    } else {
      // Clear data when user signs out
      setPendingBooks([]);
      setApprovedBooks([]);
      setRejectedBooks([]);
      setPhotos([]);
      setScanUsage(null);
      setCanScan(true);
    }
  }, [user?.uid]); // Use user.uid instead of user object to catch sign-in/out events
  
  // Fallback function to load from AsyncStorage if Supabase fails
  const loadUserDataFromStorage = async () => {
    if (!user) return;
    
    try {
      console.log('📥 Loading user data from AsyncStorage fallback...');
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      const [savedPending, savedApproved, savedRejected, savedPhotos] = await Promise.all([
        AsyncStorage.getItem(userPendingKey),
        AsyncStorage.getItem(userApprovedKey),
        AsyncStorage.getItem(userRejectedKey),
        AsyncStorage.getItem(userPhotosKey),
      ]);
      
      if (savedPending) {
        try {
          const parsed = JSON.parse(savedPending);
          setPendingBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} pending books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing pending books:', e);
        }
      }
      if (savedApproved) {
        try {
          const parsed = JSON.parse(savedApproved);
          setApprovedBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} approved books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing approved books:', e);
        }
      }
      if (savedRejected) {
        try {
          const parsed = JSON.parse(savedRejected);
          setRejectedBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} rejected books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing rejected books:', e);
        }
      }
      if (savedPhotos) {
        try {
          const parsed = JSON.parse(savedPhotos);
          setPhotos(parsed);
          console.log(`✅ Loaded ${parsed.length} photos from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing photos:', e);
        }
      }
    } catch (error) {
      console.error('Error loading from AsyncStorage:', error);
    }
  };

  // Load scan usage when user changes
  const loadScanUsage = async () => {
    if (!user) {
      setCanScan(true); // Allow scanning if no user (shouldn't happen, but safe fallback)
      return;
    }
    
    try {
      // Add timeout to prevent hanging
      const usagePromise = getUserScanUsage(user.uid);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Scan usage load timeout')), 5000)
      );
      
      const usage = await Promise.race([usagePromise, timeoutPromise]) as ScanUsage | null;
      setScanUsage(usage);
      
      // Determine if user can scan based on usage data
      // Only disable if user is free tier AND has used all 5 scans
      if (usage) {
        const isFreeTier = usage.subscriptionTier === 'free';
        const hasScansRemaining = usage.scansRemaining !== null && usage.scansRemaining > 0;
        const userCanScan = !isFreeTier || hasScansRemaining;
        setCanScan(userCanScan);
        
        console.log(`📊 Scan usage: tier=${usage.subscriptionTier}, scans=${usage.monthlyScans}/${usage.monthlyLimit}, remaining=${usage.scansRemaining}, canScan=${userCanScan}`);
      } else {
        // If we can't get usage, default to allowing scans (don't block users)
        console.warn('⚠️ Could not load scan usage, allowing scans by default');
        setCanScan(true);
      }
    } catch (error: any) {
      if (error.message === 'Scan usage load timeout') {
        console.warn('⚠️ Scan usage load timed out, allowing scans by default');
      } else {
        console.error('❌ Error loading scan usage:', error);
      }
      // Default to allowing scans if we can't load usage (don't block users)
      setCanScan(true);
      // Set a default scanUsage so the banner doesn't show "loading" forever
      setScanUsage({
        subscriptionTier: 'free',
        monthlyScans: 0,
        monthlyLimit: 5,
        scansRemaining: 5,
      });
    }
  };
  
  // Background scan syncing disabled - scans work synchronously
  // This function is kept but not called to avoid breaking anything
  const syncBackgroundScans = async () => {
    // Disabled - no background jobs
    return;
    if (!user) {
      console.log('⏭️ Skipping background scan sync: no user');
      return;
    }
    
    try {
      const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL');
      if (!baseUrl) {
        console.warn('⚠️ Cannot sync background scans: EXPO_PUBLIC_API_BASE_URL not configured');
        return;
      }
      
      // Get last sync time from storage
      const lastSyncKey = `last_scan_sync_${user.uid}`;
      const lastSyncTime = await AsyncStorage.getItem(lastSyncKey);
      const since = lastSyncTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Default to 7 days ago
      
      const syncUrl = `${baseUrl}/api/sync-scans?userId=${user.uid}&since=${encodeURIComponent(since)}`;
      console.log(`🔄 Syncing background scans from ${baseUrl}...`);
      
      // Fetch completed scan jobs
      const response = await fetch(syncUrl);
      if (!response.ok) {
        let errorMessage = `Failed to sync background scans: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage += ` - ${errorData.error || errorData.detail || JSON.stringify(errorData)}`;
        } catch (e) {
          try {
            const errorText = await response.text();
            if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
          } catch (e2) {
            // Ignore parsing errors
          }
        }
        console.error(errorMessage);
        return;
      }
      
      const data = await response.json();
      const completedJobs = data.jobs || [];
      
      if (completedJobs.length === 0) {
        // Update last sync time
        await AsyncStorage.setItem(lastSyncKey, new Date().toISOString());
        return;
      }
      
      console.log(`📥 Syncing ${completedJobs.length} completed background scans...`);
      
      // Collect all pending books from all scans to fetch covers for them
      const allSyncedPendingBooks: Book[] = [];
      
      // Process each completed job
      for (const job of completedJobs) {
        if (job.status === 'completed' && job.books && job.books.length > 0) {
          // Get the photo ID associated with this job
          const jobKey = `scan_job_${job.jobId}`;
          const jobData = await AsyncStorage.getItem(jobKey);
          
          if (jobData) {
            const { scanId, photoId } = JSON.parse(jobData);
            
            // Create photo if it doesn't exist
            let photo = photos.find(p => p.id === photoId);
            if (!photo) {
              photo = {
                id: photoId,
                uri: '', // We don't store the image URI in background jobs
                timestamp: new Date(job.createdAt).getTime(),
                books: []
              };
            }
            
            // Convert job books to Book format
            const bookTimestamp = Date.now();
            const scanRandomSuffix = Math.random().toString(36).substring(2, 9);
            const newBooks: Book[] = job.books.map((book: any, index: number) => ({
              id: `book_${bookTimestamp}_${index}_${scanRandomSuffix}_${Math.random().toString(36).substring(2, 7)}`,
              title: book.title,
              author: book.author || 'Unknown Author',
              isbn: book.isbn || '',
              confidence: book.confidence || 'medium',
              status: 'pending' as const,
              scannedAt: new Date(job.createdAt).getTime(),
            }));
            
            // Separate complete and incomplete
            const newPendingBooks = newBooks.filter(book => !isIncompleteBook(book));
            const newIncompleteBooks = newBooks.filter(book => isIncompleteBook(book)).map(book => ({
              ...book,
              status: 'incomplete' as const
            }));
            
            // Collect all pending books for cover fetching
            allSyncedPendingBooks.push(...newPendingBooks);
            
            // Update photo with books
            const updatedPhoto: Photo = {
              ...photo,
              books: [
                ...newPendingBooks.map(book => ({ ...book, status: 'pending' as const })),
                ...newIncompleteBooks.map(book => ({ ...book, status: 'incomplete' as const }))
              ]
            };
            
            // Add books to pending using deduplicateBooks
            setPendingBooks(prev => {
              const deduped = deduplicateBooks(prev, newPendingBooks);
              const userPendingKey = `pending_books_${user.uid}`;
              AsyncStorage.setItem(userPendingKey, JSON.stringify(deduped));
              return deduped;
            });
            
            // Update photos
            setPhotos(prev => {
              const existing = prev.find(p => p.id === photoId);
              const updated = existing
                ? prev.map(p => p.id === photoId ? updatedPhoto : p)
                : [...prev, updatedPhoto];
              const userPhotosKey = `photos_${user.uid}`;
              AsyncStorage.setItem(userPhotosKey, JSON.stringify(updated));
              return updated;
            });
            
            // Remove job tracking
            await AsyncStorage.removeItem(jobKey);
          }
        }
      }
      
      // Update last sync time
      await AsyncStorage.setItem(lastSyncKey, new Date().toISOString());
      
      console.log(`✅ Synced ${completedJobs.length} background scans`);
      
      // Fetch covers for all synced books (not just the first scan)
      if (allSyncedPendingBooks.length > 0) {
        console.log(`🖼️ Fetching covers for ${allSyncedPendingBooks.length} books from synced background scans...`);
        // Start fetching immediately for faster loading
        fetchCoversForBooks(allSyncedPendingBooks).catch(error => {
          console.error('❌ Error fetching covers for synced books:', error);
        });
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error 
        ? `Error syncing background scans: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
        : `Error syncing background scans: ${String(error)}`;
      console.error(errorMessage);
    }
  };

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      // Load from AsyncStorage FIRST for instant UI, then merge Supabase data
      console.log('📥 Loading user data (AsyncStorage first, then Supabase)...');
      
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      // Load from AsyncStorage immediately (fast, local)
      const [savedPending, savedApproved, savedRejected, savedPhotos] = await Promise.all([
        AsyncStorage.getItem(userPendingKey),
        AsyncStorage.getItem(userApprovedKey),
        AsyncStorage.getItem(userRejectedKey),
        AsyncStorage.getItem(userPhotosKey),
      ]);
      
      // Set AsyncStorage data immediately so UI shows something right away
      if (savedPending) {
        try {
          const parsed = JSON.parse(savedPending);
          setPendingBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} pending books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing pending books:', e);
        }
      }
      if (savedApproved) {
        try {
          const parsed = JSON.parse(savedApproved);
          setApprovedBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} approved books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing approved books:', e);
        }
      }
      if (savedRejected) {
        try {
          const parsed = JSON.parse(savedRejected);
          setRejectedBooks(parsed);
          console.log(`✅ Loaded ${parsed.length} rejected books from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing rejected books:', e);
        }
      }
      if (savedPhotos) {
        try {
          const parsed = JSON.parse(savedPhotos);
          setPhotos(parsed);
          console.log(`✅ Loaded ${parsed.length} photos from AsyncStorage`);
        } catch (e) {
          console.error('Error parsing photos:', e);
        }
      }
      
      // Now load from Supabase with timeout and merge
      try {
        const supabasePromise = Promise.all([
          loadBooksFromSupabase(user.uid),
          loadPhotosFromSupabase(user.uid),
        ]);
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Supabase load timeout')), 5000)
        );
        
        const [supabaseBooks, supabasePhotos] = await Promise.race([
          supabasePromise,
          timeoutPromise,
        ]) as [any, any];
      
        
        // Merge Supabase data with AsyncStorage data
        let mergedPending: Book[] = [];
        let mergedApproved: Book[] = [];
        let mergedRejected: Book[] = [];
        
        if (supabaseBooks) {
          setPendingBooks(prev => {
            mergedPending = mergeBooks(prev, supabaseBooks.pending || []);
            console.log(`📚 Merged pending: ${prev.length} existing + ${supabaseBooks.pending.length} from Supabase = ${mergedPending.length} total`);
            return mergedPending;
          });
          setApprovedBooks(prev => {
            mergedApproved = mergeBooks(prev, supabaseBooks.approved || []);
            console.log(`📚 Merged approved: ${prev.length} existing + ${supabaseBooks.approved.length} from Supabase = ${mergedApproved.length} total`);
            return mergedApproved;
          });
          setRejectedBooks(prev => {
            mergedRejected = mergeBooks(prev, supabaseBooks.rejected || []);
            console.log(`📚 Merged rejected: ${prev.length} existing + ${supabaseBooks.rejected.length} from Supabase = ${mergedRejected.length} total`);
            return mergedRejected;
          });
          console.log(`✅ Merged ${supabaseBooks.pending.length} pending, ${supabaseBooks.approved.length} approved, ${supabaseBooks.rejected.length} rejected books from Supabase`);
        }
        
        // Merge photos from Supabase
        if (supabasePhotos && supabasePhotos.length > 0) {
          const validPhotos = supabasePhotos.filter(photo => {
            const hasValidUrl = photo.uri && 
              typeof photo.uri === 'string' && 
              photo.uri.startsWith('http') && 
              photo.uri.includes('supabase.co');
            return hasValidUrl;
          });
          
          setPhotos(prev => {
            // Simple merge: combine arrays and dedupe by id
            const existingIds = new Set(prev.map(p => p.id));
            const newPhotos = validPhotos.filter(p => !existingIds.has(p.id));
            const merged = [...prev, ...newPhotos];
            console.log(`📸 Merged photos: ${prev.length} existing + ${newPhotos.length} from Supabase = ${merged.length} total`);
            return merged;
          });
        }
        
        // Fetch covers for all merged books that don't have covers yet
        const allBooks = [...mergedPending, ...mergedApproved, ...mergedRejected];
        const booksNeedingCovers = allBooks.filter(book => !book.coverUrl && !book.localCoverPath);
        if (booksNeedingCovers.length > 0) {
          console.log(`🖼️ Fetching covers for ${booksNeedingCovers.length} books without covers...`);
          fetchCoversForBooks(booksNeedingCovers).catch(error => {
            console.error('Error fetching covers for loaded books:', error);
          });
        }
      } catch (supabaseError: any) {
        if (supabaseError.message === 'Supabase load timeout') {
          console.warn('⚠️ Supabase load timed out, using AsyncStorage data only');
        } else {
          console.error('❌ Error loading from Supabase:', supabaseError);
        }
        // Continue with AsyncStorage data - UI already shows it
      }
      
      // Merge photos from Supabase with existing state (don't replace - merge to prevent duplicates)
      // IMPORTANT: Only load photos that have valid storage URLs (already uploaded)
      // Filter out photos with local file paths (those are temporary and shouldn't be loaded)
      if (supabasePhotos && supabasePhotos.length > 0) {
        // Filter to only include photos with valid storage URLs
        const validPhotos = supabasePhotos.filter(photo => {
          const hasValidUrl = photo.uri && 
            typeof photo.uri === 'string' && 
            photo.uri.startsWith('http') && 
            photo.uri.includes('supabase.co');
          if (!hasValidUrl) {
            console.warn(`Skipping photo ${photo.id}: no valid storage URL (may be old temporary file)`);
          }
          return hasValidUrl;
        });
        
        setPhotos(prev => {
          // Merge photos by ID to prevent duplicates
          const photoMap = new Map<string, Photo>();
          
          // Add existing photos first (only if they have valid URLs)
          prev.forEach(photo => {
            if (photo.id) {
              const hasValidUrl = photo.uri && 
                typeof photo.uri === 'string' && 
                (photo.uri.startsWith('http') || photo.uri.startsWith('file://'));
              if (hasValidUrl) {
                photoMap.set(photo.id, photo);
              }
            }
          });
          
          // Add/update with Supabase photos (prefer Supabase data as source of truth)
          // IMPORTANT: Don't filter books - keep ALL books (pending, approved, rejected, incomplete)
          // Photos should show all books that were scanned, regardless of their current status
          // IMPORTANT: Merge books instead of replacing - if Supabase has empty books but local has books, keep local books
          validPhotos.forEach(photo => {
            if (photo.id) {
              const existingPhoto = photoMap.get(photo.id);
              if (existingPhoto) {
                // Always merge books - never lose local books if Supabase has empty array
                // Prefer Supabase books if they exist and are not empty, otherwise keep existing books
                const supabaseHasBooks = photo.books && Array.isArray(photo.books) && photo.books.length > 0;
                const localHasBooks = existingPhoto.books && Array.isArray(existingPhoto.books) && existingPhoto.books.length > 0;
                
                let mergedBooks: Book[] = [];
                if (supabaseHasBooks) {
                  // Supabase has books - use them (they're the source of truth)
                  mergedBooks = photo.books;
                } else if (localHasBooks) {
                  // Supabase has no books but local does - keep local books
                  mergedBooks = existingPhoto.books;
                } else {
                  // Neither has books - use empty array
                  mergedBooks = [];
                }
                
                photoMap.set(photo.id, {
                  ...photo,  // Use Supabase photo data (URI, timestamp, etc.)
                  books: mergedBooks  // Use merged books (never lose local data)
                });
              } else {
                // No existing photo - use Supabase photo as-is
                photoMap.set(photo.id, photo);
              }
            }
          });
          
          const merged = Array.from(photoMap.values());
          console.log(`📸 Merged photos: ${prev.length} existing + ${validPhotos.length} valid from Supabase = ${merged.length} total`);
          return merged;
        });
        console.log(`✅ Loaded ${validPhotos.length} valid photos from Supabase (filtered out ${supabasePhotos.length - validPhotos.length} invalid)`);
      } else {
        // If Supabase returned empty, try AsyncStorage as fallback
        console.log('⚠️ No photos from Supabase, checking AsyncStorage fallback...');
        const userPhotosKey = `photos_${user.uid}`;
        const savedPhotos = await AsyncStorage.getItem(userPhotosKey);
        if (savedPhotos) {
          try {
            const parsed = JSON.parse(savedPhotos);
            if (parsed && parsed.length > 0) {
              setPhotos(parsed);
              console.log(`✅ Loaded ${parsed.length} photos from AsyncStorage fallback`);
            }
          } catch (e) {
            console.error('Error parsing photos from AsyncStorage:', e);
          }
        }
      }
      
      // Also load folders from AsyncStorage (folders not yet in Supabase)
      const userFoldersKey = `folders_${user.uid}`;
      const savedFolders = await AsyncStorage.getItem(userFoldersKey);
      if (savedFolders) {
        try {
          const parsed = JSON.parse(savedFolders);
          // Deduplicate folders by ID
          const seen = new Map<string, Folder>();
          const deduplicated = parsed.filter((folder: Folder) => {
            if (!folder.id) return false;
            if (seen.has(folder.id)) {
              console.warn(`Duplicate folder ID found: ${folder.id}, keeping first occurrence`);
              return false;
            }
            seen.set(folder.id, folder);
            return true;
          });
          setFolders(deduplicated);
        } catch (e) {
          console.error('Error parsing folders:', e);
        }
      }
      
      // Also cache to AsyncStorage for offline access
      // (userPendingKey, userApprovedKey, userRejectedKey, userPhotosKey already declared at top of function)
      if (supabaseBooks) {
        await Promise.all([
          AsyncStorage.setItem(userPendingKey, JSON.stringify(supabaseBooks.pending || [])),
          AsyncStorage.setItem(userApprovedKey, JSON.stringify(supabaseBooks.approved || [])),
          AsyncStorage.setItem(userRejectedKey, JSON.stringify(supabaseBooks.rejected || [])),
        ]);
      }
      
      if (supabasePhotos) {
        await AsyncStorage.setItem(userPhotosKey, JSON.stringify(supabasePhotos));
      }
      
    } catch (error) {
      console.error('Error loading user data from Supabase, falling back to AsyncStorage:', error);
      
      // Fallback to AsyncStorage if Supabase fails
      try {
        const userPendingKey = `pending_books_${user.uid}`;
        const userApprovedKey = `approved_books_${user.uid}`;
        const userRejectedKey = `rejected_books_${user.uid}`;
        const userPhotosKey = `photos_${user.uid}`;
        const userFoldersKey = `folders_${user.uid}`;
        
        const [savedPending, savedApproved, savedRejected, savedPhotos, savedFolders] = await Promise.all([
          AsyncStorage.getItem(userPendingKey),
          AsyncStorage.getItem(userApprovedKey),
          AsyncStorage.getItem(userRejectedKey),
          AsyncStorage.getItem(userPhotosKey),
          AsyncStorage.getItem(userFoldersKey),
        ]);
        
        let loadedPending: Book[] = [];
        let loadedApproved: Book[] = [];
        let loadedRejected: Book[] = [];
        
        if (savedPending) {
          try {
            const parsed = JSON.parse(savedPending);
            loadedPending = parsed;
            setPendingBooks(parsed);
          } catch (e) {
            console.error('Error parsing pending books:', e);
          }
        }
        if (savedApproved) {
          try {
            const parsed = JSON.parse(savedApproved);
            loadedApproved = parsed;
            setApprovedBooks(parsed);
          } catch (e) {
            console.error('Error parsing approved books:', e);
          }
        }
        if (savedRejected) {
          try {
            const parsed = JSON.parse(savedRejected);
            loadedRejected = parsed;
            setRejectedBooks(parsed);
          } catch (e) {
            console.error('Error parsing rejected books:', e);
          }
        }
        if (savedPhotos) {
          try {
            const parsed = JSON.parse(savedPhotos);
            setPhotos(parsed);
          } catch (e) {
            console.error('Error parsing photos:', e);
          }
        }
        if (savedFolders) {
          try {
            const parsed = JSON.parse(savedFolders);
            setFolders(parsed);
          } catch (e) {
            console.error('Error parsing folders:', e);
          }
        }
        
        // Fetch covers for all books that don't have covers yet (from AsyncStorage fallback)
        const allFallbackBooks = [...loadedPending, ...loadedApproved, ...loadedRejected];
        const fallbackBooksNeedingCovers = allFallbackBooks.filter(book => !book.coverUrl && !book.localCoverPath);
        if (fallbackBooksNeedingCovers.length > 0) {
          console.log(`🖼️ Fetching covers for ${fallbackBooksNeedingCovers.length} books without covers (from AsyncStorage)...`);
          // Start fetching immediately for faster loading
          fetchCoversForBooks(fallbackBooksNeedingCovers).catch(error => {
            console.error('Error fetching covers for fallback books:', error);
          });
        }
      } catch (fallbackError) {
        console.error('Error loading from AsyncStorage fallback:', fallbackError);
      }
    }
  };
  
  // Reload data when tab is focused (user navigates back to this tab)
  // Must be after loadUserData and loadScanUsage are defined
  useFocusEffect(
    useCallback(() => {
      if (user) {
        console.log('🔄 Tab focused, refreshing data...');
        // Reload data in background
        loadUserData().catch(error => {
          console.error('❌ Error reloading user data on focus:', error);
        });
        loadScanUsage().catch(error => {
          console.error('❌ Error reloading scan usage on focus:', error);
        });
      }
    }, [user])
  );

  const saveUserData = async (newPending: Book[], newApproved: Book[], newRejected: Book[], newPhotos: Photo[]) => {
    if (!user) return;
    
    try {
      // Save to AsyncStorage for offline access (fast, local)
      const userPendingKey = `pending_books_${user.uid}`;
      const userApprovedKey = `approved_books_${user.uid}`;
      const userRejectedKey = `rejected_books_${user.uid}`;
      const userPhotosKey = `photos_${user.uid}`;
      
      await Promise.all([
        AsyncStorage.setItem(userPendingKey, JSON.stringify(newPending)),
        AsyncStorage.setItem(userApprovedKey, JSON.stringify(newApproved)),
        AsyncStorage.setItem(userRejectedKey, JSON.stringify(newRejected)),
        AsyncStorage.setItem(userPhotosKey, JSON.stringify(newPhotos)),
      ]);
      
      // Save to Supabase for permanent cloud storage (async, don't block)
      Promise.all([
        // Save all books to Supabase
        ...newPending.map(book => saveBookToSupabase(user.uid, book, 'pending')),
        ...newApproved.map(book => saveBookToSupabase(user.uid, book, 'approved')),
        ...newRejected.map(book => saveBookToSupabase(user.uid, book, 'rejected')),
        // Save all photos to Supabase (filter out photos with invalid URIs)
        ...newPhotos
          .filter(photo => photo.uri && typeof photo.uri === 'string' && photo.uri.trim().length > 0)
          .map(photo => savePhotoToSupabase(user.uid, photo)),
      ]).catch(error => {
        console.error('Error saving to Supabase (non-blocking):', error);
        // Don't throw - AsyncStorage save succeeded, Supabase is just for sync
      });
      
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

  // NOTE: Client-side validation removed for security
  // All validation is now handled server-side by the API endpoint

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
    // Import the centralized service
    const { fetchBookData } = await import('../services/googleBooksService');
    
    // Filter out books that already have covers
    const booksNeedingCovers = books.filter(book => {
      // Skip if already has cover and local cache
      if (book.googleBooksId && book.localCoverPath && FileSystem.documentDirectory) {
        // We'll check file existence in parallel, but skip if we already have cover URL
        if (book.coverUrl) return false;
      }
      // Skip if we already have description and all stats (even without local cover)
      if (book.description && book.googleBooksId && 
          (book.pageCount || book.publisher || book.publishedDate)) {
        return false; // Already has description and stats, skip
      }
      return true;
    });

    if (booksNeedingCovers.length === 0) return;

    // Process books in parallel batches for faster loading
    // Batch size of 3-4 works well with Google Books API rate limits
    const BATCH_SIZE = 4;
    const batches = [];
    
    for (let i = 0; i < booksNeedingCovers.length; i += BATCH_SIZE) {
      batches.push(booksNeedingCovers.slice(i, i + BATCH_SIZE));
    }

    // Process batches sequentially, but books within each batch in parallel
    for (const batch of batches) {
      const promises = batch.map(async (book) => {
        try {
          // Skip if already has all data (cover, description, and stats) and local cache
          if (book.googleBooksId && book.localCoverPath && FileSystem.documentDirectory) {
            try {
              const fullPath = `${FileSystem.documentDirectory}${book.localCoverPath}`;
              const fileInfo = await FileSystem.getInfoAsync(fullPath);
              // Check if we already have cover, description, and key stats
              if (fileInfo.exists && book.coverUrl && book.description && 
                  (book.pageCount || book.publisher || book.publishedDate)) {
                return; // Already has everything, skip
              }
            } catch (error) {
              // File doesn't exist, continue to fetch
            }
          }

          // Use centralized service - it will use googleBooksId if available (much faster!)
          const bookData = await fetchBookData(
            book.title,
            book.author,
            book.googleBooksId // If we already have the ID, use it instead of searching
          );
          
          if (bookData.coverUrl && bookData.googleBooksId) {
            // Download and cache the cover (non-blocking)
            const localPath = await downloadAndCacheCover(bookData.coverUrl, bookData.googleBooksId);
            
            // Include all stats data from Google Books API
            const updatedBook = {
              coverUrl: bookData.coverUrl,
              googleBooksId: bookData.googleBooksId,
              ...(localPath && { localCoverPath: localPath }),
              // Include all stats fields
              ...(bookData.pageCount !== undefined && { pageCount: bookData.pageCount }),
              ...(bookData.categories && { categories: bookData.categories }),
              ...(bookData.publisher && { publisher: bookData.publisher }),
              ...(bookData.publishedDate && { publishedDate: bookData.publishedDate }),
              ...(bookData.language && { language: bookData.language }),
              ...(bookData.averageRating !== undefined && { averageRating: bookData.averageRating }),
              ...(bookData.ratingsCount !== undefined && { ratingsCount: bookData.ratingsCount }),
              ...(bookData.subtitle && { subtitle: bookData.subtitle }),
              ...(bookData.printType && { printType: bookData.printType }),
              ...(bookData.description && { description: bookData.description }),
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
            
            // Save to Supabase immediately if description or stats were fetched
            if (user && (updatedBook.description || updatedBook.pageCount || updatedBook.publisher)) {
              saveBookToSupabase(user.uid, { ...book, ...updatedBook }, book.status || 'approved')
                .catch(error => {
                  console.error(`Error saving book data to Supabase for ${book.title}:`, error);
                });
            }
          }
        } catch (error) {
          console.error(`Error fetching data for ${book.title}:`, error);
        }
      });

      // Wait for all books in this batch to complete (parallel processing)
      await Promise.all(promises);
      
      // Small delay between batches to respect rate limits (reduced from 500ms to 200ms)
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Note: Descriptions and stats are now saved to Supabase immediately when fetched
    // This ensures data persists even if the app is closed before the next user action
  };

  // NOTE: Client-side API key usage removed for security
  // All scans now go through the server API endpoint which handles API keys securely

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

  // Submit scan as background job (continues even if app closes)
  const submitBackgroundScanJob = async (imageDataURL: string, scanId: string, photoId: string): Promise<string | null> => {
    const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL');
    if (!baseUrl) {
      console.error('❌ No API base URL configured');
      return null;
    }
    
    try {
      const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      const resp = await fetch(`${baseUrl}/api/scan-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataURL,
          userId: user?.uid,
          jobId
        })
      });
      
      if (resp.ok) {
        const data = await resp.json();
        const finalJobId = data.jobId || jobId;
        
        // Check if job was completed synchronously
        if (data.status === 'completed' && data.books) {
          console.log(`✅ Background scan job completed synchronously: ${finalJobId} with ${data.books.length} books`);
          // Job completed immediately, return the jobId so caller knows it's done
          // The books will be processed by the sync function when app reopens
          // For now, just store the job info
          const jobKey = `scan_job_${finalJobId}`;
          await AsyncStorage.setItem(jobKey, JSON.stringify({
            jobId: finalJobId,
            scanId,
            photoId,
            createdAt: new Date().toISOString(),
            completed: true,
            books: data.books
          }));
          return finalJobId;
        } else if (data.status === 'failed') {
          console.error(`❌ Background scan job failed: ${finalJobId} - ${data.error}`);
          return null;
        } else {
          // Job is still processing or pending
          console.log(`⏳ Background scan job submitted: ${finalJobId} (status: ${data.status})`);
          // Store job tracking info
          const jobKey = `scan_job_${finalJobId}`;
          await AsyncStorage.setItem(jobKey, JSON.stringify({
            jobId: finalJobId,
            scanId,
            photoId,
            createdAt: new Date().toISOString()
          }));
          
          // Track in state
          setBackgroundScanJobs(prev => {
            const newMap = new Map(prev);
            newMap.set(finalJobId, { jobId: finalJobId, scanId, photoId });
            return newMap;
          });
          
          return finalJobId;
        }
      } else {
        console.error(`❌ Failed to submit background scan job: ${resp.status}`);
        return null;
      }
    } catch (error) {
      console.error('❌ Error submitting background scan job:', error);
      return null;
    }
  };

  const scanImageWithAI = async (primaryDataURL: string, fallbackDataURL: string, useBackground: boolean = false, scanId?: string, photoId?: string): Promise<{ books: Book[], fromVercel: boolean, jobId?: string }> => {
    // Background mode disabled - always scan directly
    
    console.log('🚀 Starting AI scan via server API...');
    const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL');
    
    if (!baseUrl) {
      console.error('❌ CRITICAL: No API base URL configured!');
      console.error('❌ Please set EXPO_PUBLIC_API_BASE_URL in your .env file or app.config.js');
      Alert.alert(
        'Configuration Error',
        'The API server URL is not configured. Please contact support or check your configuration.'
      );
      return { books: [], fromVercel: false };
    }
    
    console.log(`📡 Attempting server API scan at: ${baseUrl}/api/scan`);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
      
        const resp = await fetch(`${baseUrl}/api/scan`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ 
            imageDataURL: primaryDataURL,
            userId: user?.uid || undefined // Include user ID for scan tracking
          }),
          signal: controller.signal,
        });
      
      clearTimeout(timeoutId);
        
        if (resp.ok) {
          const data = await resp.json();
          const serverBooks = Array.isArray(data.books) ? data.books : [];
          
          // Log API status if available
          if (data.apiResults) {
            const { openai, gemini } = data.apiResults;
          console.log(`✅ Server API Status: OpenAI=${openai.working ? '✅' : '❌'} (${openai.count} books), Gemini=${gemini.working ? '✅' : '❌'} (${gemini.count} books)`);
          } else {
          console.log(`✅ Server API returned ${serverBooks.length} books`);
          }
          
          // If API didn't track the scan, do it client-side as fallback
          if (user && (!data.scanTracked)) {
            console.warn('⚠️ API did not track scan, attempting client-side fallback...');
            incrementScanCount(user.uid).catch(err => {
              console.error('❌ Client-side scan tracking also failed:', err);
            });
          }
          
        console.log(`✅ Using server API results: ${serverBooks.length} books found (already validated)`);
            return { books: serverBooks, fromVercel: true };
        } else {
          const errorText = await resp.text().catch(() => '');
        console.error(`❌ Server API error: ${resp.status} - ${errorText.substring(0, 200)}`);
        
        // Check if it's a scan limit error
        if (resp.status === 403) {
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error === 'scan_limit_reached') {
              // 🎛️ FEATURE FLAG: Only show upgrade prompt if subscription UI is not hidden
              if (!isSubscriptionUIHidden()) {
                Alert.alert(
                  'Scan Limit Reached',
                  errorData.message || 'You have reached your monthly scan limit. Please upgrade to Pro for unlimited scans.',
                  [
                    { text: 'OK', onPress: () => setShowUpgradeModal(true) }
                  ]
                );
              }
              // Refresh scan usage
              if (user) {
                loadScanUsage();
              }
              return { books: [], fromVercel: false };
            }
          } catch (e) {
            // Not JSON, continue with normal error handling
          }
        }
        
        // If server returns 0 books, try with fallback image
        if (resp.status === 200) {
          // Status 200 but might have returned empty array, try fallback
          console.log('⚠️ Server returned empty results, trying with downscaled image...');
          try {
            const fallbackResp = await fetch(`${baseUrl}/api/scan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                imageDataURL: fallbackDataURL,
                userId: user?.uid || undefined // Include user ID for scan tracking
              }),
            });
            
            if (fallbackResp.ok) {
              const fallbackData = await fallbackResp.json();
              const fallbackBooks = Array.isArray(fallbackData.books) ? fallbackData.books : [];
              if (fallbackBooks.length > 0) {
                console.log(`✅ Fallback scan returned ${fallbackBooks.length} books`);
                return { books: fallbackBooks, fromVercel: true };
              }
            }
          } catch (fallbackErr) {
            console.error('❌ Fallback scan failed:', fallbackErr);
          }
        }
        
        return { books: [], fromVercel: false };
      }
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      console.error('❌ Server API request failed:', errorMsg);
      console.error('❌ Error details:', {
        message: errorMsg,
        name: e?.name,
        stack: e?.stack?.slice(0, 500),
        baseUrl: baseUrl
      });
      
      // Check if it's a network error vs other error
      if (errorMsg.includes('Network request failed') || errorMsg.includes('Failed to fetch')) {
        Alert.alert(
          'Network Error',
          'Unable to connect to the scan server. Please check your internet connection and try again.\n\nIf this persists, the server may be temporarily unavailable.'
        );
      } else {
        Alert.alert(
          'Scan Failed',
          `Error: ${errorMsg.substring(0, 100)}`
        );
      }
      return { books: [], fromVercel: false };
    }
  };

  const processImage = async (uri: string, scanId: string, caption?: string) => {
    // Prevent processing the same image multiple times
    if (processingUrisRef.current.has(uri)) {
      console.warn(`⚠️ Image ${uri} is already being processed, skipping duplicate`);
      return;
    }
    
    // Mark this URI as being processed
    processingUrisRef.current.add(uri);
    
    try {
      // Get latest progress to preserve totalScans - CRITICAL: never set totalScans to 0
      // Use ref to get latest value (avoids stale closure issue)
      const latestProgress = scanProgress;
      const refTotalScans = totalScansRef.current;
      const progressTotalScans = latestProgress?.totalScans || 0;
      const existingTotalScans = Math.max(refTotalScans, progressTotalScans);
      
      // Read queue length using functional update to get latest state
      let currentQueueLength = 0;
      let currentCompletedCount = 0;
      let currentFailedCount = 0;
      
      setScanQueue(prev => {
        currentQueueLength = prev.length;
        currentCompletedCount = prev.filter(item => item.status === 'completed' || item.status === 'failed').length;
        currentFailedCount = prev.filter(item => item.status === 'failed').length;
        return prev; // Don't modify
      });
      
      // Use the MAXIMUM of existing totalScans or current queue length
      // This ensures we never lose the correct count that was set when images were added
      const totalScans = Math.max(existingTotalScans, currentQueueLength);
      
      // Update ref with the value we're using
      if (totalScans > 0) {
        totalScansRef.current = totalScans;
      }
      
      console.log('📊 processImage starting:', {
        scanId,
        existingTotalScans,
        currentQueueLength,
        totalScans,
        'Will preserve totalScans': totalScans > 0 ? totalScans : 'ERROR: totalScans is 0!'
      });
      
      // Step 1: Initializing (1%) - update progress with correct totalScans
      // CRITICAL: Always preserve totalScans - never set it to 0
      if (totalScans === 0) {
        console.error('❌ ERROR: totalScans is 0 in processImage! This should never happen!');
        console.error('   existingTotalScans:', existingTotalScans);
        console.error('   currentQueueLength:', currentQueueLength);
        console.error('   latestProgress:', latestProgress);
      }
      
      setScanProgress({
        currentScanId: scanId,
        currentStep: 1,
        totalSteps: 10, // More granular steps for better progress tracking
        totalScans: totalScans, // Always use the correct total - MUST be > 0
        completedScans: currentCompletedCount,
        failedScans: currentFailedCount,
        startTimestamp: latestProgress?.startTimestamp || Date.now(), // Preserve or set start timestamp
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
      console.log('📸 Starting AI scan...');
      
      // Generate photo ID for this scan
      const photoId = `photo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Scan directly - no background jobs, just wait for results
      const scanResult = await scanImageWithAI(imageDataURL, fallbackDataURL, false, scanId, photoId);
      const detectedBooks = scanResult.books;
      const cameFromVercel = scanResult.fromVercel;
      
      console.log(`📚 AI scan completed: ${detectedBooks.length} books detected (${cameFromVercel ? 'from Vercel API, already validated' : 'from client-side, needs validation'})`);
      
      if (detectedBooks.length === 0) {
        console.error('❌ WARNING: No books detected from scan!');
        console.error('   Possible causes:');
        console.error('   1. API keys not configured (check logs above)');
        console.error('   2. Image quality too low or no books visible');
        console.error('   3. API errors (check network/status)');
      }
      
      updateProgress({ currentStep: 4, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 4, total: 10 } });
      
      // Step 4: Books are already validated server-side (Vercel API handles validation)
      // If books came from Vercel API, they're already validated. If from client-side fallback, validate here.
      const analyzedBooks = [];
      const totalBooks = detectedBooks.length;
      
      if (totalBooks > 0) {
        if (cameFromVercel) {
          console.log(`✅ Using ${totalBooks} validated books from server API (already validated server-side)`);
          analyzedBooks.push(...detectedBooks);
          // Books are already validated by server, move directly to finalizing
          updateProgress({ currentStep: 9, totalScans: totalScans });
          setCurrentScan({ id: scanId, uri, progress: { current: 9, total: 10 } });
        } else {
          // If server API is not available, we can't proceed (no client-side fallback for security)
          console.error('❌ Server API not available and client-side API keys are not configured for security reasons');
          console.error('❌ Please ensure EXPO_PUBLIC_API_BASE_URL is set correctly');
          // Still add the books but they won't be validated
          analyzedBooks.push(...detectedBooks);
          updateProgress({ currentStep: 9, totalScans: totalScans });
          setCurrentScan({ id: scanId, uri, progress: { current: 9, total: 10 } });
        }
      } else {
        console.log(`⚠️ No books detected to validate`);
      }
      
      // Step 5: Finalizing (100%)
      updateProgress({ currentStep: 10, totalScans: totalScans });
      setCurrentScan({ id: scanId, uri, progress: { current: 10, total: 10 } });
      
      // Convert analyzed books to proper structure and separate complete vs incomplete
      // Use timestamp + index + random for stable IDs that can be used for folder membership
      const bookTimestamp = Date.now();
      const scanRandomSuffix = Math.random().toString(36).substring(2, 9);
      const allBooks: Book[] = analyzedBooks.map((book, index) => ({
        id: `book_${bookTimestamp}_${index}_${scanRandomSuffix}_${Math.random().toString(36).substring(2, 7)}`,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        confidence: book.confidence,
        status: 'pending' as const,
        scannedAt: Date.now(),
      }));
      
      // Check if no books were found - don't save the photo if so
      if (allBooks.length === 0) {
        console.error('❌ No books detected from scan - not saving photo');
        
        // Determine failure reason
        let failureReason = 'No books were detected in the image.';
        let failureDetails = '';
        
        if (!cameFromVercel) {
          failureReason = 'Unable to connect to scan server.';
          failureDetails = 'Please check your internet connection and try again.';
        } else if (detectedBooks.length === 0) {
          failureReason = 'No books detected in the image.';
          failureDetails = 'Possible reasons:\n• Image quality is too low\n• No books are visible in the photo\n• Books are too blurry or obscured\n• Try taking a clearer photo with better lighting';
        }
        
        // Mark scan as failed in queue
        setScanQueue(prev => prev.map(item => 
          item.id === scanId ? { ...item, status: 'failed' as const } : item
        ));
        
        // Clear current scan state
        setCurrentScan(null);
        
        // Update progress to show failed scan
        const currentFailedCount = scanProgress?.failedScans || 0;
        updateProgress({
          currentScanId: null,
          currentStep: 0,
          failedScans: currentFailedCount + 1,
          totalScans: totalScans,
        });
        
        // Clean up caption ref
        scanCaptionsRef.current.delete(scanId);
        
        // Check if there are more photos to scan
        const hasMorePhotos = pendingImages.length > 1 && currentImageIndex < pendingImages.length - 1;
        
        if (hasMorePhotos) {
          // Automatically move to next photo without showing alert
          console.log('📸 No books found, automatically moving to next photo...');
          const nextIndex = currentImageIndex + 1;
          const nextImage = pendingImages[nextIndex];
          
          // Update to show next photo in caption modal
          setCurrentImageIndex(nextIndex);
          setPendingImageUri(nextImage.uri);
          currentScanIdRef.current = nextImage.scanId;
          setCaptionText(scanCaptionsRef.current.get(nextImage.scanId) || '');
          
          // Don't save the photo - just return (caption modal will show next photo)
          return;
        } else {
          // This is the last photo (or only photo), show alert
          Alert.alert(
            'Failed to Find Books',
            `${failureReason}\n\n${failureDetails}`,
            [{ text: 'OK' }]
          );
        }
        
        // Don't save the photo - just return
        // The photo won't appear in recent scans since it's never added to the photos array
        return;
      }
      
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
      const finalPhotoId = photoId || scanId;
      const newPhoto: Photo = {
        id: finalPhotoId, // Use photoId if available (for background jobs), otherwise use scanId
        uri,
        books: photoBooks, // Store all books with correct statuses for scan modal
        timestamp: Date.now(),
        caption: finalCaption, // Include caption if provided
      };
      
      // Use functional updates to ensure we have the latest state
      // This prevents books from previous scans from being lost
      // IMPORTANT: Check if a photo with this URI already exists to prevent duplicates
      setPhotos(prevPhotos => {
        // Check if a photo with this URI already exists
        const existingPhoto = prevPhotos.find(p => p.uri === uri);
        if (existingPhoto) {
          console.warn(`⚠️ Photo with URI ${uri} already exists (ID: ${existingPhoto.id}), skipping duplicate`);
          // Update existing photo with new books instead of creating duplicate
          const updatedPhotos = prevPhotos.map(p => 
            p.id === existingPhoto.id 
              ? { ...p, books: [...p.books, ...photoBooks] } // Merge books
              : p
          );
          return updatedPhotos;
        }
        
        const updatedPhotos = [...prevPhotos, newPhoto];
        console.log('📸 Adding photo, total photos now:', updatedPhotos.length);
        
        // Save photos to AsyncStorage immediately to prevent data loss
        const userPhotosKey = `photos_${user.uid}`;
        AsyncStorage.setItem(userPhotosKey, JSON.stringify(updatedPhotos)).catch(error => {
          console.error('Error saving photos to AsyncStorage:', error);
        });
        
        // Upload photo to Supabase Storage in the background (don't block UI)
        // IMPORTANT: Save with books immediately to prevent data loss
        if (user) {
          savePhotoToSupabase(user.uid, newPhoto).catch(error => {
            console.error('Error uploading photo to Supabase (non-blocking):', error);
            // Don't throw - photo is saved locally, Supabase upload can retry later
          });
        }
        
        // Deduplicate books by ID to prevent duplicate key errors
        // Use functional update for pendingBooks to get latest state
        setPendingBooks(prevPending => {
          console.log('📚 Current pending books count:', prevPending.length);
          console.log('📚 New pending books to add:', newPendingBooks.length);
          
          const existingBookIds = new Set(prevPending.map(b => b.id));
          const uniqueNewPendingBooks = newPendingBooks.filter(book => !existingBookIds.has(book.id));
          const updatedPending = [...prevPending, ...uniqueNewPendingBooks];
          
          console.log('📚 Updated pending books count:', updatedPending.length);
          console.log('📚 Unique new books added:', uniqueNewPendingBooks.length);
          
          // Save data with the updated values
          saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos).catch(error => {
            console.error('Error saving user data:', error);
          });
          
          return updatedPending;
        });
        
        return updatedPhotos;
      });
      
      // Ensure no book appears pre-selected after new results arrive
      setSelectedBooks(new Set());
      
      // Fetch covers for books immediately (don't wait for this)
      // Start fetching right away for faster cover loading
      console.log('🖼️ Fetching covers for', newPendingBooks.length, 'books');
      fetchCoversForBooks(newPendingBooks).catch(error => {
        console.error('❌ Error fetching covers:', error);
      });
      
      // Add books to selected folder if one was chosen
      if (selectedFolderId) {
        const scannedBookIds = newPendingBooks.map(book => book.id).filter((id): id is string => id !== undefined);
        await addBooksToSelectedFolder(scannedBookIds);
      }
      
      // NOTE: Scan count is already incremented by the API when the scan request is made
      // We should NOT increment again here to avoid double-counting
      // The API tracks scans at the point of request, not when books are found
      // This ensures 1 photo = 1 scan, regardless of how many books are found
      
      // Refresh scan limit banner and usage after successful scan
      // The API now tracks scans synchronously, so refresh after a short delay
      if (user) {
        // Refresh after 1 second to let the database update complete
        setTimeout(() => {
          if (scanLimitBannerRef.current) {
            scanLimitBannerRef.current.refresh();
          }
          loadScanUsage();
        }, 1000);
        
        // Also refresh after 3 seconds as a backup
        setTimeout(() => {
          if (scanLimitBannerRef.current) {
            scanLimitBannerRef.current.refresh();
          }
          loadScanUsage();
        }, 3000);
      }
      
      // Update queue status using functional update to get latest state
      setScanQueue(prev => {
        const updatedQueue = prev.map(item => 
        item.id === scanId ? { ...item, status: 'completed' as const } : item
      );
      
        // Update scanning progress - ensure totalScans is correct
      const newCompletedCount = updatedQueue.filter(item => item.status === 'completed').length;
      const pendingScans = updatedQueue.filter(item => item.status === 'pending');
      const stillProcessing = updatedQueue.some(item => item.status === 'processing');
        const actualTotalScans = updatedQueue.length; // Use actual queue length
        
        console.log('📊 Scan completion check:', {
          newCompletedCount,
          pendingScans: pendingScans.length,
          stillProcessing,
          actualTotalScans,
          queue: updatedQueue.map(i => ({ id: i.id, status: i.status }))
        });
        
        // Defer progress update to avoid "Cannot update component during render" error
        setTimeout(() => {
          // ALWAYS update progress to keep notification visible with correct count
        updateProgress({
          currentScanId: null,
          currentStep: 0,
          completedScans: newCompletedCount,
            totalScans: actualTotalScans, // Use actual queue length
          });
          console.log('📊 Updated progress - totalScans:', actualTotalScans, 'completedScans:', newCompletedCount);
        }, 0);
        
        // Check if there are more scans to process
        const hasMoreScans = pendingScans.length > 0 || stillProcessing;
        
        if (hasMoreScans) {
          // More scans to process - process next one
          console.log('📊 More scans to process, keeping notification visible');
        
        // Process next pending scan if available and not already processing
        if (!stillProcessing && pendingScans.length > 0) {
          const nextScan = pendingScans[0];
            console.log('📊 Starting next scan:', nextScan.id);
          setIsProcessing(true);
          setTimeout(() => {
              setScanQueue(currentQueue => {
                const updatedQueue = currentQueue.map(item => 
                item.id === nextScan.id ? { ...item, status: 'processing' as const } : item
                );
                // Read completed count from updated queue
                const currentCompleted = updatedQueue.filter(item => item.status === 'completed').length;
                // Update progress AFTER state update completes
                setTimeout(() => {
                  updateProgress({
                    currentScanId: nextScan.id,
                    currentStep: 0,
                    completedScans: currentCompleted,
                    totalScans: actualTotalScans,
                  });
                }, 0);
                return updatedQueue;
              });
            processImage(nextScan.uri, nextScan.id);
          }, 500);
        }
      } else {
        // All scans complete, hide notification after a brief delay
          console.log('📊 All scans complete, hiding notification');
        setTimeout(() => {
          setScanProgress(null);
          // Refresh scan usage when all scans are complete
          if (user) {
            setTimeout(() => {
              loadScanUsage();
              scanLimitBannerRef.current?.refresh();
            }, 1000);
          }
        }, 500);
      }
        
        return updatedQueue;
      });
      
      console.log(`✅ Scan complete: ${newPendingBooks.length} books ready, ${newIncompleteBooks.length} incomplete`);
      
    } catch (error) {
      console.error(' Processing failed:', error);
      // Use functional update to get latest queue state
      setScanQueue(prev => {
        const failedQueue = prev.map(item => 
        item.id === scanId ? { ...item, status: 'failed' as const } : item
      );
      
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
              setScanQueue(currentQueue => 
                currentQueue.map(item => 
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
          // Refresh scan usage when all scans are complete
          if (user) {
            setTimeout(() => {
              loadScanUsage();
              scanLimitBannerRef.current?.refresh();
            }, 1000);
          }
        }, 500);
      }
        
        return failedQueue;
      });
    } finally {
      // Remove URI from processing set so it can be processed again if needed
      processingUrisRef.current.delete(uri);
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
    
    // Fetch cover if not already loaded
    if (!approvedBook.coverUrl && !approvedBook.localCoverPath) {
      fetchCoversForBooks([approvedBook]).catch(error => {
        console.error('Error fetching cover for approved book:', error);
      });
    }
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

      // IMPORTANT: Only delete pending/incomplete books - NEVER delete approved books
      // Approved books should remain in the library even if the photo is deleted
      const booksToDelete = photoToDelete.books.filter(book => 
        book.status === 'pending' || book.status === 'incomplete'
      );
      const approvedBooksFromPhoto = photoToDelete.books.filter(book => 
        book.status === 'approved'
      );

      // Delete from Supabase (storage and database)
      if (user) {
        await deletePhotoFromSupabase(user.uid, photoId);
        // Only delete pending/incomplete books from Supabase - NOT approved books
        for (const book of booksToDelete) {
          await deleteBookFromSupabase(user.uid, book).catch(err => {
            console.warn('Error deleting book from Supabase:', err);
          });
        }
        // Approved books stay in Supabase - they're part of the library
      }

      // Remove the photo completely
      const updatedPhotos = photos.filter(photo => photo.id !== photoId);
      
      // Remove pending/incomplete books that were from this scan
      // IMPORTANT: Do NOT remove approved books - they stay in the library
      const bookIdsToRemove = new Set(booksToDelete.map(book => book.id));
      const updatedPending = pendingBooks.filter(book => !bookIdsToRemove.has(book.id));
      
      // Approved books remain in approvedBooks - they're not removed
      // The photo is deleted, but approved books stay in the library
      
      // Clear selected photo if we're deleting it
      if (selectedPhoto?.id === photoId) {
        setSelectedPhoto(null);
        closeScanModal();
      }
      
      setPendingBooks(updatedPending);
      setPhotos(updatedPhotos);
      // approvedBooks stays unchanged - approved books are NOT deleted
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);
      
      const deletedCount = booksToDelete.length;
      const keptCount = approvedBooksFromPhoto.length;
      const message = keptCount > 0 
        ? `Scan deleted. ${deletedCount} pending/incomplete book${deletedCount !== 1 ? 's' : ''} removed. ${keptCount} approved book${keptCount !== 1 ? 's' : ''} remain${keptCount === 1 ? 's' : ''} in your library.`
        : `Scan deleted. ${deletedCount} pending/incomplete book${deletedCount !== 1 ? 's' : ''} removed.`;
      
      Alert.alert('Scan Deleted', message);
    } catch (error) {
      console.error('Error deleting scan:', error);
      Alert.alert('Error', 'Failed to delete scan. Please try again.');
    }
  };

  const toggleBookSelection = useCallback((bookId: string) => {
    setSelectedBooks(prev => {
      const newSelected = new Set(prev);
      if (newSelected.has(bookId)) {
        newSelected.delete(bookId);
        // Close edit actions if no books are selected
        if (newSelected.size === 0) {
          setShowEditActions(false);
        }
      } else {
        newSelected.add(bookId);
        // Close edit actions if more than one book is selected
        if (newSelected.size > 1) {
          setShowEditActions(false);
        }
      }
      return newSelected;
    });
  }, []);

  const selectAllBooks = useCallback(() => {
    // Select all pending books (exclude incomplete ones)
    const allPendingIds = pendingBooks
      .filter(book => book.status !== 'incomplete')
      .map(book => book.id)
      .filter((id): id is string => id !== undefined);
    
    setSelectedBooks(new Set(allPendingIds));
  }, [pendingBooks]);

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
    
    // Fetch covers for all approved books that don't have covers yet
    const booksNeedingCovers = approvedBooksData.filter(book => !book.coverUrl && !book.localCoverPath);
    if (booksNeedingCovers.length > 0) {
      fetchCoversForBooks(booksNeedingCovers).catch(error => {
        console.error('Error fetching covers for approved books:', error);
      });
    }
    
    Alert.alert('Success', `Added ${addedCount} book${addedCount !== 1 ? 's' : ''} to your library!`);
  };

  const unselectAllBooks = useCallback(() => {
    setSelectedBooks(new Set());
  }, []);

  const clearAllBooks = useCallback(async () => {
    // Remove all pending books (including incomplete ones)
    setPendingBooks([]);
    setSelectedBooks(new Set());
    
    // Also remove incomplete books from photos
    const updatedPhotos = photos.map(photo => ({
      ...photo,
      books: photo.books.filter(book => book.status !== 'incomplete')
    }));
    
    setPhotos(updatedPhotos);
    
    // Don't await - run in background
    saveUserData([], approvedBooks, rejectedBooks, updatedPhotos).catch(error => {
      console.error('Error saving user data:', error);
    });
  }, [approvedBooks, rejectedBooks, photos]);

  const clearSelectedBooks = async () => {
    const remainingBooks = pendingBooks.filter(book => !selectedBooks.has(book.id));
    setPendingBooks(remainingBooks);
    setSelectedBooks(new Set());
    await saveUserData(remainingBooks, approvedBooks, rejectedBooks, photos);
  };

  // Helper to merge books from Supabase with existing state
  // Preserves all books - prefers Supabase data when there's a match, keeps local-only books
  const mergeBooks = (existingBooks: Book[], supabaseBooks: Book[]): Book[] => {
    // Create a map of existing books by ID and by title+author (for matching)
    const existingById = new Map<string, Book>();
    const existingByKey = new Map<string, Book>();
    
    existingBooks.forEach(book => {
      if (book.id) {
        existingById.set(book.id, book);
      }
      // Also index by title+author for matching books that might have different IDs
      const key = `${book.title}|${book.author || ''}`;
      if (!existingByKey.has(key)) {
        existingByKey.set(key, book);
      }
    });
    
    // Create a set of all matched keys/IDs
    const matched = new Set<string>();
    
    // Start with Supabase books (prefer Supabase data as source of truth)
    const merged: Book[] = supabaseBooks.map(supabaseBook => {
      const key = `${supabaseBook.title}|${supabaseBook.author || ''}`;
      
      // Try to match by ID first
      if (supabaseBook.id && existingById.has(supabaseBook.id)) {
        matched.add(supabaseBook.id);
        // Use Supabase data (it's more up-to-date) but preserve the ID
        return { ...supabaseBook, id: supabaseBook.id };
      }
      
      // Try to match by title+author
      if (existingByKey.has(key)) {
        const existing = existingByKey.get(key)!;
        matched.add(existing.id || key);
        // Use Supabase data but preserve the existing ID if it exists
        return { ...supabaseBook, id: existing.id || supabaseBook.id };
      }
      
      // New book from Supabase
      return supabaseBook;
    });
    
    // Add existing books that weren't matched (local-only books)
    existingBooks.forEach(book => {
      const key = `${book.title}|${book.author || ''}`;
      if (!matched.has(book.id || key)) {
        merged.push(book);
      }
    });
    
    return merged;
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

  const approveSelectedBooks = useCallback(async () => {
    const currentSelected = selectedBooks;
    const selectedBookObjs = pendingBooks.filter(book => currentSelected.has(book.id));
    const remainingBooks = pendingBooks.filter(book => !currentSelected.has(book.id));
    
    const newApprovedBooks = selectedBookObjs.map(book => ({ ...book, status: 'approved' as const }));
    const updatedApproved = deduplicateBooks(approvedBooks, newApprovedBooks);
    
    setPendingBooks(remainingBooks);
    setApprovedBooks(updatedApproved);
    setSelectedBooks(new Set());
    
    // Don't await - run async operations in background
    saveUserData(remainingBooks, updatedApproved, rejectedBooks, photos).catch(error => {
      console.error('Error saving user data:', error);
    });
    
    // Fetch covers for all selected books that don't have covers yet
    const booksNeedingCovers = newApprovedBooks.filter(book => !book.coverUrl && !book.localCoverPath);
    if (booksNeedingCovers.length > 0) {
      fetchCoversForBooks(booksNeedingCovers).catch(error => {
        console.error('Error fetching covers for selected books:', error);
      });
    }
  }, [pendingBooks, approvedBooks, rejectedBooks, photos, selectedBooks]);

  // Edit functions for pending books
  const handleRemoveCover = useCallback(async (bookId: string) => {
    if (!user) return;
    
    const bookToUpdate = pendingBooks.find(book => book.id === bookId);
    if (!bookToUpdate) return;

    const updatedBook: Book = {
      ...bookToUpdate,
      coverUrl: undefined,
      localCoverPath: undefined,
      googleBooksId: undefined, // Remove Google Books ID since we're removing the cover
    };

    // Update in pending books
    const updatedPending = pendingBooks.map(book => 
      book.id === bookId ? updatedBook : book
    );
    setPendingBooks(updatedPending);

    // Update in photos
    const updatedPhotos = photos.map(photo => ({
      ...photo,
      books: photo.books.map(book => 
        book.id === bookId ? updatedBook : book
      ),
    }));
    setPhotos(updatedPhotos);

    // Save to Supabase
    await saveBookToSupabase(user.uid, updatedBook);
    await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

    // Clear selection and close edit mode
    setSelectedBooks(new Set());
    setShowEditActions(false);

    Alert.alert('Cover Removed', 'The cover has been removed from this book.');
  }, [pendingBooks, photos, approvedBooks, rejectedBooks, user]);

  const handleSwitchCovers = useCallback(async (bookId: string) => {
    const bookToUpdate = pendingBooks.find(book => book.id === bookId);
    if (!bookToUpdate) return;

    setShowSwitchCoversModal(true);
    setIsLoadingCovers(true);
    setCoverSearchResults([]);

    try {
      const { searchMultipleBooks } = await import('../services/googleBooksService');
      const results = await searchMultipleBooks(bookToUpdate.title, bookToUpdate.author, 20);
      
      // Filter to only show results with covers
      const resultsWithCovers = results.filter(r => r.coverUrl && r.googleBooksId);
      setCoverSearchResults(resultsWithCovers);
    } catch (error) {
      console.error('Error searching for covers:', error);
      Alert.alert('Error', 'Failed to search for covers. Please try again.');
    } finally {
      setIsLoadingCovers(false);
    }
  }, [pendingBooks]);

  const handleSelectCover = useCallback(async (selectedCover: {googleBooksId: string, coverUrl?: string}) => {
    if (!user || !selectedCover.googleBooksId || !selectedCover.coverUrl) return;

    const bookId = Array.from(selectedBooks)[0]; // Get the selected book ID
    const bookToUpdate = pendingBooks.find(book => book.id === bookId);
    if (!bookToUpdate) return;

    // Download and cache the new cover
    const { fetchBookData } = await import('../services/googleBooksService');
    const bookData = await fetchBookData(bookToUpdate.title, bookToUpdate.author, selectedCover.googleBooksId);

    if (bookData.coverUrl) {
      // Download the cover
      const coverUri = await downloadAndCacheCover(bookData.coverUrl, selectedCover.googleBooksId);
      
      const updatedBook: Book = {
        ...bookToUpdate,
        coverUrl: bookData.coverUrl,
        localCoverPath: coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined,
        googleBooksId: selectedCover.googleBooksId,
        // Update other book data if available
        description: bookData.description || bookToUpdate.description,
        pageCount: bookData.pageCount || bookToUpdate.pageCount,
        categories: bookData.categories || bookToUpdate.categories,
        publisher: bookData.publisher || bookToUpdate.publisher,
        publishedDate: bookData.publishedDate || bookToUpdate.publishedDate,
        language: bookData.language || bookToUpdate.language,
        averageRating: bookData.averageRating || bookToUpdate.averageRating,
        ratingsCount: bookData.ratingsCount || bookToUpdate.ratingsCount,
        subtitle: bookData.subtitle || bookToUpdate.subtitle,
      };

      // Update in pending books
      const updatedPending = pendingBooks.map(book => 
        book.id === bookId ? updatedBook : book
      );
      setPendingBooks(updatedPending);

      // Update in photos
      const updatedPhotos = photos.map(photo => ({
        ...photo,
        books: photo.books.map(book => 
          book.id === bookId ? updatedBook : book
        ),
      }));
      setPhotos(updatedPhotos);

      // Save to Supabase
      await saveBookToSupabase(user.uid, updatedBook);
      await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

      setShowSwitchCoversModal(false);
      setSelectedBooks(new Set());
      setShowEditActions(false);

      Alert.alert('Cover Updated', 'The book cover has been updated.');
    }
  }, [pendingBooks, photos, approvedBooks, rejectedBooks, user, selectedBooks]);

  const handleSwitchBook = useCallback(() => {
    setShowSwitchBookModal(true);
    setBookSearchQuery('');
    setBookSearchResults([]);
  }, []);

  const searchBooks = useCallback(async (query: string) => {
    if (!query.trim()) {
      setBookSearchResults([]);
      return;
    }

    setIsSearchingBooks(true);
    try {
      const { searchBooksByQuery } = await import('../services/googleBooksService');
      const results = await searchBooksByQuery(query, 20);
      setBookSearchResults(results);
    } catch (error) {
      console.error('Error searching books:', error);
      Alert.alert('Error', 'Failed to search for books. Please try again.');
    } finally {
      setIsSearchingBooks(false);
    }
  }, []);

  const handleSelectBook = useCallback(async (selectedBook: {googleBooksId: string, title: string, author?: string, coverUrl?: string}) => {
    if (!user) return;

    const bookId = Array.from(selectedBooks)[0]; // Get the selected book ID
    const bookToUpdate = pendingBooks.find(book => book.id === bookId);
    if (!bookToUpdate) return;

    // Fetch full book data
    const { fetchBookData } = await import('../services/googleBooksService');
    const bookData = await fetchBookData(selectedBook.title, selectedBook.author, selectedBook.googleBooksId);

    // Download cover if available
    let localCoverPath: string | undefined = undefined;
    if (bookData.coverUrl) {
      const coverUri = await downloadAndCacheCover(bookData.coverUrl, selectedBook.googleBooksId);
      localCoverPath = coverUri ? coverUri.replace(FileSystem.documentDirectory || '', '') : undefined;
    }

    const updatedBook: Book = {
      ...bookToUpdate,
      title: selectedBook.title,
      author: selectedBook.author || bookToUpdate.author,
      coverUrl: bookData.coverUrl || selectedBook.coverUrl,
      localCoverPath,
      googleBooksId: selectedBook.googleBooksId,
      description: bookData.description,
      pageCount: bookData.pageCount,
      categories: bookData.categories,
      publisher: bookData.publisher,
      publishedDate: bookData.publishedDate,
      language: bookData.language,
      averageRating: bookData.averageRating,
      ratingsCount: bookData.ratingsCount,
      subtitle: bookData.subtitle,
    };

    // Update in pending books
    const updatedPending = pendingBooks.map(book => 
      book.id === bookId ? updatedBook : book
    );
    setPendingBooks(updatedPending);

    // Update in photos
    const updatedPhotos = photos.map(photo => ({
      ...photo,
      books: photo.books.map(book => 
        book.id === bookId ? updatedBook : book
      ),
    }));
    setPhotos(updatedPhotos);

    // Save to Supabase
    await saveBookToSupabase(user.uid, updatedBook);
    await saveUserData(updatedPending, approvedBooks, rejectedBooks, updatedPhotos);

    setShowSwitchBookModal(false);
    setSelectedBooks(new Set());
    setShowEditActions(false);

    Alert.alert('Book Updated', 'The book has been replaced.');
  }, [pendingBooks, photos, approvedBooks, rejectedBooks, user, selectedBooks]);

  const rejectSelectedBooks = useCallback(async () => {
    if (!user) return;
    
    setSelectedBooks(currentSelected => {
      const selectedBookObjs = pendingBooks.filter(book => currentSelected.has(book.id));
      if (selectedBookObjs.length === 0) return currentSelected;
      
      // Delete books from Supabase (async, don't wait)
      Promise.all(
        selectedBookObjs.map(book => 
          deleteBookFromSupabase(user.uid, book).catch(err => {
            console.warn('Error deleting book from Supabase:', err);
          })
        )
      );
      
      // Remove from pending books (don't add to rejected - actually delete them)
      const remainingBooks = pendingBooks.filter(book => !currentSelected.has(book.id));
      
      // Remove from photos - but ONLY remove pending/incomplete books, NEVER approved books
      // IMPORTANT: Approved books should never be removed from photos
      const selectedBookIds = new Set(selectedBookObjs.map(book => book.id).filter((id): id is string => id !== undefined));
      const updatedPhotos = photos.map(photo => ({
        ...photo,
        books: photo.books.filter(book => {
          // Keep approved/rejected books - they should never be removed
          if (book.status === 'approved' || book.status === 'rejected') {
            return true;
          }
          // Only remove if it's a pending/incomplete book that was selected
          return !selectedBookIds.has(book.id);
        })
      }));
      
      setPendingBooks(remainingBooks);
      setPhotos(updatedPhotos);
      
      saveUserData(remainingBooks, approvedBooks, rejectedBooks, updatedPhotos).catch(error => {
        console.error('Error saving user data:', error);
      });
      
      return new Set(); // Clear selection
    });
  }, [user, pendingBooks, approvedBooks, rejectedBooks, photos]);

  const addImageToQueue = (uri: string, caption?: string, providedScanId?: string) => {
    // Generate unique scanId if not provided, using counter to prevent duplicates
    const scanId = providedScanId || (() => {
      scanIdCounterRef.current += 1;
      return `${Date.now()}_${scanIdCounterRef.current}_${Math.random().toString(36).substring(2, 9)}`;
    })();
    
    // Store caption if provided
    if (caption !== undefined) {
      scanCaptionsRef.current.set(scanId, caption);
    }
    
    // Check if this URI is already in the queue to prevent duplicates
    setScanQueue(prevQueue => {
      const isAlreadyQueued = prevQueue.some(item => item.uri === uri && item.status === 'pending');
      if (isAlreadyQueued) {
        console.warn(`⚠️ Image ${uri} is already in the queue, skipping duplicate`);
        return prevQueue; // Don't add duplicate
      }
      
      const newScanItem: ScanQueueItem = {
        id: scanId,
        uri,
        status: 'pending'
      };
      
      // Clear any lingering selections before a new scan starts
      setSelectedBooks(new Set());

      // Calculate new queue state
      const updatedQueue = [...prevQueue, newScanItem];
      const totalScans = updatedQueue.length;
      const completedCount = updatedQueue.filter(item => item.status === 'completed' || item.status === 'failed').length;
      
      console.log('📸 Adding image to queue, setting scan progress immediately', {
        totalScans,
        completedCount,
        scanId,
        queueLength: prevQueue.length
      });
      
      // Return the updated queue
      return updatedQueue;
    });
    
    // Set progress AFTER state update (defer to avoid render conflicts)
    setTimeout(() => {
      setScanQueue(currentQueue => {
        const currentTotalScans = currentQueue.length;
        const currentCompletedCount = currentQueue.filter(item => item.status === 'completed' || item.status === 'failed').length;
        const progressData = {
          currentScanId: null,
          currentStep: 0,
          totalSteps: 10,
          totalScans: currentTotalScans,
          completedScans: currentCompletedCount,
          failedScans: 0,
          startTimestamp: scanProgress?.startTimestamp || Date.now(),
        };
        totalScansRef.current = progressData.totalScans;
        setScanProgress(progressData);
        return currentQueue; // Don't modify queue here
      });
    }, 0);
    
    // Start processing if not already processing
    if (!isProcessing) {
      setIsProcessing(true);
      setTimeout(() => {
        processImage(uri, scanId, caption);
      }, 100);
    }
  };

  const handleCaptionSubmit = () => {
    // Scanning already started in background - save caption for the current scan
    if (currentScanIdRef.current) {
      scanCaptionsRef.current.set(currentScanIdRef.current, captionText.trim());
    }
    
    // Check if there are more images to caption
    if (currentImageIndex < pendingImages.length - 1) {
      // Move to next image
      const nextIndex = currentImageIndex + 1;
      setCurrentImageIndex(nextIndex);
      setPendingImageUri(pendingImages[nextIndex].uri);
      currentScanIdRef.current = pendingImages[nextIndex].scanId;
      setCaptionText(scanCaptionsRef.current.get(pendingImages[nextIndex].scanId) || '');
    } else {
      // Last image - close modal
      setPendingImageUri(null);
      setCaptionText('');
      setShowCaptionModal(false);
      setPendingImages([]);
      setCurrentImageIndex(0);
      currentScanIdRef.current = null;
    }
    // Scanning notification will automatically appear if scanning is still in progress
  };

  const handleCaptionSkip = () => {
    // Check if there are more images to caption
    if (currentImageIndex < pendingImages.length - 1) {
      // Move to next image (skip current one)
      const nextIndex = currentImageIndex + 1;
      setCurrentImageIndex(nextIndex);
      setPendingImageUri(pendingImages[nextIndex].uri);
      currentScanIdRef.current = pendingImages[nextIndex].scanId;
      setCaptionText(scanCaptionsRef.current.get(pendingImages[nextIndex].scanId) || '');
    } else {
      // Last image - close modal
      currentScanIdRef.current = null; // Clear ref
      setPendingImageUri(null);
      setCaptionText('');
      setShowCaptionModal(false);
      setPendingImages([]);
      setCurrentImageIndex(0);
    }
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
    if (!cameraRef) {
      console.warn('Camera ref not available');
      return;
    }
    
    // Check if camera is still active before taking picture
    if (!isCameraActive) {
      console.warn('Camera not active, cannot take picture');
      return;
    }
    
    try {
      // Store the camera ref locally to prevent issues if component unmounts
      const currentCameraRef = cameraRef;
      
      const photo = await currentCameraRef.takePictureAsync({
          quality: 0.8,
          base64: false,
          flashMode: 'on',
        });
        
        if (photo?.uri) {
          console.log('📷 Photo taken:', photo.uri);
        
        // Store photo URI first before any state changes
        const photoUri = photo.uri;
        
        // Don't close camera - allow taking multiple photos
          // Reset caption modal state
          setShowCaptionModal(false);
          setCaptionText('');
        
        // Start scanning immediately (camera stays open for more photos)
          handleImageSelected(photoUri);
      } else {
        console.error('Photo captured but no URI returned');
        Alert.alert('Camera Error', 'Photo was taken but could not be saved. Please try again.');
        }
    } catch (error: any) {
        console.error('Error taking picture:', error);
      
      // Only show alert if camera is still active (not unmounted)
      if (isCameraActive) {
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
        allowsMultipleSelection: true,
        selectionLimit: 0, // 0 = unlimited
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        console.log(`📂 ${result.assets.length} image(s) picked from library`);
        // Reset caption modal state
        setShowCaptionModal(false);
        setCaptionText('');
        
        // Generate scanIds for all images first
        const scanItems: Array<{uri: string, scanId: string}> = [];
        result.assets.forEach((asset) => {
          scanIdCounterRef.current += 1;
          const scanId = `${Date.now()}_${scanIdCounterRef.current}_${Math.random().toString(36).substring(2, 9)}`;
          scanCaptionsRef.current.set(scanId, ''); // Initialize with empty caption
          scanItems.push({ uri: asset.uri, scanId });
        });
        
        // Add all images to queue at once using functional update
        // IMPORTANT: Check for duplicates and only add new images
        let actuallyAddedItems: Array<{uri: string, scanId: string}> = [];
        
        setScanQueue(prev => {
          // Filter out completed and failed items from previous scans
          const activeQueue = prev.filter(item => item.status === 'pending' || item.status === 'processing');
          
          // Check for duplicates - only add images that aren't already in the queue
          const existingUris = new Set(activeQueue.map(item => item.uri));
          const newItems: ScanQueueItem[] = scanItems
            .filter(({ uri }) => !existingUris.has(uri)) // Only add if not already in queue
            .map(({ uri, scanId }) => ({
              id: scanId,
              uri,
              status: 'pending' as const
            }));
          
          if (newItems.length === 0) {
            console.warn('⚠️ All selected images are already in the queue, skipping');
            return prev; // Don't add duplicates
          }
          
          // Store which items were actually added (for use outside the callback)
          actuallyAddedItems = scanItems.filter(({ uri }) => !existingUris.has(uri));
          
          const updatedQueue = [...activeQueue, ...newItems];
          const totalScans = newItems.length; // Only count the NEW images being scanned (not old pending ones)
          
          console.log('📊 Adding multiple images to queue:', {
            totalScans: totalScans,
            newItems: newItems.length,
            activeQueueLength: activeQueue.length,
            updatedQueueLength: updatedQueue.length,
            prevQueueLength: prev.length,
            'Only counting NEW images': true
          });
          
          // Return the updated queue (don't call setScanProgress here - it causes render error)
          return updatedQueue;
        });
        
        // Set progress AFTER state update completes (defer to avoid render error)
        // Use the items that were actually added (not stale scanQueue state)
        setTimeout(() => {
          const progressData = {
            currentScanId: null,
            currentStep: 0,
            totalSteps: 10,
            totalScans: actuallyAddedItems.length, // Only the NEW images that were actually added
            completedScans: 0, // Reset for new batch
            failedScans: 0,
            startTimestamp: Date.now(), // New timestamp for new batch
          };
          
          console.log('📊 About to set scanProgress with totalScans:', progressData.totalScans, 'type:', typeof progressData.totalScans);
          // Update ref to track latest totalScans
          totalScansRef.current = progressData.totalScans;
          setScanProgress(progressData);
          console.log('📊 scanProgress set, totalScans:', progressData.totalScans, 'ref updated to:', totalScansRef.current);
          
          // Start processing the first new image if not already processing
          // Use the items that were actually added (not stale scanQueue state)
          if (!isProcessing && actuallyAddedItems.length > 0) {
            const firstItem = actuallyAddedItems[0];
            setIsProcessing(true);
            setTimeout(() => {
              setScanQueue(currentQueue => 
                currentQueue.map(item => 
                  item.id === firstItem.scanId ? { ...item, status: 'processing' as const } : item
                )
              );
              processImage(firstItem.uri, firstItem.scanId);
            }, 50);
          }
        }, 0);
        
        // Show caption modal for the first NEW image only
        // Use the items that were actually added (not stale scanQueue state)
        if (actuallyAddedItems.length > 0) {
          // Store all NEW pending images for navigation
          setPendingImages(actuallyAddedItems);
          setCurrentImageIndex(0);
          setPendingImageUri(actuallyAddedItems[0].uri);
          currentScanIdRef.current = actuallyAddedItems[0].scanId;
          setCaptionText(scanCaptionsRef.current.get(actuallyAddedItems[0].scanId) || '');
          setTimeout(() => {
            console.log('📝 Showing caption modal');
            setShowCaptionModal(true);
          }, 100);
        }
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

  // Pinch gesture for zoom
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      lastZoomRef.current = zoom;
    })
    .onUpdate((e) => {
      // Scale from 1.0 (no change) - scale up = zoom in, scale down = zoom out
      // Map scale to zoom: scale 0.5 = zoom out, scale 2.0 = zoom in
      const baseZoom = lastZoomRef.current;
      const scaleChange = e.scale - 1.0; // Change from 1.0
      const newZoom = Math.max(0, Math.min(1, baseZoom + scaleChange * 0.5));
      setZoom(newZoom);
    })
    .onEnd(() => {
      lastZoomRef.current = zoom;
    });

  if (isCameraActive) {
    return (
      <View style={styles.cameraContainer}>
        <GestureDetector gesture={pinchGesture}>
          <View style={styles.camera}>
        <CameraView
              style={StyleSheet.absoluteFill}
          facing="back"
          flashMode="on"
              zoom={zoom}
          ref={(ref) => setCameraRef(ref)}
        />
          </View>
        </GestureDetector>
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
                ? 'Better lighting = better accuracy • Tap × to close'
                : 'Better lighting = better accuracy • Tap × to close • Take multiple photos'}
            </Text>
          </View>
        
          {/* Zoom controls - Right side */}
          <View style={styles.zoomControls}>
            <TouchableOpacity
              style={styles.zoomButton}
              onPress={() => setZoom(Math.max(0, zoom - 0.1))}
              activeOpacity={0.7}
            >
              <Ionicons name="remove-outline" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.zoomText}>{Math.round(zoom * 100)}%</Text>
            <TouchableOpacity
              style={styles.zoomButton}
              onPress={() => setZoom(Math.min(1, zoom + 0.1))}
              activeOpacity={0.7}
            >
              <Ionicons name="add-outline" size={24} color="#fff" />
            </TouchableOpacity>
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
  // Calculate sticky toolbar position - above scanning notification if it's visible
  // Notification is at: insets.bottom + tabBarHeight (~49-56px)
  // Position toolbar as low as possible - use minimal height to eliminate gap
  const tabBarHeight = Platform.OS === 'ios' ? 49 : 56;
  // To eliminate gap: notification is at bottom: insets.bottom + tabBarHeight
  // Toolbar should be positioned so its bottom touches notification's top
  // Subtract significantly more to move toolbar DOWN and eliminate gap completely
  const notificationHeight = scanProgress ? 75 : 0; // Actual measured height
  const stickyBottomPosition = scanProgress 
    ? insets.bottom + tabBarHeight + notificationHeight - 75 // Subtract 75px to move toolbar down and eliminate gap
    : 0; // Directly at bottom when no notification

  return (
    <View style={styles.safeContainer}>
      <SafeAreaView style={{ flex: 1 }} edges={['left','right']}>
        <ScrollView 
          style={styles.container}
          contentContainerStyle={[
            pendingBooks.length > 0 && { paddingBottom: 100 } // Add padding so content isn't hidden behind sticky toolbar
          ]}
          bounces={false}
          overScrollMode="never"
        >
      <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
      <View style={styles.header}>
        <Text style={styles.title}>Book Scanner</Text>
        <Text style={styles.subtitle}>Scan your bookshelf to build your library</Text>
      </View>

      {/* Scan Limit Banner */}
      {user && (
        <ScanLimitBanner
          ref={scanLimitBannerRef}
          onUpgradePress={() => setShowUpgradeModal(true)}
        />
      )}

      {/* Scan Options */}
      <View style={styles.scanOptions}>
        <TouchableOpacity 
          style={styles.scanButton} 
          onPress={async () => {
            // Only check scan limit if user is free tier and has NO scans remaining
            if (user && scanUsage) {
              const isFreeTier = scanUsage.subscriptionTier === 'free';
              const hasNoScans = scanUsage.scansRemaining !== null && scanUsage.scansRemaining <= 0;
              
              // Only block if free tier AND no scans remaining
              if (isFreeTier && hasNoScans) {
                // Double-check with server to be sure
                const canScanNow = await canUserScan(user.uid);
                if (!canScanNow) {
                  // User is out of scans - show upgrade modal (only if subscription UI is not hidden)
                  if (!isSubscriptionUIHidden()) {
                    setShowUpgradeModal(true);
                  }
                  loadScanUsage();
                  return;
                }
              }
              // If user has scans remaining OR is pro/owner, proceed normally
            } else if (user && !scanUsage) {
              // If scanUsage not loaded yet, check with server
              const canScanNow = await canUserScan(user.uid);
              if (!canScanNow) {
                // 🎛️ FEATURE FLAG: Only show upgrade modal if subscription UI is not hidden
                if (!isSubscriptionUIHidden()) {
                  setShowUpgradeModal(true);
                }
                loadScanUsage();
                return;
              }
            }
            // User has scans or is pro/owner - proceed normally
            handleStartCamera();
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.scanButtonText}>
            Take Photo
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={styles.scanButton} 
          onPress={async () => {
            // Only check scan limit if user is free tier and has NO scans remaining
            if (user && scanUsage) {
              const isFreeTier = scanUsage.subscriptionTier === 'free';
              const hasNoScans = scanUsage.scansRemaining !== null && scanUsage.scansRemaining <= 0;
              
              // Only block if free tier AND no scans remaining
              if (isFreeTier && hasNoScans) {
                // Double-check with server to be sure
                const canScanNow = await canUserScan(user.uid);
                if (!canScanNow) {
                  // User is out of scans - show upgrade modal (only if subscription UI is not hidden)
                  if (!isSubscriptionUIHidden()) {
                    setShowUpgradeModal(true);
                  }
                  loadScanUsage();
                  return;
                }
              }
              // If user has scans remaining OR is pro/owner, proceed normally
            } else if (user && !scanUsage) {
              // If scanUsage not loaded yet, allow the action but check in background
              // Don't block user - load usage in background
              loadScanUsage().catch(() => {});
              // Proceed with image picker - we'll check limit when scan completes
              pickImage();
              return;
            }
            // User has scans or is pro/owner - proceed normally
            pickImage();
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.scanButtonText}>
            Upload Image
          </Text>
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
                onPress={selectedBooks.size > 0 && selectedBooks.size === pendingBooks.filter(book => book.status !== 'incomplete').length ? unselectAllBooks : selectAllBooks}
              >
                <Text style={styles.selectAllButtonText}>
                  {selectedBooks.size > 0 && selectedBooks.size === pendingBooks.filter(book => book.status !== 'incomplete').length ? 'Unselect All' : 'Select All'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View>
            {groupedPendingBooks.map((group, groupIndex) => {
              const photo = photoMap.get(group.photoId);
              
              return (
                <View key={`group_${group.photoId}`} style={styles.photoGroup}>
                  {/* Separator line between photo groups - show after first group */}
                  {groupIndex > 0 && (
                    <View style={styles.photoSeparator}>
                      <View style={styles.separatorLine} />
                      <Text style={styles.separatorText}>
                        {photo?.caption ? `From: ${photo.caption}` : `Scan ${groupIndex + 1}`}
                      </Text>
                      <View style={styles.separatorLine} />
                    </View>
                  )}
                  
                  {/* Books from this photo - in grid layout */}
          <View style={styles.booksGrid}>
                    {group.books.map((book, bookIndex) => {
                      const uniqueKey = book.id 
                        ? `${book.id}_${groupIndex}_${bookIndex}` 
                        : `book_${groupIndex}_${bookIndex}_${(book.title || 'unknown').substring(0, 20)}`;
                      const bookId = book.id || '';
                      const isSelected = selectedBooks.has(bookId);
                      const coverUri = getBookCoverUri(book);
                      
                      return (
              <TouchableOpacity 
                          key={uniqueKey} 
                style={[
                  styles.pendingBookCard,
                            isSelected && styles.selectedBookCard
                ]}
                          onPress={() => toggleBookSelection(bookId)}
                activeOpacity={0.7}
              >
              {/* Cover area: show cover or placeholder with title text; author below */}
              <View style={styles.bookTopSection}>
                {coverUri ? (
                  <Image 
                    source={{ uri: coverUri }} 
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
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Recent Scans */}
      {photos.length > 0 && (
        <View style={styles.recentSection}>
          <Text style={styles.sectionTitle}>Recent Scans</Text>
          {photos.slice(-3).reverse().map((photo, photoIndex) => (
      <TouchableOpacity 
              key={photo.id || `photo_${photoIndex}_${photo.timestamp}`} 
              style={styles.photoCard}
              onPress={() => openScanModal(photo)}
            >
              <Image source={{ uri: photo.uri }} style={styles.photoThumbnail} />
              <View style={styles.photoInfo}>
                <Text style={styles.photoDate}>
                  {new Date(photo.timestamp).toLocaleDateString()}
                </Text>
                <Text style={styles.photoBooks}>
                  {photo.books?.length || 0} books found
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
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
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
                      
                      let statsData: any = {};
                      try {
                        // Use centralized service instead of direct API call
                        const { fetchBookData } = await import('../services/googleBooksService');
                        const bookData = await fetchBookData(manualTitle.trim(), manualAuthor.trim());
                        
                        if (bookData.coverUrl && bookData.googleBooksId) {
                          coverUrl = bookData.coverUrl;
                          googleBooksId = bookData.googleBooksId;
                          localCoverPath = await downloadAndCacheCover(coverUrl, googleBooksId);
                          
                          // Extract all stats data
                          statsData = {
                            ...(bookData.pageCount !== undefined && { pageCount: bookData.pageCount }),
                            ...(bookData.categories && { categories: bookData.categories }),
                            ...(bookData.publisher && { publisher: bookData.publisher }),
                            ...(bookData.publishedDate && { publishedDate: bookData.publishedDate }),
                            ...(bookData.language && { language: bookData.language }),
                            ...(bookData.averageRating !== undefined && { averageRating: bookData.averageRating }),
                            ...(bookData.ratingsCount !== undefined && { ratingsCount: bookData.ratingsCount }),
                            ...(bookData.subtitle && { subtitle: bookData.subtitle }),
                            ...(bookData.printType && { printType: bookData.printType }),
                            ...(bookData.description && { description: bookData.description }),
                          };
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
                              ...statsData, // Include all stats data
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
                                    // Include all stats from Google Books API
                                    ...(volumeInfo.pageCount && { pageCount: volumeInfo.pageCount }),
                                    ...(volumeInfo.categories && { categories: volumeInfo.categories }),
                                    ...(volumeInfo.publisher && { publisher: volumeInfo.publisher }),
                                    ...(volumeInfo.publishedDate && { publishedDate: volumeInfo.publishedDate }),
                                    ...(volumeInfo.language && { language: volumeInfo.language }),
                                    ...(volumeInfo.averageRating && { averageRating: volumeInfo.averageRating }),
                                    ...(volumeInfo.ratingsCount && { ratingsCount: volumeInfo.ratingsCount }),
                                    ...(volumeInfo.subtitle && { subtitle: volumeInfo.subtitle }),
                                    ...(volumeInfo.printType && { printType: volumeInfo.printType }),
                                    ...(volumeInfo.description && { description: volumeInfo.description }),
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
        <SafeAreaView style={styles.captionModalContainer} edges={['left','right']}>
          <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
          <View style={styles.captionModalHeader}>
            <Text style={styles.modalTitle}>Add Caption</Text>
            {pendingImages.length > 1 && (
              <Text style={styles.captionProgressText}>
                {currentImageIndex + 1} of {pendingImages.length}
              </Text>
            )}
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={handleCaptionSkip}
            >
              <Text style={styles.modalCloseText}>
                {currentImageIndex < pendingImages.length - 1 ? 'Skip' : 'Skip All'}
              </Text>
            </TouchableOpacity>
          </View>
          
          {pendingImageUri && (
            <KeyboardAvoidingView 
              style={{ flex: 1 }} 
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
            >
              <GestureDetector gesture={Gesture.Pan()
                .activeOffsetX([-15, 15]) // Require at least 15px horizontal movement to activate
                .failOffsetY([-20, 20]) // Fail if vertical movement exceeds 20px (allows some vertical but prioritizes horizontal)
                .onEnd((e) => {
                  const { translationX, velocityX } = e;
                  // Swipe left (negative translationX or negative velocityX) to go to next photo
                  // Require at least 50px movement or fast velocity (500px/s)
                  if (translationX < -50 || velocityX < -500) {
                    if (currentImageIndex < pendingImages.length - 1) {
                      handleCaptionSubmit();
                    }
                  }
                  // Swipe right (positive translationX or positive velocityX) to go to previous photo
                  else if (translationX > 50 || velocityX > 500) {
                    if (currentImageIndex > 0) {
                      const prevIndex = currentImageIndex - 1;
                      setCurrentImageIndex(prevIndex);
                      setPendingImageUri(pendingImages[prevIndex].uri);
                      currentScanIdRef.current = pendingImages[prevIndex].scanId;
                      setCaptionText(scanCaptionsRef.current.get(pendingImages[prevIndex].scanId) || '');
                    }
                  }
                })
              }>
                  <ScrollView 
                    style={styles.captionModalContent}
                    contentContainerStyle={styles.captionModalContentContainer}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    <Image source={{ uri: pendingImageUri }} style={styles.captionModalImage} />
                    
                    {pendingImages.length > 1 && (
                      <View style={styles.captionSwipeHint}>
                        <Ionicons name="arrow-back" size={16} color="#718096" />
                        <Text style={styles.captionSwipeHintText}>
                          Swipe left/right to navigate • {currentImageIndex + 1} of {pendingImages.length}
                        </Text>
                        <Ionicons name="arrow-forward" size={16} color="#718096" />
                      </View>
                    )}
                    
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
                      autoFocus={currentImageIndex === 0}
                      blurOnSubmit={true}
                      returnKeyType={currentImageIndex < pendingImages.length - 1 ? "next" : "done"}
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
                    <Text style={styles.captionSubmitButtonText}>
                      {currentImageIndex < pendingImages.length - 1 ? 'Next' : 'Done'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
              </GestureDetector>
            </KeyboardAvoidingView>
          )}
        </SafeAreaView>
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
        <SafeAreaView style={styles.folderModalContainer} edges={['top']}>
          <View style={[styles.folderModalHeader, { paddingTop: insets.top + 20 }]}>
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
                      color={selectedFolderId === folder.id ? "#0056CC" : "#4a5568"} 
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
                      <Ionicons name="checkmark-circle" size={24} color="#0056CC" />
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
        </SafeAreaView>
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
          {/* Edit action buttons - shown when edit mode is active */}
          {showEditActions && selectedBooks.size === 1 && (
            <View style={styles.editActionsRow}>
              <TouchableOpacity 
                style={styles.editActionButton}
                onPress={() => {
                  const bookId = Array.from(selectedBooks)[0];
                  handleRemoveCover(bookId);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="image-outline" size={14} color="#fff" style={{ marginRight: 4 }} />
                <Text style={styles.editActionButtonText}>Remove Cover</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.editActionButton}
                onPress={() => {
                  const bookId = Array.from(selectedBooks)[0];
                  handleSwitchCovers(bookId);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="swap-horizontal-outline" size={14} color="#fff" style={{ marginRight: 4 }} />
                <Text style={styles.editActionButtonText}>Switch Covers</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.editActionButton}
                onPress={() => {
                  handleSwitchBook();
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="book-outline" size={14} color="#fff" style={{ marginRight: 4 }} />
                <Text style={styles.editActionButtonText}>Switch Book</Text>
              </TouchableOpacity>
            </View>
          )}
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
            {selectedBooks.size === 1 && (
              <TouchableOpacity 
                style={[styles.stickyEditButton, showEditActions && styles.stickyEditButtonActive]}
                onPress={() => {
                  setShowEditActions(!showEditActions);
                }}
                activeOpacity={0.8}
              >
                <Ionicons 
                  name={showEditActions ? "close" : "create-outline"} 
                  size={16} 
                  color="#fff" 
                  style={{ marginRight: 4 }} 
                />
                <Text style={styles.stickyEditButtonText}>
                  {showEditActions ? 'Cancel' : 'Edit'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* Upgrade Modal */}
      <UpgradeModal
        visible={showUpgradeModal}
        onClose={() => {
          setShowUpgradeModal(false);
          loadScanUsage(); // Refresh usage after closing
        }}
        onUpgradeComplete={() => {
          setShowUpgradeModal(false);
          loadScanUsage(); // Refresh usage after upgrade
        }}
      />

      {/* Switch Covers Modal */}
      <Modal
        visible={showSwitchCoversModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setShowSwitchCoversModal(false);
          setCoverSearchResults([]);
        }}
      >
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
            <Text style={styles.modalTitle}>Switch Cover</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                setShowSwitchCoversModal(false);
                setCoverSearchResults([]);
              }}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          
          {selectedBooks.size === 1 && (() => {
            const bookId = Array.from(selectedBooks)[0];
            const book = pendingBooks.find(b => b.id === bookId);
            if (!book) return null;
            
            return (
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
            );
          })()}
        </SafeAreaView>
      </Modal>

      {/* Switch Book Modal */}
      <Modal
        visible={showSwitchBookModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          // Clear search timeout
          if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
          }
          setShowSwitchBookModal(false);
          setBookSearchQuery('');
          setBookSearchResults([]);
        }}
      >
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
            <Text style={styles.modalTitle}>Switch Book</Text>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => {
                // Clear search timeout
                if (searchTimeoutRef.current) {
                  clearTimeout(searchTimeoutRef.current);
                  searchTimeoutRef.current = null;
                }
                setShowSwitchBookModal(false);
                setBookSearchQuery('');
                setBookSearchResults([]);
              }}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          
          <View style={styles.modalContent}>
            <View style={styles.searchContainer}>
              <TextInput
                style={styles.searchInput}
                placeholder="Search for a book..."
                value={bookSearchQuery}
                onChangeText={(text) => {
                  setBookSearchQuery(text);
                  // Debounce search
                  if (searchTimeoutRef.current) {
                    clearTimeout(searchTimeoutRef.current);
                  }
                  searchTimeoutRef.current = setTimeout(() => {
                    searchBooks(text);
                  }, 500);
                }}
                autoCapitalize="words"
                autoCorrect={false}
              />
              {isSearchingBooks && (
                <ActivityIndicator size="small" color="#0056CC" style={{ marginLeft: 10 }} />
              )}
            </View>

            {selectedBooks.size === 1 && (() => {
              const bookId = Array.from(selectedBooks)[0];
              const book = pendingBooks.find(b => b.id === bookId);
              if (!book) return null;
              
              return (
                <View style={styles.switchBookHeader}>
                  <Text style={styles.switchBookHeaderTitle}>Replacing:</Text>
                  <View style={styles.currentBookCard}>
                    {getBookCoverUri(book) ? (
                      <Image 
                        source={{ uri: getBookCoverUri(book) }} 
                        style={styles.currentBookCoverSmall}
                      />
                    ) : (
                      <View style={[styles.currentBookCoverSmall, styles.placeholderCover]}>
                        <Text style={styles.placeholderText} numberOfLines={2}>
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
              );
            })()}

            <ScrollView style={styles.searchResultsContainer}>
              {bookSearchResults.length === 0 && bookSearchQuery.trim() ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No books found</Text>
                </View>
              ) : (
                bookSearchResults.map((result, index) => (
                  <TouchableOpacity
                    key={result.googleBooksId || index}
                    style={styles.bookSearchResult}
                    onPress={() => handleSelectBook(result)}
                    activeOpacity={0.7}
                  >
                    {result.coverUrl ? (
                      <Image 
                        source={{ uri: result.coverUrl }} 
                        style={styles.bookSearchResultCover}
                      />
                    ) : (
                      <View style={[styles.bookSearchResultCover, styles.placeholderCover]}>
                        <Text style={styles.placeholderText} numberOfLines={2}>
                          {result.title}
                        </Text>
                      </View>
                    )}
                    <View style={styles.bookSearchResultInfo}>
                      <Text style={styles.bookSearchResultTitle}>{result.title}</Text>
                      {result.author && (
                        <Text style={styles.bookSearchResultAuthor}>{result.author}</Text>
                      )}
                      {result.publishedDate && (
                        <Text style={styles.bookSearchResultDate}>{result.publishedDate}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
};

const getStyles = (screenWidth: number) => StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa', // Subtle gray background
    position: 'relative',
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
  scanOptions: {
    flexDirection: 'row',
    padding: 20,
    gap: 15,
    marginTop: 0,
  },
  scanButton: {
    flex: 1,
    backgroundColor: '#e8e6e3', // Grey marble
    padding: 18,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 0.5,
    borderColor: '#d4d2cf', // Slightly darker grey border
  },
  scanButtonText: {
    color: '#2d3748', // Slate text (darker for contrast on marble)
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  scanButtonDisabled: {
    backgroundColor: '#d1d5db', // Lighter gray when disabled
    opacity: 0.5,
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: '#9ca3af',
  },
  scanButtonTextDisabled: {
    color: '#6b7280', // Darker gray text when disabled for better visibility
    textDecorationLine: 'line-through',
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
  zoomControls: {
    position: 'absolute',
    right: 20,
    top: '50%',
    transform: [{ translateY: -60 }],
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 25,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
  },
  zoomButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 4,
  },
  zoomText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginVertical: 4,
    minWidth: 40,
    textAlign: 'center',
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
    backgroundColor: '#ffffff', // White card
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  pendingSection: {
    backgroundColor: '#ffffff', // White card
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  recentSection: {
    backgroundColor: '#ffffff', // White card
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
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
    color: '#6b7280', // Medium gray text
    fontWeight: '500',
    marginBottom: 15,
  },
  photoGroup: {
    width: '100%',
  },
  booksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between', // Evenly distribute space
    width: '100%',
  },
  photoSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    marginHorizontal: 0,
    width: '100%',
    paddingHorizontal: 0,
  },
  separatorLine: {
    flex: 1,
    height: 1.5,
    backgroundColor: '#9ca3af', // Slightly darker for better visibility
  },
  separatorText: {
    marginHorizontal: 12,
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pendingBookCard: {
    backgroundColor: 'transparent',
    borderRadius: 8,
    padding: 0,
    marginBottom: 12,
    marginHorizontal: 0, // No horizontal margins, use space-between for even spacing
    flexDirection: 'column',
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
    // Calculate width: screenWidth - section margins (15*2) - section padding (20*2) = screenWidth - 70
    // For 3 columns with space-between: divide by 3, accounting for 2 gaps
    // Using space-between means gaps are automatically even, so we just need to account for available width
    // Subtract more to create more spacing between books
    width: (screenWidth - 70) / 3 - 12, // Subtract 12px to create more spacing between 3 items
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
    backgroundColor: '#f8f9fa', // Subtle gray
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  placeholderText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280', // Medium gray
    textAlign: 'center',
    lineHeight: 14,
  },
  bookInfo: {
    width: '100%',
    alignItems: 'center',
  },
  bookTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a', // Deep charcoal
    marginBottom: 2,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  bookAuthor: {
    fontSize: 11,
    color: '#6b7280', // Medium gray
    marginBottom: 6,
    textAlign: 'center',
    fontWeight: '500',
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
    backgroundColor: '#059669', // Emerald accent
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    flex: 1,
    alignItems: 'center',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 0,
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
    color: '#0056CC',
    marginTop: 4,
    fontStyle: 'italic',
    fontWeight: '600',
  },
  rejectedSection: {
    backgroundColor: '#ffffff', // White card
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  rejectedBookCard: {
    backgroundColor: '#f8f9fa', // Subtle gray
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626', // Red accent
    opacity: 0.85,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#faf8f3', // Warm cream background
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 20,
    backgroundColor: '#2d3748', // Match main app header color
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
    backgroundColor: '#0056CC',
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
    backgroundColor: '#0056CC',
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
    backgroundColor: '#2563eb', // Deep blue accent
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
    borderWidth: 0,
    minWidth: 110, // Fixed width to prevent resizing when text changes
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectAllButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  clearButton: {
    backgroundColor: '#6b7280', // Medium gray
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    shadowColor: '#6b7280',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
    borderWidth: 0,
  },
  clearButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  addAllButton: {
    flex: 1,
    backgroundColor: '#059669', // Emerald accent
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 0,
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
    backgroundColor: '#dc2626', // Red for delete
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
    borderColor: '#0056CC',
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
    paddingVertical: 14,
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
    fontSize: 15,
    fontWeight: '700',
    color: '#1a202c',
  },
  stickyToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stickySelectedCount: {
    fontSize: 12,
    color: '#4a5568',
    fontWeight: '600',
  },
  stickyButton: {
    backgroundColor: '#2563eb', // Deep blue accent
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 0,
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
    flex: 1,
    minHeight: 48,
  },
  stickyButtonDisabled: {
    opacity: 0.5,
  },
  stickyButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  stickyDeleteButton: {
    backgroundColor: '#dc2626', // Red for delete
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 0,
    shadowColor: '#dc2626',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
    flex: 1,
    minHeight: 48,
  },
  stickyDeleteButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  stickyEditButton: {
    backgroundColor: '#0056CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 0,
    shadowColor: '#0056CC',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minHeight: 48,
  },
  stickyEditButtonActive: {
    backgroundColor: '#dc2626',
    shadowColor: '#dc2626',
  },
  stickyEditButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  editActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  editActionButton: {
    flex: 1,
    minWidth: '30%',
    backgroundColor: '#0056CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0056CC',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  editActionButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  selectionIndicator: {},
  selectedCheckbox: {},
  unselectedCheckbox: {},
  checkmark: {},
  captionSection: {
    backgroundColor: '#ffffff', // White card
    borderRadius: 16,
    padding: 20,
    marginTop: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
  },
  captionLabel: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a', // Deep charcoal
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  captionHint: {
    fontSize: 13,
    color: '#6b7280', // Medium gray
    marginBottom: 12,
    fontStyle: 'italic',
  },
  scanningInBackgroundHint: {
    fontSize: 14,
    color: '#0056CC',
    marginBottom: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  captionInput: {
    backgroundColor: '#f8f9fa', // Subtle gray
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#1a1a1a', // Deep charcoal
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  captionSubmitButton: {
    backgroundColor: '#2563eb', // Deep blue accent
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
    backgroundColor: '#6b7280', // Medium gray
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
    backgroundColor: '#f8f9fa', // Subtle gray background
  },
  captionModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#2d3748',
    borderBottomWidth: 0,
  },
  captionProgressText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    marginLeft: 12,
    marginRight: 'auto',
  },
  captionSwipeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f7fafc',
    borderRadius: 8,
    gap: 8,
  },
  captionSwipeHintText: {
    fontSize: 12,
    color: '#718096',
    fontWeight: '500',
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
    backgroundColor: '#f8f9fa', // Subtle gray background
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
    backgroundColor: '#0056CC',
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
    borderColor: '#0056CC',
    backgroundColor: '#f0f8ff',
  },
  folderItemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a202c',
    marginBottom: 4,
  },
  folderItemNameSelected: {
    color: '#0056CC',
  },
  // Switch Covers Modal Styles
  switchCoversHeader: {
    padding: 20,
    backgroundColor: '#f8f9fa',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  switchCoversTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 12,
  },
  currentBookCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  currentBookCover: {
    width: 80,
    height: 120,
    borderRadius: 8,
    marginRight: 12,
  },
  currentBookCoverSmall: {
    width: 60,
    height: 90,
    borderRadius: 6,
    marginRight: 12,
  },
  currentBookInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  currentBookTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
  },
  currentBookAuthor: {
    fontSize: 14,
    color: '#6b7280',
  },
  switchCoversSection: {
    padding: 20,
  },
  switchCoversSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
  },
  coversGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  coverOption: {
    width: (screenWidth - 80) / 3, // 3 columns with padding
    aspectRatio: 0.67, // Book cover ratio
    borderRadius: 8,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  coverOptionImage: {
    width: '100%',
    height: '100%',
  },
  // Switch Book Modal Styles
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  searchInput: {
    flex: 1,
    height: 44,
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#1a202c',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  switchBookHeader: {
    padding: 16,
    backgroundColor: '#f8f9fa',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  switchBookHeaderTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 8,
  },
  searchResultsContainer: {
    flex: 1,
    padding: 16,
  },
  bookSearchResult: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  bookSearchResultCover: {
    width: 50,
    height: 75,
    borderRadius: 6,
    marginRight: 12,
  },
  bookSearchResultInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  bookSearchResultTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
  },
  bookSearchResultAuthor: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 2,
  },
  bookSearchResultDate: {
    fontSize: 12,
    color: '#9ca3af',
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6b7280',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
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
    backgroundColor: '#0056CC',
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


