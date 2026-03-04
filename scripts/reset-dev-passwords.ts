/**
 * Script to reset passwords for dev server accounts
 * 
 * Usage:
 * 1. Set the emails and new passwords in the accounts array below
 * 2. Make sure SUPABASE_SERVICE_ROLE_KEY is set in your environment
 * 3. Run: npx ts-node scripts/reset-dev-passwords.ts
 * 
 * Or use Node.js:
 * node -r ts-node/register scripts/reset-dev-passwords.ts
 */

import { createClient } from '@supabase/supabase-js';

// Dev Supabase credentials
const SUPABASE_URL = 'https://gsfkjwmdwhptakgcbuxe.supabase.co';
// SECURITY: Use only SUPABASE_SERVICE_ROLE_KEY (never EXPO_PUBLIC_* — service role must not be in client env).
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  const msg =
    'SUPABASE_SERVICE_ROLE_KEY is required. Never use EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY (service role must not reach the client).';
  console.error('\n[FATAL]', msg);
  console.error('Set it in .env or: export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here\n');
  process.exit(1);
}

// Create admin client
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
 auth: {
 autoRefreshToken: false,
 persistSession: false
 }
});

// Accounts to reset - UPDATE THESE WITH YOUR ACCOUNTS
const accounts = [
 {
 email: 'your-email@example.com', // Replace with your dev account email
 newPassword: 'NewPassword123!', // Set the new password you want
 },
 // Add more accounts as needed
 // {
 // email: 'another-email@example.com',
 // newPassword: 'AnotherPassword123!',
 // },
];

async function resetPassword(email: string, newPassword: string): Promise<boolean> {
 try {
 console.log(`\n Resetting password for: ${email}`);
 
 // Get the user by email
 const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();
 
 if (listError) {
 console.error(' Error listing users:', listError);
 return false;
 }
 
 type AuthUser = { id: string; email?: string };
const user = ((users?.users ?? []) as AuthUser[]).find(u => u.email === email);
 
 if (!user) {
 console.error(` User not found: ${email}`);
 return false;
 }
 
 // Update the user's password
 const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
 user.id,
 { password: newPassword }
 );
 
 if (error) {
 console.error(` Error updating password:`, error);
 return false;
 }
 
 console.log(` Password reset successfully for: ${email}`);
 console.log(` New password: ${newPassword}`);
 return true;
 } catch (error: any) {
 console.error(` Unexpected error:`, error);
 return false;
 }
}

async function main() {
 console.log(' Dev Server Password Reset Script');
 console.log('=====================================\n');
 
 if (accounts.length === 0 || accounts[0].email === 'your-email@example.com') {
 console.error(' Please update the accounts array in this script with your actual email addresses');
 process.exit(1);
 }
 
 let successCount = 0;
 let failCount = 0;
 
 for (const account of accounts) {
 const success = await resetPassword(account.email, account.newPassword);
 if (success) {
 successCount++;
 } else {
 failCount++;
 }
 }
 
 console.log('\n=====================================');
 console.log(` Successfully reset: ${successCount} account(s)`);
 if (failCount > 0) {
 console.log(` Failed: ${failCount} account(s)`);
 }
 console.log('\n You can now sign in with the new passwords!');
}

main().catch(console.error);

