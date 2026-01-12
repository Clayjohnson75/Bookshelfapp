import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabaseClient';
import { Book, Photo, Folder } from '../types/BookTypes';
import * as BiometricAuth from '../services/biometricAuth';

// Helper to read env vars
const getEnvVar = (key: string): string => {
  return Constants.expoConfig?.extra?.[key] || 
         Constants.manifest?.extra?.[key] || 
         process.env[key] || 
         '';
};

interface User {
  uid: string;
  email: string;
  username: string;
  displayName?: string;
  photoURL?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signInWithDemoAccount: () => Promise<boolean>;
  signUp: (email: string, password: string, username: string, displayName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<boolean>;
  updatePassword: (accessToken: string, newPassword: string) => Promise<boolean>;
  searchUsers: (query: string) => Promise<User[]>;
  getUserByUsername: (username: string) => Promise<User | null>;
  deleteAccount: () => Promise<void>;
  biometricCapabilities: BiometricAuth.BiometricCapabilities | null;
  isBiometricEnabled: () => Promise<boolean>;
  enableBiometric: (email: string, password: string) => Promise<void>;
  disableBiometric: () => Promise<void>;
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

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
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

  useEffect(() => {
    // Load any persisted session on mount and subscribe to auth changes
    const init = async () => {
      // Set a timeout to prevent infinite loading
      const timeoutId = setTimeout(() => {
        console.warn('Auth initialization timeout, loading from storage');
        loadUserFromStorage();
        setLoading(false);
      }, 5000); // 5 second timeout

      try {
        if (!supabase) {
          clearTimeout(timeoutId);
          await loadUserFromStorage();
          setLoading(false);
          return;
        }
        
        try {
          // Add timeout to getSession call
          const sessionPromise = supabase.auth.getSession();
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Session timeout')), 3000)
          );
          
          const { data, error } = await Promise.race([sessionPromise, timeoutPromise]) as any;
          
          clearTimeout(timeoutId);
          
          // If there's an error with refresh token, clear the session and load from storage
          if (error) {
            console.warn('Session error (likely invalid refresh token):', error.message);
            // Clear invalid session
            await supabase.auth.signOut().catch(() => {});
            // Clear any stored Supabase session data - find and remove all Supabase keys
            try {
              const allKeys = await AsyncStorage.getAllKeys();
              const supabaseKeys = allKeys.filter(key => 
                key.includes('supabase') || 
                key.includes('sb-') || 
                key.includes('auth-token')
              );
              if (supabaseKeys.length > 0) {
                await AsyncStorage.multiRemove(supabaseKeys);
              }
            } catch (clearError) {
              // Ignore errors when clearing
            }
            await loadUserFromStorage();
            setLoading(false);
            return;
          }
          
          const sessionUser = data?.session?.user;
          if (sessionUser) {
            // Add timeout to fetchUserProfile (increased to 3 seconds for slower networks)
            try {
              const profilePromise = fetchUserProfile(sessionUser.id);
              const profileTimeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Profile fetch timeout')), 3000)
              );
              const profile = await Promise.race([profilePromise, profileTimeoutPromise]) as any;
              
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
              console.warn('Profile fetch error, using session data:', profileError);
              // Use session data even if profile fetch fails
              const userData: User = {
                uid: sessionUser.id,
                email: sessionUser.email || '',
                username: sessionUser.email?.split('@')[0] || '',
                displayName: undefined,
                photoURL: undefined,
              };
              setUser(userData);
              await saveUserToStorage(userData);
            }
          } else {
            await loadUserFromStorage();
          }
        } catch (sessionError: any) {
          clearTimeout(timeoutId);
          console.warn('Session loading error:', sessionError?.message || sessionError);
          // If it's a timeout or network error, just load from storage
          await loadUserFromStorage();
        }
      } catch (error: any) {
        clearTimeout(timeoutId);
        // Catch any errors during session loading
        console.warn('Error loading session:', error?.message || error);
        // Clear potentially invalid session
        if (supabase) {
          await supabase.auth.signOut().catch(() => {});
        }
        await loadUserFromStorage();
      } finally {
        clearTimeout(timeoutId);
        setLoading(false);
      }
    };
    init();

    if (!supabase) return;
    
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      try {
        // Handle token refresh errors
        if (event === 'TOKEN_REFRESHED' && !session) {
          console.warn('Token refresh failed, signing out');
          setUser(null);
          await AsyncStorage.removeItem('user');
          return;
        }
        
        // Handle SIGNED_OUT event (which can happen on token refresh errors)
        if (event === 'SIGNED_OUT') {
          setUser(null);
          await AsyncStorage.removeItem('user');
          return;
        }
        
        const sUser = session?.user;
        if (sUser) {
          try {
            const profile = await fetchUserProfile(sUser.id);
            const userData: User = {
              uid: sUser.id,
              email: sUser.email || '',
              username: profile.username,
              displayName: profile.displayName,
              photoURL: profile.photoURL,
            };
            setUser(userData);
            await saveUserToStorage(userData);
          } catch (error) {
            console.error('Error fetching user profile:', error);
            // If profile fetch fails, still set basic user data
            const userData: User = {
              uid: sUser.id,
              email: sUser.email || '',
              username: sUser.email?.split('@')[0] || 'user',
            };
            setUser(userData);
            await saveUserToStorage(userData);
          }
        } else {
          setUser(null);
          await AsyncStorage.removeItem('user');
        }
      } catch (error: any) {
        // Catch any errors in auth state change handler (like refresh token errors)
        console.warn('Error in auth state change:', error?.message || error);
        // If it's a token error, clear the session
        if (error?.message?.includes('refresh token') || error?.message?.includes('Refresh Token')) {
          setUser(null);
          await AsyncStorage.removeItem('user');
          if (supabase) {
            await supabase.auth.signOut().catch(() => {});
          }
        }
      }
    });

    return () => {
      sub?.subscription?.unsubscribe();
    };
  }, []);

  const loadUserFromStorage = async () => {
    try {
      const userData = await AsyncStorage.getItem('user');
      if (userData) {
        setUser(JSON.parse(userData));
      }
    } catch (error) {
      console.error('Error loading user:', error);
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
        Alert.alert('Sign In Error', 'Supabase not configured. Please add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.');
        setLoading(false);
        return false;
      }
      
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
                  isProduction: process.env.EAS_ENV === 'production' || Constants.expoConfig?.extra?.EAS_ENV === 'production',
                  supabaseUrl: supabase?.supabaseUrl?.substring(0, 30) + '...' || 'not configured'
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
              
              if (response.ok) {
                const data = await response.json();
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
                  try {
                    errorData = JSON.parse(errorText);
                  } catch {
                    errorData = { message: errorText || 'Username not found' };
                  }
                  // Show user-friendly error and return false (don't try cached email for non-existent username)
                  setLoading(false);
                  Alert.alert('Sign In Error', errorData.message || 'This username does not exist. Please check your username and try again.');
                  return false;
              } else {
                  // Other errors (500, etc.) - treat as connection/server error
                  const errorText = await response.text();
                  console.error('API error response:', errorText);
                  let errorData;
                  try {
                    errorData = JSON.parse(errorText);
                  } catch {
                    errorData = { message: errorText || 'API call failed' };
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
      
      // CRITICAL: Sign out any existing session first to prevent account switching issues
      // This ensures we're signing in as the correct user, not reusing an old session
      try {
        await supabase.auth.signOut();
        // Longer delay to ensure sign out completes and session is fully cleared
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Also clear any Supabase session data from AsyncStorage
        try {
          const allKeys = await AsyncStorage.getAllKeys();
          const supabaseKeys = allKeys.filter(key => 
            key.includes('supabase') || 
            key.includes('sb-') || 
            key.includes('auth-token')
          );
          if (supabaseKeys.length > 0) {
            await AsyncStorage.multiRemove(supabaseKeys);
          }
        } catch (clearError) {
          console.warn('Error clearing Supabase keys:', clearError);
        }
      } catch (signOutError) {
        // Ignore sign out errors - might not have a session
        console.log('No existing session to sign out:', signOutError);
      }
      
      // Sign in with timeout protection
      try {
        const signInPromise = supabase.auth.signInWithPassword({ email, password: cleanedPassword });
        const signInTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sign in timeout')), 10000)
        );
        const signInResult = await Promise.race([signInPromise, signInTimeoutPromise]) as any;
        const { data, error } = signInResult;
        
        if (error || !data?.user) {
          const errorMessage = getSignInErrorMessage(error);
          Alert.alert('Sign In Error', errorMessage);
          setLoading(false);
          return false;
        }
        
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
            // Sign out immediately - wrong account!
            await supabase.auth.signOut();
            Alert.alert(
              'Sign In Error', 
              `Username mismatch. You requested "${requestedUsername}" but signed in as "${signedInUsername}". Please try again.`
            );
            setLoading(false);
            return false;
          }
          console.log(`✅ Verified username match: "${requestedUsername}" = "${signedInUsername}"`);
        }
        
        setUser(userData);
        await saveUserToStorage(userData);
        
        // Update the username-to-email mapping with the correct email
        if (requestedUsername && userData.email) {
          await AsyncStorage.setItem('usernameToEmail:' + requestedUsername, userData.email);
        }
        
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
        Alert.alert('Sign Up Error', 'Supabase not configured. Please add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.');
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
        setUser(userData);
        await saveUserToStorage(userData);
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
    try {
      const currentUser = user;
      
      // Clear user state first
      setUser(null);
      
      // Remove user from AsyncStorage
      await AsyncStorage.removeItem('user');
      
      // Clear biometric credentials on sign out
      await BiometricAuth.clearStoredCredentials().catch(() => {
        // Ignore errors - biometric clearing is optional
      });
      
      // For Supabase-authenticated users, sign out from Supabase
      // For demo accounts (DEMO_UID), skip Supabase signOut since they're not in Supabase auth
      if (supabase && currentUser && currentUser.uid !== DEMO_UID) {
        try {
          await supabase.auth.signOut();
        } catch (supabaseError) {
          console.warn('Supabase signOut error (continuing anyway):', supabaseError);
          // Continue even if Supabase signOut fails - we've already cleared local state
        }
      }
      
      // Clear any Supabase session data from AsyncStorage
      try {
        const allKeys = await AsyncStorage.getAllKeys();
        const supabaseKeys = allKeys.filter(key => 
          key.includes('supabase') || 
          key.includes('sb-') || 
          key.includes('auth-token')
        );
        if (supabaseKeys.length > 0) {
          await AsyncStorage.multiRemove(supabaseKeys);
        }
      } catch (clearError) {
        console.warn('Error clearing Supabase keys:', clearError);
        // Continue anyway
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

      // Verify the recovery token - this will set the session
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: recoveryToken,
        type: 'recovery',
      });

      if (verifyError || !data) {
        // If verifyOtp doesn't work, try using the token as a recovery token directly
        // Some Supabase versions use the token differently
        console.log('verifyOtp failed, trying alternative method:', verifyError);
        
        // Alternative: Try to exchange the token for a session
        // The token from the URL might need to be used with exchangeCodeForSession
        // But for recovery tokens, we can try setting it directly
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: recoveryToken,
          refresh_token: '',
        });
        
        if (sessionError) {
          console.error('Error setting session for password update:', sessionError);
          Alert.alert('Password Update Error', 'Invalid or expired reset link. Please request a new one.');
          return false;
        }
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

  const value: AuthContextType = {
    user,
    loading,
    signIn,
    signInWithDemoAccount,
    signUp,
    signOut,
    resetPassword,
    updatePassword,
    searchUsers,
    getUserByUsername,
    deleteAccount,
    biometricCapabilities,
    isBiometricEnabled: BiometricAuth.isBiometricEnabled,
    enableBiometric,
    disableBiometric,
    demoCredentials: {
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
