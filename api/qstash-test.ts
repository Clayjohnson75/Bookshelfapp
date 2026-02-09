import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Test route to verify QStash JSON publish format
 * 
 * This isolates the QStash publish logic to test if the format is correct.
 * Call: GET /api/qstash-test
 * 
 * Returns QStash's raw response to verify the publish succeeded.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const qstashBase = process.env.QSTASH_URL;
  const token = process.env.QSTASH_TOKEN;
  const workerUrl = `${req.headers.origin ?? 'https://www.bookshelfscan.app'}/api/scan-worker`;

  if (!qstashBase) {
    return res.status(500).json({ error: 'QSTASH_URL not set' });
  }

  if (!token) {
    return res.status(500).json({ error: 'QSTASH_TOKEN not set' });
  }

  const publishEndpoint = `${qstashBase.replace(/\/$/, '')}/v2/publish`;
  const testPayload = { test: true, timestamp: new Date().toISOString() };

  console.log('[QSTASH-TEST] Publishing test message...');
  console.log('[QSTASH-TEST] Endpoint:', publishEndpoint);
  console.log('[QSTASH-TEST] Worker URL:', workerUrl);
  console.log('[QSTASH-TEST] Payload:', testPayload);

  try {
    const qstashRequestBody = {
      url: workerUrl,
      body: JSON.stringify(testPayload),
      headers: { 'Content-Type': 'application/json' },
    };

    const start = Date.now();
    const resp = await fetch(publishEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(qstashRequestBody),
    });

    const duration = Date.now() - start;
    const respText = await resp.text();

    console.log('[QSTASH-TEST] Response:', {
      status: resp.status,
      duration: `${duration}ms`,
      body: respText,
    });

    return res.status(200).json({
      success: resp.ok,
      status: resp.status,
      duration: `${duration}ms`,
      qstashResponse: respText,
      publishedTo: workerUrl,
      testPayload,
    });
  } catch (err: any) {
    console.error('[QSTASH-TEST] Error:', err);
    return res.status(500).json({
      error: 'Publish failed',
      message: err?.message,
      name: err?.name,
    });
  }
}


