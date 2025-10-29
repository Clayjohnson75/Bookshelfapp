import React, { useState } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/SimpleAuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ visible, onClose }) => {
  const { user, signOut } = useAuth();
  const [newUsername, setNewUsername] = useState('');
  const [loading, setLoading] = useState(false);

  // Update username when user changes or modal opens
  React.useEffect(() => {
    if (visible && user) {
      // Set to current username if exists, otherwise leave empty for new users
      setNewUsername(user.username || '');
    }
  }, [user, visible]);

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

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
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

          {/* Additional Settings Section (for future) */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Preferences</Text>
            <Text style={styles.comingSoon}>More settings coming soon...</Text>
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
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#1a1a2e',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  closeButton: {
    backgroundColor: '#007AFF',
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
    borderBottomColor: '#e2e8f0',
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
  },
  settingContent: {
    flexDirection: 'column',
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
    backgroundColor: '#f7fafc',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  saveButton: {
    backgroundColor: '#007AFF',
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
    backgroundColor: '#e2e8f0',
    marginVertical: 20,
  },
  comingSoon: {
    fontSize: 14,
    color: '#718096',
    fontStyle: 'italic',
  },
  signOutButton: {
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
  signOutButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default SettingsModal;

