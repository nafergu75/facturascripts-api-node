/**
 * Intenciones de impuestos (capa 1, 0 €): el IVA del trimestre (INT-28, modelo
 * 303) y los próximos impuestos y plazos (INT-30).
 *
 * SOLO LECTURA. Nunca se usan listarModelosImpuesto ni buscarModelo, que crean
 * las filas del calendario al leer: aquí se lee con calendarioFiscalSoloLectura
 * y modeloGuardadoSoloLectura, que no escriben nada.
 */
import { calcularModelo303 } from '../../impuestosCalculo.service';
import { calendarioFiscalSoloLectura, modeloGuardadoSoloLectura, type ModeloCalendarioLectura } from '../../impuestosModulo.service';
import { tiene } from '../contexto';
import { botonIntencion, diasEntre, eur, fechaES, plural, tabla } from '../plantillas';
import { periodoTrimestre, resolverCodigoPeriodo, trimestreDe } from '../huecos/periodo';
import { AVISO_FESTIVOS, NOMBRES_MODELO, diasHasta, etiquetaPeriodo, frasePlazo, plazosDelEjercicio, proximosPlazos } from '../faq/calendario';
import type { CarmenCtx, HuecosResueltos, Kpi, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

// ---------------- INT-28: IVA del trimestre (303) ----------------

const numero = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const ivaDelTrimestre: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'impuestos:read')) return { sinPermiso: true, area: 'impuestos' };
  // Por defecto, el último trimestre cerrado, que es el que toca presentar.
  const pedido = h.periodo ?? resolverCodigoPeriodo('trimestre-pasado', ctx.hoy)!;
  const anio = Number(pedido.desde.slice(0, 4));
  const t = trimestreDe(pedido.desde);
  const trimestre = periodoTrimestre(anio, t);
  const avisos: string[] = [];
  if (pedido.desde !== trimestre.desde || pedido.hasta !== trimestre.hasta) {
    avisos.push(`El 303 es trimestral: te enseño el ${t}T de ${anio}, que es el trimestre de ${pedido.etiqueta}.`);
  }
  const entendido = `IVA del ${t}T de ${anio} (modelo 303)`;
  if (trimestre.desde > ctx.hoy) {
    return { entendido, texto: `El ${t}T de ${anio} todavía no ha empezado.`, sinCifras: true };
  }
  const periodo = `${t}T`;
  const guardado = await modeloGuardadoSoloLectura(ctx.companyId, '303', anio, periodo);
  const c = guardado?.casillas ?? null;
  const resultadoGuardado = c ? numero(c['71_resultado']) : null;

  let resultado: number;
  let devengado: number | null;
  let deducible: number | null;
  let origen: string;
  if (resultadoGuardado !== null) {
    resultado = resultadoGuardado;
    devengado = numero(c!['27_total_devengado']);
    deducible = numero(c!['45_total_deducir']) ?? numero(c!['29_cuota_deducible']);
    origen =
      guardado!.origen === 'manual-mixto'
        ? 'Es el importe del modelo guardado en Fiscalidad → Modelo 303, con cambios hechos a mano.'
        : 'Es el importe del modelo guardado en Fiscalidad → Modelo 303.';
  } else {
    const d = await calcularModelo303(ctx.companyId, { ejercicio: anio, periodo, tipo: 'trimestral', fechaInicio: trimestre.desde, fechaFin: trimestre.hasta });
    resultado = d.resultadoFinal ?? d.resultado;
    devengado = d.totalCuotaDevengada;
    deducible = d.totalCuotaDeducible;
    origen =
      'Todavía no lo tienes guardado en la app: lo calculo con las facturas del trimestre (sin borradores) y sin restar cuotas a compensar de trimestres anteriores.';
    if (d.advertencias?.length) avisos.push(...d.advertencias);
  }
  const enCurso = trimestre.hasta >= ctx.hoy;
  if (enCurso) avisos.push('El trimestre todavía no ha terminado: la cifra lleva solo las facturas registradas hasta hoy.');

  const sale =
    resultado > 0
      ? `sale a ingresar ${eur(resultado)}`
      : resultado < 0
        ? t === 4
          ? `sale negativo, ${eur(-resultado)}: en el 4T puedes pedir la devolución o compensarlo después`
          : `sale negativo, ${eur(-resultado)}, que se compensa en los trimestres siguientes`
        : 'sale a cero';
  const plazo = plazosDelEjercicio(anio).find((p) => p.modelo === '303' && p.periodo === periodo)!;
  const presentado = guardado?.estado === 'presentado';
  const textoPlazo =
    presentado
      ? ' En la app consta como presentado.'
      : plazo.fecha >= ctx.hoy
        ? ` ${frasePlazo(plazo, ctx.hoy)}`
        : ` El plazo terminó el ${fechaES(plazo.fecha)} y en la app no consta como presentado.`;
  if (!presentado && plazo.fecha >= ctx.hoy) avisos.push(AVISO_FESTIVOS);

  const kpis: Kpi[] = [
    ...(devengado !== null ? [{ etiqueta: 'IVA devengado', valor: eur(devengado) }] : []),
    ...(deducible !== null ? [{ etiqueta: 'IVA deducible', valor: eur(deducible) }] : []),
    { etiqueta: 'Resultado del 303', valor: eur(resultado), detalle: `${t}T de ${anio}` },
  ];
  return {
    entendido,
    texto: `El 303 del ${t}T de ${anio} ${sale}. ${origen}${textoPlazo}`,
    permisoRequerido: 'impuestos:read',
    kpis,
    enlaces: [{ texto: 'Ir al modelo 303', href: '/dashboard/fiscal/modelo-303' }],
    ...(avisos.length ? { avisos } : {}),
    botones:
      t === trimestreDe(ctx.hoy) && anio === Number(ctx.hoy.slice(0, 4))
        ? [botonIntencion('¿Y el trimestre pasado?', 'INT-28', { periodo: 'trimestre-pasado' })]
        : [botonIntencion('¿Y este trimestre?', 'INT-28', { periodo: 'este-trimestre' })],
  };
};

// ---------------- INT-30: próximos impuestos y plazos ----------------

const COLS_PLAZOS = [
  { titulo: 'Modelo', tipo: 'codigo' as const, ancho: 2 },
  { titulo: 'Qué es', tipo: 'texto' as const, ancho: 8 },
  { titulo: 'Periodo', tipo: 'texto' as const, ancho: 4 },
  { titulo: 'Hasta el', tipo: 'fecha' as const, ancho: 3 },
];

/** Plazos generales (sin mirar la empresa): para quien no tiene permiso de impuestos. */
function plazosGenerales(ctx: CarmenCtx): RespuestaDatos {
  const plazos = proximosPlazos(ctx.hoy, 6);
  const primero = plazos[0];
  const dias = primero ? diasHasta(ctx.hoy, primero.fecha) : 0;
  return {
    entendido: `Próximos plazos de presentación desde el ${fechaES(ctx.hoy)}`,
    texto:
      (primero
        ? `El próximo plazo es el ${fechaES(primero.fecha)}${dias === 0 ? ' (hoy)' : ` (dentro de ${plural(dias, 'día')})`}: modelo ${primero.modelo}, ${NOMBRES_MODELO[primero.modelo]}. `
        : '') + 'Son los plazos generales de una empresa con ejercicio natural; no miran qué modelos te tocan ni si ya los has presentado.',
    sinCifras: true,
    tabla: tabla(
      'Próximos plazos generales',
      `Desde el ${fechaES(ctx.hoy)}`,
      COLS_PLAZOS,
      plazos.map((p) => ({ celdas: [p.modelo, p.nombre, etiquetaPeriodo(p).replace(/^el /, ''), p.fecha] })),
    ),
    avisos: [AVISO_FESTIVOS],
  };
}

const periodoModelo = (m: ModeloCalendarioLectura) => (m.periodo === '0A' ? `ejercicio ${m.ejercicio}` : `${m.periodo} de ${m.ejercicio}`);

export const proximosImpuestos: Ejecutor = async (ctx) => {
  if (!tiene(ctx, 'impuestos:read')) return plazosGenerales(ctx);
  const modelos = await calendarioFiscalSoloLectura(ctx.companyId, ctx.hoy);
  const caducados = modelos.filter((m) => m.estado === 'expirado');
  const proximos = modelos.filter((m) => m.estado === 'vigente').slice(0, 6);
  const siguiente = proximos[0];
  const frases: string[] = [];
  if (caducados.length) {
    frases.push(
      caducados.length === 1
        ? `Tienes 1 modelo con el plazo ya pasado que en la app no consta como presentado ni omitido: el ${caducados[0].codigo} del ${periodoModelo(caducados[0])}.`
        : `Tienes ${caducados.length} modelos con el plazo ya pasado que en la app no constan como presentados ni omitidos (el más antiguo, el ${caducados[0].codigo} del ${periodoModelo(caducados[0])}).`,
    );
  } else {
    frases.push('No tienes modelos con el plazo pasado sin presentar.');
  }
  if (siguiente) {
    const dias = diasEntre(ctx.hoy, siguiente.fechaVencimiento);
    frases.push(
      `El próximo es el ${siguiente.codigo} (${NOMBRES_MODELO[siguiente.codigo] ?? siguiente.descripcion}) del ${periodoModelo(siguiente)}, hasta el ${fechaES(siguiente.fechaVencimiento)}${dias === 0 ? ' (hoy)' : ` (quedan ${plural(dias, 'día')})`}.`,
    );
  }
  frases.push('Miro los modelos de la pantalla Modelos Fiscales; los que no te tocan, márcalos allí como omitidos.');
  const filas = [
    ...caducados.map((m) => ({ celdas: [m.codigo, NOMBRES_MODELO[m.codigo] ?? m.descripcion, periodoModelo(m), m.fechaVencimiento, 'Plazo pasado'] })),
    ...proximos.map((m) => ({ celdas: [m.codigo, NOMBRES_MODELO[m.codigo] ?? m.descripcion, periodoModelo(m), m.fechaVencimiento, m.tieneBorrador ? 'Preparado' : 'Pendiente'] })),
  ];
  return {
    entendido: `Tus impuestos y plazos a ${fechaES(ctx.hoy)}`,
    texto: frases.join(' '),
    permisoRequerido: 'impuestos:read',
    kpis: [
      { etiqueta: 'Plazo pasado sin presentar', valor: caducados.length.toLocaleString('es-ES') },
      ...(siguiente ? [{ etiqueta: 'Próximo plazo', valor: fechaES(siguiente.fechaVencimiento), detalle: `Modelo ${siguiente.codigo}` }] : []),
    ],
    tabla: tabla('Modelos con plazo pasado y próximos', `A ${fechaES(ctx.hoy)}`, [...COLS_PLAZOS, { titulo: 'Estado', tipo: 'texto', ancho: 3 }], filas),
    enlaces: [{ texto: 'Ver el estado de tus modelos', href: '/dashboard/fiscal/estado' }],
    avisos: [AVISO_FESTIVOS],
  };
};

/** Bloque de impuestos para el resumen (INT-39): sin permiso, nada. */
export async function resumenImpuestos(ctx: CarmenCtx): Promise<{ caducados: number; siguiente?: ModeloCalendarioLectura } | null> {
  if (!tiene(ctx, 'impuestos:read')) return null;
  const modelos = await calendarioFiscalSoloLectura(ctx.companyId, ctx.hoy);
  return { caducados: modelos.filter((m) => m.estado === 'expirado').length, siguiente: modelos.find((m) => m.estado === 'vigente') };
}

export const EJECUTORES_IMPUESTOS = { ivaDelTrimestre, proximosImpuestos };
