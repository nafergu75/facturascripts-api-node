import { useCallback, useEffect, useState } from 'react';

/** Hook de carga: ejecuta fn, expone datos/cargando/error y recargar(). */
export function useCarga<T>(fn: () => Promise<T>, deps: unknown[]): {
  datos: T | null;
  cargando: boolean;
  error: string | null;
  recargar: () => Promise<void>;
  setError: (e: string | null) => void;
} {
  const [datos, setDatos] = useState<T | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setDatos(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando datos');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { datos, cargando, error, recargar, setError };
}
