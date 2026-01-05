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
    const { books, existingFolders } = req.body;

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
            content: 'You are a book organization assistant. Group books by their primary genre and return only valid JSON. Use standard literary genres like Fiction, Non-Fiction, Science Fiction, Mystery, Romance, Biography, History, Business, Self-Help, Philosophy, Poetry, etc.',
          },
          {
            role: 'user',
            content: `Sort these ${books.length} books into folders by their primary genre. Analyze each book's title and author to determine its genre.

${existingFolders && existingFolders.length > 0 ? `CRITICAL REQUIREMENT: You have ${existingFolders.length} existing genre folders. You MUST match EVERY SINGLE BOOK to an existing folder if at all possible. Be extremely flexible and creative in matching.

Existing genre folders (MATCH TO THESE - BE VERY FLEXIBLE):
${JSON.stringify(existingFolders.map((f: any) => ({ folderName: f.name || f.folderName, bookCount: f.bookIds?.length || 0 })), null, 2)}

MATCHING RULES (BE VERY FLEXIBLE):
1. Match books to existing folders even with loose connections:
   - Business/Marketing/Management/Finance → "Business"
   - History/Historical/War/Biography → "History" or "Biography" 
   - Science/Science Fiction/Technology → "Science Fiction" or "Science"
   - Fiction/Novel/Story → "Fiction"
   - Self-Help/Personal Development/Psychology → "Self-Help" or "Psychology"
   - Philosophy/Religion/Spirituality → "Philosophy" or "Religion"
   - Any non-fiction book → "Non-Fiction" if you have that folder
   - Any fiction book → "Fiction" if you have that folder

2. If a book could fit multiple existing folders, pick the BEST match, but ALWAYS pick an existing folder over creating a new one.

3. Only create a NEW folder if the book's genre is COMPLETELY unrelated to ALL existing folders.

4. NEVER create an "Other" folder. NEVER put books in "Other". If you can't match a book to an existing folder, create a new specific genre folder for it (e.g., "Poetry", "Art", "Cookbooks", etc.).

5. If a book has ANY meaningful title or author information, it MUST go into a folder - either an existing one or a new specific genre folder.

` : ''}Books to sort:
${JSON.stringify(bookList, null, 2)}

Return ONLY a JSON array of folder groups. Each group should have:
- folderName: The genre name (2-3 words max, no emojis). ${existingFolders && existingFolders.length > 0 ? 'Use EXACT existing folder names when matching. Only create new folder names for truly new genres.' : 'Use standard genre names like "Science Fiction", "Mystery", "Biography", "Business", "History", "Fiction", "Non-Fiction", etc.'}
- bookIds: Array of book IDs that belong in this genre folder

${existingFolders && existingFolders.length > 0 ? 'REMEMBER: Match EVERY book to an existing folder if possible. Be extremely flexible. Only create new folders for books that truly don\'t fit any existing genre. NEVER use "Other".' : 'Focus on genre classification. If a book\'s genre is unclear, use "Fiction" or "Non-Fiction" as appropriate. Only use "Other" for books where both title and author are "Unknown".'}

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

    // Try to match unassigned books to existing folders before creating "Other"
    const assignedBookIds = new Set(validGroups.flatMap(g => g.bookIds));
    const unassignedBooks = bookList.filter((b: any) => !assignedBookIds.has(b.id));
    
    if (unassignedBooks.length > 0 && existingFolders && existingFolders.length > 0) {
      // Try to match unassigned books to existing folders
      const otherBooks: string[] = [];
      
      for (const book of unassignedBooks) {
        // Only put in "Other" if both title and author are unknown
        if ((book.title === 'Unknown Title' || !book.title) && 
            (book.author === 'Unknown Author' || !book.author)) {
          otherBooks.push(book.id);
          continue;
        }
        
        // Try to find a matching existing folder with aggressive matching
        let matched = false;
        const bookTitle = (book.title || '').toLowerCase();
        const bookAuthor = (book.author || '').toLowerCase();
        const bookText = `${bookTitle} ${bookAuthor}`;
        
        // Category-based matching rules
        const categoryMatches: { [key: string]: string[] } = {
          'business': ['business', 'marketing', 'management', 'finance', 'entrepreneur', 'startup', 'strategy', 'leadership', 'sales', 'corporate', 'economy', 'investment', 'trading'],
          'history': ['history', 'historical', 'war', 'battle', 'ancient', 'medieval', 'world war', 'civil war', 'revolution', 'empire', 'dynasty', 'chronology'],
          'biography': ['biography', 'memoir', 'autobiography', 'life of', 'life story', 'diary', 'journals'],
          'science': ['science', 'scientific', 'physics', 'chemistry', 'biology', 'astronomy', 'mathematics', 'research', 'discovery'],
          'science fiction': ['science fiction', 'sci-fi', 'space', 'future', 'dystopia', 'alien', 'robot', 'cyberpunk', 'speculative'],
          'mystery': ['mystery', 'detective', 'crime', 'thriller', 'suspense', 'murder', 'investigation'],
          'philosophy': ['philosophy', 'philosophical', 'ethics', 'metaphysics', 'logic', 'existential', 'stoic'],
          'self-help': ['self-help', 'self help', 'personal development', 'motivation', 'success', 'happiness', 'productivity', 'habits'],
          'psychology': ['psychology', 'psychological', 'mental', 'mind', 'brain', 'behavior', 'cognitive', 'therapy'],
          'fiction': ['novel', 'story', 'tale', 'fiction', 'literature', 'literary', 'narrative'],
          'non-fiction': ['non-fiction', 'nonfiction', 'guide', 'manual', 'how to', 'reference', 'encyclopedia'],
          'romance': ['romance', 'romantic', 'love story', 'dating'],
          'poetry': ['poetry', 'poem', 'verse', 'sonnet'],
          'art': ['art', 'artistic', 'painting', 'sculpture', 'design', 'aesthetics'],
          'cooking': ['cookbook', 'cooking', 'recipe', 'culinary', 'food'],
        };
        
        for (const existingFolder of existingFolders) {
          const folderName = (existingFolder.name || existingFolder.folderName || '').toLowerCase();
          
          if (!folderName) continue;
          
          // Direct name matching
          const folderWords = folderName.split(/\s+/).filter(w => w.length > 2);
          const matchesFolderName = bookText.includes(folderName) || folderName.includes(bookTitle.split(' ')[0]);
          const matchesAnyWord = folderWords.some(word => bookText.includes(word));
          
          // Category-based matching
          let categoryMatch = false;
          for (const [category, keywords] of Object.entries(categoryMatches)) {
            if (folderName.includes(category) || category.includes(folderName)) {
              if (keywords.some(keyword => bookText.includes(keyword))) {
                categoryMatch = true;
                break;
              }
            }
          }
          
          // Match if any condition is true
          if (matchesFolderName || matchesAnyWord || categoryMatch) {
            // Add to existing folder update
            const existingGroup = validGroups.find(g => 
              g.folderName.toLowerCase() === folderName
            );
            if (existingGroup) {
              existingGroup.bookIds.push(book.id);
            } else {
              validGroups.push({
                folderName: existingFolder.name || existingFolder.folderName,
                bookIds: [book.id],
              });
            }
            matched = true;
            break;
          }
        }
        
        // If still not matched, try broad category fallbacks
        if (!matched) {
          // Check for Fiction/Non-Fiction as catch-all
          const fictionFolder = existingFolders.find(f => {
            const name = (f.name || f.folderName || '').toLowerCase();
            return name.includes('fiction') && !name.includes('non');
          });
          const nonFictionFolder = existingFolders.find(f => {
            const name = (f.name || f.folderName || '').toLowerCase();
            return name.includes('non-fiction') || name.includes('nonfiction');
          });
          
          // Determine if it's likely fiction or non-fiction
          const isLikelyFiction = bookText.includes('novel') || bookText.includes('story') || 
                                  bookText.includes('tale') || bookText.includes('fiction') ||
                                  bookText.includes('literature');
          const isLikelyNonFiction = bookText.includes('guide') || bookText.includes('how to') || 
                                     bookText.includes('manual') || bookText.includes('self-help') ||
                                     bookText.includes('business') || bookText.includes('history') ||
                                     bookText.includes('biography') || bookText.includes('science') ||
                                     bookText.includes('philosophy') || bookText.includes('psychology');
          
          if (isLikelyFiction && fictionFolder) {
            const existingGroup = validGroups.find(g => 
              g.folderName.toLowerCase().includes('fiction') && !g.folderName.toLowerCase().includes('non')
            );
            if (existingGroup) {
              existingGroup.bookIds.push(book.id);
              matched = true;
            }
          } else if (isLikelyNonFiction && nonFictionFolder) {
            const existingGroup = validGroups.find(g => 
              g.folderName.toLowerCase().includes('non-fiction') || g.folderName.toLowerCase().includes('nonfiction')
            );
            if (existingGroup) {
              existingGroup.bookIds.push(book.id);
              matched = true;
            }
          } else if (fictionFolder && !isLikelyNonFiction) {
            // Default to Fiction if we have it and it's not clearly non-fiction
            const existingGroup = validGroups.find(g => 
              g.folderName.toLowerCase().includes('fiction') && !g.folderName.toLowerCase().includes('non')
            );
            if (existingGroup) {
              existingGroup.bookIds.push(book.id);
              matched = true;
            }
          }
        }
        
        // If still not matched, create a new specific genre folder instead of "Other"
        if (!matched) {
          // Try to infer genre from title/author
          let inferredGenre = 'Fiction'; // Default
          if (bookText.includes('business') || bookText.includes('marketing') || bookText.includes('management')) {
            inferredGenre = 'Business';
          } else if (bookText.includes('history') || bookText.includes('war') || bookText.includes('historical')) {
            inferredGenre = 'History';
          } else if (bookText.includes('science') || bookText.includes('technology')) {
            inferredGenre = 'Science';
          } else if (bookText.includes('biography') || bookText.includes('memoir')) {
            inferredGenre = 'Biography';
          } else if (bookText.includes('mystery') || bookText.includes('detective') || bookText.includes('crime')) {
            inferredGenre = 'Mystery';
          } else if (bookText.includes('philosophy') || bookText.includes('philosophical')) {
            inferredGenre = 'Philosophy';
          } else if (bookText.includes('self-help') || bookText.includes('personal development')) {
            inferredGenre = 'Self-Help';
          } else if (bookText.includes('psychology') || bookText.includes('psychological')) {
            inferredGenre = 'Psychology';
          } else if (bookText.includes('romance') || bookText.includes('romantic')) {
            inferredGenre = 'Romance';
          } else if (bookText.includes('poetry') || bookText.includes('poem')) {
            inferredGenre = 'Poetry';
          } else if (bookText.includes('art') || bookText.includes('artistic')) {
            inferredGenre = 'Art';
          } else if (bookText.includes('cookbook') || bookText.includes('cooking') || bookText.includes('recipe')) {
            inferredGenre = 'Cooking';
          }
          
          // Check if this genre folder already exists in validGroups
          const genreGroup = validGroups.find(g => 
            g.folderName.toLowerCase() === inferredGenre.toLowerCase()
          );
          if (genreGroup) {
            genreGroup.bookIds.push(book.id);
          } else {
            validGroups.push({
              folderName: inferredGenre,
              bookIds: [book.id],
            });
          }
          matched = true; // Mark as matched so it doesn't go to "Other"
        }
        
        // Only add to "Other" if truly unmatched AND has no data
        if (!matched && ((book.title === 'Unknown Title' || !book.title || book.title.trim() === '') && 
            (book.author === 'Unknown Author' || !book.author || book.author.trim() === ''))) {
          otherBooks.push(book.id);
        }
      }
      
      // Only create "Other" folder if there are books with no data
      if (otherBooks.length > 0) {
        validGroups.push({
          folderName: 'Other',
          bookIds: otherBooks,
        });
      }
    } else if (unassignedBooks.length > 0) {
      // No existing folders, but still only put truly unknown books in "Other"
      const unknownBooks = unassignedBooks.filter((b: any) => 
        (b.title === 'Unknown Title' || !b.title) && 
        (b.author === 'Unknown Author' || !b.author)
      );
      
      if (unknownBooks.length > 0) {
        validGroups.push({
          folderName: 'Other',
          bookIds: unknownBooks.map((b: any) => b.id),
        });
      }
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

