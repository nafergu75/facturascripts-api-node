/**
 * Exportacion del mayor de un cliente con datos reales (BD): ventas de miles
 * contabilizadas con el motor, un cobro entero y otro en parte, una
 * rectificativa que anula una venta, un anticipo apuntado a mano y una venta
 * emitida sin asiento. En PDF y en Excel, cada cifra en su columna (Debe,
 * Haber, Saldo), el saldo de cada fila = anterior + Debe − Haber y el final
 * igual a la suma. Lo mismo en el Libro mayor (de un cliente y de varias
 * cuentas), el listado de clientes y el resto de informes que usan el mismo
 * exportador (sumas y saldos, balance, PyG y diario).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '../config/database';
import { clientesService } from '../services/clientes.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import {
  informeBalance,
  informeDetalleTercero,
  informeDiario,
  informeMayor,
  informeMayorTerceros,
  informePerdidasGanancias,
  informeSumasYSaldos,
  terceroParaMayor,
} from '../services/informesContables.service';
import { tablaAPdf, tablaAXlsx, type TablaInforme } from '../services/informesContables.documentos';
import { informesContablesRoutes } from '../routes/informesContables.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { aCentimos } from '../utils/money';
import { controlCif } from '../utils/nif';
import { relojEn, relojReal } from './reloj-falso';
import { textosDePdf } from './texto-pdf';
import { fallosColumnasPdf, fallosColumnasXlsx } from './columnas-informe';

const SUFIJO = Date.now();
const E = `inf-export-${SUFIJO}`;
const P = { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 };
const motor = new AccountingEngineController();
let n = 0;
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}
const linea = (descripcion: string, precio: number) => ({ descripcion, cantidad: 1, precioUnitario: precio, tipoIva: 21 });

/** Emite una venta en su fecha y, si se pide, la contabiliza con el motor. */
async function venta(customerId: string, fecha: string, lineas: Array<Record<string, unknown>>, contabilizar = true): Promise<string> {
  const b = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: customerId }, fechaEmision: fecha, lineas, borrador: true } as never);
  const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: fecha });
  if (contabilizar) await motor.contabilizarFacturaIngreso(E, f.id);
  return f.id;
}

let cliente: string;
let subcuenta: string;
let sinAsiento: string;
/** Cliente de mostrador: seis ventas cobradas en caja el mismo dia (de la A-5 a la A-10). */
let mostrador: string;

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Exportes Informes SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Exportes Informes, S.L.', nif: cif() } });
  await asegurarPlanContableEmpresa(E);
  // Las ventas son de 2026: se emiten con el reloj en octubre de 2026.
  relojEn('2026-10-20T10:00:00Z');
  try {
    const c = (await clientesService.create(E, { nombreFiscal: 'Distribuciones Cerámicas del Mediterráneo y Baleares SL', nifCif: cif(), cp: '46001' })) as unknown as {
      id: string;
      subcuenta430: string;
    };
    cliente = c.id;
    subcuenta = c.subcuenta430;
    const v1 = await venta(cliente, '2026-01-15', [linea('Pavimento porcelánico 60x60, palets 1 a 12', 7152.63)]); // 8.654,68
    const v2 = await venta(cliente, '2026-02-20', [linea('Revestimiento gran formato, obra del hotel', 303547.49)]); // 367.292,46
    const v3 = await venta(cliente, '2026-03-10', [linea('Muestras y expositores', 1250), linea('Portes', 180.5)]); // 1.730,91
    await registrarCobroFactura(E, 'INGRESO', v1, { fecha: '2026-02-01', caja: true });
    await registrarCobroFactura(E, 'INGRESO', v2, { fecha: '2026-04-05', importe: 150000, caja: true });
    const r = await incomeInvoicesService.crearRectificativa(E, v3, { motivo: 'Devolución de las muestras', borrador: true });
    await incomeInvoicesService.finalizar(E, r.id, { fechaEmision: '2026-04-20' });
    await motor.contabilizarFacturaIngreso(E, r.id);
    // Emitida sin asiento (como una venta del lector cuyo asiento no llego a crearse).
    sinAsiento = await venta(cliente, '2026-05-02', [linea('Pedido sin contabilizar', 2000)], false);
    // Ventas al contado: cada una cobrada en caja el mismo dia que se emite.
    mostrador = ((await clientesService.create(E, { nombreFiscal: 'Bar Pepe', nifCif: cif(), cp: '46002' })) as unknown as { id: string }).id;
    for (let i = 0; i < 6; i++) {
      const fecha = `2026-05-${String(10 + i).padStart(2, '0')}`;
      const v = await venta(mostrador, fecha, [linea('Azulejo de reposición', 100)]); // 121,00
      await registrarCobroFactura(E, 'INGRESO', v, { fecha, caja: true });
    }
  } finally {
    relojReal();
  }
  // Anticipo apuntado a mano en la subcuenta del cliente.
  await prisma.journalEntry.create({
    data: {
      companyId: E,
      fecha: new Date('2026-06-30T00:00:00.000Z'),
      numeroAsiento: `AJ-${SUFIJO}`,
      descripcion: 'Anticipo recibido por transferencia del pedido de julio para la obra de Benidorm (pendiente de factura)',
      origen: 'AJUSTE_MANUAL',
      estado: 'POSTED',
      lineas: {
        create: [
          { accountCode: '572', accountName: 'Bancos', debe: 12500, haber: 0, companyId: E },
          { accountCode: subcuenta, accountName: 'Cliente', debe: 0, haber: 12500, companyId: E },
        ],
      },
    },
  });
});

/** PDF y Excel de una tabla sin ninguna cifra fuera de su columna. */
async function exportaBien(t: TablaInforme) {
  const pdf = await tablaAPdf(t);
  const textos = await textosDePdf(pdf);
  expect(fallosColumnasPdf(t, textos)).toEqual([]);
  expect(fallosColumnasXlsx(t, tablaAXlsx(t))).toEqual([]);
  return { pdf, textos: textos.map((x) => x.texto) };
}

/** Saldo de cada fila = anterior + Debe − Haber (en centimos), desde «Saldo inicial» hasta «Totales y saldo final». */
function compruebaSaldos(filas: TablaInforme['filas'], ini: number, iDebe: number, iHaber: number, iSaldo: number) {
  expect(filas[ini].celdas[2]).toBe('Saldo inicial');
  expect([filas[ini].celdas[iDebe], filas[ini].celdas[iHaber]]).toEqual([null, null]);
  let saldo = aCentimos(Number(filas[ini].celdas[iSaldo]));
  let debe = 0;
  let haber = 0;
  let i = ini + 1;
  for (; (filas[i].estilo ?? 'normal') === 'normal'; i++) {
    const [d, h, s] = [iDebe, iHaber, iSaldo].map((k) => aCentimos(Number(filas[i].celdas[k])));
    saldo += d - h;
    debe += d;
    haber += h;
    expect(s).toBe(saldo);
  }
  const total = filas[i];
  expect(String(total.celdas[2])).toMatch(/^Totales y saldo final/);
  expect([total.celdas[iDebe], total.celdas[iHaber], total.celdas[iSaldo]].map((v) => aCentimos(Number(v)))).toEqual([debe, haber, saldo]);
  return i;
}

describe('mayor de un cliente con ventas, abono y cobros, en PDF y Excel', () => {
  it('detalle del cliente: movimientos reales, saldo acumulado y cada cifra en su columna', async () => {
    const d = await informeDetalleTercero(E, 'clientes', P, cliente);
    expect(d.tercero.movimientos.map((m) => [m.fecha, m.debe, m.haber, m.saldo])).toEqual([
      ['2026-01-15', 8654.68, 0, 8654.68],
      ['2026-02-01', 0, 8654.68, 0],
      ['2026-02-20', 367292.46, 0, 367292.46],
      ['2026-03-10', 1730.91, 0, 369023.37],
      ['2026-04-05', 0, 150000, 219023.37],
      // La rectificativa se contabiliza en negativo en el Debe.
      ['2026-04-20', -1730.91, 0, 217292.46],
      ['2026-06-30', 0, 12500, 204792.46],
    ]);
    expect(d.tercero.saldoFinal).toBe(204792.46);
    compruebaSaldos(d.tabla.filas, 0, 4, 5, 6);
    expect(d.tabla.columnas.map((c) => c.titulo)).toEqual(['Fecha', 'Asiento', 'Concepto', 'Factura', 'Debe', 'Haber', 'Saldo']);

    const { pdf, textos } = await exportaBien(d.tabla);
    const { width, height } = (await PDFDocument.load(pdf)).getPages()[0].getSize();
    expect(width).toBeGreaterThan(height);
    expect(textos).toEqual(expect.arrayContaining(['DEBE', 'HABER', 'SALDO', '8.654,68', '367.292,46', '−1.730,91', '150.000,00', '204.792,46', '375.947,14', '171.154,68']));

    // La venta sin asiento no sale en el mayor, pero se avisa con su numero.
    const numero = (await prisma.incomeInvoice.findUnique({ where: { id: sinAsiento }, select: { numeroCompleto: true } }))!.numeroCompleto!;
    const aviso = d.tabla.notas?.find((x) => x.startsWith('Atención'));
    expect(aviso).toContain(`la venta ${numero} (2.420,00\u00a0€) no tiene asiento`);
  });

  it('ventas cobradas el mismo dia: la factura antes que su cobro (sin saldos negativos de paso) y el asiento entero', async () => {
    const d = await informeDetalleTercero(E, 'clientes', P, mostrador);
    const movs = d.tercero.movimientos;
    expect(movs).toHaveLength(12);
    // Factura y cobro alternados: 121,00 y 0,00, nunca −121,00.
    expect(movs.map((m) => m.saldo)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 ? 0 : 121)));
    expect(movs.filter((_, i) => i % 2 === 0).every((m) => m.asiento.startsWith('FAC-ING-'))).toBe(true);
    expect(movs.map((m) => m.asiento)).toContain('FAC-ING-A-10');
    compruebaSaldos(d.tabla.filas, 0, 4, 5, 6);
    // «FAC-ING-A-10» es el asiento mas largo de su columna: sale entero, sin «…» (y el resto tambien).
    const { textos } = await exportaBien(d.tabla);
    expect(textos).toEqual(expect.arrayContaining(movs.map((m) => m.asiento)));
    expect(textos.some((x) => x.startsWith('FAC-ING-') && x.endsWith('…'))).toBe(false);
    // Lo mismo en el Libro mayor de su subcuenta.
    await exportaBien((await informeMayor(E, P, {}, await terceroParaMayor(E, 'cliente', mostrador))).tabla);
  });

  it('Libro mayor del cliente: su subcuenta con saldo inicial, movimientos y totales en sus columnas', async () => {
    const r = await informeMayor(E, P, {}, await terceroParaMayor(E, 'cliente', cliente));
    expect(r.tabla.filas[0]).toMatchObject({ estilo: 'seccion' });
    expect(r.tabla.filas[0].celdas[2]).toContain(subcuenta);
    const fin = compruebaSaldos(r.tabla.filas, 1, 4, 5, 6);
    expect(r.tabla.filas[fin].celdas[2]).toBe(`Totales y saldo final ${subcuenta}`);
    expect(r.tabla.notas?.some((x) => x.includes('no tiene asiento'))).toBe(true);
    await exportaBien(r.tabla);
  });

  it('Libro mayor de varias cuentas: el subtotal de cada una y el total, con el saldo final en Saldo', async () => {
    const r = await informeMayor(E, P, { desde: '430', hasta: '572' });
    expect(r.cuentas.length).toBeGreaterThan(1);
    let i = 0;
    for (const c of r.cuentas) {
      expect(r.tabla.filas[i].celdas[2]).toBe(`${c.cuenta} · ${c.nombre}`);
      i = compruebaSaldos(r.tabla.filas, i + 1, 4, 5, 6) + 1;
    }
    const total = r.tabla.filas[i];
    expect(total.estilo).toBe('total');
    const suma = (f: (c: (typeof r.cuentas)[number]) => number) => r.cuentas.reduce((s, c) => s + aCentimos(f(c)), 0);
    expect([total.celdas[4], total.celdas[5], total.celdas[6]].map((v) => aCentimos(Number(v)))).toEqual([
      suma((c) => c.totalDebe),
      suma((c) => c.totalHaber),
      suma((c) => c.saldoFinal),
    ]);
    await exportaBien(r.tabla);
  });

  it('listado de clientes: saldo inicial, Debe, Haber y saldo final en sus cuatro columnas', async () => {
    const r = await informeMayorTerceros(E, 'clientes', P);
    const fila = r.tabla.filas.find((f) => f.celdas[0] === 'Distribuciones Cerámicas del Mediterráneo y Baleares SL')!;
    expect(fila.celdas.slice(3, 7)).toEqual([0, 375947.14, 171154.68, 204792.46]);
    const { textos } = await exportaBien(r.tabla);
    // El saldo inicial a cero se escribe (columna de saldo).
    expect(textos).toContain('0,00');
  });

  it('sumas y saldos, balance, PyG y diario: cada importe en su columna', async () => {
    const sumas = await informeSumasYSaldos(E, P, 'subcuenta');
    const fila = sumas.tabla.filas.find((f) => f.celdas[0] === subcuenta)!;
    // Sumas al Debe y al Haber; saldo deudor en su columna y el acreedor vacio.
    expect(fila.celdas.slice(2)).toEqual([0, 375947.14, 171154.68, 204792.46, 0]);
    await exportaBien(sumas.tabla);
    await exportaBien((await informeBalance(E, P)).tabla);
    await exportaBien((await informePerdidasGanancias(E, P)).tabla);
    await exportaBien((await informeDiario(E, P, false)).tabla);
  });

  it('por la API: el PDF y el Excel del detalle se descargan con su nombre', async () => {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: ['contabilidad:read'] } } as never;
      req.companyId = E;
      next();
    });
    a.use('/informes-contables', informesContablesRoutes);
    a.use(errorMiddleware);
    const binario = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => cb(null, Buffer.concat(trozos)));
    };
    const pdf = await request(a).get(`/informes-contables/terceros/clientes/${cliente}?ejercicio=2026&formato=pdf`).buffer(true).parse(binario as never);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('mayor_Distribuciones_Ceramicas_del_Mediterraneo_y_Baleares_SL_2026-01-01_2026-12-31.pdf');
    expect((await textosDePdf(pdf.body)).map((x) => x.texto)).toContain('204.792,46');
    const xlsx = await request(a).get(`/informes-contables/terceros/clientes/${cliente}?ejercicio=2026&formato=xlsx`).buffer(true).parse(binario as never);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const d = await informeDetalleTercero(E, 'clientes', P, cliente);
    expect(fallosColumnasXlsx(d.tabla, xlsx.body)).toEqual([]);
  });
});
