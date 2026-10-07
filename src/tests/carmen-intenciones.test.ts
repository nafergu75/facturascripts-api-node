/**
 * Carmen, intenciones de datos: matriz de permisos por rol, solo lectura y
 * contrato de cifras (cada cifra de la respuesta es la del servicio de origen).
 * Prisma y los servicios de origen, simulados.
 */
const llamadas: string[] = [];
const lecturas: Record<string, (...a: unknown[]) => unknown> = {
  'journalEntry.count': async (args: unknown) => ((args as { where: { estado: string } }).where.estado === 'DRAFT' ? 2 : 3),
  'journalEntry.findMany': async () => [{ fecha: new Date('2026-09-01T00:00:00Z'), numeroAsiento: 'FAC-ING-1', descripcion: 'Factura A-1', estado: 'DRAFT' }],
  'bankMovement.aggregate': async () => ({ _max: { fecha: '2026-10-05' } }),
  'bankMovement.findMany': async () => [
    { fecha: '2026-10-05', importe: -60.5, concepto: 'RECIBO REPSOL', cuentaBancaria: { bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' } },
    { fecha: '2026-10-04', importe: 1210, concepto: 'TRANSFERENCIA CONSTRUCCIONES PEREZ', cuentaBancaria: { bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' } },
  ],
  'invoicePayment.count': async () => 4,
  'customer.findMany': async () => [{ id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' }],
  'supplier.findMany': async () => [],
  'bankAccount.findMany': async () => [{ id: 'b1', bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' }],
};
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
const mockObtenerResumen = jest.fn();
jest.mock('../services/cobrosClientes.service', () => ({ facturasPorCobrar: (...a: unknown[]) => mockFacturasPorCobrar(...a) }));
jest.mock('../services/cobrosPagos.service', () => ({ totalCobradoEntre: (...a: unknown[]) => mockTotalCobradoEntre(...a) }));
jest.mock('../services/treasury.service', () => ({ obtenerResumen: (...a: unknown[]) => mockObtenerResumen(...a) }));

import { construirContexto } from '../services/carmen/contexto';
import { INTENCIONES, intencionPorId } from '../services/carmen/intenciones/catalogo';
import { olvidarIndices } from '../services/carmen/terceros';
import { resolverCodigoPeriodo } from '../services/carmen/huecos/periodo';
import { conservaPermiso } from '../services/carmen/sesiones';
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

beforeEach(() => {
  llamadas.length = 0;
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
});

const huecosDe = (id: string): HuecosResueltos =>
  id === 'INT-01' ? { terceroId: 'c1', rol: 'cliente' } : id === 'INT-05' ? { periodo: resolverCodigoPeriodo('este-mes', HOY)!, sentido: 'cobros' } : {};

const ejecutar = (id: string, rol: string, h?: HuecosResueltos) => intencionPorId(id)!.ejecutar(construirContexto(ROLES[rol], 'E1', HOY), h ?? huecosDe(id));
const conCifras = (r: RespuestaDatos) => !r.sinPermiso && !r.sinCifras;

/** true = el rol ve las cifras de la intención. */
const MATRIZ: Record<string, Record<string, boolean>> = {
  'INT-01': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-02': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-03': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-05': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-23': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-24': { admin: true, contable: true, ventas: false, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-25': { admin: true, contable: true, ventas: false, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
};
/** Las que por ahora solo llevan a su pantalla: true = el rol puede ir. */
const PANTALLA: Record<string, Record<string, boolean>> = {
  'INT-06': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-28': { admin: true, contable: true, ventas: false, tesoreria: false, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
  'INT-18': { admin: true, contable: true, ventas: true, tesoreria: true, 'solo-lectura': true, 'sin rol': false, 'admin global': true },
};

const ESCRITURAS = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$|^\$(executeRaw|executeRawUnsafe|queryRawUnsafe|transaction)$/;

describe('matriz de permisos', () => {
  const casos = Object.entries(MATRIZ).flatMap(([id, roles]) => Object.entries(roles).map(([rol, ve]) => [id, rol, ve] as const));
  it.each(casos)('%s con rol %s: ve las cifras = %s', async (id, rol, ve) => {
    const r = await ejecutar(id, rol);
    expect(conCifras(r)).toBe(ve);
    if (!ve) {
      expect(r).toEqual({ sinPermiso: true, area: intencionPorId(id)!.area === 'resumen' ? 'resumen' : expect.any(String) });
      // Sin permiso, el servicio de origen NO se llama.
      expect(mockFacturasPorCobrar).not.toHaveBeenCalled();
      expect(mockTotalCobradoEntre).not.toHaveBeenCalled();
      expect(mockObtenerResumen).not.toHaveBeenCalled();
      expect(llamadas.filter((l) => !/^(customer|supplier|bankAccount)\.findMany$/.test(l))).toEqual([]);
    }
  });

  const pantallas = Object.entries(PANTALLA).flatMap(([id, roles]) => Object.entries(roles).map(([rol, puede]) => [id, rol, puede] as const));
  it.each(pantallas)('%s (solo pantalla) con rol %s: puede ir = %s', async (id, rol, puede) => {
    const r = await ejecutar(id, rol);
    expect(!r.sinPermiso).toBe(puede);
    expect(llamadas).toEqual([]);
  });

  it('pagos (INT-05) piden compras o contabilidad', async () => {
    const pagos = { periodo: resolverCodigoPeriodo('este-mes', HOY)!, sentido: 'pagos' as const };
    expect(conCifras(await ejecutar('INT-05', 'contable', pagos))).toBe(true);
    expect(conCifras(await ejecutar('INT-05', 'sin rol', pagos))).toBe(false);
  });

  it('el resumen (INT-39) solo enseña los bloques permitidos', async () => {
    const ventas = await ejecutar('INT-39', 'ventas');
    if (ventas.sinPermiso) throw new Error('sin permiso');
    const etiquetas = (ventas.kpis ?? []).map((k) => k.etiqueta);
    expect(etiquetas).toEqual(expect.arrayContaining(['Pendiente de cobro', 'Asientos sin aprobar']));
    expect(etiquetas).not.toContain('Saldo en bancos');
    expect(mockObtenerResumen).not.toHaveBeenCalled();
    const nadie = await ejecutar('INT-39', 'sin rol');
    expect(nadie.sinPermiso || nadie.sinCifras).toBe(true);
    expect(mockFacturasPorCobrar).toHaveBeenCalledTimes(1);
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

describe('solo lectura', () => {
  it.each(INTENCIONES.map((i) => [i.id] as const))('%s no crea, actualiza ni borra nada', async (id) => {
    await ejecutar(id, 'admin');
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
    expect(mockTotalCobradoEntre).toHaveBeenCalledWith('E1', 'INGRESO', '2026-10-01', HOY);
    expect(r.kpis?.[0]).toEqual({ etiqueta: 'Total cobrado', valor: '2.345,60 €', detalle: '4 cobros' });
    expect(r.texto).toMatch(/^En octubre de 2026 \(hasta hoy\) has cobrado 2\.345,60 € en 4 cobros registrados\./);
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
