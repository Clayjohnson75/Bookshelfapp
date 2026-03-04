import React, { useState, useEffect, useRef } from 'react';
import { AppState, Platform, View, ActivityIndicator, StyleSheet, StatusBar } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { AuthProvider, useAuth } from './auth/SimpleAuthContext';
import { ProfileStatsProvider } from './contexts/ProfileStatsContext';
import { ScanningProvider } from './contexts/ScanningContext';
import { CameraProvider } from './contexts/CameraContext';
import { CoverUpdateProvider } from './contexts/CoverUpdateContext';
import { SignedPhotoUrlProvider } from './contexts/SignedPhotoUrlContext';
import { PhotoSignedUrlPersistRefProvider } from './contexts/PhotoSignedUrlPersistContext';
import { BottomDockProvider } from './contexts/BottomDockContext';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import { LoginScreen, PasswordResetScreen } from './auth/AuthScreens';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { TabNavigator } from './TabNavigator';
import { LOG_DEBUG } from './lib/logFlags';
import { setTelemetryContext } from './lib/clientTelemetry';
import { logNetworkSecurityBaseline, flushSecurityBreadcrumbs } from './lib/securityBaseline';
import { runStorageAudit } from './lib/localStorageAudit';
import { logger } from './utils/logger';
import { startUploadQueueWorker, stopUploadQueueWorker } from './lib/photoUploadQueue';
import { startApproveQueueWorker, stopApproveQueueWorker } from './lib/approveQueue';

// Disable screens for Expo Go to avoid compatibility issues
// This will fall back to JS-based navigation which works better in Expo Go
if (__DEV__) {
 try {
 enableScreens(false);
 } catch (e) {
 // Ignore if enableScreens is not available
 }
}

// Single root gate: prevents INITIAL_SESSION bounce. Do not gate "if (!session) go login" in screens only here.
function SplashLoading() {
 const { t } = useTheme();
 return (
 <View style={[styles.loadingContainer, { backgroundColor: t.colors.bg }]}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 </View>
 );
}

const AppContent: React.FC = () => {
 const { session, authReady, loading, refreshAuthState } = useAuth();
 const { t } = useTheme();
 const [resetToken, setResetToken] = useState<string | null>(null);
 const [confirmingEmail, setConfirmingEmail] = useState(false);
 const lastNavGuardRef = useRef<{ authReady: boolean; hasSession: boolean; userId: string | null } | null>(null);

 const navTheme = React.useMemo(() => ({
 ...DefaultTheme,
 dark: t.name === 'scriptoriumDark',
 colors: {
 ...DefaultTheme.colors,
 // Global nav/action tint source (prevents default iOS blue fallbacks).
 primary: t.colors.accent ?? t.colors.primary,
 background: t.colors.bg,
 card: t.colors.surface,
 text: t.colors.text,
 border: t.colors.border,
 notification: t.colors.accent ?? t.colors.primary,
 },
 }), [t.name, t.colors.accent, t.colors.primary, t.colors.bg, t.colors.surface, t.colors.text, t.colors.border]);

 const userId = session?.user?.id ?? null;
 const sessionId = session?.access_token ?? session?.refresh_token ?? null;
 const previousUserIdRef = React.useRef<string | null>(null);
 /** Worker started for this user — avoid stop/restart on effect re-run (e.g. Strict Mode, focus). Only stop on sign-out or user switch. */
 const workerStartedForUserIdRef = React.useRef<string | null>(null);

 useEffect(() => {
   setTelemetryContext({ userId: userId ?? undefined, sessionId: sessionId ?? undefined });
 }, [userId, sessionId]);

 // Durable upload + approve queue workers: start once per signed-in user; do NOT stop/restart on navigation or effect re-run. Only stop on sign-out / user switch.
 useEffect(() => {
   const prev = previousUserIdRef.current;
   const alreadyStartedFor = workerStartedForUserIdRef.current;

   if (userId) {
     if (prev && prev !== userId) {
       import('./lib/photoUploadQueue').then(({ clearQueueForUser }) => {
         clearQueueForUser(prev).catch(() => {});
       });
     }
     if (alreadyStartedFor === userId) {
       return;
     }
     if (alreadyStartedFor != null) {
       stopUploadQueueWorker();
       stopApproveQueueWorker();
       workerStartedForUserIdRef.current = null;
     }
     startUploadQueueWorker(() => userId);
     startApproveQueueWorker(() => userId);
     previousUserIdRef.current = userId;
     workerStartedForUserIdRef.current = userId;
   } else {
     if (prev) {
       import('./lib/photoUploadQueue').then(({ clearQueueForUser }) => {
         clearQueueForUser(prev).catch(() => {});
       });
       previousUserIdRef.current = null;
     }
     if (workerStartedForUserIdRef.current != null) {
       stopUploadQueueWorker();
       stopApproveQueueWorker();
       workerStartedForUserIdRef.current = null;
     }
   }
 }, [userId]);

 // Log network security baseline once per session at app start.
 useEffect(() => {
 logNetworkSecurityBaseline();
 }, []);

 // On boot: log local storage summary so unbounded growth is visible.
 useEffect(() => {
 let cancelled = false;
 runStorageAudit()
   .then((r) => {
     if (cancelled) return;
     const scanStaging = r.scanStagingSubdir ?? { fileCount: 0, totalBytes: 0 };
     const legacyPhotos = r.photosSubdir ?? { fileCount: 0, totalBytes: 0 };
     logger.info('[LOCAL_STORAGE_SUMMARY]', {
       docsBytes: r.documentDir.totalBytes,
       cacheBytes: r.cacheDir.totalBytes,
       scanOriginalsCount: scanStaging.fileCount + legacyPhotos.fileCount,
       scanOriginalsBytes: scanStaging.totalBytes + legacyPhotos.totalBytes,
       scanStagingCount: scanStaging.fileCount,
       scanStagingBytes: scanStaging.totalBytes,
       legacyPhotosCount: legacyPhotos.fileCount,
       legacyPhotosBytes: legacyPhotos.totalBytes,
     });
   })
   .catch(() => {});
 return () => { cancelled = true; };
 }, []);

 // Flush security breadcrumbs whenever app returns to foreground so post-mortem
 // data is sent before the user takes more actions.
 useEffect(() => {
 const sub = AppState.addEventListener('change', (nextState) => {
   if (nextState === 'active') {
     flushSecurityBreadcrumbs({ userId }).catch(() => {});
   }
 });
 return () => sub.remove();
 }, [userId]);

 useEffect(() => {
 const handleDeepLink = async ({ url }: { url: string }) => {
 const parsedUrl = Linking.parse(url);
 
 // Handle password reset
 if (parsedUrl.path === 'reset-password' && parsedUrl.queryParams?.token) {
 setResetToken(parsedUrl.queryParams.token as string);
 return;
 }
 
 // Handle email confirmation
 if (parsedUrl.path === 'confirm-email') {
 setConfirmingEmail(true);
 
 if (parsedUrl.queryParams?.confirmed === 'true') {
 setTimeout(() => setConfirmingEmail(false), 1000);
 } else if (parsedUrl.queryParams?.token) {
 setTimeout(() => {
 if (refreshAuthState) refreshAuthState();
 setConfirmingEmail(false);
 }, 2000);
 } else {
 setTimeout(() => setConfirmingEmail(false), 1000);
 }
 }
 };

 Linking.getInitialURL().then((url) => {
 if (url) handleDeepLink({ url });
 });

 const subscription = Linking.addEventListener('url', handleDeepLink);
 return () => subscription.remove();
 }, [refreshAuthState]);

 // Block routing until auth ready; then always show tabs (guest allowed). Scan + Explore work unsigned; Library tab shows sign-in when you tap it.
 // Do NOT include `loading` here — sign-in attempts set loading=true which would unmount NavigationContainer and reset to Scans tab on failure.
 if (!authReady || confirmingEmail) {
 return <SplashLoading />;
 }

 if (resetToken) {
 return <PasswordResetScreen onAuthSuccess={() => setResetToken(null)} accessToken={resetToken} />;
 }

 const hasSession = !!session;
 const prev = lastNavGuardRef.current;
 const navChanged = prev === null || prev.hasSession !== hasSession || prev.userId !== userId;
 if (navChanged) lastNavGuardRef.current = { authReady, hasSession, userId };
 if (__DEV__ && LOG_DEBUG && navChanged) {
 console.log('NAV guard: hasSession=' + hasSession + ' userId=' + (userId ? userId.slice(0, 8) + '' : 'null'));
 }
 return (
 <View
 style={[
 { flex: 1 },
 Platform.OS === 'ios' ? ({ tintColor: t.colors.accent ?? t.colors.primary } as any) : null,
 ]}
 >
 <NavigationContainer theme={navTheme}>
 <TabNavigator />
 </NavigationContainer>
 </View>
 );
};

function AppWithTheme() {
 const { t } = useTheme();
 const isDark = t.name === 'scriptoriumDark';
 return (
 <>
 <StatusBar
 barStyle={isDark ? 'light-content' : 'dark-content'}
 backgroundColor={t.colors.surface}
 translucent={false}
 />
 <AuthProvider>
 <ProfileStatsProvider>
 <ScanningProvider>
 <CameraProvider>
      <CoverUpdateProvider>
        <SignedPhotoUrlProvider>
          <PhotoSignedUrlPersistRefProvider>
            <BottomDockProvider>
            <AppContent />
            </BottomDockProvider>
          </PhotoSignedUrlPersistRefProvider>
        </SignedPhotoUrlProvider>
      </CoverUpdateProvider>
 </CameraProvider>
 </ScanningProvider>
 </ProfileStatsProvider>
 </AuthProvider>
 </>
 );
}

export default function App() {
 return (
 <SafeAreaProvider>
 <ThemeProvider>
 <AppWithTheme />
 </ThemeProvider>
 </SafeAreaProvider>
 );
}

const styles = StyleSheet.create({
 loadingContainer: {
 flex: 1,
 justifyContent: 'center',
 alignItems: 'center',
 },
});

