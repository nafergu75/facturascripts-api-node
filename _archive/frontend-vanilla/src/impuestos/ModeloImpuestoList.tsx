import React from 'react';
import { EstadoModeloImpuesto, ModeloImpuestoResumen, TabImpuestos } from './types';

/**
 * Tabla reutilizable de modelos tributarios (lista principal / omitidos /
 * presentados). UI con componentes propios + estilos inline (sin framework),
 * coherentes en todo el modulo. TODO: extraer a CSS/tema global del proyecto.
 */

const COLOR_ESTADO: Record<EstadoModeloImpuesto, { bg: string; fg: string }> = {
  vigente: { bg: '#d1f7dd', fg: '#0f7a3d' }, // verde
  expirado: { bg: '#ffe3c2', fg: '#b35c00' }, // naranja
  presentado: { bg: '#d6e6ff', fg: '#1a56b0' }, // azul
  omitido: { bg: '#e8e8e8', fg: '#666666' }, // gris
};

export function EstadoBadge({ estado }: { estado: EstadoModeloImpuesto }): React.ReactElement {
  const c = COLOR_ESTADO[estado];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        borderRadius: 12,
        padding: '2px 10px',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {estado}
    </span>
  );
}

/** Columna "Dias": "+X dias" si faltan, "-Y dias" si ya vencio. */
function DiasCell({ m }: { m: ModeloImpuestoResumen }): React.ReactElement {
  if (m.diasHastaVencimiento !== undefined) {
    return <span style={{ color: '#0f7a3d', fontWeight: 600 }}>+{m.diasHastaVencimiento} dias</span>;
  }
  if (m.diasDesdeVencimiento !== undefined) {
    return <span style={{ color: '#b35c00', fontWeight: 600 }}>-{m.diasDesdeVencimiento} dias</span>;
  }
  return <span>—</span>;
}

const btn: React.CSSProperties = {
  padding: '4px 10px',
  marginRight: 6,
  borderRadius: 6,
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer',
  fontSize: 12,
};
const btnPrimario: React.CSSProperties = { ...btn, background: '#1a56b0', color: '#fff', border: 'none' };

export interface ModeloImpuestoListProps {
  modelos: ModeloImpuestoResumen[];
  /** Pestana activa: decide que acciones se muestran por fila. */
  tab: TabImpuestos;
  onEditar: (m: ModeloImpuestoResumen) => void;
  onOmitir: (m: ModeloImpuestoResumen) => void;
  onRecuperar: (m: ModeloImpuestoResumen) => void;
  onListoParaPresentar: (m: ModeloImpuestoResumen) => void;
  onNoPresentado: (m: ModeloImpuestoResumen) => void;
  onDescargarTxt: (m: ModeloImpuestoResumen) => void;
  onDescargarPdf: (m: ModeloImpuestoResumen) => void;
}

export function ModeloImpuestoList(props: ModeloImpuestoListProps): React.ReactElement {
  const { modelos, tab } = props;

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #ddd', fontSize: 13 };
  const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #eee', fontSize: 13 };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={th}>Modelo</th>
          <th style={th}>Descripcion</th>
          <th style={th}>Periodo</th>
          <th style={th}>Estado</th>
          <th style={th}>Vence</th>
          <th style={th}>Dias</th>
          <th style={th}>Acciones</th>
        </tr>
      </thead>
      <tbody>
        {modelos.length === 0 && (
          <tr>
            <td style={td} colSpan={7}>
              No hay modelos en esta pestana.
            </td>
          </tr>
        )}
        {modelos.map((m) => (
          <tr key={m.id}>
            <td style={{ ...td, fontWeight: 700 }}>{m.codigo}</td>
            <td style={td}>{m.descripcion}</td>
            <td style={td}>{m.periodoEtiqueta}</td>
            <td style={td}>
              <EstadoBadge estado={m.estado} />
            </td>
            <td style={td}>{m.fechaVencimiento}</td>
            <td style={td}>
              <DiasCell m={m} />
            </td>
            <td style={td}>
              {tab === 'activos' && (
                <>
                  {/* "Rellenar" si aun no tiene borrador; "Editar" si ya lo tiene */}
                  <button style={btnPrimario} onClick={() => props.onEditar(m)}>
                    {m.tieneBorrador ? 'Editar' : 'Rellenar'}
                  </button>
                  {m.tieneBorrador && (
                    <button style={btn} onClick={() => props.onDescargarPdf(m)}>
                      Descargar PDF
                    </button>
                  )}
                  <button style={btn} onClick={() => props.onListoParaPresentar(m)}>
                    Listo para presentar
                  </button>
                  <button style={btn} onClick={() => props.onOmitir(m)}>
                    Omitir
                  </button>
                </>
              )}
              {tab === 'omitidos' && (
                <button style={btnPrimario} onClick={() => props.onRecuperar(m)}>
                  Recuperar
                </button>
              )}
              {tab === 'presentados' && (
                <>
                  <button style={btn} onClick={() => props.onNoPresentado(m)}>
                    No presentado
                  </button>
                  <button style={btn} onClick={() => props.onDescargarTxt(m)}>
                    Descargar TXT
                  </button>
                  <button style={btn} onClick={() => props.onDescargarPdf(m)}>
                    Descargar PDF
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
