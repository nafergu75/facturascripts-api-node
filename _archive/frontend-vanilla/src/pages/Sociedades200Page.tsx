import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, Cargando, ErrorBanner, eur, td, th, TituloPagina } from '../app/ui';

/** Impuesto de Sociedades (Modelo 200): liquidacion calculada + descarga TXT. */
export function Sociedades200Page(): React.ReactElement {
  const { api, sesion } = useApp();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear() - 1); // se presenta el año siguiente
  const { datos, cargando, error } = useCarga(() => api.getModelo200(ejercicio), [api, sesion.companyId, ejercicio]);

  const FILAS: Array<[string, string]> = [
    ['resultadoContableAntesImpuestos', 'Resultado contable antes de impuestos'],
    ['baseImponiblePrevia', 'Base imponible previa'],
    ['basesNegativasCompensables', 'Bases negativas compensadas'],
    ['baseImponibleFinal', 'Base imponible'],
    ['tipoGravamen', 'Tipo de gravamen (%)'],
    ['cuotaIntegra', 'Cuota integra'],
    ['deduccionesBonificaciones', 'Deducciones y bonificaciones'],
    ['pagosFraccionadosRetenciones', 'Pagos fraccionados y retenciones'],
    ['cuotaLiquida', 'Cuota liquida'],
    ['cuotaADepositarODevolver', 'Cuota a ingresar / devolver'],
  ];

  return (
    <div>
      <TituloPagina
        acciones={
          <>
            <label style={{ fontSize: 13, color: '#445', marginRight: 8 }}>
              Ejercicio <input type="number" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))} style={{ width: 80, padding: 5, borderRadius: 6, border: '1px solid #ccd' }} />
            </label>
            <button style={btn} onClick={() => void api.descargar(`/modelo-200/fichero?ejercicio=${ejercicio}`, `200_${ejercicio}.txt`)}>
              Descargar TXT AEAT
            </button>
          </>
        }
      >
        Impuesto de Sociedades (Modelo 200)
      </TituloPagina>
      <p style={{ fontSize: 12, color: '#667' }}>Liquidacion calculada desde la contabilidad (tipo 25%; ajustes extracontables y tipo reducido: TODO). Plazo: 25 de julio de {ejercicio + 1}.</p>
      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <Cargando />
      ) : (
        datos && (
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', maxWidth: 620 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {FILAS.map(([clave, etiqueta]) => {
                  const v = Number(datos[clave] ?? 0);
                  const esResultado = clave === 'cuotaADepositarODevolver';
                  return (
                    <tr key={clave} style={esResultado ? { background: '#f4f7fb' } : undefined}>
                      <td style={{ ...td, fontWeight: esResultado ? 800 : 400 }}>{etiqueta}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: esResultado ? 800 : 600 }}>{clave === 'tipoGravamen' ? `${v} %` : eur(v)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
