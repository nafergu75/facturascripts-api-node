import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { anioEspana } from '../utils/fechas';
import { FILTRO_ASIENTOS_CIERRE } from '../domain/asientosCierre';

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

/**
 * Estado del ejercicio para la pantalla, en una sola palabra:
 *  - CERRADO: tiene asientos de regularizacion o cierre (domain/asientosCierre:
 *    los de Cierre y traspaso de saldos y los de los cierres anteriores);
 *  - CERRADO_SIN_ASIENTOS: marcado como cerrado sin esos asientos (lo cerraba
 *    el boton de Registro Mercantil): el administrador lo puede reabrir;
 *  - ABIERTO: el resto.
 */
export type EstadoEfectivoEjercicio = 'ABIERTO' | 'CERRADO' | 'CERRADO_SIN_ASIENTOS';

export function estadoEfectivoEjercicio(estado: string, tieneAsientosCierre: boolean): EstadoEfectivoEjercicio {
  if (tieneAsientosCierre) return 'CERRADO';
  return estado === 'CLOSED' ? 'CERRADO_SIN_ASIENTOS' : 'ABIERTO';
}

type FilaEjercicio = { label: string; fechaInicio: string; fechaFin: string };
const diaDe = (fecha: Date) => fecha.toISOString().slice(0, 10);
const dentroDe = (fecha: Date, fy: FilaEjercicio) => {
  const f = diaDe(fecha);
  return !!fy.fechaInicio && !!fy.fechaFin && f >= fy.fechaInicio && f <= fy.fechaFin;
};
/** Ultimo dia del ejercicio (sus fechas o, si faltan, el 31/12 de su año). */
const finDe = (fy: FilaEjercicio) => fy.fechaFin || `${fy.label}-12-31`;
/** Año natural del ejercicio, para sus 12 meses (null si no se sabe). */
function anioDe(fy: FilaEjercicio): number | null {
  if (/^\d{4}$/.test(fy.label)) return Number(fy.label);
  const m = /^(\d{4})-/.exec(fy.fechaInicio ?? '');
  return m ? Number(m[1]) : null;
}

/** Lo que hace falta para decidir el estado y si se puede reabrir (pocas filas). */
interface DatosCierres {
  /** Fechas de los asientos de cierre de la empresa (dos por ejercicio cerrado). */
  cierres: Date[];
  /** Fecha del primer asiento POSTED que no es de cierre (null: ninguno). */
  primerAsiento: Date | null;
}

async function datosCierres(companyId: string): Promise<DatosCierres> {
  const [asientos, primero] = await Promise.all([
    prisma.journalEntry.findMany({ where: { companyId, estado: 'POSTED', ...FILTRO_ASIENTOS_CIERRE }, select: { fecha: true } }),
    prisma.journalEntry.findFirst({
      where: { companyId, estado: 'POSTED', NOT: FILTRO_ASIENTOS_CIERRE },
      orderBy: { fecha: 'asc' },
      select: { fecha: true },
    }),
  ]);
  return { cierres: asientos.map((a) => a.fecha), primerAsiento: primero?.fecha ?? null };
}

/** Enlace a la pantalla donde el administrador reabre los cerrados sin asientos. */
export const ENLACE_CONFIG_EJERCICIOS = '/dashboard/configuracion/ejercicios';
export const enlaceCierre = (ejercicio: string | number) => `/dashboard/contabilidad/cierre-ejercicio?ejercicio=${ejercicio}`;

/**
 * Por que NO se reabre un ejercicio cerrado sin asientos de cierre (null: se
 * puede). Las mismas reglas que el arreglo SQL de reapertura:
 *  - posterior_cerrado: un ejercicio posterior ya tiene asientos de cierre; su
 *    cierre ya arrastro los saldos de este año y este no se podria volver a
 *    cerrar (el cierre pide que el siguiente este abierto).
 *  - sin_asientos: no tiene ningun asiento hasta su fin (años anteriores a la
 *    puesta en marcha que se cerraron para sacar sus libros): no habria nada que
 *    cerrar, se quedaria abierto para siempre y sus libros ya no se generarian.
 */
export function motivoNoReabrir(fy: FilaEjercicio, datos: DatosCierres): { motivo: 'posterior_cerrado' | 'sin_asientos'; mensaje: string } | null {
  const fin = finDe(fy);
  if (datos.cierres.some((f) => diaDe(f) > fin)) {
    return {
      motivo: 'posterior_cerrado',
      mensaje:
        `El ejercicio ${fy.label} no se puede reabrir: un ejercicio posterior ya está cerrado con sus asientos de cierre, y ese cierre ya incluye los saldos de este año. ` +
        'Si de verdad hay que corregir algo, deshaz antes esos cierres en Contabilidad > Cierre y traspaso de saldos, empezando por el más reciente.',
    };
  }
  if (!datos.primerAsiento || diaDe(datos.primerAsiento) > fin) {
    return {
      motivo: 'sin_asientos',
      mensaje:
        `El ejercicio ${fy.label} no tiene asientos: no hay nada que corregir ni que cerrar. ` +
        'Si se reabriera, no se podría volver a cerrar y ya no se podrían generar sus libros, así que se deja cerrado.',
    };
  }
  return null;
}

/**
 * Texto para quien se encuentra un ejercicio cerrado sin asientos de cierre
 * (lo cerraba el boton de Registro Mercantil): en Cierre y traspaso de saldos
 * no hay nada que deshacer; lo que toca es reabrirlo en Configuracion (si se
 * puede) y despues cerrarlo bien.
 */
export function mensajeCerradoSinAsientos(anio: string | number, motivo: string | null): string {
  const base = `El ejercicio ${anio} se marcó como cerrado sin hacer la regularización ni el cierre, así que en Cierre y traspaso de saldos no hay nada que deshacer.`;
  if (motivo) return `${base} ${motivo}`;
  return `${base} El administrador de la empresa puede reabrirlo en Configuración > Ejercicios y periodos y después cerrarlo en Cierre y traspaso de saldos.`;
}

/** ¿Se puede reabrir el ejercicio de ese año? (para los mensajes de periodos y del cierre). */
export async function reaperturaDelAnio(companyId: string, ejercicio: number): Promise<{ puedeReabrir: boolean; motivo: string | null }> {
  const fy = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } });
  if (!fy) return { puedeReabrir: false, motivo: null };
  const no = motivoNoReabrir(fy, await datosCierres(companyId));
  return { puedeReabrir: !no, motivo: no?.mensaje ?? null };
}

const MENSAJE_DESHAZ_EN_CIERRE = 'Este ejercicio tiene asientos de cierre: deshaz el cierre desde Contabilidad > Cierre y traspaso de saldos.';

export const fiscalYearsService = {
  /**
   * Ejercicios de la empresa, con tieneAsientosCierre, el estado unico
   * (estadoEfectivo) y, en los cerrados sin asientos, si se pueden reabrir
   * (puedeReabrir, motivoNoReabrir).
   */
  async listar(companyId: string) {
    const [ejercicios, datos] = await Promise.all([
      prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'desc' } }),
      datosCierres(companyId),
    ]);
    return ejercicios.map((fy) => {
      const tieneAsientosCierre = datos.cierres.some((f) => dentroDe(f, fy));
      const estadoEfectivo = estadoEfectivoEjercicio(fy.estado, tieneAsientosCierre);
      const no = estadoEfectivo === 'CERRADO_SIN_ASIENTOS' ? motivoNoReabrir(fy, datos) : null;
      return {
        ...fy,
        tieneAsientosCierre,
        estadoEfectivo,
        puedeReabrir: estadoEfectivo === 'CERRADO_SIN_ASIENTOS' && !no,
        motivoNoReabrir: no?.mensaje ?? null,
      };
    });
  },

  /**
   * Reabre un ejercicio CERRADO_SIN_ASIENTOS (lo cerro el boton de Registro
   * Mercantil, que no regularizaba ni cerraba): lo mismo que deshacer el cierre,
   * sin asientos que anular. Con asientos de cierre, 409: eso se deshace en
   * Cierre y traspaso de saldos. Tampoco se reabre si un ejercicio posterior ya
   * esta cerrado con asientos o si no tiene asientos (motivoNoReabrir).
   *
   * Sus 12 meses quedan BLOQUEADOS: el ejercicio pudo tener libros legalizados
   * o cuentas depositadas, y hasta repetir el cierre nada se apunta en el por
   * error. Quien tenga contabilidad:write desbloquea el mes que tenga que
   * ajustar. No toca libros generados, expedientes ni cuentas anuales.
   */
  async reabrirSinAsientos(companyId: string, fyId: string) {
    const fy = await prisma.fiscalYear.findFirst({ where: { id: fyId, companyId } });
    if (!fy) throw notFound('Ejercicio contable no encontrado.');
    const datos = await datosCierres(companyId);
    const tieneAsientosCierre = datos.cierres.some((f) => dentroDe(f, fy));
    const estado = estadoEfectivoEjercicio(fy.estado, tieneAsientosCierre);
    if (estado === 'CERRADO') {
      throw conflict(MENSAJE_DESHAZ_EN_CIERRE, { enlace: enlaceCierre(fy.label) });
    }
    if (estado === 'ABIERTO') throw conflict(`El ejercicio ${fy.label} ya está abierto.`);
    const no = motivoNoReabrir(fy, datos);
    if (no) throw conflict(no.mensaje, { motivo: no.motivo });
    const anio = anioDe(fy);
    const reabierto = await prisma.$transaction(async (tx) => {
      // Solo si sigue cerrado (dos clics a la vez no hacen nada raro).
      const r = await tx.fiscalYear.updateMany({
        where: { id: fy.id, estado: 'CLOSED' },
        data: { estado: 'OPEN', closingDate: null, legalizationDeadline: null, accountsDepositDeadline: null, asientosBloqueados: false },
      });
      if (r.count !== 1) throw conflict(`El ejercicio ${fy.label} ya está abierto.`);
      const libros = await tx.legalBook.deleteMany({ where: { fiscalYearId: fy.id, status: 'PENDING', filePath: '' } });
      let mesesBloqueados = 0;
      if (anio !== null) {
        const fechaApertura = new Date().toISOString();
        const nuevos = await tx.periodo.createMany({
          data: Array.from({ length: 12 }, (_, i) => ({ companyId, ejercicio: anio, mes: i + 1, estado: 'bloqueado', fechaApertura })),
          skipDuplicates: true,
        });
        const abiertos = await tx.periodo.updateMany({ where: { companyId, ejercicio: anio, estado: 'abierto' }, data: { estado: 'bloqueado' } });
        mesesBloqueados = nuevos.count + abiertos.count;
      }
      return { fy: await tx.fiscalYear.findUniqueOrThrow({ where: { id: fy.id } }), librosPendientesBorrados: libros.count, mesesBloqueados };
    });
    return {
      ...reabierto.fy,
      tieneAsientosCierre: false,
      estadoEfectivo: 'ABIERTO' as EstadoEfectivoEjercicio,
      puedeReabrir: false,
      motivoNoReabrir: null,
      librosPendientesBorrados: reabierto.librosPendientesBorrados,
      mesesBloqueados: reabierto.mesesBloqueados,
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
