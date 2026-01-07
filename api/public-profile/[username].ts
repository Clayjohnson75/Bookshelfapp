import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Server is not properly configured. Please try again later.'
      });
    }

    // Create Supabase client (anon key is fine for public data)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Get user profile by username
    // First try with public_profile_enabled check
    console.log('[API] Searching for username:', username.toLowerCase());
    let { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, profile_bio, created_at, public_profile_enabled')
      .eq('username', username.toLowerCase())
      .eq('public_profile_enabled', true)
      .single();
    
    console.log('[API] Profile query result:', { 
      found: !!profile, 
      error: profileError ? {
        code: profileError.code,
        message: profileError.message,
        details: profileError.details,
        hint: profileError.hint
      } : null
    });

    // If that fails, check if the column exists (migration might not be run)
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
      
      if (profileError.code === 'PGRST301' || profileError.message?.includes('row-level security')) {
        // RLS policy issue
        return res.status(500).json({ 
          error: 'Permission denied',
          message: 'The database migration needs to be run to set up public profile access policies.'
        });
      }
    }

    // If profile not found, try without the public_profile_enabled check to see if user exists
    if (profileError || !profile) {
      // Try to get profile without the public check to see if it exists
      // Use service role key to bypass RLS for debugging
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      let profileCheck = null;
      let checkError = null;
      
      if (supabaseServiceKey) {
        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        const result = await supabaseAdmin
          .from('profiles')
          .select('id, username, public_profile_enabled')
          .eq('username', username.toLowerCase())
          .single();
        profileCheck = result.data;
        checkError = result.error;
        console.log('[API] Admin check result:', { profileCheck, checkError });
      } else {
        // Fallback to regular client
        const result = await supabase
          .from('profiles')
          .select('id, username, public_profile_enabled')
          .eq('username', username.toLowerCase())
          .single();
        profileCheck = result.data;
        checkError = result.error;
      }
      
      if (profileCheck) {
        console.error('[API] Profile exists but query failed. Details:', {
          username: profileCheck.username,
          public_profile_enabled: profileCheck.public_profile_enabled,
          originalError: profileError
        });
        
        // If profile exists but public_profile_enabled is false/null
        if (!profileCheck.public_profile_enabled) {
          return res.status(404).json({ 
            error: 'Profile not public',
            message: 'This profile exists but is not set to public. The user needs to enable public profile in their app settings.'
          });
        }
        
        // If it's true but still failing, it's likely an RLS issue
        return res.status(500).json({ 
          error: 'Permission error',
          message: 'Profile exists but cannot be accessed. This may be a database permissions issue.',
          debug: {
            public_profile_enabled: profileCheck.public_profile_enabled,
            errorCode: profileError?.code,
            errorMessage: profileError?.message
          }
        });
      }
      
      // Profile doesn't exist at all
      console.error('[API] Profile not found. Username searched:', username.toLowerCase());
      return res.status(404).json({ 
        error: 'Profile not found',
        message: `No profile found with username "${username}". Please check the username and try again.`
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

