# Bookshelf Scanner - Complete Feature List

## 📸 CORE SCANNING FEATURES

### AI-Powered Book Detection
- **Dual AI System**: Uses both OpenAI GPT-4o and Google Gemini for maximum accuracy
- **Automatic Book Detection**: Scans bookshelf photos and detects all visible book spines
- **Confidence Levels**: Each detected book has a confidence rating (high/medium/low)
- **Smart Image Processing**: Divides large images into sections for better accuracy
- **Batch Processing**: Can process multiple images in queue
- **Background Scanning**: Scans can run in background with progress notifications
- **Real-time Progress**: Shows scanning progress with current/total sections

### Photo Capture & Upload
- **Camera Integration**: Take photos directly within the app
- **Photo Library Access**: Upload existing photos from device
- **Multiple Image Selection**: Select and scan multiple photos at once
- **Photo Captions**: Add captions to remember where each bookshelf is located
- **Photo Management**: View, edit, and delete scanned photos
- **Image Optimization**: Automatically optimizes images for faster processing

### Book Validation & Editing
- **Pending Books Review**: Review detected books before adding to library
- **Manual Book Editing**: Edit title and author if AI needs correction
- **Book Replacement**: Find and replace books with similar titles using Open Library API
- **Cover Search**: Search for book covers by title and replace them
- **Manual Book Entry**: Add books manually if they weren't detected
- **Book Validation**: AI validates detected books for accuracy

## 📚 LIBRARY MANAGEMENT

### Book Organization
- **Custom Folders**: Create unlimited folders to organize books by genre, author, reading status, etc.
- **Folder Management**: Create, rename, delete folders
- **Book-to-Folder Assignment**: Add books to folders individually or in bulk
- **Auto-Sort Feature**: AI automatically sorts books into folders based on similarity
  - Matches books to existing folders first
  - Creates new folders only when needed
  - Preserves all existing folders
  - Only uses "Other" folder for books with truly no data
- **Folder Expansion/Collapse**: Folders section can be expanded or collapsed on profile page
- **Folder Search**: Search for books within folders
- **Folder View**: Full-screen folder view with book grid

### Book Display & Details
- **Book Grid View**: Visual grid display of all books with covers
- **Book Detail Modal**: Tap any book to see full details
  - Title and author
  - Book cover (with ability to replace)
  - Description (fetched from Google Books)
  - Read/Unread status toggle
  - Remove book option
- **Book Covers**: Automatically fetches high-quality covers from Open Library
- **Cover Replacement**: Tap cover to search and replace with different cover image
- **Book Sorting**: Sort books by author's last name (default) or other criteria
- **Read Status Tracking**: Mark books as read/unread with timestamp

### Search & Filter
- **Real-time Search**: Search books by title or author with instant results
- **Smart Search**: Prioritizes starts-with matches, then contains matches
- **Filter by Read Status**: Filter to show only read or unread books
- **Library Search Bar**: Search across entire library
- **Folder Search**: Search within specific folders

## 👤 USER FEATURES

### Authentication
- **Email/Username Sign-in**: Sign in with email or username
- **Password Authentication**: Secure password-based authentication
- **Sign Up**: Create new account with email, username, password, and display name
- **Password Reset**: Forgot password flow with email reset link
  - Custom email sent via Resend
  - Deep link opens app directly to password reset screen
  - Web fallback page for browsers
- **Biometric Authentication**: Face ID / Touch ID support
  - Enable/disable biometric login
  - "Remember Me" option to enable biometric on login
  - Secure credential storage
- **Demo Account**: Hidden demo account for testing
- **Sign Out**: Secure sign out with data clearing

### User Profile
- **Profile Display**: Shows username, display name, book count, photo count
- **Profile Statistics**: 
  - Total books in library
  - Total photos scanned
  - Top author (author with most books)
- **Username Editing**: Change username in settings
- **Account Management**: Delete account option

### Settings
- **Settings Modal**: Accessible from profile page
- **Username Management**: Edit username
- **Biometric Settings**: Enable/disable Face ID or Touch ID
- **Clear Account Data**: Remove all books, photos, and scan data (keeps account)
- **Delete Account**: Permanently delete account and all data
- **Sign Out**: Sign out of account

## 💰 SUBSCRIPTION & PREMIUM FEATURES

### Free Tier
- **5 Scans Per Month**: Limited to 5 book scans per month
- **Monthly Reset**: Scan limit resets on the 1st of each month
- **Scan Limit Banner**: Shows remaining scans and upgrade prompt
- **Basic Features**: Access to all basic library management features

### Pro Tier (Subscription)
- **Unlimited Scans**: No monthly scan limit
- **Apple In-App Purchase**: Monthly subscription via Apple IAP
- **Subscription Management**: 
  - Purchase subscription
  - Restore purchases
  - Check subscription status
- **Upgrade Modal**: Prompts to upgrade when scan limit reached
- **Scan Limit Banner**: Disappears for Pro users

### Subscription Service
- **Scan Usage Tracking**: Tracks scans per user per month
- **Subscription Status**: Checks if user has active Pro subscription
- **Automatic Limit Enforcement**: Prevents scanning when limit reached
- **Usage Display**: Shows "X/5 scans used" or "Unlimited" for Pro users

## 📤 EXPORT & SHARING

### Citation Export
- **Multiple Formats**: Export in MLA, APA, or Chicago citation formats
- **Selective Export**: Export individual books, folders, or entire library
- **Proper Formatting**: Correctly formats author names per citation style
- **Book Details**: Includes publisher, publication date when available
- **Copy to Clipboard**: Easy copy/paste for academic work

### Sharing
- **Share Books**: Share individual books
- **Export Text**: Export library as formatted text
- **Folder Export**: Export specific folders

## 🔍 EXPLORE & DISCOVER

### User Discovery
- **Search Users**: Search for other users by username
- **User Profiles**: View other users' public profiles
- **Public Libraries**: Browse other users' public book collections
- **User Search Results**: See matching users in explore tab

### Book Discovery
- **Google Books Integration**: Search Google Books API for book information
- **Book Search**: Search for books by title
- **Author Search**: Search for books by author
- **Book Results**: View book details, covers, and metadata from Google Books
- **Pagination**: Load more book results with infinite scroll

## 📊 ANALYTICS & STATISTICS

### Library Statistics
- **Total Books**: Count of all books in library
- **Total Photos**: Count of all scanned photos
- **Top Author**: Author with the most books in collection
- **Read/Unread Count**: Track how many books you've read
- **Collection Growth**: Track library growth over time

### User Profile Stats
- **Book Count**: Total number of books
- **Photo Count**: Total number of photos
- **Profile Display**: Shows stats on profile page

## 🎨 UI/UX FEATURES

### Navigation
- **Bottom Tab Navigator**: Three main tabs (Scans, My Library, Explore)
- **Modal Views**: Full-screen modals for detailed views
- **Back Navigation**: Proper back button handling throughout app
- **Deep Linking**: Support for password reset deep links

### Visual Design
- **Modern UI**: Clean, modern interface design
- **Book Grid Layout**: Visual grid display of books
- **Cover Images**: High-quality book covers throughout
- **Icons**: Ionicons for consistent iconography
- **Gradients**: Linear gradients for visual appeal
- **Safe Area Support**: Proper handling of notches and safe areas

### User Experience
- **Loading States**: Activity indicators during processing
- **Error Handling**: User-friendly error messages
- **Confirmation Dialogs**: Confirm destructive actions
- **Toast Messages**: Success/error feedback
- **Keyboard Handling**: Proper keyboard avoidance
- **Scroll Views**: Smooth scrolling throughout

## 🔒 SECURITY & DATA

### Data Storage
- **Local Storage**: AsyncStorage for offline access
- **Cloud Sync**: Supabase for cloud backup and sync
- **Data Merging**: Smart merging of local and cloud data
- **Offline Support**: Works offline with local data
- **Data Persistence**: Data persists across app restarts

### Security
- **Secure Authentication**: Supabase authentication
- **Password Security**: Secure password storage and reset
- **Biometric Security**: Secure credential storage with biometric protection
- **API Security**: API keys stored server-side only (not exposed to client)
- **Row Level Security**: Supabase RLS policies for data protection

## 📱 TECHNICAL FEATURES

### Platform Support
- **iOS Native**: Built with Expo for iOS
- **Camera Permissions**: Proper camera permission handling
- **Photo Library Permissions**: Photo library access permissions
- **Biometric Support**: Face ID and Touch ID support

### Performance
- **Image Optimization**: Optimizes images before processing
- **Background Processing**: Scans can run in background
- **Progress Tracking**: Real-time progress updates
- **Error Recovery**: Retry logic for failed scans
- **Caching**: Caches book covers and data

### Integration
- **Supabase Backend**: Full Supabase integration for data storage
- **Vercel API**: Serverless API endpoints on Vercel
- **OpenAI Integration**: GPT-4o for book detection
- **Google Gemini Integration**: Gemini for book detection
- **Google Books API**: Book metadata and covers
- **Open Library API**: Book cover images
- **Resend Email Service**: Custom email sending for password reset
- **Apple IAP**: In-app purchase for subscriptions

## 🆕 RECENT FEATURES (Version 1.0.6 Build 26)

### Password Reset
- Custom email service integration (Resend)
- Deep link support for in-app password reset
- Web fallback page for password reset links
- Password update screen in app

### Folder Management
- Auto-sort books into folders using AI
- Folders expand/collapse on profile page
- Search bar when creating folders
- Bottom popup tab for folder creation
- Preserve existing folders when auto-sorting

### Security Improvements
- Removed exposed API keys from client code
- All AI calls go through server API endpoints
- Secure credential handling

## 📋 APP STRUCTURE

### Main Tabs
1. **Scans Tab**: Camera, photo upload, scanning, pending books review
2. **My Library Tab**: Books, folders, photos, profile, settings
3. **Explore Tab**: Search users, search books, discover new content

### Key Screens
- Login/Sign Up screens
- Password Reset screen
- Settings modal
- Book Detail modal
- Folder View (full-screen)
- Library View
- Upgrade Modal
- User Profile Modal

### Services
- Authentication service
- Subscription service
- Biometric auth service
- Apple IAP service
- Supabase sync service
- Google Books service

## 🎯 USE CASES

### For Book Collectors
- Digitize entire physical library
- Organize books by genre, author, or custom categories
- Track reading progress
- Export citations for academic work

### For Students
- Manage research book collections
- Export citations in MLA, APA, or Chicago format
- Organize books by course or project
- Quick access to book details

### For Book Clubs
- Share book collections
- Track group reading lists
- Discover new books from members
- Organize by reading status

### For Librarians
- Catalog collections quickly
- Organize by genre or subject
- Track collection statistics
- Export library data

## 🔄 DATA FLOW

1. **Scan Flow**: Photo → AI Processing → Pending Books → Approval → Library
2. **Sync Flow**: Local Storage ↔ Supabase Cloud Sync
3. **Subscription Flow**: Check Limit → Scan → Update Count → Enforce Limit
4. **Export Flow**: Select Books → Format Citations → Copy/Share

## 📈 METRICS TRACKED

- Total books in library
- Total photos scanned
- Scans used per month
- Subscription status
- Read/unread book counts
- Top authors
- Folder organization

## 🛠 TECHNICAL STACK

- **Framework**: React Native with Expo
- **Navigation**: React Navigation
- **Backend**: Supabase (PostgreSQL)
- **API**: Vercel Serverless Functions
- **AI**: OpenAI GPT-4o, Google Gemini
- **Storage**: AsyncStorage (local), Supabase (cloud)
- **Authentication**: Supabase Auth
- **Payments**: Apple In-App Purchase
- **Email**: Resend
- **Image Processing**: Expo Image Manipulator
- **Camera**: Expo Camera

