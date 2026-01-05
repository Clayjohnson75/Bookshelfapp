# Testing Face ID / Touch ID Authentication

## Prerequisites

1. **Real Device Required**: Face ID/Touch ID only works on real iOS devices, NOT in the simulator
2. **Device Setup**: Make sure Face ID/Touch ID is enabled in your device Settings
3. **App Installed**: Have the app installed on your device (via Expo Go or TestFlight/build)

## Step-by-Step Testing Guide

### Step 1: Enable Biometric Login

1. **Open the app** on your device
2. **Sign in** with your email and password
3. **Check the "Remember me & enable Face ID" toggle** (appears below password field)
4. **Tap "Sign In"**
5. You should see a success message and be signed in

### Step 2: Test Biometric Login

1. **Sign out** of the app (Settings → Sign Out)
2. You should now see a **"Sign in with Face ID"** button on the login screen
3. **Tap the Face ID button**
4. **Face ID prompt should appear** - look at your device to authenticate
5. If successful, you should be automatically signed in

### Step 3: Test Settings Toggle

1. **Sign in** (using Face ID or password)
2. Go to **Settings** → **Preferences**
3. You should see a **"Face ID Login"** toggle
4. **Toggle it off** - should disable biometric
5. **Sign out** - Face ID button should disappear
6. **Toggle it back on** - you'll need to sign in again with "Remember Me" checked

## What to Look For

### ✅ Success Indicators:
- "Remember me & enable Face ID" toggle appears on login screen
- Face ID button appears after enabling biometric
- Face ID prompt appears when tapping the button
- Automatic sign-in after successful Face ID authentication
- Settings toggle works correctly

### ❌ Potential Issues:
- **No toggle/button appears**: Device might not support Face ID, or biometric check failed
- **Face ID prompt doesn't appear**: Check device Settings → Face ID & Passcode
- **App crashes**: Check console logs for errors
- **"Remember Me" doesn't work**: Check if credentials are being stored (see debugging below)

## Debugging

### Check Console Logs

Look for these messages in your console:

```
🔗 Using DEV/PRODUCTION Supabase: ...
✅ Successfully incremented scan count for user: ...
📊 Incremented scan count for X photo(s)
```

For biometric:
- `Error checking biometric capabilities:` - Module not loaded
- `Error storing credentials:` - SecureStore issue
- `Biometric sign in error:` - Authentication failed

### Manual Testing Checklist

- [ ] App opens without crashing
- [ ] Login screen shows "Remember me & enable Face ID" toggle (if device supports it)
- [ ] Can sign in with email/password
- [ ] After signing in with "Remember Me" checked, biometric is enabled
- [ ] After signing out, "Sign in with Face ID" button appears
- [ ] Tapping Face ID button shows Face ID prompt
- [ ] Face ID authentication succeeds and signs user in
- [ ] Settings shows biometric toggle
- [ ] Can disable biometric in Settings
- [ ] Can re-enable biometric

## Testing on Different Devices

### iPhone with Face ID (iPhone X and newer)
- Should show "Face ID" in UI
- Uses Face ID authentication

### iPhone with Touch ID (iPhone 8 and older)
- Should show "Touch ID" in UI
- Uses fingerprint authentication

### iPad
- Depends on model - newer iPads have Face ID
- Older iPads may not support biometric

### Simulator
- ❌ **Won't work** - biometric requires real device
- App will still work, but biometric features won't be available

## Troubleshooting

### Issue: Toggle/Button Doesn't Appear

**Possible Causes:**
1. Device doesn't support Face ID/Touch ID
2. Biometric not set up in device Settings
3. Native modules not properly linked (need to rebuild)

**Solution:**
- Check device Settings → Face ID & Passcode (or Touch ID & Passcode)
- Make sure Face ID/Touch ID is enabled
- Rebuild app: `npx expo prebuild --clean` then `eas build`

### Issue: Face ID Prompt Doesn't Appear

**Possible Causes:**
1. Biometric not enabled in app
2. Credentials not stored
3. Device biometric disabled

**Solution:**
- Sign in again with "Remember Me" checked
- Check Settings → Preferences → Face ID Login toggle is ON
- Verify device biometric is enabled

### Issue: App Crashes on Open

**Possible Causes:**
1. Native modules not linked
2. Missing error handling

**Solution:**
- Check console for error messages
- The code now has defensive error handling - should not crash
- If still crashing, may need to rebuild with `npx expo prebuild --clean`

## Quick Test Script

1. **Fresh Start**: Clear app data (delete and reinstall, or clear AsyncStorage)
2. **Sign In**: Use email/password, check "Remember me & enable Face ID"
3. **Verify**: Check Settings → Preferences → Face ID Login should be ON
4. **Sign Out**: Settings → Sign Out
5. **Test Biometric**: Tap "Sign in with Face ID" button
6. **Authenticate**: Complete Face ID prompt
7. **Verify**: Should be signed in automatically

## Expected Behavior

### First Time User:
- Sees login screen with email/password fields
- Sees "Remember me & enable Face ID" toggle (if device supports it)
- No Face ID button yet

### After Enabling Biometric:
- Sees "Sign in with Face ID" button on login screen
- Can use Face ID for quick login
- Can still use password login as fallback

### In Settings:
- Sees "Face ID Login" toggle in Preferences section
- Can enable/disable biometric login
- Changes take effect immediately

## Notes

- **Biometric is optional** - app works perfectly without it
- **Credentials are encrypted** - stored securely in iOS Keychain
- **Sign out clears biometric** - must re-enable after signing out
- **Works with existing accounts** - just need to enable it once





