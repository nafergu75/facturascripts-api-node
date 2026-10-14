/**
 * Inmutabilidad de VERI*FACTU (config/inmutabilidadVerifactu.ts; spec
 * verifactu, 2.8 y 7.4) sobre BD real: los registros solo cambian su envio y
 * no se borran; una factura con registro solo cambia su cobro, su estado de
 * VERI*FACTU y la anulacion, y sus lineas y enlaces no se tocan. Las facturas
 * sin registro siguen como siempre.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import { hoyEspana } from '../utils/fechas';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `vfinm-${SUFIJO}`;
const HOY = hoyEspana();
let cliente = '';
let facturaId = '';
let registroId = '';
let rectificativaId = '';
let leidaId = '';

function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}

const linea = (precio = 100) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const inmutable = { statusCode: 409, details: { codigo: 'VERIFACTU_INMUTABLE' } };
const registrada = { statusCode: 409, details: { codigo: 'FACTURA_REGISTRADA' } };

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Inmutabilidad', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, tipoSociedad: 'SL', denominacion: 'Inmutable SL', nif: cifSl() } });
  await listarSeries(E);
  await prisma.verifactuConfig.create({ data: { companyId: E, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente SL', nifCif: 'B12345674', pais: 'ES' } })).id;
  const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, fechaEmision: HOY, lineas: [linea(1000)] });
  facturaId = f.id;
  registroId = (await prisma.verifactuRegistro.findFirstOrThrow({ where: { incomeInvoiceId: f.id } })).id;
  const r = await incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    fechaEmision: HOY,
    lineas: [linea(-100)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: f.id }] },
  } as unknown as CrearFacturaIngresoDTO);
  rectificativaId = r.id;
  const leida = await incomeInvoicesService.crearIngreso(
    { companyId: E, customer: { id: cliente }, fechaEmision: HOY, lineas: [linea(50)], serie: 'LEC', numero: 1 } as CrearFacturaIngresoDTO,
    { origen: 'lector' },
  );
  leidaId = leida.id;
});

describe('VerifactuRegistro', () => {
  it('cambiar la huella o el importe: 409; cambiar el envío: sí', async () => {
    await expect(prisma.verifactuRegistro.update({ where: { id: registroId }, data: { huella: 'A'.repeat(64) } })).rejects.toMatchObject(inmutable);
    await expect(prisma.verifactuRegistro.updateMany({ where: { id: registroId }, data: { importeTotal: '1.00' } })).rejects.toMatchObject(inmutable);
    // Un campo de envio junto a otro que no lo es: tambien se rechaza entero.
    await expect(prisma.verifactuRegistro.update({ where: { id: registroId }, data: { estadoEnvio: 'ENVIANDO', contenido: {} } })).rejects.toMatchObject(inmutable);
    const r = await prisma.verifactuRegistro.update({ where: { id: registroId }, data: { estadoEnvio: 'ENVIANDO', intentos: { increment: 1 }, bloqueadoHasta: new Date() } });
    expect(r).toMatchObject({ estadoEnvio: 'ENVIANDO', intentos: 1 });
    await prisma.verifactuRegistro.update({ where: { id: registroId }, data: { estadoEnvio: 'PENDIENTE', intentos: 0, bloqueadoHasta: null } });
  });

  it('borrar un registro, la cadena o la bitácora: rechazado', async () => {
    await expect(prisma.verifactuRegistro.delete({ where: { id: registroId } })).rejects.toMatchObject(inmutable);
    await expect(prisma.verifactuRegistro.deleteMany({ where: { companyId: E } })).rejects.toMatchObject(inmutable);
    await expect(prisma.verifactuCadena.deleteMany({ where: { companyId: E } })).rejects.toMatchObject(inmutable);
    await expect(prisma.verifactuBitacora.deleteMany({ where: { companyId: E } })).rejects.toMatchObject(inmutable);
    expect(await prisma.verifactuRegistro.count({ where: { companyId: E } })).toBe(2);
  });

  it('dentro de una transacción, igual', async () => {
    await expect(prisma.$transaction(async (tx) => tx.verifactuRegistro.update({ where: { id: registroId }, data: { huella: 'B'.repeat(64) } }))).rejects.toMatchObject(inmutable);
  });
});

describe('factura con registro', () => {
  it('cambiar la base, la fecha o el número: 409 FACTURA_REGISTRADA (y nada cambia)', async () => {
    await expect(prisma.incomeInvoice.update({ where: { id: facturaId }, data: { baseTotal: 1 } })).rejects.toMatchObject(registrada);
    await expect(prisma.incomeInvoice.update({ where: { id: facturaId }, data: { fechaEmision: '2026-01-01' } })).rejects.toMatchObject(registrada);
    await expect(prisma.incomeInvoice.update({ where: { id: facturaId }, data: { numero: 999 } })).rejects.toMatchObject(registrada);
    await expect(prisma.incomeInvoice.update({ where: { id: facturaId }, data: { lineas: { deleteMany: {} } } })).rejects.toMatchObject(registrada);
    // updateMany la deja fuera sin error.
    expect((await prisma.incomeInvoice.updateMany({ where: { id: facturaId }, data: { observaciones: 'cambiada' } })).count).toBe(0);
    expect(await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: facturaId } })).toMatchObject({ baseTotal: 1000, fechaEmision: HOY, observaciones: null });
  });

  it('cambiar el estado de cobro y el de VERI*FACTU: sí; poner el de VERI*FACTU a null: no', async () => {
    expect((await prisma.incomeInvoice.update({ where: { id: facturaId }, data: { estado: 'PAID' } })).estado).toBe('PAID');
    expect((await prisma.incomeInvoice.update({ where: { id: facturaId }, data: { estado: 'PENDING', verifactuEstado: 'ACEPTADO' } })).verifactuEstado).toBe('ACEPTADO');
    await expect(prisma.incomeInvoice.update({ where: { id: facturaId }, data: { verifactuEstado: null } })).rejects.toMatchObject(registrada);
    await prisma.incomeInvoice.update({ where: { id: facturaId }, data: { verifactuEstado: 'PENDIENTE' } });
  });

  it('borrarla: lo impide la clave ajena del registro', async () => {
    await expect(prisma.incomeInvoice.delete({ where: { id: facturaId } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.incomeInvoice.deleteMany({ where: { id: facturaId } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.incomeInvoice.count({ where: { id: facturaId } })).toBe(1);
  });

  it('borrar la empresa con registros: lo impide la clave ajena de su cadena (el registro no la tiene, a propósito)', async () => {
    await expect(prisma.company.delete({ where: { id: E } })).rejects.toMatchObject({ code: expect.stringMatching(/^P20(03|14)$/) });
    expect(await prisma.verifactuRegistro.count({ where: { companyId: E } })).toBeGreaterThan(0);
  });

  it('cambiar o borrar sus líneas: rechazado', async () => {
    const [l] = await prisma.incomeInvoiceLine.findMany({ where: { invoiceId: facturaId } });
    await expect(prisma.incomeInvoiceLine.update({ where: { id: l.id }, data: { baseLine: 1 } })).rejects.toMatchObject(registrada);
    await expect(prisma.incomeInvoiceLine.delete({ where: { id: l.id } })).rejects.toMatchObject(registrada);
    expect((await prisma.incomeInvoiceLine.deleteMany({ where: { invoiceId: facturaId } })).count).toBe(0);
    expect((await prisma.incomeInvoiceLine.updateMany({ where: { invoiceId: facturaId }, data: { descripcion: 'otra' } })).count).toBe(0);
    expect(await prisma.incomeInvoiceLine.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ baseLine: 1000, descripcion: 'Servicio' });
  });

  it('los enlaces de una rectificativa registrada no se cambian', async () => {
    expect((await prisma.incomeInvoiceRectificada.deleteMany({ where: { rectificativaId } })).count).toBe(0);
    expect((await prisma.incomeInvoiceRectificada.updateMany({ where: { rectificativaId }, data: { baseRectificada: 1 } })).count).toBe(0);
    expect(await prisma.incomeInvoiceRectificada.count({ where: { rectificativaId } })).toBe(1);
  });

  it('modificar o borrar como borrador sigue dando 400', async () => {
    await expect(incomeInvoicesService.actualizarBorrador(E, facturaId, { observaciones: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(incomeInvoicesService.eliminarBorrador(E, facturaId)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('factura FINAL sin registro (lector)', () => {
  it('se puede cambiar y sus líneas también, como hasta ahora', async () => {
    expect((await prisma.incomeInvoice.update({ where: { id: leidaId }, data: { observaciones: 'revisada' } })).observaciones).toBe('revisada');
    expect((await prisma.incomeInvoiceLine.updateMany({ where: { invoiceId: leidaId }, data: { accountCode: '705' } })).count).toBe(1);
  });
});
