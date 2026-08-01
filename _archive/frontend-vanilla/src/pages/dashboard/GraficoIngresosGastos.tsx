import React, { memo, useMemo, useState } from 'react';
import { ApiClient } from '../../app/apiClient';
import { getIngresosGastosPorMes, IngresosGastosMes } from '../../app/dashboardApi';
import { useCarga } from '../../app/hooks';
import { ErrorBanner, EstadoVacio, SkeletonBloque } from '../../app/ui';
import { BarrasMensuales, VERDE, ROJO } from '../../app/charts';

/** Barras comparativas ingresos (verde) vs gastos (rojo) por mes, con filtros. */
export interface GraficoIngresosGastosProps {
  api: ApiClient;
  companyId: string;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// memo: no se re-renderiza al cambiar el periodo del resumen superior (sus props
// api/companyId no cambian), solo cuando recarga sus propios datos.
export const GraficoIngresosGastos = memo(function GraficoIngresosGastos({ api, companyId }: GraficoIngresosGastosProps): React.ReactElement {
  const anoActual = new Date().getFullYear();
  const [year, setYear] = useState(anoActual);
  const [mesDesde, setMesDesde] = useState(1);
  const [mesHasta, setMesHasta] = useState(12);

  const { datos, cargando, error } = useCarga<IngresosGastosMes[]>(
    () => getIngresosGastosPorMes(api, year),
    [api, companyId, year],
  );

  // useMemo: acotar meses solo se recalcula si cambian datos o el rango.
  const visibles = useMemo(() => (datos ?? []).filter((m) => m.mes >= mesDesde && m.mes <= mesHasta), [datos, mesDesde, mesHasta]);
  const hayDatos = visibles.some((m) => m.ingresos > 0 || m.gastos > 0);
  const select: React.CSSProperties = { padding: 4, borderRadius: 6, border: '1px solid #ccd', fontSize: 12 };

  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Ingresos y gastos</b>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: VERDE }}>■</span> ingresos <span style={{ color: ROJO }}>■</span> gastos
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#445' }}>
            Año{' '}
            <select style={select} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[anoActual - 2, anoActual - 1, anoActual].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#445' }}>
            De{' '}
            <select style={select} value={mesDesde} onChange={(e) => setMesDesde(Number(e.target.value))}>
              {MESES.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#445' }}>
            a{' '}
            <select style={select} value={mesHasta} onChange={(e) => setMesHasta(Number(e.target.value))}>
              {MESES.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <SkeletonBloque alto={230} />
      ) : !hayDatos ? (
        <EstadoVacio mensaje={`No hay datos para ${year} en los meses seleccionados.`} />
      ) : (
        <BarrasMensuales datos={visibles} />
      )}
    </div>
  );
});
