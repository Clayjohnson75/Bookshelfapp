import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

  if (!username || typeof username !== 'string') {
    return res.status(400).send('Invalid username');
  }

  // Fetch profile data from our API
  const baseUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : 'https://bookshelfscan.app';
  
  try {
    const profileResponse = await fetch(`${baseUrl}/api/public-profile/${username}`);
    
    if (!profileResponse.ok) {
      // Try to get error details for debugging
      let errorMessage = 'Profile not found';
      try {
        const errorData = await profileResponse.json();
        errorMessage = errorData.message || errorData.error || 'Profile not found';
        console.error('[API] Profile fetch error:', {
          status: profileResponse.status,
          statusText: profileResponse.statusText,
          error: errorData
        });
      } catch (e) {
        console.error('[API] Profile fetch failed:', {
          status: profileResponse.status,
          statusText: profileResponse.statusText,
          url: `${baseUrl}/api/public-profile/${username}`
        });
      }
      
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

    const data = await profileResponse.json();
    const { profile, books, stats } = data;

    // Generate HTML for the profile page
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${profile.displayName}'s Library - Bookshelf Scanner</title>
        <meta name="description" content="View ${profile.displayName}'s book collection on Bookshelf Scanner">
        <meta property="og:title" content="${profile.displayName}'s Library - Bookshelf Scanner">
        <meta property="og:description" content="${stats.totalBooks} books in ${profile.displayName}'s collection">
        <meta property="og:image" content="${profile.avatarUrl || '/logo.png'}">
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
            margin-bottom: 30px;
            letter-spacing: 0.5px;
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
            <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" style="color: #007AFF; text-decoration: none; font-weight: 600;">Get the App</a>
          </div>
        </div>
        
        <div class="container">
          <div class="profile-header">
            ${profile.avatarUrl 
              ? `<img src="${profile.avatarUrl}" alt="${profile.displayName}" class="avatar">`
              : `<div class="avatar-placeholder">${profile.displayName.charAt(0).toUpperCase()}</div>`
            }
            <h1 class="profile-name">${profile.displayName}</h1>
            <div class="profile-username">@${profile.username}</div>
            ${profile.bio ? `<div class="profile-bio">${profile.bio}</div>` : ''}
            
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
            ${books.length > 0 
              ? `<div class="books-grid">
                  ${books.map((book: any) => `
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
      </body>
      </html>
    `;

    return res.status(200).send(html);

  } catch (error: any) {
    console.error('[API] Error rendering profile page:', error);
    return res.status(500).send('Error loading profile');
  }
}

