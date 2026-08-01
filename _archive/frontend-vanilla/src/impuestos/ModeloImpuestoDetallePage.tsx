import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ImpuestosApiClient, URL_SEDE_AEAT } from './ImpuestosApiClient';
import { EstadoBadge } from './ModeloImpuestoList';
import { Casillas, ModeloImpuestoDetalle } from './types';

/**
 * Pantalla de edicion de un modelo (flujo del tutorial):
 *  - Ficha explicativa arriba (texto + advertencias + recomendaciones).
 *  - "Recalcular importes": autorrellena desde contabilidad, SE GUARDA SOLO y
 *    PISA lo manual -> si hay cambios manuales sin guardar (o guardados como
 *    manual-mixto) se pide CONFIRMACION antes.
 *  - Casillas editables: al tocar una, el modelo queda "modificado manualmente"
 *    (aviso visible). Los totales dependientes NO se recalculan solos.
 *  - "Guardar": conserva los cambios manuales (origen manual-mixto).
 */
export interface ModeloImpuestoDetallePageProps {
  companyId: string;
  token: string;
  modeloId: string;
  apiBaseUrl?: string;
  /** Volver a la lista (TODO: integrar con el router del proyecto). */
  onVolver: () => void;
}

const btn: React.CSSProperties = { padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', marginRight: 8 };
const btnPrimario: React.CSSProperties = { ...btn, background: '#1a56b0', color: '#fff', border: 'none' };
const btnPeligro: React.CSSProperties = { ...btn, background: '#b35c00', color: '#fff', border: 'none' };

export function ModeloImpuestoDetallePage(props: ModeloImpuestoDetallePageProps): React.ReactElement {
  const { companyId, token, modeloId, apiBaseUrl = '', onVolver } = props;
  const api = useMemo(() => new ImpuestosApiClient(apiBaseUrl, companyId, token), [apiBaseUrl, companyId, token]);

  const [detalle, setDetalle] = useState<ModeloImpuestoDetalle | null>(null);
  const [casillas, setCasillas] = useState<Casillas>({});
  /** true si el usuario ha tocado casillas desde la ultima carga/recalculo. */
  const [modificadoManualmente, setModificadoManualmente] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aplicar = useCallback((d: ModeloImpuestoDetalle) => {
    setDetalle(d);
    setCasillas({ ...d.casillas });
    setModificadoManualmente(false);
  }, []);

  useEffect(() => {
    api.obtenerDetalle(modeloId).then(aplicar).catch((e) => setError(String(e)));
  }, [api, modeloId, aplicar]);

  const recalcular = async (): Promise<void> => {
    // Regla del tutorial: recalcular PIERDE los cambios manuales -> confirmar.
    const hayManuales = modificadoManualmente || detalle?.origen === 'manual-mixto';
    if (hayManuales && !window.confirm('Recalcular importes sobrescribira tus cambios manuales. ¿Continuar?')) return;
    setOcupado(true);
    setError(null);
    try {
      aplicar(await api.recalcular(modeloId));
      setMensaje('Importes recalculados desde la contabilidad y guardados automaticamente.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al recalcular');
    } finally {
      setOcupado(false);
    }
  };

  const guardar = async (): Promise<void> => {
    setOcupado(true);
    setError(null);
    try {
      aplicar(await api.guardar(modeloId, casillas));
      setMensaje('Cambios manuales guardados (origen: manual-mixto).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setOcupado(false);
    }
  };

  const editarCasilla = (clave: string, valor: string): void => {
    const num = Number(valor);
    setCasillas((prev) => ({ ...prev, [clave]: valor === '' ? null : Number.isFinite(num) && valor.trim() !== '' ? num : valor }));
    setModificadoManualmente(true);
    setMensaje(null);
  };

  if (error && !detalle) return <p style={{ color: '#a00' }}>{error}</p>;
  if (!detalle) return <p>Cargando…</p>;

  const { resumen, ficha } = detalle;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto', padding: 16 }}>
      <button style={btn} onClick={onVolver}>
        ← Volver a la lista
      </button>

      <h1 style={{ fontSize: 20, marginTop: 12 }}>
        {ficha.titulo} <EstadoBadge estado={resumen.estado} />
      </h1>
      <p style={{ fontSize: 13, color: '#555' }}>
        Periodo {resumen.periodoEtiqueta} · vence el {resumen.fechaVencimiento} · datos: {detalle.origen}
      </p>

      {/* Ficha explicativa (texto del tutorial) */}
      <div style={{ background: '#f4f7fb', border: '1px solid #d6e2f0', borderRadius: 8, padding: 12, fontSize: 13 }}>
        <p style={{ marginTop: 0 }}>{ficha.textoExplicativo}</p>
        {ficha.advertencias.map((a, i) => (
          <p key={i} style={{ color: '#b35c00', margin: '4px 0' }}>
            ⚠ {a}
          </p>
        ))}
        {ficha.recomendaciones.map((r, i) => (
          <p key={i} style={{ color: '#0f7a3d', margin: '4px 0' }}>
            ✓ {r}
          </p>
        ))}
      </div>

      {/* Aviso de cambios manuales sin guardar */}
      {modificadoManualmente && (
        <div style={{ background: '#fff7e0', border: '1px solid #e0c060', borderRadius: 6, padding: 8, margin: '10px 0', fontSize: 13 }}>
          Has modificado casillas a mano. Recuerda: los totales dependientes NO se recalculan solos y debes pulsar
          <b> Guardar</b> para conservarlos. Si pulsas «Recalcular importes» los perderas.
        </div>
      )}

      <div style={{ margin: '12px 0' }}>
        <button style={btnPeligro} onClick={() => void recalcular()} disabled={ocupado}>
          Recalcular importes
        </button>
        <button style={btnPrimario} onClick={() => void guardar()} disabled={ocupado || !modificadoManualmente}>
          Guardar
        </button>
        <a href={URL_SEDE_AEAT} target="_blank" rel="noreferrer" style={{ fontSize: 13, marginLeft: 8 }}>
          Ir a la Sede de la AEAT ↗
        </a>
      </div>

      {mensaje && <div style={{ background: '#e6f6ec', color: '#0f7a3d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{mensaje}</div>}
      {error && <div style={{ background: '#ffe0e0', color: '#a00', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 13 }}>{error}</div>}

      {/* Casillas del modelo */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid #ddd', fontSize: 13 }}>Casilla</th>
            <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid #ddd', fontSize: 13 }}>Valor</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(casillas).length === 0 && (
            <tr>
              <td colSpan={2} style={{ padding: 8 }}>
                Sin casillas todavia: pulsa «Recalcular importes» para autorrellenar el modelo.
              </td>
            </tr>
          )}
          {Object.entries(casillas).map(([clave, valor]) => (
            <tr key={clave}>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee', fontSize: 13 }}>{clave}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee' }}>
                <input
                  style={{ width: 220, padding: 4, fontSize: 13 }}
                  value={valor === null || valor === undefined ? '' : String(valor)}
                  onChange={(e) => editarCasilla(clave, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
