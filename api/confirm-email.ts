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
    const { token, type } = req.query;

    if (!token || type !== 'signup') {
      return res.status(400).send(`
        <html>
          <body>
            <h1>Invalid confirmation link</h1>
            <p>The confirmation link is invalid or expired.</p>
          </body>
        </html>
      `);
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Server Error</title>
        </head>
        <body>
          <h1>Server Error</h1>
          <p>Server configuration error. Please try again later.</p>
        </body>
        </html>
      `);
    }

    // Return HTML page for email confirmation
    const confirmToken = encodeURIComponent(token as string);
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Confirm Your Email - Bookshelf Scanner</title>
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
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container { 
            max-width: 450px; 
            width: 100%;
            background: white;
            border-radius: 20px; 
            padding: 40px; 
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
            margin-bottom: 10px;
            font-size: 28px;
            font-weight: 800;
            letter-spacing: 0.5px;
          }
          .subtitle {
            color: #2c3e50;
            font-size: 14px;
            margin-bottom: 30px;
            font-weight: 500;
          }
          button {
            width: 100%;
            padding: 14px;
            background: #34495e;
            color: #ecf0f1;
            border: 1px solid #2c3e50;
            border-radius: 30px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
            margin-top: 10px;
            letter-spacing: 0.8px;
            box-shadow: 0 4px 15px rgba(52, 73, 94, 0.3);
          }
          button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(52, 73, 94, 0.4);
            background: #2c3e50;
          }
          button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
          }
          .error {
            color: #e74c3c;
            font-size: 14px;
            margin-top: 15px;
            display: none;
          }
          .error.show {
            display: block;
          }
          .success {
            color: #27ae60;
            font-size: 14px;
            margin-top: 15px;
            display: none;
          }
          .success.show {
            display: block;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="/logo.png" alt="Bookshelf Scanner Logo" class="logo">
          <h1>Confirm Your Email</h1>
          <p class="subtitle">Click the button below to confirm your email address</p>
          
          <button id="confirmBtn" onclick="confirmEmail()">Confirm Email</button>
          
          <div class="error" id="errorMessage"></div>
          <div class="success" id="successMessage">
            Your email has been confirmed! You can now sign in to the app.
          </div>
        </div>
        
        <script>
          const confirmToken = '${confirmToken}';
          
          async function confirmEmail() {
            const btn = document.getElementById('confirmBtn');
            const errorDiv = document.getElementById('errorMessage');
            const successDiv = document.getElementById('successMessage');
            
            // Clear previous messages
            errorDiv.classList.remove('show');
            successDiv.classList.remove('show');
            
            // Disable button
            btn.disabled = true;
            btn.textContent = 'Confirming...';
            
            try {
              const response = await fetch('/api/confirm-email-api', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  token: confirmToken
                })
              });
              
              const data = await response.json();
              
              if (response.ok && data.success) {
                // Show success message
                successDiv.classList.add('show');
                btn.style.display = 'none';
                
                // Redirect to app after 3 seconds
                setTimeout(() => {
                  window.location.href = 'bookshelfscanner://';
                }, 3000);
              } else {
                // Show error
                errorDiv.textContent = data.message || 'Failed to confirm email. The link may be invalid or expired.';
                errorDiv.classList.add('show');
                btn.disabled = false;
                btn.textContent = 'Confirm Email';
              }
            } catch (error) {
              console.error('Confirmation error:', error);
              errorDiv.textContent = 'An error occurred. Please try again.';
              errorDiv.classList.add('show');
              btn.disabled = false;
              btn.textContent = 'Confirm Email';
            }
          }
          
          // Auto-confirm on page load
          window.addEventListener('load', () => {
            setTimeout(confirmEmail, 500);
          });
        </script>
      </body>
      </html>
    `);
  } catch (error: any) {
    console.error('[API] Error confirming email:', error);
    return res.status(500).send(`
      <html>
        <body>
          <h1>Server Error</h1>
          <p>An error occurred while confirming your email. Please try again later.</p>
        </body>
      </html>
    `);
  }
}

