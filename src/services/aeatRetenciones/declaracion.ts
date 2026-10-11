/**
 * Borrador de los modelos 111 y 115 con el diseño de registro de la AEAT: una
 * sola "declaracion" (identificacion, casillas, complementaria, forma de pago)
 * de la que salen a la vez el fichero importable en la sede y el formulario de
 * la pantalla, para que lo que se ve y lo que se descarga sean siempre lo mismo.
 *
 * Fuentes: dr111e16v18.xls (111, v1.8) y DR115e15v13.xls (115, v1.3),
 * transcritos en src/domain/aeat/dr111-v2.json y dr115-v13.json.
 */
import type { DatosModelo111, DatosModelo115 } from '../../domain/impuestos.model';
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import {
  componerRegistroDr,
  DR111,
  DR115,
  errorNifDeclarante,
  esPersonaFisica,
  ibanNormalizado,
  PERIODO_111_115,
  registroDr,
  sanearAN,
  type DisenoDr,
} from './diseno';
import { cabeceraAux, cierreAux, programaAeat, type ProgramaAeat } from '../../aeat/common/cabeceraAux';

export type ModeloRetenciones = '111' | '115';
export type Casillas = Record<string, number>;
export type FormaPago = 'I' | 'U' | 'G';
export type TipoDeclaracion = FormaPago | 'N';

interface ConfigModelo {
  diseno: DisenoDr;
  /** Id del registro de la pagina en el diseño. */
  pagina: string;
  /** Casilla -> clave con la que se guarda en ModeloImpuesto.casillas. */
  claves: Record<string, string>;
  /** Casillas de numero de perceptores (las demas son importes). */
  conteos: string[];
  /** Casilla total y sus sumandos (si el total es una suma). */
  total?: { casilla: string; sumandos: string[] };
  /** Base del resultado: el total (111) o las retenciones (115). */
  base: string;
  anteriores: string;
  resultado: string;
}

const CLAVES_111: Record<string, string> = {
  '01': '01_perceptores_trabajo',
  '02': '02_percepciones_trabajo',
  '03': '03_retenciones_trabajo',
  '04': '04_perceptores_especie',
  '05': '05_percepciones_especie',
  '06': '06_ingresos_a_cuenta',
  '07': '07_perceptores_actividades',
  '08': '08_percepciones_actividades',
  '09': '09_retenciones_actividades',
  '10': '10_perceptores_actividades_especie',
  '11': '11_percepciones_actividades_especie',
  '12': '12_ingresos_a_cuenta_actividades',
  '13': '13_perceptores_premios',
  '14': '14_percepciones_premios',
  '15': '15_retenciones_premios',
  '16': '16_perceptores_premios_especie',
  '17': '17_percepciones_premios_especie',
  '18': '18_ingresos_a_cuenta_premios',
  '19': '19_perceptores_forestales',
  '20': '20_percepciones_forestales',
  '21': '21_retenciones_forestales',
  '22': '22_perceptores_forestales_especie',
  '23': '23_percepciones_forestales_especie',
  '24': '24_ingresos_a_cuenta_forestales',
  '25': '25_perceptores_imagen',
  '26': '26_contraprestaciones_imagen',
  '27': '27_ingresos_a_cuenta_imagen',
  '28': '28_total_retenciones',
  '29': '29_resultado_anteriores',
  '30': '30_resultado',
};

const CLAVES_115: Record<string, string> = {
  '01': '01_perceptores',
  '02': '02_base',
  '03': '03_retenciones',
  '04': '04_anteriores',
  '05': '05_resultado',
};

export const MODELOS_RETENCIONES: Record<ModeloRetenciones, ConfigModelo> = {
  '111': {
    diseno: DR111,
    pagina: 'M11101',
    claves: CLAVES_111,
    conteos: ['01', '04', '07', '10', '13', '16', '19', '22', '25'],
    total: { casilla: '28', sumandos: ['03', '06', '09', '12', '15', '18', '21', '24', '27'] },
    base: '28',
    anteriores: '29',
    resultado: '30',
  },
  '115': {
    diseno: DR115,
    pagina: 'DR11501',
    claves: CLAVES_115,
    conteos: ['01'],
    base: '03',
    anteriores: '04',
    resultado: '05',
  },
};

/** Claves de opciones del borrador guardadas con las casillas (no son importes). */
export const OPCION_FORMA_PAGO = 'opcion_forma_pago';
export const OPCION_COMPLEMENTARIA = 'opcion_complementaria';
export const OPCION_JUSTIFICANTE = 'opcion_justificante_anterior';
export const esOpcion = (clave: string) => clave.startsWith('opcion_');

const cent = (v: number) => Math.round((Number(v) || 0) * 100);

/** Todas las casillas del modelo a 0 (las del formulario oficial). */
export function casillasVacias(modelo: ModeloRetenciones): Casillas {
  return Object.fromEntries(Object.keys(MODELOS_RETENCIONES[modelo].claves).map((k) => [k, 0]));
}

/** Casillas ('01'...) a partir de las guardadas en ModeloImpuesto (claves largas). Las que faltan, a 0. */
export function casillasDeGuardadas(modelo: ModeloRetenciones, guardadas: Record<string, unknown> | null | undefined): Casillas {
  const g = guardadas ?? {};
  const out = casillasVacias(modelo);
  for (const [casilla, clave] of Object.entries(MODELOS_RETENCIONES[modelo].claves)) out[casilla] = Number(g[clave] ?? 0) || 0;
  return out;
}

/** Casillas con las claves largas con que se guardan en ModeloImpuesto. */
export function casillasAGuardadas(modelo: ModeloRetenciones, casillas: Casillas): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [casilla, clave] of Object.entries(MODELOS_RETENCIONES[modelo].claves)) out[clave] = casillas[casilla] ?? 0;
  return out;
}

/** true si las casillas guardadas tienen el formato actual (con el resultado). */
export function tieneCasillasGuardadas(modelo: ModeloRetenciones, guardadas: Record<string, unknown> | null | undefined): boolean {
  const m = MODELOS_RETENCIONES[modelo];
  return !!guardadas && m.claves[m.base] in guardadas;
}

export interface OpcionesDeclaracion {
  /** I ingreso, U domiciliacion, G ingreso a anotar en la cuenta corriente tributaria. */
  formaPago?: FormaPago | null;
  complementaria?: boolean | null;
  /** Numero de justificante (13 cifras) de la declaracion a la que complementa. */
  justificanteAnterior?: string | null;
  /** IBAN de la cuenta de cargo (solo con domiciliacion). */
  iban?: string | null;
}

/** Opciones del borrador guardadas con las casillas (y el IBAN de la empresa). */
export function opcionesDeGuardadas(guardadas: Record<string, unknown> | null | undefined): OpcionesDeclaracion {
  const g = guardadas ?? {};
  const forma = String(g[OPCION_FORMA_PAGO] ?? '').toUpperCase();
  return {
    formaPago: forma === 'U' || forma === 'G' || forma === 'I' ? forma : null,
    complementaria: g[OPCION_COMPLEMENTARIA] === true || g[OPCION_COMPLEMENTARIA] === 'true' || g[OPCION_COMPLEMENTARIA] === 'si',
    justificanteAnterior: g[OPCION_JUSTIFICANTE] ? String(g[OPCION_JUSTIFICANTE]) : null,
    iban: g.config_iban ? String(g.config_iban) : null,
  };
}

export interface EntradaDeclaracion {
  nif: unknown;
  /** Razon social, o "APELLIDOS, NOMBRE" de una persona fisica. */
  denominacion: unknown;
  ejercicio: number;
  periodo: string;
  casillas: Casillas;
  opciones?: OpcionesDeclaracion;
}

export interface DeclaracionRetenciones {
  modelo: ModeloRetenciones;
  identificacion: { nif: string; apellidosODenominacion: string; nombre: string; ejercicio: number; periodo: string; personaFisica: boolean };
  casillas: Casillas;
  complementaria: boolean;
  justificanteAnterior: string;
  formaPago: FormaPago;
  tipoDeclaracion: TipoDeclaracion;
  /** IBAN que va al fichero (solo con domiciliacion). */
  iban: string;
  /** Lo que impide generar el fichero (el formulario se ve igual). */
  errores: string[];
  avisos: string[];
}

export const TEXTO_TIPO_DECLARACION: Record<TipoDeclaracion, string> = {
  I: 'Ingreso',
  U: 'Domiciliación',
  G: 'Ingreso a anotar en la cuenta corriente tributaria',
  N: 'Negativa (sin importe a ingresar)',
};

/**
 * Declaracion del 111 o del 115 lista para el fichero y la pantalla. No lanza:
 * deja en `errores` lo que la sede rechazaria (NIF, periodo, casillas que no
 * cuadran, domiciliacion sin IBAN...), para enseñarlo en la pantalla, y el
 * fichero no se genera mientras haya errores.
 */
export function construirDeclaracion(modelo: ModeloRetenciones, e: EntradaDeclaracion): DeclaracionRetenciones {
  const m = MODELOS_RETENCIONES[modelo];
  const errores: string[] = [];
  const avisos: string[] = [];
  const casillas: Casillas = { ...casillasVacias(modelo), ...e.casillas };
  const o = e.opciones ?? {};

  // --- Importes: el 111 y el 115 no admiten casillas negativas ---
  const negativas = Object.entries(casillas).filter(([k, v]) => k !== m.anteriores && cent(v) < 0);
  if (negativas.length || (modelo === '115' && cent(casillas[m.anteriores]) < 0)) {
    errores.push(
      `El ${modelo} sale con importes negativos y no admite casillas negativas: revisa las facturas anuladas del periodo. Si declaraste de más en otro periodo, se rectifica ese modelo.`,
    );
  }

  // --- Identificacion ---
  // NIF con su letra o digito de control (el del declarante: el unico NIF del 111 y del 115).
  const nif = normalizarNif(e.nif);
  const errorNif = errorNifDeclarante(nif);
  if (errorNif) errores.push(errorNif);
  const personaFisica = !!nif && esPersonaFisica(nif);
  const denominacion = String(e.denominacion ?? '').trim();
  let apellidos = denominacion;
  let nombre = '';
  if (personaFisica && denominacion.includes(',')) {
    // "APELLIDOS, NOMBRE": apellidos en la 23 y nombre en la 83.
    apellidos = denominacion.slice(0, denominacion.indexOf(',')).trim();
    nombre = denominacion.slice(denominacion.indexOf(',') + 1).trim();
  } else if (personaFisica && denominacion) {
    avisos.push('Persona física: escribe la denominación como "Apellidos, Nombre" para separar los apellidos y el nombre, como pide el modelo.');
  }
  if (!sanearAN(apellidos)) errores.push('Falta la razón social de la empresa (Registro Mercantil > Datos para la memoria).');
  if (!PERIODO_111_115.test(e.periodo)) errores.push(`El ${modelo} es mensual (01 a 12) o trimestral (1T a 4T): el periodo "${e.periodo}" no es válido.`);

  // --- Casillas que dependen de otras ---
  if (m.total) {
    const suma = m.total.sumandos.reduce((a, k) => a + cent(casillas[k]), 0);
    if (suma !== cent(casillas[m.total.casilla])) {
      errores.push(`La casilla [${m.total.casilla}] (${(cent(casillas[m.total.casilla]) / 100).toFixed(2)}) no es la suma de ${m.total.sumandos.map((k) => `[${k}]`).join(' + ')} (${(suma / 100).toFixed(2)}): corrige las casillas editadas a mano.`);
    }
  }
  const complementaria = o.complementaria === true;
  const anteriores = cent(casillas[m.anteriores]);
  if (anteriores !== 0 && !complementaria) {
    errores.push(`La casilla [${m.anteriores}] solo se rellena en una declaración complementaria.`);
  }
  const resultado = cent(casillas[m.base]) - anteriores;
  if (resultado !== cent(casillas[m.resultado])) {
    errores.push(`La casilla [${m.resultado}] tiene que ser [${m.base}] - [${m.anteriores}] (${(resultado / 100).toFixed(2)}): corrige las casillas editadas a mano.`);
  }
  if (complementaria && resultado <= 0) {
    // Instrucciones del modelo 111 en la sede (Modelo 111 > Instrucciones, consultadas
    // el 11-10-2026): «Únicamente procederá la presentación de autoliquidación
    // complementaria» cuando dé un importe a ingresar mayor, y de la casilla 30:
    // «dicho resultado habrá de ser siempre una cantidad positiva». Lo ingresado de
    // más se corrige con una solicitud de rectificación (art. 120.3 LGT). El 115
    // tiene la misma liquidacion ([05] = [03] - [04]) y los mismos tipos (I, U, G, N).
    errores.push(
      `Una complementaria del ${modelo} solo se presenta si sale una cantidad a ingresar, y aquí la casilla [${m.resultado}] sale ${(resultado / 100).toFixed(2).replace('.', ',')} €. ` +
        'La sede no la admite: si en la declaración anterior ingresaste de más, pide en la sede la rectificación de esa autoliquidación; si no cambia nada, no hace falta presentar otra.',
    );
  } else if (resultado < 0) {
    errores.push(`El resultado del ${modelo} no puede ser negativo: lo ingresado de más se rectifica en la declaración anterior.`);
  }
  const justificante = String(o.justificanteAnterior ?? '').replace(/\s/g, '');
  if (complementaria && !/^\d{13}$/.test(justificante)) {
    errores.push('En una complementaria hay que indicar el número de justificante de la declaración anterior (13 cifras).');
  }

  // --- Tipo de declaracion ---
  const formaPago: FormaPago = o.formaPago ?? 'I';
  let tipoDeclaracion: TipoDeclaracion = resultado === 0 ? 'N' : formaPago;
  let iban = '';
  if (tipoDeclaracion === 'U') {
    const valido = ibanNormalizado(o.iban);
    if (!valido) errores.push('Para domiciliar el pago hace falta un IBAN válido: revisa la cuenta bancaria activa de la empresa (Tesorería > Bancos).');
    else iban = valido;
  }
  if (resultado === 0 && formaPago !== 'I') avisos.push('El resultado es 0: la declaración sale como negativa y no se cobra nada.');
  if (resultado === 0) tipoDeclaracion = 'N';

  return {
    modelo,
    identificacion: { nif, apellidosODenominacion: apellidos, nombre, ejercicio: e.ejercicio, periodo: e.periodo, personaFisica },
    casillas,
    complementaria,
    justificanteAnterior: complementaria ? justificante : '',
    formaPago,
    tipoDeclaracion,
    iban,
    errores,
    avisos,
  };
}

/**
 * Fichero para importar en el formulario de la sede: cabecera <AUX> (328) +
 * pagina (1000 en el 111, 500 en el 115) + cierre (18), sin salto de linea
 * final (el diseño no lo prevé). 400 si la declaracion tiene errores.
 */
export function ficheroDeclaracion(d: DeclaracionRetenciones, programa: ProgramaAeat = programaAeat()): string {
  if (d.errores.length) {
    throw badRequest(d.errores.join(' '), { errores: d.errores });
  }
  const m = MODELOS_RETENCIONES[d.modelo];
  const { ejercicio, periodo } = d.identificacion;
  const comunes = { ejercicio: String(ejercicio).padStart(4, '0'), periodo };
  const pagina = componerRegistroDr(registroDr(m.diseno, m.pagina), {
    ...comunes,
    ...d.casillas,
    ejercicio,
    tipoDeclaracion: d.tipoDeclaracion,
    nif: d.identificacion.nif,
    apellidosODenominacion: d.identificacion.apellidosODenominacion,
    nombre: d.identificacion.nombre,
    complementaria: d.complementaria ? 'X' : '',
    justificanteAnterior: d.justificanteAnterior,
    iban: d.tipoDeclaracion === 'U' ? d.iban : '',
  });
  // Cabecera <AUX> y cierre comunes a todas las autoliquidaciones (aeat/common/cabeceraAux).
  return cabeceraAux(d.modelo, ejercicio, periodo, programa) + pagina + cierreAux(d.modelo, ejercicio, periodo);
}

export interface CasillaFormulario {
  numero: string;
  descripcion: string;
  valor: number;
  tipo: 'numero' | 'importe';
}

export interface FormularioRetenciones {
  modelo: ModeloRetenciones;
  titulo: string;
  fuente: string;
  version: string;
  identificacion: { nif: string; apellidosODenominacion: string; nombre: string; ejercicio: number; periodo: string; personaFisica: boolean };
  columnas: string[];
  bloques: Array<{ titulo: string; filas: Array<{ rotulo: string; casillas: CasillaFormulario[] }> }>;
  total: Array<CasillaFormulario & { rotulo: string }>;
  liquidacion: {
    tipoDeclaracion: TipoDeclaracion;
    tipoDeclaracionTexto: string;
    formaPago: FormaPago;
    complementaria: boolean;
    justificanteAnterior: string;
    iban: string;
  };
  errores: string[];
  avisos: string[];
}

/** Formulario de la pantalla con las casillas y rotulos del modelo oficial (misma declaracion que el fichero). */
export function formularioDeclaracion(d: DeclaracionRetenciones): FormularioRetenciones {
  const m = MODELOS_RETENCIONES[d.modelo];
  const pagina = registroDr(m.diseno, m.pagina);
  const casilla = (numero: string): CasillaFormulario => {
    const c = pagina.campos.find((x) => x.casilla === numero);
    return { numero, descripcion: c?.desc ?? `Casilla ${numero}`, valor: d.casillas[numero] ?? 0, tipo: c?.decimales ? 'importe' : 'numero' };
  };
  const f = m.diseno.formulario;
  return {
    modelo: d.modelo,
    titulo: f.titulo,
    fuente: m.diseno.fuente,
    version: m.diseno.version,
    identificacion: d.identificacion,
    columnas: f.columnas ?? [],
    bloques: (f.bloques ?? []).map((b) => ({ titulo: b.titulo, filas: b.filas.map((fila) => ({ rotulo: fila.rotulo, casillas: fila.casillas.map(casilla) })) })),
    total: (f.total ?? []).map((t) => ({ ...casilla(t.casilla), rotulo: t.rotulo })),
    liquidacion: {
      tipoDeclaracion: d.tipoDeclaracion,
      tipoDeclaracionTexto: TEXTO_TIPO_DECLARACION[d.tipoDeclaracion],
      formaPago: d.formaPago,
      complementaria: d.complementaria,
      justificanteAnterior: d.justificanteAnterior,
      iban: d.iban,
    },
    errores: d.errores,
    avisos: d.avisos,
  };
}

/**
 * Declaracion a partir de lo guardado en ModeloImpuesto (casillas con claves
 * largas, datos de la empresa config_* y opciones opcion_*): es la fuente de
 * la pantalla y del fichero. Si las casillas guardadas son de un formato
 * anterior, se usan las calculadas (`calculadas`).
 */
export function declaracionDeGuardadas(
  modelo: ModeloRetenciones,
  guardadas: Record<string, unknown> | null | undefined,
  ejercicio: number,
  periodo: string,
  calculadas?: Casillas,
): DeclaracionRetenciones {
  const g = guardadas ?? {};
  return construirDeclaracion(modelo, {
    nif: g.config_nif,
    denominacion: g.config_razon_social,
    ejercicio,
    periodo,
    casillas: tieneCasillasGuardadas(modelo, g) ? casillasDeGuardadas(modelo, g) : (calculadas ?? casillasVacias(modelo)),
    opciones: opcionesDeGuardadas(g),
  });
}

/** Casillas del 111 a partir del calculo (DatosModelo111). */
export function casillasDeDatos111(d: DatosModelo111): Casillas {
  const c = casillasVacias('111');
  c['01'] = d.nPerceptoresTrabajo;
  c['02'] = d.percepcionesTrabajo;
  c['03'] = d.retencionesTrabajo;
  c['04'] = d.nPerceptoresEspecie ?? 0;
  c['05'] = d.percepcionesEspecie ?? 0;
  c['06'] = d.ingresosACuentaEspecie ?? 0;
  c['07'] = d.nPerceptoresActividades ?? 0;
  c['08'] = d.percepcionesActividades ?? 0;
  c['09'] = d.retencionesActividades ?? 0;
  for (const [k, v] of Object.entries(d.otrasCasillas ?? {})) {
    if (/^(1\d|2[0-7])$/.test(k)) c[k] = Number(v) || 0;
  }
  c['28'] = d.totalRetenciones;
  c['29'] = d.resultadoAnteriores ?? 0;
  c['30'] = d.resultadoIngresar;
  return c;
}

/** Casillas del 115 a partir del calculo (DatosModelo115). */
export function casillasDeDatos115(d: DatosModelo115): Casillas {
  return { '01': d.nPerceptores, '02': d.baseRetenciones, '03': d.retenciones, '04': d.resultadoAnteriores, '05': d.resultadoIngresar };
}
