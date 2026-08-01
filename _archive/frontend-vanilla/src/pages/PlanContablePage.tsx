import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btnPrimario, Cargando, ErrorBanner, EstadoVacio, td, th, TituloPagina } from '../app/ui';

/**
 * Plan contable: subcuentas de la empresa + alta rapida de subcuenta de GASTO
 * (genera el codigo correlativo 627xxxx) sobre el plan base PGC-PYME.
 */
export function PlanContablePage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [nombre, setNombre] = useState('');
  const [cuentaBase, setCuentaBase] = useState('627');
  const { datos, cargando, error, recargar, setError } = useCarga(
    async () => ({ subcuentas: await api.getSubcuentas(), base: await api.getPlanBaseCuentas() }),
    [api, sesion.companyId],
  );

  const crearGasto = async (): Promise<void> => {
    if (!nombre.trim()) {
      setError('Indica el nombre de la subcuenta (ej. "Luz oficina").');
      return;
    }
    try {
      await api.crearSubcuentaGasto(cuentaBase, nombre.trim());
      setNombre('');
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la subcuenta');
    }
  };

  const cuentasGasto = (datos?.base ?? []).filter((c) => c.tipo === 'gasto');

  return (
    <div>
      <TituloPagina>Plan contable</TituloPagina>
      {error && <ErrorBanner mensaje={error} />}

      {/* Alta rapida de subcuenta de gasto (627001 Luz oficina, 627002...) */}
      <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <b style={{ fontSize: 13 }}>Alta rapida de subcuenta de gasto</b>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={cuentaBase} onChange={(e) => setCuentaBase(e.target.value)} style={{ padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13 }}>
            {cuentasGasto.map((c) => (
              <option key={c.codigo} value={c.codigo}>
                {c.codigo} — {c.nombre}
              </option>
            ))}
          </select>
          <input
            style={{ padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, width: 260 }}
            placeholder='Concepto (ej. "Luz oficina")'
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <button style={btnPrimario} onClick={() => void crearGasto()}>
            Crear subcuenta
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#667', marginBottom: 0 }}>Genera el siguiente codigo correlativo (ej. 6270001, 6270002…) validando que la cuenta base es de gasto.</p>
      </div>

      {cargando ? (
        <Cargando />
      ) : !datos || datos.subcuentas.length === 0 ? (
        <EstadoVacio mensaje="La empresa aun no tiene subcuentas propias. Crea la primera con el alta rapida de gasto." />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Codigo</th><th style={th}>Nombre</th><th style={th}>Cuenta base</th><th style={th}>Activa</th></tr>
            </thead>
            <tbody>
              {datos.subcuentas.map((s, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700 }}>{String(s.codigo)}</td>
                  <td style={td}>{String(s.nombre)}</td>
                  <td style={td}>{String(s.cuentaBaseCodigo)}</td>
                  <td style={td}>{s.activa ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
