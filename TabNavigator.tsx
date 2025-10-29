import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ScansTab } from './tabs/ScansTab';
import { ExploreTab } from './tabs/ExploreTab';
import { MyLibraryTab } from './tabs/MyLibraryTab';

const Tab = createBottomTabNavigator();

export const TabNavigator = () => {
  return (
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
        }}
      />
    </Tab.Navigator>
  );
};

