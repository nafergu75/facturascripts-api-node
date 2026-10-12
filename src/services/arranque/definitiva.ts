/**
 * Repetir la carga (otra provisional o la definitiva, cuando la gestoria
 * cierre de verdad): que cambia frente a la carga vigente y como se aplica.
 *
 *  - Comparacion por subcuenta de la apertura vigente con la nueva: lo que
 *    tenia, lo que trae y la diferencia, y si la subcuenta ya tiene apuntes de
 *    2027.
 *  - La apertura se REEMPLAZA (se anula y se pone la nueva) si enero de 2027
 *    esta abierto. Si esta bloqueado (por ejemplo, con el 303 del 1T ya
 *    presentado), va un asiento COMPLEMENTARIO de apertura (APAJ) solo con las
 *    diferencias, con un motivo; y no puede tocar el IVA (472 y 477).
 *  - Los bancos (572) no pueden cambiar: el saldo a 31-12 es un hecho.
 *  - Facturas pendientes con cobros o pagos de 2027, o con abonos del proveedor
 *    ya descontados: siguen si la nueva cartera las trae igual; si desaparecen
 *    o cambian, error con la lista.
 *  - Bienes con amortizacion apuntada en 2027: igual.
 */
import { prisma } from '../../config/database';
import { FILTRO_ASIENTOS_APERTURA } from '../../domain/asientosCierre';
import { aCentimos, importeTexto } from '../../utils/money';
import { rangoEjercicio } from '../puestaEnMarcha/asientosEnBloque';
import { partidasConMovimientos } from './partidas.service';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const lista = (xs: string[]) => (xs.length > 10 ? `${xs.slice(0, 10).join(', ')} y ${xs.length - 10} más` : xs.join(', '));

export type ModoApertura = 'NUEVA' | 'REEMPLAZAR' | 'COMPLEMENTARIO';

export interface DiferenciaSubcuenta {
  subcuenta: string;
  nombre: string;
  /** Saldo en la apertura vigente (deudor > 0). */
  anterior: number;
  nuevo: number;
  diferencia: number;
  /** Apuntes de 2027 en esa subcuenta, sin contar la apertura. */
  movimientos2027: number;
}

export interface AnalisisRepeticion {
  modo: ModoApertura;
  /** Solo las subcuentas que cambian. */
  comparacion: DiferenciaSubcuenta[];
  /** Lineas del asiento complementario (modo COMPLEMENTARIO). */
  ajuste: Array<{ cuenta: string; nombre: string; debe: number; haber: number }>;
  /** Partidas de la carga vigente con cobros o pagos que siguen (la nueva cartera las trae igual). */
  partidasMantenidas: Array<{ id: string; clave: string }>;
  /** Bienes de la carga vigente con amortizacion apuntada que siguen igual. */
  activosMantenidos: Array<{ id: string; clave: string }>;
  errores: string[];
}

export const clavePartida = (p: { tipo: string; subcuenta: string; documento: string }) => `${p.tipo}|${p.subcuenta}|${p.documento}`;
export const claveActivo = (a: { descripcion: string; cuentaBien: string }) => `${a.descripcion.trim().toLowerCase()}|${a.cuentaBien}`;

interface Entrada {
  companyId: string;
  ejercicio: number;
  vigente: { id: string; version: number } | null;
  /** Lineas de la apertura nueva (null si la carga no trae saldos). */
  apertura: Array<{ cuenta: string; nombre: string; debe: number; haber: number }> | null;
  /** Hay apertura del ejercicio ya puesta (de una carga o de la puesta en marcha). */
  hayAperturaPrevia: boolean;
  eneroNoAbierto: boolean;
  motivoAjuste: string | null;
  /** Partidas nuevas (null si la carga no trae cartera). */
  partidas: Array<{ tipo: string; subcuenta: string; documento: string; pendiente: number }> | null;
  /** Bienes nuevos (null si la carga no trae inmovilizado o se deja fuera). */
  activos: Array<{ descripcion: string; cuentaBien: string; coste: number; amortAcumulada: number }> | null;
}

export async function analizarRepeticion(e: Entrada): Promise<AnalisisRepeticion> {
  const errores: string[] = [];
  const out: AnalisisRepeticion = { modo: 'NUEVA', comparacion: [], ajuste: [], partidasMantenidas: [], activosMantenidos: [], errores };
  const anio = e.ejercicio - 1;

  // Apertura: reemplazar o complementario.
  if (e.apertura && e.eneroNoAbierto) {
    if (!e.vigente) {
      errores.push(`Enero de ${e.ejercicio} está bloqueado: la apertura del 1-1-${e.ejercicio} no se puede poner ni cambiar. Desbloquéalo en Configuración > Ejercicios y periodos.`);
    } else out.modo = 'COMPLEMENTARIO';
  } else if (e.apertura && e.hayAperturaPrevia) out.modo = 'REEMPLAZAR';

  if (e.vigente && e.apertura) {
    const previas = await prisma.journalEntryLine.findMany({
      where: { companyId: e.companyId, entry: { estado: 'POSTED', ...FILTRO_ASIENTOS_APERTURA, fecha: rangoEjercicio(e.ejercicio) } },
      select: { accountCode: true, accountName: true, debe: true, haber: true },
    });
    const antes = new Map<string, { saldo: number; nombre: string }>();
    for (const l of previas) {
      const x = antes.get(l.accountCode) ?? { saldo: 0, nombre: l.accountName };
      x.saldo = r2(x.saldo + Number(l.debe) - Number(l.haber));
      antes.set(l.accountCode, x);
    }
    const ahora = new Map<string, { saldo: number; nombre: string }>();
    for (const l of e.apertura) {
      const x = ahora.get(l.cuenta) ?? { saldo: 0, nombre: l.nombre };
      x.saldo = r2(x.saldo + l.debe - l.haber);
      ahora.set(l.cuenta, x);
    }
    const codigos = [...new Set([...antes.keys(), ...ahora.keys()])].sort();
    const cambian = codigos.filter((c) => aCentimos(antes.get(c)?.saldo ?? 0) !== aCentimos(ahora.get(c)?.saldo ?? 0));
    const usados = cambian.length
      ? await prisma.journalEntryLine.groupBy({
          by: ['accountCode'],
          where: { companyId: e.companyId, accountCode: { in: cambian }, entry: { estado: 'POSTED', fecha: rangoEjercicio(e.ejercicio), NOT: FILTRO_ASIENTOS_APERTURA } },
          _count: { _all: true },
        })
      : [];
    const movs = new Map(usados.map((u) => [u.accountCode, u._count._all]));
    out.comparacion = cambian.map((c) => {
      const anterior = antes.get(c)?.saldo ?? 0;
      const nuevo = ahora.get(c)?.saldo ?? 0;
      return { subcuenta: c, nombre: ahora.get(c)?.nombre || antes.get(c)?.nombre || '', anterior, nuevo, diferencia: r2(nuevo - anterior), movimientos2027: movs.get(c) ?? 0 };
    });
    const bancos = out.comparacion.filter((d) => d.subcuenta.startsWith('572'));
    if (bancos.length) {
      errores.push(
        `El saldo de los bancos a 31-12-${anio} no puede cambiar de una carga a otra (es lo que dice el banco): ${lista(bancos.map((d) => `${d.subcuenta} (${importeTexto(d.anterior)} y ahora ${importeTexto(d.nuevo)})`))}. Uno de los dos ficheros está mal: revísalo con la gestoría.`,
      );
    }
    if (out.modo === 'COMPLEMENTARIO') {
      const iva = out.comparacion.filter((d) => /^47[27]/.test(d.subcuenta));
      if (iva.length) {
        errores.push(
          `Enero de ${e.ejercicio} está bloqueado y la diferencia toca el IVA (${lista(iva.map((d) => d.subcuenta))}): no se puede ajustar sin cambiar el 303 ya presentado. Consúltalo con la gestoría.`,
        );
      }
      if (!e.motivoAjuste) {
        errores.push(`Enero de ${e.ejercicio} está bloqueado: la diferencia irá en un asiento de ajuste de la apertura (1-1-${e.ejercicio}). Escribe el motivo del ajuste (queda guardado).`);
      }
      out.ajuste = out.comparacion
        .filter((d) => aCentimos(d.diferencia) !== 0)
        .map((d) => ({ cuenta: d.subcuenta, nombre: d.nombre, debe: d.diferencia > 0 ? d.diferencia : 0, haber: d.diferencia < 0 ? -d.diferencia : 0 }));
    }
  }

  if (e.vigente) {
    // Facturas pendientes de la carga vigente con cobros o pagos de 2027, o con abonos ya descontados.
    const partidas = await prisma.partidaPendiente.findMany({
      where: { companyId: e.companyId, cargaId: e.vigente.id, estado: { not: 'ANULADA' } },
      select: { id: true, tipo: true, subcuenta: true, numeroDocumento: true, importePendiente: true },
    });
    const movimientos = await partidasConMovimientos(prisma, e.companyId, partidas.map((p) => p.id));
    const nuevas = new Map((e.partidas ?? []).map((p) => [clavePartida(p), p]));
    const problemas: string[] = [];
    let conAbonos = false;
    for (const p of partidas.filter((x) => movimientos.has(x.id))) {
      const clave = clavePartida({ tipo: p.tipo, subcuenta: p.subcuenta, documento: p.numeroDocumento });
      if (!e.partidas) {
        out.partidasMantenidas.push({ id: p.id, clave });
        continue;
      }
      const n = nuevas.get(clave);
      if (n && aCentimos(n.pendiente) === aCentimos(Number(p.importePendiente))) {
        out.partidasMantenidas.push({ id: p.id, clave });
        continue;
      }
      const abonos = movimientos.get(p.id)!.abonos;
      if (aCentimos(abonos) !== 0) conAbonos = true;
      const descontado = aCentimos(abonos) !== 0 ? `, con ${importeTexto(Math.abs(abonos))} descontados con abonos` : '';
      problemas.push(`${p.numeroDocumento} (${p.subcuenta})${n ? `: pendiente ${importeTexto(Number(p.importePendiente))} y ahora ${importeTexto(n.pendiente)}` : ': ya no está'}${descontado}`);
    }
    if (problemas.length) {
      const que = conAbonos ? 'cobros, pagos o abonos descontados' : 'cobros o pagos';
      const anular = conAbonos
        ? 'Anula antes esos cobros o pagos, y la aplicación de los abonos en su ficha de Compras («Aplicado a otras facturas»)'
        : 'Anula antes esos cobros o pagos';
      errores.push(
        `${problemas.length === 1 ? `Una factura pendiente que ya tiene ${que} de ${e.ejercicio} cambia` : `${problemas.length} facturas pendientes que ya tienen ${que} de ${e.ejercicio} cambian`} en la cartera nueva: ${lista(problemas)}. ${anular}, o pide a la gestoría que la cartera las traiga igual.`,
      );
    }

    // Bienes de la carga vigente con amortizacion apuntada.
    const activos = await prisma.activoFijo.findMany({
      where: { companyId: e.companyId, cargaId: e.vigente.id, activo: true, dotaciones: { some: { anulada: false } } },
      select: { id: true, descripcion: true, subcuentaBien: true, coste: true, amortAcumuladaInicial: true },
    });
    const bienes = new Map((e.activos ?? []).map((a) => [claveActivo(a), a]));
    const cambian: string[] = [];
    for (const a of activos) {
      const clave = claveActivo({ descripcion: a.descripcion, cuentaBien: a.subcuentaBien });
      if (!e.activos) {
        out.activosMantenidos.push({ id: a.id, clave });
        continue;
      }
      const n = bienes.get(clave);
      if (n && aCentimos(n.coste) === aCentimos(Number(a.coste)) && aCentimos(n.amortAcumulada) === aCentimos(Number(a.amortAcumuladaInicial))) out.activosMantenidos.push({ id: a.id, clave });
      else cambian.push(a.descripcion);
    }
    if (cambian.length) {
      errores.push(
        `${cambian.length === 1 ? 'Un bien que ya tiene amortización apuntada en ' + e.ejercicio + ' cambia' : `${cambian.length} bienes que ya tienen amortización apuntada en ${e.ejercicio} cambian`} en el inmovilizado nuevo: ${lista(cambian)}. Anula antes esa amortización (Contabilidad > Inmovilizado) o pide a la gestoría que los traiga igual.`,
      );
    }
  }
  return out;
}
