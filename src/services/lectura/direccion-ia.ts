/**
 * La direccion separada que piden a Claude los lectores (ventas y gastos):
 * la definicion para la herramienta y la lectura de lo que devuelve.
 *
 * Sin dependencias (solo tipos): la usan los extractores de siempre, que no
 * pueden importar el resto de la lectura sin crear ciclos.
 */
import type { DireccionLeida } from './tipos';

/** Propiedades de la direccion en la herramienta de Claude (todas opcionales). */
export const PROPIEDADES_DIRECCION = {
  calle: { type: 'string', description: 'Calle o vía, con número, piso y puerta' },
  cp: { type: 'string', description: 'Código postal' },
  municipio: { type: 'string', description: 'Municipio o ciudad' },
  provincia: { type: 'string', description: 'Provincia, región o estado' },
  pais: { type: 'string', description: 'País, tal como aparece en el documento (omítelo si no aparece)' },
} as const;

const cadena = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : null);

/** Lo que devuelve Claude -> DireccionLeida; null si no trae ninguna parte. */
export function direccionDeIa(v: unknown): DireccionLeida | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d: DireccionLeida = {};
  for (const k of ['calle', 'cp', 'municipio', 'provincia', 'pais'] as const) {
    const valor = cadena(o[k]);
    if (valor) d[k] = valor;
  }
  return Object.keys(d).length ? d : null;
}
