import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { Cargando, ErrorBanner, eur, td, TituloPagina } from '../app/ui';

/** Cuentas anuales: balance + PyG + EFE resumidos (datos de /cuentas-anuales/preview). */
export function CuentasAnualesPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear());
  const { datos, cargando, error } = useCarga(() => api.getCuentasAnuales(ejercicio), [api, sesion.companyId, ejercicio]);

  const num = (path: string[]): number => {
    let v: unknown = datos;
    for (const p of path) v = (v as Record<string, unknown> | undefined)?.[p];
    return Number(v ?? 0);
  };

  const bloque = (titulo: string, filas: Array<[string, number]>): React.ReactElement => (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', minWidth: 300, flex: 1 }}>
      <div style={{ padding: '10px 12px', fontWeight: 700, fontSize: 13, borderBottom: '1px solid #eef1f5' }}>{titulo}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {filas.map(([etiqueta, valor]) => (
            <tr key={etiqueta}>
              <td style={td}>{etiqueta}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{eur(valor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <TituloPagina
        acciones={
          <label style={{ fontSize: 13, color: '#445' }}>
            Ejercicio <input type="number" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))} style={{ width: 80, padding: 5, borderRadius: 6, border: '1px solid #ccd' }} />
          </label>
        }
      >
        Cuentas anuales
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <Cargando />
      ) : (
        datos && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {bloque('Balance de situacion', [
              ['Activo total', num(['balance', 'totalActivo'])],
              ['Patrimonio neto', num(['balance', 'totalPatrimonioNeto'])],
              ['Pasivo total', num(['balance', 'totalPasivo'])],
              ['PN + Pasivo', num(['balance', 'totalPatrimonioNetoYPasivo'])],
            ])}
            {bloque('Cuenta de perdidas y ganancias', [
              ['Ingresos de explotacion', num(['pyg', 'ingresosExplotacion'])],
              ['Gastos de explotacion', num(['pyg', 'gastosExplotacion'])],
              ['Resultado antes de impuestos', num(['pyg', 'resultadoAntesImpuestos'])],
              ['Resultado del ejercicio', num(['pyg', 'resultadoEjercicio'])],
            ])}
            {bloque('Estado de flujos de efectivo', [
              ['Flujos de explotacion', num(['efe', 'explotacion', 'total'])],
              ['Flujos de inversion', num(['efe', 'inversion', 'total'])],
              ['Flujos de financiacion', num(['efe', 'financiacion', 'total'])],
              ['Variacion neta de efectivo', num(['efe', 'variacionNetaEfectivo'])],
            ])}
          </div>
        )
      )}
      <p style={{ fontSize: 12, color: '#667', marginTop: 14 }}>Libro diario y libro de inventarios disponibles en Contabilidad · Asientos y via API (/cuentas-anuales/libro-*).</p>
    </div>
  );
}
