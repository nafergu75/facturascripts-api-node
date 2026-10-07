/**
 * Correcciones de la revision de divisas y tipo de operacion, sobre BD real:
 *  - las facturas anteriores (sin tipo) conservan su clasificacion aunque se
 *    edite la ficha del cliente (pais congelado en paisClienteLegacy);
 *  - la rectificativa de una factura anterior tampoco lleva tipo y se
 *    contabiliza y se declara como la original;
 *  - el IVA y el libro de IVA van al periodo del devengo (fecha de operacion);
 *  - la rectificativa total en divisa guardada como borrador y emitida despues
 *    sigue siendo el espejo exacto de la original;
 *  - una nacional con suplidos (lineas al 0 %) se emite, como siempre;
 *  - modificar y emitir a la vez no deja una factura emitida a medias;
 *  - no se rectifica un borrador ni una proforma por POST /income-invoices;
 *  - "volver al BCE" al emitir; sin aviso de cuenta en otra moneda;
 *  - lo recibido en el banco se compara con el tipo de referencia;
 *  - moneda y pais de la empresa: cuentas bancarias y documentos.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import axios from 'axios';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import * as tiposCambio from '../services/tiposCambio.service';
import { calcularModelo303, calcularModelo347, calcularModelo349, obtenerFacturasFiscales } from '../services/impuestosCalculo.service';
import { taxModelsService } from '../services/tax-models.service';
import { clientesService } from '../services/clientes.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { accountingHooksService } from '../services/accounting-hooks.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { avisosFactura } from '../services/facturaPdf.service';
import { legalConfigService } from '../services/legalConfig.service';
import type { PeriodoFiscal } from '../domain/impuestos.model';

const get = (axios as unknown as { get: jest.Mock }).get;
const motor = new AccountingEngineController();
const T1: PeriodoFiscal = { ejercicio: 2026, periodo: '1T', tipo: 'trimestral', fechaInicio: '2026-01-01', fechaFin: '2026-03-31' };
// Las pruebas en divisa van en 2024: la cache de tipos del BCE es comun a toda la BD de pruebas
// y otras suites cuentan con que no haya tipo guardado en sus fechas de 2026.
const T1_24: PeriodoFiscal = { ejercicio: 2024, periodo: '1T', tipo: 'trimestral', fechaInicio: '2024-01-01', fechaFin: '2024-03-31' };
const T2_24: PeriodoFiscal = { ejercicio: 2024, periodo: '2T', tipo: 'trimestral', fechaInicio: '2024-04-01', fechaFin: '2024-06-30' };

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
  const id = `revision-div-${Date.now()}-${++n}`;
  await prisma.company.create({ data: { id, name: `Revision divisas ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Revision divisas ${n}`, nif: 'B00000000', ...legal } });
  return id;
}
async function cliente(companyId: string, datos: { nifCif: string; pais?: string }): Promise<string> {
  return (await prisma.customer.create({ data: { companyId, nombreFiscal: `Cliente ${datos.nifCif}`, ...datos } })).id;
}
async function banco(companyId: string): Promise<string> {
  return (await prisma.bankAccount.create({ data: { companyId, iban: `ES00${Date.now()}${++n}`, bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
}
const linea = (precio: number, tipoIva = 21, extra: Partial<CrearLineaIngresoDTO> = {}): CrearLineaIngresoDTO => ({
  descripcion: 'Servicio',
  cantidad: 1,
  precioUnitario: precio,
  tipoIva,
  ...extra,
});
const usd = (precio: number, tipoIva = 21) => linea(precio, tipoIva, { moneda: 'USD' });

/** Factura emitida ANTES de los tipos de operacion (sin tipo), como las que ya hay en produccion. */
function antigua(companyId: string, customerId: string, numero: number, fecha: string, base: number, iva: number) {
  return prisma.incomeInvoice.create({
    data: {
      companyId,
      customerId,
      serie: 'L',
      numero,
      numeroCompleto: `L-${numero}`,
      fechaEmision: fecha,
      fechaVencimiento: '2026-12-31',
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      lineas: { create: [{ descripcion: 'Antigua', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: iva ? 21 : 0 }] },
    },
  });
}

/** Saldo de una cuenta en los asientos de facturas de la empresa. */
async function saldo(companyId: string, cuenta: string): Promise<number> {
  const lineas = await prisma.journalEntryLine.findMany({ where: { companyId, accountCode: cuenta, entry: { origen: 'FACTURA_INGRESO' } } });
  return Math.round(lineas.reduce((s, l) => s + l.debe - l.haber, 0) * 100) / 100;
}

beforeEach(() => {
  tiposCambio.limpiarMemoTiposCambio();
  get.mockReset();
  bce('caido');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('facturas anteriores: editar la ficha del cliente no mueve los modelos ya presentados', () => {
  it('cliente ES con NIF-IVA frances: guardar la ficha no reescribe el pais; pasarlo a US congela el de antes', async () => {
    const companyId = await empresa();
    const c = await cliente(companyId, { nifCif: 'FR40303265045' }); // pais ES (el de siempre)
    const a = await antigua(companyId, c, 1, '2026-02-01', 4000, 840);

    const antes303 = await calcularModelo303(companyId, T1);
    expect(antes303.totalCuotaDevengada).toBe(840);
    expect((await calcularModelo347(companyId, 2026)).operaciones.map((o) => o.cifnif)).toEqual(['FR40303265045']);

    // La ficha manda siempre pais y NIF: cambiar solo la direccion no toca el pais.
    await clientesService.update(companyId, c, { pais: 'ES', nifCif: 'FR40303265045', direccion: 'Rue de Rivoli 1' });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c } })).pais).toBe('ES');

    // Cambiarlo de verdad (para facturarle exportaciones nuevas): sus facturas anteriores conservan el de antes.
    await clientesService.update(companyId, c, { pais: 'US' });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c } })).pais).toBe('US');
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: a.id } })).paisClienteLegacy).toBe('ES');

    const despues303 = await calcularModelo303(companyId, T1);
    expect(despues303.totalCuotaDevengada).toBe(840);
    expect(despues303.exportaciones).toBe(antes303.exportaciones);
    expect(despues303.casillas).toEqual(antes303.casillas);
    expect((await calcularModelo347(companyId, 2026)).operaciones.map((o) => o.cifnif)).toEqual(['FR40303265045']);
    const m347 = await taxModelsService.generarModelo347(companyId, 2026);
    expect(m347.terceros.map((t: { nif: string }) => t.nif)).toEqual(['FR40303265045']);

    // La ficha de la factura: clasificada como siempre y sin mencion propia (como su PDF).
    const ficha = await incomeInvoicesService.obtenerPorId(companyId, a.id);
    expect(ficha.tipoOperacionEfectivo).toBe('NACIONAL');
    expect(ficha.mencionFiscal).toBeNull();
  });

  it('cliente FRA importado de FacturaScripts: no pasa a FR al guardar; en otro pais sigue en el 349', async () => {
    const companyId = await empresa();
    const c = await cliente(companyId, { nifCif: 'FR99999999999', pais: 'FRA' });
    await antigua(companyId, c, 1, '2026-02-02', 2000, 0);
    const antes349 = await calcularModelo349(companyId, T1);
    expect(antes349.operaciones).toEqual([expect.objectContaining({ cifnif: 'FR99999999999', clave: 'E', base: 2000 })]);

    await clientesService.update(companyId, c, { pais: 'FR', direccion: 'Rue 2' });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c } })).pais).toBe('FRA');

    await clientesService.update(companyId, c, { pais: 'BE' });
    expect(await calcularModelo349(companyId, T1)).toEqual(antes349);
    expect((await calcularModelo303(companyId, T1)).entregasIntracomunitarias).toBe(2000);
  });
});

describe('rectificativa de una factura anterior', () => {
  it('sin tipo propio: se contabiliza como la original (la 477 se anula) y sin mencion de exencion', async () => {
    const companyId = await empresa();
    // Pais ISO-2 'FR' con IVA: la clasificacion de siempre la daba como exportacion, pero lleva IVA.
    const c = await cliente(companyId, { nifCif: 'FR11111111111', pais: 'FR' });
    const a = await antigua(companyId, c, 1, '2026-02-03', 100, 21);
    expect((await accountingHooksService.onIncomeInvoiceConfirmed(companyId, a.id)).contabilizada).toBe(true);

    const r = await incomeInvoicesService.crearRectificativa(companyId, a.id, { motivo: 'Anulación' });
    expect(r.tipoOperacion).toBeUndefined();
    expect(r.mencionFiscal).toBeNull();
    expect([r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual([-100, -21, -121]);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.id } })).paisClienteLegacy).toBe('FR');

    const res = await accountingHooksService.onIncomeInvoiceConfirmed(companyId, r.id);
    expect(res.contabilizada).toBe(true);
    expect([await saldo(companyId, '430'), await saldo(companyId, '700'), await saldo(companyId, '477')]).toEqual([0, 0, 0]);

    // En los modelos, la pareja se clasifica igual (la de siempre) y se anula.
    const fiscales = await obtenerFacturasFiscales(companyId, '2026-01-01', '2099-12-31');
    expect(fiscales.map((f) => f.operacion)).toEqual(['exportacion', 'exportacion']);
    expect(fiscales.reduce((s, f) => s + f.lineas.reduce((x, l) => x + l.base, 0), 0)).toBe(0);
  });

  it('tambien emitida desde un borrador', async () => {
    const companyId = await empresa();
    const c = await cliente(companyId, { nifCif: 'B22222222' });
    const a = await antigua(companyId, c, 1, '2026-02-04', 300, 63);
    const b = await incomeInvoicesService.crearRectificativa(companyId, a.id, { motivo: 'Error', borrador: true });
    const r = await incomeInvoicesService.finalizar(companyId, b.id);
    expect(r.tipoOperacion).toBeUndefined();
    expect([r.baseTotal, r.ivaTotal]).toEqual([-300, -63]);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.id } })).paisClienteLegacy).toBe('ES');
  });
});

describe('devengo: la operacion de un trimestre facturada en el siguiente', () => {
  it('nacional en USD: tipo, 303 y libro de IVA en el periodo de la operacion', async () => {
    bce({ 'USD|2024-03-27': 1.1, 'USD|2024-04-02': 1.2 });
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B12312312' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2024-04-03',
      fechaOperacion: '2024-03-27',
      moneda: 'USD',
      tipoOperacion: 'NACIONAL',
      lineas: [usd(11000)],
      borrador: true,
    });
    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2024-04-03' });
    expect(f).toMatchObject({ fechaOperacion: '2024-03-27', fechaTipoCambio: '2024-03-27', tipoCambio: 1.1, baseTotal: 10000, ivaTotal: 2100 });

    expect((await calcularModelo303(companyId, T1_24)).totalCuotaDevengada).toBe(2100);
    expect((await calcularModelo303(companyId, T2_24)).totalCuotaDevengada).toBe(0);
    const fiscales = await obtenerFacturasFiscales(companyId, '2024-01-01', '2024-03-31');
    expect(fiscales.map((x) => [x.idFactura, x.fecha])).toEqual([[f.numeroCompleto, '2024-03-27']]);

    await motor.contabilizarFacturaIngreso(companyId, f.id);
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId, numeroFactura: f.numeroCompleto! } });
    expect(libro.fechaFactura.toISOString().slice(0, 10)).toBe('2024-03-27');
    expect(libro.observaciones).toBe('Fecha de expedición: 03/04/2024');
    // El asiento, con la fecha de emision (como siempre).
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { companyId, invoiceId: f.id } });
    expect(asiento.fecha.toISOString().slice(0, 10)).toBe('2024-04-03');
  });

  it('entrega intracomunitaria: se devenga al emitir la factura antes del dia 15 (art. 75.Uno.8.º): 349 de abril', async () => {
    const companyId = await empresa();
    const fr = await cliente(companyId, { nifCif: 'FR12345678901', pais: 'FR' });
    await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: fr },
      fechaEmision: '2024-04-03',
      fechaOperacion: '2024-03-27',
      tipoOperacion: 'INTRACOMUNITARIA',
      lineas: [linea(5000, 0)],
    });
    expect((await calcularModelo349(companyId, T1_24)).operaciones).toEqual([]);
    expect((await calcularModelo349(companyId, T2_24)).operaciones).toEqual([expect.objectContaining({ cifnif: 'FR12345678901', clave: 'E', base: 5000 })]);
  });
});

describe('rectificativa total en divisa guardada como borrador', () => {
  it('al emitirla sigue siendo el espejo exacto: la pareja suma cero en las dos monedas', async () => {
    bce({ 'USD|2024-05-06': 1.1 });
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B45645645' });
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2024-05-06',
      moneda: 'USD',
      tipoOperacion: 'NACIONAL',
      lineas: [usd(100.125)],
    });
    expect([f.baseTotalDoc, f.ivaTotalDoc, f.totalFacturaDoc]).toEqual([100.13, 21.03, 121.16]);
    expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([91.03, 19.12, 110.15]);

    const b = await incomeInvoicesService.crearRectificativa(companyId, f.id, { motivo: 'Anulación', borrador: true });
    const r = await incomeInvoicesService.finalizar(companyId, b.id);
    expect([r.baseTotalDoc, r.ivaTotalDoc, r.totalFacturaDoc]).toEqual([-100.13, -21.03, -121.16]);
    expect([r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual([-91.03, -19.12, -110.15]);
    expect(r.lineas.map((l) => [l.baseLine, l.ivaImporte, l.baseLineDoc, l.ivaImporteDoc])).toEqual([[-91.03, -19.12, -100.13, -21.03]]);

    await motor.contabilizarFacturaIngreso(companyId, f.id);
    await motor.contabilizarFacturaIngreso(companyId, r.id);
    expect([await saldo(companyId, '430'), await saldo(companyId, '700'), await saldo(companyId, '477')]).toEqual([0, 0, 0]);
  });
});

describe('nacional con suplidos (alguna linea al 0 %)', () => {
  it('se emite como siempre, con aviso; tambien un borrador sin tipo', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B78978978' });
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2026-05-05',
      lineas: [linea(1000, 21), linea(50, 0)],
    });
    expect(f).toMatchObject({ estadoDocumento: 'FINAL', tipoOperacion: 'NACIONAL', totalFactura: 1260 });
    expect(f.avisosFiscales?.map((a) => a.codigo)).toContain('LINEAS_AL_0');

    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2026-05-06',
      lineas: [linea(1000, 21), linea(50, 0)],
      borrador: true,
    });
    const f2 = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-05-06' });
    expect(f2).toMatchObject({ estadoDocumento: 'FINAL', tipoOperacion: 'NACIONAL', totalFactura: 1260 });

    // Todo al 0 % no es nacional.
    await expect(
      incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, tipoOperacion: 'NACIONAL', lineas: [linea(50, 0)] }),
    ).rejects.toThrow(/Todas las líneas van al 0 %/);
  });
});

describe('modificar y emitir a la vez', () => {
  it('emitir no pisa un cambio hecho mientras se resolvia el tipo de cambio', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B31231231' });
    const b = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, fechaEmision: '2026-06-01', lineas: [linea(100)], borrador: true });
    const espia = jest.spyOn(tiposCambio, 'resolverTipoCambio').mockImplementationOnce(async () => {
      // Otra peticion guarda el borrador mientras tanto.
      await prisma.incomeInvoice.update({ where: { id: b.id }, data: { observaciones: 'cambiado por otra pestaña' } });
      return { tipoCambio: 1, fechaTipoCambio: null, fuente: 'PAR', provisional: false };
    });
    await expect(incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-06-01' })).rejects.toThrow(/ha cambiado/);
    espia.mockRestore();
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).estadoDocumento).toBe('BORRADOR');
    // Al repetir, se emite (con el numero 1: el intento fallido no deja hueco).
    expect(await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-06-01' })).toMatchObject({ estadoDocumento: 'FINAL', numero: 1 });
  });

  it('guardar el borrador no toca la factura si otra pestaña la ha emitido mientras se consultaba el BCE', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B32132132' });
    const b = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, fechaEmision: '2026-06-02', lineas: [linea(200)], borrador: true });
    const espia = jest.spyOn(tiposCambio, 'resolverTipoCambio').mockImplementationOnce(async () => {
      await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2026-06-02' });
      return { tipoCambio: 1.1, fechaTipoCambio: '2026-06-02', fuente: 'BCE', provisional: false };
    });
    await expect(incomeInvoicesService.actualizarBorrador(companyId, b.id, { moneda: 'USD', lineas: [usd(300)] })).rejects.toThrow(/ha cambiado/);
    espia.mockRestore();
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id }, include: { lineas: true } });
    expect(f).toMatchObject({ estadoDocumento: 'FINAL', moneda: 'EUR', totalFactura: 242, fuenteTipoCambio: 'PAR' });
    expect(f.lineas.map((l) => l.baseLine)).toEqual([200]);
  });
});

describe('rectificativa por POST /income-invoices', () => {
  it('solo de una factura emitida: ni de un borrador ni de una proforma', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B65465465' });
    const borrador = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, lineas: [linea(100)], borrador: true });
    const proforma = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, lineas: [linea(100)], proforma: true });
    for (const [original, motivo] of [
      [borrador.id, /borrador no se rectifica/],
      [proforma.id, /proforma no se rectifica/],
    ] as const) {
      await expect(
        incomeInvoicesService.crearIngreso({
          companyId,
          customer: { id: es },
          facturaOriginalId: original,
          tipoFactura: 'R1',
          motivoRectificacion: 'x',
          lineas: [linea(-10)],
        }),
      ).rejects.toThrow(motivo);
    }
  });
});

describe('tipo de cambio al emitir y avisos', () => {
  it('con tipoCambio null al emitir se deja el manual del borrador y se aplica el del BCE', async () => {
    bce({ 'USD|2024-06-05': 1.15 });
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B98798798' });
    const b = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2024-06-05',
      moneda: 'USD',
      tipoCambio: 1.2,
      lineas: [usd(120)],
      borrador: true,
    });
    expect(b).toMatchObject({ fuenteTipoCambio: 'MANUAL', tipoCambio: 1.2 });
    const f = await incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: '2024-06-05', tipoCambio: null });
    expect(f).toMatchObject({ fuenteTipoCambio: 'BCE', tipoCambio: 1.15, fechaTipoCambio: '2024-06-05' });

    // Sin aviso de "cuenta en la moneda de la factura": las cuentas van en la moneda de la contabilidad.
    await banco(companyId);
    expect(await avisosFactura(companyId, f.id)).not.toContain('CUENTA_BANCARIA_MONEDA');
  });

  it('lo recibido en el banco se compara con el tipo de referencia del dia del cobro', async () => {
    bce({ 'USD|2024-06-06': 1.1, 'USD|2024-06-12': 1.1 });
    const companyId = await empresa();
    const es = await cliente(companyId, { nifCif: 'B15915915' });
    const cuenta = await banco(companyId);
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: es },
      fechaEmision: '2024-06-06',
      moneda: 'USD',
      tipoOperacion: 'NACIONAL',
      lineas: [usd(1000)],
    });
    await motor.contabilizarFacturaIngreso(companyId, f.id);
    // Una errata (un cero de mas) daria una 768 desorbitada: 400.
    await expect(
      registrarCobroFactura(companyId, 'INGRESO', f.id, { fecha: '2024-06-12', importeDoc: 1000, importeRecibido: 10000, cuentaBancariaId: cuenta }),
    ).rejects.toThrow(/Lo recibido en el banco equivale/);
    // Una cifra razonable se acepta.
    const { cobro } = await registrarCobroFactura(companyId, 'INGRESO', f.id, {
      fecha: '2024-06-12',
      importeDoc: 1000,
      importeRecibido: 905,
      cuentaBancariaId: cuenta,
    });
    expect(cobro).toMatchObject({ fuenteTipoCambio: 'BANCO', importeTesoreria: 905 });
  });
});

describe('pais y moneda de la contabilidad de la empresa', () => {
  it('sin documentos: al pasar a EE. UU. la contabilidad y sus cuentas bancarias pasan a USD', async () => {
    const companyId = await empresa();
    const cuenta = await banco(companyId);
    const r = await legalConfigService.actualizar(companyId, { pais: 'US' });
    expect(r.monedaCuenta).toBe('USD');
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: cuenta } })).moneda).toBe('USD');
    // EE. UU. trabaja solo en dolares.
    await expect(legalConfigService.actualizar(companyId, { monedaCuenta: 'EUR' })).rejects.toThrow(/dólares/);
  });

  it('con facturas: no se pasa de Espana a otro pais (el PDF y los modelos de lo emitido no cambian)', async () => {
    const companyId = await empresa();
    const us = await cliente(companyId, { nifCif: '12-3456789', pais: 'US' });
    await incomeInvoicesService.crearIngreso({ companyId, customer: { id: us }, tipoOperacion: 'EXPORTACION', lineas: [linea(1000, 0)] });
    await expect(legalConfigService.actualizar(companyId, { pais: 'US' })).rejects.toThrow(/ya tiene facturas/);
    expect((await prisma.legalConfig.findUniqueOrThrow({ where: { companyId } })).pais).toBe('ES');
    // Los demas datos se siguen guardando.
    await expect(legalConfigService.actualizar(companyId, { telefono: '960000000' })).resolves.toMatchObject({ telefono: '960000000' });
  });
});
