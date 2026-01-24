import React, { createContext, useContext, useState, ReactNode } from 'react';

interface CameraContextType {
  isCameraActive: boolean;
  setIsCameraActive: (active: boolean) => void;
}

const CameraContext = createContext<CameraContextType | undefined>(undefined);

export const useCamera = () => {
  const context = useContext(CameraContext);
  if (!context) {
    throw new Error('useCamera must be used within a CameraProvider');
  }
  return context;
};

interface CameraProviderProps {
  children: ReactNode;
}

export const CameraProvider: React.FC<CameraProviderProps> = ({ children }) => {
  const [isCameraActive, setIsCameraActive] = useState(false);

  return (
    <CameraContext.Provider value={{ isCameraActive, setIsCameraActive }}>
      {children}
    </CameraContext.Provider>
  );
};

