/**
 * Facturas de 2026 que la gestoria trajo pendientes (partidas de «Traer la
 * contabilidad de 2026»):
 *  - no se pueden registrar otra vez en Compras (su IVA ya lo dedujo la
 *    gestoria y la deuda ya esta en la apertura); una de 2027 con el mismo
 *    numero, o una de 2026 que no esta en la cartera, si;
 *  - con abonos de 2027 ya descontados, la definitiva no las puede quitar ni
 *    cambiar y la carga no se puede deshacer hasta anular esa aplicacion.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { registrarGasto, editarGasto } from '../services/expense-invoices.service';
import { anularCompensacion } from '../services/compensacionesGasto.service';
import { subirYAnalizar } from '../services/arranque/cargas.service';
import { deshacerCarga } from '../services/arranque/deshacer.service';
import type { HttpError } from '../utils/http-errors';
import { AJUSTES_A, CARTERA_A, ficherosEmpresaA, ficherosEmpresaADefinitiva } from './fixtures/arranque/generar';
import { empresaDePrueba, TODOS, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

const proveedor = (companyId: string, subcuenta: string) =>
  prisma.supplier.findFirstOrThrow({ where: { companyId, OR: [{ subcuenta400: subcuenta }, { subcuenta410: subcuenta }] } });

const compra = (supplierId: string, numero: string, fechaEmision: string, fechaRegistro?: string) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision,
  ...(fechaRegistro ? { fechaRegistro } : {}),
  tipoGasto: 'COMPRA',
  lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 2000, tipoIva: 21, cuenta: '600' }],
});

const abonoSobreFD12 = (supplierId: string) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: 'AB-1',
  fechaEmision: '2027-01-20',
  tipoGasto: 'COMPRA',
  lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -1000, tipoIva: 21, cuenta: '608' }],
  rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ numero: 'FD-12', fecha: '2026-03-15' }], yaPagada: false },
});

describe('una factura que la gestoría trajo pendiente no se registra otra vez', () => {
  const E = `arr-rep-a-${SUFIJO}`;
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
  }, 120_000);

  it('FD-12 de Proveedor Dos, con fecha de 2026 y registrada en 2027: 409 que manda a pagarla desde la partida', async () => {
    const dos = await proveedor(E, '4000000002');
    const partida = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: 'FD-12' } });
    for (const numero of ['FD-12', ' fd-12 ', 'FD -12']) {
      const e = await error(registrarGasto(E, compra(dos.id, numero, '2026-03-15', '2027-01-10'), { contabilizar: 'POSTED' }));
      expect(e.statusCode).toBe(409);
      expect(e.message).toBe(
        'Esta factura ya la contabilizó tu gestoría: es la FD-12 de «Facturas de 2026 pendientes» (Contabilidad > Traer la contabilidad de 2026). Págala desde allí y no la registres otra vez.',
      );
      expect(e.details).toMatchObject({ codigo: 'FACTURA_EN_PARTIDA_2026', partidaId: partida.id, enlace: '/dashboard/contabilidad/arranque?vista=pendientes' });
    }
    // Tampoco desde el lector (borrador).
    expect((await error(registrarGasto(E, compra(dos.id, 'FD-12', '2026-03-15', '2027-01-10'), { contabilizar: 'DRAFT' }))).statusCode).toBe(409);
    expect(await prisma.expenseInvoice.count({ where: { companyId: E, supplierId: dos.id } })).toBe(0);
  });

  it('una factura de 2026 que no está en la cartera sí se registra', async () => {
    const dos = await proveedor(E, '4000000002');
    const tarde = await registrarGasto(E, compra(dos.id, 'FP-90', '2026-12-20', '2027-01-10'), { contabilizar: 'POSTED' });
    expect(tarde.factura.numeroFacturaProveedor).toBe('FP-90');
  });

  it('corregir una factura para ponerle el número y la fecha de una partida: 409', async () => {
    const dos = await proveedor(E, '4000000002');
    const f = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, supplierId: dos.id, numeroFacturaProveedor: 'FP-90' } });
    const e = await error(editarGasto(E, f.id, compra(dos.id, 'FD-12', '2026-03-15', '2027-01-10')));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'FACTURA_EN_PARTIDA_2026' });
  });
  it('una de 2027 con el mismo número es otra factura (proveedores que numeran cada año desde 1)', async () => {
    const dos = await proveedor(E, '4000000002');
    const nueva = await registrarGasto(E, compra(dos.id, 'FD-12', '2027-01-12'), { contabilizar: 'POSTED' });
    expect(nueva.factura.numeroFacturaProveedor).toBe('FD-12');
  });

  it('otro proveedor con el mismo número no choca', async () => {
    const uno = await proveedor(E, '4000000001');
    const r = await registrarGasto(E, compra(uno.id, 'FD-12', '2026-03-15', '2027-01-10'), { contabilizar: 'POSTED' });
    expect(r.factura.numeroFacturaProveedor).toBe('FD-12');
  });

});

describe('abonos de 2027 descontados de una partida: definitiva y deshacer', () => {
  const E = `arr-rep-b-${SUFIJO}`;
  let cargaId = '';
  let abonoId = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    cargaId = (await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A)).r.carga.id;
    const dos = await proveedor(E, '4000000002');
    abonoId = (await registrarGasto(E, abonoSobreFD12(dos.id), { contabilizar: 'POSTED' })).factura.id;
  }, 120_000);

  it('deshacer la carga se bloquea y dice qué abono anular', async () => {
    const plan = await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA);
    expect(plan.puede).toBe(false);
    expect(plan.bloqueos).toEqual([
      '1 factura pendiente de 2026 ya tiene abonos de 2027 descontados (FD-12). Anula antes su aplicación en la ficha del abono, en Compras («Aplicado a otras facturas»).',
    ]);
    const e = await error(deshacerCarga(E, 2027, cargaId, {}, USUARIO_PRUEBA));
    expect(e.statusCode).toBe(409);
  });

  it('una definitiva cuya cartera ya no trae FD-12 da error; con la cartera de antes, FD-12 sigue con su abono', async () => {
    const sinFD12 = CARTERA_A.filter((p) => p.documento !== 'FD-12');
    const ficheros = Object.values(ficherosEmpresaADefinitiva([], { cartera: sinFD12 }));
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, ficheros, { ...AJUSTES_A, tipoCarga: 'DEFINITIVA' }, TODOS);
    expect(r.vista.puedeConfirmar).toBe(false);
    const errores = r.vista.comprobaciones.puntos.filter((p) => p.nivel === 'ERROR').map((p) => p.texto).join(' | ');
    expect(errores).toContain(
      'Una factura pendiente que ya tiene cobros, pagos o abonos descontados de 2027 cambia en la cartera nueva: FD-12 (4000000002): ya no está, con 1.210,00 € descontados con abonos. Anula antes esos cobros o pagos, y la aplicación de los abonos en su ficha de Compras («Aplicado a otras facturas»), o pide a la gestoría que la cartera las traiga igual.',
    );
  });

  it('anulada la aplicación del abono, deshacer ya se puede', async () => {
    const c = await prisma.compensacionGasto.findFirstOrThrow({ where: { companyId: E, abonoId, estado: 'ACTIVO' } });
    await anularCompensacion(E, abonoId, c.id, { fecha: '2027-01-25' });
    const plan = await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA);
    expect(plan.bloqueos).toEqual([]);
  });
});
