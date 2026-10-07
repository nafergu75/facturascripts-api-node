/**
 * Quien tiene acceso a una empresa (Configuracion > Tu acceso y usuarios).
 * Solo lectura: la gestion (altas, roles, quitar el acceso) sigue en
 * Administracion global. Nunca devuelve hashes, tokens ni datos de otras empresas.
 */
import { prisma } from '../config/database';

export interface MiembroEmpresa {
  userId: string;
  /** La app todavia no guarda el nombre de los usuarios: siempre null (se muestra el email). */
  nombre: string | null;
  email: string;
  /** Rol en ESTA empresa, como en el enum Role de la BD: admin | contable | ventas | solo_lectura. */
  rol: string;
  /** false: la cuenta esta desactivada y no puede entrar. */
  activo: boolean;
}

export async function listarMiembros(companyId: string): Promise<MiembroEmpresa[]> {
  const membresias = await prisma.membership.findMany({
    where: { companyId },
    select: { userId: true, role: true, user: { select: { email: true, isActive: true } } },
  });
  return membresias
    .map((m) => ({ userId: m.userId, nombre: null, email: m.user.email, rol: String(m.role), activo: m.user.isActive }))
    .sort((a, b) => a.email.localeCompare(b.email));
}
