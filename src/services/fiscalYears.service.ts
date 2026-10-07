import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { anioEspana } from '../utils/fechas';

/** Primer año que se puede crear (el mismo limite que la puesta en marcha). */
export const ANIO_MINIMO_EJERCICIO = 1990;

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es una fecha real AAAA-MM-DD? (rechaza 2026-02-30). */
function fechaValida(f: string): boolean {
  const m = FECHA_RE.exec(f);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const texto = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Año del ejercicio que se quiere crear, a partir del cuerpo nuevo {anio} o del
 * antiguo {label, fechaInicio, fechaFin} (Registro Mercantil). Por ahora solo
 * hay ejercicios de año natural: el cierre, los periodos y comprobarFechaAbierta
 * buscan el ejercicio por su año (label = "2026"), y uno que se llamara de otra
 * forma ("Ejercicio 2026") se quedaba sin proteger.
 */
export function anioDelEjercicio(datos: { anio?: unknown; label?: unknown; fechaInicio?: unknown; fechaFin?: unknown }, hoyAnio = anioEspana()): number {
  const maximo = hoyAnio + 1;
  let anio: number;
  if (datos.anio !== undefined && datos.anio !== null && datos.anio !== '') {
    anio = Number(datos.anio);
    if (!Number.isInteger(anio)) throw badRequest('Indica el año del ejercicio con cuatro cifras (por ejemplo, 2026).', { campo: 'anio' });
    if (datos.label !== undefined && texto(datos.label) !== String(anio)) {
      throw badRequest(`El nombre del ejercicio tiene que ser su año (${anio}).`, { campo: 'label' });
    }
  } else {
    const label = texto(datos.label);
    if (!label) throw badRequest('Indica el año del ejercicio.', { campo: 'anio' });
    if (!/^\d{4}$/.test(label)) {
      throw badRequest('El ejercicio se nombra con su año, en cuatro cifras (por ejemplo, 2026).', { campo: 'label' });
    }
    anio = Number(label);
  }
  if (anio < ANIO_MINIMO_EJERCICIO || anio > maximo) {
    throw badRequest(`El año del ejercicio tiene que estar entre ${ANIO_MINIMO_EJERCICIO} y ${maximo}.`, { campo: 'anio' });
  }

  // Fechas: opcionales; si vienen, tienen que ser las del año natural.
  const inicio = texto(datos.fechaInicio);
  const fin = texto(datos.fechaFin);
  for (const [campo, valor] of [['fechaInicio', inicio], ['fechaFin', fin]] as const) {
    if (valor && !fechaValida(valor)) throw badRequest('La fecha no es válida: usa el formato AAAA-MM-DD.', { campo });
  }
  if (inicio && fin && inicio >= fin) throw badRequest('La fecha de inicio tiene que ser anterior a la de fin.', { campo: 'fechaFin' });
  if ((inicio && inicio !== `${anio}-01-01`) || (fin && fin !== `${anio}-12-31`)) {
    throw badRequest(`Por ahora los ejercicios van del 1 de enero al 31 de diciembre: el ${anio} es del ${anio}-01-01 al ${anio}-12-31.`, {
      campo: inicio && inicio !== `${anio}-01-01` ? 'fechaInicio' : 'fechaFin',
    });
  }
  return anio;
}

const yaExiste = (anio: number) => conflict(`Ya existe el ejercicio ${anio}.`, { campo: 'anio' });

export const fiscalYearsService = {
  async listar(companyId: string) {
    return prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'desc' } });
  },

  /** Carga un ejercicio por id y valida que pertenece a la empresa esperada (si se pasa). */
  async obtener(fyId: string) {
    const fy = await prisma.fiscalYear.findUnique({ where: { id: fyId } });
    if (!fy) throw notFound('Ejercicio contable no encontrado.');
    return fy;
  },

  /**
   * Crea un ejercicio de año natural. Acepta {anio} o, por compatibilidad,
   * {label, fechaInicio, fechaFin}. 400 si los datos no valen; 409 si ya existe
   * o se solapa con otro (tambien cuando dos peticiones llegan a la vez).
   */
  async crear(companyId: string, datos: { anio?: unknown; label?: unknown; fechaInicio?: unknown; fechaFin?: unknown }) {
    const anio = anioDelEjercicio(datos ?? {});
    const label = String(anio);
    const fechaInicio = `${anio}-01-01`;
    const fechaFin = `${anio}-12-31`;

    const existentes = await prisma.fiscalYear.findMany({
      where: { companyId },
      select: { label: true, fechaInicio: true, fechaFin: true },
    });
    if (existentes.some((e) => e.label === label)) throw yaExiste(anio);
    // Ejercicios antiguos con otro nombre o con otras fechas: no se pueden pisar.
    const solapado = existentes.find((e) => e.fechaInicio && e.fechaFin && e.fechaInicio <= fechaFin && e.fechaFin >= fechaInicio);
    if (solapado) {
      throw conflict(
        `El ${anio} se solapa con el ejercicio "${solapado.label}" (del ${solapado.fechaInicio} al ${solapado.fechaFin}).`,
        { campo: 'anio' },
      );
    }

    try {
      return await prisma.fiscalYear.create({
        data: { companyId, label, fechaInicio, fechaFin, estado: 'OPEN' },
      });
    } catch (e) {
      // Otra peticion lo ha creado a la vez (unico empresa + label).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw yaExiste(anio);
      throw e;
    }
  },
};
