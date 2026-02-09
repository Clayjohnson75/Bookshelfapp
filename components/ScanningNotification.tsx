import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Platform, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getEnvVar } from '../lib/getEnvVar';
import { useScanning } from '../contexts/ScanningContext';

interface ScanningNotificationProps {
  onCancelComplete?: () => void; // Callback to clear queue and other state in parent
}

export const ScanningNotification: React.FC<ScanningNotificationProps> = ({ onCancelComplete: propOnCancelComplete }) => {
  const { scanProgress, setScanProgress, onCancelComplete: contextOnCancelComplete } = useScanning();
  // Use prop callback if provided, otherwise use context callback
  const onCancelComplete = propOnCancelComplete || contextOnCancelComplete;
  const insets = useSafeAreaInsets();
  const [serverProgress, setServerProgress] = useState<number | null>(null);
  const [serverStage, setServerStage] = useState<string | null>(null);
  
  // Tab bar height: ~49px on iOS, ~56px on Android, plus safe area bottom
  const tabBarHeight = Platform.OS === 'ios' ? 49 : 56;
  const bottomPosition = insets.bottom + tabBarHeight;
  
  
  // Poll for progress updates from server
  // CRITICAL: Track by batchId/jobIds, not userId - this ensures progress persists even if auth temporarily fails
  useEffect(() => {
    if (!scanProgress || !(scanProgress as any).jobIds || (scanProgress as any).jobIds.length === 0) {
      setServerProgress(null);
      setServerStage(null);
      return;
    }
    
    const jobIds = (scanProgress as any).jobIds || [];
    const batchId = (scanProgress as any).batchId;
    
    if (__DEV__ && batchId) {
      console.log(`[ScanningNotification] batchId: ${batchId}, jobIds: ${jobIds.length}`);
    }
    const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
    
    // Find the first active job (pending or processing) to poll
    const findActiveJob = async (): Promise<string | null> => {
      // Check each job in order to find the first active one
      for (const jobId of jobIds) {
        try {
          const statusUrl = `${baseUrl}/api/scan-status?jobId=${jobId}`;
          const response = await fetch(statusUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'Pragma': 'no-cache'
            },
            cache: 'no-store'
          });
          
          if (response.ok) {
            const data = await response.json();
            // If this job is still pending or processing, use it
            if (data.status === 'pending' || data.status === 'processing') {
              return jobId;
            }
          }
        } catch (error) {
          console.error(`Error checking job ${jobId} status:`, error);
          // Continue to next job
        }
      }
      return null; // No active jobs found
    };
    
    // Track current active job being polled
    let currentActiveJobId: string | null = null;
    let intervalId: NodeJS.Timeout | null = null;
    
    const pollProgress = async () => {
      // If we don't have an active job, find one
      if (!currentActiveJobId) {
        currentActiveJobId = await findActiveJob();
        if (!currentActiveJobId) {
          // No active jobs found, clear progress
          setServerProgress(null);
          setServerStage(null);
          return;
        }
      }
      
      try {
        const statusUrl = `${baseUrl}/api/scan-status?jobId=${currentActiveJobId}`;
        const response = await fetch(statusUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
          },
          cache: 'no-store'
        });
        
        if (response.ok) {
          const data = await response.json();
          
          // If this job completed/failed, find the next active job
          if (data.status === 'canceled' || data.status === 'completed' || data.status === 'failed') {
            currentActiveJobId = null; // Reset to find next active job
            const nextActiveJob = await findActiveJob();
            if (!nextActiveJob) {
              // No more active jobs
              setServerProgress(null);
              setServerStage(null);
              return;
            }
            currentActiveJobId = nextActiveJob;
            // Poll the new active job immediately
            pollProgress();
            return;
          }
          
          // Update progress if available
          if (data.progress !== null && data.progress !== undefined) {
            setServerProgress(data.progress);
            setServerStage(data.stage || null);
          } else {
            // Job exists but no progress yet (might be queued)
            setServerProgress(null);
            setServerStage(data.stage || null);
          }
        }
      } catch (error) {
        console.error('Error polling progress:', error);
      }
    };
    
    // Poll immediately, then every 3 seconds (matches ScansTab poll interval, reduces log noise)
    const POLL_INTERVAL_MS = 3000;
    pollProgress();
    intervalId = setInterval(pollProgress, POLL_INTERVAL_MS);
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [scanProgress, (scanProgress as any)?.jobIds]);
  
  // Handle cancel with confirmation
  const handleCancel = () => {
    Alert.alert(
      'Cancel Scan',
      'Are you sure you want to cancel this scan? This action cannot be undone.',
      [
        {
          text: 'No',
          style: 'cancel'
        },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            const jobIds = (scanProgress as any)?.jobIds;
            if (!jobIds || jobIds.length === 0) {
              return;
            }
            
            // OPTIMISTIC UPDATE: Clear UI state immediately (don't wait for backend)
            console.log(`🚫 [CANCEL] Clearing UI state immediately for ${jobIds.length} job(s)`);
            setScanProgress(null);
            
            // Call parent callback to clear queue and other state
            if (onCancelComplete) {
              onCancelComplete();
            }
            
            // Cancel all active jobs in background (fire-and-forget)
            const baseUrl = getEnvVar('EXPO_PUBLIC_API_BASE_URL') || 'https://www.bookshelfscan.app';
            jobIds.forEach(async (jobId: string) => {
              try {
                const response = await fetch(`${baseUrl}/api/scan-cancel`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ jobId })
                });
                
                if (response.ok) {
                  console.log(`✅ [CANCEL] Canceled job: ${jobId}`);
                } else {
                  console.error(`❌ [CANCEL] Failed to cancel job ${jobId}:`, response.status);
                }
              } catch (error) {
                console.error(`❌ [CANCEL] Error canceling job ${jobId}:`, error);
              }
            });
          }
        }
      ]
    );
  };

  // Early return after all hooks
  if (!scanProgress) {
    return null;
  }

  // Extract values directly from scanProgress, with explicit fallback
  const totalScans = (scanProgress as any)?.totalScans ?? 0;
  const completedScans = (scanProgress as any)?.completedScans ?? 0;
  const failedScans = (scanProgress as any)?.failedScans ?? 0;
  const canceledScans = (scanProgress as any)?.canceledScans ?? 0; // User canceled – not failed
  const currentScanId = (scanProgress as any)?.currentScanId;
  
  // Calculate ACTIVE scans (only pending/processing; completed, failed, and canceled all count as "done")
  const doneCount = completedScans + failedScans + canceledScans;
  const activeScans = totalScans - doneCount;
  const isCompleted = totalScans > 0 && doneCount >= totalScans && !currentScanId;
  

  if (isCompleted) {
    // Hide after completion
    return null;
  }

  // Use server progress if available, otherwise show active scans count
  const displayProgress = serverProgress !== null ? serverProgress : null;
  const displayStage = serverStage || null;

  return (
    <View style={[styles.container, { bottom: bottomPosition }]}>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.textContainer}>
            <Text style={styles.title}>
              {(() => {
                // Only show ACTIVE scans (not completed ones)
                // activeScans = totalScans - (completedScans + failedScans)
                const displayText = activeScans > 0 
                  ? `Scanning ${activeScans} ${activeScans === 1 ? 'image' : 'images'}`
                  : 'Scanning...';
                return displayText;
              })()}
            </Text>
            {displayProgress !== null && (
              <Text style={styles.progressText}>
                {displayProgress}%{displayStage ? ` • ${displayStage}` : ''}
              </Text>
            )}
            {activeScans > 0 && displayProgress === null && (
              <Text style={styles.eta}>Approx 1 minute per image</Text>
            )}
            <Text style={styles.subtitle}>
              {activeScans > 0
                ? `Processing scan ${completedScans + failedScans + 1}/${totalScans}`
                : totalScans > 0
                  ? `${completedScans + failedScans}/${totalScans} completed`
                  : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleCancel}
            activeOpacity={0.7}
          >
            <Ionicons name="close" size={20} color="#ffffff" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 2,
    borderTopColor: '#007AFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
    zIndex: 10000,
  },
  content: {
    width: '100%',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  textContainer: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  progressText: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '600',
    marginBottom: 4,
  },
  eta: {
    fontSize: 12,
    color: '#cbd5e0',
    marginBottom: 6,
    fontWeight: '500',
  },
  subtitle: {
    fontSize: 12,
    color: '#cbd5e0',
    fontWeight: '400',
  },
  cancelButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: -2, // Align with title
  },
});

