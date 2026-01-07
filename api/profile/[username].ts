import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
            background: white;
            border-radius: 20px;
            padding: 40px;
            margin-bottom: 30px;
            box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
            border: 1px solid #e0e0e0;
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
          }
          .stat-card {
            background: #f8f6f0;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
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
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
            border: 1px solid #e0e0e0;
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
          }
          .book-card {
            background: #f8f6f0;
            border-radius: 12px;
            overflow: hidden;
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: pointer;
          }
          .book-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
          }
          .book-cover {
            width: 100%;
            aspect-ratio: 2/3;
            object-fit: cover;
            background: #34495e;
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
            background: white;
            border-radius: 20px;
            padding: 40px;
            margin-top: 30px;
            box-shadow: 0 4px 20px rgba(44, 62, 80, 0.1);
            border: 1px solid #e0e0e0;
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
          .empty-state-icon {
            font-size: 64px;
            margin-bottom: 20px;
            opacity: 0.5;
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
            ${isEditMode ? `
              <div style="background: #e8f5e9; border: 2px solid #4caf50; border-radius: 8px; padding: 12px; margin-bottom: 20px; text-align: center;">
                <span style="color: #2e7d32; font-weight: 600; font-size: 14px;">✓ You are viewing your own profile</span>
              </div>
            ` : ''}
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
            <div class="search-container">
              <input 
                type="text" 
                class="search-input" 
                id="bookSearch" 
                placeholder="Search books by title or author..." 
                oninput="filterBooks()"
              />
            </div>
            ${(books || []).length > 0 
              ? `<div class="books-grid">
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
                  <div class="empty-state-icon">📚</div>
                  <div class="empty-state-text">No books yet</div>
                </div>`
            }
          </div>

          ${stats.topAuthors.length > 0 ? `
            <div class="top-authors">
              <h2 class="section-title">Top Authors</h2>
              <ul class="author-list">
                ${stats.topAuthors.map((item: any) => `
                  <li class="author-item">
                    <span class="author-name">${item.author}</span>
                    <span class="author-count">${item.count} book${item.count !== 1 ? 's' : ''}</span>
                  </li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
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

          function filterBooks() {
            const searchTerm = document.getElementById('bookSearch').value.toLowerCase();
            const bookCards = document.querySelectorAll('.book-card');
            
            bookCards.forEach(card => {
              const title = card.querySelector('.book-title')?.textContent?.toLowerCase() || '';
              const author = card.querySelector('.book-author')?.textContent?.toLowerCase() || '';
              const matches = title.includes(searchTerm) || author.includes(searchTerm);
              card.style.display = matches ? 'block' : 'none';
            });
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
            
            if (book.average_rating) {
              const ratingText = book.average_rating.toFixed(1) + (book.ratings_count ? \` (\${book.ratings_count} ratings)\` : '');
              html += \`
                <div class="book-detail-info-item">
                  <div class="book-detail-info-label">Rating</div>
                  <div class="book-detail-info-value">\${ratingText}</div>
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

          function handleProfileNavClick() {
            const session = localStorage.getItem('supabase_session');
            if (session) {
              // User is signed in, show their profile in edit mode
              window.location.href = \`/\${username}?edit=true\`;
            } else {
              // User not signed in, open sign in modal
              openSignInModal();
            }
          }

          // Check if user is signed in on page load
          window.addEventListener('DOMContentLoaded', () => {
            const session = localStorage.getItem('supabase_session');
            const urlParams = new URLSearchParams(window.location.search);
            const isEditMode = urlParams.get('edit') === 'true';
            
            if (session && !isEditMode) {
              // User has session but not in edit mode, redirect to edit mode
              window.location.href = \`/\${username}?edit=true\`;
            } else if (!session && isEditMode) {
              // User in edit mode but no session, redirect to regular view
              window.location.href = \`/\${username}\`;
            }
          });

          function openSignInModal() {
            document.getElementById('signInModal').classList.add('show');
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
                  username: username,
                }),
              });

              const data = await response.json();

              if (!response.ok) {
                throw new Error(data.message || data.error || 'Sign in failed');
              }

              // Success! Store session and redirect to edit view
              if (data.session) {
                // Store session token in localStorage
                localStorage.setItem('supabase_session', JSON.stringify(data.session));
                // Redirect to edit view
                window.location.href = \`/\${username}?edit=true\`;
              } else {
                closeSignInModal();
                alert('Signed in successfully! Redirecting...');
                window.location.href = \`/\${username}?edit=true\`;
              }
            } catch (error) {
              errorDiv.textContent = error.message || 'Sign in failed. Please try again.';
              errorDiv.classList.add('show');
            } finally {
              submitButton.disabled = false;
              submitButton.textContent = 'Sign In';
            }
          }
        </script>
      </body>
      </html>
    `;

    return res.status(200).send(html);

  } catch (error: any) {
    console.error('[API] Error rendering profile page:', error);
    return res.status(500).send('Error loading profile');
  }
}

