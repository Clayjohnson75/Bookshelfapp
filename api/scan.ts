import type { VercelRequest, VercelResponse } from '@vercel/node';

// Basic helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalize(s?: string) {
  if (!s) return '';
  return s.trim()
    .toLowerCase()
    .replace(/[.,;:!?]/g, '') // Remove punctuation
    .replace(/\s+/g, ' '); // Normalize whitespace
}

function normalizeTitle(title?: string) {
  const normalized = normalize(title);
  // Remove "the", "a", "an" from the beginning
  return normalized.replace(/^(the|a|an)\s+/, '').trim();
}

function normalizeAuthor(author?: string) {
  const normalized = normalize(author);
  // Remove common suffixes
  return normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
}

function dedupeBooks(books: any[]) {
  const map: Record<string, any> = {};
  for (const b of books || []) {
    const k = `${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`;
    if (!map[k]) map[k] = b;
  }
  const deduped = Object.values(map);
  
  // Additional pass: check for near-duplicates (similar titles with same author)
  const final: any[] = [];
  for (const book of deduped) {
    const bookTitle = normalizeTitle(book.title);
    const bookAuthor = normalizeAuthor(book.author);
    
    let isDuplicate = false;
    for (const existing of final) {
      const existingTitle = normalizeTitle(existing.title);
      const existingAuthor = normalizeAuthor(existing.author);
      
      // If authors match and titles are very similar (one contains the other)
      if (bookAuthor === existingAuthor && bookAuthor && bookAuthor !== 'unknown' && bookAuthor !== 'unknown author') {
        if (bookTitle.length > 3 && existingTitle.length > 3) {
          if (bookTitle.includes(existingTitle) || existingTitle.includes(bookTitle)) {
            isDuplicate = true;
            break;
          }
        }
      }
    }
    
    if (!isDuplicate) {
      final.push(book);
    }
  }
  
  return final;
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
  const startTime = Date.now();
  const timeout = setTimeout(() => {
    const elapsed = Date.now() - startTime;
    console.error(`[API] OpenAI request timed out after ${elapsed}ms`);
    controller.abort();
  }, 45000); // 45s timeout - GPT-4o is much faster than GPT-5
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o', // Using GPT-4o for speed - no reasoning tokens, much faster than GPT-5
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
        max_tokens: 2000, // GPT-4o uses max_tokens, not max_completion_tokens
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[API] OpenAI scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    
    // Check for reasoning model response format (GPT-5 uses reasoning tokens)
    let content = '';
    const choice = data.choices?.[0];
    
    if (choice?.message?.content) {
      content = choice.message.content.trim();
    } else if (choice?.message?.refusal) {
      // Model refused to respond
      console.error(`[API] OpenAI refused: ${choice.message.refusal}`);
      return [];
    } else if (choice?.finish_reason === 'length') {
      // Hit token limit - check if there's any partial content
      console.error(`[API] OpenAI hit token limit. Usage:`, data.usage);
      // Try to get any partial content if available
      content = choice.message?.content?.trim() || '';
    }
    
    // Debug: log the full response structure if content is missing
    if (!content) {
      console.error(`[API] OpenAI response structure:`, JSON.stringify(data, null, 2).slice(0, 500));
    }
    
    console.log(`[API] OpenAI raw response length: ${content.length} chars`);
    if (content.length > 0) {
      console.log(`[API] OpenAI response preview: ${content.slice(0, 200)}...`);
    }
    
    if (!content) {
      console.error(`[API] OpenAI returned empty content. Full response:`, JSON.stringify(data).slice(0, 1000));
      return [];
    }
    
    // Remove markdown code blocks
    if (content.includes('```')) {
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }
    
    // Try to extract JSON array from response (might have text before/after)
    let parsed: any = null;
    
    // First try: parse entire content if it's pure JSON
    try {
      parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        console.log(`[API] OpenAI parsed ${parsed.length} books (direct JSON)`);
        return parsed;
      }
    } catch {}
    
    // Second try: find JSON array in content
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          console.log(`[API] OpenAI parsed ${parsed.length} books (extracted from text)`);
          return parsed;
        }
      } catch (e) {
        console.error(`[API] OpenAI failed to parse extracted JSON:`, e);
      }
    }
    
    console.error(`[API] OpenAI response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
    return [];
  } catch (e: any) {
    console.error(`[API] OpenAI scan exception:`, e?.message || String(e));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function scanWithGemini(imageDataURL: string, modelName: string = 'gemini-3-pro-preview'): Promise<any[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log(`[API] Gemini API key not set, skipping Gemini scan`);
    return [];
  }
  
  console.log(`[API] Starting Gemini scan with model: ${modelName}...`);
  const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
  
  const controller = new AbortController();
  const startTime = Date.now();
  const timeout = setTimeout(() => {
    const elapsed = Date.now() - startTime;
    console.error(`[API] Gemini request timed out after ${elapsed}ms`);
    controller.abort();
  }, 90000);
  
  try {
    const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
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
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[API] Gemini scan failed (${modelName}): ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
    
    // If 503 (overloaded), throw error so we can retry with different model
    if (res.status === 503) {
      const error = new Error(`Gemini ${modelName} overloaded (503)`);
      (error as any).isOverloaded = true; // Mark for fallback logic
      throw error;
    }
    return [];
  }
  const data = await res.json();
  
  // Debug: log the full response structure if content is missing
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text && !data.candidates?.[0]?.text) {
    console.error(`[API] Gemini response structure:`, JSON.stringify(data, null, 2).slice(0, 500));
  }
  
  let content = '';
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    content = data.candidates[0].content.parts[0].text;
  } else if (data.candidates?.[0]?.text) {
    content = data.candidates[0].text;
  }
  
  console.log(`[API] Gemini raw response length: ${content.length} chars`);
  if (content.length > 0) {
    console.log(`[API] Gemini response preview: ${content.slice(0, 200)}...`);
  }
  
  if (!content) {
    console.error(`[API] Gemini returned empty content. Full response:`, JSON.stringify(data).slice(0, 1000));
    return [];
  }
  
  // Remove markdown code blocks
  if (content.includes('```')) {
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }
  content = content.trim();
  
  // Try to extract JSON array from response
  let parsed: any = null;
  
  // First try: parse entire content if it's pure JSON
  try {
    parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      console.log(`[API] Gemini parsed ${parsed.length} books (direct JSON)`);
      return parsed;
    }
  } catch {}
  
  // Second try: find JSON array in content
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        console.log(`[API] Gemini parsed ${parsed.length} books (extracted from text)`);
        return parsed;
      }
    } catch (e) {
      console.error(`[API] Gemini failed to parse extracted JSON:`, e);
    }
  }
  
  console.error(`[API] Gemini response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
  return [];
  } catch (e: any) {
    console.error(`[API] Gemini scan exception:`, e?.message || String(e));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Validate multiple books in batches (much faster than one-by-one)
async function validateBooksBatch(books: any[]): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || books.length === 0) return books;

  const BATCH_SIZE = 10; // Validate 10 books at a time
  const results: any[] = [];

  for (let i = 0; i < books.length; i += BATCH_SIZE) {
    const batch = books.slice(i, i + BATCH_SIZE);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      console.error(`[API] Batch validation timeout after 45s`);
      controller.abort();
    }, 45000); // 45s per batch - increased to prevent premature aborts

    try {
      const booksList = batch.map((b, idx) => 
        `${idx + 1}. Title: "${b.title}", Author: "${b.author}", Confidence: ${b.confidence}`
      ).join('\n');

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'gpt-4o', // Using GPT-4o for validation speed
          messages: [
            {
              role: 'user',
              content: `You are a book expert analyzing detected books from a bookshelf scan.

DETECTED BOOKS:
${booksList}

TASK: Analyze each book and determine if it's a real book. For each book, correct any OCR errors and return the proper title and author.

RULES:
1. If the title and author are swapped, fix them
2. Fix obvious OCR errors (e.g., "owmen" → "women")
3. Clean up titles (remove publisher prefixes, series numbers)
4. Validate that the author looks like a real person's name
5. If it's not a real book, mark it as invalid

CRITICAL: You MUST respond with ONLY valid JSON array. No explanations, no markdown, no code blocks. Just the raw JSON array.

RETURN FORMAT (JSON ARRAY ONLY, NO OTHER TEXT):
[
  {"isValid": true, "title": "Corrected Title 1", "author": "Corrected Author 1", "confidence": "high", "reason": "Brief explanation"},
  {"isValid": false, "title": "Book 2", "author": "Author 2", "confidence": "low", "reason": "Not a real book"},
  ...
]

Return the array in the same order as the input. Respond with ONLY the JSON array, nothing else.`,
            },
          ],
          max_tokens: 2000, // GPT-4o uses max_tokens
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[API] Batch validation failed: ${res.status} - ${errorText.slice(0, 200)}`);
        // Return original books if validation fails
        results.push(...batch);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content?.trim();

      if (!content) {
        results.push(...batch);
        continue;
      }

      let analyses: any[];
      try {
        analyses = JSON.parse(content);
        if (!Array.isArray(analyses)) {
          throw new Error('Response is not an array');
        }
      } catch {
        // Try extracting from code blocks
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            analyses = JSON.parse(arrayMatch[0]);
          } catch {
            console.error(`[API] Failed to parse batch validation response`);
            results.push(...batch);
            continue;
          }
        } else {
          results.push(...batch);
          continue;
        }
      }

      // Map validated results back to original books
      for (let j = 0; j < batch.length; j++) {
        const book = batch[j];
        const analysis = analyses[j];
        
        if (analysis && analysis.isValid) {
          results.push({
            ...book,
            title: analysis.title,
            author: analysis.author,
            confidence: analysis.confidence,
          });
        } else {
          results.push({
            ...book,
            title: analysis?.title || book.title,
            author: analysis?.author || book.author,
            confidence: 'low',
            chatgptReason: analysis?.reason,
          });
        }
      }
    } catch (e) {
      console.error(`[API] Batch validation error:`, e);
      // Return original books if validation fails
      results.push(...batch);
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
}

// Track scan in Supabase (non-blocking, don't fail scan if tracking fails)
async function trackScan(userId: string | undefined): Promise<void> {
  if (!userId) {
    return; // No user ID provided, skip tracking
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('[API] Supabase credentials not configured, skipping scan tracking');
    return;
  }

  try {
    // Use dynamic import to avoid bundling issues
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Call the increment function we created in the migration
    const { error } = await supabase.rpc('increment_user_scan_count', {
      user_uuid: userId
    });

    if (error) {
      console.error(`[API] Failed to track scan for user ${userId}:`, error);
    } else {
      console.log(`[API] Successfully tracked scan for user ${userId}`);
    }
  } catch (e: any) {
    // Don't throw - tracking failures shouldn't break scans
    console.error('[API] Error tracking scan:', e?.message || e);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers - allow all origins for mobile apps
  const origin = req.headers.origin || req.headers.referer || '*';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { imageDataURL, userId } = req.body || {};
    if (!imageDataURL || typeof imageDataURL !== 'string') {
      return res.status(400).json({ error: 'imageDataURL required' });
    }

    // Track scan asynchronously (don't wait for it)
    if (userId && typeof userId === 'string') {
      trackScan(userId).catch(err => {
        console.error('[API] Scan tracking error (non-blocking):', err);
      });
    }

    console.log(`[API] Starting parallel scans: OpenAI and Gemini...`);
    const imageSizeKB = Math.round(imageDataURL.length / 1024);
    console.log(`[API] Image size: ${imageSizeKB}KB`);
    
    const scanStartTime = Date.now();
    const [openai, gemini] = await Promise.all([
      withRetries(() => {
        console.log(`[API] Attempting OpenAI scan...`);
        return scanWithOpenAI(imageDataURL);
      }, 2, 1200).catch((e) => {
        console.error(`[API] OpenAI scan failed after retries:`, e?.message || e);
        return [];
      }),
      (async () => {
        // Try primary model first
        try {
          return await scanWithGemini(imageDataURL, 'gemini-3-pro-preview');
        } catch (e: any) {
          // If overloaded, try alternative models
          if (e?.isOverloaded || e?.message?.includes('503') || e?.message?.includes('overloaded')) {
            console.log(`[API] Gemini 3 Pro overloaded, trying alternative models...`);
            
            const alternativeModels = ['gemini-2.5-pro'];
            for (const altModel of alternativeModels) {
              try {
                console.log(`[API] Trying Gemini model: ${altModel}`);
                const result = await scanWithGemini(imageDataURL, altModel);
                if (result && result.length > 0) {
                  console.log(`[API] ✅ ${altModel} succeeded with ${result.length} books`);
                  return result;
                }
              } catch (altError: any) {
                console.log(`[API] ${altModel} also failed: ${altError?.message || altError}`);
                continue;
              }
            }
            console.log(`[API] All Gemini models failed, returning empty array`);
            return [];
          }
          // For non-overload errors, return empty array
          console.error(`[API] Gemini scan error (non-overload):`, e?.message || e);
          return [];
        }
      })().catch((e) => {
        console.error(`[API] Gemini scan failed after all retries:`, e?.message || e);
        return [];
      }),
    ]);
    const scanElapsed = Date.now() - scanStartTime;
    const openaiCount = openai?.length || 0;
    const geminiCount = gemini?.length || 0;
    const merged = dedupeBooks([...(openai || []), ...(gemini || [])]);
    
    console.log(`[API] Scan completed in ${scanElapsed}ms: OpenAI=${openaiCount} books, Gemini=${geminiCount} books, Merged=${merged.length} unique`);
    
    // Validate all detected books with ChatGPT (server-side) in batches for speed
    console.log(`[API] Validating ${merged.length} books with ChatGPT (batched)...`);
    const validatedBooks = await validateBooksBatch(merged);
    
    console.log(`[API] Validation complete: ${validatedBooks.length} books validated`);
    
    return res.status(200).json({ 
      books: validatedBooks,
      apiResults: {
        openai: { count: openaiCount, working: openaiCount > 0 },
        gemini: { count: geminiCount, working: geminiCount > 0 }
      }
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'scan_failed', detail: e?.message || String(e) });
  }
}
