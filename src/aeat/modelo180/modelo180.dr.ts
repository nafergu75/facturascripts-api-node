/**
 * Modelo 180 (resumen anual de retenciones por alquileres de inmuebles
 * urbanos) con el diseno de registro OFICIAL (DR_Mod_180_2023.pdf, Orden
 * HAP/1732/2014 actualizada por la HFP/1284/2023; es el unico publicado y vale
 * para 2023 y siguientes; src/domain/aeat/dr180.json):
 *  - un registro de tipo 1 (declarante) de 500 caracteres;
 *  - un tipo 2 por perceptor, inmueble y ejercicio de devengo (los reintegros,
 *    aparte y con N).
 * Lineas separadas por CRLF, en ISO-8859-1.
 *
 * La pantalla lee el fichero generado con la misma tabla (leerFichero180).
 */
import { DISENO_180 } from '../../domain/aeat/disenos';
import { componerRegistroDr, leerRegistroDr, registroDe, type CampoLeidoDr } from '../common/disenoRegistro';
import { errorNifDeclarante, nifDerecha, telefonoAeat, textoAeat } from '../common/normalizacion';
import { esNifEspanolValido } from '../../utils/nif';
import type { ColumnaDr } from '../modelo349/modelo349.dr';

/** Inmueble arrendado, con los nombres de campo del diseno. */
export interface Inmueble180 {
  /** 1 territorio comun, 2 Pais Vasco, 3 Navarra (con referencia catastral); 4 sin referencia catastral. */
  situacion: 1 | 2 | 3 | 4;
  referenciaCatastral?: string | null;
  tipoVia?: string | null;
  nombreVia?: string | null;
  tipoNumeracion?: string | null;
  numeroCasa?: string | null;
  calificadorNumero?: string | null;
  bloque?: string | null;
  portal?: string | null;
  escalera?: string | null;
  planta?: string | null;
  puerta?: string | null;
  complemento?: string | null;
  localidad?: string | null;
  municipio?: string | null;
  codigoMunicipio?: string | null;
  provinciaInmueble?: string | null;
  codigoPostal?: string | null;
}

export interface Perceptor180 {
  nif: string;
  /** Solo si el perceptor es menor de 14 anos. */
  nifRepresentante?: string | null;
  nombre: string;
  /** Codigo de provincia del domicilio del perceptor (01-53). */
  provincia: string;
  /** 1 dineraria (las facturas de alquiler), 2 en especie. */
  modalidad?: 1 | 2;
  /** Reintegro de cantidades cobradas de mas en ejercicios anteriores: N y resta. */
  reintegro?: boolean;
  base: number;
  /** % de retencion (el ultimo del año). */
  porcentaje: number;
  retenciones: number;
  /** Solo si se declara este año algo devengado en uno anterior (y en los reintegros). */
  ejercicioDevengo?: number | null;
  inmueble: Inmueble180;
}

export interface Declarante180 {
  nif: string;
  nombre: string;
  telefono?: string | null;
  personaContacto?: string | null;
  numeroDeclaracion?: string | null;
  tipoDeclaracion?: 'C' | 'S' | null;
  declaracionAnterior?: string | null;
}

export interface Entrada180 {
  ejercicio: number;
  declarante: Declarante180;
  perceptores: Perceptor180[];
}

export class ErrorEntrada180 extends Error {
  constructor(readonly errores: string[]) {
    super(errores.join(' '));
  }
}


const PROVINCIA = /^(0[1-9]|[1-4]\d|5[0-3])$/;
const quien = (p: Perceptor180) => `${p.nombre || 'Arrendador sin nombre'} (${p.nif || 'sin NIF'})`;

/** Lo que impide generar el fichero; vacio si se puede. */
export function erroresEntrada180(e: Entrada180): string[] {
  const errores: string[] = [];
  const d = e.declarante;
  const errorNif = errorNifDeclarante(d.nif);
  if (errorNif) errores.push(errorNif);
  if (!textoAeat(d.nombre)) errores.push('Falta la razón social de la empresa: complétala en Registro Mercantil > Datos.');
  if (d.numeroDeclaracion && !/^180\d{10}$/.test(d.numeroDeclaracion)) errores.push('El número de la declaración tiene que tener 13 cifras y empezar por 180.');
  if (d.tipoDeclaracion && !/^180\d{10}$/.test(d.declaracionAnterior ?? '')) {
    errores.push('Una complementaria o sustitutiva necesita el número de la declaración anterior (13 cifras que empiezan por 180).');
  }
  for (const p of e.perceptores) {
    const i = p.inmueble;
    if (!esNifEspanolValido(nifDerecha(p.nif))) {
      errores.push(`${quien(p)}: el 180 solo admite arrendadores con NIF español. Un arrendador no residente va en el 216/296.`);
      continue;
    }
    if (!PROVINCIA.test(p.provincia ?? '')) errores.push(`${quien(p)}: falta la provincia de su domicilio (ficha del proveedor).`);
    if (p.base < 0 || p.retenciones < 0) errores.push(`${quien(p)}: la base y la retención van en positivo (un reintegro se marca aparte).`);
    if (!(p.porcentaje >= 0 && p.porcentaje < 100)) errores.push(`${quien(p)}: el porcentaje de retención ${p.porcentaje} no es válido.`);
    if (p.reintegro && !(p.ejercicioDevengo && p.ejercicioDevengo < e.ejercicio)) errores.push(`${quien(p)}: un reintegro necesita el ejercicio en que se cobró de más.`);
    if (p.ejercicioDevengo && p.ejercicioDevengo >= e.ejercicio) errores.push(`${quien(p)}: el ejercicio de devengo tiene que ser anterior a ${e.ejercicio}.`);
    if (![1, 2, 3, 4].includes(i.situacion)) errores.push(`${quien(p)}: falta la situación del inmueble.`);
    else if (i.situacion !== 4 && !/^[0-9A-Z]{20}$/.test(textoAeat(i.referenciaCatastral).replace(/ /g, ''))) {
      errores.push(`${quien(p)}: falta la referencia catastral del inmueble (20 caracteres) o marca que no tiene.`);
    }
    if (!textoAeat(i.tipoVia) || !textoAeat(i.nombreVia)) errores.push(`${quien(p)}: falta el tipo y el nombre de la vía del inmueble.`);
    if (!textoAeat(i.municipio) || !/^\d{5}$/.test(i.codigoMunicipio ?? '')) errores.push(`${quien(p)}: falta el municipio del inmueble con su código INE de 5 cifras.`);
    if (!PROVINCIA.test(i.provinciaInmueble ?? '') || !/^\d{5}$/.test(i.codigoPostal ?? '')) errores.push(`${quien(p)}: falta la provincia o el código postal del inmueble.`);
  }
  return errores;
}

const centimos = (n: number) => Math.round(n * 100);

/** Fichero del 180 (ISO-8859-1 al enviarlo). Lanza ErrorEntrada180 si faltan datos. */
/**
 * Con `comprobar: false` no se exigen los datos (sirve para enseñar el
 * borrador en pantalla aunque falte algo); el fichero que se descarga siempre
 * se comprueba.
 */
export function generarFichero180(e: Entrada180, { comprobar = true }: { comprobar?: boolean } = {}): string {
  const errores = comprobar ? erroresEntrada180(e) : [];
  if (errores.length) throw new ErrorEntrada180(errores);
  const d = e.declarante;
  const nif = nifDerecha(d.nif);
  const sumaBases = e.perceptores.reduce((a, p) => a + (p.reintegro ? -1 : 1) * centimos(p.base), 0);

  const declarante = componerRegistroDr(registroDe(DISENO_180, 'declarante'), {
    ejercicio: e.ejercicio,
    nifDeclarante: nif,
    nombreDeclarante: d.nombre,
    telefonoContacto: telefonoAeat(d.telefono) || undefined,
    nombreContacto: d.personaContacto ?? '',
    // Lo pone el historial de declaraciones (B5); sin el, a ceros (solo para la pantalla).
    numeroDeclaracion: d.numeroDeclaracion || '',
    complementaria: d.tipoDeclaracion === 'C' ? 'C' : '',
    sustitutiva: d.tipoDeclaracion === 'S' ? 'S' : '',
    declaracionAnterior: d.tipoDeclaracion ? d.declaracionAnterior ?? '' : undefined,
    numeroPerceptores: e.perceptores.length,
    signoBases: sumaBases < 0 ? 'N' : '',
    importeBases: Math.abs(sumaBases) / 100,
    importeRetenciones: e.perceptores.reduce((a, p) => a + centimos(p.retenciones), 0) / 100,
  });

  const perceptores = e.perceptores.map((p) => {
    const i = p.inmueble;
    return componerRegistroDr(registroDe(DISENO_180, 'perceptor'), {
      ejercicio: e.ejercicio,
      nifDeclarante: nif,
      nifPerceptor: nifDerecha(p.nif),
      nifRepresentante: p.nifRepresentante ? nifDerecha(p.nifRepresentante) : '',
      nombrePerceptor: p.nombre,
      provinciaPerceptor: p.provincia,
      modalidad: p.modalidad ?? 1,
      signoBase: p.reintegro ? 'N' : '',
      base: p.base,
      porcentaje: p.porcentaje,
      retenciones: p.retenciones,
      ejercicioDevengo: p.ejercicioDevengo ?? undefined,
      situacion: i.situacion,
      referenciaCatastral: i.situacion === 4 ? '' : textoAeat(i.referenciaCatastral).replace(/ /g, ''),
      tipoVia: i.tipoVia,
      nombreVia: i.nombreVia,
      tipoNumeracion: i.tipoNumeracion,
      numeroCasa: i.numeroCasa,
      calificadorNumero: i.calificadorNumero,
      bloque: i.bloque,
      portal: i.portal,
      escalera: i.escalera,
      planta: i.planta,
      puerta: i.puerta,
      complemento: i.complemento,
      localidad: i.localidad,
      municipio: i.municipio,
      codigoMunicipio: i.codigoMunicipio,
      provinciaInmueble: i.provinciaInmueble,
      codigoPostal: i.codigoPostal,
    });
  });
  return [declarante, ...perceptores].join('\r\n') + '\r\n';
}

export interface Cuadre180 {
  coincide: boolean;
  base180: number;
  retenciones180: number;
  base115: number;
  retenciones115: number;
  diferenciaBase: number;
  diferenciaRetenciones: number;
  /** Trimestres (o meses) del 115 que no estan. */
  faltan: string[];
}

/**
 * Cuadre con los 115 del año (en centimos): las bases y retenciones del 180
 * tienen que ser la suma de las de los 115 (cuatro trimestres o doce meses).
 */
export function cuadre180Con115(e: Entrada180, periodos115: Array<{ periodo: string; base: number; retenciones: number }>): Cuadre180 {
  const signo = (p: Perceptor180) => (p.reintegro ? -1 : 1);
  const b180 = e.perceptores.reduce((a, p) => a + signo(p) * centimos(p.base), 0);
  const r180 = e.perceptores.reduce((a, p) => a + signo(p) * centimos(p.retenciones), 0);
  const b115 = periodos115.reduce((a, p) => a + centimos(p.base), 0);
  const r115 = periodos115.reduce((a, p) => a + centimos(p.retenciones), 0);
  const mensual = periodos115.some((p) => /^\d{2}$/.test(p.periodo));
  const esperados = mensual ? Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')) : ['1T', '2T', '3T', '4T'];
  const faltan = esperados.filter((x) => !periodos115.some((p) => p.periodo === x));
  return {
    coincide: b180 === b115 && r180 === r115 && faltan.length === 0,
    base180: b180 / 100,
    retenciones180: r180 / 100,
    base115: b115 / 100,
    retenciones115: r115 / 100,
    diferenciaBase: (b180 - b115) / 100,
    diferenciaRetenciones: (r180 - r115) / 100,
    faltan,
  };
}

export interface Pantalla180 {
  declarante: CampoLeidoDr[];
  columnasPerceptor: ColumnaDr[];
  perceptores: Array<Record<string, string | number>>;
}

const COMUNES = new Set(['tipoRegistro', 'modelo', 'ejercicio', 'nifDeclarante']);

/** Lee el fichero con el diseno: lo que sale en pantalla es lo que lleva el fichero. */
export function leerFichero180(fichero: string): Pantalla180 {
  const lineas = fichero.split('\r\n').filter((l) => l.length);
  const reg = registroDe(DISENO_180, 'perceptor');
  return {
    declarante: leerRegistroDr(registroDe(DISENO_180, 'declarante'), lineas[0] ?? ''),
    columnasPerceptor: reg.campos.filter((c) => c.tipo !== 'Blanco' && !COMUNES.has(c.id)).map(({ id, descripcion, pos, lon }) => ({ id, descripcion, pos, lon })),
    perceptores: lineas.slice(1).map((l) => Object.fromEntries(leerRegistroDr(reg, l).filter((c) => !COMUNES.has(c.id)).map((c) => [c.id, c.valor]))),
  };
}
