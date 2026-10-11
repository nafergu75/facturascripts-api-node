/**
 * Borrador del modelo 303 con el diseño de registro oficial 2026 (v1.01):
 * de los datos calculados (agregar303) a las páginas del fichero que se importa
 * en el formulario de la sede y a las casillas que enseña la pantalla. Las dos
 * cosas salen del mismo borrador, así que la pantalla y el fichero coinciden.
 *
 * Todo es puro (sin BD): la empresa (NIF, ajustes fiscales, IBAN) llega en el
 * contexto. Lo lee calcularBorrador303 en impuestosModulo.service.
 */
import { DatosModelo303, filasRegimenGeneral303, PeriodoFiscal } from '../domain/impuestos.model';
import {
  cierre303,
  componerCabecera303,
  componerPagina303,
  nifAn303,
  paginaDiseno303,
  SoftwareAeat,
  textoAn303,
  type CampoDr303,
  type ValorCampo303,
} from '../domain/aeat/modelo303-2026';
import { badRequest } from '../utils/http-errors';

/**
 * Tipos de declaración que ofrece la app (Nota 1 de la página 1). La cuenta
 * corriente tributaria (G, V) y la devolución por transferencia al extranjero
 * (X) no se ofrecen.
 */
export type TipoDeclaracion303 = 'I' | 'U' | 'C' | 'D' | 'N';

export const NOMBRE_TIPO_DECLARACION_303: Readonly<Record<TipoDeclaracion303, string>> = {
  I: 'Ingreso',
  U: 'Domiciliación del ingreso',
  C: 'A compensar en los siguientes periodos',
  D: 'Devolución',
  N: 'Sin actividad o resultado cero',
};

/** Datos de la empresa que necesita el borrador. */
export interface ContextoEmpresa303 {
  nif: string;
  razonSocial: string;
  /** Inscrita en el registro de devolución mensual. */
  redeme: boolean;
  /** Lleva los libros por el SII (y por eso está exonerada del 390). */
  sii: boolean;
  /** Acogida al criterio de caja. */
  criterioCaja: boolean;
  /** IBAN para domiciliar o para la devolución. */
  iban?: string | null;
}

export interface CasillaPantalla303 {
  pagina: '01' | '03';
  numero: string;
  /** Bloque del formulario: "IVA devengado", "IVA deducible", "Información adicional", "Resultado"... */
  seccion: string;
  /** Concepto de la fila: "Régimen general", "Adquisiciones intracomunitarias de bienes y servicios"... */
  concepto: string;
  /** Columna: "Base imponible", "Tipo %", "Cuota"... ('' si la casilla es la fila entera). */
  columna: string;
  /** Fórmula oficial de la casilla, si la tiene ("[27] - [45]"). */
  formula?: string;
  /** Descripción completa del diseño de la AEAT. */
  descripcion: string;
  valor: number;
  unidad: 'eur' | 'porcentaje';
}

export interface Borrador303 {
  periodo: PeriodoFiscal;
  nif: string;
  razonSocial: string;
  datos: DatosModelo303;
  /** Casillas oficiales en euros ('01' -> 1000), las del fichero. */
  casillas: Record<string, number>;
  tipoDeclaracion: TipoDeclaracion303;
  tiposDeclaracion: TipoDeclaracion303[];
  /** Indicadores de identificación de la página 1, por Nº de campo del diseño. */
  indicadores: Record<number, string | null>;
  sinActividad: boolean;
  iban: string | null;
  /** Lo que impide generar el fichero (falta el NIF...). La pantalla lo enseña. */
  errores: string[];
  advertencias: string[];
}

export const esUltimoPeriodo303 = (periodo: string): boolean => periodo === '4T' || periodo === '12';

/**
 * Tipos de declaración posibles según el resultado [71] (Nota 1): a ingresar,
 * ingreso o domiciliación; a devolver, compensar o, en el último periodo o con
 * REDEME, devolución; a cero, N.
 */
export function tiposDeclaracion303(resultado71: number, periodo: string, redeme: boolean): TipoDeclaracion303[] {
  const centimos = Math.round(resultado71 * 100);
  if (centimos > 0) return ['I', 'U'];
  if (centimos < 0) return esUltimoPeriodo303(periodo) || redeme ? ['C', 'D'] : ['C'];
  return ['N'];
}

/**
 * Indicadores de identificación de la página 1 (campos 11 a 25, posiciones
 * 109 a 130), para una sociedad de territorio común en régimen general:
 * foral, conjunta y concurso, "2"; régimen simplificado, "3" (solo RG);
 * REDEME, criterio de caja y SII según los ajustes; prorrata especial, en
 * blanco salvo en el último periodo ("2", Nota 6); exonerado del 390 y
 * volumen, "0" salvo en el último periodo (Notas 3 y 4); carburantes, "0" en
 * los trimestres y en el mes 01, "2" desde el 02 (Notas 8 y 9).
 */
export function indicadoresPagina1_303(periodo: PeriodoFiscal, ctx: Pick<ContextoEmpresa303, 'redeme' | 'sii' | 'criterioCaja'>): Record<number, string | null> {
  const ultimo = esUltimoPeriodo303(periodo.periodo);
  const exonerado390 = ctx.sii; // Quien lleva los libros por el SII no presenta el 390 (art. 71.7 RIVA).
  const mensualDesde02 = periodo.tipo === 'mensual' && periodo.periodo >= '02';
  return {
    11: '2', // tributación exclusivamente foral
    12: ctx.redeme ? '1' : '2', // REDEME
    13: '3', // solo régimen general
    14: '2', // autoliquidación conjunta
    15: ctx.criterioCaja ? '1' : '2', // criterio de caja
    16: '2', // destinatario de operaciones con criterio de caja
    17: ultimo ? '2' : null, // opción por la prorrata especial
    18: ultimo ? '2' : null, // revocación de la prorrata especial
    19: '2', // concurso de acreedores
    22: ctx.sii ? '1' : '2', // SII voluntario
    23: ultimo ? (exonerado390 ? '1' : '2') : '0', // exonerado del 390
    24: ultimo && exonerado390 ? '1' : '0', // volumen anual distinto de cero
    25: mensualDesde02 ? '2' : '0', // pago a cuenta de carburantes
  };
}

/**
 * Casillas oficiales de unos datos guardados antes del diseño 2026 (sin
 * `casillasOficiales`): se reconstruyen con los importes de siempre.
 */
export function casillasOficiales303De(d: DatosModelo303): Record<string, number> {
  if (d.casillasOficiales) return d.casillasOficiales;
  const c: Record<string, number> = {};
  const { filas } = filasRegimenGeneral303(d.ivaDevengado ?? []);
  const FILAS: Array<[string, string]> = [
    ['01', '03'],
    ['04', '06'],
    ['07', '09'],
  ];
  filas.forEach((f, i) => {
    if (!f) return;
    c[FILAS[i][0]] = f.base;
    c[FILAS[i][1]] = f.cuota;
  });
  const resultado = d.resultado ?? 0;
  Object.assign(c, {
    '27': d.totalCuotaDevengada ?? 0,
    '28': d.totalBaseDeducible ?? 0,
    '29': d.totalCuotaDeducible ?? 0,
    '45': d.totalCuotaDeducible ?? 0,
    '46': resultado,
    '59': d.entregasIntracomunitarias ?? 0,
    '60': d.exportaciones ?? 0,
    '120': d.noSujetasLocalizacion ?? 0,
    '122': d.inversionSujetoPasivo ?? 0,
    '64': resultado,
    '65': 100,
    '66': resultado,
    '110': d.cuotasACompensarAnteriores ?? 0,
    '78': d.cuotasAplicadas ?? 0,
    '87': d.cuotasPendientesPosteriores ?? 0,
    '69': d.resultadoFinal ?? resultado,
    '71': d.resultadoFinal ?? resultado,
  });
  return c;
}

const IBAN_ES = /^ES\d{22}$/;

/**
 * Monta el borrador: casillas, tipo de declaración (el pedido, si vale para el
 * resultado; si no, 400), indicadores y lo que falta para poder generar el
 * fichero (que la pantalla enseña sin bloquear el cálculo).
 */
export function montarBorrador303(datos: DatosModelo303, ctx: ContextoEmpresa303, tipoPedido?: string | null): Borrador303 {
  const periodo = datos.periodo;
  const casillas = casillasOficiales303De(datos);
  const resultado71 = casillas['71'] ?? 0;
  const tiposDeclaracion = tiposDeclaracion303(resultado71, periodo.periodo, ctx.redeme);
  let tipoDeclaracion = tiposDeclaracion[0];
  if (tipoPedido) {
    const pedido = tipoPedido.toUpperCase() as TipoDeclaracion303;
    if (!tiposDeclaracion.includes(pedido)) {
      const posibles = tiposDeclaracion.map((t) => `${t} (${NOMBRE_TIPO_DECLARACION_303[t].toLowerCase()})`).join(' o ');
      throw badRequest(`Con este resultado el tipo de declaración del 303 puede ser ${posibles}.`, { campo: 'tipoDeclaracion', pedido: tipoPedido });
    }
    tipoDeclaracion = pedido;
  }

  const nif = nifAn303(ctx.nif);
  const razonSocial = textoAn303(ctx.razonSocial);
  const iban = (ctx.iban ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const errores: string[] = [];
  if (!nif) errores.push('Falta el NIF de la empresa. Rellénalo en Registro Mercantil > Datos para la memoria y vuelve a descargar el fichero.');
  else if (nif.length !== 9) errores.push(`El NIF de la empresa (${nif}) no tiene 9 caracteres. Corrígelo en Registro Mercantil > Datos para la memoria.`);
  if (!razonSocial) errores.push('Falta la razón social de la empresa. Rellénala en Registro Mercantil > Datos para la memoria y vuelve a descargar el fichero.');
  const { sinFila } = filasRegimenGeneral303(datos.ivaDevengado ?? []);
  if (sinFila.length) {
    errores.push(
      `No se puede generar el fichero del 303: hay ventas al ${sinFila.map((d) => `${d.tipo} %`).join(', ')}, que no tiene fila en el régimen general. Revisa esas facturas.`,
    );
  }
  if (tipoDeclaracion === 'U' || tipoDeclaracion === 'D') {
    const para = tipoDeclaracion === 'U' ? 'domiciliar el pago' : 'pedir la devolución';
    if (!iban) errores.push(`Para ${para} hace falta una cuenta bancaria de la empresa con IBAN. Añádela en Tesorería > Cuentas bancarias.`);
    else if (!IBAN_ES.test(iban)) errores.push(`Para ${para} la app solo admite una cuenta española (IBAN que empieza por ES y 24 caracteres): ${iban.slice(0, 4)}... no vale.`);
  }

  const advertencias = [...(datos.advertencias ?? [])];
  if (esUltimoPeriodo303(periodo.periodo) && ctx.sii) {
    advertencias.push(
      'En el último periodo, quien lleva los libros por el SII rellena la página 4 del 303 (actividades y volumen de operaciones). La app todavía no la genera: complétala en el formulario de la sede después de importar el fichero.',
    );
  }

  return {
    periodo,
    nif,
    razonSocial,
    datos: { ...datos, casillasOficiales: casillas },
    casillas,
    tipoDeclaracion,
    tiposDeclaracion,
    indicadores: indicadoresPagina1_303(periodo, ctx),
    sinActividad: datos.sinActividad === true,
    iban: tipoDeclaracion === 'U' || tipoDeclaracion === 'D' ? iban : null,
    errores,
    advertencias,
  };
}

/** Versión del programa y NIF de la entidad desarrolladora (cabecera, Nota 1). */
export function softwareAeat(): SoftwareAeat {
  return {
    // Identificador de la versión de Conta API para los ficheros de la AEAT.
    versionPrograma: '0100',
    nifEmpresaDesarrollo: process.env.AEAT_NIF_EMPRESA_DESARROLLO ?? '',
  };
}

/** Página 1 (identificación y liquidación del régimen general). */
export function pagina1Borrador303(b: Borrador303): string {
  const campos: Record<number, ValorCampo303> = {
    6: b.tipoDeclaracion,
    7: b.nif,
    8: b.razonSocial,
    9: String(b.periodo.ejercicio),
    10: b.periodo.periodo,
    ...b.indicadores,
  };
  return componerPagina303('01', { casillas: b.casillas, campos });
}

/** Página 3 (información adicional y resultado). */
export function pagina3Borrador303(b: Borrador303): string {
  return componerPagina303('03', { casillas: b.casillas, campos: { 30: b.sinActividad ? 'X' : null } });
}

/** Página DID (domiciliación o devolución): IBAN español y marca SEPA "1". */
export function paginaDidBorrador303(iban: string): string {
  return componerPagina303('DID', { campos: { 6: iban, 11: '1' } });
}

/**
 * Fichero completo para importar en el formulario del 303 de la sede:
 * cabecera + página 1 + página 3 (+ DID si se domicilia o se pide la
 * devolución) + cierre. La página 2 (régimen simplificado) no va y las 4 y 5
 * no tienen contenido para una sociedad en régimen general.
 */
export function ficheroBorrador303(b: Borrador303, software: SoftwareAeat = softwareAeat()): string {
  if (b.errores.length) throw badRequest(b.errores[0], { errores: b.errores });
  const { ejercicio, periodo } = b.periodo;
  const paginas = [pagina1Borrador303(b), pagina3Borrador303(b)];
  if (b.iban && (b.tipoDeclaracion === 'U' || b.tipoDeclaracion === 'D')) paginas.push(paginaDidBorrador303(b.iban));
  return componerCabecera303(ejercicio, periodo, software) + paginas.join('') + cierre303(ejercicio, periodo);
}

// ---------------------------------------------------------------------------
// Casillas para la pantalla, con el número y la descripción del diseño
// ---------------------------------------------------------------------------

const COLUMNAS: Readonly<Record<string, string>> = {
  'base imponible': 'Base imponible',
  base: 'Base',
  'tipo %': 'Tipo %',
  cuota: 'Cuota',
};

/** Separa la descripción del diseño en bloque, concepto, columna y fórmula. */
function partesDescripcion(pagina: '01' | '03', c: CampoDr303): Pick<CasillaPantalla303, 'seccion' | 'concepto' | 'columna' | 'formula'> {
  // "Modificación bases y cuotas- Base imponible [14]": al diseño le falta un blanco.
  let texto = c.descripcion.replace(/\s*\[[0-9A-Z]+\]\s*$/, '').replace(/(\S)- /g, '$1 - ');
  let formula: string | undefined;
  const f = /\(\s*((?:\[\d+\][\s+\-]*)+)\)/.exec(texto);
  if (f) {
    formula = f[1].replace(/\s+/g, ' ').trim();
    texto = texto.replace(f[0], ' ');
  }
  const partes = texto.split(' - ').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let seccion: string;
  let resto: string[];
  if (pagina === '01') {
    // "Liquidación (3) - Regimen General - IVA Devengado - Régimen general - Base imponible"
    seccion = (partes[2] ?? '').replace('IVA Devengado', 'IVA devengado').replace('IVA Deducible', 'IVA deducible');
    resto = partes.slice(3);
  } else {
    seccion = partes[0] ?? '';
    resto = partes.slice(1);
  }
  const ultima = resto[resto.length - 1] ?? '';
  const columna = resto.length > 1 ? COLUMNAS[ultima.toLowerCase()] ?? '' : '';
  const concepto = (columna ? resto.slice(0, -1) : resto).join(' - ');
  return { seccion, concepto, columna, ...(formula ? { formula } : {}) };
}

/**
 * Casillas de las páginas 1 y 3 en el orden del formulario, con su número, la
 * descripción oficial y el importe del borrador (el mismo que va al fichero).
 * Los tipos % fijos del diseño salen como porcentaje.
 */
export function casillasPantalla303(b: Pick<Borrador303, 'casillas'>): CasillaPantalla303[] {
  const out: CasillaPantalla303[] = [];
  for (const pagina of ['01', '03'] as const) {
    for (const c of paginaDiseno303(pagina).campos) {
      if (!c.casilla) continue;
      const porcentaje = c.constante !== undefined || c.casilla === '65';
      const valor = c.constante !== undefined ? Number(c.constante) / 100 : b.casillas[c.casilla] ?? (c.casilla === '65' ? 100 : 0);
      out.push({
        pagina,
        numero: c.casilla,
        ...partesDescripcion(pagina, c),
        descripcion: c.descripcion,
        valor,
        unidad: porcentaje ? 'porcentaje' : 'eur',
      });
    }
  }
  return out;
}
