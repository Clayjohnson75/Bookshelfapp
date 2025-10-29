import React, { createContext, useContext, useState, ReactNode } from 'react';

interface ScanProgress {
  currentScanId: string | null;
  currentStep: number;
  totalSteps: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
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
      if (!prev) {
        return update as ScanProgress;
      }
      return { ...prev, ...update };
    });
  };

  return (
    <ScanningContext.Provider value={{ scanProgress, setScanProgress, updateProgress }}>
      {children}
    </ScanningContext.Provider>
  );
};

