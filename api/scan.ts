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
        model: 'gpt-5',
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
        max_completion_tokens: 1200,
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[API] OpenAI scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
      return [];
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    let content = data.choices?.[0]?.message?.content?.trim() || '';
    
    console.log(`[API] OpenAI raw response length: ${content.length} chars`);
    if (content.length > 0) {
      console.log(`[API] OpenAI response preview: ${content.slice(0, 200)}...`);
    }
    
    if (!content) {
      console.error(`[API] OpenAI returned empty content`);
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

async function scanWithGemini(imageDataURL: string): Promise<any[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const base64Data = imageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${key}`,
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
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[API] Gemini scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
    return [];
  }
  const data = await res.json() as { 
    candidates?: Array<{ 
      content?: { parts?: Array<{ text?: string }> }; 
      text?: string 
    }> 
  };
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
    console.error(`[API] Gemini returned empty content`);
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
}

async function validateBookWithChatGPT(book: any): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return book; // Return original if no key

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author}"
Confidence: ${book.confidence}

TASK: Analyze this book and determine if it's a real book. If it is, correct any OCR errors and return the proper title and author.

RULES:
1. If the title and author are swapped, fix them
2. Fix obvious OCR errors (e.g., "owmen" → "women")
3. Clean up titles (remove publisher prefixes, series numbers)
4. Validate that the author looks like a real person's name
5. If it's not a real book, mark it as invalid

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES:
Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author"}

Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book"}

Input: Title="The Great Gatsby", Author="F. Scott Fitzgerald"
Output: {"isValid": true, "title": "The Great Gatsby", "author": "F. Scott Fitzgerald", "confidence": "high", "reason": "Already correct"}

Remember: Respond with ONLY the JSON object, nothing else.`,
          },
        ],
        max_completion_tokens: 500,
      }),
    });

    if (!res.ok) {
      console.error(`[API] Validation failed for "${book.title}": ${res.status}`);
      return book;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) return book;

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      // Try extracting from code blocks
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        return book;
      }
    }

    if (analysis.isValid) {
      return {
        ...book,
        title: analysis.title,
        author: analysis.author,
        confidence: analysis.confidence,
      };
    } else {
      return {
        ...book,
        title: analysis.title,
        author: analysis.author,
        confidence: 'low',
        chatgptReason: analysis.reason,
      };
    }
  } catch (e) {
    console.error(`[API] Validation error for "${book.title}":`, e);
    return book;
  } finally {
    clearTimeout(timeout);
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
    const openaiCount = openai?.length || 0;
    const geminiCount = gemini?.length || 0;
    const merged = dedupeBooks([...(openai || []), ...(gemini || [])]);
    
    console.log(`[API] Scan results: OpenAI=${openaiCount} books, Gemini=${geminiCount} books, Merged=${merged.length} unique`);
    
    // Validate all detected books with ChatGPT (server-side)
    console.log(`[API] Validating ${merged.length} books with ChatGPT...`);
    const validatedBooks = await Promise.all(
      merged.map(book => validateBookWithChatGPT(book))
    );
    
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
