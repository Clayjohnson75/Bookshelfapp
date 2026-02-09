/**
 * Auth: email/password only. No Apple/Google OAuth or ID tokens.
 *
 * RULE: Auth state comes only from Supabase (email/password). We do not use or persist
 * idToken, identityToken, provider_token, or any Apple/Google SDK token as session.
 *
 * Session is used as-is; we do not clear or reject based on JWT alg.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { supabase, SUPABASE_INSTANCE_ID, SUPABASE_ENV } from '../lib/supabase';
import { getEnvVar } from '../lib/getEnvVar';
import { Book, Photo, Folder } from '../types/BookTypes';
import * as BiometricAuth from '../services/biometricAuth';
import { saveBookToSupabase, savePhotoToSupabase } from '../services/supabaseSync';
import { PENDING_APPROVE_ACTION_KEY, ACTIVE_USER_ID_KEY } from '../lib/cacheKeys';

interface User {
  uid: string;
  email: string;
  username: string;
  displayName?: string;
  photoURL?: string;
  isGuest?: boolean; // Flag to identify guest users
}

// Guest user ID constant for local storage
export const GUEST_USER_ID = 'guest_user';

// Helper function to check if a user is a guest
export const isGuestUser = (user: User | null): boolean => {
  return user?.uid === GUEST_USER_ID || user?.isGuest === true;
};

interface AuthContextType {
  user: User | null;
  /** Supabase session — use this for gating (not user) so Library doesn't redirect before user is derived. */
  session: Session | null;
  loading: boolean;
  /** True only after init has finished (getSession retries done). Don't treat as guest until this is true. */
  authReady: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signInWithDemoAccount: () => Promise<boolean>;
  signUp: (email: string, password: string, username: string, displayName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<boolean>;
  updatePassword: (accessToken: string, newPassword: string) => Promise<boolean>;
  searchUsers: (query: string) => Promise<User[]>;
  getUserByUsername: (username: string) => Promise<User | null>;
  deleteAccount: () => Promise<void>;
  refreshAuthState: () => Promise<void>;
  biometricCapabilities: BiometricAuth.BiometricCapabilities | null;
  isBiometricEnabled: () => Promise<boolean>;
  signInWithBiometric: () => Promise<boolean>;
  enableBiometric: (email: string, password: string) => Promise<void>;
  disableBiometric: () => Promise<void>;
  /** Dev only: signOut(global) + clear Supabase auth storage keys. No-op in prod. */
  hardResetAuthStorageDev: () => Promise<void>;
  demoCredentials: {
    username: string;
    email: string;
    password: string;
  };
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

// Supabase auth storage key pattern: sb-<project-ref>-auth-token (project ref from Supabase URL).
// We filter by sb- / supabase / auth-token so we clear the right keys regardless of ref.
async function clearSupabaseStorage(): Promise<void> {
  console.log('[SESSION_STORAGE_CLEAR] clearSupabaseStorage()', new Error().stack);
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const supabaseKeys = allKeys.filter(key =>
      key.includes('supabase') || key.includes('sb-') || key.includes('auth-token')
    );
    // Step C: print the keys we're clearing so you can verify / add to hard reset if needed
    if (supabaseKeys.length > 0) {
      console.log('[SESSION_STORAGE_CLEAR] keys being removed:', supabaseKeys);
      await AsyncStorage.multiRemove(supabaseKeys);
    } else {
      console.log('[SESSION_STORAGE_CLEAR] no Supabase keys found (already clear or different key names)');
    }
  } catch (e) {
    console.warn('[SESSION_STORAGE_CLEAR] error:', e);
  }
}

/** Dev only: signOut(global) + nuke everything auth-related in AsyncStorage. Then fully kill the app and relaunch. */
export async function devResetAuth(supabaseClient: { auth: { signOut: (opts?: { scope?: string }) => Promise<{ error: unknown }> } }): Promise<void> {
  try {
    await supabaseClient.auth.signOut({ scope: 'global' });
  } catch (e) {}

  const keys = await AsyncStorage.getAllKeys();
  const kill = keys.filter(k =>
    k.includes('supabase') ||
    k.includes('sb-') ||
    k.includes('auth') ||
    k.includes('apple') ||
    k.includes('google') ||
    k.includes('token')
  );

  await AsyncStorage.multiRemove(kill);
  console.log('[DEV_RESET_AUTH] removed keys:', kill);
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [biometricCapabilities, setBiometricCapabilities] = useState<BiometricAuth.BiometricCapabilities | null>(null);
  const DEMO_USERNAME = 'test12';
  const DEMO_PASSWORD = 'admin12345';
  const DEMO_EMAIL = 'appstore.review+test12@bookshelfscanner.app';
  const DEMO_UID = 'demo-user-test12';
  const DEMO_SEEDED_KEY = `demo_seeded_${DEMO_UID}`;
  
  // Check biometric capabilities on mount (with delay to prevent crashes)
  useEffect(() => {
    // Delay the check slightly to ensure native modules are loaded
    const timer = setTimeout(() => {
      checkBiometricCapabilities();
    }, 500);
    
    return () => clearTimeout(timer);
  }, []);

  // Definitive log: tells us if the UI is still flipping. Healthy: authReady false→true, then hasSession stable.
  useEffect(() => {
    if (__DEV__) {
      console.log('[AUTH_SNAPSHOT]', { authReady, hasSession: !!session, userId: session?.user?.id ?? null });
    }
  }, [authReady, session?.user?.id]);

  const checkBiometricCapabilities = async () => {
    try {
      // Only check if we're on a native platform (not web)
      if (Platform.OS === 'web') {
        setBiometricCapabilities(null);
        return;
      }
      const capabilities = await BiometricAuth.checkBiometricAvailability();
      setBiometricCapabilities(capabilities);
    } catch (error) {
      console.error('Error checking biometric capabilities:', error);
      // Set to null if check fails - app will work without biometric
      setBiometricCapabilities(null);
    }
  };

  const handleDemoSignIn = async (saveUserToStorageFn: (userData: User) => Promise<void>) => {
    const demoUser: User = {
      uid: DEMO_UID,
      email: DEMO_EMAIL,
      username: DEMO_USERNAME,
      displayName: 'App Review Demo',
    };

    try {
      const alreadySeeded = await AsyncStorage.getItem(DEMO_SEEDED_KEY);
      if (!alreadySeeded) {
        const now = Date.now();
        const approvedBooks: Book[] = [
          {
            id: 'demo-book-1',
            title: 'The Great Gatsby',
            author: 'F. Scott Fitzgerald',
            confidence: 'high',
            status: 'approved',
            scannedAt: now - 1000 * 60 * 60 * 24,
            coverUrl: 'https://covers.openlibrary.org/b/id/7222246-L.jpg',
          },
          {
            id: 'demo-book-2',
            title: 'Atomic Habits',
            author: 'James Clear',
            confidence: 'high',
            status: 'approved',
            scannedAt: now - 1000 * 60 * 60 * 12,
            coverUrl: 'https://covers.openlibrary.org/b/id/9259255-L.jpg',
          },
          {
            id: 'demo-book-3',
            title: 'Becoming',
            author: 'Michelle Obama',
            confidence: 'medium',
            status: 'approved',
            scannedAt: now - 1000 * 60 * 30,
            coverUrl: 'https://covers.openlibrary.org/b/id/9253191-L.jpg',
          },
        ];

        const pendingBooks: Book[] = [
          {
            id: 'demo-book-4',
            title: 'The Midnight Library',
            author: 'Matt Haig',
            confidence: 'medium',
            status: 'pending',
            scannedAt: now - 1000 * 60 * 15,
          },
        ];

        const rejectedBooks: Book[] = [
          {
            id: 'demo-book-5',
            title: 'Unknown Title',
            author: 'Unknown',
            confidence: 'low',
            status: 'rejected',
            scannedAt: now - 1000 * 60 * 45,
          },
        ];

        const photos: Photo[] = [
          {
            id: 'demo-photo-1',
            uri: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=1200&q=80',
            books: approvedBooks,
            timestamp: now - 1000 * 60 * 60,
            caption: 'Living Room Bookshelf',
          },
          {
            id: 'demo-photo-2',
            uri: 'https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=1200&q=80',
            books: pendingBooks,
            timestamp: now - 1000 * 60 * 20,
            caption: 'Office Desk',
          },
        ];

        const folders: Folder[] = [
          {
            id: 'demo-folder-1',
            name: 'Classics',
            bookIds: ['demo-book-1'],
            photoIds: ['demo-photo-1'],
            createdAt: now - 1000 * 60 * 60 * 24 * 3,
          },
          {
            id: 'demo-folder-2',
            name: 'Personal Growth',
            bookIds: ['demo-book-2'],
            photoIds: ['demo-photo-2'],
            createdAt: now - 1000 * 60 * 60 * 10,
          },
        ];

        await AsyncStorage.multiSet([
          [`approved_books_${DEMO_UID}`, JSON.stringify(approvedBooks)],
          [`pending_books_${DEMO_UID}`, JSON.stringify(pendingBooks)],
          [`rejected_books_${DEMO_UID}`, JSON.stringify(rejectedBooks)],
          [`photos_${DEMO_UID}`, JSON.stringify(photos)],
          [`folders_${DEMO_UID}`, JSON.stringify(folders)],
          [`usernameToEmail:${DEMO_USERNAME}`, DEMO_EMAIL],
        ]);
        await AsyncStorage.setItem(DEMO_SEEDED_KEY, 'true');
      }
    } catch (error) {
      console.warn('Failed to seed demo data', error);
    }

    setUser(demoUser);
    await saveUserToStorageFn(demoUser);
    
    // Transfer guest data to the demo account
    await transferGuestDataToUser(DEMO_UID);
  };

  const fetchUserProfile = async (userId: string): Promise<{ username: string; displayName?: string; photoURL?: string }> => {
    if (!supabase) {
      // Fallback to local storage if Supabase not configured
      const username = (await AsyncStorage.getItem('username:' + userId)) || '';
      const displayName = (await AsyncStorage.getItem('displayName:' + userId)) || undefined;
      const photoURL = (await AsyncStorage.getItem('photoURL:' + userId)) || undefined;
      return { username, displayName, photoURL };
    }
    
    const { data, error } = await supabase
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', userId)
      .single();
    
    if (error || !data) {
      // Fallback to local storage for backwards compatibility
      const username = (await AsyncStorage.getItem('username:' + userId)) || '';
      const displayName = (await AsyncStorage.getItem('displayName:' + userId)) || undefined;
      const photoURL = (await AsyncStorage.getItem('photoURL:' + userId)) || undefined;
      return { username, displayName, photoURL };
    }
    
    return {
      username: data.username || '',
      displayName: data.display_name || undefined,
      photoURL: data.avatar_url || undefined,
    };
  };

  // authReady: false on first render. getSession() once on mount → set session → set authReady true → subscribe to onAuthStateChange.
  const authUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      setAuthReady(true);
      setLoading(false);
      return;
    }
    if (__DEV__) console.log('[SUPABASE_INSTANCE][SimpleAuthContext]', SUPABASE_INSTANCE_ID);

    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) console.log('[AUTH] getSession error', error);

      let sess: Session | null = data?.session ?? null;
      if (error) {
        sess = null;
      }

      setSession(sess);
      setAuthReady(true);
      setLoading(false);

      const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
        if (event === 'INITIAL_SESSION' && newSession == null) return;
        setSession(newSession ?? null);
      });
      authUnsubRef.current = () => sub.subscription.unsubscribe();
    })();

    return () => {
      authUnsubRef.current?.();
      authUnsubRef.current = null;
    };
  }, []);

  // Derive user from session only when authReady. Guest ONLY when authReady === true AND session === null; never earlier.
  useEffect(() => {
    if (!authReady) {
      setUser(null);
      return;
    }
    if (session?.user) {
      const sessionUser = session.user;
      fetchUserProfile(sessionUser.id)
        .then(profile => {
          const userData: User = {
            uid: sessionUser.id,
            email: sessionUser.email || '',
            username: profile?.username || '',
            displayName: profile?.displayName,
            photoURL: profile?.photoURL,
          };
          setUser(userData);
          return saveUserToStorage(userData).then(() => transferGuestDataToUser(sessionUser.id));
        })
        .catch(() => {
          const userData: User = {
            uid: sessionUser.id,
            email: sessionUser.email || '',
            username: sessionUser.email?.split('@')[0] || '',
            displayName: undefined,
            photoURL: undefined,
          };
          setUser(userData);
          return saveUserToStorage(userData).then(() => transferGuestDataToUser(sessionUser.id));
        });
    } else if (session === null) {
      // Guest mode ONLY when authReady and we know there is no session (not during boot/transition).
      AsyncStorage.removeItem('user');
      setUser({
        uid: GUEST_USER_ID,
        email: '',
        username: 'guest',
        displayName: 'Guest',
        isGuest: true,
      });
    } else {
      // session undefined or not yet resolved — do not set guest; leave user null until resolved
      setUser(null);
    }
  }, [session, authReady]);

  // Keep active_user_id in sync so cache keys always match current user; clear when no user.
  useEffect(() => {
    if (user?.uid) {
      AsyncStorage.setItem(ACTIVE_USER_ID_KEY, user.uid).catch(() => {});
    } else {
      AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
    }
  }, [user?.uid]);

  const loadUserFromStorage = async () => {
    try {
      const userData = await AsyncStorage.getItem('user');
      if (userData) {
        const parsed = JSON.parse(userData);
        // Only load if it's not a guest user (guest users don't persist)
        if (parsed.uid !== GUEST_USER_ID) {
          setUser(parsed);
        } else {
          // If guest was saved, clear it and use fresh guest
          setUser({
            uid: GUEST_USER_ID,
            email: '',
            username: 'guest',
            displayName: 'Guest',
            isGuest: true,
          });
        }
      } else {
        // No user in storage - use guest mode
        setUser({
          uid: GUEST_USER_ID,
          email: '',
          username: 'guest',
          displayName: 'Guest',
          isGuest: true,
        });
      }
    } catch (error) {
      console.error('Error loading user:', error);
      // On error, default to guest mode
      setUser({
        uid: GUEST_USER_ID,
        email: '',
        username: 'guest',
        displayName: 'Guest',
        isGuest: true,
      });
    } finally {
      setLoading(false);
    }
  };

  const saveUserToStorage = async (userData: User) => {
    try {
      await AsyncStorage.setItem('user', JSON.stringify(userData));
    } catch (error) {
      console.error('Error saving user:', error);
    }
  };

  /**
   * Transfer guest data (pending books, photos, etc.) to the signed-in user account
   * This ensures that when a guest signs in, their scanned books and photos are preserved
   */
  const transferGuestDataToUser = async (userId: string): Promise<void> => {
    try {
      console.log('🔄 Checking for guest data to transfer...');
      
      // Load guest data from AsyncStorage
      const guestPendingKey = `pending_books_${GUEST_USER_ID}`;
      const guestApprovedKey = `approved_books_${GUEST_USER_ID}`;
      const guestRejectedKey = `rejected_books_${GUEST_USER_ID}`;
      const guestPhotosKey = `photos_${GUEST_USER_ID}`;
      
      const [guestPendingData, guestApprovedData, guestRejectedData, guestPhotosData] = await Promise.all([
        AsyncStorage.getItem(guestPendingKey),
        AsyncStorage.getItem(guestApprovedKey),
        AsyncStorage.getItem(guestRejectedKey),
        AsyncStorage.getItem(guestPhotosKey),
      ]);
      
      // Parse guest data
      const guestPending: Book[] = guestPendingData ? JSON.parse(guestPendingData) : [];
      const guestApproved: Book[] = guestApprovedData ? JSON.parse(guestApprovedData) : [];
      const guestRejected: Book[] = guestRejectedData ? JSON.parse(guestRejectedData) : [];
      const guestPhotos: Photo[] = guestPhotosData ? JSON.parse(guestPhotosData) : [];
      
      // Check if there's any guest data to transfer
      if (guestPending.length === 0 && guestApproved.length === 0 && guestRejected.length === 0 && guestPhotos.length === 0) {
        console.log('✅ No guest data to transfer');
        return;
      }
      
      console.log(`📦 Transferring guest data: ${guestPending.length} pending, ${guestApproved.length} approved, ${guestRejected.length} rejected, ${guestPhotos.length} photos`);
      
      // Load existing user data (if any)
      const userPendingKey = `pending_books_${userId}`;
      const userApprovedKey = `approved_books_${userId}`;
      const userRejectedKey = `rejected_books_${userId}`;
      const userPhotosKey = `photos_${userId}`;
      
      const [userPendingData, userApprovedData, userRejectedData, userPhotosData] = await Promise.all([
        AsyncStorage.getItem(userPendingKey),
        AsyncStorage.getItem(userApprovedKey),
        AsyncStorage.getItem(userRejectedKey),
        AsyncStorage.getItem(userPhotosKey),
      ]);
      
      const userPending: Book[] = userPendingData ? JSON.parse(userPendingData) : [];
      const userApproved: Book[] = userApprovedData ? JSON.parse(userApprovedData) : [];
      const userRejected: Book[] = userRejectedData ? JSON.parse(userRejectedData) : [];
      const userPhotos: Photo[] = userPhotosData ? JSON.parse(userPhotosData) : [];
      
      // Helper function to deduplicate books by title + author
      const deduplicateBooks = (existing: Book[], newBooks: Book[]): Book[] => {
        const existingKeys = new Set(
          existing.map(book => `${book.title?.toLowerCase().trim()}_${book.author?.toLowerCase().trim() || 'noauthor'}`)
        );
        
        const uniqueNewBooks = newBooks.filter(book => {
          const key = `${book.title?.toLowerCase().trim()}_${book.author?.toLowerCase().trim() || 'noauthor'}`;
          return !existingKeys.has(key);
        });
        
        return [...existing, ...uniqueNewBooks];
      };
      
      // Merge guest data with user data (deduplicate)
      const mergedPending = deduplicateBooks(userPending, guestPending);
      const mergedApproved = deduplicateBooks(userApproved, guestApproved);
      const mergedRejected = deduplicateBooks(userRejected, guestRejected);
      
      // Merge photos (deduplicate by ID)
      const existingPhotoIds = new Set(userPhotos.map(photo => photo.id));
      const uniqueGuestPhotos = guestPhotos.filter(photo => !existingPhotoIds.has(photo.id));
      const mergedPhotos = [...userPhotos, ...uniqueGuestPhotos];
      
      // Save merged data to user's AsyncStorage
      await Promise.all([
        AsyncStorage.setItem(userPendingKey, JSON.stringify(mergedPending)),
        AsyncStorage.setItem(userApprovedKey, JSON.stringify(mergedApproved)),
        AsyncStorage.setItem(userRejectedKey, JSON.stringify(mergedRejected)),
        AsyncStorage.setItem(userPhotosKey, JSON.stringify(mergedPhotos)),
      ]);
      
      console.log(`✅ Saved merged data to user account: ${mergedPending.length} pending, ${mergedApproved.length} approved, ${mergedRejected.length} rejected, ${mergedPhotos.length} photos`);
      
      // Save to Supabase (non-blocking - don't wait for it)
      Promise.all([
        // Save all books to Supabase
        ...guestPending.map(book => saveBookToSupabase(userId, book, 'pending')),
        ...guestApproved.map(book => saveBookToSupabase(userId, book, 'approved')),
        ...guestRejected.map(book => saveBookToSupabase(userId, book, 'rejected')),
        // Save all photos to Supabase
        ...guestPhotos
          .filter(photo => photo.uri && typeof photo.uri === 'string' && photo.uri.trim().length > 0)
          .map(photo => savePhotoToSupabase(userId, photo)),
      ]).then(() => {
        console.log('✅ Guest data synced to Supabase');
      }).catch(error => {
        console.error('⚠️ Error syncing guest data to Supabase (non-blocking):', error);
      });
      
      // Clear guest data after successful transfer
      await Promise.all([
        AsyncStorage.removeItem(guestPendingKey),
        AsyncStorage.removeItem(guestApprovedKey),
        AsyncStorage.removeItem(guestRejectedKey),
        AsyncStorage.removeItem(guestPhotosKey),
      ]);
      
      console.log('✅ Guest data cleared from AsyncStorage');
    } catch (error) {
      console.error('❌ Error transferring guest data:', error);
      // Don't throw - this is non-critical, user can still use the app
    }
  };

  const signInWithDemoAccount = async (): Promise<boolean> => {
    try {
      setLoading(true);
      await handleDemoSignIn(saveUserToStorage);
      return true;
    } catch (error) {
      console.error('Demo sign in error:', error);
      Alert.alert('Sign In Error', 'Unable to load the demo account right now. Please try again.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const signIn = async (emailOrUsername: string, password: string): Promise<boolean> => {
    const normalizedInput = emailOrUsername.trim().toLowerCase();
    const cleanedPassword = password.trim();
    const isDemoIdentifier = normalizedInput === DEMO_USERNAME || normalizedInput === DEMO_EMAIL.toLowerCase();
    const isDemoLogin = isDemoIdentifier && cleanedPassword === DEMO_PASSWORD;

    if (isDemoLogin) {
      return signInWithDemoAccount();
    }

    try {
      setLoading(true);
      
      if (!supabase) {
        Alert.alert('Sign In Error', 'Supabase not configured. In .env set dev vars (EXPO_PUBLIC_SUPABASE_URL_DEV, _ANON_KEY_DEV) or prod (EXPO_PUBLIC_SUPABASE_URL, _ANON_KEY). app.config chooses by env.');
        setLoading(false);
        return false;
      }

      // Dev sign-in diagnostic: which Supabase and email vs username
      const { SUPABASE_REF } = await import('../lib/supabase');
      const isUsername = !emailOrUsername.trim().includes('@');
      console.log('[AUTH DEV] signIn → Supabase ref:', SUPABASE_REF, 'input:', isUsername ? 'username' : 'email');
      
      // Allow username sign-in by resolving to email from Supabase
      let email = emailOrUsername.trim();
      const requestedUsername = !emailOrUsername.includes('@') ? emailOrUsername.toLowerCase() : null;
      
      if (requestedUsername) {
        try {
          // FIRST: Check cached email - use it immediately if available (fastest path)
          const cachedEmail = await AsyncStorage.getItem('usernameToEmail:' + requestedUsername);
          if (cachedEmail) {
            console.log(`✅ Using cached email for username "${requestedUsername}"`);
            email = cachedEmail;
          } else {
            // No cache, try to fetch from server
          // CRITICAL: Clear any stale username-to-email mappings first to prevent wrong account sign-in
          // This ensures we always get fresh data from the server
          await AsyncStorage.removeItem('usernameToEmail:' + requestedUsername);
          
          // Try RPC first (works in dev), but fallback to API endpoint (works in production)
          let emailData = null;
          let rpcError = null;
          
          try {
            // Add timeout to RPC call (reduced to 3 seconds for faster fallback)
            console.log('Attempting RPC call for username:', requestedUsername);
            const rpcPromise = supabase.rpc('get_email_by_username', {
              username_input: requestedUsername,
            });
            const rpcTimeout = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('RPC timeout after 3 seconds')), 3000)
            );
            
            const rpcResult = await Promise.race([rpcPromise, rpcTimeout]) as any;
            emailData = rpcResult?.data;
            rpcError = rpcResult?.error;
            console.log('RPC result:', { emailData, error: rpcError?.message });
          } catch (rpcErr: any) {
            console.log('RPC call failed or timed out, trying API endpoint:', rpcErr?.message);
            rpcError = rpcErr;
          }
          
          // Fallback: Use API endpoint if RPC fails (more reliable in production)
          if (rpcError || !emailData) {
              console.log('RPC failed or returned no data, trying API endpoint for username lookup:', requestedUsername);
              console.log('RPC error:', rpcError?.message || 'No error object');
              console.log('RPC data:', emailData);
              
              try {
                // Use environment variable with correct fallback
                // Use www subdomain to avoid redirect issues
                let apiUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
                
                // Safety check: override old URL if somehow it got through
                if (apiUrl.includes('bookshelfapp-five')) {
                  console.warn('⚠️ Detected old API URL in env var, overriding:', apiUrl);
                  apiUrl = 'https://www.bookshelfscan.app';
                }
                
                // Ensure we use www to avoid redirect CORS issues
                if (apiUrl === 'https://bookshelfscan.app') {
                  apiUrl = 'https://www.bookshelfscan.app';
                }
                
                console.log('Calling API endpoint:', `${apiUrl}/api/get-email-by-username`);
                console.log('API URL source check:', {
                  envVar: getEnvVar('EXPO_PUBLIC_API_BASE_URL'),
                  final: apiUrl,
                  isProduction: process.env.EAS_ENV === 'production' || getEnvVar('EAS_ENV') === 'production',
                  supabaseConfigured: !!supabase
                });
                
                // Add timeout to API call to prevent infinite loading (reduced to 5 seconds)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                  controller.abort();
                }, 5000); // 5 second timeout
                
                let response: Response;
                try {
                  response = await fetch(`${apiUrl}/api/get-email-by-username`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: requestedUsername }),
                    signal: controller.signal,
              });
                  clearTimeout(timeoutId);
                } catch (fetchError: any) {
                  clearTimeout(timeoutId);
                  if (fetchError.name === 'AbortError' || fetchError.message?.includes('aborted')) {
                    throw new Error('Request timed out. Please check your connection and try again.');
                  }
                  throw fetchError;
                }
                
                console.log('API response status:', response.status, response.statusText);
              
              // Check content type before parsing
              const contentType = response.headers.get('content-type') || '';
              const isJson = contentType.includes('application/json');
              
              if (response.ok) {
                let data;
                if (isJson) {
                  data = await response.json();
                } else {
                  const text = await response.text();
                  console.error('⚠️ API returned non-JSON response:', text.substring(0, 200));
                  throw new Error('Server returned invalid response. Please try again.');
                }
                  console.log('API response data:', data);
                if (data.email) {
                  email = data.email;
                  // Cache the mapping for future use
                  await AsyncStorage.setItem('usernameToEmail:' + requestedUsername, email);
                  console.log(`✅ Username "${requestedUsername}" resolved to email via API: ${email}`);
                } else {
                  throw new Error('No email returned from API');
                }
                } else if (response.status === 404) {
                  // Username doesn't exist - this is a valid response, not a connection error
                  const errorText = await response.text();
                  let errorData;
                  if (isJson) {
                  try {
                    errorData = JSON.parse(errorText);
                  } catch {
                      errorData = { message: 'Username not found' };
                    }
                  } else {
                    errorData = { message: 'Username not found' };
                  }
                  // Show user-friendly error and return false (don't try cached email for non-existent username)
                  setLoading(false);
                  Alert.alert('Sign In Error', errorData.message || 'This username does not exist. Please check your username and try again.');
                  return false;
              } else {
                  // Other errors (500, etc.) - treat as connection/server error
                  const errorText = await response.text();
                  console.error('API error response:', errorText.substring(0, 200));
                  let errorData;
                  if (isJson) {
                  try {
                    errorData = JSON.parse(errorText);
                  } catch {
                    errorData = { message: errorText || 'API call failed' };
                    }
                  } else {
                    // HTML error page or other non-JSON response
                    errorData = { message: `Server error (${response.status}). Please try again later.` };
                  }
                  throw new Error(errorData.message || errorData.error || `API returned ${response.status}`);
              }
            } catch (apiError: any) {
              console.error('API endpoint failed:', apiError);
                console.error('API error details:', {
                  message: apiError?.message,
                  stack: apiError?.stack,
                  name: apiError?.name
                });
                
                // Always clear loading state first to prevent infinite loading
              setLoading(false);
                
                // Try cached email first - this is the most reliable fallback
                const cachedEmail = await AsyncStorage.getItem('usernameToEmail:' + requestedUsername);
                if (cachedEmail) {
                  console.log(`✅ Using cached email for username "${requestedUsername}"`);
                  email = cachedEmail;
                  // Continue with sign-in using cached email (don't return false)
                } else {
                  // If no cache and API failed, show helpful error
                  const isTimeout = apiError?.message?.includes('timeout') || apiError?.message?.includes('timed out');
                  const errorMessage = isTimeout
                    ? 'The server is not responding. Please check your internet connection and try again. If this persists, the API endpoint may need to be deployed.'
                    : 'Could not verify username. Please check your connection and try again.';
                  Alert.alert('Sign In Error', errorMessage);
              return false;
                }
            }
          } else {
            email = emailData;
            // Cache the mapping for future use
            await AsyncStorage.setItem('usernameToEmail:' + requestedUsername, email);
            console.log(`✅ Username "${requestedUsername}" resolved to email via RPC: ${email}`);
            }
          }
        } catch (error: any) {
          console.error('Username lookup error:', error);
          Alert.alert('Sign In Error', 'Could not verify username. Please check your connection and try again.');
          setLoading(false);
          return false;
        }
      }
      
      // Do not call signOut() before sign-in — it can trigger SIGNED_OUT during/after sign-in and cause a bounce.
      // signInWithPassword will replace any existing session.

      // Sign in with timeout protection
      try {
        const signInPromise = supabase.auth.signInWithPassword({ email, password: cleanedPassword });
        const signInTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sign in timeout')), 10000)
        );
        const signInResult = await Promise.race([signInPromise, signInTimeoutPromise]) as any;
        const { data, error } = signInResult;
        const res = signInResult;

        console.log('[SIGNIN_RAW]', JSON.stringify({
          hasDataSession: !!res.data?.session,
          dataUserId: res.data?.user?.id ?? null,
          sessionUserId: res.data?.session?.user?.id ?? null,
          provider: res.data?.user?.app_metadata?.provider ?? null,
          accessTokenHeader: res.data?.session?.access_token?.slice(0, 40) ?? null,
          refreshTokenPresent: !!res.data?.session?.refresh_token,
          error: res.error ? { message: res.error.message, status: (res.error as any).status } : null,
        }, null, 2));

        const token = res.data?.session?.access_token;
        let payload: { iss?: string; aud?: string; sub?: string; exp?: number } | null = null;
        if (token) {
          try {
            const b64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '';
            const decoded = (typeof globalThis !== 'undefined' && globalThis.atob ? globalThis.atob(b64) : '');
            if (decoded) payload = JSON.parse(decoded);
          } catch (_) {}
        }
        console.log('[JWT_PAYLOAD_DEBUG]', JSON.stringify({
          iss: payload?.iss,
          aud: payload?.aud,
          sub: payload?.sub,
          exp: payload?.exp,
        }, null, 2));
        // Supabase: iss like https://<ref>.supabase.co/auth/v1. Apple: iss would be https://appleid.apple.com

        const { data: sessionAfterWrite } = await supabase.auth.getSession();
        console.log('[SESSION_AFTER_WRITE]', JSON.stringify({
          header: sessionAfterWrite.session?.access_token?.slice(0, 40),
          hasRefresh: !!sessionAfterWrite.session?.refresh_token,
        }, null, 2));

        console.log('[AUTH_METHOD]', 'signInWithPassword');

        console.log('[AUTH] signIn error=', error?.message, 'code=', error?.code);
        console.log('[AUTH] signIn session userId=', data?.session?.user?.id);
        console.log('[AUTH] signIn tokenLen=', data?.session?.access_token?.length);
        if (!data?.session) console.log('[AUTH] signIn data.session is null — sign-in did not complete');

        if (error || !data?.user) {
          const errorMessage = getSignInErrorMessage(error);
          // Dev: log raw error so you can see exact Supabase response (e.g. email_not_confirmed)
          if (error) {
            console.log('[AUTH DEV] signIn failed — raw error:', { message: error.message, code: error.code, status: error.status });
            if ((error.message || '').includes('Email not confirmed') || (error as any).code === 'email_not_confirmed') {
              console.log('[AUTH DEV] Email not confirmed → In Supabase Dashboard (dev): Auth → Providers → Email, disable "Confirm email" OR Auth → Users → confirm the user.');
            }
          }
          Alert.alert('Sign In Error', errorMessage);
          setLoading(false);
          return false;
        }

        const { data: s } = await supabase.auth.getSession();
        console.log('[POST_SIGNIN_SESSION]', JSON.stringify({
          hasSession: !!s.session,
          userId: s.session?.user?.id ?? null,
          accessTokenAlg: s.session?.access_token?.split('.')?.[0] ?? null,
          tokenLen: s.session?.access_token?.length ?? 0,
        }, null, 2));

        const sUser = data.user;
        
        // Fetch profile with error handling and timeout protection
        let profile;
        try {
          const profilePromise = fetchUserProfile(sUser.id);
          const profileTimeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Profile fetch timeout')), 5000)
          );
          profile = await Promise.race([profilePromise, profileTimeoutPromise]) as any;
        } catch (profileError) {
          console.warn('Profile fetch error, using basic user data:', profileError);
          // Use basic data if profile fetch fails
          profile = {
            username: sUser.email?.split('@')[0] || '',
            displayName: undefined,
            photoURL: undefined,
          };
        }
        
        const userData: User = {
          uid: sUser.id,
          email: sUser.email || '',
          username: profile?.username || sUser.email?.split('@')[0] || '',
          displayName: profile?.displayName,
          photoURL: profile?.photoURL,
        };
        
        // CRITICAL: Verify that the signed-in user matches the requested username
        // This prevents signing into the wrong account due to stale mappings
        if (requestedUsername) {
          const signedInUsername = userData.username.toLowerCase();
          if (signedInUsername !== requestedUsername) {
            console.error(`❌ Username mismatch! Requested: "${requestedUsername}", Signed in: "${signedInUsername}"`);
            await AsyncStorage.removeItem('user');
            setSession(null);
            Alert.alert(
              'Sign In Error', 
              `Username mismatch. You requested "${requestedUsername}" but signed in as "${signedInUsername}". Please try again.`
            );
            setLoading(false);
            return false;
          }
          console.log(`✅ Verified username match: "${requestedUsername}" = "${signedInUsername}"`);
        }

        // Do not call setSession manually — Supabase persists the session when signInWithPassword succeeds.

        // Update React state so Library (which gates on session) sees the session immediately.
        setSession(data.session);
        setUser(userData);
        await saveUserToStorage(userData);
        
        // Update the username-to-email mapping with the correct email
        if (requestedUsername && userData.email) {
          await AsyncStorage.setItem('usernameToEmail:' + requestedUsername, userData.email);
        }
        
        // Transfer guest data to the signed-in account
        await transferGuestDataToUser(userData.uid);
        
        setLoading(false);
        return true;
      } catch (signInError: any) {
        console.error('Sign in error:', signInError);
        const errorMessage = signInError?.message?.includes('timeout') 
          ? 'Connection timeout. Please check your internet connection and try again.'
          : getSignInErrorMessage(signInError);
        Alert.alert('Sign In Error', errorMessage);
        setLoading(false);
        return false;
      }
    } catch (error: any) {
      console.error('Sign in error:', error);
      const errorMessage = getSignInErrorMessage(error);
      Alert.alert('Sign In Error', errorMessage);
      setLoading(false);
      return false;
    } finally {
      // CRITICAL: Always clear loading state, even if something unexpected happens
      // This prevents infinite loading screens
      setLoading(false);
    }
  };

  // Helper function to parse Supabase error messages into user-friendly messages
  const getSignInErrorMessage = (error: any): string => {
    if (!error) return 'Invalid credentials. Please check your email/username and password.';
    
    const errorMessage = error?.message || error?.toString() || '';
    const errorCode = error?.code || error?.status || '';
    
    // Check for specific error messages
    if (errorMessage.includes('Invalid login credentials') || 
        errorMessage.includes('invalid_credentials') ||
        errorMessage.includes('Invalid password') ||
        errorCode === 'invalid_credentials') {
      return 'Invalid email/username or password. Please check your credentials and try again.';
    }
    
    if (errorMessage.includes('Email not confirmed') || 
        errorMessage.includes('email_not_confirmed')) {
      return 'Please check your email and confirm your account before signing in.';
    }
    
    if (errorMessage.includes('User not found') || 
        errorMessage.includes('user_not_found')) {
      return 'No account found with this email/username. Please sign up first.';
    }
    
    if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
      return 'Connection timeout. Please check your internet connection and try again.';
    }
    
    if (errorMessage.includes('Too many requests') || 
        errorMessage.includes('rate_limit')) {
      return 'Too many sign-in attempts. Please wait a few minutes and try again.';
    }
    
    // Return the original message if it's user-friendly, otherwise return a generic message
    if (errorMessage && errorMessage.length < 100) {
      return errorMessage;
    }
    
    return 'Unable to sign in. Please check your internet connection and try again.';
  };

  // Helper function to parse Supabase sign-up error messages into user-friendly messages
  const getSignUpErrorMessage = (error: any): string => {
    if (!error) return 'Failed to create account. Please try again.';
    
    // Log full error for debugging
    console.error('Sign up error details:', {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      status: error?.status,
      fullError: JSON.stringify(error, null, 2)
    });
    
    const errorMessage = error?.message || error?.toString() || '';
    const errorCode = error?.code || error?.status || '';
    
    // Check for specific error messages
    if (errorMessage.includes('User already registered') || 
        errorMessage.includes('already registered') ||
        errorMessage.includes('email_address_already_exists') ||
        errorCode === 'email_address_already_exists') {
      return 'This email is already registered. Please sign in instead or use a different email.';
    }
    
    if (errorMessage.includes('Password should be at least') || 
        errorMessage.includes('password_too_short') ||
        errorMessage.includes('Password length')) {
      return 'Password must be at least 6 characters long.';
    }
    
    if (errorMessage.includes('Invalid email') || 
        errorMessage.includes('invalid_email') ||
        errorMessage.includes('Email format')) {
      return 'Please enter a valid email address.';
    }
    
    if (errorMessage.includes('Username') && errorMessage.includes('taken')) {
      return 'This username is already taken. Please choose another.';
    }
    
    if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
      return 'Connection timeout. Please check your internet connection and try again.';
    }
    
    if (errorMessage.includes('Too many requests') || 
        errorMessage.includes('rate_limit')) {
      return 'Too many sign-up attempts. Please wait a few minutes and try again.';
    }
    
    // Return the original message if it's user-friendly, otherwise return a generic message
    if (errorMessage && errorMessage.length < 100 && !errorMessage.includes('supabase')) {
      return errorMessage;
    }
    
    return 'Unable to create account. Please check your internet connection and try again.';
  };

  const signUp = async (email: string, password: string, username: string, displayName: string): Promise<boolean> => {
    try {
      setLoading(true);
      
      if (!supabase) {
        Alert.alert('Sign Up Error', 'Supabase not configured. In .env set dev vars (EXPO_PUBLIC_SUPABASE_URL_DEV, _ANON_KEY_DEV) or prod (EXPO_PUBLIC_SUPABASE_URL, _ANON_KEY). app.config chooses by env.');
        setLoading(false);
        return false;
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        Alert.alert('Sign Up Error', 'Please enter a valid email address.');
        setLoading(false);
        return false;
      }
      
      // Validate username format (alphanumeric and underscores only, 3-20 chars)
      const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
      if (!usernameRegex.test(username)) {
        Alert.alert('Sign Up Error', 'Username must be 3-20 characters and contain only letters, numbers, and underscores');
        setLoading(false);
        return false;
      }
      
      // CRITICAL: Check if email already exists BEFORE attempting signup
      // This prevents creating duplicate unconfirmed users
      try {
        const apiBaseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://bookshelfscan.app';
        const checkResponse = await fetch(`${apiBaseUrl}/api/check-email-exists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        
        if (checkResponse.ok) {
          const checkData = await checkResponse.json();
          console.log('Email check result:', checkData);
          
          if (checkData.exists) {
            // Email exists - check if it's confirmed
            if (checkData.confirmed) {
              // Confirmed user exists - this is definitely a duplicate
              Alert.alert('Sign Up Error', 'This email is already registered. Please sign in instead or use a different email.');
              setLoading(false);
              return false;
            } else {
              // Unconfirmed user exists - we could allow this, but it's better to prevent duplicates
              Alert.alert('Sign Up Error', 'An account with this email is pending confirmation. Please check your email or use a different email address.');
              setLoading(false);
              return false;
            }
          }
        } else {
          console.warn('Email check API failed, continuing with signup');
        }
      } catch (checkErr) {
        console.warn('Email check failed, continuing with signup:', checkErr);
        // Continue - the check is optional but recommended
      }
      
      // Check if username is already taken (with timeout)
      try {
        const usernameCheckPromise = supabase
          .from('profiles')
          .select('username')
          .eq('username', username.toLowerCase())
          .single();
        const usernameTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Username check timeout')), 5000)
        );
        
        const { data: existingProfile } = await Promise.race([usernameCheckPromise, usernameTimeout]) as any;
        
        if (existingProfile) {
          Alert.alert('Sign Up Error', 'This username is already taken. Please choose another.');
          setLoading(false);
          return false;
        }
      } catch (usernameError: any) {
        console.warn('Username check error, continuing anyway:', usernameError);
        // Continue with sign-up if username check fails (might be network issue)
      }
      
      // Sign up with metadata so trigger can create profile (with timeout)
      // Enable email confirmation - user must confirm email before accessing account
      // 
      // IMPORTANT: To prevent duplicate emails, disable Supabase's automatic email sending:
      // 1. Go to Supabase Dashboard → Authentication → Settings
      // 2. Under "Email Auth", toggle OFF "Enable email confirmations" 
      //    OR configure custom SMTP with a no-op email service
      // 3. Our custom API at /api/send-confirmation-email handles all emails via Resend
      //
      // If automatic emails are enabled in Supabase, users will receive TWO emails:
      // - One from Supabase (automatic when signUp() is called)
      // - One from Resend (via our custom API)
      try {
        const signUpPromise = supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: 'bookshelfscanner://confirm-email',
            data: {
              username: username.toLowerCase(),
              display_name: displayName,
            },
          },
        });
        const signUpTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sign up timeout')), 10000)
        );
        
        const { data, error } = await Promise.race([signUpPromise, signUpTimeout]) as any;
        
        // Log the full response for debugging
        console.log('Signup response:', { 
          hasUser: !!data?.user, 
          hasSession: !!data?.session,
          userEmail: data?.user?.email,
          error: error?.message,
          errorCode: error?.code 
        });
        
        if (error) {
          // Check for duplicate email error specifically
          const errorMessage = error?.message || '';
          const errorCode = error?.code || '';
          
          console.log('Signup error details:', { errorMessage, errorCode, fullError: error });
          
          // Check all possible duplicate email error patterns
          const isDuplicateEmail = 
            errorMessage.toLowerCase().includes('user already registered') || 
            errorMessage.toLowerCase().includes('already registered') ||
            errorMessage.toLowerCase().includes('email_address_already_exists') ||
            errorMessage.toLowerCase().includes('email already registered') ||
            errorMessage.toLowerCase().includes('user with this email already exists') ||
            errorMessage.toLowerCase().includes('email address is already registered') ||
            errorMessage.toLowerCase().includes('email already in use') ||
            errorCode === 'email_address_already_exists' ||
            errorCode === 'user_already_registered' ||
            errorCode === 'signup_disabled';
          
          if (isDuplicateEmail) {
            Alert.alert('Sign Up Error', 'This email is already registered. Please sign in instead or use a different email.');
            setLoading(false);
            return false;
          }
          
          const friendlyErrorMessage = getSignUpErrorMessage(error);
          Alert.alert('Sign Up Error', friendlyErrorMessage);
          setLoading(false);
          return false;
        }
        
        if (!data?.user) {
          Alert.alert('Sign Up Error', 'Failed to create account. Please try again.');
          setLoading(false);
          return false;
        }
        
        // Check if email confirmation is required
        if (data.user && !data.session) {
          // No session = email confirmation required
          console.log('Email confirmation required for user:', data.user.email);
          
          // Send confirmation email via our custom API (uses Resend)
          try {
            const apiBaseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://bookshelfscan.app';
            await fetch(`${apiBaseUrl}/api/send-confirmation-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
            });
            console.log('Confirmation email sent via custom API');
          } catch (emailError) {
            console.warn('Failed to send confirmation email via API, Supabase will handle it:', emailError);
            // Supabase will send the email as fallback
          }
          
          // Email confirmation required - show alert
          Alert.alert(
            'Check Your Email',
            'We\'ve sent you a confirmation email. Please check your inbox (and spam folder) and click the confirmation link to activate your account. You won\'t be able to sign in until you confirm your email.',
            [{ text: 'OK' }]
          );
          setLoading(false);
          return true; // Return true because signup was successful, just needs confirmation
        }
        
        const uid = data.user.id;
        
        // Check if profile already exists (trigger might have created it)
        try {
          const profileCheckPromise = supabase
            .from('profiles')
            .select('id')
            .eq('id', uid)
            .single();
          const profileTimeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Profile check timeout')), 5000)
          );
          
          const { data: existingProfileCheck } = await Promise.race([profileCheckPromise, profileTimeout]) as any;
          
          // Only insert if profile doesn't exist
          if (!existingProfileCheck) {
            const { error: profileError } = await supabase
              .from('profiles')
              .insert({
                id: uid,
                username: username.toLowerCase(),
                display_name: displayName || null,
              });
            
            // If profile insert fails with RLS error, that's OK - trigger probably created it
            if (profileError && !profileError.message.includes('duplicate') && !profileError.message.includes('row-level security')) {
              console.warn('Profile creation warning:', profileError);
            }
          }
        } catch (profileError) {
          console.warn('Profile check/creation error, continuing anyway:', profileError);
          // Continue even if profile check fails - trigger might have created it
        }
        
        // Store local mapping for backwards compatibility
        await AsyncStorage.setItem('usernameToEmail:' + username.toLowerCase(), email);

        const userData: User = {
          uid,
          email: email,
          username: username.toLowerCase(),
          displayName,
        };
        // So Library (which gates on session) doesn't show sign-in again
        if (data.session) setSession(data.session);
        setUser(userData);
        await saveUserToStorage(userData);
        
        // Transfer guest data to the new account
        await transferGuestDataToUser(uid);
        
        setLoading(false);
        Alert.alert('Success', 'Account created successfully! You can now start using the app.');
        return true;
      } catch (signUpError: any) {
        console.error('Sign up error:', signUpError);
        const errorMessage = signUpError?.message?.includes('timeout')
          ? 'Connection timeout. Please check your internet connection and try again.'
          : getSignUpErrorMessage(signUpError);
        Alert.alert('Sign Up Error', errorMessage);
        setLoading(false);
        return false;
      }
    } catch (error: any) {
      console.error('Sign up error:', error);
      const errorMessage = getSignUpErrorMessage(error);
      Alert.alert('Sign Up Error', errorMessage);
      setLoading(false);
      return false;
    } finally {
      // CRITICAL: Always clear loading state, even if something unexpected happens
      // This prevents infinite loading screens
      setLoading(false);
    }
  };

  const signInWithBiometric = async (): Promise<boolean> => {
    try {
      // Get stored credentials (this will prompt for biometric)
      const credentials = await BiometricAuth.getStoredCredentials();
      
      if (!credentials) {
        return false;
      }
      
      // Sign in with stored credentials (signIn manages its own loading state)
      const success = await signIn(credentials.email, credentials.password);
      return success;
    } catch (error) {
      console.error('Biometric sign in error:', error);
      return false;
    }
  };
  
  const enableBiometric = async (email: string, password: string): Promise<void> => {
    try {
      await BiometricAuth.storeCredentialsForBiometric(email, password);
      await BiometricAuth.setBiometricEnabled(true);
    } catch (error) {
      console.error('Error enabling biometric:', error);
      // Don't throw - just log to prevent crashes
    }
  };
  
  const disableBiometric = async (): Promise<void> => {
    try {
      await BiometricAuth.setBiometricEnabled(false);
      await BiometricAuth.clearStoredCredentials();
    } catch (error) {
      console.error('Error disabling biometric:', error);
      // Don't throw - just log to prevent crashes
    }
  };

  const signOut = async (): Promise<void> => {
    console.log('[SIGNOUT_CALLED]', new Error().stack);
    try {
      const currentUser = user;
      
      // Clear user state first
      setUser(null);
      
      // Remove user from AsyncStorage and active-user / pending-action so next user never sees previous user's data
      await AsyncStorage.removeItem('user');
      await AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
      await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY).catch(() => {});

      // Clear biometric credentials on sign out
      await BiometricAuth.clearStoredCredentials().catch(() => {
        // Ignore errors - biometric clearing is optional
      });
      
      // For Supabase-authenticated users, sign out from Supabase
      // For demo accounts (DEMO_UID), skip Supabase signOut since they're not in Supabase auth
      if (supabase && currentUser && currentUser.uid !== DEMO_UID) {
        try {
          console.log('[SIGNOUT_CALLED] supabase.auth.signOut()', new Error().stack);
          await supabase.auth.signOut();
        } catch (supabaseError) {
          console.warn('Supabase signOut error (continuing anyway):', supabaseError);
          // Continue even if Supabase signOut fails - we've already cleared local state
        }
      }
      
      // Only clear Supabase storage on explicit sign-out (not on INITIAL_SESSION, SIGNED_IN, startup, etc.)
      try {
        const reason = 'signOut';
        const env = SUPABASE_ENV ?? (__DEV__ ? 'dev' : 'prod');
        console.log('[SESSION_STORAGE_CLEAR_TRIGGER]', {
          reason,
          env,
          authReady,
          hasSession: !!session,
          userId: session?.user?.id ?? null,
        });
        console.trace('[SESSION_STORAGE_CLEAR_STACK]');
        await clearSupabaseStorage();
      } catch (clearError) {
        console.warn('Error clearing Supabase keys:', clearError);
      }
      
      console.log('✅ Successfully signed out');
    } catch (error) {
      console.error('Sign out error:', error);
      // Even if there's an error, clear the user state
      setUser(null);
      await AsyncStorage.removeItem('user').catch(() => {});
      Alert.alert('Sign Out Error', 'Failed to sign out completely. Please try again.');
    }
  };

  const hardResetAuthStorageDev = async (): Promise<void> => {
    if (!__DEV__) return;
    console.log('[HARD_RESET_AUTH] dev only — devResetAuth then clear local state');
    await devResetAuth(supabase);
    await AsyncStorage.removeItem('user').catch(() => {});
    await AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
    await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY).catch(() => {});
    setUser(null);
    console.log('[HARD_RESET_AUTH] done — fully kill the app and relaunch, then sign in with username/email');
  };

  const resetPassword = async (email: string): Promise<boolean> => {
    try {
      if (!supabase) {
        Alert.alert('Password Reset Error', 'Supabase not configured.');
        return false;
      }
      
      // Call custom API endpoint to send reset email
      const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://bookshelfscan.app';
      const response = await fetch(`${baseUrl}/api/send-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to send reset email');
      }

      const data = await response.json();
      Alert.alert('Password Reset', data.message || 'Check your email for a reset link.');
      return true;
    } catch (error: any) {
      console.error('Password reset error:', error);
      Alert.alert('Password Reset Error', error.message || 'An error occurred. Please try again.');
      return false;
    }
  };

  const updatePassword = async (recoveryToken: string, newPassword: string): Promise<boolean> => {
    try {
      if (!supabase) {
        Alert.alert('Password Update Error', 'Supabase not configured.');
        return false;
      }

      // Verify the recovery token — Supabase sets the session from this. Never call setSession with raw token (could be provider token).
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: recoveryToken,
        type: 'recovery',
      });

      if (verifyError || !data) {
        console.log('verifyOtp failed:', verifyError);
        Alert.alert('Password Update Error', 'Invalid or expired reset link. Please request a new one.');
        return false;
      }

      // Update the user's password
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        Alert.alert('Password Update Error', error.message);
        return false;
      }
      Alert.alert('Success', 'Your password has been updated!');
      return true;
    } catch (error: any) {
      console.error('Password update error:', error);
      Alert.alert('Password Update Error', error.message || 'An error occurred. Please try again.');
      return false;
    }
  };

  const searchUsers = async (query: string): Promise<User[]> => {
    try {
      if (!query || query.length < 2) return [];
      
      if (!supabase) {
        // Fallback to local storage if Supabase not configured
        const usersData = await AsyncStorage.getItem('users');
        const users = usersData ? JSON.parse(usersData) : {};
        const queryLower = query.toLowerCase();
        const results: User[] = [];
        for (const email in users) {
          const user = users[email];
          const usernameMatch = user.username && user.username.toLowerCase().includes(queryLower);
          const displayNameMatch = user.displayName && user.displayName.toLowerCase().includes(queryLower);
          if (usernameMatch || displayNameMatch) {
            results.push({
              uid: user.uid,
              email: user.email,
              username: user.username,
              displayName: user.displayName,
            });
          }
        }
        return results;
      }
      
      const queryLower = query.toLowerCase();
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .or(`username.ilike.%${queryLower}%,display_name.ilike.%${queryLower}%`)
        .limit(20);
      
      if (error || !data) {
        // Fallback to local storage for backwards compatibility
        const usersData = await AsyncStorage.getItem('users');
        const users = usersData ? JSON.parse(usersData) : {};
        const results: User[] = [];
        for (const email in users) {
          const user = users[email];
          const usernameMatch = user.username && user.username.toLowerCase().includes(queryLower);
          const displayNameMatch = user.displayName && user.displayName.toLowerCase().includes(queryLower);
          if (usernameMatch || displayNameMatch) {
            results.push({
              uid: user.uid,
              email: user.email,
              username: user.username,
              displayName: user.displayName,
            });
          }
        }
        return results;
      }
      
      // We have profile data but need emails - for now return basic user info
      // In phase 2, we'd join with auth.users or store email in profiles
      return data.map((p: any) => ({
        uid: p.id,
        email: '', // Email is protected in auth.users - would need RPC function
        username: p.username || '',
        displayName: p.display_name || undefined,
      }));
    } catch (error) {
      console.error('Search users error:', error);
      return [];
    }
  };

  const getUserByUsername = async (username: string): Promise<User | null> => {
    try {
      if (!supabase) {
        // Fallback to local storage if Supabase not configured
        const mapped = await AsyncStorage.getItem('usernameToEmail:' + username.toLowerCase());
        if (!mapped) return null;
        const usersData = await AsyncStorage.getItem('users');
        const users = usersData ? JSON.parse(usersData) : {};
        const user = users[mapped];
        if (!user) return null;
        return {
          uid: user.uid,
          email: user.email,
          username: user.username,
          displayName: user.displayName,
        };
      }
      
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .eq('username', username.toLowerCase())
        .single();
      
      if (error || !data) {
        // Fallback to local storage
        const mapped = await AsyncStorage.getItem('usernameToEmail:' + username.toLowerCase());
        if (!mapped) return null;
        const usersData = await AsyncStorage.getItem('users');
        const users = usersData ? JSON.parse(usersData) : {};
        const user = users[mapped];
        if (!user) return null;
        return {
          uid: user.uid,
          email: user.email,
          username: user.username,
          displayName: user.displayName,
        };
      }
      
      return {
        uid: data.id,
        email: '', // Email protected - would need RPC function
        username: data.username || '',
        displayName: data.display_name || undefined,
      };
    } catch (error) {
      console.error('Get user by username error:', error);
      return null;
    }
  };

  const deleteAccount = async (): Promise<void> => {
    try {
      if (!user) {
        Alert.alert('Error', 'No user logged in');
        return;
      }

      if (!supabase) {
        Alert.alert('Error', 'Supabase not configured');
        return;
      }

      // Delete profile from Supabase (this frees up the username)
      const { error: profileError } = await supabase
        .from('profiles')
        .delete()
        .eq('id', user.uid);

      if (profileError) {
        console.warn('Profile deletion warning:', profileError);
        // If deletion fails due to RLS, try to continue anyway
      }

      // Note: Auth user deletion requires admin privileges (server-side only)
      // The profile deletion frees up the username, which is what matters for sign-up

      // Clean up local storage
      await AsyncStorage.removeItem('user');
      await AsyncStorage.removeItem(`usernameToEmail:${user.username.toLowerCase()}`);
      await AsyncStorage.removeItem(`approved_books_${user.uid}`);
      await AsyncStorage.removeItem(`photos_${user.uid}`);

      // Sign out
      await signOut();
      
      Alert.alert('Success', 'Your account has been deleted successfully.');
    } catch (error) {
      console.error('Delete account error:', error);
      Alert.alert('Error', 'Failed to delete account. Please try again.');
    }
  };

  const refreshAuthState = async (): Promise<void> => {
    try {
      if (!supabase) return;
      
      // Check for current session
      const { data, error } = await supabase.auth.getSession();
      
      if (error) {
        console.warn('Error refreshing auth state:', error.message);
        return;
      }
      
      const sessionUser = data?.session?.user;
      if (sessionUser) {
        // Fetch updated profile and update user state
        try {
          const profile = await fetchUserProfile(sessionUser.id);
          const userData: User = {
            uid: sessionUser.id,
            email: sessionUser.email || '',
            username: profile?.username || '',
            displayName: profile?.displayName,
            photoURL: profile?.photoURL,
          };
          setUser(userData);
          await saveUserToStorage(userData);
        } catch (profileError) {
          console.warn('Profile fetch error during refresh:', profileError);
          // Use basic session data if profile fetch fails
          const userData: User = {
            uid: sessionUser.id,
            email: sessionUser.email || '',
            username: sessionUser.email?.split('@')[0] || '',
          };
          setUser(userData);
          await saveUserToStorage(userData);
        }
      }
    } catch (error) {
      console.warn('Error refreshing auth state:', error);
    }
  };

  const value: AuthContextType = {
    user,
    session,
    loading,
    authReady,
    signIn,
    signInWithDemoAccount,
    signUp,
    signOut,
    resetPassword,
    updatePassword,
    searchUsers,
    getUserByUsername,
    deleteAccount,
    refreshAuthState,
    biometricCapabilities,
    isBiometricEnabled: BiometricAuth.isBiometricEnabled,
    signInWithBiometric,
    enableBiometric,
    disableBiometric,
    hardResetAuthStorageDev,
    demoCredentials: {
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
