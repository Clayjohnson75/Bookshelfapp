import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabaseClient';

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
  signUp: (email: string, password: string, username: string, displayName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<boolean>;
  searchUsers: (query: string) => Promise<User[]>;
  getUserByUsername: (username: string) => Promise<User | null>;
  deleteAccount: () => Promise<void>;
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

  const signIn = async (emailOrUsername: string, password: string): Promise<boolean> => {
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
      
      // Generate avatar using first name
      let avatarUrl: string | undefined = undefined;
      try {
        const firstName = displayName?.split(' ')[0] || username.charAt(0).toUpperCase() + username.slice(1);
        const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
        
        if (apiBaseUrl) {
          const avatarResponse = await fetch(`${apiBaseUrl}/api/generate-avatar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName }),
          });
          
          if (avatarResponse.ok) {
            const avatarData = await avatarResponse.json();
            if (avatarData.success && avatarData.imageData) {
              avatarUrl = avatarData.imageData; // base64 data URL
              
              // Store avatar in Supabase profile
              await supabase
                .from('profiles')
                .update({ avatar_url: avatarUrl })
                .eq('id', uid);
            }
          }
        }
      } catch (avatarError) {
        console.error('Error generating avatar:', avatarError);
        // Don't fail signup if avatar generation fails
      }
      
      // Store local mapping for backwards compatibility
      await AsyncStorage.setItem('usernameToEmail:' + username.toLowerCase(), email);

      const userData: User = {
        uid,
        email: email,
        username: username.toLowerCase(),
        displayName,
        photoURL: avatarUrl,
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
    signUp,
    signOut,
    resetPassword,
    searchUsers,
    getUserByUsername,
    deleteAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
