import { Prisma, Role } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { caducidadContrasenaProvisional, contrasenaProvisionalCaducada, generarContrasenaProvisional, hashPassword } from '../utils/password';
import {
  AccesoAsignado,
  AccesoEmpresa,
  CatalogoPermisos,
  EmpresaAdmin,
  UsuarioAdmin,
  UsuarioConContrasena,
} from '../domain/admin.model';
import {
  AREAS,
  NIVELES,
  accesoPersonalizado,
  areasDeAcceso,
  areasDePerfil,
  canonizarParaGuardar,
  esquemaAreas,
  type Areas,
} from './rbac.service';
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
  monedaCuentaPorPais,
  type LegalConfigInput,
} from './legalConfig.service';

/**
 * Administracion de la plataforma (modo administrador global): empresas,
 * usuarios y accesos de cada usuario a cada empresa.
 *
 * Roles que se pueden asignar: los del enum Role de la BD, los mismos que
 * ROL_PERMISOS en rbac.service. Antes figuraba 'tesoreria', que no esta en el
 * enum: asignarlo hacia fallar el upsert con un error 500 de Prisma. Si algun
 * dia se quiere ese rol, hay que anadirlo a la vez al esquema, aqui y en rbac.
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

/** Nombre y apellidos de un usuario: sin espacios sobrantes, entre 2 y 120 caracteres. */
export function normalizarNombrePersona(valor: unknown): string {
  const nombre = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (!nombre) throw badRequest('Escribe el nombre y apellidos.', { campo: 'nombre' });
  if (nombre.length < 2) throw badRequest('El nombre es demasiado corto.', { campo: 'nombre' });
  if (nombre.length > 120) throw badRequest('El nombre no puede pasar de 120 caracteres.', { campo: 'nombre' });
  return nombre;
}

/**
 * Telefono de un usuario (opcional): vacio = sin telefono (null). Solo cifras,
 * espacios, guiones, parentesis y el + del prefijo, con 6 cifras como minimo.
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') throw badRequest('El teléfono no es válido.', { campo: 'telefono' });
  const telefono = valor.trim().replace(/\s+/g, ' ');
  if (!telefono) return null;
  if (telefono.length > 30 || !/^[+\d\s().-]+$/.test(telefono) || (telefono.match(/\d/g) ?? []).length < 6) {
    throw badRequest('El teléfono solo puede llevar cifras, espacios, guiones, paréntesis y el + del prefijo.', { campo: 'telefono' });
  }
  return telefono;
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
    select: { id: true, codigo: true, name: true, isActive: true, createdAt: true, pruebasVerifactuDe: true, _count: { select: { memberships: true } } },
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
      pruebasVerifactuDe: c.pruebasVerifactuDe ?? null,
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
            // Moneda de la contabilidad segun el pais, como al cambiarlo en "Datos
            // de la empresa" (decidirMonedaCuenta): EUR en Espana y la UE, USD
            // fuera (EE. UU. y Hong Kong solo admiten USD). Sin facturas ni
            // asientos se puede cambiar despues.
            monedaCuenta: monedaCuentaPorPais(datos.pais),
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
export function conCampo<T>(campo: string, fn: () => T): T {
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
  nombre: string | null;
  telefono: string | null;
  isActive: boolean;
  isGlobalAdmin: boolean;
  debeCambiarContrasena: boolean;
  contrasenaProvisionalHasta: Date | null;
  createdAt: Date;
  memberships: Array<{
    role: Role;
    permisosPersonalizados: Prisma.JsonValue | null;
    company: { id: string; name: string; codigo: string | null; isActive: boolean };
  }>;
};

/** Campos que se leen de un usuario: NUNCA el hash de la contrasena. */
const SELECT_USUARIO = {
  id: true,
  email: true,
  nombre: true,
  telefono: true,
  isActive: true,
  isGlobalAdmin: true,
  debeCambiarContrasena: true,
  contrasenaProvisionalHasta: true,
  createdAt: true,
  memberships: {
    select: { role: true, permisosPersonalizados: true, company: { select: { id: true, name: true, codigo: true, isActive: true } } },
  },
} as const;

// accesoPersonalizado y areasDeAcceso viven en rbac.service (las usa tambien
// GET /miembros). El modo admin global no cuenta: el usuario ya trae
// esAdminGlobal para que el panel lo explique.
const aUsuarioAdmin = (u: UsuarioConAccesos): UsuarioAdmin => ({
  id: u.id,
  email: u.email,
  nombre: u.nombre,
  telefono: u.telefono,
  activo: u.isActive,
  esAdminGlobal: u.isGlobalAdmin,
  debeCambiarContrasena: u.debeCambiarContrasena === true,
  // Solo mientras sea provisional: la fecha de una ya cambiada no dice nada.
  contrasenaProvisionalHasta: u.debeCambiarContrasena && u.contrasenaProvisionalHasta ? u.contrasenaProvisionalHasta.toISOString() : null,
  contrasenaProvisionalCaducada: contrasenaProvisionalCaducada(u),
  creadoEn: u.createdAt.toISOString(),
  empresas: u.memberships
    .map(
      (m): AccesoEmpresa => ({
        companyId: m.company.id,
        nombre: m.company.name,
        codigo: m.company.codigo,
        activa: m.company.isActive,
        rol: String(m.role),
        personalizado: accesoPersonalizado(m),
        areas: areasDeAcceso(m),
      }),
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
});

/** Nombres de pantalla de los perfiles, en el orden del selector. */
const NOMBRE_PERFIL: Record<RolEmpresa, string> = {
  admin: 'Administrador',
  contable: 'Contable',
  ventas: 'Ventas',
  solo_lectura: 'Solo lectura',
};

/**
 * Catalogo de la matriz de permisos para el panel. Las areas de cada perfil se
 * calculan con areasDePerfil (nunca escritas a mano): si cambia un perfil en
 * rbac.service, el panel lo ve.
 */
export function catalogoPermisos(): CatalogoPermisos {
  return {
    areas: AREAS.map(({ clave, nombre, descripcion }) => ({ clave, nombre, descripcion })),
    niveles: NIVELES,
    perfiles: ROLES_VALIDOS.map((rol) =>
      rol === 'admin'
        ? {
            rol,
            nombre: NOMBRE_PERFIL[rol],
            todo: true,
            areas: null,
            descripcion: 'Puede hacer todo en la empresa, también cambiar sus plantillas y los ajustes de Carmen y del lector.',
          }
        : { rol, nombre: NOMBRE_PERFIL[rol], todo: false, areas: areasDePerfil(rol) },
    ),
  };
}

/**
 * Lee el campo `areas` del cuerpo: null si no viene (o viene null = "los del
 * perfil"); si viene, tienen que ser las 6 areas con un nivel valido cada una.
 */
export function leerAreas(valor: unknown): Areas | null {
  if (valor === undefined || valor === null) return null;
  const r = esquemaAreas.safeParse(valor);
  if (!r.success) throw badRequest('Las áreas no son válidas.', { campo: 'areas' });
  return r.data;
}

/** Mensaje (409) al dejar una empresa sin administrador. */
export const MENSAJE_ULTIMO_ADMIN_EMPRESA =
  'Es el único administrador de esta empresa. Nombra antes a otro administrador para que la empresa no se quede sin nadie que la gestione.';

/**
 * Configuracion > Usuarios: una empresa no se queda sin administrador activo.
 * Si el acceso de `userId` deja de ser de administrador (o se quita), tiene que
 * quedar otro administrador con la cuenta activa. Bloquea las filas de los
 * administradores de la empresa (SELECT ... FOR UPDATE) para que dos que se
 * quitan el acceso el uno al otro a la vez no la dejen sin ninguno. Un
 * administrador con la cuenta desactivada no cuenta: no puede entrar.
 */
async function comprobarQuedaAdminEmpresa(tx: TransaccionBD, companyId: string, userId: string): Promise<void> {
  const admins = await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT m.userId FROM \`Membership\` m JOIN \`User\` u ON u.id = m.userId
    WHERE m.companyId = ${companyId} AND m.role = 'admin' AND u.isActive = 1
    FOR UPDATE`;
  const ids = admins.map((a) => a.userId);
  if (ids.includes(userId) && !ids.some((id) => id !== userId)) {
    throw conflict(MENSAJE_ULTIMO_ADMIN_EMPRESA, { codigo: 'ULTIMO_ADMIN_EMPRESA' });
  }
}

/** Opciones de asignarRol y quitarAcceso. */
export interface OpcionesAcceso {
  /** Configuracion > Usuarios: no dejar la empresa sin administrador activo. */
  protegerUltimoAdmin?: boolean;
}

/** Lo que hay en la columna para comparar (null = perfil). */
const columnaComparable = (valor: unknown): string => JSON.stringify(valor ?? null);

export async function listarUsuarios(): Promise<UsuarioAdmin[]> {
  const usuarios = await prisma.user.findMany({ orderBy: { email: 'asc' }, select: SELECT_USUARIO });
  return usuarios.map(aUsuarioAdmin);
}

/**
 * Crea un usuario con su contrasena inicial (hasheada con scrypt, utils/password)
 * y, si se indica, le da acceso a una empresa con un rol (por defecto, solo
 * lectura) y, si se quiere, permisos a medida (`areas`).
 *
 * La contrasena inicial es siempre PROVISIONAL (debeCambiarContrasena): la
 * conoce el administrador y el usuario tiene que poner una suya al entrar.
 * Caduca a los DIAS_CONTRASENA_PROVISIONAL dias (contrasenaProvisionalHasta).
 * - Con `generarSiFalta` (solo /admin/usuarios): si no viene, la genera el
 *   servidor y la devuelve UNA vez en `contrasenaProvisional`.
 * - Sin la opcion (POST /users, que no la devolveria): es obligatoria.
 * - Si la escribe el administrador, no se devuelve.
 */
export async function crearUsuario(
  datos: {
    email: unknown;
    password: unknown;
    esAdminGlobal?: unknown;
    companyId?: unknown;
    rol?: unknown;
    areas?: unknown;
    nombre?: unknown;
    telefono?: unknown;
  },
  opciones: { generarSiFalta?: boolean; exigirNombre?: boolean } = {},
): Promise<UsuarioConContrasena> {
  const email = conCampo('email', () => normalizarEmail(datos.email));
  // El nombre es opcional en la administracion global (altas antiguas sin el) y
  // obligatorio en Configuracion > Usuarios (exigirNombre).
  const sinNombre = datos.nombre === undefined || datos.nombre === null || datos.nombre === '';
  const nombre = sinNombre && !opciones.exigirNombre ? null : normalizarNombrePersona(datos.nombre);
  const telefono = normalizarTelefono(datos.telefono);
  const generar = opciones.generarSiFalta === true && (datos.password === undefined || datos.password === null || datos.password === '');
  const password = generar ? generarContrasenaProvisional() : validarContrasena(datos.password, email);
  const esAdminGlobal = leerBooleano(datos.esAdminGlobal, 'esAdminGlobal') ?? false;
  const companyId = typeof datos.companyId === 'string' && datos.companyId.trim() ? datos.companyId.trim() : null;
  if (datos.rol !== undefined && datos.rol !== '' && !companyId) throw badRequest('Para dar un rol hay que elegir también la empresa.');
  const rol = companyId ? conCampo('rol', () => normalizarRol(datos.rol === undefined || datos.rol === '' ? 'solo_lectura' : datos.rol)) : null;
  const areas = leerAreas(datos.areas);
  if (areas && !companyId) throw badRequest('Para ajustar permisos hay que elegir también la empresa.', { campo: 'areas' });
  const personalizados = rol ? canonizarParaGuardar(rol, areas) : null;

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict(`Ya existe un usuario con el email ${email}.`);
  }
  if (companyId && !(await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
    throw notFound('La empresa elegida no existe.');
  }

  try {
    const u = await prisma.$transaction(async (tx) => {
      const creado = await tx.user.create({
        data: {
          email,
          nombre,
          telefono,
          passwordHash: hashPassword(password),
          isActive: true,
          isGlobalAdmin: esAdminGlobal,
          debeCambiarContrasena: true,
          contrasenaProvisionalHasta: caducidadContrasenaProvisional(),
        },
        select: { id: true },
      });
      if (companyId && rol) {
        await tx.membership.create({
          data: { userId: creado.id, companyId, role: rol as Role, permisosPersonalizados: personalizados ?? Prisma.DbNull },
        });
      }
      return tx.user.findUniqueOrThrow({ where: { id: creado.id }, select: SELECT_USUARIO });
    });
    const usuario: UsuarioConContrasena = aUsuarioAdmin(u);
    if (generar) usuario.contrasenaProvisional = password;
    return usuario;
  } catch (e) {
    if (esDuplicado(e)) throw conflict(`Ya existe un usuario con el email ${email}.`);
    throw e;
  }
}

/**
 * Da acceso a una empresa o lo cambia: SUSTITUCION COMPLETA del acceso (rol y
 * permisos a medida). `areas` ausente o null = los del perfil ("Volver al
 * perfil"); si coinciden con el perfil tambien se guarda NULL. Con el perfil
 * Administrador la columna queda siempre NULL.
 *
 * Leer lo anterior, decidir si hay cambio y escribir van en una transaccion:
 * si dos administradores guardan a la vez gana el ultimo, y lo que devuelve
 * cada uno (y su auditoria) es lo que habia justo antes de su escritura. Si no
 * cambia nada no se escribe (cambiado: false).
 */
export async function asignarRol(
  userId: string,
  companyId: string,
  rolPedido: unknown,
  areasPedidas?: unknown,
  opciones: OpcionesAcceso = {},
): Promise<AccesoAsignado> {
  const rol = conCampo('rol', () => normalizarRol(rolPedido));
  const areas = leerAreas(areasPedidas);
  const personalizados = canonizarParaGuardar(rol, areas);
  const [usuario, empresa] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
  ]);
  if (!usuario) throw notFound('Usuario no encontrado.');
  if (!empresa) throw notFound('Empresa no encontrada.');

  const nuevo = { role: rol, permisosPersonalizados: personalizados };
  return prisma.$transaction(async (tx) => {
    const anterior = await tx.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true, permisosPersonalizados: true },
    });
    // Se compara la columna tal cual: un valor manipulado a mano se limpia al guardar.
    const cambiado =
      !anterior || String(anterior.role) !== rol || columnaComparable(anterior.permisosPersonalizados) !== columnaComparable(personalizados);
    if (opciones.protegerUltimoAdmin && anterior && String(anterior.role) === 'admin' && rol !== 'admin') {
      await comprobarQuedaAdminEmpresa(tx, companyId, userId);
    }
    if (cambiado) {
      const columna = personalizados ?? Prisma.DbNull;
      await tx.membership.upsert({
        where: { userId_companyId: { userId, companyId } },
        update: { role: rol as Role, permisosPersonalizados: columna },
        create: { userId, companyId, role: rol as Role, permisosPersonalizados: columna },
      });
    }
    return {
      rol,
      rolAnterior: anterior ? String(anterior.role) : null,
      personalizado: accesoPersonalizado(nuevo),
      personalizadoAntes: anterior ? accesoPersonalizado(anterior) : false,
      areas: areasDeAcceso(nuevo),
      areasAnteriores: anterior ? areasDeAcceso(anterior) : null,
      cambiado,
    };
  });
}

/**
 * Quita el acceso de un usuario a una empresa. Sus datos y los de la empresa no
 * se tocan. Con `protegerUltimoAdmin`, no deja la empresa sin administrador.
 */
export async function quitarAcceso(
  userId: string,
  companyId: string,
  opciones: OpcionesAcceso = {},
): Promise<{ rolAnterior: string; personalizadoAntes: boolean }> {
  return prisma.$transaction(async (tx) => {
    const m = await tx.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { id: true, role: true, permisosPersonalizados: true },
    });
    if (!m) throw notFound('Ese usuario no tiene acceso a esa empresa.');
    if (opciones.protegerUltimoAdmin && String(m.role) === 'admin') await comprobarQuedaAdminEmpresa(tx, companyId, userId);
    await tx.membership.delete({ where: { id: m.id } });
    return { rolAnterior: String(m.role), personalizadoAntes: accesoPersonalizado(m) };
  });
}

/** Lo que cambio en un usuario (para la auditoria). NUNCA la contrasena. */
export interface CambiosUsuario {
  activo?: boolean;
  esAdminGlobal?: boolean;
  contrasenaRestablecida?: boolean;
  /** La nueva es provisional (la de OTRO usuario): tendra que cambiarla al entrar. */
  contrasenaProvisional?: boolean;
  /** La genero el servidor (restablecerContrasena). */
  contrasenaGenerada?: boolean;
  /** Se le obliga a cambiar la que ya tiene (exigirCambioContrasena), sin tocarla. */
  exigirCambioContrasena?: boolean;
  /** Nombre y telefono nuevos (no son secretos: se auditan tal cual). */
  nombre?: string;
  telefono?: string | null;
}

/**
 * Activa/desactiva, da/quita el modo administrador global, restablece la
 * contrasena de un usuario o le obliga a cambiar la que ya tiene. Todo surte efecto en su siguiente peticion
 * (authMiddleware mira la BD): desactivarlo o cambiarle la contrasena cierra
 * las sesiones que tuviera abiertas.
 *
 * Contrasena de OTRO usuario: queda provisional (tendra que poner una suya al
 * entrar). Con `restablecerContrasena: true` la genera el servidor y se
 * devuelve una vez en `contrasenaProvisional`; con `nuevaContrasena` la escribe
 * el administrador y no se devuelve. La propia no se cambia aqui de ninguna de
 * las dos formas: se cambia en "Cambiar contrasena", que pide la actual.
 *
 * La contrasena puesta a otro (generada o escrita) caduca a los
 * DIAS_CONTRASENA_PROVISIONAL dias si no la cambia (contrasenaProvisionalHasta).
 *
 * `exigirCambioContrasena: true` (solo para OTRO usuario) le marca la que ya
 * tiene como provisional, sin caducidad y sin cambiarla: entra con ella y tiene que poner una
 * suya antes de usar nada mas. Sirve para los usuarios dados de alta antes de
 * existir la contrasena provisional, cuya contrasena puso un administrador.
 * Sus sesiones abiertas quedan bloqueadas en la siguiente peticion (403
 * CAMBIO_CONTRASENA_OBLIGATORIO), sin echarle.
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
  datos: {
    activo?: unknown;
    esAdminGlobal?: unknown;
    nuevaContrasena?: unknown;
    restablecerContrasena?: unknown;
    exigirCambioContrasena?: unknown;
    nombre?: unknown;
    telefono?: unknown;
  },
): Promise<{ usuario: UsuarioAdmin; cambios: CambiosUsuario; contrasenaProvisional?: string }> {
  const activo = leerBooleano(datos.activo, 'activo');
  // Nombre: si viene, tiene que ser valido (no se borra); telefono: vacio lo borra.
  const nombre = datos.nombre === undefined ? undefined : normalizarNombrePersona(datos.nombre);
  const telefono = datos.telefono === undefined ? undefined : normalizarTelefono(datos.telefono);
  const hayDatos = nombre !== undefined || telefono !== undefined;
  const esAdminGlobal = leerBooleano(datos.esAdminGlobal, 'esAdminGlobal');
  const restablecer = leerBooleano(datos.restablecerContrasena, 'restablecerContrasena') === true;
  const hayContrasena = datos.nuevaContrasena !== undefined && datos.nuevaContrasena !== '';
  const exigirCambio = leerBooleano(datos.exigirCambioContrasena, 'exigirCambioContrasena');
  // Solo true: quitar la obligacion dejaria como definitiva una contrasena que conoce el administrador.
  if (exigirCambio === false) {
    throw badRequest('Solo se puede pedir que cambie su contraseña (exigirCambioContrasena: true), no quitarlo.', { campo: 'exigirCambioContrasena' });
  }
  if (activo === undefined && esAdminGlobal === undefined && !hayContrasena && !restablecer && !exigirCambio && !hayDatos) {
    throw badRequest('No hay nada que cambiar: envía activo, esAdminGlobal, nombre, telefono, nuevaContrasena, restablecerContrasena o exigirCambioContrasena.');
  }
  if (exigirCambio && (hayContrasena || restablecer)) {
    throw badRequest('Con una contraseña nueva ya tendrá que cambiarla al entrar: no hace falta pedirlo aparte.');
  }
  if (restablecer && hayContrasena) {
    throw badRequest('Elige una de las dos: generar una contraseña provisional o escribirla.');
  }
  // La propia, ni generada ni escrita: se cambia en POST /auth/cambiar-contrasena,
  // que pide la actual. Si no, quien robe el token de un administrador global
  // podria ponerle una contrasena nueva sin saber la actual y quedarse la cuenta.
  // Cubre PATCH /admin/usuarios y PUT /users (los dos pasan por aqui).
  if ((restablecer || hayContrasena || exigirCambio) && userId === actorId) throw badRequest('Tu propia contraseña cámbiala en «Cambiar contraseña».');
  if (userId === actorId && activo === false) throw badRequest('No puedes desactivar tu propio usuario.');
  if (userId === actorId && esAdminGlobal === false) {
    throw badRequest('No puedes quitarte a ti mismo el modo administrador. Pídeselo a otro administrador global.');
  }
  // Se genera, se valida y se hashea fuera de la transaccion (scrypt tarda): no retiene el bloqueo.
  const generada = restablecer ? generarContrasenaProvisional() : null;
  const nuevaContrasena = hayContrasena ? validarContrasena(datos.nuevaContrasena) : generada;
  const nuevoHash = nuevaContrasena ? hashPassword(nuevaContrasena) : null;

  return prisma.$transaction(async (tx) => {
    const objetivo = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, isActive: true, isGlobalAdmin: true, debeCambiarContrasena: true, nombre: true, telefono: true },
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

    const data: {
      isActive?: boolean;
      isGlobalAdmin?: boolean;
      passwordHash?: string;
      debeCambiarContrasena?: boolean;
      contrasenaProvisionalHasta?: Date | null;
      nombre?: string;
      telefono?: string | null;
    } = {};
    const cambios: CambiosUsuario = {};
    if (nombre !== undefined && nombre !== objetivo.nombre) data.nombre = cambios.nombre = nombre;
    if (telefono !== undefined && telefono !== objetivo.telefono) data.telefono = cambios.telefono = telefono;
    if (activo !== undefined && activo !== objetivo.isActive) data.isActive = cambios.activo = activo;
    if (esAdminGlobal !== undefined && esAdminGlobal !== objetivo.isGlobalAdmin) data.isGlobalAdmin = cambios.esAdminGlobal = esAdminGlobal;
    if (nuevaContrasena && nuevoHash) {
      validarContrasena(nuevaContrasena, objetivo.email); // que no sea su propio email
      data.passwordHash = nuevoHash;
      // Es la de OTRO usuario (la propia no llega aqui): la conoce quien la pone, provisional.
      data.debeCambiarContrasena = true;
      data.contrasenaProvisionalHasta = caducidadContrasenaProvisional();
      cambios.contrasenaRestablecida = true;
      cambios.contrasenaProvisional = true;
      if (generada) cambios.contrasenaGenerada = true;
    }
    // Si ya la tenia que cambiar, no hay nada que hacer (ni que auditar).
    if (exigirCambio && !objetivo.debeCambiarContrasena) {
      data.debeCambiarContrasena = cambios.exigirCambioContrasena = true;
      // Es la suya de siempre: no caduca (si no entra en dias, no se queda fuera).
      data.contrasenaProvisionalHasta = null;
    }

    const u = Object.keys(data).length
      ? await tx.user.update({ where: { id: userId }, data, select: SELECT_USUARIO })
      : await tx.user.findUniqueOrThrow({ where: { id: userId }, select: SELECT_USUARIO });
    return { usuario: aUsuarioAdmin(u), cambios, ...(generada ? { contrasenaProvisional: generada } : {}) };
  });
}
