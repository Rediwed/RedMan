import { getPublicSettings } from '../api/index.js';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const SettingsContext = createContext({});

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState({});

  const refresh = useCallback(() => {
    getPublicSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
