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
    const { books } = req.body;

    if (!books || !Array.isArray(books) || books.length === 0) {
      return res.status(400).json({ error: 'Books array is required' });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    console.log(`[API] Auto-sorting ${books.length} books into folders...`);

    // Prepare book list for ChatGPT
    const bookList = books.map((book: Book, index: number) => ({
      id: book.id || `book_${index}`,
      title: book.title || 'Unknown Title',
      author: book.author || 'Unknown Author',
    }));

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
            content: 'You are a book organization assistant. Group books by similarity (genre, topic, author, theme, etc.) and return only valid JSON.',
          },
          {
            role: 'user',
            content: `Sort these ${books.length} books into folders by similarity. Group books that are similar in genre, topic, theme, or author together.

Books to sort:
${JSON.stringify(bookList, null, 2)}

Return ONLY a JSON array of folder groups. Each group should have:
- folderName: A short descriptive name (2-3 words max, no emojis, just basic description like "Science Fiction" or "Business Books" or "Classic Literature")
- bookIds: Array of book IDs that belong in this folder

Example format:
[
  {
    "folderName": "Science Fiction",
    "bookIds": ["book_1", "book_5", "book_12"]
  },
  {
    "folderName": "Business",
    "bookIds": ["book_2", "book_8"]
  }
]

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

    // Validate and clean folder groups
    const validGroups: FolderGroup[] = [];
    const usedBookIds = new Set<string>();

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
        validGroups.push({
          folderName: cleanName,
          bookIds: validBookIds,
        });
      }
    }

    // Add any books that weren't assigned to a folder into an "Other" folder
    const assignedBookIds = new Set(validGroups.flatMap(g => g.bookIds));
    const unassignedBooks = bookList.filter((b: any) => !assignedBookIds.has(b.id));
    
    if (unassignedBooks.length > 0) {
      validGroups.push({
        folderName: 'Other',
        bookIds: unassignedBooks.map((b: any) => b.id),
      });
    }

    console.log(`[API] Created ${validGroups.length} folders from ${books.length} books`);

    return res.status(200).json({
      success: true,
      folders: validGroups,
    });
  } catch (error: any) {
    console.error('[API] Error auto-sorting books:', error);
    return res.status(500).json({
      error: error?.message || 'Internal server error',
    });
  }
}

