import React, { useRef, useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, eur, td, th, TituloPagina } from '../app/ui';

/**
 * Lector de facturas (FRONTEND VANILLA — LEGACY).
 *
 * Esta página pertenece al frontend antiguo (`frontend/`) y consume el lector
 * LEGACY del backend (`/facturas/lector`, lectorFacturas.service.ts). El lector
 * oficial del proyecto es income-reader, y la UI nueva vive en el frontend
 * Chakra (`frontend-chakra/`, ruta /lector). Las nuevas evoluciones del lector
 * deben hacerse sobre frontend-chakra + income-reader, NO aquí. Esta página se
 * mantiene solo por compatibilidad. Ver ADR "Consolidación de lector OCR".
 *
 * Comportamiento: subir PDF/imagen/XML -> borrador (XML Facturae se parsea con
 * regex; PDF/imagen delegan el OCR en income-reader/Claude si hay
 * ANTHROPIC_API_KEY). Si no detecta datos, el borrador queda pendiente_revision
 * con un aviso para completar a mano (PUT) -> crear factura oficial CON
 * contabilidad (alta automatica de tercero por NIF).
 */
export function LectorPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const ficheroRef = useRef<HTMLInputElement>(null);
  const { datos, cargando, error, recargar, setError } = useCarga(() => api.getFacturasLeidas(), [api, sesion.companyId]);

  const subir = async (file: File): Promise<void> => {
    setMensaje(null);
    try {
      const fl = await api.subirFacturaLector(file);
      if (fl.avisoLectura) {
        setMensaje(`"${file.name}" subido. ${String(fl.avisoLectura)} Puedes editar los campos (numero, fecha, NIF, totales...) antes de crear la factura.`);
      } else {
        setMensaje(`"${file.name}" subido: datos de la factura detectados y aplicados (tipo: ${String(fl.tipoDetectado)}).`);
      }
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al subir');
    }
  };

  const crear = async (fl: Record<string, unknown>, tipo: 'venta' | 'compra'): Promise<void> => {
    if (!window.confirm(`Crear factura de ${tipo} desde "${fl.nombreArchivo}" y generar su contabilidad?`)) return;
    try {
      await api.crearFacturaDesdeLector(String(fl.id), tipo);
      setMensaje('Factura oficial creada y contabilizada (asiento + IVA + vencimientos). Tercero dado de alta por NIF si no existia.');
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la factura');
    }
  };

  const lista = datos ?? [];

  return (
    <div>
      <TituloPagina
        acciones={
          <>
            <input ref={ficheroRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && void subir(e.target.files[0])} />
            <button style={btnPrimario} onClick={() => ficheroRef.current?.click()}>
              📥 Subir factura (PDF / imagen / XML)
            </button>
          </>
        }
      >
        Lector de facturas
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}
      {mensaje && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{mensaje}</div>}

      {cargando ? (
        <Cargando />
      ) : lista.length === 0 ? (
        <EstadoVacio mensaje="Arrastra aqui tu primera factura: los XML Facturae y los PDF/imagen (numero, fecha, NIF, totales) se leen automaticamente. Si algo no se detecta, podras completarlo a mano." accion={{ etiqueta: 'Subir factura', onClick: () => ficheroRef.current?.click() }} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Archivo</th><th style={th}>Numero</th><th style={th}>Fecha</th><th style={th}>NIF emisor</th><th style={th}>Total</th><th style={th}>Tipo</th><th style={th}>Estado</th><th style={th}>Acciones</th></tr>
            </thead>
            <tbody>
              {lista.map((fl, i) => {
                const estado = String(fl.estado);
                return (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 600 }}>{String(fl.nombreArchivo)}</td>
                    <td style={td}>{String(fl.numero ?? '—')}</td>
                    <td style={td}>{String(fl.fecha ?? '—')}</td>
                    <td style={td}>{String(fl.nifEmisor ?? '—')}</td>
                    <td style={td}>{fl.totalFactura != null ? eur(Number(fl.totalFactura)) : '—'}</td>
                    <td style={td}>{String(fl.tipoDetectado)}</td>
                    <td style={td} title={fl.avisoLectura ? String(fl.avisoLectura) : undefined}>
                      {estado === 'confirmada' ? `✓ factura ${fl.facturaId}` : estado}
                      {fl.avisoLectura ? ' ⚠️' : ''}
                    </td>
                    <td style={td}>
                      {estado !== 'confirmada' && (
                        <>
                          <button style={btnPrimario} onClick={() => void crear(fl, 'compra')}>Crear gasto</button>
                          <button style={btn} onClick={() => void crear(fl, 'venta')}>Crear venta</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
