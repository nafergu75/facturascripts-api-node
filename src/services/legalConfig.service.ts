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
] as const;
const TIPOS_SOCIEDAD = ['SA', 'SL', 'SLU', 'SCP', 'OTRA'];

/**
 * Solo los campos de la configuracion legal. Antes se guardaba el cuerpo tal
 * cual (incluidos id o companyId).
 */
export function limpiarLegalConfig(datos: Record<string, unknown>): LegalConfigInput {
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
  if (typeof limpio.nif === 'string') limpio.nif = (limpio.nif as string).toUpperCase().replace(/[\s-]/g, '');
  if (typeof limpio.fechaConstitucion === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(limpio.fechaConstitucion as string)) {
    throw badRequest('fechaConstitucion tiene que tener el formato AAAA-MM-DD.');
  }
  return limpio as LegalConfigInput;
}

export const legalConfigService = {
  /** Devuelve la config legal de la empresa, creándola con valores por defecto si no existe. */
  async obtener(companyId: string) {
    const existente = await prisma.legalConfig.findUnique({ where: { companyId } });
    if (existente) return existente;
    return prisma.legalConfig.create({ data: { companyId } });
  },

  async actualizar(companyId: string, datos: Record<string, unknown>) {
    const limpio = limpiarLegalConfig(datos ?? {});
    return prisma.legalConfig.upsert({
      where: { companyId },
      update: limpio,
      create: { companyId, ...limpio },
    });
  },
};
