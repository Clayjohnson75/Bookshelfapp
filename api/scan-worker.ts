import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/scan-worker
 * Worker endpoint that processes scan jobs
 * Called by QStash (or directly for testing)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // QStash sends the payload in req.body
    const { jobId, scanId, userId, imageDataURL } = req.body || {};
    
    if (!jobId || !scanId || !imageDataURL) {
      console.error('[API] [WORKER] Missing required fields:', { jobId, scanId, hasImage: !!imageDataURL });
      return res.status(400).json({ error: 'jobId, scanId, and imageDataURL required' });
    }

    console.log(`[API] [WORKER] [SCAN ${scanId}] [JOB ${jobId}] Starting worker processing...`);
    
    // Import the processScanJob function from scan.ts (now exported)
    const { processScanJob } = await import('./scan');
    
    // Process the job (this is the heavy work: Gemini + OpenAI + validation)
    // This can take 60-90+ seconds, but QStash allows long-running workers
    await processScanJob(imageDataURL, userId, scanId, jobId);
    
    console.log(`[API] [WORKER] [SCAN ${scanId}] [JOB ${jobId}] Worker processing completed`);
    
    // Return success - QStash will mark the message as processed
    return res.status(200).json({ success: true, jobId });
    
  } catch (e: any) {
    console.error('[API] [WORKER] Error in scan worker:', e);
    return res.status(500).json({ error: 'worker_failed', detail: e?.message || String(e) });
  }
}

