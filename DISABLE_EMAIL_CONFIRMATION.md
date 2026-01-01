# Disable Email Confirmation in Supabase

Email confirmation is not ideal for mobile apps. Here's how to disable it:

## Option 1: Disable in Supabase Dashboard (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **Authentication** → **Settings** → **Auth Providers** → **Email**
3. Find **"Enable email confirmations"** toggle
4. **Turn it OFF** (disable email confirmations)
5. Save changes

This will auto-confirm all new users, allowing them to sign in immediately after sign-up.

## Option 2: Auto-Confirm via SQL (Alternative)

If you prefer to do it via SQL, you can also set this in your database:

```sql
-- This is usually done via dashboard, but you can check the setting:
-- Go to Authentication → Settings in Supabase dashboard
```

## For Development Database

1. Go to: https://gsfkjwmdwhptakgcbuxe.supabase.co (dev database)
2. Authentication → Settings → Email
3. Disable "Enable email confirmations"

## For Production Database

1. Go to: https://cnlnrlzhhbrtehpkttqv.supabase.co (production database)
2. Authentication → Settings → Email
3. Disable "Enable email confirmations"

## Benefits

- ✅ Users can sign in immediately after sign-up
- ✅ Better mobile app UX (no need to check email)
- ✅ No confusion about email confirmation
- ✅ Faster onboarding

## Note

If you want to keep email confirmation for security, you can:
- Keep it enabled but improve the UI to show a better message
- Add a "Resend confirmation email" button
- Show a screen explaining they need to check their email

But for most mobile apps, auto-confirmation is the better choice.



