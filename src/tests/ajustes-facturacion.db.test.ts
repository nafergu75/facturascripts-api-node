/**
 * Configuración > Facturación (GET/PUT /companies/:id/ajustes-facturacion) y
 * su uso real en las facturas de venta, sobre BD real.
 *
 *  - GET sin fila: los valores de siempre, sin crearla.
 *  - PUT: cada regla con su campo (campoDelError en la pantalla).
 *  - Una factura sin forma de pago o sin vencimiento toma los de aquí.
 *  - Al emitir se copian el IBAN y el pie: el PDF de una factura emitida no
 *    cambia aunque después se cambien los ajustes; el de un borrador sí.
 *  - Empresa en USD: el IRPF se guarda a 0 y solo valen cuentas en USD.
 *  - IEEPNR: valores por defecto, rangos, cuenta del grupo 47 o 7 activa en el
 *    plan, y en una empresa extranjera no se repercute nunca.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import ajustesFacturacionRoutes from '../routes/ajustesFacturacion.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { datosPdfFactura, generarPdfFactura } from '../services/facturaPdf.service';
import { cuentaParaFactura } from '../services/ajustesFacturacion.service';

const SUFIJO = Date.now();
const ES = `ajustes-fact-es-${SUFIJO}`;
const US = `ajustes-fact-us-${SUFIJO}`;
const OTRA = `ajustes-fact-otra-${SUFIJO}`;
const IBAN_1 = 'ES9121000418450200051332';
const IBAN_2 = 'ES7921000813610123456789';

let rol = 'admin';
const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: `u-${rol}`, roles: [rol], rolesPorEmpresa: { [req.params.companyId]: [rol] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/ajustes-facturacion', ajustesFacturacionRoutes);
app.use(errorMiddleware);

const leer = (empresa = ES) => request(app).get(`/companies/${empresa}/ajustes-facturacion`);
const guardar = (body: object, empresa = ES) => request(app).put(`/companies/${empresa}/ajustes-facturacion`).send(body);

let cuenta1: string;
let cuenta2: string;
let cuentaInactiva: string;
let cuentaOtra: string;
let cuentaUsd: string;
let cuentaEurEnUs: string;
let clienteEs: string;

beforeAll(async () => {
  for (const [id, name] of [[ES, 'Ajustes Facturacion SL'], [US, 'Settings Inc'], [OTRA, 'Otra SL']]) {
    await prisma.company.create({ data: { id, name, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  await prisma.legalConfig.create({ data: { companyId: ES, denominacion: 'Ajustes Facturacion SL', nif: 'B12345674' } });
  await prisma.legalConfig.create({ data: { companyId: US, denominacion: 'Settings Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
  const alta = (companyId: string, iban: string, extra: object = {}) =>
    prisma.bankAccount.create({ data: { companyId, iban, subcuentaCodigo: '572000', ...extra } }).then((c) => c.id);
  cuenta1 = await alta(ES, IBAN_1, { bic: 'CAIXESBBXXX' });
  cuenta2 = await alta(ES, IBAN_2);
  cuentaInactiva = await alta(ES, 'ES1000492352082414205416', { activa: false });
  cuentaOtra = await alta(OTRA, 'ES6000491500051234567892');
  cuentaUsd = await alta(US, 'US00000000000000000001', { moneda: 'USD' });
  cuentaEurEnUs = await alta(US, 'DE89370400440532013000', { moneda: 'EUR' });
  clienteEs = (await prisma.customer.create({ data: { companyId: ES, nombreFiscal: 'Cliente Ajustes SL', nifCif: 'B87654321' } })).id;
});

describe('GET /ajustes-facturacion', () => {
  it('sin fila: los valores de siempre, y no la crea', async () => {
    const res = await leer();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      formaPago: 'TRANSFERENCIA',
      diasVencimiento: 30,
      irpfDefecto: 0,
      cuentaBancariaId: null,
      mostrarIban: true,
      textoPie: null,
      guardado: false,
      empresaEspanola: true,
      monedaCuenta: 'EUR',
    });
    // Solo las cuentas activas, de la más antigua a la más nueva.
    expect(res.body.data.cuentasBancarias.map((c: { id: string }) => c.id)).toEqual([cuenta1, cuenta2]);
    expect(await prisma.ajustesFacturacion.count({ where: { companyId: ES } })).toBe(0);
  });

  it('la ve el contable y el comercial; el de solo lectura también', async () => {
    for (const r of ['contable', 'ventas', 'solo_lectura']) {
      rol = r;
      expect((await leer()).status).toBe(200);
    }
    rol = 'admin';
  });
});

describe('PUT /ajustes-facturacion', () => {
  it('guarda (upsert) y solo cambia lo que llega', async () => {
    const res = await guardar({ formaPago: 'GIRO', diasVencimiento: 45, irpfDefecto: 15, textoPie: '  Inscrita en el RM de Valencia.  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ formaPago: 'GIRO', diasVencimiento: 45, irpfDefecto: 15, textoPie: 'Inscrita en el RM de Valencia.', guardado: true });
    const otra = await guardar({ mostrarIban: false });
    expect(otra.body.data).toMatchObject({ formaPago: 'GIRO', diasVencimiento: 45, mostrarIban: false, actualizadoPor: 'u-admin' });
    expect(await prisma.ajustesFacturacion.count({ where: { companyId: ES } })).toBe(1);
    await guardar({ mostrarIban: true });
  });

  it('cada error dice su campo', async () => {
    const casos: Array<[object, string]> = [
      [{ formaPago: 'CHEQUE' }, 'formaPago'],
      [{ diasVencimiento: 366 }, 'diasVencimiento'],
      [{ diasVencimiento: -1 }, 'diasVencimiento'],
      [{ diasVencimiento: 10.5 }, 'diasVencimiento'],
      [{ irpfDefecto: 3 }, 'irpfDefecto'],
      [{ mostrarIban: 'si' }, 'mostrarIban'],
      [{ textoPie: 'x'.repeat(501) }, 'textoPie'],
      [{ cuentaBancariaId: cuentaOtra }, 'cuentaBancariaId'],
      [{ cuentaBancariaId: cuentaInactiva }, 'cuentaBancariaId'],
      [{ cuentaBancariaId: 'no-existe' }, 'cuentaBancariaId'],
      [{ plantilla: 'otra' }, 'plantilla'],
    ];
    for (const [body, campo] of casos) {
      const res = await guardar(body);
      expect([res.status, res.body.details]).toEqual([400, { campo }]);
    }
    // Nada de lo rechazado se ha guardado.
    expect((await leer()).body.data).toMatchObject({ formaPago: 'GIRO', diasVencimiento: 45, irpfDefecto: 15, cuentaBancariaId: null });
  });

  it('el contable no la cambia (no factura); el comercial sí', async () => {
    rol = 'contable';
    expect((await guardar({ diasVencimiento: 10 })).status).toBe(403);
    rol = 'ventas';
    expect((await guardar({ diasVencimiento: 45 })).status).toBe(200);
    rol = 'admin';
  });

  it('empresa en USD: el IRPF se guarda a 0 y solo valen cuentas en USD', async () => {
    const res = await guardar({ irpfDefecto: 15, cuentaBancariaId: cuentaUsd }, US);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ irpfDefecto: 0, cuentaBancariaId: cuentaUsd, empresaEspanola: false, monedaCuenta: 'USD' });
    expect(res.body.data.cuentasBancarias.map((c: { id: string }) => c.id)).toEqual([cuentaUsd]);
    expect(Number((await prisma.ajustesFacturacion.findUnique({ where: { companyId: US } }))!.irpfDefecto)).toBe(0);
    const eur = await guardar({ cuentaBancariaId: cuentaEurEnUs }, US);
    expect([eur.status, eur.body.details]).toEqual([400, { campo: 'cuentaBancariaId' }]);
  });
});

describe('IEEPNR (plantilla A)', () => {
  beforeAll(async () => {
    const cuenta = (codigo: string, activo = true) =>
      prisma.chartOfAccounts.create({ data: { companyId: ES, codigo, nombre: `Cuenta ${codigo}`, grupo: Number(codigo[0]), nivel: 4, naturaleza: 'PASIVO', tipoUso: 'BALANCE', activo } });
    await cuenta('4758');
    await cuenta('7059');
    await cuenta('4759', false);
  });

  it('por defecto: no se repercute, 0,45 € por kg y sin cuenta propia', async () => {
    const res = await leer(OTRA);
    expect(res.body.data).toMatchObject({ ieepnrRepercute: false, ieepnrPorKg: 0.45, ieepnrCuenta: null, guardado: false });
  });

  it('guarda si se repercute, el tipo por kg y la cuenta', async () => {
    const res = await guardar({ ieepnrRepercute: true, ieepnrPorKg: 0.4567, ieepnrCuenta: '4758' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ieepnrRepercute: true, ieepnrPorKg: 0.4567, ieepnrCuenta: '4758' });
    expect((await guardar({ ieepnrPorKg: 10, ieepnrCuenta: '7059' })).body.data).toMatchObject({ ieepnrPorKg: 10, ieepnrCuenta: '7059', ieepnrRepercute: true });
    // null (o vacía) quita la cuenta: el IEEPNR vuelve a la cuenta de ingresos de su línea.
    expect((await guardar({ ieepnrPorKg: 0.45, ieepnrCuenta: null })).body.data).toMatchObject({ ieepnrPorKg: 0.45, ieepnrCuenta: null });
    // Lo demás no se toca.
    expect((await leer()).body.data).toMatchObject({ formaPago: 'GIRO', diasVencimiento: 45 });
  });

  it('rangos y cuentas no válidos: 400 con su campo y nada guardado', async () => {
    const casos: Array<[object, string]> = [
      [{ ieepnrPorKg: 0 }, 'ieepnrPorKg'],
      [{ ieepnrPorKg: -0.45 }, 'ieepnrPorKg'],
      [{ ieepnrPorKg: 10.0001 }, 'ieepnrPorKg'],
      [{ ieepnrPorKg: 0.45678 }, 'ieepnrPorKg'],
      [{ ieepnrPorKg: '0,45' }, 'ieepnrPorKg'],
      [{ ieepnrRepercute: 'si' }, 'ieepnrRepercute'],
      [{ ieepnrCuenta: 'abc' }, 'ieepnrCuenta'],
      [{ ieepnrCuenta: '475-8' }, 'ieepnrCuenta'],
      // De otro grupo: ni 47 ni 7.
      [{ ieepnrCuenta: '6000' }, 'ieepnrCuenta'],
      [{ ieepnrCuenta: '4000' }, 'ieepnrCuenta'],
      // No existe en el plan.
      [{ ieepnrCuenta: '4757123' }, 'ieepnrCuenta'],
      // Desactivada.
      [{ ieepnrCuenta: '4759' }, 'ieepnrCuenta'],
      // La plantilla va por series, no aquí.
      [{ plantilla: 'A' }, 'plantilla'],
    ];
    for (const [body, campo] of casos) {
      const res = await guardar(body);
      expect([JSON.stringify(body), res.status, res.body.details]).toEqual([JSON.stringify(body), 400, { campo }]);
    }
    expect((await leer()).body.data).toMatchObject({ ieepnrRepercute: true, ieepnrPorKg: 0.45, ieepnrCuenta: null });
  });

  it('empresa extranjera: ieepnrRepercute se guarda siempre como false', async () => {
    const res = await guardar({ ieepnrRepercute: true }, US);
    expect(res.status).toBe(200);
    expect(res.body.data.ieepnrRepercute).toBe(false);
    expect((await prisma.ajustesFacturacion.findUnique({ where: { companyId: US } }))!.ieepnrRepercute).toBe(false);
  });

  afterAll(async () => {
    await guardar({ ieepnrRepercute: false, ieepnrPorKg: 0.45, ieepnrCuenta: null });
  });
});

describe('plantilla B: cuenta del cargo de palets, logo de la marca y sello', () => {
  // PNG de 1 x 1 y JPG minimo (solo cuenta la cabecera).
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const subir = (tipo: string, fichero: Buffer, nombre = 'imagen.png') =>
    request(app).put(`/companies/${ES}/ajustes-facturacion/imagenes/${tipo}`).attach('imagen', fichero, nombre);

  it('por defecto: sin cuenta propia del cargo de palets y sin imagenes', async () => {
    expect((await leer()).body.data).toMatchObject({ cuentaPalets: null, imagenesPlantillaB: { marca: false, sello: false } });
  });

  it('la cuenta del cargo de palets es una de ventas (70x) del plan; vacia vuelve a la de ventas', async () => {
    expect((await guardar({ cuentaPalets: '704' })).body.data).toMatchObject({ cuentaPalets: '704' });
    for (const [cuentaPalets, campo] of [
      ['abc', 'cuentaPalets'],
      ['600', 'cuentaPalets'],
      ['7049999', 'cuentaPalets'],
      [7, 'cuentaPalets'],
    ]) {
      const res = await guardar({ cuentaPalets });
      expect([res.status, res.body.details?.campo]).toEqual([400, campo]);
    }
    expect((await leer()).body.data.cuentaPalets).toBe('704');
    expect((await guardar({ cuentaPalets: null })).body.data.cuentaPalets).toBeNull();
  });

  it('sube, lee y quita el logo de la marca y el sello (PNG o JPG); el GET da la imagen tal cual', async () => {
    expect((await subir('marca', PNG)).status).toBe(200);
    expect((await subir('SELLO', JPG, 'sello.jpg')).status).toBe(200);
    expect((await leer()).body.data.imagenesPlantillaB).toEqual({ marca: true, sello: true });
    const marca = await request(app).get(`/companies/${ES}/ajustes-facturacion/imagenes/marca`).buffer(true);
    expect(marca.status).toBe(200);
    expect(marca.headers['content-type']).toBe('image/png');
    const sello = await request(app).get(`/companies/${ES}/ajustes-facturacion/imagenes/sello`).buffer(true);
    expect(sello.headers['content-type']).toBe('image/jpeg');
    // Se cambia sin crear otra.
    expect((await subir('marca', JPG, 'marca.jpg')).status).toBe(200);
    expect(await prisma.imagenFactura.count({ where: { companyId: ES } })).toBe(2);
    expect((await request(app).delete(`/companies/${ES}/ajustes-facturacion/imagenes/sello`)).status).toBe(200);
    expect((await request(app).get(`/companies/${ES}/ajustes-facturacion/imagenes/sello`)).status).toBe(404);
    expect((await leer()).body.data.imagenesPlantillaB).toEqual({ marca: true, sello: false });
    // Cada empresa ve solo las suyas.
    expect((await request(app).get(`/companies/${OTRA}/ajustes-facturacion/imagenes/marca`)).status).toBe(404);
  });

  it('un fichero que no es PNG ni JPG, vacio o un tipo que no existe: 400', async () => {
    const pdf = await subir('marca', Buffer.from('%PDF-1.4 hola'), 'marca.png');
    expect([pdf.status, pdf.body.details?.campo]).toEqual([400, 'imagen']);
    const sinFichero = await request(app).put(`/companies/${ES}/ajustes-facturacion/imagenes/marca`);
    expect([sinFichero.status, sinFichero.body.details?.campo]).toEqual([400, 'imagen']);
    const tipo = await subir('logo', PNG);
    expect([tipo.status, tipo.body.details?.campo]).toEqual([400, 'tipo']);
  });

  it('el contable las ve pero no las cambia; el comercial si', async () => {
    rol = 'contable';
    expect((await request(app).get(`/companies/${ES}/ajustes-facturacion/imagenes/marca`)).status).toBe(200);
    expect((await subir('sello', PNG)).status).toBe(403);
    expect((await request(app).delete(`/companies/${ES}/ajustes-facturacion/imagenes/marca`)).status).toBe(403);
    rol = 'ventas';
    expect((await subir('sello', PNG)).status).toBe(200);
    rol = 'admin';
    await request(app).delete(`/companies/${ES}/ajustes-facturacion/imagenes/sello`);
    await request(app).delete(`/companies/${ES}/ajustes-facturacion/imagenes/marca`);
  });
});

describe('uso en las facturas de venta', () => {
  const linea = { descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 };

  it('sin forma de pago ni vencimiento: los de los ajustes', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-02', lineas: [linea], borrador: true });
    expect(f.formaPago).toBe('GIRO');
    expect(f.fechaVencimiento).toBe('2026-04-16'); // 2 de marzo + 45 días
    // Lo que trae la factura manda.
    const g = await incomeInvoicesService.crearIngreso({
      companyId: ES,
      customer: { id: clienteEs },
      fechaEmision: '2026-03-02',
      fechaVencimiento: '2026-03-10',
      formaPago: 'CONTADO',
      lineas: [linea],
      borrador: true,
    });
    expect([g.formaPago, g.fechaVencimiento]).toEqual(['CONTADO', '2026-03-10']);
  });

  it('al emitir se copian el IBAN y el pie: el PDF emitido no cambia; el del borrador sí', async () => {
    await guardar({ cuentaBancariaId: cuenta2, textoPie: 'Pie de antes', formaPago: 'TRANSFERENCIA' });
    const emitida = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-03', lineas: [linea] });
    const borrador = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-03', lineas: [linea], borrador: true });
    const fila = await prisma.incomeInvoice.findUnique({ where: { id: emitida.id } });
    expect([fila!.ibanCobro, fila!.textoPie]).toEqual([IBAN_2, 'Pie de antes']);
    expect((await prisma.incomeInvoice.findUnique({ where: { id: borrador.id } }))!.ibanCobro).toBeNull();

    // Cambian los ajustes: otra cuenta y otro pie.
    await guardar({ cuentaBancariaId: cuenta1, textoPie: 'Pie de después' });
    const pdfEmitida = (await datosPdfFactura(ES, emitida.id)).datos;
    expect(pdfEmitida.cuenta).toEqual({ iban: IBAN_2, bic: null });
    expect(pdfEmitida.textoPie).toBe('Pie de antes');
    const pdfBorrador = (await datosPdfFactura(ES, borrador.id)).datos;
    expect(pdfBorrador.cuenta).toEqual({ iban: IBAN_1, bic: 'CAIXESBBXXX' });
    expect(pdfBorrador.textoPie).toBe('Pie de después');

    // Al emitir el borrador, se copia lo de ahora.
    const final = await incomeInvoicesService.finalizar(ES, borrador.id, { fechaEmision: '2026-03-03' });
    const filaFinal = await prisma.incomeInvoice.findUnique({ where: { id: final.id } });
    expect([filaFinal!.ibanCobro, filaFinal!.textoPie]).toEqual([IBAN_1, 'Pie de después']);
    // Y el PDF se genera bien con el pie.
    expect((await generarPdfFactura(ES, final.id)).contenido.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sin mostrar el IBAN: la factura emitida guarda "" y el PDF no lo lleva', async () => {
    await guardar({ mostrarIban: false, textoPie: null });
    const f = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-04', lineas: [linea] });
    const fila = await prisma.incomeInvoice.findUnique({ where: { id: f.id } });
    expect([fila!.ibanCobro, fila!.textoPie]).toEqual(['', '']);
    await guardar({ mostrarIban: true, textoPie: 'Pie nuevo' });
    const datos = (await datosPdfFactura(ES, f.id)).datos;
    expect([datos.cuenta, datos.textoPie]).toEqual([null, '']);
    await guardar({ textoPie: null });
  });

  it('una factura emitida antes de la copia (null) no cambia con los ajustes: la regla de entonces y sin pie', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-05', lineas: [linea] });
    await prisma.incomeInvoice.update({ where: { id: f.id }, data: { ibanCobro: null, textoPie: null } });
    const primeraEur = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: ES, activa: true, moneda: 'EUR' }, orderBy: { createdAt: 'asc' } });
    const antes = (await datosPdfFactura(ES, f.id)).datos;
    expect([antes.cuenta?.iban, antes.textoPie]).toEqual([primeraEur.iban, null]);

    // Se oculta el IBAN, se elige otra cuenta y se escribe un pie: el PDF de esa factura sigue igual.
    await guardar({ mostrarIban: false, cuentaBancariaId: cuenta2, textoPie: 'Pie que no llevaba' });
    const despues = (await datosPdfFactura(ES, f.id)).datos;
    expect([despues.cuenta?.iban, despues.textoPie]).toEqual([primeraEur.iban, null]);

    // Un borrador sin copia sí usa los ajustes de ahora.
    const b = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: clienteEs }, fechaEmision: '2026-03-05', lineas: [linea], borrador: true });
    const borrador = (await datosPdfFactura(ES, b.id)).datos;
    expect([borrador.cuenta, borrador.textoPie]).toEqual([null, 'Pie que no llevaba']);
    await guardar({ mostrarIban: true, cuentaBancariaId: null, textoPie: null });
  });
});

describe('cuentaParaFactura (pura)', () => {
  const eur = { id: 'a', moneda: 'EUR' };
  const usd = { id: 'b', moneda: 'USD' };
  it('automática: la primera en la moneda de la factura; si no, la primera', () => {
    expect(cuentaParaFactura([eur, usd], { cuentaBancariaId: null, mostrarIban: true }, 'USD')).toBe(usd);
    expect(cuentaParaFactura([eur], { cuentaBancariaId: null, mostrarIban: true }, 'USD')).toBe(eur);
  });
  it('la elegida si sigue activa y es de la moneda de la factura; sin IBAN, ninguna', () => {
    expect(cuentaParaFactura([eur, usd], { cuentaBancariaId: 'b', mostrarIban: true }, 'USD')).toBe(usd);
    // Elegida en USD y factura en EUR: la automática en EUR, no la cuenta en otra moneda.
    expect(cuentaParaFactura([eur, usd], { cuentaBancariaId: 'b', mostrarIban: true }, 'EUR')).toBe(eur);
    expect(cuentaParaFactura([usd, eur], { cuentaBancariaId: 'a', mostrarIban: true }, 'USD')).toBe(usd);
    expect(cuentaParaFactura([eur], { cuentaBancariaId: 'b', mostrarIban: true }, 'EUR')).toBe(eur);
    expect(cuentaParaFactura([eur], { cuentaBancariaId: null, mostrarIban: false }, 'EUR')).toBeNull();
  });
});
