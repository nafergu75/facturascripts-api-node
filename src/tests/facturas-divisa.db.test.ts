/**
 * Facturas de venta en divisa y tipo de operacion de IVA sobre BD real:
 * tipo de cambio del BCE (simulado) o manual, congelado al emitir; importes de
 * cuenta en euros y de documento en dolares; rectificativa heredada; factura
 * exenta; empresa de EE. UU. sin IVA; y las facturas EUR, igual que siempre.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import axios from 'axios';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { limpiarMemoTiposCambio } from '../services/tiposCambio.service';
import { obtenerFacturasFiscales } from '../services/impuestosCalculo.service';

const get = (axios as unknown as { get: jest.Mock }).get;

const CABECERA = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS';
/** BCE simulado: ultima observacion <= endPeriod de las indicadas, o caido. */
function bce(valores: Record<string, number> | 'caido'): void {
  get.mockImplementation(async (url: string) => {
    if (valores === 'caido' || !url.includes('data-api.ecb.europa.eu')) throw new Error('BCE caído');
    const moneda = /D\.([A-Z]{3})\.EUR/.exec(url)?.[1] ?? '';
    const fin = /endPeriod=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? '';
    const fechas = Object.keys(valores)
      .filter((k) => k.startsWith(`${moneda}|`) && k.slice(4) <= fin)
      .sort();
    if (fechas.length === 0) return { data: '' };
    const k = fechas[fechas.length - 1];
    return { data: `${CABECERA}\nEXR.D.${moneda}.EUR.SP00.A,D,${moneda},EUR,SP00,A,${k.slice(4)},${valores[k]},A\n` };
  });
}

let n = 0;
async function empresa(legal: { pais?: string; monedaCuenta?: string } = {}): Promise<string> {
  const id = `divisas-test-${Date.now()}-${++n}`;
  await prisma.company.create({ data: { id, name: `Divisas ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Divisas ${n}`, nif: 'B00000000', ...legal } });
  return id;
}
async function cliente(companyId: string, datos: { nifCif: string; pais?: string; monedaPreferida?: string }): Promise<string> {
  const c = await prisma.customer.create({ data: { companyId, nombreFiscal: `Cliente ${datos.nifCif}`, ...datos } });
  return c.id;
}
const linea = (precio: number, tipoIva = 21, extra: Partial<CrearLineaIngresoDTO> = {}): CrearLineaIngresoDTO => ({
  descripcion: 'Servicio',
  cantidad: 1,
  precioUnitario: precio,
  tipoIva,
  ...extra,
});
const usd = (precio: number, tipoIva = 21) => linea(precio, tipoIva, { moneda: 'USD' });

beforeEach(() => {
  limpiarMemoTiposCambio();
  get.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('factura en USD de una empresa espanola', () => {
  it('emitir fija el tipo del BCE del devengo: base y cuota en euros, documento en dolares', async () => {
    bce({ 'USD|2026-09-21': 1.149 });
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B11111111' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: esp },
      fechaEmision: '2026-09-21',
      moneda: 'usd',
      lineas: [usd(1000)],
      borrador: true,
    });
    expect(b).toMatchObject({ moneda: 'USD', monedaCuenta: 'EUR', fuenteTipoCambio: 'BCE', tipoCambio: 1.149, tipoCambioProvisional: true });
    expect(b.totalFacturaDoc).toBe(1210);
    expect(b.totalFactura).toBe(1053.09);

    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-09-21' });
    expect(f).toMatchObject({
      estadoDocumento: 'FINAL',
      tipoOperacion: 'NACIONAL',
      fuenteTipoCambio: 'BCE',
      fechaTipoCambio: '2026-09-21',
      tipoCambio: 1.149,
      textoTipoCambio: '1 EUR = 1,1490 USD',
      tipoCambioProvisional: false,
      baseTotal: 870.32,
      ivaTotal: 182.77,
      totalFactura: 1053.09,
      baseTotalDoc: 1000,
      ivaTotalDoc: 210,
      totalFacturaDoc: 1210,
    });
    expect(f.lineas[0]).toMatchObject({ baseLine: 870.32, ivaImporte: 182.77, baseLineDoc: 1000, ivaImporteDoc: 210, precioUnitarioDoc: 1000 });

    // Los modelos de la AEAT leen las columnas de cuenta: euros.
    const fiscales = await obtenerFacturasFiscales(companyId, '2026-09-01', '2026-09-30');
    expect(fiscales.find((x) => x.idFactura === f.numeroCompleto)?.lineas).toEqual([{ tipoIva: 21, base: 870.32, cuota: 182.77 }]);

    // Una emitida no se recalcula ni se vuelve a emitir.
    await expect(incomeInvoicesService.finalizar(companyId, f.id)).rejects.toThrow(/emitida/);

    // Rectificativa total: misma moneda y mismo tipo (HEREDADO); la pareja suma cero.
    const r = await incomeInvoicesService.crearRectificativa(companyId, f.id, { motivo: 'Anulación' });
    expect(r).toMatchObject({ moneda: 'USD', fuenteTipoCambio: 'HEREDADO', tipoCambio: 1.149, tipoOperacion: 'NACIONAL' });
    expect([r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual([-870.32, -182.77, -1053.09]);
    expect(r.totalFacturaDoc).toBe(-1210);
    await expect(incomeInvoicesService.crearRectificativa(companyId, f.id, { motivo: 'x', moneda: 'EUR' })).rejects.toThrow(/moneda/);
    await expect(
      incomeInvoicesService.crearIngreso({
        companyId,
        customer: { id: esp },
        facturaOriginalId: f.id,
        motivoRectificacion: 'x',
        moneda: 'EUR',
        lineas: [linea(-10)],
      }),
    ).rejects.toThrow(/moneda/);

    // Duplicar copia la moneda y los precios en dolares, y pide tipo nuevo (no lo hereda).
    const copia = await incomeInvoicesService.duplicar(companyId, f.id);
    expect(copia).toMatchObject({ estadoDocumento: 'BORRADOR', moneda: 'USD' });
    expect(copia.fuenteTipoCambio).not.toBe('HEREDADO');
    expect(copia.lineas[0].precioUnitarioDoc).toBe(1000);
  });

  it('emitir en otra fecha vuelve a pedir el tipo y recalcula lineas y cabecera', async () => {
    bce({ 'USD|2026-09-21': 1.149, 'USD|2026-09-22': 1.1 });
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B22222222' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: esp },
      fechaEmision: '2026-09-21',
      moneda: 'USD',
      lineas: [usd(1000)],
      borrador: true,
    });
    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-09-22' });
    expect(f).toMatchObject({ tipoCambio: 1.1, fechaTipoCambio: '2026-09-22', baseTotal: 909.09, ivaTotal: 190.91, totalFactura: 1100 });
    expect(f.lineas[0].baseLine).toBe(909.09);
  });

  it('sin BCE: borrador PENDIENTE, emitir da 400 y con tipo manual se emite; el invertido se rechaza', async () => {
    bce('caido');
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B33333333' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: esp },
      fechaEmision: '2026-08-04',
      moneda: 'USD',
      lineas: [usd(1000)],
      borrador: true,
    });
    expect(b.fuenteTipoCambio).toBe('PENDIENTE');
    expect(b.totalFactura).toBe(0);
    expect(b.totalFacturaDoc).toBe(1210);
    await expect(incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-08-04' })).rejects.toThrow(/indícalo a mano/);

    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-08-04', tipoCambio: '1,15' });
    expect(f).toMatchObject({ fuenteTipoCambio: 'MANUAL', tipoCambio: 1.15, baseTotal: 869.57, numero: 1 });

    // Con el BCE disponible, un tipo invertido no se acepta.
    limpiarMemoTiposCambio();
    bce({ 'USD|2026-08-05': 1.149 });
    const b2 = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: esp },
      fechaEmision: '2026-08-05',
      moneda: 'USD',
      lineas: [usd(100)],
      borrador: true,
    });
    await expect(incomeInvoicesService.finalizar(companyId, b2.id, { fechaEmision: '2026-08-05', tipoCambio: 0.87 })).rejects.toThrow(/invertido/);
  });

  it('los precios no se convierten solos: cambiar la moneda exige lineas, y en divisa cada linea dice su moneda', async () => {
    bce({ 'USD|2026-09-21': 1.149, 'USD|2026-09-22': 1.1 });
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B44444444' });
    const eur = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, lineas: [linea(100)], borrador: true });
    await expect(incomeInvoicesService.actualizarBorrador(companyId, eur.id, { moneda: 'USD' })).rejects.toThrow(/no se convierten/);
    const enUsd = await incomeInvoicesService.actualizarBorrador(companyId, eur.id, { moneda: 'USD', lineas: [usd(50)], fechaEmision: '2026-09-21' });
    expect(enUsd).toMatchObject({ moneda: 'USD', totalFacturaDoc: 60.5, fuenteTipoCambio: 'BCE' });
    // Un formulario antiguo que reenvia las lineas sin moneda: 400.
    await expect(incomeInvoicesService.actualizarBorrador(companyId, eur.id, { lineas: [linea(50)] })).rejects.toThrow(/moneda de la línea/);
    // Sin lineas nuevas, cambiar la fecha pide el tipo de ese dia y recalcula desde los precios en dolares.
    const otraFecha = await incomeInvoicesService.actualizarBorrador(companyId, eur.id, { fechaEmision: '2026-09-22' });
    expect(otraFecha).toMatchObject({ tipoCambio: 1.1, fechaTipoCambio: '2026-09-22', totalFacturaDoc: 60.5, totalFactura: 54.99 });
    expect(otraFecha.lineas[0].precioUnitarioDoc).toBe(50);
  });

  it('proforma en USD: pasa a factura con la moneda y los precios en dolares', async () => {
    bce({ 'USD|2026-09-21': 1.149 });
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B55555555' });
    const p = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, moneda: 'USD', lineas: [usd(250)], proforma: true });
    expect(p).toMatchObject({ estadoDocumento: 'PROFORMA', moneda: 'USD' });
    const f = await incomeInvoicesService.pasarProformaAFactura(companyId, p.id);
    expect(f).toMatchObject({ estadoDocumento: 'BORRADOR', moneda: 'USD', proformaId: p.id });
    expect(f.lineas[0].precioUnitarioDoc).toBe(250);
  });
});

describe('tipo de operacion', () => {
  it('factura exenta: sin supuesto no se emite; con causa y precepto, si', async () => {
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B66666666' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: esp },
      tipoOperacion: 'EXENTA',
      lineas: [linea(500, 0)],
      borrador: true,
    });
    expect(b.tipoOperacion).toBe('EXENTA');
    expect(b.avisosFiscales?.map((a) => a.codigo)).toContain('EXENCION_SIN_SUPUESTO');
    await expect(incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-09-10' })).rejects.toThrow(/supuesto de exención/);

    await incomeInvoicesService.actualizarBorrador(companyId, b.id, { causaExencion: 'E1', referenciaLegal: 'art. 20.Uno.9.º Ley 37/1992' });
    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-09-10' });
    expect(f).toMatchObject({ tipoOperacion: 'EXENTA', causaExencion: 'E1', ivaTotal: 0, baseTotal: 500, totalFactura: 500 });
    expect(f.mencionFiscal?.es).toBe('Operación exenta de IVA – art. 20.Uno.9.º Ley 37/1992');

    // Una linea con IVA en una exenta es una contradiccion: 400 tambien al guardar.
    await expect(
      incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, tipoOperacion: 'EXENTA', lineas: [linea(10, 21)], borrador: true }),
    ).rejects.toThrow(/0 %/);
    // Una empresa espanola no puede elegir EMPRESA_EXTRANJERA.
    await expect(
      incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, tipoOperacion: 'EMPRESA_EXTRANJERA', lineas: [linea(10, 0)], borrador: true }),
    ).rejects.toThrow(/no válido/);
  });

  it('sin tipo: con IVA es NACIONAL; mezclada no se emite; `origen` del cuerpo se ignora', async () => {
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B77777777' });
    const f = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, fechaEmision: '2026-09-01', lineas: [linea(100)] });
    expect(f.tipoOperacion).toBe('NACIONAL');
    const mezclada = { companyId, customer: { id: esp }, fechaEmision: '2026-09-02', lineas: [linea(100), linea(50, 0)], origen: 'lector' };
    await expect(incomeInvoicesService.crearIngreso(mezclada as never)).rejects.toThrow(/tipo de operación/);
    // Desde el lector (lo decide el servidor) no se rechaza: queda para revisar.
    const leida = await incomeInvoicesService.crearIngreso(mezclada as never, { origen: 'lector' });
    expect(leida.estadoDocumento).toBe('FINAL');
    expect(leida.avisosFiscales?.length).toBeGreaterThan(0);
  });

  it('empresa de EE. UU.: factura en USD sin IVA ni retencion aunque lleguen', async () => {
    const companyId = await empresa({ pais: 'US', monedaCuenta: 'USD' });
    const us = await cliente(companyId, { nifCif: '12-3456789', pais: 'US' });
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: us },
      fechaEmision: '2026-09-15',
      lineas: [linea(1000, 21, { tipoRetencion: 15 })],
    });
    expect(f).toMatchObject({
      tipoOperacion: 'EMPRESA_EXTRANJERA',
      moneda: 'USD',
      monedaCuenta: 'USD',
      fuenteTipoCambio: 'PAR',
      baseTotal: 1000,
      ivaTotal: 0,
      retencionTotal: 0,
      totalFactura: 1000,
      totalFacturaDoc: 1000,
      mencionFiscal: null,
    });
    expect(f.lineas[0]).toMatchObject({ tipoIva: 0, tipoRetencion: 0 });
    expect(f.avisosFiscales?.map((a) => a.codigo)).toEqual(['IVA_ELIMINADO_EMPRESA_EXTRANJERA']);
    // Solo trabaja en su moneda.
    await expect(
      incomeInvoicesService.crearIngreso({ companyId, customer: { id: us }, moneda: 'EUR', lineas: [linea(10, 0)], borrador: true }),
    ).rejects.toThrow(/EUR no está habilitada/);
  });
});

describe('facturas en euros: igual que siempre', () => {
  it('una factura nueva en EUR va a la par y sus *Doc son copia literal', async () => {
    const companyId = await empresa();
    // monedaPreferida solo la propone el formulario: el backend no la aplica.
    const esp = await cliente(companyId, { nifCif: 'B88888888', monedaPreferida: 'USD' });
    const f = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: esp }, lineas: [linea(100), linea(40, 10)] });
    expect(f).toMatchObject({ moneda: 'EUR', fuenteTipoCambio: 'PAR', tipoCambio: 1, baseTotal: 140, ivaTotal: 25, totalFactura: 165 });
    const guardada = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id }, include: { lineas: true } });
    expect([guardada.baseTotalDoc, guardada.ivaTotalDoc, guardada.totalFacturaDoc]).toEqual([140, 25, 165]);
    expect(guardada.baseTotal + guardada.ivaTotal).toBe(165);
    for (const l of guardada.lineas) expect(l.baseLineDoc).toBe(l.baseLine);
  });

  it('una factura anterior (sin *Doc ni moneda) responde igual que hoy', async () => {
    const companyId = await empresa();
    const esp = await cliente(companyId, { nifCif: 'B99999999' });
    const antigua = await prisma.incomeInvoice.create({
      data: {
        companyId,
        customerId: esp,
        serie: 'A',
        numero: 900,
        numeroCompleto: 'A-900',
        fechaEmision: '2025-01-10',
        fechaVencimiento: '2025-01-25',
        baseTotal: 100,
        ivaTotal: 21,
        totalFactura: 121,
        lineas: { create: [{ descripcion: 'Antigua', cantidad: 1, precioUnitario: 100, baseLine: 100, ivaImporte: 21 }] },
      },
    });
    const r = await incomeInvoicesService.obtenerPorId(companyId, antigua.id);
    expect(r).toMatchObject({
      moneda: 'EUR',
      fuenteTipoCambio: 'PAR',
      totalFactura: 121,
      totalFacturaDoc: 121,
      baseTotalDoc: 100,
      tipoOperacionEfectivo: 'NACIONAL',
      tipoCambioProvisional: false,
    });
    expect(r.tipoOperacion).toBeUndefined();
    expect(r.lineas[0]).toMatchObject({ baseLine: 100, baseLineDoc: 100, precioUnitarioDoc: 100 });
  });
});
