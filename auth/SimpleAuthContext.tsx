/**
 * Auth: email/password only. No Apple/Google OAuth or ID tokens.
 *
 * RULE: Auth state comes only from Supabase (email/password). We do not use or persist
 * idToken, identityToken, provider_token, or any Apple/Google SDK token as session.
 *
 * Session is used as-is; we do not clear or reject based on JWT alg.
 *
 * USERNAME SINGLE SOURCE OF TRUTH: The profiles table is canonical for username.
 * - Read: always from profiles when available; only use AsyncStorage 'user' as stale cache when DB unavailable.
 * - Write: only via the update-username API (profiles table). Never merge usernames from multiple sources.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { supabase, SUPABASE_ENV } from '../lib/supabase';
import { getEnvVar } from '../lib/getEnvVar';
import { Book, Photo, Folder } from '../types/BookTypes';
import * as BiometricAuth from '../services/biometricAuth';
import { saveBookToSupabase, savePhotoToSupabase, loadProfilePhotoFromSupabase } from '../services/supabaseSync';
import { PENDING_APPROVE_ACTION_KEY, ACTIVE_USER_ID_KEY } from '../lib/cacheKeys';
import { clearSignedPhotoUrlCache } from '../lib/photoUrls';
import { sanitizeTextForDb } from '../lib/sanitizeTextForDb';
import { setAuditToken } from '../lib/deleteGuard';
import {
  logBuildFingerprint,
  logAuthSessionInit,
  logAuthSessionRefresh,
  logAuthUserMismatch,
  logAuthSignout,
} from '../lib/authIntegrity';
import { LOG_DEBUG } from '../lib/logFlags';
import logger from '../utils/logger';

interface User {
 uid: string;
 email: string;
 username: string;
 displayName?: string;
 photoURL?: string;
 isGuest?: boolean; // Flag to identify guest users
 /** When set, from profiles.updated_at (canonical). Used to avoid stale overwrites: only overwrite username if incoming has real username or is newer. */
 profileUpdatedAt?: string;
}

// Guest user ID constant for local storage
export const GUEST_USER_ID = 'guest_user';

/**
 * Prevent stale overwrites: do not overwrite username with null/empty unless incoming is newer (by updated_at).
 * Only overwrite if incoming has a real username, or incoming.updated_at is newer than current.
 */
function resolveUsername(
 incomingUsername: string,
 incomingUpdatedAt: string | null | undefined,
 currentUsername: string | null | undefined,
 currentProfileUpdatedAt: string | null | undefined
): string {
 const hasIncoming = !!incomingUsername?.trim();
 const hasCurrent = !!currentUsername?.trim();
 if (hasIncoming) return incomingUsername.trim();
 if (hasCurrent && !hasIncoming) {
 if (incomingUpdatedAt && (currentProfileUpdatedAt == null || incomingUpdatedAt > currentProfileUpdatedAt))
 return ''; // DB is newer, allow clear
 return currentUsername; // keep current, avoid stale overwrite
 }
 return incomingUsername?.trim() ?? '';
}

// Helper function to check if a user is a guest
export const isGuestUser = (user: User | null): boolean => {
 return user?.uid === GUEST_USER_ID || user?.isGuest === true;
};

interface AuthContextType {
 user: User | null;
 /** Supabase session use this for gating (not user) so Library doesn't redirect before user is derived. */
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
 /** Update profile username locally + cache only. Call after successful API update-username. Canonical source: profiles table. */
 updateProfileUsername: (username: string) => Promise<void>;
 /** Update profile display name locally + cache. Call after successful Supabase profiles.display_name update. */
 updateProfileDisplayName: (displayName: string) => Promise<void>;
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
 logger.info('[SESSION_STORAGE_CLEAR]', 'clearSupabaseStorage() called');
 try {
 const allKeys = await AsyncStorage.getAllKeys();
 const supabaseKeys = allKeys.filter(key =>
 key.includes('supabase') || key.includes('sb-') || key.includes('auth-token')
 );
 if (supabaseKeys.length > 0) {
 logger.debug('[SESSION_STORAGE_CLEAR]', 'keys being removed', { keys: supabaseKeys });
 await AsyncStorage.multiRemove(supabaseKeys);
 } else {
 logger.debug('[SESSION_STORAGE_CLEAR]', 'no Supabase keys found (already clear or different key names)');
 }
 } catch (e) {
 logger.warn('[SESSION_STORAGE_CLEAR]', 'error', { err: String(e) });
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
 logger.info('[DEV_RESET_AUTH]', 'removed keys', { count: kill.length });
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

 const authSnapshotRef = useRef<{ hasSession: boolean; userId: string | null; authReady: boolean } | null>(null);
 useEffect(() => {
 const hasSession = !!session;
 const userId = session?.user?.id ?? null;
 const prev = authSnapshotRef.current;
 const same = prev && prev.hasSession === hasSession && prev.userId === userId && prev.authReady === authReady;
 authSnapshotRef.current = { hasSession, userId, authReady };
 if (LOG_DEBUG && !same) {
 logger.debug('[AUTH_SNAPSHOT]', { hasSession, userId: userId ? userId.slice(0, 8) : null, authReady });
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

 /**
 * Canonical source for username (and display_name, avatar_url) is the profiles table.
 * We only read from that place when available. AsyncStorage 'user' is a stale cache
 * used only when DB is unavailable (no supabase, error, or no row). Never merge
 * usernames from multiple sources deterministic rule: DB wins when present; else stale cache.
 */
 const fetchUserProfile = async (userId: string): Promise<{ username: string; displayName?: string; photoURL?: string; source: 'database' | 'cache'; id?: string; updated_at?: string }> => {
 const readStaleCache = async (): Promise<{ username: string; displayName?: string; photoURL?: string }> => {
 try {
 const userJson = await AsyncStorage.getItem('user');
 const parsed = userJson ? JSON.parse(userJson) : null;
 if (parsed?.uid === userId) {
 return {
 username: parsed.username ?? '',
 displayName: parsed.displayName,
 photoURL: parsed.photoURL,
 };
 }
 } catch (_) {}
 return { username: '', displayName: undefined, photoURL: undefined };
 };

 if (!supabase) {
 const stale = await readStaleCache();
 logger.debug('[PROFILE_HYDRATION]', 'fetchUserProfile result', {
   source: 'asyncStorage',
   username_after: stale.username || null,
   reason: 'no_supabase_stale_cache_only',
 });
 return { ...stale, source: 'cache' };
 }

 const { data, error } = await supabase
 .from('profiles')
 .select('id, username, display_name, avatar_url, updated_at')
 .eq('id', userId)
 .single();

 if (error || !data) {
 const stale = await readStaleCache();
 if (LOG_DEBUG && lastLoggedProfileFetchUserIdRef.current !== userId) {
 lastLoggedProfileFetchUserIdRef.current = userId;
 logger.debug('[PROFILE_HYDRATION]', 'fetch failed', { userId: userId.slice(0, 8), error: error?.message ?? 'no data' });
 }
 return { ...stale, source: 'cache' };
 }

 const username = data.username || '';
 const profilePhoto = await loadProfilePhotoFromSupabase(userId);
 const photoURL = profilePhoto?.uri ?? undefined;
 const updatedAt = data.updated_at ?? undefined;
 if (LOG_DEBUG && lastLoggedProfileFetchUserIdRef.current !== userId) {
 lastLoggedProfileFetchUserIdRef.current = userId;
 logger.debug('[PROFILE_HYDRATION]', 'fetch ok', { userId: userId.slice(0, 8), updated_at: updatedAt ?? null });
 }
 return {
 username,
 displayName: data.display_name || undefined,
 photoURL,
 source: 'database',
 id: data.id,
 updated_at: updatedAt,
 };
 };

 // authReady: false on first render. getSession() once on mount set session set authReady true subscribe to onAuthStateChange.
 const authUnsubRef = useRef<(() => void) | null>(null);
 // Guard: only apply the latest profile fetch (avoids double PROFILE_APPLY from StrictMode or session set twice).
 const profileApplyRequestIdRef = useRef(0);
 // Dedupe: log PROFILE_FETCH / PROFILE_APPLY once per userId (not 23 times on boot).
 const lastLoggedProfileFetchUserIdRef = useRef<string | null>(null);
 const lastLoggedProfileApplyUserIdRef = useRef<string | null>(null);

 useEffect(() => {
 // Log build fingerprint once — warns if dev config is running in a release binary.
 logBuildFingerprint();

 if (!supabase) {
   setSession(null);
   setAuthReady(true);
   setLoading(false);
   logAuthSessionInit(null);
   return;
 }

 (async () => {
   // ALWAYS validate session with Supabase, not just AsyncStorage — prevents zombie sessions.
   const _initT0 = Date.now();
   const { data, error } = await supabase.auth.getSession();
   if (error) {
     logger.warn('[AUTH]', 'getSession error', { err: error.message ?? String(error) });
     logAuthSignout({ reason: 'getSession_failed', errMessage: error.message });
     try { await supabase.auth.signOut(); } catch (_) {}
   }

   const sess: Session | null = error ? null : (data?.session ?? null);

   // AUTH_SESSION_INIT — always fires once at app start.
   logAuthSessionInit(sess);
   logger.debug('[AUTH_INIT_LATENCY]', { latencyMs: Date.now() - _initT0 });

   if (!sess) {
     // No valid session — force clean logout so we don't resurrect stale AsyncStorage state.
     setSession(null);
     setUser(null);
     logAuthSignout({ reason: 'no_session_on_init' });
     try {
       await supabase.auth.signOut();
       await clearSupabaseStorage();
       await AsyncStorage.removeItem('user');
       await AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
     } catch (e) {
       logger.warn('[AUTH]', 'forceLogout cleanup error', { err: String(e) });
     }
     // Set guest.
     setUser({
       uid: GUEST_USER_ID,
       email: '',
       username: 'guest',
       displayName: 'Guest',
       isGuest: true,
     });
   } else {
     setSession(sess);
   }

   setAuthReady(true);
   setLoading(false);

   // Track last known session userId so we can detect swaps.
   let _lastSessionUserId: string | null = sess?.user?.id ?? null;
   let _tokenRefreshT0: number | null = null;

   const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
     if (event === 'INITIAL_SESSION' && newSession == null) return;
     setSession(newSession ?? null);

     const newUserId = newSession?.user?.id ?? null;

     // AUTH_USER_MISMATCH: session userId changed to a *different* authenticated user
     // (not just null → uid on sign-in, which is expected).
     if (
       _lastSessionUserId != null &&
       newUserId != null &&
       newUserId !== _lastSessionUserId
     ) {
       logAuthUserMismatch({
         sessionUserId: newUserId,
         stateUserId: _lastSessionUserId,
         event,
       });
     }
     _lastSessionUserId = newUserId;

     // AUTH_SESSION_REFRESH
     if (event === 'TOKEN_REFRESHED') {
       const latencyMs = _tokenRefreshT0 != null ? Date.now() - _tokenRefreshT0 : null;
       _tokenRefreshT0 = null;
       logAuthSessionRefresh({
         ok: !!newSession,
         reason: 'token_refreshed',
         latencyMs: latencyMs ?? undefined,
         newExpiresAt: newSession?.expires_at,
         userIdPrefix: newUserId?.slice(0, 8),
       });
     } else {
       // Mark when next refresh starts (Supabase fires TOKEN_REFRESHED after a silent refresh).
       _tokenRefreshT0 = Date.now();
     }

     // Check B: canary query — fires once on sign-in to confirm we're hitting the right project/dataset.
     if (event === 'SIGNED_IN' && newSession?.user?.id) {
       (async () => {
         const res = await supabase.from('books').select('id', { count: 'exact', head: true });
         logger.info('[BOOKS_HEAD_COUNT]', { count: res.count, err: res.error?.message ?? null, userId: newSession.user.id.slice(0, 8) });
       })();
     }
   });
   authUnsubRef.current = () => sub.subscription.unsubscribe();
 })();

 return () => {
   authUnsubRef.current?.();
 authUnsubRef.current = null;
 };
 }, []);

  // Keep deleteGuard's audit-token in sync with the current session so
  // logDeleteAudit can persist events server-side without prop-drilling the token.
  useEffect(() => {
    setAuditToken(session?.access_token ?? null);
  }, [session?.access_token]);

  // Derive user from session only when authReady. Guest ONLY when authReady === true AND session === null; never earlier.
  // Duplicate PROFILE_FETCH/APPLY on boot is often React StrictMode (double-invoke) or session set twice (getSession + onAuthStateChange). We only apply the latest via requestId.
  useEffect(() => {
 if (!authReady) {
 setUser(null);
 return;
 }
 if (session?.user) {
 const sessionUser = session.user;
 const requestId = ++profileApplyRequestIdRef.current;
 const usernameBeforeRef = user?.username ?? null;
 const profileUpdatedAtBeforeRef = user?.profileUpdatedAt ?? null;
 fetchUserProfile(sessionUser.id)
 .then(profile => {
 if (requestId !== profileApplyRequestIdRef.current) {
 if (LOG_DEBUG) console.log('PROFILE apply skip: requestId mismatch (requestId=' + requestId + ' current=' + profileApplyRequestIdRef.current + ')');
 return;
 }
 const incomingUsername = profile?.username || '';
 const incomingUpdatedAt = profile?.updated_at ?? null;
 const chosenUsername = resolveUsername(
 incomingUsername,
 incomingUpdatedAt,
 usernameBeforeRef,
 profileUpdatedAtBeforeRef
 );
 const source = profile?.source === 'database' ? 'supabase' : (profile?.source === 'cache' ? 'local' : 'default');
 const userData: User = {
 uid: sessionUser.id,
 email: sessionUser.email || '',
 username: chosenUsername,
 displayName: profile?.displayName,
 photoURL: profile?.photoURL,
 profileUpdatedAt: profile?.source === 'database' ? (profile?.updated_at ?? profileUpdatedAtBeforeRef ?? undefined) : (profileUpdatedAtBeforeRef ?? undefined),
 };
 if (LOG_DEBUG && lastLoggedProfileApplyUserIdRef.current !== sessionUser.id) {
 lastLoggedProfileApplyUserIdRef.current = sessionUser.id;
 console.log('PROFILE apply: source=' + source + ' username=' + (chosenUsername || ''));
 }
 setUser(userData);
 return saveUserToStorage(userData).then(() => transferGuestDataToUser(sessionUser.id));
 })
 .catch(() => {
 if (requestId !== profileApplyRequestIdRef.current) {
 if (LOG_DEBUG) console.log('PROFILE apply skip: requestId mismatch (requestId=' + requestId + ' current=' + profileApplyRequestIdRef.current + ')');
 return;
 }
 const fallbackUsername = sessionUser.email?.split('@')[0] || '';
 const userData: User = {
 uid: sessionUser.id,
 email: sessionUser.email || '',
 username: fallbackUsername,
 displayName: undefined,
 photoURL: undefined,
 };
 if (LOG_DEBUG && lastLoggedProfileApplyUserIdRef.current !== sessionUser.id) {
 lastLoggedProfileApplyUserIdRef.current = sessionUser.id;
 console.log('PROFILE apply: source=default username=' + (fallbackUsername || ''));
 }
 setUser(userData);
 return saveUserToStorage(userData).then(() => transferGuestDataToUser(sessionUser.id));
 });
 } else if (session === null) {
 lastLoggedProfileApplyUserIdRef.current = null;
 lastLoggedProfileFetchUserIdRef.current = null;
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
 // session undefined or not yet resolved do not set guest; leave user null until resolved
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
 if (__DEV__ && (process.env.EXPO_PUBLIC_LOG_DEBUG === 'true' || process.env.EXPO_PUBLIC_LOG_DEBUG === '1')) console.log(' Checking for guest data to transfer...');
 
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
 // Only log once per session this fires on every sign-in so silence repeats.
 logger.once('guest_transfer_none', 'debug', '[GUEST_TRANSFER]', 'no guest data to transfer');
 return;
 }
 
 logger.info('[GUEST_TRANSFER]', 'transferring guest data', {
 pending: guestPending.length,
 approved: guestApproved.length,
 rejected: guestRejected.length,
 photos: guestPhotos.length,
 });
 
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
 
 const guestApprovedAdded = mergedApproved.length - userApproved.length;
 if (guestApprovedAdded > 0) {
 console.log(`[GUEST_TRANSFER] merged approved: user=${userApproved.length} guest=${guestApproved.length} merged=${mergedApproved.length} (guest added ${guestApprovedAdded}); Supabase save is non-blocking so local may exceed DB until sync`);
 }
 
 // Save merged data to user's AsyncStorage
 await Promise.all([
 AsyncStorage.setItem(userPendingKey, JSON.stringify(mergedPending)),
 AsyncStorage.setItem(userApprovedKey, JSON.stringify(mergedApproved)),
 AsyncStorage.setItem(userRejectedKey, JSON.stringify(mergedRejected)),
 AsyncStorage.setItem(userPhotosKey, JSON.stringify(mergedPhotos)),
 ]);
 
 console.log(` Saved merged data to user account: ${mergedPending.length} pending, ${mergedApproved.length} approved, ${mergedRejected.length} rejected, ${mergedPhotos.length} photos`);
 
 // Save to Supabase (non-blocking - don't wait for it). If any save fails, local count will exceed DB (cache drift).
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
 console.log(' Guest data synced to Supabase');
 }).catch(error => {
 console.error(' Error syncing guest data to Supabase (non-blocking):', error);
 });
 
 // Clear guest data after successful transfer
 await Promise.all([
 AsyncStorage.removeItem(guestPendingKey),
 AsyncStorage.removeItem(guestApprovedKey),
 AsyncStorage.removeItem(guestRejectedKey),
 AsyncStorage.removeItem(guestPhotosKey),
 ]);
 
 console.log(' Guest data cleared from AsyncStorage');
 } catch (error) {
 console.error(' Error transferring guest data:', error);
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
 logger.debug('[AUTH_SIGNIN_START]', { inputType: isUsername ? 'username' : 'email', supabaseRefPrefix: SUPABASE_REF?.slice(0, 8) ?? null });
 
 // Allow username sign-in by resolving to email from Supabase
 let email = emailOrUsername.trim();
 const requestedUsername = !emailOrUsername.includes('@') ? emailOrUsername.toLowerCase() : null;
 
 if (requestedUsername) {
 try {
 // FIRST: Check cached email - use it immediately if available (fastest path)
 const cachedEmail = await AsyncStorage.getItem('usernameToEmail:' + requestedUsername);
 if (cachedEmail) {
 console.log(` Using cached email for username "${requestedUsername}"`);
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
 console.warn(' Detected old API URL in env var, overriding:', apiUrl);
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
 console.error(' API returned non-JSON response:', text.substring(0, 200));
 throw new Error('Server returned invalid response. Please try again.');
 }
 console.log('API response data:', data);
 if (data.email) {
 email = data.email;
 // Cache the mapping for future use
 await AsyncStorage.setItem('usernameToEmail:' + requestedUsername, email);
 console.log(` Username "${requestedUsername}" resolved to email via API: ${email}`);
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
 console.log(` Using cached email for username "${requestedUsername}"`);
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
 console.log(` Username "${requestedUsername}" resolved to email via RPC: ${email}`);
 }
 }
 } catch (error: any) {
 console.error('Username lookup error:', error);
 Alert.alert('Sign In Error', 'Could not verify username. Please check your connection and try again.');
 setLoading(false);
 return false;
 }
 }
 
 // Do not call signOut() before sign-in it can trigger SIGNED_OUT during/after sign-in and cause a bounce.
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

 // Structured sign-in result log — metadata only, no tokens.
 logger.info('[AUTH_SIGNIN]', {
   ok: !!res.data?.session && !res.error,
   userIdPrefix: res.data?.user?.id?.slice(0, 8) ?? null,
   provider: res.data?.user?.app_metadata?.provider ?? null,
   hasRefreshToken: !!res.data?.session?.refresh_token,
   errCode: res.error ? (res.error as any).code ?? null : null,
   errStatus: res.error ? (res.error as any).status ?? null : null,
 });

 if (error || !data?.user) {
   const errorMessage = getSignInErrorMessage(error);
   if (error) {
     logger.warn('[AUTH_SIGNIN_FAIL]', {
       errMessage: error.message,
       errCode: (error as any).code ?? null,
       isEmailUnconfirmed: (error.message || '').includes('Email not confirmed') || (error as any).code === 'email_not_confirmed',
     });
   }
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
 
 // When signing in by username: use DB username if we got it; otherwise trust requestedUsername (covers cache stale after username change, or profile fetch timeout)
 const profileUsername = (profile?.username || '').toLowerCase();
 const resolvedUsername = requestedUsername
 ? (profile?.source === 'database'
 ? (profile?.username || requestedUsername)
 : requestedUsername)
 : (profile?.username || sUser.email?.split('@')[0] || '');
 const userData: User = {
 uid: sUser.id,
 email: sUser.email || '',
 username: resolvedUsername,
 displayName: profile?.displayName,
 photoURL: profile?.photoURL,
 profileUpdatedAt: profile?.source === 'database' ? (profile?.updated_at ?? undefined) : undefined,
 };

 // Verify signed-in account matches requested username (prevents wrong account from stale email mapping)
 // When profile came from cache and differs from requested, we already used requestedUsername above (post-username-change case)
 if (requestedUsername) {
 const signedInUsername = userData.username.toLowerCase();
 if (signedInUsername !== requestedUsername) {
 // Only treat as mismatch when profile came from DB (so it's a real different account, not stale cache)
 if (profile?.source === 'database') {
 console.error(` Username mismatch! Requested: "${requestedUsername}", Signed in: "${signedInUsername}"`);
 await AsyncStorage.removeItem('user');
 setSession(null);
 Alert.alert(
 'Sign In Error',
 `Username mismatch. You requested "${requestedUsername}" but signed in as "${signedInUsername}". Please try again.`
 );
 setLoading(false);
 return false;
 }
 }
 console.log(` Username resolved: requested="${requestedUsername}", signedIn="${signedInUsername}" (source=${profile?.source ?? 'unknown'})`);
 }

 // Do not call setSession manually Supabase persists the session when signInWithPassword succeeds.

 // Update React state so Library (which gates on session) sees the session immediately.
 setSession(data.session);
 setUser(userData);
 await saveUserToStorage(userData);

 // Confirm session persisted; log metadata only (not the token itself).
 const { data: postLoginSession } = await supabase.auth.getSession();
 logger.debug('[AUTH_POST_LOGIN_SESSION]', {
   hasSession: !!postLoginSession?.session,
   userIdPrefix: postLoginSession?.session?.user?.id?.slice(0, 8) ?? null,
 });
 
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
 // 1. Go to Supabase Dashboard Authentication Settings
 // 2. Under "Email Auth", toggle OFF "Enable email confirmations" 
 // OR configure custom SMTP with a no-op email service
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
 const usernameForDb = sanitizeTextForDb(username.toLowerCase()) ?? username.toLowerCase();
 const displayNameForDb = displayName != null ? sanitizeTextForDb(displayName) : null;
 const { error: profileError } = await supabase
 .from('profiles')
 .insert({
 id: uid,
 username: usernameForDb,
 display_name: displayNameForDb,
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
 try {
   const currentUser = user;
   logAuthSignout({ reason: 'user', userIdPrefix: currentUser?.uid?.slice(0, 8) });

   // Clear user state first.
   setUser(null);

   // Remove user from AsyncStorage and active-user / pending-action so next user never sees previous user's data.
   await AsyncStorage.removeItem('user');
   await AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
   await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY).catch(() => {});

   // Clear biometric credentials on sign out.
   await BiometricAuth.clearStoredCredentials().catch(() => {});

   // Clear signed photo URL cache so next user doesn't see previous user's URLs.
   clearSignedPhotoUrlCache();

   // For Supabase-authenticated users, sign out from Supabase.
   // For demo accounts (DEMO_UID), skip Supabase signOut since they're not in Supabase auth.
   if (supabase && currentUser && currentUser.uid !== DEMO_UID) {
     try {
       await supabase.auth.signOut();
     } catch (supabaseError) {
       logger.warn('[AUTH_SIGNOUT]', 'Supabase signOut error (continuing anyway)', {
         err: supabaseError instanceof Error ? supabaseError.message : String(supabaseError),
       });
     }
   }

   // Clear Supabase storage on explicit sign-out.
   try {
     logger.info('[AUTH_SIGNOUT]', 'clearing Supabase storage keys', {
       env: SUPABASE_ENV ?? (__DEV__ ? 'dev' : 'prod'),
     });
     await clearSupabaseStorage();
   } catch (clearError) {
     logger.warn('[AUTH_SIGNOUT]', 'error clearing Supabase keys', {
       err: clearError instanceof Error ? clearError.message : String(clearError),
     });
   }
 } catch (error) {
   logAuthSignout({
     reason: 'error',
     userIdPrefix: user?.uid?.slice(0, 8),
     errMessage: error instanceof Error ? error.message : String(error),
   });
   // Even if there's an error, clear the user state.
   setUser(null);
 await AsyncStorage.removeItem('user').catch(() => {});
 Alert.alert('Sign Out Error', 'Failed to sign out completely. Please try again.');
 }
 };

 const hardResetAuthStorageDev = async (): Promise<void> => {
 if (!__DEV__) return;
 console.log('[HARD_RESET_AUTH] dev only devResetAuth then clear local state');
 await devResetAuth(supabase);
 await AsyncStorage.removeItem('user').catch(() => {});
 await AsyncStorage.removeItem(ACTIVE_USER_ID_KEY).catch(() => {});
 await AsyncStorage.removeItem(PENDING_APPROVE_ACTION_KEY).catch(() => {});
 setUser(null);
 console.log('[HARD_RESET_AUTH] done fully kill the app and relaunch, then sign in with username/email');
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

 // Verify the recovery token Supabase sets the session from this. Never call setSession with raw token (could be provider token).
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

 /**
 * Update profile username locally and in cache only. Call this only after a successful
 * canonical write to profiles (e.g. API update-username). We never write username to
 * profiles from the app only the update-username API does. Single source of truth: profiles table.
 */
 const updateProfileUsername = async (username: string): Promise<void> => {
 if (!user?.uid) return;
 const usernameBefore = user.username ?? null;
 const usernameAfter = username.trim().toLowerCase();
 const userData: User = {
 ...user,
 username: usernameAfter,
 };
 setUser(userData);
 await saveUserToStorage(userData);
 try {
 await AsyncStorage.setItem(`profile_${user.uid}`, JSON.stringify({ username: userData.username }));
 } catch (_) {}
 if (LOG_DEBUG) console.log('PROFILE apply: source=local_update username=' + (usernameAfter || ''));
 };

 const updateProfileDisplayName = async (displayName: string): Promise<void> => {
 if (!user?.uid) return;
 const trimmed = displayName.trim();
 const userData: User = { ...user, displayName: trimmed || undefined };
 setUser(userData);
 await saveUserToStorage(userData);
 try {
 const cache = await AsyncStorage.getItem(`profile_${user.uid}`);
 const parsed = cache ? JSON.parse(cache) : {};
 await AsyncStorage.setItem(`profile_${user.uid}`, JSON.stringify({ ...parsed, displayName: userData.displayName }));
 } catch (_) {}
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
 const usernameBeforeRefresh = user?.username ?? null;
 const profileUpdatedAtBefore = user?.profileUpdatedAt ?? null;
 try {
 const profile = await fetchUserProfile(sessionUser.id);
 const incomingUsername = profile?.username || '';
 const incomingUpdatedAt = profile?.updated_at ?? null;
 const chosenUsername = resolveUsername(
 incomingUsername,
 incomingUpdatedAt,
 usernameBeforeRefresh,
 profileUpdatedAtBefore
 );
 const source = profile?.source === 'database' ? 'supabase' : (profile?.source === 'cache' ? 'local' : 'default');
 const userData: User = {
 uid: sessionUser.id,
 email: sessionUser.email || '',
 username: chosenUsername,
 displayName: profile?.displayName,
 photoURL: profile?.photoURL,
 profileUpdatedAt: profile?.source === 'database' ? (profile?.updated_at ?? profileUpdatedAtBefore ?? undefined) : (profileUpdatedAtBefore ?? undefined),
 };
 if (LOG_DEBUG && lastLoggedProfileApplyUserIdRef.current !== sessionUser.id) {
 lastLoggedProfileApplyUserIdRef.current = sessionUser.id;
 console.log('PROFILE apply: source=' + source + ' username=' + (chosenUsername || ''));
 }
 setUser(userData);
 await saveUserToStorage(userData);
 } catch (profileError) {
 console.warn('Profile fetch error during refresh:', profileError);
 const fallbackUsername = sessionUser.email?.split('@')[0] || '';
 const userData: User = {
 uid: sessionUser.id,
 email: sessionUser.email || '',
 username: fallbackUsername,
 };
 if (LOG_DEBUG && lastLoggedProfileApplyUserIdRef.current !== sessionUser.id) {
 lastLoggedProfileApplyUserIdRef.current = sessionUser.id;
 console.log('PROFILE apply: source=default username=' + (fallbackUsername || ''));
 }
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
 updateProfileUsername,
 updateProfileDisplayName,
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
