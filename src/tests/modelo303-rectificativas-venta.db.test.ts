/**
 * 303 con rectificativas de venta (B8):
 *  - por sustitución, solo la diferencia con la original (antes contaba la
 *    factura corregida entera y el IVA salía dos veces: observación 17.1);
 *  - por diferencias, lo que restan, en [14]/[15] del periodo de la rectificativa;
 *  - una R4 que sube el IVA va al periodo de la original (art. 89.Cinco LIVA).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { calcularModelo303, obtenerFacturasFiscales } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { resumenFiscalPeriodo } from '../services/resumenFiscal.service';

const E = `m303-rect-venta-${Date.now()}`;
let cliente = '';
const HOY = new Date().toISOString().slice(0, 10);
const trimestreDe = (f: string) => `${Math.ceil(Number(f.slice(5, 7)) / 3)}T`;

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const emitir = (fecha: string, base: number) =>
  incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, fechaEmision: fecha, lineas: [linea(base)] } as CrearFacturaIngresoDTO);
const rect = (rectificativa: Record<string, unknown>, base: number) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas: [linea(base)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Rectificación', ...rectificativa },
  } as unknown as CrearFacturaIngresoDTO);
const casillas = async (periodo: string) => (await calcularModelo303(E, periodoFiscal(Number(HOY.slice(0, 4)), periodo))).casillasOficiales ?? {};

let originalS = '';
let sustituta = '';

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: '303 Rectificativas Venta SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: '303 Rectificativas Venta SL', nif: 'B40000006' } });
  await prisma.ajustesFiscales.create({ data: { companyId: E, inicioEnApp: `${HOY.slice(0, 4)}-01-01` } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente 303 SL', nifCif: 'B50000051' } })).id;
  // Originales del 1T (la de hoy, en otro trimestre); rectificativas de hoy.
  const anio = HOY.slice(0, 4);
  const a = await emitir(`${anio}-01-15`, 100);
  const b = await emitir(`${anio}-02-10`, 200);
  const c = await emitir(`${anio}-03-01`, 100);
  originalS = a.id;
  sustituta = (await rect({ forma: 'S', motivo: 'ERROR', explicacion: 'El precio era 80', originales: [{ id: a.id }] }, 80)).id;
  await rect({ originales: [{ id: b.id }] }, -50);
  // R4 que sube el IVA: va al 1T, el de la original.
  await rect({ motivo: 'ERROR', explicacion: 'Faltaba un servicio', originales: [{ id: c.id }] }, 10);
});

describe('303 con rectificativas de venta', () => {
  it('la sustitución aporta la diferencia por tipo de IVA, no la factura entera', async () => {
    const anio = HOY.slice(0, 4);
    const fiscales = await obtenerFacturasFiscales(E, `${anio}-01-01`, `${anio}-12-31`);
    const s = fiscales.find((f) => f.rectificativa && f.lineas.some((l) => l.base === -20));
    expect(s?.lineas).toEqual([{ tipoIva: 21, base: -20, cuota: -4.2 }]);
    expect(fiscales.filter((f) => f.lineas.some((l) => l.base === 80))).toEqual([]);
    expect(originalS && sustituta).toBeTruthy();
  });

  it('en el periodo de hoy: [14]/[15] = sustitución (-20 / -4,20) + abono (-50 / -10,50); la R4 que sube no está', async () => {
    const c = await casillas(trimestreDe(HOY));
    expect([Number(c['14']), Number(c['15'])]).toEqual([-70, -14.7]);
  });

  it('el resumen fiscal (panel y Carmen) cuenta lo mismo: la diferencia de la sustitución y el devengo de la R4', async () => {
    const anio = Number(HOY.slice(0, 4));
    const hoy = periodoFiscal(anio, trimestreDe(HOY));
    expect((await resumenFiscalPeriodo(E, hoy.fechaInicio, hoy.fechaFin)).ventas).toMatchObject({ base: -70, iva: -14.7 });
    const t1 = periodoFiscal(anio, '1T');
    expect((await resumenFiscalPeriodo(E, t1.fechaInicio, t1.fechaFin)).ventas).toMatchObject({ facturas: 4, base: 410, iva: 86.1 });
  });

  it('en el 1T: las tres ventas en el 21 % y la R4 que sube el IVA en [14]/[15]', async () => {
    const c = await casillas('1T');
    expect([Number(c['07']), Number(c['09'])]).toEqual([400, 84]);
    expect([Number(c['14']), Number(c['15'])]).toEqual([10, 2.1]);
  });
});
