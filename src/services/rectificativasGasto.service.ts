/**
 * Abonos y facturas rectificativas de proveedor: lo que el alta, la
 * correccion, la anulacion y la ficha necesitan mirar en la BD (las reglas
 * puras estan en domain/rectificativa-gasto.model.ts y en el esquema del
 * cuerpo, schemas/factura-gasto.schemas.ts).
 *
 * Una rectificativa es una ExpenseInvoice con `esRectificativa` y los importes
 * de la rectificacion con su signo. Sus enlaces (ExpenseInvoiceRectificada)
 * dicen que rectifica: facturas de la app, facturas de fuera (numero y fecha)
 * o un periodo (rappel), con la parte de la rectificacion de cada una.
 */
import type { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { aCentimos, importeTexto } from '../utils/money';
import { TIPO_GASTO_INFO, esTipoGasto, fechaContableGasto, normalizarNumeroProveedor, type TipoGasto } from '../domain/factura-gasto.model';
import {
  CAUSA_INFO,
  cuentaPropuesta,
  imputacionIva,
  limiteIncremento,
  lineasDiferencia,
  repartir,
  textoRectifica,
  type Causa,
  type LineaRect,
  type TipoRectificativa,
} from '../domain/rectificativa-gasto.model';
import { comprobarImportesRectificativa, totalesLineas, totalesRectificativa, type FacturaGastoBody } from '../schemas/factura-gasto.schemas';
import { aplicadoPorFactura } from './cobrosPagos.service';

type Db = TransaccionBD | typeof prisma;

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
const euros = (c: number) => c / 100;
const numeroDe = (f: { numeroFacturaProveedor: string | null; numeroCompleto: string }) => f.numeroFacturaProveedor ?? f.numeroCompleto;

/** Un enlace de la rectificativa, listo para guardar. */
export interface EnlaceRectificativa {
  originalId: string | null;
  numeroOriginal: string | null;
  fechaOriginal: string | null;
  periodoDesde: string | null;
  periodoHasta: string | null;
  baseRectificada: number;
  cuotaRectificada: number;
  retencionRectificada: number;
}

/** Lo que el alta o la correccion guardan de una rectificativa, ademas de sus lineas. */
export interface PlanRectificativa {
  tipo: TipoRectificativa;
  causa: Causa;
  motivo: string | null;
  enlaces: EnlaceRectificativa[];
  /** El de la primera original de la app (si la hay). */
  tipoGasto: TipoGasto;
  /** Subcuenta del proveedor del asiento vigente de la primera original (40x/41x). */
  cuentaAcreedor: string | null;
  clave349: string | null;
  inmuebleArrendadoId: string | null;
  fechaImputacionIva: string | null;
  rectificaDesde: string | null;
  rectificaHasta: string | null;
  datosSustitucion: Prisma.InputJsonValue | null;
  /** Para la descripcion del asiento: «F-2026/118», «las compras del ...». */
  rectifica: string;
  /** Observaciones del libro de IVA. */
  observacionesLibro: string;
  /** Una original de fuera que no estaba pagada: el alta crea la compensacion «de fuera». */
  compensarFuera: boolean;
  avisos: string[];
}

/** Originales de la app con sus lineas (importes como number: config/decimales.ts). */
const cargarOriginales = (companyId: string, ids: string[]) =>
  prisma.expenseInvoice.findMany({ where: { companyId, id: { in: ids } }, include: { lineas: true } });
type OriginalApp = Awaited<ReturnType<typeof cargarOriginales>>[number];

/** Asiento vigente de una factura de gasto (el ultimo de origen FACTURA_GASTO que no esta REVERSED). */
async function asientoVigenteDe(db: Db, companyId: string, invoiceId: string) {
  return db.journalEntry.findFirst({
    where: { companyId, invoiceId, origen: 'FACTURA_GASTO', estado: { not: 'REVERSED' } },
    include: { lineas: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** Subcuenta del proveedor (40x/41x) que uso el asiento vigente de una factura, sin mirar el lado. */
export async function cuentaProveedorDeFactura(db: Db, companyId: string, invoiceId: string): Promise<string | null> {
  const a = await asientoVigenteDe(db, companyId, invoiceId);
  return a?.lineas.find((l) => /^4[01]/.test(l.accountCode))?.accountCode ?? null;
}

/** Rectificativas vigentes (no anuladas) que enlazan con cada original, sin `excluirId`. */
export async function rectificativasVigentesDe(db: Db, companyId: string, originalIds: string[], excluirId?: string) {
  if (!originalIds.length) return [];
  return db.expenseInvoiceRectificada.findMany({
    where: {
      companyId,
      originalId: { in: originalIds },
      rectificativa: { estado: { not: 'ANULADA' }, ...(excluirId ? { id: { not: excluirId } } : {}) },
    },
    include: { rectificativa: { select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, fechaEmision: true, totalFactura: true, tipoRectificativa: true, estado: true } } },
  });
}

/** Parte (total con IVA menos retencion) de un enlace. */
const totalEnlace = (e: { baseRectificada: number | null; cuotaRectificada: number | null; retencionRectificada: number | null }) =>
  aCentimos(Number(e.baseRectificada ?? 0)) + aCentimos(Number(e.cuotaRectificada ?? 0)) - aCentimos(Number(e.retencionRectificada ?? 0));

/** Cuenta de una linea para comparar la original con la corregida (sustitucion). */
function cuentaComun(original: OriginalApp, tipo: TipoGasto, cuentaFactura?: string): (c?: string | null) => string {
  const cuentas = [...new Set(original.lineas.map((l) => l.accountCode ?? TIPO_GASTO_INFO[tipo].cuenta))];
  const porDefecto = cuentaFactura ?? (cuentas.length === 1 ? cuentas[0] : TIPO_GASTO_INFO[tipo].cuenta);
  return (c) => c || porDefecto;
}

/**
 * Comprueba el bloque `rectificativa` contra la BD y prepara lo que se guarda:
 * enlaces con su parte, herencia de la original (tipo de gasto, subcuenta,
 * clave del 349 e inmueble), fecha de imputacion del IVA y, en la sustitucion
 * con la original en la app, las lineas de diferencia (cambia `v.lineas`).
 * `supplierId` es el proveedor elegido (null si es nuevo). `excluirId`: la
 * propia rectificativa al corregirla.
 */
export async function prepararRectificativa(
  companyId: string,
  v: FacturaGastoBody,
  supplierId: string | null,
  opciones: { excluirId?: string } = {},
): Promise<PlanRectificativa> {
  const r = v.rectificativa!;
  const avisos: string[] = [...(v.avisos ?? [])];
  const ids = r.originales.map((o) => o.id).filter((x): x is string => !!x);
  const encontradas = ids.length ? await cargarOriginales(companyId, ids) : [];
  const porId = new Map(encontradas.map((f) => [f.id, f]));

  const originalesApp: OriginalApp[] = [];
  r.originales.forEach((o, i) => {
    if (!o.id) return;
    const f = porId.get(o.id);
    if (!f) throw notFound('No se encuentra la factura que rectifica.', { campo: `rectificativa.originales.${i}.id` });
    const num = numeroDe(f);
    if (f.id === opciones.excluirId) throw badRequest('Una rectificativa no puede rectificarse a sí misma.', { campo: `rectificativa.originales.${i}.id` });
    if (f.supplierId !== supplierId) throw badRequest(`La factura ${num} es de otro proveedor.`, { campo: `rectificativa.originales.${i}.id` });
    if (f.estado === 'ANULADA') throw badRequest(`La factura ${num} está anulada: no se puede rectificar.`, { campo: `rectificativa.originales.${i}.id` });
    if (f.estado === 'DRAFT') {
      throw badRequest(`Aprueba antes la factura ${num}: está pendiente de revisar en el Motor contable.`, { campo: `rectificativa.originales.${i}.id` });
    }
    if (originalesApp.some((x) => x.id === f.id)) throw badRequest(`La factura ${num} está repetida.`, { campo: `rectificativa.originales.${i}.id` });
    originalesApp.push(f);
  });

  const masAntigua = [...originalesApp.map((f) => f.fechaEmision), ...r.originales.filter((o) => !o.id && o.fecha).map((o) => o.fecha!)].sort()[0] ?? null;
  if (masAntigua && v.fechaEmision < masAntigua) {
    throw badRequest(`La rectificativa no puede tener fecha anterior a la de la factura que rectifica (${ddmmaaaa(masAntigua)}).`, { campo: 'fechaEmision' });
  }

  // Tipo de gasto: el de la primera original de la app.
  const primera = originalesApp[0] ?? null;
  if (primera && esTipoGasto(primera.tipoGasto)) {
    if (originalesApp.some((f) => TIPO_GASTO_INFO[esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA'].acreedor !== TIPO_GASTO_INFO[primera.tipoGasto as TipoGasto].acreedor)) {
      avisos.push(`Las facturas que rectifica van a cuentas distintas del proveedor (400 y 410): el abono va a la de la ${numeroDe(primera)}.`);
    }
    v.tipoGasto = primera.tipoGasto;
  }
  const tipoGasto: TipoGasto = esTipoGasto(v.tipoGasto) ? v.tipoGasto : 'COMPRA';

  // Sustitucion con la original en la app: la diferencia con sus lineas.
  let datosSustitucion: Prisma.InputJsonValue | null = null;
  if (r.tipo === 'S' && r.corregida) {
    let originalLineas: LineaRect[];
    if (primera) {
      const cuenta = cuentaComun(primera, tipoGasto, v.cuentaGasto);
      originalLineas = primera.lineas.map((l) => ({
        descripcion: l.descripcion,
        cantidad: Number(l.cantidad),
        precioUnitario: Number(l.precioUnitario),
        descuentoPorcentaje: Number(l.descuentoPorcentaje),
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
        cuenta: cuenta(l.accountCode),
      }));
      const corregidas = r.corregida.lineas.map((l) => ({ ...l, cuenta: cuenta(l.cuenta ?? null) }));
      const dif = lineasDiferencia(originalLineas, corregidas);
      v.lineas = dif.lineas.map((l) => ({ ...l, descuentoPorcentaje: 0, tipoRetencion: l.tipoRetencion ?? 0 }));
      avisos.push(...dif.avisos);
      comprobarImportesRectificativa(v);
    } else {
      originalLineas = r.importesOriginales?.lineas ?? [];
    }
    datosSustitucion = {
      original: { lineas: originalLineas, totales: totalesLineas(originalLineas) },
      corregida: { lineas: r.corregida.lineas, totales: totalesLineas(r.corregida.lineas) },
    } as unknown as Prisma.InputJsonValue;
  }

  // Retenciones admitidas por el tipo de gasto heredado.
  v.lineas.forEach((l, i) => {
    if (!TIPO_GASTO_INFO[tipoGasto].retenciones.includes(l.tipoRetencion ?? 0)) {
      throw badRequest(`La factura que rectifica es de ${TIPO_GASTO_INFO[tipoGasto].texto.toLowerCase()}: esa retención no corresponde.`, { campo: `lineas.${i}.tipoRetencion` });
    }
  });

  const t = totalesRectificativa(v.lineas);
  const totalCent = aCentimos(t.total);

  // Con una sola original de la app, el abono acumulado no puede dejarla por debajo de cero.
  if (originalesApp.length === 1 && r.originales.length === 1) {
    const o = originalesApp[0];
    const otras = await rectificativasVigentesDe(prisma, companyId, [o.id], opciones.excluirId);
    const queda = aCentimos(Number(o.totalFactura)) + otras.reduce((a, e) => a + totalEnlace(e), 0) + totalCent;
    if (queda < 0) {
      throw badRequest(
        `Con este abono la factura ${numeroDe(o)} quedaría en ${importeTexto(euros(queda))}: el abono no puede pasar de lo que se facturó. Revisa el importe.`,
        { campo: 'lineas' },
      );
    }
    const tiposOriginal = new Set(o.lineas.map((l) => l.tipoIva));
    const nuevos = [...new Set(v.lineas.map((l) => l.tipoIva))].filter((x) => !tiposOriginal.has(x));
    if (nuevos.length) avisos.push(`La factura ${numeroDe(o)} no tiene IVA al ${nuevos.join(' % ni al ')} %: comprueba el tipo.`);
  }

  // Plazo para deducir un incremento de IVA.
  const fechaContable = v.fechaRegistro ?? v.fechaEmision;
  if (aCentimos(t.iva) > 0) {
    const limite = limiteIncremento({ causa: r.causa, fechaDevengoOriginal: masAntigua, fechaEmision: v.fechaEmision });
    if (limite && fechaContable > limite) {
      throw badRequest(
        `El plazo para deducir este IVA terminó el ${ddmmaaaa(limite)}: regístrala con el IVA al 0 % y el importe con IVA como base, o consúltalo con tu asesor.`,
        { campo: 'fechaRegistro' },
      );
    }
  }
  if (masAntigua) {
    const [a, m, d] = masAntigua.split('-');
    if (`${Number(a) + 4}-${m}-${d}` < v.fechaEmision) {
      avisos.push('La factura que rectifica tiene más de cuatro años. Se registra igual (el plazo era del proveedor), pero si tienes dudas consúltalo con tu asesor.');
    }
  }

  // Enlaces: una fila por original (con su parte) o una de periodo.
  let enlaces: EnlaceRectificativa[];
  if (r.periodo) {
    enlaces = [
      { originalId: null, numeroOriginal: null, fechaOriginal: null, periodoDesde: r.periodo.desde, periodoHasta: r.periodo.hasta, baseRectificada: t.base, cuotaRectificada: t.iva, retencionRectificada: t.retencion },
    ];
  } else {
    const n = r.originales.length;
    let bases: number[];
    let cuotas: number[];
    let retenciones: number[];
    if (n === 1) {
      bases = [t.base];
      cuotas = [t.iva];
      retenciones = [t.retencion];
    } else if (r.originales.every((o) => o.base !== undefined)) {
      bases = r.originales.map((o) => o.base!);
      cuotas = r.originales.every((o) => o.cuota !== undefined) ? r.originales.map((o) => o.cuota!) : repartir(t.iva, bases);
      retenciones = r.originales.every((o) => o.retencion !== undefined) ? r.originales.map((o) => o.retencion!) : repartir(t.retencion, bases);
    } else {
      // Sin reparto: en proporcion a lo pendiente de cada una y, si no queda nada, a su base.
      const aplicado = await aplicadoPorFactura(companyId, originalesApp.map((f) => f.id));
      const pendientes = r.originales.map((o) => {
        const f = o.id ? porId.get(o.id)! : null;
        return f ? Math.max(0, aCentimos(Number(f.totalFactura)) - aCentimos(aplicado.get(f.id) ?? 0)) / 100 : 0;
      });
      const pesos = pendientes.some((p) => p > 0)
        ? pendientes
        : r.originales.map((o) => (o.id ? Number(porId.get(o.id)!.baseTotal) : Math.abs(o.base ?? 0)));
      bases = repartir(t.base, pesos);
      cuotas = repartir(t.iva, pesos);
      retenciones = repartir(t.retencion, pesos);
    }
    enlaces = r.originales.map((o, i) => {
      const f = o.id ? porId.get(o.id)! : null;
      return {
        originalId: f?.id ?? null,
        numeroOriginal: f ? numeroDe(f) : (o.numero ?? null),
        fechaOriginal: f ? f.fechaEmision : (o.fecha ?? null),
        periodoDesde: null,
        periodoHasta: null,
        baseRectificada: bases[i],
        cuotaRectificada: cuotas[i],
        retencionRectificada: retenciones[i],
      };
    });
  }

  const imp = imputacionIva({
    causa: r.causa,
    cuota: t.iva,
    fechaContable,
    fechaOriginalContable: primera ? fechaContableGasto(primera) : (r.originales.find((o) => o.fecha)?.fecha ?? null),
  });
  const cuentaAcreedor = primera ? await cuentaProveedorDeFactura(prisma, companyId, primera.id) : null;
  const rectifica = r.periodo
    ? `las compras del ${ddmmaaaa(r.periodo.desde)} al ${ddmmaaaa(r.periodo.hasta)}`
    : enlaces.map((e) => e.numeroOriginal ?? 'sin número').join(', ');

  return {
    tipo: r.tipo,
    causa: r.causa,
    motivo: r.motivo?.trim() || null,
    enlaces,
    tipoGasto,
    cuentaAcreedor,
    clave349: primera?.clave349 ?? null,
    inmuebleArrendadoId: primera?.inmuebleArrendadoId ?? null,
    fechaImputacionIva: imp.fecha !== fechaContable ? imp.fecha : null,
    rectificaDesde: r.periodo?.desde ?? null,
    rectificaHasta: r.periodo?.hasta ?? null,
    datosSustitucion,
    rectifica,
    observacionesLibro: textoRectifica({
      tipo: r.tipo,
      causa: r.causa,
      originales: enlaces.map((e) => ({ numero: e.numeroOriginal, fecha: e.fechaOriginal })),
      periodo: r.periodo ?? null,
    }),
    compensarFuera: r.yaPagada === false && !originalesApp.length && !r.periodo && totalCent < 0,
    avisos,
  };
}

/** Columnas de ExpenseInvoice de una rectificativa (alta y correccion). */
export const columnasRectificativa = (p: PlanRectificativa | null) =>
  p
    ? {
        esRectificativa: true,
        tipoRectificativa: p.tipo,
        causaRectificacion: p.causa,
        motivoRectificacion: p.motivo,
        rectificaDesde: p.rectificaDesde,
        rectificaHasta: p.rectificaHasta,
        fechaImputacionIva: p.fechaImputacionIva,
        datosSustitucion: p.datosSustitucion ?? undefined,
        clave349: p.clave349,
        inmuebleArrendadoId: p.inmuebleArrendadoId,
      }
    : {};

/** Guarda los enlaces de la rectificativa (borra antes los que tuviera, al corregirla). */
export async function guardarEnlaces(tx: TransaccionBD, companyId: string, rectificativaId: string, enlaces: EnlaceRectificativa[]): Promise<void> {
  await tx.expenseInvoiceRectificada.deleteMany({ where: { companyId, rectificativaId } });
  if (enlaces.length) await tx.expenseInvoiceRectificada.createMany({ data: enlaces.map((e) => ({ ...e, companyId, rectificativaId })) });
}

/**
 * 409 si la factura tiene rectificativas vigentes: no se puede anular ni
 * cambiar sus importes (sí sus datos sin importes: vencimiento, observaciones).
 */
export async function comprobarSinRectificativas(companyId: string, id: string, accion: 'anular' | 'corregir'): Promise<void> {
  const vigentes = await rectificativasVigentesDe(prisma, companyId, [id]);
  if (!vigentes.length) return;
  const lista = [...new Set(vigentes.map((e) => numeroDe(e.rectificativa)))].join(', ');
  const una = vigentes.length === 1;
  throw conflict(
    `Tiene ${una ? 'la rectificativa' : 'las rectificativas'} ${lista}: ${una ? 'anúlala' : 'anúlalas'} antes de ${accion === 'anular' ? 'anular la factura' : 'cambiar sus importes'}.`,
    { motivo: 'tiene_rectificativas', rectificativas: vigentes.map((e) => e.rectificativa.id) },
  );
}

/** Lo que la ficha de una factura de gasto ensena de las rectificativas (las suyas o lo que rectifica). */
export async function datosRectificativaDeFicha(
  companyId: string,
  f: {
    id: string;
    esRectificativa: boolean;
    tipoRectificativa: string | null;
    causaRectificacion: string | null;
    motivoRectificacion: string | null;
    rectificaDesde: string | null;
    rectificaHasta: string | null;
    fechaImputacionIva: string | null;
    fechaEmision: string;
    fechaRegistro: string | null;
  },
) {
  const vigentes = await rectificativasVigentesDe(prisma, companyId, [f.id]);
  const rectificativas = [...new Map(vigentes.map((e) => [e.rectificativa.id, e.rectificativa])).values()].map((x) => ({
    id: x.id,
    numeroCompleto: x.numeroCompleto,
    numero: x.numeroFacturaProveedor,
    fecha: x.fechaEmision,
    total: x.totalFactura,
    tipo: x.tipoRectificativa,
  }));
  if (!f.esRectificativa) return { rectificativa: null, rectificativas, facturaOriginalId: null };

  const enlaces = await prisma.expenseInvoiceRectificada.findMany({
    where: { companyId, rectificativaId: f.id },
    include: { original: { select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, fechaEmision: true } } },
  });
  const causa = (f.causaRectificacion ?? 'DEVOLUCION') as Causa;
  const contable = fechaContableGasto(f);
  const fechaIva = f.fechaImputacionIva ?? contable;
  const originales = enlaces
    .filter((e) => !e.periodoDesde)
    .map((e) => ({
      id: e.originalId,
      numeroCompleto: e.original?.numeroCompleto ?? null,
      numero: e.numeroOriginal,
      fecha: e.fechaOriginal,
      base: e.baseRectificada,
      cuota: e.cuotaRectificada,
    }));
  const conApp = originales.filter((o) => o.id);
  return {
    rectificativa: {
      tipo: f.tipoRectificativa,
      causa,
      causaTexto: CAUSA_INFO[causa]?.texto ?? causa,
      motivo: f.motivoRectificacion,
      originales,
      periodo: f.rectificaDesde && f.rectificaHasta ? { desde: f.rectificaDesde, hasta: f.rectificaHasta } : null,
      imputacionIva: { fecha: fechaIva, casillas: f.fechaImputacionIva ? '28-29' : '40-41' },
    },
    rectificativas,
    facturaOriginalId: conApp.length === 1 && originales.length === 1 ? conApp[0].id : null,
  };
}

/**
 * Candidatas a original de un abono (GET /originales y el lector): facturas
 * vigentes (ni anuladas ni en borrador) del proveedor (por id o por NIF), con
 * el numero normalizado igual (EXACTA) o parecido (PARECIDA), 8 como mucho.
 */
export async function buscarOriginales(
  companyId: string,
  q: { supplierId?: string | null; numero?: string | null; nif?: string | null },
): Promise<{ coincidencia: 'EXACTA' | 'PARECIDA' | 'NINGUNA'; candidatas: Array<{ id: string; numeroCompleto: string; numero: string | null; fecha: string; total: number; exacta: boolean }> }> {
  let supplierId = q.supplierId?.trim() || null;
  if (!supplierId && q.nif?.trim()) {
    const s = await prisma.supplier.findFirst({ where: { companyId, nifCif: q.nif.trim().toUpperCase() }, select: { id: true } });
    supplierId = s?.id ?? null;
  }
  if (!supplierId) return { coincidencia: 'NINGUNA', candidatas: [] };
  const numero = q.numero?.trim() ? normalizarNumeroProveedor(q.numero) : '';
  const facturas = await prisma.expenseInvoice.findMany({
    where: { companyId, supplierId, estado: { notIn: ['ANULADA', 'DRAFT'] } },
    select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, numeroProveedorActivo: true, fechaEmision: true, totalFactura: true, esRectificativa: true },
    orderBy: [{ fechaEmision: 'desc' }, { numero: 'desc' }],
    take: 500,
  });
  const soloCifras = (s: string) => s.replace(/[^0-9]/g, '').replace(/^0+/, '');
  const puntuadas = facturas
    .map((f) => {
      const n = f.numeroProveedorActivo ?? normalizarNumeroProveedor(f.numeroFacturaProveedor ?? '');
      const exacta = !!numero && n === numero;
      const parecida = !!numero && !exacta && !!n && (n.includes(numero) || numero.includes(n) || (soloCifras(n) !== '' && soloCifras(n) === soloCifras(numero)));
      return { f, exacta, parecida };
    })
    .filter((x) => !numero || x.exacta || x.parecida);
  puntuadas.sort((a, b) => Number(b.exacta) - Number(a.exacta));
  const candidatas = puntuadas.slice(0, 8).map(({ f, exacta }) => ({
    id: f.id,
    numeroCompleto: f.numeroCompleto,
    numero: f.numeroFacturaProveedor,
    fecha: f.fechaEmision,
    total: f.totalFactura,
    exacta,
  }));
  const coincidencia = candidatas.some((c) => c.exacta) ? 'EXACTA' : candidatas.length && numero ? 'PARECIDA' : 'NINGUNA';
  return { coincidencia, candidatas };
}

/**
 * Datos para prellenar un abono de la factura `id` (GET /:id/rectificar):
 * proveedor, tipo de gasto, lineas con su cuenta y la que se propone por
 * causa, lo ya rectificado, lo pendiente y el abono maximo.
 */
export async function datosParaRectificar(companyId: string, id: string) {
  const f = await prisma.expenseInvoice.findFirst({
    where: { id, companyId },
    include: { lineas: true, supplier: { select: { id: true, nombreFiscal: true, nifCif: true, pais: true } } },
  });
  if (!f) throw notFound('Factura de gasto no encontrada.');
  if (f.estado === 'ANULADA') throw conflict(`La factura ${numeroDe(f)} está anulada: no se puede rectificar.`);
  if (f.estado === 'DRAFT') throw conflict(`Aprueba antes la factura ${numeroDe(f)}: está pendiente de revisar en el Motor contable.`);
  const tipo: TipoGasto = esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA';
  const vigentes = await rectificativasVigentesDe(prisma, companyId, [f.id]);
  const yaRectificado = vigentes.reduce((a, e) => a + totalEnlace(e), 0);
  const aplicado = (await aplicadoPorFactura(companyId, [f.id])).get(f.id) ?? 0;
  const total = aCentimos(Number(f.totalFactura));
  const causas = Object.keys(CAUSA_INFO) as Causa[];
  return {
    original: {
      id: f.id,
      numeroCompleto: f.numeroCompleto,
      numero: f.numeroFacturaProveedor,
      fechaEmision: f.fechaEmision,
      fechaRegistro: f.fechaRegistro,
      baseTotal: f.baseTotal,
      ivaTotal: f.ivaTotal,
      retencionTotal: f.retencionTotal,
      totalFactura: f.totalFactura,
      esRectificativa: f.esRectificativa,
    },
    proveedor: f.supplier,
    tipoGasto: tipo,
    tipoGastoTexto: TIPO_GASTO_INFO[tipo].texto,
    lineas: f.lineas.map((l) => {
      const cuenta = l.accountCode ?? TIPO_GASTO_INFO[tipo].cuenta;
      return {
        descripcion: l.descripcion,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario,
        descuentoPorcentaje: l.descuentoPorcentaje,
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
        baseLine: l.baseLine,
        ivaImporte: l.ivaImporte,
        cuenta,
        cuentaPropuesta: Object.fromEntries(causas.map((c) => [c, cuentaPropuesta(c, cuenta, false)])),
        cuentaPropuestaConPeriodo: cuentaPropuesta('DESCUENTO', cuenta, true),
      };
    }),
    rectificativas: [...new Map(vigentes.map((e) => [e.rectificativa.id, e.rectificativa])).values()].map((x) => ({
      id: x.id,
      numeroCompleto: x.numeroCompleto,
      numero: x.numeroFacturaProveedor,
      fecha: x.fechaEmision,
      total: x.totalFactura,
      tipo: x.tipoRectificativa,
    })),
    yaRectificado: euros(yaRectificado),
    // Lo aplicado ya incluye lo que sus abonos le descontaron (compensaciones).
    pendiente: euros(total - aCentimos(aplicado)),
    /** Lo que se puede abonar como mucho (en positivo): lo que queda de la factura tras sus rectificativas. */
    abonoMaximo: euros(Math.max(0, total + yaRectificado)),
    causas: causas.map((c) => ({ causa: c, texto: CAUSA_INFO[c].texto, admitePeriodo: CAUSA_INFO[c].admitePeriodo, soloBaja: CAUSA_INFO[c].soloBaja })),
  };
}
