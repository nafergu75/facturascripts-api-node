/**
 * Rectificativas y abonos de venta: lo que el alta, la correccion del
 * borrador, la emision, la ficha, el buscador de originales y el lector
 * necesitan mirar en la BD. Las reglas puras estan en
 * domain/rectificativa-venta.model.ts.
 *
 * Una rectificativa de venta es una IncomeInvoice con `esRectificativa`, su
 * motivo (`causaRectificacion`) y sus enlaces (IncomeInvoiceRectificada): las
 * facturas de la app que rectifica, las de fuera (numero y fecha, y la partida
 * de cobro de 2026 que rebaja) o un periodo (rappel), con la parte de cada una.
 * Con una sola original se siguen rellenando facturaOriginalId (de la app) o
 * rectificaFueraNumero/Fecha (de fuera), como antes: Carmen, la cartera y el
 * PDF antiguos siguen funcionando. Las rectificativas anteriores a la tabla no
 * se migran: enlacesDeVenta lee la tabla y, si esta vacia, esos campos.
 *
 * Este modulo no importa income-invoices.service (que lo usa) ni
 * cobrosPagos.service (que usa aFavorDeAbonos), para no crear ciclos.
 */
import type { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { aCentimos, importeTexto } from '../utils/money';
import { fechaTexto } from '../utils/fechas';
import { inicioLlevanzaApp } from '../utils/anios';
import { fechaDevengoVenta, type AvisoFiscal } from '../domain/tipo-operacion.model';
import {
  MOTIVOS_VENTA,
  MOTIVO_INFO,
  cuentaPorTipoIva,
  diferenciaSustitucion,
  esMotivoVenta,
  exigeImputarAlPeriodoOriginal,
  limitePlazo,
  repartoCuadra,
  subeCuotaAConsumidorFinal,
  tipoFacturaDe,
  type FormaRectificacion,
  type LineaImportes,
  type MotivoVenta,
} from '../domain/rectificativa-venta.model';
import { codigoSerieTickets, obtenerSeriePorDefecto } from './series.service';
import { numeroComparable, pendientePorPartida } from './arranque/partidas.service';

type Db = TransaccionBD | typeof prisma;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const fechaValida = (f: string): boolean => FECHA_RE.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
const euros = (c: number) => (c === 0 ? 0 : c / 100);
const sumaCent = (xs: number[]) => xs.reduce((a, x) => a + aCentimos(x), 0);

/** Factura de venta con sus lineas y su cliente (importes como number: config/decimales.ts). */
const cargarFacturas = (db: Db, companyId: string, ids: string[]) =>
  db.incomeInvoice.findMany({ where: { companyId, id: { in: ids } }, include: { lineas: true, customer: true } });
export type FacturaVenta = Awaited<ReturnType<typeof cargarFacturas>>[number];

// ---------------------------------------------------------------------------
// El bloque `rectificativa` del cuerpo
// ---------------------------------------------------------------------------

/** Una factura que se rectifica, tal como llega: de la app (id) o de fuera (numero y fecha, o la partida de 2026). */
export interface OriginalPedida {
  id?: string;
  numero?: string;
  fecha?: string;
  partidaId?: string;
  base?: number;
  cuota?: number;
  retencion?: number;
}

export interface BloqueVenta {
  /** «Rectificativa de un ticket» (R5) frente a «Rectificativa o abono» (R1-R4). */
  ticket: boolean;
  forma: FormaRectificacion;
  /** null: rectificativa hecha con los campos antiguos (facturaOriginalId, rectificaFuera...). */
  motivo: MotivoVenta | null;
  /** La causa en palabras: va al PDF (motivoRectificacion). */
  explicacion: string;
  originales: OriginalPedida[];
  periodo: { desde: string; hasta: string } | null;
  /** Traducido de los campos antiguos (frontend antiguo y /credit-note): sin las reglas que dependen del motivo. */
  legado: boolean;
}

const importeDelReparto = (v: unknown, campo: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw badRequest('El importe del reparto entre las facturas no es un número.', { codigo: 'REPARTO_NO_CUADRA', campo });
  return n;
};

/** Lee y comprueba la forma del bloque `rectificativa` (las reglas que necesitan la BD van en prepararRectificativaVenta). */
export function leerBloque(raw: unknown): BloqueVenta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Los datos de la rectificativa no tienen el formato esperado.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa' });
  }
  const r = raw as Record<string, unknown>;
  if (r.ticket !== undefined && r.ticket !== null && typeof r.ticket !== 'boolean') {
    throw badRequest('Indica si es la rectificativa de un ticket (sí o no).', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.ticket' });
  }
  const forma = r.forma === undefined || r.forma === null || r.forma === '' ? 'I' : r.forma;
  if (forma !== 'I' && forma !== 'S') {
    throw badRequest('Elige cómo rectificas: por diferencias o por sustitución.', { codigo: 'FORMA_NO_VALIDA', campo: 'rectificativa.forma' });
  }
  if (r.motivo === undefined || r.motivo === null || r.motivo === '') {
    throw badRequest('Elige el motivo de la rectificación.', { codigo: 'MOTIVO_NO_VALIDO', campo: 'rectificativa.motivo' });
  }
  if (!esMotivoVenta(r.motivo)) {
    throw badRequest('El motivo de la rectificación no es válido: elige uno de la lista.', { codigo: 'MOTIVO_NO_VALIDO', campo: 'rectificativa.motivo' });
  }
  const info = MOTIVO_INFO[r.motivo];
  if (!info.disponible) throw badRequest(info.aviso ?? 'Ese motivo todavía no se puede usar.', { codigo: 'MOTIVO_NO_DISPONIBLE', campo: 'rectificativa.motivo' });
  if (r.explicacion !== undefined && r.explicacion !== null && typeof r.explicacion !== 'string') {
    throw badRequest('La explicación de la rectificación tiene que ser un texto.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.explicacion' });
  }
  const explicacion = String(r.explicacion ?? '').trim();
  if (explicacion.length > 1000) {
    throw badRequest('La explicación es demasiado larga (1.000 caracteres como mucho).', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.explicacion' });
  }

  if (r.originales !== undefined && r.originales !== null && !Array.isArray(r.originales)) {
    throw badRequest('Las facturas que rectificas no tienen el formato esperado.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.originales' });
  }
  const lista = (r.originales ?? []) as unknown[];
  if (lista.length > 50) throw badRequest('Una rectificativa puede rectificar 50 facturas como mucho.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.originales' });
  const originales: OriginalPedida[] = lista.map((x, i) => {
    const campo = `rectificativa.originales.${i}`;
    if (!x || typeof x !== 'object') throw badRequest('Las facturas que rectificas no tienen el formato esperado.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo });
    const o = x as Record<string, unknown>;
    const importes = {
      base: importeDelReparto(o.base, `${campo}.base`),
      cuota: importeDelReparto(o.cuota, `${campo}.cuota`),
      retencion: importeDelReparto(o.retencion, `${campo}.retencion`),
    };
    if (typeof o.id === 'string' && o.id.trim()) return { id: o.id.trim(), ...importes };
    const numero = typeof o.numero === 'string' ? o.numero.trim() : '';
    const partidaId = typeof o.partidaId === 'string' && o.partidaId.trim() ? o.partidaId.trim() : undefined;
    if (!numero && !partidaId) throw badRequest('Escribe el número de la factura que rectificas.', { codigo: 'RECTIFICATIVA_SIN_ORIGINAL', campo: `${campo}.numero` });
    if (numero.length > 60) {
      throw badRequest('El número de la factura que rectificas es demasiado largo (60 caracteres como mucho).', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: `${campo}.numero` });
    }
    const fecha = typeof o.fecha === 'string' ? o.fecha.trim() : '';
    if (fecha && !fechaValida(fecha)) {
      throw badRequest(`Escribe la fecha de la factura ${numero || 'que rectificas'} (día, mes y año).`, { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: `${campo}.fecha` });
    }
    if (!fecha && !partidaId) throw badRequest(`Indica la fecha de la factura ${numero}.`, { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: `${campo}.fecha` });
    return { ...(numero ? { numero } : {}), ...(fecha ? { fecha } : {}), ...(partidaId ? { partidaId } : {}), ...importes };
  });

  let periodo: BloqueVenta['periodo'] = null;
  if (r.periodo !== undefined && r.periodo !== null) {
    const p = r.periodo as Record<string, unknown>;
    const desde = typeof p?.desde === 'string' ? p.desde.trim() : '';
    const hasta = typeof p?.hasta === 'string' ? p.hasta.trim() : '';
    if (!fechaValida(desde) || !fechaValida(hasta)) {
      throw badRequest('Indica el periodo del rappel o del descuento: desde y hasta.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.periodo' });
    }
    if (desde > hasta) throw badRequest('El periodo está al revés: «desde» es posterior a «hasta».', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.periodo' });
    periodo = { desde, hasta };
  }
  if (periodo && originales.length) {
    throw badRequest('Indica las facturas que rectificas o el periodo del rappel, no las dos cosas.', { codigo: 'PERIODO_SOLO_RAPPEL', campo: 'rectificativa.periodo' });
  }
  if (periodo && !info.admitePeriodo) {
    throw badRequest('Un periodo solo vale para un rappel o un descuento por volumen. Con otro motivo, indica las facturas que rectificas.', {
      codigo: 'PERIODO_SOLO_RAPPEL',
      campo: 'rectificativa.periodo',
    });
  }
  if (!periodo && !originales.length) {
    throw badRequest('Indica qué factura rectificas. Si no está en la app, escribe su número y su fecha; si es un rappel, el periodo.', {
      codigo: 'RECTIFICATIVA_SIN_ORIGINAL',
      campo: 'rectificativa.originales',
    });
  }
  return { ticket: r.ticket === true, forma, motivo: r.motivo, explicacion, originales, periodo, legado: false };
}

// ---------------------------------------------------------------------------
// Preparacion (antes de los importes) y cierre (con los importes)
// ---------------------------------------------------------------------------

/** Una fila de enlace, lista para guardar en IncomeInvoiceRectificada. */
export interface EnlaceVenta {
  originalId: string | null;
  numeroOriginal: string | null;
  fechaOriginal: string | null;
  periodoDesde: string | null;
  periodoHasta: string | null;
  partidaPendienteId: string | null;
  baseRectificada: number;
  cuotaRectificada: number;
  retencionRectificada: number;
}

interface FilaPlan extends Omit<EnlaceVenta, 'baseRectificada' | 'cuotaRectificada' | 'retencionRectificada'> {
  pedido: { base?: number; cuota?: number; retencion?: number };
  /** Devengo de la original (el de la app o la fecha escrita): plazos y R4 que sube el IVA. */
  devengo: string | null;
}

export interface PlanVenta {
  bloque: BloqueVenta;
  tipoFactura: string;
  /** Originales de la app, en el orden del bloque. */
  originalesApp: FacturaVenta[];
  /** La primera de la app: de ella se heredan la moneda, el tipo de cambio y el tipo de operacion. */
  herencia: FacturaVenta | null;
  /** Cliente de la rectificativa cuando lo fijan las originales (o la partida de 2026); null: el del cuerpo. */
  customerId: string | null;
  filas: FilaPlan[];
  avisos: AvisoFiscal[];
}

export interface ContextoPlan {
  companyId: string;
  fechaEmision: string;
  borrador: boolean;
  monedaCuenta: string;
  /** tipoFactura del cuerpo: opcional; si llega tiene que ser el del motivo. En el camino antiguo, el que se pidio. */
  tipoFacturaPedido?: string;
  /** Cliente del cuerpo. */
  customerId?: string | null;
  customerNuevo?: boolean;
  /** Al corregir o emitir el borrador: la propia rectificativa (no cuenta en los limites). */
  excluirId?: string;
}

const numeroDe = (f: { numeroCompleto: string | null }) => f.numeroCompleto ?? 'sin número';

/** Mensaje y codigo de una original de la app que no se puede rectificar, o null. */
export function problemaOriginal(f: { estadoDocumento: string; estado: string; esRectificativa: boolean; numeroCompleto: string | null }): string | null {
  if (f.estadoDocumento === 'PROFORMA') return 'Una proforma no se rectifica: mientras esté pendiente, modifícala.';
  if (f.estadoDocumento !== 'FINAL' || f.estado === 'DRAFT') return 'Un borrador no se rectifica: modifícalo directamente.';
  if (f.esRectificativa) {
    return `La ${numeroDe(f)} ya es una rectificativa: no se rectifica. Si hay que corregirla, haz otra rectificativa de la factura original.`;
  }
  return null;
}

/**
 * Comprueba el bloque contra la BD antes de calcular los importes: originales
 * de la app (de la empresa, emitidas, ni rectificativas ni proformas, del
 * mismo cliente, misma moneda y tipo de operacion), originales de fuera
 * (anteriores a llevar la facturacion en la app, con su partida de 2026),
 * tipo R por motivo, ticket o no, sustitucion y fechas.
 */
export async function prepararRectificativaVenta(b: BloqueVenta, ctx: ContextoPlan): Promise<PlanVenta> {
  const avisos: AvisoFiscal[] = [];
  // Tipo de VERI*FACTU: el del motivo (o R5 si es de un ticket). Si llega, tiene que coincidir.
  let tipoFactura = (ctx.tipoFacturaPedido ?? '').toUpperCase() || 'R1';
  if (b.motivo) {
    const t = tipoFacturaDe(b.motivo, b.ticket);
    const pedido = (ctx.tipoFacturaPedido ?? '').trim().toUpperCase();
    if (pedido && pedido !== t) {
      throw badRequest(
        `Con el motivo «${MOTIVO_INFO[b.motivo].texto.toLowerCase()}» la rectificativa${b.ticket ? ' de un ticket' : ''} es ${t}, no ${pedido}.`,
        { codigo: 'TIPO_NO_CUADRA_CON_MOTIVO', campo: 'tipoFactura' },
      );
    }
    tipoFactura = t;
    if (!ctx.borrador && !b.explicacion) {
      throw badRequest('Explica en una frase por qué rectificas la factura: es obligatorio y sale en el PDF.', {
        codigo: 'FALTA_EXPLICACION',
        campo: 'rectificativa.explicacion',
      });
    }
  }

  // Originales de la app.
  const ids = b.originales.map((o) => o.id).filter((x): x is string => !!x);
  const vistas = new Set<string>();
  b.originales.forEach((o, i) => {
    if (!o.id) return;
    if (vistas.has(o.id)) throw badRequest('Has elegido la misma factura dos veces.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: `rectificativa.originales.${i}` });
    vistas.add(o.id);
  });
  const encontradas = ids.length ? await cargarFacturas(prisma, ctx.companyId, ids) : [];
  const porId = new Map(encontradas.map((f) => [f.id, f]));
  const originalesApp: FacturaVenta[] = [];
  b.originales.forEach((o, i) => {
    if (!o.id) return;
    const campo = `rectificativa.originales.${i}`;
    const f = porId.get(o.id);
    if (!f) throw notFound('La factura que rectificas no existe.', { codigo: 'ORIGINAL_NO_ENCONTRADA', campo });
    if (f.id === ctx.excluirId) throw badRequest('Una rectificativa no puede rectificarse a sí misma.', { codigo: 'ORIGINAL_NO_RECTIFICABLE', campo });
    const problema = problemaOriginal(f);
    if (problema) throw badRequest(problema, { codigo: 'ORIGINAL_NO_RECTIFICABLE', campo });
    originalesApp.push(f);
  });
  const herencia = originalesApp[0] ?? null;

  // Cliente: el de las originales de la app, todas del mismo.
  let customerId: string | null = null;
  if (herencia) {
    customerId = herencia.customerId;
    b.originales.forEach((o, i) => {
      const f = o.id ? porId.get(o.id)! : null;
      if (f && f.customerId !== customerId) {
        throw badRequest(`La ${numeroDe(f)} es de otro cliente: una rectificativa solo rectifica facturas de un mismo cliente.`, {
          codigo: 'ORIGINAL_DE_OTRO_CLIENTE',
          campo: `rectificativa.originales.${i}`,
        });
      }
    });
    if (ctx.customerNuevo || (ctx.customerId && ctx.customerId !== customerId)) {
      throw badRequest(`La ${numeroDe(herencia)} es de ${herencia.customer.nombreFiscal}: la rectificativa va a su nombre y no se cambia de cliente.`, {
        codigo: 'ORIGINAL_DE_OTRO_CLIENTE',
        campo: 'customer',
      });
    }
    const monedas = new Set(originalesApp.map((f) => f.moneda));
    const tipos = new Set(originalesApp.map((f) => f.tipoOperacion ?? ''));
    if (monedas.size > 1) {
      throw badRequest('Las facturas que rectificas van en monedas distintas: haz una rectificativa para cada moneda.', { codigo: 'ORIGINALES_INCOMPATIBLES', campo: 'rectificativa.originales' });
    }
    if (tipos.size > 1) {
      throw badRequest('Las facturas que rectificas tienen distinto tipo de operación (por ejemplo, una nacional y otra intracomunitaria): haz una rectificativa para cada tipo.', {
        codigo: 'ORIGINALES_INCOMPATIBLES',
        campo: 'rectificativa.originales',
      });
    }
    if (herencia.moneda !== ctx.monedaCuenta && b.originales.length > 1) {
      throw badRequest(`Una rectificativa en ${herencia.moneda} rectifica una sola factura: haz una para cada una.`, { codigo: 'ORIGINALES_INCOMPATIBLES', campo: 'rectificativa.originales' });
    }
  }

  // Ticket (R5) o no: solo en el bloque nuevo (el camino antiguo ya comprueba la R5 sobre una F2).
  if (!b.legado) {
    b.originales.forEach((o, i) => {
      const f = o.id ? porId.get(o.id)! : null;
      if (!f) return;
      if (b.ticket && f.tipoFactura !== 'F2') {
        throw badRequest(
          `Una rectificativa de un ticket (R5) solo corrige tickets y facturas simplificadas (F2), y la ${numeroDe(f)} es ${f.tipoFactura}. Elige «Rectificativa o abono».`,
          { codigo: 'TICKET_SOLO_SIMPLIFICADAS', campo: `rectificativa.originales.${i}` },
        );
      }
      if (!b.ticket && f.tipoFactura === 'F2') {
        throw badRequest(`La ${numeroDe(f)} es una factura simplificada (un ticket): se rectifica con «Rectificativa de un ticket» (R5).`, {
          codigo: 'SIMPLIFICADA_SOLO_TICKET',
          campo: `rectificativa.originales.${i}`,
        });
      }
    });
  }

  // Por sustitucion: una sola original, de la app y sin otras rectificativas.
  if (b.forma === 'S') {
    if (b.motivo && MOTIVO_INFO[b.motivo].soloDiferencias) {
      throw badRequest('Un impago o un concurso solo se rectifican por diferencias.', { codigo: 'SOLO_DIFERENCIAS', campo: 'rectificativa.forma' });
    }
    if (b.periodo || b.originales.length !== 1) {
      throw badRequest('Por sustitución se corrige una sola factura: elige una, o rectifica por diferencias.', { codigo: 'SUSTITUCION_UNA_ORIGINAL', campo: 'rectificativa.forma' });
    }
    if (!herencia) {
      throw badRequest('Por sustitución solo se corrige una factura de la app: para una de fuera, rectifica por diferencias.', {
        codigo: 'SUSTITUCION_SIN_ORIGINAL_APP',
        campo: 'rectificativa.forma',
      });
    }
    const previas = await rectificativasDe(prisma, ctx.companyId, [herencia.id], ctx.excluirId);
    if (previas.length) throw errorSustitucionConRectificativas(herencia, previas);
  }

  // Originales de fuera: anteriores a llevar la facturacion en la app, con su partida de 2026 si la hay.
  const inicio = b.originales.some((o) => !o.id) ? await inicioLlevanzaApp(ctx.companyId) : null;
  const filas: FilaPlan[] = [];
  for (let i = 0; i < b.originales.length; i++) {
    const o = b.originales[i];
    const campo = `rectificativa.originales.${i}`;
    const f = o.id ? porId.get(o.id)! : null;
    if (f) {
      filas.push({
        originalId: f.id,
        numeroOriginal: f.numeroCompleto,
        fechaOriginal: f.fechaEmision,
        periodoDesde: null,
        periodoHasta: null,
        partidaPendienteId: null,
        pedido: { base: o.base, cuota: o.cuota, retencion: o.retencion },
        devengo: fechaDevengoVenta(f),
      });
      continue;
    }
    let numero = o.numero ?? '';
    let fecha = o.fecha ?? '';
    if (o.partidaId) {
      const p = await prisma.partidaPendiente.findFirst({ where: { id: o.partidaId, companyId: ctx.companyId } });
      if (!p || p.tipo !== 'COBRO' || p.estado === 'ANULADA' || p.incomeInvoiceId) {
        throw badRequest('Esa factura pendiente de 2026 no existe o ya no está pendiente: elígela otra vez.', { codigo: 'PARTIDA_NO_VALIDA', campo: `${campo}.partidaId` });
      }
      const delCliente = customerId ?? ctx.customerId ?? null;
      if (p.customerId && delCliente && p.customerId !== delCliente) {
        throw badRequest(`La factura ${p.numeroDocumento} de 2026 es de otro cliente.`, { codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo });
      }
      // Con un cliente nuevo, el abono rebajaria la partida de un cliente e iria a la 430 de otro.
      if (p.customerId && !delCliente && ctx.customerNuevo) {
        throw badRequest(`La factura ${p.numeroDocumento} de 2026 es de un cliente que ya tienes dado de alta: elígelo en vez de crear uno nuevo. La rectificativa va a su nombre.`, {
          codigo: 'ORIGINAL_DE_OTRO_CLIENTE',
          campo: 'customer',
        });
      }
      if (!herencia && !ctx.customerId && !ctx.customerNuevo && p.customerId) customerId = p.customerId;
      numero = numero || p.numeroDocumento;
      fecha = fecha || p.fechaDocumento || '';
      if (!fecha) throw badRequest(`Indica la fecha de la factura ${numero}.`, { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: `${campo}.fecha` });
    }
    if (!b.legado && inicio && fecha >= inicio) {
      throw badRequest(
        `La factura que rectificas es del ${fechaTexto(fecha)}, cuando ya llevabas la facturación en la app: búscala en Ventas y elígela de la lista.`,
        { codigo: 'ORIGINAL_EN_LA_APP', campo: `${campo}.fecha` },
      );
    }
    filas.push({
      originalId: null,
      numeroOriginal: numero,
      fechaOriginal: fecha,
      periodoDesde: null,
      periodoHasta: null,
      partidaPendienteId: o.partidaId ?? null,
      pedido: { base: o.base, cuota: o.cuota, retencion: o.retencion },
      devengo: fecha,
    });
  }
  if (b.periodo) {
    filas.push({
      originalId: null,
      numeroOriginal: null,
      fechaOriginal: null,
      periodoDesde: b.periodo.desde,
      periodoHasta: b.periodo.hasta,
      partidaPendienteId: null,
      pedido: {},
      devengo: null,
    });
    if (b.periodo.desde > ctx.fechaEmision) {
      throw badRequest('El periodo del rappel no puede empezar después de la fecha de la rectificativa.', { codigo: 'FECHA_ANTERIOR_ORIGINAL', campo: 'rectificativa.periodo' });
    }
  }
  // Una sola partida por rectificativa y fila: la misma dos veces no.
  const partidas = filas.map((x) => x.partidaPendienteId).filter((x): x is string => !!x);
  if (new Set(partidas).size !== partidas.length) throw badRequest('Has elegido la misma factura de 2026 dos veces.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa.originales' });

  // La rectificativa no puede ser anterior a la factura que rectifica.
  const masAntigua = filas
    .map((x, i) => ({ fecha: x.fechaOriginal, i, numero: x.numeroOriginal }))
    .filter((x): x is { fecha: string; i: number; numero: string | null } => !!x.fecha)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  if (masAntigua && ctx.fechaEmision < masAntigua.fecha) {
    throw badRequest(`La rectificativa no puede tener fecha anterior a la de la factura que rectifica (${masAntigua.numero ?? ''} del ${fechaTexto(masAntigua.fecha)}).`, {
      codigo: 'FECHA_ANTERIOR_ORIGINAL',
      campo: 'fechaEmision',
    });
  }

  return { bloque: b, tipoFactura, originalesApp, herencia, customerId, filas, avisos };
}

/**
 * Motivo con el que se aplican las reglas de la ley (signo, art. 89.Tres, plazo
 * de cuatro años y periodo de la original de una R4 que sube el IVA). El del
 * bloque o, en una rectificativa hecha con los campos antiguos (frontend
 * antiguo y /credit-note, sin motivo), el que sale de su tipo: la R1 como una
 * causa del art. 80 (cambio de precio: el plazo solo se avisa) y la R4 como
 * «Otra causa». La R5 no dice su causa: sin reglas de motivo. La R2 y la R3 no
 * llegan aqui (exigirTipoRectificativaDisponible).
 */
export function motivoDeReglas(b: BloqueVenta, tipoFactura: string): MotivoVenta | null {
  if (b.motivo) return b.motivo;
  if (!b.legado) return null;
  if (tipoFactura === 'R1') return 'CAMBIO_PRECIO';
  if (tipoFactura === 'R4') return 'OTROS';
  return null;
}

/**
 * La R2 (concurso) y la R3 (impago) aun no se pueden hacer (MOTIVO_INFO, disponible
 * = false): tampoco con los campos antiguos ni por /credit-note, que las dejaban
 * crear con el asiento completo cuando solo se rectifica el IVA.
 */
export function exigirTipoRectificativaDisponible(tipoFactura: string | null | undefined): void {
  const t = String(tipoFactura ?? '').toUpperCase();
  const motivo: MotivoVenta | null = t === 'R2' ? 'CONCURSO' : t === 'R3' ? 'IMPAGO' : null;
  if (!motivo || MOTIVO_INFO[motivo].disponible) return;
  const que = motivo === 'CONCURSO' ? 'La R2 es la rectificativa por concurso del cliente.' : 'La R3 es la rectificativa por impago (crédito incobrable).';
  throw badRequest(`${que} ${MOTIVO_INFO[motivo].aviso ?? 'Todavía no se puede hacer desde la app.'}`, { codigo: 'MOTIVO_NO_DISPONIBLE', campo: 'tipoFactura' });
}

/**
 * Por diferencias, cada linea lleva la retencion de las facturas que rectifica
 * (todas de la app; con una de fuera o un periodo no se sabe cual era). Un
 * abono sin la retencion de su original dejaba la 473 sin ajustar y la 430N
 * por encima de lo que de verdad se debe. Por sustitucion, la factura
 * corregida puede cambiarla. Lo comprueban el alta, el lector y la emision.
 */
export function exigirRetencionDeOriginales(plan: PlanVenta, lineas: Array<{ tipoRetencion?: number | null }>): void {
  if (plan.bloque.forma !== 'I' || !plan.originalesApp.length || plan.filas.some((f) => !f.originalId)) return;
  const tipos = [...new Set(plan.originalesApp.flatMap((f) => f.lineas.map((l) => Number(l.tipoRetencion ?? 0))))].sort((a, b) => a - b);
  const i = lineas.findIndex((l) => !tipos.includes(Number(l.tipoRetencion ?? 0)));
  if (i < 0) return;
  const texto = (t: number) => (t ? `con una retención de IRPF del ${t} %` : 'sin retención');
  const deLa = plan.originalesApp.length === 1 ? `La factura ${numeroDe(plan.originalesApp[0])}` : 'Las facturas que rectificas';
  throw badRequest(
    tipos.length === 1
      ? `${deLa} ${plan.originalesApp.length === 1 ? 'va' : 'van'} ${texto(tipos[0])} y la línea ${i + 1} de la rectificativa, ${texto(Number(lineas[i].tipoRetencion ?? 0))}. Por diferencias, la rectificativa lleva la misma retención que la factura que corrige.`
      : `La línea ${i + 1} de la rectificativa va ${texto(Number(lineas[i].tipoRetencion ?? 0))}, y las facturas que rectificas llevan ${tipos.map(texto).join(' o ')}. Por diferencias, cada línea lleva la retención de la factura que corrige.`,
    { codigo: 'RETENCION_NO_CUADRA', campo: 'tipoRetencion' },
  );
}

/** 409 de una sustitucion sobre una factura que ya tiene rectificativas. */
function errorSustitucionConRectificativas(f: { id: string; numeroCompleto: string | null }, previas: Array<{ id: string; numeroCompleto: string | null }>) {
  const lista = previas.map((r) => r.numeroCompleto ?? 'sin número').join(', ');
  return conflict(
    `La ${numeroDe(f)} ya tiene ${previas.length === 1 ? 'la rectificativa' : 'las rectificativas'} ${lista}: ahora solo se puede rectificar por diferencias.`,
    { codigo: 'SUSTITUCION_CON_RECTIFICATIVAS', campo: 'rectificativa.forma', facturaOriginalId: f.id, rectificativas: previas.map((r) => r.id) },
  );
}

/** Totales con los que se cierra el plan (moneda de cuenta). */
export interface TotalesRectificativa {
  base: number;
  cuota: number;
  retencion: number;
  total: number;
  /** Lineas calculadas de la rectificativa (para la diferencia de una sustitucion). */
  lineas: LineaImportes[];
}

/** Lineas de una factura guardada, como las lee diferenciaSustitucion (moneda de cuenta). */
export const lineasImportesDe = (f: { lineas: Array<{ tipoIva: number; accountCode: string | null; baseLine: number; ivaImporte: number; retencionImporte: number }> }): LineaImportes[] =>
  f.lineas.map((l) => ({ tipoIva: l.tipoIva, cuenta: l.accountCode ?? null, baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte), retencionImporte: Number(l.retencionImporte) }));

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Periodo del 303 de una fecha: el mes si la empresa declara cada mes; si no, el trimestre. */
const periodo303De = (fecha: string, mensual: boolean) => (mensual ? fecha.slice(0, 7) : `${fecha.slice(0, 4)}-${Math.ceil(Number(fecha.slice(5, 7)) / 3)}T`);
/** «del 3T de 2026» o «de julio de 2026». */
const periodoTexto = (fecha: string, mensual = false) =>
  mensual ? `de ${MESES[Number(fecha.slice(5, 7)) - 1]} de ${fecha.slice(0, 4)}` : `del ${Math.ceil(Number(fecha.slice(5, 7)) / 3)}T de ${fecha.slice(0, 4)}`;

/**
 * Cierra el plan con los importes ya calculados: la parte de cada fila (con
 * varias originales, la que indica la persona, que tiene que cuadrar al
 * centimo), las reglas de signo, el art. 89.Tres, el plazo de cuatro años y
 * la fecha de la operacion de una R4 que sube el IVA (el devengo de la
 * original, art. 89.Cinco LIVA).
 */
export function cerrarPlan(
  plan: PlanVenta,
  t: TotalesRectificativa,
  // mensual: la empresa presenta el 303 cada mes en la fecha de la rectificativa (si no, cada trimestre).
  d: { fechaEmision: string; clienteConNif: boolean; mensual?: boolean },
): { enlaces: EnlaceVenta[]; fechaOperacion: string | null; avisos: AvisoFiscal[]; rectificacion: { base: number; cuota: number; retencion: number; total: number } } {
  const b = plan.bloque;
  const avisos = [...plan.avisos];
  // Por sustitucion las lineas son la factura corregida entera: con el signo de
  // la original (en positivo) o a cero, nunca al reves. Una S en negativo
  // restaba dos veces la venta y el IVA, y una a cero dejaba sin limite las
  // rectificativas siguientes.
  if (b.forma === 'S' && plan.herencia) {
    const o = plan.herencia;
    const signo = Math.sign(aCentimos(Number(o.totalFactura))) || Math.sign(aCentimos(Number(o.baseTotal))) || 1;
    if (aCentimos(t.base) * signo < 0 || aCentimos(t.total) * signo < 0) {
      throw badRequest(
        `Por sustitución, las líneas son la factura ${numeroDe(o)} ya corregida y entera, con sus importes en positivo, como la original. Para restar (un abono), rectifica por diferencias.`,
        { codigo: 'SIGNO_NO_CUADRA', campo: 'lineas' },
      );
    }
  }
  // Lo que se rectifica: la diferencia en una sustitucion, los importes de la rectificativa en el resto.
  const rect =
    b.forma === 'S' && plan.herencia
      ? (() => {
          const dif = diferenciaSustitucion(t.lineas, lineasImportesDe(plan.herencia));
          return { base: dif.base, cuota: dif.cuota, retencion: dif.retencion, total: dif.total };
        })()
      : { base: t.base, cuota: t.cuota, retencion: t.retencion, total: t.total };

  let partes: Array<{ base: number; cuota: number; retencion: number }>;
  if (plan.filas.length <= 1) {
    partes = [{ base: rect.base, cuota: rect.cuota, retencion: rect.retencion }];
  } else {
    partes = plan.filas.map((f, i) => {
      if (f.pedido.base === undefined || f.pedido.cuota === undefined) {
        throw badRequest(`Con varias facturas, indica la base y el IVA que le tocan a cada una (falta en la ${f.numeroOriginal ?? `factura ${i + 1}`}).`, {
          codigo: 'REPARTO_NO_CUADRA',
          campo: `rectificativa.originales.${i}.base`,
        });
      }
      return { base: f.pedido.base, cuota: f.pedido.cuota, retencion: f.pedido.retencion ?? 0 };
    });
    if (!repartoCuadra(partes, rect)) {
      throw badRequest(
        `El reparto entre las facturas no suma lo mismo que la rectificativa (base ${importeTexto(rect.base)}, IVA ${importeTexto(rect.cuota)} y retención ${importeTexto(rect.retencion)}): corrige la parte de alguna.`,
        { codigo: 'REPARTO_NO_CUADRA', campo: 'rectificativa.originales' },
      );
    }
  }

  let fechaOperacion: string | null = null;
  // Con los campos antiguos (sin motivo), el que sale de su tipo: las reglas de la ley tambien valen ahi.
  const motivo = motivoDeReglas(b, plan.tipoFactura);
  if (motivo) {
    const info = MOTIVO_INFO[motivo];
    if (info.soloResta && !(aCentimos(rect.base) < 0 && aCentimos(rect.total) < 0)) {
      throw badRequest(
        `${info.texto} resta: ${b.forma === 'S' ? 'la factura corregida tiene que ser menor que la original' : 'las líneas van en negativo (por ejemplo, cantidad -1)'}.`,
        { codigo: 'SIGNO_NO_CUADRA', campo: 'lineas' },
      );
    }
    if (subeCuotaAConsumidorFinal({ motivo, cuota: rect.cuota, clienteConNif: d.clienteConNif, ticket: b.ticket })) {
      throw badRequest(
        'A quien no es empresario ni profesional (cliente sin NIF o ticket) no se le puede subir el IVA por un error: solo por una devolución, un descuento, un rappel o un cambio de precio (art. 89.Tres LIVA).',
        { codigo: 'SUBE_IVA_CONSUMIDOR_FINAL', campo: 'lineas' },
      );
    }
    // Plazo: cuatro años desde el devengo de la original (art. 89.Uno LIVA). En las
    // causas del art. 80 cuenta desde la circunstancia, que la app no conoce: solo se avisa.
    plan.filas.forEach((f, i) => {
      if (!f.devengo) return;
      const limite = limitePlazo(f.devengo);
      if (d.fechaEmision <= limite) return;
      const num = f.numeroOriginal ?? 'que rectificas';
      if (!info.art80) {
        throw badRequest(
          motivo === 'OTROS'
            ? `Han pasado más de cuatro años desde la factura ${num} (${fechaTexto(f.devengo)}): ya no se puede rectificar, salvo por una devolución, un descuento, un rappel o un cambio de precio (art. 89.Uno LIVA). Consúltalo con tu asesoría.`
            : `Han pasado más de cuatro años desde la factura ${num} (${fechaTexto(f.devengo)}): por un error ya no se puede rectificar (art. 89.Uno LIVA). Consúltalo con tu asesoría.`,
          { codigo: 'PLAZO_RECTIFICACION', campo: i === 0 ? 'fechaEmision' : `rectificativa.originales.${i}` },
        );
      }
      avisos.push({
        codigo: 'PLAZO_ART80',
        mensaje: `La factura ${num} tiene más de cuatro años. El plazo para rectificarla cuenta desde que pasó lo que la cambia (la devolución, el descuento, el nuevo precio...): si de eso también hace más de cuatro años, ya no se puede rectificar.`,
      });
    });
    // R4 que sube el IVA: se declara en el periodo de la original (art. 89.Cinco LIVA).
    // Solo si es otro periodo del 303; con originales de periodos distintos, una
    // rectificativa para cada uno (cada subida va al 303 de su factura).
    if (exigeImputarAlPeriodoOriginal({ motivo, ticket: b.ticket, cuota: rect.cuota })) {
      const mensual = !!d.mensual;
      const conDevengo = plan.filas.filter((f) => !!f.devengo).sort((x, y) => x.devengo!.localeCompare(y.devengo!));
      const periodos = new Map<string, FilaPlan>();
      for (const f of conDevengo) if (!periodos.has(periodo303De(f.devengo!, mensual))) periodos.set(periodo303De(f.devengo!, mensual), f);
      if (periodos.size > 1) {
        const lista = [...periodos.values()].map((f) => `la ${f.numeroOriginal ?? 'factura'}, ${periodoTexto(f.devengo!, mensual)}`);
        throw badRequest(
          `Esta rectificativa sube el IVA por un error y cada subida va en el 303 del periodo de su factura: ${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}. Haz una rectificativa para cada periodo.`,
          { codigo: 'R4_VARIOS_PERIODOS', campo: 'rectificativa.originales' },
        );
      }
      const primera = conDevengo[0];
      if (primera && primera.devengo! < d.fechaEmision && periodo303De(primera.devengo!, mensual) !== periodo303De(d.fechaEmision, mensual)) {
        fechaOperacion = primera.devengo;
        avisos.push({
          codigo: 'IVA_PERIODO_ORIGINAL',
          mensaje: `Esta rectificativa sube el IVA por un error: no va en el 303 de hoy, sino en el ${periodoTexto(primera.devengo!, mensual)}, el de la factura ${primera.numeroOriginal ?? ''} (art. 89.Cinco LIVA). Si ese 303 ya está presentado, hay que presentar una complementaria.`,
        });
      }
    }
  }

  const enlaces: EnlaceVenta[] = plan.filas.map((f, i) => ({
    originalId: f.originalId,
    numeroOriginal: f.numeroOriginal,
    fechaOriginal: f.fechaOriginal,
    periodoDesde: f.periodoDesde,
    periodoHasta: f.periodoHasta,
    partidaPendienteId: f.partidaPendienteId,
    baseRectificada: partes[i].base,
    cuotaRectificada: partes[i].cuota,
    retencionRectificada: partes[i].retencion,
  }));
  return { enlaces, fechaOperacion, avisos, rectificacion: rect };
}

// ---------------------------------------------------------------------------
// Lo que ya se ha rectificado de cada original y su limite
// ---------------------------------------------------------------------------

interface RectificativaPrevia {
  id: string;
  numeroCompleto: string | null;
  numero: number | null;
  fechaEmision: string;
  forma: 'I' | 'S';
  tipoFactura: string;
  /** Totales de la rectificativa (los de la factura corregida en una S). */
  total: { base: number; cuota: number; retencion: number; total: number };
  /** Parte de esta rectificativa que toca a la original (en una S, la diferencia). */
  parte: { base: number; cuota: number; retencion: number; total: number };
}

/**
 * Rectificativas emitidas (FINAL) de cada original: las de la tabla de enlaces
 * con su parte y las anteriores a la tabla (facturaOriginalId sin enlaces),
 * enteras. Sin `excluirId`. Ordenadas por fecha y numero.
 */
export async function rectificativasPorOriginal(db: Db, companyId: string, originalIds: string[], excluirId?: string): Promise<Map<string, RectificativaPrevia[]>> {
  const out = new Map<string, RectificativaPrevia[]>(originalIds.map((id) => [id, []]));
  if (!originalIds.length) return out;
  const excluir = excluirId ? { id: { not: excluirId } } : {};
  const sel = { id: true, numeroCompleto: true, numero: true, fechaEmision: true, tipoRectificativa: true, tipoFactura: true, baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } as const;
  const [filas, antiguas] = await Promise.all([
    db.incomeInvoiceRectificada.findMany({
      where: { companyId, originalId: { in: originalIds }, rectificativa: { estadoDocumento: 'FINAL', ...excluir } },
      include: { rectificativa: { select: sel } },
    }),
    db.incomeInvoice.findMany({
      where: { companyId, facturaOriginalId: { in: originalIds }, estadoDocumento: 'FINAL', enlacesRectifica: { none: {} }, ...excluir },
      select: { ...sel, facturaOriginalId: true },
    }),
  ]);
  const totales = (r: { baseTotal: number; ivaTotal: number; retencionTotal: number; totalFactura: number }) => ({
    base: Number(r.baseTotal),
    cuota: Number(r.ivaTotal),
    retencion: Number(r.retencionTotal),
    total: Number(r.totalFactura),
  });
  for (const f of filas) {
    const r = f.rectificativa;
    const tot = totales(r);
    const base = f.baseRectificada ?? tot.base;
    const cuota = f.cuotaRectificada ?? tot.cuota;
    const retencion = f.retencionRectificada ?? tot.retencion;
    out.get(f.originalId!)!.push({
      id: r.id,
      numeroCompleto: r.numeroCompleto,
      numero: r.numero,
      fechaEmision: r.fechaEmision,
      forma: r.tipoRectificativa === 'S' ? 'S' : 'I',
      tipoFactura: r.tipoFactura,
      total: tot,
      parte: { base, cuota, retencion, total: euros(aCentimos(base) + aCentimos(cuota) - aCentimos(retencion)) },
    });
  }
  for (const r of antiguas) {
    const tot = totales(r);
    out.get(r.facturaOriginalId!)!.push({
      id: r.id,
      numeroCompleto: r.numeroCompleto,
      numero: r.numero,
      fechaEmision: r.fechaEmision,
      forma: r.tipoRectificativa === 'S' ? 'S' : 'I',
      tipoFactura: r.tipoFactura,
      total: tot,
      parte: tot,
    });
  }
  for (const lista of out.values()) lista.sort((a, b) => a.fechaEmision.localeCompare(b.fechaEmision) || (a.numero ?? 0) - (b.numero ?? 0));
  return out;
}

/** Rectificativas emitidas de unas originales (sin repetir), para los mensajes. */
async function rectificativasDe(db: Db, companyId: string, ids: string[], excluirId?: string) {
  const por = await rectificativasPorOriginal(db, companyId, ids, excluirId);
  return [...new Map([...por.values()].flat().map((r) => [r.id, r])).values()];
}

export interface Restante {
  /** Base, cuota y total de referencia: los de la original o, si se sustituyo, los de su sustituta. */
  referencia: { base: number; cuota: number; total: number };
  /** Lo que queda por rectificar: la referencia mas las rectificativas por diferencias. */
  base: number;
  cuota: number;
  total: number;
  sustituta: { id: string; numeroCompleto: string | null } | null;
  /** Las rectificativas por diferencias que ya cuentan. */
  previas: Array<{ id: string; numeroCompleto: string | null }>;
  /** Todas (por diferencias y por sustitucion). */
  todas: RectificativaPrevia[];
}

/**
 * Lo que queda por rectificar de cada original (moneda de cuenta): la
 * original, o su sustituta si se rectifico por sustitucion, mas las partes de
 * las rectificativas por diferencias (con signo).
 */
export async function restantePorOriginal(
  db: Db,
  companyId: string,
  originales: Array<{ id: string; baseTotal: number; ivaTotal: number; totalFactura: number }>,
  excluirId?: string,
): Promise<Map<string, Restante>> {
  const por = await rectificativasPorOriginal(db, companyId, originales.map((f) => f.id), excluirId);
  const out = new Map<string, Restante>();
  for (const o of originales) {
    const todas = por.get(o.id) ?? [];
    const sustitutas = todas.filter((r) => r.forma === 'S');
    const s = sustitutas[sustitutas.length - 1] ?? null;
    const referencia = s
      ? { base: s.total.base, cuota: s.total.cuota, total: s.total.total }
      : { base: Number(o.baseTotal), cuota: Number(o.ivaTotal), total: Number(o.totalFactura) };
    const previas = todas.filter((r) => r.forma === 'I');
    out.set(o.id, {
      referencia,
      base: euros(aCentimos(referencia.base) + sumaCent(previas.map((r) => r.parte.base))),
      cuota: euros(aCentimos(referencia.cuota) + sumaCent(previas.map((r) => r.parte.cuota))),
      total: euros(aCentimos(referencia.total) + sumaCent(previas.map((r) => r.parte.total))),
      sustituta: s ? { id: s.id, numeroCompleto: s.numeroCompleto } : null,
      previas: previas.map((r) => ({ id: r.id, numeroCompleto: r.numeroCompleto })),
      todas,
    });
  }
  return out;
}

/**
 * Una rectificativa por diferencias no puede dejar la original (o su
 * sustituta) por debajo de cero, ni en base ni en total: una venta anulada
 * entera no se anula otra vez (el 303 restaria el IVA dos veces). Con `tx`,
 * llamar despues de bloquear las originales (bloquearFacturasVenta).
 */
export async function exigirLimites(
  db: Db,
  companyId: string,
  originales: Array<{ id: string; numeroCompleto: string | null; baseTotal: number; ivaTotal: number; totalFactura: number }>,
  partes: Array<{ originalId: string; base: number; total: number; indice: number }>,
  excluirId?: string,
): Promise<void> {
  if (!partes.length) return;
  const restantes = await restantePorOriginal(db, companyId, originales, excluirId);
  for (const p of partes) {
    const o = originales.find((x) => x.id === p.originalId);
    const r = restantes.get(p.originalId);
    if (!o || !r) continue;
    // Referencia a cero (una sustitucion a 0 €): manda el signo de la original, no queda sin limite.
    const signo =
      Math.sign(aCentimos(r.referencia.total)) ||
      Math.sign(aCentimos(r.referencia.base)) ||
      Math.sign(aCentimos(Number(o.totalFactura))) ||
      Math.sign(aCentimos(Number(o.baseTotal))) ||
      1;
    const sumaTotal = aCentimos(r.total) + aCentimos(p.total);
    const sumaBase = aCentimos(r.base) + aCentimos(p.base);
    if (sumaTotal * signo >= 0 && sumaBase * signo >= 0) continue;
    const numero = o.numeroCompleto ?? 'original';
    const lista = r.previas.map((x) => x.numeroCompleto).filter(Boolean).join(', ');
    throw conflict(
      !r.previas.length
        ? r.sustituta
          ? `La rectificativa (${importeTexto(p.total)}) es mayor que lo que queda de la factura ${numero}: ${importeTexto(r.referencia.total)}, el total de la ${r.sustituta.numeroCompleto ?? 'rectificativa'} que la sustituyó.`
          : `La rectificativa (${importeTexto(p.total)}) es mayor que la factura ${numero} (${importeTexto(r.referencia.total)}).`
        : aCentimos(r.total) === 0
          ? `La factura ${numero} ya está anulada por completo con la ${lista}. No se puede rectificar otra vez.`
          : `La rectificativa deja la factura ${numero} por debajo de cero: después de la ${lista} solo quedan ${importeTexto(r.total)} por rectificar.`,
      {
        codigo: 'RECTIFICATIVA_EXCEDE_ORIGINAL',
        facturaOriginalId: o.id,
        rectificativas: r.previas.map((x) => x.id),
        campo: partes.length > 1 ? `rectificativa.originales.${p.indice}` : 'lineas',
      },
    );
  }
}

/** Bloquea facturas de venta (SELECT ... FOR UPDATE) en orden de id, para que dos operaciones a la vez no se crucen. */
export async function bloquearFacturasVenta(tx: TransaccionBD, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await tx.$queryRaw`SELECT id FROM IncomeInvoice WHERE id = ${id} FOR UPDATE`;
}

/** Bloquea partidas de 2026 (FOR UPDATE, en orden de id): un cobro de la partida a la vez no se cruza con el abono. */
export async function bloquearPartidas(tx: TransaccionBD, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await tx.$queryRaw`SELECT id FROM PartidaPendiente WHERE id = ${id} FOR UPDATE`;
}

/**
 * Dentro de la transaccion del alta, la correccion o la emision: bloquea las
 * originales (en orden de id) y sus partidas de 2026, vuelve a mirar que sigan
 * rectificables, que una sustitucion no tenga rectificativas y el limite de
 * cada original con su parte. Sin esto, dos rectificativas a la vez de la misma
 * factura pasaban las dos.
 */
export async function exigirRectificablesEnTx(
  tx: TransaccionBD,
  companyId: string,
  r: { forma: FormaRectificacion; enlaces: EnlaceVenta[] },
  excluirId?: string,
): Promise<void> {
  const ids = [...new Set(r.enlaces.map((e) => e.originalId).filter((x): x is string => !!x))];
  await bloquearFacturasVenta(tx, ids);
  await bloquearPartidas(tx, r.enlaces.map((e) => e.partidaPendienteId).filter((x): x is string => !!x));
  if (!ids.length) return;
  const fs = await cargarFacturas(tx, companyId, ids);
  for (const id of ids) {
    const f = fs.find((x) => x.id === id);
    if (!f) throw conflict('La factura que rectificas ya no existe: vuelve a elegirla.', { codigo: 'ORIGINAL_NO_RECTIFICABLE', campo: 'rectificativa.originales' });
    const problema = problemaOriginal(f);
    if (problema) throw badRequest(problema, { codigo: 'ORIGINAL_NO_RECTIFICABLE', campo: 'rectificativa.originales' });
  }
  if (r.forma === 'S') {
    const previas = await rectificativasDe(tx, companyId, ids, excluirId);
    if (previas.length) throw errorSustitucionConRectificativas(fs[0], previas);
    return;
  }
  const partes = r.enlaces
    .map((e, indice) => ({ e, indice }))
    .filter(({ e }) => !!e.originalId)
    .map(({ e, indice }) => ({
      originalId: e.originalId!,
      base: e.baseRectificada,
      total: euros(aCentimos(e.baseRectificada) + aCentimos(e.cuotaRectificada) - aCentimos(e.retencionRectificada)),
      indice,
    }));
  await exigirLimites(tx, companyId, fs, partes, excluirId);
}

/** Guarda los enlaces de la rectificativa (borra antes los que tuviera, al corregir el borrador). */
export async function guardarEnlacesVenta(tx: TransaccionBD, companyId: string, rectificativaId: string, enlaces: EnlaceVenta[]): Promise<void> {
  await tx.incomeInvoiceRectificada.deleteMany({ where: { companyId, rectificativaId } });
  if (enlaces.length) await tx.incomeInvoiceRectificada.createMany({ data: enlaces.map((e) => ({ ...e, companyId, rectificativaId })) });
}

// ---------------------------------------------------------------------------
// Lo que ensena la ficha
// ---------------------------------------------------------------------------

export interface OriginalDeRectificativa {
  id: string | null;
  numeroCompleto: string;
  fecha: string | null;
  partidaId: string | null;
  enApp: boolean;
  base: number | null;
  cuota: number | null;
  retencion: number | null;
}

export interface RectificativaResp {
  ticket: boolean;
  forma: FormaRectificacion;
  motivo: string | null;
  motivoTexto: string | null;
  explicacion: string | null;
  originales: OriginalDeRectificativa[];
  periodo: { desde: string; hasta: string } | null;
}

type FacturaParaEnlaces = {
  id: string;
  companyId: string;
  esRectificativa: boolean;
  tipoFactura: string;
  tipoRectificativa: string | null;
  causaRectificacion?: string | null;
  motivoRectificacion: string | null;
  facturaOriginalId: string | null;
  rectificaFueraNumero: string | null;
  rectificaFueraFecha: string | null;
};

/**
 * Que rectifica una rectificativa: las filas de la tabla de enlaces o, si no
 * tiene (rectificativas anteriores a la tabla), facturaOriginalId o
 * rectificaFuera. Para varias facturas a la vez, `enlacesDeVentas`.
 */
export async function enlacesDeVentas(db: Db, facturas: FacturaParaEnlaces[]): Promise<Map<string, RectificativaResp>> {
  const rects = facturas.filter((f) => f.esRectificativa);
  const out = new Map<string, RectificativaResp>();
  if (!rects.length) return out;
  const companyId = rects[0].companyId;
  const filas = await db.incomeInvoiceRectificada.findMany({
    where: { companyId, rectificativaId: { in: rects.map((f) => f.id) } },
    include: { original: { select: { numeroCompleto: true, fechaEmision: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const antiguas = rects.filter((f) => f.facturaOriginalId && !filas.some((x) => x.rectificativaId === f.id)).map((f) => f.facturaOriginalId!);
  const originalesAntiguas = antiguas.length ? await db.incomeInvoice.findMany({ where: { companyId, id: { in: antiguas } }, select: { id: true, numeroCompleto: true, fechaEmision: true } }) : [];
  for (const f of rects) {
    const suyas = filas.filter((x) => x.rectificativaId === f.id);
    let originales: OriginalDeRectificativa[];
    let periodo: RectificativaResp['periodo'] = null;
    if (suyas.length) {
      const p = suyas.find((x) => x.periodoDesde && x.periodoHasta);
      if (p) periodo = { desde: p.periodoDesde!, hasta: p.periodoHasta! };
      originales = suyas
        .filter((x) => !x.periodoDesde)
        .map((x) => ({
          id: x.originalId,
          numeroCompleto: x.original?.numeroCompleto ?? x.numeroOriginal ?? '',
          fecha: x.original?.fechaEmision ?? x.fechaOriginal,
          partidaId: x.partidaPendienteId,
          enApp: !!x.originalId,
          base: x.baseRectificada,
          cuota: x.cuotaRectificada,
          retencion: x.retencionRectificada,
        }));
    } else if (f.facturaOriginalId) {
      const o = originalesAntiguas.find((x) => x.id === f.facturaOriginalId);
      originales = [{ id: f.facturaOriginalId, numeroCompleto: o?.numeroCompleto ?? '', fecha: o?.fechaEmision ?? null, partidaId: null, enApp: true, base: null, cuota: null, retencion: null }];
    } else if (f.rectificaFueraNumero) {
      originales = [{ id: null, numeroCompleto: f.rectificaFueraNumero, fecha: f.rectificaFueraFecha, partidaId: null, enApp: false, base: null, cuota: null, retencion: null }];
    } else originales = [];
    const motivo = f.causaRectificacion ?? null;
    out.set(f.id, {
      ticket: f.tipoFactura === 'R5',
      forma: f.tipoRectificativa === 'S' ? 'S' : 'I',
      motivo,
      motivoTexto: motivo && esMotivoVenta(motivo) ? MOTIVO_INFO[motivo].texto : null,
      explicacion: f.motivoRectificacion ?? null,
      originales,
      periodo,
    });
  }
  return out;
}

/** Rectificativas emitidas que rectifican una factura (de los enlaces y de facturaOriginalId), para su ficha. */
export async function rectificadaPorDe(companyId: string, id: string) {
  const por = await rectificativasPorOriginal(prisma, companyId, [id]);
  return (por.get(id) ?? []).map((r) => ({
    id: r.id,
    numeroCompleto: r.numeroCompleto,
    fechaEmision: r.fechaEmision,
    totalFactura: r.total.total,
    tipoRectificativa: r.forma,
    tipoFactura: r.tipoFactura,
  }));
}

// ---------------------------------------------------------------------------
// A favor del cliente: lo que un abono no ha descontado de sus originales
// ---------------------------------------------------------------------------

/**
 * Lo que queda a favor del cliente en cada abono (rectificativa emitida con
 * total < 0), en la moneda de la factura y ya descontadas las devoluciones al
 * cliente registradas (InvoicePayment en negativo):
 *  - cada fila con una original de la app descuenta, como mucho, lo que esa
 *    original (o su sustituta) tiene pendiente de cobro; si varios abonos
 *    rectifican la misma, se reparten lo pendiente por orden de fecha;
 *  - cada fila con una partida de cobro de 2026, lo que le queda a la partida;
 *  - un periodo (rappel) o una factura de fuera sin partida no descuentan de
 *    ninguna factura: todo queda a favor del cliente.
 * Lo que no se descuenta se puede devolver (POST /:id/cobros).
 */
export async function aFavorDeAbonos(db: Db, companyId: string, abonoIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!abonoIds.length) return out;
  const abonos = await db.incomeInvoice.findMany({
    where: { companyId, id: { in: abonoIds }, estadoDocumento: 'FINAL', esRectificativa: true },
    select: { id: true, totalFactura: true, totalFacturaDoc: true, facturaOriginalId: true, rectificaFueraNumero: true },
  });
  const negativos = abonos.filter((a) => aCentimos(Number(a.totalFactura)) < 0);
  for (const a of abonos) if (!negativos.includes(a)) out.set(a.id, 0);
  if (!negativos.length) return out;

  // Filas de los abonos pedidos y, de cada original y partida que tocan, todos sus abonos (para repartir lo pendiente por orden).
  const filasPedidas = await db.incomeInvoiceRectificada.findMany({ where: { companyId, rectificativaId: { in: negativos.map((a) => a.id) } } });
  const originalIds = [
    ...new Set([
      ...filasPedidas.map((f) => f.originalId).filter((x): x is string => !!x),
      ...negativos.filter((a) => a.facturaOriginalId && !filasPedidas.some((f) => f.rectificativaId === a.id)).map((a) => a.facturaOriginalId!),
    ]),
  ];
  const partidaIds = [...new Set(filasPedidas.map((f) => f.partidaPendienteId).filter((x): x is string => !!x))];

  // Abonos (FINAL, total < 0) que comparten originales o partidas, con sus filas.
  const filasTodas = await db.incomeInvoiceRectificada.findMany({
    where: {
      companyId,
      rectificativa: { estadoDocumento: 'FINAL', totalFactura: { lt: 0 } },
      OR: [...(originalIds.length ? [{ originalId: { in: originalIds } }] : []), ...(partidaIds.length ? [{ partidaPendienteId: { in: partidaIds } }] : [])],
    },
    include: { rectificativa: { select: { id: true, fechaEmision: true, numero: true, totalFactura: true, totalFacturaDoc: true } } },
  });
  const antiguas = originalIds.length
    ? await db.incomeInvoice.findMany({
        where: { companyId, facturaOriginalId: { in: originalIds }, estadoDocumento: 'FINAL', totalFactura: { lt: 0 }, enlacesRectifica: { none: {} } },
        select: { id: true, fechaEmision: true, numero: true, totalFactura: true, totalFacturaDoc: true, facturaOriginalId: true },
      })
    : [];

  // Lo pendiente de cobro de cada original (o de su sustituta), sin contar los abonos.
  const capacidadOriginal = await pendienteSinAbonos(db, companyId, originalIds);
  const capacidadPartida = new Map<string, number>();
  if (partidaIds.length) {
    const [ps, liq] = await Promise.all([
      db.partidaPendiente.findMany({ where: { companyId, id: { in: partidaIds } }, select: { id: true, importePendiente: true, estado: true } }),
      db.invoicePayment.groupBy({ by: ['invoiceId'], where: { companyId, invoiceType: 'PARTIDA', estado: 'ACTIVO', invoiceId: { in: partidaIds } }, _sum: { importe: true } }),
    ]);
    for (const p of ps) {
      const cobrado = aCentimos(Number(liq.find((x) => x.invoiceId === p.id)?._sum.importe ?? 0));
      capacidadPartida.set(p.id, p.estado === 'ANULADA' ? 0 : Math.max(0, aCentimos(Number(p.importePendiente)) - cobrado));
    }
  }

  // Reparto por orden (fecha, numero) entre todos los abonos de cada original o partida.
  type Pieza = { abonoId: string; fecha: string; numero: number; parte: number; originalId: string | null; partidaId: string | null };
  const piezas: Pieza[] = [
    ...filasTodas.map((f) => ({
      abonoId: f.rectificativaId,
      fecha: f.rectificativa.fechaEmision,
      numero: f.rectificativa.numero ?? 0,
      // Parte en la moneda de cuenta; con una sola fila, el total de la factura en su moneda.
      parte: Math.abs(aCentimos(f.baseRectificada ?? 0) + aCentimos(f.cuotaRectificada ?? 0) - aCentimos(f.retencionRectificada ?? 0)),
      originalId: f.originalId,
      partidaId: f.originalId ? null : f.partidaPendienteId,
    })),
    ...antiguas.map((a) => ({ abonoId: a.id, fecha: a.fechaEmision, numero: a.numero ?? 0, parte: Math.abs(aCentimos(Number(a.totalFactura))), originalId: a.facturaOriginalId, partidaId: null })),
  ].sort((x, y) => x.fecha.localeCompare(y.fecha) || x.numero - y.numero);
  const descontado = new Map<string, number>();
  const capO = new Map(capacidadOriginal);
  const capP = new Map(capacidadPartida);
  for (const p of piezas) {
    const mapa = p.originalId ? capO : p.partidaId ? capP : null;
    const clave = p.originalId ?? p.partidaId;
    if (!mapa || !clave) continue;
    const queda = mapa.get(clave) ?? 0;
    const usa = Math.min(queda, p.parte);
    mapa.set(clave, queda - usa);
    descontado.set(p.abonoId, (descontado.get(p.abonoId) ?? 0) + usa);
  }

  // Devoluciones ya registradas (en negativo).
  const devoluciones = await db.invoicePayment.groupBy({
    by: ['invoiceId'],
    where: { companyId, invoiceType: 'INGRESO', estado: 'ACTIVO', invoiceId: { in: negativos.map((a) => a.id) } },
    _sum: { importe: true, importeDoc: true },
  });
  for (const a of negativos) {
    const totalCuenta = Math.abs(aCentimos(Number(a.totalFactura)));
    const totalDoc = Math.abs(aCentimos(Number(a.totalFacturaDoc ?? a.totalFactura)));
    const dev = devoluciones.find((x) => x.invoiceId === a.id);
    const devueltoDoc = Math.abs(aCentimos(Number(dev?._sum.importeDoc ?? dev?._sum.importe ?? 0)));
    // Lo descontado va en la moneda de cuenta: se pasa a la de la factura en proporcion.
    const desc = Math.min(totalCuenta, descontado.get(a.id) ?? 0);
    const descDoc = totalCuenta === 0 ? 0 : totalCuenta === totalDoc ? desc : Math.round((desc * totalDoc) / totalCuenta);
    out.set(a.id, euros(Math.max(0, totalDoc - descDoc - devueltoDoc)));
  }
  return out;
}

/**
 * Lo pendiente de cobro de cada original sin contar sus abonos (centimos de la
 * moneda de cuenta): total menos cobros activos; una cobrada a mano sin cobros,
 * cero. Si se sustituyo, lo de su sustituta menos lo cobrado a la original.
 */
async function pendienteSinAbonos(db: Db, companyId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const sustitutas = await db.incomeInvoiceRectificada.findMany({
    where: { companyId, originalId: { in: ids }, rectificativa: { estadoDocumento: 'FINAL', tipoRectificativa: 'S' } },
    select: { originalId: true, rectificativaId: true },
  });
  const antiguasS = await db.incomeInvoice.findMany({
    where: { companyId, facturaOriginalId: { in: ids }, estadoDocumento: 'FINAL', tipoRectificativa: 'S', enlacesRectifica: { none: {} } },
    select: { id: true, facturaOriginalId: true },
  });
  const sustituta = new Map<string, string>([...sustitutas.map((s) => [s.originalId!, s.rectificativaId] as const), ...antiguasS.map((s) => [s.facturaOriginalId!, s.id] as const)]);
  const todas = [...new Set([...ids, ...sustituta.values()])];
  const [fs, cobros] = await Promise.all([
    db.incomeInvoice.findMany({ where: { companyId, id: { in: todas } }, select: { id: true, totalFactura: true, estado: true } }),
    db.invoicePayment.groupBy({ by: ['invoiceId'], where: { companyId, invoiceType: 'INGRESO', estado: 'ACTIVO', invoiceId: { in: todas } }, _sum: { importe: true } }),
  ]);
  const cobrado = (id: string) => aCentimos(Number(cobros.find((c) => c.invoiceId === id)?._sum.importe ?? 0));
  const pendientePropio = (id: string) => {
    const f = fs.find((x) => x.id === id);
    if (!f) return 0;
    const c = cobrado(id);
    if (f.estado === 'PAID' && c === 0) return 0;
    return aCentimos(Number(f.totalFactura)) - c;
  };
  for (const id of ids) {
    const s = sustituta.get(id);
    out.set(id, Math.max(0, s ? pendientePropio(s) - cobrado(id) : pendientePropio(id)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buscador de originales, datos para rectificar y opciones
// ---------------------------------------------------------------------------

export interface CandidataOriginalVenta {
  id: string;
  numeroCompleto: string;
  serie: string;
  fechaEmision: string;
  customerId: string;
  cliente: string;
  nifCliente: string | null;
  tipoFactura: string;
  moneda: string;
  tipoOperacion: string | null;
  totalFactura: number;
  restante: number;
  sustituidaPor: string | null;
  origen: string;
  exacta: boolean;
  rectificable: boolean;
  motivoNoRectificable: string | null;
}

export interface PartidaFueraVenta {
  partidaId: string;
  numero: string;
  fecha: string | null;
  pendiente: number;
  exacta: boolean;
}

const sinTildes = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const soloCifras = (s: string) => s.replace(/[^0-9]/g, '').replace(/^0+/, '');

/**
 * Cobros de 2026 que trajo la gestoria sin factura en la app y con algo
 * pendiente, del cliente: todos (son pocos), primero los del numero buscado.
 */
export async function partidasFueraCobro(companyId: string, customerId: string, numero: string | null | undefined): Promise<PartidaFueraVenta[]> {
  const filas = await prisma.partidaPendiente.findMany({
    where: { companyId, tipo: 'COBRO', customerId, incomeInvoiceId: null, sinDetalle: false, estado: { in: ['PENDIENTE', 'PARCIAL'] } },
    select: { id: true, numeroDocumento: true, fechaDocumento: true },
    orderBy: [{ fechaDocumento: 'desc' }, { numeroDocumento: 'asc' }],
    take: 200,
  });
  if (!filas.length) return [];
  const pendiente = await pendientePorPartida(prisma, companyId, filas.map((f) => f.id));
  const buscado = numeroComparable(numero);
  return filas
    .map((f) => ({ partidaId: f.id, numero: f.numeroDocumento, fecha: f.fechaDocumento, pendiente: pendiente.get(f.id) ?? 0, exacta: !!buscado && numeroComparable(f.numeroDocumento) === buscado }))
    .filter((p) => aCentimos(p.pendiente) > 0)
    .sort((a, b) => Number(b.exacta) - Number(a.exacta));
}

export interface FiltrosOriginales {
  q?: string | null;
  numero?: string | null;
  customerId?: string | null;
  desde?: string | null;
  hasta?: string | null;
  /** true: solo simplificadas (F2); false: sin F2; undefined: todas. */
  ticket?: boolean;
  take?: number;
}

/**
 * Facturas emitidas que se pueden rectificar (GET /originales y el lector):
 * FINAL, sin borradores ni proformas ni rectificativas, de cualquier serie
 * (tambien las del lector). Con `numero`, primero la que coincide exacta (sin
 * espacios y en mayusculas) y luego las parecidas (mismas cifras o una dentro
 * de la otra). Con `q`, por numero o por nombre o NIF del cliente.
 */
export async function buscarOriginalesVenta(
  companyId: string,
  f: FiltrosOriginales,
): Promise<{ coincidencia: 'EXACTA' | 'PARECIDA' | 'NINGUNA'; candidatas: CandidataOriginalVenta[]; partidasFuera: PartidaFueraVenta[] }> {
  const take = Math.min(20, Math.max(1, Math.floor(Number(f.take) || 10)));
  const numero = numeroComparable(f.numero);
  const q = String(f.q ?? '').trim();
  const where: Prisma.IncomeInvoiceWhereInput = {
    companyId,
    estadoDocumento: 'FINAL',
    estado: { not: 'DRAFT' },
    esRectificativa: false,
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.ticket === true ? { tipoFactura: 'F2' } : f.ticket === false ? { tipoFactura: { not: 'F2' } } : {}),
    ...(f.desde || f.hasta ? { fechaEmision: { ...(f.desde ? { gte: f.desde } : {}), ...(f.hasta ? { lte: f.hasta } : {}) } } : {}),
  };
  const and: Prisma.IncomeInvoiceWhereInput[] = [];
  if (numero) {
    const cifras = soloCifras(numero);
    and.push({ OR: [{ numeroCompleto: { contains: numero } }, ...(cifras ? [{ numeroCompleto: { contains: cifras } }] : [])] });
  }
  if (q) {
    const sinEsp = q.replace(/\s+/g, '');
    and.push({ OR: [{ numeroCompleto: { contains: sinEsp } }, { customer: { nombreFiscal: { contains: q } } }, { customer: { nifCif: { contains: sinEsp.toUpperCase() } } }] });
  }
  const filas = await prisma.incomeInvoice.findMany({
    where: { ...where, ...(and.length ? { AND: and } : {}) },
    include: { customer: { select: { nombreFiscal: true, nifCif: true } } },
    orderBy: [{ fechaEmision: 'desc' }, { numero: 'desc' }],
    take: 500,
  });
  const qNorm = sinTildes(q);
  const puntuadas = filas
    .map((x) => {
      const n = numeroComparable(x.numeroCompleto);
      const exacta = !!numero && n === numero;
      const parecida = !!numero && !exacta && !!n && (n.includes(numero) || numero.includes(n) || (soloCifras(n) !== '' && soloCifras(n) === soloCifras(numero)));
      // Con q: el nombre sin tildes (la BD ya compara sin tildes; se repite por si la colacion es otra).
      const porQ = !q || n.includes(q.replace(/\s+/g, '').toUpperCase()) || sinTildes(x.customer.nombreFiscal).includes(qNorm) || (x.customer.nifCif ?? '').toUpperCase().includes(q.replace(/\s+/g, '').toUpperCase());
      return { x, exacta, parecida, porQ };
    })
    .filter((p) => p.porQ && (!numero || p.exacta || p.parecida));
  puntuadas.sort((a, b) => Number(b.exacta) - Number(a.exacta));
  const elegidas = puntuadas.slice(0, take);
  const restantes = await restantePorOriginal(
    prisma,
    companyId,
    elegidas.map(({ x }) => x),
  );
  const candidatas: CandidataOriginalVenta[] = elegidas.map(({ x, exacta }) => {
    const r = restantes.get(x.id)!;
    return {
      id: x.id,
      numeroCompleto: x.numeroCompleto ?? '',
      serie: x.serie,
      fechaEmision: x.fechaEmision,
      customerId: x.customerId,
      cliente: x.customer.nombreFiscal,
      nifCliente: x.customer.nifCif ?? null,
      tipoFactura: x.tipoFactura,
      moneda: x.moneda,
      tipoOperacion: x.tipoOperacion ?? null,
      totalFactura: Number(x.totalFactura),
      restante: r.total,
      sustituidaPor: r.sustituta?.numeroCompleto ?? null,
      origen: x.origen === 'lector' ? 'lector' : 'app',
      exacta,
      rectificable: true,
      motivoNoRectificable: null,
    };
  });
  const coincidencia = candidatas.some((c) => c.exacta) ? 'EXACTA' : numero && candidatas.length ? 'PARECIDA' : 'NINGUNA';
  const partidasFuera = f.customerId ? await partidasFueraCobro(companyId, f.customerId, f.numero) : [];
  return { coincidencia, candidatas, partidasFuera };
}

/** Datos para prellenar una rectificativa de la factura `id` (GET /:id/rectificar). */
export async function datosParaRectificarVenta(companyId: string, id: string) {
  const [f] = await cargarFacturas(prisma, companyId, [id]);
  if (!f) throw notFound('Factura no encontrada.');
  const problema = problemaOriginal(f);
  const restante = (await restantePorOriginal(prisma, companyId, [f]))!.get(f.id)!;
  const doc = (n: number | null | undefined, cuenta: number) => (n === null || n === undefined ? cuenta : Number(n));
  const cobros = await prisma.invoicePayment.aggregate({ where: { companyId, invoiceType: 'INGRESO', invoiceId: f.id, estado: 'ACTIVO' }, _sum: { importe: true, importeDoc: true } });
  const cobradoDoc = Number(cobros._sum.importeDoc ?? cobros._sum.importe ?? 0);
  const totalDoc = doc(f.totalFacturaDoc, Number(f.totalFactura));
  const pendienteCobro = f.estado === 'PAID' && cobradoDoc === 0 ? 0 : euros(aCentimos(totalDoc) - aCentimos(cobradoDoc));
  return {
    original: {
      id: f.id,
      numeroCompleto: f.numeroCompleto ?? '',
      serie: f.serie,
      fechaEmision: f.fechaEmision,
      devengo: fechaDevengoVenta(f),
      tipoFactura: f.tipoFactura,
      origen: f.origen === 'lector' ? 'lector' : 'app',
      customerId: f.customerId,
      cliente: { id: f.customer.id, nombreFiscal: f.customer.nombreFiscal, nifCif: f.customer.nifCif ?? null, pais: f.customer.pais ?? null },
      moneda: f.moneda,
      tipoCambio: Number(f.tipoCambio),
      tipoOperacion: f.tipoOperacion ?? null,
      causaExencion: f.causaExencion ?? null,
      referenciaLegal: f.referenciaLegal ?? null,
      baseTotal: Number(f.baseTotal),
      ivaTotal: Number(f.ivaTotal),
      retencionTotal: Number(f.retencionTotal),
      totalFactura: Number(f.totalFactura),
      totalFacturaDoc: totalDoc,
    },
    lineas: f.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnitario: Number(l.precioUnitarioDoc ?? l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje),
      tipoIva: l.tipoIva,
      tipoRetencion: l.tipoRetencion,
      productoServicioId: l.productoServicioId ?? null,
      cuenta: l.accountCode ?? null,
      baseLine: doc(l.baseLineDoc, Number(l.baseLine)),
      ivaImporte: doc(l.ivaImporteDoc, Number(l.ivaImporte)),
    })),
    cuentaPorTipoIva: cuentaPorTipoIva(f.lineas.map((l) => ({ tipoIva: l.tipoIva, cuenta: l.accountCode ?? null, baseLine: Number(l.baseLine) }))),
    rectificativas: restante.todas.map((r) => ({ id: r.id, numeroCompleto: r.numeroCompleto ?? '', fechaEmision: r.fechaEmision, totalFactura: r.total.total, forma: r.forma, tipoFactura: r.tipoFactura })),
    restante: { base: restante.base, cuota: restante.cuota, total: restante.total },
    pendienteCobro,
    ticket: f.tipoFactura === 'F2',
    rectificable: !problema,
    motivoNoRectificable: problema,
    admiteSustitucion: !problema && restante.todas.length === 0,
  };
}

/** Motivos (la tabla del dominio) y series de rectificativas (GET /rectificativas/opciones). */
export async function opcionesRectificativa(companyId: string) {
  const [r, tickets] = await Promise.all([obtenerSeriePorDefecto(companyId, 'RECTIFICATIVA'), codigoSerieTickets(companyId)]);
  return {
    motivos: MOTIVOS_VENTA.map((codigo) => {
      const m = MOTIVO_INFO[codigo];
      return {
        codigo,
        texto: m.texto,
        ayuda: m.ayuda,
        tipoFactura: m.tipoFactura,
        articulo: m.articulo,
        soloResta: m.soloResta,
        admitePeriodo: m.admitePeriodo,
        soloDiferencias: m.soloDiferencias,
        aviso: m.aviso,
        disponible: m.disponible,
      };
    }),
    // existe: hay una serie de rectificativas activa (si no, no se puede emitir: hay que activarla o crearla).
    series: { rectificativas: { codigo: r?.codigo ?? 'R', existe: !!r }, tickets },
  };
}
