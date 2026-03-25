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
  
  // Handle POST requests to save settings
  if (req.method === 'POST') {
    const { username } = req.query;
    const authHeader = req.headers.authorization || '';

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Invalid username' });
    }
    
    // Reject static file requests
    const lowerUsername = username.toLowerCase();
    const hasFileExtension = /\.(png|ico|svg|jpg|jpeg|gif|txt|xml|json|css|js|woff|woff2|ttf|eot)$/i.test(username);
    const matchesStaticPattern = ['favicon', 'robots', 'sitemap', '.well-known'].some(pattern => lowerUsername.includes(pattern));
    
    if (hasFileExtension || matchesStaticPattern || !/^[a-z0-9_-]+$/i.test(username)) {
      return res.status(404).end(); // Silent 404
    }

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token. Please sign in again.' });
    }

    const token = authHeader.slice(7).trim();
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token. Please sign in again.' });
    }
    const userId = data.user.id;

    try {
      // Get profile to verify ownership (user can only edit their own profile)
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('username', lowerUsername)
        .maybeSingle();

      if (profileError || !profile || profile.id !== userId) {
        return res.status(403).json({ error: 'Forbidden', message: 'You can only edit your own profile.' });
      }

      // Get customization settings from request body
      const {
        backgroundColor,
        buttonColor,
        textColor,
        showTotalBooks,
        showReadBooks,
        showUnreadBooks,
        showTopAuthors,
        showFavorites,
        showFolders,
        hideBio,
        hideAvatar
      } = req.body;

      const profileSettings = {
        backgroundColor: backgroundColor || '#f8f6f0',
        buttonColor: buttonColor || '#007AFF',
        textColor: textColor || '#2c3e50',
        showTotalBooks: showTotalBooks !== false,
        showReadBooks: showReadBooks !== false,
        showUnreadBooks: showUnreadBooks !== false,
        showTopAuthors: showTopAuthors === true,
        showFavorites: showFavorites === true,
        showFolders: showFolders === true,
        hideBio: hideBio || false,
        hideAvatar: hideAvatar || false
      };

      // Update profile_settings column (requires migration add-profile-settings.sql)
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ profile_settings: profileSettings })
        .eq('id', profile.id);

      if (updateError) {
        console.error('[API] Error saving profile settings:', updateError);
        return res.status(500).json({
          error: 'Failed to save settings',
          message: 'Database update failed'
        });
      }

      return res.status(200).json({ success: true, settings: profileSettings });
    } catch (error: any) {
      console.error('[API] Error in save profile settings:', error);
      return res.status(500).json({ error: 'Failed to save settings' });
    }
  }

  // Handle GET requests to show edit page
  const { username } = req.query;

  if (!username || typeof username !== 'string') {
    return res.status(400).send('Invalid username');
  }

  try {
    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[API] Missing Supabase credentials');
      return res.status(500).send('Server configuration error');
    }

    // Use service role key to bypass RLS for public profiles
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Validate username format (reject static file requests)
    if (!username || typeof username !== 'string') {
      return res.status(404).end(); // Silent 404
    }
    
    const lowerUsername = username.toLowerCase();
    const hasFileExtension = /\.(png|ico|svg|jpg|jpeg|gif|txt|xml|json|css|js|woff|woff2|ttf|eot)$/i.test(username);
    const matchesStaticPattern = ['favicon', 'robots', 'sitemap', '.well-known'].some(pattern => lowerUsername.includes(pattern));
    
    if (hasFileExtension || matchesStaticPattern || !/^[a-z0-9_-]+$/i.test(username)) {
      return res.status(404).end(); // Silent 404
    }

    // Get user profile by username (include profile_settings for current values)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, profile_bio, profile_settings')
      .eq('username', username.toLowerCase())
      .single();

    // Handle errors
    if (profileError) {
      if (profileError.code === 'PGRST116') {
        return res.status(404).send('Profile not found');
      }
      return res.status(500).send('Error loading profile');
    }

    if (!profile) {
      return res.status(404).send('Profile not found');
    }

    // Use saved profile_settings or defaults
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

    const profileData = {
      username: profile.username,
      displayName: profile.display_name || profile.username,
      avatarUrl: profilePhoto?.uri ?? null,
      settings
    };

    // Return edit page HTML
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" href="/logo.png" type="image/png">
        <link rel="apple-touch-icon" href="/logo.png">
        <title>Edit Profile - ${profileData.displayName}</title>
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
            max-width: 900px;
            margin: 0 auto;
            padding: 40px 20px;
          }
          .edit-header {
            margin-bottom: 40px;
          }
          .edit-title {
            font-size: 36px;
            font-weight: 800;
            color: #2c3e50;
            margin-bottom: 10px;
          }
          .edit-subtitle {
            font-size: 16px;
            color: #666;
          }
          .settings-section {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          }
          .section-title {
            font-size: 24px;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #e0e0e0;
          }
          .form-group {
            margin-bottom: 25px;
          }
          .form-label {
            display: block;
            font-size: 14px;
            font-weight: 600;
            color: #2c3e50;
            margin-bottom: 8px;
          }
          .form-description {
            font-size: 13px;
            color: #666;
            margin-bottom: 10px;
          }
          .color-input-wrapper {
            display: flex;
            align-items: center;
            gap: 15px;
          }
          .color-input {
            width: 60px;
            height: 40px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            cursor: pointer;
            padding: 0;
            background: none;
          }
          .color-input::-webkit-color-swatch-wrapper {
            padding: 0;
          }
          .color-input::-webkit-color-swatch {
            border: none;
            border-radius: 6px;
          }
          .text-input {
            flex: 1;
            padding: 10px 14px;
            font-size: 14px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-family: monospace;
            background: #f8f6f0;
          }
          .toggle-group {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 15px;
            background: #f8f6f0;
            border-radius: 8px;
            margin-bottom: 10px;
          }
          .toggle-label {
            font-size: 15px;
            font-weight: 600;
            color: #2c3e50;
          }
          .toggle-switch {
            position: relative;
            width: 50px;
            height: 26px;
          }
          .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
          }
          .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #ccc;
            transition: 0.3s;
            border-radius: 26px;
          }
          .toggle-slider:before {
            position: absolute;
            content: "";
            height: 20px;
            width: 20px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: 0.3s;
            border-radius: 50%;
          }
          .toggle-switch input:checked + .toggle-slider {
            background-color: #007AFF;
          }
          .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(24px);
          }
          .preview-section {
            background: #f8f6f0;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 30px;
            border: 2px dashed #e0e0e0;
          }
          .preview-title {
            font-size: 18px;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 20px;
          }
          .preview-content {
            background: white;
            border-radius: 8px;
            padding: 20px;
            min-height: 200px;
          }
          .button-group {
            display: flex;
            gap: 15px;
            margin-top: 30px;
          }
          .button {
            padding: 14px 28px;
            font-size: 16px;
            font-weight: 600;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }
          .button-primary {
            background: #007AFF;
            color: white;
          }
          .button-primary:hover {
            background: #0056CC;
          }
          .button-secondary {
            background: white;
            color: #2c3e50;
            border: 2px solid #e0e0e0;
          }
          .button-secondary:hover {
            background: #f8f6f0;
            border-color: #007AFF;
          }
          .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .message {
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
          }
          .message.show {
            display: block;
          }
          .message-success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
          }
          .message-error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
          }
          .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
          }
          .modal-overlay.show {
            display: flex;
          }
          .modal-content {
            background: white;
            border-radius: 12px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
          }
          .modal-header {
            padding: 20px;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .modal-title { font-size: 18px; font-weight: 700; color: #2c3e50; }
          .modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #666; line-height: 1; }
          .modal-body {
            padding: 20px;
            overflow-y: auto;
            flex: 1;
          }
          .favorites-search {
            width: 100%;
            padding: 12px 16px;
            font-size: 16px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            margin-bottom: 16px;
          }
          .favorites-search:focus {
            outline: none;
            border-color: #007AFF;
          }
          .favorites-count {
            font-size: 14px;
            color: #666;
            margin-bottom: 12px;
          }
          .favorites-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .favorites-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            cursor: pointer;
            transition: border-color 0.2s;
          }
          .favorites-item:hover { border-color: #007AFF; }
          .favorites-item.selected { border-color: #007AFF; background: #f0f8ff; }
          .favorites-item input[type="checkbox"] {
            width: 20px;
            height: 20px;
            cursor: pointer;
          }
          .favorites-item-cover {
            width: 40px;
            height: 60px;
            object-fit: cover;
            border-radius: 4px;
          }
          .favorites-item-cover-placeholder {
            width: 40px;
            height: 60px;
            background: #e2e8f0;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: #718096;
            text-align: center;
            padding: 4px;
          }
          .favorites-item-info { flex: 1; }
          .favorites-item-title { font-weight: 600; color: #2c3e50; }
          .favorites-item-author { font-size: 13px; color: #666; }
          .modal-footer {
            padding: 20px;
            border-top: 1px solid #e0e0e0;
            display: flex;
            justify-content: flex-end;
            gap: 10px;
          }
          @media (max-width: 768px) {
            .container {
              padding: 20px 15px;
            }
            .edit-title {
              font-size: 28px;
            }
            .settings-section {
              padding: 20px;
            }
            .button-group {
              flex-direction: column;
            }
            .button {
              width: 100%;
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
            <a href="/${profileData.username}" style="color: #007AFF; text-decoration: none; font-weight: 600;">View Profile</a>
          </div>
        </div>

        <div class="container">
          <div class="edit-header">
            <h1 class="edit-title">Customize Your Profile</h1>
            <p class="edit-subtitle">Personalize how your profile appears to others</p>
          </div>

          <div id="message" class="message"></div>

          <!-- Colors Section -->
          <div class="settings-section">
            <h2 class="section-title">Colors</h2>
            
            <div class="form-group">
              <label class="form-label" for="backgroundColor">Background Color</label>
              <p class="form-description">Choose the background color for your profile page</p>
              <div class="color-input-wrapper">
                <input type="color" id="backgroundColor" class="color-input" value="${settings.backgroundColor}">
                <input type="text" id="backgroundColorText" class="text-input" value="${settings.backgroundColor}">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="buttonColor">Button Color</label>
              <p class="form-description">Choose the color for buttons and links</p>
              <div class="color-input-wrapper">
                <input type="color" id="buttonColor" class="color-input" value="${settings.buttonColor}">
                <input type="text" id="buttonColorText" class="text-input" value="${settings.buttonColor}">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="textColor">Text Color</label>
              <p class="form-description">Choose the main text color</p>
              <div class="color-input-wrapper">
                <input type="color" id="textColor" class="color-input" value="${settings.textColor}">
                <input type="text" id="textColorText" class="text-input" value="${settings.textColor}">
              </div>
            </div>

            <button type="button" class="button button-secondary" style="margin-top: 10px;" onclick="resetColors()">Reset to Original</button>
          </div>

          <!-- Stats Visibility Section -->
          <div class="settings-section">
            <h2 class="section-title">Stats Visibility</h2>
            <p class="form-description" style="margin-bottom: 20px;">Choose which statistics to display on your profile</p>
            
            <div class="toggle-group">
              <label class="toggle-label">Show Total Books</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showTotalBooks" ${settings.showTotalBooks ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Show Read Books</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showReadBooks" ${settings.showReadBooks ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Show Unread Books</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showUnreadBooks" ${settings.showUnreadBooks ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Show Top Authors</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showTopAuthors" ${settings.showTopAuthors ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Show Favorites Bar</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showFavorites" ${settings.showFavorites ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div style="margin-top: 12px; margin-left: 0;">
              <button type="button" class="button button-secondary" onclick="openFavoritesModal()" style="font-size: 14px; padding: 10px 18px;">Add to Favorites</button>
              <span class="form-description" style="margin-left: 10px; display: inline-block;">Search and select up to 10 books to show in your Favorites bar</span>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Show Collections</label>
              <label class="toggle-switch">
                <input type="checkbox" id="showFolders" ${settings.showFolders ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- Elements Visibility Section -->
          <div class="settings-section">
            <h2 class="section-title">Profile Elements</h2>
            <p class="form-description" style="margin-bottom: 20px;">Choose which elements to hide on your profile</p>
            
            <div class="toggle-group">
              <label class="toggle-label">Hide Bio</label>
              <label class="toggle-switch">
                <input type="checkbox" id="hideBio" ${settings.hideBio ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="toggle-group">
              <label class="toggle-label">Hide Avatar</label>
              <label class="toggle-switch">
                <input type="checkbox" id="hideAvatar" ${settings.hideAvatar ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="button-group">
            <button class="button button-primary" onclick="saveSettings()">Save Changes</button>
            <button class="button button-secondary" onclick="window.location.href='/${profileData.username}'">Cancel</button>
          </div>
        </div>

        <!-- Favorites Modal -->
        <div id="favoritesModal" class="modal-overlay" onclick="if(event.target===this) closeFavoritesModal()">
          <div class="modal-content">
            <div class="modal-header">
              <h2 class="modal-title">Add to Favorites</h2>
              <button type="button" class="modal-close" onclick="closeFavoritesModal()">&times;</button>
            </div>
            <div class="modal-body">
              <input type="text" id="favoritesSearch" class="favorites-search" placeholder="Search your library..." oninput="filterFavoritesList()">
              <div class="favorites-count" id="favoritesCount">Select up to 10 books</div>
              <div class="favorites-list" id="favoritesList"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="button button-secondary" onclick="closeFavoritesModal()">Cancel</button>
              <button type="button" class="button button-primary" id="saveFavoritesBtn" onclick="saveFavorites()">Save Favorites</button>
            </div>
          </div>
        </div>

        <script>
          // Sync color pickers with text inputs
          function syncColorInputs() {
            const colorInputs = ['backgroundColor', 'buttonColor', 'textColor'];
            colorInputs.forEach(colorId => {
              const colorInput = document.getElementById(colorId);
              const textInput = document.getElementById(colorId + 'Text');
              
              colorInput.addEventListener('input', () => {
                textInput.value = colorInput.value;
              });
              
              textInput.addEventListener('input', () => {
                if (/^#[0-9A-F]{6}$/i.test(textInput.value)) {
                  colorInput.value = textInput.value;
                }
              });
            });
          }

          function getAccessToken() {
            // Prefer session stored by web sign-in
            const session = localStorage.getItem('supabase_session');
            if (session) {
              try {
                const data = JSON.parse(session);
                const token = data.access_token || data.session?.access_token;
                if (token) return token;
              } catch (e) {}
            }
            // Fallback: Supabase client stores under sb-<projectRef>-auth-token
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

          async function saveSettings() {
            const messageDiv = document.getElementById('message');
            messageDiv.classList.remove('show', 'message-success', 'message-error');

            const accessToken = getAccessToken();
            if (!accessToken) {
              window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
              return;
            }

            try {
              // Get all settings
              const settings = {
                backgroundColor: document.getElementById('backgroundColor').value,
                buttonColor: document.getElementById('buttonColor').value,
                textColor: document.getElementById('textColor').value,
                showTotalBooks: document.getElementById('showTotalBooks').checked,
                showReadBooks: document.getElementById('showReadBooks').checked,
                showUnreadBooks: document.getElementById('showUnreadBooks').checked,
                showTopAuthors: document.getElementById('showTopAuthors').checked,
                showFavorites: document.getElementById('showFavorites').checked,
                showFolders: document.getElementById('showFolders').checked,
                hideBio: document.getElementById('hideBio').checked,
                hideAvatar: document.getElementById('hideAvatar').checked
              };

              // Save settings
              const response = await fetch('/api/profile/${profileData.username}/edit', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': \`Bearer \${accessToken}\`
                },
                body: JSON.stringify(settings)
              });

              const data = await response.json();

              if (!response.ok) {
                const msg = data.message || data.error || 'Failed to save settings';
                if (response.status === 401) {
                  localStorage.removeItem('supabase_session');
                  const keysToRemove = [];
                  for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) keysToRemove.push(key);
                  }
                  keysToRemove.forEach(k => localStorage.removeItem(k));
                  window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
                  return;
                }
                throw new Error(msg);
              }

              showMessage('Settings saved successfully!', 'success');

              // Redirect to profile after a short delay
              setTimeout(() => {
                window.location.href = '/${profileData.username}';
              }, 1500);
            } catch (error) {
              console.error('Error saving settings:', error);
              showMessage(error.message || 'Failed to save settings. Please try again.', 'error');
            }
          }

          function showMessage(text, type) {
            const messageDiv = document.getElementById('message');
            messageDiv.textContent = text;
            messageDiv.className = \`message message-\${type} show\`;
            setTimeout(() => messageDiv.classList.remove('show'), 5000);
          }
          function showMessageWithLink(text, linkHref, linkText, type) {
            const messageDiv = document.getElementById('message');
            messageDiv.textContent = '';
            messageDiv.appendChild(document.createTextNode(text));
            const a = document.createElement('a');
            a.href = linkHref;
            a.textContent = linkText;
            a.style.marginLeft = '4px';
            messageDiv.appendChild(document.createTextNode(' '));
            messageDiv.appendChild(a);
            messageDiv.className = \`message message-\${type} show\`;
            setTimeout(() => messageDiv.classList.remove('show'), 8000);
          }

          function resetColors() {
            const defaults = {
              backgroundColor: '#f8f6f0',
              buttonColor: '#007AFF',
              textColor: '#2c3e50'
            };
            Object.entries(defaults).forEach(([key, value]) => {
              const colorInput = document.getElementById(key);
              const textInput = document.getElementById(key + 'Text');
              if (colorInput && textInput) {
                colorInput.value = value;
                textInput.value = value;
              }
            });
          }

          let favoritesBooks = [];
          let favoritesSelected = new Set();

          async function openFavoritesModal() {
            const token = getAccessToken();
            if (!token) {
              window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
              return;
            }
            document.getElementById('favoritesModal').classList.add('show');
            document.getElementById('favoritesSearch').value = '';
            favoritesSelected.clear();
            try {
              const res = await fetch('/api/library-books', {
                headers: { 'Authorization': 'Bearer ' + token }
              });
              if (!res.ok) {
                if (res.status === 401) {
                  window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
                  return;
                }
                throw new Error('Failed to load books');
              }
              const data = await res.json();
              favoritesBooks = data.books || [];
              favoritesBooks.forEach(b => {
                if (b.is_favorite) favoritesSelected.add(b.id);
              });
              renderFavoritesList();
            } catch (e) {
              alert('Failed to load your library. Please try again.');
              closeFavoritesModal();
            }
          }

          function closeFavoritesModal() {
            document.getElementById('favoritesModal').classList.remove('show');
          }

          function filterFavoritesList() {
            renderFavoritesList();
          }

          function toggleFavorite(bookId) {
            if (favoritesSelected.has(bookId)) {
              favoritesSelected.delete(bookId);
            } else if (favoritesSelected.size < 10) {
              favoritesSelected.add(bookId);
            }
            renderFavoritesList();
          }

          function renderFavoritesList() {
            const q = (document.getElementById('favoritesSearch').value || '').trim().toLowerCase();
            const filtered = q
              ? favoritesBooks.filter(b =>
                  (b.title || '').toLowerCase().includes(q) ||
                  (b.author || '').toLowerCase().includes(q))
              : favoritesBooks;
            const list = document.getElementById('favoritesList');
            const countEl = document.getElementById('favoritesCount');
            countEl.textContent = favoritesSelected.size + ' / 10 selected';
            list.innerHTML = filtered.length === 0
              ? '<p style="color:#666;">No books found. ' + (q ? 'Try a different search.' : 'Add books in the app first.') + '</p>'
              : filtered.map(b => {
                  const sel = favoritesSelected.has(b.id);
                  const cover = b.cover_url
                    ? '<img src="' + b.cover_url.replace(/"/g, '&quot;') + '" alt="" class="favorites-item-cover">'
                    : '<div class="favorites-item-cover-placeholder">' + (b.title || '').substring(0, 15) + '</div>';
                  const title = (b.title || 'Untitled').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const author = (b.author || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  return '<label class="favorites-item ' + (sel ? 'selected' : '') + '" onclick="event.preventDefault(); toggleFavorite(\'' + b.id.replace(/'/g, "\\'") + '\');">' +
                    '<input type="checkbox" ' + (sel ? 'checked' : '') + '>' +
                    cover +
                    '<div class="favorites-item-info">' +
                    '<div class="favorites-item-title">' + title + '</div>' +
                    (author ? '<div class="favorites-item-author">' + author + '</div>' : '') +
                    '</div></label>';
                }).join('');
          }

          async function saveFavorites() {
            const token = getAccessToken();
            if (!token) {
              window.location.href = '/api/signin?returnUrl=' + encodeURIComponent(window.location.pathname);
              return;
            }
            const btn = document.getElementById('saveFavoritesBtn');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            try {
              const res = await fetch('/api/set-favorites', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ bookIds: Array.from(favoritesSelected) })
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error || 'Failed to save favorites');
              }
              closeFavoritesModal();
              showMessage('Favorites saved!', 'success');
            } catch (e) {
              alert(e.message || 'Failed to save favorites.');
            } finally {
              btn.disabled = false;
              btn.textContent = 'Save Favorites';
            }
          }

          // Initialize on load
          document.addEventListener('DOMContentLoaded', () => {
            syncColorInputs();
            if (window.location.search.includes('favorites=1')) {
              openFavoritesModal();
            }
          });
        </script>
      </body>
      </html>
    `;

    return res.send(html);
  } catch (error: any) {
    console.error('[API] Error in profile edit:', error);
    return res.status(500).send('Error loading edit page');
  }
}
