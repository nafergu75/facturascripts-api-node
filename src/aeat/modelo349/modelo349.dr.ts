/**
 * Modelo 349 con el diseno de registro OFICIAL (DR_Anexo_349.pdf, Orden
 * HAC/174/2020, vigente; src/domain/aeat/dr349.json):
 *  - un registro de tipo 1 (declarante) de 500 caracteres;
 *  - un tipo 2 por operador y clave, con la base del periodo;
 *  - un tipo 2 de rectificacion por operador, clave y periodo corregido.
 * Lineas separadas por CRLF, en ISO-8859-1 (la Ñ y la Ç se conservan).
 *
 * El fichero y la pantalla salen de aqui: leerFichero349 lee con la misma
 * tabla el fichero generado, asi lo que se ve es lo que se presenta.
 */
import { DISENO_349 } from '../../domain/aeat/disenos';
import { componerRegistroDr, leerRegistroDr, registroDe, type CampoLeidoDr } from '../common/disenoRegistro';
import { errorNifDeclarante, nifDerecha, separarNifIva, telefonoAeat, textoAeat } from '../common/normalizacion';
import { PAISES_UE } from '../../domain/tipo-operacion.model';

/** E entregas, M entregas tras importacion exenta, H idem por representante fiscal, A adquisiciones de bienes,
 * T triangulares, S servicios prestados, I servicios recibidos, R/D/C ventas en consigna. */
export const CLAVES_349 = ['E', 'M', 'H', 'A', 'T', 'S', 'I', 'R', 'D', 'C'] as const;
export type Clave349 = (typeof CLAVES_349)[number];

export interface Declarante349 {
  nif: string;
  nombre: string;
  telefono?: string | null;
  /** Apellidos y nombre de la persona de contacto. */
  personaContacto?: string | null;
  /** 13 cifras que empiezan por 349. */
  numeroDeclaracion?: string | null;
  /** C complementaria, S sustitutiva; vacio en una primera declaracion. */
  tipoDeclaracion?: 'C' | 'S' | null;
  declaracionAnterior?: string | null;
}

export interface Operador349 {
  /** NIF-IVA con o sin prefijo de pais (si no lo lleva, se usa `pais`). */
  nifIva: string;
  /** Pais de la ficha (ISO-2 o ISO-3). */
  pais?: string | null;
  nombre: string;
  clave: Clave349;
  base: number;
  /** Solo clave C: el nuevo destinatario de los bienes en consigna. */
  sustituto?: { nifIva: string; pais?: string | null; nombre: string } | null;
}

export interface Rectificacion349 extends Omit<Operador349, 'base'> {
  /** Ejercicio y periodo de la declaracion que se corrige. */
  ejercicio: number;
  periodo: string;
  /** Base total que queda para ese operador, clave y periodo. */
  baseRectificada: number;
  /** Base declarada antes. */
  baseAnterior: number;
}

export interface Entrada349 {
  ejercicio: number;
  /** '01'-'12' o '1T'-'4T'. */
  periodo: string;
  /** Declaracion mensual que recoge los dos primeros meses del trimestre (X en 186). */
  cambioPeriodicidad?: boolean;
  declarante: Declarante349;
  operadores: Operador349[];
  rectificaciones?: Rectificacion349[];
}

/** Datos de la entrada que impiden el fichero (en castellano, para la persona). */
export class ErrorEntrada349 extends Error {
  constructor(readonly errores: string[]) {
    super(errores.join(' '));
  }
}

const PERIODO_349 = /^(0[1-9]|1[0-2]|[1-4]T)$/;

/**
 * Numero identificativo de la declaracion: 349 + ejercicio + periodo (mes, o
 * 21-24 para los trimestres) + secuencia de 4 cifras. Distinto por periodo, y
 * con la secuencia se distingue una complementaria o sustitutiva.
 */
export function numeroDeclaracion349(ejercicio: number, periodo: string, secuencia = 1): string {
  const p = /^[1-4]T$/.test(periodo) ? `2${periodo[0]}` : periodo === '0A' ? '00' : periodo.padStart(2, '0');
  return `349${String(ejercicio).padStart(4, '0')}${p}${String(secuencia).padStart(4, '0')}`;
}

const etiqueta = (o: { nombre: string; nifIva: string }) => `${o.nombre || 'Operador sin nombre'} (${o.nifIva || 'sin NIF'})`;

/** Lo que impide generar el fichero; vacio si se puede. */
export function erroresEntrada349(e: Entrada349): string[] {
  const errores: string[] = [];
  const d = e.declarante;
  const errorNif = errorNifDeclarante(d.nif);
  if (errorNif) errores.push(errorNif);
  if (!textoAeat(d.nombre)) errores.push('Falta la razón social de la empresa: complétala en Registro Mercantil > Datos.');
  if (!Number.isInteger(e.ejercicio) || e.ejercicio < 2000 || e.ejercicio > 9999) errores.push(`El ejercicio ${e.ejercicio} no es válido.`);
  if (!PERIODO_349.test(e.periodo)) errores.push(`El periodo "${e.periodo}" no es válido: usa 01-12 o 1T-4T.`);
  if (e.cambioPeriodicidad && !/^(0[1-9]|1[0-2])$/.test(e.periodo)) errores.push('El cambio de periodicidad solo se marca en una declaración mensual.');
  if (d.numeroDeclaracion && !/^349\d{10}$/.test(d.numeroDeclaracion)) errores.push('El número de la declaración tiene que tener 13 cifras y empezar por 349.');
  if (d.tipoDeclaracion && !/^349\d{10}$/.test(d.declaracionAnterior ?? '')) {
    errores.push('Una complementaria o sustitutiva necesita el número de la declaración anterior (13 cifras que empiezan por 349).');
  }

  const comprobarOperador = (o: Operador349 | Rectificacion349, que: string) => {
    if (!CLAVES_349.includes(o.clave)) {
      errores.push(`${etiqueta(o)}: la clave "${o.clave}" no existe en el 349.`);
      return;
    }
    if (!separarNifIva(o.nifIva, o.pais)) errores.push(`${etiqueta(o)}: ${que} necesita el NIF-IVA de otro país de la UE, con su código de país.`);
    if (o.clave === 'C' && (!o.sustituto || !separarNifIva(o.sustituto.nifIva, o.sustituto.pais))) {
      errores.push(`${etiqueta(o)}: con la clave C hay que indicar el NIF-IVA del sustituto.`);
    }
  };
  for (const o of e.operadores) {
    comprobarOperador(o, 'la operación');
    if (o.base < 0) errores.push(`${etiqueta(o)}: la base de la clave ${o.clave} sale negativa (${o.base.toFixed(2)} €). Un abono de otro periodo va como rectificación de ese periodo.`);
  }
  for (const r of e.rectificaciones ?? []) {
    comprobarOperador(r, 'la rectificación');
    if (!PERIODO_349.test(r.periodo) || !Number.isInteger(r.ejercicio)) errores.push(`${etiqueta(r)}: el periodo que se rectifica (${r.ejercicio} ${r.periodo}) no es válido.`);
    if (r.baseRectificada < 0) errores.push(`${etiqueta(r)}: la base rectificada de ${r.ejercicio} ${r.periodo} sale negativa (${r.baseRectificada.toFixed(2)} €).`);
    if (r.baseAnterior < 0) errores.push(`${etiqueta(r)}: la base declarada antes no puede ser negativa.`);
  }
  return errores;
}

const centimos = (n: number) => Math.round(n * 100);

/** Fichero del 349 (ISO-8859-1 al enviarlo). Lanza ErrorEntrada349 si faltan datos. */
/**
 * Con `comprobar: false` no se exigen los datos (sirve para enseñar el
 * borrador en pantalla aunque falte algo); el fichero que se descarga siempre
 * se comprueba.
 */
export function generarFichero349(e: Entrada349, { comprobar = true }: { comprobar?: boolean } = {}): string {
  const errores = comprobar ? erroresEntrada349(e) : [];
  if (errores.length) throw new ErrorEntrada349(errores);
  const d = e.declarante;
  const nif = nifDerecha(d.nif);
  const rect = e.rectificaciones ?? [];
  const comunes = { ejercicio: e.ejercicio, nifDeclarante: nif };

  const declarante = componerRegistroDr(registroDe(DISENO_349, 'declarante'), {
    ...comunes,
    nombreDeclarante: d.nombre,
    telefonoContacto: telefonoAeat(d.telefono) || undefined,
    nombreContacto: d.personaContacto ?? '',
    numeroDeclaracion: d.numeroDeclaracion || numeroDeclaracion349(e.ejercicio, e.periodo),
    complementaria: d.tipoDeclaracion === 'C' ? 'C' : '',
    sustitutiva: d.tipoDeclaracion === 'S' ? 'S' : '',
    declaracionAnterior: d.tipoDeclaracion ? d.declaracionAnterior ?? '' : undefined,
    periodo: e.periodo,
    numeroOperadores: e.operadores.length,
    importeOperaciones: e.operadores.reduce((a, o) => a + centimos(o.base), 0) / 100,
    numeroRectificaciones: rect.length,
    importeRectificaciones: rect.reduce((a, r) => a + centimos(r.baseRectificada), 0) / 100,
    cambioPeriodicidad: e.cambioPeriodicidad ? 'X' : '',
  });

  const operador = (o: Operador349 | Rectificacion349) => {
    const nifIva = separarNifIva(o.nifIva, o.pais) ?? { pais: '', numero: String(o.nifIva ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') };
    const sustituto = o.clave === 'C' && o.sustituto ? separarNifIva(o.sustituto.nifIva, o.sustituto.pais) : null;
    return {
      ...comunes,
      paisOperador: nifIva.pais,
      numeroOperador: nifIva.numero,
      nombreOperador: o.nombre,
      clave: o.clave,
      ...(sustituto && { paisSustituto: sustituto.pais, numeroSustituto: sustituto.numero, nombreSustituto: o.sustituto!.nombre }),
    };
  };

  const lineas = [
    declarante,
    ...e.operadores.map((o) => componerRegistroDr(registroDe(DISENO_349, 'operador'), { ...operador(o), base: o.base })),
    ...rect.map((r) =>
      componerRegistroDr(registroDe(DISENO_349, 'rectificacion'), {
        ...operador(r),
        ejercicioRectificado: r.ejercicio,
        periodoRectificado: r.periodo,
        baseRectificada: r.baseRectificada,
        baseAnterior: r.baseAnterior,
      }),
    ),
  ];
  return lineas.join('\r\n') + '\r\n';
}

export interface ColumnaDr {
  id: string;
  descripcion: string;
  pos: number;
  lon: number;
}

export interface Pantalla349 {
  declarante: CampoLeidoDr[];
  columnasOperador: ColumnaDr[];
  operadores: Array<Record<string, string | number>>;
  columnasRectificacion: ColumnaDr[];
  rectificaciones: Array<Record<string, string | number>>;
}

/** Campos de un registro sin los comunes a todas las lineas (tipo, modelo, ejercicio y NIF). */
const COMUNES = new Set(['tipoRegistro', 'modelo', 'ejercicio', 'nifDeclarante']);
const columnas = (id: string): ColumnaDr[] =>
  registroDe(DISENO_349, id)
    .campos.filter((c) => c.tipo !== 'Blanco' && !COMUNES.has(c.id))
    .map(({ id: i, descripcion, pos, lon }) => ({ id: i, descripcion, pos, lon }));

/** Lee el fichero con el diseno: lo que sale en pantalla es lo que lleva el fichero. */
export function leerFichero349(fichero: string): Pantalla349 {
  const lineas = fichero.split('\r\n').filter((l) => l.length);
  const plano = (id: string, linea: string) =>
    Object.fromEntries(leerRegistroDr(registroDe(DISENO_349, id), linea).filter((c) => !COMUNES.has(c.id)).map((c) => [c.id, c.valor]));
  const tipo2 = lineas.slice(1);
  const esRect = (l: string) => l.slice(133, 146).trim() === '';
  return {
    declarante: leerRegistroDr(registroDe(DISENO_349, 'declarante'), lineas[0] ?? ''),
    columnasOperador: columnas('operador'),
    operadores: tipo2.filter((l) => !esRect(l)).map((l) => plano('operador', l)),
    columnasRectificacion: columnas('rectificacion'),
    rectificaciones: tipo2.filter(esRect).map((l) => plano('rectificacion', l)),
  };
}
