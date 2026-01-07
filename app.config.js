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
    version: "1.0.6",
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
      buildNumber: "27",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription: "Bookshelf Scanner needs access to your camera to take photos of your bookshelf. When you take a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you photograph a bookshelf containing 'The Great Gatsby' by F. Scott Fitzgerald, the app will detect and catalog this book automatically.",
        NSPhotoLibraryUsageDescription: "Bookshelf Scanner needs access to your photo library to select existing photos of bookshelves. When you choose a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you select a photo of your bookshelf, the app will scan it and add all detected books like 'To Kill a Mockingbird' by Harper Lee to your digital library."
      }
    },
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
    extra: {
      eas: {
        projectId: "b558ee2d-5af2-481c-82af-669e79311aab"
      },
      EXPO_PUBLIC_SUPABASE_URL: envVars.EXPO_PUBLIC_SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://cnlnrlzhhbrtehpkttqv.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubG5ybHpoaGJydGVocGt0dHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NTI1MjEsImV4cCI6MjA3NzQyODUyMX0.G-XYS-ASfPAhx83ZdbdL87lp8Zy3RWz4A8QXKSJ_wh0',
      EXPO_PUBLIC_API_BASE_URL: envVars.EXPO_PUBLIC_API_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || 'https://bookshelfapp-five.vercel.app',
      // SECURITY: OpenAI and Gemini API keys are server-side only (in Vercel env vars)
      // They should NEVER be exposed to the client with EXPO_PUBLIC_ prefix
    }
  }
};

// Debug: log what we're exporting
console.log('📋 app.config.js final extra:', JSON.stringify(module.exports.expo.extra, null, 2));

