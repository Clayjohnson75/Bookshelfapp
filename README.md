# 📚 Bookshelf Scanner - Expo App

A React Native Expo app that scans bookshelves using AI to detect and catalog books.

## Features

- 📷 **Camera Scanning**: Take photos of bookshelves
- 🖼️ **Photo Upload**: Upload existing photos from your device
- 🤖 **AI Book Detection**: Uses OpenAI GPT-4o to detect books in 12 sections
- 📚 **Library Management**: View, search, and manage your book collection
- 🔄 **Replace Functionality**: Find similar books using Open Library API
- 🗑️ **Remove Books**: Delete books from your library
- 💾 **Local Storage**: Books are saved locally on your device

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure OpenAI API Key**:
   - Create a `.env` file in the root directory
   - Add your OpenAI API key:
   ```
   EXPO_PUBLIC_OPENAI_API_KEY=YOUR_KEY_HERE
   ```
   - Or replace with your own API key from https://platform.openai.com/api-keys

3. **Run the App**:
   ```bash
   # For iOS
   npm run ios
   
   # For Android
   npm run android
   
   # For Web
   npm run web
   ```

## How It Works

1. **Take a Photo**: Use the camera to capture a bookshelf
2. **AI Processing**: The app divides the image into 12 sections and analyzes each with OpenAI
3. **Book Detection**: AI identifies book titles (not author names) with confidence levels
4. **Library Management**: View your books, search, replace, or remove them

## Technical Details

- **Framework**: React Native with Expo
- **AI Model**: OpenAI GPT-4o-mini
- **Image Processing**: Expo Image Manipulator
- **Storage**: AsyncStorage for local data persistence
- **Book Covers**: Open Library API for book covers and metadata

## Permissions

The app requires:
- Camera access for taking photos
- Photo library access for uploading images

## API Keys Required

- **OpenAI API Key**: For AI book detection
- Get your key from: https://platform.openai.com/api-keys

## Troubleshooting

- Make sure your OpenAI API key is correctly set in the `.env` file
- Ensure you have camera/photo library permissions enabled
- Check your internet connection for API calls

## Original Web Version

This Expo app is based on the working web version located at:
`/Users/clayjohnson/BookshelfScannerExpo/`

The functionality is identical, just adapted for mobile devices.
