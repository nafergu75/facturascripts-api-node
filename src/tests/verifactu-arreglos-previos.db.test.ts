/**
 * Arreglos previos a VERI*FACTU (spec verifactu, apartado 8) sobre BD real.
 * Cada describe es uno de los fallos P1-P11 (P4 y P6 del lector van tambien en
 * verifactu-arreglos-lector.test.ts; P8 en tipo-operacion.model.test.ts; P12 en
 * verifactu-sin-restos.test.ts).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { marcarEmpresaPruebas } from './ayuda-empresa-pruebas';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { crearSerie, listarSeries } from '../services/series.service';
import { legalConfigService } from '../services/legalConfig.service';
import { datosPdfFactura, pdfParaDescargar } from '../services/facturaPdf.service';
import { putObject } from '../utils/storage';
import { hoyEspana, sumarDiasISO } from '../utils/fechas';
import { promises as fsp } from 'fs';
import path from 'path';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const EMPRESA = `vfarr-${SUFIJO}`;
const SIN_NIF = `vfarr-sinnif-${SUFIJO}`;
const CON_VF = `vfarr-vf-${SUFIJO}`;
const SIN_FACTURAS = `vfarr-nueva-${SUFIJO}`;
const EMPRESAS = [EMPRESA, SIN_NIF, CON_VF, SIN_FACTURAS];
const USUARIO = `vfarr-user-${SUFIJO}`;
const clientes: Record<string, string> = {};

/** CIF de sociedad limitada valido y distinto en cada ejecucion (el NIF no se repite entre empresas). */
function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}

const HOY = hoyEspana();
const MANANA = sumarDiasISO(HOY, 1);
const linea = (precio = 100, tipoIva = 21) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva });
const alta = (extra: Record<string, unknown> = {}, companyId = EMPRESA) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: clientes[companyId] }, fechaEmision: HOY, lineas: [linea()], ...extra });
const delLector = (extra: Record<string, unknown>) =>
  incomeInvoicesService.crearIngreso({ companyId: EMPRESA, customer: { id: clientes[EMPRESA] }, fechaEmision: HOY, lineas: [linea()], ...extra }, { origen: 'lector' });
const serie = (codigo: string, companyId = EMPRESA) => prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo } } });
const origenDe = async (id: string) => (await prisma.incomeInvoice.findUniqueOrThrow({ where: { id }, select: { origen: true } })).origen;

beforeAll(async () => {
  for (const id of EMPRESAS) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    clientes[id] = (await prisma.customer.create({ data: { companyId: id, nombreFiscal: `Cliente ${id}`, nifCif: 'B12345674', pais: 'ES' } })).id;
    await listarSeries(id); // A, R y P
  }
  await prisma.legalConfig.create({ data: { companyId: EMPRESA, tipoSociedad: 'SL', denominacion: 'Arreglos SL', nif: 'B33333333' } });
  await prisma.legalConfig.create({ data: { companyId: CON_VF, tipoSociedad: 'SL', denominacion: 'Con Verifactu SL', nif: 'B44444444' } });
  await prisma.legalConfig.create({ data: { companyId: SIN_FACTURAS, tipoSociedad: 'SL', denominacion: 'Recién Llegada SL', nif: cifSl() } });
  await prisma.verifactuConfig.create({ data: { companyId: CON_VF, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  await marcarEmpresaPruebas(prisma, CON_VF);
});

afterAll(async () => {
  await prisma.verifactuConfig.deleteMany({ where: { companyId: { in: EMPRESAS } } });
  await prisma.auditLog.deleteMany({ where: { userId: USUARIO } });
  await fsp.rm(path.join(process.cwd(), 'storage', 'tests', `vfarr-${SUFIJO}`), { recursive: true, force: true });
});

describe('P1: desde la API no se elige el número de una factura emitida', () => {
  it('un «numero» en el cuerpo se ignora: la factura lleva el siguiente de la serie', async () => {
    const antes = (await serie('A'))!.ultimoNumero;
    const f = await alta({ numero: 9999 });
    expect(f.estadoDocumento).toBe('FINAL');
    expect(f.numero).toBe(antes + 1);
    expect((await serie('A'))!.ultimoNumero).toBe(antes + 1);
  });

  it('el lector sí conserva su número (y nunca lo numera la app)', async () => {
    const f = await delLector({ serie: 'IMP', numero: 41 });
    expect(f.numeroCompleto).toBe('IMP-41');
  });
});

describe('P2: la emisión directa exige NIF y denominación del emisor', () => {
  it('sin ellos, 400 antes de numerar (como al finalizar un borrador)', async () => {
    const antes = (await serie('A', SIN_NIF))!.ultimoNumero;
    await expect(alta({}, SIN_NIF)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/denominación y el NIF/) });
    expect((await serie('A', SIN_NIF))!.ultimoNumero).toBe(antes);
    // El borrador sí se guarda; al finalizarlo, el mismo aviso.
    const b = await alta({ borrador: true }, SIN_NIF);
    await expect(incomeInvoicesService.finalizar(SIN_NIF, b.id)).rejects.toThrow(/denominación y el NIF/);
  });
});

describe('P3: no se emite con fecha futura', () => {
  it('emisión directa con fecha de mañana: 400', async () => {
    await expect(alta({ fechaEmision: MANANA })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/posterior a hoy/) });
  });

  it('finalizar con fecha de mañana: 400; el borrador y la proforma con esa fecha sí se guardan', async () => {
    const b = await alta({ borrador: true, fechaEmision: MANANA });
    await expect(incomeInvoicesService.finalizar(EMPRESA, b.id, { fechaEmision: MANANA })).rejects.toThrow(/posterior a hoy/);
    expect((await alta({ proforma: true, fechaEmision: MANANA })).estadoDocumento).toBe('PROFORMA');
    expect((await incomeInvoicesService.finalizar(EMPRESA, b.id, { fechaEmision: HOY })).estadoDocumento).toBe('FINAL');
  });
});

describe('P4: el lector no deja que la app numere la factura', () => {
  it('sin número leído: 400 y no se crea nada', async () => {
    const antes = await prisma.incomeInvoice.count({ where: { companyId: EMPRESA } });
    await expect(delLector({ serie: 'IMP' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/número/) });
    await expect(delLector({ numero: 3 })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/serie/) });
    expect(await prisma.incomeInvoice.count({ where: { companyId: EMPRESA } })).toBe(antes);
  });
});

describe('P5: las facturas del lector van a series históricas', () => {
  it('si el código coincide con una serie de la app (activa): 409, no se crea nada y no sube el contador', async () => {
    const antes = (await serie('A'))!;
    const facturas = await prisma.incomeInvoice.count({ where: { companyId: EMPRESA } });
    await expect(delLector({ serie: 'A', numero: 500 })).rejects.toMatchObject({
      statusCode: 409,
      details: { campo: 'serie' },
      message: expect.stringMatching(/mismo número/),
    });
    expect(await prisma.incomeInvoice.count({ where: { companyId: EMPRESA } })).toBe(facturas);
    expect(await serie('A-H')).toBeNull();
    const despues = (await serie('A'))!;
    expect(despues.ultimoNumero).toBe(antes.ultimoNumero);
    expect(despues.activa).toBe(true);
  });

  it('una serie nueva se crea desactivada y la factura lleva su número real', async () => {
    const f = await delLector({ serie: 'OTRO-26', numero: 500 });
    expect(f.serie).toBe('OTRO-26');
    expect(f.numeroCompleto).toBe('OTRO-26-500');
    expect((await serie('OTRO-26'))!).toMatchObject({ activa: false, tipoDocumento: 'FACTURA' });
  });

  it('una serie ya histórica (desactivada) se reutiliza tal cual', async () => {
    await delLector({ serie: 'ANT-2025', numero: 1 });
    const f = await delLector({ serie: 'ant-2025', numero: 2 });
    expect(f.serie).toBe('ANT-2025');
    expect((await serie('ANT-2025'))!.activa).toBe(false);
  });

  it('el código normalizado («fac/26» → FAC-26) tampoco cae en una serie activa', async () => {
    await crearSerie(EMPRESA, { codigo: 'FAC-26', descripcion: 'Activa', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
    await expect(delLector({ serie: 'fac/26', numero: 8 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await serie('FAC-26'))!.ultimoNumero).toBe(0);
  });

  it('una serie de la app que se desactivó, con facturas suyas, no se trata como histórica', async () => {
    await crearSerie(EMPRESA, { codigo: 'VIEJA', descripcion: 'De la app', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
    await alta({ serie: 'VIEJA' });
    await prisma.invoiceSeries.update({ where: { companyId_codigo: { companyId: EMPRESA, codigo: 'VIEJA' } }, data: { activa: false } });
    const contador = (await serie('VIEJA'))!.ultimoNumero;
    await expect(delLector({ serie: 'VIEJA', numero: 90 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await serie('VIEJA'))!.ultimoNumero).toBe(contador);
  });
});

describe('Factura del lector: duplicar y PDF', () => {
  it('se puede duplicar: la copia va a la serie de facturas por defecto', async () => {
    const f = await delLector({ serie: 'DUP-26', numero: 3 });
    const copia = await incomeInvoicesService.duplicar(EMPRESA, f.id);
    expect(copia.estadoDocumento).toBe('BORRADOR');
    expect(copia.serie).toBe('A');
  });

  it('su PDF nunca es la plantilla de factura de la app: sale marcado como registro de otro programa', async () => {
    const f = await delLector({ serie: 'PDF-26', numero: 4 });
    const { datos, nombre } = await datosPdfFactura(EMPRESA, f.id);
    expect(datos.registroLector).toBe(true);
    expect(nombre).toBe('registro_factura_PDF-26-4.pdf');
    const descarga = await pdfParaDescargar(EMPRESA, f.id);
    expect(descarga.nombre).toBe('registro_factura_PDF-26-4.pdf');
    expect(descarga.contenido.subarray(0, 4).toString()).toBe('%PDF');
    // Una factura de la app sigue siendo una factura.
    const propia = await alta();
    expect((await datosPdfFactura(EMPRESA, propia.id)).datos.registroLector).toBe(false);
  });

  it('con el PDF original guardado por el lector, se descarga ese original', async () => {
    const f = await delLector({ serie: 'ORI-26', numero: 5 });
    const original = Buffer.from('%PDF-1.4 original del otro programa');
    const storagePath = await putObject(`tests/vfarr-${SUFIJO}/original.pdf`, original, 'application/pdf');
    await prisma.incomeReaderDocument.create({
      data: {
        companyId: EMPRESA,
        sourceType: 'WEB_UPLOAD',
        originalFileName: 'original.pdf',
        mimeType: 'application/pdf',
        fileSize: original.length,
        storagePath,
        status: 'VERIFIED',
        linkedInvoiceId: f.id,
      },
    });
    const descarga = await pdfParaDescargar(EMPRESA, f.id);
    expect(descarga.contenido.equals(original)).toBe(true);
    expect(descarga.nombre).toBe('factura_ORI-26-5_original.pdf');
  });
});

describe('P7: se guarda el origen de cada factura', () => {
  it('pantalla, copia y lector en todos los caminos de alta', async () => {
    const emitida = await alta();
    expect(await origenDe(emitida.id)).toBe('pantalla');
    const borrador = await alta({ borrador: true });
    expect(await origenDe(borrador.id)).toBe('pantalla');
    const proforma = await alta({ proforma: true });
    expect(await origenDe(proforma.id)).toBe('pantalla');
    expect(await origenDe((await incomeInvoicesService.duplicar(EMPRESA, emitida.id)).id)).toBe('copia');
    expect(await origenDe((await incomeInvoicesService.pasarProformaAFactura(EMPRESA, proforma.id)).id)).toBe('copia');
    expect(await origenDe((await incomeInvoicesService.crearRectificativa(EMPRESA, emitida.id, { motivo: 'Error' })).id)).toBe('pantalla');
    expect(await origenDe((await delLector({ serie: 'IMP', numero: 77 })).id)).toBe('lector');
    // El cuerpo no lo elige.
    expect(await origenDe((await alta({ origen: 'lector' })).id)).toBe('pantalla');
  });

  it('finalizar conserva el origen del borrador; uno antiguo sin origen pasa a «pantalla»', async () => {
    const copia = await incomeInvoicesService.duplicar(EMPRESA, (await alta()).id);
    await incomeInvoicesService.finalizar(EMPRESA, copia.id);
    expect(await origenDe(copia.id)).toBe('copia');
    const antiguo = await alta({ borrador: true });
    await prisma.incomeInvoice.update({ where: { id: antiguo.id }, data: { origen: null } });
    await incomeInvoicesService.finalizar(EMPRESA, antiguo.id);
    expect(await origenDe(antiguo.id)).toBe('pantalla');
  });
});

describe('P9: simplificadas (F2) y sus rectificativas (R5)', () => {
  it('una F2 de más de 3.000 € (base más IVA) no se emite; hasta 3.000 €, sí', async () => {
    await expect(alta({ tipoFactura: 'F2', lineas: [linea(2500)] })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/3\.000/),
    });
    // 2479,34 + 21 % = 2999,999 -> 3.000,00 € justos.
    expect((await alta({ tipoFactura: 'F2', lineas: [linea(2479.34)] })).estadoDocumento).toBe('FINAL');
  });

  it('el borrador de una F2 grande se guarda, pero no se finaliza', async () => {
    const b = await alta({ tipoFactura: 'F2', borrador: true, lineas: [linea(2500)] });
    await expect(incomeInvoicesService.finalizar(EMPRESA, b.id)).rejects.toThrow(/3\.000/);
  });

  it('R5 solo rectifica una simplificada (F2)', async () => {
    const completa = await alta();
    await expect(incomeInvoicesService.crearRectificativa(EMPRESA, completa.id, { motivo: 'Error', tipoFactura: 'R5' })).rejects.toThrow(/R5/);
    const simplificada = await alta({ tipoFactura: 'F2' });
    const r = await incomeInvoicesService.crearRectificativa(EMPRESA, simplificada.id, { motivo: 'Error', tipoFactura: 'R5' });
    expect(r.tipoFactura).toBe('R5');
  });

  it('tampoco cambiando a R5 el borrador de la rectificativa de una F1, ni al finalizarlo', async () => {
    const completa = await alta();
    const b = await incomeInvoicesService.crearRectificativa(EMPRESA, completa.id, { motivo: 'Error', borrador: true });
    await expect(incomeInvoicesService.actualizarBorrador(EMPRESA, b.id, { tipoFactura: 'R5' })).rejects.toMatchObject({
      statusCode: 400,
      details: { campo: 'tipoFactura' },
    });
    // Aunque el tipo se hubiera colado por otra via, finalizar no emite una R5 sobre una F1.
    await prisma.incomeInvoice.update({ where: { id: b.id }, data: { tipoFactura: 'R5' } });
    const antes = (await serie('R'))!.ultimoNumero;
    await expect(incomeInvoicesService.finalizar(EMPRESA, b.id)).rejects.toThrow(/R5/);
    expect((await serie('R'))!.ultimoNumero).toBe(antes);
  });
});

describe('P10: el NIF del emisor no cambia con VERI*FACTU activado', () => {
  it('con VERI*FACTU en marcha (pruebas o activo): 409 al cambiar el NIF; la denominación sí cambia', async () => {
    await expect(legalConfigService.actualizar(CON_VF, { nif: cifSl() })).rejects.toMatchObject({
      statusCode: 409,
      details: { campo: 'nif' },
    });
    const cfg = await legalConfigService.actualizar(CON_VF, { denominacion: 'Con Verifactu Nueva SL' });
    expect(cfg.denominacion).toBe('Con Verifactu Nueva SL');
    expect((await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: CON_VF } })).nif).toBe('B44444444');
  });

  it('sin facturas emitidas, el NIF se puede corregir', async () => {
    const nuevo = cifSl();
    const cfg = await legalConfigService.actualizar(SIN_FACTURAS, { nif: nuevo });
    expect(cfg.nif).toBe(nuevo);
  });

  it('con facturas emitidas, solo un administrador lo cambia, confirmándolo, y queda el rastro', async () => {
    const nuevo = cifSl();
    const antes = (await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: EMPRESA } })).nif;
    await expect(legalConfigService.actualizar(EMPRESA, { nif: nuevo }, { userId: USUARIO })).rejects.toMatchObject({
      statusCode: 409,
      details: { campo: 'nif', codigo: 'NIF_CON_FACTURAS' },
    });
    await expect(legalConfigService.actualizar(EMPRESA, { nif: nuevo }, { userId: USUARIO, esAdministrador: true })).rejects.toMatchObject({
      statusCode: 409,
      details: { campo: 'nif', codigo: 'CONFIRMAR_CAMBIO_NIF' },
    });
    expect((await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: EMPRESA } })).nif).toBe(antes);

    const cfg = await legalConfigService.actualizar(EMPRESA, { nif: nuevo, confirmarCambioNif: true }, { userId: USUARIO, esAdministrador: true });
    expect(cfg.nif).toBe(nuevo);
    const rastro = await prisma.auditLog.findFirst({ where: { companyId: EMPRESA, action: 'NIF_EMPRESA_CAMBIADO' }, orderBy: { timestamp: 'desc' } });
    expect(rastro?.userId).toBe(USUARIO);
    expect(rastro?.meta).toMatchObject({ nif: { antes, despues: nuevo } });
  });

  it('con facturas emitidas, pasar a autónomo (que retrasa la red al 1-7-2027) tampoco lo hace quien no es administrador', async () => {
    await expect(legalConfigService.actualizar(EMPRESA, { tipoSociedad: 'AUTONOMO', nif: '12345678Z' }, { userId: USUARIO })).rejects.toMatchObject({
      statusCode: 409,
      details: { codigo: 'NIF_CON_FACTURAS' },
    });
    expect((await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: EMPRESA } })).tipoSociedad).toBe('SL');
  });
});

describe('P11: códigos de serie que la AEAT no admite', () => {
  it('al crear la serie: 400 con « & \' < > = o caracteres no ASCII', async () => {
    for (const codigo of ['A&B', 'A"B', "A'B", 'A<B', 'A>B', 'A=B', 'AÑO']) {
      await expect(crearSerie(EMPRESA, { codigo, descripcion: '', tipoDocumento: 'FACTURA', activa: true, porDefecto: false })).rejects.toMatchObject({
        statusCode: 400,
        details: { campo: 'codigo' },
      });
    }
  });

  it('una serie antigua con esos caracteres no emite (ni directa ni al finalizar)', async () => {
    await prisma.invoiceSeries.create({ data: { companyId: EMPRESA, codigo: 'X&Y', descripcion: 'Antigua', tipoDocumento: 'FACTURA', activa: true } });
    await expect(alta({ serie: 'X&Y' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/AEAT/) });
    const b = await alta({ serie: 'X&Y', borrador: true });
    await expect(incomeInvoicesService.finalizar(EMPRESA, b.id)).rejects.toThrow(/AEAT/);
    expect((await serie('X&Y'))!.ultimoNumero).toBe(0);
  });
});
