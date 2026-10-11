/**
 * Modelo 202 (pago fraccionado del Impuesto sobre Sociedades) con el diseno de
 * registro OFICIAL (DR202e25.xlsx v1.3, "2025 y siguientes";
 * src/domain/aeat/dr202-2025.json): cabecera <AUX> (328) + pagina 01 (700) +
 * pagina 02 (900) + cierre (18), seguidos y con CRLF al final.
 *
 * Modalidad A (art. 40.2 LIS): [01] cuota del ultimo 200 vencido menos
 * deducciones, bonificaciones, retenciones e ingresos a cuenta; [03] = 18 % de
 * [01] menos [02] (complementaria). La modalidad B (art. 40.3) se puede
 * escribir con sus casillas, pero la app todavia no la calcula.
 *
 * La pantalla lee el fichero generado con la misma tabla (leerFichero202).
 */
import { DISENO_202 } from '../../domain/aeat/disenos';
import { componerRegistroDr, leerRegistroDr, nifDerecha, registroDe, textoAeat, type CampoLeidoDr, type ValorDr } from '../common/disenoRegistro';
import { esNifEspanolValido } from '../../utils/nif';

export type Periodo202 = '1P' | '2P' | '3P';
export const PERIODOS_202: readonly Periodo202[] = ['1P', '2P', '3P'];

/** Marcas de datos adicionales de la pagina 01 (X o blanco). */
export type Marca202 =
  | 'marcaLey49'
  | 'marcaLey11'
  | 'marcaCapitalRiesgo'
  | 'marcaNavieras'
  | 'marcaErd'
  | 'marcaIncnMas6M'
  | 'marcaCooperativa'
  | 'marcaNota7'
  | 'marcaIncnMenos1M'
  | 'marcaVariosTipos';

/** Casillas numericas por su numero oficial ('01', '03', '17'...). */
export type Casillas202 = Partial<Record<string, number>>;

export interface Entrada202 {
  ejercicio: number;
  periodo: Periodo202;
  versionPrograma?: string;
  nifEmpresaDesarrollo?: string;
  /** I ingreso, U domiciliacion, G ingreso en CCT, N negativa. */
  tipoDeclaracion: 'I' | 'U' | 'G' | 'N';
  nif: string;
  denominacion: string;
  /** Blanco, o 1 Navarra, 2 Guipuzcoa, 3 Vizcaya, 4 Alava. */
  territorioForal?: '' | '1' | '2' | '3' | '4';
  /** AAAA-MM-DD */
  fechaInicioPeriodo: string;
  cnae?: string | null;
  marcas?: Partial<Record<Marca202, boolean>>;
  tipoGravamen?: string;
  /** INCN de los 12 meses anteriores: 0 no consta, 1 de 10 a 20 M, 2 de 20 a 60 M, 3 desde 60 M. */
  tramoIncn?: '0' | '1' | '2' | '3';
  modalidad: 'A' | 'B';
  casillas: Casillas202;
  complementaria?: boolean;
  justificanteAnterior?: string | null;
  iban?: string | null;
}

export class ErrorEntrada202 extends Error {
  constructor(readonly errores: string[]) {
    super(errores.join(' '));
  }
}

/** Porcentaje de la modalidad A (art. 40.2 LIS). */
export const PORCENTAJE_MODALIDAD_A = 18;

const cent = (n: number) => Math.round(n * 100);

/**
 * Modalidad A: [01] base (la cuota del 200; si es negativa, 0), [02] lo
 * ingresado en la declaracion anterior si es complementaria, [03] = 18 % de
 * [01] menos [02], nunca negativo. Calculo en centimos.
 */
export function calcularModalidadA202(base: number, anterior = 0): { '01': number; '02': number; '03': number } {
  const b = Math.max(0, cent(base));
  const a = Math.max(0, cent(anterior));
  const c03 = Math.max(0, Math.round((b * PORCENTAJE_MODALIDAD_A) / 100) - a);
  return { '01': b / 100, '02': a / 100, '03': c03 / 100 };
}

const ddmmaaaa = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');
const limpiarIban = (iban?: string | null) => String(iban ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Campos de casilla (con su numero oficial) de una pagina. */
const camposCasilla = (pagina: string) => registroDe(DISENO_202, pagina).campos.filter((c) => c.casilla);

/** Lo que impide generar el fichero; vacio si se puede. */
export function erroresEntrada202(e: Entrada202): string[] {
  const errores: string[] = [];
  if (!esNifEspanolValido(nifDerecha(e.nif))) errores.push('Falta el NIF de la empresa o no es válido: complétalo en Registro Mercantil > Datos.');
  if (!textoAeat(e.denominacion)) errores.push('Falta la razón social de la empresa: complétala en Registro Mercantil > Datos.');
  if (!PERIODOS_202.includes(e.periodo)) errores.push(`El periodo "${e.periodo}" no es válido: el 202 tiene 1P, 2P y 3P.`);
  if (!ddmmaaaa(e.fechaInicioPeriodo)) errores.push('Falta la fecha de inicio del periodo impositivo.');
  if (e.tipoDeclaracion === 'U' && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(limpiarIban(e.iban))) errores.push('Para domiciliar el pago hace falta el IBAN de la cuenta.');
  if (e.complementaria && !textoAeat(e.justificanteAnterior)) errores.push('Una complementaria necesita el número de justificante de la declaración anterior.');
  for (const pagina of ['pagina01', 'pagina02']) {
    for (const c of camposCasilla(pagina)) {
      const v = e.casillas[c.casilla!];
      if (v !== undefined && c.tipo === 'Num' && v < 0) errores.push(`La casilla [${c.casilla}] no admite importes negativos (${v.toFixed(2)} €).`);
    }
  }
  const aIngresar = e.modalidad === 'A' ? e.casillas['03'] ?? 0 : e.casillas['34'] ?? 0;
  if (e.tipoDeclaracion === 'N' && aIngresar > 0) errores.push('Con importe a ingresar la declaración no puede ser negativa (N).');
  return errores;
}

/** Fichero del 202. Lanza ErrorEntrada202 si faltan datos. */
/**
 * Con `comprobar: false` no se exigen los datos (sirve para enseñar el
 * borrador en pantalla aunque falte algo); el fichero que se descarga siempre
 * se comprueba.
 */
export function generarFichero202(e: Entrada202, { comprobar = true }: { comprobar?: boolean } = {}): string {
  const errores = comprobar ? erroresEntrada202(e) : [];
  if (errores.length) throw new ErrorEntrada202(errores);
  const tag = { ejercicio: String(e.ejercicio), periodo: e.periodo };
  const casillas = (pagina: string): Record<string, ValorDr> =>
    Object.fromEntries(camposCasilla(pagina).map((c) => [c.id, e.casillas[c.casilla!] ?? 0]));
  const marcas = Object.fromEntries(Object.entries(e.marcas ?? {}).map(([k, v]) => [k, v ? 'X' : '']));

  const cabecera = componerRegistroDr(registroDe(DISENO_202, 'cabecera'), {
    ...tag,
    versionPrograma: e.versionPrograma ?? '',
    nifEmpresaDesarrollo: e.nifEmpresaDesarrollo ? nifDerecha(e.nifEmpresaDesarrollo) : '',
  });
  const pagina01 = componerRegistroDr(registroDe(DISENO_202, 'pagina01'), {
    tipoDeclaracion: e.tipoDeclaracion,
    nif: nifDerecha(e.nif),
    denominacion: e.denominacion,
    territorioForal: e.territorioForal ?? '',
    ejercicio: e.ejercicio,
    periodo: e.periodo,
    fechaInicioPeriodo: ddmmaaaa(e.fechaInicioPeriodo),
    cnae: String(e.cnae ?? '').replace(/\D/g, '').slice(0, 4) || undefined,
    ...marcas,
    tipoGravamen: e.tipoGravamen ?? '',
    tramoIncn: e.tramoIncn ?? '0',
    modalidad: e.modalidad,
    ...casillas('pagina01'),
  });
  const pagina02 = componerRegistroDr(registroDe(DISENO_202, 'pagina02'), {
    ...casillas('pagina02'),
    complementaria: e.complementaria ? 'X' : '',
    justificanteAnterior: e.complementaria ? e.justificanteAnterior ?? '' : '',
    // IBAN espanol: solo las 24 primeras posiciones (nota 7 del diseno).
    iban: e.tipoDeclaracion === 'U' ? (limpiarIban(e.iban).startsWith('ES') ? limpiarIban(e.iban).slice(0, 24) : limpiarIban(e.iban)) : '',
  });
  const cierre = componerRegistroDr(registroDe(DISENO_202, 'cierre'), tag);
  return cabecera + pagina01 + pagina02 + cierre + '\r\n';
}

export interface Pantalla202 {
  cabecera: CampoLeidoDr[];
  pagina01: CampoLeidoDr[];
  pagina02: CampoLeidoDr[];
}

/** Lee el fichero con el diseno: lo que sale en pantalla es lo que lleva el fichero. */
export function leerFichero202(fichero: string): Pantalla202 {
  const f = fichero.replace(/\r\n$/, '');
  const cab = registroDe(DISENO_202, 'cabecera');
  const p1 = registroDe(DISENO_202, 'pagina01');
  const p2 = registroDe(DISENO_202, 'pagina02');
  const sinConstantes = (cs: CampoLeidoDr[], r: typeof cab) => cs.filter((c) => r.campos.find((x) => x.id === c.id)?.constante === undefined);
  return {
    cabecera: sinConstantes(leerRegistroDr(cab, f.slice(0, cab.longitud)), cab),
    pagina01: sinConstantes(leerRegistroDr(p1, f.slice(cab.longitud, cab.longitud + p1.longitud)), p1),
    pagina02: sinConstantes(leerRegistroDr(p2, f.slice(cab.longitud + p1.longitud, cab.longitud + p1.longitud + p2.longitud)), p2),
  };
}
