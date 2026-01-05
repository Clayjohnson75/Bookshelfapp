import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/SimpleAuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabaseClient';
import * as BiometricAuth from '../services/biometricAuth';

// Safe import for LocalAuthentication
let LocalAuthentication: any = null;
try {
  LocalAuthentication = require('expo-local-authentication');
} catch (error) {
  console.warn('expo-local-authentication not available');
}

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  onDataCleared?: () => void; // Callback to notify parent that data was cleared
}

const SettingsModal: React.FC<SettingsModalProps> = ({ visible, onClose, onDataCleared }) => {
  const insets = useSafeAreaInsets();
  const { 
    user, 
    signOut, 
    deleteAccount,
    biometricCapabilities,
    isBiometricEnabled,
    enableBiometric,
    disableBiometric,
  } = useAuth();
  const [newUsername, setNewUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [clearingAccount, setClearingAccount] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricLoading, setBiometricLoading] = useState(false);

  // Update username when user changes or modal opens
  React.useEffect(() => {
    if (visible && user) {
      // Set to current username if exists, otherwise leave empty for new users
      setNewUsername(user.username || '');
    }
  }, [user, visible]);

  // Check biometric status when modal opens
  useEffect(() => {
    if (visible) {
      loadBiometricStatus();
    }
  }, [visible]);

  const loadBiometricStatus = async () => {
    try {
      const enabled = await isBiometricEnabled();
      setBiometricEnabled(enabled);
    } catch (error) {
      console.error('Error loading biometric status:', error);
    }
  };

  const toggleBiometric = async () => {
    if (biometricLoading) return;
    
    setBiometricLoading(true);
    try {
      if (biometricEnabled) {
        await disableBiometric();
        setBiometricEnabled(false);
        Alert.alert('Success', 'Biometric login has been disabled');
      } else {
        // To enable, we need the user's password
        // For now, show a message that they need to sign in again with "Remember Me" checked
        Alert.alert(
          'Enable Biometric Login',
          'To enable biometric login, please sign out and sign in again with "Remember Me" checked on the login screen.',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Error toggling biometric:', error);
      Alert.alert('Error', 'Failed to update biometric settings. Please try again.');
    } finally {
      setBiometricLoading(false);
    }
  };

  const handleChangeUsername = async () => {
    console.log('Save button pressed, current user:', user?.username, 'new username:', newUsername);
    
    if (!user) {
      Alert.alert('Error', 'User not found. Please try again.');
      return;
    }

    // Validate username format
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    const newUsernameTrimmed = newUsername.trim();
    
    if (!usernameRegex.test(newUsernameTrimmed)) {
      Alert.alert('Invalid Username', 'Username must be 3-20 characters and contain only letters, numbers, and underscores');
      return;
    }

    if (!newUsernameTrimmed || newUsernameTrimmed.length < 3) {
      Alert.alert('Invalid Username', 'Username must be at least 3 characters');
      return;
    }

    const newUsernameLower = newUsernameTrimmed.toLowerCase();
    const currentUsernameLower = user.username ? user.username.toLowerCase().trim() : '';

    // If user already has a username and it's the same, show message
    if (currentUsernameLower && newUsernameLower === currentUsernameLower) {
      Alert.alert('No Change', 'This is already your username');
      return;
    }

    setLoading(true);
    try {
      // Check if username is taken
      const usernamesData = await AsyncStorage.getItem('usernames');
      const usernames = usernamesData ? JSON.parse(usernamesData) : {};

      // Check if new username is already taken by someone else
      const existingEmail = usernames[newUsernameLower];
      if (existingEmail && existingEmail !== user.email) {
        Alert.alert('Username Taken', 'This username is already taken. Please choose another.');
        setLoading(false);
        return;
      }

      // Update username mapping
      const usersData = await AsyncStorage.getItem('users');
      const users = usersData ? JSON.parse(usersData) : {};

      // Remove old username mapping (only if it exists and user had one)
      if (currentUsernameLower && usernames[currentUsernameLower]) {
        delete usernames[currentUsernameLower];
      }

      // Add new username mapping
      usernames[newUsernameLower] = user.email;

      // Update user data
      if (users[user.email]) {
        users[user.email].username = newUsernameLower;
      }

      // Save updated data
      await AsyncStorage.setItem('usernames', JSON.stringify(usernames));
      await AsyncStorage.setItem('users', JSON.stringify(users));

      // Update current user in storage
      const updatedUser = {
        ...user,
        username: newUsernameLower,
      };
      await AsyncStorage.setItem('user', JSON.stringify(updatedUser));

      console.log('Username updated successfully');
      Alert.alert('Success', 'Username updated successfully! Please sign in again to see the changes.', [
        {
          text: 'OK',
          onPress: async () => {
            await signOut();
            onClose();
          },
        },
      ]);
    } catch (error) {
      console.error('Error updating username:', error);
      Alert.alert('Error', 'Failed to update username. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClearAccount = async () => {
    if (!user) {
      Alert.alert('Error', 'User not found. Please try again.');
      return;
    }

    // First confirmation dialog
    Alert.alert(
      'Clear All Data',
      'This will permanently delete:\n\n• All books in your library\n• All scan photos\n• All folders\n• All scan history\n\nThis action cannot be undone. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Clear Everything',
          style: 'destructive',
          onPress: async () => {
            setClearingAccount(true);
            try {
              // Get counts for final confirmation
              let bookCount = 0;
              let photoCount = 0;
              
              try {
                const approvedData = await AsyncStorage.getItem(`approved_books_${user.uid}`);
                const photosData = await AsyncStorage.getItem(`photos_${user.uid}`);
                const books = approvedData ? JSON.parse(approvedData) : [];
                const photos = photosData ? JSON.parse(photosData) : [];
                bookCount = books.length;
                photoCount = photos.length;
              } catch (e) {
                console.warn('Error getting counts:', e);
              }

              // Final confirmation with actual counts
              Alert.alert(
                'Final Confirmation',
                `You are about to permanently delete:\n\n• ${bookCount} book${bookCount !== 1 ? 's' : ''} from your library\n• ${photoCount} scan photo${photoCount !== 1 ? 's' : ''}\n• All folders and organization\n• All scan history\n\nThis cannot be undone. Continue?`,
                [
                  { text: 'Cancel', style: 'cancel', onPress: () => setClearingAccount(false) },
                  {
                    text: 'Delete Everything',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        // Delete all books from Supabase
                        if (supabase) {
                          try {
                            const { error: booksError } = await supabase
                              .from('books')
                              .delete()
                              .eq('user_id', user.uid);
                            
                            if (booksError) {
                              console.warn('Error deleting books from Supabase:', booksError);
                            } else {
                              console.log('✅ Deleted all books from Supabase');
                            }
                          } catch (e) {
                            console.warn('Error deleting books from Supabase:', e);
                          }

                          // Delete all photos from Supabase storage and database
                          try {
                            // First, get all photos to delete their storage files
                            const { data: photosData, error: fetchError } = await supabase
                              .from('photos')
                              .select('storage_path')
                              .eq('user_id', user.uid);

                            if (!fetchError && photosData && photosData.length > 0) {
                              // Delete all storage files
                              const storagePaths = photosData
                                .map(p => p.storage_path)
                                .filter(Boolean);
                              
                              if (storagePaths.length > 0) {
                                const { error: storageError } = await supabase.storage
                                  .from('photos')
                                  .remove(storagePaths);
                                
                                if (storageError) {
                                  console.warn('Error deleting photos from storage:', storageError);
                                } else {
                                  console.log(`✅ Deleted ${storagePaths.length} photos from storage`);
                                }
                              }
                            }

                            // Delete all photos from database
                            const { error: photosError } = await supabase
                              .from('photos')
                              .delete()
                              .eq('user_id', user.uid);
                            
                            if (photosError) {
                              console.warn('Error deleting photos from Supabase:', photosError);
                            } else {
                              console.log('✅ Deleted all photos from Supabase');
                            }
                          } catch (e) {
                            console.warn('Error deleting photos from Supabase:', e);
                          }

                          // Reset user stats
                          try {
                            const { error: statsError } = await supabase
                              .from('user_stats')
                              .update({
                                total_scans: 0,
                                monthly_scans: 0,
                                last_scan_month: null,
                                last_scan_at: null,
                              })
                              .eq('user_id', user.uid);
                            
                            if (statsError) {
                              console.warn('Error resetting user stats:', statsError);
                            } else {
                              console.log('✅ Reset user stats');
                            }
                          } catch (e) {
                            console.warn('Error resetting user stats:', e);
                          }
                        }

                        // Clear all local storage
                        await AsyncStorage.removeItem(`approved_books_${user.uid}`);
                        await AsyncStorage.removeItem(`photos_${user.uid}`);
                        await AsyncStorage.removeItem(`folders_${user.uid}`);
                        await AsyncStorage.removeItem(`pending_books_${user.uid}`);
                        await AsyncStorage.removeItem(`rejected_books_${user.uid}`);
                        
                        console.log('✅ Cleared all local storage');

                        // Notify parent component to clear local state immediately
                        if (onDataCleared) {
                          onDataCleared();
                        }

                        Alert.alert(
                          'Success',
                          'All books, photos, and data have been cleared from your account.',
                          [
                            {
                              text: 'OK',
                              onPress: () => {
                                setClearingAccount(false);
                                onClose();
                              },
                            },
                          ]
                        );
                      } catch (error) {
                        console.error('Error clearing account:', error);
                        Alert.alert('Error', 'Failed to clear all data. Please try again.');
                        setClearingAccount(false);
                      }
                    },
                  },
                ]
              );
            } catch (error) {
              console.error('Error in clear account flow:', error);
              Alert.alert('Error', 'Failed to clear account. Please try again.');
              setClearingAccount(false);
            }
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['left','right','bottom']}>
        <View style={{ height: insets.top, backgroundColor: '#2d3748' }} />
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Settings</Text>
          <TouchableOpacity 
            style={styles.closeButton} 
            onPress={onClose}
            activeOpacity={0.8}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content}>
          {/* Account Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Account</Text>

            {/* Current Username Display */}
            {user?.username && (
              <View style={styles.infoRow}>
                <View style={styles.infoContent}>
                  <Text style={styles.infoLabel}>Current Username</Text>
                  <Text style={styles.infoValue}>@{user.username}</Text>
                </View>
              </View>
            )}

            {/* Set/Change Username */}
            <View style={styles.settingItem}>
              <View style={styles.settingContent}>
                <Text style={styles.settingLabel}>
                  {user?.username ? 'Change Username' : 'Set Username'}
                </Text>
                <Text style={styles.settingDescription}>
                  {user?.username 
                    ? 'Your username is how others find you on the app'
                    : 'You need to set a username so others can find you. This can only be set once.'}
                </Text>
              </View>
            </View>

            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                placeholder={user?.username ? "New username (3-20 chars)" : "Choose a username (3-20 chars)"}
                value={newUsername}
                onChangeText={(text) => setNewUsername(text.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={20}
                editable={!loading}
              />
              <TouchableOpacity
                style={[styles.saveButton, (loading || newUsername.length < 3 || (user?.username && newUsername.toLowerCase() === user.username.toLowerCase())) && styles.saveButtonDisabled]}
                onPress={handleChangeUsername}
                disabled={loading || newUsername.length < 3 || (user?.username && newUsername.toLowerCase() === user.username.toLowerCase())}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>

            <View style={styles.divider} />

            {/* Email Display (read-only) */}
            <View style={styles.infoRow}>
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>Email</Text>
                <Text style={styles.infoValue}>{user?.email}</Text>
              </View>
            </View>
          </View>

          {/* Additional Settings Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Preferences</Text>
            
            {/* Biometric Login Toggle */}
            {biometricCapabilities?.isAvailable && (
              <View style={styles.settingItem}>
                <View style={styles.settingContent}>
                  <View style={styles.settingHeader}>
                    <Ionicons 
                      name={
                        LocalAuthentication && 
                        biometricCapabilities.supportedTypes.includes(
                          LocalAuthentication.AuthenticationType?.FACIAL_RECOGNITION
                        ) 
                          ? 'person' 
                          : 'finger-print'
                      } 
                      size={20} 
                      color="#0056CC" 
                      style={{ marginRight: 8 }}
                    />
                    <Text style={styles.settingLabel}>
                      {BiometricAuth.getBiometricTypeName(biometricCapabilities)} Login
                    </Text>
                  </View>
                  <Text style={styles.settingDescription}>
                    Sign in quickly using {BiometricAuth.getBiometricTypeName(biometricCapabilities).toLowerCase()}
                  </Text>
                </View>
                <Switch
                  value={biometricEnabled}
                  onValueChange={toggleBiometric}
                  disabled={biometricLoading}
                  trackColor={{ false: '#767577', true: '#0056CC' }}
                  thumbColor={biometricEnabled ? '#fff' : '#f4f3f4'}
                />
              </View>
            )}
          </View>

          {/* Clear Account Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Data Management</Text>
            <Text style={styles.settingDescription}>
              Remove all books, photos, and scan data from your account. Your account will remain active.
            </Text>
            <TouchableOpacity
              style={[styles.clearAccountButton, clearingAccount && styles.clearAccountButtonDisabled]}
              onPress={handleClearAccount}
              disabled={clearingAccount}
              activeOpacity={0.8}
            >
              {clearingAccount ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={styles.clearAccountButtonText}>Clear All Data</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Sign Out Section */}
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.signOutButton}
              onPress={async () => {
                Alert.alert(
                  'Sign Out',
                  'Are you sure you want to sign out?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Sign Out',
                      style: 'destructive',
                      onPress: async () => {
                        await signOut();
                        onClose();
                      },
                    },
                  ]
                );
              }}
            >
              <Text style={styles.signOutButtonText}>Sign Out</Text>
            </TouchableOpacity>
          </View>

          {/* Delete Account Section - At the very bottom */}
          <View style={[styles.section, styles.bottomSection]}>
            <TouchableOpacity
              style={styles.deleteAccountButton}
              onPress={async () => {
                Alert.alert(
                  'Delete Account',
                  'Are you sure you want to delete your account? This will permanently delete your account and all your data. This action cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await deleteAccount();
                          onClose();
                        } catch (error) {
                          console.error('Error deleting account:', error);
                          Alert.alert('Error', 'Failed to delete account. Please try again.');
                        }
                      },
                    },
                  ]
                );
              }}
            >
              <Text style={styles.deleteAccountButtonText}>Delete Account</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa', // Subtle gray background
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 20,
    backgroundColor: '#2d3748', // Slate header
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  closeButton: {
    backgroundColor: '#2563eb', // Deep blue accent
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  closeButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  section: {
    backgroundColor: '#ffffff',
    marginTop: 15,
    marginHorizontal: 15,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a202c',
    marginBottom: 20,
    letterSpacing: 0.3,
  },
  infoRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb', // Subtle gray border
  },
  infoContent: {
    flexDirection: 'column',
  },
  infoLabel: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '500',
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 16,
    color: '#1a202c',
    fontWeight: '600',
  },
  settingItem: {
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingContent: {
    flex: 1,
    marginRight: 12,
  },
  settingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  settingLabel: {
    fontSize: 16,
    color: '#1a202c',
    fontWeight: '600',
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 14,
    color: '#718096',
  },
  inputContainer: {
    marginTop: 15,
  },
  input: {
    backgroundColor: '#f8f9fa', // Subtle gray
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    borderWidth: 0.5,
    borderColor: '#e5e7eb', // Subtle gray border
    marginBottom: 12,
  },
  saveButton: {
    backgroundColor: '#2563eb', // Deep blue accent
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: '#e5e7eb', // Subtle gray border
    marginVertical: 20,
  },
  comingSoon: {
    fontSize: 14,
    color: '#718096',
    fontStyle: 'italic',
  },
  deleteAccountButton: {
    backgroundColor: '#dc3545',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  deleteAccountButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  signOutButton: {
    backgroundColor: '#6c757d',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  signOutButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  clearAccountButton: {
    backgroundColor: '#f59e0b', // Amber/orange warning color
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  clearAccountButtonDisabled: {
    opacity: 0.6,
  },
  clearAccountButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  bottomSection: {
    marginBottom: 30,
  },
});

export default SettingsModal;

