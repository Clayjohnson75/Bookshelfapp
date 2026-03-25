/**
 * Single source of truth for profile stats (book count) in the app.
 *
 * Profile stats MUST use approvedBooks only (pending must not affect counts).
 *   profileBookCount = approvedBooks.length (from approved list only).
 *   displayPhotoCount = distinct source_photo_id among approved books (approvedCountsByPhotoId size).
 * Do NOT use: "all books" length, pending counts, or photo.books (which may include pending).
 *
 * Source: persisted merged approved list (AsyncStorage approved_books_${uid}). Same list ScansTab
 * writes after loadUserData/approve. Call refreshProfileStats() after any write to that key.
 *
 * libraryHydrated: true only after books server fetch + photos server fetch + merge applied.
 * Until then show last known count (or "—") and do not render profile collage from pending/local staging.
 *
 * Rehydrate gate: startRehydrate() → libraryHydrated=false; completeRehydrate(count) → libraryHydrated=true.
 * Unknown vs zero: null = "—"; 0 = "0".
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth, GUEST_USER_ID } from '../auth/SimpleAuthContext';
import { getBookSourcePhotoId } from '../lib/bookKey';
import { getApprovedUniqueCount } from '../lib/approvedCount';

interface ProfileStatsContextType {
 /** Library book count = approved list length only (single source of truth). null until loaded or if guest. */
 canonicalBookCount: number | null;
 /** Last stable count (end of previous merge); shown while !libraryHydrated or mergeInProgress. */
 lastStableBookCount: number | null;
 /** Last stable photo count; shown while !libraryHydrated or mergeInProgress. */
 lastStablePhotoCount: number | null;
 /** True only after books fetch + photos fetch + merge applied. Gate collage and "—" until then. */
 libraryHydrated: boolean;
 /** True while rehydrate/merge is in progress. */
 mergeInProgress: boolean;
 /** True while refreshProfileStats is in flight. */
 statsRefreshing: boolean;
 /** Count to show in UI: last known while merging/refreshing, else canonical. null = "—". */
 displayBookCount: number | null;
 /** Photos count to show (distinct source_photo_id among approved books only). null = "—". */
 displayPhotoCount: number | null;
 /** Re-read count from persisted merged approved list. Call after approving, syncing, or load merge.
  * Pass approvedBooks directly to skip AsyncStorage read (instant update after approval). */
 refreshProfileStats: (approvedBooks?: any[]) => Promise<void>;
 /** Call when rehydrate starts; sets libraryHydrated=false. */
 startRehydrate: () => void;
 /** Call when merge applied (books + photos fetch done, merge applied); sets libraryHydrated=true. */
 completeRehydrate: (count: number) => void;
 /** Call on error/early exit so the gate is not left stuck. */
 endRehydrate: () => void;
 /** Timestamp (ms) of last approve action. Used so Profile doesn't overwrite optimistic approved with stale server 0. */
 lastApprovedAt: number;
 /** Call when user approves books so Profile can honor grace window. */
 setLastApprovedAt: (t: number) => void;
}

const ProfileStatsContext = createContext<ProfileStatsContextType | undefined>(undefined);

const approvedKey = (uid: string) => `approved_books_${uid}`;

export function ProfileStatsProvider({ children }: { children: React.ReactNode }) {
 const { user } = useAuth();
 const [canonicalBookCount, setCanonicalBookCount] = useState<number | null>(null);
 const [lastStableBookCount, setLastStableBookCount] = useState<number | null>(null);
 const [photoCount, setPhotoCount] = useState<number | null>(null);
 const [lastStablePhotoCount, setLastStablePhotoCount] = useState<number | null>(null);
 const [libraryHydrated, setLibraryHydrated] = useState(false);
 const [mergeInProgress, setMergeInProgress] = useState(false);
 const [statsRefreshing, setStatsRefreshing] = useState(false);
 const [lastApprovedAt, setLastApprovedAt] = useState(0);
 const mergeInProgressRef = useRef(false);
 mergeInProgressRef.current = mergeInProgress;

 const refreshProfileStats = useCallback(async (directApprovedBooks?: any[]) => {
 if (!user || user.uid === GUEST_USER_ID || (user as { isGuest?: boolean }).isGuest) {
 setCanonicalBookCount(null);
 setPhotoCount(null);
 setLibraryHydrated(false);
 setLastStableBookCount(null);
 setLastStablePhotoCount(null);
 return;
 }
 setStatsRefreshing(true);
 try {
 // When called with directApprovedBooks, skip AsyncStorage read for instant stats update.
 // This avoids the race where AsyncStorage hasn't been written yet after approval.
 let arr: any[];
 if (directApprovedBooks) {
 arr = directApprovedBooks;
 } else {
 const raw = await AsyncStorage.getItem(approvedKey(user.uid));
 const list = raw ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : [];
 arr = Array.isArray(list) ? list : [];
 }
 const activeArr = arr.filter((b: { status?: string; deleted_at?: string | null }) => {
 if (b?.status !== 'approved') return false;
 if (b?.deleted_at != null) return false;
 return true;
 });
 const profileBookCount = getApprovedUniqueCount(activeArr);

 // When called with direct data (e.g. after clear or approve), always update immediately
 // regardless of merge state. This prevents stale counts from persisting after clear.
 const forceUpdate = !!directApprovedBooks;
 if (forceUpdate || !mergeInProgressRef.current) {
 setCanonicalBookCount(profileBookCount);
 setLastStableBookCount(profileBookCount);
 }

 const countsByPhotoId = new Map<string, number>();
 activeArr.forEach((b: { source_photo_id?: string | null; sourcePhotoId?: string | null; photoId?: string | null }) => {
 const key = getBookSourcePhotoId(b);
 if (key) countsByPhotoId.set(key, (countsByPhotoId.get(key) ?? 0) + 1);
 });
 if (forceUpdate || !mergeInProgressRef.current) {
 setPhotoCount(countsByPhotoId.size);
 setLastStablePhotoCount(countsByPhotoId.size);
 } else {
 setPhotoCount(countsByPhotoId.size);
 setLastStablePhotoCount(countsByPhotoId.size);
 }
 } catch {
 if (!mergeInProgressRef.current) {
 setCanonicalBookCount(null);
 }
 setPhotoCount(null);
 } finally {
 setStatsRefreshing(false);
 }
 }, [user]);

 const startRehydrate = useCallback(() => {
 setMergeInProgress(true);
 setLibraryHydrated(false);
 }, []);

 const completeRehydrate = useCallback((count: number) => {
 setLastStableBookCount(count);
 setCanonicalBookCount(count);
 setMergeInProgress(false);
 setLibraryHydrated(true);
 }, []);

 const endRehydrate = useCallback(() => {
 setMergeInProgress(false);
 }, []);

 const displayBookCount = useMemo(() => {
 if (mergeInProgress || statsRefreshing) return lastStableBookCount ?? canonicalBookCount ?? null;
 return canonicalBookCount ?? null;
 }, [mergeInProgress, statsRefreshing, lastStableBookCount, canonicalBookCount]);

 const displayPhotoCount = useMemo(() => {
 if (mergeInProgress || statsRefreshing) return lastStablePhotoCount ?? photoCount ?? null;
 return photoCount ?? null;
 }, [mergeInProgress, statsRefreshing, lastStablePhotoCount, photoCount]);

 // Load counts immediately on mount (and when user changes) so profile never shows "—".
 // Also persist last known counts so they're available instantly on next app open.
 useEffect(() => {
 if (!user || user.uid === GUEST_USER_ID) return;
 // Read counts from approved_books list. This is async so counts start as null
 // (displayed as empty string) until the read completes (~50ms).
 refreshProfileStats();
 }, [refreshProfileStats]);

 const value = useMemo(
 () => ({
 canonicalBookCount,
 lastStableBookCount,
 lastStablePhotoCount,
 libraryHydrated,
 mergeInProgress,
 statsRefreshing,
 displayBookCount,
 displayPhotoCount,
 refreshProfileStats,
 startRehydrate,
 completeRehydrate,
 endRehydrate,
 lastApprovedAt,
 setLastApprovedAt,
 }),
 [canonicalBookCount, lastStableBookCount, lastStablePhotoCount, libraryHydrated, mergeInProgress, statsRefreshing, displayBookCount, displayPhotoCount, refreshProfileStats, startRehydrate, completeRehydrate, endRehydrate, lastApprovedAt]
 );

 return (
 <ProfileStatsContext.Provider value={value}>
 {children}
 </ProfileStatsContext.Provider>
 );
}

export function useProfileStats(): ProfileStatsContextType {
 const ctx = useContext(ProfileStatsContext);
 if (ctx === undefined) {
 throw new Error('useProfileStats must be used within ProfileStatsProvider');
 }
 return ctx;
}

/** Format count for UI: null/undefined = "" (hidden while loading); number = string. */
export function formatCountForDisplay(count: number | null | undefined): string {
 return count == null ? '' : String(count);
}
