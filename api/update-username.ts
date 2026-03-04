import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { sanitizeTextForDb } from '../lib/sanitizeTextForDb';

/**
 * POST /api/update-username
 * Body: { username: string }
 * Authorization: Bearer <Supabase access_token>
 * Updates the authenticated user's profile username in the backend.
 * Auth: supabase.auth.getUser(token) Supabase handles RS256 + JWKS internally.
 */
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

 // Log which host/URL this request hit (same idea as [ENQUEUE_URL] for scans)
 console.log('[USERNAME_SAVE_URL]', {
 url: req.url,
 host: req.headers.host,
 'x-forwarded-host': req.headers['x-forwarded-host'],
 });
 const auth = req.headers.authorization || '';
 const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
 if (!token) {
 return res.status(401).json({ error: 'Missing token', message: 'Missing or invalid Authorization header' });
 }

 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseUrl || !serviceKey) {
 return res.status(500).json({ error: 'Server configuration error' });
 }

 const supabase = createClient(supabaseUrl, serviceKey, {
 auth: { autoRefreshToken: false, persistSession: false },
 });

 const { data: userData, error: userErr } = await supabase.auth.getUser(token);
 if (userErr || !userData?.user) {
 return res.status(401).json({ error: 'Invalid token', details: userErr ?? undefined, message: userErr?.message || 'Invalid or expired token' });
 }
 const userId = userData.user.id;

 const { username } = req.body;
 if (!username || typeof username !== 'string') {
 return res.status(400).json({ error: 'Username required', message: 'Please provide a valid username.' });
 }

 const newUsername = username.trim().toLowerCase();
 const usernameRegex = /^[a-z0-9_]{3,20}$/;
 if (!usernameRegex.test(newUsername)) {
 return res.status(400).json({
 error: 'Invalid username',
 message: 'Username must be 320 characters and contain only letters, numbers, and underscores.',
 });
 }

 try {

 const { data: existing } = await supabase
 .from('profiles')
 .select('id')
 .eq('username', newUsername)
 .maybeSingle();

 if (existing && existing.id !== userId) {
 return res.status(409).json({ error: 'Username taken', message: 'This username is already taken. Please choose another.' });
 }

 const usernameForDb = sanitizeTextForDb(newUsername) ?? newUsername;
 const table = 'profiles';
 const column = 'username';
 const updatedAt = new Date().toISOString();

 const { data: returnedRow, error: updateError } = await supabase
 .from(table)
 .update({ username: usernameForDb, updated_at: updatedAt })
 .eq('id', userId)
 .select('id, username, updated_at')
 .single();

 // A) Definitive log after save: attempted username, returned row or error (confirm row actually changed)
 console.log('[USERNAME_SAVE] update response:', {
 returned: returnedRow ? { id: returnedRow.id, username: returnedRow.username, updated_at: returnedRow?.updated_at } : null,
 error: updateError?.message ?? null,
 rowChanged: returnedRow?.username === usernameForDb,
 });
 if (updateError) {
 console.error('[USERNAME_SAVE] error:', {
 attempted: newUsername,
 table,
 column,
 error: updateError.message,
 code: updateError.code,
 });
 if (updateError.code === '23505') {
 return res.status(409).json({ error: 'Username taken', message: 'This username is already taken. Please choose another.' });
 }
 return res.status(500).json({ error: 'Update failed', message: updateError.message || 'Failed to update username' });
 }
 const returnedDataLength = returnedRow ? 1 : 0;
 if (returnedDataLength === 0) {
 console.error('[USERNAME_SAVE] returnedDataLength: 0', { attempted: newUsername, table, column, userId });
 return res.status(500).json({ error: 'Update failed', message: 'No row returned after update' });
 }
 console.log('[USERNAME_SAVE] updated 1 row in profiles, returned', {
 id: returnedRow?.id,
 username: returnedRow?.username,
 updated_at: returnedRow?.updated_at,
 });

 return res.status(200).json({ success: true, username: (returnedRow?.username ?? usernameForDb) as string });
 } catch (err: any) {
 console.error('[API] update-username:', err);
 return res.status(500).json({ error: 'Server error', message: err?.message || 'Failed to update username' });
 }
}
