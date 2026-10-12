/**
 * Modelo 200 (Impuesto sobre Sociedades) — BORRADOR con el diseño de registro
 * OFICIAL vers. 1.02 del ejercicio 2025 (DR200e25.xls, 77 hojas):
 * src/domain/aeat/dr200-2025.json (con las páginas que se generan aquí y el
 * índice de todas).
 *
 * Se generan las páginas que necesita una S.L./S.A. pyme que presenta el
 * balance y la PyG con el modelo PYMES: identificación y caracteres (01000),
 * tipo de modelo de cuentas (01B00), balance (03000-06000), PyG (07000-08000),
 * resultado contable y correcciones por el IS (12000), liquidación (14000 y
 * 14B00) e ingreso o devolución (DID00, la última). El resto de páginas del
 * diseño (administradores y socios, ECPN, detalle de correcciones, BINs por
 * año, reservas, deducciones, regímenes especiales...) no se generan: la
 * pantalla las enseña como pendientes y se completan en Sociedades WEB.
 *
 * Fichero = cabecera <AUX> (328) + páginas seguidas en el orden del diseño +
 * cierre de 18 "</T2000EEEE0A0000>". Discriminante "0" (normal, abreviado y PYMES).
 *
 * REVISAR cada año: el diseño de 2026 aún no está publicado (suele salir en
 * primavera del año siguiente) y los tipos de gravamen cambian cada año por la
 * Ley 7/2024 (DT 44.ª LIS).
 */
import { cabeceraAux, cierreAux, programaAeat, type ProgramaAeat } from '../common/cabeceraAux';
import dr200 from '../../domain/aeat/dr200-2025.json';
import type { BalanceSituacion, CuentaPerdidasGanancias } from '../../domain/impuesto-sociedades.model';
import { aCentimos, importeTexto } from '../../utils/money';
import { CampoOficial, exigirDiseno, PaginaOficial, RegistroAeat } from './diseno';
import { errorNifDeclarante, ibanAeat, nifAeat, telefonoAeat, textoAeat } from '../common/normalizacion';

interface Diseno200 {
  version: string;
  ejercicio: number;
  revisar: string;
  orden: string[];
  indice: Array<{ pagina: string; hoja: string; longitud: number }>;
  cabecera: { hoja: string; campos: CampoOficial[] };
  paginas: Record<string, PaginaOficial>;
}
export const DISENO_200 = dr200 as unknown as Diseno200;

export const TITULOS_200: Record<string, string> = {
  '01000': 'Página 1. Identificación y caracteres de la declaración',
  '01B00': 'Página 1 bis. Grupo, modelo de cuentas y plantilla',
  '03000': 'Página 3. Balance: activo (I)',
  '04000': 'Página 4. Balance: activo (II)',
  '05000': 'Página 5. Balance: patrimonio neto y pasivo (I)',
  '06000': 'Página 6. Balance: patrimonio neto y pasivo (II)',
  '07000': 'Página 7. Cuenta de pérdidas y ganancias (I)',
  '08000': 'Página 8. Cuenta de pérdidas y ganancias (II)',
  '12000': 'Página 12. Resultado contable y correcciones al resultado',
  '14000': 'Página 14. Liquidación: base imponible, tipo y cuota íntegra',
  '14B00': 'Página 14 bis. Liquidación: cuota líquida, pagos a cuenta y resultado',
  DID00: 'Ingreso o devolución',
};

/** Motivo de cada página del diseño que no se genera (lo que queda por completar). */
const PENDIENTES: Record<string, string> = {
  '02000': 'Relación de administradores, participaciones en la entidad (socios con un 5 % o más) y titular real: la app no guarda administradores ni socios.',
  '02B00': 'Participaciones de la entidad en otras sociedades: no se registran en la app.',
  '09000': 'Estado de ingresos y gastos reconocidos (ECPN, parte A).',
  '10000': 'Estado total de cambios en el patrimonio neto (ECPN, parte B).',
  '11000': 'Estado total de cambios en el patrimonio neto (ECPN, parte B, continuación).',
  '13000': 'Detalle de correcciones al resultado (gastos no deducibles, amortizaciones, deterioros...): la app no tiene ajustes extracontables.',
  '15000': 'Detalle de la compensación de bases imponibles negativas por año de origen.',
  '20B00': 'Reserva de capitalización (art. 25 LIS) y de nivelación (art. 105 LIS).',
  '20D00': 'Aplicación del resultado del ejercicio.',
};

const NO_APLICA = 'No aplica a una S.L. o S.A. pyme sin regímenes especiales (deducciones especiales, Canarias o Baleares, cooperativas, fusiones, entidades financieras...).';

export interface Entrada200 {
  ejercicio: number;
  /**
   * Autoliquidación rectificativa de la presentada (B4): justificante de la
   * anterior (13 cifras), lo ya ingresado con ella ([01578]) y la devolución
   * que la AEAT ya acordó ([01584]).
   */
  rectificativa?: { justificanteAnterior: string; resultadoAnterior?: number; devolucionAcordada?: number } | null;
  identificacion: {
    nif: string;
    razonSocial: string;
    cnae?: string | null;
    telefono?: string | null;
    email?: string | null;
    contacto?: string | null;
    /** Periodo impositivo (AAAA-MM-DD). */
    fechaInicio: string;
    fechaFin: string;
    fechaConstitucion?: string | null;
  };
  balance: BalanceSituacion;
  pyg: CuentaPerdidasGanancias;
  /** Saldo de la reserva legal (112) para separar "legal y estatutarias" del resto de reservas. */
  reservaLegal?: number;
  /** Importe neto de la cifra de negocios del ejercicio anterior (tipo de gravamen y caracteres). */
  incnAnterior?: number | null;
  /** Plantilla media del ejercicio. */
  plantilla?: { fijo: number; noFijo: number } | null;
  /** Bases imponibles negativas de ejercicios anteriores pendientes de compensar. */
  binsPendientes?: number;
  /** Primer periodo con base positiva o el siguiente (art. 29.1 LIS, 15 %). */
  nuevaCreacion?: boolean;
  /** Pagos fraccionados (modelo 202) de abril, octubre y diciembre. */
  pagosFraccionados?: [number, number, number];
  /** Retenciones e ingresos a cuenta soportados. */
  retenciones?: number;
  /** IBAN de la empresa (devolución). */
  iban?: string | null;
  /** Version y NIF de la entidad desarrolladora (cabecera <AUX>); por defecto, los de la app. */
  programa?: ProgramaAeat;
}

export interface TipoGravamen200 {
  /** Casilla [00558]: "AABB" (tipo único "2500"; doble "2122"). */
  codigo: string;
  tramos: Array<{ hasta: number | null; tipo: number }>;
  clave: 'general' | 'micro' | 'reducida' | 'nueva';
  descripcion: string;
}

/**
 * Tipo de gravamen del ejercicio (art. 29.1 y DT 44.ª LIS, redacción de la Ley
 * 7/2024). INCN del periodo anterior < 1 M€: tipo doble (primeros 50.000 € y
 * resto); < 10 M€ (entidad de reducida dimensión): tipo reducido; resto, 25 %.
 * REVISAR cada año.
 */
export function tipoGravamen200(ejercicio: number, incnAnterior: number | null | undefined, nuevaCreacion = false): TipoGravamen200 {
  const incn = Number(incnAnterior ?? Number.POSITIVE_INFINITY);
  const micro: Record<number, [number, number]> = { 2025: [21, 22], 2026: [19, 21] };
  const reducida: Record<number, number> = { 2025: 24, 2026: 23, 2027: 22, 2028: 21 };
  if (incn < 1_000_000) {
    const [a, b] = micro[ejercicio] ?? (ejercicio < 2025 ? [23, 23] : [17, 20]);
    if (nuevaCreacion && a > 15) {
      return { codigo: '1500', tramos: [{ hasta: null, tipo: 15 }], clave: 'nueva', descripcion: 'Entidad de nueva creación (art. 29.1 LIS): 15 %.' };
    }
    if (a === b) return { codigo: `${a}00`, tramos: [{ hasta: null, tipo: a }], clave: 'micro', descripcion: `INCN del año anterior inferior a 1 millón: ${a} %.` };
    return {
      codigo: `${a}${b}`,
      tramos: [
        { hasta: 50_000, tipo: a },
        { hasta: null, tipo: b },
      ],
      clave: 'micro',
      descripcion: `INCN del año anterior inferior a 1 millón: ${a} % hasta 50.000 € y ${b} % el resto.`,
    };
  }
  if (nuevaCreacion) return { codigo: '1500', tramos: [{ hasta: null, tipo: 15 }], clave: 'nueva', descripcion: 'Entidad de nueva creación (art. 29.1 LIS): 15 %.' };
  if (incn < 10_000_000 && ejercicio >= 2025) {
    const t = reducida[ejercicio] ?? 20;
    return { codigo: `${t}00`, tramos: [{ hasta: null, tipo: t }], clave: 'reducida', descripcion: `Entidad de reducida dimensión (INCN del año anterior inferior a 10 millones): ${t} %.` };
  }
  return { codigo: '2500', tramos: [{ hasta: null, tipo: 25 }], clave: 'general', descripcion: 'Tipo general: 25 %.' };
}

/** Cuota íntegra en céntimos aplicando los tramos a una base positiva (en céntimos). */
function cuotaPorTramos(baseCent: number, tg: TipoGravamen200): number {
  let resto = Math.max(0, baseCent);
  let desde = 0;
  let cuota = 0;
  for (const t of tg.tramos) {
    const tope = t.hasta === null ? resto : Math.min(resto, aCentimos(t.hasta) - desde);
    cuota += Math.round((tope * t.tipo) / 100);
    resto -= tope;
    desde += tope;
    if (resto <= 0) break;
  }
  return cuota;
}

export interface Declaracion200 {
  ejercicio: number;
  diseno: string;
  revisar: string;
  paginas: Array<{ codigo: string; titulo: string; casillas: Record<string, number | string>; linea: string }>;
  casillas: Record<string, number | string>;
  liquidacion: {
    resultadoContable: number; // [00500]
    resultadoAntesImpuestos: number; // [00501]
    basePrevia: number; // [00550]
    compensacionBins: number; // [00547]
    baseImponible: number; // [00552]
    tipo: TipoGravamen200;
    cuotaIntegra: number; // [00562]
    cuotaLiquida: number; // [00592]
    retenciones: number; // [01766]
    pagosFraccionados: number; // [00601]+[00603]+[00605]
    cuotaDiferencial: number; // [00611]
    resultado: number; // [00621]
    /** Rectificativa: lo ingresado con la anterior [01578], la devolución acordada [01584] y lo que se devuelve por la rectificación [00866]. */
    resultadoAnterior: number;
    devolucionAcordada: number;
    rectificacion: number;
    tipoDeclaracion: 'I' | 'N' | 'D';
    binsGeneradas: number;
  };
  paginasPendientes: Array<{ codigo: string; motivo: string }>;
  advertencias: string[];
  errores: string[];
  fichero: string;
}

const pag = (c: string) => new RegistroAeat(DISENO_200.paginas[c], `200 ${c}`);

const imp = (lista: Array<{ codigo?: string; importe: number }>, codigo: string) => lista.find((p) => p.codigo === codigo)?.importe ?? 0;

/** Partida del balance PYMES -> casilla del 200. */
const BALANCE_CASILLAS: Array<[string, string]> = [
  ['A.I', '00102'], ['A.II', '00111'], ['A.III', '00115'], ['A.IV', '00118'], ['A.V', '00126'], ['A.VI', '00134'],
  ['B.I', '00137'], ['B.II', '00138'], ['B.III.1', '00150'], ['B.III.2', '00158'], ['B.III.3', '00159'], ['B.IV', '00160'],
  ['B.V', '00168'], ['B.VI', '00176'], ['B.VII', '00177'],
  ['A1.I', '00187'], ['A1.II', '00190'], ['A1.III', '00191'], ['A1.IV', '00194'], ['A1.V', '00195'], ['A1.VI', '00198'],
  ['A1.VII', '00199'], ['A1.VIII', '00200'], ['A2', '00209'],
  ['C.I', '00211'], ['C.II', '00216'], ['C.III', '00223'], ['C.IV', '00224'], ['C.V', '00225'],
  ['D.I', '00230'], ['D.II', '00231'], ['D.III', '00238'], ['D.IV.1', '00240'], ['D.IV.2', '00249'], ['D.V', '00250'],
];

/** Partida de la PyG PYMES -> casilla del 200 (importes con su signo: gastos en negativo). */
const PYG_CASILLAS: Array<[string, string]> = [
  ['1', '00255'], ['2', '00258'], ['3', '00259'], ['4', '00260'], ['5', '00265'], ['6', '00270'], ['7', '00279'], ['8', '00284'],
  ['9', '00285'], ['10', '00286'], ['11', '00287'], ['12', '00295'], ['13', '00297'], ['14', '00305'], ['15', '00309'],
  ['16', '00312'], ['17', '00313'], ['18', '00326'],
];

const fechaPartes = (f: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f);
  if (!m) throw new Error(`Fecha no válida: ${f}`);
  return { a: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
};

export function construirModelo200(e: Entrada200): Declaracion200 {
  const errores: string[] = [];
  const advertencias: string[] = [];
  const id = e.identificacion;
  const nif = nifAeat(id.nif);
  const errorNif = errorNifDeclarante(id.nif);
  if (errorNif) errores.push(errorNif);
  if (!textoAeat(id.razonSocial)) errores.push('Falta la razón social de la empresa. Rellénala en Registro Mercantil > Datos para la memoria.');
  if (e.ejercicio !== DISENO_200.ejercicio) {
    advertencias.push(`Se usa el diseño ${DISENO_200.version} del ejercicio ${DISENO_200.ejercicio}: la AEAT aún no ha publicado el del ${e.ejercicio}. Revísalo cuando salga.`);
  }
  const cnae = String(id.cnae ?? '').replace(/\D/g, '').slice(0, 4);
  if (cnae.length !== 4) advertencias.push('Falta el código CNAE-2025 de 4 cifras de la actividad principal (página 1): complétalo en Registro Mercantil o en Sociedades WEB.');

  const b = e.balance;
  const p = e.pyg;
  const c = aCentimos;
  const eur = (n: number) => n / 100;

  // --- Liquidación (en céntimos) ---
  const c500 = c(p.resultadoEjercicio);
  const imp18 = c(imp(p.partidas ?? [], '18')); // impuesto sobre beneficios con su signo (gasto en negativo)
  const c301 = Math.max(0, -imp18);
  const c302 = Math.max(0, imp18);
  const c501 = c500 + c301 - c302;
  const c550 = c501; // sin detalle de correcciones (página 13)
  // Sin la cifra de negocios del año anterior no se sabe el tipo de gravamen ni
  // los caracteres de la página 1: no se supone el 25 %, se pide (y no hay fichero).
  // Mientras falta, la pantalla enseña la cuota al tipo general, marcada como provisional.
  const sinIncn = e.incnAnterior === null || e.incnAnterior === undefined;
  const tgCalculado = tipoGravamen200(e.ejercicio, e.incnAnterior, e.nuevaCreacion);
  const tg: TipoGravamen200 =
    sinIncn && tgCalculado.clave !== 'nueva'
      ? { ...tgCalculado, descripcion: `Provisional: falta la cifra de negocios de ${e.ejercicio - 1}. Hasta que la indiques, la cuota se calcula al 25 %.` }
      : tgCalculado;
  const bins = c(Math.max(0, e.binsPendientes ?? 0));
  // Límite del art. 26 LIS: el 70 % de la base previa, y siempre hasta 1 millón (sin límite en entidades de nueva creación).
  const limite = e.nuevaCreacion ? Math.max(0, c550) : Math.max(0, Math.min(c550, Math.max(c(1_000_000), Math.round(c550 * 0.7))));
  const c547 = Math.min(bins, limite);
  const c552 = c550 - c547;
  const c562 = cuotaPorTramos(c552, tg);
  const c582 = c562; // sin bonificaciones
  const c592 = c582; // sin deducciones
  const ret = c(Math.max(0, e.retenciones ?? 0));
  const pf = (e.pagosFraccionados ?? [0, 0, 0]).map((v) => c(Math.max(0, v)));
  const c599 = c592 - ret;
  const c611 = c599 - pf[0] - pf[1] - pf[2];
  const c1586 = c611;
  // Rectificativa (manual de Sociedades, «Cumplimentación del modelo 200:
  // casillas 01578 y 01584»): [00621] = [01586] - [01578] + [01584]. [01578] es
  // lo que se ingresó con la anterior y [01584], la devolución que la AEAT ya
  // hizo (0 si no se ha acordado). Si [00621] sale negativo, la parte que
  // corresponde a lo ingresado antes va en [00866] (lo devuelve la AEAT por la
  // rectificación) y el tipo de declaración se decide sin ella, como en el 303.
  const rect = e.rectificativa ?? null;
  const c1578 = rect ? c(Math.max(0, rect.resultadoAnterior ?? 0)) : 0;
  const c1584 = rect ? c(Math.max(0, rect.devolucionAcordada ?? 0)) : 0;
  const c621 = c1586 - c1578 + c1584;
  const c866 = rect && c1578 > 0 && c621 < 0 ? Math.min(-c621, c1578) : 0;
  const cTipo = c621 + c866;
  const tipoDeclaracion: 'I' | 'N' | 'D' = cTipo > 0 ? 'I' : cTipo < 0 ? 'D' : 'N';

  if (bins === 0) advertencias.push('No se han indicado bases imponibles negativas de ejercicios anteriores: si las hay, indícalas para compensarlas ([00547]) y completa la página 15 en Sociedades WEB.');
  if (ret === 0 && pf.every((x) => x === 0)) advertencias.push('No se han indicado retenciones ni pagos fraccionados (modelo 202): si los hubo, indícalos ([01766], [00601], [00603] y [00605]).');
  if (sinIncn) {
    errores.push(
      `No consta la cifra de negocios de ${e.ejercicio - 1}, y de ella dependen el tipo de gravamen y los datos de la página 1. Escríbela en «Cifra de negocios de ${e.ejercicio - 1}», en esta misma pantalla, o importa la cuenta de resultados de ${e.ejercicio - 1} en Contabilidad > Puesta en marcha > Años anteriores.`,
    );
  } else {
    advertencias.push(`Tipo de gravamen: ${tg.descripcion} Revísalo cada año (Ley 7/2024).`);
  }
  if (c550 < 0) advertencias.push(`La base imponible sale negativa (${importeTexto(eur(c550))}): queda pendiente de compensar en los próximos ejercicios.`);
  if (id.fechaConstitucion && Number(id.fechaConstitucion.slice(0, 4)) >= e.ejercicio - 2 && !e.nuevaCreacion) {
    advertencias.push('La sociedad es de constitución reciente: comprueba si le toca el tipo del 15 % de las entidades de nueva creación.');
  }

  // --- Página 01000: identificación y caracteres ---
  const ini = fechaPartes(id.fechaInicio);
  const fin = fechaPartes(id.fechaFin);
  const anoNatural = id.fechaInicio.endsWith('-01-01') && id.fechaFin.endsWith('-12-31') && ini.a === fin.a;
  const incn = e.incnAnterior ?? null;
  const p1 = pag('01000');
  if (e.rectificativa) {
    // Marca de rectificativa, justificante de la anterior y motivo «Rectificaciones».
    if (!/^\d{13}$/.test(e.rectificativa.justificanteAnterior)) errores.push('La autoliquidación rectificativa del 200 necesita el número de justificante de la anterior (13 cifras).');
    else p1.crudo(149, '1').crudo(150, e.rectificativa.justificanteAnterior).crudo(163, '1');
    const txt = (n: number) => importeTexto(eur(n)).replace(' €', '');
    advertencias.push(
      c866 > 0
        ? `Autoliquidación rectificativa: con la anterior se ingresaron ${txt(c1578)} € ([01578]). Ahora sale ${txt(c621)} € ([00621]): la AEAT devuelve ${txt(c866)} € por la rectificación ([00866]) a la cuenta de la empresa. Revísalo en Sociedades WEB antes de presentarla.`
        : `Autoliquidación rectificativa: con la anterior se ingresaron ${txt(c1578)} € ([01578])${c1584 ? ` y la AEAT ya devolvió ${txt(c1584)} € ([01584])` : ''}. Ahora solo se ingresa la diferencia, ${txt(Math.max(0, c621))} € ([00621]). Revísalo en Sociedades WEB antes de presentarla.`,
    );
  }
  p1.crudo(13, tipoDeclaracion)
    .texto(14, nif, false)
    .texto(23, id.razonSocial)
    .entero(103, e.ejercicio)
    .entero(109, ini.a)
    .entero(113, ini.m)
    .entero(115, ini.d)
    .entero(117, fin.a)
    .entero(121, fin.m)
    .entero(123, fin.d)
    .entero(125, anoNatural ? 1 : 2) // TODO confirmar la tabla de "tipo de ejercicio" en la ayuda de Sociedades WEB
    .crudo(126, cnae.length === 4 ? cnae : '0000')
    .texto(131, telefonoAeat(id.telefono), false);
  if (incn !== null && incn < 10_000_000) p1.crudo(193, '1'); // [00006] incentivos de reducida dimensión
  if (c552 <= 0) p1.crudo(219, '1'); // [00027] base imponible negativa o cero
  if (tg.clave === 'micro') p1.crudo(227, '1'); // [00088] INCN del año anterior < 1 M€
  if (tg.clave === 'nueva') p1.crudo(226, '1'); // [00071] nueva creación (art. 29.1 LIS)
  if (incn === null || incn < 20_000_000) p1.crudo(241, '1');
  else if (incn < 60_000_000) p1.crudo(242, '1');
  else p1.crudo(243, '1');
  if (id.contacto) p1.texto(285, id.contacto);
  const tel = telefonoAeat(id.telefono);
  if (tel) p1.crudo(tel.startsWith('6') || tel.startsWith('7') ? 344 : 335, tel.padStart(9, '0'));
  const email = String(id.email ?? '').trim().replace(/[^A-Za-z0-9@._-]/g, '').slice(0, 50);
  if (email) p1.crudo(353, email.padEnd(50, ' '));

  // --- Página 01B00: modelo de cuentas (PYMES) y plantilla ---
  const p1b = pag('01B00');
  p1b.crudo(156, '3') // balance: modelo PYMES
    .crudo(157, '0') // ECPN: no consta (páginas 9-11 pendientes)
    .crudo(158, '3'); // PyG: modelo PYMES
  if (e.plantilla) p1b.importe('00041', e.plantilla.fijo).importe('00042', e.plantilla.noFijo);
  else advertencias.push('Falta la plantilla media del ejercicio (personal fijo [00041] y no fijo [00042], página 1 bis).');

  // --- Balance: páginas 03000 a 06000 ---
  const partidas = [...b.activoNoCorriente, ...b.activoCorriente, ...b.patrimonioNeto, ...b.pasivoNoCorriente, ...b.pasivoCorriente];
  const suma = (l: Array<{ importe: number }>) => l.reduce((a, x) => a + c(x.importe), 0);
  const p3 = pag('03000');
  const p4 = pag('04000');
  const p5 = pag('05000');
  const p6 = pag('06000');
  const destino = (casilla: string) => [p3, p4, p5, p6].find((r) => {
    try {
      r.campo(casilla);
      return true;
    } catch {
      return false;
    }
  })!;
  for (const [partida, casilla] of BALANCE_CASILLAS) {
    const v = imp(partidas, partida);
    if (v !== 0) destino(casilla).importe(casilla, v);
  }
  const b3 = c(imp(partidas, 'B.III.1')) + c(imp(partidas, 'B.III.2')) + c(imp(partidas, 'B.III.3'));
  const d4 = c(imp(partidas, 'D.IV.1')) + c(imp(partidas, 'D.IV.2'));
  const fondosPropios = suma(b.patrimonioNeto.filter((x) => (x.codigo ?? '').startsWith('A1')));
  const reservaLegal = c(e.reservaLegal ?? 0);
  const reservas = c(imp(partidas, 'A1.III'));
  const anteriores = c(imp(partidas, 'A1.V'));
  p3.importe('00101', eur(suma(b.activoNoCorriente))).importe('00136', eur(suma(b.activoCorriente)));
  p4.importe('00149', eur(b3)).importe('00180', b.totalActivo);
  p5.importe('00185', eur(suma(b.patrimonioNeto)))
    .importe('00186', eur(fondosPropios))
    .importe('00188', imp(partidas, 'A1.I')) // capital escriturado (sin capital no exigido)
    .importe('00192', eur(reservaLegal))
    .importe('00193', eur(reservas - reservaLegal))
    .importe(anteriores >= 0 ? '00196' : '00197', eur(anteriores))
    .importe('00210', eur(suma(b.pasivoNoCorriente)));
  p6.importe('00228', eur(suma(b.pasivoCorriente))).importe('00239', eur(d4)).importe('00252', b.totalPatrimonioNetoYPasivo);
  if (c(b.descuadre ?? 0) !== 0) errores.push(`El balance no cuadra (diferencia ${importeTexto(Number(b.descuadre))}): revisa los asientos antes de generar el 200.`);

  // --- PyG: páginas 07000 y 08000 ---
  const p7 = pag('07000');
  const p8 = pag('08000');
  for (const [partida, casilla] of PYG_CASILLAS) {
    const v = imp(p.partidas ?? [], partida);
    if (v !== 0) (Number(casilla) <= 296 ? p7 : p8).importe(casilla, v);
  }
  p7.importe('00296', p.resultadoExplotacion);
  p8.importe('00324', p.resultadoFinanciero)
    .importe('00325', p.resultadoAntesImpuestos)
    .importe('00327', p.resultadoEjercicio)
    .importe('00500', p.resultadoEjercicio);

  // --- Página 12000: resultado contable y corrección por el IS ---
  const p12 = pag('12000');
  p12.importe('00500', eur(c500)).importe('00301', eur(c301)).importe('00302', eur(c302)).importe('00501', eur(c501));

  // --- Página 14000: base imponible, tipo y cuota íntegra ---
  const p14 = pag('14000');
  p14.importe('00550', eur(c550))
    .importe('00547', eur(c547))
    .importe('00552', eur(c552))
    .importe('01330', eur(c552))
    .entero('00558', Number(tg.codigo))
    .importe('00562', eur(c562))
    .importe('00582', eur(c582));

  // --- Página 14B00: cuota líquida, pagos a cuenta y resultado ---
  const p14b = pag('14B00');
  p14b.importe('00592', eur(c592))
    .importe('01798', eur(ret)) // retenciones no incluidas en las casillas anteriores (sin desglose por tipo de renta)
    .importe('01766', eur(ret))
    .importe('00599', eur(c599))
    .importe('00601', eur(pf[0]))
    .importe('00603', eur(pf[1]))
    .importe('00605', eur(pf[2]))
    .importe('00611', eur(c611))
    .importe('01586', eur(c1586))
    .importe('00621', eur(c621));
  if (rect) p14b.importe('01578', eur(c1578)).importe('01584', eur(c1584)).importe('00866', eur(c866));

  // --- DID00: ingreso o devolución (la última página) ---
  const did = pag('DID00');
  const aa = (n: number) => String(n % 100).padStart(2, '0');
  const dd = (n: number) => String(n).padStart(2, '0');
  did.crudo(13, '0')
    .entero(14, e.ejercicio)
    .entero(18, anoNatural ? 1 : 2)
    .crudo(21, dd(ini.d))
    .crudo(23, dd(ini.m))
    .crudo(25, aa(ini.a))
    .crudo(27, dd(fin.d))
    .crudo(29, dd(fin.m))
    .crudo(31, aa(fin.a))
    .texto(33, nif, false)
    .texto(42, id.razonSocial)
    .importe(122, eur(c552))
    .importe(139, eur(c562))
    .importe(156, eur(c1586))
    .importe(173, eur(c621));
  const iban = ibanAeat(e.iban) ?? '';
  const conCuenta = tipoDeclaracion === 'D' || c866 > 0;
  if (tipoDeclaracion === 'D') did.crudo(207, 'D').importe(208, eur(-cTipo));
  // Rectificativa: lo que se devuelve por la rectificación, por transferencia (campo 25).
  if (c866 > 0) did.importe(225, eur(c866));
  if (conCuenta) {
    if (iban) did.crudo(242, iban.startsWith('ES') ? '1' : '2').texto(243, iban, false);
    else advertencias.push('Sale a devolver y falta un IBAN válido de la empresa (Tesorería > Cuentas bancarias).');
  }
  if (tipoDeclaracion === 'I') did.crudo(425, 'I').importe(426, eur(c621));
  else if (tipoDeclaracion === 'N' && c866 === 0) did.crudo(562, '1');

  const orden: Array<[string, RegistroAeat]> = [
    ['01000', p1], ['01B00', p1b], ['03000', p3], ['04000', p4], ['05000', p5], ['06000', p6],
    ['07000', p7], ['08000', p8], ['12000', p12], ['14000', p14], ['14B00', p14b], ['DID00', did],
  ];
  const paginas = orden.map(([codigo, r]) => {
    const linea = r.toString();
    exigirDiseno(DISENO_200.paginas[codigo], linea);
    return { codigo, titulo: TITULOS_200[codigo], casillas: r.casillas(), linea };
  });
  const casillas = Object.assign({}, ...paginas.map((x) => x.casillas)) as Record<string, number | string>;

  // Cabecera <AUX> y cierre comunes (aeat/common/cabeceraAux).
  const cabecera = cabeceraAux('200', e.ejercicio, '0A', e.programa ?? programaAeat());
  const cierre = cierreAux('200', e.ejercicio, '0A');

  const generadas = new Set(orden.map(([x]) => x));
  const paginasPendientes = DISENO_200.indice
    .filter((x) => !generadas.has(x.pagina))
    .map((x) => ({ codigo: x.pagina, motivo: PENDIENTES[x.pagina] ?? NO_APLICA }));

  return {
    ejercicio: e.ejercicio,
    diseno: DISENO_200.version,
    revisar: DISENO_200.revisar,
    paginas,
    casillas,
    liquidacion: {
      resultadoContable: eur(c500),
      resultadoAntesImpuestos: eur(c501),
      basePrevia: eur(c550),
      compensacionBins: eur(c547),
      baseImponible: eur(c552),
      tipo: tg,
      cuotaIntegra: eur(c562),
      cuotaLiquida: eur(c592),
      retenciones: eur(ret),
      pagosFraccionados: eur(pf[0] + pf[1] + pf[2]),
      cuotaDiferencial: eur(c611),
      resultado: eur(c621),
      resultadoAnterior: eur(c1578),
      devolucionAcordada: eur(c1584),
      rectificacion: eur(c866),
      tipoDeclaracion,
      binsGeneradas: c552 < 0 ? eur(-c552) : 0,
    },
    paginasPendientes,
    advertencias,
    errores,
    fichero: cabecera + paginas.map((x) => x.linea).join('') + cierre,
  };
}
