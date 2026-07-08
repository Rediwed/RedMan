import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getSettings } from '../api/index.js';

const SettingsContext = createContext({});

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState({});

  const refresh = useCallback(() => {
    getSettings().then(setSettings).catch(() => {});
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
