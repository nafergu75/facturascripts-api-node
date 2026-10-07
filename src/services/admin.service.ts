import { Prisma, Role } from '@prisma/client';
import { prisma } from '../config/database';
import { hashPassword } from '../utils/password';
import { AccesoEmpresa, EmpresaAdmin, UsuarioAdmin } from '../domain/admin.model';
import { HttpError, badRequest, conflict, notFound } from '../utils/http-errors';
import { validarNifEspanol } from '../utils/nif';
import { problemaCodigoPostal } from '../utils/geografia';
import {
  INSCRIBIBLES,
  TEXTO_MAX,
  camposPendientesEmpresa,
  comprobarNifLibre,
  comprobarNifSegunForma,
  esConflictoEscritura,
  librosObligatorios,
  limpiarLegalConfig,
  type LegalConfigInput,
} from './legalConfig.service';

/**
 * Administracion de la plataforma (modo administrador global): empresas,
 * usuarios y accesos de cada usuario a cada empresa.
 *
 * Roles que se pueden asignar: los del enum Role de la BD. OJO: 'tesoreria'
 * existe en rbac.service (ROL_PERMISOS) pero NO en el enum Role de Prisma;
 * antes figuraba aqui y asignarlo hacia fallar el upsert con un error 500 de
 * Prisma. Si algun dia se quiere ese rol hay que anadirlo primero al esquema.
 */
export const ROLES_VALIDOS = ['admin', 'contable', 'ventas', 'solo_lectura'] as const;
export type RolEmpresa = (typeof ROLES_VALIDOS)[number];

export const CONTRASENA_MIN = 12;
const CONTRASENA_MAX = 128;
const EMAIL_MAX = 191;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const CODIGO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;

// --- VALIDACIONES (funciones puras, probadas en admin-validaciones.test.ts) ---

/** Rol de empresa valido. Admite 'solo-lectura' (como lo escribe rbac) y lo pasa a 'solo_lectura'. */
export function normalizarRol(valor: unknown): RolEmpresa {
  const rol = typeof valor === 'string' ? valor.trim().replace(/-/g, '_') : '';
  if (!(ROLES_VALIDOS as readonly string[]).includes(rol)) {
    throw badRequest(`Rol no válido. Elige uno de estos: ${ROLES_VALIDOS.join(', ')}.`);
  }
  return rol as RolEmpresa;
}

/** Email en minusculas y sin espacios alrededor; formato estricto. */
export function normalizarEmail(valor: unknown): string {
  const email = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!email) throw badRequest('Falta el email.');
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw badRequest('El email no tiene un formato válido.');
  return email;
}

/** Contrasena inicial o restablecida: minimo razonable, sin reglas de composicion raras. */
export function validarContrasena(valor: unknown, email?: string): string {
  if (typeof valor !== 'string' || valor.length === 0) throw badRequest('Falta la contraseña.');
  if (valor.length < CONTRASENA_MIN) throw badRequest(`La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres.`);
  if (valor.length > CONTRASENA_MAX) throw badRequest(`La contraseña no puede pasar de ${CONTRASENA_MAX} caracteres.`);
  if (/^(.)\1*$/.test(valor)) throw badRequest('La contraseña no puede ser un mismo carácter repetido.');
  if (email && valor.trim().toLowerCase() === email.trim().toLowerCase()) {
    throw badRequest('La contraseña no puede ser el propio email.');
  }
  return valor;
}

/** Nombre de empresa: sin espacios sobrantes, entre 2 y 120 caracteres. */
export function normalizarNombreEmpresa(valor: unknown): string {
  const nombre = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (!nombre) throw badRequest('Falta el nombre de la empresa.');
  if (nombre.length < 2) throw badRequest('El nombre de la empresa es demasiado corto.');
  if (nombre.length > 120) throw badRequest('El nombre de la empresa no puede pasar de 120 caracteres.');
  return nombre;
}

/** Codigo corto de empresa (opcional). Vacio = sin codigo. */
export function normalizarCodigoEmpresa(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') throw badRequest('El código de la empresa no es válido.');
  const codigo = valor.trim();
  if (!codigo) return null;
  if (!CODIGO_RE.test(codigo)) {
    throw badRequest('El código solo puede llevar letras, números, guiones y guiones bajos (de 2 a 30 caracteres).');
  }
  return codigo;
}

/** Lee un booleano opcional del cuerpo: undefined si no viene, error si viene con otro tipo. */
export function leerBooleano(valor: unknown, campo: string): boolean | undefined {
  if (valor === undefined) return undefined;
  if (typeof valor !== 'boolean') throw badRequest(`El campo ${campo} debe ser true o false.`);
  return valor;
}

/**
 * La plataforma nunca se queda sin administrador global activo: si `objetivoId`
 * deja de serlo (o se desactiva), tiene que quedar al menos otro.
 */
export function comprobarQuedaAdminGlobal(adminsActivos: string[], objetivoId: string): void {
  if (!adminsActivos.some((id) => id !== objetivoId)) {
    throw conflict('Es el único administrador global activo: nombra antes a otro para no dejar la plataforma sin administrador.');
  }
}

// --- DATOS DE LA EMPRESA EN EL ALTA (funciones puras, probadas en admin-alta-empresa.test.ts) ---

/**
 * Campos de LegalConfig que se piden al dar de alta una empresa: los que salen
 * en las facturas. El resto (ejercicio, CNAE, logo...) se completa despues
 * desde "Datos de la empresa".
 */
export const CAMPOS_ALTA_EMPRESA = [
  'denominacion',
  'tipoSociedad',
  'pais',
  'nif',
  'domicilioSocial',
  'codigoPostal',
  'municipio',
  'provincia',
  'telefono',
  'email',
  'web',
  'registroMercantilProvincia',
  'registroTomo',
  'registroFolio',
  'registroHoja',
  'registroInscripcion',
  'datosRegistrales',
] as const;

const CAMPOS_REGISTRO = ['registroMercantilProvincia', 'registroTomo', 'registroFolio', 'registroHoja', 'registroInscripcion'] as const;

const NOMBRE_CAMPO: Record<(typeof CAMPOS_ALTA_EMPRESA)[number], string> = {
  denominacion: 'La denominación',
  tipoSociedad: 'La forma jurídica',
  pais: 'El país',
  nif: 'El NIF',
  domicilioSocial: 'El domicilio',
  codigoPostal: 'El código postal',
  municipio: 'El municipio',
  provincia: 'La provincia',
  telefono: 'El teléfono',
  email: 'El email',
  web: 'La web',
  registroMercantilProvincia: 'El Registro Mercantil',
  registroTomo: 'El tomo',
  registroFolio: 'El folio',
  registroHoja: 'La hoja',
  registroInscripcion: 'La inscripción',
  datosRegistrales: 'Los datos registrales',
};

/** Datos de la empresa ya validados, listos para guardar en LegalConfig. */
export type DatosAltaEmpresa = LegalConfigInput & {
  denominacion: string;
  tipoSociedad: string;
  pais: string;
  nif: string;
};

/**
 * Valida los datos de la empresa que llegan con el alta (POST /admin/empresas,
 * campo `datos`). Usa las mismas reglas que la pantalla "Datos de la empresa"
 * (limpiarLegalConfig) y ademas:
 * - exige denominacion, forma juridica, NIF, domicilio, CP, municipio y, en
 *   Espana, provincia (lo minimo para facturar);
 * - en Espana comprueba el NIF con su caracter de control (DNI, NIE o CIF) y
 *   que cuadre con la forma juridica (comprobarNifSegunForma), y que el codigo
 *   postal exista y sea de la provincia escrita;
 * - el Registro Mercantil es opcional en el alta (la app lo pide despues) y
 *   solo se guarda en sociedades espanolas que se inscriben (SA, SL, SLU).
 * Cada error lleva `details.campo` para senalar el campo en el formulario.
 */
export function validarDatosAltaEmpresa(entrada: unknown): DatosAltaEmpresa {
  if (typeof entrada !== 'object' || entrada === null || Array.isArray(entrada)) {
    throw badRequest('Los datos de la empresa no son válidos.');
  }
  const bruto = entrada as Record<string, unknown>;
  // Solo los campos del alta: nada de companyId, logo, ejercicio...
  const solo: Record<string, string> = {};
  for (const campo of CAMPOS_ALTA_EMPRESA) {
    const v = bruto[campo];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw badRequest(`${NOMBRE_CAMPO[campo]} tiene que ser un texto.`, { campo });
    if (v.trim().length > TEXTO_MAX) {
      throw badRequest(`${NOMBRE_CAMPO[campo]} no puede pasar de ${TEXTO_MAX} caracteres.`, { campo });
    }
    solo[campo] = v;
  }
  if (solo.pais === undefined) solo.pais = 'ES';
  if (!solo.tipoSociedad?.trim()) throw badRequest('Elige la forma jurídica.', { campo: 'tipoSociedad' });

  const limpio = limpiarLegalConfig(solo, 'ES') as Record<string, string | null | undefined>;
  const espana = limpio.pais === 'ES';
  const exigir = (campo: string, texto: string) => {
    if (!limpio[campo]) throw badRequest(`Falta ${texto}.`, { campo });
  };
  exigir('denominacion', 'la denominación o nombre completo');
  exigir('nif', espana ? 'el NIF' : 'la identificación fiscal');
  exigir('domicilioSocial', 'el domicilio');
  exigir('codigoPostal', 'el código postal');
  exigir('municipio', 'el municipio');
  if (espana) exigir('provincia', 'la provincia');

  if (espana) {
    const nif = validarNifEspanol(limpio.nif);
    if (!nif.valido) throw badRequest(nif.motivo ?? 'El NIF no es válido.', { campo: 'nif' });
    comprobarNifSegunForma(String(limpio.tipoSociedad), nif);
    limpio.nif = nif.normalizado;
    const cp = problemaCodigoPostal(limpio.codigoPostal, limpio.provincia);
    if (cp) throw badRequest(cp.mensaje, { campo: 'codigoPostal' });
  }

  const telefono = limpio.telefono;
  if (telefono && (!/^[+\d\s().-]+$/.test(telefono) ||(telefono.match(/\d/g) ?? []).length < 6)) {
    throw badRequest('El teléfono solo puede llevar cifras, espacios, guiones, paréntesis y el + del prefijo.', { campo: 'telefono' });
  }
  if (limpio.web && !/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(limpio.web)) {
    throw badRequest('La web no parece una dirección válida (por ejemplo, www.empresa.es).', { campo: 'web' });
  }

  // Registro Mercantil espanol: solo SA, SL y SLU espanolas. Fuera de Espana,
  // el texto libre de datos registrales (lo que pida la factura de ese pais).
  const inscribible = espana && INSCRIBIBLES.includes(String(limpio.tipoSociedad));
  if (!inscribible) for (const campo of CAMPOS_REGISTRO) delete limpio[campo];
  if (espana) delete limpio.datosRegistrales;
  return limpio as unknown as DatosAltaEmpresa;
}

/** Nombre corto de la empresa en la app a partir de su denominacion (hasta 120 caracteres). */
function nombreDesdeDenominacion(denominacion: string): string {
  const limpio = denominacion.trim().replace(/\s+/g, ' ');
  return limpio.length <= 120 ? limpio : limpio.slice(0, 120).trim();
}

const esDuplicado = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

// --- EMPRESAS ---

export async function listarEmpresas(): Promise<EmpresaAdmin[]> {
  const empresas = await prisma.company.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, codigo: true, name: true, isActive: true, createdAt: true, _count: { select: { memberships: true } } },
  });
  // LegalConfig no tiene relacion declarada con Company: se cruza por companyId.
  const legales = await prisma.legalConfig.findMany({
    where: { companyId: { in: empresas.map((e) => e.id) } },
    select: { companyId: true, denominacion: true, nif: true, pais: true },
  });
  const legalDe = new Map(legales.map((l) => [l.companyId, l]));
  return empresas.map((c) => {
    const legal = legalDe.get(c.id);
    return {
      id: c.id,
      codigo: c.codigo,
      nombre: c.name,
      activa: c.isActive,
      creadoEn: c.createdAt.toISOString(),
      denominacion: legal?.denominacion ?? null,
      nif: legal?.nif ?? null,
      pais: legal?.pais ?? null,
      usuarios: c._count.memberships,
    };
  });
}

/**
 * Crea una empresa. Quien la crea queda como miembro 'admin' de ella (ademas
 * de verla por ser administrador global), asi sigue en la empresa aunque un dia
 * deje de ser administrador de la plataforma.
 *
 * fsBaseUrl y fsApiKeyEnc son obligatorios en el esquema (herencia de
 * FacturaScripts) pero los datos ya viven en la BD propia: se guardan vacios.
 * Vacios no son ningun secreto, y si algo intentara hablar con FacturaScripts
 * para esta empresa fallaria al descifrar en vez de usar credenciales ajenas.
 */
export async function crearEmpresa(
  entrada: { nombre?: unknown; codigo?: unknown; datos?: unknown },
  creadorId: string,
): Promise<EmpresaAdmin> {
  const datos = entrada.datos === undefined || entrada.datos === null ? null : validarDatosAltaEmpresa(entrada.datos);
  const nombrePedido = typeof entrada.nombre === 'string' && entrada.nombre.trim() ? entrada.nombre : undefined;
  const nombre = conCampo('nombre', () =>
    normalizarNombreEmpresa(nombrePedido ?? (datos ? nombreDesdeDenominacion(datos.denominacion) : entrada.nombre)),
  );
  const codigo = conCampo('codigo', () => normalizarCodigoEmpresa(entrada.codigo));
  if (codigo && (await prisma.company.findUnique({ where: { codigo }, select: { id: true } }))) {
    throw conflict(`Ya existe una empresa con el código '${codigo}'.`, { campo: 'codigo' });
  }
  try {
    const { empresa: c, conCreador } = await prisma.$transaction(async (tx) => {
      if (datos) await comprobarNifLibre(tx, datos.nif);
      const empresa = await tx.company.create({
        data: { name: nombre, codigo, fsBaseUrl: '', fsApiKeyEnc: '', isActive: true },
      });
      const creador = await tx.user.findUnique({ where: { id: creadorId }, select: { id: true } });
      if (creador) await tx.membership.create({ data: { userId: creadorId, companyId: empresa.id, role: Role.admin } });
      if (datos) {
        await tx.legalConfig.create({
          data: {
            ...datos,
            companyId: empresa.id,
            // Libros que se legalizan en el Registro Mercantil (el esquema, por
            // defecto, marca el de socios siempre y el de contratos nunca). Se
            // recalculan si luego cambian la forma o el pais (legalConfigService.actualizar).
            ...librosObligatorios(datos.tipoSociedad, datos.pais),
          },
        });
      }
      return { empresa, conCreador: !!creador };
    });
    const pendientes = camposPendientesEmpresa(datos as Record<string, unknown> | null);
    return {
      id: c.id,
      codigo: c.codigo,
      nombre: c.name,
      activa: c.isActive,
      creadoEn: c.createdAt.toISOString(),
      denominacion: datos?.denominacion ?? null,
      nif: datos?.nif ?? null,
      pais: datos?.pais ?? null,
      usuarios: conCreador ? 1 : 0,
      completo: pendientes.length === 0,
      pendientes,
    };
  } catch (e) {
    if (esDuplicado(e)) throw conflict(`Ya existe una empresa con el código '${codigo}'.`, { campo: 'codigo' });
    if (esConflictoEscritura(e)) {
      throw conflict('Se estaba dando de alta a la vez otra empresa con el mismo NIF. Vuelve a intentarlo en unos segundos.', {
        campo: 'nif',
      });
    }
    throw e;
  }
}

/** Ejecuta una validacion y, si falla con un 400, le anade el campo al que se refiere. */
function conCampo<T>(campo: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 400 && e.details === undefined) throw badRequest(e.message, { campo });
    throw e;
  }
}

/** Renombra y/o activa-desactiva una empresa. Nunca borra datos. */
export async function actualizarEmpresa(
  id: string,
  datos: { nombre?: unknown; activa?: unknown },
): Promise<{ antes: { nombre: string; activa: boolean }; despues: { nombre: string; activa: boolean } }> {
  const cambios: { name?: string; isActive?: boolean } = {};
  if (datos.nombre !== undefined) cambios.name = normalizarNombreEmpresa(datos.nombre);
  const activa = leerBooleano(datos.activa, 'activa');
  if (activa !== undefined) cambios.isActive = activa;
  if (Object.keys(cambios).length === 0) throw badRequest('No hay nada que cambiar: envía nombre o activa.');

  const actual = await prisma.company.findUnique({ where: { id }, select: { name: true, isActive: true } });
  if (!actual) throw notFound('Empresa no encontrada.');
  const c = await prisma.company.update({ where: { id }, data: cambios, select: { name: true, isActive: true } });
  return { antes: { nombre: actual.name, activa: actual.isActive }, despues: { nombre: c.name, activa: c.isActive } };
}

// --- USUARIOS ---

type UsuarioConAccesos = {
  id: string;
  email: string;
  isActive: boolean;
  isGlobalAdmin: boolean;
  createdAt: Date;
  memberships: Array<{ role: Role; company: { id: string; name: string; codigo: string | null; isActive: boolean } }>;
};

/** Campos que se leen de un usuario: NUNCA el hash de la contrasena. */
const SELECT_USUARIO = {
  id: true,
  email: true,
  isActive: true,
  isGlobalAdmin: true,
  createdAt: true,
  memberships: { select: { role: true, company: { select: { id: true, name: true, codigo: true, isActive: true } } } },
} as const;

const aUsuarioAdmin = (u: UsuarioConAccesos): UsuarioAdmin => ({
  id: u.id,
  email: u.email,
  activo: u.isActive,
  esAdminGlobal: u.isGlobalAdmin,
  creadoEn: u.createdAt.toISOString(),
  empresas: u.memberships
    .map(
      (m): AccesoEmpresa => ({
        companyId: m.company.id,
        nombre: m.company.name,
        codigo: m.company.codigo,
        activa: m.company.isActive,
        rol: String(m.role),
      }),
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
});

export async function listarUsuarios(): Promise<UsuarioAdmin[]> {
  const usuarios = await prisma.user.findMany({ orderBy: { email: 'asc' }, select: SELECT_USUARIO });
  return usuarios.map(aUsuarioAdmin);
}

/**
 * Crea un usuario con su contrasena inicial (hasheada con scrypt, utils/password)
 * y, si se indica, le da acceso a una empresa con un rol (por defecto, solo lectura).
 */
export async function crearUsuario(datos: {
  email: unknown;
  password: unknown;
  esAdminGlobal?: unknown;
  companyId?: unknown;
  rol?: unknown;
}): Promise<UsuarioAdmin> {
  const email = normalizarEmail(datos.email);
  const password = validarContrasena(datos.password, email);
  const esAdminGlobal = leerBooleano(datos.esAdminGlobal, 'esAdminGlobal') ?? false;
  const companyId = typeof datos.companyId === 'string' && datos.companyId.trim() ? datos.companyId.trim() : null;
  if (datos.rol !== undefined && datos.rol !== '' && !companyId) throw badRequest('Para dar un rol hay que elegir también la empresa.');
  const rol = companyId ? normalizarRol(datos.rol === undefined || datos.rol === '' ? 'solo_lectura' : datos.rol) : null;

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict(`Ya existe un usuario con el email ${email}.`);
  }
  if (companyId && !(await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
    throw notFound('La empresa elegida no existe.');
  }

  try {
    const u = await prisma.$transaction(async (tx) => {
      const creado = await tx.user.create({
        data: { email, passwordHash: hashPassword(password), isActive: true, isGlobalAdmin: esAdminGlobal },
        select: { id: true },
      });
      if (companyId && rol) await tx.membership.create({ data: { userId: creado.id, companyId, role: rol as Role } });
      return tx.user.findUniqueOrThrow({ where: { id: creado.id }, select: SELECT_USUARIO });
    });
    return aUsuarioAdmin(u);
  } catch (e) {
    if (esDuplicado(e)) throw conflict(`Ya existe un usuario con el email ${email}.`);
    throw e;
  }
}

/** Da acceso a una empresa o cambia el rol que ya tenia (upsert de la membresia). */
export async function asignarRol(
  userId: string,
  companyId: string,
  rolPedido: unknown,
): Promise<{ rol: RolEmpresa; rolAnterior: string | null }> {
  const rol = normalizarRol(rolPedido);
  const [usuario, empresa] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
  ]);
  if (!usuario) throw notFound('Usuario no encontrado.');
  if (!empresa) throw notFound('Empresa no encontrada.');

  const anterior = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true },
  });
  await prisma.membership.upsert({
    where: { userId_companyId: { userId, companyId } },
    update: { role: rol as Role },
    create: { userId, companyId, role: rol as Role },
  });
  return { rol, rolAnterior: anterior ? String(anterior.role) : null };
}

/** Quita el acceso de un usuario a una empresa. Sus datos y los de la empresa no se tocan. */
export async function quitarAcceso(userId: string, companyId: string): Promise<{ rolAnterior: string }> {
  const m = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { id: true, role: true },
  });
  if (!m) throw notFound('Ese usuario no tiene acceso a esa empresa.');
  await prisma.membership.delete({ where: { id: m.id } });
  return { rolAnterior: String(m.role) };
}

export interface CambiosUsuario {
  activo?: boolean;
  esAdminGlobal?: boolean;
  contrasenaRestablecida?: boolean;
}

/**
 * Activa/desactiva, da/quita el modo administrador global o restablece la
 * contrasena de un usuario. Todo surte efecto en su siguiente peticion
 * (authMiddleware mira la BD): desactivarlo o cambiarle la contrasena cierra
 * las sesiones que tuviera abiertas.
 *
 * Protecciones:
 * - Nadie se desactiva ni se quita el modo administrador a si mismo (se
 *   quedaria fuera del panel sin poder deshacerlo).
 * - La plataforma no se queda nunca sin administrador global activo. La
 *   comprobacion bloquea las filas de los administradores (SELECT ... FOR
 *   UPDATE) para que dos administradores que se quitan el permiso el uno al
 *   otro a la vez no dejen la plataforma sin ninguno.
 */
export async function actualizarUsuario(
  actorId: string,
  userId: string,
  datos: { activo?: unknown; esAdminGlobal?: unknown; nuevaContrasena?: unknown },
): Promise<{ usuario: UsuarioAdmin; cambios: CambiosUsuario }> {
  const activo = leerBooleano(datos.activo, 'activo');
  const esAdminGlobal = leerBooleano(datos.esAdminGlobal, 'esAdminGlobal');
  const hayContrasena = datos.nuevaContrasena !== undefined && datos.nuevaContrasena !== '';
  if (activo === undefined && esAdminGlobal === undefined && !hayContrasena) {
    throw badRequest('No hay nada que cambiar: envía activo, esAdminGlobal o nuevaContrasena.');
  }
  if (userId === actorId && activo === false) throw badRequest('No puedes desactivar tu propio usuario.');
  if (userId === actorId && esAdminGlobal === false) {
    throw badRequest('No puedes quitarte a ti mismo el modo administrador. Pídeselo a otro administrador global.');
  }
  // Se valida y se hashea fuera de la transaccion (scrypt tarda): no retiene el bloqueo.
  const nuevaContrasena = hayContrasena ? validarContrasena(datos.nuevaContrasena) : null;
  const nuevoHash = nuevaContrasena ? hashPassword(nuevaContrasena) : null;

  return prisma.$transaction(async (tx) => {
    const objetivo = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, isActive: true, isGlobalAdmin: true },
    });
    if (!objetivo) throw notFound('Usuario no encontrado.');

    const dejaDeSerAdminActivo =
      objetivo.isGlobalAdmin && objetivo.isActive && (esAdminGlobal === false || activo === false);
    if (dejaDeSerAdminActivo) {
      const admins = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM \`User\` WHERE isGlobalAdmin = 1 AND isActive = 1 FOR UPDATE`;
      comprobarQuedaAdminGlobal(
        admins.map((a) => a.id),
        userId,
      );
    }

    const data: { isActive?: boolean; isGlobalAdmin?: boolean; passwordHash?: string } = {};
    const cambios: CambiosUsuario = {};
    if (activo !== undefined && activo !== objetivo.isActive) data.isActive = cambios.activo = activo;
    if (esAdminGlobal !== undefined && esAdminGlobal !== objetivo.isGlobalAdmin) data.isGlobalAdmin = cambios.esAdminGlobal = esAdminGlobal;
    if (nuevaContrasena && nuevoHash) {
      validarContrasena(nuevaContrasena, objetivo.email); // que no sea su propio email
      data.passwordHash = nuevoHash;
      cambios.contrasenaRestablecida = true;
    }

    const u = Object.keys(data).length
      ? await tx.user.update({ where: { id: userId }, data, select: SELECT_USUARIO })
      : await tx.user.findUniqueOrThrow({ where: { id: userId }, select: SELECT_USUARIO });
    return { usuario: aUsuarioAdmin(u), cambios };
  });
}
