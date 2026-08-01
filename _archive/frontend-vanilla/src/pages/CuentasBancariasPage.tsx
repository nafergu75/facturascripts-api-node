import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, td, th, TituloPagina } from '../app/ui';

/** Cuentas bancarias: lista + alta (IBAN + subcuenta 572x). */
export function CuentasBancariasPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const navigate = useNavigate();
  const [alta, setAlta] = useState(false);
  const [nueva, setNueva] = useState({ iban: '', subcuentaCodigo: '572000', bancoNombre: '' });
  const { datos, cargando, error, recargar, setError } = useCarga(() => api.getCuentasBancarias(), [api, sesion.companyId]);

  const crear = async (): Promise<void> => {
    if (!nueva.iban || !nueva.subcuentaCodigo) {
      setError('IBAN y subcuenta contable (572x) son obligatorios.');
      return;
    }
    try {
      await api.crearCuentaBancaria(nueva);
      setAlta(false);
      setNueva({ iban: '', subcuentaCodigo: '572000', bancoNombre: '' });
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la cuenta');
    }
  };

  const input: React.CSSProperties = { padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, marginRight: 8 };

  return (
    <div>
      <TituloPagina acciones={<button style={btnPrimario} onClick={() => setAlta(!alta)}>{alta ? 'Cancelar' : '+ Nueva cuenta'}</button>}>
        Cuentas bancarias
      </TituloPagina>

      {alta && (
        <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input style={{ ...input, width: 260 }} placeholder="IBAN *" value={nueva.iban} onChange={(e) => setNueva({ ...nueva, iban: e.target.value })} />
          <input style={input} placeholder="Subcuenta (572x) *" value={nueva.subcuentaCodigo} onChange={(e) => setNueva({ ...nueva, subcuentaCodigo: e.target.value })} />
          <input style={input} placeholder="Banco" value={nueva.bancoNombre} onChange={(e) => setNueva({ ...nueva, bancoNombre: e.target.value })} />
          <button style={btnPrimario} onClick={() => void crear()}>Guardar cuenta</button>
        </div>
      )}

      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <Cargando />
      ) : !datos || datos.length === 0 ? (
        <EstadoVacio mensaje="Sin cuentas bancarias. Cada cuenta enlaza un IBAN con su subcuenta contable 572x para extractos, conciliacion y cuadre de cierre." accion={{ etiqueta: '+ Crear cuenta', onClick: () => setAlta(true) }} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>IBAN</th><th style={th}>Banco</th><th style={th}>Subcuenta</th><th style={th}>Activa</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {datos.map((c) => (
                <tr key={c.id}>
                  <td style={{ ...td, fontWeight: 700 }}>{c.iban}</td>
                  <td style={td}>{c.bancoNombre ?? '—'}</td>
                  <td style={td}>{c.subcuentaCodigo}</td>
                  <td style={td}>{c.activa ? '✓' : '✗'}</td>
                  <td style={td}>
                    <button style={btn} onClick={() => navigate('/bancos/extractos')}>Ver extracto</button>
                    <button style={btn} onClick={() => navigate('/bancos/conciliacion')}>Conciliar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
