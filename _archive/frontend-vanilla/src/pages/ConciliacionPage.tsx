import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/**
 * Conciliacion bancaria (patron Quipu): movimientos importados pendientes ->
 *  - "Conciliar con factura": registra el COBRO con su asiento de tesoreria y
 *    deja la factura Cobrada/Parcial.
 *  - "A cuenta 555": movimientos sin documento (comisiones, dividendos...) se
 *    asientan contra 555 Partidas pendientes de aplicacion (u otra subcuenta).
 */
export function ConciliacionPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(true);
  const { datos, cargando, error, recargar, setError } = useCarga(() => api.getMovimientos(), [api, sesion.companyId]);

  const movimientos = (datos ?? []).filter((m) => !soloPendientes || !m.conciliado);

  const conFactura = async (movId: string): Promise<void> => {
    // Selector simple de factura: pide el id/numero. TODO: modal con las
    // facturas pendientes de cobro precargadas (GET /facturas + filtro estado).
    const facturaId = window.prompt('Id de la factura a conciliar (ej. 5):');
    if (!facturaId) return;
    try {
      await api.conciliarMovimientoConFactura(movId, facturaId);
      setMensaje('Movimiento conciliado: cobro registrado con su asiento de tesoreria y factura actualizada.');
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al conciliar');
    }
  };

  const conCuenta = async (movId: string): Promise<void> => {
    const subcuenta = window.prompt('Subcuenta contable destino:', '5550000000');
    if (!subcuenta) return;
    try {
      await api.conciliarMovimientoConCuenta(movId, subcuenta);
      setMensaje(`Movimiento asentado contra la subcuenta ${subcuenta}.`);
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al conciliar');
    }
  };

  return (
    <div>
      <TituloPagina
        acciones={
          <label style={{ fontSize: 13, color: '#445' }}>
            <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} /> Solo pendientes
          </label>
        }
      >
        Conciliacion bancaria
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {mensaje && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{mensaje}</div>}

      {cargando ? (
        <Cargando />
      ) : movimientos.length === 0 ? (
        <EstadoVacio mensaje={soloPendientes ? 'No hay movimientos pendientes de conciliar. 🎉' : 'No hay movimientos importados. Importa un extracto CSV desde Bancos · Extractos.'} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Fecha</th><th style={th}>Concepto</th><th style={th}>Importe</th><th style={th}>Estado</th><th style={th}>Acciones</th></tr>
            </thead>
            <tbody>
              {movimientos.map((m) => (
                <tr key={m.id}>
                  <td style={td}>{m.fecha}</td>
                  <td style={td}>{m.concepto}</td>
                  <td style={{ ...td, color: m.importe >= 0 ? '#0f7a3d' : '#b35c00', fontWeight: 600 }}>{eur(m.importe)}</td>
                  <td style={td}>{m.conciliado ? `✓ conciliado (${m.referencia ?? ''})` : '— pendiente'}</td>
                  <td style={td}>
                    {!m.conciliado && (
                      <>
                        <button style={btnPrimario} onClick={() => void conFactura(m.id)} disabled={m.importe <= 0} title={m.importe <= 0 ? 'Los cargos (pagos) se concilian contra cuenta' : ''}>
                          Conciliar con factura
                        </button>
                        <button style={btn} onClick={() => void conCuenta(m.id)}>A cuenta (555…)</button>
                      </>
                    )}
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
