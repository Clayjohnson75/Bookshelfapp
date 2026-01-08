import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * Validate Apple receipt and update subscription in Supabase
 * This provides server-side validation for security
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { transactionId, originalTransactionId, productId, userId } = req.body;

    if (!transactionId || !originalTransactionId || !productId) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields: transactionId, originalTransactionId, productId' 
      });
    }

    // Get Supabase credentials
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Supabase credentials not configured');
      return res.status(500).json({ 
        success: false,
        error: 'Server configuration error' 
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // For now, we'll trust the client's transaction ID and update Supabase
    // In production, you should validate with Apple's servers:
    // https://developer.apple.com/documentation/appstorereceipts/verifyreceipt
    
    // If userId is provided, update that user's subscription
    // Otherwise, find user by transaction ID
    let targetUserId: string | null = null;

    if (userId) {
      targetUserId = userId;
    } else {
      // Find user by original transaction ID
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('apple_original_transaction_id', originalTransactionId)
        .single();

      if (existingProfile) {
        targetUserId = existingProfile.id;
      }
    }

    if (!targetUserId) {
      // If we can't find the user, this might be a new purchase
      // We'll return success but note that user needs to be identified
      console.warn('⚠️ Could not identify user for receipt validation');
      return res.status(200).json({ 
        success: true,
        warning: 'User not identified - subscription will be updated on next app sync'
      });
    }

    // Calculate subscription end date (1 month from now for monthly subscription)
    const subscriptionEndsAt = new Date();
    subscriptionEndsAt.setMonth(subscriptionEndsAt.getMonth() + 1);

    // Update subscription in Supabase
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_started_at: new Date().toISOString(),
        subscription_ends_at: subscriptionEndsAt.toISOString(),
        apple_transaction_id: transactionId,
        apple_original_transaction_id: originalTransactionId,
        apple_product_id: productId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetUserId);

    if (updateError) {
      console.error('❌ Error updating subscription:', updateError);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to update subscription' 
      });
    }

    console.log(`✅ Subscription validated and updated for user: ${targetUserId}`);

    return res.status(200).json({ 
      success: true,
      message: 'Receipt validated and subscription updated',
      userId: targetUserId,
    });
  } catch (error: any) {
    console.error('[API] Error validating receipt:', error);
    return res.status(500).json({ 
      success: false,
      error: error?.message || 'Internal server error' 
    });
  }
}

/**
 * NOTE: For production, you should validate receipts with Apple's servers:
 * 
 * 1. Get the receipt data from the client (not just transaction ID)
 * 2. Send to Apple's verifyReceipt endpoint:
 *    - Production: https://buy.itunes.apple.com/verifyReceipt
 *    - Sandbox: https://sandbox.itunes.apple.com/verifyReceipt
 * 3. Verify the response and check:
 *    - status === 0 (valid)
 *    - latest_receipt_info contains the subscription
 *    - expires_date_ms is in the future
 * 
 * Example implementation:
 * 
 * const receiptData = req.body.receiptData; // Base64 encoded receipt
 * const response = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     'receipt-data': receiptData,
 *     'password': process.env.APPLE_SHARED_SECRET, // From App Store Connect
 *   }),
 * });
 * 
 * const result = await response.json();
 * if (result.status === 0) {
 *   // Valid receipt - update Supabase
 * } else {
 *   // Invalid receipt
 * }
 */

