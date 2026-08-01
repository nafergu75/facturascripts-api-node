import React from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/** Productos: catalogo de FacturaScripts (referencia, descripcion, precio, stock). */
export function ProductosPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const { datos, cargando, error } = useCarga(() => api.getProductos(), [api, sesion.companyId]);
  const lista = datos?.items ?? [];

  return (
    <div>
      <TituloPagina>Productos</TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {cargando ? (
        <Cargando />
      ) : lista.length === 0 ? (
        <EstadoVacio mensaje="No hay productos en el catalogo. Crealos en FacturaScripts o importalos (TODO: alta desde aqui)." />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Referencia</th><th style={th}>Descripcion</th><th style={th}>Precio</th><th style={th}>Stock</th><th style={th}>Bloqueado</th></tr>
            </thead>
            <tbody>
              {lista.map((p, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 700 }}>{String(p.referencia ?? '')}</td>
                  <td style={td}>{String(p.descripcion ?? '')}</td>
                  <td style={td}>{eur(Number(p.precio ?? 0))}</td>
                  <td style={td}>{String(p.stockfis ?? 0)}</td>
                  <td style={td}>{p.bloqueado ? 'Si' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: 10, fontSize: 13, color: '#556' }}>Total: {datos?.total ?? 0} productos</div>
        </div>
      )}
    </div>
  );
}
