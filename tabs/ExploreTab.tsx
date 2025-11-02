import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/SimpleAuthContext';
import UserProfileModal from '../components/UserProfileModal';
import { Ionicons } from '@expo/vector-icons';

interface User {
  uid: string;
  email: string;
  username: string;
  displayName?: string;
}

export const ExploreTab: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { searchUsers, user: currentUser } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);


  useEffect(() => {
    const delayedSearch = setTimeout(async () => {
      if (searchQuery.length >= 2) {
        setLoading(true);
        const results = await searchUsers(searchQuery);
        setSearchResults(results);
        setLoading(false);
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(delayedSearch);
  }, [searchQuery, searchUsers]);

  const handleUserPress = (user: User) => {
    setSelectedUser(user);
    setShowProfileModal(true);
  };

  const renderUserItem = ({ item }: { item: User }) => (
    <TouchableOpacity
      style={styles.userCard}
      onPress={() => handleUserPress(item)}
    >
      <View style={styles.avatarContainer}>
        <Text style={styles.avatarText}>
          {item.displayName?.charAt(0).toUpperCase() || item.username.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.userInfo}>
        <Text style={styles.username}>@{item.username}</Text>
        {item.displayName && (
          <Text style={styles.displayName}>{item.displayName}</Text>
        )}
      </View>
      <Text style={styles.arrow}>›</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safeContainer} edges={['left','right','bottom']}>
      <LinearGradient
        colors={['#f5f7fa', '#1a1a2e']}
        style={{ height: insets.top }}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
      />
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Explore</Text>
          <Text style={styles.subtitle}>Search for users by username or name</Text>
        </View>
        
        {/* Fade Gradient Below Header */}
        <LinearGradient
          colors={['#1a1a2e', '#ebedf0']}
          style={{ height: 30 }}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
        />

        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search users by username or name..."
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={Keyboard.dismiss}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                style={styles.clearButton}
                onPress={() => {
                  setSearchQuery('');
                  Keyboard.dismiss();
                }}
              >
                <Ionicons name="close-circle" size={24} color="#718096" />
              </TouchableOpacity>
            )}
          </View>
        </TouchableWithoutFeedback>

        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        )}

        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            {!loading && searchQuery.length >= 2 && searchResults.length === 0 && (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No users found</Text>
              </View>
            )}

            {!loading && searchResults.length > 0 && (
              <FlatList
                data={searchResults}
                renderItem={renderUserItem}
                keyExtractor={(item) => item.uid}
                style={styles.resultsList}
                contentContainerStyle={styles.resultsContent}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={Keyboard.dismiss}
              />
            )}

            {searchQuery.length < 2 && (
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={styles.placeholderContainer}>
                  <Text style={styles.placeholderText}>
                    Start typing to search for users by username or name...
                  </Text>
                </View>
              </TouchableWithoutFeedback>
            )}
          </View>
        </TouchableWithoutFeedback>
      </View>

      <UserProfileModal
        visible={showProfileModal}
        user={selectedUser}
        onClose={() => {
          setShowProfileModal(false);
          setSelectedUser(null);
        }}
        currentUserId={currentUser?.uid}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#ebedf0',
  },
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#1a1a2e',
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
    color: '#cbd5e0',
    fontWeight: '400',
  },
  searchContainer: {
    padding: 20,
    marginTop: -55,
    position: 'relative',
  },
  searchInput: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 18,
    paddingRight: 50,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  clearButton: {
    position: 'absolute',
    right: 30,
    top: 35,
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '500',
  },
  placeholderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  placeholderText: {
    fontSize: 16,
    color: '#718096',
    fontWeight: '500',
    textAlign: 'center',
  },
  resultsList: {
    flex: 1,
  },
  resultsContent: {
    padding: 20,
  },
  userCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  avatarContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  userInfo: {
    flex: 1,
  },
  username: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 4,
  },
  displayName: {
    fontSize: 14,
    color: '#718096',
  },
  arrow: {
    fontSize: 24,
    color: '#cbd5e0',
    fontWeight: '300',
  },
});
