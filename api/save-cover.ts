/**
 * POST /api/save-cover
 * Fetches a cover image from a URL (e.g. Google Books), uploads to our storage,
 * updates cover_resolutions for caching, and returns a stable public URL.
 * Use this when a user selects a new cover - Google URLs expire and turn gray.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { buildWorkKey, acceptableCover, getStoragePublicUrl, resizeCoverForStorage, pickCoverResPayload } from '../lib/coverResolution';
import { workKeyToStoragePath } from '../lib/workKey';

const BUCKET = 'book-covers';
const CACHE_MAX_AGE = '31536000'; // 1 year in seconds

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'BookshelfScanner/1.0' } });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: 'invalid token', message: error?.message || 'Unauthorized' });
  }
  const userId = data.user.id;

  const body = req.body as { coverUrl?: string; title?: string; author?: string; isbn?: string; googleBooksId?: string };
  const coverUrl = typeof body?.coverUrl === 'string' ? body.coverUrl.trim() : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const author = typeof body?.author === 'string' ? body.author : '';
  const isbn = typeof body?.isbn === 'string' ? body.isbn.trim() : '';
  const googleBooksId = typeof body?.googleBooksId === 'string' ? body.googleBooksId.trim() : '';

  if (!coverUrl || (!title && !isbn)) {
    return res.status(400).json({ ok: false, error: 'coverUrl and (title or isbn) required' });
  }

  const workKey = buildWorkKey(isbn, title, author);
  const buffer = await fetchImageBuffer(coverUrl);
  if (!buffer || buffer.length < 100) {
    return res.status(400).json({ ok: false, error: 'Could not fetch or invalid image' });
  }
  const check = await acceptableCover(buffer);
  if (!check.ok) {
    return res.status(400).json({ ok: false, error: 'cover too small', detail: { bytes: check.bytes, width: check.width, height: check.height } });
  }

  const path = workKeyToStoragePath(workKey, '.jpg');
  if (!path) {
    return res.status(400).json({ ok: false, error: 'Invalid work key' });
  }
  const resized = await resizeCoverForStorage(buffer);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, resized, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: CACHE_MAX_AGE,
    });

  if (uploadError) {
    console.error('[save-cover] Storage upload error:', uploadError);
    return res.status(500).json({ ok: false, error: 'Failed to save cover' });
  }

  const now = new Date().toISOString();
  const payload = pickCoverResPayload({
    work_key: workKey,
    cover_storage_path: path,
    source: 'google',
    status: 'ready',
    width: check.width ?? null,
    height: check.height ?? null,
    mime: 'image/jpeg',
    updated_at: now,
  });
  await supabase
    .from('cover_resolutions')
    .upsert(payload, { onConflict: 'work_key' });

  const storageUrl = getStoragePublicUrl(path);
  return res.status(200).json({
    ok: true,
    coverUrl: storageUrl,
    googleBooksId: googleBooksId || workKey.split('.')[0],
  });
}
