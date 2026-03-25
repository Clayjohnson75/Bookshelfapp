import type { VercelRequest, VercelResponse } from '@vercel/node';

// Disabled in production — was exposing QStash internals without auth.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(404).json({ error: 'Not found' });
}
