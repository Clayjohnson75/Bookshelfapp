/**
 * Central logger: levels, categories, env-controlled filtering, once/every, redaction, safe stringify.
 *
 * Env flags:
 *   EXPO_PUBLIC_LOG_LEVEL      : error | warn | info | debug | trace  (default: info dev, warn prod)
 *   EXPO_PUBLIC_LOG_CATEGORIES : comma list of categories to show at INFO; when set, overrides default allowlist.
 *   EXPO_PUBLIC_DEBUG_TRACE_ID : when set, only log lines whose traceId matches (e.g. S-0E49). Cuts logs by ~95% when debugging one upload/scan.
 *   EXPO_PUBLIC_DEBUG_INTEGRITY: "true"  → emit full detail payload for integrity check logs
 *   EXPO_PUBLIC_DEBUG_STACKS   : "true"  → include stack in warn/error (otherwise compact: caller + count)
 *
 * Default at INFO (when LOG_CATEGORIES not set): only tags matching [SCAN_JOB], [UPLOAD], [ERROR], [SESSION_GUARD], [SCAN_SUMMARY], [JOB_SUMMARY], [BATCH_COMPLETE], [STEP_*].
 *
 * Domain-scope toggles (see lib/logFlags.ts): LOG_NET, LOG_SNAPSHOT, LOG_SCAN, LOG_APPROVE.
 *
 * Category system
 * ───────────────
 * Tags map to categories: SCAN, UPLOAD, MERGE, AUTH, PHOTO, BOOKS, UI.
 * CATEGORY_LEVELS defines tag → level. When LOG_CATEGORIES is set, at INFO we only emit if
 * the tag's category is in the list; everything else is effectively DEBUG (off at default INFO).
 */
import { LogBox } from 'react-native';
import { getEnvVar } from '../lib/getEnvVar';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';
const order: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/** Default: info (dev), warn (prod). trace/debug no-op unless EXPO_PUBLIC_LOG_LEVEL=debug|trace. */
const DEFAULT_LEVEL: Level =
 (() => {
 const raw = getEnvVar('EXPO_PUBLIC_LOG_LEVEL')?.toLowerCase?.();
 if (raw && (order as Record<string, number>)[raw] !== undefined) return raw as Level;
 return __DEV__ ? 'info' : 'warn';
 })();

/** When set, at INFO only emit logs whose tag's category is in this set. Others suppressed unless LOG_LEVEL >= debug. */
export type LogCategory = 'SCAN' | 'UPLOAD' | 'MERGE' | 'AUTH' | 'PHOTO' | 'BOOKS' | 'UI';
const DEBUG_CATEGORIES: Set<LogCategory> | null = (() => {
 const raw = getEnvVar('EXPO_PUBLIC_LOG_CATEGORIES');
 if (!raw || typeof raw !== 'string') return null;
 return new Set(raw.split(',').map((s) => s.trim().toUpperCase() as LogCategory).filter(Boolean));
})();

/** Default INFO allowlist: when LOG_CATEGORIES is not set, only these tag prefixes are shown at INFO to avoid "409 messages discarded". */
const DEFAULT_INFO_ALLOWED_TAG_PREFIXES = [
 '[SCAN_JOB', '[SCAN_SUMMARY]', '[JOB_SUMMARY]', '[BATCH_COMPLETE]', '[STEP_', '[UPLOAD_', '[ERROR]', '[SESSION_GUARD]',
];

function tagMatchesDefaultAllowlist(tag: string): boolean {
 return DEFAULT_INFO_ALLOWED_TAG_PREFIXES.some((p) => tag.startsWith(p));
}

/** When set, only emit logs whose traceId matches (e.g. "S-0E49" or "scan_123_abc"). Set via EXPO_PUBLIC_DEBUG_TRACE_ID or setDebugTraceId(). */
let debugTraceId: string | null = getEnvVar('EXPO_PUBLIC_DEBUG_TRACE_ID')?.trim() || null;

export function setDebugTraceId(id: string | null): void {
 debugTraceId = id ? id.trim() || null : null;
}

export function getDebugTraceId(): string | null {
 return debugTraceId;
}

/** Tag prefix → category for INFO filtering. Longest match wins. */
const TAG_CATEGORIES: Array<[prefix: string, category: LogCategory]> = [
 ['[SCAN_', 'SCAN'], ['[BATCH_', 'SCAN'], ['[STEP_', 'UPLOAD'], ['[SCAN_WATCHDOG]', 'SCAN'], ['[SCAN_TERMINAL_REMOVE]', 'SCAN'],
 ['[JOB_SUMMARY]', 'SCAN'], ['[SCAN_POLL', 'SCAN'], ['[SCAN_BAR', 'SCAN'], ['[SCAN_IMPORT', 'SCAN'], ['[SCAN_FAILED', 'SCAN'],
 ['[UPLOAD_', 'UPLOAD'], ['[PHOTO_CREATE]', 'UPLOAD'], ['[PHOTO_ATTACH_BOOKS]', 'UPLOAD'],
 ['[FETCH_ALL_', 'BOOKS'], ['[BOOKS_', 'BOOKS'], ['[MERGE_', 'MERGE'], ['[SNAPSHOT_MERGE]', 'MERGE'], ['[REHYDRATE_', 'MERGE'],
 ['[AUTH_', 'AUTH'], ['[SESSION_', 'AUTH'], ['[PHOTO_', 'PHOTO'], ['[APPROVE_', 'BOOKS'], ['[SAVE_BOOK', 'BOOKS'],
];

function tagCategory(tag: string): LogCategory | null {
 let match: LogCategory | null = null;
 let maxLen = 0;
 for (const [prefix, cat] of TAG_CATEGORIES) {
  if (tag.startsWith(prefix) && prefix.length > maxLen) {
   maxLen = prefix.length;
   match = cat;
  }
 }
 return match;
}

// ─── Category → canonical log level ──────────────────────────────────────────
// Tags are matched by prefix (longest match wins).
// Add new entries here when you add new log tags; categories act as the single
// source of truth for "what level should this tag emit at?"
//
// Canonical levels by category:
//   error  – real failures, data integrity violations, guard blocks
//   warn   – mismatches, partial snapshots, stale responses, retries
//   info   – high-level lifecycle milestones (one per operation)
//   debug  – per-step detail, page queries, intermediate counts, header presence
//
const CATEGORY_LEVELS: Array<[prefix: string, level: Level]> = [
 // ── Errors / guard blocks ─────────────────────────────────────────────────
 ['[FETCH_ALL_APPROVED_BOOKS] aborting',          'error'],
 ['[FETCH_ALL_PHOTOS] aborting',                  'error'],
 ['[REHYDRATE_MERGE_EMPTY_GUARD]',                'error'],
 ['[APPROVE_PROVENANCE_GUARD_BLOCKED]',           'error'],
 ['[APPROVE_UPDATE_SAFETY]',                      'error'],
 ['[APPROVE_INSERT_SAFETY]',                      'error'],
 ['[APPROVE_SAVE_BOOKS_FAIL]',                    'error'],
 ['[PHOTO_SAVE_23505',                            'error'],  // prefix — covers all PHOTO_SAVE_23505* variants
 ['[PHOTO_SAVE_DB_ERROR]',                        'error'],
 ['[APPROVE_SAVE_PHOTO_FAIL]',                    'error'],
 ['[FK_BLOCKER_LIBRARY_EVENTS]',                  'error'],
 ['[SAVE_BOOK_UPSERT_ERR]',                       'error'],
 ['[PHOTO_FK_PATCH_NONFATAL]',                    'error'],  // non-fatal but still surfaced as error
 ['[SOFT_DELETE_AUDIT]',                          'error'],
 ['[DELETE_GUARD]',                               'error'],   // invariant violations in assertDeleteAllowed
 ['[STORAGE_PUBLIC_URL_DETECTED]',               'warn'],    // private-bucket data exposed via public URL

 // ── Warnings / mismatches / retries ──────────────────────────────────────
 ['[REHYDRATE_MERGE_BLOCKED]',                    'warn'],
 ['[REHYDRATE_MERGE_STALE]',                      'warn'],
 ['[BOOKS_MERGE_PARTIAL_SNAPSHOT]',               'warn'],
 ['[PHOTO_MERGE_PARTIAL_SNAPSHOT]',               'warn'],
 ['[REHYDRATE_INVARIANT_VIOLATION]',              'warn'],
 ['[REHYDRATE_IDENTITY_DIFF]',                    'warn'],
 ['[APPROVE_VERIFY_USERID_AUDIT]',                'warn'],
 ['[VERIFY_VS_FETCHALL_AUDIT]',                   'warn'],
 ['[SCAN_IMPORT_AUDIT]',                          'warn'],
 ['[PENDING_TOMBSTONES_APPLIED]',                 'warn'],
 ['[PHOTO_FILTER_BOOKS_OVERRIDE]',                'warn'],
 ['[PHOTO_DRAFT_WITH_BOOKS]',                     'warn'],
 ['[PROBE_BOOKS_ANY_STATUS]',                     'warn'],   // only fires on sanity-check mismatch
 ['[DELETE_BLOCKED]',                              'warn'],   // non-user delete attempt refused by guard
 ['[DATA_SAFETY_DROP]',                           'warn'],   // suspicious count drop without a recent delete
 ['[SCAN_WATCHDOG]',                              'warn'],
 ['[PHOTO_ROW_LOOKUP]',                           'warn'],   // error sub-path is warn; success is debug
 ['[MYLIB_SNAPSHOT_PARTIAL]',                     'warn'],
 ['[DIAG_DELETED_AT_PATTERN]',                    'warn'],   // elevated to warn when likelyBulkDelete
 ['[APPROVE]',                                    'warn'],   // [APPROVE] update by id missing source_scan_job_id
 ['[LOAD_PHOTOS_LINKAGE]',                        'warn'],
 ['[PHOTO_SAVE_23505_DELETED_ROW]',               'warn'],
 ['[NETWORK_NON_HTTPS_BLOCKED]',                  'warn'],   // plain-HTTP URL intercepted/rejected
 ['[ANOMALY_TOO_MANY_REQUESTS]',                  'warn'],   // request rate exceeds threshold
 ['[ANOMALY_TOO_MANY_SCANS]',                     'warn'],   // scan rate exceeds threshold
 ['[ANOMALY_REPEATED_FAILURES]',                  'warn'],   // consecutive failures on same op

 // ── Info: lifecycle milestones (one per operation) ────────────────────────
 ['[SNAPSHOT_MERGE]',                             'info'],
 ['[FETCH_ALL_APPROVED_BOOKS]',                   'info'],
 ['[BOOKS_FETCH_SHAPES]',                         'info'],   // after load: count, sample statuses, deleted_at
 ['[FETCH_ALL_PHOTOS]',                           'info'],
 ['[APPROVE_COMPLETE]',                           'info'],
 ['[APPROVE_VERIFY_IDS]',                         'info'],
 ['[APPROVE_VERIFY_RESULT]',                      'info'],
 ['[APPROVE_FULL_REFRESH]',                       'info'],
 ['[SCAN_SUMMARY]',                               'info'],
 ['[BATCH_COMPLETE]',                             'info'],
 ['[JOB_SUMMARY]',                                'info'],
 ['[SCAN_FAILED_TOAST]',                          'info'],
 ['[SCAN_POLL_EXIT]',                             'info'],
 ['[PHOTO_CANONICAL_STATUS]',                     'info'],
 ['[PHOTO_ATTACH_SUMMARY]',                        'info'],   // one line per library sync: photos, photosWithBooks, totalAttachedBooks
 ['[LOCAL_STORAGE_SUMMARY]',                       'info'],   // on boot: docsBytes, cacheBytes, scanOriginalsCount/Bytes
 ['[LOCAL_STORAGE_PURGE_RESULT]',                  'info'],   // after purge: deletedCount, deletedBytes
 ['[PERF]',                                        'info'],   // tapAt / stateCommittedAt / listRenderedAt for slow interactions
 ['[PHOTO_DETAILS_DEBUG]',                        'info'],   // photo row + attached books (when __photoDebug)
 ['[PHOTO_SAVE_TIMING_BREAKDOWN]',                'info'],
 ['[PENDING_COUNTS]',                             'info'],   // before Pending screen render: all, pending, approved, rejected
 ['[PENDING_DELETE_RESULT]',                      'info'],
 ['[PENDING_TOMBSTONES]',                         'info'],
 ['[APPROVE_STATE_AFTER_SETTLE]',                 'info'],
 ['[SERVER_SNAPSHOT_SUMMARY]',                    'info'],   // legacy alias kept for grep continuity
 ['[MERGE_DECISION]',                             'info'],   // legacy alias kept for grep continuity
 ['[BOOKS_HEAD_COUNT]',                           'info'],
 ['[PHOTO_SAVE_DEDUPE]',                          'info'],
 ['[PHOTO_SAVE_REUSED_BY_HASH]',                  'info'],
 ['[PHOTO_SAVE_23505_RESURRECTED]',               'info'],
 ['[PHOTO_DEDUPE_MIGRATION]',                     'info'],
 ['[PHOTO_SAVE]',                                 'info'],
 ['[DELETE_AUDIT]',                                'info'],   // one per confirmed user delete action
 ['[CANCEL]',                                     'info'],
 ['[BATCH_CANCEL]',                               'info'],
 ['[INTEGRITY_CLEANUP_DECISION]',                 'info'],
 ['[PHOTO_ALIAS_MAP_UPDATE]',                     'info'],
 ['[PHOTO_ALIAS_MAP_LOADED]',                     'info'],
 ['[MYLIB_FULL_SNAPSHOT]',                        'info'],
 ['[DELETE_PHOTO_LOCAL_APPLY]',                   'info'],
 ['[SAVE_BOOK_UPSERT_OK]',                        'info'],
 ['[STORAGE_URL_MODE]',                           'info'],   // how a storage URL was obtained (signed/public)
 ['[NETWORK_SECURITY_BASELINE]',                  'info'],   // logged once per session at app start
 ['[MUTATION_INTENT]',                            'info'],   // before a destructive DB write
 ['[MUTATION_EXECUTE]',                           'info'],   // after a DB write completes
 ['[MUTATION_BLOCKED_GUARDRAIL]',                 'warn'],   // write blocked by safety threshold
 ['[RLS_DENIED]',                                 'warn'],   // Supabase returned permission denied
 ['[AUTH_SESSION_INIT]',                          'info'],   // app start session check
 ['[AUTH_SESSION_REFRESH]',                       'info'],   // token refresh event
 ['[AUTH_USER_MISMATCH]',                         'warn'],   // session userId differs from state
 ['[AUTH_SIGNOUT]',                               'info'],   // user signed out
 ['[ENV_BUILD_FINGERPRINT]',                      'info'],   // env + build metadata at launch

 // ── Debug (domain-gated): network / auth headers ───────────────────────────
 // Gate these with LOG_NET=true so they never appear at default info level.
 ['[REST_AUTH_HEADER]',                           'debug'],  // was info; now debug + gated by LOG_NET
 ['[AUTH_USER_ID]',                               'debug'],
 ['[AUTH_SESSION_USER_ID]',                       'debug'],
 ['[AUTH_HAS_SESSION]',                           'debug'],
 ['[SESSION_TOKEN_LEN]',                          'debug'],
 ['[AUTH_ID_COMPARISON]',                         'debug'],
 ['[SUPABASE_URL_RUNTIME]',                       'debug'],
 ['[SUPABASE_REF_RUNTIME]',                       'debug'],
 ['[SESSION_GUARD]',                              'debug'],

 // ── Debug (domain-gated): snapshot / pagination detail ────────────────────
 // Gate with LOG_SNAPSHOT=true for full pagination traces.
 ['[BOOKS_COUNT_QUERY_RESULT]',                   'debug'],
 ['[BOOKS_PAGE_QUERY_RESULT]',                    'debug'],
 ['[PHOTOS_COUNT_QUERY_RESULT]',                  'debug'],
 ['[PHOTOS_PAGE_QUERY_RESULT]',                   'debug'],
 ['[SNAPSHOT_QUERY_META]',                        'debug'],
 ['[FETCH_ALL_APPROVED_BOOKS] session_check',     'debug'],
 ['[FETCH_ALL_PHOTOS] session_check',             'debug'],
 ['[PHOTO_INSERT_FIELD_VALUES]',                  'debug'],
 ['[PHOTO_INSERT_PAYLOAD]',                       'debug'],
 ['[PHOTO_RENDER_PIPELINE]',                      'debug'],

 // ── Debug (domain-gated): scan polling detail ─────────────────────────────
 // Gate with LOG_SCAN=true for full polling traces.
 ['[SCAN_BAR_VISIBILITY_CHANGE]',                 'debug'],
 ['[SCAN_BAR_VISIBILITY]',                        'debug'],
 ['[SCAN_POLL_START]',                            'debug'],

 // ── Debug (domain-gated): approve per-book detail ─────────────────────────
 // Gate with LOG_APPROVE=true for per-book write traces.
 ['[SAVE_BOOK_TO_SUPABASE]',                      'debug'],
 ['[SAVE_BOOK_VERIFY_SELECT]',                    'debug'],
 ['[SAVE_BOOK_DB_WRITE]',                         'debug'],
 ['[BOOK_WRITE_INTENT]',                          'debug'],
 ['[BOOK_DB_WRITE_RESULT]',                       'debug'],
 ['[SAVE_BOOK]',                                  'debug'],
 ['[SOURCE_PHOTO_ID_CANONICAL_WIN]',              'debug'],
 ['[PHOTO_ATTACH_INTENT]',                        'debug'],
 ['[PHOTO_ATTACH_DB_KEYCHECK]',                   'debug'],

 // ── Debug: photo save internals ────────────────────────────────────────────
 ['[PHOTO_SAVE_INPUT]',                           'debug'],
 ['[PHOTO_SAVE_UPSERT]',                          'debug'],
 ['[PHOTO_SAVE_JOB_LOOKUP]',                      'debug'],
 ['[PHOTO_SAVE_PRECHECK]',                        'debug'],
 ['[PHOTO_SAVE_BEFORE_UPSERT]',                   'debug'],
 ['[PHOTO_SAVE_LIFECYCLE_ONLY]',                  'debug'],
 ['[PHOTO_LIFECYCLE_PATCH_SKIPPED]',              'debug'],
 ['[PHOTO_LIFECYCLE_PATCH_DEFERRED]',             'debug'],
 ['[BACKFILL]',                                   'debug'],

 // ── Debug: client-side merge / rehydrate internals ────────────────────────
 ['[TIMING]',                                     'debug'],
 ['[MERGE_BOOKS]',                                'debug'],
 ['[STATE_PUBLISHED]',                            'debug'],
 ['[ASYNC_STORAGE_INITIAL]',                      'debug'],
 ['[ASYNC_STORAGE_FALLBACK]',                     'debug'],
 ['[SYNC_RESTORE]',                               'debug'],
 ['[PENDING_PIPELINE_SUMMARY]',                   'debug'],
 ['[PHOTO_ADOPT_CANONICAL]',                      'debug'],
 ['[PHOTO_DEDUPE_LOCAL_REWRITE]',                 'debug'],
 ['[PHOTO_CANONICAL_INSERT]',                     'debug'],
 ['[PHOTO_LOCAL_PLACEHOLDER_REMOVED]',            'debug'],
 ['[PENDING_ID_BACKFILL]',                        'debug'],
 ['[APPROVED_INVARIANT]',                          'warn'],   // approvedBooksCount > 0 but some items not status===approved
 ['[APPROVED_IDENTITY_HEALTH]',                   'debug'],
 ['[CANONICAL_IDENTITY_AUDIT]',                   'debug'],
 ['[LOCAL_QUEUE_UPDATE]',                         'debug'],
 ['[JOBS_IN_PROGRESS_RECALC]',                    'debug'],
 ['[RULE3_TERMINAL_BYPASS]',                      'debug'],
 ['[APPROVED_CHANGED]',                           'debug'],
 ['[POST_REHYDRATE_INVARIANTS]',                  'debug'],
 ['[LOAD_MERGE_APPLIED]',                         'debug'],
 ['[APPROVED_ID_STABILITY]',                      'debug'],
 ['[REHYDRATE_SYNC_PENDING_APPROVED]',            'debug'],
 ['[REHYDRATE_ALIAS_MIGRATION]',                  'debug'],
 ['[PHOTO_ROW_LOOKUP]',                           'debug'],  // success sub-path (error is warn above)
 ['[PHOTO_ALIAS_MAP_LOADED]',                     'debug'],  // success path only; same tag is info above, prefix order makes warn/info first match

 // ── Trace: per-render / per-tile (never at info; sampled or trace-only) ───
 ['[PHOTO_TILE_URI]',                             'trace'],
 ['[PHOTO_MERGE_DEBUG]',                          'trace'],
 ['[PHOTO_GRID_DIAG]',                            'trace'],
 ['[LIBRARY_STATE_WRITE]',                        'trace'],  // stack only at error/trace; see logLibraryStateWrite
 ['[SCAN_BAR_RENDER]',                            'trace'],

 // ── Debug: UI / render noise ───────────────────────────────────────────────
 ['[SCAN_IMPORT]',                                'debug'],
 ['[UPLOAD_FILE_INFO',                            'debug'],  // no closing bracket — prefix match covers UPLOAD_FILE_INFO + UPLOAD_FILE_INFO_RESULT
 ['[PICK_DEBUG]',                                 'debug'],
 ['[PICKER_DEDUP]',                               'debug'],
 ['[SERVER_ACTIVE_JOBS]',                         'debug'],
 ['[CLEANUP_ACTION]',                             'debug'],
 ['[GUEST_GATE]',                                 'debug'],
 ['[PHOTO_PRUNE]',                                'debug'],
 ['[PROFILE_PHOTOS]',                             'debug'],
 ['[LIB]',                                        'debug'],
 ['[MYLIB_LOAD_USER_DATA]',                       'debug'],
 ['[MYLIB_PHOTO_ALIAS_MAP_LOADED]',               'debug'],
 ['[DESC_MERGE_LOCAL_WINS]',                      'debug'],
 ['[DESC_MERGE_REMOTE_WINS]',                     'debug'],
 ['[DELETE_PHOTO]',                               'debug'],

 // ── Debug: diagnostics (cheap; always-on dev probes) ──────────────────────
 ['[DIAG_BOOKS_SAMPLE]',                          'debug'],
 ['[DIAG_BOOKS_STATUS_UNIQUE]',                   'debug'],
 ['[DIAG_PHOTOS_SAMPLE]',                         'debug'],
 ['[DIAG_DELETED_AT_PATTERN]',                    'debug'],  // elevated to warn by call-site when likelyBulkDelete
 ['[DB_RAW_COUNTS]',                              'debug'],

 // ── Debug: auth / profile ──────────────────────────────────────────────────
 ['[PROFILE_HYDRATION]',                          'debug'],
 ['[AUTH_SNAPSHOT]',                              'debug'],

 // ── Debug: misc flags ─────────────────────────────────────────────────────
 ['[FOCUS_REFRESH_SKIP]',                         'debug'],
 ['[APPROVE_SANITY_CHECK]',                       'debug'],  // OK variants are debug; mismatch branches use explicit warn/error
];

/**
 * Resolve the canonical level for a log tag by checking CATEGORY_LEVELS prefixes.
 * Returns undefined if no category matches (caller should supply an explicit level).
 */
function categoryLevel(tag: string): Level | undefined {
 for (const [prefix, lvl] of CATEGORY_LEVELS) {
  if (tag.startsWith(prefix)) return lvl;
 }
 return undefined;
}

/**
 * When true, integrity check logs emit full detail payloads (missing IDs, book samples, etc.).
 * Set EXPO_PUBLIC_DEBUG_INTEGRITY=true in .env.local to enable.
 */
export const DEBUG_INTEGRITY: boolean = getEnvVar('EXPO_PUBLIC_DEBUG_INTEGRITY') === 'true';

/**
 * When true, integrity/error logs append a one-line stack trace.
 * Set EXPO_PUBLIC_DEBUG_STACKS=true in .env.local to enable.
 */
export const DEBUG_STACKS: boolean = getEnvVar('EXPO_PUBLIC_DEBUG_STACKS') === 'true';

let currentLevel: Level = DEFAULT_LEVEL;

const onceKeys = new Set<string>();
const lastTimes = new Map<string, number>();
const whenChangedKeys = new Map<string, string>();
const suppressedCounts = new Map<string, number>();

const REDACT_KEYS = new Set([
 'supabaseAnonKey',
 'authorization',
 'token',
 'apiKey',
 'access_token',
 'refresh_token',
]);

function redact(obj: any): any {
 if (!obj || typeof obj !== 'object') return obj;
 if (Array.isArray(obj)) return obj.map(redact);
 const out: any = {};
 for (const k of Object.keys(obj)) {
 const v = (obj as any)[k];
 if (REDACT_KEYS.has(k)) out[k] = '[REDACTED]';
 else out[k] = redact(v);
 }
 return out;
}

function safeStringify(value: any, maxLen = 1200): string {
 try {
 const v = redact(value);
 let s = JSON.stringify(
 v,
 (_k, val) => {
 if (val && typeof val === 'object') return val;
 return val;
 },
 0
 );
 if (s.length > maxLen) s = s.slice(0, maxLen) + '(truncated)';
 return s;
 } catch {
 return String(value);
 }
}

/** Stable stringify for dedupe key (keys sorted, no stack). */
function stablePayloadKey(data: any): string {
 if (data == null) return '';
 try {
 if (typeof data !== 'object') return String(data);
 const obj = data as Record<string, unknown>;
 const skip = new Set(['stack', 'stackTrace', '_suppressed', '_callN']);
 const keys = Object.keys(obj).filter(k => !skip.has(k)).sort();
 const out: Record<string, unknown> = {};
 for (const k of keys) out[k] = obj[k];
 return JSON.stringify(out);
 } catch {
 return String(data);
 }
}

// ─── Dedupe: same tag+payload within 2s → count; flush "repeated x N in 2s" ───
const DEDUPE_WINDOW_MS = 2000;
const dedupeMap = new Map<string, { count: number; firstAt: number }>();
let dedupeFlushTimer: ReturnType<typeof setInterval> | null = null;

function flushDedupeRepeat(key: string, entry: { count: number; firstAt: number }): void {
 if (entry.count <= 1) return;
 const tag = key.slice(0, key.indexOf('\0'));
 const line = `${LEVEL_PREFIX['info']}${tag} repeated x${entry.count} in ${DEDUPE_WINDOW_MS / 1000}s`;
 if (shouldSkipNoise(line)) return;
 pushRing(line);
 console.log(line);
}

function scheduleDedupeFlush(): void {
 if (dedupeFlushTimer != null) return;
 dedupeFlushTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dedupeMap.entries()) {
   if (now - entry.firstAt >= DEDUPE_WINDOW_MS) {
    dedupeMap.delete(key);
    flushDedupeRepeat(key, entry);
   }
  }
  if (dedupeMap.size === 0 && dedupeFlushTimer != null) {
   clearInterval(dedupeFlushTimer);
   dedupeFlushTimer = null;
  }
 }, DEDUPE_WINDOW_MS);
}

/** Tags that are deduped (same payload within 2s → single line + "repeated x N"). */
const DEDUPE_TAGS = new Set([
 '[PHOTO_TILE_URI]', '[PHOTO_MERGE_DEBUG]', '[PHOTO_GRID_DIAG]', '[LIBRARY_STATE_WRITE]', '[SCAN_BAR_RENDER]',
]);

/** Hot tags: log at most 1-in-N or once per second. */
const HOT_TAG_SAMPLE_N = 20;
const HOT_TAG_MIN_MS = 1000;
const hotTagCounts = new Map<string, number>();
const hotTagLastEmit = new Map<string, number>();
const HOT_TAGS = new Set([
 '[PHOTO_TILE_URI]', '[PHOTO_MERGE_DEBUG]', '[PHOTO_GRID_DIAG]', '[SCAN_BAR_RENDER]',
]);

/** Same message+tag+traceId only logs once per 10s; suppressed count added when window reopens. */
const RATE_LIMIT_10S_MS = 10000;
const rateLimit10sByKey = new Map<string, { lastAt: number; suppressed: number }>();
const RATE_LIMIT_10S_TAGS = new Set([
 '[SCAN_WATCHDOG]', '[FETCH_ALL_APPROVED_BOOKS]', '[FETCH_ALL_PHOTOS]', '[SCAN_POLL_TICK]', '[SCAN_BAR_STATE]',
]);

function shouldLog(level: Level): boolean {
 return order[level] <= order[currentLevel];
}

/** When true, include full stack in warn/error; otherwise compact (caller + count only). */
function shouldEmitStacks(): boolean {
 return DEBUG_STACKS || order[currentLevel] >= order.debug;
}

/** Skip noisy Expo/metro messages (manifest, "Running main") even if something logs them. */
function shouldSkipNoise(line: string): boolean {
 if (line.includes('Running "main" with') || line.includes('manifestString')) return true;
 if (line.length > 2000 && line.includes('"expo"')) return true; // giant manifest JSON
 return false;
}

// Level prefix prepended to every log line so Metro output is easy to grep/filter.
// Format: "I/", "W/", "E/", "D/" — one char keeps lines compact.
const LEVEL_PREFIX: Record<Level, string> = {
 error: 'E/',
 warn:  'W/',
 info:  'I/',
 debug: 'D/',
 trace: 'T/',
};

// ─── Ring buffer: last N lines for "export on error" / Export Debug Logs ─────
const RING_SIZE = 500;
const ringLines: string[] = new Array(RING_SIZE);
let ringIndex = 0;
let ringFilled = false;

function pushRing(line: string): void {
 ringLines[ringIndex] = line;
 ringIndex = (ringIndex + 1) % RING_SIZE;
 if (ringIndex === 0) ringFilled = true;
}

/** Returns last RING_SIZE lines (newest at end). Call from Export Debug Logs or on error. */
export function getLogBuffer(): string[] {
 if (!ringFilled) return ringLines.slice(0, ringIndex);
 return [...ringLines.slice(ringIndex), ...ringLines.slice(0, ringIndex)];
}

/** One string of last RING_SIZE lines (newest last). Use from "Export Debug Logs" in dev menu. */
export function exportDebugLogs(): string {
 return getLogBuffer().join('\n');
}

// ─── Per-batch trace id: set when user starts a scan batch, cleared when batch ends. Included in every log line. ───
let currentTraceId: string | null = null;

export function setTraceId(id: string): void {
 currentTraceId = id;
}

export function clearTraceId(): void {
 currentTraceId = null;
}

export function getTraceId(): string | null {
 return currentTraceId;
}

function log(level: Level, tag: string, msg: string, data?: any): void {
 if (!shouldLog(level)) return;
 // At INFO: restrict to allowed tags so production/dev doesn't spam (e.g. "409 messages discarded").
 if (level === 'info') {
  if (DEBUG_CATEGORIES != null) {
   const cat = tagCategory(tag);
   if (cat != null && !DEBUG_CATEGORIES.has(cat)) return;
  } else if (!tagMatchesDefaultAllowlist(tag)) {
   return; // default: only SCAN_JOB, UPLOAD, ERROR, SESSION_GUARD, etc.
  }
 }
 // When debugging a single flow: only emit if this log's traceId matches debugTraceId.
 if (debugTraceId != null) {
  let effectiveTraceId: string | null = (typeof data === 'object' && data != null && typeof data.traceId === 'string') ? data.traceId : currentTraceId;
  if (effectiveTraceId !== debugTraceId) return;
 }
 let payload = data;
 if (currentTraceId != null) {
  payload = typeof payload === 'object' && payload !== null
   ? { ...payload, traceId: currentTraceId }
   : { _: payload, traceId: currentTraceId };
 }
 // Compact SCAN_TERMINAL_REMOVE when stacks are off: caller + truncated jobId + count only.
 if (tag === '[SCAN_TERMINAL_REMOVE]' && (level === 'warn' || level === 'error') && !shouldEmitStacks() && payload && typeof payload === 'object') {
  const p = payload as Record<string, unknown>;
  payload = {
   caller: p.caller ?? '?',
   jobId: String(p.jobId ?? '').slice(0, 24),
   count: (p._count as number) ?? 1,
   ...(currentTraceId ? { traceId: currentTraceId } : {}),
  };
 }
 // Rate-limit noisy repeats: same tag+traceId+msg at most once per 10s.
 if (RATE_LIMIT_10S_TAGS.has(tag)) {
  const rlKey = `${tag}\0${currentTraceId ?? ''}\0${msg}`;
  const now = Date.now();
  const entry = rateLimit10sByKey.get(rlKey);
  if (entry) {
   if (now - entry.lastAt < RATE_LIMIT_10S_MS) {
    entry.suppressed++;
    return;
   }
   if (entry.suppressed > 0) {
    payload = typeof payload === 'object' && payload !== null ? { ...payload, _suppressed: entry.suppressed } : { _: payload, _suppressed: entry.suppressed };
   }
  }
  rateLimit10sByKey.set(rlKey, { lastAt: now, suppressed: 0 });
 }
 const body = payload === undefined ? `${tag} ${msg}` : `${tag} ${msg} ${safeStringify(payload)}`;
 const line = `${LEVEL_PREFIX[level]}${body}`;
 if (shouldSkipNoise(line)) return;

 // Dedupe: same tag+payload within 2s → increment count, skip emit; flush later.
 if (DEDUPE_TAGS.has(tag)) {
  const payloadKey = stablePayloadKey(payload);
  const dedupeKey = `${tag}\0${payloadKey}`;
  const now = Date.now();
  const entry = dedupeMap.get(dedupeKey);
  if (entry) {
   if (now - entry.firstAt < DEDUPE_WINDOW_MS) {
    entry.count++;
    scheduleDedupeFlush();
    pushRing(line); // still capture in ring for context
    return;
   }
   dedupeMap.delete(dedupeKey);
   flushDedupeRepeat(dedupeKey, entry);
  }
  dedupeMap.set(dedupeKey, { count: 1, firstAt: now });
  scheduleDedupeFlush();
 }

 // Hot-tag sampling: at most 1-in-N or once per second for high-frequency tags.
 if (HOT_TAGS.has(tag) && (level === 'trace' || level === 'debug')) {
  const count = (hotTagCounts.get(tag) ?? 0) + 1;
  hotTagCounts.set(tag, count);
  const last = hotTagLastEmit.get(tag) ?? 0;
  const now = Date.now();
  const allowed = count === 1 || count % HOT_TAG_SAMPLE_N === 0 || (now - last >= HOT_TAG_MIN_MS);
  if (!allowed) {
   pushRing(line);
   return;
  }
  hotTagLastEmit.set(tag, now);
 }

 // On error: dump buffer (lead-up) before adding this line, then log the error.
 if (level === 'error') {
  const buf = getLogBuffer();
  const tail = buf.slice(-50);
  if (tail.length > 0) {
   console.log(`${LEVEL_PREFIX['info']}[LOG_CONTEXT] --- last ${tail.length} lines before error ---`);
   tail.forEach(l => console.log(l));
  }
 }
 pushRing(line);

 // Route warn/error through console.log unless DEBUG_STACKS is on.
 if (DEBUG_STACKS) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
 } else {
  console.log(line);
 }
}

/** Backward compat: (msg, data?) treated as (tag="", msg, data). */
function normalizeArgs(
 tagOrMsg: string,
 msgOrData?: string | any,
 data?: any
): { tag: string; msg: string; data?: any } {
 if (msgOrData === undefined) return { tag: '', msg: tagOrMsg, data: undefined };
 if (typeof msgOrData === 'string') return { tag: tagOrMsg, msg: msgOrData, data };
 return { tag: '', msg: tagOrMsg, data: msgOrData };
}

export const logger = {
 setLevel: (lvl: Level) => (currentLevel = lvl),

 /** Current effective log level string (e.g. 'info'). */
 get LOG_LEVEL(): Level { return currentLevel; },

 error: (tagOrMsg: string, msgOrData?: string | any, data?: any) => {
 const { tag, msg, data: d } = normalizeArgs(tagOrMsg, msgOrData, data);
 log('error', tag, msg, d);
 },
 warn: (tagOrMsg: string, msgOrData?: string | any, data?: any) => {
 const { tag, msg, data: d } = normalizeArgs(tagOrMsg, msgOrData, data);
 log('warn', tag, msg, d);
 },
 info: (tagOrMsg: string, msgOrData?: string | any, data?: any) => {
 const { tag, msg, data: d } = normalizeArgs(tagOrMsg, msgOrData, data);
 log('info', tag, msg, d);
 },
 debug: (tagOrMsg: string, msgOrData?: string | any, data?: any) => {
 const { tag, msg, data: d } = normalizeArgs(tagOrMsg, msgOrData, data);
 log('debug', tag, msg, d);
 },
 trace: (tagOrMsg: string, msgOrData?: string | any, data?: any) => {
 const { tag, msg, data: d } = normalizeArgs(tagOrMsg, msgOrData, data);
 log('trace', tag, msg, d);
 },

 /**
  * Category-aware log: resolves the level from CATEGORY_LEVELS by tag prefix,
  * falling back to `fallback` (default 'info') when no category matches.
  *
  * Usage:  logger.cat('[SCAN_IMPORT_AUDIT]', { jobId, ... })
  *         logger.cat('[CUSTOM_TAG]', 'some message', { ... }, 'debug')
  *
  * This is the preferred call for new log sites — no need to think about which
  * level to use; the category table decides, and it's easy to adjust centrally.
  */
 cat: (tag: string, msgOrData?: string | any, data?: any, fallback: Level = 'info') => {
  const lvl = categoryLevel(tag) ?? fallback;
  const { msg, data: d } = typeof msgOrData === 'string'
   ? { msg: msgOrData, data }
   : { msg: '', data: msgOrData };
  log(lvl, tag, msg, d);
 },

 once: (key: string, level: Level, tag: string, msg: string, data?: any) => {
 if (onceKeys.has(key)) return;
 onceKeys.add(key);
 log(level, tag, msg, data);
 },

 every: (
 key: string,
 ms: number,
 level: Level,
 tag: string,
 msg: string,
 data?: any
 ) => {
 const now = Date.now();
 const last = lastTimes.get(key) ?? 0;
 if (now - last < ms) return;
 lastTimes.set(key, now);
 log(level, tag, msg, data);
 },

 /**
 * Rate-limit a log to at most once per `ms` milliseconds.
 * When the window opens again, the suppressed count is appended to the data so you can
 * see how many calls were dropped (mirrors the logRateLimited pattern from the design doc).
 *
 * Usage:
 * logger.rateLimit('fk_patch_fail', 5000, 'warn', '[PHOTO_FK_PATCH_FAIL]', 'batch', { ... })
 */
 rateLimit: (
 key: string,
 ms: number,
 level: Level,
 tag: string,
 msg: string,
 data?: any
 ) => {
 const now = Date.now();
 const last = lastTimes.get(key) ?? 0;
 if (now - last < ms) {
 suppressedCounts.set(key, (suppressedCounts.get(key) ?? 0) + 1);
 return;
 }
 const suppressed = suppressedCounts.get(key) ?? 0;
 suppressedCounts.set(key, 0);
 lastTimes.set(key, now);
 const enriched = suppressed > 0
 ? { ...((data && typeof data === 'object') ? data : {}), _suppressed: suppressed }
 : data;
 log(level, tag, msg, enriched);
 },

 /**
  * Emit exactly once per app run, keyed by `key`.
  * Identical to `once` but named to match the logOnce/logThrottle naming convention.
  * Usage: logger.logOnce('cover_exceed_warn', 'warn', '[HeaderShelfCollage]', 'cover exceeds rowHeight', { ... })
  */
 logOnce: (key: string, level: Level, tag: string, msg: string, data?: any) => {
  if (onceKeys.has(key)) return;
  onceKeys.add(key);
  log(level, tag, msg, data);
 },

 /**
  * Emit at most once per `ms` milliseconds, keyed by `key`.
  * Suppressed call counts are appended as `_suppressed` when the window re-opens.
  * Identical to `rateLimit` but named to match the logOnce/logThrottle naming convention.
  * Usage: logger.logThrottle('integrity_warn', 10_000, 'warn', '[INTEGRITY]', 'summary', { ... })
  */
 logThrottle: (key: string, ms: number, level: Level, tag: string, msg: string, data?: any) => {
  const now = Date.now();
  const last = lastTimes.get(key) ?? 0;
  if (now - last < ms) {
   suppressedCounts.set(key, (suppressedCounts.get(key) ?? 0) + 1);
   return;
  }
  const suppressed = suppressedCounts.get(key) ?? 0;
  suppressedCounts.set(key, 0);
  lastTimes.set(key, now);
  const enriched = suppressed > 0
   ? { ...((data && typeof data === 'object') ? data : {}), _suppressed: suppressed }
   : data;
  log(level, tag, msg, enriched);
 },

 /** Log only when the value key changes (e.g. total:withDesc for DESC_CLIENT_FETCH). Cuts repeated identical lines. */
 whenChanged: (valueKey: string, level: Level, tag: string, msg: string, data?: any) => {
 if (!shouldLog(level)) return;
 const prev = whenChangedKeys.get(tag);
 if (prev === valueKey) return;
 whenChangedKeys.set(tag, valueKey);
 log(level, tag, msg, data);
 },
 /** Update whenChanged key without logging (e.g. after a milestone log so next whenChanged doesn't re-log same values). */
 setWhenChangedKey: (tag: string, valueKey: string) => {
 whenChangedKeys.set(tag, valueKey);
 },

 /** Provenance mismatch: once per unique (scanJobId, expectedCount, storedCount), throttle 5s. Include table in data. */
 provenanceMismatch: (data: { scanJobId: string; expectedCount: number; storedCount: number; table?: string }) => {
 const key = `provenance:${data.scanJobId}:${data.expectedCount}:${data.storedCount}`;
 const now = Date.now();
 const last = lastTimes.get(key) ?? 0;
 if (now - last < 5000) return;
 lastTimes.set(key, now);
 log('warn', '[PROVENANCE]', 'mismatch', data);
 },

 redact,
 safeStringify,
};

/** Substrings that, when found in a log line, cause it to be silently dropped. */
const SUPPRESS_SUBSTRINGS: readonly string[] = [
 'Running "main" with',
 'manifestString',
 '[SUPABASE_REF]',
 '[SUPABASE] ENV:',
 '[SUPABASE_INSTANCE]',
 // ReactFabric internal stack-trace lines emitted by LogBox after console.warn/error.
 // These are noise — not actionable errors. Suppressed unless DEBUG_STACKS=true.
 'recursivelyTraversePassiveMountEffects',
 'commitPassiveMountEffects',
 'flushPassiveEffects',
 'ReactFabric-',
 'VirtualizedList: You have a large list that is slow',
];

function shouldSuppressConsoleLine(args: unknown[]): boolean {
 if (DEBUG_STACKS) return false; // never suppress when full stacks are requested
 const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
 if (line.length > 1500 && line.includes('"expo"')) return true; // giant manifest JSON
 for (const sub of SUPPRESS_SUBSTRINGS) {
  if (line.includes(sub)) return true;
 }
 return false;
}

/** LogBox patterns that suppress the yellow/red overlay and stack expansion in dev. */
const LOGBOX_IGNORE_PATTERNS: readonly string[] = [
 'Running "main" with',
 'manifestString',
 'expoClient',
 'Debugger integration',
 'Require cycle:',
 // ReactFabric stack-trace lines — only appear when console.warn/error is used.
 // With DEBUG_STACKS=false the logger routes through console.log so these never appear,
 // but we add the patterns defensively in case a third-party lib calls console.warn directly.
 'recursivelyTraversePassiveMountEffects',
 'commitPassiveMountEffects',
 'VirtualizedList: You have a large list',
 'ReactFabric',
];

export function setupDevLogBox(): void {
 if (!__DEV__) return;
 LogBox.ignoreLogs(LOGBOX_IGNORE_PATTERNS as string[]);
 // Intercept console.log (and, when DEBUG_STACKS=false, console.warn/error which the logger
 // also routes through console.log) to drop noisy infra lines.
 const origLog = console.log;
 console.log = (...args: unknown[]) => {
  if (shouldSuppressConsoleLine(args)) return;
  origLog.apply(console, args);
 };
 // When not in DEBUG_STACKS mode, console.warn/error are never called by the logger,
 // but third-party code may still use them. Intercept to suppress ReactFabric noise.
 if (!DEBUG_STACKS) {
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => {
   if (shouldSuppressConsoleLine(args)) return;
   origWarn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
   if (shouldSuppressConsoleLine(args)) return;
   origError.apply(console, args);
  };
 }
}

/**
 * Generate a stable trace ID for a single scan attempt (camera / library pick / batch item).
 * Format: scan_<timestamp>_<rand6>
 * Attach this to every log line in the flow so you can filter to one run:
 * grep traceId=scan_1234567890_abc logs.txt
 */
export function makeScanTraceId(): string {
 const rand = Math.random().toString(36).slice(2, 8);
 return `scan_${Date.now()}_${rand}`;
}

/**
 * Short batch trace ID for user-initiated scan batch (e.g. "Scan 3 photos").
 * Format: S-<4 hex chars> — e.g. S-8F2A. Include in every log for that batch to filter quickly.
 * Usage: const traceId = makeBatchTraceId(); logger.cat('[SCAN_BATCH]', '', { traceId, ... });
 */
export function makeBatchTraceId(): string {
 const hex = Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
 return `S-${hex}`;
}

/**
 * One compact line per scan milestone. Replaces hundreds of lines with 5 lines per session.
 * stepA: photos_enqueued=N
 * stepB: uploads_ok=N uploads_fail=N
 * stepC: jobs_created=N
 * stepD: jobs_completed=N jobs_failed=N
 * stepE: books_created=N pending=N approved=N attach_ok_photos=N join_mismatch=false
 */
export function logScanMilestone(
  traceId: string,
  step: 'stepA' | 'stepB' | 'stepC' | 'stepD' | 'stepE',
  data: Record<string, string | number | boolean | undefined | null>
): void {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  const msg = parts.length ? parts.join(' ') : '';
  log('info', '[SCAN_SUMMARY]', `${step} ${msg}`.trim(), { traceId });
}

/**
 * Emit a single compact JSON summary at the end of a scan attempt.
 * Paste this + any error blocks when filing bugs — all the signal in one line.
 */
export function logScanSummary(summary: {
  traceId: string;
  /**
   * success       — all jobs completed on server and all imports succeeded
   * import_failed — server job(s) succeeded but ≥1 local import failed (retryable)
   * partial       — some server jobs failed, some succeeded
   * fail          — all server jobs failed
   * canceled      — every job was canceled before completing (user pressed X)
   */
  outcome: 'success' | 'fail' | 'partial' | 'import_failed' | 'canceled';
  jobId?: string | null;
  scanJobId?: string | null;
  photoId?: string | null;
  batchId?: string | null;
  counts: {
    detected?: number;
    imported?: number;
    saved?: number;
    failed?: number;
    importFailed?: number;
    /** Number of jobs that hit server terminal 'completed' (superset of importFailed). */
    jobsCompleted?: number;
    jobsCanceled?: number;
  };
 timings?: {
 uploadMs?: number;
 scanMs?: number;
 dbMs?: number;
 };
 topErrors?: string[];
}): void {
 log('info', '[SCAN_SUMMARY]', '', summary);
}

// ---------------------------------------------------------------------------
// Standalone convenience exports (mirrors logger methods for import ergonomics)
// ---------------------------------------------------------------------------

/** Emit exactly once per app run. @see logger.logOnce */
export function logOnce(key: string, level: Level, tag: string, msg: string, data?: any): void {
 logger.logOnce(key, level, tag, msg, data);
}

/** Throttle to at most once per `ms` ms. @see logger.logThrottle */
export function logThrottle(key: string, ms: number, level: Level, tag: string, msg: string, data?: any): void {
 logger.logThrottle(key, ms, level, tag, msg, data);
}

// ── Call-count state (module-level, survives re-renders) ─────────────────────
const everyNCounts = new Map<string, number>();

/**
 * Emit the log on the 1st call and then every Nth call after that.
 * Useful for sampling high-frequency loops (e.g. poll ticks, render loops) without
 * flooding the output — you see the first hit immediately, then periodic updates.
 *
 * Usage:
 *   logEveryN('scan_poll_tick', 10, 'debug', '[SCAN_POLL_TICK]', '', { status, elapsed })
 *   // → logs on call 1, 11, 21, 31, …
 */
export function logEveryN(
 key: string,
 n: number,
 level: Level,
 tag: string,
 msg: string,
 data?: any
): void {
 const count = (everyNCounts.get(key) ?? 0) + 1;
 everyNCounts.set(key, count);
 if (count === 1 || count % n === 0) {
  log(level, tag, msg, data === undefined ? undefined : { ...((data && typeof data === 'object') ? data : { value: data }), _callN: count });
 }
}

export default logger;
