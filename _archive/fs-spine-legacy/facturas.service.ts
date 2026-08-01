import { Factura } from '../domain/factura.model';
import { createSalesDocumentService } from './sales-document.service';
import { CampoDocumento, PlantillaDocumento, SeccionDocumento } from '../domain/plantillas-documento.model';
import { ID, Paginated } from '../domain/common.types';
import { getFsClientForCompany } from './facturascripts-client';
import { resolverCodSerieFactura } from './series.service';
import { enriquecerFacturasConEstadoCobro } from './cobros.service';
import { crearAsientoEnFacturascriptsDesdeFactura } from './asientos.service';
import { crearVencimientos } from './vencimientos.service';
import { badRequest } from '../utils/http-errors';
import {
  CrearFacturaIngresoDTO,
  EstadoFacturaIngreso,
  FacturaIngresoResp,
  LineaIngresoResp,
} from '../domain/facturaIngreso.model';

// Facturas de cliente -> recurso FacturaScripts: facturaclientes
const baseFacturasService = createSalesDocumentService<Factura>('facturaclientes');

/**
 * Servicio de facturas enriquecido:
 *  - list/getById: anexan estadoCobro/importeCobrado/importePendiente (Feature 3).
 *  - create: resuelve la SERIE elegida por el usuario (Feature 1) y la mapea al
 *    campo `codserie` de FacturaScripts antes de crear el documento.
 */
export const facturasService = {
  ...baseFacturasService,

  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Factura>> {
    const res = await baseFacturasService.list(companyId, params);
    // Enriquecido en lote: 1 sola consulta de cobros para todo el listado.
    const items = (await enriquecerFacturasConEstadoCobro(
      String(companyId),
      res.items as Array<Record<string, unknown>>,
    )) as unknown as Factura[];
    return { ...res, items };
  },

  async getById(companyId: ID, id: ID): Promise<Factura> {
    const f = await baseFacturasService.getById(companyId, id);
    const [enriquecida] = await enriquecerFacturasConEstadoCobro(String(companyId), [f as Record<string, unknown>]);
    return enriquecida as unknown as Factura;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Factura> {
    // Feature 1 — eleccion de serie: serieId | serieCodigo | (defecto FACTURA).
    const codserie = await resolverCodSerieFactura(String(companyId), {
      serieId: data.serieId as string | undefined,
      serieCodigo: data.serieCodigo as string | undefined,
    });
    const fs = await getFsClientForCompany(companyId);
    // Mapea el DTO a la API de FS inyectando codserie. El resto de campos
    // (codcliente, fecha, lineas, codalmacen, coddivisa, codpago) se pasan tal
    // cual; FacturaScripts valida y numera segun la serie indicada.
    const { serieId: _sid, serieCodigo: _sc, ...resto } = data;
    void _sid;
    void _sc;
    return (await fs.create('facturaclientes', { ...resto, codserie })) as Factura;
  },
};

/** Busca el codigo de cliente/proveedor en FacturaScripts por su NIF (cifnif). */
async function resolverTerceroPorNif(
  companyId: ID,
  recurso: 'clientes' | 'proveedores',
  nif: string,
): Promise<string | null> {
  const fs = await getFsClientForCompany(companyId);
  const { items } = await fs.listWithMeta(recurso, { 'filter[cifnif]': nif, limit: 1 });
  const it = items[0] as Record<string, unknown> | undefined;
  if (!it) return null;
  return String(recurso === 'clientes' ? it.codcliente : it.codproveedor);
}

// El flujo legacy "crear factura desde FacturaLeida" (lector vanilla) se retiró
// con la cadena lectorFacturas (ADR-002): el lector canónico income-reader crea
// la factura por su propio camino (verificarYCrearFactura -> income-invoices).

const round2ing = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Resuelve el codcliente: usa el existente o crea uno nuevo en FacturaScripts. */
async function resolverCliente(companyId: ID, customer: CrearFacturaIngresoDTO['customer']): Promise<string> {
  if (customer.id) return String(customer.id);
  const n = customer.nuevo;
  if (!n || !n.nombreFiscal || !n.nifCif) throw badRequest('Indica customer.id o customer.nuevo con nombreFiscal y nifCif.');
  const fs = await getFsClientForCompany(companyId);
  const creado = (await fs.create('clientes', {
    nombre: n.nombreFiscal,
    razonsocial: n.nombreFiscal,
    cifnif: n.nifCif,
    email: n.email,
    direccion: n.direccion,
    codpais: n.pais ?? 'ESP',
    provincia: n.provincia,
    ciudad: n.municipio,
    codpostal: n.cp,
  })) as Record<string, unknown>;
  const cod = String(creado.codcliente ?? '');
  if (!cod) throw badRequest('No se pudo crear el cliente nuevo.');
  return cod;
}

/**
 * Crea una FACTURA DE INGRESO completa (cabecera + lineas + totales) en
 * FacturaScripts, replicando las formulas de FS (Calculator):
 *   pvpsindto = cantidad*precio ; pvptotal = pvpsindto*(100-dto)/100
 *   neto = sum(pvptotal) ; totaliva = sum(base*iva/100) ;
 *   totalirpf = sum(base*irpf/100) ; total = neto+totaliva-totalirpf
 * Crea ademas el vencimiento (a cobrar) con la fecha de vencimiento para el
 * panel de tesoreria. FS controla la numeracion (serie+numero) y rechaza
 * duplicados. Reutilizado por las facturas rectificativas (importes negativos).
 */
export async function crearFacturaIngreso(companyId: ID, dto: CrearFacturaIngresoDTO): Promise<FacturaIngresoResp> {
  if (!dto.lineas || dto.lineas.length === 0) throw badRequest('La factura necesita al menos una linea.');

  const codcliente = await resolverCliente(companyId, dto.customer);
  const codserie = await resolverCodSerieFactura(String(companyId), { serieCodigo: dto.serie });
  const fechaEmision = (dto.fechaEmision ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const fechaVencimiento = (dto.fechaVencimiento ?? (() => {
    const d = new Date(fechaEmision);
    d.setDate(d.getDate() + 15); // por defecto: emision + 15 dias (editable)
    return d.toISOString().slice(0, 10);
  })()).slice(0, 10);

  const fs = await getFsClientForCompany(companyId);

  // FS exige codalmacen/coddivisa/codpago explicitos al crear el documento (la
  // empresa no tiene defaults). Ademas, la LINEA guarda el IVA por `codimpuesto`
  // (no por el numero `iva`): hay que mapear tipoIva -> codimpuesto o el 303
  // leeria 0% de cuota. Lo tomamos del recurso `impuestos` de FS.
  const [alm, fpago, imp] = await Promise.all([
    fs.listWithMeta('almacenes', { limit: 1 }),
    fs.listWithMeta('formapagos', { limit: 1 }),
    fs.listWithMeta('impuestos', { limit: 100 }),
  ]);
  const codalmacen = String((alm.items[0] as Record<string, unknown> | undefined)?.codalmacen ?? '');
  const codpago = String((fpago.items[0] as Record<string, unknown> | undefined)?.codpago ?? '');
  const codImpuestoPorTipo = new Map<number, string>();
  for (const it of imp.items as Array<Record<string, unknown>>) {
    codImpuestoPorTipo.set(Math.round(Number(it.iva ?? 0)), String(it.codimpuesto ?? ''));
  }

  // --- Calculo de lineas y totales (formulas FS) ---
  const lineasResp: LineaIngresoResp[] = [];
  let baseTotal = 0;
  let ivaTotal = 0;
  let retencionTotal = 0;
  const lineasFs: Array<Record<string, unknown>> = [];
  for (const l of dto.lineas) {
    const dto2 = l.descuentoPorcentaje ?? 0;
    const pvpsindto = round2ing(l.cantidad * l.precioUnitario);
    const baseLine = round2ing((pvpsindto * (100 - dto2)) / 100);
    const tipoIva = l.tipoIva ?? 0;
    const tipoRet = l.tipoRetencion ?? 0;
    const ivaImporte = round2ing((baseLine * tipoIva) / 100);
    const retencionImporte = round2ing((baseLine * tipoRet) / 100);
    baseTotal = round2ing(baseTotal + baseLine);
    ivaTotal = round2ing(ivaTotal + ivaImporte);
    retencionTotal = round2ing(retencionTotal + retencionImporte);
    lineasResp.push({ descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario, descuentoPorcentaje: dto2, baseLine, tipoIva, ivaImporte, tipoRetencion: tipoRet, retencionImporte });
    lineasFs.push({ referencia: l.productoServicioId, descripcion: l.descripcion, cantidad: l.cantidad, pvpunitario: l.precioUnitario, dtopor: dto2, codimpuesto: codImpuestoPorTipo.get(Math.round(tipoIva)), iva: tipoIva, irpf: tipoRet, pvpsindto, pvptotal: baseLine });
  }
  const totalFactura = round2ing(baseTotal + ivaTotal - retencionTotal);

  // FS denormaliza cifnif/nombrecliente en la cabecera y no los autocompleta
  // desde codcliente via API: los leemos de la ficha del cliente.
  const cli = (await fs.getOne('clientes', codcliente)) as Record<string, unknown>;

  // --- Cabecera ---
  const cabecera: Record<string, unknown> = {
    codcliente,
    cifnif: String(cli.cifnif ?? ''),
    nombrecliente: String(cli.nombre ?? cli.razonsocial ?? ''),
    codserie,
    fecha: fechaEmision,
    observaciones: dto.observaciones,
    codalmacen,
    coddivisa: 'EUR',
    codpago,
  };
  if (dto.facturaOriginalId) cabecera.idfacturarect = dto.facturaOriginalId; // rectificativa
  const factura = (await fs.create('facturaclientes', cabecera)) as Record<string, unknown>;
  const idfactura = String(factura.idfactura ?? '');

  // --- Lineas ---
  for (const lf of lineasFs) await fs.create('lineafacturaclientes', { ...lf, idfactura });

  // --- Totales (FS no recalcula al crear lineas via API; los fijamos nosotros) ---
  const facturaActualizada = (await fs.update('facturaclientes', idfactura, {
    neto: baseTotal,
    totaliva: ivaTotal,
    totalirpf: retencionTotal,
    totalrecargo: 0,
    total: totalFactura,
  })) as Record<string, unknown>;

  // --- Vencimiento (a cobrar) para el panel de tesoreria ---
  await crearVencimientos(String(companyId), idfactura, 'cobro', [{ fecha: fechaVencimiento, importe: totalFactura, formaPago: 'TRANSFERENCIA' }]);

  const hoy = new Date().toISOString().slice(0, 10);
  let estado: EstadoFacturaIngreso = 'PENDING';
  if (totalFactura < 0) estado = 'PENDING'; // rectificativa (abono) tambien pendiente
  else if (fechaVencimiento < hoy) estado = 'OVERDUE';

  return {
    id: idfactura,
    companyId: String(companyId),
    customerId: codcliente,
    serie: codserie,
    numero: Number(facturaActualizada.numero ?? factura.numero ?? 0),
    numeroCompleto: String(facturaActualizada.codigo ?? factura.codigo ?? ''),
    fechaEmision,
    fechaVencimiento,
    estado,
    baseTotal,
    ivaTotal,
    retencionTotal,
    totalFactura,
    observaciones: dto.observaciones ?? '',
    esRectificativa: !!dto.facturaOriginalId,
    facturaOriginalId: dto.facturaOriginalId,
    lineas: lineasResp,
  };
}

/**
 * Factura RECTIFICATIVA (abono): crea una nueva factura con las lineas de la
 * original NEGADAS, enlazada por idfacturarect. Permite sustituir las lineas
 * (para rectificar importes concretos) o negar las de la original tal cual.
 */
export async function crearFacturaRectificativa(
  companyId: ID,
  facturaOriginalId: string,
  lineasOverride?: CrearFacturaIngresoDTO['lineas'],
): Promise<FacturaIngresoResp> {
  const fs = await getFsClientForCompany(companyId);
  const orig = (await fs.getOne('facturaclientes', facturaOriginalId)) as Record<string, unknown>;
  if (!orig || orig.idfactura === undefined) throw badRequest('Factura original no encontrada.');

  let lineas = lineasOverride;
  if (!lineas) {
    const { items } = await fs.listWithMeta('lineafacturaclientes', { 'filter[idfactura]': facturaOriginalId, limit: 1000 });
    lineas = (items as Array<Record<string, unknown>>).map((l) => ({
      descripcion: String(l.descripcion ?? ''),
      cantidad: -Number(l.cantidad ?? 0), // negada -> abono
      precioUnitario: Number(l.pvpunitario ?? 0),
      descuentoPorcentaje: Number(l.dtopor ?? 0),
      tipoIva: Number(l.iva ?? 0),
      tipoRetencion: Number(l.irpf ?? 0),
    }));
  }
  return crearFacturaIngreso(companyId, {
    customer: { id: String(orig.codcliente ?? '') },
    serie: String(orig.codserie ?? ''),
    lineas,
    observaciones: `Rectificativa de ${orig.codigo ?? facturaOriginalId}`,
    facturaOriginalId,
  });
}

export interface DocumentoRenderizado {
  encabezado: Record<string, unknown>;
  cuerpo: { columnas: string[]; lineas: Record<string, unknown>[] };
  pie: Record<string, unknown>;
  observaciones: string[];
}

/** Resuelve un path tipo 'empresa.nombre' contra el contexto. */
function resolverPath(contexto: Record<string, unknown>, path?: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, contexto);
}

/** Extrae el valor de un campo a partir de su origen/pathOrigen. */
function valorCampo(campo: CampoDocumento, contexto: Record<string, unknown>): unknown {
  if (campo.origen === 'fijo') return campo.valorFijo ?? '';
  return resolverPath(contexto, campo.pathOrigen);
}

/**
 * Aplica una plantilla a una factura y devuelve una estructura lista para
 * renderizar (PDF, email, web). No genera PDF: solo estructura los datos.
 */
export function renderizarFacturaConPlantilla(
  factura: Record<string, unknown>,
  empresa: Record<string, unknown>,
  cliente: Record<string, unknown>,
  plantilla: PlantillaDocumento,
): DocumentoRenderizado {
  const contexto: Record<string, unknown> = { empresa, cliente, factura };
  const lineas = Array.isArray(factura.lineas) ? (factura.lineas as Record<string, unknown>[]) : [];

  const seccion = (nombre: SeccionDocumento['nombre']): SeccionDocumento | undefined =>
    plantilla.secciones.find((s) => s.nombre === nombre);

  const camposVisibles = (s?: SeccionDocumento): CampoDocumento[] =>
    (s?.campos ?? []).filter((c) => c.visible).sort((a, b) => a.orden - b.orden);

  // encabezado / pie: objeto etiqueta -> valor
  const construirObjeto = (nombre: SeccionDocumento['nombre']): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const campo of camposVisibles(seccion(nombre))) {
      out[campo.etiqueta] = valorCampo(campo, contexto);
    }
    return out;
  };

  // cuerpo (tabla): columnas = etiquetas; cada linea aplica los campos origen 'linea'
  const camposCuerpo = camposVisibles(seccion('cuerpo'));
  const columnas = camposCuerpo.map((c) => c.etiqueta);
  const filas = lineas.map((linea) => {
    const fila: Record<string, unknown> = {};
    for (const campo of camposCuerpo) {
      const ctxLinea: Record<string, unknown> = { ...contexto, linea };
      fila[campo.etiqueta] = campo.origen === 'fijo' ? campo.valorFijo ?? '' : resolverPath(ctxLinea, campo.pathOrigen);
    }
    return fila;
  });

  // observaciones: lista de valores
  const observaciones = camposVisibles(seccion('observaciones')).map((c) => String(valorCampo(c, contexto) ?? ''));

  return {
    encabezado: construirObjeto('encabezado'),
    cuerpo: { columnas, lineas: filas },
    pie: construirObjeto('pie'),
    observaciones,
  };
}
