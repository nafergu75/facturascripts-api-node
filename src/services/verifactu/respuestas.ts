/**
 * Lectura de las respuestas de la AEAT a los servicios de VERI*FACTU y
 * clasificacion del resultado de una llamada (spec verifactu, 6.5; plan F2,
 * 4.4 y 7.3). Funciones puras.
 *
 * - Se lee con fast-xml-parser sin prefijos (removeNSPrefix), sin convertir
 *   los valores (parseTagValue: false) y sin entidades (processEntities: false).
 * - Una respuesta con DOCTYPE o ENTITY se trata como inesperada antes de
 *   leerla: SOAP no admite DTD, y asi no hay expansion de entidades.
 * - Las respuestas NO se validan contra el XSD: el ejemplo oficial de la
 *   consulta no lo cumple. Se admiten «Correcto»/«Correcta» y
 *   «Anulado»/«Anulada».
 *
 * La lectura del alta (RespuestaRegFactuSistemaFacturacion) llega en la fase F3.
 */
import { XMLParser } from 'fast-xml-parser';
import type { EntornoVerifactu } from './cadena';

/** Etiquetas que se leen siempre como lista, aunque venga una sola. */
const LISTAS = new Set(['RespuestaLinea', 'RegistroRespuestaConsultaFactuSistemaFacturacion', 'DetalleDesglose', 'IDDestinatario']);

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: true,
  processEntities: false,
  ignoreDeclaration: true,
  trimValues: true,
  isArray: (nombre) => LISTAS.has(nombre),
});

type Nodo = Record<string, unknown>;

/** true si el texto trae una DTD o entidades declaradas (se rechaza sin leerlo). */
export function traeDtd(xml: string): boolean {
  return /<!DOCTYPE|<!ENTITY/i.test(xml);
}

/** Lee un XML de la AEAT; null si no es XML, trae DTD o no se puede leer. */
export function leerXml(xml: string): Nodo | null {
  if (typeof xml !== 'string' || !xml.trim() || traeDtd(xml)) return null;
  const limpio = xml.replace(/^﻿/, '');
  if (!/^\s*(<\?xml[^>]*\?>\s*)?</.test(limpio)) return null;
  try {
    const r = parser.parse(limpio, true) as unknown;
    return r && typeof r === 'object' ? (r as Nodo) : null;
  } catch {
    return null;
  }
}

const esNodo = (v: unknown): v is Nodo => !!v && typeof v === 'object' && !Array.isArray(v);
const texto = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** El cuerpo SOAP (Envelope/Body) o, si no viene en sobre, el propio documento. */
function cuerpo(doc: Nodo): Nodo {
  const sobre = doc.Envelope;
  if (esNodo(sobre) && esNodo(sobre.Body)) return sobre.Body;
  return doc;
}

/** Las 5 entidades de XML y las numericas (el parser las deja tal cual). */
function sinEntidades(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const safeCodePoint = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/** Texto de la AEAT para enseñarlo: sin etiquetas, con espacios simples y como mucho 300 caracteres. */
export function limpiarTextoAeat(t: string | null | undefined): string {
  const s = sinEntidades(String(t ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, 300).join('');
}

export interface FaultAeat {
  /** Lo que va detras de «:» en faultcode: Client, Server... */
  tipo: string;
  /** El de «Codigo[NNNN]» del faultstring, si lo trae. */
  codigo: number | null;
  texto: string;
}

/** El SOAP Fault de una respuesta, o null si no lo hay. */
export function leerFault(xml: string): FaultAeat | null {
  const doc = leerXml(xml);
  if (!doc) return null;
  const f = cuerpo(doc).Fault;
  if (!esNodo(f)) return null;
  const faultcode = texto(f.faultcode) ?? '';
  const faultstring = texto(f.faultstring) ?? '';
  const tipo = faultcode.includes(':') ? faultcode.slice(faultcode.lastIndexOf(':') + 1) : faultcode;
  const m = /Codigo\[(\d+)\]/.exec(faultstring);
  return { tipo, codigo: m ? Number(m[1]) : null, texto: limpiarTextoAeat(faultstring) };
}

/** Estado de un registro en una respuesta de la AEAT, con las dos formas que usa (Correcto/Correcta...). */
export function estadoRegistro(t: string | null | undefined): 'Correcto' | 'AceptadoConErrores' | 'Incorrecto' | 'Anulado' | null {
  const s = String(t ?? '').trim();
  if (s === 'Correcto' || s === 'Correcta') return 'Correcto';
  if (s === 'AceptadoConErrores' || s === 'AceptadaConErrores') return 'AceptadoConErrores';
  if (s === 'Incorrecto' || s === 'Incorrecta') return 'Incorrecto';
  if (s === 'Anulado' || s === 'Anulada') return 'Anulado';
  return null;
}

export interface RespuestaConsulta {
  resultado: 'ConDatos' | 'SinDatos';
  paginacion: 'S' | 'N' | null;
  /** Registros que devuelve esta pagina. */
  registros: number;
  /** Estado de cada registro devuelto (null si no se reconoce). */
  estados: Array<ReturnType<typeof estadoRegistro>>;
}

/** La respuesta a ConsultaFactuSistemaFacturacion, o null si no es una. */
export function leerRespuestaConsulta(xml: string): RespuestaConsulta | null {
  const doc = leerXml(xml);
  if (!doc) return null;
  const r = cuerpo(doc).RespuestaConsultaFactuSistemaFacturacion;
  if (!esNodo(r)) return null;
  const resultado = texto(r.ResultadoConsulta);
  if (resultado !== 'ConDatos' && resultado !== 'SinDatos') return null;
  const pag = texto(r.IndicadorPaginacion);
  const filas = Array.isArray(r.RegistroRespuestaConsultaFactuSistemaFacturacion) ? r.RegistroRespuestaConsultaFactuSistemaFacturacion : [];
  const estados = filas.map((fila) => {
    const e = esNodo(fila) && esNodo(fila.EstadoRegistro) ? fila.EstadoRegistro.EstadoRegistro : null;
    return estadoRegistro(texto(e));
  });
  return { resultado, paginacion: pag === 'S' || pag === 'N' ? pag : null, registros: filas.length, estados };
}

// ---------- Clasificacion del resultado de «Probar conexión» ----------

export type TipoResultadoConexion =
  | 'CORRECTO'
  | 'CERTIFICADO_CADUCADO'
  | 'RED'
  | 'TIEMPO_AGOTADO'
  | 'TLS_CORTADO'
  | 'CERTIFICADO_RECHAZADO'
  | 'SERVIDOR_NO_FIABLE'
  | 'SIN_PERMISO'
  | 'DATOS_OBLIGADO'
  | 'REPRESENTANTE'
  | 'ERROR_AEAT'
  | 'XML'
  | 'SERVICIO'
  | 'RESPUESTA_INESPERADA';

export interface ResultadoClasificado {
  ok: boolean;
  tipo: TipoResultadoConexion;
  mensaje: string;
  codigoAeat?: number;
  httpStatus?: number;
}

/** Respuesta HTTP tal como la da el cliente (cliente-aeat.ts). */
export interface RespuestaHttp {
  status: number;
  tipoContenido: string | null;
  cuerpo: string;
}

/** Tope del mensaje que se guarda. */
export const MAX_MENSAJE = 1000;

const recortarMensaje = (s: string) => Array.from(s).slice(0, MAX_MENSAJE).join('');

const NOMBRE_ENTORNO: Record<EntornoVerifactu, string> = { PRUEBAS: 'entorno de pruebas', PRODUCCION: 'entorno real' };

/** Codigos de la AEAT (errores.properties) agrupados por lo que tiene que hacer la persona. */
const GRUPOS_FAULT: Array<{ tipo: TipoResultadoConexion; codigos: number[] }> = [
  { tipo: 'SIN_PERMISO', codigos: [4112, 4140, 4132] },
  { tipo: 'DATOS_OBLIGADO', codigos: [4104, 4107, 4109, 4115, 4116] },
  { tipo: 'REPRESENTANTE', codigos: [4105, 4117, 4123, 4124] },
  { tipo: 'ERROR_AEAT', codigos: [4108, 4110, 4111, 4128] },
  { tipo: 'XML', codigos: [4102, 4103, 4113, 4114, 4118, 4119, 4136, 4137, 4138] },
  { tipo: 'SERVICIO', codigos: [4134, 4139, 4141] },
];

/** Mensajes para la persona. `n`: codigo de la AEAT; `aeat`: su texto, limpio. */
export const MENSAJES_CONEXION = {
  correcto: (entorno: EntornoVerifactu) => `Conexión correcta con la AEAT (${NOMBRE_ENTORNO[entorno]}). Ha aceptado el certificado.`,
  caducado: (fecha: string) => `El certificado caducó el ${fecha}. Sube uno vigente.`,
  red: 'No se ha podido llegar a la AEAT. Comprueba la conexión y vuelve a probar dentro de unos minutos.',
  tiempo: 'La AEAT no ha contestado a tiempo. Vuelve a probar dentro de unos minutos.',
  tlsCortado:
    'La AEAT ha cortado la conexión al recibir el certificado. Lo más probable es que no lo acepte. Si el certificado está bien, puede ser la red: prueba más tarde.',
  certificadoRechazado: 'La AEAT no acepta este certificado. Tiene que ser un certificado cualificado (por ejemplo, de la FNMT) y estar vigente.',
  servidorNoFiable:
    'No se ha podido comprobar que el servidor es de la AEAT. Es un fallo de configuración de la app, no de tu certificado: avisa al soporte de Conta API.',
  sinPermiso: (n: number) =>
    `El titular del certificado no tiene permiso en la AEAT para esta empresa (código ${n}). Si actúa como apoderado, el apoderamiento tiene que estar dado de alta en la sede.`,
  datosObligado: (n: number, aeat: string) =>
    `La AEAT no reconoce el NIF o la razón social de la empresa (código ${n}). Revisa los datos de la empresa.${aeat ? ` La AEAT dice: «${aeat}»` : ''}`,
  representante: (n: number, aeat: string) => `La AEAT rechaza los datos del representante (código ${n}).${aeat ? ` La AEAT dice: «${aeat}»` : ''}`,
  errorAeat: 'La AEAT ha tenido un problema al atender la consulta. Prueba más tarde.',
  xml: (n: number) => `La AEAT rechaza el formato de la consulta (código ${n}). Es un fallo de la app, no de tu certificado: avisa al soporte de Conta API.`,
  servicio: (n: number) => `El servicio de la AEAT no está disponible para esta conexión (código ${n}).`,
  faultDesconocido: (n: number | null, aeat: string) =>
    `La AEAT ha rechazado la consulta${n ? ` (código ${n})` : ''}.${aeat ? ` La AEAT dice: «${aeat}»` : ''}`,
  inesperada: (status?: number) =>
    `La AEAT ha contestado algo que no se esperaba${status ? ` (HTTP ${status})` : ''}. Prueba más tarde; si se repite, avisa al soporte de Conta API.`,
};

const r = (ok: boolean, tipo: TipoResultadoConexion, mensaje: string, extra: { codigoAeat?: number | null; httpStatus?: number } = {}): ResultadoClasificado => ({
  ok,
  tipo,
  mensaje: recortarMensaje(mensaje),
  ...(extra.codigoAeat ? { codigoAeat: extra.codigoAeat } : {}),
  ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
});

/** Codigos de error de red de Node. */
const RED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN']);
const TIEMPO = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const SERVIDOR_NO_FIABLE = /^(CERT_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED_CERT$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT|ERR_TLS_CERT_ALTNAME_INVALID$|HOSTNAME_MISMATCH$)/;

/** Clasifica un error de red o de TLS (lo que lanza la llamada antes de tener respuesta). */
function clasificarError(e: unknown): ResultadoClasificado {
  const err = (e ?? {}) as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const causa = (err.cause ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = String(err.code ?? causa.code ?? '');
  const nombre = String(err.name ?? '');
  const mensaje = `${String(err.message ?? '')} ${String(causa.message ?? '')}`.toLowerCase();

  if (TIEMPO.has(code) || nombre === 'AbortError' || nombre === 'TimeoutError' || nombre === 'CanceledError' || causa.name === 'TimeoutError' || /timeout|timed out/.test(mensaje)) {
    return r(false, 'TIEMPO_AGOTADO', MENSAJES_CONEXION.tiempo);
  }
  if (SERVIDOR_NO_FIABLE.test(code)) return r(false, 'SERVIDOR_NO_FIABLE', MENSAJES_CONEXION.servidorNoFiable);
  if (code === 'ERR_BAD_RESPONSE' && /maxcontentlength|max(imum)? content length/.test(mensaje)) {
    return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.inesperada());
  }
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_') || /alert (bad certificate|certificate required|unknown ca|handshake failure|certificate unknown|access denied|decrypt error)/.test(mensaje)) {
    return r(false, 'CERTIFICADO_RECHAZADO', MENSAJES_CONEXION.certificadoRechazado);
  }
  if (code === 'ECONNRESET' || /socket hang up|before secure tls connection/.test(mensaje)) {
    return r(false, 'TLS_CORTADO', MENSAJES_CONEXION.tlsCortado);
  }
  if (RED.has(code)) return r(false, 'RED', MENSAJES_CONEXION.red);
  return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.inesperada());
}

const pareceHtml = (resp: RespuestaHttp) =>
  /text\/html/i.test(resp.tipoContenido ?? '') || /^\s*(<!doctype\s+html|<html)/i.test(resp.cuerpo ?? '');

/** Clasifica una respuesta HTTP de la AEAT a la consulta. */
function clasificarRespuesta(resp: RespuestaHttp, entorno: EntornoVerifactu): ResultadoClasificado {
  const status = resp.status;
  if (pareceHtml(resp)) {
    if (status === 401 || status === 403) return r(false, 'CERTIFICADO_RECHAZADO', MENSAJES_CONEXION.certificadoRechazado, { httpStatus: status });
    if (status >= 500) return r(false, 'ERROR_AEAT', MENSAJES_CONEXION.errorAeat, { httpStatus: status });
    return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.inesperada(status), { httpStatus: status });
  }
  const cuerpoTxt = resp.cuerpo ?? '';
  if (traeDtd(cuerpoTxt)) return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.inesperada(status), { httpStatus: status });
  const consulta = leerRespuestaConsulta(cuerpoTxt);
  if (consulta && status >= 200 && status < 300) return r(true, 'CORRECTO', MENSAJES_CONEXION.correcto(entorno), { httpStatus: status });
  const fault = leerFault(cuerpoTxt);
  if (fault) {
    if (fault.tipo === 'Server') return r(false, 'ERROR_AEAT', MENSAJES_CONEXION.errorAeat, { codigoAeat: fault.codigo, httpStatus: status });
    const n = fault.codigo;
    const grupo = n !== null ? GRUPOS_FAULT.find((g) => g.codigos.includes(n)) : undefined;
    const extra = { codigoAeat: n, httpStatus: status };
    switch (grupo?.tipo) {
      case 'SIN_PERMISO':
        return r(false, 'SIN_PERMISO', MENSAJES_CONEXION.sinPermiso(n!), extra);
      case 'DATOS_OBLIGADO':
        return r(false, 'DATOS_OBLIGADO', MENSAJES_CONEXION.datosObligado(n!, fault.texto), extra);
      case 'REPRESENTANTE':
        return r(false, 'REPRESENTANTE', MENSAJES_CONEXION.representante(n!, fault.texto), extra);
      case 'ERROR_AEAT':
        return r(false, 'ERROR_AEAT', MENSAJES_CONEXION.errorAeat, extra);
      case 'XML':
        return r(false, 'XML', MENSAJES_CONEXION.xml(n!), extra);
      case 'SERVICIO':
        return r(false, 'SERVICIO', MENSAJES_CONEXION.servicio(n!), extra);
      default:
        return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.faultDesconocido(n, fault.texto), extra);
    }
  }
  if (status >= 500) return r(false, 'ERROR_AEAT', MENSAJES_CONEXION.errorAeat, { httpStatus: status });
  return r(false, 'RESPUESTA_INESPERADA', MENSAJES_CONEXION.inesperada(status), { httpStatus: status });
}

/**
 * Resultado de «Probar conexión» a partir de la respuesta HTTP o del error de
 * la llamada. Una conexion fallida no es un error de la app: es un resultado
 * con ok:false y un mensaje en castellano para la persona.
 */
export function clasificar(entrada: { respuesta: RespuestaHttp } | { error: unknown }, entorno: EntornoVerifactu): ResultadoClasificado {
  if ('respuesta' in entrada) return clasificarRespuesta(entrada.respuesta, entorno);
  return clasificarError(entrada.error);
}
