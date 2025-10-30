import React, { createContext, useContext, useState, ReactNode } from 'react';

interface ScanProgress {
  currentScanId: string | null;
  currentStep: number;
  totalSteps: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
  startTimestamp?: number;
}

interface ScanningContextType {
  scanProgress: ScanProgress | null;
  setScanProgress: (progress: ScanProgress | null) => void;
  updateProgress: (update: Partial<ScanProgress>) => void;
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

  const updateProgress = (update: Partial<ScanProgress>) => {
    setScanProgress(prev => {
      const base = prev || ({} as ScanProgress);
      const start = base.startTimestamp || update.startTimestamp || Date.now();
      return { ...base, ...update, startTimestamp: start } as ScanProgress;
    });
  };

  return (
    <ScanningContext.Provider value={{ scanProgress, setScanProgress, updateProgress }}>
      {children}
    </ScanningContext.Provider>
  );
};

