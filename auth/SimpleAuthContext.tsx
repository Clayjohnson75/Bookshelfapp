import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabaseClient';
import { Book, Photo, Folder } from '../types/BookTypes';

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
  searchUsers: (query: string) => Promise<User[]>;
  getUserByUsername: (username: string) => Promise<User | null>;
  deleteAccount: () => Promise<void>;
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
  const DEMO_USERNAME = 'test12';
  const DEMO_PASSWORD = 'admin12345';
  const DEMO_EMAIL = 'appstore.review+test12@bookshelfscanner.app';
  const DEMO_UID = 'demo-user-test12';
  const DEMO_SEEDED_KEY = `demo_seeded_${DEMO_UID}`;

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
      if (!supabase) {
        await loadUserFromStorage();
        setLoading(false);
        return;
      }
      
      const { data } = await supabase.auth.getSession();
      const sessionUser = data.session?.user;
      if (sessionUser) {
        const profile = await fetchUserProfile(sessionUser.id);
        const userData: User = {
          uid: sessionUser.id,
          email: sessionUser.email || '',
          username: profile.username,
          displayName: profile.displayName,
          photoURL: profile.photoURL,
        };
        setUser(userData);
        await saveUserToStorage(userData);
      } else {
        await loadUserFromStorage();
      }
      setLoading(false);
    };
    init();

    if (!supabase) return;
    
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const sUser = session?.user;
      if (sUser) {
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
      } else {
        setUser(null);
        await AsyncStorage.removeItem('user');
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
    const isDemoLogin =
      password === DEMO_PASSWORD &&
      (normalizedInput === DEMO_USERNAME || normalizedInput === DEMO_EMAIL.toLowerCase());

    if (isDemoLogin) {
      return signInWithDemoAccount();
    }

    try {
      setLoading(true);
      
      if (!supabase) {
        Alert.alert('Sign In Error', 'Supabase not configured. Please add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.');
        return false;
      }
      
      // Allow username sign-in by resolving to email from Supabase
      let email = emailOrUsername;
      if (!emailOrUsername.includes('@')) {
        const { data: emailData, error: rpcError } = await supabase.rpc('get_email_by_username', {
          username_input: emailOrUsername.toLowerCase(),
        });
        
        if (!rpcError && emailData) {
          email = emailData;
        } else {
          // Fallback: check local storage for old mapping
          const mapped = await AsyncStorage.getItem('usernameToEmail:' + emailOrUsername.toLowerCase());
          if (mapped) {
            email = mapped;
          } else {
            Alert.alert('Sign In Error', 'Username not found');
            return false;
          }
        }
      }
      
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        Alert.alert('Sign In Error', error?.message || 'Invalid credentials');
        return false;
      }
      const sUser = data.user;
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
      return true;
    } catch (error) {
      console.error('Sign in error:', error);
      Alert.alert('Sign In Error', 'An error occurred. Please try again.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const signUp = async (email: string, password: string, username: string, displayName: string): Promise<boolean> => {
    try {
      setLoading(true);
      
      if (!supabase) {
        Alert.alert('Sign Up Error', 'Supabase not configured. Please add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.');
        return false;
      }
      
      // Validate username format (alphanumeric and underscores only, 3-20 chars)
      const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
      if (!usernameRegex.test(username)) {
        Alert.alert('Sign Up Error', 'Username must be 3-20 characters and contain only letters, numbers, and underscores');
        return false;
      }
      
      // Check if username is already taken
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('username')
        .eq('username', username.toLowerCase())
        .single();
      
      if (existingProfile) {
        Alert.alert('Sign Up Error', 'This username is already taken. Please choose another.');
        return false;
      }
      
      // Sign up with metadata so trigger can create profile
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            username: username.toLowerCase(),
            display_name: displayName,
          },
        },
      });
      
      if (error || !data.user) {
        Alert.alert('Sign Up Error', error?.message || 'Failed to create account');
        return false;
      }
      
      const uid = data.user.id;
      
      // Check if profile already exists (trigger might have created it)
      const { data: existingProfileCheck } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', uid)
        .single();
      
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
      Alert.alert('Success', 'Account created. Check your email if confirmation is enabled.');
      return true;
    } catch (error) {
      console.error('Sign up error:', error);
      Alert.alert('Sign Up Error', 'An error occurred. Please try again.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const signOut = async (): Promise<void> => {
    try {
      if (supabase) {
        await supabase.auth.signOut();
      }
      await AsyncStorage.removeItem('user');
      setUser(null);
    } catch (error) {
      console.error('Sign out error:', error);
      Alert.alert('Sign Out Error', 'Failed to sign out. Please try again.');
    }
  };

  const resetPassword = async (email: string): Promise<boolean> => {
    try {
      if (!supabase) {
        Alert.alert('Password Reset Error', 'Supabase not configured.');
        return false;
      }
      
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://bookshelfapp-five.vercel.app/password-reset',
      });
      if (error) {
        Alert.alert('Password Reset Error', error.message);
        return false;
      }
      Alert.alert('Password Reset', 'Check your email for a reset link.');
      return true;
    } catch (error) {
      console.error('Password reset error:', error);
      Alert.alert('Password Reset Error', 'An error occurred. Please try again.');
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
    searchUsers,
    getUserByUsername,
    deleteAccount,
    demoCredentials: {
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
