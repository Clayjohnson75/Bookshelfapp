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

    if (!token || type !== 'recovery') {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Reset Error</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px; }
            .container { max-width: 500px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 30px; }
            h1 { color: #dc3545; }
            p { color: #6c757d; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Invalid Link</h1>
            <p>The password reset link is invalid or expired. Please request a new one.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
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

    // Create Supabase admin client
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Return HTML page with password reset form
    const resetToken = encodeURIComponent(token as string);
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password - Bookshelf Scanner</title>
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
            text-align: center;
            font-weight: 800;
            letter-spacing: 0.5px;
          }
          .subtitle {
            color: #2c3e50;
            font-size: 14px;
            text-align: center;
            margin-bottom: 30px;
            font-weight: 500;
          }
          .form-group {
            margin-bottom: 20px;
          }
          label {
            display: block;
            color: #2c3e50;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
          }
          input[type="password"] {
            width: 100%;
            padding: 12px 16px;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            font-size: 16px;
            transition: border-color 0.3s;
            background: #fff;
          }
          input[type="password"]:focus {
            outline: none;
            border-color: #007AFF;
          }
          .error {
            color: #e74c3c;
            font-size: 14px;
            margin-top: 8px;
            display: none;
          }
          .error.show {
            display: block;
          }
          .success {
            color: #27ae60;
            font-size: 14px;
            margin-top: 8px;
            display: none;
          }
          .success.show {
            display: block;
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
          button:active {
            transform: translateY(0);
          }
          button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
          }
          .password-requirements {
            font-size: 12px;
            color: #2c3e50;
            margin-top: 5px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="/logo.png" alt="Bookshelf Scanner Logo" class="logo">
          <h1>Reset Your Password</h1>
          <p class="subtitle">Enter your new password below</p>
          
          <form id="resetForm">
            <div class="form-group">
              <label for="password">New Password</label>
              <input type="password" id="password" name="password" required minlength="6" autocomplete="new-password">
              <div class="password-requirements">Must be at least 6 characters</div>
              <div class="error" id="passwordError"></div>
            </div>
            
            <div class="form-group">
              <label for="confirmPassword">Confirm Password</label>
              <input type="password" id="confirmPassword" name="confirmPassword" required minlength="6" autocomplete="new-password">
              <div class="error" id="confirmError"></div>
            </div>
            
            <div class="error" id="formError"></div>
            <div class="success" id="successMessage">Your password has been successfully updated!</div>
            
            <button type="submit" id="submitBtn">Reset Password</button>
          </form>
        </div>
        
        <script>
          const form = document.getElementById('resetForm');
          const passwordInput = document.getElementById('password');
          const confirmInput = document.getElementById('confirmPassword');
          const passwordError = document.getElementById('passwordError');
          const confirmError = document.getElementById('confirmError');
          const formError = document.getElementById('formError');
          const successMessage = document.getElementById('successMessage');
          const submitBtn = document.getElementById('submitBtn');
          
          const urlParams = new URLSearchParams(window.location.search);
          const token = urlParams.get('token');
          
          if (!token) {
            formError.textContent = 'Invalid reset link. Please request a new password reset.';
            formError.classList.add('show');
            form.style.display = 'none';
          }
          
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Clear previous errors
            passwordError.classList.remove('show');
            confirmError.classList.remove('show');
            formError.classList.remove('show');
            successMessage.classList.remove('show');
            
            const password = passwordInput.value;
            const confirmPassword = confirmInput.value;
            
            // Validate passwords match
            if (password !== confirmPassword) {
              confirmError.textContent = 'Passwords do not match';
              confirmError.classList.add('show');
              return;
            }
            
            // Validate password length
            if (password.length < 6) {
              passwordError.textContent = 'Password must be at least 6 characters';
              passwordError.classList.add('show');
              return;
            }
            
            // Disable button and show loading
            submitBtn.disabled = true;
            submitBtn.textContent = 'Updating Password...';
            
            try {
              const response = await fetch('/api/update-password', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  token: token,
                  password: password,
                  confirmPassword: confirmPassword
                })
              });
              
              const data = await response.json();
              
              if (response.ok && data.success) {
                // Show success message
                form.style.display = 'none';
                successMessage.classList.add('show');
                
                // Optionally redirect to app after 3 seconds
                setTimeout(() => {
                  window.location.href = 'bookshelfscanner://';
                }, 3000);
              } else {
                // Show error
                formError.textContent = data.message || 'Failed to update password. Please try again.';
                formError.classList.add('show');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Reset Password';
              }
            } catch (error) {
              formError.textContent = 'An error occurred. Please try again.';
              formError.classList.add('show');
              submitBtn.disabled = false;
              submitBtn.textContent = 'Reset Password';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (error: any) {
    console.error('[API] Error in password-reset:', error);
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
        <p>An error occurred. Please try again later.</p>
      </body>
      </html>
    `);
  }
}

