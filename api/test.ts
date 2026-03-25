import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Health check only — no env details, no stack traces in production.
  return res.status(200).json({ status: 'ok' });
}
