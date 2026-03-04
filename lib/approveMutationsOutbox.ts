/**
 * Durable approve mutation outbox (outbox pattern).
 *
 * When the user approves books we immediately write a mutation record (action_id, book_ids, client_timestamp).
 * We push to the server via the approve queue. On next launch we replay unconfirmed mutations until the server
 * confirms. Merge rules use this to avoid resurrecting locally-approved books to pending when server snapshot
 * is stale.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from '../utils/logger';

const OUTBOX_KEY_PREFIX = 'approve_mutations_';

export interface ApproveMutationRecord {
  action_id: string;
  book_ids: string[];
  client_timestamp: number;
  confirmed: boolean;
}

function outboxKey(userId: string): string {
  return `${OUTBOX_KEY_PREFIX}${userId}`;
}

const MAX_RECORDS = 100;

export async function addApproveMutation(
  userId: string,
  params: { action_id: string; book_ids: string[] }
): Promise<void> {
  const list = await getApproveMutations(userId);
  const record: ApproveMutationRecord = {
    action_id: params.action_id,
    book_ids: params.book_ids.filter((id) => id && id.length >= 36),
    client_timestamp: Date.now(),
    confirmed: false,
  };
  if (record.book_ids.length === 0) return;
  list.unshift(record);
  const trimmed = list.slice(0, MAX_RECORDS);
  await AsyncStorage.setItem(outboxKey(userId), JSON.stringify(trimmed));
  logger.debug('[APPROVE_OUTBOX]', 'added', {
    action_id: params.action_id.slice(0, 12),
    book_count: record.book_ids.length,
  });
}

export async function getApproveMutations(userId: string): Promise<ApproveMutationRecord[]> {
  const raw = await AsyncStorage.getItem(outboxKey(userId));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as ApproveMutationRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getUnconfirmedMutations(userId: string): Promise<ApproveMutationRecord[]> {
  const list = await getApproveMutations(userId);
  return list.filter((r) => !r.confirmed);
}

/** Set of book IDs that have at least one unconfirmed approve mutation. Used by merge to keep them approved. */
export async function getBookIdsWithUnconfirmedApprove(userId: string): Promise<Set<string>> {
  const unconfirmed = await getUnconfirmedMutations(userId);
  const set = new Set<string>();
  for (const r of unconfirmed) {
    for (const id of r.book_ids) set.add(id);
  }
  return set;
}

/** Call after server confirms approve for this action_id. */
export async function markMutationConfirmed(userId: string, action_id: string): Promise<void> {
  const list = await getApproveMutations(userId);
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].action_id === action_id && !list[i].confirmed) {
      list[i] = { ...list[i], confirmed: true };
      changed = true;
      break;
    }
  }
  if (changed) {
    await AsyncStorage.setItem(outboxKey(userId), JSON.stringify(list));
    logger.debug('[APPROVE_OUTBOX]', 'confirmed', { action_id: action_id.slice(0, 12) });
  }
}

/** Remove confirmed records older than 24h to avoid unbounded growth. */
export async function pruneConfirmedMutations(userId: string): Promise<void> {
  const list = await getApproveMutations(userId);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const kept = list.filter((r) => !r.confirmed || r.client_timestamp > cutoff);
  if (kept.length < list.length) {
    await AsyncStorage.setItem(outboxKey(userId), JSON.stringify(kept));
  }
}
