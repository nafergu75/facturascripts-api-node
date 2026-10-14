/**
 * Certificado electronico de VERI*FACTU de cada empresa (spec verifactu, 2.5;
 * plan F2, 6.3). Lo sube un administrador de la empresa (config:write) en
 * Configuracion > VERI*FACTU.
 *
 *  - Se lee con certificado.ts (forge solo para abrir el PKCS#12).
 *  - El PFX (en base64) y la contraseña se guardan cifrados con cifrarV1, cada
 *    uno con su contexto «verifactu:<companyId>:pfx|pass»: copiados a otra
 *    empresa no se descifran. Se cifra y se descifra siempre FUERA de las
 *    transacciones.
 *  - Ningun GET devuelve el PFX ni la contraseña: solo los metadatos (select
 *    explicito). certificadoParaConexion es la UNICA funcion que lee pfxEnc y
 *    passEnc (lo vigila verifactu-sin-secretos.test.ts).
 *  - Subir, sustituir y borrar dejan rastro en VerifactuBitacora y en AuditLog,
 *    en la misma transaccion y sin secretos.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { conflict, HttpError, notFound } from '../../utils/http-errors';
import { cifrarV1, descifrarV1 } from '../../utils/crypto';
import { normalizarNif } from '../../utils/nif';
import { formatearHusoMadrid } from '../../utils/fechas';
import { perfilDesdeConfig } from '../perfilEmpresa.service';
import { fechaCorta, leerCertificado, type MetadatosLeidos, type TipoCertificado } from './certificado';

export const ACTUA_COMO = ['OBLIGADO', 'APODERADO', 'COLABORADOR'] as const;
export type ActuaComo = (typeof ACTUA_COMO)[number];

const DIA_MS = 86_400_000;

export const contextoPfx = (companyId: string) => `verifactu:${companyId}:pfx`;
export const contextoPass = (companyId: string) => `verifactu:${companyId}:pass`;

const conCodigo = (codigo: string, extra: Record<string, unknown> = {}) => ({ codigo, code: codigo, ...extra });

export type AvisoCaducidad = null | 'CADUCA_30' | 'CADUCA_7' | 'CADUCADO';

/** Aviso de caducidad del certificado: a 30 dias, a 7 o ya caducado. */
export function avisoCaducidad(caducaEn: Date, ahora: Date): { dias: number; aviso: AvisoCaducidad } {
  const ms = caducaEn.getTime() - ahora.getTime();
  const dias = Math.floor(ms / DIA_MS);
  const aviso: AvisoCaducidad = ms <= 0 ? 'CADUCADO' : ms <= 7 * DIA_MS ? 'CADUCA_7' : ms <= 30 * DIA_MS ? 'CADUCA_30' : null;
  return { dias, aviso };
}

/** Texto del aviso de caducidad para las pantallas (Ventas, panel y Configuracion > VERI*FACTU). */
export function textoAvisoCaducidad(caducaEn: Date, ahora: Date): { nivel: 'aviso' | 'urgente' | 'caducado'; texto: string } | null {
  const { dias, aviso } = avisoCaducidad(caducaEn, ahora);
  if (!aviso) return null;
  const fecha = fechaCorta(caducaEn);
  if (aviso === 'CADUCADO') return { nivel: 'caducado', texto: `El certificado de VERI*FACTU caducó el ${fecha}. Sube uno nuevo en Configuración > VERI*FACTU.` };
  const cuando = dias <= 0 ? 'hoy' : dias === 1 ? 'mañana' : `en ${dias} días`;
  return {
    nivel: aviso === 'CADUCA_7' ? 'urgente' : 'aviso',
    texto: `El certificado de VERI*FACTU caduca ${cuando} (${fecha}). Renuévalo y súbelo en Configuración > VERI*FACTU.`,
  };
}

/** Lo que la pantalla puede ver del certificado (nunca el PFX ni la contraseña). */
export interface MetadatosCertificado {
  titular: string;
  nifTitular: string;
  nifRepresentante: string | null;
  tipo: TipoCertificado;
  actuaComo: ActuaComo;
  nifCoincide: boolean;
  emisor: string;
  numeroSerie: string;
  validoDesde: string;
  caducaEn: string;
  huellaSha256: string;
  subidoEn: string;
  /** Email de quien lo subio (no su id). */
  subidoPor: string | null;
  diasParaCaducar: number;
  aviso: AvisoCaducidad;
  ultimaPrueba: null | { en: string; entorno: 'PRUEBAS' | 'PRODUCCION'; ok: boolean; tipo: string; mensaje: string };
}

/** Columnas del certificado que se pueden leer (sin pfxEnc ni passEnc). */
export const SELECT_METADATOS = {
  companyId: true,
  titular: true,
  nifTitular: true,
  nifRepresentante: true,
  tipoCertificado: true,
  actuaComo: true,
  emisor: true,
  numeroSerie: true,
  validoDesde: true,
  caducaEn: true,
  huellaSha256: true,
  subidoPor: true,
  subidoEn: true,
  pruebaConexionFecha: true,
  pruebaConexionEntorno: true,
  pruebaConexionOk: true,
  pruebaConexionTipo: true,
  pruebaConexionMensaje: true,
} as const;

type FilaMetadatos = Prisma.VerifactuCertificadoGetPayload<{ select: typeof SELECT_METADATOS }>;

const TIPOS: readonly string[] = ['REPRESENTANTE_PJ', 'PERSONA_FISICA', 'SELLO', 'OTRO'];

/** NIF del obligado: el congelado en VERI*FACTU o, si aun no lo esta, el de los datos de la empresa. */
async function nifDeLaEmpresa(companyId: string): Promise<string> {
  const config = await prisma.verifactuConfig.findUnique({ where: { companyId }, select: { nifObligado: true } });
  if (config?.nifObligado) return config.nifObligado;
  const legal = await prisma.legalConfig.findUnique({ where: { companyId }, select: { nif: true } });
  return normalizarNif(legal?.nif ?? '');
}

function aPublicos(f: FilaMetadatos, ahora: Date, nifEmpresa: string, emailSubidoPor: string | null): MetadatosCertificado {
  const { dias, aviso } = avisoCaducidad(f.caducaEn, ahora);
  const entorno = f.pruebaConexionEntorno === 'PRODUCCION' ? 'PRODUCCION' : 'PRUEBAS';
  return {
    titular: f.titular,
    nifTitular: f.nifTitular,
    nifRepresentante: f.nifRepresentante,
    tipo: (TIPOS.includes(f.tipoCertificado ?? '') ? f.tipoCertificado : 'OTRO') as TipoCertificado,
    actuaComo: ((ACTUA_COMO as readonly string[]).includes(f.actuaComo ?? '') ? f.actuaComo : 'OBLIGADO') as ActuaComo,
    nifCoincide: !!nifEmpresa && normalizarNif(f.nifTitular) === nifEmpresa,
    emisor: f.emisor,
    numeroSerie: f.numeroSerie,
    validoDesde: f.validoDesde.toISOString(),
    caducaEn: f.caducaEn.toISOString(),
    huellaSha256: f.huellaSha256,
    subidoEn: f.subidoEn.toISOString(),
    subidoPor: emailSubidoPor,
    diasParaCaducar: dias,
    aviso,
    ultimaPrueba:
      f.pruebaConexionFecha && f.pruebaConexionOk !== null
        ? { en: f.pruebaConexionFecha.toISOString(), entorno, ok: f.pruebaConexionOk, tipo: f.pruebaConexionTipo ?? '', mensaje: f.pruebaConexionMensaje ?? '' }
        : null,
  };
}

/** Metadatos del certificado de la empresa, o null si no tiene. */
export async function metadatosCertificado(companyId: string, ahora: Date = new Date()): Promise<MetadatosCertificado | null> {
  const f = await prisma.verifactuCertificado.findUnique({ where: { companyId }, select: SELECT_METADATOS });
  if (!f) return null;
  const usuario = await prisma.user.findUnique({ where: { id: f.subidoPor }, select: { email: true } });
  return aPublicos(f, ahora, await nifDeLaEmpresa(companyId), usuario?.email ?? null);
}

/** Lo que va a la bitacora y a AuditLog del certificado: nunca secretos. */
function rastro(m: { titular: string; nifTitular: string; nifRepresentante: string | null; emisor: string; numeroSerie: string; validoDesde: Date; caducaEn: Date; huellaSha256: string }) {
  return {
    titular: m.titular,
    nifTitular: m.nifTitular,
    nifRepresentante: m.nifRepresentante,
    emisor: m.emisor,
    numeroSerie: m.numeroSerie,
    validoDesde: m.validoDesde.toISOString(),
    caducaEn: m.caducaEn.toISOString(),
    huellaSha256: m.huellaSha256,
  };
}

/** Comprobaciones previas comunes: empresa española con NIF y denominación. */
export async function exigirObligado(companyId: string): Promise<{ nif: string; denominacion: string }> {
  const legal = await prisma.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true, nif: true, denominacion: true } });
  if (!perfilDesdeConfig(legal).espanola) {
    throw conflict('VERI*FACTU solo se aplica a empresas españolas: esta empresa no necesita certificado.', conCodigo('VERIFACTU_NO_APLICA'));
  }
  const campos = [!legal?.denominacion?.trim() ? 'denominacion' : null, !legal?.nif?.trim() ? 'nif' : null].filter((x): x is string => !!x);
  if (campos.length) {
    throw conflict('Antes, completa la denominación y el NIF en Datos de la empresa.', conCodigo('VERIFACTU_DATOS_OBLIGADO', { campos }));
  }
  return { nif: normalizarNif(legal!.nif!), denominacion: legal!.denominacion!.trim() };
}

/**
 * Sube (o sustituye) el certificado de la empresa. Si el titular no es la
 * empresa, hace falta saber si actua como apoderado o como colaborador social
 * (400 con campo actuaComo y los datos para preguntarlo). Sustituir se admite
 * tambien con VERI*FACTU activo (para renovar un certificado que caduca).
 */
export async function subirCertificado(
  companyId: string,
  userId: string,
  entrada: { pfx: Buffer | undefined; contrasena: unknown; actuaComo?: unknown },
  ahora: Date = new Date(),
): Promise<{ certificado: MetadatosCertificado; sustituido: boolean }> {
  // Fuera de la transaccion: comprobaciones, lectura del certificado y cifrado.
  await exigirObligado(companyId);
  const contrasena = typeof entrada.contrasena === 'string' ? entrada.contrasena : '';
  const { metadatos } = leerCertificado(entrada.pfx ?? Buffer.alloc(0), contrasena, ahora);
  const nifEmpresa = await nifDeLaEmpresa(companyId);
  let actuaComo: ActuaComo;
  if (normalizarNif(metadatos.nifTitular) === nifEmpresa) {
    actuaComo = 'OBLIGADO';
  } else {
    const pedido = typeof entrada.actuaComo === 'string' ? entrada.actuaComo.trim().toUpperCase() : '';
    if (pedido !== 'APODERADO' && pedido !== 'COLABORADOR') {
      throw new HttpError(
        400,
        `El certificado es de ${metadatos.titular || 'otro titular'} (${metadatos.nifTitular || 'sin NIF'}), no de la empresa (${nifEmpresa}). Indica si actúa como apoderado o como colaborador social de la empresa.`,
        conCodigo('VERIFACTU_CERT_ACTUA_COMO', { campo: 'actuaComo', titular: metadatos.titular, nifTitular: metadatos.nifTitular, nifEmpresa }),
      );
    }
    actuaComo = pedido;
  }
  const pfxEnc = cifrarV1(entrada.pfx!.toString('base64'), contextoPfx(companyId));
  const passEnc = cifrarV1(contrasena, contextoPass(companyId));
  const datos = datosGuardados(metadatos, actuaComo);

  const sustituido = await prisma.$transaction(async (tx) => {
    const antes = await tx.verifactuCertificado.findUnique({ where: { companyId }, select: { huellaSha256: true, titular: true, caducaEn: true } });
    await tx.verifactuCertificado.upsert({
      where: { companyId },
      create: { companyId, pfxEnc, passEnc, ...datos, subidoPor: userId, subidoEn: ahora },
      update: {
        pfxEnc,
        passEnc,
        ...datos,
        subidoPor: userId,
        subidoEn: ahora,
        pruebaConexionFecha: null,
        pruebaConexionEntorno: null,
        pruebaConexionOk: null,
        pruebaConexionTipo: null,
        pruebaConexionMensaje: null,
      },
    });
    const detalle = { ...rastro(metadatos), tipo: metadatos.tipo, actuaComo, sustituye: antes?.huellaSha256 ?? null, instante: formatearHusoMadrid(ahora) };
    await tx.verifactuBitacora.create({ data: { companyId, tipo: 'CERT_SUBIDO', usuarioId: userId, detalle: detalle as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: {
        userId,
        companyId,
        action: antes ? 'VERIFACTU_CERTIFICADO_SUSTITUIDO' : 'VERIFACTU_CERTIFICADO_SUBIDO',
        resourceType: 'VERIFACTU_CERTIFICADO',
        resourceId: companyId,
        meta: detalle as Prisma.InputJsonValue,
      },
    });
    return !!antes;
  });
  const certificado = await metadatosCertificado(companyId, ahora);
  return { certificado: certificado!, sustituido };
}

function datosGuardados(m: MetadatosLeidos, actuaComo: ActuaComo) {
  return {
    titular: m.titular,
    nifTitular: m.nifTitular,
    nifRepresentante: m.nifRepresentante,
    tipoCertificado: m.tipo,
    actuaComo,
    emisor: m.emisor,
    numeroSerie: m.numeroSerie,
    validoDesde: m.validoDesde,
    caducaEn: m.caducaEn,
    huellaSha256: m.huellaSha256,
  };
}

/** Borra el certificado. Con VERI*FACTU activo no: 409 (se sustituye, no se borra). */
export async function borrarCertificado(companyId: string, userId: string, ahora: Date = new Date()): Promise<{ borrado: true }> {
  const actual = await prisma.verifactuCertificado.findUnique({ where: { companyId }, select: { id: true } });
  if (!actual) throw notFound('Esta empresa no tiene certificado de VERI*FACTU.', conCodigo('VERIFACTU_SIN_CERTIFICADO'));
  const config = await prisma.verifactuConfig.findUnique({ where: { companyId }, select: { estado: true } });
  if (config?.estado === 'ACTIVO') {
    throw conflict('VERI*FACTU está activo en esta empresa y usa este certificado: no se puede borrar. Si caduca, sube el nuevo y sustituirá al de ahora.', conCodigo('VERIFACTU_CERTIFICADO_EN_USO'));
  }
  await prisma.$transaction(async (tx) => {
    const f = await tx.verifactuCertificado.findUnique({
      where: { companyId },
      select: { titular: true, nifTitular: true, nifRepresentante: true, emisor: true, numeroSerie: true, validoDesde: true, caducaEn: true, huellaSha256: true },
    });
    if (!f) throw notFound('Esta empresa no tiene certificado de VERI*FACTU.', conCodigo('VERIFACTU_SIN_CERTIFICADO'));
    await tx.verifactuCertificado.delete({ where: { companyId } });
    const detalle = { ...rastro(f), instante: formatearHusoMadrid(ahora) };
    await tx.verifactuBitacora.create({ data: { companyId, tipo: 'CERT_BORRADO', usuarioId: userId, detalle: detalle as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: { userId, companyId, action: 'VERIFACTU_CERTIFICADO_BORRADO', resourceType: 'VERIFACTU_CERTIFICADO', resourceId: companyId, meta: detalle as Prisma.InputJsonValue },
    });
  });
  return { borrado: true };
}

/** El certificado listo para una conexion TLS. Solo fuera de transacciones. */
export interface CertificadoConexion {
  pfx: Buffer;
  passphrase: string;
  huellaSha256: string;
  caducaEn: Date;
  validoDesde: Date;
}

/**
 * La UNICA funcion que lee el PFX y la contraseña cifrados: los descifra (fuera
 * de transaccion) para conectar con la AEAT. Si no se pueden descifrar (clave
 * rotada, dato tocado...), 409: hay que volver a subirlo.
 */
export async function certificadoParaConexion(companyId: string): Promise<CertificadoConexion> {
  const f = await prisma.verifactuCertificado.findUnique({
    where: { companyId },
    select: { pfxEnc: true, passEnc: true, huellaSha256: true, caducaEn: true, validoDesde: true },
  });
  if (!f) throw notFound('Esta empresa no tiene certificado de VERI*FACTU.', conCodigo('VERIFACTU_SIN_CERTIFICADO'));
  try {
    return {
      pfx: Buffer.from(descifrarV1(f.pfxEnc, contextoPfx(companyId)), 'base64'),
      passphrase: descifrarV1(f.passEnc, contextoPass(companyId)),
      huellaSha256: f.huellaSha256,
      caducaEn: f.caducaEn,
      validoDesde: f.validoDesde,
    };
  } catch {
    throw conflict('No se puede leer el certificado guardado: vuelve a subirlo.', conCodigo('VERIFACTU_CERT_ILEGIBLE'));
  }
}
