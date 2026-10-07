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

/** Asientos que deja el cierre de verdad (Contabilidad > Cierre y traspaso de saldos). */
export const ORIGENES_ASIENTOS_CIERRE = ['REGULARIZACION', 'CIERRE'];

/**
 * Estado del ejercicio para la pantalla, en una sola palabra:
 *  - CERRADO: tiene asientos de regularizacion o cierre (lo cerro el cierre);
 *  - CERRADO_SIN_ASIENTOS: marcado como cerrado sin esos asientos (lo cerraba
 *    el boton de Registro Mercantil): el administrador lo puede reabrir;
 *  - ABIERTO: el resto.
 */
export type EstadoEfectivoEjercicio = 'ABIERTO' | 'CERRADO' | 'CERRADO_SIN_ASIENTOS';

export function estadoEfectivoEjercicio(estado: string, tieneAsientosCierre: boolean): EstadoEfectivoEjercicio {
  if (tieneAsientosCierre) return 'CERRADO';
  return estado === 'CLOSED' ? 'CERRADO_SIN_ASIENTOS' : 'ABIERTO';
}

type FilaEjercicio = { fechaInicio: string; fechaFin: string };
const dentroDe = (fecha: Date, fy: FilaEjercicio) => {
  const f = fecha.toISOString().slice(0, 10);
  return !!fy.fechaInicio && !!fy.fechaFin && f >= fy.fechaInicio && f <= fy.fechaFin;
};

/** Fechas de los asientos de cierre de la empresa (pocos: dos por ejercicio cerrado). */
async function fechasAsientosCierre(companyId: string): Promise<Date[]> {
  const asientos = await prisma.journalEntry.findMany({
    where: { companyId, estado: 'POSTED', origen: { in: ORIGENES_ASIENTOS_CIERRE } },
    select: { fecha: true },
  });
  return asientos.map((a) => a.fecha);
}

const MENSAJE_DESHAZ_EN_CIERRE = 'Este ejercicio tiene asientos de cierre: deshaz el cierre desde Contabilidad > Cierre y traspaso de saldos.';

export const fiscalYearsService = {
  /** Ejercicios de la empresa, con tieneAsientosCierre y el estado unico (estadoEfectivo). */
  async listar(companyId: string) {
    const [ejercicios, cierres] = await Promise.all([
      prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'desc' } }),
      fechasAsientosCierre(companyId),
    ]);
    return ejercicios.map((fy) => {
      const tieneAsientosCierre = cierres.some((f) => dentroDe(f, fy));
      return { ...fy, tieneAsientosCierre, estadoEfectivo: estadoEfectivoEjercicio(fy.estado, tieneAsientosCierre) };
    });
  },

  /**
   * Reabre un ejercicio CERRADO_SIN_ASIENTOS (lo cerro el boton de Registro
   * Mercantil, que no regularizaba ni cerraba): lo mismo que deshacer el cierre,
   * sin asientos que anular. Con asientos de cierre, 409: eso se deshace en
   * Cierre y traspaso de saldos. No toca libros generados, expedientes,
   * cuentas anuales ni meses.
   */
  async reabrirSinAsientos(companyId: string, fyId: string) {
    const fy = await prisma.fiscalYear.findFirst({ where: { id: fyId, companyId } });
    if (!fy) throw notFound('Ejercicio contable no encontrado.');
    const tieneAsientosCierre = (await fechasAsientosCierre(companyId)).some((f) => dentroDe(f, fy));
    const estado = estadoEfectivoEjercicio(fy.estado, tieneAsientosCierre);
    if (estado === 'CERRADO') {
      throw conflict(MENSAJE_DESHAZ_EN_CIERRE, { enlace: `/dashboard/contabilidad/cierre-ejercicio?ejercicio=${fy.label}` });
    }
    if (estado === 'ABIERTO') throw conflict(`El ejercicio ${fy.label} ya está abierto.`);
    const reabierto = await prisma.$transaction(async (tx) => {
      // Solo si sigue cerrado (dos clics a la vez no hacen nada raro).
      const r = await tx.fiscalYear.updateMany({
        where: { id: fy.id, estado: 'CLOSED' },
        data: { estado: 'OPEN', closingDate: null, legalizationDeadline: null, accountsDepositDeadline: null, asientosBloqueados: false },
      });
      if (r.count !== 1) throw conflict(`El ejercicio ${fy.label} ya está abierto.`);
      const libros = await tx.legalBook.deleteMany({ where: { fiscalYearId: fy.id, status: 'PENDING', filePath: '' } });
      return { fy: await tx.fiscalYear.findUniqueOrThrow({ where: { id: fy.id } }), librosPendientesBorrados: libros.count };
    });
    return {
      ...reabierto.fy,
      tieneAsientosCierre: false,
      estadoEfectivo: 'ABIERTO' as EstadoEfectivoEjercicio,
      librosPendientesBorrados: reabierto.librosPendientesBorrados,
    };
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
