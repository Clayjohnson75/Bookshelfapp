import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkRateLimit, sendRateLimitResponse } from '../lib/rateLimit';

interface Book {
 id?: string;
 title: string;
 author?: string;
}

interface FolderGroup {
 folderName: string;
 bookIds: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 res.setHeader('Access-Control-Max-Age', '86400');

 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

 const rateLimitResult = await checkRateLimit(req, 'llm');
 if (!rateLimitResult.success) { sendRateLimitResponse(res, rateLimitResult); return; }

 try {
 const { books, existingFolders } = req.body;

 if (!books || !Array.isArray(books) || books.length === 0) {
 return res.status(400).json({ error: 'Books array is required' });
 }

 const openaiKey = process.env.OPENAI_API_KEY;
 if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

 const bookList = books.map((book: Book, index: number) => ({
 id: book.id || `book_${index}`,
 title: book.title || 'Unknown Title',
 author: book.author || 'Unknown Author',
 }));

 const existingNames = (existingFolders ?? [])
   .map((f: any) => f.name || f.folderName)
   .filter(Boolean) as string[];

 const response = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${openaiKey}`,
 },
 body: JSON.stringify({
 model: 'gpt-4o-mini',
 messages: [
 {
 role: 'system',
 content: `You classify books by genre. You are given a list of books (title + author) and must assign each book to exactly one genre folder.

Rules:
- Use broad, recognizable genres: Fiction, Non-Fiction, Science Fiction, Fantasy, Mystery & Thriller, Romance, Biography & Memoir, History, Business, Self-Help, Philosophy, Psychology, Science, Poetry, Art & Design, Cooking, Religion & Spirituality, Health & Wellness, Politics, True Crime, Horror, Children's, Young Adult, Humor, Travel, Sports, Music, Technology, Economics, Education, Classics.
- Pick the SINGLE most fitting genre for each book. Every book must be assigned.
- If you recognize the book or author, use your knowledge. If you don't, infer from the title.
- Keep genre names short (1-3 words). Capitalize each word.
- Never use "Other" or "Miscellaneous" as a genre. Always pick a real genre.
${existingNames.length > 0 ? `- Prefer these existing folder names when they fit: ${existingNames.join(', ')}. Use the exact name. Only create a new genre if none of the existing ones apply.` : ''}
- Return ONLY a JSON array, no markdown, no explanation.`,
 },
 {
 role: 'user',
 content: `Classify these ${bookList.length} books by genre.

${JSON.stringify(bookList, null, 1)}

Return JSON: [{"folderName": "Genre Name", "bookIds": ["id1", "id2"]}, ...]`,
 },
 ],
 max_tokens: 4000,
 temperature: 0.1,
 }),
 });

 if (!response.ok) {
 const errorText = await response.text();
 console.error(`[API] OpenAI error: ${response.status} - ${errorText}`);
 return res.status(500).json({ error: 'Failed to classify books' });
 }

 const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
 let content = data.choices?.[0]?.message?.content?.trim() || '';

 if (!content) return res.status(500).json({ error: 'Empty response' });

 // Strip markdown fences
 content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

 let folderGroups: FolderGroup[];
 try {
 folderGroups = JSON.parse(content);
 } catch {
 const arrayMatch = content.match(/\[[\s\S]*\]/);
 if (arrayMatch) {
 folderGroups = JSON.parse(arrayMatch[0]);
 } else {
 console.error('[API] Failed to parse:', content);
 return res.status(500).json({ error: 'Invalid response format' });
 }
 }

 if (!Array.isArray(folderGroups)) {
 return res.status(500).json({ error: 'Response is not an array' });
 }

 // Validate and deduplicate
 const validGroups: FolderGroup[] = [];
 const usedBookIds = new Set<string>();
 const bookIdSet = new Set(bookList.map((b: any) => b.id));

 for (const group of folderGroups) {
 if (!group.folderName || !Array.isArray(group.bookIds)) continue;

 const cleanName = group.folderName
 .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
 .trim()
 .substring(0, 40);

 if (!cleanName) continue;

 const validBookIds = group.bookIds.filter((id: string) => {
 if (usedBookIds.has(id) || !bookIdSet.has(id)) return false;
 usedBookIds.add(id);
 return true;
 });

 if (validBookIds.length > 0) {
 validGroups.push({ folderName: cleanName, bookIds: validBookIds });
 }
 }

 // Any unassigned books: add to the largest existing genre group.
 // This avoids wrongly putting a non-fiction book into "Fiction".
 const unassigned = bookList.filter((b: any) => !usedBookIds.has(b.id));
 if (unassigned.length > 0 && validGroups.length > 0) {
 // Sort groups by size descending — largest genre is the safest catch-all
 const sorted = [...validGroups].sort((a, b) => b.bookIds.length - a.bookIds.length);
 for (const book of unassigned) {
   if (book.title === 'Unknown Title' && book.author === 'Unknown Author') continue;
   sorted[0].bookIds.push(book.id);
 }
 } else if (unassigned.length > 0) {
 // No groups at all (model returned nothing) — create "General"
 const remaining = unassigned
   .filter((b: any) => !(b.title === 'Unknown Title' && b.author === 'Unknown Author'))
   .map((b: any) => b.id);
 if (remaining.length > 0) {
   validGroups.push({ folderName: 'General', bookIds: remaining });
 }
 }

 console.log(`[API] Classified ${books.length} books into ${validGroups.length} genres`);

 return res.status(200).json({ success: true, folders: validGroups });
 } catch (error: any) {
 console.error('[API] Error:', error);
 return res.status(500).json({ error: error?.message || 'Internal server error' });
 }
}
