/**
 * Lo que enseña la pantalla Configuracion > VERI*FACTU (spec verifactu, 10.3;
 * plan F2, bloque E y contrato de GET /verifactu/configuracion). Solo lee.
 *
 * En la fase F2 no se activa nada: `puedeActivar` es siempre false y la
 * checklist se enseña en solo lectura.
 */
import { prisma } from '../../config/database';
import { normalizarNif } from '../../utils/nif';
import { perfilDesdeConfig } from '../perfilEmpresa.service';
import { exclusionDe, type Exclusion } from './redSeguridad';
import { metadatosCertificado, type MetadatosCertificado } from './certificado.service';
import { fechaCorta } from './certificado';
import { ID_SISTEMA, NOMBRE_SISTEMA, productor, VERSION_SIF } from './sistema';

export type ClaveChecklist = 'datos' | 'certificado' | 'conexionProduccion' | 'pruebas' | 'declaracion' | 'exclusion' | 'version';

export interface ConfiguracionVerifactu {
  /** false: empresa extranjera (VERI*FACTU no se le aplica). */
  aplica: boolean;
  empresa: {
    denominacion: string | null;
    nif: string | null;
    domicilio: { direccion: string | null; cp: string | null; municipio: string | null; provincia: string | null; pais: string | null };
    faltan: Array<'denominacion' | 'nif' | 'domicilio'>;
    /** NIF y nombre congelados con el primer registro: ya no cambian. */
    obligadoCongelado: { nif: string; nombre: string } | null;
  };
  /** Es la empresa de pruebas de otra (la real). */
  empresaPruebas: { de: { id: string; nombre: string } } | null;
  exclusion: { motivoExclusion: Exclusion | null; siiEnAjustes: boolean; posibleForal: boolean };
  estado: 'DESACTIVADO' | 'PRUEBAS' | 'ACTIVO';
  entorno: 'PRUEBAS' | 'PRODUCCION';
  activaDesde: string | null;
  certificado: MetadatosCertificado | null;
  checklist: Array<{ clave: ClaveChecklist; texto: string; cumplido: boolean; detalle: string | null }>;
  puedeActivar: false;
  sistema: { nombre: string; id: string; version: string; productor: { nombre: string; nif: string }; numeroInstalacion: string | null };
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const PROVINCIAS_FORALES = ['ALAVA', 'ARABA', 'ARABA/ALAVA', 'ALAVA/ARABA', 'GIPUZKOA', 'GUIPUZCOA', 'BIZKAIA', 'VIZCAYA', 'NAVARRA', 'NAFARROA'];
/** Prefijos de codigo postal de Alava (01), Gipuzkoa (20), Bizkaia (48) y Navarra (31). */
const CP_FORALES = ['01', '20', '48', '31'];

/** El domicilio parece del Pais Vasco o de Navarra (regimen foral): solo un aviso, lo decide el administrador. */
export function posibleForal(provincia: string | null | undefined, cp: string | null | undefined): boolean {
  if (provincia && PROVINCIAS_FORALES.includes(sinAcentos(provincia))) return true;
  const c = String(cp ?? '').trim();
  return /^\d{5}$/.test(c) && CP_FORALES.includes(c.slice(0, 2));
}

/** Version del sistema que ya se puede activar (con su declaracion responsable): la 1.0.0 o posterior. */
const versionActivable = (v: string) => Number(v.split('.')[0]) >= 1;

export async function configuracionVerifactu(companyId: string, ahora: Date = new Date()): Promise<ConfiguracionVerifactu> {
  const legal = await prisma.legalConfig.findUnique({
    where: { companyId },
    select: { pais: true, monedaCuenta: true, denominacion: true, nif: true, domicilioSocial: true, codigoPostal: true, municipio: true, provincia: true },
  });
  const ajustes = await prisma.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true } });
  const config = await prisma.verifactuConfig.findUnique({ where: { companyId } });
  const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { pruebasVerifactuDe: true } });
  const real = empresa?.pruebasVerifactuDe ? await prisma.company.findUnique({ where: { id: empresa.pruebasVerifactuDe }, select: { id: true, name: true } }) : null;
  const certificado = await metadatosCertificado(companyId, ahora);

  const aplica = perfilDesdeConfig(legal).espanola;
  const domicilio = {
    direccion: legal?.domicilioSocial ?? null,
    cp: legal?.codigoPostal ?? null,
    municipio: legal?.municipio ?? null,
    provincia: legal?.provincia ?? null,
    pais: legal?.pais ?? null,
  };
  const faltan: ConfiguracionVerifactu['empresa']['faltan'] = [];
  if (!legal?.denominacion?.trim()) faltan.push('denominacion');
  if (!legal?.nif?.trim()) faltan.push('nif');
  if (!domicilio.direccion?.trim() || !(domicilio.cp?.trim() || domicilio.municipio?.trim())) faltan.push('domicilio');

  const sii = ajustes?.sii === true;
  const motivoExclusion = exclusionDe({ sii, config: config ? { estado: config.estado, entorno: config.entorno, activaDesde: config.activaDesde, motivoExclusion: config.motivoExclusion } : null });
  const foral = posibleForal(domicilio.provincia, domicilio.cp);
  const estado = (['DESACTIVADO', 'PRUEBAS', 'ACTIVO'].includes(config?.estado ?? '') ? config!.estado : 'DESACTIVADO') as ConfiguracionVerifactu['estado'];
  const entorno = config?.entorno === 'PRODUCCION' ? 'PRODUCCION' : 'PRUEBAS';

  const vigente = !!certificado && new Date(certificado.validoDesde).getTime() <= ahora.getTime() && certificado.aviso !== 'CADUCADO';
  const prueba = certificado?.ultimaPrueba ?? null;
  const textoPrueba = prueba
    ? `Última prueba en el entorno de pruebas: ${prueba.ok ? 'correcta' : 'con error'} el ${fechaCorta(new Date(prueba.en))}.`
    : 'Todavía no se ha probado la conexión.';
  const checklist: ConfiguracionVerifactu['checklist'] = [
    {
      clave: 'datos',
      texto: 'Datos de la empresa completos (denominación, NIF y domicilio)',
      cumplido: faltan.length === 0,
      detalle: faltan.length ? 'Complétalos en Datos de la empresa.' : null,
    },
    {
      clave: 'certificado',
      texto: 'Certificado electrónico vigente',
      cumplido: vigente,
      detalle: !certificado ? 'Sube el certificado de la empresa.' : vigente ? null : 'El certificado no está vigente: sube uno nuevo.',
    },
    { clave: 'conexionProduccion', texto: 'Conexión correcta con la AEAT (entorno real)', cumplido: false, detalle: `Pendiente: la prueba en el entorno real llega con la activación. ${textoPrueba}` },
    {
      clave: 'pruebas',
      texto: 'Pruebas en el entorno de pruebas de la AEAT superadas',
      cumplido: !!config?.pruebasSuperadasEn,
      detalle: config?.pruebasSuperadasEn ? `Marcadas el ${fechaCorta(config.pruebasSuperadasEn)}.` : 'Pendiente.',
    },
    {
      clave: 'declaracion',
      texto: 'Declaración responsable del programa aceptada',
      cumplido: !!config?.declaracionVersion,
      detalle: config?.declaracionVersion ? `Versión ${config.declaracionVersion}.` : 'Llegará con la versión 1.0.0 del programa.',
    },
    {
      clave: 'exclusion',
      texto: 'La empresa no está en el SII ni en un régimen foral',
      cumplido: !motivoExclusion,
      detalle: motivoExclusion ? `Excluida por ${motivoExclusion === 'SII' ? 'el SII' : 'régimen foral'}: VERI*FACTU no se le aplica.` : null,
    },
    {
      clave: 'version',
      texto: 'Versión del programa lista para activar',
      cumplido: versionActivable(VERSION_SIF),
      detalle: versionActivable(VERSION_SIF) ? null : `La versión ${VERSION_SIF} es la de desarrollo y pruebas.`,
    },
  ];

  const p = productor();
  return {
    aplica,
    empresa: {
      denominacion: legal?.denominacion ?? null,
      nif: legal?.nif ? normalizarNif(legal.nif) : null,
      domicilio,
      faltan,
      obligadoCongelado: config?.nifObligado && config.nombreObligado ? { nif: config.nifObligado, nombre: config.nombreObligado } : null,
    },
    empresaPruebas: empresa?.pruebasVerifactuDe ? { de: { id: empresa.pruebasVerifactuDe, nombre: real?.name ?? '' } } : null,
    exclusion: { motivoExclusion, siiEnAjustes: sii, posibleForal: foral },
    estado,
    entorno,
    activaDesde: config?.activaDesde ? config.activaDesde.toISOString() : null,
    certificado,
    checklist,
    puedeActivar: false,
    sistema: { nombre: NOMBRE_SISTEMA, id: ID_SISTEMA, version: VERSION_SIF, productor: { nombre: p.nombreRazon, nif: p.nif }, numeroInstalacion: config?.numeroInstalacion ?? null },
  };
}
