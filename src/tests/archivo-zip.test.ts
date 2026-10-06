/**
 * ZIP propio (sin dependencias) y piezas del archivo por trimestres que no
 * necesitan base de datos: rutas, nombres y resumen.csv.
 */
import { describe, it, expect } from '@jest/globals';
import { inflateRawSync } from 'zlib';
import { crearZip, crc32 } from '../utils/zip';
import {
  periodoDeFecha,
  rangoTrimestre,
  nombreArchivoFactura,
  rutaArchivoFactura,
  resumenCsv,
  extensionDe,
} from '../services/archivoFacturas.service';

interface EntradaLeida {
  nombre: string;
  metodo: number;
  flags: number;
  datos: Buffer;
}

/** Lee un ZIP como lo haría un descompresor: EOCD -> directorio central -> cabeceras locales. */
function leerZip(zip: Buffer): EntradaLeida[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const total = zip.readUInt16LE(eocd + 10);
  const tamCentral = zip.readUInt32LE(eocd + 12);
  let p = zip.readUInt32LE(eocd + 16);
  expect(p + tamCentral).toBe(eocd);

  const salida: EntradaLeida[] = [];
  for (let i = 0; i < total; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const metodo = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const tamComp = zip.readUInt32LE(p + 20);
    const tam = zip.readUInt32LE(p + 24);
    const lNombre = zip.readUInt16LE(p + 28);
    const lExtra = zip.readUInt16LE(p + 30);
    const lComent = zip.readUInt16LE(p + 32);
    const offLocal = zip.readUInt32LE(p + 42);
    const nombre = zip.subarray(p + 46, p + 46 + lNombre).toString('utf8');

    // Cabecera local coherente con la central.
    expect(zip.readUInt32LE(offLocal)).toBe(0x04034b50);
    expect(zip.readUInt16LE(offLocal + 8)).toBe(metodo);
    const inicio = offLocal + 30 + zip.readUInt16LE(offLocal + 26) + zip.readUInt16LE(offLocal + 28);
    const comprimido = zip.subarray(inicio, inicio + tamComp);
    const datos = metodo === 8 ? inflateRawSync(comprimido) : Buffer.from(comprimido);
    expect(datos.length).toBe(tam);
    expect(crc32(datos)).toBe(crc);

    salida.push({ nombre, metodo, flags, datos });
    p += 46 + lNombre + lExtra + lComent;
  }
  return salida;
}

describe('crearZip', () => {
  const texto = Buffer.from('Factura de prueba '.repeat(200), 'utf8');
  const binario = Buffer.from([0, 1, 2, 3, 250, 251, 252]);

  it('sin compresión (store) se lee entero y con su CRC', () => {
    const entradas = leerZip(crearZip([{ name: 'a.txt', data: texto }, { name: 'b.bin', data: binario }]));
    expect(entradas.map((e) => e.nombre)).toEqual(['a.txt', 'b.bin']);
    expect(entradas.every((e) => e.metodo === 0)).toBe(true);
    expect(entradas[0].datos.equals(texto)).toBe(true);
    expect(entradas[1].datos.equals(binario)).toBe(true);
  });

  it('con deflate comprime lo comprimible y se descomprime con zlib', () => {
    const zip = crearZip(
      [
        { name: 'ventas/2026-01-15_A-1_Cliente.pdf', data: texto },
        { name: 'gastos/pequeño.bin', data: binario },
        { name: 'vacío.txt', data: Buffer.alloc(0) },
      ],
      { comprimir: true, fecha: new Date(2026, 0, 15, 10, 30, 0) },
    );
    expect(zip.length).toBeLessThan(texto.length);
    const entradas = leerZip(zip);
    expect(entradas[0].metodo).toBe(8);
    expect(entradas[0].datos.equals(texto)).toBe(true);
    // Lo que no gana con deflate se guarda tal cual.
    expect(entradas[1].metodo).toBe(0);
    expect(entradas[1].datos.equals(binario)).toBe(true);
    expect(entradas[2].datos.length).toBe(0);
  });

  it('marca los nombres como UTF-8 (bit 11) y los conserva con tildes', () => {
    const entradas = leerZip(crearZip([{ name: 'gastos/Ñandú_factura.pdf', data: binario }], { comprimir: true }));
    expect(entradas[0].flags & 0x0800).toBe(0x0800);
    expect(entradas[0].nombre).toBe('gastos/Ñandú_factura.pdf');
  });

  it('sin fecha el resultado es idéntico byte a byte', () => {
    const a = crearZip([{ name: 'x.txt', data: texto }], { comprimir: true });
    const b = crearZip([{ name: 'x.txt', data: texto }], { comprimir: true });
    expect(a.equals(b)).toBe(true);
  });

  it('CRC-32 coincide con el valor de referencia', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('archivo por trimestres: rutas y nombres', () => {
  it('saca año, mes y trimestre del texto de la fecha, sin husos horarios', () => {
    expect(periodoDeFecha('2026-01-01')).toEqual({ anio: 2026, mes: 1, trimestre: 1 });
    expect(periodoDeFecha('2025-12-31')).toEqual({ anio: 2025, mes: 12, trimestre: 4 });
    expect(periodoDeFecha('2026-04-01')).toEqual({ anio: 2026, mes: 4, trimestre: 2 });
    expect(() => periodoDeFecha('15/01/2026')).toThrow(/Fecha inválida/);
  });

  it('el rango del trimestre cubre sus tres meses', () => {
    expect(rangoTrimestre(2026, 1)).toEqual({ desde: '2026-01-01', hasta: '2026-03-31' });
    expect(rangoTrimestre(2026, 4)).toEqual({ desde: '2026-10-01', hasta: '2026-12-31' });
  });

  it('coloca cada factura en archivo/<empresa>/<año>/<T>T/<ventas|gastos>/', () => {
    const nombre = nombreArchivoFactura('2026-02-10', 'A-12', 'Cerámicas Núñez, S.L.', 'pdf');
    expect(nombre).toBe('2026-02-10_A-12_Ceramicas-Nunez_-S.L..pdf');
    expect(rutaArchivoFactura('emp1', periodoDeFecha('2026-02-10'), 'ventas', nombre)).toBe(
      'archivo/emp1/2026/1T/ventas/2026-02-10_A-12_Ceramicas-Nunez_-S.L..pdf',
    );
  });

  it('un número con barras no parte el nombre', () => {
    expect(nombreArchivoFactura('2026-07-01', 'F/2026/001', 'Cliente', 'pdf')).toBe('2026-07-01_F-2026-001_Cliente.pdf');
  });

  it('un nombre malicioso no sale de la carpeta', () => {
    const nombre = nombreArchivoFactura('2026-05-01', '../../etc/passwd', '..\\..\\x', 'pdf');
    expect(nombre).not.toContain('/');
    expect(nombre).not.toContain('\\');
  });

  it('elige la extensión por el nombre o por el tipo', () => {
    expect(extensionDe('ticket.JPG', 'image/jpeg')).toBe('jpg');
    expect(extensionDe(undefined, 'application/pdf')).toBe('pdf');
    expect(extensionDe('sin-extension', 'image/png')).toBe('png');
  });
});

describe('resumen.csv', () => {
  it('usa ";", coma decimal, BOM UTF-8 y comillas cuando hacen falta', () => {
    const csv = resumenCsv([
      {
        tipo: 'Venta',
        facturaId: 'f1',
        numero: 'A-1',
        fecha: '2026-01-15',
        tercero: 'Cliente; con punto y coma',
        nif: 'B12345678',
        base: 1000,
        iva: 210,
        total: 1210,
        documentoId: null,
        archivoNombre: null,
        tieneArchivo: false,
        descargable: true,
        origen: 'emitida',
        archivo: 'ventas/a.pdf',
      },
      {
        tipo: 'Gasto',
        facturaId: 'g1',
        numero: 'F-7',
        fecha: '2026-02-01',
        tercero: 'Proveedor "Bueno"',
        nif: null,
        base: 10.5,
        iva: 2.21,
        total: 12.71,
        documentoId: null,
        archivoNombre: null,
        tieneArchivo: false,
        descargable: false,
        origen: 'registrada',
        archivo: 'sin original',
      },
    ]);
    expect(csv.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const lineas = csv.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    expect(lineas[0]).toBe('Tipo;Fecha;Número;Tercero;NIF;Base;IVA;Total;Archivo');
    expect(lineas[1]).toBe('Venta;2026-01-15;A-1;"Cliente; con punto y coma";B12345678;1000,00;210,00;1210,00;ventas/a.pdf');
    expect(lineas[2]).toBe('Gasto;2026-02-01;F-7;"Proveedor ""Bueno""";;10,50;2,21;12,71;sin original');
  });
});
