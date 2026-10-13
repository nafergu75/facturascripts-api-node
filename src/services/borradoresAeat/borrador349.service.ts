/**
 * Borrador del modelo 349 (operaciones intracomunitarias) con el diseno
 * oficial: las mismas cifras salen en pantalla y en el fichero, porque la
 * pantalla lee el fichero generado (aeat/modelo349/modelo349.dr.ts).
 *
 * De donde sale cada dato:
 *  - Ventas: las facturas emitidas del periodo por fecha de devengo y su tipo
 *    de operacion (E entregas de bienes, S servicios), con el NIF-IVA y el pais
 *    del cliente (impuestosCalculo.obtenerFacturasFiscales).
 *  - Compras (desde 2027): las facturas de gasto por fecha contable a un
 *    proveedor de otro pais de la UE (pais ISO-2 de la ficha o prefijo del
 *    NIF-IVA). Clave A (bienes) o I (servicios): la de la factura
 *    (ExpenseInvoice.clave349) o, si no la tiene, COMPRA = A y el resto = I.
 *    Antes de 2027 se mantiene la clasificacion de siempre (solo A).
 *  - Rectificaciones: una rectificativa de venta cuya factura original se
 *    devengo en un periodo anterior, o una compra anulada con contraasiento en
 *    este periodo cuya fecha contable es anterior, va en un registro de
 *    rectificacion de ese periodo. Base anterior: la del 349 presentado de ese
 *    periodo (o, si no consta, la calculada con las facturas); base
 *    rectificada = anterior + la diferencia.
 */
import { prisma } from '../../config/database';
import { repartirCentimos } from '../../domain/importesFactura';
import { estadosEnRectificacion } from '../declaracionesAeat/declaraciones.service';
import { importeTexto } from '../../utils/money';
import { badRequest } from '../../utils/http-errors';
import { aparicionesEntre, fechaContableGasto, whereGastosFiscales } from '../../domain/factura-gasto.model';
import { fechaDevengoVenta, paisDelCliente, PAISES_UE } from '../../domain/tipo-operacion.model';
import { clasificarOperacion, clave349De, exigirModelosAeat, INICIO_COMPRAS_ISO2, obtenerFacturasFiscales } from '../impuestosCalculo.service';
import { periodoFiscal } from '../nominas/fiscal';
import type { PeriodoFiscal } from '../../domain/impuestos.model';
import {
  ERROR_SIN_REGISTROS_349,
  ErrorEntrada349,
  erroresEntrada349,
  MESES_CAMBIO_PERIODICIDAD_349,
  generarFichero349,
  leerFichero349,
  type Clave349,
  type Entrada349,
  type Operador349,
  type Pantalla349,
  type Rectificacion349,
} from '../../aeat/modelo349/modelo349.dr';
import { ErrorDisenoRegistro } from '../../aeat/common/disenoRegistro';
import { separarNifIva } from '../../aeat/common/normalizacion';
import {
  AVISO_SIN_NUMERO,
  avisoPresentado,
  declaracionInformativa,
  declaranteEmpresa,
  erroresContacto,
  exigirNumero,
  filaModelo,
  opcionesDe,
  presentacionDe,
  registrosElegidos,
  type FilaCalendario,
} from './comun';

// Desde INICIO_COMPRAS_ISO2 las compras se clasifican por el pais ISO-2 y llevan A o I
// (el mismo dia y el mismo criterio que en el 303 y el 390: clasificarCompra).

/** Una factura (o su anulacion) en el 349 del periodo. */
export interface Movimiento349 {
  /** Id de la factura de gasto (solo compras: para cambiar su clave A/I). */
  id?: string;
  factura: string;
  tipo: 'venta' | 'compra';
  fecha: string;
  nifIva: string;
  pais: string | null;
  nombre: string;
  clave: Clave349;
  base: number;
  /** Periodo anterior que rectifica (si no, va en las operaciones del periodo). */
  rectifica?: { ejercicio: number; periodo: string };
  /** Abono de una factura de fuera de la app: la base declarada de su periodo hay que pedirla. */
  fuera?: boolean;
  /** Aviso del movimiento (un rappel que abarca varios periodos del 349). */
  aviso?: string;
}

export interface Borrador349 {
  ejercicio: number;
  periodo: string;
  estado: string;
  /** Presentado con una complementaria, sustitutiva o rectificativa en preparación (si no, null). */
  estadoTexto: string | null;
  /** Tipo y anterior salen del historial de declaraciones (B4); cambioPeriodicidad, de las opciones. */
  opciones: { tipoDeclaracion: 'C' | 'S' | null; declaracionAnterior: string | null; cambioPeriodicidad: boolean };
  /** Numero identificativo (B5); null hasta que se descarga o se presenta. */
  numeroDeclaracion: string | null;
  entrada: Entrada349;
  /** Todos los registros del periodo con su clave (para elegir los de una complementaria). */
  registros: Array<{ clave: string; nombre: string; importe: number; tipo: 'operador' | 'rectificacion' }>;
  errores: string[];
  avisos: string[];
  /** Lo que lleva el fichero, leido con el diseno (null si no se puede componer). */
  pantalla: Pantalla349 | null;
  movimientos: Movimiento349[];
  /**
   * Bases declaradas que hay que escribir a mano: rectificaciones de periodos
   * cuyo 349 no esta en la app (las facturas de 2026 llevadas fuera). Se
   * guardan con PUT /349/opciones { basesDeclaradas: { [clave]: importe } }.
   */
  basesPedidas: Array<{ clave: string; nombre: string; claveOperacion: string; ejercicio: number; periodo: string; base: number | null }>;
}

const cent = (n: number) => Math.round(n * 100);
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/** Periodo del 349 de una fecha, con la misma periodicidad que el que se declara. */
function periodoDeFecha(fecha: string, tipo: PeriodoFiscal['tipo']): { ejercicio: number; periodo: string } {
  const mes = Number(fecha.slice(5, 7));
  return { ejercicio: Number(fecha.slice(0, 4)), periodo: tipo === 'mensual' ? fecha.slice(5, 7) : `${Math.ceil(mes / 3)}T` };
}

/** Primer dia de un periodo del 349 («2026», «3T» o «07»). */
const inicioDePeriodo = (x: { ejercicio: number; periodo: string }) =>
  /^\dT$/.test(x.periodo) ? `${x.ejercicio}-${String((Number(x.periodo[0]) - 1) * 3 + 1).padStart(2, '0')}-01` : `${x.ejercicio}-${x.periodo}-01`;

/**
 * Rappel de venta de un periodo que abarca varios periodos del 349: su base se
 * reparte entre ellos en proporcion a las ventas de ese periodo al mismo
 * operador y con la misma clave (sin rectificativas), como propone compras.
 * Al centimo: las partes suman la base. null si no hay ventas con que repartir
 * (entonces va entera al periodo de su inicio, con aviso).
 */
async function repartoRappelVenta(
  companyId: string,
  r: { cifnif: string; pais: string | null; clave: Clave349 },
  desde: string,
  hasta: string,
  base: number,
  tipo: PeriodoFiscal['tipo'],
): Promise<Array<{ periodo: { ejercicio: number; periodo: string }; base: number }> | null> {
  const operador = claveOperador({ nifIva: r.cifnif, pais: r.pais, clave: r.clave });
  const ventas = (await obtenerFacturasFiscales(companyId, desde, hasta)).filter(
    (x) => x.tipo === 'venta' && !x.rectificativa && x.fecha >= desde && x.fecha <= hasta && clave349De(x) === r.clave && claveOperador({ nifIva: x.cifnif, pais: x.paisTercero ?? null, clave: r.clave }) === operador,
  );
  const porPeriodo = new Map<string, { periodo: { ejercicio: number; periodo: string }; cent: number }>();
  for (const x of ventas) {
    const per = periodoDeFecha(x.fecha, tipo);
    const k = `${per.ejercicio}|${per.periodo}`;
    const a = porPeriodo.get(k) ?? { periodo: per, cent: 0 };
    a.cent += x.lineas.reduce((s, l) => s + cent(l.base), 0);
    porPeriodo.set(k, a);
  }
  const filas = [...porPeriodo.values()].filter((a) => a.cent > 0).sort((a, b) => inicioDePeriodo(a.periodo).localeCompare(inicioDePeriodo(b.periodo)));
  const total = filas.reduce((s, a) => s + a.cent, 0);
  if (!total || filas.length < 2) return null;
  const partes = repartirCentimos(base, filas.map((a) => (base * a.cent) / total));
  return filas.map((a, i) => ({ periodo: a.periodo, base: partes[i] })).filter((x) => cent(x.base) !== 0);
}

/** Clave de agrupacion de un operador: pais + numero del NIF-IVA (o el NIF limpio) y clave. */
export function claveOperador(m: { nifIva: string; pais?: string | null; clave: string }): string {
  const s = separarNifIva(m.nifIva, m.pais);
  return `${s ? s.pais + s.numero : String(m.nifIva ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')}|${m.clave}`;
}

/** Ventas y compras del periodo que van al 349, cada una con su clave y su base en euros. */
export async function movimientos349(companyId: string, p: PeriodoFiscal): Promise<Movimiento349[]> {
  const out: Movimiento349[] = [];

  // Ventas: el criterio fiscal comun (devengo, tipo de operacion, euros).
  const ventas = (await obtenerFacturasFiscales(companyId, p.fechaInicio, p.fechaFin)).filter((f) => f.tipo === 'venta');
  const conClave: Array<{ f: (typeof ventas)[number]; clave: Clave349 }> = [];
  for (const f of ventas) {
    const clave = clave349De(f);
    if (clave) conClave.push({ f, clave });
  }
  // Rectificativas de venta: por cada factura (o periodo) que rectifican, su
  // parte. Si la original es de un periodo anterior (su devengo, la fecha de
  // una de fuera o el inicio del rappel), registro de rectificacion de ese
  // periodo; si no, resta en el registro normal del operador.
  const numeros = conClave.filter((x) => x.f.rectificativa).map((x) => String(x.f.idFactura));
  const rectificativas = numeros.length
    ? await prisma.incomeInvoice.findMany({
        where: { companyId, esRectificativa: true, numeroCompleto: { in: numeros } },
        select: {
          numeroCompleto: true,
          facturaOriginalId: true,
          rectificaFueraFecha: true,
          enlacesRectifica: {
            select: {
              originalId: true,
              fechaOriginal: true,
              periodoDesde: true,
              periodoHasta: true,
              baseRectificada: true,
              original: { select: { fechaEmision: true, fechaOperacion: true, tipoOperacion: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
    : [];
  const antiguas = rectificativas.filter((r) => !r.enlacesRectifica.length && r.facturaOriginalId);
  const originalesAntiguas = antiguas.length
    ? await prisma.incomeInvoice.findMany({
        where: { companyId, id: { in: antiguas.map((r) => r.facturaOriginalId!) } },
        select: { id: true, fechaEmision: true, fechaOperacion: true, tipoOperacion: true },
      })
    : [];
  /** Filas de cada rectificativa: fecha de origen, parte de la base (null = toda) y si es de fuera de la app. */
  const filasDe = new Map<string, Array<{ origen: string | null; base: number | null; fuera: boolean; periodo?: { desde: string; hasta: string } }>>();
  for (const r of rectificativas) {
    if (!r.numeroCompleto) continue;
    if (r.enlacesRectifica.length) {
      const varias = r.enlacesRectifica.length > 1;
      filasDe.set(
        r.numeroCompleto,
        r.enlacesRectifica.map((e) => ({
          origen: e.original ? fechaDevengoVenta(e.original) : (e.fechaOriginal ?? e.periodoDesde),
          base: varias && e.baseRectificada !== null ? Number(e.baseRectificada) : null,
          fuera: !e.originalId && !e.periodoDesde,
          ...(e.periodoDesde && e.periodoHasta ? { periodo: { desde: e.periodoDesde, hasta: e.periodoHasta } } : {}),
        })),
      );
    } else {
      const o = originalesAntiguas.find((x) => x.id === r.facturaOriginalId);
      if (o) filasDe.set(r.numeroCompleto, [{ origen: fechaDevengoVenta(o), base: null, fuera: false }]);
      else if (r.rectificaFueraFecha) filasDe.set(r.numeroCompleto, [{ origen: r.rectificaFueraFecha, base: null, fuera: true }]);
    }
  }
  for (const { f, clave } of conClave) {
    const base = f.lineas.reduce((a, l) => a + cent(l.base), 0) / 100;
    const comun = { factura: String(f.idFactura), tipo: 'venta' as const, fecha: f.fecha, nifIva: f.cifnif, pais: f.paisTercero ?? null, nombre: f.nombreTercero, clave };
    const filas = f.rectificativa ? filasDe.get(String(f.idFactura)) : undefined;
    if (!filas?.length) {
      out.push({ ...comun, base });
      continue;
    }
    for (const e of filas) {
      // Rappel de varios periodos del 349: cada periodo, su parte (rectificacion de los anteriores).
      const varios = e.periodo && periodoDeFecha(e.periodo.desde, p.tipo).periodo !== periodoDeFecha(e.periodo.hasta, p.tipo).periodo;
      if (e.periodo && (varios || e.periodo.desde.slice(0, 4) !== e.periodo.hasta.slice(0, 4))) {
        const reparto = await repartoRappelVenta(companyId, { cifnif: f.cifnif, pais: f.paisTercero ?? null, clave }, e.periodo.desde, e.periodo.hasta, e.base ?? base, p.tipo);
        if (reparto) {
          for (const r of reparto) {
            const inicio = inicioDePeriodo(r.periodo);
            out.push({ ...comun, base: r.base, ...(inicio < p.fechaInicio ? { rectifica: r.periodo } : {}) });
          }
          continue;
        }
        out.push({
          ...comun,
          base: e.base ?? base,
          ...(e.origen && e.origen < p.fechaInicio ? { rectifica: periodoDeFecha(e.origen, p.tipo) } : {}),
          aviso: `El rappel ${f.idFactura} abarca varios periodos del 349 (del ${ddmm(e.periodo.desde)} al ${ddmm(e.periodo.hasta)}) y no hay ventas a ese cliente con las que repartirlo: se rectifica entero en el periodo de su inicio. Si hay que repartirlo, hazlo a mano.`,
        });
        continue;
      }
      out.push({
        ...comun,
        base: e.base ?? base,
        // Original de fuera de la app: su base declarada se pide a mano si su 349 no esta en la app.
        ...(e.origen && e.origen < p.fechaInicio ? { rectifica: periodoDeFecha(e.origen, p.tipo), ...(e.fuera ? { fuera: true } : {}) } : {}),
      });
    }
  }

  // Compras: facturas de gasto por fecha contable (una anulada con contraasiento resta en su periodo).
  const compras = await prisma.expenseInvoice.findMany({
    where: whereGastosFiscales(companyId, p.fechaInicio, p.fechaFin),
    include: {
      supplier: { select: { nifCif: true, nombreFiscal: true, pais: true } },
      lineas: { select: { baseLine: true } },
      rectifica: { include: { original: { select: { id: true, fechaEmision: true, fechaRegistro: true, esRectificativa: true } } } },
    },
  });
  for (const f of compras) {
    for (const ap of aparicionesEntre(f, p.fechaInicio, p.fechaFin)) {
      let clave: Clave349 | null = null;
      let pais: string | null = null;
      if (ap.fecha >= INICIO_COMPRAS_ISO2) {
        pais = paisDelCliente({ pais: f.supplier.pais, nifCif: f.supplier.nifCif });
        if (pais !== 'ES' && PAISES_UE.has(pais)) {
          clave = f.clave349 === 'A' || f.clave349 === 'I' ? f.clave349 : f.tipoGasto === 'COMPRA' ? 'A' : 'I';
        }
      } else if (clasificarOperacion(f.supplier.pais, f.supplier.nifCif) === 'intracomunitaria') {
        clave = 'A';
      }
      if (!clave) continue;
      const base = f.lineas.length ? f.lineas.reduce((a, l) => a + cent(Number(l.baseLine)), 0) : cent(Number(f.baseTotal));
      const contable = fechaContableGasto(f);
      // Abono o rectificativa: por cada factura (o periodo) que rectifica, su
      // parte. Si la original es de un periodo anterior, es un registro de
      // rectificacion de ese periodo; si no, resta en el registro normal.
      if (f.esRectificativa && ap.signo > 0 && f.rectifica.length) {
        for (const e of f.rectifica) {
          const origen = await fechaOrigen349(companyId, e);
          const parte = f.rectifica.length === 1 || e.baseRectificada === null ? base : cent(Number(e.baseRectificada));
          const varios = e.periodoDesde && e.periodoHasta && periodoDeFecha(e.periodoDesde, p.tipo).periodo !== periodoDeFecha(e.periodoHasta, p.tipo).periodo;
          out.push({
            id: f.id,
            factura: f.numeroFacturaProveedor ?? f.numeroCompleto,
            tipo: 'compra',
            fecha: ap.fecha,
            nifIva: f.supplier.nifCif,
            pais,
            nombre: f.supplier.nombreFiscal,
            clave,
            base: parte / 100,
            // Original de fuera de la app (no un periodo de rappel): su base declarada se pide a mano.
            ...(origen && origen < p.fechaInicio ? { rectifica: periodoDeFecha(origen, p.tipo), ...(e.originalId || e.periodoDesde ? {} : { fuera: true }) } : {}),
            ...(varios
              ? {
                  aviso: `Una parte del rappel ${f.numeroFacturaProveedor ?? f.numeroCompleto} abarca varios periodos del 349 (del ${ddmm(e.periodoDesde!)} al ${ddmm(e.periodoHasta!)}): se rectifica entera en el periodo de su inicio. Si hay que repartirla, corrige el reparto por periodos del abono.`,
                }
              : {}),
          });
        }
        continue;
      }
      out.push({
        id: f.id,
        factura: f.numeroFacturaProveedor ?? f.numeroCompleto,
        tipo: 'compra',
        fecha: ap.fecha,
        nifIva: f.supplier.nifCif,
        pais,
        nombre: f.supplier.nombreFiscal,
        clave,
        base: (ap.signo * base) / 100,
        ...(ap.signo < 0 && contable < p.fechaInicio ? { rectifica: periodoDeFecha(contable, p.tipo) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.factura.localeCompare(b.factura));
}

/**
 * Fecha de la operacion que corrige un enlace de rectificativa, para el 349:
 * la contable de la original de la app (siguiendo la cadena si la original es
 * a su vez una rectificativa), la de una original de fuera o el inicio del periodo.
 */
async function fechaOrigen349(
  companyId: string,
  e: { originalId: string | null; fechaOriginal: string | null; periodoDesde: string | null; original: { id: string; fechaEmision: string; fechaRegistro: string | null; esRectificativa: boolean } | null },
): Promise<string | null> {
  if (!e.originalId || !e.original) return e.fechaOriginal ?? e.periodoDesde;
  let o = e.original;
  for (let i = 0; i < 10 && o.esRectificativa; i++) {
    const sig = await prisma.expenseInvoiceRectificada.findFirst({
      where: { companyId, rectificativaId: o.id },
      include: { original: { select: { id: true, fechaEmision: true, fechaRegistro: true, esRectificativa: true } } },
    });
    if (!sig) break;
    if (!sig.original) return sig.fechaOriginal ?? sig.periodoDesde ?? fechaContableGasto(o);
    o = sig.original;
  }
  return fechaContableGasto(o);
}

/** Base declarada a mano de un operador, clave y periodo (opciones del 349 que se prepara o de otro del mismo periodo rectificado). */
async function basesDeclaradasManuales(companyId: string, opc: Record<string, unknown>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const otras = await prisma.modeloImpuesto.findMany({ where: { companyId, codigo: '349' }, select: { casillas: true } });
  for (const casillas of [...otras.map((o) => (o.casillas ?? {}) as Record<string, unknown>), Object.fromEntries(Object.entries(opc).map(([k, v]) => [`opc_${k}`, v]))]) {
    for (const [k, v] of Object.entries(casillas)) if (k.startsWith('opc_base:') && typeof v === 'number') out.set(k.slice(9), v);
  }
  return out;
}

/** Operadores del periodo: una linea por operador y clave con la suma de sus bases (sin las rectificaciones). */
function agruparOperadores(movs: Movimiento349[]): Operador349[] {
  const porClave = new Map<string, Operador349 & { c: number }>();
  for (const m of movs) {
    if (m.rectifica) continue;
    const k = claveOperador(m);
    const o = porClave.get(k) ?? { nifIva: m.nifIva, pais: m.pais, nombre: m.nombre, clave: m.clave, base: 0, c: 0 };
    o.c += cent(m.base);
    porClave.set(k, o);
  }
  return [...porClave.values()]
    .filter((o) => o.c !== 0)
    .map(({ c, ...o }) => ({ ...o, base: c / 100 }))
    .sort((a, b) => a.clave.localeCompare(b.clave) || a.nombre.localeCompare(b.nombre, 'es'));
}

/** Base declarada de un operador y clave en el 349 guardado de un periodo (formato nuevo o el anterior). */
function baseEnDeclaracion(datos: unknown, clave: string): number | null {
  const d = datos as { entrada?: { operadores?: Operador349[] }; operaciones?: Array<{ cifnif: string; clave: string; base: number }> } | null;
  if (d?.entrada?.operadores) {
    const o = d.entrada.operadores.find((x) => claveOperador(x) === clave);
    return o ? o.base : 0;
  }
  if (d?.operaciones) {
    const o = d.operaciones.find((x) => claveOperador({ nifIva: x.cifnif, clave: x.clave }) === clave);
    return o ? o.base : 0;
  }
  return null;
}

/** Calcula el borrador del 349 de un periodo ('1T'-'4T' o '01'-'12'). No guarda nada. */
export async function calcularBorrador349(companyId: string, ejercicio: number, periodo: string): Promise<Borrador349> {
  const p = periodoFiscal(ejercicio, periodo);
  if (p.tipo === 'anual') throw badRequest('El 349 es trimestral o mensual: indica 1T-4T o un mes (01-12).');
  await exigirModelosAeat(companyId, p.fechaInicio, p.fechaFin);

  const fila = await filaModelo(companyId, '349', ejercicio, p.periodo);
  const opc = opcionesDe(fila);
  // Cambio de periodicidad (X): la declaración mensual del segundo mes del
  // trimestre recoge también el primero (DR_Anexo_349, posición 186).
  const conCambio = opc.cambioPeriodicidad === true && (MESES_CAMBIO_PERIODICIDAD_349 as readonly string[]).includes(p.periodo);
  const delPeriodo: PeriodoFiscal = conCambio ? { ...p, fechaInicio: periodoFiscal(ejercicio, String(Number(p.periodo) - 1).padStart(2, '0')).fechaInicio } : p;
  const [movimientos, declarante, decl] = await Promise.all([
    movimientos349(companyId, delPeriodo),
    declaranteEmpresa(companyId),
    declaracionInformativa(companyId, '349', ejercicio, p.periodo),
  ]);
  const avisos: string[] = [];
  if (conCambio) avisos.push(`Cambio de periodicidad: la declaración de ${p.periodo} recoge también las operaciones del mes anterior.`);
  for (const m of movimientos) if (m.aviso && !avisos.includes(m.aviso)) avisos.push(m.aviso);

  // Rectificaciones: por operador, clave y periodo corregido.
  const grupos = new Map<string, { m: Movimiento349; c: number; ejercicio: number; periodo: string; fuera: boolean }>();
  for (const m of movimientos) {
    if (!m.rectifica) continue;
    const k = `${claveOperador(m)}|${m.rectifica.ejercicio}|${m.rectifica.periodo}`;
    const g = grupos.get(k) ?? { m, c: 0, ...m.rectifica, fuera: false };
    g.c += cent(m.base);
    if (m.fuera) g.fuera = true;
    grupos.set(k, g);
  }
  const anteriores = new Map<string, { fila: FilaCalendario | null; calculados?: Operador349[] }>();
  const rectificaciones: Rectificacion349[] = [];
  const manuales = grupos.size ? await basesDeclaradasManuales(companyId, opc) : new Map<string, number>();
  const basesPedidas: Borrador349['basesPedidas'] = [];
  const erroresBases: string[] = [];
  for (const g of grupos.values()) {
    if (g.c === 0) continue;
    const kp = `${g.ejercicio}|${g.periodo}`;
    if (!anteriores.has(kp)) anteriores.set(kp, { fila: await filaModelo(companyId, '349', g.ejercicio, g.periodo) });
    const ant = anteriores.get(kp)!;
    let base: number | null = ant.fila?.estado === 'presentado' ? baseEnDeclaracion(ant.fila.datos, claveOperador(g.m)) : null;
    // Sin el 349 presentado en la app, la base declarada se calcula con las
    // facturas. Si el abono es de una factura llevada fuera de la app, o resta
    // de un periodo en el que la app no tiene compras de ese operador (un
    // rappel de 2026, por ejemplo), no se puede calcular (daria 0): se pide a mano.
    if (base === null && !g.fuera && g.c < 0) {
      ant.calculados ??= agruparOperadores(await movimientos349(companyId, periodoFiscal(g.ejercicio, g.periodo)));
      if (!ant.calculados.some((o) => claveOperador(o) === claveOperador(g.m) && cent(o.base) !== 0)) g.fuera = true;
    }
    if (base === null && g.fuera) {
      const clave = `${claveOperador(g.m)}|${g.ejercicio}|${g.periodo}`;
      const manual = manuales.get(clave);
      basesPedidas.push({ clave, nombre: g.m.nombre, claveOperacion: g.m.clave, ejercicio: g.ejercicio, periodo: g.periodo, base: manual ?? null });
      if (manual === undefined) {
        erroresBases.push(`Indica la base que declaraste para ${g.m.nombre} (clave ${g.m.clave}) en el 349 del ${g.periodo} de ${g.ejercicio}: sin ella no se puede rectificar.`);
        continue;
      }
      base = manual;
    }
    if (base === null) {
      ant.calculados ??= agruparOperadores(await movimientos349(companyId, periodoFiscal(g.ejercicio, g.periodo)));
      base = ant.calculados.find((o) => claveOperador(o) === claveOperador(g.m))?.base ?? 0;
      avisos.push(
        `El 349 de ${g.periodo} de ${g.ejercicio} no consta como presentado en la app: la base declarada antes de ${g.m.nombre} (clave ${g.m.clave}) se ha calculado con las facturas (${importeTexto(base)}). Compruébala con la declaración que presentaste.`,
      );
    }
    rectificaciones.push({
      nifIva: g.m.nifIva,
      pais: g.m.pais,
      nombre: g.m.nombre,
      clave: g.m.clave,
      ejercicio: g.ejercicio,
      periodo: g.periodo,
      baseAnterior: base,
      baseRectificada: (cent(base) + g.c) / 100,
    });
  }

  // Complementaria o sustitutiva y su anterior: las pone el historial de declaraciones (B4).
  const tipoDeclaracion = decl.tipoDeclaracion;
  const opciones = { tipoDeclaracion, declaracionAnterior: decl.declaracionAnterior, cambioPeriodicidad: opc.cambioPeriodicidad === true };
  const operadores = agruparOperadores(movimientos);
  const rects = rectificaciones.sort((a, b) => a.clave.localeCompare(b.clave) || a.nombre.localeCompare(b.nombre, 'es'));
  const registros = [
    ...operadores.map((o) => ({ clave: claveOperador(o), nombre: o.nombre, importe: o.base, tipo: 'operador' as const })),
    ...rects.map((r) => ({ clave: claveRectificacion349(r), nombre: `${r.nombre} (rectifica ${r.periodo} de ${r.ejercicio})`, importe: r.baseRectificada, tipo: 'rectificacion' as const })),
  ];
  const calculada: Entrada349 = {
    ejercicio,
    periodo: p.periodo,
    cambioPeriodicidad: opciones.cambioPeriodicidad,
    declarante: {
      nif: declarante.nif,
      nombre: declarante.nombre,
      telefono: declarante.telefono,
      personaContacto: declarante.personaContacto,
      numeroDeclaracion: decl.numeroDeclaracion,
      tipoDeclaracion,
      declaracionAnterior: opciones.declaracionAnterior,
    },
    // Complementaria: solo los registros elegidos (por defecto, los que no estaban en la presentada).
    operadores: registrosElegidos(operadores, claveOperador, decl.incluye),
    rectificaciones: registrosElegidos(rects, claveRectificacion349, decl.incluye),
  };
  // Presentada: se enseña (y se descarga) lo que se presento.
  const presentada = presentacionDe<Entrada349>(fila);
  const entrada = presentada?.entrada ?? calculada;
  // Sin ningún registro de tipo 2 es un error (ERROR_SIN_REGISTROS_349); en una
  // complementaria sin nada elegido, se dice qué hay que marcar.
  const sinRegistros = (e: string) =>
    e === ERROR_SIN_REGISTROS_349 && decl.seleccion ? 'La complementaria no lleva ningún registro: marca los operadores que se quedaron fuera de la declaración anterior.' : e;
  const errores = presentada ? [] : [...erroresContacto(declarante), ...erroresBases, ...erroresEntrada349(entrada).map(sinRegistros)];
  if (presentada) avisos.unshift(avisoPresentado(presentada));
  else if (!entrada.declarante.numeroDeclaracion) avisos.push(AVISO_SIN_NUMERO);

  let pantalla: Pantalla349 | null = null;
  try {
    pantalla = leerFichero349(generarFichero349(entrada, { comprobar: false }));
  } catch (e) {
    if (!(e instanceof ErrorDisenoRegistro)) throw e;
  }
  return {
    ejercicio,
    periodo: p.periodo,
    estado: fila?.estado ?? 'vigente',
    estadoTexto: (await estadosEnRectificacion(companyId, '349', ejercicio)).get(p.periodo) ?? null,
    opciones,
    numeroDeclaracion: entrada.declarante.numeroDeclaracion ?? null,
    entrada,
    registros,
    errores,
    avisos,
    pantalla,
    movimientos,
    basesPedidas,
  };
}

/** Clave de una rectificacion: operador, clave y periodo que corrige. */
export function claveRectificacion349(r: { nifIva: string; pais?: string | null; clave: string; ejercicio: number; periodo: string }): string {
  return `R|${claveOperador(r)}|${r.ejercicio}|${r.periodo}`;
}

/** Fichero del 349 para importar en la sede. 400 con la lista de lo que falta. */
export async function ficheroModelo349(companyId: string, ejercicio: number, periodo: string): Promise<{ nombre: string; contenido: string }> {
  const b = await calcularBorrador349(companyId, ejercicio, periodo);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 349: ${b.errores.join(' ')}`, { errores: b.errores });
  exigirNumero(b.entrada.declarante.numeroDeclaracion, '349');
  try {
    return { nombre: `349_${ejercicio}_${b.periodo}.txt`, contenido: generarFichero349(b.entrada) };
  } catch (e) {
    if (e instanceof ErrorEntrada349) throw badRequest(`No se puede generar el fichero del 349: ${e.errores.join(' ')}`, { errores: e.errores });
    throw e;
  }
}

/** Clave A o I de una compra a la UE (null = segun el tipo de gasto). */
export function claveCompraValida(clave: unknown): 'A' | 'I' | null {
  if (clave === null || clave === undefined || clave === '') return null;
  if (clave === 'A' || clave === 'I') return clave;
  throw badRequest(`La clave del 349 de una compra es A (bienes) o I (servicios), no "${String(clave)}".`);
}

