import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { generarPdfA } from '../utils/pdf-a';
import { sha256 } from '../utils/zip';
import { guardarArtefacto } from './registroMercantil.helpers';
import { fiscalYearsService } from './fiscalYears.service';
import { TipoLibro, TIPOS_LIBRO } from '../domain/registroMercantil.model';
import { generarLibroDiario, generarLibroInventarios, generarCuentasAnuales } from './cuentasAnuales.service';

const TITULO_LIBRO: Record<TipoLibro, string> = {
  DIARIO: 'Libro Diario',
  INVENTARIOS_CUENTAS_ANUALES: 'Libro de Inventarios y Cuentas Anuales',
  ACTAS: 'Libro de Actas',
  SOCIOS: 'Libro Registro de Socios / Acciones',
  CONTRATOS: 'Libro Registro de Contratos (sociedad unipersonal)',
};

/** Ejercicio (año) del fiscal year: label numérico, o el año de cierre/fin como respaldo. */
function ejercicioDe(fy: { label: string; closingDate: string | null; fechaFin?: string | null }): number {
  const n = Number(fy.label);
  if (Number.isFinite(n) && n > 1900) return n;
  const d = fy.closingDate ?? fy.fechaFin;
  return d ? new Date(d).getFullYear() : new Date().getFullYear();
}

const imp = (n: number): string => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cabecera(fy: { companyId: string; label: string; closingDate: string | null; fechaFin?: string | null }): string[] {
  return [
    `Empresa (companyId): ${fy.companyId}`,
    `Ejercicio: ${fy.label}`,
    `Fecha de cierre: ${fy.closingDate ?? fy.fechaFin ?? '-'}`,
    `Generado: ${new Date().toISOString()}`,
    '',
  ];
}

/** DIARIO: todos los asientos POSTED del ejercicio con sus apuntes y los totales. */
async function contenidoDiario(companyId: string, ejercicio: number): Promise<string[]> {
  const ld = await generarLibroDiario(companyId, ejercicio);
  if (ld.asientos.length === 0) return ['Sin asientos contabilizados en el ejercicio.'];

  const out: string[] = [];
  for (const a of ld.asientos) {
    out.push(`Asiento ${a.numero}  ${a.fecha}  ${a.concepto}`.trimEnd());
    for (const l of a.lineas) {
      out.push(`    ${String(l.subcuenta).padEnd(12)}  Debe ${imp(l.debe).padStart(14)}   Haber ${imp(l.haber).padStart(14)}`);
    }
  }
  out.push('', `${'TOTALES'.padEnd(18)}Debe ${imp(ld.totalDebe).padStart(14)}   Haber ${imp(ld.totalHaber).padStart(14)}`);
  return out;
}

/** INVENTARIOS Y CUENTAS ANUALES: balances de apertura/cierre por subcuenta + resumen de cuentas anuales. */
async function contenidoInventarios(companyId: string, ejercicio: number): Promise<string[]> {
  const inv = await generarLibroInventarios(companyId, ejercicio);
  const out: string[] = [];

  const bloque = (titulo: string, items: Array<{ codigo?: string; descripcion?: string; importe: number }>): void => {
    out.push(titulo);
    if (items.length === 0) out.push('  (sin saldos)');
    else for (const s of items) out.push(`    ${String(s.codigo).padEnd(12)} ${imp(s.importe).padStart(14)}   ${s.descripcion ?? ''}`.trimEnd());
    out.push('');
  };
  bloque('BALANCE DE APERTURA (saldos deudores)', inv.balanceApertura);
  bloque('BALANCE DE CIERRE (saldos deudores)', inv.balanceCierre);

  try {
    const ca = await generarCuentasAnuales(companyId, ejercicio);
    out.push('CUENTAS ANUALES (resumen)');
    if (ca.sociedad.denominacion || ca.sociedad.nif) out.push(`    ${ca.sociedad.denominacion} ${ca.sociedad.nif}`.trim());
    out.push(`    Resultado del ejercicio: ${imp(ca.aplicacionResultado.resultadoEjercicio)}`);
    out.push(`    Aplicación: a reservas ${imp(ca.aplicacionResultado.aReservas)} / a dividendos ${imp(ca.aplicacionResultado.aDividendos)}`);
  } catch {
    out.push('CUENTAS ANUALES: no disponibles (no se pudieron calcular los estados financieros).');
  }
  return out;
}

/**
 * Contenido REAL del libro según su tipo (ya no es stub):
 *  - DIARIO / INVENTARIOS_CUENTAS_ANUALES -> datos contables reales (asientos
 *    POSTED, saldos por subcuenta, cuentas anuales).
 *  - ACTAS / SOCIOS / CONTRATOS -> no hay módulo societario con datos: se genera
 *    un libro válido con cabecera y nota explícita (sin movimientos).
 * Si la carga de datos falla, degrada a "solo cabecera + motivo" (visible en el
 * PDF, no silencioso) para no abortar todo el expediente de legalización.
 */
export async function contenidoLibro(
  type: TipoLibro,
  fy: { companyId: string; label: string; closingDate: string | null; fechaFin?: string | null },
): Promise<string[]> {
  const head = cabecera(fy);
  try {
    if (type === 'DIARIO') return [...head, ...(await contenidoDiario(fy.companyId, ejercicioDe(fy)))];
    if (type === 'INVENTARIOS_CUENTAS_ANUALES') return [...head, ...(await contenidoInventarios(fy.companyId, ejercicioDe(fy)))];
    return [
      ...head,
      `El "${TITULO_LIBRO[type]}" no tiene un módulo de datos integrado en el sistema.`,
      'Libro generado sin movimientos registrados.',
    ];
  } catch (e) {
    return [...head, 'No se pudo cargar el contenido del libro:', `  ${(e as Error)?.message ?? String(e)}`, '', 'Libro generado solo con cabecera (revisar el origen de datos).'];
  }
}

export const booksService = {
  /**
   * Genera el PDF/A de cada libro solicitado. Exige que el ejercicio esté CERRADO.
   * Si ya existía una fila del libro (borrador PENDING creado al cerrar), la
   * actualiza a GENERATED; si no, la crea.
   */
  async generar(fyId: string, tipos: TipoLibro[]) {
    const fy = await fiscalYearsService.obtener(fyId);
    if (fy.estado !== 'CLOSED') throw badRequest('No se pueden generar libros: el ejercicio no está cerrado.');
    if (!Array.isArray(tipos) || tipos.length === 0) throw badRequest('Indica al menos un tipo de libro.');

    const invalidos = tipos.filter((t) => !TIPOS_LIBRO.includes(t));
    if (invalidos.length) throw badRequest(`Tipos de libro no válidos: ${invalidos.join(', ')}.`);

    const resultados = [];
    for (const type of tipos) {
      const pdf = await generarPdfA(TITULO_LIBRO[type], await contenidoLibro(type, fy));
      const hash = sha256(pdf);
      const filePath = await guardarArtefacto(fy.companyId, fyId, `libro-${type}.pdf`, pdf);

      const existente = await prisma.legalBook.findFirst({ where: { fiscalYearId: fyId, type } });
      const libro = existente
        ? await prisma.legalBook.update({
            where: { id: existente.id },
            data: { filePath, hash, format: 'PDF/A', status: 'GENERATED' },
          })
        : await prisma.legalBook.create({
            data: { companyId: fy.companyId, fiscalYearId: fyId, type, filePath, hash, format: 'PDF/A', status: 'GENERATED' },
          });

      resultados.push({ bookId: libro.id, type: libro.type, filePath: libro.filePath, format: libro.format, hash: libro.hash });
    }
    return resultados;
  },

  async listar(fyId: string) {
    return prisma.legalBook.findMany({ where: { fiscalYearId: fyId }, orderBy: { type: 'asc' } });
  },

  async obtener(bookId: string) {
    return prisma.legalBook.findUnique({ where: { id: bookId } });
  },
};
