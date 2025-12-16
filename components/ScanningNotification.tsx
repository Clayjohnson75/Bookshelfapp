import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScanning } from '../contexts/ScanningContext';

export const ScanningNotification: React.FC = () => {
  const { scanProgress } = useScanning();
  const insets = useSafeAreaInsets();
  
  // Tab bar height: ~49px on iOS, ~56px on Android, plus safe area bottom
  const tabBarHeight = Platform.OS === 'ios' ? 49 : 56;
  const bottomPosition = insets.bottom + tabBarHeight;

  // Debug logging - must be before any conditional returns
  React.useEffect(() => {
    if (scanProgress) {
      console.log('📊 ScanningNotification: scanProgress detected', scanProgress);
    } else {
      console.log('📊 ScanningNotification: No scanProgress');
    }
  }, [scanProgress]);

  // Early return after all hooks
  if (!scanProgress) {
    return null;
  }

  // Extract totalScans directly from scanProgress, with explicit fallback
  const totalScans = (scanProgress as any)?.totalScans ?? 0;
  const completedScans = (scanProgress as any)?.completedScans ?? 0;
  const failedScans = (scanProgress as any)?.failedScans ?? 0;
  const currentScanId = (scanProgress as any)?.currentScanId;
  const isCompleted = totalScans > 0 && (completedScans + failedScans) >= totalScans && !currentScanId;
  
  // Debug logging - show exactly what we're getting
  console.log('📊 ScanningNotification render:', {
    totalScans,
    completedScans,
    failedScans,
    currentScanId,
    'scanProgress?.totalScans': scanProgress?.totalScans,
    'typeof totalScans': typeof totalScans,
    'totalScans > 0': totalScans > 0,
    'Will show text': totalScans > 0 ? `Scanning ${totalScans} ${totalScans === 1 ? 'image' : 'images'}` : 'Scanning...',
    scanProgressKeys: Object.keys(scanProgress || {})
  });

  // Removed ETA calculation - no longer needed

  if (isCompleted) {
    // Hide after completion
    return null;
  }

  return (
    <View style={[styles.container, { bottom: bottomPosition }]}>
      <View style={styles.content}>
        <View style={styles.textContainer}>
          <Text style={styles.title}>
            {(() => {
              // Get totalScans directly from scanProgress to ensure we have latest value
              const actualTotalScans = (scanProgress as any)?.totalScans ?? 0;
              const displayText = actualTotalScans > 0 
                ? `Scanning ${actualTotalScans} ${actualTotalScans === 1 ? 'image' : 'images'}`
                : 'Scanning...';
              console.log('📊 Notification title render:', {
                totalScans,
                actualTotalScans,
                'actualTotalScans > 0': actualTotalScans > 0,
                displayText,
                'scanProgress?.totalScans': (scanProgress as any)?.totalScans,
                'scanProgress object': scanProgress
              });
              return displayText;
            })()}
          </Text>
        </View>
        {totalScans > 0 && (
          <Text style={styles.eta}>Approx 1 minute per image</Text>
        )}
        <Text style={styles.subtitle}>
          {totalScans > 0
            ? currentScanId 
              ? `Processing scan ${completedScans + failedScans + 1}/${totalScans}`
              : `${completedScans + failedScans}/${totalScans} completed`
            : ''}
        </Text>
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
  textContainer: {
    marginBottom: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: 0.3,
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
});

