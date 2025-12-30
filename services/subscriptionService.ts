/**
 * Subscription Service
 * 
 * Handles subscription management, scan limits, and upgrade prompts
 */

import { supabase } from '../lib/supabaseClient';

export interface ScanUsage {
  subscriptionTier: 'free' | 'pro' | 'owner';
  monthlyScans: number;
  monthlyLimit: number | null; // null for pro/owner (unlimited)
  scansRemaining: number | null; // null for pro/owner (unlimited)
  resetAt: Date;
}

/**
 * Check if user can perform a scan
 */
export async function canUserScan(userId: string): Promise<boolean> {
  if (!supabase) {
    console.warn('Supabase not available, allowing scan');
    return true;
  }

  try {
    const { data, error } = await supabase.rpc('can_user_scan', {
      user_uuid: userId,
    });

    if (error) {
      console.error('Error checking scan permission:', error);
      // Allow scan on error to avoid blocking users
      return true;
    }

    return data === true;
  } catch (error) {
    console.error('Error checking scan permission:', error);
    return true; // Allow scan on error
  }
}

/**
 * Get user's scan usage information
 */
export async function getUserScanUsage(userId: string): Promise<ScanUsage | null> {
  if (!supabase) {
    return null;
  }

  try {
    const { data, error } = await supabase.rpc('get_user_scan_usage', {
      user_uuid: userId,
    });

    if (error) {
      const errorMessage = error?.message || error?.code || JSON.stringify(error) || String(error);
      console.error('Error getting scan usage:', errorMessage);
      return null;
    }

    if (!data || data.length === 0) {
      // Return default for new users
      return {
        subscriptionTier: 'free',
        monthlyScans: 0,
        monthlyLimit: 5,
        scansRemaining: 5,
        resetAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
      };
    }

    const usage = data[0];
    return {
      subscriptionTier: usage.subscription_tier || 'free',
      monthlyScans: usage.monthly_scans || 0,
      monthlyLimit: usage.monthly_limit,
      scansRemaining: usage.scans_remaining,
      resetAt: new Date(usage.reset_at),
    };
  } catch (error: any) {
    console.error('Error getting scan usage:', error?.message || error);
    return null;
  }
}

/**
 * Increment user's scan count (client-side fallback)
 * This ensures the count updates even if the API uses a different database
 */
export async function incrementScanCount(userId: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }

  try {
    const { error } = await supabase.rpc('increment_user_scan_count', {
      user_uuid: userId,
    });

    if (error) {
      console.error('Error incrementing scan count:', error);
      return false;
    }

    return true;
  } catch (error: any) {
    console.error('Error incrementing scan count:', error?.message || error);
    return false;
  }
}

/**
 * Get user's subscription tier
 */
export async function getUserSubscriptionTier(userId: string): Promise<'free' | 'pro' | 'owner'> {
  if (!supabase) {
    return 'free';
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return 'free';
    }

    return (data.subscription_tier as 'free' | 'pro' | 'owner') || 'free';
  } catch (error) {
    console.error('Error getting subscription tier:', error);
    return 'free';
  }
}

/**
 * Format reset date for display
 */
export function formatResetDate(date: Date): string {
  const now = new Date();
  const daysUntilReset = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  if (daysUntilReset <= 0) {
    return 'Resets today';
  } else if (daysUntilReset === 1) {
    return 'Resets tomorrow';
  } else {
    return `Resets in ${daysUntilReset} days`;
  }
}

