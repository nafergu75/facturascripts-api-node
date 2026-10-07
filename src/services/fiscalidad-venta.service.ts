import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import { badRequest } from '../utils/http-errors';
import {
  avisoFiscal,
  CAUSAS_EXENCION,
  esClienteUe,
  fueraDelTai,
  mencionFiscal,
  paisDelCliente,
  PAISES_UE,
  REGLA_OPERACION,
  resolverFiscalidadPura,
  sugerirTipoOperacion,
  SUPUESTOS_EXENCION,
  SUPUESTOS_ISP,
  tieneNifIvaUe,
  tipoOperacionLegacy,
  TIPOS_SELECCIONABLES,
  type AvisoFiscal,
  type ClienteFiscal,
  type ModoFiscal,
  type ResultadoFiscalidad,
  type TipoProducto,
} from '../domain/tipo-operacion.model';
import { MONEDAS_FACTURA } from '../domain/divisas';
import { perfilEmpresa, type PerfilEmpresa } from './perfilEmpresa.service';

type Db = ClienteBD | TransaccionBD;

export interface EntradaResolverFiscalidad {
  companyId: string;
  perfil: PerfilEmpresa;
  cliente: ClienteFiscal;
  tipoOperacion?: string | null;
  causaExencion?: string | null;
  referenciaLegal?: string | null;
  tipoFactura?: string | null;
  lineas: Array<{ tipoIva?: number; tipoRetencion?: number; productoServicioId?: string | null }>;
  /** Rectificativa: el tipo de la factura que rectifica (null si es anterior a esta funcion). */
  heredado?: { tipoOperacion: string | null; causaExencion: string | null; referenciaLegal: string | null };
}

/** PRODUCTO o SERVICIO de las lineas que vienen del catalogo (solo para avisos). */
async function tiposDeProducto(companyId: string, lineas: EntradaResolverFiscalidad['lineas'], db: Db): Promise<TipoProducto[]> {
  const ids = [...new Set(lineas.map((l) => l.productoServicioId).filter((x): x is string => !!x))];
  if (ids.length === 0) return [];
  const productos = await db.product.findMany({ where: { companyId, id: { in: ids } }, select: { tipo: true } });
  return [...new Set(productos.map((p) => (p.tipo === 'SERVICIO' ? 'SERVICIO' : 'PRODUCTO') as TipoProducto))];
}

/**
 * Tipo de operacion de una factura de venta segun la empresa, el cliente y las
 * lineas (ver domain/tipo-operacion.model.ts). Los errores dan 400 con sus
 * codigos en `details`.
 *
 *  - Empresa no espanola: EMPRESA_EXTRANJERA con las lineas a 0 % y sin
 *    retencion (normaliza, no rechaza).
 *  - Rectificativa: hereda el tipo de la original (el de siempre si es
 *    anterior) y valida sus lineas contra el.
 */
export async function resolverFiscalidad(e: EntradaResolverFiscalidad, modo: ModoFiscal, db: Db = prisma): Promise<ResultadoFiscalidad> {
  const tiposProducto = await tiposDeProducto(e.companyId, e.lineas, db);
  const lineas = e.lineas.map((l) => ({ tipoIva: Number(l.tipoIva ?? 21), tipoRetencion: Number(l.tipoRetencion ?? 0) }));
  let r: ResultadoFiscalidad;

  if (e.heredado) {
    const tipo = e.heredado.tipoOperacion ?? tipoOperacionLegacy(e.cliente.pais, e.cliente.nifCif);
    r = resolverFiscalidadPura(
      {
        empresaEspanola: tipo !== 'EMPRESA_EXTRANJERA',
        tipoOperacion: tipo,
        causaExencion: e.heredado.causaExencion,
        referenciaLegal: e.heredado.referenciaLegal,
        tipoFactura: e.tipoFactura,
        lineas,
        cliente: e.cliente,
        tiposProducto,
        heredadoLegacy: !e.heredado.tipoOperacion,
      },
      'heredar',
    );
  } else {
    r = resolverFiscalidadPura(
      {
        empresaEspanola: e.perfil.espanola,
        tipoOperacion: e.tipoOperacion ?? null,
        causaExencion: e.causaExencion,
        referenciaLegal: e.referenciaLegal,
        tipoFactura: e.tipoFactura,
        lineas,
        cliente: e.cliente,
        tiposProducto,
      },
      modo,
    );
  }

  if (r.errores.length > 0) {
    throw badRequest(r.errores.map((x) => x.mensaje).join(' '), {
      codigos: r.errores.map((x) => x.codigo),
      errores: r.errores,
      avisos: r.avisos,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Contexto para el formulario de factura
// ---------------------------------------------------------------------------

async function cargarCliente(companyId: string, customerId: string, db: Db): Promise<ClienteFiscal> {
  const c = await db.customer.findFirst({ where: { id: customerId, companyId }, select: { pais: true, nifCif: true, cp: true } });
  if (!c) throw badRequest('Cliente no encontrado.');
  return c;
}

/** Avisos sobre los datos del cliente (NIF-IVA, Canarias...), sin bloquear. */
function avisosDelCliente(cliente: ClienteFiscal): AvisoFiscal[] {
  const avisos: AvisoFiscal[] = [];
  if (esClienteUe(cliente) && !tieneNifIvaUe(cliente)) avisos.push(avisoFiscal('CLIENTE_SIN_NIF_IVA'));
  if (fueraDelTai(paisDelCliente(cliente), cliente.cp)) avisos.push(avisoFiscal('CLIENTE_FUERA_TAI'));
  return avisos;
}

/**
 * GET /income-invoices/tipos-operacion: lo que necesita el formulario. Una
 * empresa no espanola no tiene desplegable (tipos vacio): sus facturas van sin IVA.
 */
export async function contextoFiscalEmpresa(companyId: string, customerId?: string, db: Db = prisma) {
  const perfil = await perfilEmpresa(companyId, db);
  const base = {
    empresaEspanola: perfil.espanola,
    pais: perfil.pais,
    idiomaPdf: perfil.idioma,
    formatoPdf: perfil.formato,
    monedaCuenta: perfil.monedaCuenta,
    monedasFactura: perfil.monedasFactura.map((codigo) => ({
      codigo,
      nombre: MONEDAS_FACTURA[codigo]?.nombre.es ?? codigo,
      simbolo: MONEDAS_FACTURA[codigo]?.simbolo ?? codigo,
    })),
    tipos: perfil.espanola
      ? TIPOS_SELECCIONABLES.map((t) => {
          const r = REGLA_OPERACION[t];
          return {
            codigo: t,
            etiqueta: r.etiqueta.es,
            etiquetaCorta: r.etiquetaCorta.es,
            etiquetaEn: r.etiqueta.en,
            llevaCuota: r.llevaCuota,
            admiteRetencion: r.admiteRetencion,
            tiposFacturaProhibidos: r.tiposFacturaProhibidos,
            exigeSupuesto: t === 'EXENTA',
            admiteReferencia: t === 'EXENTA' || t === 'ISP_NACIONAL',
          };
        })
      : [],
    causasExencion: CAUSAS_EXENCION,
    supuestosExencion: SUPUESTOS_EXENCION,
    supuestosIsp: SUPUESTOS_ISP,
    paisesUe: [...PAISES_UE].filter((p) => p !== 'ES').sort(),
  };
  if (!customerId || !perfil.espanola) return base;
  const cliente = await cargarCliente(companyId, customerId, db);
  const sugerencia = sugerirTipoOperacion(cliente);
  return {
    ...base,
    sugerencia: { tipoOperacion: sugerencia.tipoOperacion, avisos: sugerencia.avisos.map(avisoFiscal) },
    avisosCliente: avisosDelCliente(cliente),
  };
}

export interface EntradaSugerir {
  customerId?: string;
  cliente?: ClienteFiscal;
  lineas?: Array<{ tipoIva?: number; tipoRetencion?: number; productoServicioId?: string | null }>;
  tipoOperacion?: string | null;
  causaExencion?: string | null;
  referenciaLegal?: string | null;
  tipoFactura?: string | null;
  /** Revisar como al guardar (por defecto) o como al emitir. */
  modo?: 'guardar' | 'emitir';
}

/**
 * POST /income-invoices/sugerir-operacion: tipo sugerido para el cliente (y las
 * lineas), la mencion del PDF y, si llegan lineas, la revision sin bloquear
 * (errores y avisos con sus codigos). No guarda nada.
 */
export async function sugerirOperacion(companyId: string, e: EntradaSugerir, db: Db = prisma) {
  const perfil = await perfilEmpresa(companyId, db);
  const cliente: ClienteFiscal = e.customerId
    ? await cargarCliente(companyId, e.customerId, db)
    : { pais: e.cliente?.pais ?? null, nifCif: e.cliente?.nifCif ?? null, cp: e.cliente?.cp ?? null };
  const lineas = Array.isArray(e.lineas) ? e.lineas : [];
  const tiposProducto = await tiposDeProducto(companyId, lineas, db);

  if (!perfil.espanola) {
    return {
      empresaEspanola: false,
      sugerencia: { tipoOperacion: 'EMPRESA_EXTRANJERA' as const, avisos: [] },
      mencion: null,
      revision: { errores: [], avisos: lineas.some((l) => Number(l.tipoIva ?? 0) || Number(l.tipoRetencion ?? 0)) ? [avisoFiscal('IVA_ELIMINADO_EMPRESA_EXTRANJERA')] : [] },
    };
  }

  const s = sugerirTipoOperacion(cliente, tiposProducto);
  const elegido = e.tipoOperacion ? String(e.tipoOperacion).trim().toUpperCase() : null;
  const r = resolverFiscalidadPura(
    {
      empresaEspanola: true,
      tipoOperacion: elegido,
      causaExencion: e.causaExencion,
      referenciaLegal: e.referenciaLegal,
      tipoFactura: e.tipoFactura,
      lineas: lineas.map((l) => ({ tipoIva: Number(l.tipoIva ?? 21), tipoRetencion: Number(l.tipoRetencion ?? 0) })),
      cliente,
      tiposProducto,
    },
    e.modo === 'emitir' ? 'emitir' : 'guardar',
  );
  const tipoMencion = r.tipoOperacionEfectivo ?? s.tipoOperacion;
  return {
    empresaEspanola: true,
    sugerencia: { tipoOperacion: s.tipoOperacion, avisos: s.avisos.map(avisoFiscal) },
    mencion: mencionFiscal(tipoMencion, { cliente, causaExencion: r.causaExencion, referenciaLegal: r.referenciaLegal }),
    avisosCliente: avisosDelCliente(cliente),
    ...(lineas.length > 0 || elegido ? { revision: { tipoOperacion: r.tipoOperacionEfectivo, errores: r.errores, avisos: r.avisos } } : {}),
  };
}
