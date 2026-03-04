/**
 * Client telemetry for TestFlight/App Store. Emit high-signal events to backend (no console spam).
 * Transition-only + 1 event/sec throttle (critical events always allowed).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { getApiBaseUrl } from './getEnvVar';

const DEVICE_ID_KEY = 'telemetry_device_id';
const CRITICAL_EVENTS = new Set(['SCAN_IMPORT', 'SCAN_ENQUEUE', 'SCAN_DONE_CLIENT', 'APP_STATE_CHANGE']);
const THROTTLE_MS = 1000;

let lastSentAt = 0;
let deviceIdPromise: Promise<string> | null = null;

function getBuild(): string {
  const c = (Constants.expoConfig as unknown) as Record<string, unknown> | undefined;
  const manifest = (Constants.manifest as unknown) as Record<string, unknown> | undefined;
  const v = c?.version ?? manifest?.version ?? '';
  const ios = c?.ios as Record<string, unknown> | undefined;
  const android = c?.android as Record<string, unknown> | undefined;
  const build = (ios?.buildNumber ?? android?.versionCode ?? '') as string;
  return [String(v), String(build)].filter(Boolean).join('-') || 'unknown';
}

export async function getDeviceId(): Promise<string> {
  if (deviceIdPromise) return deviceIdPromise;
  deviceIdPromise = (async () => {
    try {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (existing && existing.length > 0) return existing;
      const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      await AsyncStorage.setItem(DEVICE_ID_KEY, uuid);
      return uuid;
    } catch {
      return `anon-${Date.now()}`;
    }
  })();
  return deviceIdPromise;
}

export function canSend(eventName: string): boolean {
  const now = Date.now();
  if (CRITICAL_EVENTS.has(eventName)) return true;
  if (now - lastSentAt < THROTTLE_MS) return false;
  lastSentAt = now;
  return true;
}

export type TelemetryContext = {
  userId?: string | null;
  sessionId?: string | null;
};

let telemetryContext: TelemetryContext = {};

export function setTelemetryContext(ctx: TelemetryContext): void {
  telemetryContext = { ...telemetryContext, ...ctx };
}

export async function sendTelemetry(
  eventName: string,
  data: Record<string, unknown> = {},
  options?: { userId?: string | null; sessionId?: string | null }
): Promise<void> {
  if (!canSend(eventName)) return;

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return;

  const userId = options?.userId ?? telemetryContext.userId ?? null;
  const sessionId = options?.sessionId ?? telemetryContext.sessionId ?? null;
  const deviceId = await getDeviceId();
  const build = getBuild();
  const ts = new Date().toISOString();

  const body = {
    userId: userId ?? undefined,
    deviceId,
    sessionId: sessionId ?? undefined,
    build,
    eventName,
    data,
    ts,
  };

  try {
    const res = await fetch(`${baseUrl}/api/client-telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Don't spam; telemetry failures are non-fatal
      if (__DEV__) console.warn('[telemetry] send failed', eventName, res.status);
    }
  } catch (err) {
    if (__DEV__) console.warn('[telemetry] send error', eventName, err);
  }
}
