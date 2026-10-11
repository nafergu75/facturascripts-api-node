/**
 * Comprobacion "dorada" de un fichero de la AEAT contra la tabla de campos de
 * su diseño de registro oficial (src/domain/aeat/*.json): longitud de cada
 * registro, constantes, blancos reservados, tipo de cada campo (An, A, Num, N),
 * alineacion, valores admitidos y los valores esperados de cada caso.
 */
import { expect } from '@jest/globals';
import type { CampoDr, DisenoDr, RegistroDr } from '../services/aeatRetenciones/diseno';

/** Estructura del diseño: campos seguidos, sin huecos ni solapes, que suman la longitud del registro. */
export function comprobarTablaDiseno(diseno: DisenoDr): void {
  for (const r of diseno.registros) {
    let pos = 1;
    for (const c of r.campos) {
      expect({ registro: r.id, campo: c.n, pos: c.pos }).toEqual({ registro: r.id, campo: c.n, pos });
      expect(c.lon).toBeGreaterThan(0);
      expect(['An', 'A', 'Num', 'N']).toContain(c.tipo);
      if (c.constante !== undefined) expect(c.constante).toHaveLength(c.lon);
      pos += c.lon;
    }
    expect({ registro: r.id, longitud: pos - 1 }).toEqual({ registro: r.id, longitud: r.longitud });
  }
}

const nombre = (c: CampoDr) => c.clave ?? c.casilla ?? `#${c.n}`;

/**
 * Comprueba un registro ya generado campo a campo. `esperados` va por la clave
 * o la casilla del campo (como en el JSON) y lleva el texto exacto que debe
 * haber en esas posiciones.
 */
export function comprobarRegistro(texto: string, registro: RegistroDr, esperados: Record<string, string> = {}): void {
  expect({ registro: registro.id, longitud: texto.length }).toEqual({ registro: registro.id, longitud: registro.longitud });
  const vistos = new Set<string>();
  for (const c of registro.campos) {
    const v = texto.slice(c.pos - 1, c.pos - 1 + c.lon);
    const id = { registro: registro.id, campo: c.n, nombre: nombre(c), pos: c.pos, valor: v };
    const falla = (motivo: string) => ({ ...id, motivo });
    if (c.constante !== undefined) {
      expect(id).toEqual({ ...id, valor: c.constante });
      continue;
    }
    if (c.blancos) {
      expect(id).toEqual({ ...id, valor: ' '.repeat(c.lon) });
      continue;
    }
    const blanco = /^ +$/.test(v);
    switch (c.tipo) {
      case 'Num':
        expect(falla(/^\d+$/.test(v) ? 'ok' : 'Num: solo cifras, a la derecha con ceros')).toEqual(falla('ok'));
        break;
      case 'N':
        expect(falla(/^(N\d+|\d+)$/.test(v) ? 'ok' : 'N: cifras con N delante si es negativo')).toEqual(falla('ok'));
        break;
      default: {
        if (c.libre) break;
        if (c.alinear === 'derecha') {
          expect(falla(blanco || /^[A-Z0-9]+$/.test(v) ? 'ok' : 'NIF a la derecha con ceros')).toEqual(falla('ok'));
          break;
        }
        const permitido = c.tipo === 'A' ? /^[A-ZÑÇ ]*$/ : /^[A-Z0-9ÑÇ ]*$/;
        expect(falla(permitido.test(v) ? 'ok' : `${c.tipo}: solo letras${c.tipo === 'An' ? ', cifras' : ''} y blancos en mayúsculas`)).toEqual(falla('ok'));
        expect(falla(blanco || !v.startsWith(' ') ? 'ok' : 'alineado a la izquierda')).toEqual(falla('ok'));
      }
    }
    if (c.valores && !(blanco && c.tipo !== 'Num')) expect(falla(c.valores.includes(v) ? 'ok' : `valor no admitido: ${c.valores.join(', ')}`)).toEqual(falla('ok'));
    const k = nombre(c);
    if (k in esperados) {
      vistos.add(k);
      expect(id).toEqual({ ...id, valor: esperados[k] });
    }
  }
  // Todos los esperados corresponden a algun campo del diseño.
  expect(Object.keys(esperados).filter((k) => !vistos.has(k))).toEqual([]);
}

/** Importe en centimos con ceros a la izquierda (como lo escribe la AEAT). */
export const cents = (euros: number, lon: number) => String(Math.round(euros * 100)).padStart(lon, '0');
