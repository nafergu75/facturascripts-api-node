import React, { memo, useRef, useState } from 'react';

/**
 * Graficos SVG PROPIOS, sin dependencias, siguiendo buenas practicas de
 * dashboards financieros:
 *  - Tooltips INTERACTIVOS (no <title> nativo) con el importe exacto.
 *  - Ejes etiquetados con unidad (€) y leyendas cortas.
 *  - Barras desde 0; la linea de bancos marca la linea de cero cuando hay
 *    valores negativos (no engaña con la escala).
 *  - Verde = positivo/ingresos, rojo = negativo/gastos/riesgo.
 *  - Componentes memoizados (React.memo): no se re-renderizan si sus props no
 *    cambian (p. ej. al cambiar el periodo del resumen superior).
 * TODO: migrar a Recharts si se necesitan ejes con zoom/brush o animaciones.
 */

export const VERDE = '#0f7a3d';
export const ROJO = '#b3261e';
export const AZUL = '#1a56b0';
export const PALETA = ['#1a56b0', '#0f7a3d', '#b35c00', '#7b3fbf', '#0e8a8a', '#b3261e', '#8a6d00', '#555f6e'];

const eur0 = (n: number): string => n.toLocaleString('es-ES', { maximumFractionDigits: 0 }) + ' €';
const eur2 = (n: number): string => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fmtEje = (n: number): string => (Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)));

// --- Tooltip interactivo compartido ---
interface TipState {
  x: number;
  y: number;
  lineas: string[];
  color?: string;
}
function useTooltip(): {
  ref: React.RefObject<HTMLDivElement | null>;
  mostrar: (e: React.MouseEvent, lineas: string[], color?: string) => void;
  ocultar: () => void;
  overlay: React.ReactNode;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const mostrar = (e: React.MouseEvent, lineas: string[], color?: string): void => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, lineas, color });
  };
  const ocultar = (): void => setTip(null);
  const overlay = tip ? (
    <div
      style={{
        position: 'absolute',
        left: Math.min(tip.x + 12, (ref.current?.clientWidth ?? 9999) - 150),
        top: Math.max(tip.y - 10, 0),
        background: '#16243a',
        color: '#fff',
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 12,
        pointerEvents: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,.2)',
        zIndex: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {tip.color && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: tip.color, marginRight: 6 }} />}
      {tip.lineas.map((l, i) => (
        <div key={i} style={{ fontWeight: i === 0 ? 700 : 400 }}>{l}</div>
      ))}
    </div>
  ) : null;
  return { ref, mostrar, ocultar, overlay };
}

const wrap: React.CSSProperties = { position: 'relative' };

// ---------------------------------------------------------------------------
// Barras mensuales comparativas (ingresos verde vs gastos rojo)
// ---------------------------------------------------------------------------
export interface BarrasMensualesProps {
  datos: Array<{ etiqueta: string; ingresos: number; gastos: number }>;
  alto?: number;
}

export const BarrasMensuales = memo(function BarrasMensuales({ datos, alto = 230 }: BarrasMensualesProps): React.ReactElement {
  const tt = useTooltip();
  const ancho = 760;
  const margen = { sup: 12, inf: 28, izq: 50, der: 8 };
  const w = ancho - margen.izq - margen.der;
  const h = alto - margen.sup - margen.inf;
  const max = Math.max(1, ...datos.map((d) => Math.max(d.ingresos, d.gastos)));
  const grupo = w / Math.max(1, datos.length);
  const barra = Math.min(22, grupo / 2.6);

  return (
    <div style={wrap} ref={tt.ref}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Ingresos y gastos por mes en euros">
        {[0, 0.5, 1].map((f) => {
          const y = margen.sup + h - h * f;
          return (
            <g key={f}>
              <line x1={margen.izq} y1={y} x2={ancho - margen.der} y2={y} stroke="#eef1f5" />
              <text x={margen.izq - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#99a">{fmtEje(max * f)}</text>
            </g>
          );
        })}
        {/* unidad del eje Y */}
        <text x={4} y={margen.sup + 4} fontSize={10} fill="#778">€</text>
        {datos.map((d, i) => {
          const x0 = margen.izq + grupo * i + grupo / 2;
          const hi = (d.ingresos / max) * h;
          const hg = (d.gastos / max) * h;
          const perdida = d.gastos > d.ingresos && (d.ingresos > 0 || d.gastos > 0);
          const lineas = [d.etiqueta, `Ingresos: ${eur2(d.ingresos)}`, `Gastos: ${eur2(d.gastos)}`, `Resultado: ${eur2(d.ingresos - d.gastos)}`];
          return (
            <g key={i} onMouseMove={(e) => tt.mostrar(e, lineas)} onMouseLeave={tt.ocultar}>
              {/* zona de hover invisible para todo el grupo */}
              <rect x={margen.izq + grupo * i} y={margen.sup} width={grupo} height={h} fill="transparent" />
              <rect x={x0 - barra - 2} y={margen.sup + h - hi} width={barra} height={hi} fill={VERDE} rx={2} />
              <rect x={x0 + 2} y={margen.sup + h - hg} width={barra} height={hg} fill={ROJO} rx={2} />
              {/* anotacion: mes en perdida */}
              {perdida && <text x={x0} y={margen.sup + h - Math.max(hi, hg) - 4} textAnchor="middle" fontSize={11} fill={ROJO}>▾</text>}
              <text x={x0} y={alto - 9} textAnchor="middle" fontSize={10} fill="#556">{d.etiqueta}</text>
            </g>
          );
        })}
        <text x={ancho / 2} y={alto} textAnchor="middle" fontSize={10} fill="#99a">Meses</text>
      </svg>
      {tt.overlay}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Linea de serie temporal (saldo de bancos) con linea de cero
// ---------------------------------------------------------------------------
export interface LineaSerieProps {
  puntos: Array<{ fecha: string; valor: number }>;
  alto?: number;
}

export const LineaSerie = memo(function LineaSerie({ puntos, alto = 210 }: LineaSerieProps): React.ReactElement {
  const tt = useTooltip();
  const ancho = 760;
  const margen = { sup: 12, inf: 26, izq: 56, der: 10 };
  const w = ancho - margen.izq - margen.der;
  const h = alto - margen.sup - margen.inf;
  const valores = puntos.map((p) => p.valor);
  const min = Math.min(0, ...valores); // incluye 0 para no exagerar la escala
  const max = Math.max(1, ...valores);
  const x = (i: number): number => margen.izq + (puntos.length <= 1 ? w / 2 : (w * i) / (puntos.length - 1));
  const y = (v: number): number => margen.sup + h - ((v - min) / (max - min || 1)) * h;
  const path = puntos.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`).join(' ');
  const area = puntos.length ? `${path} L${x(puntos.length - 1)},${y(min)} L${x(0)},${y(min)} Z` : '';

  return (
    <div style={wrap} ref={tt.ref}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Evolucion de saldo en bancos en euros">
        {[min, (min + max) / 2, max].map((v, i) => (
          <g key={i}>
            <line x1={margen.izq} y1={y(v)} x2={ancho - margen.der} y2={y(v)} stroke="#eef1f5" />
            <text x={margen.izq - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="#99a">{fmtEje(v)}</text>
          </g>
        ))}
        {/* linea de CERO destacada si hay negativos */}
        {min < 0 && (
          <>
            <line x1={margen.izq} y1={y(0)} x2={ancho - margen.der} y2={y(0)} stroke="#b3261e" strokeDasharray="4 3" strokeWidth={1} />
            <text x={ancho - margen.der} y={y(0) - 3} textAnchor="end" fontSize={9} fill="#b3261e">0 €</text>
          </>
        )}
        <text x={6} y={margen.sup + 4} fontSize={10} fill="#778">€</text>
        <path d={area} fill={AZUL} opacity={0.08} />
        <path d={path} fill="none" stroke={AZUL} strokeWidth={2.5} />
        {puntos.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.valor)}
            r={3.5}
            fill={AZUL}
            onMouseMove={(e) => tt.mostrar(e, [p.fecha, `Saldo: ${eur2(p.valor)}`], AZUL)}
            onMouseLeave={tt.ocultar}
          />
        ))}
        {puntos.length > 0 && (
          <>
            <text x={margen.izq} y={alto - 6} fontSize={10} fill="#778">{puntos[0].fecha}</text>
            <text x={ancho - margen.der} y={alto - 6} textAnchor="end" fontSize={10} fill="#778">{puntos[puntos.length - 1].fecha}</text>
          </>
        )}
      </svg>
      {tt.overlay}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Waterfall: del ingreso al resultado (Ingresos -> -Gastos -> Resultado)
// ---------------------------------------------------------------------------
export interface WaterfallProps {
  ingresos: number;
  gastos: number;
  alto?: number;
}

export const Waterfall = memo(function Waterfall({ ingresos, gastos, alto = 200 }: WaterfallProps): React.ReactElement {
  const tt = useTooltip();
  const resultado = ingresos - gastos;
  const ancho = 520;
  const margen = { sup: 14, inf: 28, izq: 50, der: 8 };
  const w = ancho - margen.izq - margen.der;
  const h = alto - margen.sup - margen.inf;
  const max = Math.max(1, ingresos);
  const y = (v: number): number => margen.sup + h - (v / max) * h;

  // 3 pasos: total ingresos, delta -gastos (flotante), total resultado
  const pasos = [
    { etiqueta: 'Ingresos', desde: 0, hasta: ingresos, color: VERDE, valor: ingresos },
    { etiqueta: 'Gastos', desde: ingresos - gastos, hasta: ingresos, color: ROJO, valor: -gastos },
    { etiqueta: 'Resultado', desde: 0, hasta: resultado, color: resultado >= 0 ? AZUL : ROJO, valor: resultado },
  ];
  const slot = w / 3;
  const barra = Math.min(70, slot * 0.55);

  return (
    <div style={wrap} ref={tt.ref}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Del ingreso al resultado">
        <line x1={margen.izq} y1={y(0)} x2={ancho - margen.der} y2={y(0)} stroke="#dde3ea" />
        <text x={6} y={margen.sup + 4} fontSize={10} fill="#778">€</text>
        {pasos.map((p, i) => {
          const cx = margen.izq + slot * i + slot / 2;
          const yTop = y(Math.max(p.desde, p.hasta));
          const altoBar = Math.max(2, Math.abs(y(p.hasta) - y(p.desde)));
          return (
            <g key={i} onMouseMove={(e) => tt.mostrar(e, [p.etiqueta, eur2(p.valor)], p.color)} onMouseLeave={tt.ocultar}>
              <rect x={cx - barra / 2} y={yTop} width={barra} height={altoBar} fill={p.color} rx={2} />
              <text x={cx} y={yTop - 5} textAnchor="middle" fontSize={11} fontWeight={700} fill={p.color}>{eur0(p.valor)}</text>
              <text x={cx} y={alto - 9} textAnchor="middle" fontSize={11} fill="#556">{p.etiqueta}</text>
            </g>
          );
        })}
      </svg>
      {tt.overlay}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Barras horizontales con porcentaje (analisis por cliente / proveedor)
// ---------------------------------------------------------------------------
export interface BarrasPorcentajeProps {
  filas: Array<{ nombre: string; importe: number; porcentaje: number }>;
}

export const BarrasPorcentaje = memo(function BarrasPorcentaje({ filas }: BarrasPorcentajeProps): React.ReactElement {
  return (
    <div>
      {filas.map((f, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }} title={`${f.nombre}: ${eur2(f.importe)} (${f.porcentaje.toFixed(1)}%)`}>
          <span style={{ width: 170, fontSize: 12, color: '#445', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: PALETA[i % PALETA.length], marginRight: 6 }} />
            {f.nombre}
          </span>
          <div style={{ flex: 1, background: '#eef1f5', borderRadius: 4, height: 16 }}>
            <div style={{ width: `${Math.max(2, f.porcentaje)}%`, background: PALETA[i % PALETA.length], height: 16, borderRadius: 4 }} />
          </div>
          <span style={{ width: 60, fontSize: 12, textAlign: 'right', color: '#445' }}>{f.porcentaje.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
});
