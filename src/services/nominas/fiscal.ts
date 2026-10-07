/**
 * Fuente unica de lo fiscal de las retenciones: modelo 111 (trabajo y
 * profesionales) y modelo 190 (un registro por perceptor y clave). La usan el
 * modulo Impuestos (casillas oficiales y TXT del 111), la pantalla de modelos
 * fiscales (tax-models) y las rutas de nominas. Ver docs/ADR-004-nominas-fuente-fiscal.md.
 *
 *  - Trabajo: la tabla Nomina (una por trabajador y mes), no RetentionBook ni el
 *    resumen mensual antiguo. Va por FECHA DE PAGO (art. 78.1 RIRPF: la
 *    obligacion de retener nace al pagar): una nomina de diciembre pagada en
 *    enero entra en el 1T del ano siguiente. Cuentan las no anuladas; las que
 *    siguen en borrador tambien, con aviso.
 *  - Profesionales (actividades economicas): facturas de gasto confirmadas con
 *    retencion, por fecha de la factura (como hasta ahora).
 *  - Resumen mensual antiguo (NominaResumen, solo totales): solo para los meses
 *    sin nominas por trabajador, con aviso de que la casilla 01 no es fiable.
 *    No entra en el 190.
 */
import { prisma } from '../../config/database';
import type { PeriodoFiscal } from '../../domain/impuestos.model';
import { badRequest } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';

const euros = (centimos: number): number => Math.round(centimos) / 100;
const mm = (n: number) => String(n).padStart(2, '0');

const tablaLista = (nombre: string): boolean =>
  typeof (prisma as unknown as Record<string, { findMany?: unknown } | undefined>)[nombre]?.findMany === 'function';

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

/** Periodo fiscal de un ejercicio: '1T'..'4T', '01'..'12' (111 mensual) o '0A' (ano). */
export function periodoFiscal(ejercicio: number, periodo: string): PeriodoFiscal {
  const p = String(periodo).toUpperCase().trim();
  const ultimo = (m: number) => new Date(Date.UTC(ejercicio, m, 0)).toISOString().slice(0, 10);
  if (p === '0A') return { ejercicio, periodo: '0A', tipo: 'anual', fechaInicio: `${ejercicio}-01-01`, fechaFin: `${ejercicio}-12-31` };
  const t = /^([1-4])T$/.exec(p);
  if (t) {
    const n = Number(t[1]);
    return { ejercicio, periodo: `${n}T`, tipo: 'trimestral', fechaInicio: `${ejercicio}-${mm(n * 3 - 2)}-01`, fechaFin: ultimo(n * 3) };
  }
  const m = /^(0?[1-9]|1[0-2])$/.exec(p);
  if (m) {
    const n = Number(m[1]);
    return { ejercicio, periodo: mm(n), tipo: 'mensual', fechaInicio: `${ejercicio}-${mm(n)}-01`, fechaFin: ultimo(n) };
  }
  throw badRequest(`Periodo "${periodo}" no válido: usa 1T, 2T, 3T, 4T, un mes (01-12) o 0A.`);
}

/** Meses (1-12) del ejercicio que cubre un periodo. */
function mesesDe(p: PeriodoFiscal): number[] {
  const desde = Number(p.fechaInicio.slice(5, 7));
  const hasta = Number(p.fechaFin.slice(5, 7));
  return Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
}

// ---------------------------------------------------------------------------
// 111: rendimientos del trabajo (puro)
// ---------------------------------------------------------------------------

export interface NominaFiscal {
  empleadoId: string;
  nif: string;
  ejercicio: number;
  mes: number;
  ejercicioDevengo: number | null;
  fechaPago: string;
  estado: string;
  brutoDinerario: number;
  indemnizacionSujeta: number;
  indemnizacionExenta: number;
  dietasExentas: number;
  especieValoracion: number;
  ingresoACuenta: number;
  ingresoACuentaRepercutido: boolean;
  irpf: number;
  ssTrabajador: number;
}

export interface ResumenAntiguoNominas {
  mes: number;
  totalBruto: number;
  totalIRPF: number;
}

/** Casillas 01-06 del 111 (rendimientos del trabajo). */
export interface Casillas111Trabajo {
  /** [01] Perceptores distintos (por NIF) con percepciones dinerarias. */
  perceptoresDinerarios: number;
  /** [02] Bruto dinerario + indemnizacion sujeta (sin dietas ni indemnizaciones exentas). */
  percepcionesDinerarias: number;
  /** [03] IRPF retenido. */
  retencionesDinerarias: number;
  /** [04] Perceptores distintos con retribucion en especie. */
  perceptoresEspecie: number;
  /** [05] Valoracion de la especie + ingresos a cuenta no repercutidos (art. 43.2 LIRPF). */
  percepcionesEspecie: number;
  /** [06] Ingresos a cuenta de la especie. */
  ingresosACuenta: number;
}

/**
 * Casillas 01-06 a partir de las nominas del periodo (ya filtradas por fecha
 * de pago y sin anuladas) y, para los meses sin nominas, del resumen antiguo.
 */
export function agregarTrabajo111(nominas: NominaFiscal[], antiguos: ResumenAntiguoNominas[] = []): { casillas: Casillas111Trabajo; avisos: string[] } {
  const c = (v: number) => aCentimos(Number(v) || 0);
  const dinerarioPorNif = new Map<string, number>();
  const especiePorNif = new Map<string, number>();
  let dinerario = 0;
  let irpf = 0;
  let especie = 0;
  let iac = 0;
  for (const n of nominas) {
    const d = c(n.brutoDinerario) + c(n.indemnizacionSujeta);
    dinerarioPorNif.set(n.nif, (dinerarioPorNif.get(n.nif) ?? 0) + d);
    especiePorNif.set(n.nif, (especiePorNif.get(n.nif) ?? 0) + c(n.especieValoracion));
    dinerario += d;
    irpf += c(n.irpf);
    especie += c(n.especieValoracion) + (n.ingresoACuentaRepercutido ? 0 : c(n.ingresoACuenta));
    iac += c(n.ingresoACuenta);
  }
  const avisos: string[] = [];
  let perceptores = [...dinerarioPorNif.values()].filter((v) => v > 0).length;
  if (antiguos.length) {
    for (const a of antiguos) {
      dinerario += c(a.totalBruto);
      irpf += c(a.totalIRPF);
    }
    if (perceptores === 0 && antiguos.some((a) => c(a.totalBruto) > 0)) perceptores = 1;
    avisos.push(
      `${antiguos.length === 1 ? 'Un mes' : `${antiguos.length} meses`} del periodo (${antiguos.map((a) => mm(a.mes)).join(', ')}) solo ${antiguos.length === 1 ? 'tiene' : 'tienen'} el resumen antiguo de nóminas, sin trabajadores: la casilla 01 no es fiable. Corrígela con el número real de perceptores o importa las nóminas por trabajador.`,
    );
  }
  return {
    casillas: {
      perceptoresDinerarios: perceptores,
      percepcionesDinerarias: euros(dinerario),
      retencionesDinerarias: euros(irpf),
      perceptoresEspecie: [...especiePorNif.values()].filter((v) => v > 0).length,
      percepcionesEspecie: euros(especie),
      ingresosACuenta: euros(iac),
    },
    avisos,
  };
}

export interface RetencionesTrabajo {
  periodo: PeriodoFiscal;
  casillas: Casillas111Trabajo;
  /** Nominas que entran (por fecha de pago) y cuantas siguen en borrador. */
  nominas: number;
  borradores: number;
  /** Meses que solo tienen el resumen antiguo (sin trabajadores). */
  mesesResumenAntiguo: number[];
  avisos: string[];
}

function aNominaFiscal(n: Record<string, unknown> & { empleado: { nif: string } }): NominaFiscal {
  const num = (k: string) => Number(n[k] ?? 0);
  return {
    empleadoId: String(n.empleadoId),
    nif: n.empleado.nif,
    ejercicio: Number(n.ejercicio),
    mes: Number(n.mes),
    ejercicioDevengo: n.ejercicioDevengo === null || n.ejercicioDevengo === undefined ? null : Number(n.ejercicioDevengo),
    fechaPago: String(n.fechaPago),
    estado: String(n.estado),
    brutoDinerario: num('brutoDinerario'),
    indemnizacionSujeta: num('indemnizacionSujeta'),
    indemnizacionExenta: num('indemnizacionExenta'),
    dietasExentas: num('dietasExentas'),
    especieValoracion: num('especieValoracion'),
    ingresoACuenta: num('ingresoACuenta'),
    ingresoACuentaRepercutido: n.ingresoACuentaRepercutido === true,
    irpf: num('irpf'),
    ssTrabajador: num('ssTrabajador'),
  };
}

/** Nominas no anuladas pagadas (fecha de pago) entre dos fechas, con el NIF del trabajador. */
async function nominasPagadasEntre(companyId: string, desde: string, hasta: string): Promise<NominaFiscal[]> {
  if (!tablaLista('nomina')) return [];
  const filas = await prisma.nomina.findMany({
    where: { companyId, estado: { not: 'ANULADA' }, fechaPago: { gte: desde, lte: hasta } },
    include: { empleado: { select: { nif: true } } },
  });
  return filas.map((n) => aNominaFiscal(n as unknown as Record<string, unknown> & { empleado: { nif: string } }));
}

/**
 * Resumenes antiguos (solo totales) de los meses del periodo que no tienen
 * ninguna nomina por trabajador; si un mes se grabo varias veces, el ultimo.
 */
async function resumenesAntiguos(companyId: string, periodo: PeriodoFiscal): Promise<ResumenAntiguoNominas[]> {
  if (!tablaLista('nominaResumen')) return [];
  const meses = mesesDe(periodo);
  const filas = await prisma.nominaResumen.findMany({
    where: { companyId, ejercicio: periodo.ejercicio, mes: { in: meses } },
    orderBy: { createdAt: 'desc' },
  });
  if (!filas.length) return [];
  const conNominas = tablaLista('nomina')
    ? new Set(
        (
          await prisma.nomina.findMany({
            where: { companyId, ejercicio: periodo.ejercicio, mes: { in: meses }, estado: { not: 'ANULADA' } },
            select: { mes: true },
            distinct: ['mes'],
          })
        ).map((n) => n.mes),
      )
    : new Set<number>();
  const porMes = new Map<number, ResumenAntiguoNominas>();
  for (const r of filas) {
    if (conNominas.has(r.mes) || porMes.has(r.mes)) continue;
    porMes.set(r.mes, { mes: r.mes, totalBruto: Number(r.totalBruto), totalIRPF: Number(r.totalIRPF) });
  }
  return [...porMes.values()].sort((a, b) => a.mes - b.mes);
}

/**
 * Casillas 01-06 del 111 de un periodo: las nominas no anuladas cuya fecha de
 * pago cae en el periodo (y el resumen antiguo de los meses sin nominas).
 */
export async function retencionesTrabajo(companyId: string, periodo: PeriodoFiscal): Promise<RetencionesTrabajo> {
  const [nominas, antiguos] = await Promise.all([
    nominasPagadasEntre(companyId, periodo.fechaInicio, periodo.fechaFin),
    resumenesAntiguos(companyId, periodo),
  ]);
  const { casillas, avisos } = agregarTrabajo111(nominas, antiguos);
  const borradores = nominas.filter((n) => n.estado === 'BORRADOR').length;
  if (borradores) {
    avisos.unshift(
      `${borradores} nómina(s) con pago en el periodo siguen en borrador: cuentan en el 111, pero contabilízalas (o corrígelas) antes de presentarlo.`,
    );
  }
  return { periodo, casillas, nominas: nominas.length, borradores, mesesResumenAntiguo: antiguos.map((a) => a.mes), avisos };
}

// ---------------------------------------------------------------------------
// 111: rendimientos de actividades economicas (profesionales)
// ---------------------------------------------------------------------------

export interface RetencionesActividades {
  /** [07] Profesionales distintos con retencion. */
  perceptores: number;
  /** [08] Base de las facturas con retencion. */
  percepciones: number;
  /** [09] Retenciones practicadas. */
  retenciones: number;
}

/**
 * Retenciones a profesionales: facturas de gasto confirmadas (no borrador) con
 * retencion y fecha de la factura en el periodo.
 */
export async function retencionesActividades(companyId: string, periodo: PeriodoFiscal): Promise<RetencionesActividades> {
  if (!tablaLista('expenseInvoice')) return { perceptores: 0, percepciones: 0, retenciones: 0 };
  const conIrpf = await prisma.expenseInvoice.findMany({
    where: {
      companyId,
      estado: { not: 'DRAFT' },
      fechaEmision: { gte: periodo.fechaInicio, lte: periodo.fechaFin },
      retencionTotal: { gt: 0 },
    },
    select: { supplierId: true, retencionTotal: true, baseTotal: true },
  });
  return {
    perceptores: new Set(conIrpf.map((f) => f.supplierId)).size,
    percepciones: euros(conIrpf.reduce((a, f) => a + aCentimos(Number(f.baseTotal)), 0)),
    retenciones: euros(conIrpf.reduce((a, f) => a + aCentimos(Number(f.retencionTotal)), 0)),
  };
}

// ---------------------------------------------------------------------------
// 190: un registro por perceptor, clave y subclave
// ---------------------------------------------------------------------------

/** Registro de perceptor del 190 (los importes en euros, positivos). */
export interface Perceptor190 {
  clave: string;
  /** Subclave de dos digitos (claves B, C, E, F, G, H, I, K y L); null en la A. */
  subclave: string | null;
  nif: string;
  /** Apellidos y nombre (personas fisicas) o razon social. */
  nombre: string;
  /** Codigo de provincia de dos digitos (01-52, 98). */
  provincia: string | null;
  percepcionIntegra: number;
  retenciones: number;
  valoracionEspecie: number;
  ingresosACuentaEfectuados: number;
  ingresosACuentaRepercutidos: number;
  /** Ejercicio de devengo si es anterior (atrasos); null si es el del 190. */
  ejercicioDevengo: number | null;
  /** Gastos deducibles (art. 19.2 LIRPF): la SS a cargo del trabajador. */
  gastosDeducibles: number;
  anioNacimiento: number | null;
  /** 1, 2 o 3 (3 si no la comunico). */
  situacionFamiliar: number | null;
  nifConyuge: string | null;
  discapacidad: number | null;
  /** Contrato o relacion (solo clave A): 1 general, 2 inferior al ano... */
  contrato: number | null;
  movilidadGeografica: boolean;
  origen: 'nomina' | 'profesional';
  empleadoId?: string;
  proveedorId?: string;
  /** Nominas o facturas que suma. */
  documentos: number;
  /** Datos que faltan para poder generar el fichero. */
  faltan: string[];
}

export interface Modelo190 {
  ejercicio: number;
  perceptores: Perceptor190[];
  totales: {
    /** Registros de perceptor (tipo 2). */
    registros: number;
    /** Personas distintas (por NIF). */
    perceptores: number;
    /** Percepciones dinerarias + valoracion de la especie. */
    percepciones: number;
    /** Retenciones + ingresos a cuenta efectuados. */
    retenciones: number;
  };
  /** Suma de los cuatro 111 del ano (retenciones e ingresos a cuenta), para cuadrar con el 190. */
  cuadre111: { trimestres: Array<{ periodo: string; retenciones: number }>; total: number; coincide: boolean };
  avisos: string[];
}

/** Codigos de provincia del 190 (los dos primeros digitos del codigo postal, salvo La Palma = 53). */
const PROVINCIAS: Record<string, string> = {
  alava: '01', araba: '01', albacete: '02', alicante: '03', alacant: '03', almeria: '04', avila: '05', badajoz: '06',
  'illes balears': '07', baleares: '07', 'islas baleares': '07', barcelona: '08', burgos: '09', caceres: '10', cadiz: '11',
  castellon: '12', castello: '12', 'ciudad real': '13', cordoba: '14', 'a coruna': '15', coruna: '15', 'la coruna': '15',
  cuenca: '16', girona: '17', gerona: '17', granada: '18', guadalajara: '19', guipuzcoa: '20', gipuzkoa: '20', huelva: '21',
  huesca: '22', jaen: '23', leon: '24', lleida: '25', lerida: '25', 'la rioja': '26', rioja: '26', lugo: '27', madrid: '28',
  malaga: '29', murcia: '30', navarra: '31', ourense: '32', orense: '32', asturias: '33', palencia: '34', 'las palmas': '35',
  palmas: '35', pontevedra: '36', salamanca: '37', 'santa cruz de tenerife': '38', tenerife: '38', cantabria: '39',
  segovia: '40', sevilla: '41', soria: '42', tarragona: '43', teruel: '44', toledo: '45', valencia: '46', valladolid: '47',
  vizcaya: '48', bizkaia: '48', zamora: '49', zaragoza: '50', ceuta: '51', melilla: '52',
};

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Provincia (dos digitos) de un tercero: por su codigo postal o por el nombre de la provincia. */
export function codigoProvincia(cp: string | null | undefined, provincia: string | null | undefined): string | null {
  const c = String(cp ?? '').replace(/\D/g, '');
  if (c.length === 5 && Number(c.slice(0, 2)) >= 1 && Number(c.slice(0, 2)) <= 52) return c.slice(0, 2);
  const p = String(provincia ?? '').trim();
  if (/^(0[1-9]|[1-4]\d|5[0-3])$/.test(p)) return p;
  // "Alicante/Alacant", "Valencia/València"...: vale cualquiera de los dos nombres.
  for (const parte of p.split('/')) {
    const nombre = sinTildes(parte.toLowerCase()).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (PROVINCIAS[nombre]) return PROVINCIAS[nombre];
  }
  return null;
}

/** Contrato o relacion del 190 (clave A) segun el tipo de contrato del trabajador. */
export function contrato190(tipoContrato: string | null | undefined): number {
  // 2 = contrato de duracion inferior al ano: se supone en los temporales (revisalo si dura mas).
  return tipoContrato === 'TEMPORAL' ? 2 : 1;
}

interface EmpleadoFiscal {
  id: string;
  nif: string;
  nombre: string;
  apellidos: string;
  provincia: string | null;
  anioNacimiento: number | null;
  situacionFamiliar: number | null;
  nifConyuge: string | null;
  discapacidad: number | null;
  movilidadGeografica: boolean | null;
  tipoContrato: string;
  clave190: string;
  subclave190: string | null;
}

/** Registros del 190 de los trabajadores a partir de sus nominas del ano (puro). */
export function perceptoresDeNominas(ejercicio: number, nominas: Array<NominaFiscal>, empleados: Map<string, EmpleadoFiscal>): Perceptor190[] {
  const c = (v: number) => aCentimos(Number(v) || 0);
  type Acum = { e: EmpleadoFiscal; devengo: number | null; din: number; irpf: number; esp: number; iac: number; iacRep: number; ss: number; dietas: number; indExenta: number; docs: number };
  const grupos = new Map<string, Acum>();
  for (const n of nominas) {
    const e = empleados.get(n.empleadoId);
    if (!e) continue;
    const devengoAnual = n.ejercicioDevengo ?? n.ejercicio;
    const devengo = devengoAnual < ejercicio ? devengoAnual : null;
    const k = `${e.id}|${devengo ?? ''}`;
    const g = grupos.get(k) ?? { e, devengo, din: 0, irpf: 0, esp: 0, iac: 0, iacRep: 0, ss: 0, dietas: 0, indExenta: 0, docs: 0 };
    g.din += c(n.brutoDinerario) + c(n.indemnizacionSujeta);
    g.irpf += c(n.irpf);
    g.esp += c(n.especieValoracion);
    g.iac += c(n.ingresoACuenta);
    g.iacRep += n.ingresoACuentaRepercutido ? c(n.ingresoACuenta) : 0;
    g.ss += c(n.ssTrabajador);
    g.dietas += c(n.dietasExentas);
    g.indExenta += c(n.indemnizacionExenta);
    g.docs++;
    grupos.set(k, g);
  }
  const out: Perceptor190[] = [];
  for (const g of grupos.values()) {
    const e = g.e;
    const nombre = [e.apellidos, e.nombre].filter((s) => s?.trim()).join(' ').trim();
    const base = {
      nif: e.nif,
      nombre,
      provincia: e.provincia,
      ejercicioDevengo: g.devengo,
      origen: 'nomina' as const,
      empleadoId: e.id,
      documentos: g.docs,
    };
    const faltaProvincia = e.provincia ? [] : ['provincia'];
    if (g.din || g.irpf || g.esp || g.iac) {
      const faltan = [...faltaProvincia];
      if (!e.anioNacimiento) faltan.push('año de nacimiento');
      if (e.situacionFamiliar === 2 && !e.nifConyuge) faltan.push('NIF del cónyuge (situación familiar 2)');
      const clave = e.clave190 || 'A';
      out.push({
        ...base,
        clave,
        subclave: clave === 'A' ? null : e.subclave190,
        percepcionIntegra: euros(g.din),
        retenciones: euros(g.irpf),
        valoracionEspecie: euros(g.esp),
        ingresosACuentaEfectuados: euros(g.iac),
        ingresosACuentaRepercutidos: euros(g.iacRep),
        gastosDeducibles: euros(g.ss),
        anioNacimiento: e.anioNacimiento,
        situacionFamiliar: e.situacionFamiliar ?? 3,
        nifConyuge: e.situacionFamiliar === 2 ? e.nifConyuge : null,
        discapacidad: e.discapacidad ?? 0,
        contrato: clave === 'A' ? contrato190(e.tipoContrato) : null,
        movilidadGeografica: e.movilidadGeografica === true,
        faltan,
      });
    }
    // Rentas exentas: clave L. 01 dietas y gastos de viaje exceptuados; 05 indemnizacion por despido exenta.
    const exenta = (subclave: string, centimos: number) => {
      if (!centimos) return;
      out.push({
        ...base,
        clave: 'L',
        subclave,
        percepcionIntegra: euros(centimos),
        retenciones: 0,
        valoracionEspecie: 0,
        ingresosACuentaEfectuados: 0,
        ingresosACuentaRepercutidos: 0,
        gastosDeducibles: 0,
        anioNacimiento: null,
        situacionFamiliar: null,
        nifConyuge: null,
        discapacidad: null,
        contrato: null,
        movilidadGeografica: false,
        faltan: [...faltaProvincia],
      });
    };
    exenta('01', g.dietas);
    exenta('05', g.indExenta);
  }
  return out;
}

/** Registros G (profesionales) a partir de sus facturas con retencion (puro). */
export function perceptoresProfesionales(
  facturas: Array<{ supplierId: string; baseTotal: number; retencionTotal: number; tipoRetencion: number; supplier: { nifCif: string; nombreFiscal: string; cp: string | null; provincia: string | null } }>,
): Perceptor190[] {
  const grupos = new Map<string, Perceptor190 & { _base: number; _ret: number }>();
  for (const f of facturas) {
    // G.03: tipo reducido del 7 % por inicio de actividad; G.01: tipo general.
    const subclave = Number(f.tipoRetencion) === 7 ? '03' : '01';
    const k = `${f.supplierId}|${subclave}`;
    let g = grupos.get(k);
    if (!g) {
      const provincia = codigoProvincia(f.supplier.cp, f.supplier.provincia);
      g = {
        clave: 'G',
        subclave,
        nif: String(f.supplier.nifCif ?? '').toUpperCase().replace(/[\s.-]/g, ''),
        nombre: f.supplier.nombreFiscal,
        provincia,
        percepcionIntegra: 0,
        retenciones: 0,
        valoracionEspecie: 0,
        ingresosACuentaEfectuados: 0,
        ingresosACuentaRepercutidos: 0,
        ejercicioDevengo: null,
        gastosDeducibles: 0,
        anioNacimiento: null,
        situacionFamiliar: null,
        nifConyuge: null,
        discapacidad: null,
        contrato: null,
        movilidadGeografica: false,
        origen: 'profesional',
        proveedorId: f.supplierId,
        documentos: 0,
        faltan: provincia ? [] : ['provincia (código postal del proveedor)'],
        _base: 0,
        _ret: 0,
      };
      grupos.set(k, g);
    }
    g._base += aCentimos(Number(f.baseTotal));
    g._ret += aCentimos(Number(f.retencionTotal));
    g.documentos++;
  }
  return [...grupos.values()].map(({ _base, _ret, ...p }) => ({ ...p, percepcionIntegra: euros(_base), retenciones: euros(_ret) }));
}

/**
 * Modelo 190 de un ejercicio: un registro por perceptor y clave (A trabajo, L
 * rentas exentas de los trabajadores, G profesionales), con los totales del
 * registro de declarante y el cuadre con los cuatro 111 del ano.
 */
export async function calcularModelo190(companyId: string, ejercicio: number): Promise<Modelo190> {
  const anio = periodoFiscal(ejercicio, '0A');
  const avisos: string[] = [];

  const nominas = await nominasPagadasEntre(companyId, anio.fechaInicio, anio.fechaFin);
  const ids = [...new Set(nominas.map((n) => n.empleadoId))];
  const fichas = ids.length && tablaLista('empleado') ? await prisma.empleado.findMany({ where: { companyId, id: { in: ids } } }) : [];
  const empleados = new Map<string, EmpleadoFiscal>(fichas.map((e) => [e.id, e as unknown as EmpleadoFiscal]));
  const borradores = nominas.filter((n) => n.estado === 'BORRADOR').length;
  if (borradores) avisos.push(`${borradores} nómina(s) pagadas en ${ejercicio} siguen en borrador: entran en el 190, pero contabilízalas antes de presentarlo.`);

  const facturas = tablaLista('expenseInvoice')
    ? await prisma.expenseInvoice.findMany({
        where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: { gte: anio.fechaInicio, lte: anio.fechaFin }, retencionTotal: { gt: 0 } },
        select: { supplierId: true, baseTotal: true, retencionTotal: true, tipoRetencion: true, supplier: { select: { nifCif: true, nombreFiscal: true, cp: true, provincia: true } } },
      })
    : [];

  const perceptores = [
    ...perceptoresDeNominas(ejercicio, nominas, empleados),
    ...perceptoresProfesionales(facturas as never),
  ].sort((a, b) => a.clave.localeCompare(b.clave) || a.nombre.localeCompare(b.nombre, 'es') || (a.subclave ?? '').localeCompare(b.subclave ?? ''));

  if (tablaLista('nominaResumen')) {
    const antiguos = await prisma.nominaResumen.count({ where: { companyId, ejercicio } });
    if (antiguos) {
      avisos.push(`Hay meses de ${ejercicio} registrados solo con el resumen antiguo de nóminas (totales sin trabajadores): no entran en el 190. Importa esas nóminas por trabajador.`);
    }
  }
  const sinDatos = perceptores.filter((p) => p.faltan.length);
  if (sinDatos.length) {
    // Sin nombres: este aviso tambien sale en el modulo Impuestos (impuestos:read).
    avisos.push(`A ${sinDatos.length} registro(s) les faltan datos para el fichero (${[...new Set(sinDatos.flatMap((p) => p.faltan))].join(', ')}): revisa el informe por perceptor en Nóminas.`);
  }

  const c = (v: number) => aCentimos(v);
  const totales = {
    registros: perceptores.length,
    perceptores: new Set(perceptores.map((p) => p.nif)).size,
    percepciones: euros(perceptores.reduce((a, p) => a + c(p.percepcionIntegra) + c(p.valoracionEspecie), 0)),
    retenciones: euros(perceptores.reduce((a, p) => a + c(p.retenciones) + c(p.ingresosACuentaEfectuados), 0)),
  };

  // Lo mismo, por trimestres, como lo declara el 111 (misma fuente): tiene que coincidir.
  const trimestres: Modelo190['cuadre111']['trimestres'] = [];
  for (const t of ['1T', '2T', '3T', '4T']) {
    const p = periodoFiscal(ejercicio, t);
    const [trabajo, actividades] = await Promise.all([retencionesTrabajo(companyId, p), retencionesActividades(companyId, p)]);
    // Sin el resumen antiguo: el 190 no lo incluye.
    const antiguos = trabajo.mesesResumenAntiguo.length
      ? (await resumenesAntiguos(companyId, p)).reduce((a, r) => a + c(r.totalIRPF), 0)
      : 0;
    const ret = c(trabajo.casillas.retencionesDinerarias) - antiguos + c(trabajo.casillas.ingresosACuenta) + c(actividades.retenciones);
    trimestres.push({ periodo: t, retenciones: euros(ret) });
  }
  const total = euros(trimestres.reduce((a, t) => a + c(t.retenciones), 0));
  const coincide = c(total) === c(totales.retenciones);
  if (!coincide) {
    avisos.push(`Las retenciones del 190 (${totales.retenciones.toFixed(2)} €) no coinciden con la suma de los cuatro 111 (${total.toFixed(2)} €).`);
  }
  return { ejercicio, perceptores, totales, cuadre111: { trimestres, total, coincide }, avisos };
}
