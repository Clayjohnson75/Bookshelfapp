const fs = require('fs');
const path = require('path');

// Load .env then .env.local (local overrides). Required for device testing (ngrok URL in .env.local).
function loadEnvFile(filePath) {
 if (!fs.existsSync(filePath)) return;
 const envContent = fs.readFileSync(filePath, 'utf8');
 envContent.split('\n').forEach(line => {
 const trimmedLine = line.trim();
 if (trimmedLine && !trimmedLine.startsWith('#')) {
 const match = trimmedLine.match(/^([^=:#]+)=(.*)$/);
 if (match) {
 const key = match[1].trim();
 let value = match[2].trim();
 if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
 value = value.slice(1, -1);
 }
 envVars[key] = value;
 }
 }
 });
}
const envPath = path.join(__dirname, '.env');
const envLocalPath = path.join(__dirname, '.env.local');
let envVars = {};
console.log(' Loading .env from:', envPath);
loadEnvFile(envPath);
if (fs.existsSync(envLocalPath)) {
 console.log(' Loading .env.local (overrides) from:', envLocalPath);
 loadEnvFile(envLocalPath);
}
console.log(' Total env vars loaded:', Object.keys(envVars).length);

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
 version: "1.1.1",
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
    buildNumber: "3",
 infoPlist: {
 ITSAppUsesNonExemptEncryption: false,
 NSCameraUsageDescription: "Bookshelf Scanner needs access to your camera to take photos of your bookshelf. When you take a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you photograph a bookshelf containing 'The Great Gatsby' by F. Scott Fitzgerald, the app will detect and catalog this book automatically.",
 NSPhotoLibraryUsageDescription: "Bookshelf Scanner needs access to your photo library to select existing photos of bookshelves. When you choose a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you select a photo of your bookshelf, the app will scan it and add all detected books like 'To Kill a Mockingbird' by Harper Lee to your digital library."
 }
 },
 android: {
 package: "com.clayjohnson75.bookshelfscanner",
      versionCode: 3,
 adaptiveIcon: {
 foregroundImage: "./assets/adaptive-icon.png",
 backgroundColor: "#ffffff"
 }
 },
 web: {
 favicon: "./assets/favicon.png"
 },
 extra: (function () {
 // Expo dev (npx expo start) / EAS development dev Supabase + dev API. TestFlight / App Store prod Supabase + prod API.
 const isDev = process.env.EAS_ENV === 'development' ||
 process.env.EAS_BUILD_PROFILE === 'development' ||
 process.env.APP_ENV === 'development' ||
 process.env.NODE_ENV === 'development';

 // Dev build dev API (ngrok/LAN) or prod API (Option A). Terminal export wins over .env so "export EXPO_PUBLIC_API_BASE_URL=..." works.
 const EXPO_PUBLIC_API_BASE_URL = isDev
 ? (process.env.EXPO_PUBLIC_API_BASE_URL_DEV || process.env.EXPO_PUBLIC_API_BASE_URL || envVars.EXPO_PUBLIC_API_BASE_URL_DEV || envVars.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000')
 : (process.env.EXPO_PUBLIC_API_BASE_URL || envVars.EXPO_PUBLIC_API_BASE_URL || 'https://www.bookshelfscan.app');

 // When dev build points at deployed API (Vercel/prod URL), use prod Supabase so JWT matches API and scans work.
 const devApiIsDeployed = /bookshelfscan\.app|\.vercel\.app/i.test(EXPO_PUBLIC_API_BASE_URL || '');
 const supabaseUrl = isDev
 ? (devApiIsDeployed ? (envVars.EXPO_PUBLIC_SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://cnlnrlzhhbrtehpkttqv.supabase.co') : (envVars.EXPO_PUBLIC_SUPABASE_URL_DEV || process.env.EXPO_PUBLIC_SUPABASE_URL_DEV || ''))
 : (envVars.EXPO_PUBLIC_SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://cnlnrlzhhbrtehpkttqv.supabase.co');
 const supabaseAnonKey = isDev
 ? (devApiIsDeployed ? (envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '') : (envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV || ''))
 : (envVars.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubG5ybHpoaGJydGVocGt0dHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NTI1MjEsImV4cCI6MjA3NzQyODUyMX0.G-XYS-ASfPAhx83ZdbdL87lp8Zy3RWz4A8QXKSJ_wh0');

 console.log(' Supabase env:', isDev ? 'development' : 'production', ' ref', supabaseUrl ? supabaseUrl.replace(/^https?:\/\//, '').split('.')[0] : '(none)');
 console.log(' API base URL:', isDev ? 'development' : 'production', '', EXPO_PUBLIC_API_BASE_URL);

 const extra = {
   eas: {
     projectId: "b558ee2d-5af2-481c-82af-669e79311aab"
   },
   supabaseUrl,
   supabaseAnonKey,
   EXPO_PUBLIC_API_BASE_URL,
 };

 // --- expo.extra allowlist: only these keys may be shipped to the client bundle ---
 const ALLOWED_EXTRA_KEYS = ['supabaseUrl', 'supabaseAnonKey', 'EXPO_PUBLIC_API_BASE_URL', 'eas'];
 const FORBIDDEN_EXTRA_KEYS = [
   'GOOGLE_BOOKS_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
   'OPENAI_API_KEY', 'GEMINI_API_KEY', 'APPLE_SHARED_SECRET', 'QSTASH_', 'UPSTASH_REDIS_REST_TOKEN'
 ];
 for (const key of Object.keys(extra)) {
   if (FORBIDDEN_EXTRA_KEYS.some((f) => key === f || key.startsWith(f))) {
     throw new Error(`expo.extra must never include secret "${key}". Remove it from app.config.js.`);
   }
   if (!ALLOWED_EXTRA_KEYS.includes(key)) {
     throw new Error(
       `expo.extra allows only: ${ALLOWED_EXTRA_KEYS.join(', ')}. Got disallowed key "${key}". ` +
       'Add to ALLOWED_EXTRA_KEYS only if the value is safe for the client bundle.'
     );
   }
 }

 return extra;
 })(),
 }
};

// Debug: log what we're exporting
console.log(' app.config.js final extra:', JSON.stringify(module.exports.expo.extra, null, 2));

