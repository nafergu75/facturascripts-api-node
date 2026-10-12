/**
 * Abonos de proveedor de 2027 sobre facturas de 2026 que la gestoria trajo
 * pendientes (partidas de «Traer la contabilidad de 2026»): lo que se descuenta
 * con el abono rebaja la partida una sola vez, nunca de mas, y al anularlo
 * vuelve a estar pendiente.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { listarPartidas, liquidarPartida, resumenPendiente } from '../services/arranque/partidas.service';
import { registrarGasto, anularGasto } from '../services/expense-invoices.service';
import { anularCompensacion, aplicarAbono } from '../services/compensacionesGasto.service';
import { pendiente2026 } from '../services/carmen/intenciones/pendiente2026';
import { buscarOriginales } from '../services/rectificativasGasto.service';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const E = `arr-abonos-${Date.now()}`;

const lin = (precio: number) => ({ descripcion: 'Devolución', cantidad: 1, precioUnitario: precio, tipoIva: 21, cuenta: '608' });

/** Abono con una original de fuera de la app («No, se descuenta de lo que le debo»). */
const abonoFuera = (supplierId: string, numero: string, precio: number, original: { numero: string; fecha: string }) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: '2027-01-20',
  tipoGasto: 'COMPRA',
  lineas: [lin(precio)],
  rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [original], yaPagada: false },
});

/** Abono sin original elegida, que queda a favor para aplicarlo a mano. */
const abonoSuelto = (supplierId: string, numero: string, precio: number) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: '2027-01-21',
  tipoGasto: 'COMPRA',
  lineas: [lin(precio)],
  rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ numero: 'OTRA-1', fecha: '2026-06-01' }], yaPagada: true },
});

async function error(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    return { status: (e as { statusCode: number }).statusCode, message: (e as Error).message };
  }
  throw new Error('No dio error');
}

const partida = (doc: string) => prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: doc, estado: { not: 'ANULADA' } } });
const vista = async (doc: string) => (await listarPartidas(E, { tipos: ['PAGO'] })).partidas.find((p) => p.numeroDocumento === doc)!;
const proveedor = (subcuenta: string) => prisma.supplier.findFirstOrThrow({ where: { companyId: E, OR: [{ subcuenta400: subcuenta }, { subcuenta410: subcuenta }] } });

describe('abonos de 2027 sobre facturas pendientes de 2026', () => {
  let banco = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
    banco = (await prisma.bankAccount.findFirstOrThrow({ where: { companyId: E, subcuentaCodigo: '5720000001' } })).id;
  }, 120_000);

  it('el buscador de la original del abono ofrece las facturas de 2026 pendientes del proveedor, con lo que queda', async () => {
    const dos = await proveedor('4000000002');
    const r = await buscarOriginales(E, { supplierId: dos.id, numero: 'fd-12' });
    expect(r.candidatas).toEqual([]);
    expect(r.partidasFuera[0]).toMatchObject({ numero: 'FD-12', fecha: '2026-03-15', pendiente: 2420, exacta: true });
    // Sin número, todas las vivas de ese proveedor; nunca las de otro.
    const todas = await buscarOriginales(E, { supplierId: dos.id });
    expect(todas.partidasFuera.map((p) => p.numero)).toContain('FD-12');
    expect(todas.partidasFuera.every((p) => p.exacta === false && p.pendiente > 0)).toBe(true);
    const luz = await proveedor('4100000001');
    expect((await buscarOriginales(E, { supplierId: luz.id })).partidasFuera.map((p) => p.numero)).not.toContain('FD-12');
  });

  it('«se descuenta de lo que le debo» rebaja la partida de esa factura y la deja en parte pagada', async () => {
    const dos = await proveedor('4000000002');
    await registrarGasto(E, abonoFuera(dos.id, 'AB-1', -1000, { numero: 'FD-12', fecha: '2026-03-15' }), { contabilizar: 'POSTED' });
    const p = await vista('FD-12');
    expect(p).toMatchObject({ importeInicial: 2420, liquidado: 1210, compensado: 1210, pendiente: 1210, estado: 'PARCIAL' });
    // Pagar más de lo que queda ya no se puede: el abono ya está descontado.
    const e = await error(liquidarPartida(E, p.id, { fecha: '2027-02-01', importe: 2420, cuentaBancariaId: banco }, USUARIO_PRUEBA));
    expect(e).toEqual({ status: 400, message: 'El importe (2.420,00 €) supera lo pendiente de la factura (1.210,00 €).' });
    // Carmen y los resúmenes cuentan lo mismo.
    expect(await pendiente2026(E, 'PAGO', { terceroId: dos.id })).toEqual({ numero: 1, importe: 1210 });
    expect((await resumenPendiente(E)).pagos.pendiente).toBe(5445 - 1210);
  });

  it('un abono mayor que lo pendiente solo descuenta lo que queda; el resto sigue a tu favor', async () => {
    const luz = await proveedor('4100000001');
    const a = await registrarGasto(E, abonoFuera(luz.id, 'AB-2', -1000, { numero: 'L-0330', fecha: '2026-03-30' }), { contabilizar: 'POSTED' });
    expect(await vista('L-0330')).toMatchObject({ pendiente: 0, compensado: 605, estado: 'LIQUIDADA' });
    // Ya no queda nada por pagar: el buscador deja de ofrecerla.
    expect((await buscarOriginales(E, { supplierId: luz.id, numero: 'L-0330' })).partidasFuera).toEqual([]);
    const c = await prisma.compensacionGasto.findFirstOrThrow({ where: { companyId: E, abonoId: a.factura.id } });
    expect(Number(c.importe)).toBe(605);
  });

  it('aplicar a mano un abono a una factura de fuera que está entre las pendientes: con tope y con el número escrito de otra forma', async () => {
    const dos = await proveedor('4000000002');
    const a = await registrarGasto(E, abonoSuelto(dos.id, 'AB-3', -2000), { contabilizar: 'POSTED' });
    const e = await error(aplicarAbono(E, a.factura.id, { numeroFuera: 'fd-12', fechaFuera: '2026-03-15', importe: 1300, fecha: '2027-02-01' }));
    expect(e).toEqual({ status: 400, message: 'El importe (1.300,00 €) supera lo que queda pendiente de la factura fd-12 (1.210,00 €).' });
    const c = await aplicarAbono(E, a.factura.id, { numeroFuera: 'fd-12', fechaFuera: '2026-03-15', fecha: '2027-02-01' });
    expect(c.importe).toBe(1210);
    expect(await vista('FD-12')).toMatchObject({ pendiente: 0, estado: 'LIQUIDADA' });
    expect((await error(liquidarPartida(E, (await partida('FD-12')).id, { fecha: '2027-02-02', importe: 1, cuentaBancariaId: banco }, USUARIO_PRUEBA))).status).toBe(409);
    const otra = await error(aplicarAbono(E, a.factura.id, { numeroFuera: 'FD-12', fechaFuera: '2026-03-15', importe: 10, fecha: '2027-02-01' }));
    expect(otra.status).toBe(409);
    expect(otra.message).toMatch(/ya no tiene nada pendiente de pago/);

    // Anular la aplicación devuelve lo pendiente a la partida.
    await anularCompensacion(E, a.factura.id, c.id, { fecha: '2027-02-03' });
    expect(await vista('FD-12')).toMatchObject({ pendiente: 1210, estado: 'PARCIAL' });
  });

  it('anular el abono anula su descuento y la partida vuelve a estar pendiente entera', async () => {
    const uno = await proveedor('4000000001');
    const a = await registrarGasto(E, abonoFuera(uno.id, 'AB-4', -500, { numero: 'FP-77', fecha: '2026-03-10' }), { contabilizar: 'POSTED' });
    expect(await vista('FP-77')).toMatchObject({ pendiente: 2420 - 605, estado: 'PARCIAL' });
    await anularGasto(E, a.factura.id, { motivo: 'Error' });
    expect(await vista('FP-77')).toMatchObject({ pendiente: 2420, compensado: 0, estado: 'PENDIENTE' });
  });

  it('factura de 2026 hecha en la app y enlazada a su partida: el abono descuenta lo que queda de la partida, no de la factura', async () => {
    const uno = await proveedor('4000000001');
    // La factura entera (4.840 €) se registró en la app en 2026; la gestoría la trae con 2.420 € pendientes.
    const fra = await prisma.expenseInvoice.create({
      data: {
        companyId: E,
        supplierId: uno.id,
        serie: 'G',
        numero: 77,
        numeroCompleto: 'G-2026-077',
        numeroFacturaProveedor: 'FP-77',
        fechaEmision: '2026-03-10',
        fechaVencimiento: '2026-04-10',
        estado: 'ACCOUNTED',
        baseTotal: 4000,
        ivaTotal: 840,
        totalFactura: 4840,
      },
    });
    const p = await partida('FP-77');
    await prisma.partidaPendiente.update({ where: { id: p.id }, data: { expenseInvoiceId: fra.id } });
    const a = await registrarGasto(E, abonoSuelto(uno.id, 'AB-6', -3000), { contabilizar: 'POSTED' });
    // Pendiente de la factura en la app: 4.840; de la partida: 2.420. Manda la partida.
    const c = await aplicarAbono(E, a.factura.id, { facturaId: fra.id, fecha: '2027-02-01' });
    expect(c.importe).toBe(2420);
    expect(await vista('FP-77')).toMatchObject({ pendiente: 0, compensado: 2420, estado: 'LIQUIDADA' });
    await anularCompensacion(E, a.factura.id, c.id, { fecha: '2027-02-02' });
    expect(await vista('FP-77')).toMatchObject({ pendiente: 2420, estado: 'PENDIENTE' });
    await prisma.partidaPendiente.update({ where: { id: p.id }, data: { expenseInvoiceId: null } });
  });

  it('una factura de fuera que la gestoría no trajo pendiente se compensa como antes, sin tope', async () => {
    const uno = await proveedor('4000000001');
    const a = await registrarGasto(E, abonoFuera(uno.id, 'AB-5', -100, { numero: 'NO-ESTA-1', fecha: '2026-05-01' }), { contabilizar: 'POSTED' });
    const c = await prisma.compensacionGasto.findFirstOrThrow({ where: { companyId: E, abonoId: a.factura.id } });
    expect(Number(c.importe)).toBe(121);
    expect(await vista('FP-77')).toMatchObject({ pendiente: 2420 });
  });
});
