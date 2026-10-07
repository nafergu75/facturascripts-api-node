import { prisma } from '../config/database';
import { CrudService, Paginated } from '../domain/common.types';
import { User } from '../domain/user.model';
import { notFound } from '../utils/http-errors';

type UserDb = { id: string; email: string; passwordHash: string; isActive: boolean; createdAt: Date; memberships: Array<{ companyId: string }> };

const aDom = (u: UserDb): User => ({
  id: u.id,
  email: u.email,
  passwordHash: '***', // nunca exponer el hash
  isActive: u.isActive,
  companies: u.memberships.map((m) => m.companyId),
  createdAt: u.createdAt.toISOString(),
});

/**
 * Lectura de usuarios contra Prisma. Las altas, cambios y bajas van por
 * admin.service (las mismas reglas que /admin/usuarios); la asignacion a
 * empresas tambien vive en /admin.
 */
export const usersService: Pick<CrudService<User>, 'list' | 'getById'> = {
  async list(params: Record<string, unknown> = {}): Promise<Paginated<User>> {
    const limit = Math.min(Math.max(1, Number(params.limit ?? 50) || 50), 200);
    const offset = Math.max(0, Number(params.offset ?? 0) || 0);
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ include: { memberships: true }, orderBy: { createdAt: 'asc' }, take: limit, skip: offset }),
      prisma.user.count(),
    ]);
    return { items: rows.map(aDom), total, limit, offset };
  },

  async getById(id): Promise<User> {
    const u = await prisma.user.findUnique({ where: { id: String(id) }, include: { memberships: true } });
    if (!u) throw notFound('Usuario no encontrado.');
    return aDom(u);
  },
};
