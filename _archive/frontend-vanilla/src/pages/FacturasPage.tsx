import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../app/AppLayout';
import { FacturaResumen, FiltrosFacturas, Paginado } from '../app/types';
import { btn, btnPrimario, Cargando, CobroBadge, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/**
 * Facturas de venta: lista paginada + filtros + panel de detalle expandible con
 * accesos rapidos (contabilizar -> asiento, registrar cobro -> estado).
 * TODO: formulario "Nueva factura" completo (alta con buscador de clientes y
 * series); hoy el boton navega a un placeholder.
 */
export function FacturasPage(): React.ReactElement {
  const { api } = useApp();
  const [datos, setDatos] = useState<Paginado<FacturaResumen> | null>(null);
  const [filtros, setFiltros] = useState<FiltrosFacturas>({ page: 1, pageSize: 25 });
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null); // id de la fila expandida
  const [mensajeFila, setMensajeFila] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setDatos(await api.getFacturas(filtros));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando facturas');
    } finally {
      setCargando(false);
    }
  }, [api, filtros]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const idDe = (f: FacturaResumen): string => String(f.idfactura ?? f.codigo ?? '');

  const contabilizar = async (f: FacturaResumen): Promise<void> => {
    setMensajeFila(null);
    try {
      await api.contabilizarFactura(idDe(f));
      setMensajeFila(`Factura ${f.codigo}: asiento contable y vencimientos generados.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al contabilizar');
    }
  };

  const cobrar = async (f: FacturaResumen): Promise<void> => {
    const importe = Number(window.prompt(`Importe a cobrar (pendiente ${eur(f.importePendiente)}):`, String(f.importePendiente)));
    if (!Number.isFinite(importe) || importe <= 0) return;
    try {
      await api.registrarCobro(idDe(f), importe, new Date().toISOString().slice(0, 10));
      setMensajeFila(`Cobro de ${eur(importe)} registrado con su asiento de tesoreria.`);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al registrar el cobro');
    }
  };

  const input: React.CSSProperties = { padding: 5, borderRadius: 6, border: '1px solid #ccd', fontSize: 13 };

  return (
    <div>
      <TituloPagina
        acciones={
          <button style={btnPrimario} onClick={() => window.alert('TODO: formulario de nueva factura (POST /facturas con serie y buscador de clientes).')}>
            + Nueva factura
          </button>
        }
      >
        Facturas de venta
      </TituloPagina>

      {/* Filtros (cliente, fechas; serie/estado TODO cuando el listado los filtre en API) */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e3e8ef' }}>
        <input style={input} placeholder="Codigo de cliente" value={filtros.clienteCodigo ?? ''} onChange={(e) => setFiltros((f) => ({ ...f, clienteCodigo: e.target.value, page: 1 }))} />
        <label style={{ fontSize: 13, color: '#445' }}>
          Desde <input style={input} type="date" value={filtros.desde ?? ''} onChange={(e) => setFiltros((f) => ({ ...f, desde: e.target.value, page: 1 }))} />
        </label>
        <label style={{ fontSize: 13, color: '#445' }}>
          Hasta <input style={input} type="date" value={filtros.hasta ?? ''} onChange={(e) => setFiltros((f) => ({ ...f, hasta: e.target.value, page: 1 }))} />
        </label>
        <button style={btn} onClick={() => setFiltros({ page: 1, pageSize: 25 })}>
          Limpiar filtros
        </button>
      </div>

      {error && <ErrorBanner mensaje={error} />}
      {mensajeFila && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{mensajeFila}</div>}

      {cargando ? (
        <Cargando />
      ) : !datos || datos.items.length === 0 ? (
        <EstadoVacio mensaje="No hay facturas en este periodo." accion={{ etiqueta: 'Crear la primera factura', onClick: () => window.alert('TODO: alta de factura') }} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Numero</th>
                <th style={th}>Cliente</th>
                <th style={th}>Fecha</th>
                <th style={th}>Serie</th>
                <th style={th}>Importe</th>
                <th style={th}>Cobro</th>
                <th style={th}>Pendiente</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {datos.items.map((f) => {
                const id = idDe(f);
                return (
                  <React.Fragment key={id}>
                    <tr onClick={() => setAbierta(abierta === id ? null : id)} style={{ cursor: 'pointer' }}>
                      <td style={{ ...td, fontWeight: 700 }}>{f.codigo}</td>
                      <td style={td}>{f.nombrecliente ?? f.codcliente}</td>
                      <td style={td}>{f.fecha}</td>
                      <td style={td}>{f.codserie ?? '—'}</td>
                      <td style={td}>{eur(f.total)}</td>
                      <td style={td}>
                        <CobroBadge estado={f.estadoCobro} />
                      </td>
                      <td style={td}>{eur(f.importePendiente)}</td>
                      <td style={td}>{abierta === id ? '▲' : '▼'}</td>
                    </tr>
                    {abierta === id && (
                      <tr>
                        <td style={{ ...td, background: '#f8fafc' }} colSpan={8}>
                          <b>Detalle</b> — cobrado {eur(f.importeCobrado)}
                          {f.fechaUltimoCobro ? ` (ultimo: ${f.fechaUltimoCobro})` : ''} · pendiente {eur(f.importePendiente)}
                          <div style={{ marginTop: 8 }}>
                            <button style={btnPrimario} onClick={() => void contabilizar(f)}>
                              Contabilizar (asiento + vencimientos)
                            </button>
                            <button style={btn} onClick={() => void cobrar(f)} disabled={f.estadoCobro === 'cobrada'}>
                              Registrar cobro
                            </button>
                            <button style={btn} onClick={() => window.alert('TODO: editor de factura (PUT /facturas/:id).')}>
                              Editar
                            </button>
                            {/* Acceso rapido: el IVA de esta factura entra en el 303 de su trimestre */}
                            <button style={btn} onClick={() => (window.location.href = '/impuestos')}>
                              Ver en Impuestos (303)
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: 10, fontSize: 13, color: '#556', display: 'flex', gap: 10, alignItems: 'center' }}>
            Total: {datos.total} facturas
            <button style={btn} disabled={(filtros.page ?? 1) <= 1} onClick={() => setFiltros((f) => ({ ...f, page: (f.page ?? 1) - 1 }))}>
              ← Anterior
            </button>
            Pagina {filtros.page ?? 1}
            <button style={btn} disabled={(datos.offset + datos.items.length) >= datos.total} onClick={() => setFiltros((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}>
              Siguiente →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
