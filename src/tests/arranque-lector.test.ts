/**
 * Lector de libros completos de «Traer la contabilidad de 2026»: todas las
 * hojas de un Excel, tablas dBase de ContaPlus en pagina 850, CSV en
 * Windows-1252 con separador por votacion, ancho fijo, PDF, cabeceras repetidas
 * y codigos con punto de relleno. Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import {
  decodificarTexto,
  detectarSeparador,
  esAnchoFijo,
  expandirCodigoConPunto,
  leerLibro,
  quitarCabecerasRepetidas,
} from '../services/arranque/lectorLibros';
import { parsearFecha, texto } from '../services/puestaEnMarcha/lectorContable';
import {
  anchoFijo,
  contaplusDiario,
  contaplusSubcuentas,
  csv,
  ficherosEmpresaA,
  holdedSumasSaldos,
  libroCompleto,
  pdf,
  planWindows1252,
} from './fixtures/arranque/generar';

describe('lector de libros', () => {
  it('lee todas las hojas de un Excel y salta las vacías', () => {
    const f = libroCompleto();
    const l = leerLibro(f.contenido, f.nombre);
    expect(l.error).toBeNull();
    expect(l.formato).toBe('xlsx');
    expect(l.hojas.map((h) => h.hoja)).toEqual(['Plan', 'Sumas y saldos', 'Diario']);
  });

  it('lee las tablas dBase de ContaPlus en la página 850 (ñ y tildes bien) y sus fechas', () => {
    const sub = contaplusSubcuentas();
    const l = leerLibro(sub.contenido, sub.nombre);
    expect(l.error).toBeNull();
    expect(l.formato).toBe('dbf');
    expect(l.codificacion).toBe('cp850');
    const filas = l.hojas[0].filas;
    expect(filas[0]).toEqual(['COD', 'TITULO', 'NIF', 'DOMICILIO', 'POBLACION', 'PROVINCIA', 'CODPOSTAL']);
    expect(filas.some((f) => f[1] === 'Eléctrica Luz SL')).toBe(true);

    const dia = contaplusDiario();
    const d = leerLibro(dia.contenido, dia.nombre);
    const primera = d.hojas[0].filas[1];
    // La fecha de la tabla sale como el dia que es, no el anterior por la hora de Espana.
    expect(parsearFecha(primera[1])).toBe('2026-01-01');
    expect(texto(primera[1])).toBe('2026-01-01');
  });

  it('CSV en Windows-1252: se reconoce, se avisa y las tildes salen bien', () => {
    const f = planWindows1252();
    const l = leerLibro(f.contenido, f.nombre);
    expect(l.error).toBeNull();
    expect(l.codificacion).toBe('windows-1252');
    expect(l.avisos.join(' ')).toMatch(/Windows-1252/);
    const filas = l.hojas[0].filas;
    expect(filas[0][0]).toBe('Plan de cuentas de la Peña Ñandú, S.L.');
    expect(filas[1]).toEqual(['Subcuenta', 'Descripción', 'NIF']);
  });

  it('CSV de proveedores en Windows-1252 con un título sin separadores: el «;» gana la votación', () => {
    const f = ficherosEmpresaA().proveedores;
    const l = leerLibro(f.contenido, f.nombre);
    expect(l.hojas[0].filas[1]).toEqual(['NIF', 'Nombre', 'Subcuenta', 'Domicilio', 'CP', 'Población', 'Provincia']);
    expect(l.hojas[0].filas.some((r) => r[3] === 'Calle Ñandú 9')).toBe(true);
  });

  it('CSV de Holded en UTF-8 con BOM y coma de separador', () => {
    const f = holdedSumasSaldos();
    const l = leerLibro(f.contenido, f.nombre);
    expect(l.codificacion).toBe('utf-8');
    expect(l.hojas[0].filas[1]).toEqual(['Cuenta', 'Nombre', 'Saldo inicial', 'Debe', 'Haber', 'Saldo final']);
  });

  it('separador por votación: un título largo con comas no engaña', () => {
    const lineas = ['Listado de saldos, empresa A, ejercicio 2026', 'Cuenta;Nombre;Saldo', '4300000001;Cliente, S.L.;12,50', '5720000001;Banco;3,00'];
    expect(detectarSeparador(lineas)).toBe(';');
    expect(detectarSeparador(['a\tb\tc', '1\t2\t3'])).toBe('\t');
    expect(detectarSeparador(['solo una columna', 'otra'])).toBeNull();
  });

  it('decodificación: UTF-8 válido, Windows-1252 y UTF-16 de Excel', () => {
    expect(decodificarTexto(Buffer.from('Peña', 'utf8'))).toEqual({ texto: 'Peña', codificacion: 'utf-8' });
    expect(decodificarTexto(Buffer.from([0x50, 0x65, 0xf1, 0x61]))).toEqual({ texto: 'Peña', codificacion: 'windows-1252' });
    expect(decodificarTexto(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Año', 'utf16le')]))).toEqual({ texto: 'Año', codificacion: 'utf-16' });
  });

  it('ancho fijo y PDF: no se leen y se dice qué pedir a la gestoría', () => {
    const a = anchoFijo();
    expect(esAnchoFijo(a.contenido.toString('latin1').split(/\r?\n/))).toBe(true);
    const la = leerLibro(a.contenido, a.nombre);
    expect(la.error).toMatchObject({ motivo: 'ANCHO_FIJO' });
    expect(la.error!.mensaje).toMatch(/Excel o CSV/);
    const p = pdf();
    expect(leerLibro(p.contenido, p.nombre).error).toMatchObject({ motivo: 'PDF', mensaje: expect.stringMatching(/PDF no se pueden leer/) });
    expect(leerLibro(Buffer.alloc(0), 'vacio.csv').error).toMatchObject({ motivo: 'VACIO' });
  });

  it('cabeceras repetidas en cada página: se quitan', () => {
    const filas = [['Cuenta', 'Saldo'], ['4300000001', '1'], ['Cuenta', 'Saldo'], ['5720000001', '2']];
    expect(quitarCabecerasRepetidas(filas, 0)).toEqual([['Cuenta', 'Saldo'], ['4300000001', '1'], ['5720000001', '2']]);
  });

  it('códigos con punto de relleno: «430.1» con 10 dígitos es la 4300000001', () => {
    expect(expandirCodigoConPunto('430.1', 10)).toBe('4300000001');
    expect(expandirCodigoConPunto('572.12', 8)).toBe('57200012');
    expect(expandirCodigoConPunto('4300.0001', 8)).toBe('43000001');
    expect(expandirCodigoConPunto('4300000001', 10)).toBe('4300000001');
    expect(expandirCodigoConPunto('Total', 10)).toBeNull();
  });

  it('CSV con comillas y separadores dentro', () => {
    const b = csv([['Cuenta', 'Nombre'], ['4300000001', 'Pérez; García y Cía']], ';');
    const l = leerLibro(b, 'x.csv');
    expect(l.hojas[0].filas[1]).toEqual(['4300000001', 'Pérez; García y Cía']);
  });
});
