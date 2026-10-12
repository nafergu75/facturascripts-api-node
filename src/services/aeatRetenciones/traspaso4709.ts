/**
 * Retención de abonos que no cabe en el 111 o el 115 de su periodo (decisión
 * P1 de la especificación de abonos, secciones 8.1 y 10.5).
 *
 * El abono de un profesional o de un alquiler apunta su retención al debe de
 * la 4751. El modelo la resta casilla a casilla y como mucho hasta cero; lo
 * que sobra (`excesoAbonos`) no se resta en ningún periodo: se recupera
 * pidiendo la rectificación del 111 o 115 en que se declaró. Tras pagar el
 * modelo, ese exceso queda como saldo deudor en la 4751, y en realidad es un
 * crédito contra Hacienda: este asiento lo pasa a la 4709 (Hacienda Pública,
 * deudora por devolución de impuestos).
 *
 *   Debe 4709 / Haber 4751, por el exceso.
 *
 * Un traspaso por modelo y periodo: el asiento lleva invoiceType
 * TRASPASO_4709 e invoiceId «111-2027-2T». Anularlo lo deja REVERSED (o hace
 * un contraasiento si su periodo ya está cerrado) y se puede volver a hacer.
 */
import { prisma } from '../../config/database';
import { badRequest, conflict } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { crearAsientoConApuntes } from '../asientos.service';
import { comprobarFechaAbierta } from '../periodos.service';
import { registrarAuditoria } from '../auditoria.service';
import { declaracionRetenciones } from '../impuestosModulo.service';
import { periodoFiscal } from '../nominas/fiscal';
import { asegurarCuentas, prepararPlanEmpresa } from '../nominas/plan';
import { conReintento, fechaAnulacionPara, OPCIONES_TX, revertirAsiento, validarFecha } from '../nominas/tesoreria';

export type CodigoRetenciones = '111' | '115';

const TIPO = 'TRASPASO_4709';
const TIPO_ANULADO = 'TRASPASO_4709_ANULADO';
export const CUENTA_4709 = '4709';
const NOMBRE_4709 = 'Hacienda Pública, deudora por devolución de impuestos';
const NOMBRE_4751 = 'Hacienda Pública, acreedora por retenciones practicadas';

/** '2t' -> '2T'; '4' -> '04' (como periodoRetenciones de tax-models, sin importarlo: lo importa a su vez). */
function periodoRetenciones(entrada: string): string {
  const p = String(entrada ?? '').toUpperCase().trim();
  if (/^[1-4]T$/.test(p)) return p;
  if (/^(0?[1-9]|1[0-2])$/.test(p)) return p.padStart(2, '0');
  throw badRequest(`Periodo "${entrada}" no válido: usa un trimestre (1T a 4T) o un mes (01 a 12).`);
}

const clave = (codigo: CodigoRetenciones, ejercicio: number, periodo: string) => `${codigo}-${ejercicio}-${periodo}`;

/**
 * Periodos que se solapan con uno: el mismo, y su trimestre si es un mes o
 * sus tres meses si es un trimestre. Un mismo exceso no se pasa dos veces a la
 * 4709 pidiendo el mes y el trimestre que lo contiene (p. ej. tras cambiar de
 * periodicidad a mitad de año).
 */
function periodosSolapados(periodo: string): string[] {
  const t = /^([1-4])T$/.exec(periodo);
  if (t) return [periodo, ...[1, 2, 3].map((i) => String((Number(t[1]) - 1) * 3 + i).padStart(2, '0'))];
  return [periodo, `${Math.ceil(Number(periodo) / 3)}T`];
}

/** Traspaso vigente del mismo modelo en ese periodo o en uno que se solapa. */
async function traspasoQueSolapa(db: Pick<typeof prisma, 'journalEntry'>, companyId: string, codigo: CodigoRetenciones, ejercicio: number, periodo: string) {
  const claves = periodosSolapados(periodo).map((p) => clave(codigo, ejercicio, p));
  const a = await db.journalEntry.findFirst({
    where: { companyId, invoiceType: TIPO, invoiceId: { in: claves }, estado: { not: 'REVERSED' } },
    select: { id: true, numeroAsiento: true, invoiceId: true },
  });
  if (!a) return null;
  const suyo = (a.invoiceId ?? '').split('-')[2] ?? periodo;
  const texto =
    suyo === periodo
      ? `La retención de abonos del ${codigo} ${delPeriodo(ejercicio, periodo)} ya está pasada a la 4709 (asiento ${a.numeroAsiento}).`
      : `La retención de abonos de ese periodo ya está pasada a la 4709 con el ${codigo} ${delPeriodo(ejercicio, suyo)} (asiento ${a.numeroAsiento}).`;
  return { asientoId: a.id, texto };
}
const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** «del 2T de 2027» o «de abril de 2027». */
const delPeriodo = (ejercicio: number, p: string) => (/^\d{2}$/.test(p) ? `de ${MESES[Number(p) - 1]} de ${ejercicio}` : `del ${p} de ${ejercicio}`);

export interface Traspaso4709 {
  asientoId: string;
  numero: string;
  fecha: string;
  importe: number;
}

/** El asiento de traspaso vigente de un modelo y periodo, o null. */
export async function traspaso4709De(companyId: string, codigo: CodigoRetenciones, ejercicio: number, periodo: string): Promise<Traspaso4709 | null> {
  const a = await prisma.journalEntry.findFirst({
    where: { companyId, invoiceType: TIPO, invoiceId: clave(codigo, ejercicio, periodo), estado: { not: 'REVERSED' } },
    include: { lineas: { where: { accountCode: CUENTA_4709 } } },
  });
  if (!a) return null;
  return { asientoId: a.id, numero: a.numeroAsiento, fecha: a.fecha.toISOString().slice(0, 10), importe: a.lineas.reduce((s, l) => s + Number(l.debe), 0) };
}

/** Exceso de retención de abonos del 111 o 115 de un periodo (el de su declaración: presentada o calculada). */
export async function excesoRetencionAbonos(companyId: string, codigo: CodigoRetenciones, ejercicio: number, periodo: string): Promise<number> {
  const { datos } = await declaracionRetenciones(companyId, codigo, ejercicio, periodo);
  return Number((datos as { excesoAbonos?: number }).excesoAbonos ?? 0);
}

/**
 * La 4751 que usaron los abonos del periodo (su línea al debe en el asiento
 * de la factura); si no se encuentra, la 4751 del motor contable.
 */
async function cuenta4751DeAbonos(companyId: string, desde: string, hasta: string): Promise<string> {
  const lineas = await prisma.journalEntryLine.findMany({
    where: {
      companyId,
      accountCode: { startsWith: '4751' },
      debe: { gt: 0 },
      entry: { origen: 'FACTURA_GASTO', estado: 'POSTED', fecha: { gte: new Date(`${desde}T00:00:00Z`), lte: new Date(`${hasta}T23:59:59Z`) } },
    },
    select: { accountCode: true },
    take: 500,
  });
  const veces = new Map<string, number>();
  for (const l of lineas) veces.set(l.accountCode, (veces.get(l.accountCode) ?? 0) + 1);
  return [...veces].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '4751';
}

/**
 * Crea el asiento Debe 4709 / Haber 4751 por el exceso de retención de abonos
 * del 111 o 115 de un periodo. Fecha: la indicada o el último día del periodo
 * (tiene que estar abierta y no ser anterior al periodo).
 */
export async function traspasarExcesoA4709(
  companyId: string,
  codigo: CodigoRetenciones,
  ejercicio: number,
  periodoEntrada: string,
  opciones: { fecha?: string | null; userId?: string } = {},
): Promise<{ codigo: CodigoRetenciones; ejercicio: number; periodo: string; importe: number; cuenta4751: string; asiento: Traspaso4709 }> {
  const periodo = periodoRetenciones(periodoEntrada);
  const p = periodoFiscal(ejercicio, periodo);
  const ya = await traspasoQueSolapa(prisma, companyId, codigo, ejercicio, periodo);
  if (ya) throw conflict(ya.texto, { motivo: 'ya_traspasado', asientoId: ya.asientoId });
  const exceso = await excesoRetencionAbonos(companyId, codigo, ejercicio, periodo);
  const centimos = aCentimos(exceso);
  if (centimos <= 0) {
    throw conflict(`En el ${codigo} ${delPeriodo(ejercicio, periodo)} no hay retención de abonos que pasar a la 4709: los abonos caben en el modelo.`, { motivo: 'sin_exceso' });
  }
  const fecha = opciones.fecha ? validarFecha(opciones.fecha) : p.fechaFin;
  if (fecha < p.fechaInicio) throw badRequest(`La fecha del asiento no puede ser anterior al periodo (${p.fechaInicio.split('-').reverse().join('/')}).`, { campo: 'fecha' });
  await comprobarFechaAbierta(companyId, fecha, 'pasar la retención a la 4709');
  const cuenta4751 = await cuenta4751DeAbonos(companyId, p.fechaInicio, p.fechaFin);
  await prepararPlanEmpresa(companyId);
  const importe = centimos / 100;

  const asiento = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      // Dos peticiones a la vez: se vuelve a mirar dentro de la transacción.
      const otro = await traspasoQueSolapa(tx, companyId, codigo, ejercicio, periodo);
      if (otro) throw conflict(otro.texto, { motivo: 'ya_traspasado' });
      await asegurarCuentas(tx, companyId, [
        { codigo: CUENTA_4709, nombre: NOMBRE_4709 },
        { codigo: cuenta4751, nombre: NOMBRE_4751 },
      ]);
      const creado = await crearAsientoConApuntes(companyId, {
        tx,
        fecha,
        concepto: `Retención de abonos del ${codigo} ${delPeriodo(ejercicio, periodo)} que no se pudo restar: pasa a la 4709`,
        apuntes: [
          { subcuenta: CUENTA_4709, concepto: NOMBRE_4709, debe: importe, haber: 0 },
          { subcuenta: cuenta4751, concepto: NOMBRE_4751, debe: 0, haber: importe },
        ],
        origen: 'AJUSTE_MANUAL',
        invoiceId: clave(codigo, ejercicio, periodo),
        invoiceType: TIPO,
        referencia: `${codigo} ${periodo}/${ejercicio}`,
        exigirCuadre: true,
      });
      return { asientoId: String(creado.asiento.idasiento), numero: String(creado.asiento.numero), fecha, importe };
    }, OPCIONES_TX),
  );
  await registrarAuditoria({
    userId: opciones.userId ?? 'SYSTEM',
    companyId,
    action: 'TRASPASO_4709',
    resourceType: 'JournalEntry',
    resourceId: asiento.asientoId,
    meta: { modelo: codigo, ejercicio, periodo, importe, cuenta4751 },
  });
  return { codigo, ejercicio, periodo, importe, cuenta4751, asiento };
}

/** Anula el traspaso a la 4709 de un modelo y periodo (REVERSED o contraasiento si su periodo está cerrado). */
export async function anularTraspaso4709(
  companyId: string,
  codigo: CodigoRetenciones,
  ejercicio: number,
  periodoEntrada: string,
  opciones: { fecha?: string | null; userId?: string } = {},
): Promise<{ revertido: string | null; contraasiento: { id: string; numero: string } | null }> {
  const periodo = periodoRetenciones(periodoEntrada);
  const t = await traspaso4709De(companyId, codigo, ejercicio, periodo);
  if (!t) throw conflict(`La retención de abonos del ${codigo} ${delPeriodo(ejercicio, periodo)} no está pasada a la 4709.`, { motivo: 'sin_traspaso' });
  const { abiertos, fechaAnulacion } = await fechaAnulacionPara(companyId, [t.fecha], opciones.fecha ?? undefined);
  const r = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      const rev = await revertirAsiento(tx, companyId, t.asientoId, {
        abierto: abiertos.get(t.fecha) ?? true,
        fechaAnulacion,
        origen: 'AJUSTE_MANUAL',
        invoiceType: TIPO_ANULADO,
        invoiceId: clave(codigo, ejercicio, periodo),
      });
      // Con contraasiento el original sigue POSTED: deja de contar como traspaso del periodo.
      if (rev.contraasiento) await tx.journalEntry.update({ where: { id: t.asientoId }, data: { invoiceType: TIPO_ANULADO } });
      return rev;
    }, OPCIONES_TX),
  );
  await registrarAuditoria({
    userId: opciones.userId ?? 'SYSTEM',
    companyId,
    action: 'ANULAR_TRASPASO_4709',
    resourceType: 'JournalEntry',
    resourceId: t.asientoId,
    meta: { modelo: codigo, ejercicio, periodo, importe: t.importe },
  });
  return r;
}

/** Texto de la pantalla del 111/115 con el exceso: qué hacer y si ya está hecho. */
export function textoExceso(codigo: CodigoRetenciones, exceso: number, hecho: Traspaso4709 | null): string {
  if (!hecho) return `Hay ${eur(exceso)} de retención de abonos que no caben en este ${codigo}. Cuando lo presentes, pásalos de la 4751 a la 4709 con «Pasar a la 4709».`;
  if (Math.round(hecho.importe * 100) === Math.round(exceso * 100)) {
    return `Los ${eur(exceso)} de retención de abonos que no caben en este ${codigo} ya están pasados de la 4751 a la 4709 (asiento ${hecho.numero}).`;
  }
  return Math.round(exceso * 100) > 0
    ? `El traspaso a la 4709 (asiento ${hecho.numero}, ${eur(hecho.importe)}) ya no coincide con lo que ahora no cabe en este ${codigo} (${eur(exceso)}): anúlalo y vuelve a hacerlo.`
    : `El traspaso a la 4709 (asiento ${hecho.numero}, ${eur(hecho.importe)}) ya no hace falta: ahora los abonos caben en este ${codigo}. Anúlalo.`;
}
