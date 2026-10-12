/**
 * Cadena real del 303 sobre BD (remates C del 303):
 *  - 4T de 2026 presentado a compensar -> el 1T de 2027 lo toma en [110] y lo
 *    aplica en [78]; lo que sobra pasa a [87] y llega al 2T;
 *  - cambio de periodicidad: el mes 01 de 2027 (mensual) toma lo pendiente del
 *    4T de 2026 (trimestral), aunque no exista el mes 12;
 *  - los indicadores de la página 1 quedan congelados al presentar.
 *
 * Necesita MySQL. Los NIF son inventados (con su carácter de control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import declaracionesAeatRoutes from '../routes/declaraciones-aeat.routes';
import taxModelsRoutes from '../routes/tax-models.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { generarTxt303 } from '../services/impuestosModulo.service';

const E = `cadena-303-${Date.now()}`;
const dni = (n: number) => `${n}${letraNif(n)}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:companyId', (req, _res, next) => {
    req.user = { userId: 'u-303', roles: ['contable'], companies: [req.params.companyId], rolesPorEmpresa: { [req.params.companyId]: ['contable'] } } as never;
    req.companyId = req.params.companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', declaracionesAeatRoutes);
  a.use('/companies/:companyId/tax-models', taxModelsRoutes);
  a.use(errorMiddleware);
  return a;
}
const ruta = (r: string) => `/companies/${E}${r}`;

let numVenta = 0;
let cliente = '';
async function venta(fecha: string, base: number, iva: number) {
  numVenta += 1;
  await prisma.incomeInvoice.create({
    data: {
      companyId: E,
      customerId: cliente,
      serie: 'K',
      numero: numVenta,
      numeroCompleto: `K-${numVenta}`,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      tipoOperacion: 'NACIONAL',
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      lineas: { create: [{ descripcion: 'Venta', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: 21 }] },
    },
  });
}

let proveedor = '';
const compra = (fecha: string, numero: string, precio: number) =>
  expenseInvoicesService.crearGasto(
    {
      companyId: E,
      proveedor: { id: proveedor },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      tipoGasto: 'COMPRA',
      lineas: [{ descripcion: 'Género', cantidad: 1, precioUnitario: precio, tipoIva: 21 }],
    } as never,
    { contabilizar: 'POSTED' },
  );

const pantalla = async (ejercicio: number, periodo: string) => {
  const r = await request(app()).get(ruta(`/tax-models/303?ejercicio=${ejercicio}&periodo=${periodo}`));
  expect(r.status).toBe(200);
  const d = r.body.data;
  const de = (n: string) => d.casillas303.find((c: { numero: string }) => c.numero === n)?.valor;
  return { d, de };
};

const presentar = async (ejercicio: number, periodo: string, numero: string, opciones: Record<string, unknown> = {}) => {
  const r = await request(app())
    .post(ruta('/tax-models/303/presentado'))
    .send({ ejercicio, periodo, justificante: { numero, fecha: `${ejercicio + (periodo === '4T' ? 1 : 0)}-01-30` }, opciones });
  expect([r.status, r.status === 200 ? '' : JSON.stringify(r.body)]).toEqual([200, '']);
};

/** Casilla de la página 3 del fichero (posición del diseño, 17 caracteres). */
const p3 = (txt: string, pos: number) => {
  const t = txt.slice(txt.indexOf('<T30303000>') + pos - 1, txt.indexOf('<T30303000>') + pos - 1 + 17);
  return (t.startsWith('N') ? -Number(t.slice(1)) : Number(t)) / 100;
};

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: `Cadena 303 ${E}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Cadena Turia, S.L.', nif: 'B46000006', telefono: '961 23 45 67', personaContacto: 'García Pérez Ana' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Cadena, S.L.', nifCif: 'B12345674', pais: 'ES', cp: '46001' } })).id;
  proveedor = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Proveedor Cadena', nifCif: dni(30000004), cp: '46001' } })).id;
  // 4T 2026: devengado 210, deducible 1.050 -> resultado -840 (a compensar).
  await venta('2026-11-10', 1000, 210);
  await compra('2026-11-12', 'P-4T', 5000);
  // 1T 2027: devengado 420.
  await venta('2027-02-10', 2000, 420);
});

describe('303: cadena 4T -> 1T del año siguiente', () => {
  it('el 4T presentado a compensar llega al [110] del 1T, que lo aplica hasta cero y deja el resto en [87]', async () => {
    const t4 = await pantalla(2026, '4T');
    expect(t4.de('71')).toBe(-840);
    expect(t4.d.tiposDeclaracion.map((t: { codigo: string }) => t.codigo)).toEqual(['C', 'D']);
    await presentar(2026, '4T', '3032026000004', { tipoDeclaracion: 'C' });

    const t1 = await pantalla(2027, '1T');
    expect(t1.d.aCompensar).toMatchObject({ importe: 840, origen: 'periodo-anterior', periodo: '4T de 2026', estado: 'presentado' });
    expect([t1.de('46'), t1.de('110'), t1.de('78'), t1.de('87'), t1.de('71')]).toEqual([420, 840, 420, 420, 0]);
    // El fichero lleva lo mismo que la pantalla.
    const txt = (await generarTxt303(E, 2027, '1T')).contenido;
    expect([p3(txt, 255), p3(txt, 272), p3(txt, 289), p3(txt, 408)]).toEqual([840, 420, 420, 0]);

    await presentar(2027, '1T', '3032027000001');
    const t2 = await pantalla(2027, '2T');
    expect(t2.d.aCompensar).toMatchObject({ importe: 420, periodo: '1T de 2027' });
  });

  it('al pasar a mensual, el mes 01 toma lo pendiente del 4T (otra periodicidad), no 0', async () => {
    const m01 = await pantalla(2027, '01');
    expect(m01.d.aCompensar).toMatchObject({ importe: 840, origen: 'periodo-anterior', periodo: '4T de 2026' });
    expect(m01.de('110')).toBe(840);
  });

  it('el 303 presentado conserva sus indicadores de la página 1 aunque cambien los ajustes', async () => {
    const antes = (await generarTxt303(E, 2026, '4T')).contenido;
    await prisma.ajustesFiscales.upsert({
      where: { companyId: E },
      create: { companyId: E, periodicidadIva: 'MENSUAL', redeme: true, sii: true, granEmpresa: false },
      update: { periodicidadIva: 'MENSUAL', redeme: true, sii: true },
    });
    try {
      expect((await generarTxt303(E, 2026, '4T')).contenido).toBe(antes);
    } finally {
      await prisma.ajustesFiscales.delete({ where: { companyId: E } });
    }
  });
});
