import 'express';

export interface AuthUser {
  userId: string;
  email?: string;
  /** Roles del usuario (admin, contable, ventas, solo_lectura). */
  roles: string[];
  /** Ids de las empresas a las que el usuario tiene acceso. */
  companies: string[];
  /** Admin global de plataforma: acceso a todas las empresas + administracion. */
  esAdminGlobal?: boolean;
  /** Empresa seleccionada en el login (si se envio empresaCodigo). */
  empresaSeleccionada?: string;
  [key: string]: unknown;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      companyId?: string;
    }
  }
}
