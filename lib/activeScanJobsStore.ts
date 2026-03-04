/**
 * Durable store for active scan job IDs. Survives tab navigation and app restarts.
 * Cleared only on explicit user cancel (cancelAll) or when jobs go terminal.
 * Key: scan_active_job_ids_${userId}
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'scan_active_job_ids_';

function key(userId: string): string {
  return `${PREFIX}${userId}`;
}

export async function getActiveScanJobIds(userId: string): Promise<string[]> {
  const k = key(userId);
  const raw = await AsyncStorage.getItem(k);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export async function setActiveScanJobIds(userId: string, ids: string[]): Promise<void> {
  const k = key(userId);
  await AsyncStorage.setItem(k, JSON.stringify(ids));
}

export async function clearActiveScanJobIds(userId: string): Promise<void> {
  const k = key(userId);
  await AsyncStorage.removeItem(k);
}
