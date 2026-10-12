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
import { aplicarAbono } from '../services/compensacionesGasto.service';
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
