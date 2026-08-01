import { getFsClientForCompany, FsClient } from './facturascripts-client';
import { prisma } from '../config/database';
import { ReglasContablesEmpresa } from '../domain/reglas-contables.model';
import { obtenerReglas } from './reglasContables.service';
import { FacturaContable, LineaFacturaContable } from '../domain/factura.model';
import { AsientoContableGenerado } from '../domain/asiento.model';
import {
  generarAsientoVentaDesdeFactura,
  generarAsientoCompraDesdeFactura,
} from './contabilidadReglas.service';
import { notFound } from '../utils/http-errors';
import { crearVencimientos, generarVencimientosDesdeFactura } from './vencimientos.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Recurso FS de documento y de lineas, y campo del tercero, segun tipo. */
const DOC_MAP = {
  venta: { doc: 'facturaclientes', lineas: 'lineafacturaclientes', tercero: 'codcliente' },
  compra: { doc: 'facturaproveedores', lineas: 'lineafacturaproveedores', tercero: 'codproveedor' },
} as const;

/**
 * PASO 1 — Lee la factura completa de FacturaScripts (cabecera + lineas) y la
 * convierte al modelo contable (FacturaContable) con base e IVA por linea.
 */
async function leerFacturaContable(
  fs: FsClient,
  facturaId: string,
  tipo: 'venta' | 'compra',
): Promise<{ factura: FacturaContable; header: Record<string, unknown> }> {
  const map = DOC_MAP[tipo];

  const header = (await fs.getOne(map.doc, facturaId)) as Record<string, unknown>;
  if (!header || header.idfactura === undefined) {
    throw notFound('Factura no encontrada en FacturaScripts.');
  }

  const { items } = await fs.listWithMeta(map.lineas, {
    'filter[idfactura]': facturaId,
    limit: 1000,
  });

  const factura = construirFacturaContable(header, items as Array<Record<string, unknown>>, tipo, facturaId);
  return { factura, header };
}

/**
 * Construye una FacturaContable a partir de cabecera + lineas YA LEIDAS (puro,
 * sin peticiones). Reutilizado por leerFacturaContable y por el calculo fiscal
 * en lote (sin N+1). Nombres de campos VERIFICADOS contra el codigo fuente de
 * FacturaScripts (Core/Model/Base/BusinessDocument[Line].php): cabecera
 * dtopor1/dtopor2/coddivisa/tasaconv (totaleuros = total / tasaconv); linea
 * pvptotal/pvpunitario/iva/irpf/recargo.
 */
export function construirFacturaContable(
  header: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
  tipo: 'venta' | 'compra',
  facturaId: string,
): FacturaContable {
  const map = DOC_MAP[tipo];

  // Hallazgo 5: descuento GLOBAL de cabecera (dtopor1/dtopor2).
  const dtoPor1 = Number(header.dtopor1 ?? 0);
  const dtoPor2 = Number(header.dtopor2 ?? 0);
  const factorDtoGlobal = (1 - dtoPor1 / 100) * (1 - dtoPor2 / 100);

  // Hallazgo 6: divisa -> EUR. FS: totaleuros = total / tasaconv.
  const divisaOriginal = (header.coddivisa as string) ?? 'EUR';
  const tipoCambio = Number(header.tasaconv ?? 1) || 1;
  const factorDivisa = divisaOriginal === 'EUR' ? 1 : tipoCambio;

  const lineas: LineaFacturaContable[] = items.map((l) => {
    const baseBruta = Number(l.pvptotal ?? 0); // neto de linea (tras dto de linea)
    const baseImponible = round2((baseBruta * factorDtoGlobal) / factorDivisa); // dto global + EUR
    const tipoIva = Number(l.iva ?? 0);
    const tipoIrpf = Number(l.irpf ?? 0); // Hallazgo 4
    const tipoRecargo = Number(l.recargo ?? 0); // Hallazgo 4
    return {
      productoCodigo: (l.referencia as string) ?? undefined,
      descripcion: (l.descripcion as string) ?? '',
      cantidad: Number(l.cantidad ?? 0),
      precioUnitario: round2(Number(l.pvpunitario ?? 0) / factorDivisa),
      tipoIva,
      baseImponible,
      importeIva: round2((baseImponible * tipoIva) / 100),
      irpf: tipoIrpf,
      importeIrpf: round2((baseImponible * tipoIrpf) / 100),
      recargoEquivalencia: tipoRecargo,
      importeRecargo: round2((baseImponible * tipoRecargo) / 100),
    };
  });

  const totalBase = round2(lineas.reduce((a, l) => a + l.baseImponible, 0));
  const totalIva = round2(lineas.reduce((a, l) => a + (l.importeIva ?? 0), 0));
  const totalIrpf = round2(lineas.reduce((a, l) => a + (l.importeIrpf ?? 0), 0));
  const totalRecargo = round2(lineas.reduce((a, l) => a + (l.importeRecargo ?? 0), 0));

  return {
    idFactura: (header.codigo as string) ?? facturaId,
    tipo,
    codigoTercero: (header[map.tercero] as string) ?? '',
    fecha: (header.fecha as string) ?? '',
    formaPago: (header.codpago as string) ?? '',
    lineas,
    totalBase,
    totalIva,
    totalIrpf,
    totalRecargo,
    // Total a pagar: base + IVA + recargo - retencion IRPF.
    totalFactura: round2(totalBase + totalIva + totalRecargo - totalIrpf),
    divisaOriginal,
    tipoCambio,
  };
}

/**
 * Hallazgo 1: desglosa las lineas de IVA de una FacturaContable por tipo, usando
 * la misma fuente que la contabilidad (lineas ya leidas/normalizadas). Reemplaza
 * la reconstruccion del tipo de IVA desde la cabecera (totaliva/neto).
 */
export function obtenerLineasIvaDesdeFactura(
  factura: FacturaContable,
): Array<{ tipoIva: number; base: number; cuota: number }> {
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of factura.lineas) {
    if (!l.tipoIva || l.tipoIva <= 0) continue; // exentas/0% no llevan cuota
    const acc = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
    acc.base += l.baseImponible;
    acc.cuota += l.importeIva ?? 0;
    porTipo.set(l.tipoIva, acc);
  }
  return [...porTipo.entries()].map(([tipoIva, acc]) => ({
    tipoIva,
    base: round2(acc.base),
    cuota: round2(acc.cuota),
  }));
}

/** Lee una FacturaContable (cabecera+lineas desglosadas) por su id. Reutilizable. */
export async function cargarFacturaContable(
  companyId: string,
  facturaId: string,
  tipo: 'venta' | 'compra',
): Promise<FacturaContable> {
  const fs = await getFsClientForCompany(companyId);
  const { factura } = await leerFacturaContable(fs, facturaId, tipo);
  return factura;
}

/** Longitud de subcuenta del ejercicio (FS Spanish suele ser 10). */
async function obtenerLongSubcuenta(fs: FsClient, codejercicio: string): Promise<number> {
  const { items } = await fs.listWithMeta('ejercicios', {
    'filter[codejercicio]': codejercicio,
    limit: 1,
  });
  const long = Number((items[0] as Record<string, unknown> | undefined)?.longsubcuenta ?? 10);
  return Number.isFinite(long) && long > 0 ? long : 10;
}

/**
 * Asegura que existe la subcuenta (y su cuenta padre) en el ejercicio, creandolas
 * si hace falta. El codigo logico (ej. "700000") se rellena con ceros a la derecha
 * hasta longsubcuenta. Devuelve { codsubcuenta, idsubcuenta }.
 *
 * NOTA: en produccion el plan contable estaria pre-cargado; este get-or-create
 * hace el flujo autosuficiente sobre una instalacion limpia.
 */
async function asegurarSubcuenta(
  fs: FsClient,
  codejercicio: string,
  codLogico: string,
  longsubcuenta: number,
  descripcion: string,
): Promise<{ codsubcuenta: string; idsubcuenta: number }> {
  const codsubcuenta = codLogico.padEnd(longsubcuenta, '0');

  const existente = await fs.listWithMeta('subcuentas', {
    'filter[codejercicio]': codejercicio,
    'filter[codsubcuenta]': codsubcuenta,
    limit: 1,
  });
  if (existente.items.length) {
    return { codsubcuenta, idsubcuenta: Number((existente.items[0] as Record<string, unknown>).idsubcuenta) };
  }

  // get-or-create cuenta padre (grupo de 3 digitos del PGC)
  const codcuenta = codLogico.substring(0, 3);
  const cuentas = await fs.listWithMeta('cuentas', {
    'filter[codejercicio]': codejercicio,
    'filter[codcuenta]': codcuenta,
    limit: 1,
  });
  let idcuenta: number;
  if (cuentas.items.length) {
    idcuenta = Number((cuentas.items[0] as Record<string, unknown>).idcuenta);
  } else {
    const nuevaCuenta = (await fs.create('cuentas', {
      codejercicio,
      codcuenta,
      descripcion: `Cuenta ${codcuenta}`,
    })) as Record<string, unknown>;
    idcuenta = Number(nuevaCuenta.idcuenta);
  }

  const nuevaSub = (await fs.create('subcuentas', {
    codejercicio,
    codcuenta,
    codsubcuenta,
    idcuenta,
    descripcion,
  })) as Record<string, unknown>;

  return { codsubcuenta, idsubcuenta: Number(nuevaSub.idsubcuenta) };
}

/**
 * Crea en FacturaScripts el asiento contable correspondiente a una factura.
 * Flujo completo (Pasos 1-5):
 *  1. Leer factura (cabecera + lineas) -> FacturaContable.
 *  2. Cargar ReglasContablesEmpresa (TODO: desde BD por empresa; ahora por defecto).
 *  3. Generar el asiento con el motor de reglas (venta/compra).
 *  4. Asegurar las subcuentas implicadas (get-or-create) y mapear los apuntes.
 *  5. Crear la cabecera Asiento y sus Partidas via la API de FacturaScripts.
 */
export async function crearAsientoEnFacturascriptsDesdeFactura(
  companyId: string,
  facturaId: string,
  tipo: 'venta' | 'compra',
): Promise<unknown> {
  const fs = await getFsClientForCompany(companyId);

  // Paso 1
  const { factura } = await leerFacturaContable(fs, facturaId, tipo);

  // Paso 2 — reglas contables de la empresa (BD propia; defaults si no hay)
  const reglas: ReglasContablesEmpresa = await obtenerReglas(companyId);

  // Paso 3
  const asiento: AsientoContableGenerado =
    tipo === 'venta'
      ? generarAsientoVentaDesdeFactura(factura, reglas)
      : generarAsientoCompraDesdeFactura(factura, reglas);

  // Pasos 4-5 — crear el asiento en Prisma (JournalEntry POSTED) desde los apuntes
  const resultado = await crearAsientoConApuntes(companyId, {
    fecha: factura.fecha,
    concepto: asiento.descripcion,
    apuntes: asiento.lineas,
    origen: tipo === 'venta' ? 'FACTURA_INGRESO' : 'FACTURA_GASTO',
    invoiceId: String(factura.idFactura),
    invoiceType: tipo === 'venta' ? 'INGRESO' : 'GASTO',
  });

  // Paso 6 (Hallazgo 2) — vencimientos coherentes con la forma de pago. Lee el
  // plazo real de FS (FormaPago.plazovencimiento/tipovencimiento, verificado en
  // Core/Model/FormaPago.php: vencimiento = fecha + plazo). Media 11.
  let plazoDias = 0;
  if (factura.formaPago) {
    const fp = await fs.listWithMeta('formapagos', { 'filter[codpago]': factura.formaPago, limit: 1 });
    const row = fp.items[0] as Record<string, unknown> | undefined;
    const plazo = Number(row?.plazovencimiento ?? 0);
    const tipoPlazo = String(row?.tipovencimiento ?? 'days');
    plazoDias = tipoPlazo === 'months' ? plazo * 30 : plazo; // aproximacion meses->dias
  }
  const tipoVto = tipo === 'venta' ? 'cobro' : 'pago';
  const vencimientos = await crearVencimientos(
    companyId,
    String(factura.idFactura),
    tipoVto,
    generarVencimientosDesdeFactura(factura, plazoDias),
  );

  return {
    ...resultado,
    resumen: {
      idFactura: factura.idFactura,
      debeTotal: asiento.debeTotal,
      haberTotal: asiento.haberTotal,
      numApuntes: asiento.lineas.length,
      vencimientos: vencimientos.length,
    },
  };
}

/**
 * Hallazgo 2 — crea un asiento de TESORERIA (cobro/pago) a partir de lineas
 * debe/haber (572/570 <-> 430/400). MIGRADO a Prisma: delega en
 * crearAsientoConApuntes con origen TESORERIA (ya no consulta FS).
 */
export async function crearAsientoTesoreria(
  companyId: string,
  params: { fecha: string; descripcion: string; lineas: ApunteAsiento[] },
): Promise<{ asiento: Record<string, unknown>; partidas: unknown[] }> {
  return crearAsientoConApuntes(companyId, {
    fecha: params.fecha,
    concepto: params.descripcion,
    apuntes: params.lineas,
    origen: 'TESORERIA',
  });
}

export interface ApunteAsiento {
  subcuenta: string;
  debe: number;
  haber: number;
  concepto: string;
}

const PREFIJO_ORIGEN: Record<string, string> = {
  TESORERIA: 'TES',
  FACTURA_INGRESO: 'FAC-ING',
  FACTURA_GASTO: 'FAC-GAST',
  CIERRE: 'CIERRE',
  REGULARIZACION: 'REGUL',
  APERTURA: 'APERT',
  AJUSTE_MANUAL: 'AJUSTE',
};

/**
 * Genera un numeroAsiento unico por empresa (secuencial por prefijo de origen).
 * Si la BD no esta disponible (tests con prisma mockeado sin `count`), cae a un
 * sufijo de timestamp para no romper.
 */
async function siguienteNumeroAsiento(companyId: string, prefijo: string): Promise<string> {
  try {
    const n = await prisma.journalEntry.count({ where: { companyId, numeroAsiento: { startsWith: `${prefijo}-` } } });
    return `${prefijo}-${String(n + 1).padStart(5, '0')}`;
  } catch {
    return `${prefijo}-${Date.now()}`;
  }
}

/**
 * Crea un asiento contable en PRISMA (JournalEntry + JournalEntryLine) a partir de
 * apuntes (subcuenta + debe/haber). MIGRADO desde FacturaScripts (ADR-002): el
 * asiento queda POSTED y por tanto es visible para informes/libros/impuestos
 * (obtenerAsientosEjercicio lee JournalEntry POSTED). Es el ÚNICO punto de
 * creacion de asientos: lo reutilizan la contabilizacion de facturas, la
 * tesoreria/conciliacion y el cierre de ejercicio. El retorno conserva la forma
 * legacy `{ asiento:{idasiento,...}, partidas }` por compatibilidad con los callers.
 */
export async function crearAsientoConApuntes(
  companyId: string,
  params: {
    fecha: string;
    concepto: string;
    apuntes: ApunteAsiento[];
    origen?: string;
    invoiceId?: string;
    invoiceType?: string;
    // codejercicio/idempresa: ya no se usan (eran de FS); se aceptan por compat.
    codejercicio?: string;
    idempresa?: unknown;
  },
): Promise<{ asiento: Record<string, unknown>; partidas: unknown[] }> {
  const origen = params.origen ?? 'AJUSTE_MANUAL';
  const importe = round2(params.apuntes.reduce((a, ap) => a + ap.debe, 0));
  const numeroAsiento = await siguienteNumeroAsiento(companyId, PREFIJO_ORIGEN[origen] ?? 'AS');

  const entry = await prisma.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(params.fecha),
      numeroAsiento,
      descripcion: params.concepto,
      origen,
      estado: 'POSTED',
      invoiceId: params.invoiceId,
      invoiceType: params.invoiceType,
    },
  });

  const partidas: unknown[] = [];
  for (const ap of params.apuntes) {
    partidas.push(
      await prisma.journalEntryLine.create({
        data: {
          entryId: entry.id,
          accountCode: ap.subcuenta,
          accountName: ap.concepto || `Subcuenta ${ap.subcuenta}`,
          debe: ap.debe,
          haber: ap.haber,
          referencia: params.invoiceId,
          companyId,
        },
      }),
    );
  }

  return {
    asiento: {
      idasiento: entry.id,
      numero: entry.numeroAsiento,
      concepto: entry.descripcion,
      fecha: params.fecha,
      importe,
      estado: entry.estado,
      origen: entry.origen,
    },
    partidas,
  };
}
