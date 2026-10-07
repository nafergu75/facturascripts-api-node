import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';

export interface LegalConfigInput {
  tipoSociedad?: string;
  ejercicioInicio?: string; // MM-DD
  ejercicioFin?: string; // MM-DD
  obligaLibroSocios?: boolean;
  obligaLibroContratos?: boolean;
  registroMercantilProvincia?: string | null;
  denominacion?: string | null;
  nif?: string | null;
  domicilioSocial?: string | null;
  codigoPostal?: string | null;
  municipio?: string | null;
  provincia?: string | null;
  actividad?: string | null;
  cnae?: string | null;
  datosRegistrales?: string | null;
  fechaConstitucion?: string | null;
  registroTomo?: string | null;
  registroFolio?: string | null;
  registroHoja?: string | null;
  registroInscripcion?: string | null;
  telefono?: string | null;
  email?: string | null;
  web?: string | null;
  pais?: string;
}

const TEXTOS = [
  'registroMercantilProvincia',
  'denominacion',
  'nif',
  'domicilioSocial',
  'codigoPostal',
  'municipio',
  'provincia',
  'actividad',
  'cnae',
  'datosRegistrales',
  'fechaConstitucion',
  'registroTomo',
  'registroFolio',
  'registroHoja',
  'registroInscripcion',
  'telefono',
  'email',
  'web',
] as const;
// AUTONOMO: empresario individual (no se inscribe en el Registro Mercantil).
const TIPOS_SOCIEDAD = ['SA', 'SL', 'SLU', 'SCP', 'AUTONOMO', 'OTRA'];
/** Formas que se inscriben en el Registro Mercantil (deben llevar los datos registrales). */
export const INSCRIBIBLES = ['SA', 'SL', 'SLU'];
/** Largo maximo de los campos de texto corto (VARCHAR(191) en MySQL). */
export const TEXTO_MAX = 191;

/** Campos que faltan para que la empresa pueda facturar con todos los datos. */
export function camposPendientesEmpresa(cfg: Record<string, unknown> | null): string[] {
  const vacio = (k: string) => !String(cfg?.[k] ?? '').trim();
  const espana = String(cfg?.pais ?? 'ES').toUpperCase() === 'ES';
  const faltan: string[] = [];
  for (const [k, nombre] of [
    ['denominacion', 'Denominación o nombre'],
    ['nif', espana ? 'NIF' : 'Identificación fiscal'],
    ['domicilioSocial', 'Domicilio'],
    ['codigoPostal', 'Código postal'],
    ['municipio', 'Municipio'],
    ...(espana ? ([['provincia', 'Provincia']] as const) : []),
  ] as const) {
    if (vacio(k)) faltan.push(nombre);
  }
  // El Registro Mercantil espanol solo se exige a sociedades espanolas.
  if (espana && INSCRIBIBLES.includes(String(cfg?.tipoSociedad ?? 'SL'))) {
    for (const [k, nombre] of [
      ['registroMercantilProvincia', 'Registro Mercantil (provincia)'],
      ['registroTomo', 'Tomo'],
      ['registroFolio', 'Folio'],
      ['registroHoja', 'Hoja'],
      ['registroInscripcion', 'Inscripción'],
    ] as const) {
      if (vacio(k)) faltan.push(nombre);
    }
  }
  return faltan;
}

/** "Inscrita en el Registro Mercantil de X, Tomo T, Folio F, Hoja H, Inscripción I" o null. */
export function textoInscripcionRegistral(cfg: Record<string, unknown> | null): string | null {
  if (!cfg) return null;
  const v = (k: string) => String(cfg[k] ?? '').trim();
  // Fuera de Espana: el texto libre de datos registrales, tal cual.
  if (String(cfg.pais ?? 'ES').toUpperCase() !== 'ES') return v('datosRegistrales') || null;
  if (!INSCRIBIBLES.includes(String(cfg.tipoSociedad ?? ''))) return null;
  const partes = [
    v('registroTomo') && `Tomo ${v('registroTomo')}`,
    v('registroFolio') && `Folio ${v('registroFolio')}`,
    v('registroHoja') && `Hoja ${v('registroHoja')}`,
    v('registroInscripcion') && `Inscripción ${v('registroInscripcion')}`,
  ].filter(Boolean);
  if (!partes.length) return v('datosRegistrales') ? `Datos registrales: ${v('datosRegistrales')}` : null;
  const reg = v('registroMercantilProvincia');
  return `Inscrita en el Registro Mercantil${reg ? ` de ${reg}` : ''}, ${partes.join(', ')}.`;
}

/**
 * Solo los campos de la configuracion legal. Antes se guardaba el cuerpo tal
 * cual (incluidos id o companyId).
 */
export function limpiarLegalConfig(datos: Record<string, unknown>, paisActual = 'ES'): LegalConfigInput {
  const limpio: Record<string, unknown> = {};
  for (const campo of TEXTOS) {
    if (datos[campo] === undefined) continue;
    const v = datos[campo] === null ? '' : String(datos[campo]).trim();
    // Las columnas de texto son VARCHAR(191) (lo que Prisma pone por defecto en
    // MySQL); antes se cortaba a 300 y un texto largo acababa en un error 500.
    limpio[campo] = v === '' ? null : v.slice(0, campo === 'actividad' ? 2000 : TEXTO_MAX);
  }
  if (datos.tipoSociedad !== undefined) {
    const t = String(datos.tipoSociedad).toUpperCase();
    if (!TIPOS_SOCIEDAD.includes(t)) {
      throw badRequest(`tipoSociedad debe ser uno de: ${TIPOS_SOCIEDAD.join(', ')}.`, { campo: 'tipoSociedad' });
    }
    limpio.tipoSociedad = t;
  }
  for (const campo of ['ejercicioInicio', 'ejercicioFin'] as const) {
    if (datos[campo] === undefined) continue;
    const v = String(datos[campo]);
    if (!/^\d{2}-\d{2}$/.test(v)) throw badRequest(`${campo} tiene que tener el formato MM-DD.`, { campo });
    limpio[campo] = v;
  }
  for (const campo of ['obligaLibroSocios', 'obligaLibroContratos'] as const) {
    if (datos[campo] !== undefined) limpio[campo] = Boolean(datos[campo]);
  }
  // CNAE-2025 (obligatorio en los depositos desde el 29/05/2026): codigo de 2 a
  // 4 cifras, con o sin punto (47.11 o 4711). Se guarda sin punto.
  if (typeof limpio.cnae === 'string') {
    const cnae = (limpio.cnae as string).replace(/\./g, '');
    if (!/^\d{2,4}$/.test(cnae)) {
      throw badRequest('El CNAE tiene que ser un código CNAE-2025 de 2 a 4 cifras (por ejemplo 4711).', { campo: 'cnae' });
    }
    limpio.cnae = cnae;
  }
  if (typeof limpio.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio.email as string)) {
    throw badRequest('El email de la empresa no es válido.', { campo: 'email' });
  }
  if (datos.pais !== undefined) {
    const pais = String(datos.pais).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(pais)) throw badRequest('El país tiene que ser un código de dos letras (ES, MA, US...).', { campo: 'pais' });
    limpio.pais = pais;
  }
  const espana = (limpio.pais ?? paisActual) === 'ES';
  if (espana && typeof limpio.codigoPostal === 'string' && !/^\d{5}$/.test(limpio.codigoPostal as string)) {
    throw badRequest('El código postal tiene que tener 5 cifras.', { campo: 'codigoPostal' });
  }
  if (typeof limpio.nif === 'string') limpio.nif = (limpio.nif as string).toUpperCase().replace(/[\s-]/g, '');
  if (typeof limpio.fechaConstitucion === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(limpio.fechaConstitucion as string)) {
    throw badRequest('fechaConstitucion tiene que tener el formato AAAA-MM-DD.', { campo: 'fechaConstitucion' });
  }
  return limpio as LegalConfigInput;
}

/** La config sin los bytes del logo (no viajan en el JSON): solo si hay logo. */
function sinLogo<T extends { logo?: unknown; logoMime?: string | null }>(cfg: T) {
  const { logo, logoMime, ...resto } = cfg;
  void logoMime;
  const pendientes = camposPendientesEmpresa(resto as Record<string, unknown>);
  // `completo`: la app pide estos datos al entrar en la empresa hasta que esten.
  return { ...resto, tieneLogo: !!logo, completo: pendientes.length === 0, pendientes };
}

const LOGO_MAX = 1024 * 1024;

/** Tipo real del fichero por su cabecera (no fiarse de la extension ni del navegador). */
function tipoImagen(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export const legalConfigService = {
  /** Devuelve la config legal de la empresa, creándola con valores por defecto si no existe. */
  async obtener(companyId: string) {
    const existente = await prisma.legalConfig.findUnique({ where: { companyId } });
    if (existente) return sinLogo(existente);
    return sinLogo(await prisma.legalConfig.create({ data: { companyId } }));
  },

  async actualizar(companyId: string, datos: Record<string, unknown>) {
    const actual = await prisma.legalConfig.findUnique({ where: { companyId }, select: { pais: true } });
    const limpio = limpiarLegalConfig(datos ?? {}, actual?.pais ?? 'ES');
    delete (limpio as Record<string, unknown>).logo;
    delete (limpio as Record<string, unknown>).logoMime;
    return sinLogo(
      await prisma.legalConfig.upsert({
        where: { companyId },
        update: limpio,
        create: { companyId, ...limpio },
      }),
    );
  },

  /** Guarda el logo de la empresa (PNG o JPG, hasta 1 MB). */
  async guardarLogo(companyId: string, fichero: Buffer | undefined) {
    if (!fichero?.length) throw badRequest('Elige una imagen PNG o JPG.');
    if (fichero.length > LOGO_MAX) throw badRequest('El logo no puede pasar de 1 MB.');
    const mime = tipoImagen(fichero);
    if (!mime) throw badRequest('El logo tiene que ser una imagen PNG o JPG.');
    await prisma.legalConfig.upsert({
      where: { companyId },
      update: { logo: fichero, logoMime: mime },
      create: { companyId, logo: fichero, logoMime: mime },
    });
  },

  async obtenerLogo(companyId: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const cfg = await prisma.legalConfig.findUnique({ where: { companyId }, select: { logo: true, logoMime: true } });
    return cfg?.logo && cfg.logoMime ? { bytes: Buffer.from(cfg.logo), mime: cfg.logoMime } : null;
  },

  async borrarLogo(companyId: string) {
    await prisma.legalConfig.updateMany({ where: { companyId }, data: { logo: null, logoMime: null } });
  },
};
