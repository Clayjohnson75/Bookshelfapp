import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

// Try all possible sources: process.env, Constants.expoConfig.extra, Constants.manifest.extra
// TEMPORARY: Hardcoded values until config loading is fixed
const SUPABASE_URL = 
  process.env.EXPO_PUBLIC_SUPABASE_URL || 
  Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_URL || 
  Constants.manifest?.extra?.EXPO_PUBLIC_SUPABASE_URL || 
  'https://cnlnrlzhhbrtehpkttqv.supabase.co'; // TEMP hardcoded
const SUPABASE_ANON = 
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 
  Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY || 
  Constants.manifest?.extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubG5ybHpoaGJydGVocGt0dHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NTI1MjEsImV4cCI6MjA3NzQyODUyMX0.G-XYS-ASfPAhx83ZdbdL87lp8Zy3RWz4A8QXKSJ_wh0'; // TEMP hardcoded

// Error logging only if config is missing
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error('❌ Missing Supabase environment variables. Please add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.');
}

const storage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

// Only create client if we have the required env vars
export const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        storage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null as any; // Will be handled by auth code checking for null
