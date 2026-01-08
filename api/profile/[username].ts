import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add cache control headers to ensure fresh data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  const { username, edit } = req.query;
  const isEditMode = edit === 'true';

  if (!username || typeof username !== 'string') {
    return res.status(400).send('Invalid username');
  }

  try {
    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).send('Server configuration error');
    }

    // Use service role key to bypass RLS for public profiles
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Get user profile by username
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, profile_bio, created_at, public_profile_enabled')
      .eq('username', username.toLowerCase())
      .single();

    // Handle errors
    if (profileError) {
      if (profileError.code === 'PGRST116') {
        // Profile doesn't exist
        return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Profile Not Found - Bookshelf Scanner</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #f8f6f0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              color: #2c3e50;
            }
            .container {
              max-width: 500px;
              width: 100%;
              background: white;
              border-radius: 20px;
              padding: 60px 40px;
              box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
              text-align: center;
              border: 1px solid #e0e0e0;
            }
            .logo {
              width: 80px;
              height: 80px;
              margin: 0 auto 20px;
              display: block;
            }
            h1 {
              color: #2c3e50;
              font-size: 28px;
              margin-bottom: 15px;
              font-weight: 800;
            }
            p {
              color: #666;
              font-size: 16px;
              line-height: 1.6;
            }
            a {
              color: #007AFF;
              text-decoration: none;
              margin-top: 20px;
              display: inline-block;
            }
            a:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <img src="/logo.png" alt="Bookshelf Scanner Logo" class="logo">
            <h1>Profile Not Found</h1>
            <p>This profile does not exist or is not public.</p>
            <a href="/">Return to Home</a>
          </div>
        </body>
        </html>
      `);
      }
      
      // Other errors
      return res.status(500).send('Error loading profile');
    }

    // Check if profile exists
    if (!profile) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Profile Not Found - Bookshelf Scanner</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #f8f6f0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              color: #2c3e50;
            }
            .container {
              max-width: 500px;
              width: 100%;
              background: white;
              border-radius: 20px;
              padding: 60px 40px;
              box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
              text-align: center;
              border: 1px solid #e0e0e0;
            }
            .logo {
              width: 80px;
              height: 80px;
              margin: 0 auto 20px;
              display: block;
            }
            h1 {
              color: #2c3e50;
              font-size: 28px;
              margin-bottom: 15px;
              font-weight: 800;
            }
            p {
              color: #666;
              font-size: 16px;
              line-height: 1.6;
            }
            a {
              color: #007AFF;
              text-decoration: none;
              margin-top: 20px;
              display: inline-block;
            }
            a:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <img src="/logo.png" alt="Bookshelf Scanner Logo" class="logo">
            <h1>Profile Not Found</h1>
            <p>This profile does not exist or is not public.</p>
            <a href="/">Return to Home</a>
          </div>
        </body>
        </html>
      `);
    }

    // Check if profile is public
    if (!profile.public_profile_enabled) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Profile Not Found - Bookshelf Scanner</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #f8f6f0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              color: #2c3e50;
            }
            .container {
              max-width: 500px;
              width: 100%;
              background: white;
              border-radius: 20px;
              padding: 60px 40px;
              box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
              text-align: center;
              border: 1px solid #e0e0e0;
            }
            .logo {
              width: 80px;
              height: 80px;
              margin: 0 auto 20px;
              display: block;
            }
            h1 {
              color: #2c3e50;
              font-size: 28px;
              margin-bottom: 15px;
              font-weight: 800;
            }
            p {
              color: #666;
              font-size: 16px;
              line-height: 1.6;
            }
            a {
              color: #007AFF;
              text-decoration: none;
              margin-top: 20px;
              display: inline-block;
            }
            a:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <img src="/logo.png" alt="Bookshelf Scanner Logo" class="logo">
            <h1>Profile Not Found</h1>
            <p>This profile exists but is not set to public.</p>
            <a href="/">Return to Home</a>
          </div>
        </body>
        </html>
      `);
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
      // Don't fail if books can't be fetched, just use empty array
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

    // Format profile data
    const profileData = {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name || profile.username,
      avatarUrl: profile.avatar_url,
      bio: profile.profile_bio,
      createdAt: profile.created_at,
    };

    const stats = {
      totalBooks,
      readBooks,
      unreadBooks,
      topAuthors,
    };

    // Generate HTML for the profile page
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${profileData.displayName}'s Library - Bookshelf Scanner</title>
        <meta name="description" content="View ${profileData.displayName}'s book collection on Bookshelf Scanner">
        <meta property="og:title" content="${profileData.displayName}'s Library - Bookshelf Scanner">
        <meta property="og:description" content="${stats.totalBooks} books in ${profileData.displayName}'s collection">
        <meta property="og:image" content="${profileData.avatarUrl || '/logo.png'}">
        <meta property="og:type" content="profile">
        <meta name="twitter:card" content="summary">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #f8f6f0;
            color: #2c3e50;
            line-height: 1.6;
          }
          .header {
            background: white;
            border-bottom: 1px solid #e0e0e0;
            padding: 20px 0;
            position: sticky;
            top: 0;
            z-index: 100;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
            will-change: transform;
            transform: translateZ(0);
          }
          .header-content {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .logo-link {
            display: flex;
            align-items: center;
            text-decoration: none;
            color: #2c3e50;
            font-weight: 700;
            font-size: 18px;
          }
          .logo-link img {
            width: 32px;
            height: 32px;
            margin-right: 10px;
          }
          .header-right {
            display: flex;
            gap: 15px;
            align-items: center;
          }
          .get-app-link {
            color: #007AFF;
            text-decoration: none;
            font-weight: 600;
            font-size: 14px;
          }
          .get-app-link:hover {
            text-decoration: underline;
          }
          .nav-buttons {
            background: white;
            border-bottom: 1px solid #e0e0e0;
            padding: 0;
            position: sticky;
            top: 72px;
            z-index: 99;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
            will-change: transform;
            transform: translateZ(0);
          }
          .nav-buttons-content {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 20px;
            display: flex;
            gap: 10px;
          }
          .nav-button {
            padding: 12px 24px;
            background: transparent;
            border: none;
            color: #2c3e50;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            transition: all 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }
          .nav-button:hover {
            color: #007AFF;
            background: #f8f6f0;
          }
          .nav-button.active {
            color: #007AFF;
            border-bottom-color: #007AFF;
          }
          .nav-button.profile-button {
            margin-left: auto;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
          }
          .profile-header {
            padding: 40px 0;
            margin-bottom: 30px;
            text-align: center;
          }
          .avatar {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            margin: 0 auto 20px;
            display: block;
            object-fit: cover;
            border: 4px solid #f8f6f0;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
          .avatar-placeholder {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            margin: 0 auto 20px;
            background: #34495e;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 48px;
            font-weight: 700;
            border: 4px solid #f8f6f0;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
          .profile-name {
            font-size: 36px;
            font-weight: 800;
            color: #2c3e50;
            margin-bottom: 10px;
            letter-spacing: 0.5px;
          }
          .profile-username {
            font-size: 18px;
            color: #666;
            margin-bottom: 20px;
          }
          .profile-bio {
            font-size: 16px;
            color: #555;
            max-width: 600px;
            margin: 0 auto 30px;
            line-height: 1.8;
          }
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 20px;
            margin-top: 30px;
            contain: layout style paint;
          }
          .stat-card {
            background: #f8f6f0;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            border: 2px solid #34495e;
            box-shadow: 0 2px 8px rgba(52, 73, 94, 0.1);
          }
          .stat-value {
            font-size: 32px;
            font-weight: 800;
            color: #2c3e50;
            margin-bottom: 5px;
          }
          .stat-label {
            font-size: 14px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .books-section {
            padding: 40px 0;
          }
          .section-title {
            font-size: 28px;
            font-weight: 800;
            color: #2c3e50;
            margin-bottom: 20px;
            letter-spacing: 0.5px;
          }
          .search-container {
            margin-bottom: 30px;
          }
          .search-input {
            width: 100%;
            padding: 14px 20px;
            font-size: 16px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            background: white;
            color: #2c3e50;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            transition: border-color 0.2s, box-shadow 0.2s;
          }
          .search-input:focus {
            outline: none;
            border-color: #007AFF;
            box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
          }
          .search-input::placeholder {
            color: #999;
          }
          .sign-in-button {
            background: #007AFF;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }
          .sign-in-button:hover {
            background: #0056CC;
          }
          .ask-library-button {
            background: linear-gradient(135deg, #007AFF 0%, #0056CC 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
            display: flex;
            align-items: center;
          }
          .ask-library-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 122, 255, 0.4);
          }
          .ask-library-button:active {
            transform: translateY(0);
          }
          .mode-toggle-container {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
          }
          .mode-toggle-button {
            padding: 12px 24px;
            border: 2px solid #e0e0e0;
            background: white;
            color: #666;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }
          .mode-toggle-button:hover {
            border-color: #007AFF;
            color: #007AFF;
          }
          .mode-toggle-button.active {
            background: linear-gradient(135deg, #007AFF 0%, #0056CC 100%);
            color: white;
            border-color: #007AFF;
            box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
          }
          .ai-answer-box {
            background: linear-gradient(135deg, #f8f6f0 0%, #ffffff 100%);
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          }
          .suggested-books-title {
            font-size: 20px;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 15px;
          }
          .chat-messages {
            scrollbar-width: thin;
            scrollbar-color: #ccc transparent;
          }
          .chat-messages::-webkit-scrollbar {
            width: 6px;
          }
          .chat-messages::-webkit-scrollbar-track {
            background: transparent;
          }
          .chat-messages::-webkit-scrollbar-thumb {
            background: #ccc;
            border-radius: 3px;
          }
          .chat-messages::-webkit-scrollbar-thumb:hover {
            background: #999;
          }
          .error-message {
            display: none;
            background: #fee;
            color: #c33;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            margin-top: 10px;
          }
          .error-message.show {
            display: block;
          }
          .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
          }
          .modal-overlay.show {
            display: flex;
          }
          .modal-content {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
          }
          .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
          }
          .modal-title {
            font-size: 24px;
            font-weight: 800;
            color: #2c3e50;
          }
          .modal-close {
            background: none;
            border: none;
            font-size: 28px;
            color: #666;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: background 0.2s;
          }
          .modal-close:hover {
            background: #f0f0f0;
          }
          .form-group {
            margin-bottom: 20px;
          }
          .form-label {
            display: block;
            font-size: 14px;
            font-weight: 600;
            color: #2c3e50;
            margin-bottom: 8px;
          }
          .form-input {
            width: 100%;
            padding: 12px 16px;
            font-size: 16px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            background: white;
            color: #2c3e50;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            transition: border-color 0.2s;
          }
          .form-input:focus {
            outline: none;
            border-color: #007AFF;
          }
          .form-button {
            width: 100%;
            padding: 14px;
            background: #007AFF;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }
          .form-button:hover {
            background: #0056CC;
          }
          .form-button:disabled {
            background: #ccc;
            cursor: not-allowed;
          }
          .error-message {
            color: #e74c3c;
            font-size: 14px;
            margin-top: 8px;
            display: none;
          }
          .error-message.show {
            display: block;
          }
          .book-detail-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 2000;
            align-items: center;
            justify-content: center;
            padding: 20px;
            overflow-y: auto;
          }
          .book-detail-modal.show {
            display: flex;
          }
          .book-detail-content {
            background: white;
            border-radius: 20px;
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            position: relative;
            will-change: scroll-position;
            -webkit-overflow-scrolling: touch;
          }
          .book-detail-header {
            position: sticky;
            top: 0;
            background: white;
            padding: 20px;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 10;
            will-change: transform;
            transform: translateZ(0);
          }
          .book-detail-close {
            background: none;
            border: none;
            font-size: 32px;
            color: #666;
            cursor: pointer;
            padding: 0;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: background 0.2s;
          }
          .book-detail-close:hover {
            background: #f0f0f0;
          }
          .book-detail-body {
            padding: 30px;
          }
          .book-detail-cover {
            width: 200px;
            max-width: 100%;
            aspect-ratio: 2/3;
            object-fit: cover;
            border-radius: 12px;
            margin: 0 auto 30px;
            display: block;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
          .book-detail-cover-placeholder {
            width: 200px;
            max-width: 100%;
            aspect-ratio: 2/3;
            background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            border-radius: 12px;
            margin: 0 auto 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 18px;
            text-align: center;
            padding: 20px;
            font-weight: 600;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
          .book-detail-title {
            font-size: 32px;
            font-weight: 800;
            color: #2c3e50;
            margin-bottom: 10px;
            line-height: 1.3;
          }
          .book-detail-author {
            font-size: 20px;
            color: #666;
            margin-bottom: 20px;
          }
          .book-detail-info {
            margin-top: 30px;
          }
          .book-detail-info-item {
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid #f0f0f0;
          }
          .book-detail-info-item:last-child {
            border-bottom: none;
          }
          .book-detail-info-label {
            font-size: 12px;
            text-transform: uppercase;
            color: #999;
            letter-spacing: 0.5px;
            margin-bottom: 5px;
            font-weight: 600;
          }
          .book-detail-info-value {
            font-size: 16px;
            color: #2c3e50;
            line-height: 1.5;
          }
          .book-detail-description {
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #e0e0e0;
          }
          .book-detail-description-text {
            font-size: 16px;
            color: #555;
            line-height: 1.8;
            white-space: pre-wrap;
          }
          .books-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 20px;
            contain: layout style paint;
          }
          .book-card {
            background: #f8f6f0;
            border-radius: 12px;
            overflow: hidden;
            cursor: pointer;
            will-change: transform;
            transform: translateZ(0);
          }
          .book-card:hover {
            transform: translateY(-4px) translateZ(0);
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
          }
          .book-cover {
            width: 100%;
            aspect-ratio: 2/3;
            object-fit: cover;
            background: #34495e;
            will-change: transform;
            transform: translateZ(0);
          }
          .book-cover-placeholder {
            width: 100%;
            aspect-ratio: 2/3;
            background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 14px;
            text-align: center;
            padding: 10px;
            font-weight: 600;
          }
          .book-info {
            padding: 12px;
          }
          .book-title {
            font-size: 13px;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 4px;
            line-height: 1.4;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .book-author {
            font-size: 11px;
            color: #666;
            line-height: 1.3;
            display: -webkit-box;
            -webkit-line-clamp: 1;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .top-authors {
            padding: 40px 0;
            margin-top: 30px;
          }
          .author-list {
            list-style: none;
          }
          .author-item {
            padding: 15px 0;
            border-bottom: 1px solid #f0f0f0;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .author-item:last-child {
            border-bottom: none;
          }
          .author-name {
            font-size: 16px;
            font-weight: 600;
            color: #2c3e50;
          }
          .author-count {
            font-size: 14px;
            color: #666;
            background: #f8f6f0;
            padding: 4px 12px;
            border-radius: 12px;
          }
          .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #666;
          }
          .empty-state-text {
            font-size: 18px;
          }
          @media (max-width: 768px) {
            .container {
              padding: 20px 15px;
            }
            .profile-header {
              padding: 30px 20px;
            }
            .profile-name {
              font-size: 28px;
            }
            .books-grid {
              grid-template-columns: repeat(4, 1fr);
              gap: 8px;
            }
            .book-card {
              border-radius: 8px;
            }
            .book-cover,
            .book-cover-placeholder {
              border-radius: 6px;
            }
            .book-info {
              padding: 6px;
            }
            .book-title {
              font-size: 11px;
              margin-bottom: 2px;
            }
            .book-author {
              font-size: 9px;
            }
            .stats-grid {
              grid-template-columns: repeat(2, 1fr);
            }
            .book-detail-content {
              max-width: 95%;
              max-height: 95vh;
            }
            .book-detail-body {
              padding: 20px;
            }
            .book-detail-cover,
            .book-detail-cover-placeholder {
              width: 150px;
            }
            .book-detail-title {
              font-size: 24px;
            }
            .book-detail-author {
              font-size: 16px;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="header-content">
            <a href="/" class="logo-link">
              <img src="/logo.png" alt="Bookshelf Scanner">
              <span>Bookshelf Scanner</span>
            </a>
            <div class="header-right">
              <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" class="get-app-link" target="_blank">Get the App</a>
            </div>
          </div>
        </div>

        <div class="nav-buttons">
          <div class="nav-buttons-content">
            <button class="nav-button" onclick="window.location.href='/'">Home</button>
            <button class="nav-button" onclick="window.location.href='/search'">Search</button>
            <button class="nav-button profile-button active" onclick="handleProfileNavClick()" id="profileNavButton">${isEditMode ? 'Profile' : 'Sign In'}</button>
          </div>
        </div>
        
        <div class="container">
          <div class="profile-header">
            <h1 class="profile-name">${profileData.displayName}</h1>
            <div class="profile-username">@${profileData.username}</div>
            ${profileData.bio ? `<div class="profile-bio">${profileData.bio}</div>` : ''}
            ${isEditMode ? `
              <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Edit your profile (coming soon)</p>
                <button class="sign-in-button" style="background: #007AFF; margin-right: 10px;" onclick="alert('Edit functionality coming soon!')">Edit Profile</button>
                <button class="sign-in-button" style="background: #666;" onclick="window.location.href='/${profileData.username}'">View Public Profile</button>
              </div>
            ` : ''}
            
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-value">${stats.totalBooks}</div>
                <div class="stat-label">Total Books</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">${stats.readBooks}</div>
                <div class="stat-label">Read</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">${stats.unreadBooks}</div>
                <div class="stat-label">Unread</div>
              </div>
            </div>
          </div>

          <div class="books-section">
            <h2 class="section-title">Library</h2>
            
            <!-- Mode Toggle Buttons -->
            <div class="mode-toggle-container" id="modeToggleContainer" style="display: flex; margin-bottom: 20px;">
              <button 
                id="libraryModeButton" 
                class="mode-toggle-button active" 
                onclick="switchToLibraryMode()"
              >
                Library
              </button>
              <button 
                id="askLibraryModeButton" 
                class="mode-toggle-button" 
                onclick="switchToAskLibraryMode()"
              >
                Ask Your Library
              </button>
            </div>
            
            <!-- Search/Ask Input -->
            <div class="search-container">
              <input 
                type="text" 
                class="search-input" 
                id="bookSearch" 
                placeholder="Search books by title or author..." 
                oninput="handleSearchInput()"
                onkeypress="if(event.key === 'Enter') handleSearchSubmit()"
              />
            </div>
            
            <!-- AI Answer Display -->
            <div id="aiAnswerContainer" style="display: none; margin: 20px 0;">
              <div class="ai-answer-box">
                <p id="aiAnswerText" style="margin: 0; color: #2c3e50; line-height: 1.6;"></p>
              </div>
            </div>
            
            <!-- Suggested Books Section (for Ask Your Library mode) -->
            <div id="suggestedBooksContainer" style="display: none; margin-top: 20px;">
              <h3 class="suggested-books-title">Suggested Books</h3>
              <div class="books-grid" id="suggestedBooksGrid">
                <!-- Books will be inserted here -->
              </div>
            </div>
            
            <!-- Regular Library Books -->
            <div id="regularBooksContainer">
              ${(books || []).length > 0 
                ? `<div class="books-grid" id="regularBooksGrid">
                    ${(books || []).map((book: any, index: number) => `
                      <div class="book-card" onclick="openBookDetail(${index})">
                        ${book.cover_url 
                          ? `<img src="${book.cover_url}" alt="${book.title}" class="book-cover">`
                          : `<div class="book-cover-placeholder">${book.title}</div>`
                        }
                        <div class="book-info">
                          <div class="book-title">${book.title}</div>
                          ${book.author ? `<div class="book-author">${book.author}</div>` : ''}
                        </div>
                      </div>
                    `).join('')}
                  </div>`
                : `<div class="empty-state">
                    <div class="empty-state-text">No books yet</div>
                  </div>`
              }
            </div>
          </div>

        </div>

        <!-- Book Detail Modal -->
        <div class="book-detail-modal" id="bookDetailModal" onclick="closeBookDetail(event)">
          <div class="book-detail-content" onclick="event.stopPropagation()">
            <div class="book-detail-header">
              <h2 style="margin: 0; font-size: 20px; font-weight: 800; color: #2c3e50;">Book Details</h2>
              <button class="book-detail-close" onclick="closeBookDetail()">&times;</button>
            </div>
            <div class="book-detail-body" id="bookDetailBody">
              <!-- Book details will be inserted here -->
            </div>
          </div>
        </div>

        <!-- Sign In Modal -->
        <div class="modal-overlay" id="signInModal" onclick="closeSignInModal(event)">
          <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
              <h2 class="modal-title">Sign In</h2>
              <button class="modal-close" onclick="closeSignInModal()">&times;</button>
            </div>
            <form id="signInForm" onsubmit="handleSignIn(event)">
              <div class="form-group">
                <label class="form-label" for="signInEmail">Email or Username</label>
                <input 
                  type="text" 
                  id="signInEmail" 
                  class="form-input" 
                  required 
                  autocomplete="username"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="signInPassword">Password</label>
                <input 
                  type="password" 
                  id="signInPassword" 
                  class="form-input" 
                  required 
                  autocomplete="current-password"
                />
              </div>
              <div class="error-message" id="signInError"></div>
              <button type="submit" class="form-button" id="signInSubmit">Sign In</button>
            </form>
          </div>
        </div>

        <script>
          const allBooks = ${JSON.stringify(books || [])};
          const username = '${profileData.username}';
          
          let filterTimeout;
          function filterBooks() {
            if (currentMode !== 'library') return;
            
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(() => {
              const searchTerm = document.getElementById('bookSearch').value.toLowerCase();
              const regularBooksGrid = document.getElementById('regularBooksGrid');
              if (!regularBooksGrid) return;
              
              const bookCards = regularBooksGrid.querySelectorAll('.book-card');
              
              // Use requestAnimationFrame for smooth updates
              requestAnimationFrame(() => {
                bookCards.forEach(card => {
                  const title = card.querySelector('.book-title')?.textContent?.toLowerCase() || '';
                  const author = card.querySelector('.book-author')?.textContent?.toLowerCase() || '';
                  const matches = !searchTerm || title.includes(searchTerm) || author.includes(searchTerm);
                  card.style.display = matches ? 'block' : 'none';
                });
              });
            }, 150);
          }

          function openBookDetail(index) {
            const book = allBooks[index];
            if (!book) return;

            const modal = document.getElementById('bookDetailModal');
            const body = document.getElementById('bookDetailBody');

            const formatDate = (dateString) => {
              if (!dateString) return 'N/A';
              try {
                return new Date(dateString).toLocaleDateString('en-US', { 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                });
              } catch {
                return dateString;
              }
            };

            const escapeHtml = (text) => {
              if (!text) return '';
              const div = document.createElement('div');
              div.textContent = text;
              return div.innerHTML;
            };

            let html = '';
            
            if (book.cover_url) {
              html += \`<img src="\${escapeHtml(book.cover_url)}" alt="\${escapeHtml(book.title || '')}" class="book-detail-cover">\`;
            } else {
              html += \`<div class="book-detail-cover-placeholder">\${escapeHtml(book.title || '')}</div>\`;
            }
            
            html += \`<h1 class="book-detail-title">\${escapeHtml(book.title || 'Unknown Title')}</h1>\`;
            
            if (book.author) {
              html += \`<div class="book-detail-author">by \${escapeHtml(book.author)}</div>\`;
            }
            
            html += '<div class="book-detail-info">';
            
            if (book.publisher) {
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Publisher</div>
                  <div class="book-detail-info-value">\${escapeHtml(book.publisher)}</div>
                </div>
              \`;
            }
            
            if (book.published_date) {
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Published</div>
                  <div class="book-detail-info-value">\${formatDate(book.published_date)}</div>
                </div>
              \`;
            }
            
            if (book.page_count) {
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Pages</div>
                  <div class="book-detail-info-value">\${book.page_count}</div>
                </div>
              \`;
            }
            
            if (book.scanned_at) {
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Added to Library</div>
                  <div class="book-detail-info-value">\${formatDate(book.scanned_at)}</div>
                </div>
              \`;
            }
            
            if (book.read_at) {
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Read</div>
                  <div class="book-detail-info-value">\${formatDate(book.read_at)}</div>
                </div>
              \`;
            }
            
            if (book.categories && book.categories.length > 0) {
              const categoriesText = Array.isArray(book.categories) ? book.categories.join(', ') : book.categories;
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Categories</div>
                  <div class="book-detail-info-value">\${escapeHtml(categoriesText)}</div>
                </div>
              \`;
            }
            
            html += '</div>';
            
            if (book.description) {
              html += \`
                <div class="book-detail-description">
                  <div class="book-detail-info-label" style="margin-bottom: 15px;">Description</div>
                  <div class="book-detail-description-text">\${escapeHtml(book.description)}</div>
                </div>
              \`;
            }
            
            body.innerHTML = html;

            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
          }

          function closeBookDetail(event) {
            if (event && event.target !== event.currentTarget && event.target.closest('.book-detail-content')) {
              return;
            }
            const modal = document.getElementById('bookDetailModal');
            modal.classList.remove('show');
            document.body.style.overflow = '';
          }

          function signOut() {
            localStorage.removeItem('supabase_session');
            window.location.href = \`/\${username}\`;
          }

          async function handleProfileNavClick() {
            const session = localStorage.getItem('supabase_session');
            if (session) {
              try {
                // Check if the signed-in user owns this profile
                const sessionData = JSON.parse(session);
                const response = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: sessionData })
                });
                
                if (response.ok) {
                  const data = await response.json();
                  const signedInUsername = data.username?.toLowerCase();
                  const profileUsername = '${profileData.username}'.toLowerCase();
                  
                  if (signedInUsername === profileUsername) {
                    // User owns this profile, redirect to their profile edit page
                    window.location.href = \`/\${data.username}?edit=true\`;
                  } else {
                    // User is signed in but viewing someone else's profile, go to their own profile
                    window.location.href = \`/\${data.username}?edit=true\`;
                  }
                } else {
                  // Error getting username, go to profile page
                  window.location.href = '/profile';
                }
              } catch (error) {
                console.error('Error checking profile ownership:', error);
                window.location.href = '/profile';
              }
            } else {
              // User not signed in, go to profile page (which will show sign-in form)
              window.location.href = '/profile';
            }
          }

          // Mode and search functionality
          let currentMode = 'library'; // 'library' or 'ask'
          let chatConversation = [];
          
          function checkAndShowToggleButtons() {
            // Show toggle buttons to everyone (not just profile owners)
            const toggleContainer = document.getElementById('modeToggleContainer');
            if (toggleContainer) {
              toggleContainer.style.display = 'flex';
            }
          }
          
          function switchToLibraryMode() {
            currentMode = 'library';
            const libraryBtn = document.getElementById('libraryModeButton');
            const askBtn = document.getElementById('askLibraryModeButton');
            const searchInput = document.getElementById('bookSearch');
            const aiAnswerContainer = document.getElementById('aiAnswerContainer');
            const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
            const regularBooksContainer = document.getElementById('regularBooksContainer');
            
            if (libraryBtn) libraryBtn.classList.add('active');
            if (askBtn) askBtn.classList.remove('active');
            if (searchInput) {
              searchInput.placeholder = 'Search books by title or author...';
              searchInput.value = '';
            }
            if (aiAnswerContainer) aiAnswerContainer.style.display = 'none';
            if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
            if (regularBooksContainer) regularBooksContainer.style.display = 'block';
            
            // Restore original book filtering
            filterBooks();
          }
          
          async function switchToAskLibraryMode() {
            try {
              // Check if user is signed in first
              const session = localStorage.getItem('supabase_session');
              if (!session) {
                const signIn = confirm('You need to sign in to use Ask Your Library. Would you like to sign in now?');
                if (signIn) {
                  window.location.href = '/profile';
                }
                return;
              }
              
              // Just switch to ask mode - let the API handle Pro validation when they ask a question
              // Check if user owns this profile or is viewing someone else's
              let isOwnProfile = false;
              try {
                const sessionData = JSON.parse(session);
                const usernameResponse = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: sessionData })
                });
                
                if (usernameResponse.ok) {
                  const usernameData = await usernameResponse.json();
                  const signedInUsername = usernameData.username?.toLowerCase();
                  const profileUsername = '${profileData.username}'.toLowerCase();
                  isOwnProfile = signedInUsername === profileUsername;
                }
              } catch (e) {
                // Ignore error, just assume not own profile
              }
              
              // Switch to ask mode
              currentMode = 'ask';
              const libraryBtn = document.getElementById('libraryModeButton');
              const askBtn = document.getElementById('askLibraryModeButton');
              const searchInput = document.getElementById('bookSearch');
              const regularBooksContainer = document.getElementById('regularBooksContainer');
              
              if (libraryBtn) libraryBtn.classList.remove('active');
              if (askBtn) askBtn.classList.add('active');
              if (searchInput) {
                searchInput.placeholder = isOwnProfile 
                  ? 'Ask a question about your library!' 
                  : 'Ask a question about their library!';
                searchInput.value = '';
              }
              if (regularBooksContainer) regularBooksContainer.style.display = 'none';
              
              // Clear previous answers
              const aiAnswerContainer = document.getElementById('aiAnswerContainer');
              const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
              if (aiAnswerContainer) aiAnswerContainer.style.display = 'none';
              if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
            } catch (error) {
              console.error('Error in switchToAskLibraryMode:', error);
              alert('An error occurred. Please try again.');
            }
          }
          
          function handleSearchInput() {
            if (currentMode === 'library') {
              filterBooks();
            }
          }
          
          async function handleSearchSubmit() {
            if (currentMode === 'ask') {
              await askLibraryQuestion();
            }
          }
          
          async function askLibraryQuestion() {
            const searchInput = document.getElementById('bookSearch');
            const message = searchInput?.value.trim();
            if (!message) return;
            
            const aiAnswerContainer = document.getElementById('aiAnswerContainer');
            const aiAnswerText = document.getElementById('aiAnswerText');
            const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
            const suggestedBooksGrid = document.getElementById('suggestedBooksGrid');
            
            if (!aiAnswerContainer || !aiAnswerText) return;
            
            // Show loading state
            aiAnswerContainer.style.display = 'block';
            aiAnswerText.textContent = 'Thinking...';
            if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
            
            // Get session token
            const session = localStorage.getItem('supabase_session');
            if (!session) {
              aiAnswerText.textContent = 'Please sign in to use this feature.';
              return;
            }
            
            try {
              let sessionData = JSON.parse(session);
              
              // Supabase session object has access_token at root
              let accessToken = sessionData?.access_token;
              
              if (!accessToken || typeof accessToken !== 'string') {
                console.error('No valid access token found. Session structure:', sessionData);
                aiAnswerText.textContent = 'Session expired. Please refresh the page and sign in again.';
                return;
              }
              
              // Check if token is expired (expires_at is in seconds, convert to milliseconds)
              const expiresAt = sessionData?.expires_at;
              
              if (expiresAt) {
                const expiresAtMs = expiresAt * 1000;
                const now = Date.now();
                const isExpired = now >= expiresAtMs;
                
                // Refresh if expired or within 5 minutes of expiring
                if (isExpired || now >= expiresAtMs - 300000) {
                  console.log('Token expired or expiring soon. Attempting refresh...');
                  
                  // Try to refresh the token
                  const refreshToken = sessionData?.refresh_token;
                  if (refreshToken) {
                    try {
                      // Use our refresh token endpoint
                      const refreshResponse = await fetch('/api/refresh-token', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                          refresh_token: refreshToken
                        })
                      });
                      
                      if (refreshResponse.ok) {
                        const refreshData = await refreshResponse.json();
                        if (refreshData.session) {
                          // Update session with new tokens
                          sessionData = refreshData.session;
                          // Save updated session
                          localStorage.setItem('supabase_session', JSON.stringify(sessionData));
                          accessToken = sessionData.access_token;
                          console.log('Token refreshed successfully');
                        } else {
                          // Refresh failed - session expired
                          aiAnswerText.textContent = 'Your session has expired. Please refresh the page and sign in again.';
                          return;
                        }
                      } else {
                        // Refresh failed - check if token was already expired
                        if (isExpired) {
                          aiAnswerText.textContent = 'Your session has expired. Please refresh the page and sign in again.';
                          return;
                        }
                        // If not expired yet, try to continue with current token
                        const errorData = await refreshResponse.json().catch(() => ({}));
                        console.error('Failed to refresh token:', errorData);
                      }
                    } catch (refreshError) {
                      console.error('Error refreshing token:', refreshError);
                      if (isExpired) {
                        aiAnswerText.textContent = 'Your session has expired. Please refresh the page and sign in again.';
                        return;
                      }
                      // If not expired yet, try to continue
                    }
                  } else if (isExpired) {
                    // No refresh token and token is expired
                    aiAnswerText.textContent = 'Your session has expired. Please refresh the page and sign in again.';
                    return;
                  }
                }
              }
              
              // Determine if we're querying own library or someone else's
              const profileUsername = '${profileData.username}';
              let targetUsername = null;
              
              // Check if user owns this profile
              try {
                const usernameResponse = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: sessionData })
                });
                
                if (usernameResponse.ok) {
                  const usernameData = await usernameResponse.json();
                  const signedInUsername = usernameData.username?.toLowerCase();
                  const currentProfileUsername = profileUsername.toLowerCase();
                  
                  // If viewing someone else's profile, pass their username
                  if (signedInUsername !== currentProfileUsername) {
                    targetUsername = profileUsername;
                  }
                }
              } catch (e) {
                console.error('Error checking profile ownership:', e);
              }
              
              const requestBody = {
                message: message,
                conversation: chatConversation.slice(-6)
              };
              
              // Add target username if querying someone else's library
              if (targetUsername) {
                requestBody.target_username = targetUsername;
              }
              
              const response = await fetch('/api/library/ask', {
                method: 'POST',
                headers: {
                  'Authorization': \`Bearer \${accessToken}\`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
              });
              
              const data = await response.json();
              
              if (response.status === 401) {
                console.error('Authentication failed. Response:', data);
                console.error('This usually means the token is expired or invalid. Please sign in again.');
                aiAnswerText.textContent = 'Session expired. Please refresh the page and sign in again.';
              } else if (response.status === 403) {
                aiAnswerText.textContent = data.reply || 'This feature is available to Pro users only.';
              } else if (response.ok) {
                // Display answer
                aiAnswerText.textContent = data.reply;
                chatConversation.push({ role: 'user', content: message });
                chatConversation.push({ role: 'assistant', content: data.reply });
                
                // Display suggested books if any
                if (data.matched_books && data.matched_books.length > 0) {
                  displaySuggestedBooks(data.matched_books);
                } else {
                  if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
                }
              } else {
                console.error('API error:', response.status, data);
                aiAnswerText.textContent = data.reply || 'An error occurred. Please try again.';
              }
            } catch (error) {
              console.error('Error asking library question:', error);
              aiAnswerText.textContent = 'An error occurred. Please try again.';
            }
          }
          
          function displaySuggestedBooks(books) {
            const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
            const suggestedBooksGrid = document.getElementById('suggestedBooksGrid');
            
            if (!suggestedBooksContainer || !suggestedBooksGrid) return;
            
            suggestedBooksContainer.style.display = 'block';
            suggestedBooksGrid.innerHTML = '';
            
            // Find full book data from allBooks
            books.forEach(bookData => {
              const fullBook = allBooks.find(b => b.id === bookData.id);
              if (fullBook) {
                const bookIndex = allBooks.indexOf(fullBook);
                const bookCard = document.createElement('div');
                bookCard.className = 'book-card';
                bookCard.onclick = () => openBookDetail(bookIndex);
                
                const cover = fullBook.cover_url 
                  ? \`<img src="\${fullBook.cover_url}" alt="\${fullBook.title}" class="book-cover">\`
                  : \`<div class="book-cover-placeholder">\${fullBook.title}</div>\`;
                
                bookCard.innerHTML = \`
                  \${cover}
                  <div class="book-info">
                    <div class="book-title">\${fullBook.title || ''}</div>
                    \${fullBook.author ? \`<div class="book-author">\${fullBook.author}</div>\` : ''}
                  </div>
                \`;
                
                suggestedBooksGrid.appendChild(bookCard);
              }
            });
          }
          
          // Check if user is signed in and owns this profile on page load
          window.addEventListener('DOMContentLoaded', async () => {
            const session = localStorage.getItem('supabase_session');
            const urlParams = new URLSearchParams(window.location.search);
            const isEditMode = urlParams.get('edit') === 'true';
            
            if (!session && isEditMode) {
              // User in edit mode but no session, redirect to regular view
              window.location.href = \`/\${username}\`;
              return;
            }
            
            // Always show toggle buttons to everyone
            checkAndShowToggleButtons();
            
            if (session) {
              try {
                // Check if the signed-in user owns this profile
                const sessionData = JSON.parse(session);
                const response = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: sessionData })
                });
                
                if (response.ok) {
                  const data = await response.json();
                  const signedInUsername = data.username?.toLowerCase();
                  const profileUsername = '${profileData.username}'.toLowerCase();
                  
                  if (signedInUsername === profileUsername) {
                    // User owns this profile
                    if (!isEditMode) {
                      // Redirect to edit mode if viewing own profile and not already in edit mode
                      window.location.href = \`/\${username}?edit=true\`;
                    }
                  } else {
                    // User is signed in but viewing someone else's profile
                    if (isEditMode) {
                      // Redirect to regular view - can't edit someone else's profile
                      window.location.href = \`/\${username}\`;
                    }
                  }
                }
              } catch (error) {
                console.error('Error checking profile ownership:', error);
                // On error, just stay on current page
              }
            }
          });

          function openSignInModal() {
            window.location.href = '/signin';
          }

          function closeSignInModal(event) {
            if (event && event.target !== event.currentTarget && event.target.closest('.modal-content')) {
              return;
            }
            document.getElementById('signInModal').classList.remove('show');
            document.getElementById('signInError').classList.remove('show');
            document.getElementById('signInForm').reset();
          }

          async function handleSignIn(event) {
            event.preventDefault();
            const email = document.getElementById('signInEmail').value.trim();
            const password = document.getElementById('signInPassword').value;
            const submitButton = document.getElementById('signInSubmit');
            const errorDiv = document.getElementById('signInError');

            submitButton.disabled = true;
            submitButton.textContent = 'Signing in...';
            errorDiv.classList.remove('show');

            try {
              // Call our sign-in API endpoint
              const response = await fetch('/api/web-signin', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  emailOrUsername: email,
                  password: password,
                }),
              });

              const data = await response.json();

              if (!response.ok) {
                throw new Error(data.message || data.error || 'Sign in failed');
              }

              // Success! Store session and redirect to user's own profile edit page
              if (data.session) {
                // Store session token in localStorage
                localStorage.setItem('supabase_session', JSON.stringify(data.session));
                
                // Get username to redirect to their own profile
                const usernameResponse = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: data.session })
                });
                
                if (usernameResponse.ok) {
                  const usernameData = await usernameResponse.json();
                  if (usernameData.username) {
                    // Redirect to their own profile edit page
                    window.location.href = \`/\${usernameData.username}?edit=true\`;
                  } else {
                    // Fallback to profile page
                    window.location.href = '/profile';
                  }
                } else {
                  // Fallback to profile page
                  window.location.href = '/profile';
                }
              } else {
                closeSignInModal();
                window.location.href = \`/\${username}\`;
              }
            } catch (error) {
              errorDiv.textContent = error.message || 'Sign in failed. Please try again.';
              errorDiv.classList.add('show');
            } finally {
              submitButton.disabled = false;
              submitButton.textContent = 'Sign In';
            }
          }
          
          // Expose functions globally for onclick handlers (at end of script, after all functions defined)
          window.switchToLibraryMode = switchToLibraryMode;
          window.switchToAskLibraryMode = switchToAskLibraryMode;
          window.handleSearchSubmit = handleSearchSubmit;
          window.handleSearchInput = handleSearchInput;
          window.askLibraryQuestion = askLibraryQuestion;
          window.handleProfileNavClick = handleProfileNavClick;
          window.openBookDetail = openBookDetail;
          window.closeBookDetail = closeBookDetail;
          window.filterBooks = filterBooks;
        </script>
      </body>
      </html>
    `;

    return res.status(200).send(html);

  } catch (error: any) {
    console.error('[API] Error rendering profile page:', error);
    console.error('[API] Error stack:', error?.stack);
    console.error('[API] Error message:', error?.message);
    
    // Return a proper error page instead of just text
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - Bookshelf Scanner</title>
        <style>
          body { font-family: system-ui; padding: 40px; text-align: center; }
          h1 { color: #e74c3c; }
          pre { background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: left; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1>Error Loading Profile</h1>
        <p>An error occurred while loading this profile.</p>
        <pre>${error?.message || 'Unknown error'}</pre>
        <a href="/">Return to Home</a>
      </body>
      </html>
    `);
  }
}


