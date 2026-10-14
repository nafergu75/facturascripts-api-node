import { Prisma } from '@prisma/client';
import { conflict } from '../utils/http-errors';

/**
 * Inmutabilidad de VERI*FACTU en la app (spec verifactu, 2.8 y 7.4; RD
 * 1007/2023, art. 8.2.a: los registros no se pueden alterar). TiDB no tiene
 * triggers, asi que lo garantiza esta extension del cliente Prisma, que no
 * hace NINGUNA consulta extra (vale dentro de una transaccion con una sola
 * conexion):
 *
 *  - VerifactuRegistro: nunca se borra; solo se cambian los campos de envio
 *    (estadoEnvio, intentos, CSV, error...). Lo demas -> 409 VERIFACTU_INMUTABLE.
 *  - VerifactuCadena y VerifactuBitacora: nunca se borran.
 *  - IncomeInvoice CON registro: solo se cambian el estado de cobro, el estado
 *    de VERI*FACTU (sin ponerlo a null), la anulacion, paisClienteLegacy y
 *    updatedAt. Cualquier otro cambio lleva al where «sin registro»: en un
 *    update da 409 FACTURA_REGISTRADA; en un updateMany esa factura se queda
 *    fuera, sin error. Una factura FINAL sin registro (lector, anterior a la
 *    activacion) sigue como hasta ahora.
 *
 * «Sin registro» es `verifactuEstado: null`, una columna de la propia factura:
 * generarRegistroAlta la pone a PENDIENTE en la misma transaccion que crea el
 * registro y esta extension no deja volver a ponerla a null. NO se filtra con
 * la relacion (`verifactuRegistros: { none: {} }`): Prisma la traduce a un
 * `id NOT IN (SELECT incomeInvoiceId FROM VerifactuRegistro ...)` que en
 * MariaDB/MySQL (REPEATABLE READ) deja un bloqueo compartido en el indice de
 * VerifactuRegistro ANTES de bloquear la cadena; otra emision que ya tiene la
 * cadena espera para insertar su registro y salta el interbloqueo 1213 (dos
 * finalizar a la vez en series distintas). Ademas recorria los registros de
 * todas las empresas en cada update.
 *  - IncomeInvoiceLine e IncomeInvoiceRectificada de una factura con registro:
 *    no se cambian ni se borran (mismo filtro, sobre su factura: la subconsulta
 *    solo lee la fila de la factura por su clave).
 *  - Borrar una factura con registro lo impide la FK Restrict de
 *    VerifactuRegistro.incomeInvoiceId (tambien con SQL a mano).
 *
 * Fuera de su alcance: el SQL a mano ($executeRaw) y crear lineas o enlaces
 * nuevos de una factura registrada con create/createMany sueltos (la app no lo
 * hace: las lineas se escriben con la factura). Lo cubre la verificacion
 * periodica de la cadena (6.7, fase F4). La subsanacion de F4 tendra que
 * permitir descripcionOperacion y el destinatario (FAQ desarrolladores n.º 17).
 */

export const CODIGO_INMUTABLE = 'VERIFACTU_INMUTABLE';
export const CODIGO_FACTURA_REGISTRADA = 'FACTURA_REGISTRADA';

/** Lo unico que se puede cambiar de un registro: su envio a la AEAT. */
export const CAMPOS_ENVIO_REGISTRO: ReadonlySet<string> = new Set([
  'estadoEnvio',
  'intentos',
  'proximoIntento',
  'bloqueadoHasta',
  'loteId',
  'csv',
  'codigoError',
  'descripcionError',
  'corregidoPorId',
  'enviadoEn',
  'respondidoEn',
]);

/** Lo unico que se puede cambiar de una factura con registro. */
export const CAMPOS_LIBRES_FACTURA: ReadonlySet<string> = new Set([
  'estado',
  'verifactuEstado',
  'anuladaEn',
  'anuladaPor',
  'motivoAnulacion',
  'paisClienteLegacy',
  'updatedAt',
]);

const errorInmutable = (que: string) =>
  conflict(`${que}: los registros de VERI*FACTU no se pueden cambiar ni borrar.`, { codigo: CODIGO_INMUTABLE, code: CODIGO_INMUTABLE });

const errorFacturaRegistrada = () =>
  conflict('La factura está emitida y registrada en VERI*FACTU: no se puede cambiar. Para corregirla, haz una rectificativa.', {
    codigo: CODIGO_FACTURA_REGISTRADA,
    code: CODIGO_FACTURA_REGISTRADA,
  });

type Datos = Record<string, unknown> | undefined | null;

/** Pone a null un campo (directo o con { set: null }). */
const aNull = (v: unknown) => v === null || (!!v && typeof v === 'object' && 'set' in (v as object) && (v as { set: unknown }).set === null);

/** true si `data` solo toca campos de envio del registro. */
export function soloCamposDeEnvio(data: Datos): boolean {
  return Object.keys(data ?? {}).every((k) => CAMPOS_ENVIO_REGISTRO.has(k));
}

/** true si `data` solo toca lo que se puede cambiar de una factura registrada. */
export function soloCamposLibresFactura(data: Datos): boolean {
  return Object.entries(data ?? {}).every(([k, v]) => CAMPOS_LIBRES_FACTURA.has(k) && !(k === 'verifactuEstado' && aNull(v)));
}

/** Añade una condicion al where (con AND, sin pisar lo que ya tuviera). */
function conCondicion<W extends Record<string, unknown> | undefined>(where: W, condicion: Record<string, unknown>): W {
  const w = (where ?? {}) as Record<string, unknown>;
  const and = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  return { ...w, AND: [...and, condicion] } as unknown as W;
}

/** Factura sin registro de VERI*FACTU (ver arriba: columna propia, no la relacion). */
const SIN_REGISTRO = { verifactuEstado: null };
const FACTURA_SIN_REGISTRO = { invoice: SIN_REGISTRO };
const RECTIFICATIVA_SIN_REGISTRO = { rectificativa: SIN_REGISTRO };

const esNoEncontrado = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';

/** update de una sola fila con el filtro: si la fila existe pero esta registrada, 409 en vez del P2025. */
async function unaConFiltro<T>(consulta: () => Promise<T>): Promise<T> {
  try {
    return await consulta();
  } catch (e) {
    if (esNoEncontrado(e)) throw errorFacturaRegistrada();
    throw e;
  }
}

type ArgsConWhere = { where?: Record<string, unknown>; data?: Record<string, unknown> };
type Query = (args: unknown) => Promise<unknown>;

export const inmutabilidadVerifactu = Prisma.defineExtension({
  name: 'inmutabilidad-verifactu',
  query: {
    verifactuRegistro: {
      async delete() {
        throw errorInmutable('No se puede borrar un registro');
      },
      async deleteMany() {
        throw errorInmutable('No se pueden borrar registros');
      },
      async update({ args, query }) {
        if (!soloCamposDeEnvio(args.data as Datos)) throw errorInmutable('Solo se puede cambiar el envío de un registro');
        return query(args);
      },
      async updateMany({ args, query }) {
        if (!soloCamposDeEnvio(args.data as Datos)) throw errorInmutable('Solo se puede cambiar el envío de los registros');
        return query(args);
      },
      async upsert({ args, query }) {
        if (!soloCamposDeEnvio(args.update as Datos)) throw errorInmutable('Solo se puede cambiar el envío de un registro');
        return query(args);
      },
    },
    verifactuCadena: {
      async delete() {
        throw errorInmutable('No se puede borrar la cadena');
      },
      async deleteMany() {
        throw errorInmutable('No se puede borrar la cadena');
      },
    },
    verifactuBitacora: {
      async delete() {
        throw errorInmutable('No se puede borrar la bitácora');
      },
      async deleteMany() {
        throw errorInmutable('No se puede borrar la bitácora');
      },
    },
    incomeInvoice: {
      async update({ args, query }) {
        if (soloCamposLibresFactura(args.data as Datos)) return query(args);
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
      async updateMany({ args, query }) {
        if (soloCamposLibresFactura(args.data as Datos)) return query(args);
        const a = args as ArgsConWhere;
        return (query as Query)({ ...a, where: conCondicion(a.where, SIN_REGISTRO) }) as ReturnType<typeof query>;
      },
      async upsert({ args, query }) {
        if (soloCamposLibresFactura(args.update as Datos)) return query(args);
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
    },
    incomeInvoiceLine: {
      async update({ args, query }) {
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, FACTURA_SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
      async updateMany({ args, query }) {
        const a = args as ArgsConWhere;
        return (query as Query)({ ...a, where: conCondicion(a.where, FACTURA_SIN_REGISTRO) }) as ReturnType<typeof query>;
      },
      async delete({ args, query }) {
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, FACTURA_SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
      async deleteMany({ args, query }) {
        const a = args as ArgsConWhere;
        return (query as Query)({ ...a, where: conCondicion(a.where, FACTURA_SIN_REGISTRO) }) as ReturnType<typeof query>;
      },
    },
    incomeInvoiceRectificada: {
      async update({ args, query }) {
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, RECTIFICATIVA_SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
      async updateMany({ args, query }) {
        const a = args as ArgsConWhere;
        return (query as Query)({ ...a, where: conCondicion(a.where, RECTIFICATIVA_SIN_REGISTRO) }) as ReturnType<typeof query>;
      },
      async delete({ args, query }) {
        const a = args as ArgsConWhere;
        return unaConFiltro(() => (query as Query)({ ...a, where: conCondicion(a.where, RECTIFICATIVA_SIN_REGISTRO) })) as ReturnType<typeof query>;
      },
      async deleteMany({ args, query }) {
        const a = args as ArgsConWhere;
        return (query as Query)({ ...a, where: conCondicion(a.where, RECTIFICATIVA_SIN_REGISTRO) }) as ReturnType<typeof query>;
      },
    },
  },
});
