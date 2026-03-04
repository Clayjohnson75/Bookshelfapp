/**
 * Optional verbose/trace logging. Set env vars in .env.local to enable.
 *
 * ─── Category toggles (domain-scoped) ────────────────────────────────────────
 * LOG_NET:      Network/auth-header logs ([REST_AUTH_HEADER], token length, session checks).
 *               Default off — these are debug-only and fire on every REST call.
 *               Set EXPO_PUBLIC_LOG_NET=true to see them.
 * LOG_SNAPSHOT: Snapshot fetch detail ([SNAPSHOT_QUERY_META], per-page results, session guard).
 *               Default off. Set EXPO_PUBLIC_LOG_SNAPSHOT=true to see full pagination traces.
 * LOG_SCAN:     Scan polling detail ([SCAN_POLL_START], [SCAN_POLL_TICK], [SCAN_BAR_VISIBILITY*]).
 *               Default off. Set EXPO_PUBLIC_LOG_SCAN=true to trace job polling.
 * LOG_APPROVE:  Approve per-book detail ([SAVE_BOOK_TO_SUPABASE], [BOOK_WRITE_INTENT], preflight).
 *               Default off. Set EXPO_PUBLIC_LOG_APPROVE=true to trace every book write.
 *
 * ─── General verbosity toggles ────────────────────────────────────────────────
 * LOG_TRACE:    Tab focus skip, debounce, query dumps (very noisy).
 * LOG_DEBUG:    Auth snapshot, nav guard, profile fetch/apply, sync, scans focus.
 *               Also gates: [ENV_CONFIG], [CLEANUP_ACTION], [REHYDRATE_SUMMARY],
 *               [SERVER_ACTIVE_JOBS], [PICK_DEBUG], [ENSURE_LOCAL_URI], [PICKER_DEDUP],
 *               [UPLOAD_FILE_INFO/RESULT], "Checking for guest data", [SCAN_BAR_PERCENT].
 * LOG_POLL:     Every SCAN_POLL_TICK tick (default: only state-change ticks logged).
 * LOG_UI:       SCAN_BAR_VISIBILITY, MY_LIBRARY_GRID_DEV, and other render/visibility noise.
 * DEBUG_VERBOSE: Per-book approve samples, merge step chatter, manifest dumps,
 *               [PHOTO_ATTACH_DB_KEYCHECK] and [BOOK_PREFLIGHT_DB_BY_KEY] per-book lines.
 */
import { getEnvVar } from './getEnvVar';

const envOn = (key: string) =>
  getEnvVar(key) === 'true' || getEnvVar(key) === '1';

// ─── Domain-scoped toggles ────────────────────────────────────────────────────

/** Network/auth-header detail. EXPO_PUBLIC_LOG_NET=true */
export const LOG_NET =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_NET');

/** Snapshot fetch pagination + session guard detail. EXPO_PUBLIC_LOG_SNAPSHOT=true */
export const LOG_SNAPSHOT =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_SNAPSHOT');

/** Scan job polling detail. EXPO_PUBLIC_LOG_SCAN=true */
export const LOG_SCAN =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_SCAN');

/** Per-book approve write detail. EXPO_PUBLIC_LOG_APPROVE=true */
export const LOG_APPROVE =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_APPROVE');

// ─── General verbosity toggles ────────────────────────────────────────────────

export const LOG_TRACE =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_TRACE');

export const LOG_DEBUG =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_DEBUG');

/** Enable every SCAN_POLL_TICK line. Without this only state-change ticks are logged. */
export const LOG_POLL =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_POLL');

/** Enable UI/render noise: SCAN_BAR_VISIBILITY, MY_LIBRARY_GRID_DEV, etc. */
export const LOG_UI =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_LOG_UI');

/** Gate for [PENDING_DEBUG_RENDER] / [PENDING_DEBUG] logs. Default false — set EXPO_PUBLIC_DEBUG_PENDING=true to enable. */
export const DEBUG_PENDING =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_DEBUG_PENDING');

export const DEBUG_VERBOSE =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_DEBUG_VERBOSE');

/** When true (dev only), use pure-JS hash for image dedupe so hashing is consistent across envs where expo-crypto may fail. Client hash will differ from server (SHA256 of buffer). */
export const USE_PURE_JS_HASH =
  typeof __DEV__ !== 'undefined' && __DEV__ && envOn('EXPO_PUBLIC_USE_PURE_JS_HASH');
