/**
 * «Probar conexión» con la AEAT (spec verifactu, 10.3; plan F2, 7.4): una
 * consulta ConsultaFactuSistemaFacturacion del mes en curso con el certificado
 * de la empresa. No genera registros ni cambia la configuracion.
 *
 *  - En la fase F2 va SIEMPRE al entorno de pruebas (prewww1), sea cual sea la
 *    configuracion: la prueba contra la AEAT de verdad llega con la activacion.
 *  - Fuera de transaccion, con 10 s como mucho y sin reintentos.
 *  - Como mucho una prueba por minuto y empresa (controlado en la base con la
 *    fecha de la ultima prueba), porque la AEAT no admite pruebas masivas.
 *  - El resultado se guarda en el certificado (pruebaConexion*), con rastro en
 *    la bitacora y en AuditLog. En el log, una linea sin secretos ni XML.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { HttpError, notFound } from '../../utils/http-errors';
import { formatearHusoMadrid, hoyEspana } from '../../utils/fechas';
import { certificadoParaConexion, exigirObligado } from './certificado.service';
import { fechaCorta } from './certificado';
import { enviarSoap, urlServicio } from './cliente-aeat';
import { clasificar, MENSAJES_CONEXION, type ResultadoClasificado } from './respuestas';
import { cuerpoConsulta, sobreSoap } from './xml';
import type { EntornoVerifactu } from './cadena';

/** Tiempo maximo de la consulta. */
export const TIMEOUT_PRUEBA_MS = 10_000;
/** Una prueba por minuto y empresa, como mucho. */
export const ESPERA_ENTRE_PRUEBAS_MS = 60_000;

export interface ResultadoPrueba extends ResultadoClasificado {
  entorno: EntornoVerifactu;
  /** Instante de la prueba (ISO). */
  en: string;
  ms: number;
}

const recortar = (t: string, n: number) => Array.from(t).slice(0, n).join('');

/** Prueba la conexion con la AEAT con el certificado de la empresa. Una conexion fallida tambien es un resultado (ok:false). */
export async function probarConexion(companyId: string, userId: string, ahora: Date = new Date(), opciones: { timeoutMs?: number } = {}): Promise<ResultadoPrueba> {
  // 1. Comprobaciones previas (con el cliente global, fuera de transaccion).
  const obligadoLegal = await exigirObligado(companyId);
  const cert = await prisma.verifactuCertificado.findUnique({ where: { companyId }, select: { huellaSha256: true, caducaEn: true, pruebaConexionFecha: true } });
  if (!cert) throw notFound('Esta empresa no tiene certificado de VERI*FACTU: súbelo antes de probar la conexión.', { codigo: 'VERIFACTU_SIN_CERTIFICADO', code: 'VERIFACTU_SIN_CERTIFICADO' });
  if (cert.pruebaConexionFecha) {
    const falta = cert.pruebaConexionFecha.getTime() + ESPERA_ENTRE_PRUEBAS_MS - ahora.getTime();
    if (falta > 0) {
      const esperarSegundos = Math.ceil(falta / 1000);
      throw new HttpError(429, `Acabas de probar la conexión. Espera ${esperarSegundos} segundos antes de volver a probar.`, {
        codigo: 'VERIFACTU_PRUEBA_RECIENTE',
        code: 'VERIFACTU_PRUEBA_RECIENTE',
        esperarSegundos,
      });
    }
  }

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
    const sobre = sobreSoap(cuerpoConsulta({ obligado, ejercicio: anio, periodo: mes }));
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
