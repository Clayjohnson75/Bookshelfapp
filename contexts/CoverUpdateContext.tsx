import React, { createContext, useContext, useRef, useCallback, ReactNode } from 'react';

/** Tracks when we're in a "cover update" flow (add/set cover for one book). Scan pipeline must never create batch or scan state when this is true. */
interface CoverUpdateContextType {
  /** Set to true when starting cover update (take/upload photo or pick from search); false when done. */
  setCoverUpdateActive: (active: boolean) => void;
  /** Returns true if a cover update is in progress. Scan pipeline checks this before BATCH_START. */
  isCoverUpdateActive: () => boolean;
}

const CoverUpdateContext = createContext<CoverUpdateContextType | undefined>(undefined);

export const useCoverUpdate = () => {
  const ctx = useContext(CoverUpdateContext);
  if (!ctx) return { setCoverUpdateActive: () => {}, isCoverUpdateActive: () => false };
  return ctx;
};

export const CoverUpdateProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const activeRef = useRef(false);
  const setCoverUpdateActive = useCallback((active: boolean) => {
    activeRef.current = active;
  }, []);
  const isCoverUpdateActive = useCallback(() => activeRef.current, []);
  return (
    <CoverUpdateContext.Provider value={{ setCoverUpdateActive, isCoverUpdateActive }}>
      {children}
    </CoverUpdateContext.Provider>
  );
};
