/**
 * Modelo 347 (declaración anual de operaciones con terceras personas) con el
 * diseño de registro OFICIAL "Ejercicio 2025 y siguientes" (347.pdf):
 * src/domain/aeat/dr347-2025.json. Registros de 500 posiciones en ISO-8859-1
 * separados por CRLF: uno de tipo 1 (declarante) y uno de tipo 2 'D' por cada
 * declarado y clave (más los que van aparte por el art. 34.1 del RD 1065/2007:
 * arrendamiento de local de negocio, inversión del sujeto pasivo...).
 *
 * El fichero y lo que enseña la pantalla salen de esta misma función.
 * REVISAR cuando la AEAT publique la orden del 347 de 2027 o un diseño nuevo.
 */
import dr347 from '../../domain/aeat/dr347-2025.json';
import type { DatosModelo347 } from '../../domain/impuestos.model';
import { aCentimos } from '../../utils/money';
import { exigirDiseno, PaginaOficial, RegistroAeat } from './diseno';
import { errorNifDeclarante, importeAeat, motivoNifNoValido, nifDerecha, telefonoAeat, textoAeat } from '../common/normalizacion';

interface Diseno347 {
  version: string;
  revisar: string;
  registros: Record<'1' | '2D' | '2I', { nombre: string; longitud: number; campos: PaginaOficial['campos'] }>;
}
export const DISENO_347 = dr347 as unknown as Diseno347;
const REG = (r: '1' | '2D' | '2I'): PaginaOficial => ({ hoja: `347 tipo ${r}`, longitud: 500, campos: DISENO_347.registros[r].campos });

export const UMBRAL_347 = 3005.06;
export const UMBRAL_METALICO_347 = 6000;

export interface Declarante347 {
  nif: string;
  razonSocial: string;
  /** Teléfono de la persona de contacto (se quedan los 9 últimos dígitos). */
  telefono?: string | null;
  /** Primer apellido, segundo apellido y nombre de la persona de contacto. */
  contacto?: string | null;
  /** Número identificativo de 13 cifras que empieza por 347. */
  numeroIdentificativo?: string;
  /** Segunda o posterior presentación. */
  complementaria?: { tipo: 'C' | 'S'; numeroAnterior: string } | null;
}

/** Un registro de declarado (tipo 2 'D'). */
export interface Declarado347 {
  nif: string;
  nombre: string;
  /** 'A' adquisiciones (proveedor), 'B' entregas (cliente). */
  clave: 'A' | 'B';
  /** Dos dígitos de la provincia del domicilio fiscal; null si falta. */
  provincia: string | null;
  /** Importe anual con IVA. */
  importeAnual: number;
  /** Importes de 1T a 4T (suman el anual). */
  trimestres: [number, number, number, number];
  /** Cobros en metálico de más de 6.000 € (solo clientes). */
  metalico?: number;
  ejercicioMetalico?: number;
  /** Arrendamiento de local de negocio ('X' en la posición 100, registro aparte). */
  arrendamiento?: boolean;
  /** Compra con inversión del sujeto pasivo ('X' en la posición 282, registro aparte). */
  inversionSujetoPasivo?: boolean;
}

export interface Declaracion347 {
  ejercicio: number;
  diseno: string;
  revisar: string;
  declarante: {
    nif: string;
    razonSocial: string;
    telefono: string;
    contacto: string;
    numeroIdentificativo: string;
    complementaria: '' | 'C' | 'S';
    numeroAnterior: string;
  };
  resumen: {
    /** Pos. 136-144: nº de registros de declarado. */
    numeroDeclarados: number;
    /** Pos. 145-160: suma de los importes anuales (con su signo). */
    importeTotal: number;
    /** Pos. 161-169. */
    numeroInmuebles: number;
    /** Pos. 170-185. */
    importeArrendamientos: number;
  };
  declarados: Array<Declarado347 & { nifFichero: string; registro: string }>;
  /** Avisos que no impiden generar el fichero. */
  advertencias: string[];
  /** Problemas por los que la sede rechazaría el fichero: con alguno, no se descarga. */
  errores: string[];
  registros: string[];
  /** Contenido del fichero (sin codificar: se sirve en latin1). */
  fichero: string;
}

/** Registros de declarado a partir del calculo del 347 (clientes clave B, proveedores clave A). */
export function declarados347Desde(datos: DatosModelo347): Declarado347[] {
  return datos.operaciones.map((o) => ({
    nif: o.cifnif,
    nombre: o.nombre,
    clave: o.tipo === 'cliente' ? 'B' : 'A',
    provincia: o.provincia ?? null,
    importeAnual: o.baseAnual,
    trimestres: o.trimestres ?? [o.baseAnual, 0, 0, 0],
    ...(o.metalico ? { metalico: o.metalico, ejercicioMetalico: datos.ejercicio } : {}),
    ...(o.arrendamiento ? { arrendamiento: true } : {}),
    ...(o.inversionSujetoPasivo ? { inversionSujetoPasivo: true } : {}),
  }));
}

/** Signo + 15 cifras (13 enteros y 2 decimales). */
function signoImporte(r: RegistroAeat, posSigno: number, euros: number): void {
  const c = aCentimos(euros);
  r.crudo(posSigno, c < 0 ? 'N' : ' ');
  r.crudo(posSigno + 1, importeAeat(Math.abs(c) / 100, 15));
}

/** Provincia del 347 (01-52): La Palma (53 en otros modelos) va con Santa Cruz de Tenerife (38). */
export function provincia347(codigo: string | null | undefined): string | null {
  const c = String(codigo ?? '').trim();
  if (c === '53') return '38';
  return /^(0[1-9]|[1-4]\d|5[0-2])$/.test(c) ? c : null;
}

/**
 * Clave de un registro de declarado: NIF y clave (A o B), y una marca si es el
 * registro aparte del arrendamiento de local (L) o de las compras con
 * inversión del sujeto pasivo (I). Un mismo proveedor puede tener los tres y
 * la complementaria tiene que poder elegirlos por separado.
 */
export function claveDeclarado347(d: Pick<Declarado347, 'nif' | 'clave' | 'arrendamiento' | 'inversionSujetoPasivo'>): string {
  return `${nifDerecha(d.nif)}|${d.clave}${d.arrendamiento ? '|L' : ''}${d.inversionSujetoPasivo ? '|I' : ''}`;
}

/**
 * Construye la declaración (registros + datos de pantalla). No lanza por datos
 * que falten: los apunta en `errores` (bloquean el fichero) o en
 * `advertencias`. La descarga comprueba `errores` antes de servir el fichero.
 */
export function construirModelo347(ejercicio: number, declarante: Declarante347, declarados: Declarado347[]): Declaracion347 {
  const errores: string[] = [];
  const advertencias: string[] = [];

  const nifDecl = nifDerecha(declarante.nif);
  const errorNif = errorNifDeclarante(declarante.nif);
  if (errorNif) errores.push(errorNif);
  const razon = textoAeat(declarante.razonSocial);
  if (!razon) errores.push('Falta la razón social de la empresa. Rellénala en Registro Mercantil > Datos para la memoria.');
  // Persona de contacto y teléfono (B3): los de Registro Mercantil > Datos; sin ellos no hay fichero.
  const telefono = telefonoAeat(declarante.telefono);
  if (!telefono) errores.push('Falta el teléfono de contacto con Hacienda (9 cifras). Rellénalo en Registro Mercantil > Datos.');
  const contacto = textoAeat(declarante.contacto);
  if (!contacto) errores.push('Falta la persona de contacto con Hacienda (apellidos y nombre). Rellénala en Registro Mercantil > Datos.');
  // Número identificativo (B5): lo pone el historial de declaraciones. Sin él, a ceros (solo para la pantalla).
  const numero = /^347\d{10}$/.test(declarante.numeroIdentificativo ?? '') ? declarante.numeroIdentificativo! : '0'.repeat(13);
  const comp = declarante.complementaria ?? null;
  const numeroAnterior = comp ? String(comp.numeroAnterior ?? '').replace(/\D/g, '') : '';
  if (comp && numeroAnterior.length !== 13) errores.push('Una declaración complementaria o sustitutiva necesita el número identificativo (13 cifras) de la anterior.');

  const ordenados = [...declarados].sort(
    (a, b) => a.clave.localeCompare(b.clave) || b.importeAnual - a.importeAnual || a.nombre.localeCompare(b.nombre, 'es'),
  );

  const salida: Declaracion347['declarados'] = [];
  const registros2: string[] = [];
  let totalCent = 0;
  for (const d of ordenados) {
    const etiqueta = `${d.nombre || 'Sin nombre'} (${d.nif || 'sin NIF'})`;
    const nif = nifDerecha(d.nif);
    const motivoNif = motivoNifNoValido(d.nif);
    if (motivoNif) errores.push(`${etiqueta}: ${motivoNif === 'falta' ? 'falta el NIF' : `el NIF no es válido (${motivoNif})`}. Corrígelo en su ficha.`);
    if (!textoAeat(d.nombre)) errores.push(`${etiqueta}: falta el nombre o razón social.`);
    const provincia = provincia347(d.provincia);
    if (!provincia) errores.push(`${etiqueta}: falta la provincia del domicilio fiscal (código postal o provincia en su ficha).`);

    const anual = aCentimos(d.importeAnual);
    const trim = d.trimestres.map(aCentimos);
    if (trim.reduce((a, b) => a + b, 0) !== anual) {
      errores.push(`${etiqueta}: los importes trimestrales no suman el anual.`);
    }
    totalCent += anual;

    const r = new RegistroAeat(REG('2D'));
    r.entero(5, ejercicio)
      .crudo(9, (nifDecl || '').padEnd(9, ' '))
      .crudo(18, (nif || '').padEnd(9, ' '))
      .texto(36, d.nombre)
      .crudo(77, provincia ?? '00')
      .crudo(82, d.clave);
    signoImporte(r, 83, d.importeAnual);
    if (d.arrendamiento) r.crudo(100, 'X');
    const metalico = d.metalico && d.metalico > UMBRAL_METALICO_347 ? d.metalico : 0;
    if (metalico) {
      r.crudo(101, String(aCentimos(metalico)).padStart(15, '0'));
      r.entero(132, d.ejercicioMetalico ?? ejercicio);
    }
    signoImporte(r, 116, 0);
    [136, 168, 200, 232].forEach((pos, i) => {
      signoImporte(r, pos, d.trimestres[i]);
      signoImporte(r, pos + 16, 0); // transmisiones de inmuebles sujetas a IVA del trimestre
    });
    if (d.inversionSujetoPasivo) r.crudo(282, 'X');
    signoImporte(r, 284, 0); // criterio de caja (no se aplica)
    const linea = r.toString();
    exigirDiseno(REG('2D'), linea, { alfanumericoLibre: /^[A-Z0-9ÑÇ ]*$/ });
    registros2.push(linea);
    salida.push({ ...d, provincia, metalico, nifFichero: nif, registro: linea });
  }

  const t1 = new RegistroAeat(REG('1'));
  t1.entero(5, ejercicio)
    .crudo(9, (nifDecl || '').padEnd(9, ' '))
    .texto(18, razon)
    .crudo(58, 'T')
    .crudo(59, telefono.padStart(9, '0'))
    .texto(68, contacto)
    .crudo(108, numero)
    .entero(136, registros2.length);
  if (comp) {
    t1.crudo(comp.tipo === 'C' ? 121 : 122, comp.tipo);
    if (numeroAnterior.length === 13) t1.crudo(123, numeroAnterior);
  }
  signoImporte(t1, 145, totalCent / 100);
  signoImporte(t1, 170, 0);
  const linea1 = t1.toString();
  exigirDiseno(REG('1'), linea1);

  if (!registros2.length) advertencias.push(`No hay terceros que superen ${UMBRAL_347.toFixed(2).replace('.', ',')} € en ${ejercicio}: no hace falta presentar el 347.`);

  const registros = [linea1, ...registros2];
  return {
    ejercicio,
    diseno: DISENO_347.version,
    revisar: DISENO_347.revisar,
    declarante: {
      nif: nifDecl,
      razonSocial: razon,
      telefono,
      contacto,
      numeroIdentificativo: numero,
      complementaria: comp?.tipo ?? '',
      numeroAnterior,
    },
    resumen: { numeroDeclarados: registros2.length, importeTotal: totalCent / 100, numeroInmuebles: 0, importeArrendamientos: 0 },
    declarados: salida,
    advertencias,
    errores,
    registros,
    fichero: registros.join('\r\n') + '\r\n',
  };
}
