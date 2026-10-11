/**
 * Lector de gastos sobre BD real, sin llamar a Anthropic (el extractor esta
 * simulado):
 *  - extraer-ia devuelve el proveedor de la empresa con ese NIF y la factura
 *    ya registrada con ese numero, y rechaza los archivos de mas de 4 MB;
 *  - confirmar registra de verdad la factura con su asiento en borrador: no
 *    cuenta en el IVA hasta aprobar el asiento en el Motor contable, y
 *    entonces la factura queda contabilizada y el libro, la 472 y los dos 303
 *    cuadran;
 *  - la lectura: retencion, moneda y NIF de otro pais.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import gastosRoutes from '../routes/gastos-extractor.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { controlCif } from '../utils/nif';
import { esperarCuadre } from './ayuda-cuadre-recibidas';
import type { GastoExtraido } from '../services/gastos-extractor.service';

const mockExtraer = jest.fn<(a: unknown) => Promise<GastoExtraido>>();
jest.mock('../services/gastos-extractor.service', () => {
  const real = jest.requireActual('../services/gastos-extractor.service') as Record<string, unknown>;
  return { ...real, gastosExtractorService: { extraer: (a: unknown) => mockExtraer(a) } };
});
// Despues del mock: la funcion pura de verdad.
const { _construirGastoExtraido } = jest.requireActual('../services/gastos-extractor.service') as typeof import('../services/gastos-extractor.service');

const E = `compras-lector-${Date.now()}`;
const motor = new AccountingEngineController();
const NIF = `B7654321${controlCif('7654321').cifra}`;
let supId: string;

function app() {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-lector', email: 'lector@test.local', roles: ['contable'], companies: [E], rolesPorEmpresa: { [E]: ['contable'] } } as never;
    req.companyId = E;
    next();
  });
  a.use('/gastos-extractor', gastosRoutes);
  a.use(errorMiddleware);
  return a;
}

const leido = (extra: Partial<GastoExtraido> = {}): GastoExtraido => ({
  numeroFactura: 'FV-2026-9',
  proveedor: 'Imprenta Lector SL',
  nifProveedor: NIF,
  fecha: '2026-03-04',
  conceptoGasto: 'material de oficina',
  base: 200,
  iva: 42,
  total: 242,
  tipoIva: 21,
  tipoRetencion: null,
  retencion: 0,
  moneda: 'EUR',
  cuentaContableBase: '629',
  cuentaContableNombre: 'Otros servicios',
  tipoGastoSugerido: 'SUMINISTROS',
  confianza: 0.82,
  errores: [],
  tipoDocumento: 'factura',
  ...extra,
});

/** El cuerpo que manda la pantalla tras revisar la lectura. */
const confirmar = (extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supId },
  numeroFacturaProveedor: 'FV-2026-9',
  fechaEmision: '2026-03-04',
  tipoGasto: 'SUMINISTROS',
  cuentaGasto: '629',
  lineas: [{ descripcion: 'material de oficina', cantidad: 1, precioUnitario: 200, tipoIva: 21, tipoRetencion: 0 }],
  totalDocumento: 242,
  tipoDocumento: 'factura',
  confianza: 0.82,
  ...extra,
});

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Lector SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Lector SL', nif: 'B10000000' } });
  supId = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Imprenta Lector SL', nifCif: NIF } })).id;
});

describe('extraer-ia (extractor simulado)', () => {
  it('un proveedor nuevo: sin proveedor ni duplicada', async () => {
    mockExtraer.mockResolvedValueOnce(leido({ nifProveedor: `B1111111${controlCif('1111111').cifra}` }));
    const r = await request(app()).post('/gastos-extractor/extraer-ia').attach('archivo', Buffer.from('%PDF-1.4 prueba'), 'f.pdf');
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ proveedorExistente: null, duplicada: null, tipoGastoSugerido: 'SUMINISTROS', tipoIva: 21 });
  });

  it('el proveedor dado de alta se encuentra por su NIF (aunque venga con guiones)', async () => {
    mockExtraer.mockResolvedValueOnce(leido({ nifProveedor: `${NIF.slice(0, 1)}-${NIF.slice(1)}` }));
    const r = await request(app()).post('/gastos-extractor/extraer-ia').send({ archivoBase64: Buffer.from('%PDF-1.4').toString('base64'), mimeType: 'application/pdf' });
    expect(r.status).toBe(201);
    expect(r.body.data.proveedorExistente).toEqual({ id: supId, nombreFiscal: 'Imprenta Lector SL', nifCif: NIF });
    expect(r.body.data.duplicada).toBeNull();
  });

  it('mas de 4 MB: 400 (multipart y base64) y no se llama al extractor', async () => {
    const grande = Buffer.alloc(4 * 1024 * 1024 + 10, 1);
    const multipart = await request(app()).post('/gastos-extractor/extraer-ia').attach('archivo', grande, 'grande.pdf');
    expect(multipart.status).toBe(400);
    expect(multipart.body.message).toBe('El archivo pesa más de 4 MB: redúcelo o hazle una foto con menos resolución.');
    const base64 = await request(app()).post('/gastos-extractor/extraer-ia').send({ archivoBase64: grande.toString('base64') });
    expect(base64.status).toBe(400);
    expect(mockExtraer).not.toHaveBeenCalled();
  });
});

describe('confirmar', () => {
  let facturaId: string;
  let asientoId: string;

  it('201: factura y asiento en borrador, con su libro, pero sin contar en el IVA', async () => {
    const r = await request(app()).post('/gastos-extractor/confirmar').send(confirmar());
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      asientoEstado: 'DRAFT',
      proveedorCreado: false,
      factura: { estado: 'DRAFT', estadoTexto: 'Pendiente de revisar', numeroFacturaProveedor: 'FV-2026-9', cuentaGasto: '629', asiento: { estado: 'DRAFT' } },
    });
    expect(r.body.data.factura.observaciones).toBe('Leída con el lector de gastos (confianza 82 %).');
    facturaId = r.body.data.factura.id;
    asientoId = r.body.data.asientoId;
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: asientoId }, include: { lineas: true } });
    expect(Object.fromEntries(a.lineas.map((l) => [l.accountCode, [l.debe, l.haber]]))).toEqual({ '629': [200, 0], '472': [42, 0], '41000001': [0, 242] });
    expect(await prisma.vATBook.count({ where: { companyId: E, asientoId } })).toBe(1);
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
  });

  it('la misma factura otra vez: 409 y nada nuevo', async () => {
    mockExtraer.mockResolvedValueOnce(leido());
    const lectura = await request(app()).post('/gastos-extractor/extraer-ia').attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(lectura.body.data.duplicada).toEqual({ facturaId, numeroCompleto: 'G-1' });
    const antes = await prisma.expenseInvoice.count({ where: { companyId: E } });
    const r = await request(app()).post('/gastos-extractor/confirmar').send(confirmar());
    expect(r.status).toBe(409);
    expect(r.body.details.facturaId).toBe(facturaId);
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(antes);
  });

  it('al aprobar el asiento en el Motor contable, la factura queda contabilizada y todo cuadra', async () => {
    await motor.aprobarAsiento(E, asientoId, 'u-lector');
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe('ACCOUNTED');
    await esperarCuadre(expect, E, 2026, 1, 42, 200);
  });

  it('con un proveedor nuevo: se crea y se dice', async () => {
    const nif = `B2222222${controlCif('2222222').cifra}`;
    const r = await request(app())
      .post('/gastos-extractor/confirmar')
      .send(confirmar({ proveedor: { nuevo: { nombreFiscal: 'Proveedor Leído SL', nifCif: nif } }, numeroFacturaProveedor: 'N-1', confianza: undefined }));
    expect(r.status).toBe(201);
    expect(r.body.data.proveedorCreado).toBe(true);
    expect(r.body.data.factura.observaciones).toBe('Leída con el lector de gastos.');
    expect(await prisma.supplier.count({ where: { companyId: E, nifCif: nif } })).toBe(1);
  });

  it('sin el numero del proveedor: 400', async () => {
    const r = await request(app()).post('/gastos-extractor/confirmar').send(confirmar({ numeroFacturaProveedor: '' }));
    expect(r.status).toBe(400);
    expect(r.body.details.campo).toBe('numeroFacturaProveedor');
  });
});

describe('la lectura (sin BD)', () => {
  const lectura = {
    numero: 'F-1',
    fecha: '2026-03-01',
    proveedor: 'Asesor',
    nif_proveedor: null as string | null,
    concepto: 'servicios',
    base: 100,
    iva_porcentaje: 21,
    iva_cantidad: 21,
    total: 106,
    raw_text: null,
    tipo_documento: 'factura',
  };

  it('con una retencion de 15 € el total cuadra', () => {
    const g = _construirGastoExtraido({ ...lectura, retencion_porcentaje: 15, retencion_cantidad: 15 });
    expect(g).toMatchObject({ retencion: 15, tipoRetencion: 15, tipoIva: 21, total: 106 });
    expect(g.errores.join(' ')).not.toMatch(/Total no cuadra/);
    // Sin la retencion, el mismo documento no cuadra.
    expect(_construirGastoExtraido(lectura).errores.join(' ')).toMatch(/Total no cuadra/);
  });

  it('en dolares sale el aviso', () => {
    const g = _construirGastoExtraido({ ...lectura, total: 121, moneda: 'usd' });
    expect(g.moneda).toBe('USD');
    expect(g.errores).toContain('La factura está en USD: las facturas de gasto en otra moneda aún no se pueden registrar. Pasa los importes a euros antes de confirmar.');
  });

  it('un NIF-IVA de Francia no es invalido; un NIF español mal escrito si', () => {
    const fr = _construirGastoExtraido({ ...lectura, total: 121, nif_proveedor: 'FR12345678901' });
    expect(fr.errores.join(' ')).not.toMatch(/NIF\/CIF inválido/);
    const mal = _construirGastoExtraido({ ...lectura, total: 121, nif_proveedor: 'B1234567X' });
    expect(mal.errores).toContain('NIF/CIF inválido: B1234567X');
  });

  it('tipo de gasto sugerido por la cuenta', () => {
    expect(_construirGastoExtraido({ ...lectura, total: 121, concepto: 'alquiler del local' })).toMatchObject({ cuentaContableBase: '621', tipoGastoSugerido: 'ALQUILER' });
  });
});
