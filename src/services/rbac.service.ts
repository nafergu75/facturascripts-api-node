import { z } from 'zod';
import { NombreRol, Permiso } from '../domain/rbac.model';
import { logger } from '../config/logger';
import { badRequest } from '../utils/http-errors';

/** Catalogo de permisos del sistema (semilla en codigo). */
export const PERMISOS: Permiso[] = [
  { id: 'p1', code: 'contabilidad:read' },
  { id: 'p2', code: 'contabilidad:write' },
  { id: 'p3', code: 'tesoreria:read' },
  { id: 'p4', code: 'tesoreria:write' },
  { id: 'p5', code: 'aeat:read' },
  { id: 'p6', code: 'ventas:read' },
  { id: 'p7', code: 'ventas:write' },
  { id: 'p8', code: 'config:write' },
  // Administracion de plataforma (solo admin global, ver authorize.middleware).
  { id: 'p9', code: 'admin:global' },
  { id: 'p10', code: 'admin:empresa' },
  // Modulo Impuestos (calendario fiscal, autorrelleno, presentaciones).
  { id: 'p11', code: 'impuestos:read' },
  { id: 'p12', code: 'impuestos:write' },
  // Facturas de gasto y lector de gastos.
  { id: 'p13', code: 'compras:read' },
  { id: 'p14', code: 'compras:write' },
  // Nominas y trabajadores (datos personales y salariales): solo admin y contable.
  { id: 'p15', code: 'nominas:read' },
  { id: 'p16', code: 'nominas:write' },
];

/** Permisos por rol (admin = comodin total). */
const ROL_PERMISOS: Record<NombreRol, string[]> = {
  admin: ['*'],
  contable: ['contabilidad:read', 'contabilidad:write', 'aeat:read', 'tesoreria:read', 'impuestos:read', 'impuestos:write', 'compras:read', 'compras:write', 'nominas:read', 'nominas:write'],
  ventas: ['ventas:read', 'ventas:write', 'contabilidad:read'],
  'solo-lectura': ['contabilidad:read', 'tesoreria:read', 'aeat:read', 'ventas:read', 'impuestos:read', 'compras:read'],
};

/** Devuelve los permisos (codigos) derivados de un conjunto de roles. */
export function permisosDeRoles(roles: string[]): string[] {
  const set = new Set<string>();
  for (const rol of roles) {
    // En la BD el rol es `solo_lectura` (enum de Prisma, sin guiones); aqui, `solo-lectura`.
    const permisos = ROL_PERMISOS[rol.replace(/_/g, '-') as NombreRol];
    if (permisos) permisos.forEach((p) => set.add(p));
  }
  return [...set];
}

/** Comprueba si la lista de permisos cubre el permiso necesario (soporta comodines). */
export function usuarioTienePermiso(permisos: string[], permisoNecesario: string): boolean {
  if (permisos.includes('*')) return true;
  if (permisos.includes(permisoNecesario)) return true;
  // comodin por recurso: 'contabilidad:*' cubre 'contabilidad:read'
  const [recurso] = permisoNecesario.split(':');
  return permisos.includes(`${recurso}:*`);
}

/** Lo justo del usuario autenticado para calcular sus permisos (ver AuthUser). */
export interface UsuarioConRoles {
  roles?: string[];
  rolesPorEmpresa?: Record<string, string[]>;
  /** Permisos efectivos por empresa (authMiddleware los pone desde la BD con permisosDeAcceso). */
  permisosPorEmpresa?: Record<string, string[]>;
  esAdminGlobal?: boolean;
}

/**
 * Permisos del usuario en una empresa. El admin global lo tiene todo ('*').
 *
 * Con la sesion leida de la BD (authMiddleware pone permisosPorEmpresa, calculado
 * con permisosDeAcceso) manda ese mapa, tambien lo personalizado: una empresa que
 * no esta en el mapa no da nada, y sin empresa en la ruta cuenta la union de lo
 * que tiene en todas sus empresas (nunca se cae a los roles, que ignorarian lo
 * personalizado).
 *
 * Sin el mapa (atajo de desarrollo, tests unitarios sin BD) se calcula por roles:
 * los de ESA empresa (rolesPorEmpresa) o, en tokens antiguos, la lista general.
 * La usan authorize.middleware y Carmen, para que las dos decidan igual.
 */
export function permisosEnEmpresa(user: UsuarioConRoles, companyId?: string): string[] {
  if (user.esAdminGlobal) return ['*'];
  if (user.permisosPorEmpresa) {
    if (companyId) return user.permisosPorEmpresa[companyId] ?? [];
    return [...new Set(Object.values(user.permisosPorEmpresa).flat())];
  }
  const roles = companyId && user.rolesPorEmpresa ? (user.rolesPorEmpresa[companyId] ?? []) : (user.roles ?? []);
  return permisosDeRoles(roles);
}

/**
 * Decisión de permiso: basta con UNO de los necesarios. 'admin:global' (pedido
 * solo) es exclusivo del admin global de plataforma; el admin global pasa todo
 * lo demás. Es la única regla: la usan authorize.middleware (rutas) y Carmen
 * (cada intención), para que las dos decidan exactamente igual.
 */
export function cubrePermisos(permisos: Iterable<string>, necesarios: string[], esAdminGlobal = false): boolean {
  if (necesarios.length === 1 && necesarios[0] === 'admin:global') return esAdminGlobal;
  if (esAdminGlobal) return true;
  const lista = [...permisos];
  return necesarios.some((p) => usuarioTienePermiso(lista, p));
}

/** ¿Puede el usuario, en esa empresa, con al menos uno de estos permisos? */
export function autorizado(user: UsuarioConRoles, companyId: string | undefined, necesarios: string[]): boolean {
  return cubrePermisos(permisosEnEmpresa(user, companyId), necesarios, user.esAdminGlobal === true);
}

// --- PERMISOS A MEDIDA POR USUARIO Y EMPRESA ---
//
// Al dar acceso a una empresa se elige un perfil (rol) y, si se quiere, se
// ajusta por areas. La API de administracion habla en AREAS con tres niveles,
// nunca en codigos: el cliente no puede mandar un codigo suelto ('*',
// 'admin:global', 'admin:empresa', 'config:write'...). El servidor traduce las
// areas a codigos y guarda la lista canonica en Membership.permisosPersonalizados.
// El perfil Administrador ('*') y el admin global no se recortan nunca.

export type Area = 'ventas' | 'compras' | 'contabilidad' | 'tesoreria' | 'impuestos' | 'nominas';
export type Nivel = 'ninguno' | 'ver' | 'modificar';
export type Areas = Record<Area, Nivel>;

export interface DefArea {
  clave: Area;
  /** Texto de pantalla. */
  nombre: string;
  /** Una linea, sin jerga. */
  descripcion: string;
  /** Codigos que da "Ver" (el primero es el principal). */
  ver: string[];
  /** Codigos que ANADE "Modificar" (ademas de los de ver). */
  modificar: string[];
}

/** Orden = orden de la matriz en pantalla. */
export const AREAS: readonly DefArea[] = [
  { clave: 'ventas', nombre: 'Ventas', descripcion: 'Clientes, productos, facturas de venta y proformas.', ver: ['ventas:read'], modificar: ['ventas:write'] },
  { clave: 'compras', nombre: 'Compras', descripcion: 'Proveedores, facturas de gasto y bandeja de documentos.', ver: ['compras:read'], modificar: ['compras:write'] },
  { clave: 'contabilidad', nombre: 'Contabilidad', descripcion: 'Asientos, plan contable, informes, cierres y libros.', ver: ['contabilidad:read'], modificar: ['contabilidad:write'] },
  { clave: 'tesoreria', nombre: 'Tesorería', descripcion: 'Cuentas del banco, cobros y pagos, extractos y conciliación.', ver: ['tesoreria:read'], modificar: ['tesoreria:write'] },
  { clave: 'impuestos', nombre: 'Impuestos (incluye AEAT)', descripcion: 'Modelos de impuestos, calendario y ficheros para Hacienda.', ver: ['impuestos:read', 'aeat:read'], modificar: ['impuestos:write'] },
  { clave: 'nominas', nombre: 'Nóminas', descripcion: 'Trabajadores, nóminas y coste de personal (datos personales).', ver: ['nominas:read'], modificar: ['nominas:write'] },
];

export const NIVELES: readonly Nivel[] = ['ninguno', 'ver', 'modificar'];

/** Los unicos codigos que puede tener un acceso personalizado (13). */
export const PERMISOS_PERSONALIZABLES: ReadonlySet<string> = new Set(AREAS.flatMap((a) => [...a.ver, ...a.modificar]));

/** Nunca personalizables: solo los da el perfil Administrador ('*') o el admin global. */
export const PERMISOS_SOLO_ADMINISTRADOR = ['*', 'admin:global', 'admin:empresa', 'config:write'] as const;

const nivelZod = z.enum(['ninguno', 'ver', 'modificar']);

/** Esquema Zod de la matriz: las 6 areas, ni una mas ni una menos. */
export const esquemaAreas = z
  .object({
    ventas: nivelZod,
    compras: nivelZod,
    contabilidad: nivelZod,
    tesoreria: nivelZod,
    impuestos: nivelZod,
    nominas: nivelZod,
  })
  .strict();

/** Codigos de la matriz, ordenados y sin duplicados (forma canonica). Modificar ya incluye Ver. */
export function permisosDeAreas(areas: Areas): string[] {
  const set = new Set<string>();
  for (const a of AREAS) {
    const nivel = areas[a.clave];
    if (nivel === 'ver' || nivel === 'modificar') a.ver.forEach((p) => set.add(p));
    if (nivel === 'modificar') a.modificar.forEach((p) => set.add(p));
  }
  return [...set].sort();
}

/**
 * Nivel de cada area segun una lista de codigos: 'modificar' si estan todos sus
 * codigos de modificar y el principal de ver; 'ver' si esta el principal de
 * ver; si no, 'ninguno'. Con '*' todo es 'modificar'.
 */
export function areasDePermisos(codigos: Iterable<string>): Areas {
  const lista = new Set(codigos);
  const todo = lista.has('*');
  const areas = {} as Areas;
  for (const a of AREAS) {
    const ve = todo || lista.has(a.ver[0]);
    const modifica = ve && (todo || a.modificar.every((p) => lista.has(p)));
    areas[a.clave] = modifica ? 'modificar' : ve ? 'ver' : 'ninguno';
  }
  return areas;
}

/** 'solo-lectura' -> 'solo_lectura' (como lo guarda la BD). */
export function rolNormalizado(rol: string): string {
  return String(rol).trim().replace(/-/g, '_');
}

/** Areas de un perfil fijo; null para el Administrador ("todo"). */
export function areasDePerfil(rol: string): Areas | null {
  const r = rolNormalizado(rol);
  if (r === 'admin') return null;
  return areasDePermisos(permisosDeRoles([r]));
}

/**
 * Lee la columna permisosPersonalizados. null/undefined = los del perfil. Un
 * array de textos se limpia: solo los personalizables y con las implicaciones
 * aplicadas (Modificar implica Ver, asi que un 'ventas:write' suelto da
 * tambien 'ventas:read'; un 'aeat:read' suelto o un 'ventas:*' se caen).
 * Cualquier otro valor (manipulado a mano o corrupto) cierra el paso: sin
 * permisos de area.
 */
export function leerPersonalizados(valor: unknown): string[] | null {
  if (valor === null || valor === undefined) return null;
  if (!Array.isArray(valor) || !valor.every((v) => typeof v === 'string')) {
    logger.warn('permisosPersonalizados con formato no válido');
    return [];
  }
  const lista = new Set((valor as string[]).filter((p) => PERMISOS_PERSONALIZABLES.has(p)));
  const areas = {} as Areas;
  for (const a of AREAS) {
    areas[a.clave] = a.modificar.some((p) => lista.has(p)) ? 'modificar' : lista.has(a.ver[0]) ? 'ver' : 'ninguno';
  }
  return permisosDeAreas(areas);
}

/** Acceso de un usuario a una empresa, tal como sale de la BD. */
export interface AccesoConPermisos {
  role: unknown;
  permisosPersonalizados?: unknown;
}

/**
 * LA funcion que decide los permisos de un acceso (sesion, login, refresh,
 * /auth/me, Carmen y panel). Admin global: '*'. Sin acceso: nada. Perfil
 * Administrador: '*' (lo personalizado se ignora). Personalizado: esa lista.
 * Si no, los del perfil.
 */
export function permisosDeAcceso(acceso: AccesoConPermisos | undefined, esAdminGlobal: boolean): string[] {
  if (esAdminGlobal) return ['*'];
  if (!acceso) return [];
  const rol = rolNormalizado(String(acceso.role));
  if (rol === 'admin') return ['*'];
  const personalizados = leerPersonalizados(acceso.permisosPersonalizados);
  if (personalizados !== null) return personalizados;
  return permisosDeRoles([rol]);
}

type MembresiaConPermisos = AccesoConPermisos & { companyId: string };

/** { companyId: permisos efectivos }. Dos membresias de la misma empresa (tests) se unen. */
export function permisosPorEmpresaDe(memberships: MembresiaConPermisos[], esAdminGlobal: boolean): Record<string, string[]> {
  const mapa: Record<string, string[]> = {};
  for (const m of memberships) {
    const previos = mapa[m.companyId] ?? [];
    mapa[m.companyId] = [...new Set([...previos, ...permisosDeAcceso(m, esAdminGlobal)])];
  }
  return mapa;
}

/** { companyId: true si el acceso esta personalizado }. El perfil Administrador nunca lo esta. */
export function personalizadoPorEmpresaDe(memberships: MembresiaConPermisos[]): Record<string, boolean> {
  const mapa: Record<string, boolean> = {};
  for (const m of memberships) {
    const personalizado = rolNormalizado(String(m.role)) !== 'admin' && leerPersonalizados(m.permisosPersonalizados) !== null;
    mapa[m.companyId] = (mapa[m.companyId] ?? false) || personalizado;
  }
  return mapa;
}

/**
 * Lo que se guarda en la columna al dar o cambiar un acceso. null = los del
 * perfil (tambien si las areas coinciden con el perfil). Errores 400 con
 * `campo: 'areas'`: el Administrador no se personaliza y no se puede dejar todo
 * sin marcar.
 */
export function canonizarParaGuardar(rol: string, areas: Areas | null): string[] | null {
  if (areas === null) return null;
  const r = rolNormalizado(rol);
  if (r === 'admin') {
    throw badRequest('El perfil Administrador siempre tiene todos los permisos; no se puede personalizar.', { campo: 'areas' });
  }
  const lista = permisosDeAreas(areas);
  if (lista.length === 0) throw badRequest('Marca al menos un permiso, o no le des acceso a la empresa.', { campo: 'areas' });
  const delPerfil = [...permisosDeRoles([r])].sort();
  if (lista.length === delPerfil.length && lista.every((p, i) => p === delPerfil[i])) return null;
  return lista;
}
