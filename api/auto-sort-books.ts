import type { VercelRequest, VercelResponse } from '@vercel/node';

interface Book {
  id?: string;
  title: string;
  author?: string;
}

interface FolderGroup {
  folderName: string;
  bookIds: string[];
}

interface ExistingFolder {
  name: string;
  bookIds: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { books, existingFolders } = req.body;

    if (!books || !Array.isArray(books) || books.length === 0) {
      return res.status(400).json({ error: 'Books array is required' });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const existingFoldersList: ExistingFolder[] = existingFolders || [];
    console.log(`[API] Auto-sorting ${books.length} books into folders... (${existingFoldersList.length} existing folders to consider)`);

    // Prepare book list for ChatGPT
    const bookList = books.map((book: Book, index: number) => ({
      id: book.id || `book_${index}`,
      title: book.title || 'Unknown Title',
      author: book.author || 'Unknown Author',
    }));

    // Build prompt that includes existing folders
    let folderContext = '';
    if (existingFoldersList.length > 0) {
      folderContext = `\n\nIMPORTANT: You have ${existingFoldersList.length} existing folders. Try to match books to these existing folders first before creating new ones:\n${existingFoldersList.map((f: ExistingFolder) => `- "${f.name}" (currently has ${f.bookIds.length} books)`).join('\n')}\n\nIf a book fits well into an existing folder, assign it there. Only create new folders for books that don't fit any existing folder well.`;
    }

    // Call ChatGPT to sort books
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a book organization assistant. Group books by similarity (genre, topic, author, theme, etc.). Try to match books to existing folders first, only create new folders when books truly don\'t fit existing ones. Only use "Other" for books with no meaningful data or that truly cannot be categorized. Return only valid JSON.',
          },
          {
            role: 'user',
            content: `Sort these ${books.length} books into folders by similarity. Group books that are similar in genre, topic, theme, or author together.${folderContext}

Books to sort:
${JSON.stringify(bookList, null, 2)}

Return ONLY a JSON array with two types of folder assignments:
1. Assignments to existing folders: Use the exact existing folder name
2. New folders: Create descriptive names (2-3 words max, no emojis, like "Science Fiction" or "Business Books")
3. Only use "Other" for books with truly no data (title/author both unknown or meaningless)

Each group should have:
- folderName: The folder name (use existing folder names exactly as provided, or create new descriptive names)
- bookIds: Array of book IDs that belong in this folder

Example format:
[
  {
    "folderName": "Science Fiction",
    "bookIds": ["book_1", "book_5"]
  },
  {
    "folderName": "Business",
    "bookIds": ["book_2", "book_8"]
  }
]

IMPORTANT: 
- Match books to existing folders when they fit well
- Only create new folders for books that don't fit existing ones
- Only use "Other" for books with no meaningful data
- Try to minimize the number of books in "Other"

Return ONLY the JSON array, no explanations or markdown.`,
          },
        ],
        max_tokens: 4000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[API] OpenAI error: ${response.status} - ${errorText}`);
      return res.status(500).json({ error: 'Failed to sort books with AI' });
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() || '';

    if (!content) {
      return res.status(500).json({ error: 'Empty response from AI' });
    }

    // Remove markdown code blocks if present
    if (content.includes('```')) {
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    // Parse JSON response
    let folderGroups: FolderGroup[];
    try {
      folderGroups = JSON.parse(content);
    } catch (parseError) {
      // Try to extract JSON array from response
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        folderGroups = JSON.parse(arrayMatch[0]);
      } else {
        console.error('[API] Failed to parse folder groups:', content);
        return res.status(500).json({ error: 'Invalid response format from AI' });
      }
    }

    if (!Array.isArray(folderGroups)) {
      return res.status(500).json({ error: 'AI response is not an array' });
    }

    // Separate assignments to existing folders vs new folders
    const existingFolderAssignments: Map<string, string[]> = new Map();
    const newFolderGroups: FolderGroup[] = [];
    const usedBookIds = new Set<string>();

    // Track which existing folders we're adding books to
    const existingFolderNames = new Set(existingFoldersList.map((f: ExistingFolder) => f.name.toLowerCase()));

    for (const group of folderGroups) {
      if (!group.folderName || !Array.isArray(group.bookIds)) {
        continue;
      }

      // Clean folder name (remove emojis, limit length)
      const cleanName = group.folderName
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
        .replace(/[^\w\s-]/g, '') // Remove special chars except spaces and hyphens
        .trim()
        .substring(0, 50); // Max 50 chars

      if (!cleanName || cleanName.length === 0) {
        continue;
      }

      // Check if this matches an existing folder (case-insensitive)
      const matchingExistingFolder = existingFoldersList.find(
        (f: ExistingFolder) => f.name.toLowerCase() === cleanName.toLowerCase()
      );

      // Filter out duplicate book IDs and validate they exist
      const validBookIds = group.bookIds.filter((id: string) => {
        if (usedBookIds.has(id)) {
          return false; // Skip duplicates
        }
        const exists = bookList.some((b: any) => b.id === id);
        if (exists) {
          usedBookIds.add(id);
          return true;
        }
        return false;
      });

      if (validBookIds.length > 0) {
        if (matchingExistingFolder) {
          // Add to existing folder assignment
          const existingName = matchingExistingFolder.name; // Use exact name from existing folder
          if (!existingFolderAssignments.has(existingName)) {
            existingFolderAssignments.set(existingName, []);
          }
          existingFolderAssignments.get(existingName)!.push(...validBookIds);
        } else {
          // Only create new folder if it's not "Other" or if it has meaningful books
          // For "Other", only include books with truly no data
          if (cleanName.toLowerCase() === 'other') {
            // Only include books with no meaningful title/author
            const trulyUnclassifiable = validBookIds.filter((id: string) => {
              const book = bookList.find((b: any) => b.id === id);
              if (!book) return false;
              const hasTitle = book.title && book.title !== 'Unknown Title' && book.title.trim().length > 0;
              const hasAuthor = book.author && book.author !== 'Unknown Author' && book.author.trim().length > 0;
              return !hasTitle && !hasAuthor; // Only truly unclassifiable
            });
            
            if (trulyUnclassifiable.length > 0) {
              newFolderGroups.push({
                folderName: cleanName,
                bookIds: trulyUnclassifiable,
              });
            }
          } else {
            // Regular new folder
            newFolderGroups.push({
              folderName: cleanName,
              bookIds: validBookIds,
            });
          }
        }
      }
    }

    // Convert existing folder assignments to the response format
    const existingFolderUpdates: FolderGroup[] = Array.from(existingFolderAssignments.entries()).map(([folderName, bookIds]) => ({
      folderName,
      bookIds,
      isExisting: true, // Mark as existing folder update
    }));

    // Combine results
    const allAssignments = [...existingFolderUpdates, ...newFolderGroups];

    // Only add remaining unassigned books to "Other" if they truly have no data
    const assignedBookIds = new Set(allAssignments.flatMap(g => g.bookIds));
    const unassignedBooks = bookList.filter((b: any) => {
      if (assignedBookIds.has(b.id)) return false;
      // Only add to Other if truly unclassifiable
      const hasTitle = b.title && b.title !== 'Unknown Title' && b.title.trim().length > 0;
      const hasAuthor = b.author && b.author !== 'Unknown Author' && b.author.trim().length > 0;
      return !hasTitle && !hasAuthor;
    });
    
    if (unassignedBooks.length > 0) {
      // Check if "Other" already exists in new folders
      const otherFolder = newFolderGroups.find(g => g.folderName.toLowerCase() === 'other');
      if (otherFolder) {
        otherFolder.bookIds.push(...unassignedBooks.map((b: any) => b.id));
      } else {
        allAssignments.push({
          folderName: 'Other',
          bookIds: unassignedBooks.map((b: any) => b.id),
        });
      }
    }

    console.log(`[API] Organized ${books.length} books: ${existingFolderUpdates.length} existing folders updated, ${newFolderGroups.length} new folders created`);

    return res.status(200).json({
      success: true,
      folders: allAssignments,
      existingFolderUpdates: existingFolderUpdates.map(g => ({ folderName: g.folderName, bookIds: g.bookIds })),
      newFolders: newFolderGroups,
    });
  } catch (error: any) {
    console.error('[API] Error auto-sorting books:', error);
    return res.status(500).json({
      error: error?.message || 'Internal server error',
    });
  }
}

