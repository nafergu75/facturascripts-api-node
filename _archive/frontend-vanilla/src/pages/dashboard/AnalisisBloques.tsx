import React, { memo, useState } from 'react';
import { ApiClient } from '../../app/apiClient';
import { FilaAnalisis, getAnalisisIngresos, getDetalleGastos } from '../../app/dashboardApi';
import { useCarga } from '../../app/hooks';
import { ErrorBanner, EstadoVacio, eur, SkeletonBloque, td, th } from '../../app/ui';
import { BarrasPorcentaje } from '../../app/charts';

/**
 * Bloques de analisis con la misma anatomia (filtros año+rango de meses,
 * barras por porcentaje y tabla): "Analisis de ingresos" (por cliente) y
 * "Detalle de gastos" (por proveedor; categoria de gasto = TODO backend).
 */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

interface BloqueProps {
  api: ApiClient;
  companyId: string;
  titulo: string;
  etiquetaEntidad: string; // 'Cliente' | 'Proveedor'
  cargar: (api: ApiClient, year: number, mesDesde: number, mesHasta: number) => Promise<FilaAnalisis[]>;
}

function BloqueAnalisis(props: BloqueProps): React.ReactElement {
  const anoActual = new Date().getFullYear();
  const [year, setYear] = useState(anoActual);
  const [mesDesde, setMesDesde] = useState(1);
  const [mesHasta, setMesHasta] = useState(12);

  const { datos, cargando, error } = useCarga<FilaAnalisis[]>(
    () => props.cargar(props.api, year, mesDesde, mesHasta),
    [props.api, props.companyId, year, mesDesde, mesHasta],
  );

  const select: React.CSSProperties = { padding: 4, borderRadius: 6, border: '1px solid #ccd', fontSize: 12 };
  const total = (datos ?? []).reduce((a, f) => a + f.importe, 0);

  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 16, flex: 1, minWidth: 380 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>{props.titulo}</b>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <select style={select} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[anoActual - 2, anoActual - 1, anoActual].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select style={select} value={mesDesde} onChange={(e) => setMesDesde(Number(e.target.value))}>
            {MESES.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <select style={select} value={mesHasta} onChange={(e) => setMesHasta(Number(e.target.value))}>
            {MESES.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        </div>
      </div>
      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <SkeletonBloque alto={220} />
      ) : !datos || datos.length === 0 ? (
        <EstadoVacio mensaje="No hay datos para el periodo seleccionado." />
      ) : (
        <>
          <BarrasPorcentaje filas={datos.slice(0, 8)} />
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
            <thead>
              <tr>
                <th style={th}>{props.etiquetaEntidad}</th>
                <th style={{ ...th, textAlign: 'right' }}>Importe</th>
                <th style={{ ...th, textAlign: 'right' }}>% del total</th>
              </tr>
            </thead>
            <tbody>
              {datos.map((f) => (
                <tr key={f.nombre}>
                  <td style={td}>{f.nombre}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{eur(f.importe)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{f.porcentaje.toFixed(1)}%</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, fontWeight: 800 }}>TOTAL</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 800 }}>{eur(total)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 800 }}>100%</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export const AnalisisIngresos = memo(function AnalisisIngresos(props: { api: ApiClient; companyId: string }): React.ReactElement {
  return <BloqueAnalisis {...props} titulo="Analisis de ingresos" etiquetaEntidad="Cliente" cargar={getAnalisisIngresos} />;
});

export const DetalleGastos = memo(function DetalleGastos(props: { api: ApiClient; companyId: string }): React.ReactElement {
  return <BloqueAnalisis {...props} titulo="Detalle de gastos" etiquetaEntidad="Proveedor / categoria" cargar={getDetalleGastos} />;
});
