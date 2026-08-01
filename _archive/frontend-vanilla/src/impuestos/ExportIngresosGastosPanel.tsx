import React, { useState } from 'react';
import { ImpuestosApiClient } from './ImpuestosApiClient';

/**
 * Panel de exportacion del Excel de ingresos y gastos (flujo de validacion del
 * tutorial): elegir ejercicio + periodo (año / trimestre / mes) -> descargar
 * .xlsx -> revisar -> corregir facturas -> volver a "Recalcular importes".
 */
export interface ExportIngresosGastosPanelProps {
  api: ImpuestosApiClient;
  ejercicioInicial?: number;
}

const PERIODOS: Array<{ valor: string; etiqueta: string }> = [
  { valor: '0A', etiqueta: 'Año completo' },
  { valor: 'Q1', etiqueta: '1er trimestre' },
  { valor: 'Q2', etiqueta: '2o trimestre' },
  { valor: 'Q3', etiqueta: '3er trimestre' },
  { valor: 'Q4', etiqueta: '4o trimestre' },
  ...Array.from({ length: 12 }, (_, i) => {
    const mes = String(i + 1).padStart(2, '0');
    return { valor: mes, etiqueta: `Mes ${mes}` };
  }),
];

export function ExportIngresosGastosPanel(props: ExportIngresosGastosPanelProps): React.ReactElement {
  const [ejercicio, setEjercicio] = useState(props.ejercicioInicial ?? new Date().getFullYear());
  const [periodo, setPeriodo] = useState('0A');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportar = async (): Promise<void> => {
    setOcupado(true);
    setError(null);
    try {
      await props.api.descargarExcelIngresosGastos(ejercicio, periodo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div style={{ marginTop: 24, padding: 12, border: '1px solid #ddd', borderRadius: 8, fontSize: 13 }}>
      <b>Validar datos antes de presentar</b>
      <p style={{ color: '#555', margin: '6px 0' }}>
        Exporta los ingresos y gastos del periodo, revisa que no falte ni sobre nada y corrige las facturas o tickets
        con errores. Despues vuelve al modelo y pulsa «Recalcular importes».
      </p>
      <label>
        Ejercicio{' '}
        <input type="number" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))} style={{ width: 80, padding: 4 }} />
      </label>{' '}
      <label>
        Periodo{' '}
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} style={{ padding: 4 }}>
          {PERIODOS.map((p) => (
            <option key={p.valor} value={p.valor}>
              {p.etiqueta}
            </option>
          ))}
        </select>
      </label>{' '}
      <button
        style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0f7a3d', color: '#fff', cursor: 'pointer' }}
        onClick={() => void exportar()}
        disabled={ocupado}
      >
        {ocupado ? 'Exportando…' : 'Exportar Excel'}
      </button>
      {error && <p style={{ color: '#a00' }}>{error}</p>}
    </div>
  );
}
