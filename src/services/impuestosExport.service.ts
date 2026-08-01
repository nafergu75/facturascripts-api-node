import { DatosModelo111, DatosModelo115, DatosModelo303, DatosModelo347, DatosModelo349, DatosModelo390, PeriodoFiscal } from '../domain/impuestos.model';

/**
 * Generacion de ficheros BOE (ancho fijo) para importar en la Sede AEAT.
 *
 * IMPORTANTE: las longitudes y POSICIONES exactas de cada campo deben tomarse
 * del "Diseño de registros" OFICIAL de la AEAT de cada modelo (303/390/347/349).
 * Aqui se implementan los HELPERS de formato (que son estables) y un layout
 * REPRESENTATIVO/provisional marcado con TODO. Sustituir el layout por el oficial
 * cuando se disponga del diseño de registros.
 */

// --- Helpers de formato (estables, reutilizables) ---

/** Texto alineado a la izquierda, rellenado con espacios y truncado a len. */
export function texto(valor: string, len: number): string {
  return (valor ?? '').toString().slice(0, len).padEnd(len, ' ');
}

/** Entero alineado a la derecha, rellenado con ceros. */
export function numero(valor: number | string, len: number): string {
  const n = Math.trunc(Math.abs(Number(valor) || 0));
  return String(n).slice(0, len).padStart(len, '0');
}

/**
 * Importe en formato AEAT: valor en centimos (2 decimales implicitos), alineado
 * a la derecha y relleno con ceros. Los NEGATIVOS llevan 'N' en la 1a posicion
 * (campos tipo N); los positivos son todo digitos (sin signo). Vale para Num y N.
 */
export function importe(valor: number, len: number): string {
  const centimos = Math.round(Math.abs(valor) * 100);
  if (valor < 0) {
    return 'N' + String(centimos).padStart(len - 1, '0').slice(-(len - 1));
  }
  return String(centimos).padStart(len, '0').slice(-len);
}

/** Fecha yyyy-mm-dd -> ddmmyyyy. */
export function fecha(yyyymmdd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || '');
  return m ? `${m[3]}${m[2]}${m[1]}` : '00000000';
}

// --- Motor declarativo de layout de ancho fijo ---
// Cuando tengas el "Diseño de registros" oficial de la AEAT, solo hay que
// rellenar el array de CampoLayout (posicion/longitud/tipo) de cada modelo.

export type TipoCampo = 'A' | 'N' | 'I' | 'F'; // Alfanumerico, Numerico, Importe, Fecha

export interface CampoLayout {
  nombre: string;
  posicion: number; // posicion inicial (1-based) segun el diseno AEAT
  longitud: number;
  tipo: TipoCampo;
}

function formatearCampo(campo: CampoLayout, valor: unknown): string {
  switch (campo.tipo) {
    case 'A':
      return texto(String(valor ?? ''), campo.longitud);
    case 'N':
      return numero(Number(valor ?? 0), campo.longitud);
    case 'I':
      return importe(Number(valor ?? 0), campo.longitud);
    case 'F':
      return fecha(String(valor ?? '')).padEnd(campo.longitud, ' ').slice(0, campo.longitud);
  }
}

/**
 * Compone un registro de ancho fijo a partir del layout y los valores (en el
 * mismo orden que el layout). Respeta la `posicion` rellenando huecos con
 * espacios, de modo que el resultado cuadra con el diseno de registros oficial.
 */
export function componerRegistro(layout: CampoLayout[], valores: unknown[]): string {
  const ordenado = [...layout].sort((a, b) => a.posicion - b.posicion);
  let out = '';
  let pos = 1;
  ordenado.forEach((campo, i) => {
    if (campo.posicion > pos) out += ' '.repeat(campo.posicion - pos); // hueco
    out += formatearCampo(campo, valores[i]);
    pos = campo.posicion + campo.longitud;
  });
  return out;
}

/**
 * Layout PROVISIONAL del Modelo 303 (sustituir posiciones/longitudes por el
 * diseno de registros OFICIAL de la AEAT). Es la unica tabla a tocar cuando se
 * disponga del PDF/XLSX oficial.
 */
export const LAYOUT_303: CampoLayout[] = [
  { nombre: 'modelo', posicion: 1, longitud: 3, tipo: 'A' },
  { nombre: 'ejercicio', posicion: 4, longitud: 4, tipo: 'N' },
  { nombre: 'periodo', posicion: 8, longitud: 2, tipo: 'A' },
  { nombre: 'nif', posicion: 10, longitud: 9, tipo: 'A' },
  { nombre: 'razonSocial', posicion: 19, longitud: 40, tipo: 'A' },
  { nombre: 'baseDevengada', posicion: 59, longitud: 17, tipo: 'I' },
  { nombre: 'cuotaDevengada', posicion: 76, longitud: 17, tipo: 'I' },
  { nombre: 'baseDeducible', posicion: 93, longitud: 17, tipo: 'I' },
  { nombre: 'cuotaDeducible', posicion: 110, longitud: 17, tipo: 'I' },
  { nombre: 'resultado', posicion: 127, longitud: 17, tipo: 'I' },
];

// --- Generadores por modelo (layout PROVISIONAL, ajustar al oficial) ---

/**
 * Modelo 303 (autoliquidacion IVA). Layout representativo:
 * [modelo(3)][ejercicio(4)][periodo(2)][nif(9)][razonSocial(40)]
 * [baseDevengada][cuotaDevengada][baseDeducible][cuotaDeducible][resultado]
 * TODO: reemplazar por el diseño de registros oficial del 303.
 */
/**
 * Modelo 303 — registro de PAGINA 01 (identificacion + liquidacion regimen
 * general), segun el diseno de registros OFICIAL de la AEAT (v1.01, 2026).
 *
 * Registro de ancho fijo de 1581 caracteres, envuelto en el tag
 *   <T303 01000 > ... </T30301000>
 * Campos numericos rellenos con ceros; alfanumericos con blancos. Importes en
 * formato AEAT: signo (' '/'N') + 16 digitos en centimos (validacion 39).
 *
 * Se rellenan las casillas que calculamos; el resto quedan a cero. El IVA
 * devengado se vuelca en el bloque [01]/[02]/[03] (si hay varios tipos, se usa
 * el tipo dominante; TODO: repartir por casilla segun cada tipo).
 *
 * PENDIENTE para fichero 100% completo: registro de cabecera del fichero
 * (hoja "cabecera" del diseno) y resto de paginas (resultado final, casilla 71).
 */
export function generarFicheroModelo303(
  nif: string,
  periodo: PeriodoFiscal,
  datos: DatosModelo303,
  razonSocial = '',
): string {
  const LEN = 1581;
  const buf: string[] = new Array(LEN).fill(' ');

  // zero-fill de los bloques numericos (ejercicio; flags; liquidacion hasta [46])
  const zero = (desde: number, hasta: number): void => {
    for (let i = desde; i <= hasta; i++) buf[i - 1] = '0';
  };
  zero(103, 106); // ejercicio
  zero(109, 117); // flags identificacion
  zero(127, 1035); // flags + liquidacion (importes/tipos) hasta casilla [46]

  // escribe `valor` (ya formateado a longitud) en la posicion (1-based)
  const put = (pos: number, valor: string): void => {
    for (let i = 0; i < valor.length; i++) buf[pos - 1 + i] = valor[i];
  };

  // Constantes del tag de pagina
  put(1, '<T');
  put(3, '303');
  put(6, '01000');
  put(11, '>');
  put(1570, '</T30301000>');

  // Identificacion
  put(14, texto(nif, 9));
  put(23, texto(razonSocial, 80));
  put(103, numero(periodo.ejercicio, 4));
  put(107, texto(periodo.periodo, 2));

  // IVA devengado regimen general: TRES filas por tipo impositivo (diseno oficial)
  //   fila 1: [01]base@209 [02]tipo@226 [03]cuota@231   (habitualmente 21%)
  //   fila 2: [04]base@287 [05]tipo@304 [06]cuota@309   (habitualmente 10%)
  //   fila 3: [07]base@326 [08]tipo@343 [09]cuota@348   (habitualmente 4%)
  // Se rellenan por tipo de IVA en orden descendente. TODO: si hubiera mas de 3
  // tipos en un periodo, los excedentes no caben en el RG (revisar regimenes).
  const FILAS: Array<[number, number, number]> = [
    [209, 226, 231],
    [287, 304, 309],
    [326, 343, 348],
  ];
  const desglose = [...datos.ivaDevengado].sort((a, b) => b.tipo - a.tipo).slice(0, 3);
  desglose.forEach((d, i) => {
    const [pBase, pTipo, pCuota] = FILAS[i];
    put(pBase, importe(d.base, 17)); // base
    put(pTipo, numero(Math.round(d.tipo * 100), 5)); // tipo% (21% -> 02100)
    put(pCuota, importe(d.cuota, 17)); // cuota
  });
  put(696, importe(datos.totalCuotaDevengada, 17)); // [27] total cuota devengada

  // IVA deducible operaciones interiores corrientes -> [28] base / [29] cuota
  put(713, importe(datos.totalBaseDeducible, 17)); // [28]
  put(730, importe(datos.totalCuotaDeducible, 17)); // [29]
  put(1002, importe(datos.totalCuotaDeducible, 17)); // [45] total a deducir
  put(1019, importe(datos.resultado, 17)); // [46] resultado regimen general

  return buf.join('') + '\r\n';
}

/**
 * Cabecera/envoltura del fichero (modelos 303/390): registro de 328 posiciones
 * + contenido (paginas) + cierre de 18 posiciones, segun hoja DP30300/DP39000.
 *
 * NOTA: las constantes de las posiciones 13 (tipo y cierre), 18 y 323 referencian
 * codigos de validacion (181/14/17) de las TABLAS de validacion de la AEAT, que
 * NO vienen en el xlsx del diseno; se dejan en blanco (TODO: literal oficial).
 * El resto (tag <T, modelo, ejercicio, periodo, version, NIF ED, cierre) si es
 * determinable. discriminante por defecto ' '.
 */
export function envolverFichero(
  modelo: string,
  ejercicio: number,
  periodo: string,
  contenidoPaginas: string,
  opts: { discriminante?: string; versionPrograma?: string; nifEmpresaDesarrollo?: string } = {},
): string {
  const disc = (opts.discriminante ?? ' ').slice(0, 1);
  const cab: string[] = new Array(328).fill(' ');
  // pos1-2 "<T"; pos3-5 modelo; pos6 discriminante; pos7-10 ejercicio; pos11-12 periodo
  for (let i = 0; i < 2; i++) cab[i] = '<T'[i];
  for (let i = 0; i < 3; i++) cab[2 + i] = modelo[i];
  cab[5] = disc;
  const ej = numero(ejercicio, 4);
  for (let i = 0; i < 4; i++) cab[6 + i] = ej[i];
  const per = texto(periodo, 2);
  for (let i = 0; i < 2; i++) cab[10 + i] = per[i];
  // pos13(5) tipo y cierre, pos18(5) const, pos323(6) const -> blancos (TODO validacion)
  // pos93(4) version del programa
  const ver = texto(opts.versionPrograma ?? '', 4);
  for (let i = 0; i < 4; i++) cab[92 + i] = ver[i];
  // pos101(9) NIF Empresa Desarrollo
  const nifED = texto(opts.nifEmpresaDesarrollo ?? '', 9);
  for (let i = 0; i < 9; i++) cab[100 + i] = nifED[i];

  // cierre (18): </T + modelo + discriminante + ejercicio + periodo + blancos
  const cierre = ('</T' + modelo + disc + ej + per).padEnd(18, ' ').slice(0, 18);

  return cab.join('') + contenidoPaginas + cierre + '\r\n';
}

/**
 * Modelo 303 — PAGINA 3 (DP30303, diseno oficial): informacion adicional +
 * resultado final. Longitud 1017, tag <T30303000>, cierre </T30303000>@1006.
 * Casillas: [59]@12 entregas intracom, [60]@29 exportaciones, [64]@199 suma,
 * [65]@216 %estado (100,00), [66]@221 atribuible, [110]@255 a compensar
 * pendientes, [78]@272 a compensar aplicadas, [87]@289 pendientes futuras,
 * [69]@340 resultado autoliquidacion, [71]@408 RESULTADO FINAL.
 */
export function generarPaginaModelo303_03(datos: DatosModelo303): string {
  const LEN = 1017;
  const buf: string[] = new Array(LEN).fill(' ');
  const put = (pos: number, valor: string): void => {
    for (let i = 0; i < valor.length; i++) buf[pos - 1 + i] = valor[i];
  };
  const zero = (desde: number, hasta: number): void => {
    for (let i = desde; i <= hasta; i++) buf[i - 1] = '0';
  };

  put(1, '<T303' + '03000' + '>');
  // Bloques numericos a cero por defecto (info adicional + resultado)
  zero(12, 459);

  put(12, importe(datos.entregasIntracomunitarias ?? 0, 17)); // [59]
  put(29, importe(datos.exportaciones ?? 0, 17)); // [60]
  put(182, importe(0, 17)); // [76]
  put(199, importe(datos.resultado, 17)); // [64] = [46]+[58]+[76]
  put(216, numero(10000, 5)); // [65] % Estado = 100,00
  put(221, importe(datos.resultado, 17)); // [66] atribuible al Estado

  const aCompensar = datos.cuotasACompensarAnteriores ?? 0;
  put(255, importe(aCompensar, 17)); // [110] pendientes de periodos anteriores
  put(272, importe(aCompensar, 17)); // [78] aplicadas en este periodo
  put(289, importe(0, 17)); // [87] = [110]-[78]

  const resultadoFinal = datos.resultadoFinal ?? datos.resultado;
  put(340, importe(resultadoFinal, 17)); // [69] = [66]+[77]-[78]+[68]+[108]
  put(357, importe(0, 17)); // [70] resultados anteriores
  put(408, importe(resultadoFinal, 17)); // [71] RESULTADO

  put(1006, '</T30303000>');
  return buf.join('');
}

/**
 * Modelo 200 (Impuesto sobre Sociedades) — diseno OFICIAL v1.01. Es un fichero
 * ENORME (77 paginas: balance, PyG, ajustes, liquidacion...). Aqui se genera la
 * envoltura <AUX> + la pagina de IDENTIFICACION DP200001 (627 chars): NIF, razon
 * social, ejercicio, periodo impositivo y tag. Las paginas de liquidacion
 * (resultado, base imponible, cuota) son extensas -> TODO (mapear DP200xxx).
 */
export function generarFicheroModelo200(
  nif: string,
  ejercicio: number,
  opts: { razonSocial?: string; tipoDeclaracion?: string; versionPrograma?: string; nifEmpresaDesarrollo?: string } = {},
): string {
  const ej = numero(ejercicio, 4);
  // --- Pagina DP200001 (identificacion, 627) ---
  const p = new Array(627).fill('0') as string[];
  const blank = (d: number, h: number): void => {
    for (let i = d; i <= h; i++) p[i - 1] = ' ';
  };
  blank(1, 13); // tag + complementaria + tipo declaracion
  blank(14, 102); // NIF + razon social
  blank(107, 108); // periodo
  blank(131, 148); // telefonos
  blank(403, 627); // sello + reservados + cierre

  escribir(p, 1, '<T');
  escribir(p, 3, '200');
  escribir(p, 6, '01000');
  escribir(p, 11, '>');
  escribir(p, 13, opts.tipoDeclaracion ?? 'I'); // tipo declaracion (I ingresar...)
  escribir(p, 14, texto(nif, 9));
  escribir(p, 23, texto((opts.razonSocial ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), 80));
  escribir(p, 103, ej);
  escribir(p, 107, '0A'); // periodo (anual)
  escribir(p, 109, ej); // periodo impositivo: año inicio
  escribir(p, 113, '01'); // mes inicio
  escribir(p, 115, '01'); // dia inicio
  escribir(p, 117, ej); // año final
  escribir(p, 121, '12'); // mes final
  escribir(p, 123, '31'); // dia final
  escribir(p, 125, '1'); // tipo de ejercicio
  escribir(p, 616, '</T20001000>'); // fin de registro

  // --- Cabecera/envoltura <AUX> (328) ---
  // tag (17): <T + 200 + disc('0') + ejercicio + 0A + tipo('0000') + >
  const tag = '<T200' + '0' + ej + '0A' + '0000' + '>';
  const cab = new Array(328).fill(' ') as string[];
  escribir(cab, 1, tag);
  escribir(cab, 18, '<AUX>');
  escribir(cab, 93, texto(opts.versionPrograma ?? '', 4));
  escribir(cab, 101, texto(opts.nifEmpresaDesarrollo ?? '', 9));
  escribir(cab, 323, '</AUX>');

  const cierre = '</T200' + '0' + ej + '0A' + '0000' + '>'; // 18
  return cab.join('') + p.join('') + cierre + '\r\n';
}

// Helpers de construccion de registros de ancho fijo (AEAT)
function escribir(buf: string[], pos: number, valor: string): void {
  for (let i = 0; i < valor.length; i++) buf[pos - 1 + i] = valor[i];
}
function rellenarCeros(buf: string[], desde: number, hasta: number): void {
  for (let i = desde; i <= hasta; i++) buf[i - 1] = '0';
}

/**
 * Modelo 390 (resumen anual IVA) — diseno OFICIAL v1.02. Genera los registros
 * de las paginas clave: identificacion (01000), resultado regimen general
 * (04000, [65]) y resultado anual + volumen (06000, [84]/[86]/[99]/[108]).
 *
 * PENDIENTE para fichero 100% importable: paginas de desglose (02000, 02B00,
 * 03000, 05000) y la cabecera/envoltura del fichero. Cada pagina tiene su
 * longitud y tag propios (mapeados del diseno).
 */
export function generarFicheroModelo390(nif: string, ejercicio: number, datos: DatosModelo390): string {
  // Pagina 01000 - Identificacion (mayoritariamente alfanumerica -> blancos)
  const pag01 = new Array(1187).fill(' ') as string[];
  rellenarCeros(pag01, 103, 106); // ejercicio (Num)
  escribir(pag01, 1, '<T');
  escribir(pag01, 3, '390');
  escribir(pag01, 6, '01000');
  escribir(pag01, 11, '>');
  escribir(pag01, 14, texto(nif, 9));
  escribir(pag01, 103, numero(ejercicio, 4));
  escribir(pag01, 1176, '</T39001000>');

  // Pagina 04000 - Resultado regimen general [65] (mayoritariamente numerica -> ceros)
  const pag04 = new Array(854).fill('0') as string[];
  escribir(pag04, 1, '<T');
  escribir(pag04, 3, '390');
  escribir(pag04, 6, '04000');
  escribir(pag04, 11, '>');
  escribir(pag04, 676, importe(datos.resultadoAnual, 17)); // [65]
  escribir(pag04, 843, '</T39004000>');

  // Pagina 06000 - Resultado liquidacion anual + volumen de operaciones
  const pag06 = new Array(828).fill('0') as string[];
  escribir(pag06, 1, '<T');
  escribir(pag06, 3, '390');
  escribir(pag06, 6, '06000');
  escribir(pag06, 11, '>');
  escribir(pag06, 30, importe(datos.resultadoAnual, 17)); // [84] suma de resultados
  escribir(pag06, 81, importe(datos.resultadoAnual, 17)); // [86] resultado de la liquidacion
  escribir(pag06, 361, importe(datos.volumenOperaciones, 17)); // [99] operaciones regimen general
  escribir(pag06, 650, importe(datos.volumenOperaciones, 17)); // [108] total volumen de operaciones
  escribir(pag06, 817, '</T39006000>');

  return [pag01.join(''), pag04.join(''), pag06.join('')].join('\r\n') + '\r\n';
}

/**
 * Modelo 111 (retenciones IRPF) — diseno OFICIAL v1.9. Fichero = cabecera/envoltura
 * <AUX> (328) + pagina M11101 (1000) + cierre (18). La envoltura del 111 trae sus
 * constantes literales (a diferencia del 303/390): pos6 '0', pos13 '0000>',
 * pos18 '<AUX>', pos323 '</AUX>', cierre '</T1110'+ejercicio+periodo+'0000>'.
 *
 * Pagina: tag '<T11101000>', NIF@14, denominacion@23(60), ejercicio@103, periodo@107,
 * rendim. trabajo nº perceptores@109/percepciones@117/retenciones@134, total
 * suma retenciones [casilla 28]@487, resultado a ingresar [30]@521, cierre @989.
 */
export function generarFicheroModelo111(
  nif: string,
  periodo: PeriodoFiscal,
  datos: DatosModelo111,
  opts: { denominacion?: string; versionPrograma?: string; nifEmpresaDesarrollo?: string } = {},
): string {
  const cents = (v: number): number => Math.round(Math.abs(v) * 100);

  // --- Pagina M11101 (1000 chars), mayoritariamente numerica -> ceros ---
  const p = new Array(1000).fill('0') as string[];
  const blank = (desde: number, hasta: number): void => {
    for (let i = desde; i <= hasta; i++) p[i - 1] = ' ';
  };
  blank(1, 12); // tag (se sobrescribe) + indicador pag complementaria
  blank(13, 13); // tipo declaracion (A)
  blank(14, 102); // NIF + denominacion + nombre (An)
  blank(107, 108); // periodo (An)
  blank(538, 1000); // complementaria/justificante/IBAN/reservado/sello/cierre (An)

  escribir(p, 1, '<T');
  escribir(p, 3, '111');
  escribir(p, 6, '01');
  escribir(p, 8, '000>');
  escribir(p, 13, datos.resultadoIngresar < 0 ? 'N' : 'I'); // tipo declaracion (I ingreso / N negativa)
  escribir(p, 14, texto(nif, 9));
  escribir(p, 23, texto((opts.denominacion ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), 60));
  escribir(p, 103, numero(periodo.ejercicio, 4));
  escribir(p, 107, texto(periodo.periodo, 2));
  escribir(p, 109, numero(datos.nPerceptoresTrabajo, 8)); // nº perceptores trabajo dinerario
  escribir(p, 117, numero(cents(datos.percepcionesTrabajo), 17)); // importe percepciones
  escribir(p, 134, numero(cents(datos.retencionesTrabajo), 17)); // importe retenciones
  escribir(p, 487, numero(cents(datos.totalRetenciones), 17)); // [28] suma retenciones e ingresos a cuenta
  escribir(p, 521, numero(cents(datos.resultadoIngresar), 17)); // [30] resultado a ingresar
  escribir(p, 989, '</T11101000>');
  const pagina = p.join('');

  // --- Cabecera/envoltura <AUX> (328) ---
  const cab = new Array(328).fill(' ') as string[];
  escribir(cab, 1, '<T');
  escribir(cab, 3, '111');
  escribir(cab, 6, '0');
  escribir(cab, 7, numero(periodo.ejercicio, 4));
  escribir(cab, 11, texto(periodo.periodo, 2));
  escribir(cab, 13, '0000>');
  escribir(cab, 18, '<AUX>');
  escribir(cab, 93, texto(opts.versionPrograma ?? '', 4));
  escribir(cab, 101, texto(opts.nifEmpresaDesarrollo ?? '', 9));
  escribir(cab, 323, '</AUX>');

  const cierre = '</T1110' + numero(periodo.ejercicio, 4) + texto(periodo.periodo, 2) + '0000>';

  return cab.join('') + pagina + cierre + '\r\n';
}

/**
 * Modelo 115 (retenciones arrendamiento inmuebles) — diseno OFICIAL v1.3.
 * Envoltura <AUX> (328) + pagina DR11501 (500) + cierre (18) = 846 chars.
 * Pagina: tag '<T11501000>', NIF@14, razon@23(60), ejercicio@103, periodo@107,
 * [01] perceptores@109(15), [02] base@124(17), [03] retenciones@141(17),
 * [04] anteriores@158(17), [05] a ingresar@175(17), cierre '</T11501000>'@489.
 */
export function generarFicheroModelo115(
  nif: string,
  periodo: PeriodoFiscal,
  datos: DatosModelo115,
  opts: { razonSocial?: string; versionPrograma?: string; nifEmpresaDesarrollo?: string } = {},
): string {
  const cents = (v: number): number => Math.round(Math.abs(v) * 100);

  const p = new Array(500).fill('0') as string[];
  const blank = (d: number, h: number): void => {
    for (let i = d; i <= h; i++) p[i - 1] = ' ';
  };
  blank(1, 13); // tag + complementaria + tipo declaracion
  blank(14, 102); // NIF + razon + nombre
  blank(107, 108); // periodo
  blank(192, 500); // complementaria/justificante/IBAN/reservado/sello/cierre

  escribir(p, 1, '<T');
  escribir(p, 3, '115');
  escribir(p, 6, '01');
  escribir(p, 8, '000>');
  escribir(p, 13, datos.resultadoIngresar < 0 ? 'N' : 'I');
  escribir(p, 14, texto(nif, 9));
  escribir(p, 23, texto((opts.razonSocial ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), 60));
  escribir(p, 103, numero(periodo.ejercicio, 4));
  escribir(p, 107, texto(periodo.periodo, 2));
  escribir(p, 109, numero(datos.nPerceptores, 15)); // [01]
  escribir(p, 124, numero(cents(datos.baseRetenciones), 17)); // [02]
  escribir(p, 141, numero(cents(datos.retenciones), 17)); // [03]
  escribir(p, 158, numero(cents(datos.resultadoAnteriores), 17)); // [04]
  escribir(p, 175, numero(cents(datos.resultadoIngresar), 17)); // [05]
  escribir(p, 489, '</T11501000>');

  const cab = new Array(328).fill(' ') as string[];
  escribir(cab, 1, '<T');
  escribir(cab, 3, '115');
  escribir(cab, 6, '0');
  escribir(cab, 7, numero(periodo.ejercicio, 4));
  escribir(cab, 11, texto(periodo.periodo, 2));
  escribir(cab, 13, '0000>');
  escribir(cab, 18, '<AUX>');
  escribir(cab, 93, texto(opts.versionPrograma ?? '', 4));
  escribir(cab, 101, texto(opts.nifEmpresaDesarrollo ?? '', 9));
  escribir(cab, 323, '</AUX>');

  const cierre = '</T1150' + numero(periodo.ejercicio, 4) + texto(periodo.periodo, 2) + '0000>';
  return cab.join('') + p.join('') + cierre + '\r\n';
}

/**
 * Importe en formato 347: 16 posiciones = signo (' ' positivo / 'N' negativo) +
 * 15 digitos en centimos. (El 347 usa subcampo SIGNO explicito.)
 */
function importe347(valor: number): string {
  const centimos = Math.round(Math.abs(valor) * 100);
  return (valor < 0 ? 'N' : ' ') + String(centimos).padStart(15, '0').slice(-15);
}

/**
 * Modelo 347 (operaciones con terceros > 3.005,06 €) — diseno OFICIAL (ej. 2025+).
 * Registro Tipo 1 (declarante, 500 chars) + 1 registro Tipo 2 (declarado, 500)
 * por cada tercero. Alfanumericos en MAYUSCULAS sin acentos, ISO-8859-1.
 *
 * Mapeo (posiciones oficiales): T1 nº personas@136, importe total@145(signo+15);
 * T2 NIF declarado@18, razon social@36, tipo hoja 'D'@76, clave A/B@82,
 * importe anual@83(signo+15). Campos no usados a ceros/blancos.
 */
export function generarFicheroModelo347(
  nif: string,
  ejercicio: number,
  datos: DatosModelo347,
  razonSocial = '',
): string {
  const sinAcentos = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  const totalBase = datos.operaciones.reduce((a, o) => a + o.baseAnual, 0);

  // --- Registro Tipo 1: declarante ---
  const t1 = new Array(500).fill(' ') as string[];
  escribir(t1, 1, '1');
  escribir(t1, 2, '347');
  escribir(t1, 5, numero(ejercicio, 4));
  escribir(t1, 9, texto(nif, 9));
  escribir(t1, 18, texto(sinAcentos(razonSocial), 40));
  escribir(t1, 58, 'T'); // tipo soporte: transmision telematica
  escribir(t1, 59, numero(0, 9)); // telefono
  escribir(t1, 108, '347' + '0'.repeat(10)); // nº identificativo declaracion (13)
  escribir(t1, 136, numero(datos.operaciones.length, 9)); // nº total personas/entidades
  escribir(t1, 145, importe347(totalBase)); // importe total anual operaciones (16)
  escribir(t1, 161, numero(0, 9)); // nº total inmuebles
  escribir(t1, 170, importe347(0)); // importe total arrendamientos (16)
  // sello AEAT 488-500: blancos

  const registros = [t1.join('')];

  // --- Registros Tipo 2: un declarado por tercero ---
  for (const op of datos.operaciones) {
    const t2 = new Array(500).fill(' ') as string[];
    escribir(t2, 1, '2');
    escribir(t2, 2, '347');
    escribir(t2, 5, numero(ejercicio, 4));
    escribir(t2, 9, texto(nif, 9)); // NIF declarante
    escribir(t2, 18, texto(op.cifnif, 9)); // NIF declarado
    escribir(t2, 36, texto(sinAcentos(op.nombre), 40)); // razon social declarado
    escribir(t2, 76, 'D'); // tipo de hoja
    escribir(t2, 77, numero(0, 4)); // codigo provincia/pais
    escribir(t2, 82, op.tipo === 'cliente' ? 'B' : 'A'); // clave operacion (B ventas / A compras)
    escribir(t2, 83, importe347(op.baseAnual)); // importe anual de las operaciones (16)
    escribir(t2, 101, numero(0, 15)); // importe percibido en metalico (15, numerico) -> ceros
    registros.push(t2.join(''));
  }

  return registros.join('\r\n') + '\r\n';
}

/**
 * Modelo 349 (operaciones intracomunitarias) — diseno OFICIAL. Registro Tipo 1
 * (declarante, 500) + 1 Tipo 2 (operador intracomunitario, 500) por operacion.
 * Importes SIN signo (regla 349), centimos. Mayusculas sin acentos, ISO-8859-1.
 *
 * Mapeo: T1 periodo@136, nº operadores@138, importe operaciones@147(15);
 * T2 NIF operador comunitario@76(17), nombre@93, clave operacion@133,
 * base imponible@134(13).
 */
export function generarFicheroModelo349(
  nif: string,
  periodo: PeriodoFiscal,
  datos: DatosModelo349,
  razonSocial = '',
): string {
  const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const cents = (v: number): number => Math.round(Math.abs(v) * 100);

  // --- Tipo 1: declarante ---
  const t1 = new Array(500).fill(' ') as string[];
  escribir(t1, 1, '1');
  escribir(t1, 2, '349');
  escribir(t1, 5, numero(periodo.ejercicio, 4));
  escribir(t1, 9, texto(nif, 9));
  escribir(t1, 18, texto(sinAcentos(razonSocial), 40));
  escribir(t1, 58, 'T'); // tipo soporte: transmision telematica
  escribir(t1, 108, '349' + '0'.repeat(10)); // nº identificativo declaracion (13)
  escribir(t1, 136, texto(periodo.periodo, 2)); // periodo
  escribir(t1, 138, numero(datos.operaciones.length, 9)); // nº total operadores intracom
  escribir(t1, 147, numero(cents(datos.totalBase), 15)); // importe operaciones intracom (15)
  escribir(t1, 162, numero(0, 9)); // nº operadores con rectificaciones
  escribir(t1, 171, numero(0, 15)); // importe rectificaciones (15)

  const registros = [t1.join('')];

  // --- Tipo 2: un operador intracomunitario por operacion ---
  for (const op of datos.operaciones) {
    const t2 = new Array(500).fill(' ') as string[];
    escribir(t2, 1, '2');
    escribir(t2, 2, '349');
    escribir(t2, 5, numero(periodo.ejercicio, 4));
    escribir(t2, 9, texto(nif, 9)); // NIF declarante
    escribir(t2, 76, texto(op.cifnif, 17)); // NIF operador comunitario (con prefijo pais)
    escribir(t2, 93, texto(sinAcentos(op.nombre), 40)); // razon social operador
    escribir(t2, 133, op.clave); // clave operacion (E entregas / A adquisiciones)
    escribir(t2, 134, numero(cents(op.base), 13)); // base imponible (13)
    registros.push(t2.join(''));
  }

  return registros.join('\r\n') + '\r\n';
}
