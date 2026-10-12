/**
 * Borradores de los modelos 347, 390 y 200 con el diseño OFICIAL de la AEAT
 * (src/aeat/oficial). Una sola fuente para la pantalla y para el fichero: el
 * borrador (casillas, registros y avisos) y la descarga salen del mismo cálculo,
 * hecho al momento con las facturas y la contabilidad de la empresa. Si la
 * declaración está presentada (y no se prepara otra), los dos salen de la
 * instantánea guardada al presentarla (B4). Nada de aquí escribe (B6).
 */
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import type { DatosModelo347, DesgloseIva, FacturaFiscal } from '../domain/impuestos.model';
import { construirModelo347, declarados347Desde, type Declaracion347 } from '../aeat/oficial/modelo347';
import { construirModelo390, type Declaracion390, type Entrada390 } from '../aeat/oficial/modelo390';
import { construirModelo200, type Declaracion200 } from '../aeat/oficial/modelo200';
import { agregar303, agregar347, agregar390, exigirModelosAeat, esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS, obtenerFacturasFiscales } from './impuestosCalculo.service';
import { calcularEstadosFinancieros } from './impuestoSociedadesCalculo.service';
import { listarCuentasBancarias } from './bancos.service';
import { periodoFiscal } from './nominas/fiscal';
import { claveDeclarado347 } from '../aeat/oficial/modelo347';
import { AVISO_SIN_NUMERO, contactoEmpresa, declaracionInformativa, erroresContacto, exigirNumero, registrosElegidos } from './borradoresAeat/comun';
import { avisoCongelada, contextoDeclaracion, datosDe } from './declaracionesAeat/declaraciones.service';
import { casillasOficiales303De } from './modelo303.service';
import type { DatosModelo303 } from '../domain/impuestos.model';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Datos de la sociedad que guarda la app (Registro Mercantil > Datos para la memoria). */
async function datosSociedad(companyId: string) {
  const legal = await Promise.resolve()
    .then(() => prisma.legalConfig.findUnique({ where: { companyId } }))
    .catch(() => null);
  return {
    nif: legal?.nif ?? '',
    razonSocial: legal?.denominacion ?? '',
    telefono: legal?.telefono ?? null,
    email: legal?.email ?? null,
    actividad: legal?.actividad ?? null,
    cnae: legal?.cnae ?? null,
    fechaConstitucion: legal?.fechaConstitucion ?? null,
    ejercicioInicio: legal?.ejercicioInicio ?? '01-01',
    ejercicioFin: legal?.ejercicioFin ?? '12-31',
  };
}

// ---------------------------------------------------------------------------
// 347
// ---------------------------------------------------------------------------

/** Borrador del 347 con lo que lo identifica en el historial (B4) y todos sus registros. */
export type Borrador347 = Declaracion347 & {
  datos: DatosModelo347;
  /** Número identificativo (B5); null hasta que se descarga o se presenta. */
  numeroDeclaracion: string | null;
  /** Todos los declarados del año con su clave (para elegir los de una complementaria). */
  registrosDeclaracion: Array<{ clave: string; nombre: string; importe: number }>;
  /** Presentado: lo que se enseña es la instantánea. */
  congelada?: boolean;
};

/**
 * Borrador del 347. Contacto y teléfono, de Registro Mercantil > Datos (B3);
 * tipo, anterior, número y registros elegidos, del historial (B4 y B5).
 */
export async function borrador347(companyId: string, ejercicio: number, opts: { calcular?: boolean } = {}): Promise<Borrador347> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const [facturas, soc, contacto, decl] = await Promise.all([
    obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`),
    datosSociedad(companyId),
    contactoEmpresa(companyId),
    declaracionInformativa(companyId, '347', ejercicio, '0A'),
  ]);
  // Presentado: la pantalla es la que se guardó al presentarlo.
  // `calcular`: lo de hoy aunque este presentado (para proponer los registros de una complementaria).
  const congelado = decl.ctx.congelada && !opts.calcular ? (datosDe(decl.ctx.ultimaPresentada).pantalla as Borrador347 | null) : null;
  if (congelado) return { ...congelado, congelada: true, advertencias: [avisoCongelada(decl.ctx.ultimaPresentada!), ...(congelado.advertencias ?? [])] };
  const datos = agregar347(facturas, ejercicio);
  const todos = declarados347Desde(datos);
  const elegidos = registrosElegidos(todos, claveDeclarado347, decl.seleccion);
  const d = construirModelo347(
    ejercicio,
    {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      telefono: contacto.telefono,
      contacto: contacto.personaContacto,
      complementaria: decl.tipoDeclaracion ? { tipo: decl.tipoDeclaracion, numeroAnterior: decl.declaracionAnterior ?? '' } : null,
      numeroIdentificativo: decl.numeroDeclaracion ?? undefined,
    },
    elegidos,
  );
  const advertencias = [...(datos.advertencias ?? []), ...d.advertencias];
  if (!decl.numeroDeclaracion) advertencias.push(AVISO_SIN_NUMERO);
  const errores = [...d.errores];
  if (decl.seleccion && !elegidos.length) errores.push('La complementaria no lleva ningún declarado: marca los que se quedaron fuera de la declaración anterior.');
  return {
    ...d,
    advertencias,
    errores,
    datos,
    numeroDeclaracion: decl.numeroDeclaracion,
    registrosDeclaracion: todos.map((x) => ({ clave: claveDeclarado347(x), nombre: x.nombre, importe: x.importeAnual })),
  };
}

export async function fichero347(companyId: string, ejercicio: number) {
  const b = await borrador347(companyId, ejercicio);
  if (b.congelada) return { nombre: `347_${ejercicio}.txt`, contenido: await ficheroCongelado(companyId, '347', ejercicio, '0A'), advertencias: b.advertencias, numeroIdentificativo: b.declarante.numeroIdentificativo };
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 347: ${b.errores.join(' ')}`, { errores: b.errores });
  exigirNumero(b.numeroDeclaracion, '347');
  return { nombre: `347_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias, numeroIdentificativo: b.declarante.numeroIdentificativo };
}

/** Fichero guardado al presentar (el que se descarga mientras la declaración está congelada). */
async function ficheroCongelado(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<string> {
  const ctx = await contextoDeclaracion(companyId, codigo, ejercicio, periodo);
  const f = datosDe(ctx.ultimaPresentada).fichero;
  if (!f) throw badRequest(`El ${codigo} está presentado pero no se guardó su fichero: descárgalo de la sede.`);
  return f;
}

// ---------------------------------------------------------------------------
// 390
// ---------------------------------------------------------------------------

/** Adquisiciones intracomunitarias autoliquidadas por tipo: si la factura no trae cuota, se calcula al tipo de la linea o al 21 %. */
function autoliquidadas(compras: FacturaFiscal[]): DesgloseIva[] {
  const mapa = new Map<number, { base: number; cuota: number }>();
  for (const f of compras) {
    for (const l of f.lineas) {
      const tipo = l.tipoIva > 0 ? l.tipoIva : 21;
      const cuota = aCentimos(l.cuota) !== 0 ? aCentimos(l.cuota) : Math.round((aCentimos(l.base) * tipo) / 100);
      const a = mapa.get(tipo) ?? { base: 0, cuota: 0 };
      a.base += aCentimos(l.base);
      a.cuota += cuota;
      mapa.set(tipo, a);
    }
  }
  return [...mapa.entries()].map(([tipo, a]) => ({ tipo, base: a.base / 100, cuota: a.cuota / 100 }));
}

function porTipo(facturas: FacturaFiscal[]): DesgloseIva[] {
  const mapa = new Map<number, { base: number; cuota: number }>();
  for (const f of facturas) {
    for (const l of f.lineas) {
      const a = mapa.get(l.tipoIva) ?? { base: 0, cuota: 0 };
      a.base += aCentimos(l.base);
      a.cuota += aCentimos(l.cuota);
      mapa.set(l.tipoIva, a);
    }
  }
  return [...mapa.entries()].map(([tipo, a]) => ({ tipo, base: a.base / 100, cuota: a.cuota / 100 }));
}

/**
 * Entrada del 390 a partir de las facturas fiscales del año (logica pura).
 * Devengado: las ventas del regimen general (como el 303). Deducible: las
 * compras interiores deducibles. Las adquisiciones intracomunitarias se
 * autoliquidan (devengado y deducible por el mismo importe: no cambian el
 * resultado). Los resultados trimestrales son los del 303 de cada trimestre.
 */
export function entrada390Desde(
  facturas: FacturaFiscal[],
  ejercicio: number,
  identificacion: Entrada390['identificacion'],
  extra: Pick<Entrada390, 'compensarEjercicioAnterior' | 'ultimoPeriodo' | 'programa'> & {
    /** Resultados de los 303 del año (los presentados, si los hay); sin ellos, los cuatro trimestres calculados con las facturas. */
    resultados303?: Resultados303;
  } = {},
): { entrada: Entrada390; advertencias: string[] } {
  const { resultados303, ...resto } = extra;
  const datos = agregar390(facturas, ejercicio);
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const compras = delAno.filter((f) => f.tipo === 'compra');
  const deducibles = compras.filter((f) => f.deducible !== false);
  // Autoliquidadas: todas al devengado (también las de IVA no deducible, como en
  // el 303 [10]/[11]); al deducible, solo las deducibles.
  const intraTodas = compras.filter((f) => f.operacion === 'intracomunitaria');
  const intra = deducibles.filter((f) => f.operacion === 'intracomunitaria');
  const esServicio = (f: FacturaFiscal) => !!f.tipoGasto && f.tipoGasto !== 'COMPRA';
  const noDeducible = compras.filter((f) => f.deducible === false).reduce((a, f) => a + f.lineas.reduce((x, l) => x + aCentimos(l.base), 0), 0);
  const periodos = resultados303?.periodos ?? ['1T', '2T', '3T', '4T'];
  const resultados = resultados303?.resultados ?? periodos.map((p) => agregar303(facturas, periodoFiscal(ejercicio, p)).resultado);
  const advertencias = [...(datos.advertencias ?? []), ...(resultados303?.avisos ?? [])];
  if (intraTodas.length) {
    advertencias.push(
      'Las adquisiciones intracomunitarias se autoliquidan en el 390 (devengado y deducible por el mismo importe, al tipo de la línea o al 21 %). Comprueba que coincide con lo que declaraste en los 303.',
    );
  }
  const importaciones = deducibles
    .filter((f) => f.operacion === 'exportacion')
    .map((f) => ({ ...f, lineas: f.lineas.filter((l) => aCentimos(l.cuota) !== 0) }));
  if (compras.some((f) => f.operacion === 'exportacion' && f.lineas.every((l) => aCentimos(l.cuota) === 0))) {
    advertencias.push('Hay compras a proveedores de fuera de la UE sin IVA en la factura: el IVA de la importación (DUA) solo entra si lo registras como gasto con su cuota.');
  }
  return {
    entrada: {
      ejercicio,
      identificacion,
      devengado: datos.resumenDevengado,
      adquisicionesIntraBienes: autoliquidadas(intraTodas.filter((f) => !esServicio(f))),
      adquisicionesIntraServicios: autoliquidadas(intraTodas.filter(esServicio)),
      deducibleIntraBienes: autoliquidadas(intra.filter((f) => !esServicio(f))),
      deducibleIntraServicios: autoliquidadas(intra.filter(esServicio)),
      deducibleInterior: porTipo(deducibles.filter((f) => f.operacion === 'interior')),
      importaciones: porTipo(importaciones),
      baseNoDeducible: noDeducible / 100,
      volumen: datos.volumen ?? {
        regimenGeneral: datos.volumenOperaciones,
        intracomunitarias: 0,
        exportacionesYExentasConDeduccion: 0,
        exentasSinDeduccion: 0,
        noSujetas: 0,
        isp: 0,
        total: datos.volumenOperaciones,
      },
      resultadosTrimestrales: resultados,
      periodosResultados: periodos,
      ...resto,
    },
    advertencias,
  };
}

/** Resultados de los 303 del año para el 390, con su periodo y los avisos de lo que no está presentado. */
export interface Resultados303 {
  periodos: string[];
  resultados: number[];
  avisos: string[];
}

/**
 * Resultados de los 303 del año para las casillas [95], [97], [98] y [662] del
 * 390: de cada periodo, lo PRESENTADO (la última declaración, rectificativa
 * incluida: [69] + [78], el resultado antes de compensar cuotas anteriores);
 * si no está presentado, el cálculo de hoy con las facturas, con un aviso.
 * Así el cuadre compara con lo que se ingresó de verdad aunque después se
 * haya registrado o cambiado una factura.
 *
 * Periodicidad: en cada trimestre se usan los meses si hay alguna fila mensual
 * del 303 en ese trimestre o la empresa lo presenta cada mes (REDEME, SII, gran
 * empresa o periodicidad mensual en los ajustes) y no hay fila del trimestre.
 */
export async function resultados303DelAno(companyId: string, ejercicio: number, facturas: FacturaFiscal[], mensualPorDefecto: boolean): Promise<Resultados303> {
  const filas = await Promise.resolve()
    .then(() => prisma.modeloImpuesto.findMany({ where: { companyId, codigo: '303', ejercicio } }))
    .catch(() => []);
  const fila = new Map(filas.map((f) => [f.periodo, f]));
  const periodos: string[] = [];
  for (let t = 1; t <= 4; t++) {
    const meses = [t * 3 - 2, t * 3 - 1, t * 3].map((m) => String(m).padStart(2, '0'));
    const hayMes = meses.some((m) => fila.has(m));
    const usarMeses = hayMes || (mensualPorDefecto && !fila.has(`${t}T`));
    periodos.push(...(usarMeses ? meses : [`${t}T`]));
  }
  const sinPresentar: string[] = [];
  const resultados = periodos.map((p) => {
    const f = fila.get(p);
    const datos = f?.datos as (DatosModelo303 & { casillasOficiales?: Record<string, number> }) | null | undefined;
    if (f?.estado === 'presentado' && datos && (datos.casillasOficiales || typeof datos.resultado === 'number')) {
      const c = casillasOficiales303De(datos);
      if (typeof c['69'] === 'number') return Math.round((c['69'] + (c['78'] ?? 0)) * 100) / 100;
      return Number(datos.resultado ?? c['46'] ?? 0) || 0;
    }
    sinPresentar.push(p);
    return agregar303(facturas, periodoFiscal(ejercicio, p)).resultado;
  });
  const avisos = sinPresentar.length
    ? [
        `${sinPresentar.length === 1 ? 'El 303 de' : 'Los 303 de'} ${sinPresentar.join(', ')} no ${sinPresentar.length === 1 ? 'está marcado' : 'están marcados'} como presentado${sinPresentar.length === 1 ? '' : 's'}: el resultado de ${sinPresentar.length === 1 ? 'ese periodo' : 'esos periodos'} sale de las facturas de hoy. Márcalos como presentados para que el 390 use lo que se presentó.`,
      ]
    : [];
  return { periodos, resultados, avisos };
}

/**
 * Cuotas a compensar que vienen del año anterior: la casilla [110] del primer
 * 303 del año guardado (1T, o 01 si se presenta cada mes).
 */
async function compensarDelAnoAnterior(companyId: string, ejercicio: number, primerPeriodo = '1T'): Promise<number> {
  const fila = await Promise.resolve()
    .then(() => prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '303', ejercicio, periodo: primerPeriodo } } }))
    .catch(() => null);
  const cas = (fila?.casillas ?? {}) as Record<string, unknown>;
  const clave = Object.keys(cas).find((k) => /^110(_|$)/.test(k));
  return clave ? Math.abs(Number(cas[clave]) || 0) : 0;
}

const textoOpcion = (v: unknown): string | undefined => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim().slice(0, 120));

function importeOpcion(q: Record<string, unknown>, nombre: string): number | undefined {
  const v = textoOpcion(q[nombre]);
  if (v === undefined) return undefined;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`El importe "${nombre}" no es válido: escribe una cifra positiva.`);
  return n;
}

/** Opciones del 390 de la pantalla (query del borrador, o `opciones` al presentarlo). */
export function opciones390De(q: Record<string, unknown>): Opciones390 {
  const ultimo = textoOpcion(q.ultimoPeriodo);
  if (ultimo && ultimo !== 'compensar' && ultimo !== 'devolver') throw badRequest('El último periodo puede ser "compensar" o "devolver".');
  return { ultimoPeriodo: ultimo as Opciones390['ultimoPeriodo'], compensarEjercicioAnterior: importeOpcion(q, 'compensarAnterior') };
}

/** Opciones del 200 de la pantalla (query del borrador, o `opciones` al presentarlo). */
export function opciones200De(q: Record<string, unknown>): Opciones200 {
  const pf = ['pf1', 'pf2', 'pf3'].map((k) => importeOpcion(q, k));
  const nueva = textoOpcion(q.nuevaCreacion);
  return {
    binsPendientes: importeOpcion(q, 'bins'),
    pagosFraccionados: pf.some((x) => x !== undefined) ? (pf.map((x) => x ?? 0) as [number, number, number]) : undefined,
    retenciones: importeOpcion(q, 'retenciones'),
    nuevaCreacion: nueva === undefined ? undefined : nueva === '1' || nueva === 'true',
  };
}

export interface Opciones390 {
  ultimoPeriodo?: 'compensar' | 'devolver';
  compensarEjercicioAnterior?: number;
}

export async function borrador390(companyId: string, ejercicio: number, opciones: Opciones390 = {}): Promise<Declaracion390 & { congelada?: boolean }> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  // Presentado: la pantalla es la que se guardó al presentarlo (B4).
  const ctx = await contextoDeclaracion(companyId, '390', ejercicio, '0A');
  const congelado = ctx.congelada ? (datosDe(ctx.ultimaPresentada).pantalla as Declaracion390 | null) : null;
  if (congelado) return { ...congelado, congelada: true, advertencias: [avisoCongelada(ctx.ultimaPresentada!), ...(congelado.advertencias ?? [])] };
  const [facturas, soc, ajustes] = await Promise.all([
    obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`),
    datosSociedad(companyId),
    Promise.resolve()
      .then(() => prisma.ajustesFiscales.findUnique({ where: { companyId } }))
      .catch(() => null),
  ]);
  const mensual = !!(ajustes && (ajustes.periodicidadIva === 'MENSUAL' || ajustes.redeme || ajustes.sii || ajustes.granEmpresa));
  const resultados303 = await resultados303DelAno(companyId, ejercicio, facturas, mensual);
  const compensar = opciones.compensarEjercicioAnterior ?? (await compensarDelAnoAnterior(companyId, ejercicio, resultados303.periodos[0]));
  const { entrada, advertencias } = entrada390Desde(
    facturas,
    ejercicio,
    {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      actividad: soc.actividad,
      cnae: soc.cnae,
      presenta347: agregar347(facturas, ejercicio).operaciones.length > 0,
      criterioCaja: !!ajustes?.criterioCaja,
      redeme: !!ajustes?.redeme,
    },
    { compensarEjercicioAnterior: compensar, ultimoPeriodo: opciones.ultimoPeriodo ?? 'compensar', resultados303 },
  );
  // Sustitutiva en preparación: marca y justificante de la anterior.
  if (ctx.enCurso?.tipo === 'S') entrada.sustitutiva = { justificanteAnterior: ctx.justificanteAnterior ?? '' };
  const decl = construirModelo390(entrada);
  return { ...decl, advertencias: [...advertencias, ...decl.advertencias] };
}

export async function fichero390(companyId: string, ejercicio: number, opciones: Opciones390 = {}) {
  const b = await borrador390(companyId, ejercicio, opciones);
  if (b.congelada) return { nombre: `390_${ejercicio}.txt`, contenido: await ficheroCongelado(companyId, '390', ejercicio, '0A'), advertencias: b.advertencias };
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 390: ${b.errores.join(' ')}`);
  return { nombre: `390_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias };
}

// ---------------------------------------------------------------------------
// 200
// ---------------------------------------------------------------------------

export interface Opciones200 {
  binsPendientes?: number;
  pagosFraccionados?: [number, number, number];
  retenciones?: number;
  nuevaCreacion?: boolean;
}

export async function borrador200(companyId: string, ejercicio: number, opciones: Opciones200 = {}): Promise<Declaracion200 & { congelada?: boolean }> {
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
  // Presentado: la pantalla es la que se guardó al presentarlo (B4).
  const ctx = await contextoDeclaracion(companyId, '200', ejercicio, '0A');
  const congelado = ctx.congelada ? (datosDe(ctx.ultimaPresentada).pantalla as Declaracion200 | null) : null;
  if (congelado) return { ...congelado, congelada: true, advertencias: [avisoCongelada(ctx.ultimaPresentada!), ...(congelado.advertencias ?? [])] };
  const [estados, soc, cuentas, fy, contacto] = await Promise.all([
    calcularEstadosFinancieros(companyId, ejercicio),
    datosSociedad(companyId),
    listarCuentasBancarias(companyId).catch(() => []),
    Promise.resolve()
      .then(() => prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } }))
      .catch(() => null),
    contactoEmpresa(companyId),
  ]);
  const anterior = estados.anterior.pyg;
  const hayAnterior = (anterior.partidas ?? []).some((x) => x.importe !== 0) || anterior.importeNetoCifraNegocios !== 0;
  const notas = (fy?.memoriaNotas ?? {}) as { plantillaMedia?: number | null };
  const decl = construirModelo200({
    ejercicio,
    identificacion: {
      nif: soc.nif,
      razonSocial: soc.razonSocial,
      cnae: soc.cnae,
      // Persona de contacto y teléfono (B3): los de Registro Mercantil > Datos.
      telefono: contacto.telefono || soc.telefono,
      email: soc.email,
      contacto: contacto.personaContacto || null,
      fechaInicio: fy?.fechaInicio ?? `${ejercicio}-${soc.ejercicioInicio}`,
      fechaFin: fy?.fechaFin ?? `${ejercicio}-${soc.ejercicioFin}`,
      fechaConstitucion: soc.fechaConstitucion,
    },
    balance: estados.balance,
    pyg: estados.pyg,
    reservaLegal: estados.reservaLegal,
    incnAnterior: hayAnterior ? anterior.importeNetoCifraNegocios : null,
    plantilla: notas.plantillaMedia != null ? { fijo: Number(notas.plantillaMedia) || 0, noFijo: 0 } : null,
    binsPendientes: opciones.binsPendientes,
    pagosFraccionados: opciones.pagosFraccionados,
    retenciones: opciones.retenciones,
    nuevaCreacion: opciones.nuevaCreacion,
    iban: cuentas.find((c) => c.activa)?.iban ?? null,
    // Rectificativa: lo ingresado con la anterior va a [01578] y no se vuelve a pedir.
    rectificativa:
      ctx.enCurso?.tipo === 'C'
        ? { justificanteAnterior: ctx.justificanteAnterior ?? '', resultadoAnterior: ctx.resultadoAnterior, devolucionAcordada: ctx.devolucionAcordada }
        : null,
  });
  // Sin persona de contacto o teléfono no hay fichero (B3).
  decl.errores.unshift(...erroresContacto(contacto));
  // Lo que hay en la 473 (retenciones y pagos a cuenta) ayuda a rellenar las casillas de la página 14 bis.
  let saldo473 = 0;
  for (const [cuenta, saldo] of estados.saldos.balance) if (cuenta.startsWith('473')) saldo473 += saldo;
  if (round2(saldo473) !== 0 && opciones.retenciones === undefined && opciones.pagosFraccionados === undefined) {
    decl.advertencias.unshift(
      `La cuenta 473 (retenciones y pagos a cuenta) tiene ${round2(saldo473).toFixed(2).replace('.', ',')} € al cierre: repártelos entre retenciones [01766] y pagos fraccionados [00601]-[00605].`,
    );
  }
  if (notas.plantillaMedia != null) decl.advertencias.push('La plantilla media de la memoria va entera como personal fijo [00041]: sepárala si hay personal no fijo.');
  return decl;
}

export async function fichero200(companyId: string, ejercicio: number, opciones: Opciones200 = {}) {
  const b = await borrador200(companyId, ejercicio, opciones);
  if (b.congelada) return { nombre: `200_${ejercicio}.txt`, contenido: await ficheroCongelado(companyId, '200', ejercicio, '0A'), advertencias: b.advertencias };
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 200: ${b.errores.join(' ')}`);
  return { nombre: `200_${ejercicio}.txt`, contenido: b.fichero, advertencias: b.advertencias };
}
