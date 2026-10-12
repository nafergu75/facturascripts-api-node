/**
 * De donde salen las cifras del ejercicio anterior (columna N-1 de los
 * informes, las cuentas anuales, el Modelo 200 y el libro de inventarios).
 * Regla unica:
 *
 *  1. Si ese año lo llevo la gestoria (llevanza EXTERNA): los saldos que dio
 *     la gestoria (comparativo importado), aunque tambien se importara su
 *     diario como historico.
 *  2. Si tiene asientos en la app: los asientos.
 *  3. Si no: el comparativo importado, si lo hay.
 */
import type { SaldosEjercicio } from './contabilidadDatos.service';
import { llevanzaExterna } from './periodos.service';
import { saldosComparativosImportados } from './puestaEnMarcha/puestaEnMarcha.service';

export type FuenteAnterior = 'COMPARATIVO' | 'ASIENTOS' | 'NINGUNA';

export interface SaldosAnteriores {
  fuente: FuenteAnterior;
  saldos: SaldosEjercicio;
  /** El año lo llevo la gestoria (solo lectura en la app). */
  llevanzaExterna: boolean;
}

const vacio = (s: SaldosEjercicio) => s.balance.size === 0 && s.pyg.size === 0;

/**
 * Saldos de `ejercicio` para usarlos como año anterior. `desdeAsientos` son los
 * saldos que salen de los asientos de la app (ya calculados por quien llama).
 */
export async function fuenteEjercicioAnterior(companyId: string, ejercicio: number, desdeAsientos: SaldosEjercicio): Promise<SaldosAnteriores> {
  const externa = await llevanzaExterna(companyId, ejercicio);
  if (externa) {
    const importados = await saldosComparativosImportados(companyId, ejercicio);
    if (importados) return { fuente: 'COMPARATIVO', saldos: importados, llevanzaExterna: true };
  }
  if (!vacio(desdeAsientos)) return { fuente: 'ASIENTOS', saldos: desdeAsientos, llevanzaExterna: externa };
  const importados = externa ? null : await saldosComparativosImportados(companyId, ejercicio);
  if (importados) return { fuente: 'COMPARATIVO', saldos: importados, llevanzaExterna: externa };
  return { fuente: 'NINGUNA', saldos: desdeAsientos, llevanzaExterna: externa };
}
