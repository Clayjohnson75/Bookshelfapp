import React, { useState, useEffect } from 'react';
import { Platform, View, ActivityIndicator, StyleSheet, StatusBar } from 'react-native';
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
  const { user, loading, refreshAuthState } = useAuth();
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
        
        // If email was just confirmed (from web redirect), the email is now confirmed in Supabase
        // The user can now sign in - we just need to clear the loading state quickly
        // No need to wait for auth state refresh since there's no active session yet
        if (parsedUrl.queryParams?.confirmed === 'true') {
          // Brief loading state, then allow sign-in
          setTimeout(() => {
            setConfirmingEmail(false);
          }, 1000); // Reduced from 2000ms - just enough to show feedback
        } else if (parsedUrl.queryParams?.token) {
          // Handle token-based confirmation (if token is in URL)
          // Supabase automatically handles email confirmation when the deep link opens
          // The auth context will detect the session change and update the user state
          setTimeout(() => {
            if (refreshAuthState) {
              refreshAuthState();
            }
            setConfirmingEmail(false);
          }, 2000);
        } else {
          // Just a brief loading state for any confirm-email deep link
          setTimeout(() => {
            setConfirmingEmail(false);
          }, 1000);
        }
      }
    };

    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink({ url });
    });

    const subscription = Linking.addEventListener('url', handleDeepLink);
    return () => subscription.remove();
  }, [refreshAuthState]);

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
      <StatusBar 
        barStyle="light-content" 
        backgroundColor="#2d3748"
        translucent={false}
      />
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

