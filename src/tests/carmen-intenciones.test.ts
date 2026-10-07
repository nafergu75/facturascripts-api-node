/**
 * Carmen, intenciones de datos: matriz de permisos por rol, solo lectura y
 * contrato de cifras (cada cifra de la respuesta es la del servicio de origen).
 * Prisma y los servicios de origen, simulados. Las mismas cifras se comprueban
 * contra una BD real en carmen-intenciones.db.test.ts.
 */
const llamadas: string[] = [];
const lecturas: Record<string, (...a: unknown[]) => unknown> = {
  'journalEntry.count': async (args: unknown) => {
    const estado = (args as { where: { estado: string | { in: string[] } } }).where.estado;
    return estado === 'DRAFT' ? 2 : estado === 'PENDING_REVIEW' ? 3 : 4;
  },
  'journalEntry.findMany': async () => [{ fecha: new Date('2026-09-01T00:00:00Z'), numeroAsiento: 'FAC-ING-1', descripcion: 'Factura A-1', estado: 'DRAFT' }],
  'bankMovement.aggregate': async () => ({ _max: { fecha: '2026-10-05' } }),
  'bankMovement.findMany': async () => [
    { fecha: '2026-10-05', importe: -60.5, concepto: 'RECIBO REPSOL', cuentaBancaria: { bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' } },
    { fecha: '2026-10-04', importe: 1210, concepto: 'TRANSFERENCIA CONSTRUCCIONES PEREZ', cuentaBancaria: { bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' } },
  ],
  'invoicePayment.count': async () => 4,
  'customer.findMany': async () => [{ id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' }],
  'supplier.findMany': async () => [
    { id: 'p1', nombreFiscal: 'IBERDROLA CLIENTES SAU', nifCif: 'A44444444' },
    { id: 'p2', nombreFiscal: 'REPSOL COMERCIAL SA', nifCif: 'A55555555' },
  ],
  'bankAccount.findMany': async () => [{ id: 'b1', bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' }],
  // Las rectificativas de una factura (where.facturaOriginalId) salen de `rectificativas`.
  'incomeInvoice.findMany': async (args: unknown) =>
    (args as { where?: { facturaOriginalId?: string } })?.where?.facturaOriginalId !== undefined ? rectificativas : [
    { id: 'f1', numeroCompleto: 'A-12', estadoDocumento: 'FINAL', fechaEmision: '2026-06-01', fechaVencimiento: '2026-07-01', totalFactura: 1210, customer: { nombreFiscal: 'CONSTRUCCIONES PÉREZ SL' } },
    { id: 'f9', numeroCompleto: 'B-12', estadoDocumento: 'FINAL', fechaEmision: '2026-06-02', fechaVencimiento: '2026-07-02', totalFactura: 50, customer: { nombreFiscal: 'OTRO SL' } },
  ],
  'expenseInvoice.findMany': async () => [
    { id: 'g12', numeroCompleto: 'A-12', fechaEmision: '2026-05-10', fechaVencimiento: '2026-06-10', totalFactura: 99, supplier: { nombreFiscal: 'IBERDROLA CLIENTES SAU' } },
  ],
};
/** Rectificativas que devuelve el Prisma simulado al buscar las de una factura. */
let rectificativas: Array<Record<string, unknown>> = [];
/** Últimos argumentos de cada lectura (para mirar los filtros). */
const argumentos: Record<string, unknown[][]> = {};
/** Prisma que apunta cada llamada y solo sabe leer lo que hay en `lecturas`. */
const mockPrisma = new Proxy(
  {},
  {
    get: (_t, modelo: string) =>
      modelo.startsWith('$')
        ? (...a: unknown[]) => {
            llamadas.push(modelo);
            return Promise.resolve(a.length ? 0 : undefined);
          }
        : new Proxy(
            {},
            {
              get: (_m, metodo: string) => (...a: unknown[]) => {
                llamadas.push(`${modelo}.${metodo}`);
                (argumentos[`${modelo}.${metodo}`] ??= []).push(a);
                const f = lecturas[`${modelo}.${metodo}`];
                return f ? f(...a) : Promise.resolve(null);
              },
            },
          ),
  },
);
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

const mockFacturasPorCobrar = jest.fn();
const mockTotalCobradoEntre = jest.fn();
const mockListarCobros = jest.fn();
const mockObtenerResumen = jest.fn();
const mockPendientes = jest.fn();
const mockPyG = jest.fn();
const mockResumenFiscal = jest.fn();
const mockCalendario = jest.fn();
const mockModeloGuardado = jest.fn();
const mockCalcular303 = jest.fn();
jest.mock('../services/cobrosClientes.service', () => ({ facturasPorCobrar: (...a: unknown[]) => mockFacturasPorCobrar(...a) }));
jest.mock('../services/cobrosPagos.service', () => ({
  totalCobradoEntre: (...a: unknown[]) => mockTotalCobradoEntre(...a),
  listarCobros: (...a: unknown[]) => mockListarCobros(...a),
}));
jest.mock('../services/treasury.service', () => ({ obtenerResumen: (...a: unknown[]) => mockObtenerResumen(...a) }));
jest.mock('../services/informesContables.service', () => ({
  pendientesSegunFacturas: (...a: unknown[]) => mockPendientes(...a),
  informePerdidasGanancias: (...a: unknown[]) => mockPyG(...a),
}));
jest.mock('../services/resumenFiscal.service', () => ({ resumenFiscalPeriodo: (...a: unknown[]) => mockResumenFiscal(...a) }));
jest.mock('../services/impuestosModulo.service', () => ({
  calendarioFiscalSoloLectura: (...a: unknown[]) => mockCalendario(...a),
  modeloGuardadoSoloLectura: (...a: unknown[]) => mockModeloGuardado(...a),
}));
jest.mock('../services/impuestosCalculo.service', () => ({ calcularModelo303: (...a: unknown[]) => mockCalcular303(...a) }));

import { construirContexto } from '../services/carmen/contexto';
import { INTENCIONES, intencionPorId } from '../services/carmen/intenciones/catalogo';
import { claveNumeroFactura } from '../services/carmen/intenciones/facturacion';
import { olvidarIndices } from '../services/carmen/terceros';
import { resolverCodigoPeriodo } from '../services/carmen/huecos/periodo';
import { conservaPermiso } from '../services/carmen/sesiones';
import { hrefValido } from '../services/carmen/menus';
import type { AuthUser } from '../types/express';
import type { HuecosResueltos, RespuestaDatos } from '../services/carmen/tipos';

const HOY = '2026-10-07';
const usuario = (roles: string[], esAdminGlobal = false): AuthUser => ({ userId: 'U1', roles, rolesPorEmpresa: { E1: roles }, companies: ['E1'], esAdminGlobal });
const ROLES: Record<string, AuthUser> = {
  admin: usuario(['admin']),
  contable: usuario(['contable']),
  ventas: usuario(['ventas']),
  tesoreria: usuario(['tesoreria']),
  'solo-lectura': usuario(['solo_lectura']),
  'sin rol': usuario([]),
  'admin global': usuario([], true),
};

const FACTURAS = {
  hoy: HOY,
  facturas: [
    { id: 'f1', numeroCompleto: 'A-1', cliente: 'CONSTRUCCIONES PÉREZ SL', customerId: 'c1', fechaEmision: '2026-06-01', fechaVencimiento: '2026-07-01', total: 1210, cobrado: 0, abonado: 0, pendiente: 1210, vencida: true, diasRetraso: 98 },
    { id: 'f2', numeroCompleto: 'A-2', cliente: 'OTRO SL', customerId: 'c2', fechaEmision: '2026-09-20', fechaVencimiento: '2026-09-30', total: 605, cobrado: 200, abonado: 0, pendiente: 405, vencida: true, diasRetraso: 7 },
    { id: 'f3', numeroCompleto: 'A-3', cliente: 'CONSTRUCCIONES PÉREZ SL', customerId: 'c1', fechaEmision: '2026-10-01', fechaVencimiento: '2026-10-31', total: 121, cobrado: 0, abonado: 0, pendiente: 121, vencida: false, diasRetraso: 0 },
  ],
  pendientes: { numero: 3, importe: 1736 },
  vencidas: { numero: 2, importe: 1615 },
};

/** Facturas de proveedores pendientes (pendientesSegunFacturas). */
const PENDIENTES_PROVEEDORES = [
  { id: 'g1', terceroId: 'p1', numeroCompleto: 'LUZ-7', fechaEmision: '2026-08-01', fechaVencimiento: '2026-08-31', totalFactura: 302.5, importePendiente: 302.5, estado: 'PENDIENTE' },
  { id: 'g2', terceroId: 'p2', numeroCompleto: 'R-88', fechaEmision: '2026-10-01', fechaVencimiento: '2026-10-09', totalFactura: 121, importePendiente: 121, estado: 'PENDIENTE' },
  { id: 'g3', terceroId: 'p1', numeroCompleto: 'LUZ-8', fechaEmision: '2026-10-01', fechaVencimiento: '2026-10-31', totalFactura: 200, importePendiente: 150, estado: 'PARCIAL' },
];

const totales = (facturas: number, base: number, iva: number) => ({ facturas, base, iva, retencion: 0, total: base + iva });
const PYG_FILAS = [
  { celdas: ['1. Importe neto de la cifra de negocios', 50000, 40000], sangria: 1 },
  { celdas: ['6. Gastos de personal', -20000, -18000], sangria: 1 },
  { celdas: ['7. Otros gastos de explotación', -10000, -9000], sangria: 1 },
  { celdas: ['A) RESULTADO DE EXPLOTACIÓN (1 a 12)', 20000, 13000], estilo: 'subtotal' },
  { celdas: ['D) RESULTADO DEL EJERCICIO (C + 18)', 15000, 9750], estilo: 'total' },
];

beforeEach(() => {
  llamadas.length = 0;
  rectificativas = [];
  for (const k of Object.keys(argumentos)) delete argumentos[k];
  olvidarIndices();
  mockFacturasPorCobrar.mockReset().mockResolvedValue(FACTURAS);
  mockTotalCobradoEntre.mockReset().mockResolvedValue(2345.6);
  mockObtenerResumen.mockReset().mockResolvedValue({
    cuentasActivas: 2,
    saldoTotal: 15000.25,
    conciliados: 1,
    pendientes: 1,
    cuentas: [
      { id: 'b1', nombre: 'Banco Sabadell', iban: 'ES00 0000 0000 0000 0000 1234', saldoInicial: 0, saldoActual: 10000.25 },
      { id: 'b2', nombre: 'BBVA', iban: 'ES0000000000000000005678', saldoInicial: 0, saldoActual: 5000 },
    ],
  });
  mockPendientes.mockReset().mockResolvedValue(PENDIENTES_PROVEEDORES);
  mockResumenFiscal.mockReset().mockImplementation(async (_c: string, desde: string) =>
    desde.startsWith('2026')
      ? { desde, hasta: '', ventas: totales(5, 10000, 2100), gastos: totales(8, 4000, 840), ivaResultado: 1260, retencionesAIngresar: 0 }
      : { desde, hasta: '', ventas: totales(4, 8000, 1680), gastos: totales(0, 0, 0), ivaResultado: 1680, retencionesAIngresar: 0 },
  );
  mockListarCobros.mockReset().mockResolvedValue({
    invoiceId: 'f1',
    tipo: 'INGRESO',
    numeroFactura: 'A-12',
    // Forma de main (divisas): sin *Cuenta, en la moneda de la factura; con *Cuenta, en la de cuenta.
    moneda: 'EUR',
    monedaCuenta: 'EUR',
    totalFactura: 1210,
    importeCobrado: 210,
    importePendiente: 1000,
    totalFacturaCuenta: 1210,
    importeCobradoCuenta: 210,
    importePendienteCuenta: 1000,
    estado: 'OVERDUE',
    cobros: [{ id: 'k1', fecha: '2026-07-15', importe: 210, medio: 'BANCO', estado: 'ACTIVO' }],
  });
  mockPyG.mockReset().mockResolvedValue({
    actual: { partidas: [{ codigo: '1', descripcion: 'Importe neto de la cifra de negocios', importe: 50000 }], resultadoEjercicio: 15000 },
    anterior: { partidas: [], resultadoEjercicio: 9750 },
    tabla: { columnas: [{ titulo: 'Partida', tipo: 'texto', ancho: 9 }, { titulo: 'N', tipo: 'importe', ancho: 2 }, { titulo: 'N-1', tipo: 'importe', ancho: 2 }], filas: PYG_FILAS },
  });
  mockCalendario.mockReset().mockResolvedValue([
    { codigo: '303', descripcion: 'IVA', ejercicio: 2026, periodo: '2T', fechaVencimiento: '2026-07-20', estado: 'expirado', tieneBorrador: false, guardado: true },
    { codigo: '303', descripcion: 'IVA', ejercicio: 2026, periodo: '3T', fechaVencimiento: '2026-10-20', estado: 'vigente', tieneBorrador: true, guardado: true },
    { codigo: '111', descripcion: 'Retenciones', ejercicio: 2026, periodo: '3T', fechaVencimiento: '2026-10-20', estado: 'vigente', tieneBorrador: false, guardado: false },
  ]);
  mockModeloGuardado.mockReset().mockResolvedValue(null);
  mockCalcular303.mockReset().mockResolvedValue({ totalCuotaDevengada: 2100, totalCuotaDeducible: 840, resultado: 1260, resultadoFinal: 1260 });
});

const huecosDe = (id: string): HuecosResueltos =>
  id === 'INT-01' ? { terceroId: 'c1', rol: 'cliente' }
  : id === 'INT-05' ? { periodo: resolverCodigoPeriodo('este-mes', HOY)!, sentido: 'cobros' }
  : id === 'INT-13' ? { numeroFactura: 'A-012' }
  : {};

const ejecutar = (id: string, rol: string, h?: HuecosResueltos) => intencionPorId(id)!.ejecutar(construirContexto(ROLES[rol], 'E1', HOY), h ?? huecosDe(id));
const conCifras = (r: RespuestaDatos) => !r.sinPermiso && !r.sinCifras;

/** true = el rol ve las cifras de la intención. */
const MATRIZ: Record<string, Record<string, boolean>> = {
  'INT-01': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-02': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-03': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-05': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-06': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-09': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-13': { admin: true, contable: true, ventas: true, tesoreria: false, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-18': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-23': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-24': { admin: true, contable: true, ventas: false, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-25': { admin: true, contable: true, ventas: false, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-28': { admin: true, contable: true, ventas: false, tesoreria: false, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-30': { admin: true, contable: true, ventas: false, tesoreria: false, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
};

const SERVICIOS = [mockFacturasPorCobrar, mockTotalCobradoEntre, mockObtenerResumen, mockPendientes, mockPyG, mockResumenFiscal, mockListarCobros, mockCalendario, mockModeloGuardado, mockCalcular303];

const ESCRITURAS = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$|^\$(executeRaw|executeRawUnsafe|queryRawUnsafe|transaction)$/;

describe('matriz de permisos', () => {
  const casos = Object.entries(MATRIZ).flatMap(([id, roles]) => Object.entries(roles).map(([rol, ve]) => [id, rol, ve] as const));
  it.each(casos)('%s con rol %s: ve las cifras = %s', async (id, rol, ve) => {
    const r = await ejecutar(id, rol);
    expect(conCifras(r)).toBe(ve);
    if (!ve) {
      if (id === 'INT-30') {
        // Sin permiso de impuestos: los plazos generales, sin mirar la empresa.
        expect(r.sinPermiso).toBeFalsy();
        expect(!r.sinPermiso && r.sinCifras).toBe(true);
      } else {
        expect(r).toEqual({ sinPermiso: true, area: expect.any(String) });
      }
      // Sin permiso, ningún servicio de origen se llama ni se lee nada de la empresa.
      for (const s of SERVICIOS) expect(s).not.toHaveBeenCalled();
      expect(llamadas.filter((l) => !/^(customer|supplier|bankAccount)\.findMany$/.test(l))).toEqual([]);
    }
  });

  it('pagos (INT-05) piden compras o contabilidad', async () => {
    const pagos = { periodo: resolverCodigoPeriodo('este-mes', HOY)!, sentido: 'pagos' as const };
    expect(conCifras(await ejecutar('INT-05', 'contable', pagos))).toBe(true);
    expect(conCifras(await ejecutar('INT-05', 'sin rol', pagos))).toBe(false);
  });

  it('INT-09: sin el permiso de una parte, esa parte no sale; si se pregunta solo por ella, no hay cifras', async () => {
    const soloVentas = construirContexto(usuario(['ventas']), 'E1', HOY);
    const r = await intencionPorId('INT-09')!.ejecutar({ ...soloVentas, permisos: new Set(['ventas:read']) }, {});
    if (r.sinPermiso) throw new Error('sin permiso');
    expect(r.kpis?.map((k) => k.etiqueta)).toEqual(['Facturado sin IVA', 'Mismo periodo de 2025']);
    const gastos = await intencionPorId('INT-09')!.ejecutar({ ...soloVentas, permisos: new Set(['ventas:read']) }, { foco: 'gastos' });
    expect(gastos).toEqual({ sinPermiso: true, area: 'pagos' });
  });

  it('INT-13: con ventas solo busca entre las emitidas y con compras solo entre las recibidas', async () => {
    const ventas = construirContexto(ROLES.ventas, 'E1', HOY);
    await intencionPorId('INT-13')!.ejecutar({ ...ventas, permisos: new Set(['ventas:read']) }, { numeroFactura: 'A-12' });
    expect(llamadas).toContain('incomeInvoice.findMany');
    expect(llamadas).not.toContain('expenseInvoice.findMany');
    llamadas.length = 0;
    await intencionPorId('INT-13')!.ejecutar({ ...ventas, permisos: new Set(['compras:read']) }, { numeroFactura: 'A-12' });
    expect(llamadas).not.toContain('incomeInvoice.findMany');
    expect(llamadas).toContain('expenseInvoice.findMany');
  });

  it('INT-18: sin acceso a nóminas no salen los gastos de personal ni la descarga del informe', async () => {
    const lectura = await ejecutar('INT-18', 'solo-lectura');
    if (lectura.sinPermiso) throw new Error('sin permiso');
    expect(lectura.tabla?.filas.map((f) => f.celdas[0])).not.toContain('6. Gastos de personal');
    expect(JSON.stringify(lectura.tabla)).not.toMatch(/Gastos de personal|-20000|-18000/);
    expect(lectura.descargas).toBeUndefined();
    expect(lectura.avisos).toEqual(expect.arrayContaining([expect.stringMatching(/nóminas/)]));
    const contable = await ejecutar('INT-18', 'contable');
    if (contable.sinPermiso) throw new Error('sin permiso');
    expect(contable.tabla?.filas.map((f) => f.celdas[0])).toContain('6. Gastos de personal');
    expect(contable.descargas?.map((d) => d.formato)).toEqual(['pdf', 'xlsx']);
    // Con los gastos de personal, el historial pide también el acceso a nóminas.
    expect(contable.permisoRequerido).toBe('contabilidad:read;nominas:read');
    // Las guardadas antes de existir 'nominas:read' (grupo 'nominas') se tratan igual.
    expect(conservaPermiso(construirContexto(ROLES.contable, 'E1', HOY), 'contabilidad:read;nominas')).toBe(true);
    expect(conservaPermiso(construirContexto(ROLES.tesoreria, 'E1', HOY), 'contabilidad:read;nominas')).toBe(false);
    expect(construirContexto(ROLES['admin global'], 'E1', HOY).puedeNominas).toBe(true);
    expect(construirContexto(ROLES.ventas, 'E1', HOY).puedeNominas).toBe(false);
    expect(lectura.permisoRequerido).toBe('contabilidad:read');
    expect(conservaPermiso(construirContexto(ROLES.contable, 'E1', HOY), contable.permisoRequerido!)).toBe(true);
    // Si pasa a tesorería o solo lectura (siguen con contabilidad:read, pero sin nóminas), se oculta.
    expect(conservaPermiso(construirContexto(ROLES.tesoreria, 'E1', HOY), contable.permisoRequerido!)).toBe(false);
    expect(conservaPermiso(construirContexto(ROLES['solo-lectura'], 'E1', HOY), contable.permisoRequerido!)).toBe(false);
    expect(conservaPermiso(construirContexto(ROLES['solo-lectura'], 'E1', HOY), lectura.permisoRequerido!)).toBe(true);
  });

  it('el resumen (INT-39) solo enseña los bloques permitidos', async () => {
    const ventas = await ejecutar('INT-39', 'ventas');
    if (ventas.sinPermiso) throw new Error('sin permiso');
    const etiquetas = (ventas.kpis ?? []).map((k) => k.etiqueta);
    expect(etiquetas).toEqual(['Facturado este trimestre', 'Pendiente de cobro', 'Vencido sin cobrar', 'Asientos sin aprobar']);
    expect(mockObtenerResumen).not.toHaveBeenCalled();
    expect(mockCalendario).not.toHaveBeenCalled();
    const nadie = await ejecutar('INT-39', 'sin rol');
    expect(nadie.sinPermiso || nadie.sinCifras).toBe(true);
    expect(mockFacturasPorCobrar).toHaveBeenCalledTimes(1);
    const admin = await ejecutar('INT-39', 'admin');
    if (admin.sinPermiso) throw new Error('sin permiso');
    expect(admin.kpis?.map((k) => k.etiqueta)).toEqual([
      'Facturado este trimestre',
      'Pendiente de cobro',
      'Vencido sin cobrar',
      'Saldo en bancos',
      'Impuestos con plazo pasado',
      'Asientos sin aprobar',
    ]);
  });

  it('el resumen guarda los permisos de cada bloque y el historial lo oculta si se pierde uno', async () => {
    const r = await ejecutar('INT-39', 'ventas');
    if (r.sinPermiso) throw new Error('sin permiso');
    expect(r.permisoRequerido).toBe('ventas:read|contabilidad:read;contabilidad:read');
    expect(conservaPermiso(construirContexto(ROLES.ventas, 'E1', HOY), r.permisoRequerido!)).toBe(true);
    expect(conservaPermiso(construirContexto(ROLES['sin rol'], 'E1', HOY), r.permisoRequerido!)).toBe(false);
    expect(conservaPermiso(construirContexto(ROLES.tesoreria, 'E1', HOY), 'tesoreria:read')).toBe(true);
    expect(conservaPermiso(construirContexto(ROLES.ventas, 'E1', HOY), 'tesoreria:read')).toBe(false);
  });

  it('todas las intenciones del catálogo tienen ejecutor, ejemplos y una pregunta', () => {
    expect(INTENCIONES).toHaveLength(14);
    for (const i of INTENCIONES) {
      expect(typeof i.ejecutar).toBe('function');
      expect(i.ejemplos.length).toBeGreaterThanOrEqual(5);
      expect(i.pregunta).toMatch(/\S/);
    }
  });
});

describe('enlaces a la pantalla real', () => {
  it.each(INTENCIONES.map((i) => [i.id] as const))('%s: cada enlace existe en el menú de la app y las descargas son de informes', async (id) => {
    const variantes: HuecosResueltos[] = [huecosDe(id), { soloVencidas: true }, { terceroId: 'p1', rol: 'proveedor' }, { periodo: resolverCodigoPeriodo('esta-semana', HOY)! }];
    for (const h of variantes) {
      const r = await ejecutar(id, 'admin', h);
      if (r.sinPermiso) continue;
      for (const e of r.enlaces ?? []) expect({ href: e.href, valido: hrefValido(e.href) }).toEqual({ href: e.href, valido: true });
      for (const d of r.descargas ?? []) expect(d.ruta).toMatch(/^\/informes-contables\/[a-z-]+\?.*formato=(pdf|xlsx)$/);
    }
  });
});

describe('solo lectura', () => {
  it.each(INTENCIONES.map((i) => [i.id] as const))('%s no crea, actualiza ni borra nada', async (id) => {
    for (const rol of ['admin', 'ventas', 'sin rol']) await ejecutar(id, rol);
    expect(llamadas.filter((l) => ESCRITURAS.test(l))).toEqual([]);
  });
});

describe('contrato de cifras', () => {
  it('INT-02: las cifras son las de facturasPorCobrar', async () => {
    const r = await ejecutar('INT-02', 'admin');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockFacturasPorCobrar).toHaveBeenCalledWith('E1', HOY);
    expect(r.kpis).toEqual([
      { etiqueta: 'Pendiente de cobro', valor: '1.736,00 €', detalle: '3 facturas' },
      { etiqueta: 'Vencido', valor: '1.615,00 €', detalle: '2 facturas' },
    ]);
    expect(r.texto).toBe(
      'Tienes 1.736,00 € pendientes de cobro en 3 facturas de 2 clientes; 1.615,00 € ya han vencido. Cuenta el total de cada factura emitida menos los cobros registrados hasta hoy y sus rectificativas.',
    );
    expect(r.tabla?.filas.map((f) => f.celdas[0])).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('INT-01: filtra las facturas del cliente', async () => {
    const r = await ejecutar('INT-01', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.entendido).toBe('Pendiente de cobro de CONSTRUCCIONES PÉREZ SL a 07/10/2026');
    expect(r.kpis?.[0]).toEqual({ etiqueta: 'Pendiente de cobro', valor: '1.331,00 €', detalle: '2 facturas' });
    expect(r.kpis?.[1]).toEqual({ etiqueta: 'Vencido', valor: '1.210,00 €', detalle: '1 factura' });
    expect(r.enlaces?.[0].href).toBe('/dashboard/clientes/c1');
  });

  it('INT-03: tramos de antigüedad con lo vencido', async () => {
    const r = await ejecutar('INT-03', 'admin');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.kpis?.map((k) => [k.etiqueta, k.valor])).toEqual([
      ['Total vencido', '1.615,00 €'],
      ['De 1 a 30 días', '405,00 €'],
      ['De 31 a 60 días', '0,00 €'],
      ['De 61 a 90 días', '0,00 €'],
      ['Más de 90 días', '1.210,00 €'],
    ]);
    const masDe60 = await ejecutar('INT-03', 'admin', { diasMinimos: 60 });
    expect(!masDe60.sinPermiso && masDe60.kpis?.[0].valor).toBe('1.210,00 €');
  });

  it('INT-05: el total es el de totalCobradoEntre, hasta hoy', async () => {
    const r = await ejecutar('INT-05', 'admin');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockTotalCobradoEntre).toHaveBeenCalledWith('E1', 'INGRESO', '2026-10-01', HOY, undefined);
    expect(r.kpis?.[0]).toEqual({ etiqueta: 'Total cobrado', valor: '2.345,60 €', detalle: '4 cobros' });
    expect(r.texto).toMatch(/^En octubre de 2026 \(hasta hoy\) has cobrado 2\.345,60 € en 4 cobros registrados\./);
  });

  it('INT-06: lo pendiente con proveedores es el de pendientesSegunFacturas, por proveedor, vencido o de un periodo', async () => {
    const r = await ejecutar('INT-06', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockPendientes).toHaveBeenCalledWith('E1', 'proveedores', HOY);
    expect(r.texto).toMatch(/^Debes 573,50 € a tus proveedores en 3 facturas de 2 proveedores\. 1 está vencida \(302,50 €\)\./);
    expect(r.tabla?.filas.map((f) => f.celdas[0])).toEqual(['LUZ-7', 'R-88', 'LUZ-8']);
    expect(r.tabla?.filas[0].celdas[3]).toBe('37 días');

    const iberdrola = await ejecutar('INT-06', 'contable', { terceroId: 'p1', rol: 'proveedor' });
    expect(!iberdrola.sinPermiso && iberdrola.texto).toMatch(/^Le debes 452,50 € a IBERDROLA CLIENTES SAU en 2 facturas\./);
    expect(!iberdrola.sinPermiso && iberdrola.enlaces?.[0].href).toBe('/dashboard/proveedores/p1');

    const vencidas = await ejecutar('INT-06', 'contable', { soloVencidas: true });
    expect(!vencidas.sinPermiso && vencidas.kpis?.[0]).toEqual({ etiqueta: 'Vencido sin pagar', valor: '302,50 €', detalle: '1 factura' });

    const semana = await ejecutar('INT-06', 'contable', { periodo: resolverCodigoPeriodo('esta-semana', HOY)! });
    expect(!semana.sinPermiso && semana.texto).toMatch(
      /^Con vencimiento en esta semana tienes 1 factura de proveedores por 121,00 €\. Además tienes 1 factura vencida de antes sin pagar por 302,50 €\./,
    );
  });

  it('INT-09: lo facturado y lo gastado son los de resumenFiscalPeriodo, frente al mismo periodo del año anterior', async () => {
    const r = await ejecutar('INT-09', 'admin', { periodo: resolverCodigoPeriodo('este-trimestre', HOY)! });
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockResumenFiscal).toHaveBeenCalledWith('E1', '2026-10-01', HOY, undefined);
    expect(mockResumenFiscal).toHaveBeenCalledWith('E1', '2025-10-01', '2025-10-07', undefined);
    expect(r.texto).toMatch(
      /^En este trimestre \(4T de 2026\), hasta hoy, has facturado 10\.000,00 € en 5 facturas; en el mismo periodo de 2025, 8\.000,00 € \(\+25,0 %\)\. Has gastado 4\.000,00 € en 8 facturas; en el mismo periodo de 2025 no hay facturas\./,
    );
    expect(r.kpis?.map((k) => k.valor)).toEqual(['10.000,00 €', '8.000,00 €', '4.000,00 €', '0,00 €']);
    const soloGastos = await ejecutar('INT-09', 'admin', { foco: 'gastos' });
    expect(!soloGastos.sinPermiso && soloGastos.kpis?.map((k) => k.etiqueta)).toEqual(['Gastado sin IVA', 'Gastos en 2025']);
  });

  it('empresa no establecida en España: INT-09 sin filas de IVA e INT-39 sin impuestos ni plazos de la AEAT', async () => {
    const extranjera = construirContexto(ROLES.admin, 'E1', HOY, { espanola: false, monedaCuenta: 'USD' });
    const r = await intencionPorId('INT-09')!.ejecutar(extranjera, { periodo: resolverCodigoPeriodo('este-trimestre', HOY)! });
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.kpis?.map((k) => k.etiqueta)).toEqual(['Facturado sin impuestos', 'Mismo periodo de 2025', 'Gastado sin impuestos', 'Gastos en 2025']);
    expect(r.tabla?.filas.map((f) => f.celdas[0])).toEqual(['Ventas (base imponible)', 'Gastos (base imponible)']);
    expect(r.texto).not.toMatch(/IVA/);
    mockCalendario.mockClear();
    const resumen = await intencionPorId('INT-39')!.ejecutar(extranjera, {});
    if (resumen.sinPermiso) throw new Error('sin permiso');
    expect(resumen.kpis?.map((k) => k.etiqueta)).not.toContain('Impuestos con plazo pasado');
    expect(resumen.texto).not.toMatch(/plazo fiscal|modelo|IVA/);
    expect((resumen.botones ?? []).some((b) => b.accion.tipo === 'intencion' && b.accion.id === 'INT-30')).toBe(false);
    expect(mockCalendario).not.toHaveBeenCalled();
  });

  it('INT-13: busca sin ceros a la izquierda y da el estado de cobro de listarCobros', async () => {
    expect(claveNumeroFactura('2026-0045')).toBe(claveNumeroFactura('2026-45'));
    expect(claveNumeroFactura('a-012')).toBe('A12');
    // Lo pendiente de una emitida es el de facturasPorCobrar (el mismo que el panel).
    mockFacturasPorCobrar.mockResolvedValue({ ...FACTURAS, facturas: [{ ...FACTURAS.facturas[0], numeroCompleto: 'A-12', cobrado: 210, pendiente: 1000 }] });
    const r = await ejecutar('INT-13', 'ventas');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockListarCobros).toHaveBeenCalledWith('E1', 'INGRESO', 'f1');
    expect(r.texto).toBe(
      'La factura A-12 emitida a CONSTRUCCIONES PÉREZ SL, del 01/06/2026, es de 1.210,00 €. Lleva 210,00 € cobrados y quedan 1.000,00 € pendientes de cobro. Venció el 01/07/2026 (hace 98 días).',
    );
    expect(r.enlaces).toEqual([{ texto: 'Abrir la factura A-12', href: '/dashboard/facturas/f1' }]);
    const ninguna = await ejecutar('INT-13', 'ventas', { numeroFactura: 'Z-9' });
    expect(!ninguna.sinPermiso && ninguna.sinCifras).toBe(true);
  });

  it('INT-13: sin borradores antiguos (estado DRAFT), y con las rectificativas como en el panel de cobros', async () => {
    await ejecutar('INT-13', 'ventas');
    // La búsqueda de emitidas deja fuera los borradores antiguos (estado DRAFT con documento FINAL).
    const busqueda = (argumentos['incomeInvoice.findMany'] as Array<[{ where: Record<string, unknown> }]>).find(([a]) => 'numero' in a.where)!;
    expect(busqueda[0].where).toMatchObject({ companyId: 'E1', numero: 12, estado: { not: 'DRAFT' } });

    // A-12 de 1.210 € con una rectificativa por diferencias de -1.210 €: facturasPorCobrar ya no la lista.
    rectificativas = [{ id: 'r1', numeroCompleto: 'R-1', tipoRectificativa: 'I', totalFactura: -1210, fechaEmision: '2026-07-10' }];
    mockFacturasPorCobrar.mockResolvedValue({ ...FACTURAS, facturas: FACTURAS.facturas.filter((f) => f.id !== 'f1') });
    const abonada = await ejecutar('INT-13', 'ventas');
    if (!conCifras(abonada) || abonada.sinPermiso) throw new Error('sin cifras');
    expect(abonada.texto).toContain('No queda nada pendiente de cobro: la rectificativa R-1 la abona.');
    expect(abonada.kpis?.find((k) => k.etiqueta === 'Pendiente')?.valor).toBe('0,00 €');

    // Sustituida por una rectificativa de tipo S: remite a la nueva.
    rectificativas = [{ id: 'r2', numeroCompleto: 'R-2', tipoRectificativa: 'S', totalFactura: 1000, fechaEmision: '2026-07-10' }];
    const sustituida = await ejecutar('INT-13', 'ventas');
    expect(!sustituida.sinPermiso && sustituida.texto).toMatch(/está sustituida por la rectificativa R-2 \(por sustitución\): ya no cuenta/);
    // La sustituida no mira sus cobros: solo la búsqueda inicial y la abonada.
    expect(mockListarCobros).toHaveBeenCalledTimes(2);
  });

  it('INT-13: una rectificativa en negativo se describe como abono de la original, no como «cobrada»', async () => {
    lecturas['incomeInvoice.findFirst'] = async () => ({ numeroCompleto: 'A-7' });
    const original = lecturas['incomeInvoice.findMany'];
    lecturas['incomeInvoice.findMany'] = async (args: unknown) =>
      (args as { where?: { facturaOriginalId?: string } })?.where?.facturaOriginalId !== undefined
        ? []
        : [{ id: 'r9', numeroCompleto: 'R-12', estadoDocumento: 'FINAL', fechaEmision: '2026-08-01', fechaVencimiento: '2026-08-01', totalFactura: -1210, facturaOriginalId: 'f7', tipoRectificativa: 'I', customer: { nombreFiscal: 'CONSTRUCCIONES PÉREZ SL' } }];
    try {
      const r = await ejecutar('INT-13', 'ventas', { numeroFactura: 'R-12' });
      if (r.sinPermiso) throw new Error('sin permiso');
      expect(r.texto).toMatch(/^La factura R-12 es una rectificativa en negativo \(un abono\) de la factura A-7/);
      expect(r.texto).not.toMatch(/Está cobrada/);
      expect(mockListarCobros).not.toHaveBeenCalled();
    } finally {
      lecturas['incomeInvoice.findMany'] = original;
      delete lecturas['incomeInvoice.findFirst'];
    }
  });

  it('INT-09 e INT-05 con un cliente o un proveedor: solo sus facturas, y la respuesta lo nombra', async () => {
    const facturado = await ejecutar('INT-09', 'admin', { periodo: resolverCodigoPeriodo('este-anio', HOY)!, foco: 'ventas', terceroId: 'c1', rol: 'cliente' });
    if (!conCifras(facturado) || facturado.sinPermiso) throw new Error('sin cifras');
    expect(mockResumenFiscal).toHaveBeenCalledWith('E1', '2026-01-01', HOY, { customerId: 'c1' });
    expect(facturado.entendido).toMatch(/^Facturado a CONSTRUCCIONES PÉREZ SL en lo que va de 2026/);
    expect(facturado.texto).toMatch(/^En lo que va de 2026 le has facturado a CONSTRUCCIONES PÉREZ SL 10\.000,00 €/);
    expect(facturado.botones?.[0].accion).toMatchObject({ huecos: { terceroId: 'c1', rol: 'cliente' } });

    const gastos = await ejecutar('INT-09', 'admin', { periodo: resolverCodigoPeriodo('este-anio', HOY)!, foco: 'gastos', terceroId: 'p1', rol: 'proveedor' });
    if (!conCifras(gastos) || gastos.sinPermiso) throw new Error('sin cifras');
    expect(mockResumenFiscal).toHaveBeenCalledWith('E1', '2026-01-01', HOY, { supplierId: 'p1' });
    expect(gastos.entendido).toMatch(/^Gastado con IBERDROLA CLIENTES SAU/);

    const cobrado = await ejecutar('INT-05', 'admin', { periodo: resolverCodigoPeriodo('este-mes', HOY)!, sentido: 'cobros', terceroId: 'c1', rol: 'cliente' });
    if (!conCifras(cobrado) || cobrado.sinPermiso) throw new Error('sin cifras');
    // Solo los cobros de las facturas de ese cliente.
    expect(mockTotalCobradoEntre).toHaveBeenCalledWith('E1', 'INGRESO', '2026-10-01', HOY, ['f1', 'f9']);
    expect((argumentos['incomeInvoice.findMany'] as Array<[{ where: Record<string, unknown> }]>)[0][0].where).toEqual({ companyId: 'E1', customerId: 'c1' });
    expect(cobrado.texto).toMatch(/^En octubre de 2026 \(hasta hoy\) CONSTRUCCIONES PÉREZ SL te ha pagado 2\.345,60 €/);
  });

  it('INT-18: el resultado es el de informePerdidasGanancias, hasta hoy, con el aviso de los asientos sin aprobar', async () => {
    const r = await ejecutar('INT-18', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockPyG).toHaveBeenCalledWith('E1', { desde: '2026-01-01', hasta: HOY, ejercicio: 2026 });
    expect(r.kpis).toEqual([
      { etiqueta: 'Cifra de negocios', valor: '50.000,00 €' },
      { etiqueta: 'Resultado', valor: '15.000,00 €', detalle: '01/01/2026 a 07/10/2026' },
      { etiqueta: 'Mismo periodo de 2025', valor: '9.750,00 €' },
    ]);
    expect(r.texto).toMatch(/^En lo que va de 2026 vas en beneficios: 15\.000,00 €/);
    expect(r.avisos?.[0]).toMatch(/^Hay 4 asientos sin aprobar/);
    const dosAnios = await ejecutar('INT-18', 'contable', { periodo: resolverCodigoPeriodo('2025-12-15_2026-01-15', HOY)! });
    expect(!dosAnios.sinPermiso && dosAnios.sinCifras).toBe(true);
  });

  it('INT-28: el modelo guardado manda; si no hay, calcularModelo303 del trimestre', async () => {
    const calculado = await ejecutar('INT-28', 'contable');
    if (!conCifras(calculado) || calculado.sinPermiso) throw new Error('sin cifras');
    expect(mockModeloGuardado).toHaveBeenCalledWith('E1', '303', 2026, '3T');
    expect(mockCalcular303).toHaveBeenCalledWith('E1', { ejercicio: 2026, periodo: '3T', tipo: 'trimestral', fechaInicio: '2026-07-01', fechaFin: '2026-09-30' });
    expect(calculado.texto).toMatch(/^El 303 del 3T de 2026 sale a ingresar 1\.260,00 €\. Todavía no lo tienes guardado/);
    expect(calculado.texto).toContain('hasta el 20/10/2026 (quedan 13 días)');

    mockModeloGuardado.mockResolvedValue({ id: 'm1', estado: 'presentado', origen: 'manual-mixto', casillas: { '71_resultado': -300.5, '27_total_devengado': 100, '45_total_deducir': 400.5 } });
    const guardado = await ejecutar('INT-28', 'contable');
    if (guardado.sinPermiso) throw new Error('sin permiso');
    expect(mockCalcular303).toHaveBeenCalledTimes(1);
    expect(guardado.kpis?.map((k) => k.valor)).toEqual(['100,00 €', '400,50 €', '-300,50 €']);
    expect(guardado.texto).toBe(
      'El 303 del 3T de 2026 sale negativo, 300,50 €, que se compensa en los trimestres siguientes. Es el importe del modelo guardado en Fiscalidad → Modelo 303, con cambios hechos a mano. En la app consta como presentado.',
    );
  });

  it('INT-28: «este trimestre» en plazo del anterior es el que toca presentar; el que está en curso, en un botón', async () => {
    const r = await ejecutar('INT-28', 'contable', { periodo: resolverCodigoPeriodo('este-trimestre', HOY)! });
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.entendido).toBe('IVA del 3T de 2026 (modelo 303)');
    expect(mockModeloGuardado).toHaveBeenCalledWith('E1', '303', 2026, '3T');
    expect(r.avisos?.[0]).toMatch(/^Te enseño el 3T de 2026, que es el que toca presentar \(hasta el 20\/10\/2026\)\. El 4T acaba de empezar/);
    expect(r.botones).toEqual([{ texto: 'Ver el 4T, en curso', accion: { tipo: 'intencion', id: 'INT-28', huecos: { periodo: '2026-4T' } } }]);
    // El botón pide el 4T con su código: no vuelve al 3T.
    const cuarto = await ejecutar('INT-28', 'contable', { periodo: resolverCodigoPeriodo('2026-4T', HOY)! });
    expect(!cuarto.sinPermiso && cuarto.entendido).toBe('IVA del 4T de 2026 (modelo 303)');
    // Pasado el 20 de octubre, «este trimestre» ya es el 4T.
    const tarde = await intencionPorId('INT-28')!.ejecutar(construirContexto(ROLES.contable, 'E1', '2026-10-25'), { periodo: resolverCodigoPeriodo('este-trimestre', '2026-10-25')! });
    expect(!tarde.sinPermiso && tarde.entendido).toBe('IVA del 4T de 2026 (modelo 303)');
  });

  it('INT-28: lee también el 303 guardado por la pantalla Modelo 303 y no recalcula uno presentado', async () => {
    // Formato de tax-models: casillas '02' (repercutido) y '06' (soportado) con { valor }.
    mockModeloGuardado.mockResolvedValue({ id: 'm2', estado: 'presentado', origen: 'autorrelleno', casillas: { '02': { numero: '02', valor: 2100 }, '06': { numero: '06', valor: 840 }, '13': { valor: 1260 } } });
    const r = await ejecutar('INT-28', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockCalcular303).not.toHaveBeenCalled();
    expect(r.texto).toBe('El 303 del 3T de 2026 sale a ingresar 1.260,00 €. Es el importe del modelo guardado en Fiscalidad → Modelo 303. En la app consta como presentado.');
    expect(r.texto).not.toMatch(/no lo tienes guardado/);

    // Presentado pero sin resultado legible: no se recalcula con las facturas de hoy.
    mockModeloGuardado.mockResolvedValue({ id: 'm3', estado: 'presentado', origen: 'manual', casillas: { otra: 'cosa' } });
    const ilegible = await ejecutar('INT-28', 'contable');
    expect(mockCalcular303).not.toHaveBeenCalled();
    expect(!ilegible.sinPermiso && ilegible.sinCifras).toBe(true);
    expect(!ilegible.sinPermiso && ilegible.texto).toMatch(/consta como presentado en la app, pero no puedo leer su resultado/);

    // Guardado sin presentar y sin resultado legible: se calcula, sin decir que no está guardado.
    mockModeloGuardado.mockResolvedValue({ id: 'm4', estado: 'vigente', origen: 'manual', casillas: {} });
    const borrador = await ejecutar('INT-28', 'contable');
    expect(!borrador.sinPermiso && borrador.texto).toMatch(/Lo tienes guardado en la app, pero no puedo leer su resultado: lo calculo/);
  });

  it('INT-30: con permiso, el estado de los modelos de la empresa sin crear nada', async () => {
    const r = await ejecutar('INT-30', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(mockCalendario).toHaveBeenCalledWith('E1', HOY);
    expect(r.texto).toMatch(/^Tienes 1 modelo con el plazo ya pasado que en la app no consta como presentado ni omitido: el 303 del 2T de 2026\. El próximo es el 303/);
    expect(r.tabla?.filas.map((f) => f.celdas[4])).toEqual(['Plazo pasado', 'Preparado', 'Pendiente']);
    const ventas = await ejecutar('INT-30', 'ventas');
    expect(!ventas.sinPermiso && ventas.tabla?.titulo).toBe('Próximos plazos generales');
  });

  it('INT-24: el saldo es el de obtenerResumen, con la fecha del último extracto', async () => {
    const r = await ejecutar('INT-24', 'tesoreria');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.texto).toBe('El saldo de tus 2 cuentas es 15.000,25 €, según los extractos importados hasta el 05/10/2026.');
    const una = await ejecutar('INT-24', 'tesoreria', { ibanFinal: '5678' });
    expect(!una.sinPermiso && una.texto).toBe('El saldo de BBVA …5678 es 5.000,00 €, según los extractos importados hasta el 05/10/2026.');
    // El IBAN completo no sale nunca: solo los 4 últimos dígitos.
    expect(JSON.stringify(r)).not.toMatch(/ES00 0000/);
  });

  it('INT-24: con un banco de la pregunta, solo esa cuenta', async () => {
    const r = await ejecutar('INT-24', 'tesoreria', { terceroId: 'b2', rol: 'banco' });
    expect(!r.sinPermiso && r.texto).toBe('El saldo de BBVA …5678 es 5.000,00 €, según los extractos importados hasta el 05/10/2026.');
  });

  it('INT-25: filtra por texto e importe en memoria', async () => {
    const r = await ejecutar('INT-25', 'tesoreria', { texto: 'repsol' });
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.tabla?.filas).toHaveLength(1);
    expect(r.kpis).toEqual([
      { etiqueta: 'Entradas', valor: '0,00 €' },
      { etiqueta: 'Salidas', valor: '60,50 €' },
    ]);
    const grandes = await ejecutar('INT-25', 'tesoreria', { importeMinimo: 1000 });
    expect(!grandes.sinPermiso && grandes.tabla?.filas).toHaveLength(1);
  });

  it('INT-23: cuenta borradores y pendientes de revisión', async () => {
    const r = await ejecutar('INT-23', 'contable');
    if (!conCifras(r) || r.sinPermiso) throw new Error('sin cifras');
    expect(r.texto).toMatch(/^Tienes 5 asientos sin aprobar: 2 borradores y 3 pendientes de revisión\./);
  });
});
