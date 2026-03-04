/**
 * Meta-enrich-worker: server-side metadata enrichment. Open Library primary, Google Books fallback only if no description.
 * Global cache book_metadata_cache. Concurrency 5. Never log full descriptions (descLen only).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runMetaEnrich } from '../lib/workers/metaEnrich';

export const config = { api: { bodyParser: true } };
export const maxDuration = 120;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body || {}) as { scanJobId?: string; bookIds?: string[] };
  const result = await runMetaEnrich({
    scanJobId: body.scanJobId,
    bookIds: body.bookIds,
  });

  if (!result.ok) {
    const status = result.statusCode ?? 500;
    return res.status(status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    enriched: result.enriched,
    total: result.total,
    failed: result.failed,
    not_found: result.not_found,
  });
}
