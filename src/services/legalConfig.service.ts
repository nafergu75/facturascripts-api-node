import { prisma } from '../config/database';

export interface LegalConfigInput {
  tipoSociedad?: string;
  ejercicioInicio?: string; // MM-DD
  ejercicioFin?: string; // MM-DD
  obligaLibroSocios?: boolean;
  obligaLibroContratos?: boolean;
  registroMercantilProvincia?: string | null;
}

export const legalConfigService = {
  /** Devuelve la config legal de la empresa, creándola con valores por defecto si no existe. */
  async obtener(companyId: string) {
    const existente = await prisma.legalConfig.findUnique({ where: { companyId } });
    if (existente) return existente;
    return prisma.legalConfig.create({ data: { companyId } });
  },

  async actualizar(companyId: string, datos: LegalConfigInput) {
    return prisma.legalConfig.upsert({
      where: { companyId },
      update: { ...datos },
      create: { companyId, ...datos },
    });
  },
};
