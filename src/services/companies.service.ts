import { prisma } from '../config/database';

export interface EmpresaUsuario {
  id: string;
  name: string;
  isActive: boolean;
  role: string;
}

/** Empresas a las que el usuario tiene acceso (via memberships). */
export async function listarEmpresasUsuario(userId: string): Promise<EmpresaUsuario[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { company: true },
  });
  return memberships.map((m) => ({
    id: m.company.id,
    name: m.company.name,
    isActive: m.company.isActive,
    role: String(m.role),
  }));
}

/** Datos publicos de una empresa (sin exponer la API Key cifrada). */
export async function obtenerEmpresa(companyId: string): Promise<{ id: string; name: string; fsBaseUrl: string; isActive: boolean } | null> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, fsBaseUrl: true, isActive: true },
  });
  return c;
}
