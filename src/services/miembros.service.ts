/**
 * Quien tiene acceso a una empresa (Configuracion > Tu acceso y usuarios).
 * Solo lectura: la gestion (altas, roles, quitar el acceso) esta en
 * Configuracion > Usuarios (usuariosEmpresa.service) y en Administracion global. Nunca devuelve hashes, tokens ni datos de otras empresas.
 */
import { prisma } from '../config/database';
import { accesoPersonalizado, areasDeAcceso, type Areas } from './rbac.service';

export interface MiembroEmpresa {
  userId: string;
  /** Nombre y apellidos; null en los usuarios dados de alta sin el (se muestra el email). */
  nombre: string | null;
  email: string;
  /** Rol en ESTA empresa, como en el enum Role de la BD: admin | contable | ventas | solo_lectura. */
  rol: string;
  /** false: la cuenta esta desactivada y no puede entrar. */
  activo: boolean;
  /** true: el administrador de la plataforma le ha ajustado los permisos a medida. */
  personalizado: boolean;
  /** Lo que puede en cada area (ver/modificar/ninguno); null con el perfil Administrador (todo). */
  areas: Areas | null;
}

export async function listarMiembros(companyId: string): Promise<MiembroEmpresa[]> {
  const membresias = await prisma.membership.findMany({
    where: { companyId },
    select: { userId: true, role: true, permisosPersonalizados: true, user: { select: { email: true, isActive: true, nombre: true } } },
  });
  return membresias
    .map((m) => ({
      userId: m.userId,
      nombre: m.user.nombre,
      email: m.user.email,
      rol: String(m.role),
      activo: m.user.isActive,
      personalizado: accesoPersonalizado(m),
      areas: areasDeAcceso(m),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}
