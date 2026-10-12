/**
 * Asiento de una adquisicion intracomunitaria: el 303 y el 390 autoliquidan su
 * IVA ([10]/[11] y [36]/[37]) y el asiento tiene que llevarlo tambien, con la
 * 472 al debe y la 477 al haber por la cuota autoliquidada (PGC). Asi el mayor
 * de la 472 y de la 477 cuadra con los modelos, tambien al corregir la factura
 * y al anularla (con el periodo abierto o con contraasiento).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { proveedoresService } from '../services/proveedores.service';
import { anularGasto, editarGasto, registrarGasto } from '../services/expense-invoices.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { calcularModelo303 } from '../services/impuestosCalculo.service';
import { taxDocumentsService } from '../services/tax-documents.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { aCentimos } from '../utils/money';
import { controlCif } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function empresa(nombre: string): Promise<string> {
  const id = `autoliq-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Autoliquidación ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Autoliquidación ${nombre} SL`, nif: cif() } });
  await asegurarPlanContableEmpresa(id);
  return id;
}

const compra = (supplierId: string, numero: string, fecha: string, lineas: Array<Record<string, unknown>>) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'COMPRA',
  lineas,
});

/** Debe y haber por cuenta (prefijo de 3 cifras) de un asiento. */
async function lados(asientoId: string) {
  const ls = await prisma.journalEntryLine.findMany({ where: { entryId: asientoId } });
  const c: Record<string, [number, number]> = {};
  for (const l of ls) {
    const k = l.accountCode.slice(0, 3);
    const [d, h] = c[k] ?? [0, 0];
    c[k] = [d + aCentimos(Number(l.debe)), h + aCentimos(Number(l.haber))];
  }
  return Object.fromEntries(Object.entries(c).map(([k, [d, h]]) => [k, [d / 100, h / 100]]));
}

/** Saldo (debe - haber) de las cuentas que empiezan por `prefijo` en asientos POSTED entre dos fechas. */
async function saldo(companyId: string, prefijo: string, desde: string, hasta: string): Promise<number> {
  const ls = await prisma.journalEntryLine.findMany({
    where: { companyId, accountCode: { startsWith: prefijo }, entry: { estado: 'POSTED', fecha: { gte: new Date(desde), lte: new Date(`${hasta}T23:59:59Z`) } } },
    select: { debe: true, haber: true },
  });
  return ls.reduce((a, l) => a + aCentimos(Number(l.debe)) - aCentimos(Number(l.haber)), 0) / 100;
}

describe('asiento de una adquisición intracomunitaria', () => {
  let E: string;
  let italiano: string;
  let nacional: string;

  beforeAll(async () => {
    E = await empresa('intra');
    italiano = (await proveedoresService.create(E, { nombreFiscal: 'Rossi SpA', nifCif: 'IT12345678901', pais: 'IT' })).id;
    nacional = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
  });

  it('lleva la 472 al debe y la 477 al haber por la cuota autoliquidada, y el mayor cuadra con el 303', async () => {
    const r = await registrarGasto(
      E,
      compra(italiano, 'IT-001', '2027-02-10', [
        { descripcion: 'Género', cantidad: 1, precioUnitario: 1000, tipoIva: 0 },
        { descripcion: 'Portes', cantidad: 1, precioUnitario: 100.05, tipoIva: 0 },
      ]),
      { contabilizar: 'POSTED' },
    );
    // 1000 al 21 % = 210,00; 100,05 al 21 % = 21,01 (por linea, como el 303).
    expect(await lados(r.asientoId)).toEqual({
      '600': [1100.05, 0],
      '472': [231.01, 0],
      '477': [0, 231.01],
      '400': [0, 1100.05],
    });
    const m = await calcularModelo303(E, periodoFiscal(2027, '1T'));
    expect(m.casillasOficiales?.['11']).toBe(231.01);
    expect(m.casillasOficiales?.['37']).toBe(231.01);
    expect(await saldo(E, '472', '2027-01-01', '2027-03-31')).toBe(231.01);
    expect(await saldo(E, '477', '2027-01-01', '2027-03-31')).toBe(-231.01);
    // El libro de recibidas lleva la fila al 0 % y da aparte el IVA autoliquidado (el que falta para cuadrar con la 472).
    const libro = await taxDocumentsService.obtenerLibroIVARecibidas(E, 'Q1-2027');
    expect(libro).toMatchObject({ totalCuotas: 0, autoliquidado: 231.01 });
    expect(libro.nota).toBe('Las cuotas no incluyen 231,01 € de IVA autoliquidado de adquisiciones intracomunitarias: está en la 472 (y en la 477) y en el 303.');
  });

  it('una compra nacional no lleva autoliquidación', async () => {
    const r = await registrarGasto(E, compra(nacional, 'N-001', '2027-02-11', [{ descripcion: 'Género', cantidad: 1, precioUnitario: 100, tipoIva: 21 }]), {
      contabilizar: 'POSTED',
    });
    expect(await lados(r.asientoId)).toEqual({ '600': [100, 0], '472': [21, 0], '400': [0, 121] });
  });

  it('al corregirla, el asiento nuevo vuelve a llevar la autoliquidación', async () => {
    const r = await registrarGasto(E, compra(italiano, 'IT-002', '2027-04-10', [{ descripcion: 'Género', cantidad: 1, precioUnitario: 500, tipoIva: 0 }]), {
      contabilizar: 'POSTED',
    });
    await editarGasto(E, r.factura.id, compra(italiano, 'IT-002', '2027-04-10', [{ descripcion: 'Género', cantidad: 1, precioUnitario: 800, tipoIva: 0 }]));
    const vigente = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, invoiceId: r.factura.id, estado: 'POSTED' } });
    expect(await lados(vigente.id)).toEqual({ '600': [800, 0], '472': [168, 0], '477': [0, 168], '400': [0, 800] });
    const m = await calcularModelo303(E, periodoFiscal(2027, '2T'));
    expect(m.casillasOficiales?.['11']).toBe(168);
    expect(await saldo(E, '477', '2027-04-01', '2027-06-30')).toBe(-168);
  });

  it('al anularla con el 303 presentado, el contraasiento devuelve también la 477', async () => {
    const r = await registrarGasto(E, compra(italiano, 'IT-003', '2027-07-05', [{ descripcion: 'Género', cantidad: 1, precioUnitario: 300, tipoIva: 0 }]), {
      contabilizar: 'POSTED',
    });
    await prisma.modeloImpuesto.create({
      data: { companyId: E, codigo: '303', ejercicio: 2027, periodo: '3T', estado: 'presentado' },
    });
    const a = await anularGasto(E, r.factura.id, { motivo: 'Mercancía no recibida', fecha: '2027-10-05' });
    expect(a.contraasiento).toBe(true);
    expect(await lados(a.asientoAnulacionId!)).toEqual({ '600': [0, 300], '472': [0, 63], '477': [63, 0], '400': [300, 0] });
    const m = await calcularModelo303(E, periodoFiscal(2027, '4T'));
    // La anulacion resta el autodevengo en [14]/[15] y el deducible en [40]/[41].
    expect(m.casillasOficiales?.['15']).toBe(-63);
    expect(m.casillasOficiales?.['41']).toBe(-63);
    expect(await saldo(E, '477', '2027-10-01', '2027-12-31')).toBe(63);
    expect(await saldo(E, '472', '2027-10-01', '2027-12-31')).toBe(-63);
  });
});
