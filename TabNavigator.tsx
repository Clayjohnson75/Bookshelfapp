import React from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ScansTab } from './tabs/ScansTab';
import { ExploreTab } from './tabs/ExploreTab';
import { MyLibraryTab } from './tabs/MyLibraryTab';
import { ScanningNotification } from './components/ScanningNotification';

const Tab = createBottomTabNavigator();

export const TabNavigator = () => {
  return (
    <GestureHandlerRootView style={styles.container}>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: '#2c3e50',
          tabBarInactiveTintColor: '#bdc3c7',
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#ffffff', // Explicit solid background to prevent glass effects
            borderTopWidth: 0.5,
            borderTopColor: '#e2e8f0',
            elevation: 8, // Android shadow
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -2 },
            shadowOpacity: 0.1,
            shadowRadius: 8,
            height: 49, // Explicit height for iOS
            paddingBottom: 0,
            paddingTop: 0,
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
});

