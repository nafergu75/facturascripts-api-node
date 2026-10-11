/**
 * Fichero del modelo 190 con el diseño de registro de la AEAT: registros de 500
 * posiciones, uno de tipo 1 (declarante) y uno de tipo 2 por perceptor, clave y
 * subclave, separados por CRLF y en ISO-8859-1. Las posiciones, longitudes y
 * tipos salen de la tabla src/domain/aeat/dr190-2025.json, transcrita de
 * DISENOS_LOGICOS_190_2025.pdf (Orden HAC/1431/2025, BOE de 12-12-2025).
 *
 * El 190 que hara la app es el de 2026 (enero de 2027) y el de 2027 (enero de
 * 2028). La AEAT publica el diseño de cada ejercicio en diciembre: mientras no
 * salga, se genera con el de 2025 como BORRADOR y con un aviso.
 * TODO(diciembre de cada año): revisar en la sede (diseños de registro de los
 * modelos 100 a 199) si hay diseño nuevo, actualizar el JSON y añadir el
 * ejercicio a DISENOS_190_VERIFICADOS.
 */
import * as XLSX from 'xlsx';
import { badRequest, conflict } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { componerRegistroDr, DR190, registroDr, type ValoresDr } from '../aeatRetenciones/diseno';
import { errorNifDeclarante, motivoNifNoValido, textoAeat } from '../../aeat/common/normalizacion';
import type { Modelo190, Perceptor190 } from './fiscal';

/** Ejercicios cuyo diseño de registro se ha comprobado con el publicado por la AEAT. */
export const DISENOS_190_VERIFICADOS: Readonly<Record<number, string>> = {
  2025: 'Orden HAC/1431/2025, de 3 de diciembre (BOE de 12 de diciembre de 2025)',
};

/** Ultimo diseño publicado: el que se usa para los ejercicios posteriores, como borrador. */
export const ULTIMO_DISENO_190 = Math.max(...Object.keys(DISENOS_190_VERIFICADOS).map(Number));

export const LONGITUD_REGISTRO_190 = 500;

const T1 = registroDr(DR190, 'tipo1');
const T2 = registroDr(DR190, 'tipo2');

/**
 * Diseño con que se genera el 190 de un ejercicio. Un ejercicio anterior al
 * primer diseño verificado no se genera (409). Uno posterior al ultimo se
 * genera con ese diseño como borrador y con un aviso fijo.
 */
export function comprobarDiseno190(ejercicio: number): { disenoEjercicio: number; borrador: boolean; aviso: string | null } {
  if (DISENOS_190_VERIFICADOS[ejercicio]) return { disenoEjercicio: ejercicio, borrador: false, aviso: null };
  if (ejercicio > ULTIMO_DISENO_190) {
    return {
      disenoEjercicio: ULTIMO_DISENO_190,
      borrador: true,
      aviso:
        `Borrador con el diseño de registro de ${ULTIMO_DISENO_190}: la AEAT aún no ha publicado el del ejercicio ${ejercicio} ` +
        '(suele salir en diciembre). Compruébalo cuando se publique antes de presentar el fichero.',
    };
  }
  const verificados = Object.keys(DISENOS_190_VERIFICADOS).join(', ');
  throw conflict(
    `No se puede generar el fichero del modelo 190 de ${ejercicio}: la app tiene el diseño de registro de ${verificados} ` +
      `y el de ${ejercicio} no está verificado. Descarga el informe por perceptor (Excel) y preséntalo con el formulario de la Sede.`,
    { ejercicio, disenosVerificados: Object.keys(DISENOS_190_VERIFICADOS).map(Number) },
  );
}

export interface Declarante190 {
  nif: string;
  /** Razon social (o apellidos y nombre). */
  nombre: string;
  /** Telefono de la persona de contacto (9 digitos). */
  telefono?: string | null;
  /** Apellidos y nombre de la persona de contacto. */
  contacto?: string | null;
  email?: string | null;
  /**
   * Numero identificativo de la declaracion (13 digitos, empieza por 190). Lo
   * genera la app (services/nominas/numeracion190.ts): sin el no se compone el fichero.
   */
  numeroDeclaracion?: string | null;
  /** 'C' complementaria o 'S' sustitutiva (segunda presentacion del mismo ejercicio). */
  tipoDeclaracion?: 'C' | 'S' | null;
  /** Numero identificativo de la declaracion a la que complementa o sustituye. */
  numeroAnterior?: string | null;
}

/** Subclaves validas de cada clave (diseño de 2025). Las claves A, D y J no llevan subclave. */
export const SUBCLAVES_190: Readonly<Record<string, readonly string[]>> = {
  B: ['01', '02', '03', '04', '99'],
  C: ['01', '02', '03', '04', '05', '06', '07', '08', '09'],
  E: ['01', '02', '03', '04'],
  F: ['01', '02', '03', '04', '05', '06', '07'],
  G: ['01', '02', '03', '04', '05', '06', '07', '08'],
  H: ['01', '02', '03', '04'],
  I: ['01', '02', '03'],
  K: ['01', '02', '03', '04', '05'],
  L: [...Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')), '99'],
};
const CLAVES_SIN_SUBCLAVE = ['A', 'D', 'J'];

/** Claves con datos personales del perceptor (año de nacimiento, situacion familiar, discapacidad). */
const conDatosPersonales = (p: Perceptor190) => p.clave === 'A' || p.clave === 'C' || (p.clave === 'B' && ['01', '03', '04', '99'].includes(p.subclave ?? ''));

/** Gastos deducibles (184-196): A, B (01, 03, 04, 99), C y E (01, 02); opcional en L (05, 10, 27). */
const admiteGastos = (p: Perceptor190) =>
  p.clave === 'A' ||
  p.clave === 'C' ||
  (p.clave === 'B' && ['01', '03', '04', '99'].includes(p.subclave ?? '')) ||
  (p.clave === 'E' && ['01', '02'].includes(p.subclave ?? '')) ||
  (p.clave === 'L' && ['05', '10', '27'].includes(p.subclave ?? ''));

/** Valores del registro de tipo 2 de un perceptor (por la clave de cada campo en el JSON). */
export function valoresPerceptor190(ejercicio: number, nifDeclarante: string, p: Perceptor190): ValoresDr {
  const personales = conDatosPersonales(p);
  const esA = p.clave === 'A';
  return {
    ejercicio,
    nifDeclarante,
    nifPerceptor: p.nif,
    nombrePerceptor: p.nombre,
    provincia: p.provincia ?? 0,
    clave: p.clave,
    // Subclave (79-80, numerico) en la A, la D y la J: '00'. DISENOS_LOGICOS_190_2025,
    // posiciones 79-80: «En percepciones correspondientes a claves distintas de las
    // mencionadas, no se cumplimentará este campo». Y la regla general del diseño
    // (pagina 2): «Todos los campos tendrán contenido, a no ser que se especifique lo
    // contrario en la descripción del campo. Si no lo tuvieran, los campos numéricos
    // se rellenarán a ceros». Las instrucciones de la sede (GI10) no dicen otra cosa.
    subclave: CLAVES_SIN_SUBCLAVE.includes(p.clave) ? null : p.subclave,
    // Reintegro de percepciones de ejercicios anteriores: N y el importe sin signo.
    signoPercepcion: p.percepcionIntegra < 0 ? 'N' : '',
    percepcionIntegra: Math.abs(p.percepcionIntegra),
    retenciones: p.retenciones,
    signoEspecie: p.valoracionEspecie < 0 ? 'N' : '',
    valoracionEspecie: Math.abs(p.valoracionEspecie),
    ingresosACuentaEfectuados: p.ingresosACuentaEfectuados,
    ingresosACuentaRepercutidos: p.ingresosACuentaRepercutidos,
    ejercicioDevengo: p.ejercicioDevengo ?? 0,
    ceutaMelilla: 0,
    anioNacimiento: personales ? (p.anioNacimiento ?? 0) : 0,
    situacionFamiliar: personales ? (p.situacionFamiliar ?? 3) : 0,
    nifConyuge: personales && p.situacionFamiliar === 2 ? p.nifConyuge : null,
    discapacidad: personales ? (p.discapacidad ?? 0) : 0,
    contrato: esA ? (p.contrato ?? 1) : 0,
    titularUnidadConvivencia: 0,
    movilidadGeografica: esA && p.movilidadGeografica ? 1 : 0,
    reducciones: 0,
    gastosDeducibles: admiteGastos(p) ? p.gastosDeducibles : 0,
    // Hijos, ascendientes, IT por pago delegado y retenciones por administracion: la app aun no los recoge (ceros).
  };
}

/**
 * Identificador estable de un registro de perceptor (para elegir cuales van en
 * una complementaria y para la huella del numero de declaracion): origen,
 * trabajador o proveedor, clave y subclave, ejercicio de devengo y reintegro.
 */
export function idRegistro190(p: Perceptor190): string {
  const quien = p.empleadoId ?? p.proveedorId ?? p.nif;
  return `${p.origen}:${quien}:${p.clave}${p.subclave ?? ''}:${p.ejercicioDevengo ?? ''}${p.percepcionIntegra < 0 ? ':R' : ''}`;
}

/** Registro de tipo 2 (perceptor). */
export function registroPerceptor190(ejercicio: number, nifDeclarante: string, p: Perceptor190): string {
  return componerRegistroDr(T2, valoresPerceptor190(ejercicio, nifDeclarante, p));
}

/**
 * Totales del registro de tipo 1 (los mismos que enseña la pantalla): numero de
 * registros de perceptor, suma de las percepciones (82-94, 109-121, 256-268 y
 * 283-295, los reintegros restando) y de las retenciones e ingresos a cuenta
 * (95-107, 122-134, 269-281 y 296-308).
 */
export function totales190(perceptores: Perceptor190[]): { registros: number; percepciones: number; retenciones: number } {
  const percepciones = perceptores.reduce((a, p) => a + aCentimos(p.percepcionIntegra) + aCentimos(p.valoracionEspecie), 0);
  const retenciones = perceptores.reduce((a, p) => a + aCentimos(p.retenciones) + aCentimos(p.ingresosACuentaEfectuados), 0);
  return { registros: perceptores.length, percepciones: percepciones / 100, retenciones: retenciones / 100 };
}

/** Datos que faltan o que la sede rechazaria (vacio si se puede generar). */
export function erroresFichero190(declarante: Declarante190, perceptores: Perceptor190[]): string[] {
  const errores: string[] = [];
  // NIF de la empresa, de cada perceptor y del conyuge, con su letra o digito de control.
  const errorNif = errorNifDeclarante(declarante.nif);
  if (errorNif) errores.push(errorNif);
  if (!textoAeat(declarante.nombre)) errores.push('Falta la razón social de la empresa.');
  if (!/^\d{9}$/.test(String(declarante.telefono ?? '').replace(/\D/g, ''))) errores.push('Falta el teléfono (9 cifras) de la persona con quien relacionarse.');
  if (!textoAeat(declarante.contacto)) errores.push('Faltan los apellidos y el nombre de la persona con quien relacionarse.');
  if (declarante.numeroDeclaracion && !/^190\d{10}$/.test(declarante.numeroDeclaracion)) {
    errores.push('El número identificativo de la declaración tiene 13 dígitos y empieza por 190.');
  }
  if (declarante.tipoDeclaracion) {
    const anterior = String(declarante.numeroAnterior ?? '');
    const tipo = declarante.tipoDeclaracion === 'C' ? 'complementaria' : 'sustitutiva';
    if (!/^190\d{10}$/.test(anterior)) {
      errores.push(`En una declaración ${tipo} hay que indicar el número de la declaración anterior: los 13 dígitos (empiezan por 190) del justificante de la que presentaste.`);
    } else if (anterior === declarante.numeroDeclaracion) {
      errores.push(`El número de la declaración anterior (${anterior}) no puede ser el mismo que el de esta declaración ${tipo}.`);
    }
  }
  if (!perceptores.length) errores.push('No hay ningún perceptor en el ejercicio.');
  for (const p of perceptores) {
    const trabajador = p.origen === 'nomina';
    const motivoNif = motivoNifNoValido(p.nif, { persona: trabajador });
    if (motivoNif) {
      errores.push(
        trabajador
          ? `${p.nombre}: el NIF del trabajador (${p.nif || 'vacío'}) no es válido: ${motivoNif}. Corrígelo en Nóminas > Empleados, en su ficha.`
          : `${p.nombre}: el NIF del proveedor (${p.nif || 'vacío'}) no es válido: ${motivoNif}. Corrígelo en la ficha del proveedor (Proveedores).`,
      );
    }
    if (!p.provincia || !/^(0[1-9]|[1-4]\d|5[0-3]|98)$/.test(p.provincia)) errores.push(`${p.nombre}: falta el código de provincia.`);
    if (!/^[A-L]$/.test(p.clave)) errores.push(`${p.nombre}: la clave de percepción "${p.clave}" no existe.`);
    else if (SUBCLAVES_190[p.clave] && !SUBCLAVES_190[p.clave].includes(p.subclave ?? '')) {
      errores.push(`${p.nombre}: la clave ${p.clave} necesita una subclave válida (${SUBCLAVES_190[p.clave].join(', ')}).`);
    }
    if (conDatosPersonales(p) && !p.anioNacimiento) errores.push(`${p.nombre}: falta el año de nacimiento.`);
    if (conDatosPersonales(p) && p.situacionFamiliar === 2) {
      if (!p.nifConyuge) errores.push(`${p.nombre}: falta el NIF del cónyuge (situación familiar 2).`);
      else {
        const motivoConyuge = motivoNifNoValido(p.nifConyuge, { persona: true });
        if (motivoConyuge) {
          errores.push(`${p.nombre}: el NIF del cónyuge (${p.nifConyuge}) no es válido: ${motivoConyuge}. Corrígelo en Nóminas > Empleados, en la ficha del trabajador.`);
        }
      }
    }
    if (p.percepcionIntegra < 0 || p.valoracionEspecie < 0) {
      // Reintegro de lo cobrado de mas en un ejercicio anterior: con su ejercicio y sin retenciones.
      if (!p.ejercicioDevengo) errores.push(`${p.nombre}: un reintegro (percepción negativa) necesita el ejercicio en que se cobró de más.`);
      if (aCentimos(p.retenciones) !== 0 || aCentimos(p.ingresosACuentaEfectuados) !== 0) errores.push(`${p.nombre}: un reintegro va con las retenciones a 0.`);
    }
    if (aCentimos(p.retenciones) < 0 || aCentimos(p.ingresosACuentaEfectuados) < 0 || aCentimos(p.gastosDeducibles) < 0) {
      errores.push(`${p.nombre}: las retenciones, los ingresos a cuenta y los gastos no pueden ser negativos.`);
    }
  }
  // Un trabajador con varios registros (A y L) no repite el mismo error.
  return [...new Set(errores)];
}

/**
 * Avisos del fichero: el diseño en borrador y el numero identificativo que
 * lleva (lo pone el propio fichero: no hay que cambiarlo en la sede).
 */
export function avisosFichero190(ejercicio: number, declarante: Declarante190): string[] {
  const avisos: string[] = [];
  const diseno = comprobarDiseno190(ejercicio);
  if (diseno.aviso) avisos.push(diseno.aviso);
  if (declarante.numeroDeclaracion) {
    avisos.push(
      `Número identificativo de esta declaración: ${declarante.numeroDeclaracion}. Lo genera la app y no se repite en el ejercicio. ` +
        'Si después presentas una complementaria o una sustitutiva, te pedirá el número del justificante de esta.',
    );
  }
  return avisos;
}

/**
 * Fichero del 190 de un ejercicio: registro de declarante y uno por perceptor,
 * separados por CRLF. Para un ejercicio sin diseño publicado usa el ultimo
 * (borrador, ver avisosFichero190). 400 con la lista de lo que falta.
 */
export function generarFicheroModelo190(ejercicio: number, declarante: Declarante190, perceptores: Perceptor190[]): string {
  comprobarDiseno190(ejercicio);
  if (!/^190\d{10}$/.test(String(declarante.numeroDeclaracion ?? ''))) {
    // Lo asigna asignarNumero190 antes de componer el fichero: nunca uno fijo.
    throw new Error('Falta el número identificativo de la declaración del 190');
  }
  const errores = erroresFichero190(declarante, perceptores);
  if (errores.length) {
    throw badRequest(`No se puede generar el fichero del 190: ${errores.slice(0, 5).join(' ')}${errores.length > 5 ? ` (y ${errores.length - 5} más)` : ''}`, { errores });
  }
  const t = totales190(perceptores);
  const tipo1 = componerRegistroDr(T1, {
    ejercicio,
    nifDeclarante: declarante.nif,
    nombreDeclarante: declarante.nombre,
    telefono: String(declarante.telefono ?? '').replace(/\D/g, ''),
    contacto: declarante.contacto,
    numeroDeclaracion: declarante.numeroDeclaracion,
    complementaria: declarante.tipoDeclaracion === 'C' ? 'C' : '',
    sustitutiva: declarante.tipoDeclaracion === 'S' ? 'S' : '',
    numeroDeclaracionAnterior: declarante.tipoDeclaracion ? declarante.numeroAnterior : 0,
    numeroPercepciones: t.registros,
    signoPercepciones: t.percepciones < 0 ? 'N' : '',
    importePercepciones: Math.abs(t.percepciones),
    importeRetenciones: t.retenciones,
    email: declarante.email,
  });
  return [tipo1, ...perceptores.map((p) => registroPerceptor190(ejercicio, declarante.nif, p))].join('\r\n') + '\r\n';
}

/**
 * Resumen del 190 para la pantalla, con las casillas del formulario (las del
 * registro de tipo 1): misma funcion de totales que el fichero.
 */
export function resumen190(perceptores: Perceptor190[]): Array<{ casilla: string; rotulo: string; valor: number; signo: 'N' | ' '; tipo: 'numero' | 'importe' }> {
  const t = totales190(perceptores);
  const valores: Record<string, number> = { numeroPercepciones: t.registros, importePercepciones: t.percepciones, importeRetenciones: t.retenciones };
  return (DR190.formulario.resumen ?? []).map((r) => ({
    casilla: r.casilla,
    rotulo: r.rotulo,
    valor: valores[r.campo],
    signo: r.campo === 'importePercepciones' && t.percepciones < 0 ? 'N' : ' ',
    tipo: r.campo === 'numeroPercepciones' ? 'numero' : 'importe',
  }));
}

/**
 * Informe del 190 en Excel: una fila por registro de perceptor y los totales.
 * Sin la discapacidad (dato de salud, art. 9 RGPD): solo va en el fichero de la
 * AEAT y se revisa en la ficha de cada trabajador. La descarga queda en la auditoria.
 */
export function informe190Excel(m: Modelo190): Buffer {
  const cab = [
    'Clave',
    'Subclave',
    'NIF',
    'Apellidos y nombre / razón social',
    'Provincia',
    'Percepción íntegra',
    'Retenciones',
    'Valoración especie',
    'Ingresos a cuenta efectuados',
    'Ingresos a cuenta repercutidos',
    'Ejercicio devengo',
    'Gastos deducibles',
    'Año nacimiento',
    'Situación familiar',
    'Contrato',
    'Movilidad geográfica',
    'Nóminas / facturas',
    'Datos que faltan',
  ];
  const filas = m.perceptores.map((p) => [
    p.clave,
    p.subclave ?? '',
    p.nif,
    p.nombre,
    p.provincia ?? '',
    p.percepcionIntegra,
    p.retenciones,
    p.valoracionEspecie,
    p.ingresosACuentaEfectuados,
    p.ingresosACuentaRepercutidos,
    p.ejercicioDevengo ?? '',
    p.gastosDeducibles,
    p.anioNacimiento ?? '',
    p.situacionFamiliar ?? '',
    p.contrato ?? '',
    p.clave === 'A' ? (p.movilidadGeografica ? 'Sí' : 'No') : '',
    p.documentos,
    p.faltan.join(', '),
  ]);
  const hoja = XLSX.utils.aoa_to_sheet([
    [`Modelo 190 - ejercicio ${m.ejercicio}`],
    [],
    cab,
    ...filas,
    [],
    ['Registros', m.totales.registros],
    ['Perceptores distintos', m.totales.perceptores],
    ['Importe total de las percepciones', m.totales.percepciones],
    ['Retenciones e ingresos a cuenta', m.totales.retenciones],
    ['Suma de los cuatro 111', m.cuadre111.total, m.cuadre111.coincide ? 'Coincide' : 'NO coincide'],
    ...m.avisos.map((a) => ['Aviso', a]),
  ]);
  hoja['!cols'] = cab.map((t, i) => ({ wch: i === 3 ? 40 : Math.max(10, t.length + 2) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Perceptores');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
