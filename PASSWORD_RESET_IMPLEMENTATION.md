# Password Reset Implementation Guide

## Current Status
✅ Password reset email is sent
❌ Reset link opens web page instead of app
❌ No in-app password reset screen

## What We're Implementing

1. **Deep Linking** - Reset links will open the app
2. **Password Reset Screen** - Users can reset password in the app
3. **Token Handling** - App handles the reset token from the email link

## Steps to Complete

### 1. Update Supabase Redirect URL
In your Supabase dashboard:
- Go to Authentication → URL Configuration
- Add to "Redirect URLs": `bookshelfscanner://reset-password`
- Add to "Site URL": `bookshelfscanner://` (for deep links)

### 2. Update Password Reset Function
The `resetPassword` function in `SimpleAuthContext.tsx` now uses:
```typescript
redirectTo: 'bookshelfscanner://reset-password'
```

### 3. Deep Link Handling
The app now listens for deep links and extracts the password reset token.

### 4. Password Reset Screen
A new screen allows users to enter their new password directly in the app.

## How It Works

1. User clicks "Forgot Password?" and enters email
2. Email is sent with reset link: `bookshelfscanner://reset-password?token=...`
3. User clicks link → App opens
4. App extracts token from URL
5. App shows password reset screen
6. User enters new password
7. Password is updated via Supabase
8. User is signed in automatically




