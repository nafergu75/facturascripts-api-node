/**
 * Orquestador de las lecturas de facturas (lector de gastos y de ventas).
 *
 * Flujo en dos fases, para no dejar una funcion de Vercel esperando a Azure:
 *  1. POST /lecturas: guarda el archivo en Blob (privado), crea la lectura y
 *     manda el documento a Azure (202, la pantalla consulta). Sin Azure, lee
 *     con Claude en el momento (200).
 *  2. GET /lecturas/:id: como mucho UNA consulta a Azure por peticion, cuando
 *     toca (Retry-After o 2-5-13 s) y con bloqueo optimista para que dos
 *     pestanas no paguen dos veces. Al terminar: QR, complemento con Claude si
 *     hace falta, validaciones y LISTA. A los 45 s, o si Azure falla, Claude
 *     con vision lee el archivo de Blob.
 *
 * Nunca se guarda la respuesta bruta de Azure ni la de Claude: solo la lectura
 * normalizada y el estado de cada campo. Al log van ids, codigos y tiempos.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { leerAzure, modoLector } from '../../config/azure';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { badRequest, conflict, HttpError, notFound } from '../../utils/http-errors';
import { nombreSeguro } from '../../utils/nombre-seguro';
import { deleteObject, getObject, putObject } from '../../utils/storage';
import { MENSAJE_LECTOR_SIN_IA, type GastoExtraidoEmpresa } from '../gastos-extractor.service';
import { aIngresoExtraido, type IngresoExtraido } from '../ingresos-extractor.service';
import { cuentaHabitualDeProveedor } from '../cuentasLinea.service';
import { perfilEmpresa } from '../perfilEmpresa.service';
import { aGastoExtraido, aInvoiceExtraction, tramosGasto, type TramoGasto } from './adaptadores';
import { azurePausado } from './azure-di.client';
import { completarTotalAPagar, confianzaLectura, contarPaginasPdf } from './azure-factura.mapper';
import { azureExtractor } from './azure.extractor';
import { completarConClaude, decidirComplemento } from './claude-complemento';
import { direccionParaFicha } from './direccion';
import { claudeConfigurado, claudeVisionExtractor } from './claude-vision.adapter';
import { MENSAJE_LECTURA_NO_ENCONTRADA } from './confirmar';
import { contextoValidacion, gastoDuplicado, proveedorPorNif } from './contexto';
import { datosTerceroDeLectura, eleccionGuardada, infoTercero, type EleccionOrigenTercero, type InfoTercero } from './origen-tercero';
import { clientePorNif, type TerceroExistente } from './terceros-lector';
import { rectificativaLeida, type RectificativaLeida } from './rectificativa';
import { rectificativaVentaLeida, type RectificativaVentaLeida } from './rectificativa-venta';
import type {
  ArchivoLectura,
  CampoId,
  ContextoLectura,
  EstadoCampo,
  Lector,
  LecturaHecha,
  LecturaNormalizada,
  MotivoRespaldo,
  NivelValidacion,
  OrigenLectura,
  ResultadoQr,
  ResultadoValidacion,
} from './tipos';
import { validarLectura, type ResultadoValidacionLectura } from './validaciones';
import { compararQr, textoQr } from './verifactu-qr';

/** El cuerpo de una funcion de Vercel no pasa de 4,5 MB; el plan F0 de Azure, 4 MB. */
export const MAX_ARCHIVO_LECTURA = 4 * 1024 * 1024;
export const MENSAJE_ARCHIVO_GRANDE = 'El archivo pesa más de 4 MB: redúcelo o hazle una foto con menos resolución.';
const MIME_ADMITIDOS = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

/** Desde el POST a Azure: pasado este plazo, se lee con Claude. */
export const PLAZO_AZURE_MS = 45_000;
/**
 * Reserva de la lectura mientras una peticion consulta a Azure (y quiza a
 * Claude). Tiene que pasar de lo que puede tardar esa peticion (GET a Azure
 * mas Claude con vision); si no, otra pestana la reclamaria y pagaria otra vez.
 */
export const RESERVA_MS = 90_000;
const DIA_MS = 24 * 60 * 60 * 1000;

export const MENSAJE_NO_LEIDA = 'No se ha podido leer la factura ahora mismo. Prueba dentro de unos minutos o regístrala a mano.';
export const MENSAJE_ARCHIVO_NO_VALIDO =
  'No se ha podido leer el archivo: puede estar dañado, protegido con contraseña o en un formato que no se admite. Prueba con otro PDF o con una foto.';

type FilaLectura = NonNullable<Awaited<ReturnType<typeof prisma.lecturaDocumento.findFirst>>>;

export interface ArchivoEntrada {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export interface InfoLectura {
  lecturaId: string;
  origen: OrigenLectura;
  textoOrigen: string;
  respaldo: { motivo: string; texto: string | null } | null;
  confianza: number | null;
  estado: NivelValidacion;
  requiereRevision: boolean;
  campos: Partial<Record<CampoId, EstadoCampo>>;
  /**
   * completados: datos tomados del QR sin cotejar (con alguno, no es un QR "verificado").
   * pruebas: QR del entorno de pruebas de la AEAT (llega como NO_COINCIDE sin diferencias).
   */
  qr: {
    estado: ResultadoQr['estado'];
    verifactu: boolean | null;
    texto: string;
    diferencias: ResultadoQr['diferencias'];
    completados: NonNullable<ResultadoQr['completados']>;
    pruebas: boolean;
  };
  /** Lo que hay que revisar y no va ligado a un dato (archivo repetido, QR ilegible o de pruebas). Tambien va en avisos. */
  generales: Array<{ nivel: NivelValidacion; mensaje: string }>;
  avisos: string[];
  paginas: { archivo: number | null; leidas: number | null };
  /**
   * El tercero (el cliente en ventas, el proveedor en gastos): de donde ha
   * dicho la persona que es, de donde parece por la factura, si se contradicen
   * y como se llama su numero fiscal (NIF, NIF-IVA (VAT), RNC...).
   */
  tercero: InfoTercero;
}

export interface LecturaGastoLista {
  lecturaId: string;
  estado: 'LISTA';
  /** tramos: uno por tipo de IVA (base y cuota), para poner una linea por tipo. */
  /** rectificativa: si es una rectificativa o un abono, la original propuesta, el tipo y la causa (null si no lo es). */
  gasto: GastoExtraidoEmpresa & { tramos: TramoGasto[]; rectificativa: RectificativaLeida | null };
  lectura: InfoLectura;
}
export interface LecturaIngresoLista {
  lecturaId: string;
  estado: 'LISTA';
  /** clienteExistente: el cliente dado de alta con ese NIF, o null (hay que darlo de alta o elegir uno). */
  /** rectificativa: si es una rectificativa o un abono de venta, la factura que rectifica propuesta, el motivo y si hay que decir el signo (null si no lo es). */
  ingreso: IngresoExtraido & { clienteExistente: TerceroExistente | null; rectificativa: RectificativaVentaLeida | null };
  lectura: InfoLectura;
}
export type RespuestaLectura =
  | { lecturaId: string; estado: 'LEYENDO'; reintentarEnMs: number; segundos: number }
  | LecturaGastoLista
  | LecturaIngresoLista
  | { lecturaId: string; estado: 'ERROR'; codigo: string; mensaje: string }
  | { lecturaId: string; estado: 'CONFIRMADA' | 'DESCARTADA' };

/**
 * Lo que se guarda en LecturaDocumento.resultado. origenTercero: de donde ha
 * dicho la persona que es el tercero; se guarda ya al subir la factura (solo
 * con eso, mientras se lee) y se conserva al terminar y al cambiarlo.
 */
interface ResultadoGuardado {
  lectura: LecturaNormalizada;
  campos: Partial<Record<CampoId, EstadoCampo>>;
  origenTercero?: EleccionOrigenTercero | null;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const TEXTO_ORIGEN: Record<OrigenLectura, string> = {
  AZURE: 'Leída con Azure',
  AZURE_CLAUDE: 'Leída con Azure y completada con IA',
  CLAUDE: 'Leída con IA (Claude)',
  FACTURAE: 'Leída del XML Facturae',
  MANUAL: 'Sin leer: se rellena a mano',
};

/** Texto para el usuario segun el motivo del respaldo (null: no hay que decir nada). */
export function textoRespaldo(motivo: string): string | null {
  if (['AZURE_NO_CONFIGURADO', 'OCR_LECTOR_CLAUDE', 'AZURE_FORMATO'].includes(motivo)) return null;
  if (motivo === 'AZURE_CUOTA') return 'Azure ha llegado a su límite de este mes; la factura se ha leído con IA.';
  if (['AZURE_CLAVE', 'AZURE_PETICION', 'AZURE_RESPUESTA_RARA'].includes(motivo)) return 'Azure no está disponible; la factura se ha leído con IA.';
  return 'Azure no ha respondido a tiempo; la factura se ha leído con IA.';
}

/** Sin Azure ni Claude, en el lector de ventas (el de gastos manda a Compras). */
export const MENSAJE_LECTOR_SIN_IA_VENTAS = 'La lectura con IA no está activada en esta instalación. Crea la factura con Ventas → Nueva factura.';
const ALTERNATIVA_SIN_IA: Record<Lector, string> = { GASTO: '/dashboard/compras/nueva', VENTA: '/dashboard/facturas/nueva' };

function mensajeError(codigo: string | null, lector: string): string {
  if (codigo === 'LECTOR_SIN_IA') return lector === 'VENTA' ? MENSAJE_LECTOR_SIN_IA_VENTAS : MENSAJE_LECTOR_SIN_IA;
  if (codigo === 'ARCHIVO_NO_VALIDO') return MENSAJE_ARCHIVO_NO_VALIDO;
  return MENSAJE_NO_LEIDA;
}

/** Espera hasta la siguiente consulta: 2 s las tres primeras, luego 5 s y despues 13 s. */
export function esperaPorConsulta(consultas: number): number {
  if (consultas <= 3) return 2000;
  if (consultas === 4) return 5000;
  return 13_000;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const json = (v: unknown) => v as Prisma.InputJsonValue;
const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function contextoLectura(fila: FilaLectura, perfil: { espanola: boolean; monedaCuenta: string }): ContextoLectura {
  return { companyId: fila.companyId, lector: fila.lector as Lector, empresaEspanola: perfil.espanola, monedaCuenta: perfil.monedaCuenta, paginasArchivo: fila.paginasArchivo };
}

async function cargarArchivo(fila: FilaLectura): Promise<ArchivoLectura> {
  if (!fila.archivoRef) throw new Error('La lectura no tiene archivo');
  return { buffer: await getObject(fila.archivoRef), nombre: fila.archivoNombre, mime: fila.archivoTipo, hash: fila.archivoHash };
}

/** Borra el original de Blob sin romper: un fallo solo deja un aviso (sin el nombre del archivo). */
async function borrarArchivo(lecturaId: string, ref: string): Promise<void> {
  await deleteObject(ref).catch((err) => logger.warn('[lectura] No se ha podido borrar el archivo de la lectura', { lecturaId, error: (err as { name?: string })?.name ?? 'Error' }));
}

/** El documento del lector de ventas de una lectura que no se registra: REJECTED y sin los datos leidos. */
async function rechazarDocumentoVenta(incomeReaderDocumentId: string, motivo: string): Promise<void> {
  await prisma.incomeReaderDocument.updateMany({
    where: { id: incomeReaderDocumentId, status: 'READY_FOR_VERIFICATION' },
    data: { status: 'REJECTED', rejectionReason: motivo, parsedData: Prisma.DbNull, storagePath: '' },
  });
}

function limpiarAzure(resultId: string | null): void {
  if (!resultId || !azureExtractor.limpiar) return;
  // Sin esperar: un fallo solo deja un aviso.
  void azureExtractor.limpiar({ resultId }).catch(() => undefined);
}

/** La lectura no se ha podido hacer. El original ya no sirve (una lectura en ERROR no se reintenta): se borra. */
async function terminarConError(fila: FilaLectura, codigo: string): Promise<RespuestaLectura> {
  const r = await prisma.lecturaDocumento.updateMany({ where: { id: fila.id, estado: 'LEYENDO' }, data: { estado: 'ERROR', errorCodigo: codigo, terminadaEn: new Date(), archivoRef: null } });
  logger.warn('[lectura] Lectura sin terminar', { lecturaId: fila.id, companyId: fila.companyId, lector: fila.lector, codigo });
  if (r.count > 0 && fila.archivoRef) await borrarArchivo(fila.id, fila.archivoRef);
  return { lecturaId: fila.id, estado: 'ERROR', codigo, mensaje: mensajeError(codigo, fila.lector) };
}

/** Guarda la lectura validada (LISTA). En ventas crea, en la misma transaccion, el documento del lector de siempre. */
async function guardarLista(
  fila: FilaLectura,
  l: LecturaNormalizada,
  val: ResultadoValidacionLectura,
  extra: { origen: OrigenLectura; motivoRespaldo: string | null; confianza: number | null },
): Promise<void> {
  const datos = {
    estado: 'LISTA',
    origen: extra.origen,
    motivoRespaldo: extra.motivoRespaldo,
    confianza: extra.confianza,
    estadoValidacion: val.estado,
    qrEstado: l.qr?.estado ?? null,
    resultado: json({ lectura: l, campos: val.campos, origenTercero: eleccionGuardada(fila.resultado) } satisfies ResultadoGuardado),
    validaciones: json(val.validaciones),
    avisos: json(l.avisos),
    paginasLeidas: l.paginas.leidas,
    terminadaEn: new Date(),
  };
  await prisma.$transaction(async (tx) => {
    const r = await tx.lecturaDocumento.updateMany({ where: { id: fila.id, estado: 'LEYENDO' }, data: datos });
    if (r.count === 0 || fila.lector !== 'VENTA') return;
    const ahora = new Date();
    const doc = await tx.incomeReaderDocument.create({
      data: {
        companyId: fila.companyId,
        userId: fila.userId,
        sourceType: 'EXTRACTOR_IA',
        originalFileName: fila.archivoNombre,
        mimeType: fila.archivoTipo,
        fileSize: fila.archivoTamanio,
        storagePath: fila.archivoRef ?? '',
        status: 'READY_FOR_VERIFICATION',
        uploadedAt: fila.iniciadaEn,
        processingStartedAt: fila.iniciadaEn,
        processingCompletedAt: ahora,
        parsedData: json(aInvoiceExtraction(l, val.validaciones, { confianza: extra.confianza, nombreArchivo: fila.archivoNombre, mime: fila.archivoTipo })),
      },
    });
    await tx.lecturaDocumento.update({ where: { id: fila.id }, data: { incomeReaderDocumentId: doc.id } });
  });
  logger.info('[lectura] Lectura lista', {
    lecturaId: fila.id,
    companyId: fila.companyId,
    lector: fila.lector,
    origen: extra.origen,
    motivoRespaldo: extra.motivoRespaldo,
    segundos: Math.round((Date.now() - fila.iniciadaEn.getTime()) / 1000),
    consultas: fila.azureConsultas,
  });
}

async function validar(fila: FilaLectura, l: LecturaNormalizada, eleccion = eleccionGuardada(fila.resultado)): Promise<ResultadoValidacionLectura> {
  const ctx = await contextoValidacion(fila.companyId, fila.lector as Lector, l, { archivoHash: fila.archivoHash, lecturaId: fila.id, origenTercero: eleccion });
  return validarLectura(l, ctx);
}

/** Respaldo: Claude con vision sobre el archivo (de memoria o de Blob). */
async function respaldoConClaude(fila: FilaLectura, motivo: MotivoRespaldo, archivo?: ArchivoLectura): Promise<RespuestaLectura> {
  if (!claudeConfigurado()) return terminarConError(fila, 'LECTOR_SIN_IA');
  let a = archivo;
  if (!a) {
    try {
      a = await cargarArchivo(fila);
    } catch {
      return terminarConError(fila, 'NO_LEGIBLE');
    }
  }
  const r = await claudeVisionExtractor(fila.lector as Lector).iniciar(a, contextoLectura(fila, await perfilEmpresa(fila.companyId)));
  if (r.tipo !== 'hecho') return terminarConError(fila, motivo === 'AZURE_ARCHIVO' ? 'ARCHIVO_NO_VALIDO' : r.tipo === 'fallo' ? r.codigo : 'NO_LEGIBLE');
  const l: LecturaNormalizada = { ...r.lectura, paginas: { archivo: fila.paginasArchivo, leidas: null } };
  const val = await validar(fila, l);
  await guardarLista(fila, l, val, { origen: 'CLAUDE', motivoRespaldo: motivo, confianza: r.confianzaLector ?? null });
  return respuestaDe(await recargar(fila.id));
}

/** Azure ha terminado: QR, complemento con Claude si hace falta, validaciones y LISTA. */
async function terminarConAzure(fila: FilaLectura, hecho: LecturaHecha): Promise<RespuestaLectura> {
  const lector = fila.lector as Lector;
  // El QR primero: un dato que confirma no hace falta preguntarlo a Claude.
  let l = compararQr(hecho.qr ?? null, hecho.lectura);
  const preguntas = decidirComplemento(l, hecho.texto, lector);
  let origen: OrigenLectura = 'AZURE';
  if (preguntas.length) {
    const ctxPrevio = await contextoValidacion(fila.companyId, lector, l, { archivoHash: fila.archivoHash, lecturaId: fila.id, origenTercero: eleccionGuardada(fila.resultado) });
    const c = await completarConClaude(l, hecho.texto, preguntas, ctxPrevio);
    if (c.tipo === 'sin_texto') return respaldoConClaude(fila, 'AZURE_SIN_FACTURA');
    l = c.lectura;
    if (c.tipo === 'completada') origen = 'AZURE_CLAUDE';
  }
  // Y otra vez al final, por si Claude ha cambiado algun dato. Lo sacado del QR en la
  // primera sigue contando como sacado del QR (compararQr no lo da por cotejado).
  l = compararQr(hecho.qr ?? null, l);
  // Sin total a pagar leido: el total de la factura (menos la retencion, si la lleva).
  completarTotalAPagar(l, lector);
  const val = await validar(fila, l);
  await guardarLista(fila, l, val, { origen, motivoRespaldo: null, confianza: confianzaLectura(l, lector) });
  return respuestaDe(await recargar(fila.id));
}

async function recargar(id: string): Promise<FilaLectura> {
  return prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

function infoLectura(fila: FilaLectura, guardado: ResultadoGuardado, validaciones: ResultadoValidacion[], tercero: InfoTercero): InfoLectura {
  const l = guardado.lectura;
  const generales = validaciones.filter((v) => v.campos.length === 0 && v.nivel !== 'ok').map((v) => ({ nivel: v.nivel, mensaje: v.mensaje }));
  const avisos = Array.isArray(fila.avisos) ? (fila.avisos as string[]) : [];
  const estado = (fila.estadoValidacion ?? 'revisar') as NivelValidacion;
  const origen = (fila.origen ?? 'CLAUDE') as OrigenLectura;
  return {
    lecturaId: fila.id,
    origen,
    textoOrigen: TEXTO_ORIGEN[origen],
    respaldo: fila.motivoRespaldo ? { motivo: fila.motivoRespaldo, texto: textoRespaldo(fila.motivoRespaldo) } : null,
    confianza: fila.confianza,
    estado,
    requiereRevision: estado !== 'ok',
    campos: guardado.campos,
    qr: {
      estado: l.qr?.estado ?? 'SIN_QR',
      verifactu: l.qr?.verifactu ?? null,
      texto: textoQr(l.qr),
      diferencias: l.qr?.diferencias ?? [],
      completados: l.qr?.completados ?? [],
      pruebas: l.qr?.pruebas === true,
    },
    generales,
    // Los generales tambien como avisos: sin ellos la pantalla pedia "He revisado" sin decir que.
    avisos: sinRepetidos([...generales.map((g) => g.mensaje), ...avisos]),
    paginas: { archivo: fila.paginasArchivo, leidas: fila.paginasLeidas },
    tercero,
  };
}

/** Quita los avisos repetidos (con o sin tildes). */
function sinRepetidos(textos: string[]): string[] {
  const vistos = new Set<string>();
  return textos.filter((t) => {
    const k = sinAcentos(t);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

async function respuestaDe(fila: FilaLectura): Promise<RespuestaLectura> {
  if (fila.estado === 'CONFIRMADA' || fila.estado === 'DESCARTADA') return { lecturaId: fila.id, estado: fila.estado };
  if (fila.estado === 'ERROR') return { lecturaId: fila.id, estado: 'ERROR', codigo: fila.errorCodigo ?? 'NO_LEGIBLE', mensaje: mensajeError(fila.errorCodigo, fila.lector) };
  if (fila.estado !== 'LISTA' || !fila.resultado) {
    const segundos = Math.round((Date.now() - fila.iniciadaEn.getTime()) / 1000);
    const falta = fila.azureProximaConsulta ? fila.azureProximaConsulta.getTime() - Date.now() : 2000;
    // Mas de 13 s es la reserva de otra peticion que esta terminando: se vuelve a mirar pronto.
    return { lecturaId: fila.id, estado: 'LEYENDO', reintentarEnMs: falta > 13_000 ? 2000 : Math.max(falta, 1000), segundos };
  }
  const guardado = fila.resultado as unknown as ResultadoGuardado;
  const validaciones = (fila.validaciones ?? []) as unknown as ResultadoValidacion[];
  const lector = fila.lector as Lector;
  const eleccion = eleccionGuardada(guardado);
  const tercero = (paisFicha: string | null | undefined) =>
    infoTercero(lector, datosTerceroDeLectura(lector, guardado.lectura, { eleccion, paisFicha: paisFicha ?? null }));

  if (lector === 'GASTO') {
    const g = aGastoExtraido(guardado.lectura, validaciones, fila.confianza);
    const proveedorExistente = await proveedorPorNif(fila.companyId, g.nifProveedor);
    const duplicada = proveedorExistente ? await gastoDuplicado(fila.companyId, proveedorExistente.id, g.numeroFactura) : null;
    // La cuenta que suele llevar ese proveedor: la pantalla la propone en cada linea leida.
    const cuentaHabitual = proveedorExistente ? await cuentaHabitualDeProveedor(fila.companyId, proveedorExistente.id) : null;
    // Rectificativa o abono: la factura que rectifica y lo que se propone para el formulario.
    const rectificativa = await rectificativaLeida(fila.companyId, guardado.lectura);
    const lectura = infoLectura(fila, guardado, validaciones, tercero(proveedorExistente?.pais));
    return { lecturaId: fila.id, estado: 'LISTA', gasto: { ...g, tramos: tramosGasto(guardado.lectura), proveedorExistente, duplicada, cuentaHabitual, rectificativa }, lectura };
  }
  const extraccion = aInvoiceExtraction(guardado.lectura, validaciones, { confianza: fila.confianza, nombreArchivo: fila.archivoNombre, mime: fila.archivoTipo });
  // La direccion del cliente, separada, para darlo de alta con la ficha rellena. Que falte el NIF
  // del cliente ya lo dicen las validaciones (error si es de España, «revisar» si es de fuera).
  const ingreso = aIngresoExtraido(fila.incomeReaderDocumentId ?? '', extraccion, direccionParaFicha(guardado.lectura.receptor?.direccion), { nifYaValidado: true });
  const clienteExistente = await clientePorNif(fila.companyId, ingreso.nifCliente);
  // Rectificativa o abono de venta: la factura que rectifica y lo que se propone.
  const rectificativa = await rectificativaVentaLeida(fila.companyId, guardado.lectura);
  // Si la rectificativa va al cliente de la original propuesta, de donde es lo dice la ficha de ese
  // cliente, no la del cliente del NIF leido.
  const lectura = infoLectura(fila, guardado, validaciones, tercero(rectificativa?.clienteDeLaOriginal?.pais ?? clienteExistente?.pais));
  return { lecturaId: fila.id, estado: 'LISTA', ingreso: { ...ingreso, errores: sinRepetidos(ingreso.errores), clienteExistente, rectificativa }, lectura };
}

// ---------------------------------------------------------------------------
// Purga: al principio de cada POST (esa empresa, 50 como mucho) y en el cron
// diario que ya existe (/cron/carmen-purga: todas las empresas, 200 como mucho)
// ---------------------------------------------------------------------------

/**
 * - A los 7 dias, lo que no se registro (LEYENDO, LISTA, ERROR) pasa a
 *   DESCARTADA: sin resultado, sin archivo y, en ventas, sin los datos del
 *   documento del lector.
 * - A los 90 dias: de las CONFIRMADAS se vacia el resultado (lo demas queda
 *   como pista de auditoria); de las DESCARTADAS, tambien las validaciones y
 *   los avisos, que llevan valores leidos (NIF, importes).
 * Devuelve cuantas lecturas ha tocado.
 */
export async function purgarLecturas(companyId?: string, ahora: Date = new Date(), tope = companyId ? 50 : 200): Promise<number> {
  const hace7 = new Date(ahora.getTime() - 7 * DIA_MS);
  const hace90 = new Date(ahora.getTime() - 90 * DIA_MS);
  const deEmpresa = companyId ? { companyId } : {};

  const viejas = await prisma.lecturaDocumento.findMany({
    where: { ...deEmpresa, estado: { in: ['LEYENDO', 'LISTA', 'ERROR'] }, createdAt: { lt: hace7 } },
    select: { id: true, archivoRef: true, incomeReaderDocumentId: true },
    take: tope,
  });
  for (const v of viejas) {
    await prisma.lecturaDocumento.update({ where: { id: v.id }, data: { estado: 'DESCARTADA', resultado: Prisma.DbNull, archivoRef: null } });
    if (v.incomeReaderDocumentId) await rechazarDocumentoVenta(v.incomeReaderDocumentId, 'Lectura caducada');
    if (v.archivoRef) await borrarArchivo(v.id, v.archivoRef);
  }

  const confirmadas = await prisma.lecturaDocumento.findMany({
    where: { ...deEmpresa, estado: 'CONFIRMADA', confirmadaEn: { lt: hace90 }, resultado: { not: Prisma.DbNull } },
    select: { id: true },
    take: tope,
  });
  if (confirmadas.length) await prisma.lecturaDocumento.updateMany({ where: { id: { in: confirmadas.map((a) => a.id) } }, data: { resultado: Prisma.DbNull } });

  const descartadas = await prisma.lecturaDocumento.findMany({
    where: {
      ...deEmpresa,
      estado: 'DESCARTADA',
      updatedAt: { lt: hace90 },
      OR: [{ resultado: { not: Prisma.DbNull } }, { validaciones: { not: Prisma.DbNull } }, { avisos: { not: Prisma.DbNull } }],
    },
    select: { id: true },
    take: tope,
  });
  if (descartadas.length) {
    await prisma.lecturaDocumento.updateMany({
      where: { id: { in: descartadas.map((a) => a.id) } },
      data: { resultado: Prisma.DbNull, validaciones: Prisma.DbNull, avisos: Prisma.DbNull },
    });
  }
  return viejas.length + confirmadas.length + descartadas.length;
}

// ---------------------------------------------------------------------------
// API del servicio
// ---------------------------------------------------------------------------

function elegirLector(mime: string): MotivoRespaldo | null {
  if (modoLector() === 'claude') return 'OCR_LECTOR_CLAUDE';
  if (!leerAzure()) return 'AZURE_NO_CONFIGURADO';
  const pausa = azurePausado();
  if (pausa) return pausa;
  if (!azureExtractor.admite(mime)) return 'AZURE_FORMATO';
  return null;
}

/** POST /lecturas. 202 si Azure ha aceptado el documento; 200 si se ha leido en el momento. */
export async function iniciarLectura(
  companyId: string,
  userId: string | undefined,
  lector: Lector,
  entrada: ArchivoEntrada,
  eleccion: EleccionOrigenTercero | null = null,
): Promise<{ status: 200 | 202; data: RespuestaLectura }> {
  if (entrada.buffer.length > MAX_ARCHIVO_LECTURA) throw badRequest(MENSAJE_ARCHIVO_GRANDE, { codigo: 'ARCHIVO_GRANDE' });
  if (!MIME_ADMITIDOS.has(entrada.mimetype)) throw badRequest('Solo se admiten facturas en PDF o imagen (JPG, PNG, WEBP).', { codigo: 'ARCHIVO_NO_VALIDO' });

  try {
    await purgarLecturas(companyId);
  } catch (err) {
    logger.warn('[lectura] No se han podido purgar las lecturas antiguas', { companyId, error: (err as { name?: string })?.name ?? 'Error' });
  }

  const motivo = elegirLector(entrada.mimetype);
  if (motivo && !claudeConfigurado()) {
    throw new HttpError(503, mensajeError('LECTOR_SIN_IA', lector), { codigo: 'LECTOR_SIN_IA', alternativa: ALTERNATIVA_SIN_IA[lector] });
  }

  const archivo: ArchivoLectura = {
    buffer: entrada.buffer,
    nombre: entrada.originalname || 'factura',
    mime: entrada.mimetype,
    hash: createHash('sha256').update(entrada.buffer).digest('hex'),
  };
  const perfil = await perfilEmpresa(companyId);
  let fila = await prisma.lecturaDocumento.create({
    data: {
      companyId,
      userId: userId ?? null,
      lector,
      archivoNombre: archivo.nombre.slice(0, 255),
      archivoTipo: archivo.mime,
      archivoTamanio: archivo.buffer.length,
      archivoHash: archivo.hash,
      paginasArchivo: contarPaginasPdf(archivo.buffer),
      // De donde ha dicho la persona que es el tercero: se usa al validar en cuanto termine la lectura.
      ...(eleccion ? { resultado: json({ origenTercero: eleccion }) } : {}),
    },
  });
  const archivoRef = await putObject(`lecturas/${companyId}/${fila.id}-${nombreSeguro(archivo.nombre)}`, archivo.buffer, archivo.mime);
  fila = await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { archivoRef } });

  if (!motivo) {
    const r = await azureExtractor.iniciar(archivo, contextoLectura(fila, perfil));
    if (r.tipo === 'pendiente') {
      await prisma.lecturaDocumento.update({
        where: { id: fila.id },
        data: { azureResultId: r.ref.resultId, azureProximaConsulta: new Date(Date.now() + r.reintentarEnMs), iniciadaEn: new Date() },
      });
      return { status: 202, data: { lecturaId: fila.id, estado: 'LEYENDO', reintentarEnMs: r.reintentarEnMs, segundos: 0 } };
    }
    if (r.tipo === 'hecho') return { status: 200, data: await terminarConAzure(fila, r) };
    const data = await respaldoConClaude(fila, r.codigo, archivo);
    if (r.codigo === 'AZURE_ARCHIVO' && data.estado === 'ERROR') throw badRequest(MENSAJE_ARCHIVO_NO_VALIDO, { codigo: 'ARCHIVO_NO_VALIDO' });
    return { status: 200, data };
  }
  return { status: 200, data: await respaldoConClaude(fila, motivo, archivo) };
}

async function buscar(companyId: string, lector: Lector, id: string): Promise<FilaLectura> {
  const fila = await prisma.lecturaDocumento.findFirst({ where: { id, companyId, lector } });
  if (!fila) throw notFound(MENSAJE_LECTURA_NO_ENCONTRADA);
  return fila;
}

/** GET /lecturas/:id. Como mucho UNA consulta a Azure, y solo si ya toca. */
export async function consultarLectura(companyId: string, lector: Lector, id: string): Promise<RespuestaLectura> {
  const fila = await buscar(companyId, lector, id);
  if (fila.estado !== 'LEYENDO') return respuestaDe(fila);

  const ahora = Date.now();
  const transcurrido = ahora - fila.iniciadaEn.getTime();
  const fueraDePlazo = transcurrido > PLAZO_AZURE_MS;
  if (!fueraDePlazo && fila.azureProximaConsulta && fila.azureProximaConsulta.getTime() > ahora) return respuestaDe(fila);

  // Bloqueo optimista: si otra peticion ya la ha reclamado, no se llama a nadie.
  const n = fila.azureConsultas;
  const reclamada = await prisma.lecturaDocumento.updateMany({
    where: { id: fila.id, estado: 'LEYENDO', azureConsultas: n },
    data: { azureConsultas: n + 1, azureProximaConsulta: new Date(ahora + RESERVA_MS) },
  });
  if (reclamada.count === 0) return respuestaDe(await recargar(fila.id));
  const propia = await recargar(fila.id);

  if (!fila.azureResultId || fueraDePlazo) {
    limpiarAzure(fila.azureResultId);
    return respaldoConClaude(propia, fila.azureResultId ? 'AZURE_TIEMPO' : 'NO_LEGIBLE');
  }

  const r = await azureExtractor.consultar!({ resultId: fila.azureResultId }, contextoLectura(propia, await perfilEmpresa(companyId)));
  if (r.tipo === 'pendiente' || (r.tipo === 'fallo' && r.reintentable)) {
    const espera = (r.tipo === 'pendiente' && r.reintentarEnMs) || esperaPorConsulta(n + 1);
    const siguiente = await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { azureProximaConsulta: new Date(Date.now() + espera) } });
    return respuestaDe(siguiente);
  }
  if (r.tipo === 'fallo') {
    if (r.codigo !== 'AZURE_RESULTADO_PERDIDO') limpiarAzure(fila.azureResultId);
    return respaldoConClaude(propia, r.codigo);
  }
  limpiarAzure(fila.azureResultId);
  return terminarConAzure(propia, r);
}

export const MENSAJE_LECTURA_NO_CAMBIABLE = 'Esta lectura ya no se puede cambiar: está descartada o no ha terminado. Vuelve a leer la factura.';

/**
 * POST /lecturas/:id/origen-tercero. Cambia de donde es el tercero (o lo
 * quita, con null) y vuelve a hacer las validaciones con lo que ya se leyo,
 * sin leer otra vez la factura. Se quita la marca «He revisado». En ventas
 * tambien se rehacen los errores del documento del lector (los usa
 * /ingresos-extractor/confirmar). Devuelve la lectura como el GET.
 */
export async function cambiarOrigenTercero(companyId: string, lector: Lector, id: string, eleccion: EleccionOrigenTercero | null): Promise<RespuestaLectura> {
  const fila = await buscar(companyId, lector, id);
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró: ya no se puede cambiar.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (fila.estado !== 'LISTA' || !fila.resultado) throw badRequest(MENSAJE_LECTURA_NO_CAMBIABLE, { codigo: 'LECTURA_NO_LISTA' });
  const guardado = fila.resultado as unknown as ResultadoGuardado;
  const l = guardado.lectura;
  const val = await validar(fila, l, eleccion);
  await prisma.$transaction(async (tx) => {
    const r = await tx.lecturaDocumento.updateMany({
      where: { id: fila.id, estado: 'LISTA' },
      data: {
        estadoValidacion: val.estado,
        resultado: json({ lectura: l, campos: val.campos, origenTercero: eleccion } satisfies ResultadoGuardado),
        validaciones: json(val.validaciones),
        revisada: false,
      },
    });
    if (r.count === 0) throw badRequest(MENSAJE_LECTURA_NO_CAMBIABLE, { codigo: 'LECTURA_NO_LISTA' });
    if (lector === 'VENTA' && fila.incomeReaderDocumentId) {
      await tx.incomeReaderDocument.updateMany({
        where: { id: fila.incomeReaderDocumentId, companyId, status: 'READY_FOR_VERIFICATION' },
        data: { parsedData: json(aInvoiceExtraction(l, val.validaciones, { confianza: fila.confianza, nombreArchivo: fila.archivoNombre, mime: fila.archivoTipo })) },
      });
    }
  });
  logger.info('[lectura] Origen del tercero cambiado', { lecturaId: fila.id, companyId, lector, origen: eleccion?.origen ?? null });
  return respuestaDe(await recargar(fila.id));
}

/** POST /lecturas/:id/descartar. Borra el archivo; la lectura queda como DESCARTADA. */
export async function descartarLectura(companyId: string, lector: Lector, id: string): Promise<void> {
  const fila = await buscar(companyId, lector, id);
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró: no se puede descartar.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (fila.estado === 'DESCARTADA') return;
  // El resultado ya no se usa (un GET de una DESCARTADA solo da el estado): fuera desde ya.
  await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { estado: 'DESCARTADA', archivoRef: null, resultado: Prisma.DbNull, terminadaEn: fila.terminadaEn ?? new Date() } });
  if (fila.estado === 'LEYENDO') limpiarAzure(fila.azureResultId);
  if (fila.incomeReaderDocumentId) await rechazarDocumentoVenta(fila.incomeReaderDocumentId, 'Lectura descartada');
  if (fila.archivoRef) await borrarArchivo(fila.id, fila.archivoRef);
}
