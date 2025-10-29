import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface User {
  uid: string;
  email: string;
  displayName?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signUp: (email: string, password: string, displayName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<boolean>;
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

  const signUp = async (email: string, password: string, displayName: string): Promise<boolean> => {
    try {
      setLoading(true);
      
      // Check if user already exists
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};
      
      if (users[email]) {
        Alert.alert('Sign Up Error', 'An account with this email already exists');
        return false;
      }
      
      // Create new user
      const uid = Date.now().toString();
      const userData: User = {
        uid: uid,
        email: email,
        displayName: displayName,
      };
      
      // Save user to users list
      users[email] = {
        uid: uid,
        email: email,
        displayName: displayName,
        password: password,
      };
      
      await AsyncStorage.setItem('users', JSON.stringify(users));
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

  const value: AuthContextType = {
    user,
    loading,
    signIn,
    signUp,
    signOut,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
