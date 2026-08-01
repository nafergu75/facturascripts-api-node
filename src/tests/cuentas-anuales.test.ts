// FS mockeado: 1 asiento real (venta) -> 430 debe 363 / 700 haber 300 / 477 haber 63.
const fsClientMock = {
  listWithMeta: jest.fn(async (resource: string) => {
    if (resource === 'asientos') {
      return { items: [{ idasiento: 1, fecha: '10-06-2026', numero: 1, concepto: 'Factura venta F2026A1' }], total: 1 };
    }
    if (resource === 'partidas') {
      return {
        items: [
          { codsubcuenta: '4300000000', debe: 363, haber: 0 },
          { codsubcuenta: '7000000000', debe: 0, haber: 300 },
          { codsubcuenta: '4770000000', debe: 0, haber: 63 },
        ],
        total: 3,
      };
    }
    return { items: [], total: 0 };
  }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));
// Tras ADR-002 Paso 3, los estados financieros (cuentas anuales, Modelo 200, EFE)
// leen los asientos de Prisma `journalEntry` (POSTED), no de FacturaScripts. El
// asiento equivalente al mock FS de abajo: venta F2026A1 -> 430 debe 363 / 700
// haber 300 / 477 haber 63.
jest.mock('../config/database', () => ({
  prisma: {
    journalEntry: {
      findMany: jest.fn(async (args?: { where?: { fecha?: { gte?: Date } } }) => {
        if (args?.where?.fecha?.gte?.getUTCFullYear?.() !== 2026) return [];
        return [
          {
            id: 'a1',
            fecha: new Date(Date.UTC(2026, 5, 10)),
            numeroAsiento: '1',
            descripcion: 'Factura venta F2026A1',
            estado: 'POSTED',
            lineas: [
              { accountCode: '4300000000', debe: 363, haber: 0 },
              { accountCode: '7000000000', debe: 0, haber: 300 },
              { accountCode: '4770000000', debe: 0, haber: 63 },
            ],
          },
        ];
      }),
    },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

import request from 'supertest';
import { app } from '../app';
import { authService } from '../services/auth.service';
import { generarCuentasAnuales, generarEstadoFlujosEfectivo } from '../services/cuentasAnuales.service';

const token = authService.generateToken({ userId: 'u1', email: 'u1@test.com', roles: ['admin'], companies: ['1'] });
const auth = { Authorization: `Bearer ${token}` };

describe('Modelo 200', () => {
  it('preview: resultado 300, base 300, cuota integra 75 (25%)', async () => {
    const res = await request(app).get('/companies/1/modelo-200/preview?ejercicio=2026').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.pyg.importeNetoCifraNegocios).toBe(300);
    expect(res.body.data.resultadoContableAntesImpuestos).toBe(300);
    expect(res.body.data.baseImponibleFinal).toBe(300);
    expect(res.body.data.cuotaIntegra).toBe(75);
  });
});

// Ruta legacy /cuentas-anuales retirada en el cleanup del spine FS: se prueba el
// servicio directamente (el front Chakra usa /reports). La autenticacion de ruta
// esta cubierta por otros tests (p.ej. clientes.test 401/403).
describe('Cuentas Anuales (RM) + EFE (servicio)', () => {
  it('balance cuadra (activo = PN + pasivo) y PyG resultado 300', async () => {
    const ca = await generarCuentasAnuales('1', 2026);
    expect(ca.pyg.resultadoEjercicio).toBe(300);
    expect(ca.balance.totalActivo).toBe(363); // clientes 430
    expect(ca.balance.totalPatrimonioNetoYPasivo).toBe(363); // resultado 300 + IVA 63
    expect(ca.aplicacionResultado.aReservas).toBe(300);
  });

  it('EFE: sin movimientos de tesoreria (factura no cobrada) -> variacion 0', async () => {
    const efe = await generarEstadoFlujosEfectivo('1', 2026);
    expect(efe.variacionNetaEfectivo).toBe(0);
    expect(efe.efectivoFinal).toBe(0);
  });
});
