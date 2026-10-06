/**
 * Archivo de facturas por año y trimestre sobre BD real: árbol, listado por
 * trimestre, archivado idempotente, histórico (regenerar), subida manual y ZIP.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { inflateRawSync } from 'zlib';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import {
  arbolArchivo,
  listarTrimestre,
  archivarFacturaVenta,
  archivarFacturaGasto,
  regenerarArchivo,
  zipTrimestre,
} from '../services/archivoFacturas.service';
import { crearDocumentoArchivo, descargarArchivo } from '../services/documentoArchivo.service';

const COMPANY_ID = `archivo-test-${Date.now()}`;
let customerId: string;
let supplierId: string;

const linea = (precio: number, iva = 21) => ({ descripcion: 'Servicio de prueba', cantidad: 1, precioUnitario: precio, tipoIva: iva });

/** Nombres de las entradas de un ZIP (directorio central). */
function nombresZip(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const total = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const nombres: string[] = [];
  for (let i = 0; i < total; i++) {
    const lNombre = zip.readUInt16LE(p + 28);
    nombres.push(zip.subarray(p + 46, p + 46 + lNombre).toString('utf8'));
    p += 46 + lNombre + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return nombres;
}

/** Contenido de una entrada del ZIP. */
function leerEntrada(zip: Buffer, nombre: string): Buffer {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const total = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    const metodo = zip.readUInt16LE(p + 10);
    const tamComp = zip.readUInt32LE(p + 20);
    const lNombre = zip.readUInt16LE(p + 28);
    const off = zip.readUInt32LE(p + 42);
    if (zip.subarray(p + 46, p + 46 + lNombre).toString('utf8') === nombre) {
      const ini = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
      const datos = zip.subarray(ini, ini + tamComp);
      return metodo === 8 ? inflateRawSync(datos) : Buffer.from(datos);
    }
    p += 46 + lNombre + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  throw new Error(`No está en el ZIP: ${nombre}`);
}

beforeAll(async () => {
  await prisma.company.create({
    data: { id: COMPANY_ID, name: 'Archivo Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'test-key' },
  });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Archivo Test SL', nif: 'B00000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Archivo SL', nifCif: 'B12345678' } })).id;
  supplierId = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor Archivo SL', nifCif: 'B87654321' } })).id;
});

afterAll(async () => {
  await fsp.rm(path.join(process.cwd(), 'storage', 'archivo', COMPANY_ID), { recursive: true, force: true });
});

describe('Archivo por trimestres', () => {
  let venta1T: string;
  let venta2T: string;
  let gasto1T: string;

  it('el árbol y el listado salen de las facturas, aunque no estén archivadas', async () => {
    venta1T = (await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2025-02-10', lineas: [linea(100)] })).id;
    venta2T = (await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2025-05-20', lineas: [linea(200)] })).id;
    // Un borrador no forma parte del archivo.
    await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2025-02-11', lineas: [linea(999)], borrador: true });
    gasto1T = (
      await expenseInvoicesService.crearGasto({ companyId: COMPANY_ID, provider: { id: supplierId }, serie: 'P', fechaEmision: '2025-03-05', lineas: [linea(50)] })
    ).id;

    const arbol = await arbolArchivo(COMPANY_ID);
    const a2025 = arbol.find((a) => a.anio === 2025)!;
    expect(a2025).toBeDefined();
    expect(a2025.trimestres).toHaveLength(4);
    expect(a2025.trimestres[0].ventas).toEqual({ n: 1, total: 121 });
    expect(a2025.trimestres[0].gastos).toEqual({ n: 1, total: 60.5 });
    expect(a2025.trimestres[1].ventas).toEqual({ n: 1, total: 242 });
    expect(a2025.trimestres[2].ventas.n).toBe(0);
    expect(a2025.ventas).toEqual({ n: 2, total: 363 });
    // Años de más reciente a más antiguo; el año en curso siempre aparece.
    expect(arbol[0].anio).toBe(new Date().getFullYear());
    expect(arbol.map((a) => a.anio)).toEqual([...arbol.map((a) => a.anio)].sort((x, y) => y - x));

    const t1 = await listarTrimestre(COMPANY_ID, 2025, 1);
    expect(t1.ventas).toHaveLength(1);
    expect(t1.ventas[0]).toMatchObject({ facturaId: venta1T, tercero: 'Cliente Archivo SL', nif: 'B12345678', base: 100, iva: 21, total: 121, descargable: true });
    expect(t1.gastos).toHaveLength(1);
    expect(t1.gastos[0]).toMatchObject({ facturaId: gasto1T, tercero: 'Proveedor Archivo SL', total: 60.5, tieneArchivo: false });
  });

  it('archivar una venta guarda el PDF en su trimestre y no duplica', async () => {
    const id1 = await archivarFacturaVenta(COMPANY_ID, venta1T);
    const id2 = await archivarFacturaVenta(COMPANY_ID, venta1T);
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);

    const docs = await prisma.documentoArchivo.findMany({ where: { companyId: COMPANY_ID, incomeInvoiceId: venta1T } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ tipo: 'ingreso', anio: 2025, trimestre: 1, mes: 2, origen: 'emitida', receptor: 'Cliente Archivo SL' });
    expect(docs[0].archivoPath).toMatch(/archivo\/.+\/2025\/1T\/ventas\/2025-02-10_/);

    const t1 = await listarTrimestre(COMPANY_ID, 2025, 1);
    expect(t1.ventas[0]).toMatchObject({ documentoId: id1, tieneArchivo: true });

    const pdf = await descargarArchivo(COMPANY_ID, id1!);
    expect(pdf.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('un gasto sin original queda registrado y se completa al adjuntarlo', async () => {
    const id = await archivarFacturaGasto(COMPANY_ID, gasto1T);
    expect(await archivarFacturaGasto(COMPANY_ID, gasto1T)).toBe(id);
    let doc = await prisma.documentoArchivo.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ tipo: 'gasto', trimestre: 1, archivoPath: '', emisor: 'Proveedor Archivo SL' });

    const original = Buffer.from('%PDF-1.4 factura del proveedor');
    expect(await archivarFacturaGasto(COMPANY_ID, gasto1T, { buffer: original, nombre: 'fra.pdf', mime: 'application/pdf' })).toBe(id);
    doc = await prisma.documentoArchivo.findUniqueOrThrow({ where: { id } });
    expect(doc.archivoPath).toMatch(/2025\/1T\/gastos\//);
    expect((await descargarArchivo(COMPANY_ID, id)).buffer.equals(original)).toBe(true);
  });

  it('regenerar completa el histórico de las facturas sin documento', async () => {
    const r = await regenerarArchivo(COMPANY_ID);
    expect(r).toMatchObject({ ventas: 1, gastos: 0, errores: 0, pendientes: 0 });
    const doc = await prisma.documentoArchivo.findFirst({ where: { companyId: COMPANY_ID, incomeInvoiceId: venta2T } });
    expect(doc).toMatchObject({ anio: 2025, trimestre: 2 });
    // Una segunda pasada no hace nada.
    expect(await regenerarArchivo(COMPANY_ID)).toMatchObject({ ventas: 0, gastos: 0, pendientes: 0 });
  });

  it('una subida manual aparece en el trimestre de su fecha', async () => {
    const doc = await crearDocumentoArchivo(COMPANY_ID, {
      tipo: 'gasto',
      fecha: '2025-01-01',
      numeroFactura: 'TK-9',
      emisor: 'Gasolinera Ñ',
      total: 30,
      archivoNombre: 'ticket.pdf',
      archivoTipo: 'application/pdf',
      archivoBuffer: Buffer.from('%PDF-1.4 ticket'),
    });
    expect(doc).toMatchObject({ anio: 2025, trimestre: 1, mes: 1 });
    expect(doc.archivoPath).toMatch(/2025\/1T\/gastos\//);

    const t1 = await listarTrimestre(COMPANY_ID, 2025, 1);
    const suelto = t1.gastos.find((g) => g.documentoId === doc.id)!;
    expect(suelto).toMatchObject({ facturaId: null, numero: 'TK-9', tercero: 'Gasolinera Ñ', total: 30, tieneArchivo: true });
    expect((await arbolArchivo(COMPANY_ID)).find((a) => a.anio === 2025)!.trimestres[0].gastos).toEqual({ n: 2, total: 90.5 });
  });

  it('el ZIP del trimestre lleva ventas, gastos y resumen.csv', async () => {
    const { nombre, contenido } = await zipTrimestre(COMPANY_ID, 2025, 1);
    expect(nombre).toBe('facturas_2025_1T.zip');
    const nombres = nombresZip(contenido);
    expect(nombres.filter((n) => n.startsWith('ventas/'))).toHaveLength(1);
    expect(nombres.filter((n) => n.startsWith('gastos/'))).toHaveLength(2);
    expect(nombres).toContain('resumen.csv');
    expect(leerEntrada(contenido, nombres.find((n) => n.startsWith('ventas/'))!).subarray(0, 4).toString('latin1')).toBe('%PDF');

    const csv = leerEntrada(contenido, 'resumen.csv').toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Venta;2025-02-10;');
    expect(csv).toContain(';100,00;21,00;121,00;');
    expect(csv).toContain('Gasolinera Ñ');
  });

  it('valida año y trimestre', async () => {
    await expect(listarTrimestre(COMPANY_ID, 2025, 5)).rejects.toThrow(/trimestre/);
  });
});
