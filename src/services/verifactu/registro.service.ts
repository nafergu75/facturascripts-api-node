/**
 * Registro de alta de VERI*FACTU en la MISMA transaccion que numera la factura
 * (spec verifactu, 3.1 y 3.2; RD 1007/2023, art. 9: el registro se genera de
 * forma simultanea o inmediatamente anterior a la expedicion).
 *
 * Lo llaman la emision directa de crear() (tambien la rectificativa emitida al
 * momento) y finalizar() de income-invoices.service, despues de asignarNumero y
 * de dejar los importes definitivos. Nunca asignarNumero, ni el lector, ni los
 * borradores, proformas, «pasar a factura» o duplicar.
 *
 * Reglas (leccion del 14-10-2026, Vercel con UNA conexion): dentro de la
 * transaccion todo va con `tx`, una consulta detras de otra; nunca el cliente
 * global ni Promise.all. Sin red ni descifrado dentro. Lo que se puede saber
 * antes (planRegistro: si hay registro y la fila de la cadena) va fuera.
 *
 * Orden de bloqueo: originales de la rectificativa -> serie -> cadena.
 */
import type { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../../config/database';
import { conflict, internalError } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { operacionEfectiva, type ClienteFiscal } from '../../domain/tipo-operacion.model';
import { perfilDesdeConfig } from '../perfilEmpresa.service';
import { exclusionDe, verifactuActivo } from './redSeguridad';
import * as cadena from './cadena';
import type { EntornoVerifactu } from './cadena';
import { construirAlta, validarAlta, type LineaAlta, type RectificadaAlta } from './alta';
import { fechaHoraHusoGenRegistro } from './formato';
import { cadenaAlta, huella } from './huella';
import { leerInstantanea, type Instantanea } from './instantanea';
import { numeroInstalacionDe, sistemaInformatico } from './sistema';
import type { DetalleDesglose, Encadenamiento, RegistroContenido } from './tipos';

/** Origenes de una factura que expide la app (el lector registra facturas de otro programa). */
export const ORIGENES_CON_REGISTRO: readonly string[] = ['pantalla', 'api', 'copia'];

/** Estado de VERI*FACTU en la empresa que decide si una emision lleva registro. */
export interface ConfigEntorno {
  estado: string;
  entorno: string;
  activaDesde: Date | null;
  motivoExclusion: string | null;
}

export interface DatosEntornoRegistro {
  espanola: boolean;
  /** AjustesFiscales.sii */
  sii: boolean;
  /** null: la empresa no tiene configuracion de VERI*FACTU. */
  config: ConfigEntorno | null;
  origen: string | null;
  /** Tipo de operacion efectivo de la factura. */
  tipoOperacion: string | null;
  estadoDocumento: string;
}

const ENTORNOS: readonly EntornoVerifactu[] = ['PRUEBAS', 'PRODUCCION'];

/**
 * Entorno en el que se registra una factura, o null si no lleva registro (puro):
 *  - nunca: empresa no espanola, excluida (SII o foral), factura que no expide
 *    la app (lector u origen desconocido), EMPRESA_EXTRANJERA o no FINAL;
 *  - estado PRUEBAS: siempre en el entorno de PRUEBAS (desde activaDesde si la hay);
 *  - estado ACTIVO y en vigor (verifactuActivo): en su entorno;
 *  - sin configuracion o DESACTIVADO: no.
 */
export function entornoDeRegistro(d: DatosEntornoRegistro, ahora: Date): EntornoVerifactu | null {
  if (!d.espanola) return null;
  if (exclusionDe({ sii: d.sii, config: d.config })) return null;
  if (!d.origen || !ORIGENES_CON_REGISTRO.includes(d.origen)) return null;
  if (d.tipoOperacion === 'EMPRESA_EXTRANJERA') return null;
  if (d.estadoDocumento !== 'FINAL') return null;
  const c = d.config;
  if (!c) return null;
  if (c.estado === 'PRUEBAS') return !c.activaDesde || c.activaDesde.getTime() <= ahora.getTime() ? 'PRUEBAS' : null;
  if (c.estado === 'ACTIVO' && verifactuActivo(c, ahora)) return (ENTORNOS as readonly string[]).includes(c.entorno) ? (c.entorno as EntornoVerifactu) : null;
  return null;
}

/**
 * Margen con el que planRegistro prepara una activacion programada que esta al
 * caer: entre el plan y el registro pasan la comprobacion, la espera a la serie
 * y a la cadena (maxWait de 10 s) y la propia transaccion.
 */
export const MARGEN_ACTIVACION_MS = 2 * 60_000;

/**
 * Antes de la transaccion de emision (con el cliente global): si la emision de
 * la app llevara registro, en que entorno, y deja creada la fila de la cadena.
 * null: no hay registro. Dentro de la transaccion se vuelve a decidir con la
 * factura (generarRegistroAlta), que es lo que manda.
 *
 * Si la activacion programada (activaDesde) cae dentro de MARGEN_ACTIVACION_MS,
 * deja creada tambien la fila de ese entorno y responde como si ya estuviera
 * activa: asi la emision que coincide con la activacion (la primera factura del
 * 1-1-2027) encuentra su cadena y no da 409 VERIFACTU_CONFIG_CAMBIADA.
 */
export async function planRegistro(companyId: string, ahora: Date = new Date()): Promise<{ entorno: EntornoVerifactu } | null> {
  const legal = await prisma.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true } });
  const ajustes = await prisma.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true } });
  const config = await prisma.verifactuConfig.findUnique({
    where: { companyId },
    select: { estado: true, entorno: true, activaDesde: true, motivoExclusion: true },
  });
  const datos: DatosEntornoRegistro = {
    espanola: perfilDesdeConfig(legal).espanola,
    sii: ajustes?.sii === true,
    config,
    origen: 'pantalla',
    tipoOperacion: null,
    estadoDocumento: 'FINAL',
  };
  const ahoraMismo = entornoDeRegistro(datos, ahora);
  const enSeguida = entornoDeRegistro(datos, new Date(ahora.getTime() + MARGEN_ACTIVACION_MS));
  if (ahoraMismo) await cadena.asegurarCadena(prisma, companyId, ahoraMismo);
  if (enSeguida && enSeguida !== ahoraMismo) await cadena.asegurarCadena(prisma, companyId, enSeguida);
  const entorno = ahoraMismo ?? enSeguida;
  return entorno ? { entorno } : null;
}

const recortar = (t: string, n: number) => Array.from(t).slice(0, n).join('');

/** Desglose guardado en el contenido de un registro (para la ImporteRectificacion de una sustitucion). */
function desgloseDeContenido(contenido: unknown): DetalleDesglose[] | null {
  const d = (contenido as { desglose?: unknown } | null)?.desglose;
  return Array.isArray(d) ? (d as DetalleDesglose[]) : null;
}

const lineasAlta = (ls: Array<{ descripcion: string; baseLine: number; ivaImporte: number; tipoIva: number }>): LineaAlta[] =>
  ls.map((l) => ({ descripcion: l.descripcion, baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte), tipoIva: Number(l.tipoIva) }));

/** Lo que rectifica la factura, de sus enlaces (o, sin enlaces, de los campos de antes). Una consulta. */
async function rectificadasDe(
  tx: TransaccionBD,
  companyId: string,
  f: {
    esRectificativa: boolean;
    facturaOriginalId: string | null;
    rectificaFueraNumero: string | null;
    rectificaFueraFecha: string | null;
    enlacesRectifica: Array<{
      originalId: string | null;
      numeroOriginal: string | null;
      fechaOriginal: string | null;
      periodoDesde: string | null;
      periodoHasta: string | null;
    }>;
  },
): Promise<RectificadaAlta[]> {
  if (!f.esRectificativa) return [];
  const enlaces = f.enlacesRectifica.length
    ? f.enlacesRectifica
    : f.facturaOriginalId
      ? [{ originalId: f.facturaOriginalId, numeroOriginal: null, fechaOriginal: null, periodoDesde: null, periodoHasta: null }]
      : f.rectificaFueraNumero
        ? [{ originalId: null, numeroOriginal: f.rectificaFueraNumero, fechaOriginal: f.rectificaFueraFecha, periodoDesde: null, periodoHasta: null }]
        : [];
  const ids = [...new Set(enlaces.map((e) => e.originalId).filter((x): x is string => !!x))];
  const originales = ids.length
    ? await tx.incomeInvoice.findMany({
        where: { id: { in: ids }, companyId },
        include: {
          lineas: true,
          customer: { select: { pais: true, nifCif: true, cp: true } },
          verifactuRegistros: { where: { tipo: 'ALTA' }, orderBy: { numeroEnCadena: 'desc' }, take: 1, select: { contenido: true } },
        },
      })
    : [];
  return enlaces.map((e): RectificadaAlta => {
    if (e.originalId) {
      const o = originales.find((x) => x.id === e.originalId);
      if (!o) throw internalError('La factura que se rectifica no está en la base de datos: no se ha emitido.', { codigo: 'VERIFACTU_ORIGINAL_NO_ENCONTRADA' });
      return {
        tipo: 'APP',
        numeroCompleto: o.numeroCompleto,
        fechaEmision: o.fechaEmision,
        fechaOperacion: o.fechaOperacion,
        tipoOperacion: operacionEfectiva(o, o.customer),
        lineas: lineasAlta(o.lineas),
        desgloseRegistro: desgloseDeContenido(o.verifactuRegistros[0]?.contenido ?? null),
      };
    }
    if (e.periodoDesde) return { tipo: 'PERIODO', periodoHasta: e.periodoHasta };
    return { tipo: 'FUERA', numero: e.numeroOriginal, fecha: e.fechaOriginal };
  });
}

export interface OpcionesRegistroAlta {
  companyId: string;
  facturaId: string;
  /** La instantanea de la emision (la misma que se guarda en la factura). */
  instantanea: Instantanea | null;
  /**
   * Reloj fijo para los tests. Sin el, la decision de si hay registro se toma
   * al empezar y el instante del registro (FechaHoraHusoGenRegistro y el «hoy»
   * de validarAlta), despues de conseguir la cadena.
   */
  ahora?: Date;
  usuarioId?: string | null;
}

/**
 * Genera el registro de alta encadenado de una factura recien numerada, dentro
 * de su transaccion. Devuelve el registro, o null si la factura no lleva
 * registro (VERI*FACTU desactivado, lector, empresa extranjera...).
 *
 * Un 422 (validarAlta) o cualquier otro error deshace la transaccion entera:
 * ni numero gastado, ni registro, ni cabeza de la cadena movida.
 */
export async function generarRegistroAlta(tx: TransaccionBD, o: OpcionesRegistroAlta) {
  // Si hay registro y en que entorno se decide antes de bloquear (la fila de la cadena es por entorno).
  const decision = o.ahora ?? new Date();
  const { companyId, facturaId } = o;
  // Sin VERI*FACTU en pruebas ni activo (lo normal hasta activarlo), una sola consulta.
  const config = await tx.verifactuConfig.findUnique({ where: { companyId } });
  if (!config || (config.estado !== 'PRUEBAS' && config.estado !== 'ACTIVO')) return null;
  const f = await tx.incomeInvoice.findFirst({
    where: { id: facturaId, companyId },
    include: { lineas: true, customer: true, enlacesRectifica: { orderBy: { createdAt: 'asc' } } },
  });
  if (!f) throw internalError('La factura emitida no está en la base de datos.', { codigo: 'VERIFACTU_FACTURA_NO_ENCONTRADA' });
  const legal = await tx.legalConfig.findUnique({ where: { companyId } });
  const ajustes = await tx.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true, criterioCaja: true } });

  const inst = o.instantanea ?? leerInstantanea(f.instantaneaEmision);
  const clienteFiscal: ClienteFiscal = inst
    ? { pais: inst.cliente.pais, nifCif: inst.cliente.nifCif, cp: inst.cliente.cp }
    : { pais: f.customer.pais, nifCif: f.customer.nifCif, cp: f.customer.cp };
  const tipoOperacion = operacionEfectiva(f, clienteFiscal);
  const entorno = entornoDeRegistro(
    {
      espanola: perfilDesdeConfig(legal).espanola,
      sii: ajustes?.sii === true,
      config,
      origen: f.origen,
      tipoOperacion,
      estadoDocumento: f.estadoDocumento,
    },
    decision,
  );
  if (!entorno || !config) return null;
  if (!f.numeroCompleto) throw internalError('La factura emitida no tiene número.', { codigo: 'VERIFACTU_SIN_NUMERO' });

  // NIF del obligado: el congelado; si aun no lo esta, el de los datos de la empresa.
  const nifLegal = normalizarNif(legal?.nif ?? '');
  if (config.nifObligado && config.nifObligado !== nifLegal) {
    throw conflict(
      `El NIF de la empresa (${nifLegal || 'vacío'}) no es el que se dio de alta en VERI*FACTU (${config.nifObligado}). La cadena de registros es de ese NIF: vuelve a poner el NIF o habla con el administrador.`,
      { codigo: 'VERIFACTU_NIF_CAMBIADO', code: 'VERIFACTU_NIF_CAMBIADO' },
    );
  }
  const nifObligado = config.nifObligado ?? nifLegal;
  const multiplesOT = (await tx.company.count()) > 1;
  const rectificadas = await rectificadasDe(tx, companyId, f);

  // Cabeza de la cadena, bloqueada hasta el commit (despues de la serie).
  const cabeza = await cadena.bloquearCadena(tx, companyId, entorno);
  if (!cabeza) {
    throw conflict('La configuración de VERI*FACTU ha cambiado mientras se emitía la factura: vuelve a emitirla.', {
      codigo: 'VERIFACTU_CONFIG_CAMBIADA',
      code: 'VERIFACTU_CONFIG_CAMBIADA',
    });
  }
  // Instante del registro: con la cadena ya bloqueada (spec 3.2, paso 6). La espera a
  // la serie y a la cadena puede ser de segundos y cruzar la medianoche.
  const ahora = o.ahora ?? new Date();

  const alta = construirAlta({
    facturaId: f.id,
    tipoFactura: f.tipoFactura,
    tipoRectificativa: f.tipoRectificativa,
    numeroCompleto: f.numeroCompleto,
    fechaEmision: f.fechaEmision,
    fechaOperacion: f.fechaOperacion,
    tipoOperacion,
    causaExencion: f.causaExencion,
    descripcionOperacion: f.descripcionOperacion,
    motivoRectificacion: f.motivoRectificacion,
    baseTotal: Number(f.baseTotal),
    ivaTotal: Number(f.ivaTotal),
    lineas: lineasAlta(f.lineas),
    emisor: { nombre: inst?.emisor.denominacion ?? legal?.denominacion ?? '' },
    cliente: { nombre: inst?.cliente.nombreFiscal ?? f.customer.nombreFiscal, ...clienteFiscal },
    nifObligado,
    criterioCaja: ajustes?.criterioCaja === true,
    rectificadas,
  });
  validarAlta(alta, { nifObligado, ahora });

  // Se congelan con el primer registro el NIF, el nombre y el numero de instalacion (si la activacion no lo hizo).
  const numeroInstalacion = config.numeroInstalacion ?? numeroInstalacionDe(companyId, ahora);
  if (!config.nifObligado || !config.nombreObligado || !config.numeroInstalacion) {
    await tx.verifactuConfig.update({
      where: { companyId },
      data: {
        ...(config.nifObligado ? {} : { nifObligado }),
        ...(config.nombreObligado ? {} : { nombreObligado: recortar(alta.cuerpo.nombreEmisor, 120) }),
        ...(config.numeroInstalacion ? {} : { numeroInstalacion }),
      },
    });
  }

  // Encadenamiento con el ultimo registro (alta o anulacion), leido de la fila bloqueada.
  let encadenamiento: Encadenamiento;
  if (cabeza.ultimoRegistroId) {
    if (!cabeza.ultimaHuella || !cabeza.ultimoIdEmisor || !cabeza.ultimoNumSerie || !cabeza.ultimaFechaExpedicion) {
      throw internalError('La cabeza de la cadena de VERI*FACTU está incompleta: no se ha emitido. Avisa al administrador.', { codigo: 'VERIFACTU_CADENA_INCOMPLETA' });
    }
    encadenamiento = {
      registroAnterior: { idEmisor: cabeza.ultimoIdEmisor, numSerie: cabeza.ultimoNumSerie, fecha: cabeza.ultimaFechaExpedicion, huella: cabeza.ultimaHuella },
    };
  } else {
    if (cabeza.numRegistros !== 0 || cabeza.ultimaHuella) {
      throw internalError('La cabeza de la cadena de VERI*FACTU está incompleta: no se ha emitido. Avisa al administrador.', { codigo: 'VERIFACTU_CADENA_INCOMPLETA' });
    }
    encadenamiento = { primerRegistro: true };
  }

  const fechaHoraHuso = fechaHoraHusoGenRegistro(ahora, cabeza.ultimaFechaHoraHuso);
  const huellaAnterior = cabeza.ultimaHuella ?? '';
  const h = huella(
    cadenaAlta({
      idEmisor: alta.idEmisor,
      numSerie: alta.numSerie,
      fecha: alta.fechaExpedicion,
      tipoFactura: alta.tipoFactura,
      cuotaTotal: alta.cuotaTotal,
      importeTotal: alta.importeTotal,
      huellaAnterior,
      fechaHoraHuso,
    }),
  );
  const contenido: RegistroContenido = {
    version: 1,
    idVersion: '1.0',
    tipoHuella: '01',
    ...alta.cuerpo,
    encadenamiento,
    sistemaInformatico: sistemaInformatico({ numeroInstalacion, multiplesOT }),
  };
  const numeroEnCadena = cabeza.numRegistros + 1;
  const registro = await tx.verifactuRegistro.create({
    data: {
      companyId,
      entorno,
      incomeInvoiceId: f.id,
      numeroEnCadena,
      registroAnteriorId: cabeza.ultimoRegistroId,
      tipo: 'ALTA',
      idEmisor: alta.idEmisor,
      numSerie: alta.numSerie,
      fechaExpedicion: alta.fechaExpedicion,
      tipoFactura: alta.tipoFactura,
      cuotaTotal: alta.cuotaTotal,
      importeTotal: alta.importeTotal,
      fechaHoraHuso,
      huellaAnterior: cabeza.ultimaHuella,
      huella: h,
      contenido: contenido as unknown as Prisma.InputJsonValue,
      xml: null,
      generadoPor: o.usuarioId ?? null,
    },
  });
  await cadena.avanzarCadena(tx, cabeza.id, {
    id: registro.id,
    numeroEnCadena,
    idEmisor: alta.idEmisor,
    numSerie: alta.numSerie,
    fechaExpedicion: alta.fechaExpedicion,
    fechaHoraHuso,
    huella: h,
  });
  await tx.incomeInvoice.update({ where: { id: f.id }, data: { verifactuEstado: 'PENDIENTE' } });
  return registro;
}
