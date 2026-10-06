/**
 * Subida por trozos de Puesta en marcha con el almacenamiento LOCAL (sin
 * BLOB_READ_WRITE_TOKEN, como en CI): trozos guardados por empresa,
 * reensamblado identico al original, comprobaciones y borrado.
 */
import { describe, it, expect } from '@jest/globals';
import { createHash, randomBytes } from 'crypto';
import { borrarSubida, reensamblarSubida, recibirTrozo, TAM_MAX_SUBIDA } from '../services/puestaEnMarcha/subidasTrozos';
import { leerBalance } from '../services/puestaEnMarcha/lectorContable';
import { listObjects } from '../utils/storage';

const EMPRESA = `subidas-test-${Date.now()}`;
const TROZO = 1024 * 1024; // 1 MB para el test (en la web son ~3 MB)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function subir(empresa: string, fichero: Buffer, nombre: string, conHash = true): Promise<string> {
  const total = Math.ceil(fichero.length / TROZO);
  let subidaId: string | undefined;
  for (let i = 0; i < total; i++) {
    const trozo = fichero.subarray(i * TROZO, (i + 1) * TROZO);
    const r = await recibirTrozo(
      empresa,
      { subidaId, indice: i, total, nombre: i === 0 ? nombre : undefined, tamano: i === 0 ? fichero.length : undefined, hash: conHash ? sha(trozo) : undefined },
      trozo,
    );
    subidaId = r.subidaId;
    expect(r.completa).toBe(i === total - 1);
  }
  return subidaId!;
}

describe('subida por trozos', () => {
  it('reensambla un fichero de varios trozos identico al original', async () => {
    const fichero = randomBytes(TROZO * 3 + 12345);
    const id = await subir(EMPRESA, fichero, 'diario.xlsx');
    const r = await reensamblarSubida(EMPRESA, id);
    expect(r.originalname).toBe('diario.xlsx');
    expect(r.buffer.equals(fichero)).toBe(true);
  });

  it('el fichero reensamblado se lee igual que uno subido directo', async () => {
    const csv = Buffer.from(['Cuenta;Nombre;Saldo', ...Array.from({ length: 45000 }, (_, i) => `${5720000 + i};Cuenta ${i};${i % 2 ? '' : '-'}10,50`)].join('\n'), 'utf-8');
    expect(csv.length).toBeGreaterThan(TROZO);
    const id = await subir(EMPRESA, csv, 'balance.csv', false);
    const { buffer, originalname } = await reensamblarSubida(EMPRESA, id);
    const directo = leerBalance(csv, 'balance.csv', {});
    const porTrozos = leerBalance(buffer, originalname, {});
    expect(porTrozos.cuentas).toEqual(directo.cuentas);
    expect(porTrozos.cuentas.length).toBeGreaterThan(1000);
  });

  it('una subida solo se puede usar desde su empresa', async () => {
    const id = await subir(EMPRESA, randomBytes(2000), 'a.csv');
    await expect(reensamblarSubida('otra-empresa', id)).rejects.toThrow(/no existe o ha caducado/);
  });

  it('rechaza trozos dañados, ficheros de mas de 50 MB y extensiones no admitidas', async () => {
    const t = randomBytes(100);
    await expect(recibirTrozo(EMPRESA, { indice: 0, total: 1, nombre: 'x.csv', tamano: 100, hash: 'abc' }, t)).rejects.toThrow(/dañado/);
    await expect(recibirTrozo(EMPRESA, { indice: 0, total: 20, nombre: 'x.csv', tamano: TAM_MAX_SUBIDA + 1 }, t)).rejects.toThrow(/pesa demasiado/);
    await expect(recibirTrozo(EMPRESA, { indice: 0, total: 1, nombre: 'x.exe', tamano: 100 }, t)).rejects.toThrow(/Excel/);
    await expect(recibirTrozo(EMPRESA, { indice: 1, total: 2, subidaId: '../../etc' }, t)).rejects.toThrow(/no es válido/);
  });

  it('una subida incompleta no se reensambla', async () => {
    const r = await recibirTrozo(EMPRESA, { indice: 0, total: 3, nombre: 'inc.xlsx', tamano: 300 }, randomBytes(100));
    await recibirTrozo(EMPRESA, { subidaId: r.subidaId, indice: 2, total: 3 }, randomBytes(100));
    await expect(reensamblarSubida(EMPRESA, r.subidaId)).rejects.toThrow(/Falta el trozo 2 de 3/);
  });

  it('borrarSubida elimina sus trozos', async () => {
    const id = await subir(EMPRESA, randomBytes(TROZO + 10), 'b.xlsx');
    expect((await listObjects(`puesta-en-marcha/subidas/${EMPRESA}/${id}/`)).length).toBe(3);
    await borrarSubida(EMPRESA, id);
    expect(await listObjects(`puesta-en-marcha/subidas/${EMPRESA}/${id}/`)).toEqual([]);
    await expect(reensamblarSubida(EMPRESA, id)).rejects.toThrow(/no existe/);
  });
});
