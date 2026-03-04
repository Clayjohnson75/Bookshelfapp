/**
 * Read env vars from Expo config, manifest, or process.env.
 * Expo types don't include 'extra' on EmbeddedManifest, so we cast.
 */
import Constants from 'expo-constants';

const PRODUCTION_API_URL = 'https://www.bookshelfscan.app';

type ManifestWithExtra = { extra?: Record<string, unknown> };

/** Returns true if url looks like a dev/local/wrong URL (localhost, LAN, old Vercel, etc.) */
function isDevApiUrl(url: string): boolean {
 if (!url || typeof url !== 'string') return true;
 const lower = url.toLowerCase().trim();
 if (lower.startsWith('http://localhost') || lower.startsWith('https://localhost')) return true;
 if (lower.startsWith('http://127.0.0.1') || lower.startsWith('https://127.0.0.1')) return true;
 if (lower.includes('10.0.') || lower.includes('192.168.')) return true;
 if (lower.includes('ngrok') || lower.includes('.local')) return true;
 if (lower.includes(':3000') || lower.includes(':8080')) return true;
 // Any .vercel.app URL use canonical www.bookshelfscan.app so client and worker hit same backend
 if (lower.includes('.vercel.app')) return true;
 return false;
}

export function getEnvVar(key: string): string {
 const expo = Constants.expoConfig as ManifestWithExtra | undefined;
 const manifest = Constants.manifest as ManifestWithExtra | undefined;
 const fromExtra = expo?.extra?.[key] ?? manifest?.extra?.[key];
 if (typeof fromExtra === 'string') return fromExtra;
 const fromProcess = process.env[key];
 return typeof fromProcess === 'string' ? fromProcess : '';
}

let apiBaseUrlLogged = false;
let envConfigLogged = false;

/**
 * Log once: API_BASE_URL, SUPABASE_URL ref (hostname only), build channel. Use to confirm no dev/prod mixing.
 */
export function logEnvConfigOnce(): void {
 if (envConfigLogged) return;
 envConfigLogged = true;
 const apiBaseUrl = getApiBaseUrl();
 const supabaseUrl = getEnvVar('EXPO_PUBLIC_SUPABASE_URL') || getEnvVar('SUPABASE_URL') || '';
 let supabaseRef = '(not set)';
 try {
 if (supabaseUrl && supabaseUrl.startsWith('http')) supabaseRef = new URL(supabaseUrl).hostname;
 } catch (_) { /* ignore */ }
 const channel = __DEV__ ? 'dev' : 'prod';
 // Gate behind LOG_DEBUG useful for confirming env once, but spammy in shared logs.
 const logDebug = getEnvVar('EXPO_PUBLIC_LOG_DEBUG') === 'true' || getEnvVar('EXPO_PUBLIC_LOG_DEBUG') === '1';
 if (logDebug) {
 console.log('[ENV_CONFIG]', {
 API_BASE_URL: apiBaseUrl,
 SUPABASE_REF: supabaseRef,
 channel,
 });
 }
}

/**
 * API base URL for scan and other server calls. Always returns a valid production URL.
 * If the configured URL is missing or a dev URL (localhost, LAN, .vercel.app, etc.), returns PRODUCTION_API_URL.
 * This fixes App Store builds that were built with a dev API URL and ensures one canonical backend (www.bookshelfscan.app).
 */
export function getApiBaseUrl(): string {
 const raw = getEnvVar('EXPO_PUBLIC_API_BASE_URL');
 let apiBaseUrl: string;
 if (!raw || isDevApiUrl(raw)) {
 apiBaseUrl = PRODUCTION_API_URL;
 } else {
 let url = raw.trim();
 if (!url.startsWith('http')) url = `https://${url}`;
 if (url.includes('bookshelfscan.app') && !url.includes('www.')) {
 url = url.replace('bookshelfscan.app', 'www.bookshelfscan.app');
 }
 apiBaseUrl = url;
 }
 if (!apiBaseUrlLogged) {
 apiBaseUrlLogged = true;
 logEnvConfigOnce();
 }
 return apiBaseUrl;
}
