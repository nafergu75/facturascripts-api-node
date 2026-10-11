/**
 * Modelo 390 (declaración-resumen anual del IVA) con el diseño de registro
 * OFICIAL vers. 1.02 (dr390e2025.xlsx): src/domain/aeat/dr390-v102.json.
 *
 * Fichero = cabecera <AUX> (328) + páginas seguidas, sin separadores, en el
 * orden del diseño (01000, 02000, 02B00, 03000, 04000, 06000 y 07000 si hace
 * falta) + cierre de 18 "</T3900EEEE0A0000>". Las páginas 05000 (régimen
 * simplificado) y 08000 (sectores diferenciados) no aplican a una S.L./S.A.
 * normal y no se generan.
 *
 * Las casillas de la pantalla salen de las mismas páginas que el fichero.
 * REVISAR: es el diseño del ejercicio 2025. El de 2026 cambia por la Orden
 * HAC/27/2026 (carburantes) y aún no está en la sede (comprobado el 11-10-2026).
 */
import dr390 from '../../domain/aeat/dr390-v102.json';
import type { DesgloseIva, VolumenOperaciones390 } from '../../domain/impuestos.model';
import { aCentimos } from '../../utils/money';
import { CampoOficial, exigirDiseno, nifLimpio, PaginaOficial, RegistroAeat, textoAeat } from './diseno';

interface Diseno390 {
  version: string;
  ejercicio: number;
  revisar: string;
  orden: string[];
  cabecera: { hoja: string; campos: CampoOficial[] };
  paginas: Record<string, PaginaOficial>;
}
export const DISENO_390 = dr390 as unknown as Diseno390;

export const TITULOS_390: Record<string, string> = {
  '01000': 'Página 1. Sujeto pasivo, devengo, datos estadísticos y representantes',
  '02000': 'Página 2. IVA devengado (régimen general)',
  '02B00': 'Página 2 bis. Recargo de equivalencia y total de cuotas devengadas',
  '03000': 'Página 3. IVA deducible (operaciones interiores, importaciones y adquisiciones intracomunitarias de bienes corrientes)',
  '04000': 'Página 4. IVA deducible (resto) y resultado del régimen general',
  '06000': 'Página 6. Resultado de la liquidación anual, tributación por territorio y volumen de operaciones',
  '07000': 'Página 7. Operaciones específicas y prorratas',
};

export interface Entrada390 {
  ejercicio: number;
  identificacion: {
    nif: string;
    razonSocial: string;
    /** Descripción de la actividad principal (40). */
    actividad?: string | null;
    /** Clave de actividad (3) y epígrafe IAE (4) de la actividad principal. */
    claveActividad?: string | null;
    epigrafeIae?: string | null;
    /** CNAE (para la prorrata de la página 7). */
    cnae?: string | null;
    /** Ha presentado el 347 del ejercicio. */
    presenta347?: boolean;
    criterioCaja?: boolean;
    redeme?: boolean;
  };
  /** IVA devengado de las ventas del régimen general, por tipo. */
  devengado: DesgloseIva[];
  /** Adquisiciones intracomunitarias autoliquidadas (devengado y deducible por igual). */
  adquisicionesIntraBienes: DesgloseIva[];
  adquisicionesIntraServicios: DesgloseIva[];
  /** IVA deducible de las compras interiores corrientes, por tipo. */
  deducibleInterior: DesgloseIva[];
  /** IVA deducible de las importaciones de bienes corrientes (DUA), por tipo. */
  importaciones?: DesgloseIva[];
  /** Base de las compras con IVA no deducible ([232], página 7). */
  baseNoDeducible?: number;
  volumen: VolumenOperaciones390;
  /** Resultados del régimen general de cada 303 del año ([46] o equivalente). */
  resultadosTrimestrales: [number, number, number, number];
  /** Cuotas a compensar que vienen del ejercicio anterior. */
  compensarEjercicioAnterior?: number;
  /** Qué se pidió en el último periodo si salió negativo. */
  ultimoPeriodo?: 'compensar' | 'devolver';
  versionPrograma?: string;
  nifEmpresaDesarrollo?: string;
}

export interface PaginaGenerada {
  codigo: string;
  titulo: string;
  /** Casillas con importe distinto de cero (más las de resultado), con el valor que va al fichero. */
  casillas: Record<string, number | string>;
  linea: string;
}

export interface Declaracion390 {
  ejercicio: number;
  diseno: string;
  revisar: string;
  paginas: PaginaGenerada[];
  /** Todas las casillas numeradas que van al fichero: { '65': 1234.56 }. */
  casillas: Record<string, number | string>;
  liquidaciones: { casilla85: number; casilla95: number; casilla97: number; casilla98: number; casilla662: number; finales: number[] };
  paginasNoGeneradas: Array<{ codigo: string; motivo: string }>;
  advertencias: string[];
  errores: string[];
  fichero: string;
}

const pag = (c: string) => new RegistroAeat(DISENO_390.paginas[c], `390 ${c}`);
const cent = aCentimos;
const eur = (c: number) => c / 100;

/** Casillas de base y cuota de cada tipo de IVA por bloque. */
const DEVENGADO: Record<number, [string, string]> = { 4: ['01', '02'], 10: ['03', '04'], 21: ['05', '06'] };
const INTRA_BIENES_DEV: Record<number, [string, string]> = { 4: ['21', '22'], 10: ['23', '24'], 21: ['25', '26'] };
const INTRA_SERV_DEV: Record<number, [string, string]> = { 4: ['545', '546'], 10: ['547', '548'], 21: ['551', '552'] };
const DED_INTERIOR: Record<number, [string, string]> = { 2: ['695', '696'], 4: ['190', '191'], 5: ['724', '725'], 7.5: ['697', '698'], 10: ['603', '604'], 21: ['605', '606'] };
const DED_IMPORT: Record<number, [string, string]> = { 2: ['757', '758'], 4: ['202', '203'], 5: ['732', '733'], 7.5: ['759', '760'], 10: ['619', '620'], 21: ['621', '622'] };
const DED_INTRA_BIENES: Record<number, [string, string]> = { 2: ['765', '766'], 4: ['214', '215'], 5: ['736', '737'], 7.5: ['767', '768'], 10: ['627', '628'], 21: ['629', '630'] };
const DED_INTRA_SERV: Record<number, [string, string]> = { 4: ['587', '588'], 10: ['635', '636'], 21: ['637', '638'] };

/**
 * Reparte las líneas por tipo en sus casillas y devuelve el total (céntimos).
 * Un tipo sin casilla en el diseño (p. ej. el 5 % en el devengado de 2025) es un error.
 */
function porTipos(r: RegistroAeat, filas: DesgloseIva[], mapa: Record<number, [string, string]>, bloque: string, errores: string[]) {
  let base = 0;
  let cuota = 0;
  for (const d of filas) {
    if (cent(d.base) === 0 && cent(d.cuota) === 0) continue;
    const c = mapa[d.tipo];
    if (!c) {
      if (d.tipo === 0 && cent(d.cuota) === 0) continue; // al 0 % no hay cuota que declarar
      errores.push(`${bloque}: hay operaciones al ${d.tipo} % (base ${d.base.toFixed(2)} €), que no tiene casilla en el 390 de este ejercicio.`);
      continue;
    }
    r.importe(c[0], d.base).importe(c[1], d.cuota);
    base += cent(d.base);
    cuota += cent(d.cuota);
  }
  return { base, cuota };
}

/**
 * Resultados de los 303 del año: [85] cuotas del ejercicio anterior aplicadas,
 * [95] total a ingresar, [97]/[98] último periodo a compensar o a devolver y
 * [662] cuotas a compensar generadas en el año que siguen pendientes. Las
 * cuotas a compensar se aplican de la más antigua a la más nueva.
 */
export function liquidaciones390(resultados: number[], compensarAnterior = 0, ultimo: 'compensar' | 'devolver' = 'compensar') {
  let previo = cent(Math.abs(compensarAnterior));
  const pendientes: number[] = [];
  let aplicadoAnterior = 0;
  let aIngresar = 0;
  const finales: number[] = [];
  resultados.forEach((valor, t) => {
    const r = cent(valor);
    if (r > 0) {
      const deAnterior = Math.min(r, previo);
      previo -= deAnterior;
      aplicadoAnterior += deAnterior;
      let resto = r - deAnterior;
      while (resto > 0 && pendientes.length) {
        const x = Math.min(resto, pendientes[0]);
        pendientes[0] -= x;
        resto -= x;
        if (!pendientes[0]) pendientes.shift();
      }
      aIngresar += resto;
      finales.push(resto);
    } else {
      finales.push(r);
      if (r < 0 && t < resultados.length - 1) pendientes.push(-r);
    }
  });
  const last = finales[finales.length - 1] < 0 ? -finales[finales.length - 1] : 0;
  return {
    casilla85: eur(aplicadoAnterior),
    casilla95: eur(aIngresar),
    casilla97: ultimo === 'compensar' ? eur(last) : 0,
    casilla98: ultimo === 'devolver' ? eur(last) : 0,
    casilla662: eur(pendientes.reduce((a, b) => a + b, 0)),
    finales: finales.map(eur),
  };
}

export function construirModelo390(e: Entrada390): Declaracion390 {
  const errores: string[] = [];
  const advertencias: string[] = [];
  const id = e.identificacion;
  const nif = nifLimpio(id.nif);
  if (!nif) errores.push('Falta el NIF de la empresa. Rellénalo en Registro Mercantil > Datos para la memoria.');
  else if (!/^[0-9A-Z]{9}$/.test(nif)) errores.push(`El NIF de la empresa (${id.nif}) no tiene 9 caracteres.`);
  if (!textoAeat(id.razonSocial)) errores.push('Falta la razón social de la empresa. Rellénala en Registro Mercantil > Datos para la memoria.');
  if (e.ejercicio !== DISENO_390.ejercicio) {
    advertencias.push(`Se usa el diseño ${DISENO_390.version} del ejercicio ${DISENO_390.ejercicio}: la AEAT aún no ha publicado el del ${e.ejercicio}. Revísalo cuando salga.`);
  }

  // --- Página 01000: identificación ---
  const p1 = pag('01000');
  p1.texto(14, nif, false)
    .texto(23, id.razonSocial)
    .entero(103, e.ejercicio)
    .crudo(109, id.redeme ? '1' : '0') // registro de devolución mensual
    .crudo(110, '0') // régimen especial del grupo de entidades
    .crudo(118, '0')
    .crudo(119, '0')
    .crudo(120, '0') // art. 163 sexies: "0" (blanco) sin grupo
    .crudo(130, '2') // concurso de acreedores: No
    .crudo(131, id.criterioCaja ? '1' : '2')
    .crudo(132, '2') // destinatario del criterio de caja: No (no se registra)
    .texto(148, id.actividad ?? '')
    .texto(188, id.claveActividad ?? '')
    .texto(191, id.epigrafeIae ?? '')
    .crudo(430, id.presenta347 ? '1' : '0');
  if (!id.actividad) advertencias.push('Falta la actividad principal (página 1, apartado 3): complétala en la sede.');
  if (!id.claveActividad || !id.epigrafeIae) advertencias.push('Falta la clave de actividad y el epígrafe del IAE de la actividad principal (página 1): complétalos en la sede.');

  // --- Página 02000: IVA devengado ---
  const p2 = pag('02000');
  const rg = porTipos(p2, e.devengado, DEVENGADO, 'IVA devengado', errores);
  const ib = porTipos(p2, e.adquisicionesIntraBienes, INTRA_BIENES_DEV, 'Adquisiciones intracomunitarias de bienes', errores);
  const is = porTipos(p2, e.adquisicionesIntraServicios, INTRA_SERV_DEV, 'Adquisiciones intracomunitarias de servicios', errores);
  const base33 = rg.base + ib.base + is.base;
  const cuota34 = rg.cuota + ib.cuota + is.cuota;
  p2.importe('33', eur(base33)).importe('34', eur(cuota34));

  // --- Página 02B00: recargo de equivalencia (no aplica) y [47] ---
  const p2b = pag('02B00');
  p2b.importe('47', eur(cuota34));

  // --- Página 03000: deducible interior corriente e intracomunitario de bienes corrientes ---
  const p3 = pag('03000');
  const di = porTipos(p3, e.deducibleInterior, DED_INTERIOR, 'IVA deducible en operaciones interiores', errores);
  p3.importe('48', eur(di.base)).importe('49', eur(di.cuota));
  const dimp = porTipos(p3, e.importaciones ?? [], DED_IMPORT, 'IVA deducible en importaciones de bienes corrientes', errores);
  p3.importe('52', eur(dimp.base)).importe('53', eur(dimp.cuota));
  const dib = porTipos(p3, e.adquisicionesIntraBienes, DED_INTRA_BIENES, 'IVA deducible en adquisiciones intracomunitarias de bienes', errores);
  p3.importe('56', eur(dib.base)).importe('57', eur(dib.cuota));

  // --- Página 04000: intracomunitario de servicios, suma de deducciones y resultado ---
  const p4 = pag('04000');
  const dis = porTipos(p4, e.adquisicionesIntraServicios, DED_INTRA_SERV, 'IVA deducible en adquisiciones intracomunitarias de servicios', errores);
  p4.importe('597', eur(dis.base)).importe('598', eur(dis.cuota));
  const c64 = di.cuota + dimp.cuota + dib.cuota + dis.cuota; // [49]+[53]+[57]+[598] (el resto de sumandos va a cero)
  const c65 = cuota34 - c64; // [47] - [64]
  p4.importe('64', eur(c64)).importe('65', eur(c65));

  // --- Página 06000: resultado anual, territorio y volumen ---
  const liq = liquidaciones390(e.resultadosTrimestrales, e.compensarEjercicioAnterior ?? 0, e.ultimoPeriodo ?? 'compensar');
  const c85 = cent(liq.casilla85);
  const c86 = c65 - c85; // [84] - [659] - [85]
  const p6 = pag('06000');
  p6.importe(30, eur(c65)) // [84] = [65] (sin regularización del art. 80.Cinco.5ª)
    .importe(64, eur(c85))
    .importe(81, eur(c86))
    .entero(98, 10000) // [87] territorio común: 100,00 %
    .importe(140, eur(c65)) // [84] atribuible
    .importe(157, eur(c65)) // [92] = [84] x 100 %
    .importe(191, eur(c85)) // [93]
    .importe(208, eur(c86)) // [94] = [92] - [659] - [93]
    .importe(225, liq.casilla95)
    .importe(276, liq.casilla97)
    .importe(293, liq.casilla98)
    .importe(310, liq.casilla662);
  const v = e.volumen;
  const c108 = cent(v.regimenGeneral) + cent(v.intracomunitarias) + cent(v.exportacionesYExentasConDeduccion) + cent(v.exentasSinDeduccion) + cent(v.noSujetas) + cent(v.isp);
  p6.importe('99', v.regimenGeneral)
    .importe('103', v.intracomunitarias)
    .importe('104', v.exportacionesYExentasConDeduccion)
    .importe('105', v.exentasSinDeduccion)
    .importe('110', v.noSujetas)
    .importe('125', v.isp)
    .importe('108', eur(c108));

  // Comprobación de la AEAT: el resultado anual tiene que cuadrar con los 303.
  const cuadre = cent(liq.casilla95) - cent(liq.casilla97) - cent(liq.casilla98) - cent(liq.casilla662);
  if (cuadre !== c86) {
    advertencias.push(
      `El resultado de la liquidación [86] (${eur(c86).toFixed(2)} €) no cuadra con los 303 del año (a ingresar ${liq.casilla95.toFixed(2)} €, a compensar o devolver ${(liq.casilla97 + liq.casilla98 + liq.casilla662).toFixed(2)} €). Revisa los 303 presentados.`,
    );
  }
  if (liq.casilla98) advertencias.push('El último periodo sale a devolver: comprueba que en el 303 del 4T pediste la devolución.');

  // --- Página 07000: solo si hay IVA no deducible o exentas sin derecho a deducción ---
  const paginas: Array<[string, RegistroAeat]> = [
    ['01000', p1],
    ['02000', p2],
    ['02B00', p2b],
    ['03000', p3],
    ['04000', p4],
    ['06000', p6],
  ];
  const noDeducible = cent(e.baseNoDeducible ?? 0);
  const c105 = cent(v.exentasSinDeduccion);
  if (noDeducible !== 0 || c105 !== 0) {
    const p7 = pag('07000');
    p7.importe('232', eur(noDeducible));
    if (c105 !== 0) {
      const total = c108;
      const conDerecho = c108 - c105;
      p7.texto(200, id.actividad ?? '')
        .texto(240, String(id.cnae ?? '').replace(/\D/g, '').slice(0, 3))
        .importe(243, eur(total))
        .importe(260, eur(conDerecho))
        .crudo(277, 'G')
        .entero(278, total > 0 ? Math.min(100, Math.ceil((conDerecho / total) * 100)) * 100 : 0);
      advertencias.push('Hay operaciones exentas sin derecho a deducción: la página 7 lleva una prorrata general calculada con el volumen del año. Revísala con tu asesor.');
    }
    paginas.push(['07000', p7]);
  }

  const generadas: PaginaGenerada[] = paginas.map(([codigo, r]) => {
    const linea = r.toString();
    exigirDiseno(DISENO_390.paginas[codigo], linea);
    return { codigo, titulo: TITULOS_390[codigo], casillas: r.casillas(), linea };
  });
  const casillas = Object.assign({}, ...generadas.map((p) => p.casillas)) as Record<string, number | string>;

  // --- Cabecera <AUX> y cierre ---
  const ej = String(e.ejercicio).padStart(4, '0');
  const cab = new RegistroAeat({ hoja: 'DP39000', longitud: 328, campos: DISENO_390.cabecera.campos.filter((c) => c.pos && c.len) }, '390 cabecera');
  cab.crudo(7, ej)
    .texto(93, e.versionPrograma ?? '0001', false)
    .texto(101, nifLimpio(e.nifEmpresaDesarrollo ?? ''), false);
  const cierre = `</T3900${ej}0A0000>`;
  if (!e.nifEmpresaDesarrollo) advertencias.push('Falta el NIF de la empresa desarrolladora del programa (cabecera, posición 101). Si la sede lo pide, configura AEAT_NIF_DESARROLLADOR.');

  return {
    ejercicio: e.ejercicio,
    diseno: DISENO_390.version,
    revisar: DISENO_390.revisar,
    paginas: generadas,
    casillas,
    liquidaciones: liq,
    paginasNoGeneradas: [
      { codigo: '05000', motivo: 'Régimen simplificado y de la agricultura: una S.L. o S.A. no tributa en módulos.' },
      { codigo: '08000', motivo: 'Regímenes de deducción diferenciados (art. 101 LIVA): no se aplican.' },
      ...(paginas.some(([c]) => c === '07000') ? [] : [{ codigo: '07000', motivo: 'Sin IVA no deducible ni operaciones exentas sin derecho a deducción.' }]),
    ],
    advertencias,
    errores,
    fichero: cab.toString() + generadas.map((p) => p.linea).join('') + cierre,
  };
}
