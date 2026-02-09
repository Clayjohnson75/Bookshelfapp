import React from 'react';
import { View, StyleSheet, Image, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ScansTab } from './tabs/ScansTab';
import { ExploreTab } from './tabs/ExploreTab';
import { MyLibraryTab } from './tabs/MyLibraryTab';
import { ScanningNotification } from './components/ScanningNotification';
import { useCamera } from './contexts/CameraContext';
import { SUPABASE_REF } from './lib/supabase';

const Tab = createBottomTabNavigator();

export const TabNavigator = () => {
  const { isCameraActive } = useCamera();
  
  return (
    <GestureHandlerRootView style={styles.container}>
      {__DEV__ && (
        <View style={styles.devBadge} pointerEvents="none">
          <Text style={styles.devBadgeText}>DEV DB: {SUPABASE_REF || '—'}</Text>
        </View>
      )}
      <Tab.Navigator
        id={undefined}
        initialRouteName="Scans" // Always start on Scans tab (especially for guests)
        screenOptions={{
          tabBarActiveTintColor: '#2c3e50',
          tabBarInactiveTintColor: '#bdc3c7',
          headerShown: false,
          tabBarStyle: isCameraActive ? {
            display: 'none',
            height: 0,
            opacity: 0,
          } : {
            backgroundColor: '#ffffff',
            borderTopWidth: 0.5,
            borderTopColor: '#e2e8f0',
            elevation: 8,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -2 },
            shadowOpacity: 0.1,
            shadowRadius: 8,
          },
        }}
      >
        <Tab.Screen 
          name="Scans" 
          component={ScansTab}
          options={{
            tabBarLabel: 'Scans',
            headerShown: false,
          }}
        />
        <Tab.Screen 
          name="Explore" 
          component={ExploreTab}
          options={{
            tabBarLabel: 'Explore',
            headerShown: false,
          }}
        />
        <Tab.Screen 
          name="MyLibrary" 
          component={MyLibraryTab}
          options={{
            tabBarLabel: 'My Library',
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Image
                source={require('./assets/logo/logo.png')}
                style={{ width: size + 2, height: size + 2 }}
                resizeMode="contain"
              />
            ),
          }}
        />
      </Tab.Navigator>
      <ScanningNotification />
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  devBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  devBadgeText: {
    color: '#7fdbff',
    fontSize: 11,
    fontWeight: '600',
  },
});

