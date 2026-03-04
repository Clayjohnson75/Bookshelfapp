/**
 * Collapse approve duplicate-key spam into one [APPROVE_DUPES] summary per approve run.
 */

const dupes: string[] = [];

export function recordApproveDupe(title: string): void {
  dupes.push(title);
}

export function flushApproveDupes(log: { warn: (tag: string, msg: string, data?: any) => void }): void {
  if (dupes.length === 0) return;
  log.warn('[APPROVE_DUPES]', 'duplicate key', { count: dupes.length, sample: dupes.slice(0, 8) });
  dupes.length = 0;
}
