import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { token, type } = req.query;

  if (!token || !type) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Password Reset Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; text-align: center; padding: 20px; }
          .container { max-width: 500px; margin: 50px auto; border: 1px solid #ddd; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          h1 { color: #dc3545; }
          p { color: #6c757d; }
          a { color: #007bff; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Password Reset Error</h1>
          <p>The password reset link is invalid or expired. Please request a new one.</p>
          <p><a href="bookshelfscanner://">Open Bookshelf Scanner App</a></p>
        </div>
      </body>
      </html>
    `);
  }

  const deepLink = `bookshelfscanner://reset-password?token=${encodeURIComponent(token as string)}&type=${encodeURIComponent(type as string)}`;

  // Redirect to the deep link immediately
  res.setHeader('Location', deepLink);
  res.statusCode = 302;
  res.end();

  // Fallback HTML for browsers that don't handle deep links well
  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Password Reset</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="refresh" content="0; url=${deepLink}">
      <style>
        body { font-family: sans-serif; text-align: center; padding: 20px; }
        .container { max-width: 500px; margin: 50px auto; border: 1px solid #ddd; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #28a745; }
        p { color: #6c757d; }
        a { color: #007bff; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Redirecting...</h1>
        <p>If you are not redirected automatically, <a href="${deepLink}">click here to open the app</a>.</p>
        <p>If the app does not open, please ensure you have the Bookshelf Scanner app installed.</p>
      </div>
    </body>
    </html>
  `);
}

