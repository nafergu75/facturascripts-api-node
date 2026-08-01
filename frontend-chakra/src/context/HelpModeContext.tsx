/**
 * Contexto global del "modo ayuda": controla si los HelpTooltip se muestran en
 * toda la app. Se persiste en localStorage para recordar la preferencia entre
 * recargas. No tiene ningun efecto sobre llamadas a la API ni datos — es
 * puramente una preferencia de UI.
 */

import React, { createContext, useContext, useState } from 'react';

const STORAGE_KEY = 'help_mode_enabled';

export interface HelpModeContextValue {
  helpModeEnabled: boolean;
  setHelpModeEnabled: (value: boolean) => void;
}

const HelpModeContext = createContext<HelpModeContextValue | undefined>(undefined);

export function HelpModeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [helpModeEnabled, setHelpModeEnabledState] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY) === '1',
  );

  function setHelpModeEnabled(value: boolean): void {
    setHelpModeEnabledState(value);
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  }

  return (
    <HelpModeContext.Provider value={{ helpModeEnabled, setHelpModeEnabled }}>
      {children}
    </HelpModeContext.Provider>
  );
}

/** Falla rapido si se usa fuera de HelpModeProvider, en vez de degradar en silencio. */
export function useHelpMode(): HelpModeContextValue {
  const ctx = useContext(HelpModeContext);
  if (!ctx) throw new Error('useHelpMode debe usarse dentro de <HelpModeProvider>.');
  return ctx;
}
