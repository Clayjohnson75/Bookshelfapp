import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Add cache control headers to ensure fresh data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username } = req.query;

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ 
        error: 'Username required',
        message: 'Please provide a valid username.'
      });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Log which Supabase instance we're using (for debugging)
    const isDevSupabase = supabaseUrl.includes('gsfkjwmdwhptakgcbuxe');
    console.log('[API] Using Supabase:', isDevSupabase ? 'DEV' : 'PRODUCTION', supabaseUrl);

    // Use service role key to bypass RLS for public profiles
    // This is safe because we're only reading profiles marked as public
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Get user profile by username
    // Using service role key bypasses RLS, so we filter by public_profile_enabled ourselves
    console.log('[API] Searching for username:', username.toLowerCase());
    console.log('[API] Using Supabase URL:', supabaseUrl);
    console.log('[API] Is Dev Supabase:', isDevSupabase);
    
    // Get the profile (service role bypasses RLS)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, profile_bio, created_at, public_profile_enabled')
      .eq('username', username.toLowerCase())
      .single();
    
    console.log('[API] Profile query result:', { 
      found: !!profile,
      username: profile?.username,
      public_profile_enabled: profile?.public_profile_enabled,
      error: profileError ? {
        code: profileError.code,
        message: profileError.message,
        details: profileError.details,
        hint: profileError.hint
      } : null
    });
    
    // Handle errors first
    if (profileError) {
      console.error('[API] Profile fetch error:', {
        code: profileError.code,
        message: profileError.message,
        details: profileError.details,
        hint: profileError.hint
      });
      
      if (profileError.code === '42703') {
        // Column doesn't exist - migration not run yet
        return res.status(500).json({ 
          error: 'Database migration required',
          message: 'The public profile feature requires a database migration to be run first.'
        });
      }
      
      if (profileError.code === 'PGRST116') {
        // No rows returned - profile doesn't exist
        console.error('[API] Profile not found. Username searched:', username.toLowerCase());
        return res.status(404).json({ 
          error: 'Profile not found',
          message: `No profile found with username "${username}" in ${isDevSupabase ? 'DEV' : 'PRODUCTION'} database. Please check the username and ensure you're testing with the correct database.`,
          debug: {
            supabaseUrl: supabaseUrl,
            usernameSearched: username.toLowerCase(),
            isDevDatabase: isDevSupabase
          }
        });
      }
      
      // Other errors
      return res.status(500).json({ 
        error: 'Database error',
        message: 'An error occurred while fetching the profile.',
        debug: {
          errorCode: profileError.code,
          errorMessage: profileError.message
        }
      });
    }
    
    // Check if profile exists
    if (!profile) {
      console.error('[API] Profile not found for username:', username.toLowerCase());
      return res.status(404).json({ 
        error: 'Profile not found',
        message: `No profile found with username "${username}". Please check the username and try again.`
      });
    }
    
    // Filter by public_profile_enabled on the server side (since we're using service role)
    if (!profile.public_profile_enabled) {
      console.error('[API] Profile exists but is not public:', username.toLowerCase());
      return res.status(404).json({ 
        error: 'Profile not public',
        message: 'This profile exists but is not set to public. The user needs to enable public profile in their app settings.'
      });
    }

    // Get user's public books (only approved books)
    const { data: books, error: booksError } = await supabase
      .from('books')
      .select('id, title, author, cover_url, description, scanned_at, read_at, page_count, categories, publisher, published_date, average_rating, ratings_count')
      .eq('user_id', profile.id)
      .eq('status', 'approved')
      .order('scanned_at', { ascending: false });

    if (booksError) {
      console.error('[API] Error fetching books:', booksError);
      // Don't fail if books can't be fetched, just return empty array
    }

    // Calculate stats
    const totalBooks = books?.length || 0;
    const readBooks = books?.filter(book => book.read_at !== null).length || 0;
    const unreadBooks = totalBooks - readBooks;

    // Get most common authors
    const authorCounts: { [key: string]: number } = {};
    books?.forEach(book => {
      if (book.author) {
        authorCounts[book.author] = (authorCounts[book.author] || 0) + 1;
      }
    });
    const topAuthors = Object.entries(authorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([author, count]) => ({ author, count }));

    return res.status(200).json({
      profile: {
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name || profile.username,
        avatarUrl: profile.avatar_url,
        bio: profile.profile_bio,
        createdAt: profile.created_at,
      },
      books: books || [],
      stats: {
        totalBooks,
        readBooks,
        unreadBooks,
        topAuthors,
      }
    });

  } catch (error: any) {
    console.error('[API] Error in public-profile:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'An error occurred. Please try again later.'
    });
  }
}

