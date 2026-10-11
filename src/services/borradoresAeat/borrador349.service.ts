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
import { badRequest } from '../../utils/http-errors';
import { aparicionesEntre, fechaContableGasto, whereGastosFiscales } from '../../domain/factura-gasto.model';
import { fechaDevengoVenta, limpiarNif, paisDelCliente, PAISES_UE } from '../../domain/tipo-operacion.model';
import { clasificarOperacion, clave349De, exigirModelosAeat, obtenerFacturasFiscales } from '../impuestosCalculo.service';
import { periodoFiscal } from '../nominas/fiscal';
import type { PeriodoFiscal } from '../../domain/impuestos.model';
import {
  ErrorEntrada349,
  erroresEntrada349,
  generarFichero349,
  leerFichero349,
  numeroDeclaracion349,
  separarNifIva,
  type Clave349,
  type Entrada349,
  type Operador349,
  type Pantalla349,
  type Rectificacion349,
} from '../../aeat/modelo349/modelo349.dr';
import { ErrorDisenoRegistro } from '../../aeat/common/disenoRegistro';
import { avisosContacto, declaranteEmpresa, filaModelo, opcionesDe, type FilaCalendario } from './comun';

/** Desde este dia las compras se clasifican por el pais ISO-2 y llevan A o I. */
const INICIO_COMPRAS_ISO2 = '2027-01-01';

/** Una factura (o su anulacion) en el 349 del periodo. */
export interface Movimiento349 {
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
}

export interface Borrador349 {
  ejercicio: number;
  periodo: string;
  estado: string;
  opciones: { tipoDeclaracion: 'C' | 'S' | null; declaracionAnterior: string | null; cambioPeriodicidad: boolean };
  entrada: Entrada349;
  errores: string[];
  avisos: string[];
  /** Lo que lleva el fichero, leido con el diseno (null si no se puede componer). */
  pantalla: Pantalla349 | null;
  movimientos: Movimiento349[];
}

const cent = (n: number) => Math.round(n * 100);

/** Periodo del 349 de una fecha, con la misma periodicidad que el que se declara. */
function periodoDeFecha(fecha: string, tipo: PeriodoFiscal['tipo']): { ejercicio: number; periodo: string } {
  const mes = Number(fecha.slice(5, 7));
  return { ejercicio: Number(fecha.slice(0, 4)), periodo: tipo === 'mensual' ? fecha.slice(5, 7) : `${Math.ceil(mes / 3)}T` };
}

/** Clave de agrupacion de un operador: pais + numero del NIF-IVA (o el NIF limpio) y clave. */
function claveOperador(m: { nifIva: string; pais?: string | null; clave: string }): string {
  const s = separarNifIva(m.nifIva, m.pais);
  return `${s ? s.pais + s.numero : limpiarNif(m.nifIva)}|${m.clave}`;
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
  // Rectificativas cuya original se devengo en un periodo anterior.
  const numeros = conClave.map((x) => String(x.f.idFactura));
  const rectificativas = numeros.length
    ? await prisma.incomeInvoice.findMany({
        where: { companyId, esRectificativa: true, facturaOriginalId: { not: null }, numeroCompleto: { in: numeros } },
        select: { numeroCompleto: true, facturaOriginalId: true },
      })
    : [];
  const originales = rectificativas.length
    ? await prisma.incomeInvoice.findMany({
        where: { companyId, id: { in: rectificativas.map((r) => r.facturaOriginalId!) } },
        select: { id: true, fechaEmision: true, fechaOperacion: true, tipoOperacion: true },
      })
    : [];
  const devengoOriginal = new Map<string, string>();
  for (const r of rectificativas) {
    const o = originales.find((x) => x.id === r.facturaOriginalId);
    if (o && r.numeroCompleto) devengoOriginal.set(r.numeroCompleto, fechaDevengoVenta(o));
  }
  for (const { f, clave } of conClave) {
    const devengo = devengoOriginal.get(String(f.idFactura));
    out.push({
      factura: String(f.idFactura),
      tipo: 'venta',
      fecha: f.fecha,
      nifIva: f.cifnif,
      pais: f.paisTercero ?? null,
      nombre: f.nombreTercero,
      clave,
      base: f.lineas.reduce((a, l) => a + cent(l.base), 0) / 100,
      ...(devengo && devengo < p.fechaInicio ? { rectifica: periodoDeFecha(devengo, p.tipo) } : {}),
    });
  }

  // Compras: facturas de gasto por fecha contable (una anulada con contraasiento resta en su periodo).
  const compras = await prisma.expenseInvoice.findMany({
    where: whereGastosFiscales(companyId, p.fechaInicio, p.fechaFin),
    include: { supplier: { select: { nifCif: true, nombreFiscal: true, pais: true } }, lineas: { select: { baseLine: true } } },
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
      out.push({
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

  const [movimientos, declarante, fila] = await Promise.all([
    movimientos349(companyId, p),
    declaranteEmpresa(companyId),
    filaModelo(companyId, '349', ejercicio, p.periodo),
  ]);
  const avisos = avisosContacto(declarante);

  // Rectificaciones: por operador, clave y periodo corregido.
  const grupos = new Map<string, { m: Movimiento349; c: number; ejercicio: number; periodo: string }>();
  for (const m of movimientos) {
    if (!m.rectifica) continue;
    const k = `${claveOperador(m)}|${m.rectifica.ejercicio}|${m.rectifica.periodo}`;
    const g = grupos.get(k) ?? { m, c: 0, ...m.rectifica };
    g.c += cent(m.base);
    grupos.set(k, g);
  }
  const anteriores = new Map<string, { fila: FilaCalendario | null; calculados?: Operador349[] }>();
  const rectificaciones: Rectificacion349[] = [];
  for (const g of grupos.values()) {
    if (g.c === 0) continue;
    const kp = `${g.ejercicio}|${g.periodo}`;
    if (!anteriores.has(kp)) anteriores.set(kp, { fila: await filaModelo(companyId, '349', g.ejercicio, g.periodo) });
    const ant = anteriores.get(kp)!;
    let base: number | null = ant.fila?.estado === 'presentado' ? baseEnDeclaracion(ant.fila.datos, claveOperador(g.m)) : null;
    if (base === null) {
      ant.calculados ??= agruparOperadores(await movimientos349(companyId, periodoFiscal(g.ejercicio, g.periodo)));
      base = ant.calculados.find((o) => claveOperador(o) === claveOperador(g.m))?.base ?? 0;
      avisos.push(
        `El 349 de ${g.periodo} de ${g.ejercicio} no consta como presentado en la app: la base declarada antes de ${g.m.nombre} (clave ${g.m.clave}) se ha calculado con las facturas (${base.toFixed(2)} €). Compruébala con la declaración que presentaste.`,
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

  const opc = opcionesDe(fila);
  const tipoDeclaracion: 'C' | 'S' | null = opc.tipoDeclaracion === 'C' || opc.tipoDeclaracion === 'S' ? opc.tipoDeclaracion : null;
  const opciones = {
    tipoDeclaracion,
    declaracionAnterior: typeof opc.declaracionAnterior === 'string' ? opc.declaracionAnterior : null,
    cambioPeriodicidad: opc.cambioPeriodicidad === true,
  };
  const entrada: Entrada349 = {
    ejercicio,
    periodo: p.periodo,
    cambioPeriodicidad: opciones.cambioPeriodicidad,
    declarante: {
      nif: declarante.nif,
      nombre: declarante.nombre,
      telefono: declarante.telefono,
      personaContacto: declarante.personaContacto,
      numeroDeclaracion: numeroDeclaracion349(ejercicio, p.periodo, tipoDeclaracion ? 2 : 1),
      tipoDeclaracion,
      declaracionAnterior: opciones.declaracionAnterior,
    },
    operadores: agruparOperadores(movimientos),
    rectificaciones: rectificaciones.sort((a, b) => a.clave.localeCompare(b.clave) || a.nombre.localeCompare(b.nombre, 'es')),
  };
  if (!entrada.operadores.length && !entrada.rectificaciones!.length) avisos.push('No hay operaciones intracomunitarias en el periodo: no hace falta presentar el 349.');

  let pantalla: Pantalla349 | null = null;
  try {
    pantalla = leerFichero349(generarFichero349(entrada, { comprobar: false }));
  } catch (e) {
    if (!(e instanceof ErrorDisenoRegistro)) throw e;
  }
  return { ejercicio, periodo: p.periodo, estado: fila?.estado ?? 'vigente', opciones, entrada, errores: erroresEntrada349(entrada), avisos, pantalla, movimientos };
}

/** Fichero del 349 para importar en la sede. 400 con la lista de lo que falta. */
export async function ficheroModelo349(companyId: string, ejercicio: number, periodo: string): Promise<{ nombre: string; contenido: string }> {
  const b = await calcularBorrador349(companyId, ejercicio, periodo);
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

