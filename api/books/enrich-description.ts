/**
 * POST /api/books/enrich-description
 * Enrich one book's description (Google Books Open Library).
 * Lookup order (resilient to DB wiped / devprod mismatch / stale local dbId):
 * 1) Try by (id, user_id). If found, use that row.
 * 2) If not found and book_key present try (user_id, book_key).
 * 3) If still not found and book_key present upsert stub by (user_id, book_key) and use that row.
 * Client can send both dbId and book_key; fallback to book_key when id is missing in current DB.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { fetchDescriptionForBook } from '../../lib/enrichDescription';
import { sanitizeTextForDb } from '../../lib/sanitizeTextForDb';
import { checkRateLimit, sendRateLimitResponse } from '../../lib/rateLimit';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 if (req.method !== 'POST') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const auth = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
 if (!auth) {
 return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required.' });
 }

 const body = req.body as { dbId?: string; bookId?: string; book_key?: string; title?: string; author?: string; isbn?: string };
 const dbIdFromBody = typeof body?.dbId === 'string' ? body.dbId.trim() : null;
 const bookIdFromBody = typeof body?.bookId === 'string' ? body.bookId.trim() : null;
 const bookKey = typeof body?.book_key === 'string' ? body.book_key.trim() : null;
 const titleFromBody = typeof body?.title === 'string' ? body.title.trim() : null;
 const authorFromBody = typeof body?.author === 'string' ? body.author.trim() : null;
 const isbnFromBody = typeof body?.isbn === 'string' ? body.isbn.trim() : null;
 const bookId = dbIdFromBody || bookIdFromBody;
 if (!bookId && !bookKey) {
 return res.status(400).json({ error: 'Bad request', message: 'dbId (or bookId) or book_key required.' });
 }

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !serviceKey) {
 return res.status(500).json({ error: 'Server configuration error' });
 }

 const supabaseRef = (() => {
 try {
 const u = new URL(supabaseUrl);
 return u.hostname || supabaseUrl.replace(/^https?:\/\//, '').split('/')[0] || 'unknown';
 } catch {
 return 'unknown';
 }
 })();

 const supabase = createClient(supabaseUrl, serviceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });

 const { data: userData, error: userErr } = await supabase.auth.getUser(auth);
 if (userErr || !userData?.user) {
 return res.status(401).json({ error: 'Invalid token', message: userErr?.message || 'Invalid or expired token.' });
 }
 const userId = userData.user.id;
 console.info('[ENRICH_REQUEST]', {
 dbId: bookId ?? null,
 book_key: bookKey ?? null,
 userId,
 });
 console.info('[DESC_ENRICH_REQ]', {
 userId: userId.slice(0, 8) + '',
 hasDbId: !!bookId,
 hasBookKey: !!bookKey,
 hasTitle: !!titleFromBody,
 hasAuthor: !!authorFromBody,
 hasIsbn: !!isbnFromBody,
 });

 const enrichRateLimitResult = await checkRateLimit(req, 'enrich', { userId });
 if (!enrichRateLimitResult.success) {
 sendRateLimitResponse(res, enrichRateLimitResult);
 return;
 }

 const lookupMode = bookId && bookKey ? 'both' : bookKey ? 'book_key' : 'dbId';
 console.info('[ENRICH_LOOKUP]', {
 supabaseRef,
 lookupMode,
 userId: userId.slice(0, 8) + '',
 byId: bookId ?? null,
 byBookKey: bookKey ? `${bookKey.slice(0, 40)}${bookKey.length > 40 ? '' : ''}` : null,
 });

 type BookRow = {
 id: string;
 user_id: string;
 book_key: string | null;
 title: string | null;
 author: string | null;
 isbn: string | null;
 google_books_id: string | null;
 description: string | null;
 description_source: string | null;
 enrichment_status: string | null;
 };
 let book: BookRow | null = null;
 let lookupPath: 'by_id' | 'by_book_key' | 'stub_upserted' | null = null;

 // 1) Try by (id, user_id) first client may have dbId that no longer exists in this DB (wiped / devprod mismatch).
 if (bookId) {
 const filterById = { id: bookId, user_id: userId };
 const { data, error: bookErr } = await supabase
 .from('books')
 .select('id, user_id, book_key, title, author, isbn, google_books_id, description, description_source, enrichment_status')
 .eq('id', bookId)
 .eq('user_id', userId)
 .maybeSingle();
 const rowCount = bookErr ? -1 : (data ? 1 : 0);
 console.info('[ENRICH_LOOKUP]', { step: 'by_id', filter: filterById, found: !!data, rowCount, error: bookErr?.message ?? null });
 if (!bookErr) {
 book = data;
 if (book) lookupPath = 'by_id';
 }
 if (!book && bookKey) {
 console.info('[ENRICH_LOOKUP]', { fallback: 'id_not_found_trying_book_key', bookId });
 }
 }

 // 2) If not found and book_key present try (user_id, book_key).
 if (!book && bookKey) {
 const filterByKey = { user_id: userId, book_key: bookKey, deleted_at: null };
 const { data, error: keyErr } = await supabase
 .from('books')
 .select('id, user_id, book_key, title, author, isbn, google_books_id, description, description_source, enrichment_status')
 .eq('user_id', userId)
 .eq('book_key', bookKey)
 .is('deleted_at', null)
 .maybeSingle();
 const rowCount = keyErr ? -1 : (data ? 1 : 0);
 console.info('[ENRICH_LOOKUP]', { step: 'by_book_key', filter: filterByKey, found: !!data, rowCount, error: keyErr?.message ?? null });
 console.info('[ENRICH_FALLBACK]', {
 tried_by_book_key: true,
 found: !!data,
 userId,
 book_key: bookKey,
 });
 if (!keyErr) {
 book = data;
 if (book) lookupPath = 'by_book_key';
 }
 }

 // 3) If still not found and book_key present upsert stub and use that row.
 if (!book && bookKey) {
 const nowIso = new Date().toISOString();
 const row = {
 user_id: userId,
 book_key: bookKey,
 title: sanitizeTextForDb(titleFromBody ?? '') ?? '',
 author: sanitizeTextForDb(authorFromBody ?? '') ?? null,
 isbn: isbnFromBody ? (sanitizeTextForDb(isbnFromBody) ?? isbnFromBody) : null,
 status: 'approved',
 updated_at: nowIso,
 };
 console.info('[ENRICH_LOOKUP]', { step: 'upsert_stub', reason: 'not_found_by_id_or_key', book_key: bookKey.slice(0, 40) + (bookKey.length > 40 ? '' : '') });
 const { data: upserted, error: upsertErr } = await supabase
 .from('books')
 .upsert(row, { onConflict: 'user_id,book_key' })
 .select('id, user_id, book_key, title, author, isbn, google_books_id, description, description_source, enrichment_status');
 const rowResult = Array.isArray(upserted) ? upserted[0] : upserted;
 console.info('[ENRICH_STUB_CREATE]', {
 insertedId: (rowResult as any)?.id ?? null,
 error: upsertErr?.message ?? null,
 row,
 });
 if (!upsertErr && rowResult) {
 book = rowResult as BookRow;
 lookupPath = 'stub_upserted';
 console.info('[DESC_BACKEND_SAVE]', { book_key: bookKey, created: true, id: book.id });
 }
 }

 if (!book) {
 console.warn('[ENRICH_LOOKUP]', { outcome: 'row_not_found', supabaseRef, lookupMode, byId: bookId ?? null, byBookKey: !!bookKey });
 return res.status(404).json({ error: 'Not found', message: 'Book not found. Send book_key (and optionally title/author) to create and enrich, or dbId of an existing book.' });
 }
 if (book.user_id !== userId) {
 console.warn('[ENRICH_LOOKUP]', { outcome: 'forbidden_owner_mismatch', bookId: book.id, bookUserId: book.user_id?.slice(0, 8) + '', requestUserId: userId.slice(0, 8) + '' });
 return res.status(403).json({ error: 'Forbidden', message: 'You do not own this book.' });
 }
 const resolvedBookId = book.id;
 const hadDescription = !!(book.description && String(book.description).trim());
 console.info('[DESC_ENRICH_ROW_LOOKUP]', {
 lookupPath: lookupPath ?? 'by_id',
 resolvedBookId,
 resolvedBookKey: book.book_key ?? bookKey ?? null,
 existingDescLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 existingStatus: book.enrichment_status ?? null,
 });
 console.info('[ENRICH_LOOKUP]', { outcome: 'found', bookId: resolvedBookId, hadDescription });

 const nowIso = new Date().toISOString();

 if (book.description && String(book.description).trim()) {
 console.info('[DESC_BACKEND_SAVE]', {
 bookId: resolvedBookId,
 hasDescription: true,
 length: book.description?.length ?? 0,
 source: book.description_source ?? 'already_present',
 });
 const { data: updatedRows, error: updateErr } = await supabase
 .from('books')
 .update({
 enrichment_status: 'complete',
 enrichment_updated_at: nowIso,
 updated_at: nowIso,
 })
 .eq('id', resolvedBookId)
 .select('id');
 console.info('[DESC_ENRICH_DB_UPDATE]', {
 bookId: resolvedBookId,
 updatedRows: updatedRows?.length ?? 0,
 newStatus: 'complete',
 newDescLen: typeof book.description === 'string' ? book.description.trim().length : 0,
 error: updateErr?.message ?? null,
 });
 if (updateErr) {
 return res.status(500).json({ error: 'Update failed', message: updateErr.message });
 }
 const payloadAlready = {
 ok: true,
 bookId: resolvedBookId,
 enrichment_status: 'complete',
 description: book.description ?? null,
 description_source: book.description_source ?? null,
 };
 const descLenReturning = typeof payloadAlready.description === 'string' ? payloadAlready.description.length : 0;
 console.info('[ENRICH_RESPONSE]', {
 bookId: payloadAlready.bookId,
 descLenReturning,
 keys: Object.keys(payloadAlready),
 });
 return res.status(200).json(payloadAlready);
 }

 const result = await fetchDescriptionForBook({
 title: book.title,
 author: book.author,
 isbn: book.isbn,
 google_books_id: book.google_books_id,
 });
 const provider = 'status' in result ? null : result.source;
 const providerAttempts = provider === 'google_books'
 ? ['google_books']
 : ['google_books', 'open_library'];
 const providerDescLen = 'status' in result ? 0 : (typeof result.description === 'string' ? result.description.trim().length : 0);
 console.info('[DESC_PROVIDER_RESULT]', {
 provider,
 attempts: providerAttempts,
 descLen: providerDescLen,
 googleBooksIdUsed: !!book.google_books_id,
 googleBooksIdFound: provider === 'google_books',
 olWorkKey: null,
 });

 if (result.status === 'not_found') {
 console.info('[ENRICH_LOOKUP]', { outcome: 'found_but_providers_not_found', bookId: resolvedBookId, hadDescription: false });
 const { data: updatedRows, error: updateErr } = await supabase
 .from('books')
 .update({
 enrichment_status: 'not_found',
 enrichment_updated_at: nowIso,
 updated_at: nowIso,
 })
 .eq('id', resolvedBookId)
 .select('id');
 console.info('[DESC_ENRICH_DB_UPDATE]', {
 bookId: resolvedBookId,
 updatedRows: updatedRows?.length ?? 0,
 newStatus: 'not_found',
 newDescLen: 0,
 error: updateErr?.message ?? null,
 });
 if (updateErr) {
 return res.status(500).json({ error: 'Update failed', message: updateErr.message });
 }
 const payloadNotFound = {
 ok: true,
 bookId: resolvedBookId,
 enrichment_status: 'not_found',
 description: null,
 description_source: null,
 };
 console.info('[ENRICH_RESPONSE]', {
 bookId: payloadNotFound.bookId,
 descLenReturning: 0,
 keys: Object.keys(payloadNotFound),
 });
 return res.status(200).json(payloadNotFound);
 }

 console.info('[DESC_BACKEND_SAVE]', {
 bookId: resolvedBookId,
 hasDescription: !!result.description,
 length: result.description?.length ?? 0,
 source: result.source,
 });
 const { data: updatedRows, error: updateErr } = await supabase
 .from('books')
 .update({
 description: result.description,
 description_source: result.source,
 enrichment_status: 'complete',
 enrichment_updated_at: nowIso,
 updated_at: nowIso,
 })
 .eq('id', resolvedBookId)
 .select('id');
 console.info('[DESC_ENRICH_DB_UPDATE]', {
 bookId: resolvedBookId,
 updatedRows: updatedRows?.length ?? 0,
 newStatus: 'complete',
 newDescLen: typeof result.description === 'string' ? result.description.trim().length : 0,
 error: updateErr?.message ?? null,
 });
 if (updateErr) {
 return res.status(500).json({ error: 'Update failed', message: updateErr.message });
 }

 const payloadEnriched = {
 ok: true,
 bookId: resolvedBookId,
 enrichment_status: 'complete',
 description: result.description ?? null,
 description_source: result.source ?? null,
 };
 const descLenReturning = typeof payloadEnriched.description === 'string' ? payloadEnriched.description.length : 0;
 console.info('[ENRICH_RESPONSE]', {
 bookId: payloadEnriched.bookId,
 descLenReturning,
 keys: Object.keys(payloadEnriched),
 });
 return res.status(200).json(payloadEnriched);
}
