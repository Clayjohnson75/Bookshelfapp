import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { q } = req.query;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/logo.png" type="image/png">
      <link rel="apple-touch-icon" href="/logo.png">
      <title>Search Users - Bookshelf Scanner</title>
      <style>
        :root {
          --bg: #F6F3EE;
          --bg-secondary: #F0ECE6;
          --surface: #FAF8F5;
          --accent: #C9A878;
          --accent-hover: #B8956A;
          --text: #1B1B1B;
          --text-secondary: #6B6B6B;
          --text-muted: #9A9A9A;
          --border: #E6E1D8;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: var(--bg);
          min-height: 100vh;
          color: var(--text);
        }
        .header {
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          padding: 16px 0;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .header-content {
          max-width: 960px;
          margin: 0 auto;
          padding: 0 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .logo-link {
          display: flex;
          align-items: center;
          text-decoration: none;
          color: var(--text);
          font-weight: 700;
          font-size: 17px;
          gap: 10px;
        }
        .logo-link img { width: 28px; height: 28px; border-radius: 6px; }
        .nav { display: flex; gap: 4px; align-items: center; }
        .nav a {
          padding: 8px 16px;
          text-decoration: none;
          color: var(--text-secondary);
          font-size: 14px;
          font-weight: 600;
          border-radius: 8px;
          transition: all 0.15s;
        }
        .nav a:hover { background: var(--bg-secondary); color: var(--text); }
        .nav a.active { color: var(--accent-hover); background: var(--bg-secondary); }
        .get-app {
          display: inline-flex;
          background: var(--text);
          color: var(--surface);
          padding: 8px 16px;
          border-radius: 8px;
          text-decoration: none;
          font-size: 13px;
          font-weight: 600;
          transition: opacity 0.15s;
        }
        .get-app:hover { opacity: 0.85; }

        .container {
          max-width: 640px;
          margin: 0 auto;
          padding: 48px 24px;
        }
        .page-title {
          font-size: 28px;
          font-weight: 800;
          margin-bottom: 24px;
        }
        .search-input {
          width: 100%;
          padding: 14px 18px;
          font-size: 16px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--surface);
          color: var(--text);
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .search-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .search-input::placeholder { color: var(--text-muted); }

        .results { margin-top: 32px; }
        .results-label {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 16px;
        }
        .empty-state {
          text-align: center;
          padding: 48px 20px;
          color: var(--text-muted);
          font-size: 15px;
        }
        .user-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .user-info h3 {
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 4px;
        }
        .user-info .username {
          font-size: 14px;
          color: var(--text-secondary);
          margin-bottom: 12px;
        }
        .user-stats {
          display: flex;
          gap: 16px;
        }
        .stat-item {
          font-size: 13px;
          color: var(--text-secondary);
        }
        .stat-item strong {
          color: var(--text);
          font-weight: 700;
        }
        .view-btn {
          flex-shrink: 0;
          background: var(--text);
          color: #fff;
          padding: 10px 20px;
          border-radius: 10px;
          text-decoration: none;
          font-size: 14px;
          font-weight: 600;
          transition: opacity 0.15s;
        }
        .view-btn:hover { opacity: 0.85; }

        .footer {
          border-top: 1px solid var(--border);
          padding: 32px 24px;
          text-align: center;
          margin-top: 80px;
        }
        .footer a {
          color: var(--text-secondary);
          text-decoration: none;
          font-size: 13px;
          font-weight: 500;
          margin: 0 12px;
          transition: color 0.15s;
        }
        .footer a:hover { color: var(--accent-hover); }

        @media (max-width: 600px) {
          .container { padding: 32px 16px; }
          .page-title { font-size: 24px; }
          .user-card { flex-direction: column; align-items: flex-start; }
          .view-btn { width: 100%; text-align: center; }
          .get-app { display: none; }
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
          <nav class="nav">
            <a href="/">Home</a>
            <a href="/search" class="active">Search</a>
            <a href="/profile">Profile</a>
          </nav>
          <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" class="get-app" target="_blank">Get the App</a>
        </div>
      </div>

      <div class="container">
        <h1 class="page-title">Search Users</h1>
        <input
          type="text"
          class="search-input"
          id="searchInput"
          placeholder="Search by username..."
          oninput="handleSearch()"
          value="${(q || '').toString().replace(/"/g, '&quot;')}"
          autofocus
        />

        <div class="results">
          <div class="results-label">Results</div>
          <div id="searchResults" class="empty-state">Enter a username to search</div>
        </div>
      </div>

      <div class="footer">
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms</a>
        <a href="/support.html">Support</a>
        <a href="mailto:bookshelfscanapp@gmail.com">Contact</a>
      </div>

      <script>
        let searchTimeout;
        async function handleSearch() {
          clearTimeout(searchTimeout);
          searchTimeout = setTimeout(async () => {
            const query = document.getElementById('searchInput').value.trim();
            const resultsDiv = document.getElementById('searchResults');

            if (!query) {
              resultsDiv.className = 'empty-state';
              resultsDiv.innerHTML = 'Enter a username to search';
              return;
            }
            if (query.length < 2) {
              resultsDiv.className = 'empty-state';
              resultsDiv.innerHTML = 'Enter at least 2 characters';
              return;
            }

            resultsDiv.className = 'empty-state';
            resultsDiv.innerHTML = 'Searching...';

            try {
              const response = await fetch('/api/public-profile/' + encodeURIComponent(query));

              if (response.status === 404) {
                resultsDiv.className = 'empty-state';
                resultsDiv.innerHTML = 'No user found';
                return;
              }
              if (!response.ok) throw new Error('Search failed');

              const data = await response.json();
              resultsDiv.className = '';
              resultsDiv.innerHTML =
                '<div class="user-card">' +
                  '<div class="user-info">' +
                    '<h3>' + escapeHtml(data.profile.displayName) + '</h3>' +
                    '<div class="username">@' + escapeHtml(data.profile.username) + '</div>' +
                    '<div class="user-stats">' +
                      '<div class="stat-item"><strong>' + (data.stats.totalBooks || 0) + '</strong> books</div>' +
                      '<div class="stat-item"><strong>' + (data.stats.readBooks || 0) + '</strong> read</div>' +
                    '</div>' +
                  '</div>' +
                  '<a href="/' + encodeURIComponent(data.profile.username) + '" class="view-btn">View Profile</a>' +
                '</div>';
            } catch (error) {
              resultsDiv.className = 'empty-state';
              resultsDiv.innerHTML = 'Something went wrong. Please try again.';
            }
          }, 400);
        }

        function escapeHtml(str) {
          var div = document.createElement('div');
          div.textContent = str || '';
          return div.innerHTML;
        }

        window.addEventListener('DOMContentLoaded', () => {
          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.get('q')) handleSearch();
        });
      </script>
    </body>
    </html>
  `;

  return res.status(200).send(html);
}
