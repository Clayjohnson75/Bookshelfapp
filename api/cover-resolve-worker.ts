import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import pLimit from 'p-limit';
import { Receiver } from '@upstash/qstash';
import { getSupabase, resolveOne, updateScanJobBookCover } from '../lib/coverResolution';
import { runMetaEnrich } from '../lib/workers/metaEnrich';

const COVER_CONCURRENCY = 5;
const limit = pLimit(COVER_CONCURRENCY);

export const config = { api: { bodyParser: false } };
export const maxDuration = 120;

const receiver = new Receiver({
 currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
 nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
});

interface CoverResolveItem {
 workKey: string;
 isbn?: string;
 title?: string;
 author?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
 if (req.method !== 'POST') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const hasSignature = !!(req.headers['upstash-signature'] || req.headers['x-qstash-signature']);
 if (!hasSignature) {
 return res.status(401).json({ error: 'Missing QStash signature' });
 }

 let rawBody: Buffer;
 try {
 rawBody = await getRawBody(req);
 } catch {
 return res.status(400).json({ error: 'Failed to read body' });
 }

 const signature = (req.headers['upstash-signature'] || req.headers['x-qstash-signature']) as string | undefined;
 try {
 await receiver.verify({
 signature: signature!,
 body: rawBody.toString('utf-8'),
 });
 } catch {
 return res.status(401).json({ error: 'Invalid QStash signature' });
 }

 let body: { items?: CoverResolveItem[]; jobId?: string };
 try {
 body = JSON.parse(rawBody.toString('utf-8'));
 } catch {
 return res.status(400).json({ error: 'Invalid JSON body' });
 }

 const items = Array.isArray(body?.items) ? body.items : [];
 const jobId = typeof body?.jobId === 'string' ? body.jobId : undefined;
 if (items.length === 0) {
 return res.status(200).json({ ok: true, resolved: 0 });
 }
 if (items.length > 50) {
 return res.status(400).json({ error: 'Max 50 items per batch' });
 }

 const db = getSupabase();
 if (!db) {
 return res.status(500).json({ error: 'Storage not configured' });
 }

 const tasks = items
 .filter(item => item.workKey?.trim())
 .map(item =>
 limit(async () => {
 const { workKey, isbn = '', title = '', author = '' } = item;
 try {
 const result = await resolveOne(db, isbn, title, author, workKey);
 if (result && 'coverUrl' in result && result.coverUrl) {
 if (jobId) {
 await updateScanJobBookCover(db, jobId, workKey, result.coverUrl);
 }
 return 1;
 }
 } catch (err: any) {
 console.warn(`[cover-resolve-worker] Failed for workKey=${workKey}:`, err?.message);
 }
 return 0;
 })
 );
 const counts = await Promise.all(tasks);
 const resolved = counts.reduce((a, b) => a + b, 0);

 console.log(`[cover-resolve-worker] Resolved ${resolved}/${items.length} covers (max ${COVER_CONCURRENCY} concurrent)`);

 // Chain metadata enrichment directly (no HTTP) do NOT fetch /api/meta-enrich-worker (would hit Deployment Protection 401)
 if (jobId && db) {
 let scanJobId: string | null = null;
 try {
 const { canonicalJobId, toRawScanJobUuid } = await import('../lib/scanId');
 const canonicalId = canonicalJobId(jobId) ?? jobId;
 const { data: row } = await db.from('scan_jobs').select('job_uuid').eq('id', canonicalId).maybeSingle();
 scanJobId = row?.job_uuid != null ? String(row.job_uuid) : toRawScanJobUuid(canonicalId);
 } catch (_) {
 // ignore
 }
 if (scanJobId) {
 try {
 const metaResult = await runMetaEnrich({ scanJobId });
 if (!metaResult.ok) {
 console.warn(`[cover-resolve-worker] meta-enrich failed: ${metaResult.error}`);
 }
 } catch (err: any) {
 console.warn('[cover-resolve-worker] meta-enrich error:', err?.message);
 }
 }
 }

 return res.status(200).json({ ok: true, resolved });
}
