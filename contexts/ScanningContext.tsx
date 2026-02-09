import React, { createContext, useContext, useState, ReactNode } from 'react';

interface ScanProgress {
  currentScanId: string | null;
  currentStep: number;
  totalSteps: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
  canceledScans?: number; // User canceled – not a failure, but counts as "done" for hiding bar
  startTimestamp?: number;
  batchId?: string; // Track batchId for robustness (persists even if auth fails)
  jobIds?: string[]; // Track jobIds for cancel functionality and progress tracking
  progress?: number; // Server progress percentage (0-100)
  stage?: string; // Current stage from server
}

interface ScanningContextType {
  scanProgress: ScanProgress | null;
  setScanProgress: (progress: ScanProgress | null) => void;
  updateProgress: (update: Partial<ScanProgress>) => void;
  onCancelComplete?: () => void; // Callback to clear queue and other state when cancel is triggered
  setOnCancelComplete?: (callback: (() => void) | undefined) => void;
}

const ScanningContext = createContext<ScanningContextType | undefined>(undefined);

export const useScanning = () => {
  const context = useContext(ScanningContext);
  if (!context) {
    throw new Error('useScanning must be used within a ScanningProvider');
  }
  return context;
};

interface ScanningProviderProps {
  children: ReactNode;
}

export const ScanningProvider: React.FC<ScanningProviderProps> = ({ children }) => {
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [onCancelComplete, setOnCancelComplete] = useState<(() => void) | undefined>(undefined);

  const updateProgress = (update: Partial<ScanProgress>) => {
    setScanProgress(prev => {
      const base = prev || ({} as ScanProgress);
      const start = base.startTimestamp || update.startTimestamp || Date.now();
      return { ...base, ...update, startTimestamp: start } as ScanProgress;
    });
  };

  return (
    <ScanningContext.Provider value={{ 
      scanProgress, 
      setScanProgress, 
      updateProgress,
      onCancelComplete,
      setOnCancelComplete
    }}>
      {children}
    </ScanningContext.Provider>
  );
};

