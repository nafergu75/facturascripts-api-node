import { prisma } from '../config/database';
import { CrudService, Paginated } from '../domain/common.types';
import { User } from '../domain/user.model';
import { badRequest, notFound } from '../utils/http-errors';
import { hashPassword } from '../utils/password';

type UserDb = { id: string; email: string; passwordHash: string; isActive: boolean; createdAt: Date; memberships: Array<{ companyId: string }> };

const aDom = (u: UserDb): User => ({
  id: u.id,
  email: u.email,
  passwordHash: '***', // nunca exponer el hash
  isActive: u.isActive,
  companies: u.memberships.map((m) => m.companyId),
  createdAt: u.createdAt.toISOString(),
});

/** CRUD de usuarios contra Prisma (la asignacion a empresas vive en /admin). */
export const usersService: CrudService<User> = {
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

  async create(data: Record<string, unknown>): Promise<User> {
    const email = String(data.email ?? '');
    const password = String(data.password ?? '');
    if (!email || !password) throw badRequest('email y password obligatorios.');
    const dup = await prisma.user.findUnique({ where: { email } });
    if (dup) throw badRequest(`Ya existe un usuario con email '${email}'.`);
    const u = await prisma.user.create({
      data: { email, passwordHash: hashPassword(password), isActive: true },
      include: { memberships: true },
    });
    return aDom(u);
  },

  async update(id, data: Record<string, unknown>): Promise<User> {
    const patch: { isActive?: boolean; passwordHash?: string } = {};
    if (data.isActive !== undefined) patch.isActive = data.isActive === true;
    if (data.password) patch.passwordHash = hashPassword(String(data.password));
    if (!Object.keys(patch).length) throw badRequest('Nada que actualizar (isActive, password).');
    const u = await prisma.user.update({ where: { id: String(id) }, data: patch, include: { memberships: true } });
    return aDom(u);
  },

  async remove(id): Promise<void> {
    // Baja LOGICA (isActive=false): conserva auditoria y memberships.
    await prisma.user.update({ where: { id: String(id) }, data: { isActive: false } });
  },
};
