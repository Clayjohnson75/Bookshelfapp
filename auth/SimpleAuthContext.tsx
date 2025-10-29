import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface User {
  uid: string;
  email: string;
  username: string;
  displayName?: string;
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

  useEffect(() => {
    loadUserFromStorage();
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

  const signIn = async (email: string, password: string): Promise<boolean> => {
    try {
      setLoading(true);
      
      // Check if user exists in storage
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};
      
      if (users[email] && users[email].password === password) {
        const userData: User = {
          uid: users[email].uid,
          email: email,
          username: users[email].username || '', // Handle old users without username
          displayName: users[email].displayName,
        };
        
        setUser(userData);
        await saveUserToStorage(userData);
        return true;
      } else {
        Alert.alert('Sign In Error', 'Invalid email or password');
        return false;
      }
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
      
      // Validate username format (alphanumeric and underscores only, 3-20 chars)
      const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
      if (!usernameRegex.test(username)) {
        Alert.alert('Sign Up Error', 'Username must be 3-20 characters and contain only letters, numbers, and underscores');
        return false;
      }
      
      // Check if user already exists by email or username
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};
      const usernamesData = await AsyncStorage.getItem('usernames'); // Store username -> email mapping
      const usernames = usernamesData ? JSON.parse(usernamesData) : {};
      
      if (users[email]) {
        Alert.alert('Sign Up Error', 'An account with this email already exists');
        return false;
      }
      
      // Check if username is taken
      if (usernames[username.toLowerCase()]) {
        Alert.alert('Sign Up Error', 'This username is already taken. Please choose another.');
        return false;
      }
      
      // Create new user
      const uid = Date.now().toString();
      const userData: User = {
        uid: uid,
        email: email,
        username: username.toLowerCase(),
        displayName: displayName,
      };
      
      // Save user to users list (indexed by email)
      users[email] = {
        uid: uid,
        email: email,
        username: username.toLowerCase(),
        displayName: displayName,
        password: password,
      };
      
      // Save username mapping (username -> email for quick lookup)
      usernames[username.toLowerCase()] = email;
      
      await AsyncStorage.setItem('users', JSON.stringify(users));
      await AsyncStorage.setItem('usernames', JSON.stringify(usernames));
      setUser(userData);
      await saveUserToStorage(userData);
      
      Alert.alert('Success', 'Account created successfully!');
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
      await AsyncStorage.removeItem('user');
      setUser(null);
    } catch (error) {
      console.error('Sign out error:', error);
      Alert.alert('Sign Out Error', 'Failed to sign out. Please try again.');
    }
  };

  const resetPassword = async (email: string): Promise<boolean> => {
    try {
      Alert.alert('Password Reset', 'Password reset feature not available in demo mode. Please create a new account.');
      return false;
    } catch (error) {
      console.error('Password reset error:', error);
      Alert.alert('Password Reset Error', 'An error occurred. Please try again.');
      return false;
    }
  };

  const searchUsers = async (query: string): Promise<User[]> => {
    try {
      if (!query || query.length < 2) return [];
      
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};
      const queryLower = query.toLowerCase();
      
      const results: User[] = [];
      
      // Search by username or display name
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
    } catch (error) {
      console.error('Search users error:', error);
      return [];
    }
  };

  const getUserByUsername = async (username: string): Promise<User | null> => {
    try {
      const usernamesData = await AsyncStorage.getItem('usernames');
      const usernames = usernamesData ? JSON.parse(usernamesData) : {};
      const email = usernames[username.toLowerCase()];
      
      if (!email) return null;
      
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};
      const user = users[email];
      
      if (!user) return null;
      
      return {
        uid: user.uid,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
      };
    } catch (error) {
      console.error('Get user by username error:', error);
      return null;
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
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
