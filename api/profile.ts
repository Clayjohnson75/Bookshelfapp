import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add cache control headers
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Profile - Bookshelf Scanner</title>
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
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 40px 20px;
        }
        .signin-card {
          max-width: 450px;
          margin: 0 auto;
          background: white;
          border-radius: 12px;
          padding: 40px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
          border: 2px solid #34495e;
        }
        .signin-title {
          font-size: 28px;
          font-weight: 800;
          color: #2c3e50;
          margin-bottom: 10px;
          text-align: center;
        }
        .signin-subtitle {
          font-size: 16px;
          color: #666;
          margin-bottom: 30px;
          text-align: center;
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
          font-size: 16px;
          font-weight: 600;
          background: #34495e;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.2s, transform 0.2s;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          border: 2px solid #2c3e50;
        }
        .form-button:hover {
          background: #2c3e50;
          transform: translateY(-1px);
        }
        .form-button:disabled {
          background: #ccc;
          cursor: not-allowed;
          transform: none;
        }
        .error-message {
          background: #fee;
          color: #c33;
          padding: 12px;
          border-radius: 8px;
          margin-bottom: 20px;
          font-size: 14px;
          display: none;
        }
        .error-message.show {
          display: block;
        }
        .signup-link {
          text-align: center;
          margin-top: 20px;
          font-size: 14px;
          color: #666;
        }
        .signup-link a {
          color: #007AFF;
          text-decoration: none;
          font-weight: 600;
        }
        .signup-link a:hover {
          text-decoration: underline;
        }
        @media (max-width: 600px) {
          .signin-card {
            padding: 30px 20px;
          }
          .signin-title {
            font-size: 24px;
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
        </div>
      </div>

      <div class="nav-buttons">
        <div class="nav-buttons-content">
          <button class="nav-button" onclick="window.location.href='/'">Home</button>
          <button class="nav-button" onclick="window.location.href='/search'">Search</button>
          <button class="nav-button active" onclick="window.location.href='/profile'">Profile</button>
        </div>
      </div>

      <div class="container">
        <div class="signin-card" id="signinCard">
          <h1 class="signin-title">Sign In</h1>
          <p class="signin-subtitle">Sign in to view and edit your profile</p>
          
          <form id="signInForm" onsubmit="handleSignIn(event)">
            <div class="form-group">
              <label class="form-label" for="email">Email or Username</label>
              <input
                type="text"
                class="form-input"
                id="email"
                name="email"
                placeholder="Enter your email or username"
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
                placeholder="Enter your password"
                required
                autocomplete="current-password"
              />
            </div>
            
            <div class="error-message" id="errorMessage"></div>
            
            <button type="submit" class="form-button" id="submitButton">Sign In</button>
          </form>
          
          <div class="signup-link">
            Don't have an account? <a href="https://apps.apple.com/us/app/bookshelfscan/id6754891159" target="_blank">Download the app to sign up</a>
          </div>
        </div>
      </div>

      <script>
        // Check if user is signed in on page load
        window.addEventListener('DOMContentLoaded', async () => {
          const session = localStorage.getItem('supabase_session');
          if (session) {
            try {
              const sessionData = JSON.parse(session);
              // Get username from API
              const response = await fetch('/api/get-username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: sessionData })
              });
              
              if (response.ok) {
                const data = await response.json();
                if (data.username) {
                  // Redirect to their profile page
                  window.location.href = \`/\${data.username}?edit=true\`;
                }
              }
            } catch (error) {
              console.error('Error checking session:', error);
              // Stay on sign-in page if error
            }
          }
        });

        async function handleSignIn(event) {
          event.preventDefault();
          const email = document.getElementById('email').value.trim();
          const password = document.getElementById('password').value;
          const submitButton = document.getElementById('submitButton');
          const errorDiv = document.getElementById('errorMessage');

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

            // Success! Store session and redirect to profile
            if (data.session) {
              localStorage.setItem('supabase_session', JSON.stringify(data.session));
              
              // Get username to redirect to profile
              const usernameResponse = await fetch('/api/get-username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: data.session })
              });
              
              if (usernameResponse.ok) {
                const usernameData = await usernameResponse.json();
                if (usernameData.username) {
                  // Redirect to profile with a small delay to ensure session is stored
                  setTimeout(() => {
                    window.location.href = \`/\${usernameData.username}?edit=true\`;
                  }, 100);
                } else {
                  console.error('No username returned from get-username API');
                  window.location.href = '/search';
                }
              } else {
                const errorData = await usernameResponse.json().catch(() => ({}));
                console.error('Error getting username:', errorData);
                // If profile not found error, might be a new account - redirect to search
                if (usernameResponse.status === 404) {
                  alert('Your profile may not be set up yet. Redirecting to search...');
                }
                window.location.href = '/search';
              }
            } else {
              throw new Error('No session received');
            }
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

