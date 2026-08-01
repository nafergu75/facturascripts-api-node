import React from 'react';
import { EstadoCobro } from './types';

/** Piezas de UI compartidas (badges, botones, estados vacios, carga, error). */

export const btn: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid #ccd',
  background: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  marginRight: 6,
};
export const btnPrimario: React.CSSProperties = { ...btn, background: '#1a56b0', color: '#fff', border: 'none' };

export const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #dde3ea', fontSize: 13, whiteSpace: 'nowrap' };
export const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #eef1f5', fontSize: 13 };

const COLOR_COBRO: Record<EstadoCobro, { bg: string; fg: string }> = {
  cobrada: { bg: '#d1f7dd', fg: '#0f7a3d' },
  pendiente: { bg: '#eef1f5', fg: '#556' },
  parcial: { bg: '#d6e6ff', fg: '#1a56b0' },
  vencida: { bg: '#ffe3c2', fg: '#b35c00' },
};

export function CobroBadge({ estado }: { estado: EstadoCobro }): React.ReactElement {
  const c = COLOR_COBRO[estado] ?? COLOR_COBRO.pendiente;
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
      {estado}
    </span>
  );
}

export function Cargando(): React.ReactElement {
  return <p style={{ color: '#667' }}>Cargando…</p>;
}

export function ErrorBanner({ mensaje }: { mensaje: string }): React.ReactElement {
  return <div style={{ background: '#ffe0e0', color: '#a00', padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{mensaje}</div>;
}

/** Estado vacio amigable con accion principal (UX: nunca una tabla en blanco). */
export function EstadoVacio(props: { mensaje: string; accion?: { etiqueta: string; onClick: () => void } }): React.ReactElement {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: '#667', background: '#fff', border: '1px dashed #ccd', borderRadius: 8 }}>
      <p style={{ fontSize: 14 }}>{props.mensaje}</p>
      {props.accion && (
        <button style={btnPrimario} onClick={props.accion.onClick}>
          {props.accion.etiqueta}
        </button>
      )}
    </div>
  );
}

export function TituloPagina(props: { children: React.ReactNode; acciones?: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>{props.children}</h1>
      <div style={{ marginLeft: 'auto' }}>{props.acciones}</div>
    </div>
  );
}

export const eur = (n: number | undefined): string =>
  (n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * Skeleton loader: mejora la PERCEPCION de rendimiento frente a un "Cargando…"
 * (el usuario ve la forma del contenido que va a llegar). Animacion de brillo.
 */
export function Skeleton({ alto = 16, ancho = '100%', radio = 6, style }: { alto?: number | string; ancho?: number | string; radio?: number; style?: React.CSSProperties }): React.ReactElement {
  return (
    <div
      style={{
        height: alto,
        width: ancho,
        borderRadius: radio,
        background: 'linear-gradient(90deg, #eef1f5 25%, #e2e8f0 37%, #eef1f5 63%)',
        backgroundSize: '400% 100%',
        animation: 'skel 1.4s ease infinite',
        ...style,
      }}
    >
      {/* keyframes inyectados una vez */}
      <style>{'@keyframes skel{0%{background-position:100% 50%}100%{background-position:0 50%}}'}</style>
    </div>
  );
}

/** Bloque de varias lineas skeleton (para tarjetas/graficos mientras cargan). */
export function SkeletonBloque({ lineas = 3, alto = 200 }: { lineas?: number; alto?: number }): React.ReactElement {
  return (
    <div style={{ minHeight: alto }}>
      <Skeleton alto={28} ancho="40%" style={{ marginBottom: 14 }} />
      {Array.from({ length: lineas }).map((_, i) => (
        <Skeleton key={i} alto={14} ancho={`${90 - i * 12}%`} style={{ marginBottom: 10 }} />
      ))}
    </div>
  );
}

/**
 * Icono de info (?) con tooltip al pasar el raton. Para documentar metricas
 * complejas (p. ej. "tiempo medio de cobro", "IVA neto") sin saturar la UI.
 */
export function InfoTip({ texto }: { texto: string }): React.ReactElement {
  return (
    <span
      title={texto}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 15,
        height: 15,
        borderRadius: '50%',
        background: '#cdd9ea',
        color: '#1a56b0',
        fontSize: 10,
        fontWeight: 800,
        cursor: 'help',
        marginLeft: 5,
      }}
    >
      ?
    </span>
  );
}
