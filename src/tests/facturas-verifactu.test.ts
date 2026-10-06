/**
 * Ciclo de vida de las facturas de venta (Verifactu, paso 1) sobre BD real:
 * borrador sin numero, emision con numero correlativo sin huecos, datos
 * congelados tras emitir, rectificativa en su propia serie y PDF.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { generarPdfFactura } from '../services/facturaPdf.service';
import { obtenerFacturasFiscales } from '../services/impuestosCalculo.service';

const COMPANY_ID = `verifactu-test-${Date.now()}`;
let customerId: string;

const linea = (precio: number, iva = 21) => ({ descripcion: 'Servicio de prueba', cantidad: 1, precioUnitario: precio, tipoIva: iva });

beforeAll(async () => {
  await prisma.company.create({
    data: { id: COMPANY_ID, name: 'Verifactu Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'test-key' },
  });
  const c = await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Verifactu SL', nifCif: 'B12345678' } });
  customerId = c.id;
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Verifactu Test SL', nif: 'B00000000' } });
});

describe('Datos del emisor', () => {
  it('no deja emitir si la empresa no tiene NIF o denominación', async () => {
    const otra = `verifactu-sin-nif-${Date.now()}`;
    await prisma.company.create({ data: { id: otra, name: 'Sin NIF', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const cli = await prisma.customer.create({ data: { companyId: otra, nombreFiscal: 'Cliente', nifCif: 'B11111111' } });
    const b = await incomeInvoicesService.crearIngreso({ companyId: otra, customer: { id: cli.id }, lineas: [linea(10)], borrador: true });
    await expect(incomeInvoicesService.finalizar(otra, b.id)).rejects.toThrow(/NIF de tu empresa/);
  });
});

describe('Facturas de venta: borrador y emision', () => {
  it('un borrador no tiene numero y se puede editar y borrar', async () => {
    const b = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-03-01',
      lineas: [linea(100)],
      borrador: true,
    });
    expect(b.estadoDocumento).toBe('BORRADOR');
    expect(b.numero).toBeNull();
    expect(b.serie).toBe('A');

    const editado = await incomeInvoicesService.actualizarBorrador(COMPANY_ID, b.id, { lineas: [linea(200), linea(50, 10)] });
    expect(editado.baseTotal).toBe(250);
    expect(editado.ivaTotal).toBe(47);
    expect(editado.lineas).toHaveLength(2);

    await incomeInvoicesService.eliminarBorrador(COMPANY_ID, b.id);
    await expect(incomeInvoicesService.obtenerPorId(COMPANY_ID, b.id)).rejects.toThrow(/no encontrada/);
  });

  it('al emitir recibe el siguiente numero de la serie, sin huecos aunque haya borradores', async () => {
    const b1 = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(100)], borrador: true });
    const b2 = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(300)], borrador: true });
    // Se emite primero el segundo borrador: el numero va por orden de emision.
    const f2 = await incomeInvoicesService.finalizar(COMPANY_ID, b2.id, { fechaEmision: '2026-04-01' });
    const f1 = await incomeInvoicesService.finalizar(COMPANY_ID, b1.id, { fechaEmision: '2026-04-02' });
    expect(f2.numeroCompleto).toBe('A-1');
    expect(f1.numeroCompleto).toBe('A-2');
    expect(f1.estadoDocumento).toBe('FINAL');
    expect(f1.finalizadaEn).toBeDefined();
  });

  it('dos emisiones a la vez reciben numeros distintos y seguidos', async () => {
    const [x, y] = await Promise.all([
      incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(10)], borrador: true }),
      incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(20)], borrador: true }),
    ]);
    const emitidas = await Promise.all([
      incomeInvoicesService.finalizar(COMPANY_ID, x.id, { fechaEmision: '2026-04-03' }),
      incomeInvoicesService.finalizar(COMPANY_ID, y.id, { fechaEmision: '2026-04-03' }),
    ]);
    expect(emitidas.map((f) => f.numero).sort()).toEqual([3, 4]);
  });

  it('no deja emitir con fecha anterior a la ultima factura de la serie', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(10)], borrador: true });
    await expect(incomeInvoicesService.finalizar(COMPANY_ID, b.id, { fechaEmision: '2026-01-15' })).rejects.toThrow(/anterior/);
    // El numero no se ha consumido: la siguiente emision valida es la 5.
    const ok = await incomeInvoicesService.finalizar(COMPANY_ID, b.id, { fechaEmision: '2026-04-10' });
    expect(ok.numero).toBe(5);
  });

  it('una factura emitida no se edita, no se borra ni se vuelve a emitir', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-04-11',
      lineas: [linea(100)],
    });
    expect(f.estadoDocumento).toBe('FINAL');
    await expect(incomeInvoicesService.actualizarBorrador(COMPANY_ID, f.id, { observaciones: 'x' })).rejects.toThrow(/rectificativa/);
    await expect(incomeInvoicesService.eliminarBorrador(COMPANY_ID, f.id)).rejects.toThrow(/rectificativa/);
    await expect(incomeInvoicesService.finalizar(COMPANY_ID, f.id)).rejects.toThrow(/emitida/);
  });

  it('el estado de cobro solo admite estados de cobro y solo en facturas emitidas', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(10)], borrador: true });
    await expect(incomeInvoicesService.cambiarEstado(COMPANY_ID, b.id, 'PAID')).rejects.toThrow(/borrador/);
    const f = await incomeInvoicesService.finalizar(COMPANY_ID, b.id, { fechaEmision: '2026-04-12' });
    const cobrada = await incomeInvoicesService.cambiarEstado(COMPANY_ID, f.id, 'PAID');
    expect(cobrada.estado).toBe('PAID');
    await expect(incomeInvoicesService.cambiarEstado(COMPANY_ID, f.id, 'DRAFT')).rejects.toThrow(/no válido/);
  });
});

describe('Rectificativas', () => {
  it('va en la serie de rectificativas, exige motivo y anula la original', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-05-01',
      lineas: [linea(1000)],
    });
    await expect(incomeInvoicesService.crearRectificativa(COMPANY_ID, f.id, {})).rejects.toThrow(/motivo/);

    const r = await incomeInvoicesService.crearRectificativa(COMPANY_ID, f.id, { motivo: 'Precio mal puesto' });
    expect(r.serie).toBe('R');
    expect(r.numeroCompleto).toBe('R-1');
    expect(r.tipoFactura).toBe('R1');
    expect(r.tipoRectificativa).toBe('I');
    expect(r.facturaOriginalId).toBe(f.id);
    expect(r.totalFactura).toBe(-1210);
  });

  it('un borrador no se rectifica', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(10)], borrador: true });
    await expect(incomeInvoicesService.crearRectificativa(COMPANY_ID, b.id, { motivo: 'x' })).rejects.toThrow(/borrador/i);
  });
});

describe('Borradores fuera de impuestos y PDF', () => {
  it('el IVA del periodo no cuenta los borradores', async () => {
    const b = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-06-10',
      lineas: [linea(5000)],
      borrador: true,
    });
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-06-11',
      lineas: [linea(70)],
    });
    const ids = (await obtenerFacturasFiscales(COMPANY_ID, '2026-06-01', '2026-06-30')).map((x) => x.idFactura);
    expect(ids).toContain(f.numeroCompleto);
    expect(ids).not.toContain(b.id);
  });

  it('genera el PDF de una factura emitida y de un borrador', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-06-15',
      lineas: [linea(100), linea(40, 10)],
      observaciones: 'Gracias por su confianza',
    });
    const pdf = await generarPdfFactura(COMPANY_ID, f.id);
    expect(pdf.nombre).toBe(`factura_${f.numeroCompleto}.pdf`);
    expect(pdf.contenido.subarray(0, 5).toString()).toBe('%PDF-');

    const b = await incomeInvoicesService.duplicar(COMPANY_ID, f.id);
    expect(b.estadoDocumento).toBe('BORRADOR');
    expect(b.lineas).toHaveLength(2);
    const pdfB = await generarPdfFactura(COMPANY_ID, b.id);
    expect(pdfB.nombre).toMatch(/^borrador_factura_/);
  });
});
