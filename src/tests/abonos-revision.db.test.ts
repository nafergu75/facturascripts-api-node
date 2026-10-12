/**
 * Hallazgos de la revisión de los abonos de proveedor: la cuenta habitual del
 * lector sin abonos, lo «a tu favor» del listado sin borradores, y las
 * carreras al aplicar un abono, al registrar dos abonos de la misma original y
 * al anular la original mientras se registra su abono.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import { prisma } from '../config/database';
import { proveedoresService } from '../services/proveedores.service';
import { anularGasto, editarGasto, expenseInvoicesService, registrarGasto } from '../services/expense-invoices.service';
import * as compensaciones from '../services/compensacionesGasto.service';
import { cuentaHabitualDeProveedor } from '../services/cuentasLinea.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import * as periodos from '../services/periodos.service';
import { controlCif } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function empresa(nombre: string): Promise<string> {
  const E = `revab-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id: E, name: `Revisión abonos ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: `Revisión abonos ${nombre} SL`, nif: cif() } });
  await asegurarPlanContableEmpresa(E);
  return E;
}

const lin = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });

const factura = (supplierId: string, numero: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'COMPRA',
  lineas: [lin(precio)],
  ...extra,
});

const abonoDe = (supplierId: string, numero: string, fecha: string, precio: number, originales: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  factura(supplierId, numero, fecha, precio, { lineas: [lin(precio, { cuenta: '608' })], rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales }, ...extra });

async function error(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    return { status: (e as { statusCode: number }).statusCode, message: (e as Error).message };
  }
  throw new Error('No dio error');
}

/** Mete `hueco` justo antes de la transaccion: la primera llamada a comprobarFechaAbierta lo ejecuta y sigue. */
function enElHueco(hueco: () => Promise<unknown>): void {
  const real = periodos.comprobarFechaAbierta;
  jest.spyOn(periodos, 'comprobarFechaAbierta').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
    await hueco();
    return real(...args);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cuenta habitual del proveedor para el lector', () => {
  it('no toma la cuenta de un abono (608): sigue la de sus facturas', async () => {
    const E = await empresa('habitual');
    const prov = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
    const o = await registrarGasto(E, factura(prov, 'F-1', '2027-01-10', 100, { lineas: [lin(100, { cuenta: '600' })] }), { contabilizar: 'POSTED' });
    await registrarGasto(E, abonoDe(prov, 'R-1', '2027-01-20', -20, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    await registrarGasto(E, abonoDe(prov, 'R-2', '2027-01-21', -10, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    expect((await cuentaHabitualDeProveedor(E, prov))?.codigo).toBe('600');
  });
});

describe('listado: lo que queda a tu favor', () => {
  it('un abono en borrador del lector no cuenta como a tu favor', async () => {
    const E = await empresa('afavor');
    const prov = (await proveedoresService.create(E, { nombreFiscal: 'Imprenta Levante SL', nifCif: cif() })).id;
    const o = await registrarGasto(E, factura(prov, 'A-12', '2027-01-10', 300), { contabilizar: 'POSTED' });
    // Uno en firme de una factura de fuera, que queda a favor, y otro en borrador del lector.
    await registrarGasto(E, abonoDe(prov, 'R-1', '2027-01-20', -100, [{ numero: 'F-2026/9', fecha: '2026-11-10' }]), { contabilizar: 'POSTED' });
    const borrador = await registrarGasto(E, abonoDe(prov, 'R-3', '2027-01-25', -100, [{ id: o.factura.id }]), { contabilizar: 'DRAFT' });
    expect(borrador.factura.estado).toBe('DRAFT');
    const l = await expenseInvoicesService.listarGastos(E, {});
    expect(l.contadores.abonosAFavor).toBe(1);
    expect(l.totales.aFavor).toBe(121);
    const soloAFavor = await expenseInvoicesService.listarGastos(E, { pago: 'a_favor' });
    expect(soloAFavor.items.map((f) => f.numeroFacturaProveedor)).toEqual(['R-1']);
  });
});

describe('aplicar un abono con otra operación a la vez', () => {
  let E: string;
  let prov: string;

  beforeAll(async () => {
    E = await empresa('carrera');
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Papelera del Grau SL', nifCif: cif() })).id;
  });

  /** Un abono de -50 (60,50 €) a favor (de una factura de fuera) y una factura de 100 (121 €) pendiente. */
  async function abonoYFactura(sufijo: string, precioFactura = 100) {
    const a = await registrarGasto(E, abonoDe(prov, `R-${sufijo}`, '2027-02-01', -50, [{ numero: `F-2026/${sufijo}`, fecha: '2026-11-10' }]), { contabilizar: 'POSTED' });
    const f = await registrarGasto(E, factura(prov, `F-${sufijo}`, '2027-02-02', precioFactura), { contabilizar: 'POSTED' });
    return { abono: a.factura.id, factura: f.factura.id };
  }

  it('si la factura se anula a la vez, no queda una aplicación activa sobre una factura anulada', async () => {
    const { abono, factura: fid } = await abonoYFactura('A2');
    enElHueco(() => anularGasto(E, fid, { motivo: 'Duplicada' }));
    expect((await error(compensaciones.aplicarAbono(E, abono, { facturaId: fid, fecha: '2027-02-10' }))).status).toBe(409);
    expect(await prisma.compensacionGasto.count({ where: { companyId: E, abonoId: abono, estado: 'ACTIVO' } })).toBe(0);
    expect((await expenseInvoicesService.obtenerPorId(E, abono)).aFavor).toBe(60.5);
  });

  it('si el abono se anula a la vez, no resta de lo pendiente de la factura', async () => {
    const { abono, factura: fid } = await abonoYFactura('B2');
    enElHueco(() => anularGasto(E, abono, { motivo: 'Error' }));
    expect((await error(compensaciones.aplicarAbono(E, abono, { facturaId: fid, fecha: '2027-02-10' }))).status).toBe(409);
    expect((await expenseInvoicesService.obtenerPorId(E, fid)).importePendiente).toBe(121);
  });

  it('si la factura se corrige a la baja a la vez, no se paga de más', async () => {
    const { abono, factura: fid } = await abonoYFactura('C2');
    enElHueco(() => editarGasto(E, fid, factura(prov, 'F-C2', '2027-02-02', 10)));
    await compensaciones.aplicarAbono(E, abono, { facturaId: fid, fecha: '2027-02-10' });
    const f = await expenseInvoicesService.obtenerPorId(E, fid);
    expect(f).toMatchObject({ totalFactura: 12.1, importePendiente: 0, estadoPago: 'PAGADA' });
    expect((await expenseInvoicesService.obtenerPorId(E, abono)).aFavor).toBe(48.4);
  });
});

describe('abonos de la misma original a la vez', () => {
  it('dos abonos a la vez no dejan la original por debajo de cero', async () => {
    const E = await empresa('doble');
    const prov = (await proveedoresService.create(E, { nombreFiscal: 'Distribuciones Ruzafa SL', nifCif: cif() })).id;
    const o = await registrarGasto(E, factura(prov, 'D-1', '2027-03-01', 100), { contabilizar: 'POSTED' });
    const r = await Promise.allSettled([
      registrarGasto(E, abonoDe(prov, 'DR-1', '2027-03-05', -80, [{ id: o.factura.id }]), { contabilizar: 'POSTED' }),
      registrarGasto(E, abonoDe(prov, 'DR-2', '2027-03-05', -80, [{ id: o.factura.id }]), { contabilizar: 'POSTED' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(fallo.reason).toMatchObject({ statusCode: 400, message: expect.stringMatching(/quedaría en -72,60/) });
    expect(await prisma.expenseInvoiceRectificada.count({ where: { companyId: E, originalId: o.factura.id } })).toBe(1);
  });

  it('si la original se anula mientras se registra su abono del lector, el abono no se crea', async () => {
    const E = await empresa('anulada');
    const prov = (await proveedoresService.create(E, { nombreFiscal: 'Suministros Patraix SL', nifCif: cif() })).id;
    const o = await registrarGasto(E, factura(prov, 'E-1', '2027-03-01', 100), { contabilizar: 'POSTED' });
    enElHueco(() => anularGasto(E, o.factura.id, { motivo: 'Duplicada' }));
    const e = await error(registrarGasto(E, abonoDe(prov, 'ER-1', '2027-03-05', -20, [{ id: o.factura.id }]), { contabilizar: 'DRAFT' }));
    expect(e).toMatchObject({ status: 409, message: expect.stringMatching(/E-1 se ha anulado mientras registrabas el abono/) });
    expect(await prisma.expenseInvoiceRectificada.count({ where: { companyId: E, originalId: o.factura.id } })).toBe(0);
    expect(await prisma.expenseInvoice.count({ where: { companyId: E, numeroFacturaProveedor: 'ER-1' } })).toBe(0);
  });

  it('si se registra un abono mientras se anula la original, la anulación se para', async () => {
    const E = await empresa('anulando');
    const prov = (await proveedoresService.create(E, { nombreFiscal: 'Cartonajes Benimaclet SL', nifCif: cif() })).id;
    const o = await registrarGasto(E, factura(prov, 'G-1', '2027-03-01', 100), { contabilizar: 'POSTED' });
    // El abono (borrador del lector) entra justo antes de la transaccion de la anulacion, despues de sus comprobaciones.
    const real = compensaciones.comprobarCompensaciones;
    jest.spyOn(compensaciones, 'comprobarCompensaciones').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await registrarGasto(E, abonoDe(prov, 'GR-1', '2027-03-05', -20, [{ id: o.factura.id }]), { contabilizar: 'DRAFT' });
      return real(...args);
    });
    const e = await error(anularGasto(E, o.factura.id, { motivo: 'Duplicada' }));
    expect(e).toMatchObject({ status: 409, message: expect.stringMatching(/Tiene la rectificativa GR-1/) });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: o.factura.id } })).estado).toBe('ACCOUNTED');
  });
});
