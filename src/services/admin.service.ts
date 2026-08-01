import { prisma } from '../config/database';
import { encrypt } from '../utils/crypto';
import { hashPassword } from '../utils/password';
import { EmpresaAdmin, UsuarioAdmin } from '../domain/admin.model';
import { badRequest } from '../utils/http-errors';

const ROLES_VALIDOS = ['admin', 'contable', 'tesoreria', 'ventas', 'solo_lectura'];

const aEmpresaAdmin = (c: { id: string; codigo: string | null; name: string; fsBaseUrl: string; isActive: boolean; createdAt: Date }): EmpresaAdmin => ({
  id: c.id,
  codigo: c.codigo,
  nombre: c.name,
  fsBaseUrl: c.fsBaseUrl,
  activa: c.isActive,
  creadoEn: c.createdAt.toISOString(),
});

// --- EMPRESAS ---

/** Crea una empresa (instancia FS): guarda fsBaseUrl + FS_API_KEY cifrada. */
export async function crearEmpresa(data: {
  nombre: string;
  fsBaseUrl: string;
  fsApiKey: string;
  codigo?: string;
}): Promise<EmpresaAdmin> {
  if (data.codigo) {
    const dup = await prisma.company.findUnique({ where: { codigo: data.codigo } });
    if (dup) throw badRequest(`Ya existe una empresa con codigo '${data.codigo}'.`);
  }
  const c = await prisma.company.create({
    data: {
      name: data.nombre,
      codigo: data.codigo ?? null,
      fsBaseUrl: data.fsBaseUrl,
      fsApiKeyEnc: encrypt(data.fsApiKey),
      isActive: true,
    },
  });
  return aEmpresaAdmin(c);
}

export async function listarEmpresas(): Promise<EmpresaAdmin[]> {
  const cs = await prisma.company.findMany({ orderBy: { createdAt: 'asc' } });
  return cs.map(aEmpresaAdmin);
}

/** Devuelve las empresas a las que un usuario tiene acceso (via memberships). */
export async function listarEmpresasDeUsuario(userId: string): Promise<EmpresaAdmin[]> {
  const ms = await prisma.membership.findMany({ where: { userId }, include: { company: true } });
  return ms.map((m) => aEmpresaAdmin(m.company));
}

// --- USUARIOS ---

/** Crea un usuario de la plataforma (password hasheada con scrypt). Email unico. */
export async function crearUsuario(data: {
  email: string;
  password: string;
  esAdminGlobal?: boolean;
}): Promise<UsuarioAdmin> {
  const existe = await prisma.user.findUnique({ where: { email: data.email } });
  if (existe) throw badRequest(`Ya existe un usuario con email '${data.email}'.`);
  const u = await prisma.user.create({
    data: {
      email: data.email,
      passwordHash: hashPassword(data.password),
      isActive: true,
      isGlobalAdmin: data.esAdminGlobal === true, // false por defecto
    },
  });
  return { id: u.id, email: u.email, activo: u.isActive, esAdminGlobal: u.isGlobalAdmin, creadoEn: u.createdAt.toISOString() };
}

/** Asigna un usuario a una empresa con un rol (membership). */
export async function asignarUsuarioAEmpresa(userId: string, companyId: string, role: string): Promise<void> {
  if (!ROLES_VALIDOS.includes(role)) throw badRequest(`Rol invalido (${ROLES_VALIDOS.join(', ')}).`);
  await prisma.membership.upsert({
    where: { userId_companyId: { userId, companyId } },
    update: { role: role as never },
    create: { userId, companyId, role: role as never },
  });
}
