import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { esPaisEspana } from '../domain/perfil-empresa.model';
import { esPaisUe } from '../domain/tipo-operacion.model';
import { monedasCuentaPermitidas, validarMonedaCuenta } from '../domain/divisas';

export { esPaisEspana };
export { esEmpresaEspanola, monedaDeCuenta, perfilEmpresa } from './perfilEmpresa.service';

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
  /** Moneda de la contabilidad (EUR o USD). Ver actualizar(). */
  monedaCuenta?: string;
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
const INSCRIBIBLES = ['SA', 'SL', 'SLU'];

/** Campos que faltan para que la empresa pueda facturar con todos los datos. */
export function camposPendientesEmpresa(cfg: Record<string, unknown> | null): string[] {
  const vacio = (k: string) => !String(cfg?.[k] ?? '').trim();
  const espana = esPaisEspana(cfg?.pais as string | null | undefined);
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
    limpio[campo] = v === '' ? null : v.slice(0, campo === 'actividad' ? 2000 : 300);
  }
  if (datos.tipoSociedad !== undefined) {
    const t = String(datos.tipoSociedad).toUpperCase();
    if (!TIPOS_SOCIEDAD.includes(t)) throw badRequest(`tipoSociedad debe ser uno de: ${TIPOS_SOCIEDAD.join(', ')}.`);
    limpio.tipoSociedad = t;
  }
  for (const campo of ['ejercicioInicio', 'ejercicioFin'] as const) {
    if (datos[campo] === undefined) continue;
    const v = String(datos[campo]);
    if (!/^\d{2}-\d{2}$/.test(v)) throw badRequest(`${campo} tiene que tener el formato MM-DD.`);
    limpio[campo] = v;
  }
  for (const campo of ['obligaLibroSocios', 'obligaLibroContratos'] as const) {
    if (datos[campo] !== undefined) limpio[campo] = Boolean(datos[campo]);
  }
  // CNAE-2025 (obligatorio en los depositos desde el 29/05/2026): codigo de 2 a
  // 4 cifras, con o sin punto (47.11 o 4711). Se guarda sin punto.
  if (typeof limpio.cnae === 'string') {
    const cnae = (limpio.cnae as string).replace(/\./g, '');
    if (!/^\d{2,4}$/.test(cnae)) throw badRequest('El CNAE tiene que ser un código CNAE-2025 de 2 a 4 cifras (por ejemplo 4711).');
    limpio.cnae = cnae;
  }
  if (typeof limpio.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio.email as string)) {
    throw badRequest('El email de la empresa no es válido.');
  }
  if (datos.pais !== undefined) {
    const pais = String(datos.pais).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(pais)) throw badRequest('El país tiene que ser un código de dos letras (ES, MA, US...).');
    limpio.pais = pais;
  }
  const espana = (limpio.pais ?? paisActual) === 'ES';
  if (espana && typeof limpio.codigoPostal === 'string' && !/^\d{5}$/.test(limpio.codigoPostal as string)) {
    throw badRequest('El código postal tiene que tener 5 cifras.');
  }
  if (typeof limpio.nif === 'string') limpio.nif = (limpio.nif as string).toUpperCase().replace(/[\s-]/g, '');
  if (typeof limpio.fechaConstitucion === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(limpio.fechaConstitucion as string)) {
    throw badRequest('fechaConstitucion tiene que tener el formato AAAA-MM-DD.');
  }
  if (datos.monedaCuenta !== undefined && datos.monedaCuenta !== null && datos.monedaCuenta !== '') {
    limpio.monedaCuenta = validarMonedaCuenta(datos.monedaCuenta, String(limpio.pais ?? paisActual));
  }
  return limpio as LegalConfigInput;
}

/**
 * Moneda de cuenta por defecto segun el pais: euros en Espana y en la UE; en el
 * resto (EE. UU., Hong Kong...), dolares.
 */
export function monedaCuentaPorPais(pais: string): string {
  return esPaisEspana(pais) || esPaisUe(pais) ? 'EUR' : 'USD';
}

/**
 * Decide la moneda de cuenta tras guardar la configuracion:
 *  - con facturas o asientos, el pais no pasa de Espana a otro ni al reves: el
 *    IVA, el idioma y los modelos de lo ya emitido dependen de ello;
 *  - sin cambiar el pais ni la moneda, se deja como esta;
 *  - la indicada o, si cambia el pais, la de su pais (USD fuera de la UE); con
 *    documentos, la que ya habia. Tiene que valer para el pais: Espana y la UE,
 *    EUR; EE. UU. y Hong Kong, USD;
 *  - no cambia si la empresa ya tiene facturas o asientos.
 */
export function decidirMonedaCuenta(opc: {
  indicada?: string;
  paisAnterior: string;
  paisNuevo: string;
  monedaActual: string;
  tieneDocumentos: boolean;
}): string {
  const { indicada, paisAnterior, paisNuevo, monedaActual, tieneDocumentos } = opc;
  const cambiaPais = paisNuevo !== paisAnterior;
  if (tieneDocumentos && cambiaPais && esPaisEspana(paisAnterior) !== esPaisEspana(paisNuevo)) {
    throw badRequest(
      esPaisEspana(paisAnterior)
        ? 'La empresa ya tiene facturas o asientos como empresa establecida en España: no se puede cambiar a otro país (sus facturas llevan IVA español y se declaran a la AEAT). Si va a operar desde otro país, dala de alta como empresa nueva.'
        : 'La empresa ya tiene facturas o asientos como empresa no establecida en España: no se puede cambiar a España. Si tiene establecimiento permanente en España, dala de alta como empresa nueva con país España.',
    );
  }
  if (!cambiaPais && (indicada === undefined || indicada === monedaActual)) return monedaActual;
  // Sin indicarla: un cambio de pais no reescribe una contabilidad con documentos.
  const nueva = indicada ?? (tieneDocumentos ? monedaActual : monedaCuentaPorPais(paisNuevo));
  if (!monedasCuentaPermitidas(paisNuevo).includes(nueva) && tieneDocumentos && nueva === monedaActual) {
    throw badRequest(
      `La contabilidad está en ${monedaActual} y la empresa ya tiene facturas o asientos: no se puede cambiar a un país que la lleva en otra moneda.`,
    );
  }
  validarMonedaCuenta(nueva, paisNuevo);
  if (nueva === monedaActual) return monedaActual;
  if (tieneDocumentos) {
    throw badRequest(
      `No se puede cambiar la moneda de la contabilidad (${monedaActual}): la empresa ya tiene facturas o asientos.`,
    );
  }
  return nueva;
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

/** La empresa ya tiene facturas o asientos: su moneda de cuenta no se puede cambiar. */
async function tieneDocumentos(companyId: string): Promise<boolean> {
  const [factura, gasto, asiento] = await Promise.all([
    prisma.incomeInvoice.findFirst({ where: { companyId }, select: { id: true } }),
    prisma.expenseInvoice.findFirst({ where: { companyId }, select: { id: true } }),
    prisma.journalEntry.findFirst({ where: { companyId }, select: { id: true } }),
  ]);
  return !!(factura || gasto || asiento);
}

export const legalConfigService = {
  /**
   * Devuelve la config legal de la empresa, creándola con valores por defecto si
   * no existe. `monedaCuentaEditable`: false si ya hay facturas o asientos (la
   * moneda de la contabilidad ya no se puede cambiar).
   */
  async obtener(companyId: string) {
    const existente =
      (await prisma.legalConfig.findUnique({ where: { companyId } })) ?? (await prisma.legalConfig.create({ data: { companyId } }));
    return { ...sinLogo(existente), monedaCuentaEditable: !(await tieneDocumentos(companyId)) };
  },

  async actualizar(companyId: string, datos: Record<string, unknown>) {
    const actual = await prisma.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true } });
    const limpio = limpiarLegalConfig(datos ?? {}, actual?.pais ?? 'ES');
    delete (limpio as Record<string, unknown>).logo;
    delete (limpio as Record<string, unknown>).logoMime;
    const paisAnterior = actual?.pais ?? 'ES';
    const paisNuevo = limpio.pais ?? paisAnterior;
    const monedaActual = actual?.monedaCuenta ?? 'EUR';
    if (limpio.monedaCuenta !== undefined || paisNuevo !== paisAnterior) {
      limpio.monedaCuenta = decidirMonedaCuenta({
        indicada: limpio.monedaCuenta,
        paisAnterior,
        paisNuevo,
        monedaActual,
        tieneDocumentos: await tieneDocumentos(companyId),
      });
    }
    const guardada = await prisma.$transaction(async (tx) => {
      const cfg = await tx.legalConfig.upsert({
        where: { companyId },
        update: limpio,
        create: { companyId, ...limpio },
      });
      // Sin facturas ni asientos se puede cambiar la moneda de la contabilidad: las
      // cuentas bancarias, que se dieron de alta en la anterior, pasan a la nueva.
      if (limpio.monedaCuenta !== undefined && limpio.monedaCuenta !== monedaActual) {
        await tx.bankAccount.updateMany({ where: { companyId, moneda: monedaActual }, data: { moneda: limpio.monedaCuenta } });
      }
      return cfg;
    });
    return { ...sinLogo(guardada), monedaCuentaEditable: !(await tieneDocumentos(companyId)) };
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
