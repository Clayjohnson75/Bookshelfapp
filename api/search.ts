import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { q } = req.query;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Search - Bookshelf Scanner</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: #f8f6f0;
          min-height: 100vh;
          color: #2c3e50;
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
        .get-app-link {
          color: #007AFF;
          text-decoration: none;
          font-weight: 600;
          font-size: 14px;
        }
        .get-app-link:hover {
          text-decoration: underline;
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 40px 20px;
        }
        .search-section {
          padding: 0;
          margin-bottom: 30px;
        }
        .search-title {
          font-size: 32px;
          font-weight: 800;
          color: #2c3e50;
          margin-bottom: 20px;
        }
        .search-input {
          width: 100%;
          padding: 16px 20px;
          font-size: 18px;
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
        .results-section {
          padding: 0;
        }
        .results-title {
          font-size: 24px;
          font-weight: 800;
          color: #2c3e50;
          margin-bottom: 20px;
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
          .search-section,
          .results-section {
            padding: 20px;
          }
          .nav-buttons-content {
            padding: 0 10px;
            overflow-x: auto;
          }
          .nav-button {
            padding: 10px 16px;
            font-size: 14px;
            white-space: nowrap;
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
          <button class="nav-button active" onclick="window.location.href='/search'">Search</button>
          <button class="nav-button profile-button" onclick="handleProfileClick()" id="profileButton">Profile</button>
        </div>
      </div>

      <div class="container">
        <div class="search-section">
          <h1 class="search-title">Search Users</h1>
          <input 
            type="text" 
            class="search-input" 
            id="searchInput"
            placeholder="Search by username..." 
            oninput="handleSearch()"
            value="${q || ''}"
          />
        </div>

        <div class="results-section">
          <h2 class="results-title">Results</h2>
          <div id="searchResults" class="empty-state">
            <div class="empty-state-text">Enter a username to search</div>
          </div>
        </div>
      </div>

      <script>
          function handleProfileClick() {
            window.location.href = '/profile';
          }

        let searchTimeout;
        async function handleSearch() {
          clearTimeout(searchTimeout);
          searchTimeout = setTimeout(async () => {
            const query = document.getElementById('searchInput').value.trim();
            const resultsDiv = document.getElementById('searchResults');

            if (!query) {
              resultsDiv.innerHTML = '<div class="empty-state-text">Enter a username to search</div>';
              return;
            }

            // Require minimum 2 characters to prevent too many API calls for partial usernames
            if (query.length < 2) {
              resultsDiv.innerHTML = '<div class="empty-state-text">Enter at least 2 characters to search</div>';
              return;
            }
            
            // Increase debounce delay for better UX and fewer API calls

            resultsDiv.innerHTML = '<div class="empty-state-text">Searching...</div>';

            try {
              const response = await fetch(\`/api/public-profile/\${encodeURIComponent(query)}\`);
              
              // Handle 404s silently - user doesn't exist, which is expected
              if (response.status === 404) {
                resultsDiv.innerHTML = '<div class="empty-state-text">User not found</div>';
                return;
              }
              
              if (!response.ok) {
                // Only show error for non-404 status codes
                throw new Error(\`Search failed: \${response.status}\`);
              }
              
              const data = await response.json();
              // Use requestAnimationFrame for smooth DOM updates
              requestAnimationFrame(() => {
                resultsDiv.innerHTML = \`
                  <div style="padding: 20px; border-radius: 12px; margin-bottom: 15px; border: 2px solid #34495e;">
                    <h3 style="font-size: 20px; font-weight: 700; color: #2c3e50; margin-bottom: 10px;">\${data.profile.displayName}</h3>
                    <p style="color: #666; margin-bottom: 10px;">@\${data.profile.username}</p>
                    <div style="display: flex; gap: 20px; margin-bottom: 15px; flex-wrap: wrap;">
                      <div>
                        <span style="font-weight: 600; color: #2c3e50;">\${data.stats.totalBooks}</span> 
                        <span style="color: #666; font-size: 14px;">Total Books</span>
                      </div>
                      <div>
                        <span style="font-weight: 600; color: #2c3e50;">\${data.stats.readBooks}</span> 
                        <span style="color: #666; font-size: 14px;">Read</span>
                      </div>
                      <div>
                        <span style="font-weight: 600; color: #2c3e50;">\${data.stats.unreadBooks}</span> 
                        <span style="color: #666; font-size: 14px;">Unread</span>
                      </div>
                    </div>
                    <a href="/\${data.profile.username}" target="_blank" style="display: inline-block; background: #34495e; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; border: 2px solid #2c3e50;">View Profile</a>
                  </div>
                \`;
              });
            } catch (error) {
              // Only log actual errors (not expected 404s which are handled above)
              console.error('Search error:', error);
              requestAnimationFrame(() => {
                resultsDiv.innerHTML = '<div class="empty-state-text">Error searching. Please try again.</div>';
              });
            }
          }, 500); // Increased from 300ms to 500ms to reduce API calls
        }

        // Button always says "Profile" now
        window.addEventListener('DOMContentLoaded', () => {
          // If there's a query parameter, search immediately
          const urlParams = new URLSearchParams(window.location.search);
          const query = urlParams.get('q');
          if (query) {
            handleSearch();
          }
        });
      </script>
    </body>
    </html>
  `;

  return res.status(200).send(html);
}

