import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config/env';
import { prisma } from '../config/database';
import { verifyPassword } from '../utils/password';
import { unauthorized } from '../utils/http-errors';

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
  companies: string[];
  /** Admin global de plataforma: acceso a todas las empresas + administracion. */
  esAdminGlobal?: boolean;
  /** Empresa seleccionada en el login (si se envio empresaCodigo). */
  empresaSeleccionada?: string;
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

    const token = this.generateToken({ userId: user.id, email: user.email, roles, companies, esAdminGlobal, empresaSeleccionada });
    const refreshToken = this.signRefreshToken(user.id);

    return {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, roles, companies, esAdminGlobal },
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

    const token = this.generateToken({ userId: user.id, email: user.email, roles, companies, esAdminGlobal });
    const nuevoRefresh = this.signRefreshToken(user.id);
    return { token, refreshToken: nuevoRefresh, user: { id: user.id, email: user.email, roles, companies, esAdminGlobal }, empresas };
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

  /** Firma un refresh token con jti unico (necesario para poder revocarlo individualmente). */
  signRefreshToken(userId: string): string {
    return jwt.sign({ sub: userId, type: 'refresh', jti: randomUUID() }, config.jwtSecret, { expiresIn: '7d' });
  },

  /** Emite un access token firmado con los claims del usuario. */
  generateToken(user: AuthClaims, expiresIn: string | number = '24h'): string {
    return jwt.sign(
      {
        sub: user.userId,
        email: user.email,
        roles: user.roles,
        companies: user.companies,
        esAdminGlobal: user.esAdminGlobal ?? false,
        empresaSeleccionada: user.empresaSeleccionada,
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

    const token = this.generateToken({ userId: user.id, email: user.email, roles, companies, esAdminGlobal, empresaSeleccionada });
    const refreshToken = this.signRefreshToken(user.id);

    return {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, roles, companies, esAdminGlobal },
      empresas,
      empresaSeleccionada,
    };
  },
};
