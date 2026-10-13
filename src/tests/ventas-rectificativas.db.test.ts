/**
 * Rectificativas y abonos de venta con el bloque `rectificativa` (Nueva
 * factura): una o varias originales con su reparto, un periodo de rappel,
 * una factura de fuera de la app y una partida de 2026, el cliente de la
 * original, por sustitucion, ticket (R5), reglas de signo, art. 89.Tres, el
 * plazo de cuatro años, la R4 que sube el IVA, el borrador corregido con otro
 * bloque y dos rectificativas a la vez.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { buscarOriginalesVenta, datosParaRectificarVenta, opcionesRectificativa } from '../services/rectificativasVenta.service';
import { listarSeries } from '../services/series.service';
import { datosPdfFactura } from '../services/facturaPdf.service';
import type { HttpError } from '../utils/http-errors';
import { hoyEspana } from '../utils/fechas';

const E = `venta-rect-bloque-${Date.now()}`;
const OTRA = `${E}-otra`;
let cliente = '';
let otroCliente = '';
let sinNif = '';
// Hoy en España, como numera el servidor (en UTC fallaba entre las 00:00 y las 02:00 de Madrid).
const HOY = hoyEspana();

const linea = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });

async function emitir(base: number, extra: Partial<CrearFacturaIngresoDTO> = {}, empresa = E, clienteId = cliente) {
  return incomeInvoicesService.crearIngreso({ companyId: empresa, customer: { id: clienteId }, fechaEmision: '2026-09-01', lineas: [linea(base)], ...extra } as CrearFacturaIngresoDTO);
}

function rect(rectificativa: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas: [linea(-100)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelve parte del pedido', ...rectificativa },
    ...extra,
  } as unknown as CrearFacturaIngresoDTO);
}

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

const enlaces = (id: string) => prisma.incomeInvoiceRectificada.findMany({ where: { companyId: E, rectificativaId: id }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  for (const id of [E, OTRA]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Rectificativas Bloque SL', nif: 'B40000002' } });
    // La facturacion en la app desde el 1-1-2026: lo de antes es «de fuera».
    await prisma.ajustesFiscales.create({ data: { companyId: id, inicioEnApp: '2026-01-01' } });
  }
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Uno SL', nifCif: 'B50000011' } })).id;
  otroCliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Dos SL', nifCif: 'B50000012' } })).id;
  sinNif = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Particular', nifCif: '' } })).id;
  // Serie B para las facturas con fechas antiguas (la A va en orden de fechas), despues de las de siempre (A, R y P).
  await listarSeries(E);
  await prisma.invoiceSeries.create({ data: { companyId: E, codigo: 'B', descripcion: 'Serie B', tipoDocumento: 'FACTURA', activa: true } });
});

afterAll(async () => {
  for (const id of [E, OTRA]) {
    await prisma.incomeInvoiceRectificada.deleteMany({ where: { companyId: id } });
    await prisma.incomeInvoiceLine.deleteMany({ where: { invoice: { companyId: id } } });
    await prisma.incomeInvoice.deleteMany({ where: { companyId: id } });
  }
});

describe('una original', () => {
  it('devolución en negativo: R1 en la serie R, enlazada a la original y con facturaOriginalId', async () => {
    const a = await emitir(1000);
    const r = await rect({ originales: [{ id: a.id }] });
    expect(r).toMatchObject({ estadoDocumento: 'FINAL', esRectificativa: true, tipoFactura: 'R1', tipoRectificativa: 'I', serie: 'R', facturaOriginalId: a.id });
    expect(r.totalFactura).toBe(-121);
    expect(r.rectificativa).toMatchObject({
      ticket: false,
      forma: 'I',
      motivo: 'DEVOLUCION',
      motivoTexto: 'Devolución de mercancías o envases',
      explicacion: 'Devuelve parte del pedido',
      originales: [{ id: a.id, numeroCompleto: a.numeroCompleto, enApp: true, base: -100, cuota: -21, retencion: 0 }],
      periodo: null,
    });
    const filas = await enlaces(r.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ originalId: a.id, numeroOriginal: a.numeroCompleto, fechaOriginal: '2026-09-01', baseRectificada: -100, cuotaRectificada: -21 });
    // La ficha de la original la lista, con fecha y tipo.
    const ficha = await incomeInvoicesService.obtenerPorId(E, a.id);
    expect(ficha.rectificadaPor).toEqual([{ id: r.id, numeroCompleto: r.numeroCompleto, fechaEmision: r.fechaEmision, totalFactura: -121, parte: -121, tipoRectificativa: 'I', tipoFactura: 'R1' }]);
    // GET /:id/rectificar: lo que queda y que ya no admite sustitución.
    const datos = await datosParaRectificarVenta(E, a.id);
    expect(datos.restante).toEqual({ base: 900, cuota: 189, total: 1089 });
    expect(datos.admiteSustitucion).toBe(false);
    expect(datos.rectificativas).toEqual([expect.objectContaining({ id: r.id, forma: 'I', tipoFactura: 'R1' })]);
  });

  it('el tipo sale del motivo; si llega otro, 400 TIPO_NO_CUADRA_CON_MOTIVO', async () => {
    const a = await emitir(200);
    const e = await error(rect({ originales: [{ id: a.id }] }, { tipoFactura: 'R4' }));
    expect(e.statusCode).toBe(400);
    expect(e.details).toMatchObject({ codigo: 'TIPO_NO_CUADRA_CON_MOTIVO', campo: 'tipoFactura' });
    const r4 = await rect({ originales: [{ id: a.id }], motivo: 'ERROR' }, { tipoFactura: 'R4' });
    expect(r4.tipoFactura).toBe('R4');
  });

  it('campos antiguos junto al bloque, fecha de la operación o serie de facturas: 400', async () => {
    const a = await emitir(200);
    expect((await error(rect({ originales: [{ id: a.id }] }, { facturaOriginalId: a.id }))).details).toMatchObject({ codigo: 'RECTIFICATIVA_MEZCLA_CAMPOS' });
    expect((await error(rect({ originales: [{ id: a.id }] }, { fechaOperacion: '2026-09-01' }))).details).toMatchObject({ codigo: 'SIN_FECHA_OPERACION', campo: 'fechaOperacion' });
    expect((await error(rect({ originales: [{ id: a.id }] }, { serie: 'A' }))).details).toMatchObject({ codigo: 'SERIE_NO_RECTIFICATIVA', campo: 'serie' });
  });

  it('una devolución con las líneas en positivo: 400 SIGNO_NO_CUADRA', async () => {
    const a = await emitir(300);
    const e = await error(rect({ originales: [{ id: a.id }] }, { lineas: [linea(100)] }));
    expect(e.details).toMatchObject({ codigo: 'SIGNO_NO_CUADRA', campo: 'lineas' });
    // Un cambio de precio sí puede subir.
    const sube = await rect({ originales: [{ id: a.id }], motivo: 'CAMBIO_PRECIO' }, { lineas: [linea(50)] });
    expect(sube.totalFactura).toBe(60.5);
  });

  it('por diferencias lleva la retención de la original: sin ella, 400 RETENCION_NO_CUADRA', async () => {
    const a = await emitir(1000, { lineas: [linea(1000, { tipoRetencion: 15 })] }); // 1.000 + 210 - 150
    const sin = await error(rect({ motivo: 'DESCUENTO', originales: [{ id: a.id }] }));
    expect(sin.statusCode).toBe(400);
    expect(sin.details).toMatchObject({ codigo: 'RETENCION_NO_CUADRA', campo: 'tipoRetencion' });
    expect(sin.message).toContain('15 %');
    const con = await rect({ motivo: 'DESCUENTO', originales: [{ id: a.id }] }, { lineas: [linea(-100, { tipoRetencion: 15 })] });
    expect([con.baseTotal, con.ivaTotal, con.retencionTotal, con.totalFactura]).toEqual([-100, -21, -15, -106]);
    // Por sustitución, la factura corregida puede cambiarla.
    const b = await emitir(500, { lineas: [linea(500, { tipoRetencion: 15 })] });
    expect((await rect({ forma: 'S', motivo: 'ERROR', originales: [{ id: b.id }] }, { lineas: [linea(500)] })).retencionTotal).toBe(0);
  });

  it('el cliente es el de la original: otro, 400 ORIGINAL_DE_OTRO_CLIENTE', async () => {
    const a = await emitir(400);
    const e = await error(rect({ originales: [{ id: a.id }] }, { customer: { id: otroCliente } }));
    expect(e.details).toMatchObject({ codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo: 'customer' });
    // Sin cliente en el cuerpo, el de la original.
    expect((await rect({ originales: [{ id: a.id }] })).customerId).toBe(cliente);
  });

  it('una original de otra empresa: 404; una rectificativa: 400 ORIGINAL_NO_RECTIFICABLE', async () => {
    const ajena = await emitir(100, {}, OTRA, (await prisma.customer.create({ data: { companyId: OTRA, nombreFiscal: 'Ajeno', nifCif: 'B50000099' } })).id);
    const e = await error(rect({ originales: [{ id: ajena.id }] }));
    expect(e.statusCode).toBe(404);
    expect(e.message).toBe('La factura que rectificas no existe.');
    const a = await emitir(500);
    const r = await rect({ originales: [{ id: a.id }] });
    const e2 = await error(rect({ originales: [{ id: r.id }] }));
    expect(e2.statusCode).toBe(400);
    expect(e2.details).toMatchObject({ codigo: 'ORIGINAL_NO_RECTIFICABLE', campo: 'rectificativa.originales.0' });
  });

  it('dos rectificativas totales a la vez de la misma original: una sale y la otra da 409', async () => {
    const a = await emitir(300); // 363
    const total = [linea(-300)];
    const r = await Promise.allSettled([rect({ originales: [{ id: a.id }] }, { lineas: total }), rect({ originales: [{ id: a.id }] }, { lineas: total })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((fallo.reason as HttpError).statusCode).toBe(409);
    expect((fallo.reason as HttpError).details).toMatchObject({ codigo: 'RECTIFICATIVA_EXCEDE_ORIGINAL' });
  });
});

describe('varias originales', () => {
  it('con el reparto de cada una, que suma al céntimo; facturaOriginalId queda vacío', async () => {
    const a = await emitir(1000);
    const b = await emitir(500);
    const r = await rect(
      {
        motivo: 'DESCUENTO',
        originales: [
          { id: a.id, base: -100, cuota: -21, retencion: 0 },
          { id: b.id, base: -50, cuota: -10.5, retencion: 0 },
        ],
      },
      { lineas: [linea(-100), linea(-50)] },
    );
    expect(r.facturaOriginalId).toBeUndefined();
    expect((await enlaces(r.id)).map((x) => [x.originalId, x.baseRectificada, x.cuotaRectificada])).toEqual([
      [a.id, -100, -21],
      [b.id, -50, -10.5],
    ]);
    expect((await datosParaRectificarVenta(E, b.id)).restante.total).toBe(544.5);
    // La ficha de cada una enseña su parte, no el total de la rectificativa.
    expect((await incomeInvoicesService.obtenerPorId(E, b.id)).rectificadaPor).toEqual([expect.objectContaining({ id: r.id, totalFactura: -181.5, parte: -60.5 })]);
  });

  it('sin la parte de alguna, o si no cuadra: 400 REPARTO_NO_CUADRA', async () => {
    const a = await emitir(1000);
    const b = await emitir(500);
    const sinParte = await error(rect({ originales: [{ id: a.id }, { id: b.id }] }, { lineas: [linea(-100), linea(-50)] }));
    expect(sinParte.details).toMatchObject({ codigo: 'REPARTO_NO_CUADRA', campo: 'rectificativa.originales.0.base' });
    const noCuadra = await error(
      rect({ originales: [{ id: a.id, base: -100, cuota: -21 }, { id: b.id, base: -40, cuota: -10.5 }] }, { lineas: [linea(-100), linea(-50)] }),
    );
    expect(noCuadra.details).toMatchObject({ codigo: 'REPARTO_NO_CUADRA', campo: 'rectificativa.originales' });
  });

  it('de clientes distintos: 400 ORIGINAL_DE_OTRO_CLIENTE en la segunda', async () => {
    const a = await emitir(1000);
    const b = await emitir(500, {}, E, otroCliente);
    const e = await error(rect({ originales: [{ id: a.id, base: -50, cuota: -10.5 }, { id: b.id, base: -50, cuota: -10.5 }] }));
    expect(e.details).toMatchObject({ codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo: 'rectificativa.originales.1' });
  });
});

describe('periodo, factura de fuera y partida de 2026', () => {
  it('un rappel por periodo: una fila de periodo; con una devolución, 400 PERIODO_SOLO_RAPPEL', async () => {
    const r = await rect({ motivo: 'RAPPEL', periodo: { desde: '2026-01-01', hasta: '2026-06-30' } }, { customer: { id: cliente }, lineas: [linea(-500, { descripcion: 'Rappel 1S' })] });
    expect(r.rectificativa).toMatchObject({ motivo: 'RAPPEL', originales: [], periodo: { desde: '2026-01-01', hasta: '2026-06-30' } });
    expect(r.facturaOriginalId).toBeUndefined();
    expect(r.rectificaFuera).toBeUndefined();
    const e = await error(rect({ periodo: { desde: '2026-01-01', hasta: '2026-06-30' } }, { customer: { id: cliente } }));
    expect(e.details).toMatchObject({ codigo: 'PERIODO_SOLO_RAPPEL', campo: 'rectificativa.periodo' });
  });

  it('una factura de fuera (anterior a la app): número y fecha, y rectificaFuera como antes', async () => {
    const r = await rect({ originales: [{ numero: 'A-2025-118', fecha: '2025-11-30' }] }, { customer: { id: cliente } });
    expect(r.rectificaFuera).toEqual({ numero: 'A-2025-118', fecha: '2025-11-30' });
    expect(r.rectificativa?.originales).toEqual([expect.objectContaining({ id: null, numeroCompleto: 'A-2025-118', fecha: '2025-11-30', enApp: false })]);
    // Una de cuando ya se facturaba en la app: hay que elegirla de la lista.
    const e = await error(rect({ originales: [{ numero: 'A-7', fecha: '2026-03-01' }] }, { customer: { id: cliente } }));
    expect(e.details).toMatchObject({ codigo: 'ORIGINAL_EN_LA_APP', campo: 'rectificativa.originales.0.fecha' });
    // Por sustitución, solo una de la app.
    const s = await error(rect({ forma: 'S', motivo: 'ERROR', originales: [{ numero: 'A-2025-118', fecha: '2025-11-30' }] }, { customer: { id: cliente }, lineas: [linea(80)] }));
    expect(s.details).toMatchObject({ codigo: 'SUSTITUCION_SIN_ORIGINAL_APP' });
  });

  it('con la partida de cobro de 2026: guarda la partida y su número; de otro cliente, 400', async () => {
    const p = await prisma.partidaPendiente.create({
      data: { companyId: E, cargaId: 'carga-prueba', tipo: 'COBRO', subcuenta: '4300000001', customerId: cliente, numeroDocumento: 'F-2025/77', fechaDocumento: '2025-12-10', importePendiente: 605 },
    });
    const r = await rect({ originales: [{ partidaId: p.id }] }, { customer: { id: cliente } });
    expect(r.rectificativa?.originales).toEqual([expect.objectContaining({ numeroCompleto: 'F-2025/77', fecha: '2025-12-10', partidaId: p.id, enApp: false })]);
    expect((await enlaces(r.id))[0]).toMatchObject({ partidaPendienteId: p.id, numeroOriginal: 'F-2025/77' });
    const e = await error(rect({ originales: [{ partidaId: p.id }] }, { customer: { id: otroCliente } }));
    expect(e.details).toMatchObject({ codigo: 'ORIGINAL_DE_OTRO_CLIENTE' });
    // Con un cliente nuevo tampoco: rebajaría la partida de uno e iría a la 430 de otro.
    const antes = await prisma.customer.count({ where: { companyId: E } });
    const nuevo = await error(rect({ originales: [{ partidaId: p.id }] }, { customer: { nuevo: true, nombreFiscal: 'Cliente Nuevo SL', nifCif: 'B50000013' } }));
    expect(nuevo.details).toMatchObject({ codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo: 'customer' });
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(antes);
    // El buscador las ofrece con el cliente.
    const busca = await buscarOriginalesVenta(E, { customerId: cliente, numero: 'F-2025/77' });
    expect(busca.partidasFuera).toEqual([expect.objectContaining({ partidaId: p.id, numero: 'F-2025/77', exacta: true })]);
  });
});

describe('por sustitución', () => {
  it('sobre una original sin rectificativas: la factura corregida entera, con la diferencia en el enlace', async () => {
    const a = await emitir(100); // 121
    const s = await rect({ forma: 'S', motivo: 'ERROR', originales: [{ id: a.id }] }, { lineas: [linea(80)] });
    expect(s).toMatchObject({ tipoRectificativa: 'S', tipoFactura: 'R4', totalFactura: 96.8 });
    expect((await enlaces(s.id))[0]).toMatchObject({ originalId: a.id, baseRectificada: -20, cuotaRectificada: -4.2 });
    // El PDF dice también el importe de la rectificación (art. 15.5 RD 1619/2012).
    expect((await datosPdfFactura(E, s.id)).datos.importeRectificacion).toEqual({ base: -20, cuota: -4.2, retencion: 0, total: -24.2 });
    // Ya tiene una rectificativa: otra sustitución no; por diferencias se mide contra la sustituta (96,80).
    const otra = await error(rect({ forma: 'S', motivo: 'ERROR', originales: [{ id: a.id }] }, { lineas: [linea(70)] }));
    expect(otra.statusCode).toBe(409);
    expect(otra.details).toMatchObject({ codigo: 'SUSTITUCION_CON_RECTIFICATIVAS' });
    const demasiado = await error(rect({ originales: [{ id: a.id }] }, { lineas: [linea(-90)] }));
    expect(demasiado.statusCode).toBe(409);
    // «Hacer rectificativa» de la original propone las líneas de la sustituta (las que valen ahora).
    const datos = await datosParaRectificarVenta(E, a.id);
    expect(datos.sustituta).toMatchObject({ id: s.id, numeroCompleto: s.numeroCompleto });
    expect(datos.lineas.map((l) => [l.cantidad, l.precioUnitario])).toEqual([[1, 80]]);
    expect(datos.restante).toEqual({ base: 80, cuota: 16.8, total: 96.8 });
    expect((await rect({ originales: [{ id: a.id }] }, { lineas: [linea(-80)] })).totalFactura).toBe(-96.8);
  });

  it('la factura corregida va en positivo: en negativo, 400 SIGNO_NO_CUADRA; a cero, las siguientes no bajan de cero', async () => {
    const a = await emitir(100); // 121
    const negativa = await error(rect({ forma: 'S', motivo: 'CAMBIO_PRECIO', originales: [{ id: a.id }] }, { lineas: [linea(-100)] }));
    expect(negativa.statusCode).toBe(400);
    expect(negativa.details).toMatchObject({ codigo: 'SIGNO_NO_CUADRA', campo: 'lineas' });
    expect(await prisma.incomeInvoice.count({ where: { companyId: E, facturaOriginalId: a.id } })).toBe(0);
    // A cero (se anula por sustitución): una rectificativa por diferencias que resta ya no cabe, y el texto nombra la sustituta.
    const cero = await rect({ forma: 'S', motivo: 'CAMBIO_PRECIO', originales: [{ id: a.id }] }, { lineas: [linea(0)] });
    expect(cero.totalFactura).toBe(0);
    const mas = await error(rect({ originales: [{ id: a.id }] }, { lineas: [linea(-10)] }));
    expect(mas.statusCode).toBe(409);
    expect(mas.details).toMatchObject({ codigo: 'RECTIFICATIVA_EXCEDE_ORIGINAL' });
    expect(mas.message).toContain(`el total de la ${cero.numeroCompleto} que la sustituyó`);
  });

  it('cambiar el tipo de operación por sustitución: 400 con la forma de hacerlo', async () => {
    const a = await emitir(100);
    const e = await error(rect({ forma: 'S', motivo: 'ERROR_DERECHO', originales: [{ id: a.id }] }, { lineas: [linea(100, { tipoIva: 0 })], tipoOperacion: 'EXENTA' }));
    expect(e.details).toMatchObject({ codigo: 'SUSTITUCION_CAMBIA_OPERACION', campo: 'tipoOperacion' });
  });
});

describe('tickets (R5)', () => {
  it('la de un ticket va en la RT (se crea sola); sobre una F1, 400; una F2 sin marcar ticket, 400', async () => {
    const ticket = await emitir(50, { tipoFactura: 'F2' });
    const r5 = await rect({ ticket: true, originales: [{ id: ticket.id }] }, { lineas: [linea(-50)] });
    expect(r5).toMatchObject({ tipoFactura: 'R5', serie: 'RT' });
    expect((await opcionesRectificativa(E)).series.tickets).toEqual({ codigo: 'RT', existe: true, desactivada: false });
    const completa = await emitir(50);
    const e = await error(rect({ ticket: true, originales: [{ id: completa.id }] }, { lineas: [linea(-50)] }));
    expect(e.details).toMatchObject({ codigo: 'TICKET_SOLO_SIMPLIFICADAS' });
    expect(e.message).toMatch(/R5/);
    const e2 = await error(rect({ originales: [{ id: ticket.id }] }, { lineas: [linea(-10)] }));
    expect(e2.details).toMatchObject({ codigo: 'SIMPLIFICADA_SOLO_TICKET' });
    // R1 en la RT o R5 en la R: 400.
    expect((await error(rect({ originales: [{ id: completa.id }] }, { serie: 'RT', lineas: [linea(-10)] }))).details).toMatchObject({ codigo: 'SERIE_NO_RECTIFICATIVA' });
    expect((await error(rect({ ticket: true, originales: [{ id: ticket.id }] }, { serie: 'R', lineas: [linea(-10)] }))).details).toMatchObject({ codigo: 'SERIE_NO_RECTIFICATIVA' });
  });
});

describe('límites de la ley', () => {
  it('art. 89.Tres: subir el IVA a un cliente sin NIF por un error, no; por un cambio de precio, sí', async () => {
    const a = await emitir(100, {}, E, sinNif);
    const e = await error(rect({ motivo: 'ERROR', originales: [{ id: a.id }] }, { lineas: [linea(10)] }));
    expect(e.details).toMatchObject({ codigo: 'SUBE_IVA_CONSUMIDOR_FINAL', campo: 'lineas' });
    expect((await rect({ motivo: 'CAMBIO_PRECIO', originales: [{ id: a.id }] }, { lineas: [linea(10)] })).totalFactura).toBe(12.1);
  });

  it('más de cuatro años desde el devengo: por error, 400; por devolución, aviso', async () => {
    const vieja = await emitir(100, { fechaEmision: '2021-03-10', serie: 'B' });
    const e = await error(rect({ motivo: 'ERROR', originales: [{ id: vieja.id }] }, { lineas: [linea(-10)] }));
    expect(e.details).toMatchObject({ codigo: 'PLAZO_RECTIFICACION' });
    const r = await rect({ originales: [{ id: vieja.id }] }, { lineas: [linea(-10)] });
    expect(r.avisosFiscales).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'PLAZO_ART80' })]));
  });

  it('«Otra causa» a más de cuatro años también da 400 PLAZO_RECTIFICACION', async () => {
    const vieja = await emitir(100, { fechaEmision: '2021-03-12', serie: 'B' });
    const e = await error(rect({ motivo: 'OTROS', originales: [{ id: vieja.id }] }, { lineas: [linea(-10)] }));
    expect(e.details).toMatchObject({ codigo: 'PLAZO_RECTIFICACION' });
    expect(e.message).toMatch(/salvo por una devolución/);
  });

  it('una R4 que sube el IVA se declara en el periodo de la original: fecha de la operación y aviso', async () => {
    const a = await emitir(100, { fechaEmision: '2026-07-15', serie: 'B' });
    const r = await rect({ motivo: 'ERROR', originales: [{ id: a.id }] }, { lineas: [linea(10)] });
    expect(r.tipoFactura).toBe('R4');
    expect(r.fechaOperacion).toBe('2026-07-15');
    expect(r.avisosFiscales).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'IVA_PERIODO_ORIGINAL' })]));
    // Si baja el IVA, en su propio periodo.
    expect((await rect({ motivo: 'ERROR', originales: [{ id: a.id }] }, { lineas: [linea(-10)] })).fechaOperacion).toBeUndefined();
  });
});

describe('camino antiguo (campos de antes y /credit-note)', () => {
  it('R2 y R3 no se pueden hacer: 400 MOTIVO_NO_DISPONIBLE, sin crear nada', async () => {
    const a = await emitir(100);
    const porCampos = await error(
      incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, facturaOriginalId: a.id, tipoFactura: 'R2', motivoRectificacion: 'Concurso', lineas: [linea(-100)] }),
    );
    expect(porCampos.statusCode).toBe(400);
    expect(porCampos.details).toMatchObject({ codigo: 'MOTIVO_NO_DISPONIBLE', campo: 'tipoFactura' });
    const porRuta = await error(incomeInvoicesService.crearRectificativa(E, a.id, { motivo: 'Impago', tipoFactura: 'R3' }));
    expect(porRuta.details).toMatchObject({ codigo: 'MOTIVO_NO_DISPONIBLE' });
    expect(await prisma.incomeInvoice.count({ where: { companyId: E, facturaOriginalId: a.id } })).toBe(0);
    // R1 y R4 siguen como antes.
    expect((await incomeInvoicesService.crearRectificativa(E, a.id, { motivo: 'Anulación' })).tipoFactura).toBe('R1');
  });

  it('las reglas de la ley también valen: art. 89.Tres, plazo y periodo de la original en la R4 que sube el IVA', async () => {
    const particular = await emitir(100, {}, E, sinNif);
    const sube = await error(incomeInvoicesService.crearRectificativa(E, particular.id, { motivo: 'Error de precio', tipoFactura: 'R4', lineas: [linea(10)] }));
    expect(sube.details).toMatchObject({ codigo: 'SUBE_IVA_CONSUMIDOR_FINAL' });
    // Serie propia: la B ya lleva fechas posteriores y la numeración va en orden de fechas.
    await prisma.invoiceSeries.create({ data: { companyId: E, codigo: 'V', descripcion: 'Serie V', tipoDocumento: 'FACTURA', activa: true } });
    const vieja = await emitir(100, { fechaEmision: '2021-03-15', serie: 'V' });
    const plazo = await error(incomeInvoicesService.crearRectificativa(E, vieja.id, { motivo: 'Error', tipoFactura: 'R4', lineas: [linea(-10)] }));
    expect(plazo.details).toMatchObject({ codigo: 'PLAZO_RECTIFICACION' });
    const julio = await emitir(100, { fechaEmision: '2026-07-16', serie: 'V' });
    const r4 = await incomeInvoicesService.crearRectificativa(E, julio.id, { motivo: 'Error de precio', tipoFactura: 'R4', lineas: [linea(10)] });
    expect(r4.fechaOperacion).toBe('2026-07-16');
    // Sin motivo propio: causaRectificacion no se rellena (un borrador antiguo sigue siendo del camino antiguo).
    expect((await prisma.incomeInvoice.findUnique({ where: { id: r4.id }, select: { causaRectificacion: true } }))?.causaRectificacion).toBeNull();
  });
});

describe('borrador', () => {
  it('se guarda sin explicación, se corrige con otro bloque y se emite; sin explicación no se emite', async () => {
    const a = await emitir(1000);
    const b = await emitir(400);
    const borrador = await rect({ originales: [{ id: a.id }], explicacion: '' }, { borrador: true });
    expect(borrador.estadoDocumento).toBe('BORRADOR');
    expect((await enlaces(borrador.id)).map((x) => x.originalId)).toEqual([a.id]);
    // Otro bloque: la otra factura, con otras líneas.
    const editado = await incomeInvoicesService.actualizarBorrador(E, borrador.id, {
      lineas: [linea(-40)],
      rectificativa: { ticket: false, forma: 'I', motivo: 'DESCUENTO', explicacion: '', originales: [{ id: b.id }] },
    });
    expect(editado.rectificativa).toMatchObject({ motivo: 'DESCUENTO', originales: [expect.objectContaining({ id: b.id, base: -40 })] });
    expect((await enlaces(borrador.id)).map((x) => x.originalId)).toEqual([b.id]);
    const e = await error(incomeInvoicesService.finalizar(E, borrador.id, { fechaEmision: HOY }));
    expect(e.details).toMatchObject({ campo: 'rectificativa.explicacion' });
    await incomeInvoicesService.actualizarBorrador(E, borrador.id, {
      rectificativa: { ticket: false, forma: 'I', motivo: 'DESCUENTO', explicacion: 'Descuento por volumen', originales: [{ id: b.id }] },
    });
    const emitida = await incomeInvoicesService.finalizar(E, borrador.id, { fechaEmision: HOY });
    expect(emitida).toMatchObject({ estadoDocumento: 'FINAL', serie: 'R', motivoRectificacion: 'Descuento por volumen', facturaOriginalId: b.id });
    // Un borrador de factura no pasa a rectificativa.
    const normal = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, borrador: true, lineas: [linea(10)] });
    const e2 = await error(incomeInvoicesService.actualizarBorrador(E, normal.id, { rectificativa: { motivo: 'DEVOLUCION', originales: [{ id: a.id }] } }));
    expect(e2.statusCode).toBe(400);
  });
});

describe('borrador que cambia de modo', () => {
  it('a «Rectificativa de un ticket» sin decir la serie: va a la de tickets; y de vuelta, a la R', async () => {
    const fuera = [{ numero: 'T-2025-9', fecha: '2025-12-20' }];
    const borrador = await rect({ originales: fuera, explicacion: '' }, { borrador: true, customer: { id: cliente }, lineas: [linea(-10)] });
    expect(borrador).toMatchObject({ tipoFactura: 'R1', serie: 'R' });
    const ticket = await incomeInvoicesService.actualizarBorrador(E, borrador.id, { rectificativa: { ticket: true, forma: 'I', motivo: 'DEVOLUCION', explicacion: '', originales: fuera } });
    expect(ticket).toMatchObject({ tipoFactura: 'R5', serie: 'RT' });
    const deVuelta = await incomeInvoicesService.actualizarBorrador(E, borrador.id, { rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: '', originales: fuera } });
    expect(deVuelta).toMatchObject({ tipoFactura: 'R1', serie: 'R' });
  });
});

describe('opciones y buscador', () => {
  it('motivos con su tipo; impago y concurso, desactivados', async () => {
    const o = await opcionesRectificativa(E);
    expect(o.motivos.map((m) => [m.codigo, m.tipoFactura, m.disponible])).toEqual([
      ['DEVOLUCION', 'R1', true],
      ['DESCUENTO', 'R1', true],
      ['RAPPEL', 'R1', true],
      ['CAMBIO_PRECIO', 'R1', true],
      ['ERROR_DERECHO', 'R1', true],
      ['ERROR', 'R4', true],
      ['OTROS', 'R4', true],
      ['CONCURSO', 'R2', false],
      ['IMPAGO', 'R3', false],
    ]);
    expect(o.series.rectificativas).toEqual({ codigo: 'R', existe: true });
    expect((await error(rect({ motivo: 'IMPAGO', originales: [{ numero: 'X', fecha: '2025-01-01' }] }, { customer: { id: cliente } }))).details).toMatchObject({ codigo: 'MOTIVO_NO_DISPONIBLE' });
  });

  it('por número: la exacta primero; sin rectificativas ni borradores; solo de la empresa', async () => {
    const a = await emitir(10);
    const r = await buscarOriginalesVenta(E, { numero: a.numeroCompleto! });
    expect(r.coincidencia).toBe('EXACTA');
    expect(r.candidatas[0]).toMatchObject({ id: a.id, exacta: true, cliente: 'Cliente Uno SL', restante: 12.1, rectificable: true, origen: 'app' });
    expect(r.candidatas.every((c) => !c.numeroCompleto.startsWith('R-'))).toBe(true);
    expect((await buscarOriginalesVenta(OTRA, { numero: a.numeroCompleto! })).candidatas.some((c) => c.id === a.id)).toBe(false);
    // Por cliente, con q (sin tildes ni mayúsculas).
    const porCliente = await buscarOriginalesVenta(E, { q: 'cliente dos', take: 50 });
    expect(porCliente.candidatas.length).toBeGreaterThan(0);
    expect(porCliente.candidatas.every((c) => c.cliente === 'Cliente Dos SL')).toBe(true);
    // Tickets o sin ellos.
    expect((await buscarOriginalesVenta(E, { ticket: true, take: 20 })).candidatas.every((c) => c.tipoFactura === 'F2')).toBe(true);
  });

  it('la exacta antigua no se pierde entre muchas parecidas más recientes', async () => {
    const B = `${E}-busca`;
    await prisma.company.create({ data: { id: B, name: 'Buscador SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const c = await prisma.customer.create({ data: { companyId: B, nombreFiscal: 'Cliente Buscador SL', nifCif: 'B50000031' } });
    const fila = (numero: number, fecha: string) => ({
      companyId: B,
      customerId: c.id,
      serie: 'Z',
      numero,
      numeroCompleto: `Z-${numero}`,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      estadoDocumento: 'FINAL',
      estado: 'PENDING',
      baseTotal: 10,
      ivaTotal: 2.1,
      totalFactura: 12.1,
    });
    // Z-1 es la más antigua; detrás, 520 facturas con un «1» en el número.
    await prisma.incomeInvoice.createMany({ data: [fila(1, '2026-01-02'), ...Array.from({ length: 520 }, (_, i) => fila(1000 + i * 10 + 1, '2026-06-01'))] });
    try {
      const r = await buscarOriginalesVenta(B, { numero: 'z-1' });
      expect(r.coincidencia).toBe('EXACTA');
      expect(r.candidatas[0]).toMatchObject({ numeroCompleto: 'Z-1', exacta: true });
      expect(r.candidatas.length).toBeLessThanOrEqual(10);
    } finally {
      await prisma.incomeInvoice.deleteMany({ where: { companyId: B } });
    }
  });
});
