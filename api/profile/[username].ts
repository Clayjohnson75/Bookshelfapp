import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 // Check URL path directly first to catch static file requests early
 const url = req.url || '';
 const pathname = url.split('?')[0]; // Remove query params
 
 // Reject static file requests immediately (favicon, robots.txt, etc.)
 if (pathname.match(/\.(png|ico|svg|jpg|jpeg|gif|txt|xml|json|css|js|woff|woff2|ttf|eot|webp|avif)$/i) ||
 pathname.toLowerCase().includes('favicon') ||
 pathname.toLowerCase().includes('robots') ||
 pathname.toLowerCase().includes('sitemap') ||
 pathname.toLowerCase().includes('.well-known')) {
 return res.status(404).end(); // Silent 404, no body
 }
 
 // Add cache control headers to ensure fresh data
 res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
 res.setHeader('Pragma', 'no-cache');
 res.setHeader('Expires', '0');
 
 // Ensure username is a string (could be array if in query params)
 const username = Array.isArray(req.query.username) ? req.query.username[0] : req.query.username;
 const edit = Array.isArray(req.query.edit) ? req.query.edit[0] : req.query.edit;
 const isEditMode = edit === 'true';

 // Reject static file requests (favicon, etc.) that get incorrectly routed
 if (!username || typeof username !== 'string') {
 return res.status(404).end(); // Silent 404
 }
 
 const lowerUsername = username.toLowerCase();
 const staticFilePatterns = [
 'favicon', 'robots.txt', 'sitemap.xml', '.well-known',
 'app-ads.txt', 'ads.txt', 'apple-app-site-association', 
 'assetlinks.json', '.png', '.ico', '.svg', '.jpg', '.jpeg',
 '.gif', '.txt', '.xml', '.json', '.css', '.js'
 ];
 
 // Check if it's a static file request (has file extension or matches patterns)
 const hasFileExtension = /\.(png|ico|svg|jpg|jpeg|gif|txt|xml|json|css|js|woff|woff2|ttf|eot)$/i.test(username);
 const matchesStaticPattern = staticFilePatterns.some(pattern => lowerUsername.includes(pattern));
 
 if (hasFileExtension || matchesStaticPattern) {
 return res.status(404).end(); // Silent 404
 }
 
 // Also validate username format (should be alphanumeric + underscore/hyphen, no dots)
 if (!/^[a-z0-9_-]+$/i.test(username)) {
 return res.status(404).end(); // Silent 404
 }

 try {
 // Get Supabase credentials
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

 if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[API] Missing Supabase credentials');
  return res.status(500).send(`
 <!DOCTYPE html>
 <html>
 <head>
 <title>Server Error - Bookshelf Scanner</title>
 <style>
 body { font-family: system-ui; padding: 40px; text-align: center; background: #f8f6f0; }
 .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; }
 h1 { color: #e74c3c; }
 </style>
 </head>
 <body>
 <div class="container">
 <h1>Server Configuration Error</h1>
 <p>The server is missing required configuration. Please contact support.</p>
 <a href="/">Return to Home</a>
 </div>
 </body>
 </html>
 `);
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
 .select('id, username, display_name, avatar_url, profile_bio, created_at, public_profile_enabled, profile_settings')
 .eq('username', username.toLowerCase())
 .single();

 // Handle errors
 if (profileError) {
 console.error('[API] Profile fetch error:', {
 code: profileError.code,
 message: profileError.message,
 details: profileError.details,
 hint: profileError.hint,
 username: username
 });
 
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
 
 // Other errors - return proper error page with more details
 console.error('[API] Database error details:', {
 code: profileError.code,
 message: profileError.message,
 details: profileError.details,
 hint: profileError.hint,
 username: username
 });
 
 // Provide more helpful error message based on error type
 let errorMessage = 'An error occurred while loading this profile. Please try again later.';
 if (profileError.code === 'PGRST301' || profileError.message?.includes('permission') || profileError.message?.includes('RLS')) {
 errorMessage = 'You do not have permission to view this profile.';
 } else if (profileError.message?.includes('timeout') || profileError.message?.includes('network')) {
 errorMessage = 'The request timed out. Please check your connection and try again.';
 } else if (profileError.code) {
 errorMessage = `Database error (${profileError.code}): ${profileError.message || 'Unknown error'}`;
 }
 
 return res.status(500).send(`
 <!DOCTYPE html>
 <html>
 <head>
 <title>Error - Bookshelf Scanner</title>
 <style>
 body { font-family: system-ui; padding: 40px; text-align: center; background: #f8f6f0; }
 .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; }
 h1 { color: #e74c3c; }
 p { color: #666; margin: 10px 0; }
 .error-details { font-size: 12px; color: #999; margin-top: 20px; }
 a { color: #007AFF; text-decoration: none; display: inline-block; margin-top: 20px; }
 </style>
 </head>
 <body>
 <div class="container">
 <h1>Error Loading Profile</h1>
 <p>${errorMessage}</p>
 <div class="error-details">Error Code: ${profileError.code || 'Unknown'}</div>
 <a href="/">Return to Home</a>
 <br>
 <a href="/profile">Try Signing In Again</a>
 </div>
 </body>
 </html>
 `);
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

 // Get user's public books (only approved books; include is_favorite for Favorites bar)
 const { data: books, error: booksError } = await supabase
 .from('books')
 .select('id, title, author, cover_url, description, scanned_at, read_at, page_count, categories, publisher, published_date, average_rating, ratings_count, is_favorite')
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
 const topAuthorsWithBooks = (books || []).length > 0
 ? topAuthors.map(({ author, count }) => ({
 author,
 count,
 books: (books || []).filter((b: any) => b.author === author)
 }))
 : [];

 // Get user's folders (for profile display; service role can read any user's folders)
 let folders: { id: string; name: string; book_ids: string[] }[] = [];
 try {
 const { data: foldersData } = await supabase
 .from('folders')
 .select('id, name, book_ids')
 .eq('user_id', profile.id)
 .order('created_at', { ascending: true });
 folders = (foldersData || []).map((f: any) => ({
 id: f.id,
 name: f.name || 'Unnamed',
 book_ids: Array.isArray(f.book_ids) ? f.book_ids : (typeof f.book_ids === 'string' ? (() => { try { return JSON.parse(f.book_ids); } catch { return []; } })() : [])
 }));
 } catch (e) {
 // folders table may not exist yet
 }

 // Get profile settings from DB or use defaults
 const defaults = {
 backgroundColor: '#f8f6f0',
 buttonColor: '#007AFF',
 textColor: '#2c3e50',
 showTotalBooks: true,
 showReadBooks: true,
 showUnreadBooks: true,
 showTopAuthors: false,
 showFavorites: false,
 showFolders: false,
 hideBio: false,
 hideAvatar: false
 };
 const saved = (profile as { profile_settings?: typeof defaults }).profile_settings;
 const settings = saved && typeof saved === 'object'
 ? { ...defaults, ...saved }
 : defaults;

 // Profile photo: read from profile_photos only (not profiles.avatar_url).
 // Filter deleted_at IS NULL so "Clear Account Data" soft-deletes are respected.
 const { data: profilePhoto } = await supabase
 .from('profile_photos')
 .select('uri')
 .eq('user_id', profile.id)
 .is('deleted_at', null)
 .maybeSingle();

 // Format profile data with safe defaults
 const profileData = {
 id: profile.id || '',
 username: String(profile.username || username || ''),
 displayName: String(profile.display_name || profile.username || username || 'Unknown'),
 avatarUrl: profilePhoto?.uri ?? null,
 bio: profile.profile_bio || null,
 createdAt: profile.created_at || null,
 settings
 };

 const stats = {
 totalBooks,
 readBooks,
 unreadBooks,
 topAuthors,
 };

 const booksList = books || [];
 const booksById = new Map(booksList.map((b: any) => [b.id, b]));
 const favoriteBooks = booksList.filter((b: any) => b.is_favorite === true);
 const folderBooks = (folder: { book_ids: string[] }) =>
 (folder.book_ids || [])
 .map((id: string) => booksById.get(id))
 .filter(Boolean) as any[];

 const escapeHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
 const favoritesContent = settings.showFavorites
 ? (favoriteBooks.length > 0
 ? favoriteBooks.map((book: any) => {
 const idx = booksList.findIndex((b: any) => b.id === book.id);
 if (idx < 0) return '';
 const titleEsc = escapeHtml(book.title);
 const authorEsc = book.author ? escapeHtml(book.author) : '';
 const cover = book.cover_url
 ? `<img src="${book.cover_url.replace(/"/g, '&quot;')}" alt="${titleEsc}" class="book-cover">`
 : `<div class="book-cover-placeholder">${titleEsc}</div>`;
 return `<div class="book-card" onclick="openBookDetail(${idx})">${cover}<div class="book-info"><div class="book-title">${titleEsc}</div>${book.author ? `<div class="book-author">${authorEsc}</div>` : ''}</div></div>`;
 }).join('')
 : '<div class="empty-state"><div class="empty-state-text">No favorites yet</div></div>')
 : '';
 const foldersContent = settings.showFolders
 ? (folders.length > 0
 ? folders.map((folder: { id: string; name: string; book_ids: string[] }) => {
 const fBooks = folderBooks(folder);
 const nameEsc = escapeHtml(folder.name);
 if (fBooks.length === 0) return `<div class="folder-card"><div class="folder-name">${nameEsc}</div><div class="folder-books"><span style="color:#999;">Empty</span></div></div>`;
 const cards = fBooks.map((book: any) => {
 const idx = booksList.findIndex((b: any) => b.id === book.id);
 if (idx < 0) return '';
 const titleEsc = escapeHtml(book.title);
 const cover = book.cover_url
 ? `<img src="${book.cover_url.replace(/"/g, '&quot;')}" alt="${titleEsc}" class="book-cover">`
 : `<div class="book-cover-placeholder">${titleEsc}</div>`;
 return `<div class="book-card" onclick="openBookDetail(${idx})">${cover}<div class="book-info"><div class="book-title">${titleEsc}</div></div></div>`;
 }).join('');
 return `<div class="folder-card"><div class="folder-name">${nameEsc} (${fBooks.length})</div><div class="folder-books">${cards}</div></div>`;
 }).join('')
 : '<div class="empty-state"><div class="empty-state-text">No collections yet</div></div>')
 : '';
 const topAuthorsContent = settings.showTopAuthors
 ? (topAuthorsWithBooks.length > 0
 ? topAuthorsWithBooks.map((a: { author: string; count: number; books: any[] }, idx: number) => {
 const authorEsc = escapeHtml(a.author);
 const booksHtml = a.books.map((book: any) => {
 const bidx = booksList.findIndex((b: any) => b.id === book.id);
 const idxAttr = bidx >= 0 ? bidx : booksList.findIndex((b: any) => b.title === book.title && b.author === book.author);
 const i = idxAttr >= 0 ? idxAttr : 0;
 const titleEsc = escapeHtml(book.title || 'Untitled');
 const cover = book.cover_url
 ? `<img src="${book.cover_url.replace(/"/g, '&quot;')}" alt="${titleEsc}" class="top-author-book-cover">`
 : `<div class="top-author-book-cover-placeholder">${titleEsc}</div>`;
 return `<div class="top-author-book-card" onclick="event.stopPropagation(); openBookDetail(${i})">${cover}<div class="top-author-book-title">${titleEsc}</div></div>`;
 }).join('');
 return `<div class="top-author-card" data-author-idx="${idx}">
 <div class="top-author-bar" onclick="toggleTopAuthor(${idx})">
 <span class="top-author-name">${authorEsc}</span>
 <span class="top-author-count">${a.count} ${a.count === 1 ? 'book' : 'books'}</span>
 <span class="top-author-chevron" id="topAuthorChevron${idx}"></span>
 </div>
 <div class="top-author-books" id="topAuthorBooks${idx}" style="display:none;">${booksHtml}</div>
 </div>`;
 }).join('')
 : '<div class="empty-state"><div class="empty-state-text">No authors yet</div></div>')
 : '';

 // Generate HTML for the profile page
 const html = `
 <!DOCTYPE html>
 <html lang="en">
 <head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <link rel="icon" href="/logo.png" type="image/png">
 <link rel="apple-touch-icon" href="/logo.png">
 <title>${profileData.displayName}'s Library - Bookshelf Scanner</title>
 <meta name="description" content="View ${profileData.displayName}'s book collection on Bookshelf Scanner">
 <meta property="og:title" content="${profileData.displayName}'s Library - Bookshelf Scanner">
 <meta property="og:description" content="${stats.totalBooks} books in ${profileData.displayName}'s collection">
 <meta property="og:image" content="/logo.png">
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
 background: ${settings.backgroundColor};
 color: ${settings.textColor};
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
 .get-app-link {
 color: #007AFF;
 text-decoration: none;
 font-weight: 600;
 font-size: 14px;
 }
 .get-app-link:hover {
 text-decoration: underline;
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
 .container {
 max-width: 1200px;
 margin: 0 auto;
 padding: 40px 20px;
 }
 .profile-header {
 padding: 40px 0;
 margin-bottom: 30px;
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
 color: ${settings.textColor};
 margin-bottom: 10px;
 letter-spacing: 0.5px;
 }
 .profile-username {
 font-size: 18px;
 color: ${settings.textColor}99;
 margin-bottom: 20px;
 }
 .profile-bio {
 font-size: 16px;
 color: ${settings.textColor}cc;
 max-width: 600px;
 margin: 0 auto 30px;
 line-height: 1.8;
 ${settings.hideBio ? 'display: none;' : ''}
 }
 .stats-grid {
 display: grid;
 grid-template-columns: repeat(3, minmax(140px, 200px));
 gap: 20px;
 margin-top: 30px;
 max-width: 640px;
 margin-left: auto;
 margin-right: auto;
 contain: layout style paint;
 }
 .stat-card.col-1 { grid-column: 1; }
 .stat-card.col-2 { grid-column: 2; }
 .stat-card.col-3 { grid-column: 3; }
 .stat-card.span-center { grid-column: 2; }
 .stat-card.span-left { grid-column: 1; }
 .stat-card.span-right { grid-column: 3; }
 .stat-card {
 min-width: 140px;
 background: #f8f6f0;
 border-radius: 12px;
 padding: 20px;
 text-align: center;
 border: 2px solid #34495e;
 box-shadow: 0 2px 8px rgba(52, 73, 94, 0.1);
 }
 .stat-value {
 font-size: 32px;
 font-weight: 800;
 color: ${settings.textColor};
 margin-bottom: 5px;
 }
 .stat-label {
 font-size: 14px;
 color: ${settings.textColor}99;
 text-transform: uppercase;
 letter-spacing: 0.5px;
 }
 .favorites-section, .folders-section {
 margin-top: 30px;
 margin-bottom: 30px;
 }
 .favorites-bar {
 display: flex;
 gap: 16px;
 overflow-x: auto;
 padding: 12px 0;
 scroll-snap-type: x mandatory;
 -webkit-overflow-scrolling: touch;
 }
 .favorites-bar .book-card {
 flex: 0 0 auto;
 scroll-snap-align: start;
 width: 100px;
 cursor: pointer;
 }
 .favorites-bar .book-cover {
 width: 100px;
 height: 140px;
 object-fit: cover;
 border-radius: 8px;
 }
 .favorites-bar .book-cover-placeholder {
 width: 100px;
 height: 140px;
 border-radius: 8px;
 font-size: 11px;
 padding: 6px;
 }
 .folder-card {
 background: rgba(255,255,255,0.6);
 border-radius: 12px;
 padding: 16px;
 margin-bottom: 16px;
 border: 2px solid #e0e0e0;
 }
 .folder-name {
 font-size: 18px;
 font-weight: 700;
 color: ${settings.textColor};
 margin-bottom: 12px;
 }
 .folder-books {
 display: flex;
 gap: 12px;
 overflow-x: auto;
 padding: 4px 0;
 }
 .folder-books .book-card {
 flex: 0 0 auto;
 width: 80px;
 cursor: pointer;
 }
 .folder-books .book-cover, .folder-books .book-cover-placeholder {
 width: 80px;
 height: 112px;
 border-radius: 6px;
 object-fit: cover;
 }
 .folder-books .book-cover-placeholder {
 font-size: 10px;
 padding: 4px;
 }
 .books-section {
 padding: 40px 0;
 }
 .section-title {
 font-size: 28px;
 font-weight: 800;
 color: ${settings.textColor};
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
 border-color: ${settings.buttonColor};
 box-shadow: 0 0 0 3px ${settings.buttonColor}1a;
 }
 .search-input::placeholder {
 color: #999;
 }
 .sign-in-button {
 background: ${settings.buttonColor};
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
 opacity: 0.85;
 }
 .ask-library-button {
 background: linear-gradient(135deg, #007AFF 0%, #0056CC 100%);
 color: white;
 border: none;
 padding: 12px 24px;
 border-radius: 12px;
 font-size: 15px;
 font-weight: 600;
 cursor: pointer;
 transition: all 0.2s;
 font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
 box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
 display: flex;
 align-items: center;
 }
 .ask-library-button:hover {
 transform: translateY(-1px);
 box-shadow: 0 4px 12px rgba(0, 122, 255, 0.4);
 }
 .ask-library-button:active {
 transform: translateY(0);
 }
 .mode-toggle-container {
 display: flex;
 gap: 10px;
 margin-bottom: 20px;
 }
 .mode-toggle-button {
 padding: 12px 24px;
 border: 2px solid #e0e0e0;
 background: white;
 color: #666;
 border-radius: 12px;
 font-size: 15px;
 font-weight: 600;
 cursor: pointer;
 transition: all 0.2s;
 font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
 }
 .mode-toggle-button:hover {
 border-color: ${settings.buttonColor};
 color: ${settings.buttonColor};
 }
 .mode-toggle-button.active {
 background: ${settings.buttonColor};
 color: white;
 border-color: ${settings.buttonColor};
 box-shadow: 0 2px 8px ${settings.buttonColor}40;
 }
 .ai-answer-box {
 background: linear-gradient(135deg, #f8f6f0 0%, #ffffff 100%);
 border: 2px solid #e0e0e0;
 border-radius: 12px;
 padding: 20px;
 margin-bottom: 20px;
 box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
 }
 .suggested-books-title {
 font-size: 20px;
 font-weight: 700;
 color: #2c3e50;
 margin-bottom: 15px;
 }
 .chat-messages {
 scrollbar-width: thin;
 scrollbar-color: #ccc transparent;
 }
 .chat-messages::-webkit-scrollbar {
 width: 6px;
 }
 .chat-messages::-webkit-scrollbar-track {
 background: transparent;
 }
 .chat-messages::-webkit-scrollbar-thumb {
 background: #ccc;
 border-radius: 3px;
 }
 .chat-messages::-webkit-scrollbar-thumb:hover {
 background: #999;
 }
 .error-message {
 display: none;
 background: #fee;
 color: #c33;
 padding: 12px;
 border-radius: 8px;
 font-size: 14px;
 margin-top: 10px;
 }
 .error-message.show {
 display: block;
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
 .book-detail-modal {
 display: none;
 position: fixed;
 top: 0;
 left: 0;
 right: 0;
 bottom: 0;
 background: rgba(0, 0, 0, 0.5);
 z-index: 2000;
 align-items: center;
 justify-content: center;
 padding: 20px;
 overflow-y: auto;
 }
 .book-detail-modal.show {
 display: flex;
 }
 .book-detail-content {
 background: white;
 border-radius: 20px;
 max-width: 600px;
 width: 100%;
 max-height: 90vh;
 overflow-y: auto;
 box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
 position: relative;
 will-change: scroll-position;
 -webkit-overflow-scrolling: touch;
 }
 .book-detail-header {
 position: sticky;
 top: 0;
 background: white;
 padding: 20px;
 border-bottom: 1px solid #e0e0e0;
 display: flex;
 justify-content: space-between;
 align-items: center;
 z-index: 10;
 will-change: transform;
 transform: translateZ(0);
 }
 .book-detail-close {
 background: none;
 border: none;
 font-size: 32px;
 color: #666;
 cursor: pointer;
 padding: 0;
 width: 40px;
 height: 40px;
 display: flex;
 align-items: center;
 justify-content: center;
 border-radius: 50%;
 transition: background 0.2s;
 }
 .book-detail-close:hover {
 background: #f0f0f0;
 }
 .book-detail-body {
 padding: 30px;
 }
 .book-detail-cover {
 width: 200px;
 max-width: 100%;
 aspect-ratio: 2/3;
 object-fit: cover;
 border-radius: 12px;
 margin: 0 auto 30px;
 display: block;
 box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
 }
 .book-detail-cover-placeholder {
 width: 200px;
 max-width: 100%;
 aspect-ratio: 2/3;
 background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
 border-radius: 12px;
 margin: 0 auto 30px;
 display: flex;
 align-items: center;
 justify-content: center;
 color: white;
 font-size: 18px;
 text-align: center;
 padding: 20px;
 font-weight: 600;
 box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
 }
 .book-detail-title {
 font-size: 32px;
 font-weight: 800;
 color: #2c3e50;
 margin-bottom: 10px;
 line-height: 1.3;
 }
 .book-detail-author {
 font-size: 20px;
 color: #666;
 margin-bottom: 20px;
 }
 .book-detail-info {
 margin-top: 30px;
 }
 .book-detail-info-item {
 margin-bottom: 15px;
 padding-bottom: 15px;
 border-bottom: 1px solid #f0f0f0;
 }
 .book-detail-info-item:last-child {
 border-bottom: none;
 }
 .book-detail-info-label {
 font-size: 12px;
 text-transform: uppercase;
 color: #999;
 letter-spacing: 0.5px;
 margin-bottom: 5px;
 font-weight: 600;
 }
 .book-detail-info-value {
 font-size: 16px;
 color: #2c3e50;
 line-height: 1.5;
 }
 .book-detail-description {
 margin-top: 30px;
 padding-top: 30px;
 border-top: 1px solid #e0e0e0;
 }
 .book-detail-description-text {
 font-size: 16px;
 color: #555;
 line-height: 1.8;
 white-space: pre-wrap;
 }
 .books-grid {
 display: grid;
 grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
 gap: 20px;
 contain: layout style paint;
 }
 .book-card {
 background: #f8f6f0;
 border-radius: 12px;
 overflow: hidden;
 cursor: pointer;
 will-change: transform;
 transform: translateZ(0);
 }
 .book-card:hover {
 transform: translateY(-4px) translateZ(0);
 box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
 }
 .book-card.favorite-selected {
 border: 3px solid ${settings.buttonColor};
 box-shadow: 0 0 0 2px ${settings.buttonColor}40;
 }
 .book-cover {
 width: 100%;
 aspect-ratio: 2/3;
 object-fit: cover;
 background: #34495e;
 will-change: transform;
 transform: translateZ(0);
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
 padding: 20px 0;
 margin-top: 30px;
 }
 .top-author-card {
 margin-bottom: 12px;
 border-bottom: 1px solid #e2e8f0;
 }
 .top-author-card:last-child {
 border-bottom: none;
 }
 .top-author-bar {
 display: flex;
 align-items: center;
 justify-content: space-between;
 padding: 12px 0;
 cursor: pointer;
 transition: background 0.2s;
 }
 .top-author-bar:hover {
 background: rgba(0,0,0,0.04);
 }
 .top-author-name {
 font-weight: 700;
 color: ${settings.textColor};
 font-size: 15px;
 }
 .top-author-count {
 font-size: 14px;
 color: ${settings.textColor}99;
 margin: 0 8px;
 background: #f8f6f0;
 padding: 4px 12px;
 border-radius: 12px;
 }
 .top-author-chevron {
 font-size: 12px;
 color: ${settings.buttonColor};
 }
 .top-author-books {
 display: flex;
 gap: 12px;
 padding: 12px 0 20px;
 overflow-x: auto;
 flex-wrap: wrap;
 }
 .top-author-book-card {
 flex: 0 0 auto;
 width: 72px;
 cursor: pointer;
 text-align: center;
 }
 .top-author-book-cover, .top-author-book-cover-placeholder {
 width: 72px;
 height: 108px;
 object-fit: cover;
 border-radius: 8px;
 }
 .top-author-book-cover-placeholder {
 background: #e2e8f0;
 display: flex;
 align-items: center;
 justify-content: center;
 font-size: 10px;
 color: #718096;
 padding: 4px;
 }
 .top-author-book-title {
 font-size: 11px;
 font-weight: 600;
 color: ${settings.textColor};
 margin-top: 6px;
 line-height: 14px;
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
 .profile-header {
 padding: 30px 20px;
 }
 .profile-name {
 font-size: 28px;
 }
 .books-grid {
 grid-template-columns: repeat(4, 1fr);
 gap: 8px;
 }
 .book-card {
 border-radius: 8px;
 }
 .book-cover,
 .book-cover-placeholder {
 border-radius: 6px;
 }
 .book-info {
 padding: 6px;
 }
 .book-title {
 font-size: 11px;
 margin-bottom: 2px;
 }
 .book-author {
 font-size: 9px;
 }
 .stats-grid {
 grid-template-columns: repeat(2, 1fr);
 }
 .book-detail-content {
 max-width: 95%;
 max-height: 95vh;
 }
 .book-detail-body {
 padding: 20px;
 }
 .book-detail-cover,
 .book-detail-cover-placeholder {
 width: 150px;
 }
 .book-detail-title {
 font-size: 24px;
 }
 .book-detail-author {
 font-size: 16px;
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
 <button class="nav-button" onclick="window.location.href='/search'">Search</button>
 <button class="nav-button profile-button active" onclick="handleProfileNavClick()" id="profileNavButton">${isEditMode ? 'Profile' : 'Sign In'}</button>
 </div>
 </div>
 
 <div class="container">
 <div class="profile-header">
 <h1 class="profile-name">${String(profileData.displayName).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
 <div class="profile-username">@${String(profileData.username).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
 ${profileData.bio && !settings.hideBio ? `<div class="profile-bio">${String(profileData.bio || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</div>` : ''}
 <div id="profileEditButtons" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; display: none;">
 <div style="margin-bottom: 15px;">
 <button class="sign-in-button" style="margin-right: 10px;" onclick="openEditProfile()">Edit Profile</button>
 <button class="sign-in-button" style="background: #666;" onclick="window.location.href='/${profileData.username}'">View Public Profile</button>
 <a href="/admin" class="sign-in-button" id="adminButton" style="display: none; margin-left: 10px; background: #0d47a1; text-decoration: none; line-height: 1.5;">Admin</a>
 </div>
 </div>
 
 <div class="stats-grid">
 ${(() => {
 const cards: { value: number; label: string }[] = [];
 if (settings.showTotalBooks) cards.push({ value: stats.totalBooks, label: 'Total Books' });
 if (settings.showReadBooks) cards.push({ value: stats.readBooks, label: 'Read' });
 if (settings.showUnreadBooks) cards.push({ value: stats.unreadBooks, label: 'Unread' });
 const count = cards.length;
 const colClass = count === 1 ? 'span-center' : count === 2 ? ['span-left', 'span-right'] : ['col-1', 'col-2', 'col-3'];
 return cards.map((c, i) => `<div class="stat-card ${Array.isArray(colClass) ? colClass[i] : colClass}">
 <div class="stat-value">${c.value}</div>
 <div class="stat-label">${c.label}</div>
 </div>`).join('');
 })()}
 </div>
 </div>

 ${settings.showFavorites ? `
 <div class="favorites-section" id="favoritesSection">
 <h2 class="section-title">Favorites</h2>
 ${favoritesContent ? `<div class="favorites-bar">${favoritesContent}</div>` : '<div class="empty-state"><div class="empty-state-text">No favorites yet</div></div>'}
 <button type="button" class="sign-in-button" id="addToFavoritesBtn" style="margin-top: 12px; background: #28a745; display: none;" onclick="startAddToFavorites()">Add to Favorites</button>
 </div>
 ` : ''}

 ${topAuthorsContent ? `
 <div class="top-authors-section">
 <h2 class="section-title">Top Authors</h2>
 <div class="top-authors">${topAuthorsContent}</div>
 </div>
 ` : ''}

 <div class="books-section" id="librarySection">
 <h2 class="section-title">Library</h2>
 
 <!-- Favorites selection bar (shown when in Add to Favorites mode) -->
 <div id="favoritesSelectionBar" style="display: none; margin-bottom: 20px; padding: 16px; background: #f0f8ff; border: 2px solid #007AFF; border-radius: 12px;">
 <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
 <span id="favoritesSelectionCount" style="font-weight: 600; color: #2c3e50;">Select up to 10 books</span>
 <div style="display: flex; gap: 10px;">
 <button type="button" class="sign-in-button" style="background: #666;" onclick="cancelAddToFavorites()">Cancel</button>
 <button type="button" class="sign-in-button" id="saveFavoritesBtn" onclick="saveFavoritesFromLibrary()">Save Favorites</button>
 </div>
 </div>
 </div>
 
 <!-- Mode Toggle Buttons -->
 <div class="mode-toggle-container" id="modeToggleContainer" style="display: flex; margin-bottom: 20px;">
 <button 
 id="libraryModeButton" 
 class="mode-toggle-button active" 
 onclick="switchToLibraryMode()"
 >
 Library
 </button>
 <button 
 id="askLibraryModeButton" 
 class="mode-toggle-button" 
 onclick="switchToAskLibraryMode()"
 >
 Ask Your Library
 </button>
 </div>
 
 <!-- Search/Ask Input -->
 <div class="search-container">
 <input 
 type="text" 
 class="search-input" 
 id="bookSearch" 
 placeholder="Search books by title or author..." 
 oninput="handleSearchInput()"
 onkeypress="if(event.key === 'Enter') handleSearchSubmit()"
 />
 </div>
 
 <!-- AI Answer Display -->
 <div id="aiAnswerContainer" style="display: none; margin: 20px 0;">
 <div class="ai-answer-box">
 <p id="aiAnswerText" style="margin: 0; color: #2c3e50; line-height: 1.6;"></p>
 </div>
 </div>
 
 <!-- Suggested Books Section (for Ask Your Library mode) -->
 <div id="suggestedBooksContainer" style="display: none; margin-top: 20px;">
 <h3 class="suggested-books-title">Suggested Books</h3>
 <div class="books-grid" id="suggestedBooksGrid">
 <!-- Books will be inserted here -->
 </div>
 </div>
 
 <!-- Regular Library Books -->
 <div id="regularBooksContainer">
 ${(books || []).length > 0 
 ? `<div class="books-grid" id="regularBooksGrid">
 ${(books || []).map((book: any, index: number) => `
 <div class="book-card" data-book-id="${(book.id || '').replace(/"/g, '&quot;')}" data-book-index="${index}" onclick="handleBookCardClick(${index}, event)">
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
 <div class="empty-state-text">No books yet</div>
 </div>`
 }
 </div>
 </div>

 ${foldersContent ? `
 <div class="folders-section">
 <h2 class="section-title">Collections</h2>
 ${foldersContent}
 </div>
 ` : ''}

 </div>

 <!-- Book Detail Modal -->
 <div class="book-detail-modal" id="bookDetailModal" onclick="closeBookDetail(event)">
 <div class="book-detail-content" onclick="event.stopPropagation()">
 <div class="book-detail-header">
 <h2 style="margin: 0; font-size: 20px; font-weight: 800; color: #2c3e50;">Book Details</h2>
 <button class="book-detail-close" onclick="closeBookDetail()">&times;</button>
 </div>
 <div class="book-detail-body" id="bookDetailBody">
 <!-- Book details will be inserted here -->
 </div>
 </div>
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

 function getAccessToken() {
 const session = localStorage.getItem('supabase_session');
 if (session) {
 try {
 const data = JSON.parse(session);
 return data.access_token || data.session?.access_token || null;
 } catch (e) {}
 }
 for (let i = 0; i < localStorage.length; i++) {
 const key = localStorage.key(i);
 if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
 try {
 const data = JSON.parse(localStorage.getItem(key) || '{}');
 const token = data.access_token || data?.session?.access_token;
 if (token) return token;
 } catch (e) {}
 }
 }
 return null;
 }

 let filterTimeout;
 function filterBooks() {
 if (currentMode !== 'library' && !isFavoritesMode) return;
 
 clearTimeout(filterTimeout);
 filterTimeout = setTimeout(() => {
 const searchTerm = document.getElementById('bookSearch').value.toLowerCase();
 const regularBooksGrid = document.getElementById('regularBooksGrid');
 if (!regularBooksGrid) return;
 
 const bookCards = regularBooksGrid.querySelectorAll('.book-card');
 
 // Use requestAnimationFrame for smooth updates
 requestAnimationFrame(() => {
 bookCards.forEach(card => {
 const title = card.querySelector('.book-title')?.textContent?.toLowerCase() || '';
 const author = card.querySelector('.book-author')?.textContent?.toLowerCase() || '';
 const matches = !searchTerm || title.includes(searchTerm) || author.includes(searchTerm);
 card.style.display = matches ? 'block' : 'none';
 });
 });
 }, 150);
 }

 function toggleTopAuthor(idx) {
 const el = document.getElementById('topAuthorBooks' + idx);
 const chevron = document.getElementById('topAuthorChevron' + idx);
 if (!el || !chevron) return;
 const isShown = el.style.display !== 'none';
 el.style.display = isShown ? 'none' : 'flex';
 chevron.textContent = isShown ? '' : '';
 }

 let isFavoritesMode = false;
 let favoritesSelectedIds = new Set();

 function handleBookCardClick(index, event) {
 if (isFavoritesMode) {
 event.preventDefault();
 event.stopPropagation();
 const card = event.currentTarget;
 const bookId = card.getAttribute('data-book-id');
 const book = allBooks[index];
 const id = book?.id || bookId;
 if (!id) return;
 if (favoritesSelectedIds.has(id)) {
 favoritesSelectedIds.delete(id);
 } else if (favoritesSelectedIds.size < 10) {
 favoritesSelectedIds.add(id);
 }
 updateFavoritesSelectionUI();
 } else {
 openBookDetail(index);
 }
 }

 function updateFavoritesSelectionUI() {
 const countEl = document.getElementById('favoritesSelectionCount');
 if (countEl) countEl.textContent = favoritesSelectedIds.size + ' / 10 selected';
 document.querySelectorAll('#regularBooksGrid .book-card').forEach(card => {
 const bid = card.getAttribute('data-book-id');
 if (bid && favoritesSelectedIds.has(bid)) {
 card.classList.add('favorite-selected');
 } else {
 card.classList.remove('favorite-selected');
 }
 });
 }

 function startAddToFavorites() {
 const token = getAccessToken();
 if (!token) {
 window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
 return;
 }
 const bar = document.getElementById('favoritesSelectionBar');
 const libSection = document.getElementById('librarySection');
 if (!bar || !libSection) return;
 isFavoritesMode = true;
 favoritesSelectedIds.clear();
 allBooks.forEach(b => { if (b.is_favorite && b.id) favoritesSelectedIds.add(b.id); });
 bar.style.display = 'block';
 document.getElementById('modeToggleContainer').style.display = 'none';
 document.getElementById('bookSearch').placeholder = 'Search books to add to favorites...';
 if (currentMode === 'ask') switchToLibraryMode();
 updateFavoritesSelectionUI();
 libSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
 }

 function cancelAddToFavorites() {
 isFavoritesMode = false;
 favoritesSelectedIds.clear();
 document.getElementById('favoritesSelectionBar').style.display = 'none';
 document.getElementById('modeToggleContainer').style.display = 'flex';
 document.getElementById('bookSearch').placeholder = 'Search books by title or author...';
 document.querySelectorAll('.book-card.favorite-selected').forEach(c => c.classList.remove('favorite-selected'));
 }

 async function saveFavoritesFromLibrary() {
 const token = getAccessToken();
 if (!token) {
 window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
 return;
 }
 const ids = Array.from(favoritesSelectedIds).filter(Boolean);
 const btn = document.getElementById('saveFavoritesBtn');
 if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
 try {
 const res = await fetch('/api/set-favorites', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
 body: JSON.stringify({ bookIds: ids })
 });
 const data = await res.json();
 if (!res.ok) throw new Error(data.error || 'Failed to save');
 cancelAddToFavorites();
 window.location.reload();
 } catch (e) {
 alert(e.message || 'Failed to save favorites.');
 } finally {
 if (btn) { btn.disabled = false; btn.textContent = 'Save Favorites'; }
 }
 }

 function openBookDetail(index) {
 const book = allBooks[index];
 if (!book) return;

 const modal = document.getElementById('bookDetailModal');
 const body = document.getElementById('bookDetailBody');

 const formatDate = (dateString) => {
 if (!dateString) return 'N/A';
 try {
 return new Date(dateString).toLocaleDateString('en-US', { 
 year: 'numeric', 
 month: 'long', 
 day: 'numeric' 
 });
 } catch {
 return dateString;
 }
 };

 const escapeHtml = (text) => {
 if (!text) return '';
 const div = document.createElement('div');
 div.textContent = text;
 return div.innerHTML;
 };

 let html = '';
 
 if (book.cover_url) {
 html += \`<img src="\${escapeHtml(book.cover_url)}" alt="\${escapeHtml(book.title || '')}" class="book-detail-cover">\`;
 } else {
 html += \`<div class="book-detail-cover-placeholder">\${escapeHtml(book.title || '')}</div>\`;
 }
 
 html += \`<h1 class="book-detail-title">\${escapeHtml(book.title || 'Unknown Title')}</h1>\`;
 
 if (book.author) {
 html += \`<div class="book-detail-author">by \${escapeHtml(book.author)}</div>\`;
 }
 
 html += '<div class="book-detail-info">';
 
 if (book.publisher) {
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Publisher</div>
 <div class="book-detail-info-value">\${escapeHtml(book.publisher)}</div>
 </div>
 \`;
 }
 
 if (book.published_date) {
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Published</div>
 <div class="book-detail-info-value">\${formatDate(book.published_date)}</div>
 </div>
 \`;
 }
 
 if (book.page_count) {
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Pages</div>
 <div class="book-detail-info-value">\${book.page_count}</div>
 </div>
 \`;
 }
 
 if (book.scanned_at) {
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Added to Library</div>
 <div class="book-detail-info-value">\${formatDate(book.scanned_at)}</div>
 </div>
 \`;
 }
 
 if (book.read_at) {
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Read</div>
 <div class="book-detail-info-value">\${formatDate(book.read_at)}</div>
 </div>
 \`;
 }
 
 if (book.categories && book.categories.length > 0) {
 const categoriesText = Array.isArray(book.categories) ? book.categories.join(', ') : book.categories;
 html += \`
 <div class="book-detail-info-item">
 <div class="book-detail-info-label">Categories</div>
 <div class="book-detail-info-value">\${escapeHtml(categoriesText)}</div>
 </div>
 \`;
 }
 
 html += '</div>';
 
 if (book.description) {
 html += \`
 <div class="book-detail-description">
 <div class="book-detail-info-label" style="margin-bottom: 15px;">Description</div>
 <div class="book-detail-description-text">\${escapeHtml(book.description)}</div>
 </div>
 \`;
 }
 
 body.innerHTML = html;

 modal.classList.add('show');
 document.body.style.overflow = 'hidden';
 }

 function closeBookDetail(event) {
 if (event && event.target !== event.currentTarget && event.target.closest('.book-detail-content')) {
 return;
 }
 const modal = document.getElementById('bookDetailModal');
 modal.classList.remove('show');
 document.body.style.overflow = '';
 }

 function signOut() {
 localStorage.removeItem('supabase_session');
 window.location.href = \`/\${username}\`;
 }

 async function handleProfileNavClick() {
 const session = localStorage.getItem('supabase_session');
 if (session) {
 try {
 // Check if the signed-in user owns this profile
 const sessionData = JSON.parse(session);
 const response = await fetch('/api/get-username', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ session: sessionData })
 });
 
 if (response.ok) {
 const data = await response.json();
 const signedInUsername = data.username?.toLowerCase();
 const profileUsername = '${profileData.username}'.toLowerCase();
 
 if (signedInUsername === profileUsername) {
 // User owns this profile, redirect to their profile edit page
 window.location.href = \`/\${data.username}?edit=true\`;
 } else {
 // User is signed in but viewing someone else's profile, go to their own profile
 window.location.href = \`/\${data.username}?edit=true\`;
 }
 } else {
 // Error getting username, go to profile page
 window.location.href = '/profile';
 }
 } catch (error) {
 console.error('Error checking profile ownership:', error);
 window.location.href = '/profile';
 }
 } else {
 // User not signed in, go to profile page (which will show sign-in form)
 window.location.href = '/profile';
 }
 }

 // Mode and search functionality
 let currentMode = 'library'; // 'library' or 'ask'
 let chatConversation = [];
 
 function checkAndShowToggleButtons() {
 // Show toggle buttons to everyone (not just profile owners)
 const toggleContainer = document.getElementById('modeToggleContainer');
 if (toggleContainer) {
 toggleContainer.style.display = 'flex';
 }
 }
 
 function switchToLibraryMode() {
 currentMode = 'library';
 const libraryBtn = document.getElementById('libraryModeButton');
 const askBtn = document.getElementById('askLibraryModeButton');
 const searchInput = document.getElementById('bookSearch');
 const aiAnswerContainer = document.getElementById('aiAnswerContainer');
 const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
 const regularBooksContainer = document.getElementById('regularBooksContainer');
 
 if (libraryBtn) libraryBtn.classList.add('active');
 if (askBtn) askBtn.classList.remove('active');
 if (searchInput) {
 searchInput.placeholder = 'Search books by title or author...';
 searchInput.value = '';
 }
 if (aiAnswerContainer) aiAnswerContainer.style.display = 'none';
 if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
 if (regularBooksContainer) regularBooksContainer.style.display = 'block';
 
 // Restore original book filtering
 filterBooks();
 }
 
 async function switchToAskLibraryMode() {
 try {
 // Check if user is signed in first
 const session = localStorage.getItem('supabase_session');
 if (!session) {
 const signIn = confirm('You need to sign in to use Ask Your Library. Would you like to sign in now?');
 if (signIn) {
 window.location.href = '/profile';
 }
 return;
 }
 
 // Just switch to ask mode - let the API handle Pro validation when they ask a question
 // Check if user owns this profile or is viewing someone else's
 let isOwnProfile = false;
 try {
 const sessionData = JSON.parse(session);
 const usernameResponse = await fetch('/api/get-username', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ session: sessionData })
 });
 
 if (usernameResponse.ok) {
 const usernameData = await usernameResponse.json();
 const signedInUsername = usernameData.username?.toLowerCase();
 const profileUsername = '${profileData.username}'.toLowerCase();
 isOwnProfile = signedInUsername === profileUsername;
 }
 } catch (e) {
 // Ignore error, just assume not own profile
 }
 
 // Switch to ask mode
 currentMode = 'ask';
 const libraryBtn = document.getElementById('libraryModeButton');
 const askBtn = document.getElementById('askLibraryModeButton');
 const searchInput = document.getElementById('bookSearch');
 const regularBooksContainer = document.getElementById('regularBooksContainer');
 
 if (libraryBtn) libraryBtn.classList.remove('active');
 if (askBtn) askBtn.classList.add('active');
 if (searchInput) {
 searchInput.placeholder = isOwnProfile 
 ? 'Ask a question about your library!' 
 : 'Ask a question about their library!';
 searchInput.value = '';
 }
 if (regularBooksContainer) regularBooksContainer.style.display = 'none';
 
 // Clear previous answers
 const aiAnswerContainer = document.getElementById('aiAnswerContainer');
 const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
 if (aiAnswerContainer) aiAnswerContainer.style.display = 'none';
 if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
 } catch (error) {
 console.error('Error in switchToAskLibraryMode:', error);
 alert('An error occurred. Please try again.');
 }
 }
 
 function handleSearchInput() {
 if (currentMode === 'library' || isFavoritesMode) {
 filterBooks();
 }
 }
 
 async function handleSearchSubmit() {
 if (currentMode === 'ask') {
 await askLibraryQuestion();
 }
 }
 
 async function askLibraryQuestion() {
 const searchInput = document.getElementById('bookSearch');
 const message = searchInput?.value.trim();
 if (!message) return;
 
 const aiAnswerContainer = document.getElementById('aiAnswerContainer');
 const aiAnswerText = document.getElementById('aiAnswerText');
 const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
 const suggestedBooksGrid = document.getElementById('suggestedBooksGrid');
 
 if (!aiAnswerContainer || !aiAnswerText) return;
 
 // Show loading state
 aiAnswerContainer.style.display = 'block';
 aiAnswerText.textContent = 'Thinking...';
 if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
 
 // Get session token
 const session = localStorage.getItem('supabase_session');
 if (!session) {
 aiAnswerText.textContent = 'Please sign in to use this feature.';
 return;
 }
 
 try {
 let sessionData = JSON.parse(session);
 
 // Get access token - check all possible session structures
 // Supabase session can be: { access_token, refresh_token, ... } or { session: { access_token, ... } }
 let accessToken = sessionData?.access_token || 
 sessionData?.session?.access_token ||
 (sessionData?.user && sessionData?.user?.access_token);
 
 if (!accessToken || typeof accessToken !== 'string') {
 aiAnswerText.textContent = 'Please sign in to use this feature.';
 return;
 }
 
 // Check if token is expired (expires_at is in seconds)
 const expiresAt = sessionData?.expires_at;
 if (expiresAt) {
 const expiresAtMs = expiresAt * 1000;
 const now = Date.now();
 const isExpired = now >= expiresAtMs;
 
 if (isExpired) {
 localStorage.removeItem('supabase_session');
 window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
 return;
 }
 }
 
 // Determine if we're querying own library or someone else's
 const profileUsername = '${profileData.username}';
 let targetUsername = null;
 
 // Check if user owns this profile
 try {
 const usernameResponse = await fetch('/api/get-username', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ session: sessionData })
 });
 
 if (usernameResponse.ok) {
 const usernameData = await usernameResponse.json();
 const signedInUsername = usernameData.username?.toLowerCase();
 const currentProfileUsername = profileUsername.toLowerCase();
 
 // If viewing someone else's profile, pass their username
 if (signedInUsername !== currentProfileUsername) {
 targetUsername = profileUsername;
 }
 }
 } catch (e) {
 console.error('Error checking profile ownership:', e);
 }
 
 const requestBody = {
 message: message,
 conversation: chatConversation.slice(-6)
 };
 
 // Add target username if querying someone else's library
 if (targetUsername) {
 requestBody.target_username = targetUsername;
 }
 
 const response = await fetch('/api/library/ask', {
 method: 'POST',
 headers: {
 'Authorization': \`Bearer \${accessToken}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBody)
 });
 
 // Check if response is JSON before parsing
 const contentType = response.headers.get('content-type');
 let data;
 
 if (contentType && contentType.includes('application/json')) {
 try {
 data = await response.json();
 } catch (jsonError) {
 console.error('Error parsing JSON response:', jsonError);
 aiAnswerText.textContent = 'An error occurred. Please try again.';
 return;
 }
 } else {
 // Not JSON - read as text
 const text = await response.text();
 console.error('Non-JSON response:', text);
 aiAnswerText.textContent = 'An error occurred. Please try again.';
 return;
 }
 
 if (response.status === 401) {
 // Token is invalid or expired - clear session and redirect to sign-in
 localStorage.removeItem('supabase_session');
 window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
 return;
 } else if (response.status === 403) {
 aiAnswerText.textContent = data.reply || 'This feature is available to Pro users only.';
 } else if (response.ok) {
 // Display answer
 aiAnswerText.textContent = data.reply;
 chatConversation.push({ role: 'user', content: message });
 chatConversation.push({ role: 'assistant', content: data.reply });
 
 // Display suggested books if any
 if (data.matched_books && data.matched_books.length > 0) {
 displaySuggestedBooks(data.matched_books);
 } else {
 if (suggestedBooksContainer) suggestedBooksContainer.style.display = 'none';
 }
 } else {
 console.error('API error:', response.status, data);
 aiAnswerText.textContent = data.reply || data.error || 'An error occurred. Please try again.';
 }
 } catch (error) {
 console.error('Error asking library question:', error);
 aiAnswerText.textContent = 'An error occurred. Please try again.';
 }
 }
 
 function displaySuggestedBooks(books) {
 const suggestedBooksContainer = document.getElementById('suggestedBooksContainer');
 const suggestedBooksGrid = document.getElementById('suggestedBooksGrid');
 
 if (!suggestedBooksContainer || !suggestedBooksGrid) {
 console.error('Suggested books container not found');
 return;
 }
 
 if (!books || books.length === 0) {
 suggestedBooksContainer.style.display = 'none';
 return;
 }
 
 suggestedBooksContainer.style.display = 'block';
 suggestedBooksGrid.innerHTML = '';
 
 let booksFound = 0;
 
 // Find full book data from allBooks
 books.forEach(bookData => {
 if (!bookData || !bookData.id) return;
 
 const fullBook = allBooks.find(b => b && b.id === bookData.id);
 if (fullBook) {
 booksFound++;
 const bookIndex = allBooks.indexOf(fullBook);
 const bookCard = document.createElement('div');
 bookCard.className = 'book-card';
 bookCard.onclick = () => openBookDetail(bookIndex);
 
 const cover = fullBook.cover_url 
 ? \`<img src="\${fullBook.cover_url}" alt="\${fullBook.title || 'Book'}" class="book-cover">\`
 : \`<div class="book-cover-placeholder">\${(fullBook.title || 'Book').substring(0, 20)}</div>\`;
 
 bookCard.innerHTML = \`
 \${cover}
 <div class="book-info">
 <div class="book-title">\${fullBook.title || ''}</div>
 \${fullBook.author ? \`<div class="book-author">\${fullBook.author}</div>\` : ''}
 </div>
 \`;
 
 suggestedBooksGrid.appendChild(bookCard);
 } else {
 console.warn('Book not found in allBooks:', bookData.id, bookData.title);
 }
 });
 
 if (booksFound === 0) {
 console.warn('No suggested books found in library. Matched books:', books);
 suggestedBooksContainer.style.display = 'none';
 }
 }

 // Check if user is signed in and owns this profile on page load
 window.addEventListener('DOMContentLoaded', async () => {
 const session = localStorage.getItem('supabase_session');
 const urlParams = new URLSearchParams(window.location.search);
 const isEditMode = urlParams.get('edit') === 'true';
 
 if (!session && isEditMode) {
 // User in edit mode but no session, redirect to regular view
 window.location.href = \`/\${username}\`;
 return;
 }
 
 // Always show toggle buttons to everyone
 checkAndShowToggleButtons();
 
 if (session) {
 try {
 const sessionData = JSON.parse(session);
 if (sessionData?.access_token && sessionData?.refresh_token) {
 await fetch('/api/web-sync-session', {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ access_token: sessionData.access_token, refresh_token: sessionData.refresh_token }),
 });
 }
 // Check if the signed-in user owns this profile
 const response = await fetch('/api/get-username', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ session: sessionData })
 });
 
 if (response.ok) {
 const data = await response.json();
 const signedInUsername = data.username?.toLowerCase();
 const profileUsername = '${profileData.username}'.toLowerCase();
 
 if (signedInUsername === profileUsername) {
 // User owns this profile - show edit buttons and Add to Favorites
 const editButtonsDiv = document.getElementById('profileEditButtons');
 if (editButtonsDiv) {
 editButtonsDiv.style.display = 'block';
 }
 const addToFavBtn = document.getElementById('addToFavoritesBtn');
 if (addToFavBtn) addToFavBtn.style.display = 'inline-block';
 const profileNavBtn = document.getElementById('profileNavButton');
 if (profileNavBtn) {
 profileNavBtn.textContent = 'Profile';
 profileNavBtn.onclick = function() {
 window.location.href = \`/\${data.username}?edit=true\`;
 };
 }
 // If admin, show Admin button. Use relative path; credentials REQUIRED so cookies are sent; cache: no-store to avoid stale 401.
 (function doAdminCheck() {
 fetch('/api/admin/check', { method: 'GET', credentials: 'include', cache: 'no-store' })
 .then(function(r) { return r.ok ? r.json() : null; })
 .then(function(json) {
 if (json && json.isAdmin) {
 const adminBtn = document.getElementById('adminButton');
 if (adminBtn) adminBtn.style.display = 'inline-block';
 }
 })
 .catch(function(e) { console.log('[Admin] check failed:', e); });
 })();
 } else {
 // User is signed in but viewing someone else's profile - still show "Profile" in nav
 const editButtonsDiv = document.getElementById('profileEditButtons');
 if (editButtonsDiv) {
 editButtonsDiv.style.display = 'none';
 }
 const profileNavBtn = document.getElementById('profileNavButton');
 if (profileNavBtn) {
 profileNavBtn.textContent = 'Profile';
 profileNavBtn.onclick = function() {
 window.location.href = \`/\${data.username}?edit=true\`;
 };
 }
 if (isEditMode) {
 window.location.href = \`/\${username}\`;
 }
 }
 } else {
 // get-username failed (e.g. expired session) - clear stale session so UI is accurate
 localStorage.removeItem('supabase_session');
 for (let i = localStorage.length - 1; i >= 0; i--) {
 const key = localStorage.key(i);
 if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
 localStorage.removeItem(key);
 }
 }
 }
 } catch (error) {
 console.error('Error checking profile ownership:', error);
 // On error, just stay on current page
 }
 }
 });

 function openSignInModal() {
 window.location.href = '/signin';
 }

 function openEditProfile() {
 // Navigate to edit profile page
 window.location.href = \`/${profileData.username}/edit\`;
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
 // credentials: 'include' required so browser stores Set-Cookie: sb-* from response
 const response = await fetch('/api/web-signin', {
 method: 'POST',
 credentials: 'include',
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

 // Success! Store session and redirect to user's own profile edit page
 if (data.session) {
 // Store session token in localStorage
 localStorage.setItem('supabase_session', JSON.stringify(data.session));
 
 // Get username to redirect to their own profile
 const usernameResponse = await fetch('/api/get-username', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ session: data.session })
 });
 
 if (usernameResponse.ok) {
 const usernameData = await usernameResponse.json();
 if (usernameData.username) {
 // Redirect to their own profile edit page with a small delay
 // This ensures session is stored before redirect
 setTimeout(() => {
 window.location.href = \`/\${usernameData.username}?edit=true\`;
 }, 100);
 } else {
 console.error('No username in response from get-username');
 // Fallback to profile page
 window.location.href = '/profile';
 }
 } else {
 const errorData = await usernameResponse.json().catch(() => ({}));
 console.error('Error getting username after sign-in:', errorData);
 // If profile not found, redirect to profile page to sign in again
 if (usernameResponse.status === 404) {
 alert('Profile not found. Your account may need to be set up. Please contact support if this persists.');
 }
 window.location.href = '/profile';
 }
 } else {
 closeSignInModal();
 window.location.href = \`/\${username}\`;
 }
 } catch (error) {
 errorDiv.textContent = error.message || 'Sign in failed. Please try again.';
 errorDiv.classList.add('show');
 } finally {
 submitButton.disabled = false;
 submitButton.textContent = 'Sign In';
 }
 }
 
 // Expose functions globally for onclick handlers (at end of script, after all functions defined)
 window.switchToLibraryMode = switchToLibraryMode;
 window.switchToAskLibraryMode = switchToAskLibraryMode;
 window.handleSearchSubmit = handleSearchSubmit;
 window.handleSearchInput = handleSearchInput;
 window.askLibraryQuestion = askLibraryQuestion;
 window.handleProfileNavClick = handleProfileNavClick;
 window.openBookDetail = openBookDetail;
 window.closeBookDetail = closeBookDetail;
 window.filterBooks = filterBooks;
 window.toggleTopAuthor = toggleTopAuthor;
 window.startAddToFavorites = startAddToFavorites;
 window.cancelAddToFavorites = cancelAddToFavorites;
 window.saveFavoritesFromLibrary = saveFavoritesFromLibrary;
 window.handleBookCardClick = handleBookCardClick;
 </script>
 </body>
 </html>
 `;

 return res.status(200).send(html);

 } catch (error: any) {
 console.error('[API] Error rendering profile page:', error);
 console.error('[API] Error stack:', error?.stack);
 console.error('[API] Error message:', error?.message);
 console.error('[API] Error details:', {
 username,
 isEditMode,
 errorType: error?.constructor?.name,
 errorCode: error?.code,
 errorDetails: error?.details
 });
 
 // Return a proper error page with sanitized error message
 const errorMessage = error?.message ? String(error.message).replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Unknown error';
 const errorDetails = error?.stack ? String(error.stack).slice(0, 500).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
 
 return res.status(500).send(`
 <!DOCTYPE html>
 <html>
 <head>
 <title>Error - Bookshelf Scanner</title>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <style>
 body { font-family: system-ui; padding: 40px; text-align: center; background: #f8f6f0; }
 .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
 h1 { color: #e74c3c; margin-bottom: 20px; }
 p { color: #666; margin: 10px 0; }
 pre { background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: left; overflow-x: auto; font-size: 12px; max-height: 300px; overflow-y: auto; }
 a { color: #007AFF; text-decoration: none; display: inline-block; margin-top: 20px; }
 a:hover { text-decoration: underline; }
 </style>
 </head>
 <body>
 <div class="container">
 <h1>Error Loading Profile</h1>
 <p>An error occurred while loading this profile.</p>
 ${errorMessage ? `<pre>Error: ${errorMessage}</pre>` : ''}
 ${errorDetails && process.env.NODE_ENV !== 'production' ? `<pre>Details: ${errorDetails}</pre>` : ''}
 <a href="/">Return to Home</a>
 <br>
 <a href="/profile">Try Signing In Again</a>
 </div>
 </body>
 </html>
 `);
 }
}


