import React, { createContext, useContext, useState, ReactNode } from 'react';

interface BottomDockContextType {
  /** Bare content for the selection bar (no positioning wrapper — the dock handles all layout). */
  selectionBarContent: ReactNode | null;
  setSelectionBarContent: (content: ReactNode | null) => void;
  /** From useBottomTabBarHeight() — set by a tab screen so BottomDock can use it (avoids double-counting safe area). */
  tabBarHeight: number;
  setTabBarHeight: (h: number) => void;
}

const BottomDockContext = createContext<BottomDockContextType>({
  selectionBarContent: null,
  setSelectionBarContent: () => {},
  tabBarHeight: 0,
  setTabBarHeight: () => {},
});

export const BottomDockProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [selectionBarContent, setSelectionBarContent] = useState<ReactNode | null>(null);
  const [tabBarHeight, setTabBarHeight] = useState(0);
  return (
    <BottomDockContext.Provider value={{ selectionBarContent, setSelectionBarContent, tabBarHeight, setTabBarHeight }}>
      {children}
    </BottomDockContext.Provider>
  );
};

export const useBottomDock = () => useContext(BottomDockContext);
