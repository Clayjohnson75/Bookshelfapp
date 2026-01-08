import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Test environment variables
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    return res.status(200).json({
      status: 'ok',
      nodeVersion: process.version,
      hasSupabaseUrl: !!supabaseUrl,
      hasServiceKey: !!supabaseServiceKey,
      envKeys: Object.keys(process.env).filter(k => k.includes('SUPABASE')).slice(0, 5)
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      error: error?.message || String(error),
      stack: error?.stack
    });
  }
}

