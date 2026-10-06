/**
 * Facturas proforma sobre BD real: serie P numerada al crear y sin huecos,
 * fuera de la lista de facturas y de impuestos, "Pasar a factura" (borrador
 * enlazado, una sola vez), sin cobros y PDF propio.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { generarPdfFactura } from '../services/facturaPdf.service';
import { obtenerFacturasFiscales } from '../services/impuestosCalculo.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';

const COMPANY_ID = `proformas-test-${Date.now()}`;
let customerId: string;

const linea = (precio: number, iva = 21) => ({ descripcion: 'Servicio presupuestado', cantidad: 1, precioUnitario: precio, tipoIva: iva });
const nuevaProforma = (precio = 100, fechaEmision?: string) =>
  incomeInvoicesService.crearIngreso({
    companyId: COMPANY_ID,
    customer: { id: customerId },
    fechaEmision,
    lineas: [linea(precio)],
    formaPago: 'GIRO',
    observaciones: 'Válida 30 días',
    proforma: true,
  });

beforeAll(async () => {
  await prisma.company.create({
    data: { id: COMPANY_ID, name: 'Proformas Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'test-key' },
  });
  const c = await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Proforma SL', nifCif: 'B87654321' } });
  customerId = c.id;
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Proformas Test SL', nif: 'B00000001' } });
});

describe('Numeración de las proformas', () => {
  it('se numeran al crearlas en la serie P, sin huecos y sin la regla de fechas', async () => {
    const p1 = await nuevaProforma(100, '2026-05-10');
    // Fecha anterior a la de la proforma anterior: en una proforma no importa.
    const p2 = await nuevaProforma(200, '2026-05-01');
    expect(p1.estadoDocumento).toBe('PROFORMA');
    expect(p1.estado).toBe('PENDIENTE');
    expect(p1.serie).toBe('P');
    expect(p1.numeroCompleto).toBe('P-1');
    expect(p2.numeroCompleto).toBe('P-2');

    // Dos a la vez: numeros seguidos y distintos.
    const [a, b] = await Promise.all([nuevaProforma(10), nuevaProforma(20)]);
    expect([a.numero, b.numero].sort()).toEqual([3, 4]);

    // Borrar la ultima no deja hueco: la siguiente reutiliza su numero.
    await incomeInvoicesService.eliminarBorrador(COMPANY_ID, a.numero === 4 ? a.id : b.id);
    const p4 = await nuevaProforma(30);
    expect(p4.numeroCompleto).toBe('P-4');
  });

  it('una pendiente se edita; no se emite ni se rectifica', async () => {
    const p = await nuevaProforma(100);
    const editada = await incomeInvoicesService.actualizarBorrador(COMPANY_ID, p.id, { lineas: [linea(300)] });
    expect(editada.baseTotal).toBe(300);
    expect(editada.numeroCompleto).toBe(p.numeroCompleto);
    await expect(incomeInvoicesService.finalizar(COMPANY_ID, p.id)).rejects.toThrow(/proforma/i);
    await expect(incomeInvoicesService.crearRectificativa(COMPANY_ID, p.id, { motivo: 'x' })).rejects.toThrow(/proforma/i);
  });
});

describe('Proformas fuera de lo fiscal', () => {
  it('no salen en la lista de facturas ni en obtenerFacturasFiscales', async () => {
    const p = await nuevaProforma(5000, '2026-07-10');
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-07-11',
      lineas: [linea(70)],
    });

    const lista = await incomeInvoicesService.listar(COMPANY_ID, { take: 100 });
    expect(lista.items.map((x) => x.id)).toContain(f.id);
    expect(lista.items.some((x) => x.estadoDocumento === 'PROFORMA')).toBe(false);

    const proformas = await incomeInvoicesService.listar(COMPANY_ID, { estadoDocumento: 'PROFORMA', take: 100 });
    expect(proformas.items.map((x) => x.id)).toContain(p.id);
    expect(proformas.items.every((x) => x.estadoDocumento === 'PROFORMA')).toBe(true);

    const fiscales = await obtenerFacturasFiscales(COMPANY_ID, '2026-07-01', '2026-07-31');
    const ids = fiscales.map((x) => x.idFactura);
    expect(ids).toContain(f.numeroCompleto);
    expect(ids).not.toContain(p.numeroCompleto);
    expect(ids).not.toContain(p.id);
  });

  it('no admite cobros', async () => {
    const p = await nuevaProforma(100);
    await expect(incomeInvoicesService.cambiarEstado(COMPANY_ID, p.id, 'PAID', { caja: true })).rejects.toThrow(/proforma/i);
    await expect(registrarCobroFactura(COMPANY_ID, 'INGRESO', p.id, { caja: true, importe: 10 })).rejects.toThrow(/proforma/i);
  });
});

describe('Pasar a factura', () => {
  it('crea un borrador de factura enlazado y deja la proforma ACEPTADA', async () => {
    const p = await nuevaProforma(400);
    const f = await incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id);
    expect(f.estadoDocumento).toBe('BORRADOR');
    expect(f.numero).toBeNull();
    expect(f.serie).toBe('A');
    expect(f.proformaId).toBe(p.id);
    expect(f.customerId).toBe(customerId);
    expect(f.formaPago).toBe('GIRO');
    expect(f.observaciones).toBe('Válida 30 días');
    expect(f.totalFactura).toBe(484);
    expect(f.lineas).toHaveLength(1);

    const despues = await incomeInvoicesService.obtenerPorId(COMPANY_ID, p.id);
    expect(despues.estado).toBe('ACEPTADA');
    expect(despues.facturaGeneradaId).toBe(f.id);

    // Aceptada: ya no se edita ni se borra, y no se convierte dos veces.
    await expect(incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id)).rejects.toThrow(/ya se pasó/);
    await expect(incomeInvoicesService.actualizarBorrador(COMPANY_ID, p.id, { observaciones: 'x' })).rejects.toThrow(/aceptada/);
    await expect(incomeInvoicesService.eliminarBorrador(COMPANY_ID, p.id)).rejects.toThrow(/aceptada/);

    // La factura sigue su camino normal: al emitirla recibe numero de la serie A.
    const emitida = await incomeInvoicesService.finalizar(COMPANY_ID, f.id, { fechaEmision: '2026-12-01' });
    expect(emitida.estadoDocumento).toBe('FINAL');
    expect(emitida.numeroCompleto).toMatch(/^A-\d+$/);
  });

  it('dos conversiones a la vez solo crean una factura', async () => {
    const p = await nuevaProforma(50);
    const r = await Promise.allSettled([
      incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id),
      incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.incomeInvoice.count({ where: { companyId: COMPANY_ID, proformaId: p.id } })).toBe(1);
  });

  it('si se borra el borrador, la proforma vuelve a estar pendiente', async () => {
    const p = await nuevaProforma(60);
    const f = await incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id);
    await incomeInvoicesService.eliminarBorrador(COMPANY_ID, f.id);
    expect((await incomeInvoicesService.obtenerPorId(COMPANY_ID, p.id)).estado).toBe('PENDIENTE');
  });

  it('una rechazada no se pasa a factura; duplicada es otra proforma', async () => {
    const p = await nuevaProforma(70);
    const r = await incomeInvoicesService.rechazarProforma(COMPANY_ID, p.id);
    expect(r.estado).toBe('RECHAZADA');
    await expect(incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, p.id)).rejects.toThrow(/rechazada/);
    await expect(incomeInvoicesService.rechazarProforma(COMPANY_ID, p.id)).rejects.toThrow(/rechazada/);

    const copia = await incomeInvoicesService.duplicar(COMPANY_ID, p.id);
    expect(copia.estadoDocumento).toBe('PROFORMA');
    expect(copia.estado).toBe('PENDIENTE');
    expect(copia.numeroCompleto).toMatch(/^P-\d+$/);
    expect(copia.numero).toBeGreaterThan(p.numero!);
  });

  it('solo las proformas se pasan a factura o se rechazan', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, lineas: [linea(10)], borrador: true });
    await expect(incomeInvoicesService.pasarProformaAFactura(COMPANY_ID, b.id)).rejects.toThrow(/no es una factura proforma/);
    await expect(incomeInvoicesService.rechazarProforma(COMPANY_ID, b.id)).rejects.toThrow(/no es una factura proforma/);
  });
});

describe('PDF de la proforma', () => {
  it('sale con su numero P y nombre proforma_P-n.pdf', async () => {
    const p = await nuevaProforma(100);
    const pdf = await generarPdfFactura(COMPANY_ID, p.id);
    expect(pdf.nombre).toBe(`proforma_${p.numeroCompleto}.pdf`);
    expect(pdf.contenido.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
