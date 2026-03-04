/**
 * GET /api/cover-status?workKeys=isbn13:xxx,ta:yyy,... OR ?bookIds=uuid1,uuid2,...
 * workKeys: returns { resolved: [{ work_key, coverUrl }] } for work_keys that are ready.
 * bookIds: returns { byBookId: { [bookId]: coverUrl } } by joining cover_resolution_books -> cover_resolutions (bulletproof, no hash mismatch).
 * When bookIds is provided, Authorization: Bearer required; only covers for the user's books are returned.
 * Auth: supabase.auth.getUser(token) Supabase handles RS256 + JWKS internally.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getSupabase, getStoragePublicUrl } from '../lib/coverResolution';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Cache-Control', 'no-store');
 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'GET') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const db = getSupabase();
 if (!db) {
 return res.status(500).json({ error: 'Storage not configured', resolved: [], byBookId: {} });
 }

 const bookIdsParam = typeof req.query.bookIds === 'string' ? req.query.bookIds : '';
 const bookIds = bookIdsParam
 .split(',')
 .map(k => k.trim())
 .filter(Boolean)
 .slice(0, 100);

 if (bookIds.length > 0) {
 const auth = req.headers.authorization;
 const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
 if (!token) {
 return res.status(401).json({ error: 'Unauthorized', resolved: [], byBookId: {} });
 }
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !serviceKey) {
 return res.status(500).json({ error: 'Server not configured', resolved: [], byBookId: {} });
 }
 const supabase = createClient(supabaseUrl, serviceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });
 const { data, error } = await supabase.auth.getUser(token);
 if (error || !data?.user) {
 return res.status(401).json({ error: 'invalid token', resolved: [], byBookId: {} });
 }
 const userId = data.user.id;
 const { data: rows } = await db
 .from('cover_resolution_books')
 .select('book_id, work_key')
 .in('book_id', bookIds);
 if (!rows?.length) {
 return res.status(200).json({ resolved: [], byBookId: {} });
 }
 const workKeysFromBooks = [...new Set(rows.map((r: any) => r.work_key).filter(Boolean))];
 const { data: covRows } = await db
 .from('cover_resolutions')
 .select('work_key, cover_storage_path')
 .in('work_key', workKeysFromBooks)
 .in('status', ['ready', 'resolved'])
 .not('cover_storage_path', 'is', null);
 const pathByWorkKey: Record<string, string> = {};
 if (Array.isArray(covRows)) {
 for (const r of covRows) {
 if (r?.work_key && r?.cover_storage_path) pathByWorkKey[r.work_key] = getStoragePublicUrl(r.cover_storage_path);
 }
 }
 const byBookId: Record<string, string> = {};
 for (const r of rows as { book_id: string; work_key: string }[]) {
 const url = pathByWorkKey[r.work_key];
 if (url) byBookId[r.book_id] = url;
 }
 const { data: books } = await db.from('books').select('id').eq('user_id', userId).in('id', Object.keys(byBookId));
 const allowedIds = new Set((books || []).map((b: any) => b.id));
 const filtered: Record<string, string> = {};
 for (const [id, url] of Object.entries(byBookId)) {
 if (allowedIds.has(id)) filtered[id] = url;
 }
 return res.status(200).json({ resolved: [], byBookId: filtered });
 }

 const workKeysParam = typeof req.query.workKeys === 'string' ? req.query.workKeys : '';
 const workKeys = workKeysParam
 .split(',')
 .map(k => k.trim())
 .filter(Boolean)
 .slice(0, 100);

 if (workKeys.length === 0) {
 return res.status(200).json({ resolved: [], byBookId: {} });
 }

 const { data } = await db
 .from('cover_resolutions')
 .select('work_key, cover_storage_path')
 .in('work_key', workKeys)
 .in('status', ['ready', 'resolved'])
 .not('cover_storage_path', 'is', null);

 const resolved: { work_key: string; coverUrl: string }[] = [];
 if (Array.isArray(data)) {
 for (const row of data) {
 const path = row?.cover_storage_path;
 if (row?.work_key && path != null && path !== '') {
 resolved.push({
 work_key: row.work_key,
 coverUrl: getStoragePublicUrl(path),
 });
 }
 }
 }

 return res.status(200).json({ resolved, byBookId: {} });
}
