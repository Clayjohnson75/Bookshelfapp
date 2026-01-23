import type { VercelRequest, VercelResponse } from '@vercel/node';

// Basic helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Enhanced normalization: trim, collapse spaces, normalize quotes/dashes, strip punctuation
 */
function normalize(s?: string) {
  if (!s) return '';
  return s.trim()
    .toLowerCase()
    .replace(/[""]/g, '"') // Normalize quotes
    .replace(/['']/g, "'") // Normalize apostrophes
    .replace(/[–—]/g, '-') // Normalize dashes
    .replace(/[.,;:!?]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}

/**
 * Enhanced normalization with OCR artifact removal
 */
function normalizeWithOCR(s?: string): string {
  if (!s) return '';
  let normalized = normalize(s);
  // Remove common OCR artifacts
  normalized = normalized
    .replace(/\|/g, '') // Remove pipe characters (common OCR error)
    .replace(/^VOL\s+/i, '') // Remove leading "VOL" (volume indicators)
    .replace(/\s+VOL\s*$/i, '') // Remove trailing "VOL"
    .replace(/^[0-9]+\s*$/, '') // Remove pure numbers
    .replace(/^[%@#$&*]+\s*$/, '') // Remove pure symbols
    .trim();
  return normalized;
}

/**
 * Format author name: capitalize first letter of first and last name, use full name
 * Examples:
 * - "JOHN SMITH" -> "John Smith"
 * - "jane doe" -> "Jane Doe"
 * - "MARY J. JONES" -> "Mary J. Jones"
 * - "smith, john" -> "John Smith" (handle comma-separated)
 */
function formatAuthorName(author?: string | null): string | null {
  if (!author) return null;
  
  // Handle comma-separated names (e.g., "Smith, John" -> "John Smith")
  let name = author.trim();
  if (name.includes(',')) {
    const parts = name.split(',').map(p => p.trim());
    if (parts.length === 2) {
      name = `${parts[1]} ${parts[0]}`; // Swap last, first to first last
    }
  }
  
  // Split into words and capitalize each word properly
  const words = name.split(/\s+/).filter(w => w.length > 0);
  const formatted = words.map(word => {
    // Handle initials (e.g., "J." stays as "J.")
    if (word.length === 1 || (word.length === 2 && word.endsWith('.'))) {
      return word.toUpperCase();
    }
    // Capitalize first letter, lowercase the rest
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
  
  return formatted;
}

function normalizeTitle(title?: string) {
  if (!title) return '';
  const normalized = normalize(title);
  // Remove "the", "a", "an" from the beginning
  let cleaned = normalized.replace(/^(the|a|an)\s+/, '').trim();
  // Remove common prefixes/suffixes that might vary
  cleaned = cleaned.replace(/^(a|an|the)\s+/i, '');
  // Remove extra whitespace and normalize
  return cleaned.replace(/\s+/g, ' ').trim();
}

function normalizeAuthor(author?: string) {
  if (!author) return '';
  const normalized = normalize(author);
  // Remove common suffixes
  let cleaned = normalized.replace(/\s+(jr|sr|iii?|iv)$/i, '').trim();
  // Handle "and" in author names (e.g., "Hoffman and Casnocha" vs "Reid Hoffman and Ben Casnocha")
  // For deduplication, we'll use a simpler approach - just normalize the string
  cleaned = cleaned.replace(/\s+and\s+/gi, ' & ');
  // Remove extra whitespace
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Build canonical key for deterministic deduplication
 * Format: normalized_title::normalized_author_last
 */
function buildCanonicalKey(book: any): string {
  const title = normalizeTitle(book.title || '');
  const author = normalizeAuthor(book.author || '');
  // Extract last name from author (first word after "and" or last word)
  const authorLast = author.split(' & ').pop()?.split(' ').pop() || '';
  return `${title}::${authorLast}`;
}

/**
 * Improved merge/dedupe with canonical keys + fuzzy matching
 */
function dedupeBooks(books: any[]): any[] {
  if (!books || books.length === 0) return [];
  
  // First pass: exact match by canonical key
  const canonicalMap: Record<string, any> = {};
  for (const b of books) {
    if (!b || !b.title) continue;
    const key = buildCanonicalKey(b);
    // Keep the one with higher confidence, or one with both title+author
    if (!canonicalMap[key]) {
      canonicalMap[key] = b;
    } else {
      const existing = canonicalMap[key];
      const hasBoth = b.title && b.author;
      const existingHasBoth = existing.title && existing.author;
      if ((hasBoth && !existingHasBoth) || 
          (b.confidence === 'high' && existing.confidence !== 'high')) {
        canonicalMap[key] = b;
      }
    }
  }
  
  const deduped = Object.values(canonicalMap);
  
  // Second pass: fuzzy match titles within same spine_index neighborhood
  const final: any[] = [];
  for (const book of deduped) {
    const bookTitle = normalizeTitle(book.title);
    const bookAuthor = normalizeAuthor(book.author);
    const bookSpineIndex = book.spine_index ?? 999; // Default to end if missing
    
    if (!bookTitle || bookTitle.length < 2) continue;
    
    let isDuplicate = false;
    for (const existing of final) {
      const existingTitle = normalizeTitle(existing.title);
      const existingAuthor = normalizeAuthor(existing.author);
      const existingSpineIndex = existing.spine_index ?? 999;
      
      // Exact match
      if (bookTitle === existingTitle && bookAuthor === existingAuthor) {
        isDuplicate = true;
        break;
      }
      
      // Fuzzy match: similar titles, same author, nearby spine positions
      const authorsMatch = bookAuthor === existingAuthor || 
                          (!bookAuthor && !existingAuthor) ||
                          (bookAuthor && existingAuthor && (
                            bookAuthor === existingAuthor ||
                            bookAuthor.includes(existingAuthor) ||
                            existingAuthor.includes(bookAuthor)
                          ));
      
      const spineNearby = Math.abs(bookSpineIndex - existingSpineIndex) <= 2;
      
      if (authorsMatch && spineNearby && bookTitle.length > 3 && existingTitle.length > 3) {
        // Token-set similarity: check if titles share significant words
        const bookWords = new Set(bookTitle.split(/\s+/).filter(w => w.length > 2));
        const existingWords = new Set(existingTitle.split(/\s+/).filter(w => w.length > 2));
        const intersection = new Set([...bookWords].filter(w => existingWords.has(w)));
        const union = new Set([...bookWords, ...existingWords]);
        const similarity = intersection.size / union.size;
        
        // Also check if one contains the other
        const containsMatch = bookTitle.includes(existingTitle) || 
                              existingTitle.includes(bookTitle);
        
        if (similarity > 0.5 || containsMatch) {
          isDuplicate = true;
          // Prefer higher confidence or more complete data
          if (book.confidence === 'high' && existing.confidence !== 'high') {
            const index = final.indexOf(existing);
            if (index !== -1) {
              final[index] = book;
            }
          }
          break;
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

/**
 * Cheap validator: filter obvious junk before LLM validation
 * Returns { isValid: boolean, normalizedBook: any }
 */
function cheapValidate(book: any): { isValid: boolean; normalizedBook: any } {
  const spineText = normalizeWithOCR(book.spine_text || book.title || '');
  const title = normalizeWithOCR(book.title || '');
  const author = normalizeWithOCR(book.author || '');
  
  // Filter: spine_text too short AND no title/author
  if (spineText.length < 3 && !title && !author) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'spine_text_too_short' } };
  }
  
  // Filter: title is only digits/punctuation
  if (title && /^[0-9\s.,;:!?]+$/.test(title)) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'title_is_digits_only' } };
  }
  
  // Filter: obvious nonsense patterns
  if (title && /^(IIII|@@@@|%%%%|####|\|\|\|\|)$/.test(title)) {
    return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'nonsense_pattern' } };
  }
  
  // Filter: single generic word with no author and low confidence
  if (title && !author && book.confidence === 'low') {
    const words = title.split(/\s+/);
    if (words.length === 1 && ['the', 'a', 'an', 'book', 'volume', 'vol'].includes(words[0])) {
      return { isValid: false, normalizedBook: { ...book, cheapFilterReason: 'generic_word_no_author' } };
    }
  }
  
  // Normalize the book
  const normalizedBook = {
    ...book,
    title: book.title?.trim() || null,
    author: formatAuthorName(book.author), // Format author name properly
    spine_text: book.spine_text?.trim() || spineText,
    language: book.language || 'en',
    spine_index: book.spine_index ?? 0,
  };
  
  return { isValid: true, normalizedBook };
}

/**
 * JSON repair: attempt to fix invalid JSON using LLM
 */
async function repairJSON(invalidJSON: string, schema: string): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Fix this invalid JSON to match the schema: ${schema}\n\nInvalid JSON:\n${invalidJSON}\n\nReturn ONLY valid JSON, no explanations.`,
        }],
        max_tokens: 2000,
        temperature: 0,
      }),
    });
    
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    
    // Remove markdown if present
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function scanWithOpenAI(imageDataURL: string): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60 seconds - increased for structured output
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o', // Using gpt-4o instead of gpt-5 - faster and more reliable for vision tasks
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Scan this image and return ALL visible book spines as a strict JSON array.

CRITICAL RULES:
- TITLE is the book name (usually larger text, on the spine)
- AUTHOR is the person's name who wrote it (usually smaller text, below or above title)
- DO NOT swap title and author - titles are book names, authors are people's names
- If you see "John Smith" and "The Great Novel", "John Smith" is the AUTHOR, "The Great Novel" is the TITLE
- Format author names: capitalize first letter of first and last name, use full name (e.g., "John Smith" not "JOHN SMITH" or "john smith")
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy)
- Detect language: "en", "es", "fr", or "unknown"

Return ONLY valid JSON array (no markdown, no code blocks, no explanations):
[{
  "title": "Book Title Here or null",
  "author": "Author Name Here or null",
  "confidence": "high|medium|low",
  "spine_text": "raw text from spine",
  "language": "en|es|fr|unknown",
  "reason": "brief reason for confidence",
  "spine_index": 0
}]`,
              },
              { type: 'image_url', image_url: { url: imageDataURL } },
            ],
          },
        ],
        max_tokens: 4000, // Increased for structured output with spine_text, spine_index, etc.
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[API] OpenAI scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
      return [];
    }
      const data = await res.json() as {
        choices?: Array<{ 
          message?: { content?: string; text?: string }; 
          content?: string;
          text?: string;
          finish_reason?: string 
        }>;
        error?: any;
        model?: string;
        usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      
      // Log full response structure for debugging
      console.log(`[API] OpenAI response structure:`, JSON.stringify({
        hasChoices: !!data.choices,
        choicesLength: data.choices?.length || 0,
        firstChoice: data.choices?.[0] ? {
          hasMessage: !!data.choices[0].message,
          hasContent: !!data.choices[0].message?.content,
          finishReason: data.choices[0].finish_reason,
          contentLength: data.choices[0].message?.content?.length || 0
        } : null,
        error: data.error,
        model: data.model
      }, null, 2));
      
      // Check for API errors
      if (data.error) {
        console.error(`[API] OpenAI API error:`, data.error);
        return [];
      }
      
      // Try multiple ways to extract content
      let content = '';
      const finishReason = data.choices?.[0]?.finish_reason;
    
    // Method 1: Standard path
    content = data.choices?.[0]?.message?.content?.trim() || '';
    
    // Method 2: Try alternative paths if standard is empty
    if (!content && data.choices?.[0]) {
      const choice = data.choices[0];
      // Try different possible structures
      content = choice.content?.trim() || 
                choice.text?.trim() || 
                choice.message?.text?.trim() || 
                '';
    }
    
    // Method 3: If finish_reason is "length", the response was truncated
    // gpt-5 uses reasoning tokens - if all tokens were used for reasoning, we need more tokens
    if (!content && finishReason === 'length') {
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
      const totalTokens = data.usage?.completion_tokens || 0;
      console.warn(`[API] OpenAI response truncated: used ${totalTokens} tokens (${reasoningTokens} for reasoning). Increase max_completion_tokens.`);
    }
    
    console.log(`[API] OpenAI raw response length: ${content.length} chars, finish_reason: ${finishReason}`);
    if (content.length > 0) {
      console.log(`[API] OpenAI response preview: ${content.slice(0, 200)}...`);
    }
    
    if (!content) {
      console.error(`[API] OpenAI returned empty content. Full response keys:`, Object.keys(data));
      console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
      // If finish_reason is 'length', the response was truncated - this is still an error for our use case
      if (finishReason === 'length') {
        console.error(`[API] Response was truncated due to token limit`);
      }
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
        // Try JSON repair
        console.warn(`[API] OpenAI JSON parse failed, attempting repair...`);
        const repaired = await repairJSON(arrayMatch[0], 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
        if (repaired && Array.isArray(repaired)) {
          console.log(`[API] OpenAI parsed ${repaired.length} books (repaired JSON)`);
          return repaired;
        }
        console.error(`[API] OpenAI failed to parse/extract JSON:`, e);
      }
    }
    
    // Final attempt: try repairing the entire content
    console.warn(`[API] OpenAI attempting final JSON repair...`);
    const finalRepaired = await repairJSON(content, 'array of book objects');
    if (finalRepaired && Array.isArray(finalRepaired)) {
      console.log(`[API] OpenAI parsed ${finalRepaired.length} books (final repair)`);
      return finalRepaired;
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
                text: `Scan book spines in this image and return ONLY a strict JSON array.

CRITICAL RULES:
- TITLE is the book name (usually larger text on spine)
- AUTHOR is the person's name who wrote it (usually smaller text)
- DO NOT swap title and author - titles are book names, authors are people's names
- If you see "John Smith" and "The Great Novel", "John Smith" is AUTHOR, "The Great Novel" is TITLE
- Number books left-to-right: spine_index 0, 1, 2, etc.
- Capture raw spine_text exactly as you see it (even if messy)
- Detect language: "en", "es", "fr", or "unknown"

Return ONLY valid JSON array (no markdown, no code blocks, no explanations):
[{
  "title": "Book Title Here or null",
  "author": "Author Name Here or null",
  "confidence": "high|medium|low",
  "spine_text": "raw text from spine",
  "language": "en|es|fr|unknown",
  "reason": "brief reason for confidence",
  "spine_index": 0
}]`,
              },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
            ],
          },
        ],
        generationConfig: { 
          temperature: 0.1, 
          maxOutputTokens: 8000, // Increased to ensure we get output even if some tokens used for reasoning
        },
      }),
    }
  );
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[API] Gemini scan failed: ${res.status} ${res.statusText} - ${errorText.slice(0, 200)}`);
    return [];
  }
  const data = await res.json() as any;
  
  // Log full response structure for debugging
  console.log(`[API] Gemini response structure:`, JSON.stringify({
    hasCandidates: !!data.candidates,
    candidatesLength: data.candidates?.length || 0,
    firstCandidate: data.candidates?.[0] ? {
      hasContent: !!data.candidates[0].content,
      hasParts: !!data.candidates[0].content?.parts,
      partsLength: data.candidates[0].content?.parts?.length || 0,
      hasText: !!data.candidates[0].text,
      firstPartText: data.candidates[0].content?.parts?.[0]?.text?.substring(0, 50) || null
    } : null,
    error: data.error
  }, null, 2));
  
  let content = '';
  // Try multiple extraction methods
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    content = data.candidates[0].content.parts[0].text;
  } else if (data.candidates?.[0]?.text) {
    content = data.candidates[0].text;
  } else if (data.candidates?.[0]?.content?.text) {
    content = data.candidates[0].content.text;
  } else if (data.text) {
    content = data.text;
  }
  
  // Check if content object exists but is empty (Gemini used all tokens for reasoning)
  if (!content && data.candidates?.[0]?.content) {
    const contentObj = data.candidates[0].content;
    // Try to extract from nested structures
    if (contentObj.parts && Array.isArray(contentObj.parts)) {
      for (const part of contentObj.parts) {
        if (part.text) {
          content = part.text;
          break;
        }
      }
    }
  }
  
  content = content.trim();
  
  console.log(`[API] Gemini raw response length: ${content.length} chars`);
  if (content.length > 0) {
    console.log(`[API] Gemini response preview: ${content.slice(0, 200)}...`);
  }
  
  if (!content) {
    // Check if Gemini used all tokens for reasoning (thoughtsTokenCount > 0 but no output)
    const usageMetadata = data.usageMetadata;
    if (usageMetadata?.thoughtsTokenCount && usageMetadata.thoughtsTokenCount > 0) {
      console.error(`[API] Gemini used ${usageMetadata.thoughtsTokenCount} tokens for reasoning but produced no output`);
      console.error(`[API] Total tokens: ${usageMetadata.totalTokenCount}, Output tokens: ${usageMetadata.totalTokenCount - usageMetadata.thoughtsTokenCount}`);
      console.error(`[API] This suggests the model needs more maxOutputTokens or a more direct prompt`);
    }
    console.error(`[API] Gemini returned empty content. Full response keys:`, Object.keys(data));
    console.error(`[API] Full response:`, JSON.stringify(data, null, 2).substring(0, 1000));
    return [];
  }
  
  // Remove markdown code blocks more aggressively
  // Handle both ```json\n...\n``` and ```\n...\n``` formats
  content = content
    .replace(/^```json\s*\n?/i, '')  // Remove opening ```json (case insensitive)
    .replace(/^```\s*\n?/g, '')       // Remove opening ```
    .replace(/\n?```\s*$/g, '')      // Remove closing ```
    .replace(/```json\s*\n?/gi, '')  // Remove any ```json in middle
    .replace(/```\s*\n?/g, '')        // Remove any remaining ```
    .trim();
  
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
  
  // Second try: find complete JSON array in content (must have closing bracket)
  const completeArrayMatch = content.match(/\[[\s\S]*\]/);
  if (completeArrayMatch) {
    try {
      const arrayStr = completeArrayMatch[0];
      parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) {
        console.log(`[API] Gemini parsed ${parsed.length} books (extracted from text)`);
        return parsed;
      }
    } catch (e: any) {
      // If complete array fails, log the error and try partial extraction
      console.log(`[API] Gemini complete array parse failed: ${e?.message}, array length: ${completeArrayMatch[0].length}, trying partial extraction...`);
    }
  } else {
    console.log(`[API] Gemini: No complete array match found (no closing bracket)`);
  }
  
  // Third try: find incomplete JSON array and try to complete it
  // Look for array start and extract all complete objects
  const arrayStart = content.indexOf('[');
  if (arrayStart !== -1) {
    const arrayContent = content.substring(arrayStart);
    // Try to find all complete JSON objects in the array
    const objectMatches = arrayContent.match(/\{[^}]*"title"[^}]*"author"[^}]*\}/g);
    if (objectMatches && objectMatches.length > 0) {
      try {
        // Reconstruct array from complete objects
        const reconstructed = '[' + objectMatches.join(',') + ']';
        parsed = JSON.parse(reconstructed);
        if (Array.isArray(parsed)) {
          console.log(`[API] Gemini parsed ${parsed.length} books (reconstructed from partial)`);
          return parsed;
        }
      } catch (e) {
        // Try JSON repair
        console.warn(`[API] Gemini reconstruction failed, attempting repair...`);
        const reconstructedForRepair = '[' + objectMatches.join(',') + ']';
        const repaired = await repairJSON(reconstructedForRepair, 'array of book objects with title, author, confidence, spine_text, language, reason, spine_index');
        if (repaired && Array.isArray(repaired)) {
          console.log(`[API] Gemini parsed ${repaired.length} books (repaired JSON)`);
          return repaired;
        }
        console.log(`[API] Gemini reconstruction failed:`, e);
      }
    }
  }
  
  // Final attempt: try repairing the entire content
  console.warn(`[API] Gemini attempting final JSON repair...`);
  const repaired = await repairJSON(content, 'array of book objects');
  if (repaired && Array.isArray(repaired)) {
    console.log(`[API] Gemini parsed ${repaired.length} books (final repair)`);
    return repaired;
  }
  
  console.error(`[API] Gemini response doesn't contain valid JSON array. Content: ${content.slice(0, 500)}`);
  return [];
}

/**
 * Early external lookup for ambiguous items (before batch validation)
 * Returns book with external_match data if found
 */
async function earlyLookup(book: any): Promise<any> {
  // Only lookup if ambiguous: low/medium confidence OR missing author OR very short title
  const isAmbiguous = 
    book.confidence === 'low' || 
    book.confidence === 'medium' ||
    !book.author ||
    (book.title && book.title.length < 5);
  
  if (!isAmbiguous) return book;
  
  try {
    // Dynamic import to avoid circular dependencies
    const { fetchBookData } = await import('../services/googleBooksService');
    
    const query = book.title || book.spine_text || '';
    if (!query || query.length < 2) return book;
    
    const result = await fetchBookData(query, book.author || undefined);
    
    // GoogleBooksData doesn't have title/author directly, but fetchBookData returns data with googleBooksId
    // We'll use the original book data but mark that we found a match
    if (result && result.googleBooksId) {
      // Strong match found - attach external data
      // Note: We'll use the book's original title/author but mark it as externally validated
      return {
        ...book,
        external_match: {
          googleBooksId: result.googleBooksId,
          confidence: 'high', // External match is high confidence
        },
        // Keep original title/author but mark as externally validated
        googleBooksId: result.googleBooksId,
      };
    }
  } catch (error) {
    // Silently fail - we'll validate with LLM anyway
    console.log(`[API] Early lookup failed for "${book.title}":`, error?.message || error);
  }
  
  return book;
}

/**
 * Batch validation: validate multiple books in one LLM call
 */
async function batchValidateBooks(books: any[]): Promise<any[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || books.length === 0) return books;
  
  // Chunk into batches of 20 to avoid token limits
  const BATCH_SIZE = 20;
  const results: any[] = [];
  
  for (let i = 0; i < books.length; i += BATCH_SIZE) {
    const batch = books.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(books.length / BATCH_SIZE);
    
    console.log(`[API] Batch validating ${batchNum}/${totalBatches} (${batch.length} books)...`);
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s per batch
      
      const batchInput = batch.map((b, idx) => ({
        canonical_key: buildCanonicalKey(b),
        title: b.title || null,
        author: b.author || null,
        spine_text: b.spine_text || b.title || '',
        confidence: b.confidence || 'medium',
        external_match: b.external_match || null,
      }));
      
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `You are a book expert validating detected books from a bookshelf scan.

DETECTED BOOKS (JSON array):
${JSON.stringify(batchInput, null, 2)}

TASK: For each book, determine if it's valid and correct any errors. Be LENIENT - only mark as invalid if clearly junk.

RULES:
1. Books WITHOUT authors are VALID if title is distinctive
2. Partial titles are VALID
3. Only mark INVALID if clearly not a real book (random words, OCR garbage)
4. If title/author are swapped, fix them
5. Fix OCR errors
6. Prefer external_match data if provided (from Google Books lookup)

Return ONLY valid JSON array (no markdown, no code blocks):
[{
  "canonical_key": "same as input",
  "is_valid": true,
  "final_title": "corrected title or null",
  "final_author": "corrected author or null",
  "final_confidence": "high|medium|low",
  "fixes": ["title_author_swap", "ocr_cleanup", "filled_author", "none"],
  "notes": "brief explanation"
}]`,
          }],
          max_tokens: 2000,
          temperature: 0.1,
        }),
      });
      
      clearTimeout(timeout);
      
      if (!res.ok) {
        console.error(`[API] Batch validation failed: ${res.status}`);
        results.push(...batch); // Return originals on failure
        continue;
      }
      
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      let content = data.choices?.[0]?.message?.content?.trim() || '';
      
      // Remove markdown
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      let validated: any[];
      try {
        validated = JSON.parse(content);
      } catch {
        // Try repair
        const repaired = await repairJSON(content, 'array of validation results');
        validated = repaired || [];
      }
      
      // Map validation results back to books
      const validatedMap = new Map(validated.map((v: any) => [v.canonical_key, v]));
      
      for (const book of batch) {
        const key = buildCanonicalKey(book);
        const validation = validatedMap.get(key);
        
        if (validation && validation.is_valid) {
          results.push({
            ...book,
            title: validation.final_title || book.title,
            author: formatAuthorName(validation.final_author || book.author), // Format author name
            confidence: validation.final_confidence || book.confidence,
            validationFixes: validation.fixes || [],
            validationNotes: validation.notes,
          });
        } else {
          // Invalid book - mark for filtering
          console.log(`[API] Batch validation marked as INVALID: "${book.title}" by ${book.author || 'no author'}`);
          results.push({
            ...book,
            isValid: false,
            confidence: 'invalid',
          });
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        console.warn(`[API] Batch validation timeout for batch ${batchNum}`);
      } else {
        console.error(`[API] Batch validation error:`, error?.message || error);
      }
      results.push(...batch); // Return originals on error
    }
  }
  
  return results;
}

async function validateBookWithChatGPT(book: any): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return book; // Return original if no key

  const controller = new AbortController();
  const timeoutMs = 35000; // 35 seconds per book - increased to reduce timeouts
  const timeout = setTimeout(() => {
    console.log(`[API] AbortController timeout triggered for "${book.title}" after ${timeoutMs}ms`);
    controller.abort();
  }, timeoutMs);

  const startTime = Date.now();
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Faster model for validation
        messages: [
          {
            role: 'user',
            content: `You are a book expert analyzing a detected book from a bookshelf scan.

DETECTED BOOK:
Title: "${book.title}"
Author: "${book.author || '(no author)'}"
Confidence: ${book.confidence}

TASK: Determine if this is a real book. Be LENIENT - only mark as invalid if it's clearly junk (random words, obvious OCR garbage, not a real book title). If it's a real book (even with partial info), keep it and correct any obvious errors.

IMPORTANT RULES - BE LENIENT:
1. Books WITHOUT authors are VALID if the title is distinctive (e.g., "Fallingwater", "The Revolution", "Villareal")
2. Partial titles are VALID (e.g., "The Revolution" might be "Hamilton: The Revolution" - that's fine, keep it)
3. Only mark as INVALID if it's clearly not a real book (random words, obvious garbage, nonsensical titles)
4. CRITICAL: If title and author are swapped, ALWAYS fix them. Titles are book names, authors are people's names.
   - If "title" looks like a person's name (e.g., "John Smith", "Diana Gabaldon") and "author" looks like a book title, SWAP THEM
   - If "author" is clearly a book title (e.g., "The Great Gatsby", "Dragonfly in Amber") and "title" is a person's name, SWAP THEM
5. Fix obvious OCR errors (e.g., "owmen" → "women")
6. Clean up titles (remove publisher prefixes, series numbers) but keep the core title

CRITICAL: You MUST respond with ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.

RETURN FORMAT (JSON ONLY, NO OTHER TEXT):
{"isValid": true, "title": "Corrected Title", "author": "Corrected Author Name or null", "confidence": "high", "reason": "Brief explanation"}

EXAMPLES OF VALID BOOKS (KEEP THESE):
Input: Title="The Revolution", Author="Hamilton"
Output: {"isValid": true, "title": "Hamilton: The Revolution", "author": "Lin-Manuel Miranda", "confidence": "high", "reason": "Real book, expanded title"}

Input: Title="Fallingwater", Author=""
Output: {"isValid": true, "title": "Fallingwater", "author": null, "confidence": "high", "reason": "Real book about famous building, author not required"}

Input: Title="Villareal", Author=""
Output: {"isValid": true, "title": "Villareal", "author": null, "confidence": "medium", "reason": "Could be real book, keep it"}

Input: Title="Diana Gabaldon", Author="Dragonfly in Amber"
Output: {"isValid": true, "title": "Dragonfly in Amber", "author": "Diana Gabaldon", "confidence": "high", "reason": "Swapped title and author - Diana Gabaldon is author, Dragonfly in Amber is title"}

Input: Title="John Smith", Author="The Great Novel"
Output: {"isValid": true, "title": "The Great Novel", "author": "John Smith", "confidence": "high", "reason": "Swapped title and author - John Smith is author, The Great Novel is title"}

EXAMPLES OF INVALID BOOKS (REJECT THESE):
Input: Title="controlling owmen", Author="Unknown"
Output: {"isValid": false, "title": "controlling owmen", "author": "Unknown", "confidence": "low", "reason": "Not a real book, random words"}

Input: Title="Kaufmann's", Author=""
Output: {"isValid": false, "title": "Kaufmann's", "author": "", "confidence": "low", "reason": "Not a book title, appears to be store name"}

Input: Title="Friendship", Author=""
Output: {"isValid": false, "title": "Friendship", "author": "", "confidence": "low", "reason": "Too generic, not a distinctive book title"}

Remember: When in doubt, KEEP IT. Only reject if clearly not a real book. Respond with ONLY the JSON object, nothing else.`,
          },
        ],
        max_tokens: 500,
        temperature: 0.1, // Lower temperature = more consistent
      }),
    });

    const elapsed = Date.now() - startTime;
    console.log(`[API] Validation API call completed for "${book.title}" in ${elapsed}ms`);

    if (!res.ok) {
      console.error(`[API] Validation failed for "${book.title}": ${res.status}`);
      clearTimeout(timeout);
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
      // Valid book - return corrected version
      // Preserve null/empty authors if validation returns null
      const correctedAuthor = analysis.author === null || analysis.author === '' ? null : (analysis.author || book.author);
      return {
        ...book,
        title: analysis.title || book.title,
        author: formatAuthorName(correctedAuthor), // Format author name
        confidence: analysis.confidence || book.confidence,
      };
    } else {
      // Invalid book - mark as invalid so it can be filtered out
      console.log(`[API] Validation marked book as INVALID: "${book.title}" by ${book.author || 'no author'} - Reason: ${analysis.reason}`);
      return {
        ...book,
        title: analysis.title || book.title,
        author: analysis.author || book.author,
        confidence: 'invalid', // Mark as invalid
        isValid: false,
        chatgptReason: analysis.reason,
      };
    }
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
      console.warn(`[API] Validation aborted for "${book.title}" after ${elapsed}ms (timeout or network issue)`);
    } else {
      console.error(`[API] Validation error for "${book.title}" after ${elapsed}ms:`, e?.message || e);
    }
    return book;
  } finally {
    clearTimeout(timeout);
  }
}

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
    const { imageDataURL } = req.body || {};
    if (!imageDataURL || typeof imageDataURL !== 'string') {
      return res.status(400).json({ error: 'imageDataURL required' });
    }

    // Check if API keys are configured
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;
    
    if (!hasOpenAIKey && !hasGeminiKey) {
      console.error('[API] ERROR: No API keys configured! OPENAI_API_KEY and GEMINI_API_KEY are both missing.');
      return res.status(500).json({ 
        error: 'API keys not configured',
        message: 'Server is missing required API keys for scanning'
      });
    }
    
    console.log(`[API] API keys status: OpenAI=${hasOpenAIKey ? '✅' : '❌'}, Gemini=${hasGeminiKey ? '✅' : '❌'}`);
    
    // Run scans in parallel - both at the same time
    // If one fails, just use the other (no waiting, no retries)
    console.log('[API] Starting OpenAI and Gemini scans in parallel...');
    
    let openaiError: any = null;
    let geminiError: any = null;
    
    // Start both scans immediately in parallel
    const openaiPromise = scanWithOpenAI(imageDataURL).catch((err) => {
      openaiError = err;
      console.error('[API] OpenAI scan failed:', err?.message || err);
      return []; // Return empty array on failure
    });
    
    const geminiPromise = scanWithGemini(imageDataURL).catch((err) => {
      geminiError = err;
      console.error('[API] Gemini scan failed:', err?.message || err);
      return []; // Return empty array on failure
    });
    
    // Wait for both to complete (or fail) - whichever finishes first doesn't block the other
    const [openai, gemini] = await Promise.all([
      openaiPromise,
      geminiPromise
    ]);
    const openaiCount = openai?.length || 0;
    const geminiCount = gemini?.length || 0;
    const totalBeforeDedup = openaiCount + geminiCount;
    
    // Fix title/author swaps before deduplication
    const fixSwappedBooks = (books: any[]) => {
      return books.map(book => {
        const title = book.title?.trim() || '';
        const author = book.author?.trim() || '';
        
        // Heuristic: If title looks like a person's name and author looks like a book title, swap them
        // Person names typically: 2-3 words, capitalized, may have initials
        // Book titles typically: longer, may have "The", "A", "An", etc.
        const titleLooksLikeName = title && (
          /^[A-Z][a-z]+ [A-Z][a-z]+/.test(title) || // "John Smith" format
          /^[A-Z]\. [A-Z][a-z]+/.test(title) || // "J. Smith" format
          /^[A-Z][a-z]+ [A-Z]\. [A-Z][a-z]+/.test(title) // "John A. Smith" format
        ) && title.split(' ').length <= 4; // Names are usually 2-4 words
        
        const authorLooksLikeTitle = author && (
          author.toLowerCase().startsWith('the ') ||
          author.toLowerCase().startsWith('a ') ||
          author.toLowerCase().startsWith('an ') ||
          author.length > 20 || // Titles are usually longer
          author.split(' ').length > 4 // Titles usually have more words
        );
        
        if (titleLooksLikeName && authorLooksLikeTitle) {
          console.log(`🔄 Auto-fixing swapped title/author: "${title}" (title) ↔ "${author}" (author)`);
          return {
            ...book,
            title: author,
            author: formatAuthorName(title), // Format author name after swap
          };
        }
        
        return book;
      });
    };
    
    const fixedOpenAI = fixSwappedBooks(openai || []);
    const fixedGemini = fixSwappedBooks(gemini || []);
    const merged = dedupeBooks([...fixedOpenAI, ...fixedGemini]);
    
    console.log(`[API] Scan results: OpenAI=${openaiCount} books, Gemini=${geminiCount} books, Total=${totalBeforeDedup}, Merged=${merged.length} unique (removed ${totalBeforeDedup - merged.length} duplicates)`);
    
    // Return API status for debugging
    const apiResults = {
      openai: {
        working: hasOpenAIKey && openaiCount > 0,
        count: openaiCount,
        hasKey: hasOpenAIKey,
        error: openaiError ? (openaiError?.message || String(openaiError)) : null
      },
      gemini: {
        working: hasGeminiKey && geminiCount > 0,
        count: geminiCount,
        hasKey: hasGeminiKey,
        error: geminiError ? (geminiError?.message || String(geminiError)) : null
      }
    };
    
    // Log detailed status if both failed
    if (openaiCount === 0 && geminiCount === 0) {
      console.error('[API] Both APIs returned 0 books. OpenAI error:', openaiError, 'Gemini error:', geminiError);
    }
    
    // NEW PIPELINE: Step 1 - Cheap validator (filter obvious junk)
    console.log(`[API] Applying cheap validator to ${merged.length} books...`);
    const cheapValidated = merged.map(book => {
      const result = cheapValidate(book);
      return result.normalizedBook;
    });
    const cheapFiltered = cheapValidated.filter(book => {
      const isValid = !book.cheapFilterReason;
      if (!isValid) {
        console.log(`[API] Cheap filter rejected: "${book.title}" - ${book.cheapFilterReason}`);
      }
      return isValid;
    });
    console.log(`[API] Cheap validator: ${cheapFiltered.length} passed, ${cheapValidated.length - cheapFiltered.length} filtered`);
    
    // NEW PIPELINE: Step 2 - Early external lookup for ambiguous items
    console.log(`[API] Early lookup for ambiguous items...`);
    const withLookups = await Promise.all(
      cheapFiltered.map(book => earlyLookup(book))
    );
    const lookupCount = withLookups.filter(b => b.external_match).length;
    console.log(`[API] Early lookup: ${lookupCount} books found in Google Books`);
    
    // NEW PIPELINE: Step 3 - Batch validation (replaces per-book validation)
    console.log(`[API] Batch validating ${withLookups.length} books...`);
    const validatedBooks = await batchValidateBooks(withLookups);
    
    // Filter out invalid books
    const validBooks = validatedBooks.filter(book => {
      const isInvalid = book.confidence === 'invalid' || book.isValid === false;
      if (isInvalid) {
        console.log(`[API] Filtering out invalid book: "${book.title}" by ${book.author || 'no author'}`);
      }
      return !isInvalid;
    });
    
    console.log(`[API] Validation complete: ${validatedBooks.length} validated, ${validatedBooks.length - validBooks.length} invalid, ${validBooks.length} valid`);
    
    // Deduplicate again AFTER validation (validation might have normalized titles/authors differently)
    const finalBooks = dedupeBooks(validBooks);
    
    console.log(`[API] After post-validation deduplication: ${finalBooks.length} unique books (removed ${validBooks.length - finalBooks.length} duplicates)`);
    
    return res.status(200).json({ 
      books: finalBooks, // Only return deduplicated valid books
      apiResults // Include API status for debugging (already defined above with error info)
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'scan_failed', detail: e?.message || String(e) });
  }
}
