/**
 * «Probar conexión» con la AEAT (spec verifactu, 10.3; plan F2, 7.4): una
 * consulta ConsultaFactuSistemaFacturacion del mes en curso, de un numero de
 * factura que no existe (NUM_SERIE_PRUEBA_CONEXION), con el certificado de la
 * empresa. No genera registros ni cambia la configuracion.
 *
 *  - En la fase F2 va SIEMPRE al entorno de pruebas (prewww1), sea cual sea la
 *    configuracion: la prueba contra la AEAT de verdad llega con la activacion.
 *  - Fuera de transaccion, con 10 s como mucho y sin reintentos.
 *  - Como mucho una prueba por minuto y empresa, porque la AEAT no admite
 *    pruebas masivas. Se controla en la base, no en la memoria de una
 *    instancia: el minuto se reserva en el certificado con un UPDATE
 *    condicional ANTES de llamar (dos peticiones a la vez no hacen dos
 *    consultas), sustituir el certificado no lo reinicia y, por si se borra y
 *    se vuelve a subir, tambien cuenta la ultima prueba de la bitacora.
 *  - El resultado se guarda en el certificado (pruebaConexion*), con rastro en
 *    la bitacora y en AuditLog. En el log, una linea sin secretos ni XML.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { HttpError, notFound } from '../../utils/http-errors';
import { formatearHusoMadrid, hoyEspana } from '../../utils/fechas';
import { certificadoParaConexion, ESPERA_ENTRE_PRUEBAS_MS, exigirObligado } from './certificado.service';
import { fechaCorta } from './certificado';
import { enviarSoap, urlServicio } from './cliente-aeat';
import { clasificar, MAX_MENSAJE, MENSAJES_CONEXION, type ResultadoClasificado } from './respuestas';
import { cuerpoConsulta, NUM_SERIE_PRUEBA_CONEXION, sobreSoap } from './xml';
import type { EntornoVerifactu } from './cadena';

export { ESPERA_ENTRE_PRUEBAS_MS };

/** Tiempo maximo de la consulta. */
export const TIMEOUT_PRUEBA_MS = 10_000;

export interface ResultadoPrueba extends ResultadoClasificado {
  entorno: EntornoVerifactu;
  /** Instante de la prueba (ISO). */
  en: string;
  ms: number;
}

const recortar = (t: string, n: number) => Array.from(t).slice(0, n).join('');

const sinCertificado = () =>
  notFound('Esta empresa no tiene certificado de VERI*FACTU: súbelo antes de probar la conexión.', { codigo: 'VERIFACTU_SIN_CERTIFICADO', code: 'VERIFACTU_SIN_CERTIFICADO' });

function errorPruebaReciente(faltaMs: number): HttpError {
  const esperarSegundos = Math.min(Math.max(1, Math.ceil(faltaMs / 1000)), ESPERA_ENTRE_PRUEBAS_MS / 1000);
  return new HttpError(429, `Acabas de probar la conexión. Espera ${esperarSegundos} segundos antes de volver a probar.`, {
    codigo: 'VERIFACTU_PRUEBA_RECIENTE',
    code: 'VERIFACTU_PRUEBA_RECIENTE',
    esperarSegundos,
  });
}

/** Lo que se añade al resultado segun el certificado (para que el mensaje no despiste). */
export const NOTAS_CONEXION = {
  // Decision D13: en F2 la prueba va siempre a prewww1; los certificados de sello van a prewww10.
  sello:
    'Es un certificado de sello: la AEAT lo atiende en otra dirección que esta versión de la app todavía no usa, así que este fallo puede no deberse al certificado.',
  // La AEAT da permisos distintos para consultar y para enviar (4140 en la consulta, 4112 en el alta).
  representacion:
    'La consulta funciona, pero la AEAT comprueba aparte el permiso para enviar facturas en nombre de la empresa: se verá antes de activar VERI*FACTU.',
};

/** El resultado con la nota que le toca segun el tipo de certificado y como actua su titular. */
export function conNotaDelCertificado(r: ResultadoClasificado, cert: { tipoCertificado: string | null; actuaComo: string | null }): ResultadoClasificado {
  let nota: string | null = null;
  if (!r.ok && cert.tipoCertificado === 'SELLO' && r.tipo !== 'CERTIFICADO_CADUCADO') nota = NOTAS_CONEXION.sello;
  else if (r.ok && (cert.actuaComo === 'APODERADO' || cert.actuaComo === 'COLABORADOR')) nota = NOTAS_CONEXION.representacion;
  return nota ? { ...r, mensaje: recortar(`${r.mensaje} ${nota}`, MAX_MENSAJE) } : r;
}

/**
 * Reserva el minuto de la prueba, o lanza 429 con los segundos que faltan.
 * El UPDATE condicional es atomico: de dos peticiones a la vez, solo una lo
 * consigue. Al reservar se borra el resultado anterior (es de otra prueba).
 */
async function reservarPrueba(companyId: string, huella: string, ahora: Date): Promise<void> {
  const reserva = await prisma.verifactuCertificado.updateMany({
    where: {
      companyId,
      huellaSha256: huella,
      OR: [{ pruebaConexionFecha: null }, { pruebaConexionFecha: { lte: new Date(ahora.getTime() - ESPERA_ENTRE_PRUEBAS_MS) } }],
    },
    data: { pruebaConexionFecha: ahora, pruebaConexionEntorno: null, pruebaConexionOk: null, pruebaConexionTipo: null, pruebaConexionMensaje: null },
  });
  if (reserva.count === 1) return;
  const fila = await prisma.verifactuCertificado.findUnique({ where: { companyId }, select: { pruebaConexionFecha: true } });
  if (!fila) throw sinCertificado();
  throw errorPruebaReciente((fila.pruebaConexionFecha?.getTime() ?? ahora.getTime()) + ESPERA_ENTRE_PRUEBAS_MS - ahora.getTime());
}

/** Prueba la conexion con la AEAT con el certificado de la empresa. Una conexion fallida tambien es un resultado (ok:false). */
export async function probarConexion(companyId: string, userId: string, ahora: Date = new Date(), opciones: { timeoutMs?: number } = {}): Promise<ResultadoPrueba> {
  // 1. Comprobaciones previas (con el cliente global, fuera de transaccion).
  const obligadoLegal = await exigirObligado(companyId);
  const cert = await prisma.verifactuCertificado.findUnique({
    where: { companyId },
    select: { huellaSha256: true, caducaEn: true, pruebaConexionFecha: true, tipoCertificado: true, actuaComo: true },
  });
  if (!cert) throw sinCertificado();
  // La ultima prueba de la bitacora tambien cuenta: borrar y volver a subir el certificado no da otra prueba.
  const ultima = await prisma.verifactuBitacora.findFirst({ where: { companyId, tipo: 'CONEXION_PROBADA' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const ultimaEn = Math.max(cert.pruebaConexionFecha?.getTime() ?? 0, ultima?.createdAt.getTime() ?? 0);
  const falta = ultimaEn + ESPERA_ENTRE_PRUEBAS_MS - ahora.getTime();
  if (ultimaEn && falta > 0) throw errorPruebaReciente(falta);
  await reservarPrueba(companyId, cert.huellaSha256, ahora);

  // 2. Entorno: en F2 siempre el de pruebas (nunca se lee de la configuracion ni de la peticion).
  const entorno: EntornoVerifactu = 'PRUEBAS';
  let resultado: ResultadoClasificado;
  let ms = 0;
  if (cert.caducaEn.getTime() <= ahora.getTime()) {
    // Caducado: no se llama a nadie.
    resultado = { ok: false, tipo: 'CERTIFICADO_CADUCADO', mensaje: MENSAJES_CONEXION.caducado(fechaCorta(cert.caducaEn)) };
  } else {
    // 3. Descifrado, fuera de transaccion.
    const c = await certificadoParaConexion(companyId);
    const config = await prisma.verifactuConfig.findUnique({ where: { companyId }, select: { nifObligado: true, nombreObligado: true } });
    const obligado = { nombre: recortar(config?.nombreObligado ?? obligadoLegal.denominacion, 120), nif: config?.nifObligado ?? obligadoLegal.nif };
    const [anio, mes] = hoyEspana(ahora).split('-');
    // Solo una factura que no existe: la respuesta es siempre corta (SinDatos), sin rozar
    // los 5 MB ni los 10 s aunque la empresa tenga miles de facturas en el mes.
    const sobre = sobreSoap(cuerpoConsulta({ obligado, ejercicio: anio, periodo: mes, numSerie: NUM_SERIE_PRUEBA_CONEXION }));
    const inicio = Date.now();
    try {
      const r = await enviarSoap({ url: urlServicio(entorno, { sello: false }), pfx: c.pfx, passphrase: c.passphrase, sobre, timeoutMs: opciones.timeoutMs ?? TIMEOUT_PRUEBA_MS });
      ms = r.ms;
      resultado = clasificar({ respuesta: r }, entorno);
    } catch (e) {
      ms = Date.now() - inicio;
      resultado = clasificar({ error: e }, entorno);
    }
  }
  resultado = conNotaDelCertificado(resultado, cert);

  // 4. Se guarda el resultado (si el certificado no se ha sustituido mientras tanto) y su rastro.
  const meta = { entorno, ok: resultado.ok, tipo: resultado.tipo, codigoAeat: resultado.codigoAeat ?? null, httpStatus: resultado.httpStatus ?? null, ms, huellaCertificado: cert.huellaSha256, instante: formatearHusoMadrid(ahora) };
  await prisma.$transaction(async (tx) => {
    await tx.verifactuCertificado.updateMany({
      where: { companyId, huellaSha256: cert.huellaSha256 },
      data: { pruebaConexionFecha: ahora, pruebaConexionEntorno: entorno, pruebaConexionOk: resultado.ok, pruebaConexionTipo: resultado.tipo, pruebaConexionMensaje: resultado.mensaje },
    });
    await tx.verifactuBitacora.create({ data: { companyId, tipo: 'CONEXION_PROBADA', usuarioId: userId, detalle: meta as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: { userId, companyId, action: 'VERIFACTU_CONEXION_PROBADA', resourceType: 'VERIFACTU_CERTIFICADO', resourceId: companyId, meta: meta as Prisma.InputJsonValue },
    });
  });
  logger.info(`[verifactu] prueba de conexión: empresa ${companyId}, ${resultado.tipo}, HTTP ${resultado.httpStatus ?? '-'}, código ${resultado.codigoAeat ?? '-'}, ${ms} ms`);
  return { ...resultado, entorno, en: ahora.toISOString(), ms };
}
