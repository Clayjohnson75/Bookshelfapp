import React, { useState, useEffect } from 'react';
import { Platform, View, ActivityIndicator, StyleSheet } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { AuthProvider, useAuth } from './auth/SimpleAuthContext';
import { ScanningProvider } from './contexts/ScanningContext';
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

const AppContent: React.FC = () => {
  const { user, loading } = useAuth();
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
        // Supabase automatically handles email confirmation when the deep link opens
        // The session token is in the URL hash, which Supabase client processes automatically
        // The auth context will detect the session change and update the user state
        setTimeout(() => {
          setConfirmingEmail(false);
        }, 2000); // Give Supabase time to process the session
      }
    };

    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink({ url });
    });

    const subscription = Linking.addEventListener('url', handleDeepLink);
    return () => subscription.remove();
  }, []);

  if (loading || confirmingEmail) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2c3e50" />
      </View>
    );
  }

  // Show password reset screen if deep link was opened
  if (resetToken) {
    return <PasswordResetScreen onAuthSuccess={() => setResetToken(null)} accessToken={resetToken} />;
  }

  if (!user) {
    return <LoginScreen onAuthSuccess={() => {}} />;
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
      <AuthProvider>
        <ScanningProvider>
          <AppContent />
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

