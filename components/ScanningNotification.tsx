import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useScanning } from '../contexts/ScanningContext';

export const ScanningNotification: React.FC = () => {
  const { scanProgress } = useScanning();

  if (!scanProgress) {
    return null;
  }

  // Calculate overall percentage
  const calculatePercentage = (): number => {
    const { totalScans, completedScans, failedScans, currentStep, totalSteps } = scanProgress;
    
    if (totalScans === 0) return 0;
    
    // Calculate progress from completed scans
    const completedProgress = completedScans + failedScans;
    
    // Calculate progress from current scan (if processing)
    let currentScanProgress = 0;
    if (scanProgress.currentScanId && currentStep > 0 && totalSteps > 0) {
      currentScanProgress = Math.min(currentStep / totalSteps, 1); // Ensure it doesn't exceed 1
    }
    
    // Overall progress = (completed + current scan progress) / total
    const overallProgress = (completedProgress + currentScanProgress) / totalScans;
    
    return Math.min(Math.max(overallProgress * 100, 0), 100);
  };

  const percentage = calculatePercentage();
  const { totalScans, completedScans, failedScans, currentScanId, startTimestamp } = scanProgress as any;
  const isCompleted = (completedScans + failedScans) >= totalScans && !currentScanId;

  // Estimate remaining time (ETA) from startTimestamp and percentage
  const renderEta = () => {
    if (!startTimestamp || percentage <= 0 || percentage >= 100) return null;
    const elapsedMs = Date.now() - startTimestamp;
    const remainingMs = elapsedMs * (100 / percentage - 1);
    const secs = Math.max(1, Math.round(remainingMs / 1000));
    const label = secs > 60 ? `${Math.ceil(secs / 60)} min` : `${secs} sec`;
    return <Text style={styles.eta}>{`~ ${label} remaining`}</Text>;
  };

  if (isCompleted) {
    // Hide after completion
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.progressBarContainer}>
          <View style={[styles.progressBarFill, { width: `${percentage}%` }]} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.title}>Scanning...</Text>
        </View>
        {renderEta()}
        <Text style={styles.subtitle}>
          {currentScanId && totalScans > 0
            ? `Processing scan ${completedScans + failedScans + 1} of ${totalScans}`
            : totalScans > 0
            ? `${completedScans + failedScans} of ${totalScans} completed`
            : 'Preparing to scan...'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 90, // Above tab bar with safe area (tab bar ~49px + safe area ~36px + padding)
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
  progressBarContainer: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 3,
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

