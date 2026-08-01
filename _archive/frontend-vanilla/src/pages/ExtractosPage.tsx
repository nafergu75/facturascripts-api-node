import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app/AppLayout';
import { CuentaBancaria, ExtractoBancario, RevisionExtracto } from '../app/types';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/**
 * Bancos / Extractos: selector de cuenta + tabla de movimientos con estado de
 * conciliacion + importar CSV + exportar (CSV/JSON) + revision de discrepancias
 * contra la contabilidad (saldo 57x vs extracto).
 */
export function ExtractosPage(): React.ReactElement {
  const { api } = useApp();
  const [cuentas, setCuentas] = useState<CuentaBancaria[]>([]);
  const [cuentaId, setCuentaId] = useState<string>('');
  const [extracto, setExtracto] = useState<ExtractoBancario | null>(null);
  const [revision, setRevision] = useState<RevisionExtracto | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ficheroRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .getCuentasBancarias()
      .then((cs) => {
        setCuentas(cs);
        if (cs.length) setCuentaId((prev) => prev || cs[0].id);
        setCargando(false);
      })
      .catch((e) => {
        setError(String(e));
        setCargando(false);
      });
  }, [api]);

  const cargarExtracto = useCallback(async () => {
    if (!cuentaId) return;
    setError(null);
    setRevision(null);
    try {
      setExtracto(await api.getExtracto(cuentaId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando extracto');
    }
  }, [api, cuentaId]);

  useEffect(() => {
    void cargarExtracto();
  }, [cargarExtracto]);

  const importarCsv = async (file: File): Promise<void> => {
    try {
      const texto = await file.text();
      await api.importarCsv(cuentaId, texto);
      await cargarExtracto();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error importando CSV');
    }
  };

  const revisar = async (): Promise<void> => {
    try {
      setRevision(await api.getRevisionExtracto(cuentaId, new Date().getFullYear()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en la revision');
    }
  };

  const exportarJson = (): void => {
    if (!extracto) return;
    const blob = new Blob([JSON.stringify(extracto, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `extracto_${cuentaId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (cargando) return <Cargando />;

  return (
    <div>
      <TituloPagina>Extractos bancarios</TituloPagina>
      {error && <ErrorBanner mensaje={error} />}

      {cuentas.length === 0 ? (
        <EstadoVacio
          mensaje="Aun no hay cuentas bancarias. Crea una cuenta (IBAN + subcuenta 572x) para importar extractos."
          accion={{ etiqueta: 'Crear cuenta bancaria', onClick: () => window.alert('TODO: alta de cuenta (POST /bancos/cuentas)') }}
        />
      ) : (
        <>
          {/* Barra de acciones */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e3e8ef', marginBottom: 12 }}>
            <label style={{ fontSize: 13, color: '#445' }}>
              Cuenta{' '}
              <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} style={{ padding: 5, borderRadius: 6, border: '1px solid #ccd' }}>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.iban} ({c.subcuentaCodigo})
                  </option>
                ))}
              </select>
            </label>
            <input ref={ficheroRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && void importarCsv(e.target.files[0])} />
            <button style={btnPrimario} onClick={() => ficheroRef.current?.click()}>
              Importar CSV
            </button>
            <button style={btn} onClick={() => void api.descargar(`/extractos/cuentas/${cuentaId}/extracto.csv`, 'extracto.csv')}>
              Exportar CSV
            </button>
            <button style={btn} onClick={exportarJson}>
              Exportar JSON
            </button>
            <button style={btn} onClick={() => void revisar()}>
              Revisar discrepancias
            </button>
          </div>

          {/* Revision contable */}
          {revision && (
            <div
              style={{
                background: revision.cuadra ? '#e6f6ec' : '#ffe3c2',
                color: revision.cuadra ? '#0f7a3d' : '#b35c00',
                padding: 10,
                borderRadius: 8,
                marginBottom: 12,
                fontSize: 13,
              }}
            >
              {revision.cuadra ? '✓ El extracto CUADRA con la contabilidad.' : '⚠ DESCUADRE con la contabilidad.'} Saldo extracto {eur(revision.saldoExtracto)} · saldo contable {eur(revision.saldoContable)} · diferencia {eur(revision.diferencia)} · {revision.movimientosSinConciliar} movimientos sin conciliar.
            </div>
          )}

          {/* Tabla de movimientos */}
          {!extracto || extracto.lineas.length === 0 ? (
            <EstadoVacio mensaje="Esta cuenta no tiene movimientos. Importa un CSV del banco (fecha;importe;concepto;referencia)." accion={{ etiqueta: 'Importar CSV', onClick: () => ficheroRef.current?.click() }} />
          ) : (
            <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Fecha</th>
                    <th style={th}>Concepto</th>
                    <th style={th}>Cargo</th>
                    <th style={th}>Abono</th>
                    <th style={th}>Saldo</th>
                    <th style={th}>Conciliado</th>
                  </tr>
                </thead>
                <tbody>
                  {extracto.lineas.map((l, i) => (
                    <tr key={i}>
                      <td style={td}>{l.fecha}</td>
                      <td style={td}>{l.concepto}</td>
                      <td style={{ ...td, color: '#b35c00' }}>{l.cargo ? eur(l.cargo) : ''}</td>
                      <td style={{ ...td, color: '#0f7a3d' }}>{l.abono ? eur(l.abono) : ''}</td>
                      <td style={td}>{eur(l.saldoAcumulado)}</td>
                      <td style={td}>{l.conciliado ? '✓ contabilizado' : '— pendiente'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: 10, fontSize: 13, color: '#556' }}>
                {extracto.numMovimientos} movimientos · cargos {eur(extracto.totalCargos)} · abonos {eur(extracto.totalAbonos)} · saldo final <b>{eur(extracto.saldoFinal)}</b>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
