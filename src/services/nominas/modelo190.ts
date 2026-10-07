/**
 * Fichero del modelo 190 con el diseno de registro de la AEAT: registros de 500
 * posiciones, uno de tipo 1 (declarante) y uno de tipo 2 por perceptor, clave y
 * subclave. Numericos a la derecha con ceros, alfanumericos a la izquierda con
 * blancos, en mayusculas y sin vocales acentuadas (la Ñ y la Ç se mantienen:
 * el fichero va en ISO-8859-1).
 *
 * Diseno VERIFICADO: el del ejercicio 2025 (Orden HAC/1431/2025, BOE de 12 de
 * diciembre de 2025), que es el vigente para los ejercicios hasta 2025. El del
 * ejercicio 2026 (se presenta en enero de 2027) aun no esta publicado: para los
 * ejercicios sin diseno verificado la exportacion da un error claro y queda el
 * informe por perceptor. Cuando se publique, revisar las posiciones y anadir el
 * ejercicio a DISENOS_190_VERIFICADOS.
 */
import * as XLSX from 'xlsx';
import { badRequest, conflict } from '../../utils/http-errors';
import type { Modelo190, Perceptor190 } from './fiscal';

/** Ejercicios cuyo diseno de registro se ha comprobado con el publicado por la AEAT. */
export const DISENOS_190_VERIFICADOS: Readonly<Record<number, string>> = {
  2025: 'Orden HAC/1431/2025, de 3 de diciembre (BOE de 12 de diciembre de 2025)',
};

export const LONGITUD_REGISTRO_190 = 500;

/** Error claro si el ejercicio no tiene un diseno de registro verificado. */
export function comprobarDiseno190(ejercicio: number): void {
  if (DISENOS_190_VERIFICADOS[ejercicio]) return;
  const verificados = Object.keys(DISENOS_190_VERIFICADOS).join(', ');
  throw conflict(
    `Todavía no se puede generar el fichero del modelo 190 de ${ejercicio}: la app tiene el diseño de registro de ${verificados} ` +
      `y el de ${ejercicio} no está verificado (la AEAT lo publica antes de la campaña de enero). ` +
      'Mientras tanto, descarga el informe por perceptor (Excel) y preséntalo con el formulario de la Sede.',
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
  /** Numero identificativo de la declaracion (13 digitos, empieza por 190). */
  numeroDeclaracion?: string | null;
}

/** Texto en mayusculas, sin acentos ni caracteres especiales (se quedan la Ñ y la Ç). */
export function textoAeat(valor: string | null | undefined): string {
  return String(valor ?? '')
    .toUpperCase()
    .replace(/Ñ/g, '\u0000')
    .replace(/Ç/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0000/g, 'Ñ')
    .replace(/\u0001/g, 'Ç')
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const alfa = (valor: string | null | undefined, len: number) => textoAeat(valor).slice(0, len).padEnd(len, ' ');
const num = (valor: number | string | null | undefined, len: number) => {
  const d = String(Math.trunc(Math.abs(Number(valor) || 0)));
  return d.slice(-len).padStart(len, '0');
};
/** Importe sin signo ni coma: parte entera y dos decimales, con ceros a la izquierda. */
const imp = (euros: number, len = 13) => String(Math.round(Math.abs(euros) * 100)).padStart(len, '0').slice(-len);
/** NIF ajustado a la derecha con ceros (la ultima posicion es el caracter de control). */
const nifDer = (nif: string | null | undefined) => {
  const v = String(nif ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v ? v.slice(-9).padStart(9, '0') : ' '.repeat(9);
};

function registro(campos: Array<[number, string]>): string {
  const r = new Array<string>(LONGITUD_REGISTRO_190).fill(' ');
  for (const [pos, valor] of campos) {
    for (let i = 0; i < valor.length; i++) r[pos - 1 + i] = valor[i];
  }
  return r.join('');
}

/** Claves con datos adicionales del perceptor (posiciones 153-254, segun el diseno). */
const conDatosPersonales = (p: Perceptor190) => p.clave === 'A' || p.clave === 'C' || (p.clave === 'B' && ['01', '03', '04', '99'].includes(p.subclave ?? ''));

/** Registro de tipo 2 (perceptor). */
export function registroPerceptor190(ejercicio: number, nifDeclarante: string, p: Perceptor190): string {
  const personales = conDatosPersonales(p);
  const esA = p.clave === 'A';
  return registro([
    [1, '2'],
    [2, '190'],
    [5, num(ejercicio, 4)],
    [9, nifDer(nifDeclarante)],
    [18, nifDer(p.nif)],
    [27, ' '.repeat(9)], // NIF del representante legal (menores de 14 anos)
    [36, alfa(p.nombre, 40)],
    [76, num(p.provincia ?? 0, 2)],
    [78, alfa(p.clave, 1)],
    // Subclave: solo en las claves B, C, E, F, G, H, I, K y L.
    [79, p.subclave ? num(p.subclave, 2) : '  '],
    // Percepciones dinerarias no derivadas de incapacidad laboral (81-107).
    [81, ' '],
    [82, imp(p.percepcionIntegra)],
    [95, imp(p.retenciones)],
    // Percepciones en especie (108-147).
    [108, ' '],
    [109, imp(p.valoracionEspecie)],
    [122, imp(p.ingresosACuentaEfectuados)],
    [135, imp(p.ingresosACuentaRepercutidos)],
    [148, num(p.ejercicioDevengo ?? 0, 4)],
    [152, '0'], // Ceuta o Melilla / La Palma
    // Datos adicionales (153-254).
    [153, num(personales ? (p.anioNacimiento ?? 0) : 0, 4)],
    [157, num(personales ? (p.situacionFamiliar ?? 3) : 0, 1)],
    [158, personales && p.situacionFamiliar === 2 ? nifDer(p.nifConyuge) : ' '.repeat(9)],
    [167, num(personales ? (p.discapacidad ?? 0) : 0, 1)],
    [168, num(esA ? (p.contrato ?? 1) : 0, 1)],
    [169, '0'], // titular de la unidad de convivencia (solo L.29)
    [170, esA && p.movilidadGeografica ? '1' : '0'],
    [171, imp(0)], // reducciones aplicables
    [184, imp(p.gastosDeducibles)],
    [197, imp(0)], // pension compensatoria
    [210, imp(0)], // anualidades por alimentos
    [223, '0'.repeat(6)], // hijos y otros descendientes
    [229, '0'.repeat(12)], // descendientes con discapacidad
    [241, '0'.repeat(4)], // ascendientes
    [245, '0'.repeat(6)], // ascendientes con discapacidad
    [251, '0'.repeat(3)], // computo de los 3 primeros hijos
    [254, '0'], // comunicacion prestamos vivienda habitual
    // Percepciones derivadas de incapacidad laboral (255-321): no se registran.
    [255, ' '],
    [256, imp(0)],
    [269, imp(0)],
    [282, ' '],
    [283, imp(0)],
    [296, imp(0)],
    [309, imp(0)],
    [322, '0'], // complemento ayuda para la infancia (solo L.29)
    [323, '0'.repeat(65)], // retenciones por administracion (solo clave E)
    [388, '0'], // excesos entrega acciones empresas emergentes
    [389, '0'], // gestion de fondos de emprendimiento
    [390, '0'.repeat(5)], // tipos de prestacion B.01
    // 395-500: blancos.
  ]);
}

/** Datos que faltan para el fichero (vacio si se puede generar). */
export function erroresFichero190(declarante: Declarante190, perceptores: Perceptor190[]): string[] {
  const errores: string[] = [];
  if (!/^[A-Z0-9]{9}$/.test(String(declarante.nif ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
    errores.push('Falta el NIF de la empresa (Registro Mercantil > Datos para la memoria).');
  }
  if (!textoAeat(declarante.nombre)) errores.push('Falta la razón social de la empresa.');
  if (declarante.numeroDeclaracion && !/^190\d{10}$/.test(declarante.numeroDeclaracion)) {
    errores.push('El número identificativo de la declaración tiene 13 dígitos y empieza por 190.');
  }
  if (!perceptores.length) errores.push('No hay ningún perceptor en el ejercicio.');
  for (const p of perceptores) {
    if (!/^[A-Z0-9]{9}$/.test(p.nif)) errores.push(`${p.nombre}: el NIF "${p.nif}" no tiene 9 caracteres.`);
    if (!p.provincia || !/^(0[1-9]|[1-4]\d|5[0-3]|98)$/.test(p.provincia)) errores.push(`${p.nombre}: falta el código de provincia.`);
    if (conDatosPersonales(p) && !p.anioNacimiento) errores.push(`${p.nombre}: falta el año de nacimiento.`);
    if (conDatosPersonales(p) && p.situacionFamiliar === 2 && !p.nifConyuge) errores.push(`${p.nombre}: falta el NIF del cónyuge (situación familiar 2).`);
  }
  return errores;
}

/**
 * Fichero del 190 de un ejercicio: registro de declarante y uno por perceptor,
 * separados por CRLF. Exige un diseno verificado (comprobarDiseno190) y los
 * datos obligatorios (400 con la lista de lo que falta).
 */
export function generarFicheroModelo190(ejercicio: number, declarante: Declarante190, perceptores: Perceptor190[]): string {
  comprobarDiseno190(ejercicio);
  const errores = erroresFichero190(declarante, perceptores);
  if (errores.length) {
    throw badRequest(`No se puede generar el fichero del 190: ${errores.slice(0, 5).join(' ')}${errores.length > 5 ? ` (y ${errores.length - 5} más)` : ''}`, { errores });
  }
  // Importe total: percepciones dinerarias + valoracion de la especie (y las de IT, que no hay).
  const totalPercepciones = perceptores.reduce((a, p) => a + Math.round(p.percepcionIntegra * 100) + Math.round(p.valoracionEspecie * 100), 0) / 100;
  // Retenciones + ingresos a cuenta efectuados.
  const totalRetenciones = perceptores.reduce((a, p) => a + Math.round(p.retenciones * 100) + Math.round(p.ingresosACuentaEfectuados * 100), 0) / 100;
  const tipo1 = registro([
    [1, '1'],
    [2, '190'],
    [5, num(ejercicio, 4)],
    [9, nifDer(declarante.nif)],
    [18, alfa(declarante.nombre, 40)],
    [58, 'T'], // transmision telematica
    [59, num(String(declarante.telefono ?? '').replace(/\D/g, ''), 9)],
    [68, alfa(declarante.contacto, 40)],
    [108, num(declarante.numeroDeclaracion ?? `190${num(ejercicio, 4)}000001`, 13)],
    [121, '  '], // complementaria / sustitutiva
    [123, '0'.repeat(13)], // declaracion anterior
    [136, num(perceptores.length, 9)],
    [145, totalPercepciones < 0 ? 'N' : ' '],
    [146, imp(totalPercepciones, 15)],
    [161, imp(totalRetenciones, 15)],
    [176, String(declarante.email ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 50).padEnd(50, ' ')],
    // 226-487 blancos; 488-500 sello electronico (blancos).
  ]);
  return [tipo1, ...perceptores.map((p) => registroPerceptor190(ejercicio, declarante.nif, p))].join('\r\n') + '\r\n';
}

/** Informe del 190 en Excel: una fila por registro de perceptor y los totales. */
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
    'Discapacidad',
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
    p.discapacidad ?? '',
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
