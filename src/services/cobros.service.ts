import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { getFsClientForCompany } from './facturascripts-client';
import { Cobro, EstadoCobro, EstadoCobroFactura } from '../domain/cobros.model';
import { obtenerVencimiento, marcarComoLiquidado, crearVencimientos } from './vencimientos.service';
import { crearAsientoTesoreria } from './asientos.service';
import { subcuentaTercero } from './contabilidadReglas.service';
import { obtenerReglas } from './reglasContables.service';

/**
 * Cobros PERSISTIDOS en Prisma (tabla Cobro). Fallback en memoria si la BD no
 * esta disponible (tests con prisma mockeado).
 *
 * CRITICA 1 (auditoria) — VIA UNICA DE COBRO: registrarCobro ya NO anota un
 * cobro "sin contabilidad". Crea un vencimiento ad-hoc y lo liquida via
 * registrarCobroVencimiento, que SIEMPRE genera el asiento de tesoreria
 * (572/570 <-> 430/400). Patron Quipu: conciliar/cobrar = documento Cobrado +
 * contabilidad coherente con bancos.
 */
const memoria: Cobro[] = [];
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const dbOk = (): boolean => typeof (prisma as { cobro?: { findMany?: unknown } }).cobro?.findMany === 'function';

async function guardarCobro(c: Omit<Cobro, 'id'>): Promise<void> {
  if (dbOk()) {
    await prisma.cobro.create({ data: c });
    return;
  }
  memoria.push({ ...c, id: randomUUID() });
}

async function cobrosDeFactura(companyId: string, facturaId: string): Promise<Cobro[]> {
  if (dbOk()) {
    const rows = await prisma.cobro.findMany({ where: { companyId, facturaId }, orderBy: { fecha: 'asc' } });
    return rows.map((r) => ({ id: r.id, companyId: r.companyId, facturaId: r.facturaId, importe: r.importe, fecha: r.fecha }));
  }
  return memoria.filter((c) => c.companyId === companyId && c.facturaId === facturaId).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

/** Todos los cobros de la empresa agrupados por factura (para listados, 1 query). */
async function cobrosPorFactura(companyId: string): Promise<Map<string, Cobro[]>> {
  let lista: Cobro[];
  if (dbOk()) {
    const rows = await prisma.cobro.findMany({ where: { companyId }, orderBy: { fecha: 'asc' } });
    lista = rows.map((r) => ({ id: r.id, companyId: r.companyId, facturaId: r.facturaId, importe: r.importe, fecha: r.fecha }));
  } else {
    lista = memoria.filter((c) => c.companyId === companyId).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  }
  const mapa = new Map<string, Cobro[]>();
  for (const c of lista) {
    const arr = mapa.get(c.facturaId) ?? [];
    arr.push(c);
    mapa.set(c.facturaId, arr);
  }
  return mapa;
}

/**
 * Calculo PURO del estado de cobro a partir de la factura y sus cobros.
 * Reglas: pendiente (sin cobros) / parcial / cobrada (pendiente ~0 o FS pagada)
 * / vencida (hoy > vencimiento y pendiente > 0; prevalece sobre parcial).
 */
export function calcularEstadoCobroConCobros(
  factura: Record<string, unknown>,
  cobros: Cobro[],
  hoy: string = new Date().toISOString().slice(0, 10),
): EstadoCobroFactura {
  const total = round2(Number(factura.total ?? 0));
  let importeCobrado = round2(cobros.reduce((a, c) => a + c.importe, 0));
  if (importeCobrado === 0 && (factura.pagada === true || factura.pagada === 1)) importeCobrado = total;

  const importePendiente = round2(total - importeCobrado);
  const vencimiento = typeof factura.vencimiento === 'string' ? (factura.vencimiento as string).slice(0, 10) : undefined;

  let estadoCobro: EstadoCobro;
  if (importePendiente <= 0.005) estadoCobro = 'cobrada';
  else if (importeCobrado > 0) estadoCobro = 'parcial';
  else estadoCobro = 'pendiente';
  if (estadoCobro !== 'cobrada' && vencimiento && vencimiento < hoy) estadoCobro = 'vencida';

  return {
    estadoCobro,
    importeCobrado,
    importePendiente,
    fechaUltimoCobro: cobros.length ? cobros[cobros.length - 1].fecha : undefined,
  };
}

/** Estado de cobro de una factura ya leida (consulta sus cobros). */
export async function calcularEstadoCobro(
  companyId: string,
  factura: Record<string, unknown>,
  hoy?: string,
): Promise<EstadoCobroFactura> {
  const facturaId = String(factura.idfactura ?? factura.codigo ?? '');
  return calcularEstadoCobroConCobros(factura, await cobrosDeFactura(companyId, facturaId), hoy);
}

/** Relee la factura de FS y recalcula su estado de cobro. */
export async function recalcularEstadoCobroFactura(companyId: string, facturaId: string): Promise<EstadoCobroFactura> {
  const fs = await getFsClientForCompany(companyId);
  const factura = (await fs.getOne('facturaclientes', facturaId)) as Record<string, unknown>;
  return calcularEstadoCobro(companyId, factura);
}

/** Anexa estadoCobro a un lote de facturas con UNA sola consulta de cobros. */
export async function enriquecerFacturasConEstadoCobro<T extends Record<string, unknown>>(
  companyId: string,
  facturas: T[],
): Promise<Array<T & EstadoCobroFactura>> {
  const mapa = await cobrosPorFactura(companyId);
  return facturas.map((f) => {
    const id = String(f.idfactura ?? f.codigo ?? '');
    return { ...f, ...calcularEstadoCobroConCobros(f, mapa.get(id) ?? []) };
  });
}

/**
 * CRITICA 1 — registrar un cobro directo sobre la factura. VIA UNICA: crea un
 * vencimiento ad-hoc por el importe y lo liquida (asiento de tesoreria incluido).
 */
export async function registrarCobro(
  companyId: string,
  facturaId: string,
  importe: number,
  fecha: string,
  formaPago?: string,
): Promise<EstadoCobroFactura> {
  const [v] = await crearVencimientos(companyId, facturaId, 'cobro', [
    { fecha, importe: round2(importe), formaPago: formaPago ?? 'CONTADO' },
  ]);
  const r = await registrarCobroVencimiento(companyId, v.id, fecha, formaPago);
  return r.estado;
}

/**
 * Registra el cobro/pago de un VENCIMIENTO generando su asiento de tesoreria
 * (572/570 <-> 430/400) segun cuentasTesoreriaPorFormaPago, marca el vencimiento
 * liquidado, persiste el cobro y recalcula el estado de la factura.
 */
export async function registrarCobroVencimiento(
  companyId: string,
  vencimientoId: string,
  fecha: string,
  formaPago?: string,
): Promise<{ estado: EstadoCobroFactura; asientoTesoreria: unknown }> {
  const v = await obtenerVencimiento(companyId, vencimientoId);
  const reglas = await obtenerReglas(companyId);

  const fp = formaPago ?? v.formaPago;
  const cuentaTesoreria = reglas.cuentasTesoreriaPorFormaPago[fp] ?? reglas.cuentaTesoreriaPorDefecto;

  const fs = await getFsClientForCompany(companyId);
  const esCobro = v.tipo === 'cobro';
  const recurso = esCobro ? 'facturaclientes' : 'facturaproveedores';
  const factura = (await fs.getOne(recurso, v.facturaId)) as Record<string, unknown>;
  const codTercero = String((esCobro ? factura.codcliente : factura.codproveedor) ?? '');
  const cuentaTercero = subcuentaTercero(
    esCobro ? reglas.cuentaClientesPorDefecto : reglas.cuentaProveedoresPorDefecto,
    codTercero,
  );

  // Cobro (venta): tesoreria al debe, cliente al haber. Pago (compra): al reves.
  const concepto = `${esCobro ? 'Cobro' : 'Pago'} factura ${v.facturaId}`;
  const lineas = esCobro
    ? [
        { subcuenta: cuentaTesoreria, debe: v.importe, haber: 0, concepto },
        { subcuenta: cuentaTercero, debe: 0, haber: v.importe, concepto },
      ]
    : [
        { subcuenta: cuentaTercero, debe: v.importe, haber: 0, concepto },
        { subcuenta: cuentaTesoreria, debe: 0, haber: v.importe, concepto },
      ];

  const asientoTesoreria = await crearAsientoTesoreria(companyId, { fecha, descripcion: concepto, lineas });

  await marcarComoLiquidado(companyId, vencimientoId, fecha);
  if (esCobro) await guardarCobro({ companyId, facturaId: v.facturaId, importe: v.importe, fecha });

  const estado = await calcularEstadoCobro(companyId, factura);
  return { estado, asientoTesoreria };
}
