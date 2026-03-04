/**
 * Field-level merge for books. Prevents server from overwriting what the user approved.
 *
 * Rule: Merge must be field-level, not object replace.
 * - Identity (title, author): prefer local approved values unless server has explicit non-blank values for same book_key.
 * - Ids (id, dbId): prefer server (canonical) when present.
 * - Enrichment (description, coverUrl, etc.): prefer server when present, else keep local.
 * - Never let server blank/empty overwrite local non-empty for title/author.
 */
import type { Book } from '../types/BookTypes';
import { logger } from '../utils/logger';

/**
 * Generic merge-by-id helper. Merges `next` into `prev` by primary key `id`.
 * Server (next) wins for all fields via object spread, but local (prev) fields are
 * the base so no field is silently lost when the server omits it.
 * For books use mergeBookFieldLevel instead (which applies identity-lock rules).
 */
export function mergeById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const map = new Map<string, T>(prev.map((x) => [x.id, x]));
  for (const x of next) {
    map.set(x.id, { ...(map.get(x.id) ?? ({} as T)), ...x });
  }
  return Array.from(map.values());
}

function hasValue(s: string | undefined | null): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

/** Prefer non-empty; for strings treat blank as empty. */
function bestEnrichment<T>(server: T, local: T, isString = false): T {
  if (isString) {
    const s = server as string | undefined;
    const l = local as string | undefined;
    if (hasValue(s)) return server;
    if (hasValue(l)) return local;
    return (s ?? l ?? ('' as T)) as T;
  }
  return server != null && server !== '' ? server : (local ?? server);
}

type WinnerReason = 'local_locked' | 'local_nonempty' | 'server_nonempty' | 'local_fallback' | 'server_fallback';

function logMergeWinnerIfOverwrite(
  book_key: string,
  field: string,
  winner: WinnerReason,
  chosen: string | undefined,
  serverVal: string | undefined,
  localVal: string | undefined,
  local: Book
): void {
  const overwroteServer = serverVal !== undefined && chosen !== serverVal;
  const overwroteLocal = localVal !== undefined && chosen !== localVal;
  if (!overwroteServer && !overwroteLocal) return;
  logger.info('[MERGE_FIELD_WINNER]', {
    book_key,
    field,
    winner,
    local: { value: localVal, locked: local.identity_locked === true },
    server: { value: serverVal },
  });
}

/**
 * Merge two book records for the same logical book (same book_key).
 * - If local.identity_locked: identity fields (title, author, book_key) come from local.
 * - source_photo_id / source_scan_job_id are provenance IDs — identity_locked does NOT apply.
 *   Server value always wins for these. Caller must apply aliasMap rewrites BEFORE calling this
 *   so that a local alias (temp photo id) has already been resolved to its canonical UUID.
 * - Enrichment: best available (prefer non-empty server, else local).
 */
export function mergeBookFieldLevel(server: Book, local: Book, aliasMap?: Record<string, string>): Book {
  const locked = local.identity_locked === true;

  const book_key = locked ? (local.book_key ?? server.book_key) : (server.book_key ?? local.book_key);
  const book_keyWinner: WinnerReason = locked ? 'local_locked' : (server.book_key != null && server.book_key !== '' ? 'server_nonempty' : 'local_fallback');
  logMergeWinnerIfOverwrite(book_key ?? '', 'book_key', book_keyWinner, book_key, server.book_key, local.book_key, local);

  const title = locked
    ? (local.title ?? server.title ?? '')
    : hasValue(local.title)
      ? local.title!
      : hasValue(server.title)
        ? server.title!
        : (local.title ?? server.title ?? '');
  const titleWinner: WinnerReason = locked ? 'local_locked' : hasValue(local.title) ? 'local_nonempty' : hasValue(server.title) ? 'server_nonempty' : (local.title != null ? 'local_fallback' : 'server_fallback');
  logMergeWinnerIfOverwrite(book_key ?? '', 'title', titleWinner, title, server.title, local.title, local);

  const author = locked
    ? (local.author ?? server.author)
    : hasValue(local.author)
      ? local.author
      : hasValue(server.author)
        ? server.author
        : (local.author ?? server.author);
  const authorWinner: WinnerReason = locked ? 'local_locked' : hasValue(local.author) ? 'local_nonempty' : hasValue(server.author) ? 'server_nonempty' : (local.author != null ? 'local_fallback' : 'server_fallback');
  logMergeWinnerIfOverwrite(book_key ?? '', 'author', authorWinner, author, server.author, local.author, local);

  // Provenance IDs: identity_locked must NOT override. Server canonical always wins.
  // If caller provided aliasMap, resolve local alias → canonical before comparing.
  const localPhotoIdRaw = local.source_photo_id;
  const localPhotoId = (aliasMap && localPhotoIdRaw && aliasMap[localPhotoIdRaw]) ? aliasMap[localPhotoIdRaw] : localPhotoIdRaw;
  const source_photo_id = (server.source_photo_id != null && server.source_photo_id !== '')
    ? server.source_photo_id
    : (localPhotoId ?? server.source_photo_id);
  const source_photo_idWinner: WinnerReason = (server.source_photo_id != null && server.source_photo_id !== '') ? 'server_nonempty' : 'local_fallback';
  logMergeWinnerIfOverwrite(book_key ?? '', 'source_photo_id', source_photo_idWinner, source_photo_id, server.source_photo_id, local.source_photo_id, local);
  // Forensics: always log the ID decision for source_photo_id so we can trace alias vs canonical.
  {
    const wasAliased = localPhotoIdRaw !== localPhotoId;
    const reason: string = (server.source_photo_id != null && server.source_photo_id !== '')
      ? 'server_present'
      : wasAliased
        ? 'local_alias_resolved'
        : locked
          ? 'local_locked_override'
          : 'local_fallback';
    logger.debug('[MERGE_ID_DECISION]', {
      book_key,
      field: 'source_photo_id',
      localValue: localPhotoIdRaw,
      localLocked: locked,
      resolvedLocalValue: localPhotoId,
      serverValue: server.source_photo_id,
      winner: source_photo_id,
      reason,
      wasAliased,
    });
  }

  const localJobIdRaw = local.source_scan_job_id;
  const localJobId = (aliasMap && localJobIdRaw && aliasMap[localJobIdRaw]) ? aliasMap[localJobIdRaw] : localJobIdRaw;
  const source_scan_job_id = (server.source_scan_job_id != null && server.source_scan_job_id !== '')
    ? server.source_scan_job_id
    : (localJobId ?? server.source_scan_job_id);
  const source_scan_job_idWinner: WinnerReason = (server.source_scan_job_id != null && server.source_scan_job_id !== '') ? 'server_nonempty' : 'local_fallback';
  logMergeWinnerIfOverwrite(book_key ?? '', 'source_scan_job_id', source_scan_job_idWinner, source_scan_job_id, server.source_scan_job_id, local.source_scan_job_id, local);
  // Forensics: always log the ID decision for source_scan_job_id.
  {
    const wasAliased = localJobIdRaw !== localJobId;
    const reason: string = (server.source_scan_job_id != null && server.source_scan_job_id !== '')
      ? 'server_present'
      : wasAliased
        ? 'local_alias_resolved'
        : locked
          ? 'local_locked_override'
          : 'local_fallback';
    logger.debug('[MERGE_ID_DECISION]', {
      book_key,
      field: 'source_scan_job_id',
      localValue: localJobIdRaw,
      localLocked: locked,
      resolvedLocalValue: localJobId,
      serverValue: server.source_scan_job_id,
      winner: source_scan_job_id,
      reason,
      wasAliased,
    });
  }

  // readAt: keep whichever is more recent (user can mark read on either device).
  const readAt = (server.readAt && local.readAt)
    ? Math.max(server.readAt, local.readAt)
    : (server.readAt ?? local.readAt);

  return {
    ...server,
    ...local,
    title,
    author,
    book_key,
    source_photo_id,
    source_scan_job_id,
    id: server.id ?? local.id,
    dbId: server.dbId ?? local.dbId ?? server.id ?? local.id,
    description: bestEnrichment(server.description, local.description, true),
    coverUrl: bestEnrichment(server.coverUrl, local.coverUrl, true),
    localCoverPath: server.localCoverPath ?? local.localCoverPath,
    googleBooksId: server.googleBooksId ?? local.googleBooksId,
    work_key: server.work_key ?? local.work_key,
    pageCount: server.pageCount ?? local.pageCount,
    categories: (server.categories?.length ? server.categories : local.categories) ?? server.categories ?? local.categories,
    publisher: bestEnrichment(server.publisher, local.publisher, true),
    publishedDate: bestEnrichment(server.publishedDate, local.publishedDate, true),
    language: bestEnrichment(server.language, local.language, true),
    averageRating: server.averageRating ?? local.averageRating,
    ratingsCount: server.ratingsCount ?? local.ratingsCount,
    subtitle: bestEnrichment(server.subtitle, local.subtitle, true),
    printType: server.printType ?? local.printType,
    readAt,
    sync_state: local.sync_state ?? server.sync_state,
    sync_pending_at: local.sync_pending_at ?? server.sync_pending_at,
    identity_locked: local.identity_locked ?? server.identity_locked,
    enrichment_status: server.enrichment_status ?? local.enrichment_status,
  } as Book;
}
