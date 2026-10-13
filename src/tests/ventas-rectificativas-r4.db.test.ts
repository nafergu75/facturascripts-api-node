/**
 * R4 que sube el IVA (art. 89.Cinco LIVA): va al 303 del periodo de la
 * original, pero solo si es otro periodo; con originales de periodos
 * distintos, una rectificativa para cada uno; si el 303 de ese periodo ya
 * está presentado, 409 que se confirma y deja el aviso (también en la
 * pantalla de ese 303); al emitir un borrador se aplica con la fecha de
 * emisión definitiva; y en el 347 y el 349 cuenta la fecha de emisión.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO, type IncomeInvoiceResp } from '../services/income-invoices.service';
import { obtenerFacturasFiscales } from '../services/impuestosCalculo.service';
import { avisosAbonosTrasPresentar } from '../services/impuestosModulo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { listarSeries } from '../services/series.service';
import { hoyEspana } from '../utils/fechas';
import type { HttpError } from '../utils/http-errors';

const E = `venta-r4-${Date.now()}`;
const HOY = hoyEspana();
const ANIO = Number(HOY.slice(0, 4));
const ANTES = ANIO - 1;
const INICIO_TRIMESTRE = `${ANIO}-${String((Math.ceil(Number(HOY.slice(5, 7)) / 3) - 1) * 3 + 1).padStart(2, '0')}-01`;
let cliente = '';
let julio: IncomeInvoiceResp;
let julio20: IncomeInvoiceResp;
let noviembre: IncomeInvoiceResp;
let deEsteTrimestre: IncomeInvoiceResp;

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const emitir = (fecha: string, serie: string) =>
  incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, serie, fechaEmision: fecha, lineas: [linea(100)] } as CrearFacturaIngresoDTO);
const r4 = (originales: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas: [linea(10)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'ERROR', explicacion: 'Faltaba un servicio', originales },
    ...extra,
  } as unknown as CrearFacturaIngresoDTO);

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'R4 Ventas SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'R4 Ventas SL', nif: 'B40000071' } });
  await prisma.ajustesFiscales.create({ data: { companyId: E, inicioEnApp: `${ANTES}-01-01` } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente R4 SL', nifCif: 'B50000071' } })).id;
  await listarSeries(E);
  // Serie V para las del año pasado (la numeración va en orden de fechas).
  await prisma.invoiceSeries.create({ data: { companyId: E, codigo: 'V', descripcion: 'Serie V', tipoDocumento: 'FACTURA', activa: true } });
  julio = await emitir(`${ANTES}-07-15`, 'V');
  julio20 = await emitir(`${ANTES}-07-20`, 'V');
  noviembre = await emitir(`${ANTES}-11-10`, 'V');
  deEsteTrimestre = await emitir(INICIO_TRIMESTRE, 'A');
});

afterAll(async () => {
  await prisma.incomeInvoiceRectificada.deleteMany({ where: { companyId: E } });
  await prisma.incomeInvoiceLine.deleteMany({ where: { invoice: { companyId: E } } });
  await prisma.incomeInvoice.deleteMany({ where: { companyId: E } });
  await prisma.modeloImpuesto.deleteMany({ where: { companyId: E } });
});

describe('R4 que sube el IVA', () => {
  it('con la original del mismo trimestre: se queda en su periodo y no avisa', async () => {
    const r = await r4([{ id: deEsteTrimestre.id }]);
    expect(r.tipoFactura).toBe('R4');
    expect(r.fechaOperacion).toBeUndefined();
    expect((r.avisosFiscales ?? []).map((a) => a.codigo)).not.toContain('IVA_PERIODO_ORIGINAL');
  });

  it('con originales de trimestres distintos: 400 R4_VARIOS_PERIODOS; del mismo, al de las dos', async () => {
    const e = await error(
      r4(
        [
          { id: julio.id, base: 5, cuota: 1.05 },
          { id: noviembre.id, base: 5, cuota: 1.05 },
        ],
        { lineas: [linea(5), linea(5)] },
      ),
    );
    expect(e.statusCode).toBe(400);
    expect(e.details).toMatchObject({ codigo: 'R4_VARIOS_PERIODOS', campo: 'rectificativa.originales' });
    expect(e.message).toContain(`del 3T de ${ANTES}`);
    const mismo = await r4(
      [
        { id: julio.id, base: 5, cuota: 1.05 },
        { id: julio20.id, base: 5, cuota: 1.05 },
      ],
      { lineas: [linea(5), linea(5)] },
    );
    expect(mismo.fechaOperacion).toBe(`${ANTES}-07-15`);
  });

  it('al 303 ya presentado de la original: 409 que se confirma, con el aviso en la factura y en ese 303', async () => {
    await prisma.modeloImpuesto.create({ data: { companyId: E, codigo: '303', ejercicio: ANTES, periodo: '4T', estado: 'presentado' } });
    const e = await error(r4([{ id: noviembre.id }]));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'DEVENGO_FUERA_APP', motivo: 'rectificar_303', modelo: '303', ejercicio: ANTES, periodo: '4T' });
    expect(await prisma.incomeInvoice.count({ where: { companyId: E, facturaOriginalId: noviembre.id } })).toBe(0);
    const r = await r4([{ id: noviembre.id }], { confirmaDevengoFuera: true });
    expect(r.fechaOperacion).toBe(`${ANTES}-11-10`);
    expect(r.avisosFiscales).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'RECTIFICAR_303' })]));
    const avisos = await avisosAbonosTrasPresentar(E, periodoFiscal(ANTES, '4T'));
    expect(avisos).toEqual([expect.stringContaining(`La rectificativa de venta ${r.numeroCompleto}`)]);
    expect(avisos[0]).toContain('2,10 €');
  });

  it('un borrador que no lo necesitaba, emitido en otro trimestre: al periodo de la original', async () => {
    const borrador = await r4([{ id: julio.id }], { borrador: true, fechaEmision: `${ANTES}-07-25` });
    expect(borrador.fechaOperacion).toBeUndefined();
    const emitida = await incomeInvoicesService.finalizar(E, borrador.id, { fechaEmision: HOY });
    expect(emitida.fechaOperacion).toBe(`${ANTES}-07-15`);
    expect(emitida.avisosFiscales).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'IVA_PERIODO_ORIGINAL' })]));
    // 347 y 349: en el periodo de la emisión; 303 y 390: en el de la original (fechaIva).
    const fiscales = await obtenerFacturasFiscales(E, `${ANTES}-01-01`, `${ANIO}-12-31`);
    expect(fiscales.find((f) => f.idFactura === emitida.numeroCompleto)).toMatchObject({ fecha: HOY, fechaIva: `${ANTES}-07-15` });
    // Solo con el año de la emisión también sale (el 347 de ese año la lleva).
    expect((await obtenerFacturasFiscales(E, `${ANIO}-01-01`, `${ANIO}-12-31`)).some((f) => f.idFactura === emitida.numeroCompleto)).toBe(true);
  });
});
