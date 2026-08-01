import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

interface LineaAsiento {
  subcuenta: string;
  debe: number;
  haber: number;
  concepto?: string;
}
interface Asiento {
  numero: number | string;
  fecha: string;
  concepto: string;
  lineas: LineaAsiento[];
}
interface LibroDiario {
  ejercicio: number;
  asientos: Asiento[];
  totalDebe: number;
  totalHaber: number;
}

/** Asientos: libro diario del ejercicio con apuntes expandibles. */
export function AsientosPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [ejercicio, setEjercicio] = useState(new Date().getFullYear());
  const [abierto, setAbierto] = useState<string | null>(null);
  const { datos, cargando, error } = useCarga(() => api.getLibroDiario(ejercicio) as Promise<LibroDiario>, [api, sesion.companyId, ejercicio]);

  return (
    <div>
      <TituloPagina
        acciones={
          <>
            <label style={{ fontSize: 13, color: '#445', marginRight: 8 }}>
              Ejercicio <input type="number" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))} style={{ width: 80, padding: 5, borderRadius: 6, border: '1px solid #ccd' }} />
            </label>
            <button style={btn} onClick={() => void api.descargar(`/reportes/libro-diario.csv?ejercicio=${ejercicio}`, 'libro-diario.csv')}>
              Exportar CSV
            </button>
          </>
        }
      >
        Asientos — Libro diario
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}

      {cargando ? (
        <Cargando />
      ) : !datos || datos.asientos.length === 0 ? (
        <EstadoVacio mensaje={`No hay asientos en ${ejercicio}. Se generan al contabilizar facturas, registrar cobros o conciliar movimientos.`} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Nº</th><th style={th}>Fecha</th><th style={th}>Concepto</th><th style={th}>Apuntes</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {datos.asientos.map((a) => {
                const id = String(a.numero);
                return (
                  <React.Fragment key={id}>
                    <tr onClick={() => setAbierto(abierto === id ? null : id)} style={{ cursor: 'pointer' }}>
                      <td style={{ ...td, fontWeight: 700 }}>{a.numero}</td>
                      <td style={td}>{a.fecha}</td>
                      <td style={td}>{a.concepto}</td>
                      <td style={td}>{a.lineas.length}</td>
                      <td style={td}>{abierto === id ? '▲' : '▼'}</td>
                    </tr>
                    {abierto === id && (
                      <tr>
                        <td colSpan={5} style={{ ...td, background: '#f8fafc', padding: 0 }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <tbody>
                              {a.lineas.map((l, i) => (
                                <tr key={i}>
                                  <td style={{ ...td, width: 140, fontFamily: 'monospace' }}>{l.subcuenta}</td>
                                  <td style={td}>{l.concepto ?? ''}</td>
                                  <td style={{ ...td, width: 120, textAlign: 'right' }}>{l.debe ? `D ${eur(l.debe)}` : ''}</td>
                                  <td style={{ ...td, width: 120, textAlign: 'right' }}>{l.haber ? `H ${eur(l.haber)}` : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: 10, fontSize: 13, color: '#556' }}>
            {datos.asientos.length} asientos · Debe {eur(datos.totalDebe)} · Haber {eur(datos.totalHaber)} {datos.totalDebe === datos.totalHaber ? '✓ cuadrado' : '⚠ DESCUADRE'}
          </div>
        </div>
      )}
    </div>
  );
}
