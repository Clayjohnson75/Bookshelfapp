import React from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ScansTab } from './tabs/ScansTab';
import { ExploreTab } from './tabs/ExploreTab';
import { MyLibraryTab } from './tabs/MyLibraryTab';
import { ScanningNotification } from './components/ScanningNotification';

const Tab = createBottomTabNavigator();

export const TabNavigator = () => {
  return (
    <View style={styles.container}>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: '#2c3e50',
          tabBarInactiveTintColor: '#bdc3c7',
          headerShown: false,
        }}
      >
        <Tab.Screen 
          name="Scans" 
          component={ScansTab}
          options={{
            tabBarLabel: 'Scans',
          }}
        />
        <Tab.Screen 
          name="Explore" 
          component={ExploreTab}
          options={{
            tabBarLabel: 'Explore',
          }}
        />
        <Tab.Screen 
          name="MyLibrary" 
          component={MyLibraryTab}
          options={{
            tabBarLabel: 'My Library',
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
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

