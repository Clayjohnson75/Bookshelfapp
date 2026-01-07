import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

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
              grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
              gap: 15px;
            }
            .stats-grid {
              grid-template-columns: repeat(2, 1fr);
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
            <div style="display: flex; gap: 15px; align-items: center;">
              <button class="sign-in-button" onclick="openSignInModal()">Sign In</button>
              <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" style="color: #007AFF; text-decoration: none; font-weight: 600;">Get the App</a>
            </div>
          </div>
        </div>
        
        <div class="container">
          <div class="profile-header">
            <h1 class="profile-name">${profileData.displayName}</h1>
            <div class="profile-username">@${profileData.username}</div>
            ${profileData.bio ? `<div class="profile-bio">${profileData.bio}</div>` : ''}
            
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
                  ${(books || []).map((book: any) => `
                    <div class="book-card">
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

              // Success! Redirect to edit page or show edit options
              // For now, just close modal and show success message
              closeSignInModal();
              alert('Signed in successfully! Edit functionality coming soon.');
              // TODO: Redirect to edit page: window.location.href = \`/\${username}/edit\`;
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

