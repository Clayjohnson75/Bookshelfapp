/**
 * Lightweight perf logger for worst interactions.
 * Log: tapAt, stateCommittedAt, listRenderedAt + counts so you can tell
 * JS-blocking vs network-blocking vs list-rendering.
 */
import { logger } from '../utils/logger';

export type PerfInteraction =
  | 'select_all'
  | 'approve'
  | 'clear_library'
  | 'photos_tab_open';

export type PerfPhase = 'tap' | 'state_committed' | 'list_rendered';

export interface PerfPoint {
  tapAt?: number;
  stateCommittedAt?: number;
  listRenderedAt?: number;
  [key: string]: number | string | undefined;
}

const _pending: Record<string, PerfPoint> = {};

/**
 * Start or update a perf run for an interaction. Call at tap, after state commit, and after list render.
 * Logs one line when you have at least tapAt; logs again when stateCommittedAt/listRenderedAt are set.
 */
export function perfLog(
  interaction: PerfInteraction,
  phase: PerfPhase,
  extra: Partial<PerfPoint> & Record<string, number | string | undefined>
): void {
  const key = interaction;
  if (!_pending[key]) _pending[key] = {};
  const p = _pending[key];
  const now = Date.now();
  if (phase === 'tap') {
    p.tapAt = extra.tapAt ?? now;
    Object.assign(p, extra);
  logger.info('[PERF]', { interaction, phase: 'tap', tapAt: p.tapAt, ...extra });
    return;
  }
  if (phase === 'state_committed') {
    p.stateCommittedAt = extra.stateCommittedAt ?? now;
    Object.assign(p, extra);
    const msToState = p.tapAt != null ? p.stateCommittedAt - p.tapAt : undefined;
    logger.info('[PERF]', { interaction, phase: 'state_committed', tapAt: p.tapAt, stateCommittedAt: p.stateCommittedAt, msToState, ...extra });
    return;
  }
  if (phase === 'list_rendered') {
    p.listRenderedAt = extra.listRenderedAt ?? now;
    Object.assign(p, extra);
    const msToState = p.tapAt != null && p.stateCommittedAt != null ? p.stateCommittedAt - p.tapAt : undefined;
    const msToList = p.tapAt != null ? p.listRenderedAt - p.tapAt : undefined;
    logger.info('[PERF]', { interaction, phase: 'list_rendered', tapAt: p.tapAt, stateCommittedAt: p.stateCommittedAt, listRenderedAt: p.listRenderedAt, msToState, msToList, ...extra });
  }
}

/**
 * One-shot: log tap + state + list in one object (e.g. when all are known at end of flow).
 */
export function perfLogComplete(
  interaction: PerfInteraction,
  data: { tapAt: number; stateCommittedAt?: number; listRenderedAt?: number; [key: string]: number | string | undefined }
): void {
  const tapAt = data.tapAt;
  const stateCommittedAt = data.stateCommittedAt ?? tapAt;
  const listRenderedAt = data.listRenderedAt ?? stateCommittedAt;
  logger.info('[PERF]', { interaction, tapAt, stateCommittedAt, listRenderedAt, msToState: stateCommittedAt - tapAt, msToList: listRenderedAt - tapAt, ...data });
}
