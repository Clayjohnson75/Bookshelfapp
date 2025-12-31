/**
 * Biometric Authentication Service
 * Handles Face ID / Touch ID authentication with secure token storage
 */

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_KEY = 'biometric_enabled';
const AUTH_TOKEN_KEY = 'auth_token';
const USER_CREDENTIALS_KEY = 'user_credentials';

export interface BiometricCapabilities {
  isAvailable: boolean;
  hasHardware: boolean;
  isEnrolled: boolean;
  supportedTypes: LocalAuthentication.AuthenticationType[];
}

export interface StoredCredentials {
  email: string;
  password: string; // Encrypted in SecureStore
}

/**
 * Check if biometric authentication is available on this device
 */
export async function checkBiometricAvailability(): Promise<BiometricCapabilities> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();
  
  return {
    isAvailable: hasHardware && isEnrolled,
    hasHardware,
    isEnrolled,
    supportedTypes,
  };
}

/**
 * Get the biometric type name for display
 */
export function getBiometricTypeName(capabilities: BiometricCapabilities): string {
  if (capabilities.supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
    return 'Face ID';
  }
  if (capabilities.supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    return 'Touch ID';
  }
  return 'Biometric';
}

/**
 * Check if biometric login is enabled for the user
 */
export async function isBiometricEnabled(): Promise<boolean> {
  try {
    const enabled = await SecureStore.getItemAsync(BIOMETRIC_KEY);
    return enabled === 'true';
  } catch (error) {
    console.error('Error checking biometric status:', error);
    return false;
  }
}

/**
 * Enable or disable biometric login
 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(BIOMETRIC_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Error setting biometric status:', error);
    throw error;
  }
}

/**
 * Store user credentials securely for biometric login
 * This stores the email and an encrypted password
 */
export async function storeCredentialsForBiometric(
  email: string,
  password: string
): Promise<void> {
  try {
    const credentials: StoredCredentials = {
      email,
      password, // SecureStore encrypts this automatically
    };
    await SecureStore.setItemAsync(USER_CREDENTIALS_KEY, JSON.stringify(credentials));
  } catch (error) {
    console.error('Error storing credentials:', error);
    throw error;
  }
}

/**
 * Retrieve stored credentials (requires biometric authentication)
 */
export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    // First check if biometric is enabled
    const isEnabled = await isBiometricEnabled();
    if (!isEnabled) {
      return null;
    }

    // Check if credentials exist
    const credentialsJson = await SecureStore.getItemAsync(USER_CREDENTIALS_KEY);
    if (!credentialsJson) {
      return null;
    }

    // Authenticate with biometrics before returning credentials
    const capabilities = await checkBiometricAvailability();
    if (!capabilities.isAvailable) {
      return null;
    }

    const biometricType = getBiometricTypeName(capabilities);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: `Sign in with ${biometricType}`,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false, // Allow passcode fallback
    });

    if (result.success) {
      return JSON.parse(credentialsJson) as StoredCredentials;
    }

    return null;
  } catch (error) {
    console.error('Error retrieving credentials:', error);
    return null;
  }
}

/**
 * Clear stored credentials (e.g., on sign out or when disabling biometric)
 */
export async function clearStoredCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_CREDENTIALS_KEY);
  } catch (error) {
    console.error('Error clearing credentials:', error);
  }
}

/**
 * Store auth token securely (for session management)
 */
export async function storeAuthToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  } catch (error) {
    console.error('Error storing auth token:', error);
    throw error;
  }
}

/**
 * Get stored auth token
 */
export async function getAuthToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  } catch (error) {
    console.error('Error getting auth token:', error);
    return null;
  }
}

/**
 * Clear auth token
 */
export async function clearAuthToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  } catch (error) {
    console.error('Error clearing auth token:', error);
  }
}

