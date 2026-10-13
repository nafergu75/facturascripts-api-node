/**
 * Abonos de venta sobre facturas que la gestoria trajo pendientes de cobro
 * (partidas de «Traer la contabilidad de 2026»): el abono enlazado a la
 * partida (partidaPendienteId) rebaja lo que queda por cobrar, nunca por
 * debajo de cero (lo que no cabe queda a favor del cliente), y el cobro
 * siguiente de la partida no pasa del resto.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { liquidarPartida, listarPartidas, partidasConMovimientos } from '../services/arranque/partidas.service';
import { aFavorDeAbonos } from '../services/rectificativasVenta.service';

const E = `arr-abonos-venta-${Date.now()}`;
let cliente = '';
let carga = '';

const partida = (numero: string, importe: number) =>
  prisma.partidaPendiente.create({
    data: { companyId: E, cargaId: carga, tipo: 'COBRO', subcuenta: '4300000001', customerId: cliente, numeroDocumento: numero, fechaDocumento: '2025-11-20', importePendiente: importe },
  });
const abono = (partidaId: string, base: number) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: { id: cliente },
    lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -base, tipoIva: 21 }],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ partidaId }] },
  } as unknown as CrearFacturaIngresoDTO);
const pendiente = async (id: string) => (await listarPartidas(E, { tipos: ['COBRO'] })).partidas.find((p) => p.id === id)!;

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Abonos Venta Partidas SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Abonos Venta Partidas SL', nif: 'B40000005' } });
  await prisma.ajustesFiscales.create({ data: { companyId: E, inicioEnApp: '2026-01-01' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Partidas SL', nifCif: 'B50000041', subcuenta430: '4300000001' } })).id;
  // La carga de 2025 (la apertura es el 1-1-2026, como si 2025 lo llevara la gestoria).
  carga = (await prisma.cargaArranque.create({ data: { companyId: E, ejercicio: 2026, version: 1, tipo: 'PROVISIONAL', estado: 'CONFIRMADA', ficheros: [], createdBy: 'test' } })).id;
});

describe('abonos de venta y partidas de cobro de 2026', () => {
  it('el abono rebaja lo pendiente de la partida y cuenta como movimiento; el cobro siguiente no pasa del resto', async () => {
    const p = await partida('F-2025/10', 1210);
    const r = await abono(p.id, 200); // -242
    expect(r.totalFactura).toBe(-242);
    const vista = await pendiente(p.id);
    expect(vista).toMatchObject({ liquidado: 242, compensado: 242, pendiente: 968, estado: 'PARCIAL' });
    expect((await prisma.partidaPendiente.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe('PARCIAL');
    expect((await partidasConMovimientos(prisma, E, [p.id])).get(p.id)).toMatchObject({ abonos: 242 });
    // Todo absorbido por la partida: nada a favor del cliente.
    expect((await aFavorDeAbonos(prisma, E, [r.id])).get(r.id)).toBe(0);
    await expect(liquidarPartida(E, p.id, { importe: 1000, caja: true }, 'u')).rejects.toMatchObject({ statusCode: 400 });
    const { partida: tras } = await liquidarPartida(E, p.id, { caja: true }, 'u');
    expect(tras).toMatchObject({ liquidado: 1210, pendiente: 0, estado: 'LIQUIDADA' });
  });

  it('un abono mayor que lo que queda deja la partida a cero y el resto a favor del cliente', async () => {
    const p = await partida('F-2025/11', 121);
    await liquidarPartida(E, p.id, { importe: 100, caja: true }, 'u');
    const r = await abono(p.id, 100); // -121; solo caben 21
    expect(await pendiente(p.id)).toMatchObject({ liquidado: 121, pendiente: 0, estado: 'LIQUIDADA' });
    expect((await aFavorDeAbonos(prisma, E, [r.id])).get(r.id)).toBe(100);
    expect((await incomeInvoicesService.obtenerPorId(E, r.id)).aFavor).toBe(100);
  });

  it('un borrador de abono no rebaja nada hasta que se emite', async () => {
    const p = await partida('F-2025/12', 500);
    await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { id: cliente },
      borrador: true,
      lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -100, tipoIva: 21 }],
      rectificativa: { forma: 'I', motivo: 'DEVOLUCION', explicacion: '', originales: [{ partidaId: p.id }] },
    } as unknown as CrearFacturaIngresoDTO);
    expect(await pendiente(p.id)).toMatchObject({ liquidado: 0, pendiente: 500, estado: 'PENDIENTE' });
  });
});
