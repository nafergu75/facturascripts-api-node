import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ImpuestosApiClient } from './ImpuestosApiClient';
import { ModeloImpuestoList } from './ModeloImpuestoList';
import { ExportIngresosGastosPanel } from './ExportIngresosGastosPanel';
import { ModeloImpuestoResumen, TabImpuestos } from './types';

/**
 * Pantalla principal de Impuestos: pestanas Todos (vigentes+expirados) /
 * Omitidos / Presentados + panel de exportacion de Excel de ingresos y gastos.
 *
 * TODO integracion con el router del proyecto: aqui la navegacion al detalle se
 * delega en la prop onAbrirDetalle (en una app con react-router seria un
 * navigate(`/impuestos/${m.id}`)).
 */
export interface ImpuestosPageProps {
  companyId: string;
  token: string;
  apiBaseUrl?: string;
  ejercicioInicial?: number;
  onAbrirDetalle: (modelo: ModeloImpuestoResumen) => void;
}

const TABS: Array<{ id: TabImpuestos; etiqueta: string }> = [
  { id: 'activos', etiqueta: 'Todos' },
  { id: 'omitidos', etiqueta: 'Omitidos' },
  { id: 'presentados', etiqueta: 'Presentados' },
];

export function ImpuestosPage(props: ImpuestosPageProps): React.ReactElement {
  const { companyId, token, apiBaseUrl = '', ejercicioInicial = new Date().getFullYear(), onAbrirDetalle } = props;
  const api = useMemo(() => new ImpuestosApiClient(apiBaseUrl, companyId, token), [apiBaseUrl, companyId, token]);

  const [tab, setTab] = useState<TabImpuestos>('activos');
  const [ejercicio, setEjercicio] = useState(ejercicioInicial);
  const [modelos, setModelos] = useState<ModeloImpuestoResumen[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setModelos(await api.listarModelos(ejercicio, tab));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando modelos');
    } finally {
      setCargando(false);
    }
  }, [api, ejercicio, tab]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** Ejecuta una accion de cambio de estado y refresca la lista. */
  const accion = (fn: (id: string) => Promise<unknown>) => async (m: ModeloImpuestoResumen) => {
    try {
      await fn(m.id);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  };

  const tabBtn = (activa: boolean): React.CSSProperties => ({
    padding: '8px 18px',
    border: 'none',
    borderBottom: activa ? '3px solid #1a56b0' : '3px solid transparent',
    background: 'none',
    fontWeight: activa ? 700 : 400,
    cursor: 'pointer',
  });

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 22 }}>Impuestos</h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ borderBottom: '1px solid #ddd', flex: 1 }}>
          {TABS.map((t) => (
            <button key={t.id} style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>
              {t.etiqueta}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 13 }}>
          Ejercicio{' '}
          <input
            type="number"
            value={ejercicio}
            onChange={(e) => setEjercicio(Number(e.target.value))}
            style={{ width: 80, padding: 4 }}
          />
        </label>
      </div>

      {error && <div style={{ background: '#ffe0e0', color: '#a00', padding: 8, borderRadius: 6, marginBottom: 10 }}>{error}</div>}
      {cargando ? (
        <p>Cargando…</p>
      ) : (
        <ModeloImpuestoList
          modelos={modelos}
          tab={tab}
          onEditar={onAbrirDetalle}
          onOmitir={accion((id) => api.omitir(id))}
          onRecuperar={accion((id) => api.recuperar(id))}
          onListoParaPresentar={accion((id) => api.listoParaPresentar(id))}
          onNoPresentado={accion((id) => api.noPresentado(id))}
          onDescargarTxt={(m) => void api.descargarTxt(m.id).catch((e) => setError(String(e)))}
          onDescargarPdf={(m) => void api.descargarPdf(m.id).catch((e) => setError(String(e)))}
        />
      )}

      <ExportIngresosGastosPanel api={api} ejercicioInicial={ejercicio} />
    </div>
  );
}
