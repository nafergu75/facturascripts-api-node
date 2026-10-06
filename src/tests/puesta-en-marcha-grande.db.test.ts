/**
 * Diario grande subido por trozos y reensamblado, sobre BD real: mide cuanto
 * tarda leerlo e importarlo (los tiempos salen en el log de CI) para conocer el
 * limite practico de una sola ejecucion serverless.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { leerDiario } from '../services/puestaEnMarcha/lectorContable';
import { confirmarDiario } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { borrarSubida, reensamblarSubida, recibirTrozo } from '../services/puestaEnMarcha/subidasTrozos';

const COMPANY_ID = `diario-grande-${Date.now()}`;
const ASIENTOS = 30_000; // 60.000 apuntes, ~3,4 MB de CSV
const TROZO = 3 * 1024 * 1024;

function diarioCsv(): Buffer {
  const filas = ['Fecha;Asiento;Cuenta;Concepto;Debe;Haber'];
  for (let i = 0; i < ASIENTOS; i++) {
    const fecha = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    const importe = `${100 + (i % 900)},${String(i % 100).padStart(2, '0')}`;
    filas.push(`${fecha};${i + 1};4300000${String(1 + (i % 50)).padStart(3, '0')};Venta ${i + 1};${importe};`);
    filas.push(`${fecha};${i + 1};7000000000;Venta ${i + 1};;${importe}`);
  }
  return Buffer.from(filas.join('\n'), 'utf-8');
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Diario Grande SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
});

describe('diario grande por trozos', () => {
  it(
    `importa ${ASIENTOS} asientos (${ASIENTOS * 2} apuntes) dentro del tiempo de una funcion`,
    async () => {
      const fichero = diarioCsv();
      const total = Math.ceil(fichero.length / TROZO);
      let subidaId: string | undefined;
      let t = Date.now();
      for (let i = 0; i < total; i++) {
        const r = await recibirTrozo(
          COMPANY_ID,
          { subidaId, indice: i, total, nombre: i === 0 ? 'diario.csv' : undefined, tamano: i === 0 ? fichero.length : undefined },
          fichero.subarray(i * TROZO, (i + 1) * TROZO),
        );
        subidaId = r.subidaId;
      }
      const { buffer, originalname } = await reensamblarSubida(COMPANY_ID, subidaId);
      expect(buffer.equals(fichero)).toBe(true);
      const tSubida = Date.now() - t;

      t = Date.now();
      const lectura = leerDiario(buffer, originalname);
      const tLectura = Date.now() - t;

      t = Date.now();
      const r = await confirmarDiario(COMPANY_ID, lectura, { ejercicio: 2026 });
      const tImport = Date.now() - t;
      await borrarSubida(COMPANY_ID, subidaId);

      // eslint-disable-next-line no-console
      console.log(
        `[medida] diario ${(fichero.length / 1048576).toFixed(1)} MB, ${ASIENTOS * 2} apuntes: trozos+reensamblado ${tSubida} ms, lectura ${tLectura} ms, validacion+grabacion ${tImport} ms`,
      );
      expect(r.asientosCreados).toBe(ASIENTOS);
      expect(await prisma.journalEntryLine.count({ where: { companyId: COMPANY_ID } })).toBe(ASIENTOS * 2);
    },
    300_000,
  );
});
