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
import { SafeAreaView } from 'react-native-safe-area-context';
import { FolderIcon, ChevronForwardIcon, GlobeOutlineIcon, PersonOutlineIcon, FingerprintIcon } from './Icons';
import { useAuth, isGuestUser } from '../auth/SimpleAuthContext';
import { useProfileStats } from '../contexts/ProfileStatsContext';
import { LoginScreen } from '../auth/AuthScreens';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { sanitizeTextForDb } from '../lib/sanitizeTextForDb';
import { createDeleteIntent, assertDeleteAllowed, logDeleteAudit, isClearInProgress, setClearInProgress } from '../lib/deleteGuard';
import { getApiBaseUrl } from '../lib/getEnvVar';
import { getScanAuthHeaders } from '../lib/authHeaders';
import { perfLog } from '../lib/perfLogger';
import { resetSafetyBaselines } from '../lib/dataSafetyMark';
import { clearDeletedPendingStableKeys } from '../services/supabaseSync';
import { purgeLocalData } from '../lib/cacheEviction';
import { PENDING_APPROVE_ACTION_KEY } from '../lib/cacheKeys';
import { logger } from '../utils/logger';
import * as BiometricAuth from '../services/biometricAuth';
import { UpgradeModal } from './UpgradeModal';
import { useTheme, type ThemePreference } from '../theme/ThemeProvider';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ThemeTokens } from '../theme/tokens';
import { checkSubscriptionStatus as checkIAPSubscriptionStatus } from '../services/appleIAPService';
import { checkSubscriptionStatus, isSubscriptionUIHidden } from '../services/subscriptionService';
import { AppHeader } from './AppHeader';
import StorageDebugScreen from '../screens/StorageDebugScreen';
import { useScanning } from '../contexts/ScanningContext';

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
  /** Called before storage is wiped so the parent can cancel any in-flight scan batch first. */
  onCancelBatch?: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ visible, onClose, onDataCleared, onCancelBatch }) => {
 const { refreshProfileStats } = useProfileStats();
 const { setActiveScanJobIds } = useScanning();
 const { 
 user, 
 signOut, 
 deleteAccount,
 refreshAuthState,
 updateProfileUsername,
 updateProfileDisplayName,
 biometricCapabilities,
 isBiometricEnabled,
 enableBiometric,
 disableBiometric,
 } = useAuth();
 const { t, preference, setPreference, headingFont } = useTheme();
 const styles = React.useMemo(() => getStyles(t), [t]);
 const [newDisplayName, setNewDisplayName] = useState('');
 const [newUsername, setNewUsername] = useState('');
 const [loading, setLoading] = useState(false);
 const [displayNameLoading, setDisplayNameLoading] = useState(false);
  const [clearingAccount, setClearingAccount] = useState(false);
  // Clear flow: we only store counts from first tap; intent is created on confirm so gesture is fresh (avoids "gesture is stale" when user takes time to read the alert).
  const [clearCounts, setClearCounts] = useState({ books: 0, photos: 0 });
  const [biometricEnabled, setBiometricEnabled] = useState(false);
 const [biometricLoading, setBiometricLoading] = useState(false);
 const [showUpgradeModal, setShowUpgradeModal] = useState(false);
 const [subscriptionTier, setSubscriptionTier] = useState<'free' | 'pro'>('free');
 const [publicProfileEnabled, setPublicProfileEnabled] = useState(false);
 const [updatingPublicProfile, setUpdatingPublicProfile] = useState(false);
 const [showStorageDebug, setShowStorageDebug] = useState(false);

 // Update display name and username when user changes or modal opens
 React.useEffect(() => {
 if (visible && user) {
 setNewDisplayName(user.displayName || '');
 setNewUsername(user.username || '');
 }
 }, [user, visible]);

 // Check biometric status and subscription when modal opens
 useEffect(() => {
 if (visible) {
 loadBiometricStatus();
 checkSubscriptionTier();
 loadPublicProfileStatus();
 }
 }, [visible, user]);

 const loadPublicProfileStatus = async () => {
 if (!user || !supabase) return;
 try {
 const { data, error } = await supabase
 .from('profiles')
 .select('public_profile_enabled')
 .eq('id', user.uid)
 .single();
 
 if (!error && data) {
 setPublicProfileEnabled(data.public_profile_enabled || false);
 }
 } catch (error) {
 console.error('Error loading public profile status:', error);
 }
 };

 const togglePublicProfile = async (enabled: boolean) => {
 if (!user || !supabase) {
 Alert.alert('Error', 'Unable to update profile settings.');
 return;
 }

 setUpdatingPublicProfile(true);
 try {
 const { error } = await supabase
 .from('profiles')
 .update({ public_profile_enabled: enabled })
 .eq('id', user.uid);

 if (error) {
 console.error('Error updating public profile:', error);
 Alert.alert('Error', 'Failed to update profile settings. Please try again.');
 return;
 }

 setPublicProfileEnabled(enabled);
 const profileUrl = `https://bookshelfscan.app/${user.username}`;
 
 if (enabled) {
 Alert.alert(
 'Public Profile Enabled',
 `Your profile is now public! Share it at:\n\n${profileUrl}`,
 [{ text: 'OK' }]
 );
 } else {
 Alert.alert('Public Profile Disabled', 'Your profile is now private.');
 }
 } catch (error) {
 console.error('Error toggling public profile:', error);
 Alert.alert('Error', 'Failed to update profile settings. Please try again.');
 } finally {
 setUpdatingPublicProfile(false);
 }
 };

 const loadBiometricStatus = async () => {
 try {
 const enabled = await isBiometricEnabled();
 setBiometricEnabled(enabled);
 } catch (error) {
 console.error('Error loading biometric status:', error);
 }
 };

 const checkSubscriptionTier = async () => {
 if (!user) return;
 try {
 // Use IAP check which checks both Apple IAP and Supabase
 const tier = await checkIAPSubscriptionStatus();
 setSubscriptionTier(tier);
 } catch (error) {
 console.error('Error checking subscription tier:', error);
 // Fallback to Supabase check if IAP check fails
 try {
 const fallbackTier = await checkSubscriptionStatus();
 setSubscriptionTier(fallbackTier);
 } catch (fallbackError) {
 console.error('Error in fallback subscription check:', fallbackError);
 }
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
 if (!user) {
 Alert.alert('Error', 'User not found. Please try again.');
 return;
 }

 const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
 const newUsernameTrimmed = newUsername.trim();
 if (!usernameRegex.test(newUsernameTrimmed)) {
 Alert.alert('Invalid Username', 'Username must be 3-20 characters and contain only letters, numbers, and underscores');
 return;
 }
 if (newUsernameTrimmed.length < 3) {
 Alert.alert('Invalid Username', 'Username must be at least 3 characters');
 return;
 }

 const newUsernameLower = newUsernameTrimmed.toLowerCase();
 const currentUsernameLower = user.username ? user.username.toLowerCase().trim() : '';
 if (currentUsernameLower && newUsernameLower === currentUsernameLower) {
 Alert.alert('No Change', 'This is already your username');
 return;
 }

 setLoading(true);
 try {
 const { getScanAuthHeaders } = await import('../lib/authHeaders');
 const { getEnvVar } = await import('../lib/getEnvVar');
 let headers: { Authorization: string; 'Content-Type': string };
 try {
 headers = await getScanAuthHeaders();
 } catch (authErr) {
 Alert.alert('Error', 'You must be signed in to change your username.');
 setLoading(false);
 return;
 }
 const session = (await supabase.auth.getSession()).data.session;
 const payload = { username: newUsernameLower };
 console.log('[USERNAME_SAVE] userId=', user.uid, 'newUsername=', newUsernameLower);
 console.log('[USERNAME_SAVE] payload=', JSON.stringify(payload));
 console.log('USERNAME_SAVE_SESSION', {
 hasSession: !!session,
 userId: session?.user?.id,
 exp: session?.expires_at,
 now: Math.floor(Date.now() / 1000),
 tokenPrefix: session?.access_token?.slice(0, 20),
 });
 console.log('USERNAME_SAVE_HEADERS', {
 hasAuth: !!headers.Authorization,
 authPrefix: headers.Authorization?.slice(0, 30),
 });
 const apiBase = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
 const usernameSaveUrl = `${apiBase}/api/update-username`;
 console.log('[USERNAME_SAVE_URL]', usernameSaveUrl);
 const res = await fetch(usernameSaveUrl, {
 method: 'POST',
 headers,
 body: JSON.stringify(payload),
 });
 const data = await res.json().catch(() => ({}));
 console.log('[USERNAME_SAVE] api response status=', res.status, 'data=', JSON.stringify(data), 'error=', data?.error ?? data?.message ?? null);

 if (!res.ok) {
 const msg = data?.message || data?.error || 'Failed to update username.';
 if (res.status === 409) {
 Alert.alert('Username Taken', msg);
 } else if (res.status === 400) {
 Alert.alert('Invalid Username', msg);
 } else {
 Alert.alert('Error', msg);
 }
 setLoading(false);
 return;
 }

 const returnedUsername = (data?.username ?? newUsernameLower) as string;
 console.log('[USERNAME_SAVE] after API success', {
 source: 'api_response',
 username_before: currentUsernameLower || null,
 username_after: returnedUsername,
 updated_at: null,
 userId: user.uid,
 });
 console.log('USERNAME_SAVE_SUCCESS', { returnedUsername, userId: user.uid });

 if (currentUsernameLower) {
 await AsyncStorage.removeItem(`usernameToEmail:${currentUsernameLower}`);
 }
 await AsyncStorage.setItem(`usernameToEmail:${newUsernameLower}`, user.email);

 await updateProfileUsername(returnedUsername);
 setNewUsername(returnedUsername);

 // D) Make UI authoritative from DB after save: re-fetch profiles row and update state from that response
 let dbUsername = returnedUsername;
 if (supabase) {
 try {
 const { data: row, error: fetchErr } = await supabase
 .from('profiles')
 .select('id, username, updated_at')
 .eq('id', user.uid)
 .single();
 if (!fetchErr && row?.username != null) {
 dbUsername = String(row.username).trim().toLowerCase();
 await updateProfileUsername(dbUsername);
 setNewUsername(dbUsername);
 console.log('[USERNAME_SAVE] after Supabase profile re-fetch', {
 source: 'supabase',
 username_before: returnedUsername,
 username_after: dbUsername,
 updated_at: row.updated_at ?? null,
 id: row.id,
 });
 console.log('PROFILE_AUTHORITATIVE_FROM_DB', { username: dbUsername, updated_at: row.updated_at, id: row.id });
 } else if (fetchErr) {
 console.warn('PROFILE_AUTHORITATIVE_FROM_DB fetch failed', fetchErr.message);
 }
 } catch (e) {
 console.warn('PROFILE_AUTHORITATIVE_FROM_DB fetch error', e);
 }
 }
 await refreshAuthState();

 Alert.alert('Success', `Username updated to @${dbUsername}`);
 } catch (error: any) {
 console.error('Error updating username:', error);
 Alert.alert('Error', error?.message || 'Failed to update username. Please try again.');
 } finally {
 setLoading(false);
 }
 };

 const handleChangeDisplayName = async () => {
 if (!user || isGuestUser(user)) return;
 const trimmed = newDisplayName.trim();
 setDisplayNameLoading(true);
 try {
 if (!supabase) {
 Alert.alert('Error', 'Unable to update profile.');
 return;
 }
 const displayNameForDb = trimmed ? (sanitizeTextForDb(trimmed) ?? trimmed) : null;
 const { error } = await supabase
 .from('profiles')
 .update({ display_name: displayNameForDb, updated_at: new Date().toISOString() })
 .eq('id', user.uid);

 if (error) {
 console.error('Error updating display name:', error);
 Alert.alert('Error', 'Failed to update display name. Please try again.');
 return;
 }
 await updateProfileDisplayName(trimmed);
 setNewDisplayName(trimmed);
 Alert.alert('Success', 'Display name updated.');
 } catch (error: any) {
 console.error('Error updating display name:', error);
 Alert.alert('Error', error?.message || 'Failed to update display name. Please try again.');
 } finally {
 setDisplayNameLoading(false);
 }
 };

  const handleClearAccount = async () => {
    if (!user) {
      Alert.alert('Error', 'User not found. Please try again.');
      return;
    }

    let bookCount = 0;
    let photoCount = 0;
    try {
      const approvedData = await AsyncStorage.getItem(`approved_books_${user.uid}`);
      const photosData = await AsyncStorage.getItem(`photos_${user.uid}`);
      bookCount = approvedData ? JSON.parse(approvedData).length : 0;
      photoCount = photosData ? JSON.parse(photosData).length : 0;
    } catch (e) {
      console.warn('Error getting counts:', e);
    }

    setClearCounts({ books: bookCount, photos: photoCount });

    Alert.alert(
      'Clear All Data',
      `This will permanently delete:\n\n• ${bookCount} book${bookCount !== 1 ? 's' : ''} from your library\n• ${photoCount} scan photo${photoCount !== 1 ? 's' : ''}\n• All collections and scan history\n\nAre you sure?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Yes, Clear Everything', style: 'destructive', onPress: handleClearAccountConfirmed },
      ]
    );
  };

  const handleClearAccountConfirmed = async () => {
    if (!user) return;
    if (isClearInProgress()) return;
    const bookCount = clearCounts.books;
    const photoCount = clearCounts.photos;
    const _clearIntent = createDeleteIntent('user_clear_library', 'SettingsModal');
    _clearIntent.userConfirmed = true;
    const tapAt = Date.now();
    perfLog('clear_library', 'tap', { tapAt, bookCount, photoCount });

    setClearInProgress(true);
    setClearingAccount(true);

    try {
      if (!assertDeleteAllowed(_clearIntent, { rowCount: bookCount + photoCount || 1, isBulkConfirmed: true })) {
        setClearingAccount(false);
        setClearInProgress(false);
        return;
      }

      // Purge durable upload queue first so upload worker does not re-upsert rows after delete.
      const { clearQueueForUser } = await import('../lib/photoUploadQueue');
      if (user.uid) await clearQueueForUser(user.uid);

      // Server-side clear by user_id — do NOT rely on local counts. API runs UPDATE ... WHERE user_id = auth.uid() so every row is soft-deleted.
      const baseUrl = getApiBaseUrl();
      let photosUpdated = 0;
      let booksUpdated = 0;
      if (baseUrl) {
        try {
          const headers = await getScanAuthHeaders();
          const res = await fetch(`${baseUrl}/api/clear-library`, { method: 'POST', headers: { ...headers } });
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean; photosUpdated?: number; booksUpdated?: number };
          if (json.ok === true) {
            photosUpdated = json.photosUpdated ?? 0;
            booksUpdated = json.booksUpdated ?? 0;
          } else {
            throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
          }
        } catch (e) {
          logger.warn('[CLEAR_LIBRARY]', 'API failed, skipping server clear', { err: (e as Error)?.message });
        }
      }
      logDeleteAudit(_clearIntent, {
        extra: { scope: 'all_books_and_photos', serverPhotosUpdated: photosUpdated, serverBooksUpdated: booksUpdated },
        rowCount: photosUpdated + booksUpdated,
        isBulkConfirmed: true,
        userId: user.uid,
      });

      // Cancel any in-flight scan batch BEFORE wiping storage.
      if (onCancelBatch) onCancelBatch();
      // Clear durable active scan job ids so scan bar does not linger after clear library.
      setActiveScanJobIds([]);

      // Purge local scan cache, covers, and cache dir so account reset doesn't leave GB of files behind.
      const purgeResult = await purgeLocalData({ keepLastN: 0 });
      logger.info('[LOCAL_STORAGE_PURGE_RESULT]', {
        deletedCount: purgeResult.totalDeleted,
        deletedBytes: purgeResult.totalBytesFreed,
        scanStagingDeleted: purgeResult.scanStagingDeleted,
        scanStagingBytesFreed: purgeResult.scanStagingBytesFreed,
        legacyPhotosDeleted: purgeResult.legacyPhotosDeleted,
        legacyPhotosBytesFreed: purgeResult.legacyPhotosBytesFreed,
        coversDeleted: purgeResult.coversDeleted,
        cacheDirCleared: purgeResult.cacheDirCleared,
        errors: purgeResult.errors.length ? purgeResult.errors : undefined,
      });

      // Clear all local storage (including photo aliases so stale IDs don't persist)
      await AsyncStorage.setItem(`approved_books_${user.uid}`, JSON.stringify([]));
      await AsyncStorage.setItem(`photos_${user.uid}`, JSON.stringify([]));
      await AsyncStorage.removeItem(`folders_${user.uid}`);
      await AsyncStorage.removeItem(`pending_books_${user.uid}`);
      await AsyncStorage.removeItem(`rejected_books_${user.uid}`);
      await AsyncStorage.removeItem(`books_${user.uid}`);
      await AsyncStorage.removeItem(`photo_id_aliases_${user.uid}`);
      await clearDeletedPendingStableKeys(user.uid);
      await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY);
      // Clear approve mutations outbox so stale entries don't auto-approve on next load.
      await AsyncStorage.removeItem(`approve_mutations_${user.uid}`);
      await AsyncStorage.setItem(`library_cleared_at_${user.uid}`, String(Date.now()));
      await resetSafetyBaselines(user.uid);
      // Clear upload queue so zombie photos don't block future scans.
      try {
        const { clearQueueForUser } = await import('../lib/photoUploadQueue');
        await clearQueueForUser(user.uid);
      } catch {}

      await refreshProfileStats([]);
      // Clear cached stats so stale counts don't flash on next app load.
      await AsyncStorage.removeItem(`profile_stats_cache_${user.uid}`);
      // Clear cached author count key if it exists.
      await AsyncStorage.removeItem(`cached_author_count_${user.uid}`);
      const stateCommittedAt = Date.now();
      perfLog('clear_library', 'state_committed', { stateCommittedAt, booksUpdated, photosUpdated });
      if (onDataCleared) onDataCleared();

      Alert.alert(
        'Data Cleared',
        'All books, photos, and data have been removed from your account.',
        [{ text: 'OK', onPress: () => { setClearingAccount(false); onClose(); } }],
      );
    } catch (error) {
      console.error('Error clearing account:', error);
      Alert.alert('Error', 'Failed to clear all data. Please try again.');
      setClearingAccount(false);
    } finally {
      setClearInProgress(false);
    }
  };

 return (
 <Modal
 visible={visible}
 animationType="none"
 presentationStyle="fullScreen"
 onRequestClose={onClose}
 >
 <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg }]} edges={['left','right','bottom']}>
 <AppHeader title="Settings" onBack={onClose} />

 <ScrollView style={[styles.content, { backgroundColor: t.colors.bg }]}>
 {/* Theme selector — segmented control style */}
 <View style={styles.section}>
 <Text style={[styles.sectionTitle, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>APPEARANCE</Text>
 <View style={[styles.themeSegment, { backgroundColor: t.colors.inputBg ?? t.colors.surface2 }]}>
 {(['system', 'light', 'dark'] as const).map((pref) => {
   const isActive = preference === pref;
   const label = pref === 'system' ? 'Auto' : pref === 'light' ? 'Light' : 'Dark';
   return (
 <TouchableOpacity
   key={pref}
   style={[
     styles.themeSegmentItem,
     isActive && [styles.themeSegmentItemActive, { backgroundColor: t.colors.surface }],
   ]}
   onPress={() => setPreference(pref)}
   activeOpacity={0.7}
 >
   <Text style={[
     styles.themeSegmentText,
     { color: isActive ? (t.colors.textPrimary ?? t.colors.text) : (t.colors.textSecondary ?? t.colors.textMuted) },
     isActive && styles.themeSegmentTextActive,
   ]}>
     {label}
   </Text>
 </TouchableOpacity>
   );
 })}
 </View>
 </View>

 {/* Guest Sign In Section */}
 {user && isGuestUser(user) && (
 <View style={styles.section}>
 <Text style={styles.sectionTitle}>Sign In</Text>
 <Text style={styles.settingDescription}>
 Sign in to save your books, sync across devices, and access all features!
 </Text>
 <View style={{ marginTop: 20 }}>
 <LoginScreen onAuthSuccess={() => {
 onClose();
 // User will be automatically updated in auth context
 }} />
 </View>
 </View>
 )}

 {/* Account Section - Only show for authenticated users */}
 {user && !isGuestUser(user) && (
 <>
 <View style={styles.section}>
 <Text style={styles.sectionTitle}>Account</Text>

 {/* Display Name */}
 <View style={styles.settingItem}>
 <View style={styles.settingContent}>
 <Text style={styles.settingLabel}>Display Name</Text>
 <Text style={styles.settingDescription}>
 The name shown on your profile (e.g. in My Library). Can include spaces.
 </Text>
 </View>
 </View>
 <View style={styles.inputContainer}>
 <TextInput
 style={styles.input}
 placeholder="Your display name"
 placeholderTextColor={t.colors.textMuted}
 value={newDisplayName}
 onChangeText={setNewDisplayName}
 autoCapitalize="words"
 autoCorrect={false}
 maxLength={60}
 editable={!displayNameLoading}
 />
 <TouchableOpacity
 style={[styles.saveButton, (displayNameLoading || newDisplayName.trim() === (user?.displayName || '')) && styles.saveButtonDisabled]}
 onPress={handleChangeDisplayName}
 disabled={displayNameLoading || newDisplayName.trim() === (user?.displayName || '')}
 activeOpacity={0.8}
 >
 {displayNameLoading ? (
 <ActivityIndicator size="small" color={t.colors.primaryText} />
 ) : (
 <Text style={styles.saveButtonText}>Save</Text>
 )}
 </TouchableOpacity>
 </View>

 <View style={styles.divider} />

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
 placeholderTextColor={t.colors.textMuted}
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
 <ActivityIndicator size="small" color={t.colors.primaryText} />
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

 {/* Subscription Section */}
 {/* FEATURE FLAG: Hide entire subscription section when pro is enabled for everyone */}
 {!isSubscriptionUIHidden() && (
 <View style={styles.section}>
 <Text style={styles.sectionTitle}>Subscription</Text>
 
 <View style={styles.infoRow}>
 <View style={styles.infoContent}>
 <Text style={styles.infoLabel}>Current Plan</Text>
 <Text style={[styles.infoValue, subscriptionTier === 'pro' && { color: t.colors.primary, fontWeight: '700' }]}>
 {subscriptionTier === 'pro' ? 'Pro' : 'Free'}
 </Text>
 </View>
 </View>

 {subscriptionTier === 'free' && (
 <TouchableOpacity
 style={styles.upgradeButton}
 onPress={() => setShowUpgradeModal(true)}
 activeOpacity={0.8}
 >
 <Text style={styles.upgradeButtonText}>Upgrade to Pro</Text>
 </TouchableOpacity>
 )}

 {subscriptionTier === 'pro' && (
 <View style={styles.proBadge}>
 <Text style={styles.proBadgeText}> Unlimited Scans</Text>
 </View>
 )}
 </View>
 )}

 {/* Additional Settings Section */}
 <View style={styles.section}>
 <Text style={styles.sectionTitle}>Preferences</Text>
 
 {/* Public Profile Toggle */}
 {user?.username && (
 <View style={styles.settingItem}>
 <View style={styles.settingContent}>
 <View style={styles.settingHeader}>
 <GlobeOutlineIcon size={20} color={t.colors.primary} style={{ marginRight: 8 }} />
 <Text style={styles.settingLabel}>Public Profile</Text>
 </View>
 <Text style={styles.settingDescription}>
 {publicProfileEnabled 
 ? `Your profile is public at bookshelfscan.app/${user.username}`
 : 'Make your profile and library visible to everyone'
 }
 </Text>
 </View>
 <Switch
 value={publicProfileEnabled}
 onValueChange={togglePublicProfile}
 disabled={updatingPublicProfile}
 trackColor={{ false: t.colors.border, true: t.colors.accent2 }}
 thumbColor={publicProfileEnabled ? t.colors.primaryText : t.colors.surface2}
 />
 </View>
 )}

 {/* Biometric Login Toggle */}
 {biometricCapabilities?.isAvailable && (
 <View style={styles.settingItem}>
 <View style={styles.settingContent}>
 <View style={styles.settingHeader}>
 {LocalAuthentication &&
             biometricCapabilities.supportedTypes.includes(
               LocalAuthentication.AuthenticationType?.FACIAL_RECOGNITION
             )
               ? <PersonOutlineIcon size={20} color={t.colors.primary} style={{ marginRight: 8 }} />
               : <FingerprintIcon size={20} color={t.colors.primary} style={{ marginRight: 8 }} />}
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
 trackColor={{ false: t.colors.border, true: t.colors.accent2 }}
 thumbColor={biometricEnabled ? t.colors.primaryText : t.colors.surface2}
     />
     </View>
     )}

     {/* Storage usage */}
     <TouchableOpacity
       style={styles.settingItem}
       onPress={() => setShowStorageDebug(true)}
       activeOpacity={0.7}
     >
       <View style={styles.settingContent}>
         <View style={styles.settingHeader}>
           <FolderIcon size={20} color={t.colors.primary} style={{ marginRight: 8 }} />
           <Text style={styles.settingLabel}>Storage Usage</Text>
         </View>
         <Text style={styles.settingDescription}>View local cache sizes and free up space</Text>
       </View>
       <ChevronForwardIcon size={18} color={t.colors.textMuted} />
     </TouchableOpacity>
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
 <ActivityIndicator size="small" color={t.colors.primaryText} />
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

 {/* Delete Account Section - At the very bottom - Only for authenticated users */}
 {user && !isGuestUser(user) && (
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
 )}
 </>
 )}
 </ScrollView>

 {/* Upgrade Modal */}
 <UpgradeModal
 visible={showUpgradeModal}
 onClose={() => {
 setShowUpgradeModal(false);
 checkSubscriptionTier();
 }}
 onUpgradeComplete={() => {
 setShowUpgradeModal(false);
 checkSubscriptionTier();
 }}
 />

  {/* Storage debug screen — rendered as a full-screen overlay inside the modal */}
  {showStorageDebug && (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => setShowStorageDebug(false)}
    >
      <StorageDebugScreen onClose={() => setShowStorageDebug(false)} />
    </Modal>
  )}

  </SafeAreaView>
</Modal>
);
};

function getStyles(t: ThemeTokens) {
 const c = t.colors;
 return StyleSheet.create({
 container: { flex: 1, backgroundColor: c.bg },
 content: { flex: 1 },
 section: {
 marginTop: 24,
 paddingHorizontal: 20,
 },
 sectionTitle: { fontSize: 13, fontWeight: '600', color: c.textSecondary ?? c.textMuted, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 },
 themeSegment: {
 flexDirection: 'row',
 borderRadius: 10,
 padding: 3,
 },
 themeSegmentItem: {
 flex: 1,
 paddingVertical: 8,
 alignItems: 'center',
 borderRadius: 8,
 },
 themeSegmentItemActive: {
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.08,
 shadowRadius: 2,
 elevation: 1,
 },
 themeSegmentText: { fontSize: 14, fontWeight: '500' },
 themeSegmentTextActive: { fontWeight: '600' },
 infoRow: { paddingVertical: 14 },
 infoContent: { flexDirection: 'column' },
 infoLabel: { fontSize: 14, color: c.textSecondary ?? c.textMuted, fontWeight: '500', marginBottom: 4 },
 infoValue: { fontSize: 16, color: c.textPrimary ?? c.text, fontWeight: '600' },
 settingItem: { paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
 settingContent: { flex: 1, marginRight: 12 },
 settingHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
 settingLabel: { fontSize: 15, color: c.textPrimary ?? c.text, fontWeight: '600', marginBottom: 2 },
 settingDescription: { fontSize: 13, color: c.textSecondary ?? c.textMuted, lineHeight: 18 },
 inputContainer: { marginTop: 12 },
 input: {
 backgroundColor: c.inputBg ?? c.surface2,
 borderRadius: 10,
 padding: 14,
 fontSize: 15,
 borderWidth: 1,
 borderColor: c.inputBorder ?? c.border,
 marginBottom: 10,
 color: c.textPrimary ?? c.text,
 },
 saveButton: {
 backgroundColor: c.primary,
 borderRadius: 10,
 padding: 14,
 alignItems: 'center',
 },
 saveButtonDisabled: { opacity: 0.4 },
 saveButtonText: { color: c.primaryText, fontSize: 15, fontWeight: '600' },
 divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider ?? c.border, marginVertical: 16 },
 comingSoon: { fontSize: 14, color: c.textSecondary ?? c.textMuted, fontStyle: 'italic' },
 deleteAccountButton: {
 backgroundColor: c.danger,
 borderRadius: 12,
 padding: 16,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 deleteAccountButtonText: { color: c.primaryText, fontSize: 16, fontWeight: '700' },
 signOutButton: {
 backgroundColor: c.textMuted,
 borderRadius: 12,
 padding: 16,
 alignItems: 'center',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 signOutButtonText: { color: c.primaryText, fontSize: 16, fontWeight: '700' },
 clearAccountButton: {
 backgroundColor: c.accent2,
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
 clearAccountButtonDisabled: { opacity: 0.6 },
 clearAccountButtonText: { color: c.primaryText, fontSize: 16, fontWeight: '700' },
 bottomSection: { marginBottom: 30 },
 upgradeButton: {
 backgroundColor: c.surface,
 borderRadius: 12,
 padding: 16,
 alignItems: 'center',
 marginTop: 15,
 borderWidth: 1,
 borderColor: c.border,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.15,
 shadowRadius: 4,
 elevation: 3,
 },
 upgradeButtonText: { color: c.textPrimary ?? c.text, fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  proBadge: { backgroundColor: c.surface2, borderRadius: 8, padding: 12, marginTop: 15, alignItems: 'center' },
  proBadgeText: { color: c.primary, fontSize: 14, fontWeight: '600' },
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  confirmCard: {
    width: '100%',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  confirmTitle: { fontSize: 22, fontWeight: '800', marginBottom: 12, letterSpacing: 0.2 },
  confirmBody: { fontSize: 15, lineHeight: 22 },
 });
}

export default SettingsModal;

