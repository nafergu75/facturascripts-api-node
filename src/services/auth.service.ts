import jwt from 'jsonwebtoken';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { config } from '../config/env';
import { prisma } from '../config/database';
import { verifyPassword } from '../utils/password';
import { unauthorized } from '../utils/http-errors';
import { permisosDeRoles } from './rbac.service';

/** El admin global lo puede todo; el resto, lo que den sus roles. */
function permisosEfectivos(roles: string[], esAdminGlobal: boolean): string[] {
  return esAdminGlobal ? ['*'] : permisosDeRoles(roles);
}

/** Agrupa las membresias del usuario: { companyId: [roles] }. */
export function rolesPorEmpresaDe(memberships: Array<{ companyId: string; role: unknown }>): Record<string, string[]> {
  const mapa: Record<string, string[]> = {};
  for (const m of memberships) {
    const roles = (mapa[m.companyId] ??= []);
    const rol = String(m.role);
    if (!roles.includes(rol)) roles.push(rol);
  }
  return mapa;
}

/**
 * Huella de la contrasena que viaja en los tokens (claim `pwd`): 16 caracteres
 * de un HMAC del hash guardado, con el secreto de los JWT. No revela nada de la
 * contrasena, pero cambia en cuanto se cambia: asi, restablecer la contrasena
 * deja sin valor los tokens emitidos antes (los de acceso y los de refresco).
 */
export function huellaContrasena(passwordHash: string): string {
  return createHmac('sha256', config.jwtSecret).update(passwordHash).digest('hex').slice(0, 16);
}

/** Compara dos huellas sin dar pistas por el tiempo que tarda. */
export function mismaHuella(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Estado ACTUAL del usuario en la BD: con esto se decide cada peticion, no con el token. */
export interface SesionBd {
  activo: boolean;
  esAdminGlobal: boolean;
  huellaContrasena: string;
  companies: string[];
  roles: string[];
  rolesPorEmpresa: Record<string, string[]>;
}

/**
 * Lee de la BD lo que el token solo "recuerda" del momento del login: si el
 * usuario sigue activo, si es administrador global, sus empresas con su rol y
 * la huella de su contrasena. null si el usuario no existe.
 */
export async function sesionDeBd(userId: string): Promise<SesionBd | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, isGlobalAdmin: true, passwordHash: true, memberships: { select: { companyId: true, role: true } } },
  });
  if (!u) return null;
  return {
    activo: u.isActive,
    esAdminGlobal: u.isGlobalAdmin,
    huellaContrasena: huellaContrasena(u.passwordHash),
    companies: u.memberships.map((m) => m.companyId),
    roles: Array.from(new Set(u.memberships.map((m) => String(m.role)))),
    rolesPorEmpresa: rolesPorEmpresaDe(u.memberships),
  };
}

/** Permisos por empresa, para que el frontend sepa que puede hacer en cada una. */
function permisosPorEmpresaDe(porEmpresa: Record<string, string[]>, esAdminGlobal: boolean): Record<string, string[]> {
  return Object.fromEntries(Object.entries(porEmpresa).map(([id, roles]) => [id, permisosEfectivos(roles, esAdminGlobal)]));
}

export interface LoginInput {
  email: string;
  password: string;
  /** "Codigo de acceso" de empresa (opcional). Si se envia, valida acceso a ESA
   *  empresa y la marca como seleccionada en la respuesta/token. Si NO se envia,
   *  se devuelve la lista de empresas para que el front elija. */
  empresaCodigo?: string;
}

/** Claims que viajan dentro del JWT de acceso. */
export interface AuthClaims {
  userId: string;
  email: string;
  roles: string[];
  /** Roles por empresa. Sin esto, admin en una empresa seria admin en todas. */
  rolesPorEmpresa?: Record<string, string[]>;
  companies: string[];
  /** Admin global de plataforma: acceso a todas las empresas + administracion. */
  esAdminGlobal?: boolean;
  /** Empresa seleccionada en el login (si se envio empresaCodigo). */
  empresaSeleccionada?: string;
  /** Huella de la contrasena (huellaContrasena): el token deja de valer si se cambia. */
  huellaContrasena?: string;
}

export interface EmpresaLogin {
  companyId: string;
  codigo: string | null;
  nombre: string;
}

export interface LoginResult {
  token: string;
  /** Token de refresco (7 dias) para POST /auth/refresh. */
  refreshToken: string;
  user: {
    id: string;
    email: string;
    roles: string[];
    companies: string[];
    esAdminGlobal: boolean;
    /**
     * Permisos efectivos (misma tabla que usa authorize). El frontend filtra el
     * menu con ellos: `roles` son nombres de rol ('contable'), no permisos.
     */
    permisos: string[];
    /** Permisos efectivos en cada empresa del usuario. */
    permisosPorEmpresa: Record<string, string[]>;
    /** Roles en cada empresa (para mostrar "Contable", "Ventas"... en el menu). */
    rolesPorEmpresa: Record<string, string[]>;
  };
  empresas: EmpresaLogin[];
  empresaSeleccionada?: string;
}

export const authService = {
  async login(input: LoginInput): Promise<LoginResult> {
    const user = input?.email
      ? await prisma.user.findUnique({
          where: { email: input.email },
          include: { memberships: { include: { company: true } } },
        })
      : null;

    // TODO: passwords hasheadas con scrypt (utils/password). Migrable a bcrypt.
    if (!user || !user.isActive || !verifyPassword(input.password ?? '', user.passwordHash)) {
      throw unauthorized('Credenciales invalidas.');
    }

    const esAdminGlobal = user.isGlobalAdmin;
    const companies = user.memberships.map((m) => m.companyId);
    const roles = Array.from(new Set(user.memberships.map((m) => String(m.role))));
    const empresas: EmpresaLogin[] = user.memberships.map((m) => ({
      companyId: m.companyId,
      codigo: m.company.codigo,
      nombre: m.company.name,
    }));

    // Seccion 5 — empresaCodigo opcional: valida acceso a esa empresa concreta.
    let empresaSeleccionada: string | undefined;
    if (input.empresaCodigo) {
      const elegida = empresas.find((e) => e.codigo === input.empresaCodigo);
      if (!elegida && !esAdminGlobal) {
        throw unauthorized(`El usuario no tiene acceso a la empresa '${input.empresaCodigo}'.`);
      }
      empresaSeleccionada = elegida?.companyId;
    }

    const rolesPorEmpresa = rolesPorEmpresaDe(user.memberships);
    const huella = huellaContrasena(user.passwordHash);
    const token = this.generateToken({
      userId: user.id,
      email: user.email,
      roles,
      rolesPorEmpresa,
      companies,
      esAdminGlobal,
      empresaSeleccionada,
      huellaContrasena: huella,
    });
    const refreshToken = this.signRefreshToken(user.id, user.passwordHash);

    return {
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        roles,
        companies,
        esAdminGlobal,
        // Permisos en la empresa activa (la seleccionada o la primera), no la union.
        permisos: permisosEfectivos(rolesPorEmpresa[empresaSeleccionada ?? companies[0]] ?? [], esAdminGlobal),
        permisosPorEmpresa: permisosPorEmpresaDe(rolesPorEmpresa, esAdminGlobal),
        rolesPorEmpresa,
      },
      empresas,
      empresaSeleccionada,
    };
  },

  /**
   * Emite un nuevo access token a partir de un refresh token valido. Recarga el
   * usuario de BD (roles/empresas FRESCOS: revocaciones surten efecto aqui).
   * Rotacion + revocacion por jti: cada refresh consume el jti anterior (se marca
   * revocado) y emite uno nuevo. Si el mismo refresh token se reutiliza (robado +
   * original), la segunda llamada falla porque su jti ya esta en RevokedToken.
   *
   * Tambien se rechaza si la contrasena ha cambiado desde que se emitio (huella
   * `pwd`): restablecer la contrasena echa a quien la estuviera usando, aunque
   * tuviera un refresh token. Los refresh tokens sin huella (anteriores a esta
   * comprobacion) tampoco valen: obligan una vez a volver a entrar.
   */
  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(refreshToken ?? '', config.jwtSecret) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Refresh token invalido o expirado.');
    }
    if (payload.type !== 'refresh' || !payload.sub) throw unauthorized('El token no es de tipo refresh.');

    if (payload.jti) {
      const revocado = await prisma.revokedToken.findUnique({ where: { jti: payload.jti } });
      if (revocado) throw unauthorized('Refresh token revocado. Inicia sesion de nuevo.');
    }

    const user = await prisma.user.findUnique({
      where: { id: String(payload.sub) },
      include: { memberships: { include: { company: true } } },
    });
    if (!user || !user.isActive) throw unauthorized('Usuario inactivo o inexistente.');

    const emailDelPayload = payload.email as string | undefined;
    if (emailDelPayload && emailDelPayload !== user.email) {
      throw unauthorized('Tu email ha cambiado. Inicia sesión de nuevo.');
    }

    const huella = huellaContrasena(user.passwordHash);
    if (!mismaHuella(payload.pwd, huella)) {
      throw unauthorized('Tu contraseña ha cambiado o la sesión es antigua. Inicia sesión de nuevo.');
    }

    const esAdminGlobal = user.isGlobalAdmin;
    const companies = user.memberships.map((m) => m.companyId);
    const roles = Array.from(new Set(user.memberships.map((m) => String(m.role))));
    const empresas: EmpresaLogin[] = user.memberships.map((m) => ({ companyId: m.companyId, codigo: m.company.codigo, nombre: m.company.name }));

    // Limpieza oportunista de revocaciones ya expiradas (evita crecimiento indefinido
    // de la tabla sin necesidad de un cron dedicado).
    await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    // Revoca el jti consumido (rotacion: ya no se podra volver a usar este refresh).
    if (payload.jti && payload.exp) {
      await prisma.revokedToken.create({
        data: { jti: payload.jti, userId: user.id, expiresAt: new Date(payload.exp * 1000) },
      });
    }

    const rolesPorEmpresa = rolesPorEmpresaDe(user.memberships);
    const token = this.generateToken({ userId: user.id, email: user.email, roles, rolesPorEmpresa, companies, esAdminGlobal, huellaContrasena: huella });
    const nuevoRefresh = this.signRefreshToken(user.id, user.passwordHash);
    return {
      token,
      refreshToken: nuevoRefresh,
      user: {
        id: user.id,
        email: user.email,
        roles,
        companies,
        esAdminGlobal,
        permisos: permisosEfectivos(rolesPorEmpresa[companies[0]] ?? [], esAdminGlobal),
        permisosPorEmpresa: permisosPorEmpresaDe(rolesPorEmpresa, esAdminGlobal),
        rolesPorEmpresa,
      },
      empresas,
    };
  },

  /** Revoca un refresh token (logout). Idempotente: si ya no tiene jti o ya esta revocado, no falla. */
  async logout(refreshToken: string): Promise<void> {
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(refreshToken ?? '', config.jwtSecret) as jwt.JwtPayload;
    } catch {
      return; // token ya invalido/expirado: nada que revocar
    }
    if (!payload.jti || !payload.exp || !payload.sub) return;

    await prisma.revokedToken.upsert({
      where: { jti: payload.jti },
      create: { jti: payload.jti, userId: String(payload.sub), expiresAt: new Date(payload.exp * 1000) },
      update: {},
    });
  },

  /**
   * Firma un refresh token con jti unico (necesario para poder revocarlo
   * individualmente) y la huella de la contrasena actual. Sin passwordHash no
   * lleva huella y refresh() lo rechaza: solo sirve para cerrar sesion.
   */
  signRefreshToken(userId: string, passwordHash?: string): string {
    const pwd = passwordHash ? huellaContrasena(passwordHash) : undefined;
    return jwt.sign({ sub: userId, type: 'refresh', jti: randomUUID(), pwd }, config.jwtSecret, { expiresIn: '7d' });
  },

  /** Emite un access token firmado con los claims del usuario. */
  generateToken(user: AuthClaims, expiresIn: string | number = '24h'): string {
    return jwt.sign(
      {
        sub: user.userId,
        email: user.email,
        roles: user.roles,
        rolesPorEmpresa: user.rolesPorEmpresa,
        companies: user.companies,
        esAdminGlobal: user.esAdminGlobal ?? false,
        empresaSeleccionada: user.empresaSeleccionada,
        pwd: user.huellaContrasena,
      },
      config.jwtSecret,
      { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] },
    );
  },

  /** DEV ONLY: Login sin credenciales (para desarrollo local). Solo funciona en NODE_ENV=development. */
  async devLogin(): Promise<LoginResult> {
    if (process.env.NODE_ENV !== 'development') {
      throw unauthorized('Dev login solo disponible en desarrollo.');
    }
    const user = await prisma.user.findUnique({
      where: { email: 'demo@empresa.com' },
      include: { memberships: { include: { company: true } } },
    });
    if (!user) throw unauthorized('Usuario demo no encontrado. Ejecuta: npx prisma db seed');

    const esAdminGlobal = user.isGlobalAdmin;
    const companies = user.memberships.map((m) => m.companyId);
    const roles = Array.from(new Set(user.memberships.map((m) => String(m.role))));
    const empresas: EmpresaLogin[] = user.memberships.map((m) => ({
      companyId: m.companyId,
      codigo: m.company.codigo,
      nombre: m.company.name,
    }));
    const empresaSeleccionada = empresas[0]?.companyId;

    const rolesPorEmpresa = rolesPorEmpresaDe(user.memberships);
    const token = this.generateToken({
      userId: user.id,
      email: user.email,
      roles,
      rolesPorEmpresa,
      companies,
      esAdminGlobal,
      empresaSeleccionada,
      huellaContrasena: huellaContrasena(user.passwordHash),
    });
    const refreshToken = this.signRefreshToken(user.id, user.passwordHash);

    return {
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        roles,
        companies,
        esAdminGlobal,
        // Permisos en la empresa activa (la seleccionada o la primera), no la union.
        permisos: permisosEfectivos(rolesPorEmpresa[empresaSeleccionada ?? companies[0]] ?? [], esAdminGlobal),
        permisosPorEmpresa: permisosPorEmpresaDe(rolesPorEmpresa, esAdminGlobal),
        rolesPorEmpresa,
      },
      empresas,
      empresaSeleccionada,
    };
  },

  /**
   * Usuario de la sesion con sus permisos ACTUALES (GET /auth/me). El frontend
   * filtra el menu con los permisos que guardo al iniciar sesion; si cambian
   * (rol nuevo, arreglo de permisos) los refresca aqui sin volver a entrar.
   */
  async me(userId: string): Promise<Omit<LoginResult, 'token' | 'refreshToken'>> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { company: true } } },
    });
    if (!user || !user.isActive) throw unauthorized('Usuario inactivo o inexistente.');
    const esAdminGlobal = user.isGlobalAdmin;
    const companies = user.memberships.map((m) => m.companyId);
    const roles = Array.from(new Set(user.memberships.map((m) => String(m.role))));
    const empresas: EmpresaLogin[] = user.memberships.map((m) => ({ companyId: m.companyId, codigo: m.company.codigo, nombre: m.company.name }));
    const rolesPorEmpresa = rolesPorEmpresaDe(user.memberships);
    return {
      user: {
        id: user.id,
        email: user.email,
        roles,
        companies,
        esAdminGlobal,
        permisos: permisosEfectivos(rolesPorEmpresa[companies[0]] ?? [], esAdminGlobal),
        permisosPorEmpresa: permisosPorEmpresaDe(rolesPorEmpresa, esAdminGlobal),
        rolesPorEmpresa,
      },
      empresas,
    };
  },
};
