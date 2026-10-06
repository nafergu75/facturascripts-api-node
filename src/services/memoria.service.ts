// Memoria de las cuentas anuales (modelo PYMES, PGC tras el RD 602/2016).
//
// Lo que sale de la contabilidad se calcula (inmovilizado, activos y pasivos
// financieros, fondos propios, situacion fiscal, ingresos y gastos,
// subvenciones). Lo que no esta en los asientos (actividad, plantilla media,
// partes vinculadas, hechos posteriores...) sale de los datos de la empresa y
// de las notas del ejercicio; si falta, se marca como PENDIENTE y se lista en
// `pendientes`. Nunca se inventa un dato.
import type { AsientoSimple, SaldosEjercicio } from './contabilidadDatos.service';
import type { CuentasAnualesRM } from '../domain/cuentas-anuales.model';
import { PGC_BASE } from '../domain/pgc-model';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface DatosSociedad {
  denominacion?: string | null;
  nif?: string | null;
  formaJuridica?: string | null;
  domicilioSocial?: string | null;
  codigoPostal?: string | null;
  municipio?: string | null;
  provincia?: string | null;
  actividad?: string | null;
  cnae?: string | null;
  datosRegistrales?: string | null;
  registroMercantilProvincia?: string | null;
  fechaConstitucion?: string | null;
}

/** Notas del ejercicio que el contable completa (FiscalYear.memoriaNotas). */
export interface NotasMemoria {
  plantillaMedia?: number | null;
  plantillaMediaHombres?: number | null;
  plantillaMediaMujeres?: number | null;
  periodoMedioPago?: number | null;
  partesVinculadas?: string | null;
  remuneracionAdministradores?: string | null;
  hechosPosteriores?: string | null;
  otraInformacion?: string | null;
  /** Texto propio para una nota entera, por numero ('2', '3'...): sustituye al automatico. */
  textos?: Record<string, string>;
}

export interface TablaMemoria {
  cabeceras: string[];
  filas: Array<{ texto: string; valores: number[]; total?: boolean }>;
}

export interface NotaMemoria {
  numero: string;
  titulo: string;
  parrafos: string[];
  tablas: TablaMemoria[];
}

export interface Memoria {
  notas: NotaMemoria[];
  /** Datos que faltan para que la memoria este completa. */
  pendientes: string[];
}

export interface EntradaMemoria {
  ejercicio: number;
  cuentas: CuentasAnualesRM;
  sociedad: DatosSociedad;
  notas: NotasMemoria;
  saldos: SaldosEjercicio;
  saldosAnterior: SaldosEjercicio;
  /** Asientos normales del ejercicio. */
  asientos: AsientoSimple[];
}

export const PENDIENTE = '[PENDIENTE]';

function nombreCuenta(codigo: string): string {
  for (const largo of [4, 3, 2]) {
    const n = PGC_BASE.find((x) => x.code === codigo.slice(0, largo));
    if (n) return n.name;
  }
  return `Cuenta ${codigo}`;
}

/** Suma de saldos deudores de las cuentas que empiezan por algun prefijo. */
function deudor(saldos: Map<string, number>, prefijos: string[], excluir: string[] = []): number {
  let t = 0;
  for (const [c, v] of saldos) {
    if (prefijos.some((p) => c.startsWith(p)) && !excluir.some((p) => c.startsWith(p))) t += v;
  }
  return round2(t);
}

/** Debe y haber del ejercicio en las cuentas de un prefijo. */
function movimientos(asientos: AsientoSimple[], prefijos: string[]): { debe: number; haber: number } {
  let debe = 0;
  let haber = 0;
  for (const a of asientos) {
    for (const l of a.lineas) {
      if (prefijos.some((p) => l.subcuenta.startsWith(p))) {
        debe += l.debe;
        haber += l.haber;
      }
    }
  }
  return { debe: round2(debe), haber: round2(haber) };
}

const fmtFecha = (iso: string) => {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

export function generarMemoria(e: EntradaMemoria): Memoria {
  const pendientes: string[] = [];
  const falta = (dato: string) => {
    if (!pendientes.includes(dato)) pendientes.push(dato);
    return `${PENDIENTE} ${dato}`;
  };
  const s = e.sociedad;
  const n = e.ejercicio;
  const cab = [String(n), String(n - 1)];
  const notas: NotaMemoria[] = [];
  const nota = (numero: string, titulo: string, parrafos: string[], tablas: TablaMemoria[] = []) => {
    const propio = e.notas.textos?.[numero]?.trim();
    notas.push({ numero, titulo, parrafos: propio ? propio.split(/\n{2,}/) : parrafos, tablas: propio ? [] : tablas });
  };

  // 1. Actividad
  const domicilio = s.domicilioSocial
    ? [s.domicilioSocial, [s.codigoPostal, s.municipio].filter(Boolean).join(' '), s.provincia ? `(${s.provincia})` : '']
        .filter(Boolean)
        .join(', ')
    : falta('domicilio social');
  nota('1', 'Actividad de la empresa', [
    `${s.denominacion || falta('denominación social')}, ${s.formaJuridica ? s.formaJuridica.toLowerCase() : falta('forma jurídica')} con NIF ${
      s.nif || falta('NIF')
    }, se constituyó el ${s.fechaConstitucion ? fmtFecha(s.fechaConstitucion) : falta('fecha de constitución')} y tiene su domicilio social en ${domicilio}.`,
    `Su actividad principal es ${s.actividad || falta('actividad principal')}${s.cnae ? ` (CNAE ${s.cnae})` : ''}.`,
    `Figura inscrita en el Registro Mercantil de ${s.registroMercantilProvincia || falta('provincia del Registro Mercantil')}, ${
      s.datosRegistrales || falta('datos registrales (tomo, folio, hoja)')
    }.`,
    'La moneda funcional de la sociedad es el euro.',
  ]);

  // 2. Bases de presentacion
  nota('2', 'Bases de presentación de las cuentas anuales', [
    'Imagen fiel. Las cuentas anuales se han preparado a partir de los registros contables de la sociedad y se presentan según el Plan General de Contabilidad de Pequeñas y Medianas Empresas (RD 1515/2007 y sus modificaciones posteriores), de forma que muestran la imagen fiel del patrimonio, de la situación financiera y de los resultados.',
    'Principios contables. No se han aplicado principios contables no obligatorios.',
    'Aspectos críticos de la valoración y estimación de la incertidumbre. No se conocen incertidumbres importantes que puedan suponer cambios significativos en el valor de los activos y pasivos en el ejercicio siguiente.',
    `Comparación de la información. Las cifras se presentan junto con las del ejercicio ${n - 1}.`,
    'Cambios en criterios contables y corrección de errores. No se han producido.',
  ]);

  // 3. Normas de registro y valoracion
  nota('3', 'Normas de registro y valoración', [
    'Inmovilizado intangible y material. Se valoran por su coste de adquisición o producción, menos la amortización acumulada y las pérdidas por deterioro. La amortización se calcula de forma lineal según la vida útil estimada de los bienes.',
    'Activos financieros. Los créditos por operaciones comerciales y el efectivo se valoran a coste amortizado; los créditos con vencimiento inferior a un año, por su valor nominal.',
    'Pasivos financieros. Los débitos por operaciones comerciales y las deudas se valoran a coste amortizado; los de vencimiento inferior a un año, por su valor nominal.',
    'Impuesto sobre beneficios. El gasto por impuesto corriente es el importe a pagar por la liquidación fiscal del ejercicio.',
    'Ingresos y gastos. Se imputan según el principio de devengo, con independencia del momento del cobro o del pago. Los ingresos por ventas y prestaciones de servicios se registran por el valor razonable de la contraprestación, sin IVA.',
  ]);

  // 4. Inmovilizado
  const grupos: Array<{ titulo: string; coste: string[]; amort: string[] }> = [
    { titulo: 'Inmovilizado intangible', coste: ['20'], amort: ['280', '290'] },
    { titulo: 'Inmovilizado material', coste: ['21', '23'], amort: ['281', '291'] },
    { titulo: 'Inversiones inmobiliarias', coste: ['22'], amort: ['282', '292'] },
  ];
  const tablasInm: TablaMemoria[] = [];
  for (const g of grupos) {
    const ini = deudor(e.saldosAnterior.balance, g.coste);
    const fin = deudor(e.saldos.balance, g.coste);
    const mov = movimientos(e.asientos, g.coste);
    const aIni = -deudor(e.saldosAnterior.balance, g.amort);
    const aFin = -deudor(e.saldos.balance, g.amort);
    const aMov = movimientos(e.asientos, g.amort);
    if ([ini, fin, mov.debe, mov.haber, aIni, aFin].every((v) => v === 0)) continue;
    tablasInm.push({
      cabeceras: [g.titulo, String(n)],
      filas: [
        { texto: 'Coste: saldo inicial', valores: [ini] },
        { texto: '(+) Entradas', valores: [mov.debe] },
        { texto: '(-) Salidas y bajas', valores: [-mov.haber] },
        { texto: 'Coste: saldo final', valores: [fin], total: true },
        { texto: 'Amortización y deterioro acumulados: saldo inicial', valores: [aIni] },
        { texto: '(+) Dotaciones', valores: [aMov.haber] },
        { texto: '(-) Bajas', valores: [-aMov.debe] },
        { texto: 'Amortización y deterioro acumulados: saldo final', valores: [aFin], total: true },
        { texto: 'Valor neto contable', valores: [round2(fin - aFin)], total: true },
      ],
    });
  }
  nota(
    '4',
    'Inmovilizado material, intangible e inversiones inmobiliarias',
    tablasInm.length ? ['Movimiento del ejercicio:'] : ['La sociedad no tiene inmovilizado registrado en la contabilidad.'],
    tablasInm,
  );

  // 5. Activos financieros (sin saldos con Administraciones Publicas, que no son instrumentos financieros)
  const af = (sal: Map<string, number>) => ({
    lp: deudor(sal, ['24', '25', '26'], ['249', '259']),
    clientes: deudor(sal, ['43'], ['437']),
    otros: deudor(sal, ['44', '460', '544', '53', '54', '565', '566'], ['5395', '549']),
    efectivo: deudor(sal, ['57']),
  });
  const afN = af(e.saldos.balance);
  const afA = af(e.saldosAnterior.balance);
  nota(
    '5',
    'Activos financieros',
    ['Activos financieros a coste amortizado (no incluye los saldos con Administraciones Públicas):'],
    [
      {
        cabeceras: ['Categoría', ...cab],
        filas: [
          { texto: 'Inversiones financieras a largo plazo', valores: [afN.lp, afA.lp] },
          { texto: 'Clientes por ventas y prestaciones de servicios', valores: [afN.clientes, afA.clientes] },
          { texto: 'Otros créditos e inversiones a corto plazo', valores: [afN.otros, afA.otros] },
          { texto: 'Efectivo y otros activos líquidos', valores: [afN.efectivo, afA.efectivo] },
          {
            texto: 'Total',
            valores: [round2(afN.lp + afN.clientes + afN.otros + afN.efectivo), round2(afA.lp + afA.clientes + afA.otros + afA.efectivo)],
            total: true,
          },
        ],
      },
    ],
  );

  // 6. Pasivos financieros
  const pf = (sal: Map<string, number>) => ({
    bancosLp: -deudor(sal, ['170', '174']),
    otrasLp: -deudor(sal, ['15', '16', '17', '18'], ['170', '174']),
    bancosCp: -deudor(sal, ['520', '527']) + Math.max(0, -deudor(sal, ['57'])),
    proveedores: -deudor(sal, ['40'], ['407']),
    otrosCp: -deudor(sal, ['41', '465', '466', '51', '521', '523', '524', '525', '526', '551', '555', '56'], ['565', '566', '567']),
  });
  const pfN = pf(e.saldos.balance);
  const pfA = pf(e.saldosAnterior.balance);
  const filasPf = [
    { texto: 'Deudas con entidades de crédito a largo plazo', valores: [pfN.bancosLp, pfA.bancosLp] },
    { texto: 'Otras deudas a largo plazo', valores: [pfN.otrasLp, pfA.otrasLp] },
    { texto: 'Deudas con entidades de crédito a corto plazo', valores: [round2(pfN.bancosCp), round2(pfA.bancosCp)] },
    { texto: 'Proveedores', valores: [pfN.proveedores, pfA.proveedores] },
    { texto: 'Otros acreedores y deudas a corto plazo', valores: [pfN.otrosCp, pfA.otrosCp] },
  ];
  nota(
    '6',
    'Pasivos financieros',
    [
      'Pasivos financieros a coste amortizado (no incluye los saldos con Administraciones Públicas):',
      e.notas.periodoMedioPago != null
        ? `El periodo medio de pago a proveedores del ejercicio ha sido de ${e.notas.periodoMedioPago} días.`
        : `${falta('periodo medio de pago a proveedores')} (Ley 15/2010).`,
    ],
    [
      {
        cabeceras: ['Categoría', ...cab],
        filas: [
          ...filasPf,
          {
            texto: 'Total',
            valores: [0, 1].map((i) => round2(filasPf.reduce((t, f) => t + f.valores[i], 0))),
            total: true,
          },
        ],
      },
    ],
  );

  // 7. Fondos propios
  const capital = -deudor(e.saldos.balance, ['100', '101', '102']);
  const reservaLegal = -deudor(e.saldos.balance, ['112']);
  nota('7', 'Fondos propios', [
    `El capital social a cierre del ejercicio asciende a ${fmt(capital)} euros. ${falta('número y valor nominal de las acciones o participaciones')}.`,
    `La reserva legal asciende a ${fmt(reservaLegal)} euros. Según el artículo 274 de la Ley de Sociedades de Capital, se destina a ella el 10 % del beneficio hasta que alcance el 20 % del capital social; mientras no supere ese límite solo puede usarse para compensar pérdidas.`,
    'El movimiento de los fondos propios figura en el estado de cambios en el patrimonio neto.',
  ]);

  // 8. Situacion fiscal
  const pyg = e.cuentas.pyg;
  const hpDeudora = (sal: Map<string, number>) => deudor(sal, ['470', '471', '472', '473']);
  const hpAcreedora = (sal: Map<string, number>) => -deudor(sal, ['475', '476', '477']);
  nota(
    '8',
    'Situación fiscal',
    [
      'Conciliación del resultado contable con la base imponible del Impuesto sobre Sociedades. No se han registrado ajustes extracontables en la aplicación; si los hay, hay que completar esta nota.',
      'Los ejercicios no prescritos pueden ser objeto de comprobación por la Administración tributaria (con carácter general, los cuatro últimos).',
    ],
    [
      {
        cabeceras: ['Impuesto sobre Sociedades', String(n)],
        filas: [
          { texto: 'Resultado contable antes de impuestos', valores: [pyg.resultadoAntesImpuestos] },
          { texto: 'Ajustes extracontables', valores: [0] },
          { texto: 'Base imponible (resultado fiscal)', valores: [pyg.resultadoAntesImpuestos], total: true },
          { texto: 'Gasto por impuesto sobre beneficios', valores: [pyg.impuestoBeneficios] },
        ],
      },
      {
        cabeceras: ['Saldos con Administraciones Públicas', ...cab],
        filas: [
          { texto: 'Hacienda Pública y Seguridad Social deudoras', valores: [hpDeudora(e.saldos.balance), hpDeudora(e.saldosAnterior.balance)] },
          { texto: 'Hacienda Pública y Seguridad Social acreedoras', valores: [hpAcreedora(e.saldos.balance), hpAcreedora(e.saldosAnterior.balance)] },
        ],
      },
    ],
  );

  // 9. Ingresos y gastos
  const gasto = (sal: Map<string, number>, p: string[]) => deudor(sal, p);
  const desglose62 = [...e.saldos.pyg.keys()]
    .filter((c) => c.startsWith('62'))
    .map((c) => c.slice(0, 3))
    .filter((c, i, arr) => arr.indexOf(c) === i)
    .sort()
    .map((c) => ({ texto: nombreCuenta(c), valores: [gasto(e.saldos.pyg, [c]), gasto(e.saldosAnterior.pyg, [c])] }));
  nota(
    '9',
    'Ingresos y gastos',
    [],
    [
      {
        cabeceras: ['Desglose', ...cab],
        filas: [
          { texto: 'Consumo de mercaderías y materias primas', valores: [gasto(e.saldos.pyg, ['600', '601', '602', '606', '608', '609', '61']), gasto(e.saldosAnterior.pyg, ['600', '601', '602', '606', '608', '609', '61'])] },
          { texto: 'Trabajos realizados por otras empresas', valores: [gasto(e.saldos.pyg, ['607']), gasto(e.saldosAnterior.pyg, ['607'])] },
          { texto: 'Sueldos y salarios', valores: [gasto(e.saldos.pyg, ['640', '641']), gasto(e.saldosAnterior.pyg, ['640', '641'])] },
          { texto: 'Cargas sociales', valores: [gasto(e.saldos.pyg, ['642', '643', '644', '649']), gasto(e.saldosAnterior.pyg, ['642', '643', '644', '649'])] },
          ...desglose62,
        ],
      },
    ],
  );

  // 10. Subvenciones
  const subv = -deudor(e.saldos.balance, ['13']);
  const subvAnt = -deudor(e.saldosAnterior.balance, ['13']);
  const imputadas = -deudor(e.saldos.pyg, ['740', '746', '747']);
  nota(
    '10',
    'Subvenciones, donaciones y legados',
    subv === 0 && subvAnt === 0 && imputadas === 0
      ? ['No figuran subvenciones, donaciones ni legados en la contabilidad del ejercicio ni del anterior.']
      : [
          `Saldo en el patrimonio neto al cierre: ${fmt(subv)} euros (${fmt(subvAnt)} en ${n - 1}). Imputadas a resultados en el ejercicio: ${fmt(imputadas)} euros.`,
          falta('entidad que concede cada subvención y su finalidad'),
        ],
  );

  // 11. Partes vinculadas
  nota('11', 'Operaciones con partes vinculadas', [
    e.notas.remuneracionAdministradores?.trim()
      ? `Remuneración de los administradores: ${e.notas.remuneracionAdministradores.trim()}`
      : falta('remuneraciones y anticipos a los administradores (aunque sean cero)'),
    e.notas.partesVinculadas?.trim() || falta('operaciones con socios, administradores y empresas vinculadas, o indicar que no las hay'),
  ]);

  // 12. Otra informacion
  const plantilla =
    e.notas.plantillaMedia != null
      ? `La plantilla media del ejercicio ha sido de ${e.notas.plantillaMedia} personas${
          e.notas.plantillaMediaHombres != null && e.notas.plantillaMediaMujeres != null
            ? ` (${e.notas.plantillaMediaHombres} hombres y ${e.notas.plantillaMediaMujeres} mujeres)`
            : ''
        }.`
      : falta('número medio de personas empleadas en el ejercicio');
  nota('12', 'Otra información', [
    plantilla,
    e.notas.hechosPosteriores?.trim()
      ? `Hechos posteriores al cierre: ${e.notas.hechosPosteriores.trim()}`
      : falta('hechos posteriores al cierre, o indicar que no los hay'),
    ...(e.notas.otraInformacion?.trim() ? [e.notas.otraInformacion.trim()] : []),
  ]);

  return { notas, pendientes };
}

const formato = (v: number) => {
  const [entera, dec] = Math.abs(v).toFixed(2).split('.');
  return `${v < 0 ? '-' : ''}${entera.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};
function fmt(v: number): string {
  return formato(round2(v));
}

/** Limpia las notas que llegan del formulario: solo los campos conocidos. */
export function limpiarNotasMemoria(datos: Record<string, unknown>): NotasMemoria {
  const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 5000) : null);
  const textos: Record<string, string> = {};
  if (datos.textos && typeof datos.textos === 'object') {
    for (const [k, v] of Object.entries(datos.textos as Record<string, unknown>)) {
      if (/^(1[0-2]|[1-9])$/.test(k) && typeof v === 'string' && v.trim()) textos[k] = v.trim().slice(0, 20000);
    }
  }
  return {
    plantillaMedia: num(datos.plantillaMedia),
    plantillaMediaHombres: num(datos.plantillaMediaHombres),
    plantillaMediaMujeres: num(datos.plantillaMediaMujeres),
    periodoMedioPago: num(datos.periodoMedioPago),
    partesVinculadas: txt(datos.partesVinculadas),
    remuneracionAdministradores: txt(datos.remuneracionAdministradores),
    hechosPosteriores: txt(datos.hechosPosteriores),
    otraInformacion: txt(datos.otraInformacion),
    textos,
  };
}
