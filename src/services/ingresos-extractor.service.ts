import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos, importeTexto } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from './income-invoices.service';
import { invoiceExtractorService, type InvoiceExtraction } from './invoice-extractor.service';
import { archivarVentaSinRomper } from './archivoFacturas.service';
import { accountingHooksService } from './accounting-hooks.service';
import { comprobarRevisionVenta, MENSAJE_FALTA_RECTIFICATIVA, vincularLectura } from './lectura/confirmar';
import { MENSAJE_FALTA_NIF_CLIENTE } from './lectura/validaciones';
import { cuentaPorTipoIva, esMotivoVenta, MOTIVO_INFO } from '../domain/rectificativa-venta.model';
import { registrarAuditoria } from './auditoria.service';
import { clientePorNif, errorTerceroNoDadoDeAlta } from './lectura/terceros-lector';
import type { DireccionFicha } from './lectura/direccion';
import { detalleFalloBD, errorFalloBD, motivoSinAsiento, QUE_HACER_REGISTRAR } from '../utils/errores-bd';

/**
 * Lector de facturas de INGRESO (pantalla "Lector de ingresos").
 *
 * Digitaliza una factura que emitio la empresa (en papel o desde otro programa)
 * y la registra como factura de ingreso. La lectura la hace invoice-extractor;
 * este modulo adapta su resultado a la pantalla y, al confirmar, crea la
 * factura con los datos GUARDADOS en el servidor (no con lo que reenvie el
 * navegador).
 *
 * En una factura de ingreso el emisor es la empresa y el CLIENTE es el receptor
 * (`customer` de la extraccion).
 */

/** Lo que muestra la pantalla tras leer la factura. */
export interface IngresoExtraido {
  documentId: string;
  numeroFactura: string | null;
  cliente: string | null;
  nifCliente: string | null;
  fecha: string | null;
  concepto: string | null;
  cuentaContable: string;
  base: number;
  iva: number;
  retencion: number;
  total: number;
  /** 0 a 1. */
  confianza: number;
  /** Problemas que impiden confirmar. */
  errores: string[];
  /**
   * Las lineas con que se registrara (una por tipo de IVA), en el mismo orden
   * que en el confirmar: la pantalla deja elegir la cuenta de cada una.
   */
  lineas: Array<{ descripcion: string; base: number; tipoIva: number }>;
  /**
   * Direccion leida del cliente, para darlo de alta desde el lector con la
   * ficha rellena: { calle, cp, municipio, provincia, pais (ISO-2 o null),
   * revisar }. null si no se ha leido nada de la direccion.
   */
  direccionCliente: DireccionFicha | null;
}

/** Cuenta de ventas por defecto del PGC (700 Ventas de mercaderias / prestacion de servicios). */
const CUENTA_VENTAS = '700';

/** Error de la lectura sin NIF del cliente (tambien lo da la validacion NIF_RECEPTOR, con un cliente de España). */
export { MENSAJE_FALTA_NIF_CLIENTE };

const limpiarNif = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const limpio = v.toUpperCase().replace(/^ES/, '').replace(/[.\s-]/g, '');
  return limpio || null;
};

/**
 * Lo que muestra la pantalla. `direccion`: la del cliente leida con la lectura
 * nueva (lectura/direccion.ts); sin ella (extractor de siempre), la direccion
 * que trae la extraccion, entera en la calle.
 *
 * `nifYaValidado`: la extraccion viene de una lectura (/lecturas), cuyas
 * validaciones ya dicen si falta el NIF del cliente segun de donde es (error
 * con un cliente de España; «revisar» con uno de fuera, que puede no tenerlo).
 * Sin ella (extractor de siempre), falta el NIF es siempre un error.
 */
export function aIngresoExtraido(documentId: string, e: InvoiceExtraction, direccion?: DireccionFicha | null, opciones: { nifYaValidado?: boolean } = {}): IngresoExtraido {
  const errores = [...e.validation.errors];
  if (!opciones.nifYaValidado && !limpiarNif(e.customer.tax_id)) errores.push(MENSAJE_FALTA_NIF_CLIENTE);
  if (!e.invoice.number) errores.push('No se ha podido leer el numero de la factura.');
  if (e.amounts.bases.length === 0) errores.push('No se ha podido leer ninguna base imponible.');
  if (e.amounts.withholdings.length > 1) errores.push('La factura tiene varias retenciones; registrala a mano.');

  const concepto = e.lines.find((l) => l.description)?.description ?? null;
  return {
    documentId,
    numeroFactura: [e.invoice.series, e.invoice.number].filter(Boolean).join('-') || null,
    cliente: e.customer.name,
    nifCliente: limpiarNif(e.customer.tax_id),
    fecha: e.invoice.issue_date,
    concepto,
    cuentaContable: CUENTA_VENTAS,
    base: e.amounts.subtotal,
    iva: e.amounts.tax_total,
    retencion: e.amounts.withholding_total,
    total: e.amounts.total_net,
    confianza: e.confidence,
    errores,
    lineas: e.amounts.bases.map((b) => ({ descripcion: descripcionLinea(e, b, concepto), base: b.base_amount, tipoIva: b.tax_rate })),
    direccionCliente: direccion !== undefined ? direccion : direccionDeTexto(e.customer.address),
  };
}

/** Una direccion en una sola cadena (extractor de siempre): toda en la calle. */
function direccionDeTexto(texto: string | null | undefined): DireccionFicha | null {
  const calle = (texto ?? '').replace(/\s+/g, ' ').trim();
  return calle ? { calle, cp: null, municipio: null, provincia: null, pais: null, revisar: false } : null;
}

/** Texto de relleno de las lineas sin descripcion (aInvoiceExtraction pone «Item 2»...). */
const RELLENO = /^Item \d+$/;

/**
 * Texto de la linea de un tipo de IVA: las partidas de ese tramo (lector con
 * Azure); si no las hay, con varios tipos, la primera linea leida de ese tipo;
 * si no, el concepto de la factura o uno generico. Asi cada linea dice lo que
 * es (antes todas llevaban el concepto de la primera).
 */
function descripcionLinea(e: InvoiceExtraction, b: InvoiceExtraction['amounts']['bases'][number], concepto: string | null): string {
  const propia = b.description?.trim();
  if (propia) return propia;
  if (e.amounts.bases.length > 1) {
    const deSuTipo = e.lines.find((l) => l.tax_rate === b.tax_rate && l.description?.trim() && !RELLENO.test(l.description.trim()));
    if (deSuTipo?.description) return deSuTipo.description.trim();
  }
  return concepto ?? 'Factura digitalizada';
}

/**
 * Cuentas de ingresos elegidas en la pantalla con «Cambiar cuenta»: una por
 * linea, en el mismo orden que `lineas` de IngresoExtraido. De cada linea solo
 * se toma la cuenta; lo demas sale de lo leido y guardado en el servidor. null
 * o vacia = la de por defecto (700). Que sea una cuenta de ventas activa del
 * plan lo comprueba el alta de la factura (400 con campo lineas.N.cuenta).
 */
export function cuentasElegidas(raw: unknown, numLineas: number): Array<string | undefined> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Las cuentas de las líneas no tienen el formato esperado.', { campo: 'lineas' });
  if (raw.length > numLineas) {
    throw badRequest(`Llegan cuentas para ${raw.length} líneas y la factura leída tiene ${numLineas === 1 ? 'una' : numLineas}. Vuelve a leerla.`, { campo: 'lineas' });
  }
  return raw.map((l, i) => {
    const c = l && typeof l === 'object' ? (l as { cuenta?: unknown }).cuenta : undefined;
    if (c === undefined || c === null) return undefined;
    if (typeof c !== 'string' || c.length > 20) throw badRequest(`Línea ${i + 1}: la cuenta de ingresos no es válida.`, { campo: `lineas.${i}.cuenta` });
    return c.replace(/[\s.]/g, '') || undefined;
  });
}

/**
 * Separa el numero de factura en serie y numero correlativo, que es como se
 * guardan: "A-2025-0042" -> { serie: "A-2025", numero: 42 }. Sin prefijo, la
 * serie es el ano de emision.
 */
export function separarNumero(
  serieLeida: string | null,
  numeroLeido: string | null,
  fecha: string | null,
): { serie: string; numero: number } {
  const texto = [serieLeida, numeroLeido].filter(Boolean).join('-').trim();
  const m = /^(.*?)(\d+)\D*$/.exec(texto);
  if (!m) throw badRequest(`No se puede interpretar el numero de factura "${texto || '(vacio)'}".`);
  const numero = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw badRequest(`Numero de factura no valido: "${texto}".`);
  const prefijo = m[1].replace(/[\s/._-]+$/, '').trim();
  const serie = prefijo || (fecha ? fecha.slice(0, 4) : hoyEspana().slice(0, 4));
  return { serie, numero };
}

const centimos = (n: number) => Math.round(n * 100) / 100;

/** Lineas de la factura: una por tipo de IVA, con la retencion (si la hay) en todas. */
export function lineasDesdeExtraccion(e: InvoiceExtraction, concepto: string | null): CrearLineaIngresoDTO[] {
  if (e.amounts.withholdings.length > 1) throw badRequest('La factura tiene varias retenciones; registrala a mano.');
  const tipoRetencion = e.amounts.withholdings[0]?.rate ?? 0;
  return e.amounts.bases.map((b) => {
    if (!Number.isInteger(b.tax_rate)) throw badRequest(`Tipo de IVA no valido: ${b.tax_rate}%.`);
    return {
      descripcion: descripcionLinea(e, b, concepto),
      cantidad: 1,
      precioUnitario: b.base_amount,
      descuentoPorcentaje: 0,
      tipoIva: b.tax_rate,
      tipoRetencion,
    };
  });
}

/**
 * Comprueba ANTES de crear la factura que las lineas reproducen al centimo el
 * total leido. Si no, la factura quedaria registrada con otros importes.
 */
export function comprobarTotales(lineas: CrearLineaIngresoDTO[], e: InvoiceExtraction, signo: 1 | -1 = 1): void {
  // Con signo (una rectificativa en negativo): redondeo del valor absoluto, como
  // la rectificativa; en positivo, exactamente el de siempre.
  const r = (n: number) => (n < 0 ? -centimos(-n) : centimos(n));
  let base = 0;
  let iva = 0;
  let retencion = 0;
  for (const l of lineas) {
    const b = r(l.cantidad * l.precioUnitario);
    base += b;
    iva += r((b * (l.tipoIva ?? 0)) / 100);
    retencion += r((b * (l.tipoRetencion ?? 0)) / 100);
  }
  const total = base + iva - retencion;
  const leido = signo * e.amounts.total_net;
  if (aCentimos(total) !== aCentimos(leido)) {
    throw badRequest(
      `Los importes leidos no cuadran: las bases y tipos dan ${r(total).toFixed(2)} EUR y el total de la factura es ` +
        `${leido.toFixed(2)} EUR. Revisa la factura y registrala a mano.`,
    );
  }
}

/** Algun importe leido en negativo (base, total o total a pagar): un abono, aunque no diga «rectificativa». */
const importesLeidosNegativos = (e: InvoiceExtraction) =>
  [...e.amounts.bases.map((b) => b.base_amount), e.amounts.total_gross, e.amounts.total_net].some((x) => typeof x === 'number' && aCentimos(x) < 0);

/** Rectificativa leida lista para el alta: el bloque, las lineas y el cliente que manda la original. */
interface RectificativaLector {
  bloque: Record<string, unknown>;
  lineas: CrearLineaIngresoDTO[];
  /** Cliente de las originales de la app (manda sobre el NIF leido); null si no hay original de la app. */
  clienteOriginal: string | null;
  /** -1 si los importes leidos en positivo se registran en negativo. */
  signo: 1 | -1;
  /** Cuota de IVA fijada por linea (la de la original escrita en una sustitucion de fuera); undefined: base por tipo. */
  cuotasFijas: Array<number | undefined>;
}

/** Diferencia que se tolera entre la cuota escrita de la original y su base por el tipo: el IVA calculado linea a linea. */
const TOLERANCIA_CUOTA = 1;

const TIPOS_IVA_LECTOR = [0, 4, 5, 10, 21];

/**
 * Bloque `rectificativa` de /ingresos-extractor/confirmar. De lo leido salen
 * las lineas (una por tipo de IVA); del cuerpo, la forma, el motivo, el signo
 * (cambiarSigno: con importes en positivo, si restan), las originales o el
 * periodo y, en una sustitucion sin la original en la app, sus importes, que se
 * guardan como lineas en negativo junto a las leidas (lo guardado ya es la
 * diferencia). Sin cuenta elegida, cada linea va a la de la original para su
 * tipo de IVA: la de la linea de mayor base de ese tipo entre todas las
 * originales de la app (cuentaPorTipoIva).
 */
async function rectificativaDelLector(
  companyId: string,
  documentId: string,
  raw: unknown,
  e: InvoiceExtraction,
  lineasLeidas: CrearLineaIngresoDTO[],
  cuentasElegidas: Array<string | undefined>,
): Promise<RectificativaLector> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Los datos de la rectificativa no tienen el formato esperado.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'rectificativa' });
  }
  const r = raw as Record<string, unknown>;
  const forma = r.forma === undefined || r.forma === null || r.forma === '' ? 'I' : r.forma;
  if (forma !== 'I' && forma !== 'S') throw badRequest('Elige cómo rectifica: por diferencias o por sustitución.', { codigo: 'FORMA_NO_VALIDA', campo: 'rectificativa.forma' });
  const negativos = importesLeidosNegativos(e);
  // Por sustitucion, lo leido es la factura corregida entera: en negativo no lo es.
  if (forma === 'S' && negativos) {
    throw badRequest('Por sustitución, la factura leída es la corregida entera y no puede traer importes en negativo. Si es un abono, elige «por diferencias».', {
      codigo: 'SIGNO_NO_CUADRA',
      campo: 'rectificativa.forma',
    });
  }
  const originales = Array.isArray(r.originales) ? (r.originales as Array<Record<string, unknown>>) : [];
  const ids = originales.map((o) => (o && typeof o.id === 'string' ? o.id : null)).filter((x): x is string => !!x);
  const deLaApp = ids.length
    ? await prisma.incomeInvoice.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, customerId: true, tipoFactura: true, lineas: { select: { tipoIva: true, accountCode: true, baseLine: true } } } })
    : [];

  // Signo: con importes en positivo, por diferencias hay que decir si restan o suman.
  let signo: 1 | -1 = 1;
  if (forma === 'I' && !negativos) {
    if (typeof r.cambiarSigno !== 'boolean') {
      throw badRequest('Indica si los importes de la rectificativa restan (es un abono) o suman a la factura que rectifica.', {
        codigo: 'FALTA_SIGNO',
        campo: 'rectificativa.cambiarSigno',
      });
    }
    if (r.cambiarSigno) signo = -1;
  }
  // Sin cuenta elegida: la de la original para su tipo de IVA.
  const cuentaOriginal = cuentaPorTipoIva(deLaApp.flatMap((f) => f.lineas.map((l) => ({ tipoIva: l.tipoIva, cuenta: l.accountCode ?? null, baseLine: Number(l.baseLine) }))));
  let lineas = lineasLeidas.map((l, i) => {
    const cuenta = cuentasElegidas[i] ?? (deLaApp.length ? cuentaOriginal[String(l.tipoIva ?? 21)] : undefined);
    return { ...l, precioUnitario: signo * l.precioUnitario, ...(cuenta ? { cuenta } : {}) };
  });
  let formaBloque: 'I' | 'S' = forma;
  const cuotasFijas: Array<number | undefined> = lineas.map(() => undefined);
  // Por sustitucion sin la original en la app: sus importes, en negativo, junto a los leidos.
  if (forma === 'S' && !deLaApp.length) {
    const io = Array.isArray(r.importesOriginales) ? (r.importesOriginales as Array<Record<string, unknown>>) : [];
    if (!io.length) {
      throw badRequest('Escribe la base y el IVA de la factura original, por tipo de IVA: sin ellos no se sabe qué cambia.', {
        codigo: 'FALTA_IMPORTES_ORIGINALES',
        campo: 'rectificativa.importesOriginales',
      });
    }
    // La retencion de la original: la indicada o, si no, la de la factura leida (la corregida suele llevar la misma).
    const retencionLeida = lineasLeidas[0]?.tipoRetencion ?? 0;
    const deOriginal = io.map((x, i) => {
      const campo = `rectificativa.importesOriginales.${i}`;
      const tipoIva = Number(x?.tipoIva);
      const base = Number(x?.base);
      if (!TIPOS_IVA_LECTOR.includes(tipoIva) || !Number.isFinite(base)) {
        throw badRequest('Los importes de la factura original no son válidos: un tipo de IVA y su base.', { codigo: 'FALTA_IMPORTES_ORIGINALES', campo });
      }
      const conRetencion = x?.tipoRetencion !== undefined && x?.tipoRetencion !== null && x?.tipoRetencion !== '';
      const tipoRetencion = conRetencion ? Number(x.tipoRetencion) : retencionLeida;
      if (!Number.isFinite(tipoRetencion) || tipoRetencion < 0 || tipoRetencion > 50) {
        throw badRequest('La retención de IRPF de la factura original no es válida: un porcentaje entre 0 y 50.', { codigo: 'FALTA_IMPORTES_ORIGINALES', campo: `${campo}.tipoRetencion` });
      }
      // La cuota escrita manda (pudo calcularse linea a linea), si cuadra con su base: mas de 1 € de diferencia es una errata.
      let cuota: number | undefined;
      if (x?.cuota !== undefined && x?.cuota !== null && x?.cuota !== '') {
        cuota = Number(x.cuota);
        const calculada = Math.round(((base * tipoIva) / 100) * 100) / 100;
        if (!Number.isFinite(cuota) || (tipoIva === 0 && aCentimos(cuota) !== 0) || Math.abs(aCentimos(cuota) - aCentimos(calculada)) > TOLERANCIA_CUOTA * 100) {
          throw badRequest(
            `El IVA de la factura original al ${tipoIva} % no cuadra con su base: ${importeTexto(base)} al ${tipoIva} % son ${importeTexto(calculada)}, y has escrito ${Number.isFinite(cuota) ? importeTexto(cuota) : 'otra cosa'}. Revísalo.`,
            { codigo: 'IMPORTES_ORIGINALES_NO_CUADRAN', campo: `${campo}.cuota` },
          );
        }
      }
      return { linea: { descripcion: `Factura rectificada (IVA ${tipoIva} %)`, cantidad: -1, precioUnitario: base, descuentoPorcentaje: 0, tipoIva, tipoRetencion }, cuota };
    });
    lineas = [...lineas, ...deOriginal.map((d) => d.linea)];
    cuotasFijas.push(...deOriginal.map((d) => (d.cuota === undefined ? undefined : -d.cuota)));
    // Lo guardado ya es la diferencia con la original: por diferencias.
    formaBloque = 'I';
  }
  // Explicacion por defecto: el motivo leido (o el texto del motivo).
  let explicacion = typeof r.explicacion === 'string' ? r.explicacion.trim() : '';
  if (!explicacion) {
    const fila = await prisma.lecturaDocumento.findFirst({ where: { companyId, incomeReaderDocumentId: documentId, lector: 'VENTA' }, select: { resultado: true } });
    const leida = (fila?.resultado as { lectura?: { rectificativa?: { motivo?: { valor?: string | null } } | null } } | null)?.lectura;
    explicacion = leida?.rectificativa?.motivo?.valor?.trim() || (esMotivoVenta(r.motivo) ? MOTIVO_INFO[r.motivo].texto : '');
  }
  const clientes = [...new Set(deLaApp.map((f) => f.customerId))];
  return {
    bloque: {
      // La de un ticket (R5) la decide la original: si todas las de la app son simplificadas.
      ticket: deLaApp.length > 0 && deLaApp.every((f) => f.tipoFactura === 'F2'),
      forma: formaBloque,
      motivo: r.motivo,
      explicacion,
      ...(r.periodo !== undefined && r.periodo !== null ? { periodo: r.periodo } : { originales }),
    },
    lineas,
    clienteOriginal: clientes.length === 1 ? clientes[0] : null,
    signo,
    cuotasFijas,
  };
}

/** Lo que ha pasado con el asiento de una factura registrada desde el lector. */
export interface ContabilidadVentaLeida {
  contabilizada: boolean;
  /** El asiento creado (para el enlace «Ver el asiento»). */
  asientoId?: string;
  /** El asiento esta en borrador: cuenta en el balance cuando se aprueba en el Motor contable. */
  asientoEnBorrador?: boolean;
  /** Por que no se ha creado el asiento (se puede contabilizar despues desde la ficha). */
  motivoSinAsiento?: string | null;
}

/**
 * Asiento de una factura de venta registrada desde un lector, igual que al
 * emitir una en la app (POST /income-invoices). Como viene del lector (el
 * documento ya esta enlazado), queda en borrador hasta aprobarlo en el Motor
 * contable. No es critico: si falla, la factura ya esta registrada y se
 * contabiliza desde su ficha.
 */
export async function contabilizarVentaLeida(companyId: string, facturaId: string): Promise<ContabilidadVentaLeida> {
  try {
    const r = await accountingHooksService.onIncomeInvoiceConfirmed(companyId, facturaId);
    if (!r.contabilizada || !r.journalEntryId) return { contabilizada: false, motivoSinAsiento: r.motivo ?? null };
    const asiento = await prisma.journalEntry.findFirst({ where: { id: r.journalEntryId, companyId }, select: { estado: true } });
    return { contabilizada: true, asientoId: r.journalEntryId, asientoEnBorrador: asiento?.estado !== 'POSTED' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Aviso: no se pudo contabilizar la factura ${facturaId} del lector:`, detalleFalloBD(err) ?? (err instanceof Error ? err.message : String(err)));
    // Un fallo de la base de datos, en castellano (no el texto de Prisma).
    return { contabilizada: false, motivoSinAsiento: motivoSinAsiento(err) };
  }
}

export const ingresosExtractorService = {
  /** Lee la factura (PDF o imagen) y la deja pendiente de confirmar. */
  async extraer(
    companyId: string,
    userId: string | undefined,
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<IngresoExtraido> {
    const { documentId, extraccion } = await invoiceExtractorService.extraer(companyId, userId, archivo);
    return aIngresoExtraido(documentId, extraccion);
  },

  /**
   * Crea la factura de ingreso a partir de la extraccion guardada. El cliente
   * tiene que estar dado de alta: el elegido en la pantalla (clienteId) o el
   * de la empresa con el NIF leido. Si no hay ninguno, 400
   * TERCERO_NO_DADO_DE_ALTA: ya no se crea solo.
   *
   * Rectificativa o abono: con el bloque `rectificativa` se registra como
   * rectificativa (rectificativaDelLector); con una original de la app, su
   * cliente manda (otro clienteId: 400 ORIGINAL_DE_OTRO_CLIENTE). Con importes
   * en positivo se puede marcar que no lo es (noEsRectificativa, queda en
   * AuditLog); con importes en negativo, no.
   */
  async confirmar(
    companyId: string,
    documentId: string,
    opciones: {
      revisado?: boolean;
      userId?: string;
      lineas?: unknown;
      clienteId?: string;
      rectificativa?: unknown;
      noEsRectificativa?: boolean;
      /** Tras el 409 DEVENGO_FUERA_APP (una R4 que sube el IVA de un periodo de la gestoria o de un 303 presentado). */
      confirmaDevengoFuera?: boolean;
    } = {},
  ): Promise<{ facturaId: string; numeroCompleto: string; total: number; esRectificativa: boolean; avisos?: string[] } & ContabilidadVentaLeida> {
    const doc = await prisma.incomeReaderDocument.findFirst({
      where: { id: documentId, companyId, sourceType: 'EXTRACTOR_IA' },
    });
    if (!doc) throw notFound('Documento no encontrado.');
    if (doc.status !== 'READY_FOR_VERIFICATION') throw badRequest(`El documento esta en estado ${doc.status}; ya no se puede confirmar.`);
    // El cliente elegido en la pantalla («Es uno que ya tengo» o el recien dado de alta), de esta empresa.
    const elegido = opciones.clienteId
      ? await prisma.customer.findFirst({ where: { id: opciones.clienteId, companyId }, select: { id: true } })
      : null;
    if (opciones.clienteId && !elegido) throw notFound('Cliente no encontrado.');
    const e = doc.parsedData as unknown as InvoiceExtraction;
    // Rectificativa o abono: su bloque, o marcar que no lo es (solo con importes en positivo).
    const conBloque = opciones.rectificativa !== undefined && opciones.rectificativa !== null;
    const noEsRectificativa = opciones.noEsRectificativa === true;
    if (conBloque && noEsRectificativa) {
      throw badRequest('Indica qué factura rectifica o marca que no es una rectificativa, pero no las dos cosas.', { codigo: 'RECTIFICATIVA_NO_VALIDA', campo: 'noEsRectificativa' });
    }
    if (noEsRectificativa && importesLeidosNegativos(e)) {
      throw badRequest('Los importes son negativos: es un abono. Indica qué factura rectifica.', { codigo: 'NO_ES_RECTIFICATIVA_CON_NEGATIVOS', campo: 'noEsRectificativa' });
    }
    // Leido con /lecturas: si algo estaba marcado, hace falta "He revisado". Con un
    // cliente elegido, o con una original de la app (el cliente es el suyo), el NIF
    // leido del cliente (que falte o este mal) ya no bloquea.
    const r0 = conBloque && typeof opciones.rectificativa === 'object' ? (opciones.rectificativa as { originales?: unknown }) : null;
    const idsOriginales = Array.isArray(r0?.originales)
      ? (r0!.originales as unknown[]).map((o) => (o && typeof o === 'object' ? (o as { id?: unknown }).id : null)).filter((x): x is string => typeof x === 'string' && !!x)
      : [];
    const conOriginalApp = idsOriginales.length > 0 && (await prisma.incomeInvoice.count({ where: { companyId, id: { in: idsOriginales } } })) > 0;
    const { ignoradas: ignorados, deLectura } = await comprobarRevisionVenta(
      companyId,
      documentId,
      opciones.revisado === true,
      elegido || conOriginalApp ? ['NIF_RECEPTOR'] : [],
      { bloque: conBloque, noEsRectificativa },
    );
    // Documento del lector de siempre con importes en negativo: tambien hace falta decir que rectifica.
    if (!conBloque && !noEsRectificativa && importesLeidosNegativos(e)) throw badRequest(MENSAJE_FALTA_RECTIFICATIVA, { codigo: 'FALTA_RECTIFICATIVA', campo: 'rectificativa' });

    // Leida con /lecturas: que falte el NIF del cliente ya lo han dicho sus validaciones (un
    // cliente de fuera de la UE puede no tenerlo); sin cliente, el 400 TERCERO_NO_DADO_DE_ALTA de abajo.
    const resumen = aIngresoExtraido(documentId, e, undefined, { nifYaValidado: deLectura });
    // La cuenta de cada linea, si se cambio en la pantalla (no cambia importes).
    const cuentas = cuentasElegidas(opciones.lineas, e.amounts.bases.length);
    const leidas = lineasDesdeExtraccion(e, resumen.concepto);
    const rect = conBloque ? await rectificativaDelLector(companyId, documentId, opciones.rectificativa, e, leidas, cuentas) : null;
    if (rect?.clienteOriginal && elegido && elegido.id !== rect.clienteOriginal) {
      throw badRequest('La factura que rectifica es de otro cliente: la rectificativa va a su nombre.', { codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo: 'clienteId' });
    }
    // Con una original de la app, su cliente: el NIF leido (que falte o este mal) ya no bloquea.
    const sinNifLeido = new Set([...(elegido || rect?.clienteOriginal ? [MENSAJE_FALTA_NIF_CLIENTE] : []), ...ignorados]);
    const errores = resumen.errores.filter((m) => !sinNifLeido.has(m));
    if (errores.length > 0) throw badRequest(`No se puede registrar: ${errores.join(' ')}`);

    const existente = rect?.clienteOriginal ? { id: rect.clienteOriginal } : (elegido ?? (await clientePorNif(companyId, resumen.nifCliente)));
    if (!existente) throw errorTerceroNoDadoDeAlta('cliente', { nombre: e.customer.name, nif: resumen.nifCliente });

    const { serie, numero } = separarNumero(e.invoice.series, e.invoice.number, e.invoice.issue_date);
    const lineas = rect ? rect.lineas : leidas.map((l, i) => (cuentas[i] ? { ...l, cuenta: cuentas[i] } : l));
    // Lo leido (con su signo) tiene que cuadrar al centimo con el total de la factura.
    comprobarTotales(rect ? rect.lineas.slice(0, leidas.length) : lineas, e, rect?.signo ?? 1);

    const customer = { id: existente.id };

    // Origen lector: la fiscalidad avisa en vez de rechazar (y en una empresa no
    // espanola quita el IVA que el OCR pone por defecto).
    const factura = await incomeInvoicesService
      .crearIngreso(
        {
          companyId,
          customer,
          serie,
          numero,
          fechaEmision: e.invoice.issue_date ?? undefined,
          fechaVencimiento: e.invoice.due_date ?? undefined,
          lineas,
          observaciones: `Digitalizada desde ${doc.originalFileName}`,
          ...(rect ? { rectificativa: rect.bloque } : {}),
          ...(opciones.confirmaDevengoFuera === true ? { confirmaDevengoFuera: true } : {}),
        },
        // El numero se guarda tal como se leyo (con sus ceros y su separador), el que ve la pantalla.
        { origen: 'lector', numeroLeido: resumen.numeroFactura, ...(rect?.cuotasFijas.some((c) => c !== undefined) ? { cuotasFijas: rect.cuotasFijas } : {}) },
      )
      // Si la base de datos falla, la factura no queda registrada: se dice asi, en castellano.
      .catch((err: unknown) => {
        throw errorFalloBD(err, QUE_HACER_REGISTRAR, 'registrar la factura de venta leída') ?? err;
      });

    // Archivar el PDF en su carpeta definitiva. No es critico: si falla, la
    // factura ya esta creada y el documento queda enlazado igualmente.
    try {
      // Lo ya dado por bueno arriba (el NIF leido, con un cliente elegido) no lo frena.
      await invoiceExtractorService.confirmar(companyId, documentId, [...sinNifLeido]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('ingresos-extractor: no se pudo archivar el PDF', err);
    }
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: { status: 'VERIFIED', verifiedAt: new Date(), linkedInvoiceId: factura.id },
    });

    // Archivo por trimestres: el PDF original queda en su carpeta (no bloqueante).
    await archivarVentaSinRomper(companyId, factura.id);
    await vincularLectura(companyId, { incomeReaderDocumentId: documentId }, { incomeInvoiceId: factura.id, userId: opciones.userId, revisada: opciones.revisado === true });

    // Despues de enlazar el documento: asi el asiento sale en borrador, como el de las compras leidas.
    const contable = await contabilizarVentaLeida(companyId, factura.id);
    if (noEsRectificativa) {
      await registrarAuditoria({
        userId: opciones.userId ?? 'unknown',
        companyId,
        action: 'LECTOR_VENTA_NO_ES_RECTIFICATIVA',
        resourceType: 'INCOME_INVOICE',
        resourceId: factura.id,
        meta: { documentId, numeroCompleto: factura.numeroCompleto },
      });
    }
    // R4 que sube el IVA de un 303 ya presentado, registrada con la confirmacion: queda la marca.
    if (factura.avisosFiscales?.some((a) => a.codigo === 'RECTIFICAR_303')) {
      await registrarAuditoria({
        userId: opciones.userId ?? 'unknown',
        companyId,
        action: 'RECTIFICAR_303_PENDIENTE',
        resourceType: 'INCOME_INVOICE',
        resourceId: factura.id,
        meta: { documentId, numeroCompleto: factura.numeroCompleto, fechaIva: factura.fechaOperacion ?? null },
      });
    }
    const avisos = (factura.avisosFiscales ?? []).map((a) => a.mensaje);

    return {
      facturaId: factura.id,
      numeroCompleto: factura.numeroCompleto ?? '',
      total: factura.totalFactura,
      esRectificativa: factura.esRectificativa,
      ...(avisos.length ? { avisos } : {}),
      ...contable,
    };
  },
};
