import type { VercelRequest, VercelResponse } from '@vercel/node';

// Basic helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalize(s?: string) {
  return (s || '').trim().toLowerCase();
}

function dedupeBooks(books: any[]) {
  const map: Record<string, any> = {};
  for (const b of books || []) {
    const k = `${normalize(b.title)}|${normalize(b.author)}`;
    if (!map[k]) map[k] = b;
  }
  return Object.values(map);
}

async function withRetries<T>(fn: () => Promise<T>, tries = 2, backoffMs = 800): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await delay(backoffMs * (i + 1));
    }
  }
  throw last;
}

async function scanWithOpenAI(imageDataURL: string): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Scan this image and return ALL visible book spines as JSON.
Return only an array of objects: [{"title":"...","author":"...","confidence":"high|medium|low"}] with no extra text.`,
              },
              { type: 'image_url', image_url: { url: imageDataURL } },
            ],
          },
        ],
        max_tokens: 1200,
        temperature: 0.1,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    let content = data.choices?.[0]?.message?.content?.trim() || '';
    if (content.includes('```')) {
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    }
    if (!content.startsWith('[')) return [];
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function scanWithGemini(imageDataURL: string): Promise<any[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Scan book spines and return only JSON array: [{"title":"...","author":"...","confidence":"high|medium|low"}] no explanations.`,
              },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
            ],
          },
        ],
        generationConfig: { temperature: 0.1, maxOutputTokens: 6000 },
      }),
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  let content = '';
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    content = data.candidates[0].content.parts[0].text;
  } else if (data.candidates?.[0]?.text) {
    content = data.candidates[0].text;
  }
  if (!content) return [];
  if (content.includes('```')) {
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  }
  content = content.trim();
  if (!content.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { imageDataURL } = req.body || {};
    if (!imageDataURL || typeof imageDataURL !== 'string') {
      return res.status(400).json({ error: 'imageDataURL required' });
    }

    const [openai, gemini] = await Promise.all([
      withRetries(() => scanWithOpenAI(imageDataURL), 2, 1200).catch(() => []),
      withRetries(() => scanWithGemini(imageDataURL), 2, 1200).catch(() => []),
    ]);
    const merged = dedupeBooks([...(openai || []), ...(gemini || [])]);
    return res.status(200).json({ books: merged });
  } catch (e: any) {
    return res.status(500).json({ error: 'scan_failed', detail: e?.message || String(e) });
  }
}
