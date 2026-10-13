/**
 * Lo que la validacion V09 (EMPRESA) necesita saber de la empresa: su NIF y,
 * por si no lo tiene, sus nombres (la denominacion de Mas > Datos de la
 * empresa y el nombre con el que se dio de alta).
 *
 * Va aparte de contexto.ts porque confirmar.ts tambien lo usa y no puede
 * importar contexto.ts (que importa ingresos-extractor.service).
 */
import { prisma } from '../../config/database';

export interface DatosEmpresaValidacion {
  nifEmpresa: string | null;
  nombresEmpresa: Array<string | null>;
}

export async function datosEmpresaValidacion(companyId: string): Promise<DatosEmpresaValidacion> {
  const [legal, company] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId }, select: { nif: true, denominacion: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
  ]);
  return {
    nifEmpresa: legal?.nif?.trim() || null,
    nombresEmpresa: [legal?.denominacion ?? null, company?.name ?? null],
  };
}
