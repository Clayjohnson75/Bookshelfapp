import React from 'react';
import { Platform } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from './auth/SimpleAuthContext';
import { ScanningProvider } from './contexts/ScanningContext';
import { LoginScreen } from './auth/AuthScreens';
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

  if (loading) {
    return null; // Or a loading spinner
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

