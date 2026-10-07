import 'express';

export interface AuthUser {
  userId: string;
  email?: string;
  /** Roles del usuario en TODAS sus empresas (union). Solo para tokens antiguos y rutas sin empresa. */
  roles: string[];
  /** Roles por empresa: authorize usa los de la empresa de la ruta (req.companyId). */
  rolesPorEmpresa?: Record<string, string[]>;
  /** Ids de las empresas a las que el usuario tiene acceso. */
  companies: string[];
  /** Admin global de plataforma: acceso a todas las empresas + administracion. */
  esAdminGlobal?: boolean;
  /** Empresa seleccionada en el login (si se envio empresaCodigo). */
  empresaSeleccionada?: string;
  /** Huella de la contrasena con la que se emitio el token (claim `pwd`). */
  huellaContrasena?: string;
  /**
   * true cuando authMiddleware ya ha cambiado lo que decia el token por lo que
   * dice la BD (activo, empresas, roles y modo administrador actuales).
   */
  sesionVerificada?: boolean;
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
