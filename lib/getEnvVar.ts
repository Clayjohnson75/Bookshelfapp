/**
 * Read env vars from Expo config, manifest, or process.env.
 * Expo types don't include 'extra' on EmbeddedManifest, so we cast.
 */
import Constants from 'expo-constants';

type ManifestWithExtra = { extra?: Record<string, unknown> };

export function getEnvVar(key: string): string {
  const expo = Constants.expoConfig as ManifestWithExtra | undefined;
  const manifest = Constants.manifest as ManifestWithExtra | undefined;
  const fromExtra = expo?.extra?.[key] ?? manifest?.extra?.[key];
  if (typeof fromExtra === 'string') return fromExtra;
  const fromProcess = process.env[key];
  return typeof fromProcess === 'string' ? fromProcess : '';
}
