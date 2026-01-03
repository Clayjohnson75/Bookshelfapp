const fs = require('fs');
const path = require('path');

// Load .env file manually
const envPath = path.join(__dirname, '.env');
let envVars = {};
console.log('📋 Loading .env from:', envPath);
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  console.log('📋 .env file content length:', envContent.length);
  envContent.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const match = trimmedLine.match(/^([^=:#]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        envVars[key] = value;
        console.log(`📋 Loaded env var: ${key} (length: ${value.length})`);
      }
    }
  });
  console.log('📋 Total env vars loaded:', Object.keys(envVars).length);
} else {
  console.error('❌ .env file not found at:', envPath);
}

// Also try dotenv as fallback
try {
  require('dotenv').config();
} catch (e) {
  // dotenv might fail, that's OK
}

module.exports = {
  expo: {
    name: "Bookshelf Scanner",
    slug: "bookshelf-scanner",
    version: "1.06",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff"
    },
    assetBundlePatterns: [
      "**/*"
    ],
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.clayjohnson75.bookshelf-scanner",
      buildNumber: "25",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription: "Bookshelf Scanner uses your camera to capture photos of bookshelves. The app uses AI to automatically detect book titles and authors from the spines visible in your photos, allowing you to build and manage your digital book library. For example, when you take a photo of your bookshelf, the app identifies books like 'The Great Gatsby by F. Scott Fitzgerald' from their spines.",
        NSPhotoLibraryUsageDescription: "Bookshelf Scanner accesses your photo library to allow you to select existing photos of bookshelves. The app uses AI to automatically detect book titles and authors from the spines visible in your photos, which are then added to your digital book library. For example, you can choose a photo you previously took of your bookshelf, and the app will identify and catalog all visible books.",
        NSFaceIDUsageDescription: "Bookshelf Scanner uses Face ID to quickly and securely sign you into your account."
      }
    },
    scheme: "bookshelfscanner",
    android: {
      package: "com.clayjohnson75.bookshelfscanner",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff"
      }
    },
    web: {
      favicon: "./assets/favicon.png"
    },
    plugins: [
      [
        "expo-camera",
        {
          cameraPermission: "Bookshelf Scanner uses your camera to capture photos of bookshelves. The app uses AI to automatically detect book titles and authors from the spines visible in your photos, allowing you to build and manage your digital book library. For example, when you take a photo of your bookshelf, the app identifies books like 'The Great Gatsby by F. Scott Fitzgerald' from their spines."
        }
      ],
      [
        "expo-image-picker",
        {
          photosPermission: "Bookshelf Scanner accesses your photo library to allow you to select existing photos of bookshelves. The app uses AI to automatically detect book titles and authors from the spines visible in your photos, which are then added to your digital book library. For example, you can choose a photo you previously took of your bookshelf, and the app will identify and catalog all visible books."
        }
      ]
    ],
    extra: {
      eas: {
        projectId: "b558ee2d-5af2-481c-82af-669e79311aab"
      },
      // Environment Configuration:
      // - Development (Expo Go/local): Use _DEV values from .env file
      // - Production (EAS builds): Use values from EAS secrets or fallback to hardcoded production values
      // Priority based on EAS_ENV:
      //   - If EAS_ENV is NOT "production": Use _DEV values (for local dev/Expo Go)
      //   - If EAS_ENV is "production": Use production values (from EAS secrets or fallback)
      //   - If EAS_ENV not set (Expo Go): Use _DEV values
      EXPO_PUBLIC_SUPABASE_URL: (process.env.EAS_ENV !== 'production' && (envVars.EXPO_PUBLIC_SUPABASE_URL_DEV || process.env.EXPO_PUBLIC_SUPABASE_URL_DEV)) ||
                                 envVars.EXPO_PUBLIC_SUPABASE_URL || 
                                 process.env.EXPO_PUBLIC_SUPABASE_URL || 
                                 'https://cnlnrlzhhbrtehpkttqv.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: (process.env.EAS_ENV !== 'production' && (envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV)) ||
                                      envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY || 
                                      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 
                                      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubG5ybHpoaGJydGVocGt0dHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NTI1MjEsImV4cCI6MjA3NzQyODUyMX0.G-XYS-ASfPAhx83ZdbdL87lp8Zy3RWz4A8QXKSJ_wh0',
      EXPO_PUBLIC_API_BASE_URL: (process.env.EAS_ENV !== 'production' && (envVars.EXPO_PUBLIC_API_BASE_URL_DEV || process.env.EXPO_PUBLIC_API_BASE_URL_DEV)) ||
                                 envVars.EXPO_PUBLIC_API_BASE_URL || 
                                 process.env.EXPO_PUBLIC_API_BASE_URL || 
                                 'https://bookshelfapp-five.vercel.app',
      // NOTE: API keys (OpenAI, Gemini) are now server-side only for security
      // They must be set as environment variables on Vercel (not in client code)
    }
  }
};

// Debug: log what we're exporting
console.log('📋 app.config.js final extra:', JSON.stringify(module.exports.expo.extra, null, 2));

