/**
 * INT-18: beneficio y cuenta de pérdidas y ganancias (capa 1, 0 €).
 *
 * Las cifras salen de informePerdidasGanancias, el mismo cálculo que la
 * pantalla de Informes contables (asientos aprobados, sin regularización ni
 * cierre). Sin acceso a nóminas no se enseñan los gastos de personal (cuentas
 * 64x; las 465 y 476 son de balance y no salen en la cuenta de resultados) ni
 * se ofrece la descarga del informe completo.
 *
 * SOLO LECTURA: comprueba el permiso antes de llamar al servicio.
 */
import { prisma } from '../../../config/database';
import { informePerdidasGanancias } from '../../informesContables.service';
import { tiene } from '../contexto';
import { botonIntencion, eur, fechaES, plural, tabla } from '../plantillas';
import { hastaHoy, resolverCodigoPeriodo } from '../huecos/periodo';
import type { CarmenCtx, HuecosResueltos, Kpi, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

/** Partida de la cuenta de resultados con los sueldos y la Seguridad Social (cuentas 64x). */
const PARTIDA_PERSONAL = '6';

const diaSiguiente = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

export const CRITERIO_PYG =
  'Sale de los asientos aprobados, sin los de regularización ni cierre: lo que está en borrador o pendiente de revisión no cuenta.';

export const cuentaDeResultados: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'contabilidad:read')) return { sinPermiso: true, area: 'contabilidad' };
  const periodo = h.periodo ?? resolverCodigoPeriodo('este-anio', ctx.hoy)!;
  const entendido = `Resultado (pérdidas y ganancias) de ${periodo.etiqueta}`;
  if (periodo.ejercicios.length > 1) {
    return {
      entendido,
      texto: 'La cuenta de resultados se calcula dentro de un mismo ejercicio. ¿De qué año la quieres?',
      sinCifras: true,
      botones: periodo.ejercicios.map((a) => botonIntencion(`Resultado de ${a}`, 'INT-18', { periodo: String(a) })),
    };
  }
  if (periodo.desde > ctx.hoy) {
    return { entendido, texto: `Ese periodo (${periodo.etiqueta}) todavía no ha empezado.`, sinCifras: true };
  }
  const hasta = hastaHoy(periodo, ctx.hoy);
  const ejercicio = periodo.ejercicios[0];
  const [inf, sinAprobar] = await Promise.all([
    informePerdidasGanancias(ctx.companyId, { desde: periodo.desde, hasta, ejercicio }),
    prisma.journalEntry.count({
      where: { companyId: ctx.companyId, estado: { in: ['DRAFT', 'PENDING_REVIEW'] }, fecha: { gte: new Date(`${periodo.desde}T00:00:00Z`), lt: diaSiguiente(hasta) } },
    }),
  ]);
  const actual = inf.actual;
  const anterior = inf.anterior;
  const cifra = actual.partidas.find((p) => p.codigo === '1')?.importe ?? 0;
  // «Este trimestre», hasta hoy; «lo que va de 2026» ya lo dice.
  const recorte = hasta < periodo.hasta && !periodo.etiqueta.startsWith('lo que va') ? ', hasta hoy,' : '';
  const r = actual.resultadoEjercicio;
  const situacion = r > 0 ? `vas en beneficios: ${eur(r)}` : r < 0 ? `vas en pérdidas: ${eur(r)}` : 'el resultado es cero';
  const anioAnt = ejercicio - 1;
  const comparacion = ` En el mismo periodo de ${anioAnt} el resultado fue ${eur(anterior.resultadoEjercicio)}.`;

  const avisos: string[] = [];
  if (sinAprobar === 1) avisos.push('Hay 1 asiento sin aprobar con fecha en ese periodo: no cuenta hasta que lo apruebes.');
  else if (sinAprobar) avisos.push(`Hay ${plural(sinAprobar, 'asiento')} sin aprobar con fecha en ese periodo: no cuentan hasta que los apruebes.`);
  // Sin acceso a nóminas, fuera la fila de gastos de personal.
  let filas = inf.tabla.filas;
  if (!ctx.puedeNominas) {
    filas = filas.filter((f) => !String(f.celdas[0] ?? '').startsWith(`${PARTIDA_PERSONAL}. `));
    avisos.push('No te enseño los gastos de personal: hace falta acceso a nóminas en esta empresa.');
  }
  const kpis: Kpi[] = [
    { etiqueta: 'Cifra de negocios', valor: eur(cifra) },
    { etiqueta: 'Resultado', valor: eur(r), detalle: `${fechaES(periodo.desde)} a ${fechaES(hasta)}` },
    { etiqueta: `Mismo periodo de ${anioAnt}`, valor: eur(anterior.resultadoEjercicio) },
  ];
  const consulta = `desde=${periodo.desde}&hasta=${hasta}`;
  return {
    entendido,
    texto: `En ${periodo.etiqueta}${recorte} ${situacion}, con una cifra de negocios de ${eur(cifra)}.${comparacion} ${CRITERIO_PYG}`,
    permisoRequerido: 'contabilidad:read',
    kpis,
    tabla: tabla(
      'Pérdidas y ganancias',
      `Del ${fechaES(periodo.desde)} al ${fechaES(hasta)}, frente al mismo periodo de ${anioAnt}`,
      inf.tabla.columnas,
      filas,
    ),
    enlaces: [{ texto: 'Ver en Informes contables', href: '/dashboard/informes?tipo=pyg' }],
    ...(ctx.puedeNominas
      ? {
          descargas: [
            { texto: 'Descargar en PDF', ruta: `/informes-contables/perdidas-ganancias?${consulta}&formato=pdf`, formato: 'pdf' as const },
            { texto: 'Descargar en Excel', ruta: `/informes-contables/perdidas-ganancias?${consulta}&formato=xlsx`, formato: 'xlsx' as const },
          ],
        }
      : {}),
    ...(avisos.length ? { avisos } : {}),
    botones:
      periodo.codigo === 'este-anio'
        ? [botonIntencion('¿Y el año pasado?', 'INT-18', { periodo: 'anio-pasado' }), botonIntencion('Asientos sin aprobar', 'INT-23')]
        : [botonIntencion('¿Y este año?', 'INT-18', { periodo: 'este-anio' })],
  };
};
