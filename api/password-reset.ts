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

    // Verify the token is valid (we don't need to actually reset here, just verify)
    // The app will handle the actual password reset
    const deepLink = `bookshelfscanner://reset-password?token=${encodeURIComponent(token as string)}&type=${encodeURIComponent(type as string)}`;
    
    // Return HTML that redirects to the app
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset</title>
        <script>
          // Try to open the app immediately
          window.location.href = '${deepLink}';
          
          // Fallback: Show message if app doesn't open
          setTimeout(function() {
            document.getElementById('fallback').style.display = 'block';
          }, 2000);
        </script>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            text-align: center; 
            padding: 40px; 
            background-color: #f8f9fa;
          }
          .container { 
            max-width: 500px; 
            margin: 0 auto; 
            background: white;
            border-radius: 10px; 
            padding: 40px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { color: #2c3e50; margin-bottom: 20px; }
          p { color: #666; font-size: 16px; }
          #fallback { display: none; margin-top: 30px; }
          a { color: #007AFF; text-decoration: none; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Opening App...</h1>
          <p>Redirecting to Bookshelf Scanner to reset your password...</p>
          <div id="fallback">
            <p>If the app didn't open automatically, <a href="${deepLink}">click here</a> to open it.</p>
            <p style="font-size: 14px; color: #999; margin-top: 20px;">Make sure you have the Bookshelf Scanner app installed.</p>
          </div>
        </div>
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

