/**
 * Mayor por tercero tras «Traer la contabilidad de 2026»: el saldo de cada
 * cliente y proveedor en 2027 (que empieza con la apertura) cuadra con lo
 * pendiente, que cuenta las facturas que la gestoría dejó pendientes
 * (partidas) en lugar de las facturas de 2026, también después de pagar una
 * partida o de descontarle un abono de 2027.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { informeDetalleTercero, informeMayorTerceros, pendientesSegunFacturas } from '../services/informesContables.service';
import { liquidarPartida } from '../services/arranque/partidas.service';
import { registrarGasto } from '../services/expense-invoices.service';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const E = `arr-mayor-${Date.now()}`;
const ANIO_2027 = { ejercicio: 2027, desde: '2027-01-01', hasta: '2027-12-31' };

const proveedor = (subcuenta: string) => prisma.supplier.findFirstOrThrow({ where: { companyId: E, OR: [{ subcuenta400: subcuenta }, { subcuenta410: subcuenta }] } });

/** Cada tercero con ficha: saldo del mayor frente a lo pendiente. */
async function cuadre(tipo: 'clientes' | 'proveedores', periodo = ANIO_2027) {
  const r = await informeMayorTerceros(E, tipo, periodo);
  return r.terceros.filter((t) => t.pendienteFacturas !== null).map((t) => ({ nombre: t.nombre, saldo: t.saldoFinal, pendiente: t.pendienteFacturas }));
}

function cuadra(filas: Array<{ nombre: string; saldo: number; pendiente: number | null }>) {
  for (const f of filas) expect({ nombre: f.nombre, pendiente: f.pendiente }).toEqual({ nombre: f.nombre, pendiente: f.saldo });
}

describe('mayor por tercero con las partidas de 2026 y los abonos de 2027', () => {
  let banco = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
    banco = (await prisma.bankAccount.findFirstOrThrow({ where: { companyId: E, subcuentaCodigo: '5720000001' } })).id;
  }, 120_000);

  it('recién traída la contabilidad, el saldo de cada tercero es lo que dejó pendiente la gestoría', async () => {
    const proveedores = await cuadre('proveedores');
    expect(proveedores.find((p) => p.nombre === 'Proveedor Dos SA')).toMatchObject({ saldo: 2420, pendiente: 2420 });
    cuadra(proveedores);
    const clientes = await cuadre('clientes');
    expect(clientes.find((c) => c.nombre === 'Cliente Alfa SL')).toMatchObject({ saldo: 6050, pendiente: 6050 });
    cuadra(clientes);
  });

  it('un abono de 2027 «se descuenta de lo que le debo» sobre una factura que solo es partida: mayor y pendiente bajan lo mismo', async () => {
    const dos = await proveedor('4000000002');
    await registrarGasto(
      E,
      {
        proveedor: { id: dos.id },
        numeroFacturaProveedor: 'AB-1',
        fechaEmision: '2027-01-20',
        tipoGasto: 'COMPRA',
        lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -1000, tipoIva: 21, cuenta: '608' }],
        rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ numero: 'FD-12', fecha: '2026-03-15' }], yaPagada: false },
      },
      { contabilizar: 'POSTED' },
    );
    const proveedores = await cuadre('proveedores');
    expect(proveedores.find((p) => p.nombre === 'Proveedor Dos SA')).toMatchObject({ saldo: 1210, pendiente: 1210 });
    cuadra(proveedores);
    // El detalle del proveedor nombra la factura de 2026 con lo que queda.
    const d = await informeDetalleTercero(E, 'proveedores', ANIO_2027, dos.id);
    expect(d.tercero.saldoFinal).toBe(1210);
    expect(d.totalPendiente).toBe(1210);
    expect(d.facturasPendientes.map((f) => [f.numeroCompleto, f.importePendiente])).toEqual([['FD-12', 1210]]);
    // Antes del abono, lo pendiente a esa fecha era la partida entera.
    const antes = await pendientesSegunFacturas(E, 'proveedores', '2027-01-19', { conPartidas: true });
    expect(antes.filter((f) => f.terceroId === dos.id).map((f) => f.importePendiente)).toEqual([2420]);
    cuadra(await cuadre('proveedores', { ejercicio: 2027, desde: '2027-01-01', hasta: '2027-01-19' }));
  });

  it('pagar lo que queda de la partida deja el mayor del proveedor a cero', async () => {
    const dos = await proveedor('4000000002');
    const p = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: 'FD-12' } });
    await liquidarPartida(E, p.id, { fecha: '2027-02-01', importe: 1210, cuentaBancariaId: banco }, USUARIO_PRUEBA);
    const proveedores = await cuadre('proveedores');
    expect(proveedores.find((x) => x.nombre === 'Proveedor Dos SA')).toMatchObject({ saldo: 0, pendiente: 0 });
    cuadra(proveedores);
    expect((await informeDetalleTercero(E, 'proveedores', ANIO_2027, dos.id)).facturasPendientes).toEqual([]);
  });

  it('sin la opción de las partidas, la lista de siempre no cambia (Carmen y demás)', async () => {
    const lista = await pendientesSegunFacturas(E, 'proveedores', '2027-12-31');
    expect(lista.some((f) => f.numeroCompleto === 'FP-77' || f.numeroCompleto === 'FD-12')).toBe(false);
  });
});
