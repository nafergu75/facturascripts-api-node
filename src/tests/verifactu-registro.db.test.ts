/**
 * VERI*FACTU F1 sobre BD real: cada factura que emite la app (emision directa,
 * borrador finalizado, rectificativas) lleva su registro de alta encadenado,
 * creado en la misma transaccion que la numera; lo que no se emite desde la
 * app (lector, borradores, proformas) o no esta en VERI*FACTU no lo lleva.
 *
 * Necesita MySQL.
 */
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import { describe, it, expect, beforeAll } from '@jest/globals';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import { limpiarMemoTiposCambio } from '../services/tiposCambio.service';
import { cadenaAlta, huella } from '../services/verifactu/huella';
import { comprobarCadena } from '../services/verifactu/cadena';
import type { RegistroContenido } from '../services/verifactu/tipos';
import { fechaAeat, instanteDeHuso } from '../services/verifactu/formato';
import { hoyEspana } from '../utils/fechas';

const get = (axios as unknown as { get: jest.Mock }).get;
const CABECERA = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `vfreg-${SUFIJO}`;
const DESACT = `vfreg-des-${SUFIJO}`;
const SINCONF = `vfreg-sin-${SUFIJO}`;
const FUTURA = `vfreg-fut-${SUFIJO}`;
const FORAL = `vfreg-for-${SUFIJO}`;
const USA = `vfreg-usa-${SUFIJO}`;
const EMPRESAS = [E, DESACT, SINCONF, FUTURA, FORAL, USA];
const HOY = hoyEspana();

/** CIF de sociedad limitada valido y distinto en cada ejecucion. */
function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}

const NIF_E = cifSl();
const NIF_CANARIAS = cifSl();
const clientes: Record<string, Record<string, string>> = {};
const linea = (precio = 100, tipoIva = 21, extra: Record<string, unknown> = {}) => ({ descripcion: 'Servicio de consultoría', cantidad: 1, precioUnitario: precio, tipoIva, ...extra });
const emitir = (extra: Partial<CrearFacturaIngresoDTO> & Record<string, unknown> = {}, companyId = E, cliente = clientes[E]?.es) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: cliente }, fechaEmision: HOY, lineas: [linea()], ...extra } as CrearFacturaIngresoDTO);
const registrosDe = (incomeInvoiceId: string) => prisma.verifactuRegistro.findMany({ where: { incomeInvoiceId }, orderBy: { numeroEnCadena: 'asc' } });
const cadenaDe = (companyId: string) => prisma.verifactuRegistro.findMany({ where: { companyId, entorno: 'PRUEBAS' }, orderBy: { numeroEnCadena: 'asc' } });
const contenido = (r: { contenido: unknown }) => r.contenido as unknown as RegistroContenido;
async function unico(incomeInvoiceId: string) {
  const rs = await registrosDe(incomeInvoiceId);
  expect(rs).toHaveLength(1);
  return rs[0];
}

beforeAll(async () => {
  limpiarMemoTiposCambio();
  get.mockImplementation(async (url: string) => {
    if (!url.includes('data-api.ecb.europa.eu')) throw new Error('sin red');
    const fin = /endPeriod=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? HOY;
    return { data: `${CABECERA}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${fin},1.149,A\n` };
  });
  for (const id of EMPRESAS) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({
      data:
        id === USA
          ? { companyId: id, tipoSociedad: 'LLC', pais: 'US', monedaCuenta: 'USD', denominacion: 'Registro USA LLC', nif: '12-3456789' }
          : { companyId: id, tipoSociedad: 'SL', denominacion: `Registro ${id === E ? 'Principal' : 'Otra'} SL`, nif: id === E ? NIF_E : cifSl(), municipio: 'Valencia' },
    });
    await listarSeries(id);
    clientes[id] = {
      es: (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'Cliente Nacional SL', nifCif: 'B12345674', pais: 'ES', cp: '46001' } })).id,
    };
  }
  clientes[E].fr = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Client France SARL', nifCif: 'FR12345678901', pais: 'FR' } })).id;
  clientes[E].us = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Customer Inc', nifCif: '12-3456789', pais: 'US' } })).id;
  clientes[E].can = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Canario SL', nifCif: NIF_CANARIAS, pais: 'ES', cp: '35001' } })).id;
  clientes[E].sinNif = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Particular sin NIF', nifCif: '', pais: 'ES' } })).id;

  await prisma.verifactuConfig.create({ data: { companyId: E, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  await prisma.verifactuConfig.create({ data: { companyId: DESACT, estado: 'DESACTIVADO' } });
  await prisma.verifactuConfig.create({ data: { companyId: FUTURA, estado: 'ACTIVO', entorno: 'PRUEBAS', activaDesde: new Date(Date.now() + 30 * 86_400_000) } });
  await prisma.verifactuConfig.create({ data: { companyId: FORAL, estado: 'PRUEBAS', entorno: 'PRUEBAS', motivoExclusion: 'FORAL' } });
  await prisma.verifactuConfig.create({ data: { companyId: USA, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
});

describe('emisión directa y encadenamiento', () => {
  it('la primera emisión crea el registro 1: primer registro, huella recalculable y estado PENDIENTE', async () => {
    const f = await emitir({ lineas: [linea(1000, 21), linea(200, 10)] });
    const r = await unico(f.id);
    expect(r).toMatchObject({
      companyId: E,
      entorno: 'PRUEBAS',
      tipo: 'ALTA',
      numeroEnCadena: 1,
      registroAnteriorId: null,
      huellaAnterior: null,
      idEmisor: NIF_E,
      numSerie: f.numeroCompleto,
      fechaExpedicion: fechaAeat(HOY),
      tipoFactura: 'F1',
      cuotaTotal: '230.00',
      importeTotal: '1430.00',
      estadoEnvio: 'PENDIENTE',
      xml: null,
    });
    const c = contenido(r);
    expect(c.encadenamiento).toEqual({ primerRegistro: true });
    expect(c).toMatchObject({ version: 1, idVersion: '1.0', tipoHuella: '01', refExterna: f.id, nombreEmisor: 'Registro Principal SL' });
    expect(c.destinatarios).toEqual([{ nombre: 'Cliente Nacional SL', nif: 'B12345674' }]);
    expect(c.desglose).toHaveLength(2);
    expect(c.sistemaInformatico).toMatchObject({ idSistemaInformatico: 'CA', numeroInstalacion: `CONTA-${E}`, indicadorMultiplesOT: 'S' });
    expect(r.huella).toBe(
      huella(cadenaAlta({ idEmisor: r.idEmisor, numSerie: r.numSerie, fecha: r.fechaExpedicion, tipoFactura: 'F1', cuotaTotal: r.cuotaTotal!, importeTotal: r.importeTotal!, huellaAnterior: '', fechaHoraHuso: r.fechaHoraHuso })),
    );
    expect(r.fechaHoraHuso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } })).verifactuEstado).toBe('PENDIENTE');
    // Con el primer registro se congelan el NIF, el nombre y el numero de instalacion.
    expect(await prisma.verifactuConfig.findUniqueOrThrow({ where: { companyId: E } })).toMatchObject({
      nifObligado: NIF_E,
      nombreObligado: 'Registro Principal SL',
      numeroInstalacion: `CONTA-${E}`,
    });
    const cabeza = await prisma.verifactuCadena.findUniqueOrThrow({ where: { companyId_entorno: { companyId: E, entorno: 'PRUEBAS' } } });
    expect(cabeza).toMatchObject({ numRegistros: 1, ultimoRegistroId: r.id, ultimaHuella: r.huella, ultimoNumSerie: r.numSerie, ultimaFechaHoraHuso: r.fechaHoraHuso });
  });

  it('la segunda se encadena a la primera y su fecha y hora no va hacia atrás', async () => {
    const [primero] = await cadenaDe(E);
    const f = await emitir();
    const r = await unico(f.id);
    expect(r).toMatchObject({ numeroEnCadena: 2, registroAnteriorId: primero.id, huellaAnterior: primero.huella });
    expect(contenido(r).encadenamiento).toEqual({
      registroAnterior: { idEmisor: primero.idEmisor, numSerie: primero.numSerie, fecha: primero.fechaExpedicion, huella: primero.huella },
    });
    expect(instanteDeHuso(r.fechaHoraHuso).getTime()).toBeGreaterThanOrEqual(instanteDeHuso(primero.fechaHoraHuso).getTime());
    expect(comprobarCadena(await cadenaDe(E))).toEqual([]);
  });

  it('finalizar un borrador crea su registro; el borrador no tenía', async () => {
    const b = await emitir({ borrador: true, descripcionOperacion: 'Asesoría fiscal de octubre' });
    expect(await registrosDe(b.id)).toHaveLength(0);
    const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY });
    const r = await unico(f.id);
    expect(contenido(r).descripcionOperacion).toBe('Asesoría fiscal de octubre');
    expect(comprobarCadena(await cadenaDe(E))).toEqual([]);
  });

  it('una factura en USD lleva en el registro sus importes en euros', async () => {
    const f = await emitir({ moneda: 'USD', lineas: [linea(1149, 21, { moneda: 'USD' })] });
    expect(f).toMatchObject({ moneda: 'USD', baseTotal: 1000, ivaTotal: 210 });
    const r = await unico(f.id);
    expect(r).toMatchObject({ cuotaTotal: '210.00', importeTotal: '1210.00' });
  });

  it('la instantánea de la emisión queda en la factura', async () => {
    const f = await emitir();
    const fila = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } });
    expect(fila.instantaneaEmision).toMatchObject({
      v: 1,
      emisor: { denominacion: 'Registro Principal SL', nif: NIF_E, municipio: 'Valencia' },
      cliente: { nombreFiscal: 'Cliente Nacional SL', nifCif: 'B12345674', pais: 'ES', cp: '46001' },
    });
  });
});

describe('rectificativas', () => {
  const rect = (rectificativa: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: {},
      fechaEmision: HOY,
      lineas: [linea(-100)],
      rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelve parte del pedido', ...rectificativa },
      ...extra,
    } as unknown as CrearFacturaIngresoDTO);

  it('por diferencias (bloque nuevo): R1, TipoRectificativa I, importes negativos y FacturasRectificadas', async () => {
    const o = await emitir({ lineas: [linea(1000)] });
    const r = await rect({ originales: [{ id: o.id }] });
    const reg = await unico(r.id);
    expect(reg).toMatchObject({ tipoFactura: 'R1', cuotaTotal: '-21.00', importeTotal: '-121.00' });
    const c = contenido(reg);
    expect(c.tipoRectificativa).toBe('I');
    expect(c.importeRectificacion).toBeUndefined();
    expect(c.facturasRectificadas).toEqual([{ idEmisor: NIF_E, numSerie: o.numeroCompleto, fecha: fechaAeat(HOY) }]);
    expect(c.descripcionOperacion).toBe('Rectificación: Devuelve parte del pedido');
    expect(c.destinatarios).toHaveLength(1);
  });

  it('por sustitución: ImporteRectificacion con la base y la cuota de la original (de su registro)', async () => {
    const o = await emitir({ lineas: [linea(1000)] });
    const r = await rect({ forma: 'S', motivo: 'CAMBIO_PRECIO', explicacion: 'Precio pactado de 800 €', originales: [{ id: o.id }] }, { lineas: [linea(800)] });
    const reg = await unico(r.id);
    expect(reg).toMatchObject({ tipoFactura: 'R1', importeTotal: '968.00' });
    expect(contenido(reg)).toMatchObject({ tipoRectificativa: 'S', importeRectificacion: { base: '1000.00', cuota: '210.00' } });
  });

  it('R5 sobre una F2: sin destinatarios', async () => {
    const t = await emitir({ tipoFactura: 'F2', lineas: [linea(50)] });
    expect(contenido(await unico(t.id)).destinatarios).toBeUndefined();
    const r = await rect({ ticket: true, originales: [{ id: t.id }] }, { lineas: [linea(-10)] });
    const reg = await unico(r.id);
    expect(reg.tipoFactura).toBe('R5');
    expect(contenido(reg).destinatarios).toBeUndefined();
  });

  it('por el camino antiguo (crearRectificativa): R1 espejo con su registro', async () => {
    const o = await emitir({ lineas: [linea(300)] });
    const r = await incomeInvoicesService.crearRectificativa(E, o.id, { motivo: 'Factura emitida dos veces' });
    const reg = await unico(r.id);
    expect(reg).toMatchObject({ tipoFactura: 'R1', importeTotal: '-363.00' });
    expect(contenido(reg).facturasRectificadas?.[0]).toMatchObject({ numSerie: o.numeroCompleto });
  });

  it('un borrador de rectificativa: registro al emitirlo', async () => {
    const o = await emitir({ lineas: [linea(500)] });
    const b = await rect({ originales: [{ id: o.id }] }, { borrador: true });
    expect(await registrosDe(b.id)).toHaveLength(0);
    const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY });
    expect((await unico(f.id)).tipoFactura).toBe('R1');
    expect(comprobarCadena(await cadenaDe(E))).toEqual([]);
  });
});

describe('tipos de operación', () => {
  it('intracomunitaria: E5 con el cliente en IDOtro 02', async () => {
    const f = await emitir({ tipoOperacion: 'INTRACOMUNITARIA', lineas: [linea(500, 0)] }, E, clientes[E].fr);
    const c = contenido(await unico(f.id));
    expect(c.desglose).toEqual([{ impuesto: '01', claveRegimen: '01', operacionExenta: 'E5', baseImponible: '500.00' }]);
    expect(c.destinatarios).toEqual([{ nombre: 'Client France SARL', idOtro: { codigoPais: 'FR', idType: '02', id: 'FR12345678901' } }]);
  });

  it('exportación: 02/E2 con IDOtro 04', async () => {
    const f = await emitir({ tipoOperacion: 'EXPORTACION', lineas: [linea(800, 0)] }, E, clientes[E].us);
    const c = contenido(await unico(f.id));
    expect(c.desglose[0]).toMatchObject({ claveRegimen: '02', operacionExenta: 'E2' });
    expect(c.destinatarios?.[0]).toMatchObject({ idOtro: { codigoPais: 'US', idType: '04' } });
  });

  it('servicios a un cliente de Canarias: 08/N2 con su NIF', async () => {
    const f = await emitir({ tipoOperacion: 'SERVICIOS_EXTRANJERO', lineas: [linea(300, 0)] }, E, clientes[E].can);
    const c = contenido(await unico(f.id));
    expect(c.desglose).toEqual([{ impuesto: '01', claveRegimen: '08', calificacionOperacion: 'N2', baseImponible: '300.00' }]);
    expect(c.destinatarios).toEqual([{ nombre: 'Cliente Canario SL', nif: NIF_CANARIAS }]);
  });
});

describe('lo que no genera registro', () => {
  it('VERI*FACTU desactivado, sin configuración, activo con fecha futura, foral y empresa extranjera', async () => {
    for (const id of [DESACT, SINCONF, FUTURA, FORAL]) {
      const f = await emitir({}, id, clientes[id].es);
      expect(f.estadoDocumento).toBe('FINAL');
      expect(await registrosDe(f.id)).toHaveLength(0);
      expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } })).verifactuEstado).toBeNull();
    }
    const usa = await emitir({}, USA, clientes[USA].es);
    expect(await registrosDe(usa.id)).toHaveLength(0);
    // Sin VERI*FACTU tambien se guarda la instantanea de la emision.
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: usa.id } })).instantaneaEmision).toMatchObject({ v: 1 });
  });

  it('lector, borrador, proforma, pasar a factura y duplicar: sin registro (hasta que se emite)', async () => {
    const antes = await prisma.verifactuRegistro.count({ where: { companyId: E } });
    const leida = await incomeInvoicesService.crearIngreso(
      { companyId: E, customer: { id: clientes[E].es }, fechaEmision: HOY, lineas: [linea()], serie: 'LEC', numero: 7 } as CrearFacturaIngresoDTO,
      { origen: 'lector' },
    );
    expect(leida.estadoDocumento).toBe('FINAL');
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: leida.id } })).instantaneaEmision).toBeNull();
    const borrador = await emitir({ borrador: true });
    const proforma = await emitir({ proforma: true });
    const desdeProforma = await incomeInvoicesService.pasarProformaAFactura(E, proforma.id);
    const copia = await incomeInvoicesService.duplicar(E, leida.id);
    expect([borrador.estadoDocumento, proforma.estadoDocumento, desdeProforma.estadoDocumento, copia.estadoDocumento]).toEqual(['BORRADOR', 'PROFORMA', 'BORRADOR', 'BORRADOR']);
    expect(await prisma.verifactuRegistro.count({ where: { companyId: E } })).toBe(antes);
    // Al emitir el borrador que salio de la proforma, si.
    const emitida = await incomeInvoicesService.finalizar(E, desdeProforma.id, { fechaEmision: HOY });
    expect((await unico(emitida.id)).numeroEnCadena).toBe(antes + 1);
  });
});

describe('cliente sin NIF en una factura completa', () => {
  it('emisión directa: 422 VERIFACTU_CLIENTE_SIN_NIF y no se crea nada (ni número, ni cliente nuevo)', async () => {
    const serieAntes = (await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: E, codigo: 'A' } } })).ultimoNumero;
    const facturas = await prisma.incomeInvoice.count({ where: { companyId: E } });
    const clientesAntes = await prisma.customer.count({ where: { companyId: E } });
    await expect(emitir({}, E, clientes[E].sinNif)).rejects.toMatchObject({ statusCode: 422, details: { codigo: 'VERIFACTU_CLIENTE_SIN_NIF' }, message: expect.stringMatching(/simplificada/) });
    await expect(
      incomeInvoicesService.crearIngreso({ companyId: E, customer: { nuevo: { nombreFiscal: 'Nuevo sin NIF', nifCif: '1234' } }, fechaEmision: HOY, lineas: [linea()] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: E, codigo: 'A' } } })).ultimoNumero).toBe(serieAntes);
    expect(await prisma.incomeInvoice.count({ where: { companyId: E } })).toBe(facturas);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(clientesAntes);
    // Como simplificada si se puede.
    const f2 = await emitir({ tipoFactura: 'F2', lineas: [linea(20)] }, E, clientes[E].sinNif);
    expect(contenido(await unico(f2.id)).destinatarios).toBeUndefined();
  });

  it('finalizar: 422 y el borrador sigue como estaba', async () => {
    const b = await emitir({ borrador: true }, E, clientes[E].sinNif);
    await expect(incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY })).rejects.toMatchObject({ statusCode: 422, details: { codigo: 'VERIFACTU_CLIENTE_SIN_NIF' } });
    expect(await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ estadoDocumento: 'BORRADOR', numero: null });
  });

  it('la cadena entera sigue bien', async () => {
    expect(comprobarCadena(await cadenaDe(E))).toEqual([]);
  });
});
