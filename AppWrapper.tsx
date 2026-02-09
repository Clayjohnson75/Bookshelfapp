import React, { useState, useEffect } from 'react';
import { Platform, View, ActivityIndicator, StyleSheet, StatusBar } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { AuthProvider, useAuth } from './auth/SimpleAuthContext';
import { ScanningProvider } from './contexts/ScanningContext';
import { CameraProvider } from './contexts/CameraContext';
import { LoginScreen, PasswordResetScreen } from './auth/AuthScreens';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from './TabNavigator';

// Disable screens for Expo Go to avoid compatibility issues
// This will fall back to JS-based navigation which works better in Expo Go
if (__DEV__) {
  try {
    enableScreens(false);
  } catch (e) {
    // Ignore if enableScreens is not available
  }
}

// Single root gate: prevents INITIAL_SESSION bounce. Do not gate "if (!session) go login" in screens — only here.
function SplashLoading() {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color="#2c3e50" />
    </View>
  );
}

const AppContent: React.FC = () => {
  const { session, authReady, loading, refreshAuthState } = useAuth();
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [confirmingEmail, setConfirmingEmail] = useState(false);

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
  if (!authReady || loading || confirmingEmail) {
    return <SplashLoading />;
  }

  if (resetToken) {
    return <PasswordResetScreen onAuthSuccess={() => setResetToken(null)} accessToken={resetToken} />;
  }

  if (__DEV__) {
    const navGuardState = { authReady, hasSession: !!session, userId: session?.user?.id ?? null };
    console.log('[NAV_GUARD]', JSON.stringify(navGuardState, null, 2));
  }
  return (
    <NavigationContainer>
      <TabNavigator />
    </NavigationContainer>
  );
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar 
        barStyle="light-content" 
        backgroundColor="#2d3748"
        translucent={false}
      />
      <AuthProvider>
        <ScanningProvider>
          <CameraProvider>
            <AppContent />
          </CameraProvider>
        </ScanningProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f6f0',
  },
});

