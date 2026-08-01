import { generarLibroDiario } from './cuentasAnuales.service';
import { obtenerAsientosEjercicio } from './contabilidadDatos.service';
import { ReporteMargen } from '../domain/reportes.model';

const SEP = ';';

/** Escapa un campo CSV (separador ';'). */
function campo(v: unknown): string {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fila(valores: unknown[]): string {
  return valores.map(campo).join(SEP);
}

/** Libro Diario en CSV (una fila por apunte). */
export async function exportarLibroDiarioCSV(companyId: string, ejercicio: number): Promise<string> {
  const libro = await generarLibroDiario(companyId, ejercicio);
  const lineas = [fila(['fecha', 'numero', 'concepto', 'subcuenta', 'debe', 'haber'])];
  for (const a of libro.asientos) {
    for (const l of a.lineas) {
      lineas.push(fila([a.fecha, a.numero, a.concepto, l.subcuenta, l.debe, l.haber]));
    }
  }
  return lineas.join('\r\n') + '\r\n';
}

/** Libro Mayor de una cuenta/subcuenta (prefijo) en CSV, con saldo acumulado. */
export async function exportarMayorPorCuentaCSV(companyId: string, ejercicio: number, cuentaCodigo: string): Promise<string> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  asientos.sort((a, b) => (a.fecha === b.fecha ? Number(a.numero) - Number(b.numero) : a.fecha.localeCompare(b.fecha)));

  const lineas = [fila(['fecha', 'numero', 'concepto', 'subcuenta', 'debe', 'haber', 'saldo'])];
  let saldo = 0;
  for (const a of asientos) {
    for (const l of a.lineas) {
      if (!l.subcuenta.startsWith(cuentaCodigo)) continue;
      saldo = Math.round((saldo + l.debe - l.haber) * 100) / 100;
      lineas.push(fila([a.fecha, a.numero, a.concepto, l.subcuenta, l.debe, l.haber, saldo]));
    }
  }
  return lineas.join('\r\n') + '\r\n';
}

/** Reporte de margen en CSV. */
export function exportarReporteMargenCSV(reporte: ReporteMargen): string {
  const lineas = [fila(['clave', 'nombre', 'ventas', 'coste', 'margen', 'margen%'])];
  for (const f of reporte.filas) {
    lineas.push(fila([f.clave, f.nombre, f.ventas, f.coste, f.margen, f.margenPorcentaje]));
  }
  return lineas.join('\r\n') + '\r\n';
}
