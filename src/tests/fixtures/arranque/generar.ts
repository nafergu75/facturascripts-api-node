/**
 * Ficheros sinteticos de gestoria para los tests de «Traer la contabilidad de
 * 2026». No hay ficheros reales: se construyen en memoria con SheetJS (Excel,
 * dBase) y a mano (CSV en UTF-8 o Windows-1252, ancho fijo, PDF).
 *
 *  - Empresa A: plan de 10 digitos con NIF, sumas y saldos SIN regularizar,
 *    diario completo de 2026 que cuadra, cartera, inmovilizado y listados de
 *    clientes y proveedores.
 *  - Empresa B: plan de 8 digitos, sumas y saldos REGULARIZADO y la PyG aparte,
 *    sin diario.
 *  - Variantes por programa (a3, ContaPlus, Sage, Holded, Contasol, Monitor,
 *    Excel sin titulos...) y con fallos.
 *
 * Las columnas de cada programa son las que suelen sacar: no estan
 * comprobadas con ficheros reales.
 */
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.js';
import { controlCif } from '../../../utils/nif';

XLSX.set_cptable(cptable);

export interface FicheroPrueba {
  nombre: string;
  contenido: Buffer;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** NIF de sociedad valido a partir de 7 cifras. */
export const cifDe = (siete: string) => `B${siete}${controlCif(siete).cifra}`;

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export function libro(hojas: Array<[string, unknown[][]]>, bookType: XLSX.BookType = 'xlsx'): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [nombre, filas] of hojas) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), nombre.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

/** Tabla dBase como las de ContaPlus: pagina 850 y SIN declararla en la cabecera. */
export function dbf(filas: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'T');
  const b = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'dbf', codepage: 850 }) as Buffer);
  b[29] = 0;
  return b;
}

/** Windows-1252: Latin-1 y el euro. */
function windows1252(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = s[i] === '€' ? 0x80 : c < 256 ? c : 0x3f;
  }
  return out;
}

export function csv(filas: unknown[][], sep = ';', codificacion: 'utf-8' | 'utf-8-bom' | 'windows-1252' = 'utf-8'): Buffer {
  const celda = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(sep) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const textoCsv = filas.map((f) => f.map(celda).join(sep)).join('\r\n');
  if (codificacion === 'windows-1252') return windows1252(textoCsv);
  return Buffer.from((codificacion === 'utf-8-bom' ? '﻿' : '') + textoCsv, 'utf8');
}

/** Importe con coma decimal y punto de miles («1.234,56»). */
export const es = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
/** Fecha dd/mm/aaaa. */
const ddmm = (f: string) => f.split('-').reverse().join('/');

// ---------------------------------------------------------------------------
// Empresa A (10 digitos, sin regularizar, con diario)
// ---------------------------------------------------------------------------

export const NIF = {
  alfa: cifDe('4600001'),
  beta: cifDe('4600002'),
  cero: cifDe('4600003'),
  uno: cifDe('4600011'),
  dos: cifDe('4600012'),
  luz: cifDe('4600021'),
  gamma: cifDe('4600031'),
  delta: cifDe('4600041'),
};

export interface CuentaPrueba {
  codigo: string;
  nombre: string;
  nif?: string;
}

export const PLAN_A: CuentaPrueba[] = [
  { codigo: '100', nombre: 'Capital social' },
  { codigo: '1000000000', nombre: 'Capital social' },
  { codigo: '112', nombre: 'Reserva legal' },
  { codigo: '1120000000', nombre: 'Reserva legal' },
  { codigo: '129', nombre: 'Resultado del ejercicio' },
  { codigo: '1290000000', nombre: 'Resultado del ejercicio' },
  { codigo: '213', nombre: 'Maquinaria' },
  { codigo: '2130000000', nombre: 'Maquinaria taller' },
  { codigo: '216', nombre: 'Mobiliario' },
  { codigo: '2160000000', nombre: 'Mobiliario oficina' },
  { codigo: '281', nombre: 'Amortización acumulada del inmovilizado material' },
  { codigo: '2813000000', nombre: 'Amort. acumulada maquinaria' },
  { codigo: '2816000000', nombre: 'Amort. acumulada mobiliario' },
  { codigo: '400', nombre: 'Proveedores' },
  { codigo: '4000000001', nombre: 'Proveedor Uno SL', nif: NIF.uno },
  { codigo: '4000000002', nombre: 'Proveedor Dos SA', nif: NIF.dos },
  { codigo: '410', nombre: 'Acreedores por prestaciones de servicios' },
  { codigo: '4100000001', nombre: 'Eléctrica Luz SL', nif: NIF.luz },
  { codigo: '430', nombre: 'Clientes' },
  { codigo: '4300000001', nombre: 'Cliente Alfa SL', nif: NIF.alfa },
  { codigo: '4300000002', nombre: 'Cliente Beta SA', nif: NIF.beta },
  { codigo: '4300000003', nombre: 'Cliente Cero SL', nif: NIF.cero },
  { codigo: '4720000000', nombre: 'HP IVA soportado' },
  { codigo: '4750000000', nombre: 'HP acreedora por IVA' },
  { codigo: '4770000000', nombre: 'HP IVA repercutido' },
  { codigo: '5720000001', nombre: 'Banco Sabadell' },
  { codigo: '5720000002', nombre: 'Banco Santander' },
  { codigo: '6000000000', nombre: 'Compras de mercaderías' },
  { codigo: '6280000000', nombre: 'Suministros' },
  { codigo: '6810000000', nombre: 'Amortización del inmovilizado material' },
  { codigo: '7000000000', nombre: 'Ventas de mercaderías' },
];

export interface AsientoPrueba {
  numero: number;
  fecha: string;
  concepto: string;
  lineas: Array<[string, number, number]>; // cuenta, debe, haber
}

export const DIARIO_A: AsientoPrueba[] = [
  {
    numero: 1,
    fecha: '2026-01-01',
    concepto: 'Asiento de apertura',
    lineas: [
      ['5720000001', 18000, 0],
      ['2130000000', 10000, 0],
      ['2813000000', 0, 2000],
      ['1000000000', 0, 20000],
      ['1120000000', 0, 6000],
    ],
  },
  { numero: 2, fecha: '2026-02-15', concepto: 'Fra. A-2026-001 Cliente Alfa', lineas: [['4300000001', 12100, 0], ['7000000000', 0, 10000], ['4770000000', 0, 2100]] },
  { numero: 3, fecha: '2026-02-20', concepto: 'Fra. A-2026-002 Cliente Beta', lineas: [['4300000002', 6050, 0], ['7000000000', 0, 5000], ['4770000000', 0, 1050]] },
  { numero: 4, fecha: '2026-03-10', concepto: 'Fra. FP-77 Proveedor Uno', lineas: [['6000000000', 4000, 0], ['4720000000', 840, 0], ['4000000001', 0, 4840]] },
  { numero: 5, fecha: '2026-03-15', concepto: 'Fra. FD-12 Proveedor Dos', lineas: [['6000000000', 2000, 0], ['4720000000', 420, 0], ['4000000002', 0, 2420]] },
  { numero: 6, fecha: '2026-03-30', concepto: 'Fra. L-0330 luz', lineas: [['6280000000', 500, 0], ['4720000000', 105, 0], ['4100000001', 0, 605]] },
  { numero: 7, fecha: '2026-04-30', concepto: 'Cobro parcial Alfa', lineas: [['5720000001', 6050, 0], ['4300000001', 0, 6050]] },
  { numero: 8, fecha: '2026-04-30', concepto: 'Pago parcial Proveedor Uno', lineas: [['4000000001', 2420, 0], ['5720000001', 0, 2420]] },
  { numero: 9, fecha: '2026-06-01', concepto: 'Compra mobiliario', lineas: [['2160000000', 3000, 0], ['5720000001', 0, 3000]] },
  { numero: 10, fecha: '2026-12-31', concepto: 'Amortización 2026', lineas: [['6810000000', 1300, 0], ['2813000000', 0, 1000], ['2816000000', 0, 300]] },
  { numero: 11, fecha: '2026-12-31', concepto: 'Liquidación IVA 4T', lineas: [['4770000000', 3150, 0], ['4720000000', 0, 1365], ['4750000000', 0, 1785]] },
];

/** Sumas y saldos por subcuenta a partir de un diario (tambien las cuentas del plan sin movimientos, a cero). */
export function sumasYSaldos(diario: AsientoPrueba[], plan: CuentaPrueba[]): Array<{ codigo: string; nombre: string; debe: number; haber: number; saldo: number }> {
  const m = new Map<string, { debe: number; haber: number }>();
  for (const a of diario) {
    for (const [c, d, h] of a.lineas) {
      const s = m.get(c) ?? { debe: 0, haber: 0 };
      s.debe = r2(s.debe + d);
      s.haber = r2(s.haber + h);
      m.set(c, s);
    }
  }
  const subcuentas = plan.filter((c) => c.codigo.length > 4);
  for (const c of subcuentas) if (!m.has(c.codigo)) m.set(c.codigo, { debe: 0, haber: 0 });
  const nombre = new Map(plan.map((c) => [c.codigo, c.nombre]));
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, s]) => ({ codigo, nombre: nombre.get(codigo) ?? '', ...s, saldo: r2(s.debe - s.haber) }));
}

export const SALDOS_A = sumasYSaldos(DIARIO_A, PLAN_A);

export interface PartidaPrueba {
  subcuenta: string;
  nombre: string;
  nif: string;
  documento: string;
  fecha: string;
  vencimiento: string;
  importe: number;
  pendiente: number;
}

export const CARTERA_A: PartidaPrueba[] = [
  { subcuenta: '4300000001', nombre: 'Cliente Alfa SL', nif: NIF.alfa, documento: 'A-2026-001', fecha: '2026-02-15', vencimiento: '2026-03-15', importe: 12100, pendiente: 6050 },
  { subcuenta: '4300000002', nombre: 'Cliente Beta SA', nif: NIF.beta, documento: 'A-2026-002', fecha: '2026-02-20', vencimiento: '2027-01-20', importe: 6050, pendiente: 6050 },
  { subcuenta: '4000000001', nombre: 'Proveedor Uno SL', nif: NIF.uno, documento: 'FP-77', fecha: '2026-03-10', vencimiento: '2026-04-10', importe: 4840, pendiente: 2420 },
  { subcuenta: '4000000002', nombre: 'Proveedor Dos SA', nif: NIF.dos, documento: 'FD-12', fecha: '2026-03-15', vencimiento: '2027-01-15', importe: 2420, pendiente: 2420 },
  { subcuenta: '4100000001', nombre: 'Eléctrica Luz SL', nif: NIF.luz, documento: 'L-0330', fecha: '2026-03-30', vencimiento: '2027-01-05', importe: 605, pendiente: 605 },
];

export const INMOVILIZADO_A = [
  { descripcion: 'Torno CNC', cuenta: '2130000000', cuentaAmort: '2813000000', fechaAlta: '2024-01-01', coste: 10000, acumulada: 3000, coeficiente: 10 },
  { descripcion: 'Mesas y sillas', cuenta: '2160000000', cuentaAmort: '2816000000', fechaAlta: '2026-06-01', coste: 3000, acumulada: 300, coeficiente: 10 },
];

export const CLIENTES_A = [
  { nif: NIF.alfa, nombre: 'Cliente Alfa SL', subcuenta: '4300000001', domicilio: 'Calle Mayor 1', cp: '46001', poblacion: 'Valencia', provincia: 'Valencia', telefono: '960000001', email: 'alfa@ejemplo.es' },
  { nif: NIF.beta, nombre: 'Cliente Beta SA', subcuenta: '4300000002', domicilio: 'Avenida del Puerto 2', cp: '46021', poblacion: 'Valencia', provincia: 'Valencia', telefono: '960000002', email: 'beta@ejemplo.es' },
  { nif: NIF.cero, nombre: 'Cliente Cero SL', subcuenta: '4300000003', domicilio: 'Plaza Redonda 3', cp: '46002', poblacion: 'Valencia', provincia: 'Valencia', telefono: '', email: '' },
];

export const PROVEEDORES_A = [
  { nif: NIF.uno, nombre: 'Proveedor Uno SL', subcuenta: '4000000001', domicilio: 'Polígono Norte 5', cp: '46980', poblacion: 'Paterna', provincia: 'Valencia' },
  { nif: NIF.dos, nombre: 'Proveedor Dos SA', subcuenta: '4000000002', domicilio: 'Calle Peña 7', cp: '28001', poblacion: 'Madrid', provincia: 'Madrid' },
  { nif: NIF.luz, nombre: 'Eléctrica Luz SL', subcuenta: '4100000001', domicilio: 'Calle Ñandú 9', cp: '46100', poblacion: 'Burjassot', provincia: 'Valencia' },
];

/** Filas del sumas y saldos generico (titulos, fecha de corte y debe/haber/saldos). */
function filasSumasYSaldos(saldos: typeof SALDOS_A, titulo: string): unknown[][] {
  return [
    [titulo],
    ['Del 01/01/2026 al 31/12/2026'],
    [],
    ['Cuenta', 'Descripción', 'Debe', 'Haber', 'Saldo deudor', 'Saldo acreedor'],
    ...saldos.map((s) => [s.codigo, s.nombre, s.debe, s.haber, s.saldo > 0 ? s.saldo : 0, s.saldo < 0 ? -s.saldo : 0]),
  ];
}

export function filasDiario(diario: AsientoPrueba[], plan: CuentaPrueba[]): unknown[][] {
  const nombre = new Map(plan.map((c) => [c.codigo, c.nombre]));
  return [
    ['Libro diario 2026'],
    ['Asiento', 'Fecha', 'Cuenta', 'Título', 'Concepto', 'Debe', 'Haber'],
    ...diario.flatMap((a) => a.lineas.map(([c, d, h]) => [a.numero, ddmm(a.fecha), c, nombre.get(c) ?? '', a.concepto, d || '', h || ''])),
  ];
}

function filasCartera(cartera: PartidaPrueba[]): unknown[][] {
  return [
    ['Cartera de cobros y pagos pendientes a 31/12/2026'],
    ['Subcuenta', 'Nombre', 'NIF', 'Factura', 'Fecha', 'Vencimiento', 'Importe', 'Pendiente'],
    ...cartera.map((p) => [p.subcuenta, p.nombre, p.nif, p.documento, ddmm(p.fecha), ddmm(p.vencimiento), p.importe, p.pendiente]),
  ];
}

function filasInmovilizado(lista: typeof INMOVILIZADO_A): unknown[][] {
  return [
    ['Fichas de inmovilizado'],
    ['Descripción', 'Cuenta', 'Cuenta amortización', 'Fecha alta', 'Coste', 'Amort. acumulada', 'Coeficiente'],
    ...lista.map((b) => [b.descripcion, b.cuenta, b.cuentaAmort, ddmm(b.fechaAlta), b.coste, b.acumulada, b.coeficiente]),
  ];
}

/** Los ficheros de la empresa A tal como los mandaria una gestoria con Excel generico. */
export function ficherosEmpresaA(): Record<'plan' | 'sumasSaldos' | 'diario' | 'clientes' | 'proveedores' | 'cartera' | 'inmovilizado', FicheroPrueba> {
  return {
    plan: {
      nombre: 'plan_cuentas_2026.xlsx',
      contenido: libro([['Plan de cuentas', [['Plan de cuentas 2026 - EMPRESA A'], ['Cuenta', 'Descripción', 'NIF'], ...PLAN_A.map((c) => [c.codigo, c.nombre, c.nif ?? ''])]]]),
    },
    sumasSaldos: { nombre: 'sumas_y_saldos_2026.xlsx', contenido: libro([['Hoja1', filasSumasYSaldos(SALDOS_A, 'Balance de sumas y saldos')]]) },
    diario: { nombre: 'diario_2026.xlsx', contenido: libro([['Diario', filasDiario(DIARIO_A, PLAN_A)]]) },
    clientes: {
      nombre: 'clientes.xlsx',
      contenido: libro([
        [
          'Clientes',
          [['NIF', 'Nombre', 'Subcuenta', 'Domicilio', 'CP', 'Población', 'Provincia', 'Teléfono', 'Email'], ...CLIENTES_A.map((c) => [c.nif, c.nombre, c.subcuenta, c.domicilio, c.cp, c.poblacion, c.provincia, c.telefono, c.email])],
        ],
      ]),
    },
    proveedores: {
      nombre: 'proveedores.csv',
      contenido: csv(
        [['Listado de proveedores y acreedores'], ['NIF', 'Nombre', 'Subcuenta', 'Domicilio', 'CP', 'Población', 'Provincia'], ...PROVEEDORES_A.map((p) => [p.nif, p.nombre, p.subcuenta, p.domicilio, p.cp, p.poblacion, p.provincia])],
        ';',
        'windows-1252',
      ),
    },
    cartera: { nombre: 'cartera_pendiente.xlsx', contenido: libro([['Cartera', filasCartera(CARTERA_A)]]) },
    inmovilizado: { nombre: 'inmovilizado.xlsx', contenido: libro([['Inmovilizado', filasInmovilizado(INMOVILIZADO_A)]]) },
  };
}

// ---------------------------------------------------------------------------
// Empresa B (8 digitos, regularizado, PyG aparte, sin diario)
// ---------------------------------------------------------------------------

export const PLAN_B: CuentaPrueba[] = [
  { codigo: '10000000', nombre: 'Capital social' },
  { codigo: '12900000', nombre: 'Resultado del ejercicio' },
  { codigo: '40000001', nombre: 'Proveedor Delta SL', nif: NIF.delta },
  { codigo: '43000001', nombre: 'Cliente Gamma SL', nif: NIF.gamma },
  { codigo: '57200001', nombre: 'Banco BBVA' },
  { codigo: '62900000', nombre: 'Otros servicios' },
  { codigo: '70500000', nombre: 'Prestaciones de servicios' },
];

/** Regularizado: 6 y 7 a cero, el resultado (3.000 de beneficio) ya en la 129. */
export const SALDOS_B = [
  { codigo: '10000000', nombre: 'Capital social', saldo: -10000 },
  { codigo: '12900000', nombre: 'Resultado del ejercicio', saldo: -3000 },
  { codigo: '40000001', nombre: 'Proveedor Delta SL', saldo: -1500 },
  { codigo: '43000001', nombre: 'Cliente Gamma SL', saldo: 5000 },
  { codigo: '57200001', nombre: 'Banco BBVA', saldo: 9500 },
  { codigo: '62900000', nombre: 'Otros servicios', saldo: 0 },
  { codigo: '70500000', nombre: 'Prestaciones de servicios', saldo: 0 },
];

export const CARTERA_B: PartidaPrueba[] = [
  { subcuenta: '43000001', nombre: 'Cliente Gamma SL', nif: NIF.gamma, documento: 'B-77', fecha: '2026-11-30', vencimiento: '2027-01-30', importe: 5000, pendiente: 5000 },
  { subcuenta: '40000001', nombre: 'Proveedor Delta SL', nif: NIF.delta, documento: 'D-1', fecha: '2026-12-10', vencimiento: '2027-02-10', importe: 1500, pendiente: 1500 },
];

export function ficherosEmpresaB(): Record<'plan' | 'sumasSaldos' | 'pyg' | 'cartera', FicheroPrueba> {
  return {
    plan: { nombre: 'b_plan.xlsx', contenido: libro([['Subcuentas', [['Subcuenta', 'Título', 'NIF'], ...PLAN_B.map((c) => [c.codigo, c.nombre, c.nif ?? ''])]]]) },
    sumasSaldos: {
      nombre: 'b_balance_sumas_saldos.xlsx',
      contenido: libro([
        [
          'SyS',
          [
            ['Balance de sumas y saldos a 31/12/2026 (regularizado)'],
            ['Cuenta', 'Nombre', 'Saldo deudor', 'Saldo acreedor'],
            ...SALDOS_B.map((s) => [s.codigo, s.nombre, s.saldo > 0 ? s.saldo : 0, s.saldo < 0 ? -s.saldo : 0]),
          ],
        ],
      ]),
    },
    pyg: {
      nombre: 'b_pyg_2026.xlsx',
      contenido: libro([
        [
          'PyG',
          [
            ['Cuenta de pérdidas y ganancias 2026'],
            ['', 'Ejercicio 2026'],
            ['1. Importe neto de la cifra de negocios', 8000],
            ['a) Prestaciones de servicios', 8000],
            ['4. Aprovisionamientos', 0],
            ['6. Gastos de personal', 0],
            ['7. Otros gastos de explotación', -5000],
            ['a) Servicios exteriores', -5000],
            ['A.1) RESULTADO DE EXPLOTACIÓN', 3000],
            ['A.3) RESULTADO ANTES DE IMPUESTOS', 3000],
            ['A.4) RESULTADO DEL EJERCICIO', 3000],
          ],
        ],
      ]),
    },
    cartera: { nombre: 'b_cartera.xlsx', contenido: libro([['Vencimientos', filasCartera(CARTERA_B)]]) },
  };
}

// ---------------------------------------------------------------------------
// Variantes por programa (con los datos de la empresa A)
// ---------------------------------------------------------------------------

/** a3ECO: sumas y saldos «por niveles» (grupos, subgrupos y cuentas ademas de las subcuentas). */
export function a3SumasSaldos(): FicheroPrueba {
  const niveles = new Map<string, { nombre: string; debe: number; haber: number }>();
  for (const s of SALDOS_A) {
    for (const largo of [1, 2, 3, 10]) {
      const k = s.codigo.slice(0, largo);
      const n = niveles.get(k) ?? { nombre: largo === 10 ? s.nombre : `Nivel ${k}`, debe: 0, haber: 0 };
      n.debe = r2(n.debe + s.debe);
      n.haber = r2(n.haber + s.haber);
      niveles.set(k, n);
    }
  }
  const filas = [...niveles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => [k, n.nombre, 0, n.debe, n.haber, r2(n.debe - n.haber)]);
  return {
    nombre: 'SumasSaldos_a3.xlsx',
    contenido: libro([['Listado', [['A3ECO - Sumas y Saldos'], ['Empresa: EMPRESA A   Fecha: 31/12/2026'], ['Cuenta', 'Título', 'Saldo anterior', 'Debe', 'Haber', 'Saldo'], ...filas]]]),
  };
}

/** ContaPlus: tabla de subcuentas (SUBCTA.DBF). */
export function contaplusSubcuentas(): FicheroPrueba {
  const cliente = new Map(CLIENTES_A.map((c) => [c.subcuenta, c]));
  return {
    nombre: 'SUBCTA.DBF',
    contenido: dbf([
      ['COD', 'TITULO', 'NIF', 'DOMICILIO', 'POBLACION', 'PROVINCIA', 'CODPOSTAL'],
      ...PLAN_A.filter((c) => c.codigo.length === 10).map((c) => {
        const k = cliente.get(c.codigo);
        return [c.codigo, c.nombre, c.nif ?? '', k?.domicilio ?? '', k?.poblacion ?? '', k?.provincia ?? '', k?.cp ?? ''];
      }),
    ]),
  };
}

/** ContaPlus: diario (DIARIO.DBF) con importes en pesetas y en euros; mandan los euros. */
export function contaplusDiario(): FicheroPrueba {
  const pts = (n: number) => Math.round(n * 166.386);
  return {
    nombre: 'DIARIO.DBF',
    contenido: dbf([
      ['ASIEN', 'FECHA', 'SUBCTA', 'CONTRA', 'CONCEPTO', 'PTADEBE', 'PTAHABER', 'EURODEBE', 'EUROHABER'],
      ...DIARIO_A.flatMap((a) => {
        const [y, m, d] = a.fecha.split('-').map(Number);
        // CONTRA: la primera cuenta del otro lado (SheetJS no escribe bien una columna de texto vacia).
        return a.lineas.map(([c, de, ha]) => [a.numero, new Date(y, m - 1, d), c, a.lineas.find((o) => (de ? o[2] : o[1]))?.[0] ?? c, a.concepto, pts(de), pts(ha), de, ha]);
      }),
    ]),
  };
}

/** Sage 50: sumas y saldos con saldo deudor y acreedor. */
export function sageSumasSaldos(): FicheroPrueba {
  return {
    nombre: 'sage50_sumas_saldos.xlsx',
    contenido: libro([
      [
        'Balance',
        [
          ['Sage 50 - Balance de sumas y saldos'],
          ['Periodo: 01/01/2026 - 31/12/2026'],
          ['Cuenta', 'Nombre', 'Sumas debe', 'Sumas haber', 'Saldo deudor', 'Saldo acreedor'],
          ...SALDOS_A.map((s) => [s.codigo, s.nombre, s.debe, s.haber, s.saldo > 0 ? s.saldo : 0, s.saldo < 0 ? -s.saldo : 0]),
        ],
      ],
    ]),
  };
}

/** Holded: CSV en UTF-8 con coma de separador y punto decimal. */
export function holdedSumasSaldos(): FicheroPrueba {
  return {
    nombre: 'holded_sumas_y_saldos.csv',
    contenido: csv(
      [
        ['Holded - Sumas y saldos 2026'],
        ['Cuenta', 'Nombre', 'Saldo inicial', 'Debe', 'Haber', 'Saldo final'],
        ...SALDOS_A.map((s) => [s.codigo, s.nombre, '0.00', s.debe.toFixed(2), s.haber.toFixed(2), s.saldo.toFixed(2)]),
      ],
      ',',
      'utf-8-bom',
    ),
  };
}

/** Contasol: codigos con punto de relleno («430.1» = 4300000001) e importes en texto. */
export function contasolSumasSaldos(): FicheroPrueba {
  const conPunto = (c: string) => `${c.slice(0, 3)}.${String(Number(c.slice(3)))}`;
  return {
    nombre: 'contasol_sys.xlsx',
    contenido: libro([
      [
        'SyS',
        [
          ['CONTASOL - Sumas y saldos'],
          ['Ejercicio 2026, hasta 31/12/2026'],
          ['Código', 'Título', 'Debe', 'Haber', 'Saldo'],
          ...SALDOS_A.map((s) => [conPunto(s.codigo), s.nombre, es(s.debe), es(s.haber), es(s.saldo)]),
        ],
      ],
    ]),
  };
}

/** Monitor Informatico (ContaMonitor): plan de cuentas. */
export function monitorPlan(): FicheroPrueba {
  return {
    nombre: 'plan_monitor.xlsx',
    contenido: libro([['Plan', [['ContaMonitor - Plan de cuentas'], ['Código', 'Denominación', 'CIF'], ...PLAN_A.map((c) => [c.codigo, c.nombre, c.nif ?? ''])]]]),
  };
}

/** Excel sin titulos: codigo y nombre. */
export function planSinTitulos(): FicheroPrueba {
  return { nombre: 'cuentas.xlsx', contenido: libro([['Hoja1', PLAN_A.filter((c) => c.codigo.length === 10).map((c) => [c.codigo, c.nombre])]]) };
}

/** Un libro con plan, sumas y saldos y diario en tres hojas. */
export function libroCompleto(): FicheroPrueba {
  return {
    nombre: 'contabilidad_2026_empresaA.xlsx',
    contenido: libro([
      ['Plan', [['Cuenta', 'Descripción', 'NIF'], ...PLAN_A.map((c) => [c.codigo, c.nombre, c.nif ?? ''])]],
      ['Sumas y saldos', filasSumasYSaldos(SALDOS_A, 'Sumas y saldos')],
      ['Diario', filasDiario(DIARIO_A, PLAN_A)],
      ['Vacía', []],
    ]),
  };
}

/** Mayor por cuenta: la cuenta en una linea de encabezado y sus apuntes debajo. */
export function mayorPorCuenta(): FicheroPrueba {
  const porCuenta = new Map<string, Array<[string, string, number, number]>>();
  for (const a of DIARIO_A) for (const [c, d, h] of a.lineas) porCuenta.set(c, [...(porCuenta.get(c) ?? []), [a.fecha, a.concepto, d, h]]);
  const nombre = new Map(PLAN_A.map((c) => [c.codigo, c.nombre]));
  const filas: unknown[][] = [['Libro mayor 2026'], ['Fecha', 'Concepto', 'Debe', 'Haber']];
  for (const [c, apuntes] of [...porCuenta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    filas.push([`Cuenta: ${c} ${nombre.get(c)}`]);
    for (const [f, con, d, h] of apuntes) filas.push([ddmm(f), con, d || '', h || '']);
  }
  return { nombre: 'mayor_2026.xlsx', contenido: libro([['Mayor', filas]]) };
}

/** CSV en Windows-1252 con ñ y tildes, separador «;» y una linea de titulo sin separadores. */
export function planWindows1252(): FicheroPrueba {
  return {
    nombre: 'plan_ansi.csv',
    contenido: csv([['Plan de cuentas de la Peña Ñandú, S.L.'], ['Subcuenta', 'Descripción', 'NIF'], ...PLAN_A.map((c) => [c.codigo, c.nombre, c.nif ?? ''])], ';', 'windows-1252'),
  };
}

/** Fichero de intercambio de ancho fijo. */
export function anchoFijo(): FicheroPrueba {
  const linea = (c: string, n: string, s: number) => `${c.padEnd(12)}${n.padEnd(40).slice(0, 40)}${s.toFixed(2).padStart(16)}`;
  return { nombre: 'export.txt', contenido: Buffer.from(SALDOS_A.map((s) => linea(s.codigo, s.nombre, s.saldo)).join('\r\n'), 'latin1') };
}

export function pdf(): FicheroPrueba {
  return { nombre: 'balance.pdf', contenido: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF', 'latin1') };
}

// ---------------------------------------------------------------------------
// Variantes con fallos
// ---------------------------------------------------------------------------

/** Diario al que le falta el cobro de Alfa: no coincide con el sumas y saldos. */
export function diarioQueNoCuadraConSaldos(): FicheroPrueba {
  return { nombre: 'diario_incompleto.xlsx', contenido: libro([['Diario', filasDiario(DIARIO_A.filter((a) => a.numero !== 7), PLAN_A)]]) };
}

/** Diario con un asiento descuadrado. */
export function diarioDescuadrado(): FicheroPrueba {
  const malo = DIARIO_A.map((a) => (a.numero === 3 ? { ...a, lineas: [['4300000002', 6050, 0], ['7000000000', 0, 5000], ['4770000000', 0, 1000]] as Array<[string, number, number]> } : a));
  return { nombre: 'diario_descuadrado.xlsx', contenido: libro([['Diario', filasDiario(malo, PLAN_A)]]) };
}

/** Cartera en la que a Beta le faltan 50 €. */
export function carteraConDiferencia(): FicheroPrueba {
  return { nombre: 'cartera_mal.xlsx', contenido: libro([['Cartera', filasCartera(CARTERA_A.map((p) => (p.subcuenta === '4300000002' ? { ...p, pendiente: 6000 } : p)))]]) };
}

/** Inmovilizado con un coste que no coincide con la 213. */
export function inmovilizadoQueNoCuadra(): FicheroPrueba {
  return { nombre: 'inmovilizado_mal.xlsx', contenido: libro([['Inmovilizado', filasInmovilizado(INMOVILIZADO_A.map((b, i) => (i === 0 ? { ...b, coste: 9000 } : b)))]]) };
}

/** Sumas y saldos con el asiento de cierre: todo a cero. */
export function sumasSaldosConCierre(): FicheroPrueba {
  return { nombre: 'sys_con_cierre.xlsx', contenido: libro([['SyS', filasSumasYSaldos(SALDOS_A.map((s) => ({ ...s, debe: r2(s.debe + Math.max(-s.saldo, 0)), haber: r2(s.haber + Math.max(s.saldo, 0)), saldo: 0 })), 'Sumas y saldos')]]) };
}

/** Sumas y saldos con una subcuenta de cliente de 8 digitos entre las de 10. */
export function sumasSaldosLongitudesMezcladas(): FicheroPrueba {
  const mezcla = SALDOS_A.map((s) => (s.codigo === '4300000002' ? { ...s, codigo: '43000002' } : s));
  return { nombre: 'sys_mezcla.xlsx', contenido: libro([['SyS', filasSumasYSaldos(mezcla, 'Sumas y saldos')]]) };
}

/** Sumas y saldos con una cuenta que no es del PGC (139) con saldo. */
export function sumasSaldosCuentaSinMadre(): FicheroPrueba {
  const con = SALDOS_A.map((s) => (s.codigo === '1120000000' ? { ...s, codigo: '1390000000', nombre: 'Cuenta rara' } : s));
  return { nombre: 'sys_sin_madre.xlsx', contenido: libro([['SyS', filasSumasYSaldos(con, 'Sumas y saldos')]]) };
}
