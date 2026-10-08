/**
 * Ayuda de los tests de Compras: las cuatro fuentes del IVA soportado de un
 * trimestre, que tienen que coincidir siempre.
 *  - libroCuota / libroBase: libro de IVA RECIBIDAS (solo asientos POSTED).
 *  - saldo472: debe - haber de la 472 en los asientos POSTED con fecha en el trimestre.
 *  - m303Cuota / m303Base: 303 del modulo Impuestos (calcularModelo303).
 *  - fiscal303Cuota: 303 de Fiscalidad (taxModels.generarModelo303), que lee el libro.
 */
import { prisma } from '../config/database';
import { taxDocumentsService } from '../services/tax-documents.service';
import { taxModelsService } from '../services/tax-models.service';
import { calcularModelo303 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { aCentimos } from '../utils/money';

const euros = (c: number) => Math.round(c) / 100;

export async function cuadreRecibidas(companyId: string, ejercicio: number, trimestre: number) {
  const libro = await taxDocumentsService.obtenerLibroIVARecibidas(companyId, `Q${trimestre}-${ejercicio}`);
  const lineas = await prisma.journalEntryLine.findMany({
    where: {
      companyId,
      accountCode: { startsWith: '472' },
      entry: {
        estado: 'POSTED',
        fecha: { gte: new Date(Date.UTC(ejercicio, (trimestre - 1) * 3, 1)), lt: new Date(Date.UTC(ejercicio, trimestre * 3, 1)) },
      },
    },
    select: { debe: true, haber: true },
  });
  const m303 = await calcularModelo303(companyId, periodoFiscal(ejercicio, `${trimestre}T`));
  const fiscal = await taxModelsService.generarModelo303(companyId, ejercicio, trimestre);
  return {
    libroCuota: euros(aCentimos(libro.totalCuotas)),
    libroBase: euros(aCentimos(libro.totalBases)),
    saldo472: euros(lineas.reduce((a, l) => a + aCentimos(Number(l.debe)) - aCentimos(Number(l.haber)), 0)),
    m303Cuota: euros(aCentimos(m303.totalCuotaDeducible)),
    m303Base: euros(aCentimos(m303.totalBaseDeducible)),
    fiscal303Cuota: euros(aCentimos(fiscal.ivaSoportado.total)),
  };
}

/** Comprueba que las cuatro fuentes dan `cuota` (y el libro y el 303, `base`). */
export async function esperarCuadre(
  expect: (v: unknown) => { toEqual: (x: unknown) => void },
  companyId: string,
  ejercicio: number,
  trimestre: number,
  cuota: number,
  base?: number,
) {
  const c = await cuadreRecibidas(companyId, ejercicio, trimestre);
  expect({ libro: c.libroCuota, saldo472: c.saldo472, m303: c.m303Cuota, fiscal303: c.fiscal303Cuota }).toEqual({
    libro: cuota,
    saldo472: cuota,
    m303: cuota,
    fiscal303: cuota,
  });
  if (base !== undefined) expect({ libro: c.libroBase, m303: c.m303Base }).toEqual({ libro: base, m303: base });
  return c;
}
