# What Happens When You Make Changes in Dev?

## ⚠️ IMPORTANT: Dev and Production Share the SAME Database

Since your app uses the **same Supabase database** for both dev and production, **any changes you make in dev will affect production immediately**.

## What Gets Affected:

### ✅ Changes That Affect Production:

1. **Scanning Books**:
   - If you scan in Expo Go (dev) → Books appear in production app
   - If you scan in production app → Books appear in Expo Go (dev)
   - **Same database, same data**

2. **Adding Books to Library**:
   - Approving books in dev → Shows in production
   - Approving books in production → Shows in dev
   - **All synced to same database**

3. **Deleting Books/Photos**:
   - Deleting in dev → Deleted from production
   - Deleting in production → Deleted from dev
   - **⚠️ Be careful! Deletions are permanent**

4. **Account Changes**:
   - Profile updates in dev → Updates in production
   - Subscription changes in dev → Updates in production
   - **Same account, same data**

5. **Photos**:
   - Uploading photos in dev → Appears in production
   - Uploading photos in production → Appears in dev
   - **Same Supabase Storage bucket**

### ❌ Changes That DON'T Affect Production:

1. **Code Changes**:
   - Editing `.tsx` files → Only affects your local dev build
   - Production app uses the code from the App Store build
   - **Code changes don't affect production until you rebuild and submit**

2. **Local Storage (AsyncStorage)**:
   - Data stored locally on your device
   - Different between dev and production devices
   - **But syncs to same Supabase database**

3. **Environment Variables**:
   - `.env` file changes → Only affects local dev
   - Production uses values from `app.config.js` or EAS secrets
   - **But both point to same Supabase URL**

## Real-World Examples:

### Example 1: Testing a Scan
```
1. You scan a book in Expo Go (dev)
2. Book is saved to Supabase database
3. You open production app
4. ✅ The book you scanned in dev is now in production!
```

### Example 2: Deleting a Book
```
1. You delete a book in Expo Go (dev)
2. Book is deleted from Supabase database
3. You open production app
4. ⚠️ The book is gone from production too!
```

### Example 3: Changing Code
```
1. You edit ScansTab.tsx in dev
2. Code change only affects your local dev build
3. Production app still has old code
4. ✅ Production is safe until you rebuild and submit
```

## Best Practices:

### ✅ Safe to Do in Dev:
- Test scanning (but know it will appear in production)
- Test UI changes (code changes don't affect production)
- Test new features (code only)
- Test with test accounts (create separate test accounts)

### ⚠️ Be Careful:
- Don't delete real data in dev (it deletes from production)
- Don't test destructive operations on real accounts
- Don't make database schema changes without testing

### 🛡️ How to Protect Production Data:

1. **Use Test Accounts**:
   - Create separate test accounts for dev testing
   - Don't use your real account for testing

2. **Test Database (Optional)**:
   - Create a separate Supabase project for testing
   - Use environment variables to switch between dev/prod databases
   - More complex but safer

3. **Be Mindful**:
   - Remember that dev changes affect production
   - Test carefully before making changes
   - Use test accounts when possible

## Summary:

**Dev and production share the same database**, so:
- ✅ **Data changes** (scans, books, photos) → Affect production immediately
- ❌ **Code changes** → Only affect production after rebuild and App Store submission
- ⚠️ **Be careful** with deletions and destructive operations

**Your account data is the same everywhere** - what you do in dev affects production data, but code changes are safe until you rebuild and submit.




