/**
 * Arreglo prisma/arreglos/2026-10-07-asientos-y-cobros.sql sobre BD real.
 * scripts/aplicar-arreglos-datos.sh lo ejecuta en cada despliegue: no pasa a
 * firme los borradores del lector de gastos (factura y asiento en DRAFT, que se
 * aprueban en el Motor contable) y es de un solo uso (deja una marca en
 * AuditLog y las pasadas siguientes no hacen nada).
 *
 * El arreglo toca todas las empresas: se ejecuta dentro de una transaccion que
 * se deshace al final, para no cambiar los datos de otros tests de la BD.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma, type TransaccionBD } from '../config/database';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { controlCif } from '../utils/nif';

const COMPANY_ID = `arreglo-asientos-${Date.now()}`;
const MARCA = 'arreglo-asientos-y-cobros-hecho';
const FICHERO = join(__dirname, '../../prisma/arreglos/2026-10-07-asientos-y-cobros.sql');

/** Las sentencias del fichero, sin comentarios (como las manda prisma db execute). */
function sentencias(): string[] {
  const sinComentarios = readFileSync(FICHERO, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return sinComentarios
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

class Deshacer extends Error {}

const factura = (supplierId: string, numero: string) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: '2026-05-04',
  tipoGasto: 'SUMINISTROS',
  lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
});

describe('arreglo 2026-10-07-asientos-y-cobros.sql', () => {
  it('no pasa a firme los borradores del lector de gastos y, aplicado una vez, ya no cambia nada', async () => {
    await prisma.company.create({ data: { id: COMPANY_ID, name: 'Arreglo Asientos SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const siete = String(Date.now()).slice(-7);
    const sup = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor SL', nifCif: `B${siete}${controlCif(siete).cifra}` } })).id;
    // Borrador del lector: factura y asiento en DRAFT.
    const lector = await expenseInvoicesService.registrarGasto(COMPANY_ID, factura(sup, 'L-1'), { contabilizar: 'DRAFT' });
    // Asiento en borrador de una factura que no es del lector (lo que el arreglo si pasa a firme).
    const antiguo = await expenseInvoicesService.registrarGasto(COMPANY_ID, factura(sup, 'A-1'), { contabilizar: 'DRAFT' });
    await prisma.expenseInvoice.update({ where: { id: antiguo.factura.id }, data: { estado: 'PENDING' } });
    const estado = (tx: TransaccionBD, id: string) => tx.journalEntry.findUniqueOrThrow({ where: { id } }).then((a) => a.estado);

    const marcaPrevia = await prisma.auditLog.findUnique({ where: { id: MARCA } });
    await expect(
      prisma.$transaction(
        async (tx) => {
          // La marca es global: en la BD de pruebas se quita (dentro de la transaccion) para probarlo de nuevo.
          await tx.auditLog.deleteMany({ where: { id: MARCA } });
          for (const s of sentencias()) await tx.$executeRawUnsafe(s);
          expect(await estado(tx, lector.asientoId)).toBe('DRAFT');
          expect(await estado(tx, antiguo.asientoId)).toBe('POSTED');
          expect(await tx.auditLog.count({ where: { id: MARCA } })).toBe(1);

          // Segunda pasada (otro despliegue): con la marca, nada cambia.
          await tx.journalEntry.update({ where: { id: antiguo.asientoId }, data: { estado: 'DRAFT' } });
          for (const s of sentencias()) await tx.$executeRawUnsafe(s);
          expect(await estado(tx, antiguo.asientoId)).toBe('DRAFT');
          expect(await estado(tx, lector.asientoId)).toBe('DRAFT');
          expect(await tx.auditLog.count({ where: { id: MARCA } })).toBe(1);
          throw new Deshacer('deshacer el arreglo');
        },
        { timeout: 120_000, maxWait: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Deshacer);

    // Deshecho: la BD de pruebas queda como estaba.
    expect(await prisma.auditLog.findUnique({ where: { id: MARCA } })).toEqual(marcaPrevia);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: antiguo.asientoId } })).estado).toBe('DRAFT');
  });
});
