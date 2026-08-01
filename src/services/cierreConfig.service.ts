import { CierreConfig } from '../domain/cuadreBancos.model';
import { prisma } from '../config/database';

const DEFECTO: CierreConfig = { exigirCuadreBancos: true, toleranciaCuadre: 0.01 };

export async function obtenerCierreConfig(companyId: string): Promise<CierreConfig> {
  const row = await prisma.companyCierreConfig.findUnique({ where: { companyId } });
  if (!row) return { ...DEFECTO };
  return { exigirCuadreBancos: row.exigirCuadreBancos, toleranciaCuadre: row.toleranciaCuadre };
}

export async function actualizarCierreConfig(companyId: string, patch: Partial<CierreConfig>): Promise<CierreConfig> {
  const actual = await obtenerCierreConfig(companyId);
  const nueva: CierreConfig = {
    exigirCuadreBancos: patch.exigirCuadreBancos ?? actual.exigirCuadreBancos,
    toleranciaCuadre:
      patch.toleranciaCuadre !== undefined && Number.isFinite(patch.toleranciaCuadre)
        ? patch.toleranciaCuadre
        : actual.toleranciaCuadre,
  };
  const row = await prisma.companyCierreConfig.upsert({
    where: { companyId },
    create: { companyId, ...nueva },
    update: nueva,
  });
  return { exigirCuadreBancos: row.exigirCuadreBancos, toleranciaCuadre: row.toleranciaCuadre };
}
