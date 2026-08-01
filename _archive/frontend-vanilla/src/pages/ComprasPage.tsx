import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/**
 * Facturas de gasto (facturaproveedores): listado + contabilizar (asiento de
 * compra: gasto + IVA soportado + proveedor). El alta recomendada es por el
 * Lector de facturas (sube el PDF/XML y crea factura + contabilidad).
 */
export function ComprasPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const navigate = useNavigate();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const { datos, cargando, error, setError } = useCarga(() => api.getCompras({ pageSize: 50 }), [api, sesion.companyId]);
  const lista = datos?.items ?? [];

  const contabilizar = async (f: Record<string, unknown>): Promise<void> => {
    try {
      await api.contabilizarCompra(String(f.idfactura ?? f.codigo));
      setMensaje(`Factura ${f.codigo}: asiento de compra (gasto + IVA soportado + proveedor) y vencimiento de pago generados.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al contabilizar');
    }
  };

  return (
    <div>
      <TituloPagina acciones={<button style={btnPrimario} onClick={() => navigate('/lector')}>📥 Subir factura al lector</button>}>
        Facturas de gasto
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {mensaje && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{mensaje}</div>}

      {cargando ? (
        <Cargando />
      ) : lista.length === 0 ? (
        <EstadoVacio
          mensaje="No hay facturas de gasto. Sube la primera por el lector (PDF, imagen o XML Facturae): extrae los datos, crea el proveedor por NIF y la contabiliza."
          accion={{ etiqueta: 'Ir al lector de facturas', onClick: () => navigate('/lector') }}
        />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Numero</th><th style={th}>Proveedor</th><th style={th}>Fecha</th><th style={th}>Base</th><th style={th}>IVA</th><th style={th}>Total</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {lista.map((f, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 700 }}>{String(f.codigo ?? '')}</td>
                  <td style={td}>{String(f.nombre ?? f.codproveedor ?? '')}</td>
                  <td style={td}>{String(f.fecha ?? '')}</td>
                  <td style={td}>{eur(Number(f.neto ?? 0))}</td>
                  <td style={td}>{eur(Number(f.totaliva ?? 0))}</td>
                  <td style={td}>{eur(Number(f.total ?? 0))}</td>
                  <td style={td}>
                    <button style={btn} onClick={() => void contabilizar(f)}>Contabilizar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: 10, fontSize: 13, color: '#556' }}>Total: {datos?.total ?? 0} facturas de gasto</div>
        </div>
      )}
    </div>
  );
}
