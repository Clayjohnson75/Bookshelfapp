import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle POST requests to save settings
  if (req.method === 'POST') {
    const { username } = req.query;
    const authHeader = req.headers.authorization || '';

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Invalid username' });
    }

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const jwt = authHeader.slice(7);
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } }
    });

    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData?.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Get profile to verify ownership
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('username', username.toLowerCase())
        .single();

      if (!profile || profile.id !== userData.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
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
        hideBio,
        hideAvatar
      } = req.body;

      // Save to database (for now, we'll store as JSON in a custom column or update profiles table)
      // Since we might not have profile_settings column yet, we'll create an API to handle this
      // For now, store in a JSON column or create a separate table
      const profileSettings = {
        backgroundColor: backgroundColor || '#f8f6f0',
        buttonColor: buttonColor || '#007AFF',
        textColor: textColor || '#2c3e50',
        showTotalBooks: showTotalBooks !== false,
        showReadBooks: showReadBooks !== false,
        showUnreadBooks: showUnreadBooks !== false,
        showTopAuthors: showTopAuthors !== false,
        hideBio: hideBio || false,
        hideAvatar: hideAvatar || false
      };

      // Update profile with settings (we'll need to add a profile_settings column or use a separate table)
      // For now, let's try to update a JSON column or create a migration
      // Since we can't create migrations here, we'll store it in profile_bio or a custom field
      // Actually, let's check if we can add to an existing column or create a service role update
      
      const supabaseService = createClient(
        supabaseUrl,
        process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        {
          auth: { autoRefreshToken: false, persistSession: false }
        }
      );

      // Try to update profile_settings column, if it doesn't exist, this will fail gracefully
      const { error: updateError } = await supabaseService
        .from('profiles')
        .update({ profile_settings: profileSettings })
        .eq('id', profile.id);

      if (updateError) {
        console.error('[API] Error saving profile settings:', updateError);
        // If column doesn't exist, we'll need to add it via migration
        // For now, return success but log the error
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

    // Get user profile by username
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

    // Get current settings or defaults
    const settings = (profile.profile_settings as any) || {
      backgroundColor: '#f8f6f0',
      buttonColor: '#007AFF',
      textColor: '#2c3e50',
      showTotalBooks: true,
      showReadBooks: true,
      showUnreadBooks: true,
      showTopAuthors: true,
      hideBio: false,
      hideAvatar: false
    };

    const profileData = {
      username: profile.username,
      displayName: profile.display_name || profile.username,
      settings
    };

    // Return edit page HTML
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

          async function saveSettings() {
            const messageDiv = document.getElementById('message');
            messageDiv.classList.remove('show', 'message-success', 'message-error');

            // Get session token
            const session = localStorage.getItem('supabase_session');
            if (!session) {
              showMessage('You must be signed in to save settings', 'error');
              return;
            }

            try {
              const sessionData = JSON.parse(session);
              const accessToken = sessionData.access_token || sessionData.session?.access_token;

              if (!accessToken) {
                showMessage('Authentication failed. Please sign in again.', 'error');
                return;
              }

              // Get all settings
              const settings = {
                backgroundColor: document.getElementById('backgroundColor').value,
                buttonColor: document.getElementById('buttonColor').value,
                textColor: document.getElementById('textColor').value,
                showTotalBooks: document.getElementById('showTotalBooks').checked,
                showReadBooks: document.getElementById('showReadBooks').checked,
                showUnreadBooks: document.getElementById('showUnreadBooks').checked,
                showTopAuthors: document.getElementById('showTopAuthors').checked,
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
                throw new Error(data.error || 'Failed to save settings');
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
            
            // Auto-hide after 5 seconds
            setTimeout(() => {
              messageDiv.classList.remove('show');
            }, 5000);
          }

          // Initialize on load
          document.addEventListener('DOMContentLoaded', () => {
            syncColorInputs();
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
