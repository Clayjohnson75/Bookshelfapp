import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '../lib/supabaseServerCookies';
import { checkRateLimit, sendRateLimitResponse } from '../lib/rateLimit';
import { getCredentialedOrigin } from '../lib/corsCredentialed';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Cache-Control', 'no-store');
 res.setHeader('Access-Control-Allow-Origin', getCredentialedOrigin(req));
 res.setHeader('Access-Control-Allow-Credentials', 'true');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

 if (req.method === 'OPTIONS') {
 return res.status(200).end();
 }

 if (req.method !== 'POST') {
 return res.status(405).json({ error: 'Method not allowed' });
 }

 const rateLimitResult = await checkRateLimit(req, 'auth');
 if (!rateLimitResult.success) {
 sendRateLimitResponse(res, rateLimitResult);
 return;
 }

 try {
 const { emailOrUsername, password, username } = req.body;

 if (!emailOrUsername || !password) {
 return res.status(400).json({ 
 error: 'Missing credentials',
 message: 'Please provide both email/username and password.'
 });
 }

 // Get Supabase credentials
 const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
 const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

 if (!supabaseUrl || !supabaseAnonKey) {
 console.error('[API] Missing Supabase credentials');
 return res.status(500).json({ 
 error: 'Server configuration error',
 message: 'Server is not properly configured.'
 });
 }

 // Create Supabase client (no cookies for sign-in call)
 const supabase = createClient(supabaseUrl, supabaseAnonKey);

 // Handle username lookup if needed
 let email = emailOrUsername;
 if (!emailOrUsername.includes('@')) {
 // It's a username, need to look up the email
 // Use service role key to access auth.users
 const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!supabaseServiceKey) {
 return res.status(500).json({ 
 error: 'Server configuration error',
 message: 'Server is not properly configured.'
 });
 }

 const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
 
 // Get profile to find user ID
 const { data: profile, error: profileError } = await supabaseAdmin
 .from('profiles')
 .select('id')
 .eq('username', emailOrUsername.toLowerCase())
 .single();

 if (profileError || !profile) {
 return res.status(401).json({ 
 error: 'Invalid credentials',
 message: 'Invalid username or password.'
 });
 }

 // Get the user's email from auth.users using admin client
 const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(profile.id);
 if (authError || !authUser?.user?.email) {
 return res.status(401).json({ 
 error: 'Invalid credentials',
 message: 'Could not find email for this username.'
 });
 }
 email = authUser.user.email;
 }

 // Sign in with email and password
 const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
 email: email,
 password: password,
 });

 const hasSession = !!(signInData?.session);
 console.log('[web-signin] did signIn return a session?', hasSession);

 if (signInError || !signInData?.user) {
 return res.status(401).json({ 
 error: 'Invalid credentials',
 message: signInError?.message || 'Invalid email/username or password.'
 });
 }

 // If username was provided, verify it matches
 if (username) {
 const { data: userProfile } = await supabase
 .from('profiles')
 .select('username')
 .eq('id', signInData.user.id)
 .single();

 if (userProfile?.username?.toLowerCase() !== username.toLowerCase()) {
 console.log('[SIGNOUT_CALLED] supabase.auth.signOut() (web-signin account mismatch)', new Error().stack);
 await supabase.auth.signOut();
 return res.status(403).json({ 
 error: 'Account mismatch',
 message: 'This account does not match this profile.'
 });
 }
 }

 // Path B (fallback): server must call setSession(signInData.session) on the SSR server client
 // so the response emits Set-Cookie: sb-... (client must use credentials: "include" and not
 // follow a cross-origin redirect that drops cookies).
 try {
 const serverSupabase = createSupabaseServerClient(req, res);
 await serverSupabase.auth.setSession(signInData.session);
 console.log('[web-signin] did we call setSession(session)?', true);
 const setCookieHeader = res.getHeader('Set-Cookie');
 const setCookieArray = Array.isArray(setCookieHeader)
 ? (setCookieHeader as string[])
 : setCookieHeader
 ? [String(setCookieHeader)]
 : [];
 const cookieNames = setCookieArray
 .map((c) => (c.split('=')[0] || '').trim())
 .filter(Boolean);
 console.log('[web-signin] what cookies are being set? (names only):', cookieNames.length ? cookieNames.join(', ') : '(none)');
 const hasSbSetCookie = cookieNames.some((n) => n.startsWith('sb-'));
 console.log('[web-signin] response contains Set-Cookie: sb-...?', hasSbSetCookie);
 res.setHeader('X-Debug-Set-Cookie-Count', String(setCookieArray.length));
 res.setHeader('X-Debug-Signin', 'session_set');
 res.setHeader('X-Debug-WebSignin', 'setSession-called');
 } catch (cookieErr) {
 console.warn('[web-signin] did we call setSession(session)? false error:', cookieErr);
 console.warn('[API] web-signin: could not set session cookies', cookieErr);
 }

 return res.status(200).json({
 ok: true,
 didSetSession: true,
 success: true,
 message: 'Signed in successfully',
 user: {
 id: signInData.user.id,
 email: signInData.user.email,
 },
 session: signInData.session,
 });

 } catch (error: any) {
 console.error('[API] Error in web-signin:', error);
 return res.status(500).json({ 
 error: 'Internal server error',
 message: error?.message || 'An error occurred. Please try again later.'
 });
 }
}

