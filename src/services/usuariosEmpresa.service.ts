/**
 * Configuracion > Usuarios: el administrador de una empresa (o el global)
 * gestiona quien entra en ELLA. Montado en /companies/:companyId/usuarios.
 *
 * No duplica la administracion global: el alta, los accesos, los permisos a
 * medida y la contrasena provisional son los de admin.service (crearUsuario,
 * asignarRol, quitarAcceso, actualizarUsuario). Aqui solo se anaden las reglas
 * de quien puede hacer que desde una empresa:
 * - Solo se actua sobre usuarios con acceso a ESTA empresa (si no, 404).
 * - Al administrador global solo lo toca otro administrador global. Nadie da
 *   el modo administrador global desde aqui (el cuerpo no lo admite).
 * - La contrasena y los datos personales (nombre, telefono) son de la cuenta,
 *   no del acceso a una empresa: el administrador de empresa solo los cambia si
 *   el usuario no entra en ninguna empresa que el no administre. Si no, con la
 *   contrasena provisional podria entrar como ese usuario en las otras.
 * - Una cuenta que ya existe y hoy no entra en ninguna empresa solo la puede
 *   recibir el administrador global. Si no, al darle acceso pasaria a estar
 *   "solo en sus empresas" y el administrador de empresa podria cambiarle la
 *   contrasena y quedarse con ella.
 * - La empresa no se queda sin administrador activo (protegerUltimoAdmin).
 */
import { prisma } from '../config/database';
import type { AccesoAsignado, CatalogoPermisos } from '../domain/admin.model';
import { forbidden, notFound, conflict } from '../utils/http-errors';
import { contrasenaProvisionalCaducada } from '../utils/password';
import {
  actualizarUsuario,
  asignarRol,
  catalogoPermisos,
  conCampo,
  crearUsuario,
  normalizarEmail,
  normalizarNombrePersona,
  normalizarTelefono,
  quitarAcceso,
  type CambiosUsuario,
} from './admin.service';
import { accesoPersonalizado, areasDeAcceso, type Areas } from './rbac.service';

/** Quien hace la peticion (de req.user, que authMiddleware lee de la BD). */
export interface Actor {
  userId: string;
  esAdminGlobal: boolean;
}

/**
 * Estado de la cuenta para la lista:
 * - activo: entra con su propia contrasena;
 * - contrasena_pendiente: tiene la provisional y aun no ha puesto la suya;
 * - contrasena_caducada: la provisional ya no vale, hay que generarle otra;
 * - desactivado: el administrador global le ha cerrado la cuenta, no puede entrar.
 */
export type EstadoUsuario = 'activo' | 'contrasena_pendiente' | 'contrasena_caducada' | 'desactivado';

/** Lo que puede hacer quien pregunta con cada usuario de la lista. */
export interface AccionesPermitidas {
  editarAcceso: boolean;
  nuevaContrasena: boolean;
  quitarAcceso: boolean;
  /** Cambiar el nombre y el telefono de la cuenta (los propios, siempre). */
  datosPersonales: boolean;
}

/** Un usuario con acceso a la empresa, tal como sale en Configuracion > Usuarios. Nunca el hash. */
export interface UsuarioEmpresa {
  userId: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  /** Rol en ESTA empresa: admin | contable | ventas | solo_lectura. */
  rol: string;
  /** true: permisos ajustados a mano (nunca con el perfil Administrador). */
  personalizado: boolean;
  /** Lo que puede en cada area; null con el perfil Administrador ("todo"). */
  areas: Areas | null;
  activo: boolean;
  esAdminGlobal: boolean;
  estado: EstadoUsuario;
  /** Hasta cuando vale su contrasena provisional (ISO); null si no tiene o no caduca. */
  contrasenaProvisionalHasta: string | null;
  /** Ultima vez que entro (ISO), segun la auditoria de LOGIN; null si nunca. */
  ultimoAcceso: string | null;
  puedes: AccionesPermitidas;
}

// --- MENSAJES (403) ---

export const MENSAJE_ES_ADMIN_GLOBAL = 'Al administrador global de la plataforma solo lo puede cambiar otro administrador global.';
export const MENSAJE_CONTRASENA_OTRAS_EMPRESAS =
  'Este usuario también entra en empresas que tú no administras. Su contraseña solo se la puede cambiar el administrador global.';
export const MENSAJE_DATOS_OTRAS_EMPRESAS =
  'Este usuario también entra en empresas que tú no administras. Su nombre y su teléfono solo los puede cambiar el administrador global.';
export const MENSAJE_SIN_ACCESO = 'Ese usuario no tiene acceso a esta empresa.';
export const MENSAJE_CUENTA_SIN_EMPRESAS =
  'Este correo ya tiene usuario, pero ahora no entra en ninguna empresa. Para darle acceso, pídeselo al administrador global de la plataforma.';

// --- REGLAS (funciones puras: la lista y las acciones deciden igual) ---

/** Lo justo del usuario objetivo para decidir. */
export interface Objetivo {
  userId: string;
  esAdminGlobal: boolean;
  activo: boolean;
  rol: string;
  /** Todas las empresas en las que entra (no solo esta). */
  empresas: string[];
}

/** Empresas que administra quien pregunta; 'todas' si es administrador global. */
export type Administradas = ReadonlySet<string> | 'todas';

/** ¿Puede cambiar el acceso de este usuario a la empresa? null = si; si no, el motivo. */
export function motivoNoEditarAcceso(actor: Actor, objetivo: Objetivo): string | null {
  if (objetivo.esAdminGlobal && !actor.esAdminGlobal) return MENSAJE_ES_ADMIN_GLOBAL;
  return null;
}

/** La cuenta solo entra en empresas que administra quien pregunta. */
function cuentaEnSusEmpresas(objetivo: Objetivo, administradas: Administradas): boolean {
  return administradas === 'todas' || objetivo.empresas.every((c) => administradas.has(c));
}

/** ¿Puede generarle una contrasena provisional nueva? (La propia nunca: va por «Cambiar contraseña».) */
export function motivoNoNuevaContrasena(actor: Actor, objetivo: Objetivo, administradas: Administradas): string | null {
  const acceso = motivoNoEditarAcceso(actor, objetivo);
  if (acceso) return acceso;
  if (!cuentaEnSusEmpresas(objetivo, administradas)) return MENSAJE_CONTRASENA_OTRAS_EMPRESAS;
  return null;
}

/** ¿Puede cambiarle el nombre y el telefono? Los suyos propios, siempre: son de su cuenta. */
export function motivoNoDatosPersonales(actor: Actor, objetivo: Objetivo, administradas: Administradas): string | null {
  if (objetivo.userId === actor.userId) return null;
  const acceso = motivoNoEditarAcceso(actor, objetivo);
  if (acceso) return acceso;
  if (!cuentaEnSusEmpresas(objetivo, administradas)) return MENSAJE_DATOS_OTRAS_EMPRESAS;
  return null;
}

/** Lo que puede hacer con un usuario (la pantalla enseña u oculta los botones con esto). */
export function accionesPermitidas(actor: Actor, objetivo: Objetivo, administradas: Administradas, adminsActivos: string[]): AccionesPermitidas {
  const editarAcceso = motivoNoEditarAcceso(actor, objetivo) === null;
  const ultimoAdmin = objetivo.rol === 'admin' && adminsActivos.includes(objetivo.userId) && !adminsActivos.some((id) => id !== objetivo.userId);
  return {
    editarAcceso,
    nuevaContrasena: objetivo.userId !== actor.userId && motivoNoNuevaContrasena(actor, objetivo, administradas) === null,
    quitarAcceso: editarAcceso && !ultimoAdmin,
    datosPersonales: motivoNoDatosPersonales(actor, objetivo, administradas) === null,
  };
}

/** Estado de la cuenta (ver EstadoUsuario). */
export function estadoDe(u: { isActive: boolean; debeCambiarContrasena: boolean; contrasenaProvisionalHasta: Date | null }, ahora = new Date()): EstadoUsuario {
  if (!u.isActive) return 'desactivado';
  if (contrasenaProvisionalCaducada(u, ahora)) return 'contrasena_caducada';
  if (u.debeCambiarContrasena) return 'contrasena_pendiente';
  return 'activo';
}

// --- LECTURA ---

/** Campos de la cuenta que se leen: NUNCA el hash de la contrasena. */
const SELECT_CUENTA = {
  id: true,
  email: true,
  nombre: true,
  telefono: true,
  isActive: true,
  isGlobalAdmin: true,
  debeCambiarContrasena: true,
  contrasenaProvisionalHasta: true,
  memberships: { select: { companyId: true } },
} as const;

async function empresasAdministradas(actor: Actor): Promise<Administradas> {
  if (actor.esAdminGlobal) return 'todas';
  const propias = await prisma.membership.findMany({ where: { userId: actor.userId, role: 'admin' }, select: { companyId: true } });
  return new Set(propias.map((m) => m.companyId));
}

/** Ultimo LOGIN de cada usuario (la app no guarda otro "ultimo acceso"). */
async function ultimosAccesos(userIds: string[]): Promise<Map<string, Date>> {
  if (!userIds.length) return new Map();
  const filas = await prisma.auditLog.groupBy({
    by: ['userId'],
    where: { action: 'LOGIN', userId: { in: userIds } },
    _max: { timestamp: true },
  });
  return new Map(filas.filter((f) => f._max.timestamp).map((f) => [f.userId, f._max.timestamp as Date]));
}

/** Usuarios con acceso a la empresa (todos, o solo uno), con lo que puede hacer `actor` con cada uno. */
export async function listarUsuariosEmpresa(actor: Actor, companyId: string, soloUserId?: string): Promise<UsuarioEmpresa[]> {
  const [membresias, administradas] = await Promise.all([
    prisma.membership.findMany({
      where: { companyId },
      select: { role: true, permisosPersonalizados: true, user: { select: SELECT_CUENTA } },
    }),
    empresasAdministradas(actor),
  ]);
  const adminsActivos = membresias.filter((m) => String(m.role) === 'admin' && m.user.isActive).map((m) => m.user.id);
  const elegidas = soloUserId ? membresias.filter((m) => m.user.id === soloUserId) : membresias;
  const accesos = await ultimosAccesos(elegidas.map((m) => m.user.id));
  return elegidas
    .map((m): UsuarioEmpresa => {
      const u = m.user;
      const objetivo: Objetivo = {
        userId: u.id,
        esAdminGlobal: u.isGlobalAdmin,
        activo: u.isActive,
        rol: String(m.role),
        empresas: u.memberships.map((x) => x.companyId),
      };
      return {
        userId: u.id,
        nombre: u.nombre,
        email: u.email,
        telefono: u.telefono,
        rol: String(m.role),
        personalizado: accesoPersonalizado(m),
        areas: areasDeAcceso(m),
        activo: u.isActive,
        esAdminGlobal: u.isGlobalAdmin,
        estado: estadoDe(u),
        contrasenaProvisionalHasta: u.debeCambiarContrasena && u.contrasenaProvisionalHasta ? u.contrasenaProvisionalHasta.toISOString() : null,
        ultimoAcceso: accesos.get(u.id)?.toISOString() ?? null,
        puedes: accionesPermitidas(actor, objetivo, administradas, adminsActivos),
      };
    })
    .sort((a, b) => (a.nombre ?? a.email).localeCompare(b.nombre ?? b.email, 'es'));
}

/** Un usuario de la lista (despues de un cambio). 404 si ya no tiene acceso. */
export async function usuarioDeEmpresa(actor: Actor, companyId: string, userId: string): Promise<UsuarioEmpresa> {
  const [fila] = await listarUsuariosEmpresa(actor, companyId, userId);
  if (!fila) throw notFound(MENSAJE_SIN_ACCESO);
  return fila;
}

/** Catalogo de la matriz de permisos: el mismo que el de la administracion global. */
export function catalogoUsuariosEmpresa(): CatalogoPermisos {
  return catalogoPermisos();
}

/** Lo justo de una cuenta que ya existe para decidir si se le puede dar acceso desde la empresa. */
interface CuentaExistente {
  isGlobalAdmin: boolean;
  /** Accesos a cualquier empresa. */
  _count: { memberships: number };
}

/**
 * ¿Solo el administrador global puede darle acceso? null = no; si no, el motivo.
 * - El administrador global de la plataforma: solo lo toca otro global.
 * - Una cuenta sin ninguna empresa: si la recibiera, quedaria "solo en sus
 *   empresas" y podria cambiarle la contrasena (ver la cabecera).
 */
export function motivoNoDarAccesoACuenta(actor: Actor, cuenta: CuentaExistente): string | null {
  if (actor.esAdminGlobal) return null;
  if (cuenta.isGlobalAdmin) return MENSAJE_ES_ADMIN_GLOBAL;
  if (cuenta._count.memberships === 0) return MENSAJE_CUENTA_SIN_EMPRESAS;
  return null;
}

/**
 * Para el aviso del formulario: «Este correo ya tiene usuario: se le dará acceso
 * a esta empresa». `soloAdminGlobal` avisa antes de grabar de que desde aqui
 * no se le puede dar acceso (el alta daria un 403).
 */
export async function comprobarCorreo(
  actor: Actor,
  companyId: string,
  email: unknown,
): Promise<{ existe: boolean; yaTieneAcceso: boolean; soloAdminGlobal: boolean }> {
  const correo = conCampo('email', () => normalizarEmail(email));
  const u = await prisma.user.findUnique({
    where: { email: correo },
    select: { isGlobalAdmin: true, _count: { select: { memberships: true } }, memberships: { where: { companyId }, select: { id: true } } },
  });
  const yaTieneAcceso = !!u?.memberships.length;
  return { existe: !!u, yaTieneAcceso, soloAdminGlobal: !!u && !yaTieneAcceso && motivoNoDarAccesoACuenta(actor, u) !== null };
}

// --- ACCIONES ---

/** El usuario objetivo y lo que administra quien pregunta. 404 si no entra en esta empresa. */
async function contexto(actor: Actor, companyId: string, userId: string) {
  const m = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true, user: { select: SELECT_CUENTA } },
  });
  if (!m) throw notFound(MENSAJE_SIN_ACCESO);
  const objetivo: Objetivo = {
    userId,
    esAdminGlobal: m.user.isGlobalAdmin,
    activo: m.user.isActive,
    rol: String(m.role),
    empresas: m.user.memberships.map((x) => x.companyId),
  };
  return { objetivo, email: m.user.email, administradas: await empresasAdministradas(actor) };
}

const exigir = (motivo: string | null) => {
  if (motivo) throw forbidden(motivo);
};

export interface DatosAlta {
  email: unknown;
  nombre?: unknown;
  telefono?: unknown;
  rol: unknown;
  areas?: unknown;
}

export type ResultadoAlta =
  | { usuarioNuevo: true; userId: string; contrasenaProvisional: string; usuarioCreado: Awaited<ReturnType<typeof crearUsuario>> }
  | { usuarioNuevo: false; userId: string; acceso: AccesoAsignado };

/**
 * Alta desde la empresa. Si el correo ya tiene usuario no se crea otro: se le
 * da acceso a esta empresa con el rol y los permisos elegidos (sin tocar su
 * contrasena ni su nombre, que son de su cuenta). Si ya entraba, 409. Si es
 * el administrador global o una cuenta sin ninguna empresa, solo el global (403).
 * Si es nuevo, la contrasena la genera siempre el servidor y es provisional.
 */
export async function altaEnEmpresa(actor: Actor, companyId: string, datos: DatosAlta): Promise<ResultadoAlta> {
  const email = conCampo('email', () => normalizarEmail(datos.email));
  const existente = await prisma.user.findUnique({
    where: { email },
    select: { id: true, isGlobalAdmin: true, _count: { select: { memberships: true } }, memberships: { where: { companyId }, select: { id: true } } },
  });
  if (existente) {
    if (existente.memberships.length) {
      throw conflict('Este correo ya tiene acceso a esta empresa. Para cambiarle el rol o los permisos, usa «Editar acceso».', {
        codigo: 'YA_TIENE_ACCESO',
        userId: existente.id,
      });
    }
    exigir(motivoNoDarAccesoACuenta(actor, existente));
    const acceso = await asignarRol(existente.id, companyId, datos.rol, datos.areas);
    return { usuarioNuevo: false, userId: existente.id, acceso };
  }
  const usuarioCreado = await crearUsuario(
    { email, password: undefined, companyId, rol: datos.rol, areas: datos.areas, nombre: datos.nombre, telefono: datos.telefono },
    { generarSiFalta: true, exigirNombre: true },
  );
  return { usuarioNuevo: true, userId: usuarioCreado.id, contrasenaProvisional: usuarioCreado.contrasenaProvisional!, usuarioCreado };
}

export interface DatosEdicion {
  rol: unknown;
  areas?: unknown;
  nombre?: unknown;
  telefono?: unknown;
}

/**
 * «Editar acceso»: rol y permisos en ESTA empresa (sustitucion completa, como
 * en la administracion global) y, si vienen, nombre y telefono de la cuenta.
 */
export async function editarEnEmpresa(
  actor: Actor,
  companyId: string,
  userId: string,
  datos: DatosEdicion,
): Promise<{ acceso: AccesoAsignado; email: string; cambios: CambiosUsuario }> {
  const { objetivo, email, administradas } = await contexto(actor, companyId, userId);
  exigir(motivoNoEditarAcceso(actor, objetivo));
  const hayDatos = datos.nombre !== undefined || datos.telefono !== undefined;
  if (hayDatos) {
    exigir(motivoNoDatosPersonales(actor, objetivo, administradas));
    // Se validan antes de tocar el acceso: o se guarda todo o nada.
    if (datos.nombre !== undefined) normalizarNombrePersona(datos.nombre);
    normalizarTelefono(datos.telefono);
  }
  const acceso = await asignarRol(userId, companyId, datos.rol, datos.areas, { protegerUltimoAdmin: true });
  const cambios = hayDatos ? (await actualizarUsuario(actor.userId, userId, { nombre: datos.nombre, telefono: datos.telefono })).cambios : {};
  return { acceso, email, cambios };
}

/** «Nueva contraseña provisional»: la genera el servidor y se devuelve una vez. */
export async function nuevaContrasenaEnEmpresa(
  actor: Actor,
  companyId: string,
  userId: string,
): Promise<{ email: string; cambios: CambiosUsuario; contrasenaProvisional: string; contrasenaProvisionalHasta: string | null }> {
  const { objetivo, administradas } = await contexto(actor, companyId, userId);
  exigir(motivoNoNuevaContrasena(actor, objetivo, administradas));
  const r = await actualizarUsuario(actor.userId, userId, { restablecerContrasena: true });
  return {
    email: r.usuario.email,
    cambios: r.cambios,
    contrasenaProvisional: r.contrasenaProvisional!,
    contrasenaProvisionalHasta: r.usuario.contrasenaProvisionalHasta,
  };
}

/** «Quitar acceso a esta empresa». El usuario y sus otros accesos siguen. */
export async function quitarDeEmpresa(actor: Actor, companyId: string, userId: string): Promise<{ rolAnterior: string; personalizadoAntes: boolean }> {
  const { objetivo } = await contexto(actor, companyId, userId);
  exigir(motivoNoEditarAcceso(actor, objetivo));
  return quitarAcceso(userId, companyId, { protegerUltimoAdmin: true });
}
