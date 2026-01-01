# Update .env File with Development Supabase Credentials

## Your Development Supabase Credentials

- **URL**: `https://gsfkjwmdwhptakgcbuxe.supabase.co`
- **Anon Key**: `sb_publishable_SQXyEXtJbal30DdcqzX8gQ_VPuxA_XH`

## Update Your .env File

Open `.env` in your project root and add/update these lines:

```bash
# Development Supabase
EXPO_PUBLIC_SUPABASE_URL_DEV=https://gsfkjwmdwhptakgcbuxe.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV=sb_publishable_SQXyEXtJbal30DdcqzX8gQ_VPuxA_XH

# Keep production values as fallback
EXPO_PUBLIC_SUPABASE_URL=https://cnlnrlzhhbrtehpkttqv.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubG5ybHpoaGJydGVocGt0dHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NTI1MjEsImV4cCI6MjA3NzQyODUyMX0.G-XYS-ASfPAhx83ZdbdL87lp8Zy3RWz4A8QXKSJ_wh0
EXPO_PUBLIC_API_BASE_URL=https://bookshelfapp-five.vercel.app
```

## Next Steps

1. **Update .env file** with the values above
2. **Run migrations** on your dev Supabase database:
   - Go to https://gsfkjwmdwhptakgcbuxe.supabase.co
   - Open SQL Editor
   - Run all migration files (same as production)
3. **Create photos bucket** in dev Supabase Storage
4. **Restart Expo Go** to load new environment variables
5. **Test** - sign in and verify it's using dev database

## Verify It's Working

When you start Expo Go, check the console logs. You should see:
```
📋 Loaded env var: EXPO_PUBLIC_SUPABASE_URL_DEV
```

And when the app connects, it should use: `https://gsfkjwmdwhptakgcbuxe.supabase.co`



