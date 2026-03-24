import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/logo.png" type="image/png">
      <link rel="apple-touch-icon" href="/logo.png">
      <title>Sign In - Bookshelf Scanner</title>
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
          max-width: 420px;
          margin: 0 auto;
          padding: 64px 24px;
        }
        .signin-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 36px 32px;
        }
        .signin-title {
          font-size: 24px;
          font-weight: 800;
          margin-bottom: 6px;
        }
        .signin-subtitle {
          font-size: 14px;
          color: var(--text-secondary);
          margin-bottom: 28px;
        }
        .form-group { margin-bottom: 18px; }
        .form-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: 6px;
        }
        .form-input {
          width: 100%;
          padding: 12px 14px;
          font-size: 15px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg);
          color: var(--text);
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .form-button {
          width: 100%;
          padding: 13px;
          font-size: 15px;
          font-weight: 600;
          background: var(--text);
          color: #fff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-family: inherit;
          transition: opacity 0.15s;
          margin-top: 4px;
        }
        .form-button:hover { opacity: 0.85; }
        .form-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .error-message {
          background: #FEF2F2;
          color: #B91C1C;
          padding: 10px 14px;
          border-radius: 8px;
          margin-bottom: 16px;
          font-size: 13px;
          display: none;
          border: 1px solid #FECACA;
        }
        .error-message.show { display: block; }
        .loading-state {
          text-align: center;
          padding: 24px;
          color: var(--text-muted);
          font-size: 14px;
        }
        .signup-link {
          text-align: center;
          margin-top: 20px;
          font-size: 13px;
          color: var(--text-secondary);
        }
        .signup-link a {
          color: var(--accent-hover);
          text-decoration: none;
          font-weight: 600;
        }
        .signup-link a:hover { text-decoration: underline; }

        .footer {
          border-top: 1px solid var(--border);
          padding: 32px 24px;
          text-align: center;
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
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
          .container { padding: 40px 16px; }
          .signin-card { padding: 28px 20px; }
          .get-app { display: none; }
          .footer { position: static; margin-top: 40px; }
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
            <a href="/search">Search</a>
            <a href="/profile" class="active">Profile</a>
          </nav>
          <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" class="get-app" target="_blank">Get the App</a>
        </div>
      </div>

      <div class="container">
        <div id="loadingState" class="loading-state">Checking session...</div>

        <div class="signin-card" id="signinCard" style="display:none;">
          <h1 class="signin-title">Sign in</h1>
          <p class="signin-subtitle">Access your library and profile</p>

          <form id="signInForm" onsubmit="handleSignIn(event)">
            <div class="form-group">
              <label class="form-label" for="email">Email or Username</label>
              <input
                type="text"
                class="form-input"
                id="email"
                name="email"
                placeholder="you@example.com"
                required
                autocomplete="username"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="password">Password</label>
              <input
                type="password"
                class="form-input"
                id="password"
                name="password"
                placeholder="Your password"
                required
                autocomplete="current-password"
              />
            </div>

            <div class="error-message" id="errorMessage"></div>

            <button type="submit" class="form-button" id="submitButton">Sign In</button>
          </form>

          <div class="signup-link">
            No account yet? <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" target="_blank">Download the app to sign up</a>
          </div>
        </div>
      </div>

      <div class="footer">
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms</a>
        <a href="/support.html">Support</a>
      </div>

      <script>
        // On load: check for existing session, redirect to profile if found
        window.addEventListener('DOMContentLoaded', async () => {
          var loadingEl = document.getElementById('loadingState');
          var cardEl = document.getElementById('signinCard');

          var session = localStorage.getItem('supabase_session');
          if (session) {
            try {
              var sessionData = JSON.parse(session);
              if (sessionData && sessionData.access_token && sessionData.refresh_token) {
                // Sync session cookie
                await fetch('/api/web-sync-session', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ access_token: sessionData.access_token, refresh_token: sessionData.refresh_token }),
                }).catch(function() {});

                // Get username and redirect
                var response = await fetch('/api/get-username', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ session: sessionData })
                });

                if (response.ok) {
                  var data = await response.json();
                  if (data.username) {
                    window.location.replace('/' + data.username + '?edit=true');
                    return;
                  }
                }
              }
            } catch (e) {
              // Session invalid, clear it
              localStorage.removeItem('supabase_session');
            }
          }

          // No valid session — show sign-in form
          loadingEl.style.display = 'none';
          cardEl.style.display = 'block';
        });

        async function handleSignIn(event) {
          event.preventDefault();
          var email = document.getElementById('email').value.trim();
          var password = document.getElementById('password').value;
          var submitButton = document.getElementById('submitButton');
          var errorDiv = document.getElementById('errorMessage');

          submitButton.disabled = true;
          submitButton.textContent = 'Signing in...';
          errorDiv.classList.remove('show');

          try {
            var response = await fetch('/api/web-signin', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ emailOrUsername: email, password: password }),
            });

            var data = await response.json();
            if (!response.ok) throw new Error(data.message || data.error || 'Sign in failed');

            if (!data.session) throw new Error('No session received');

            localStorage.setItem('supabase_session', JSON.stringify(data.session));

            // Get username to redirect
            var usernameResponse = await fetch('/api/get-username', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session: data.session })
            });

            if (usernameResponse.ok) {
              var usernameData = await usernameResponse.json();
              if (usernameData.username) {
                window.location.replace('/' + usernameData.username + '?edit=true');
                return;
              }
            }
            // Fallback
            window.location.replace('/search');
          } catch (error) {
            errorDiv.textContent = error.message || 'Sign in failed. Please try again.';
            errorDiv.classList.add('show');
            submitButton.disabled = false;
            submitButton.textContent = 'Sign In';
          }
        }
      </script>
    </body>
    </html>
  `;

  return res.status(200).send(html);
}
