/**
 * Abonos y facturas rectificativas de proveedor sobre BD real: el asiento con
 * cada apunte en su lado segun el signo (seccion 8.1 de la especificacion), el
 * alta con sus enlaces a la factura o facturas que rectifica (o a un periodo),
 * la sustitucion con la diferencia, la herencia de la original y lo que ya no
 * se puede hacer con una original rectificada.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { proveedoresService } from '../services/proveedores.service';
import { anularGasto, editarGasto, expenseInvoicesService, registrarGasto } from '../services/expense-invoices.service';
import { contabilizarFacturaGasto } from '../services/accounting-engine.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { aCentimos } from '../utils/money';
import { controlCif } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
export function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

export async function empresa(nombre: string): Promise<string> {
  const id = `rect-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Rectificativas ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Rectificativas ${nombre} SL`, nif: cif() } });
  await asegurarPlanContableEmpresa(id);
  return id;
}

/** Debe y haber por cuenta de un asiento (en euros). */
async function lados(asientoId: string) {
  const ls = await prisma.journalEntryLine.findMany({ where: { entryId: asientoId } });
  const c: Record<string, [number, number]> = {};
  for (const l of ls) {
    const [d, h] = c[l.accountCode] ?? [0, 0];
    c[l.accountCode] = [d + aCentimos(Number(l.debe)), h + aCentimos(Number(l.haber))];
  }
  return Object.fromEntries(Object.entries(c).map(([k, [d, h]]) => [k, [d / 100, h / 100]]));
}

describe('asiento de un abono: cada apunte en su lado según el signo', () => {
  let E: string;
  beforeAll(async () => {
    E = await empresa('asiento');
  });

  const base = {
    ivaRate: 21,
    retencionRate: 0,
    retencionTotal: 0,
    fechaEmision: '2027-02-12',
    numeroFactura: 'G-40',
    numeroFacturaProveedor: 'R-2027/004',
    proveedorId: 'p1',
    proveedorNif: 'B00000000',
    proveedorNombre: 'Proveedor X',
    tipoGasto: 'COMPRA' as const,
  };

  it('devolución de mercancías de 100 € + 21 %: la 400N al debe, la 608 y la 472 al haber', async () => {
    const r = await contabilizarFacturaGasto(E, `inv-dev-${SUFIJO}`, {
      ...base,
      baseTotal: -100,
      ivaTotal: -21,
      totalFactura: -121,
      desgloseIva: [{ tipoIva: 21, base: -100, cuota: -21 }],
      gastoPorCuenta: [{ cuenta: '608', nombre: 'Devoluciones de compras', base: -100 }],
      cuentaAcreedor: '4000012',
      nombreCuentaAcreedor: 'Proveedor X',
      rectifica: 'F-2026/118',
    });
    expect(await lados(r.asientoId)).toEqual({ '4000012': [121, 0], '608': [0, 100], '472': [0, 21] });
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
    expect(a.descripcion).toBe('Rectificativa de gasto R-2027/004 (registro G-40) - Proveedor X; rectifica F-2026/118');
    const libro = await prisma.vATBook.findMany({ where: { asientoId: r.asientoId } });
    expect(libro.map((l) => [Number(l.baseImponible), Number(l.cuotaIva), l.numeroFacturaEmisor])).toEqual([[-100, -21, 'R-2027/004']]);
  });

  it('abono de un profesional con retención: la 4751 al debe y el asiento cuadra', async () => {
    const r = await contabilizarFacturaGasto(E, `inv-prof-${SUFIJO}`, {
      ...base,
      tipoGasto: 'SERVICIO_PROFESIONAL',
      numeroFactura: 'G-41',
      retencionRate: 15,
      baseTotal: -1000,
      ivaTotal: -210,
      retencionTotal: -150,
      totalFactura: -1060,
      desgloseIva: [{ tipoIva: 21, base: -1000, cuota: -210 }],
      gastoPorCuenta: [{ cuenta: '623', nombre: 'Servicios profesionales', base: -1000 }],
      desgloseRetencion: [{ porcentaje: 15, base: -1000, cuota: -150 }],
      cuentaAcreedor: '4100007',
      nombreCuentaAcreedor: 'Asesoría Y',
    });
    expect(await lados(r.asientoId)).toEqual({ '4100007': [1060, 0], '4751': [150, 0], '623': [0, 1000], '472': [0, 210] });
    const ret = await prisma.retentionBook.findMany({ where: { asientoId: r.asientoId } });
    expect(ret.map((x) => [Number(x.baseImponible), Number(x.cuotaRetencion), x.porcentajeRetencion])).toEqual([[-1000, -150, 15]]);
  });

  it('mixta (sube la base y baja la cuota): cada apunte por su signo', async () => {
    // De 1.000 al 21 % a 1.100 al 10 %: base +100, cuota -100 (210 → 110), total 0.
    const r = await contabilizarFacturaGasto(E, `inv-mixta-${SUFIJO}`, {
      ...base,
      numeroFactura: 'G-42',
      baseTotal: 100,
      ivaTotal: -100,
      totalFactura: 0,
      desgloseIva: [
        { tipoIva: 21, base: -1000, cuota: -210 },
        { tipoIva: 10, base: 1100, cuota: 110 },
      ],
      gastoPorCuenta: [{ cuenta: '600', nombre: 'Compras', base: 100 }],
      cuentaAcreedor: '4000012',
    });
    expect(await lados(r.asientoId)).toEqual({ '600': [100, 0], '472': [110, 210] });
  });

  it('ERROR_IVA con la misma base: solo se mueven la 472 y el proveedor', async () => {
    const r = await contabilizarFacturaGasto(E, `inv-iva-${SUFIJO}`, {
      ...base,
      numeroFactura: 'G-43',
      baseTotal: 0,
      ivaTotal: -11,
      totalFactura: -11,
      desgloseIva: [
        { tipoIva: 21, base: -100, cuota: -21 },
        { tipoIva: 10, base: 100, cuota: 10 },
      ],
      gastoPorCuenta: [{ cuenta: '600', nombre: 'Compras', base: 0 }],
      cuentaAcreedor: '4000012',
    });
    expect(await lados(r.asientoId)).toEqual({ '472': [10, 21], '4000012': [11, 0] });
  });
});

// ---------------------------------------------------------------------------
// Alta, correccion y anulacion
// ---------------------------------------------------------------------------

const lin = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });

function factura(supplierId: string, numero: string, fecha: string, lineas: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { proveedor: { id: supplierId }, numeroFacturaProveedor: numero, fechaEmision: fecha, tipoGasto: 'COMPRA', lineas, ...extra };
}

async function estado(r: Promise<unknown>): Promise<{ status: number; message: string; details?: Record<string, unknown> }> {
  try {
    await r;
  } catch (e) {
    const h = e as { statusCode: number; message: string; details?: Record<string, unknown> };
    return { status: h.statusCode, message: h.message, details: h.details };
  }
  throw new Error('No dio error');
}

describe('alta de abonos y rectificativas', () => {
  let E: string;
  let prov: string;
  let otro: string;
  let profesional: string;

  beforeAll(async () => {
    E = await empresa('alta');
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
    otro = (await proveedoresService.create(E, { nombreFiscal: 'Otra Casa SL', nifCif: cif() })).id;
    profesional = (await proveedoresService.create(E, { nombreFiscal: 'Asesoría Sanz SL', nifCif: cif() })).id;
  });

  it('abono de una original de la app: enlaza, hereda el tipo y la subcuenta, y el asiento abona la 608', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-100', '2027-01-15', [lin(1000)]), { contabilizar: 'POSTED' });
    const cuentaOriginal = (await prisma.journalEntryLine.findFirstOrThrow({ where: { entryId: o.asientoId, accountCode: { startsWith: '400' } } })).accountCode;
    const r = await registrarGasto(
      E,
      factura(prov, 'R-100', '2027-02-10', [lin(-100, { cuenta: '608' })], {
        fechaRegistro: '2027-02-12',
        tipoGasto: 'SUMINISTROS',
        totalDocumento: -121,
        rectificativa: { tipo: 'I', causa: 'DEVOLUCION', motivo: 'Mercancía dañada', originales: [{ id: o.factura.id }] },
      }),
      { contabilizar: 'POSTED' },
    );
    expect(r.factura).toMatchObject({ esRectificativa: true, tipoGasto: 'COMPRA', totalFactura: -121, facturaOriginalId: o.factura.id });
    expect(r.factura.rectificativa).toMatchObject({ tipo: 'I', causa: 'DEVOLUCION', causaTexto: 'Devolución de mercancías o envases', imputacionIva: { fecha: '2027-02-12', casillas: '40-41' } });
    expect(r.factura.rectificativa?.originales).toEqual([{ id: o.factura.id, numeroCompleto: o.factura.numeroCompleto, numero: 'F-100', fecha: '2027-01-15', base: -100, cuota: -21 }]);
    expect(await lados(r.asientoId)).toEqual({ [cuentaOriginal]: [121, 0], '608': [0, 100], '472': [0, 21] });
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { asientoId: r.asientoId } });
    expect(libro.observaciones).toBe('Rectificativa (por diferencias) de F-100 de 15/01/2027. Causa: devolución de mercancías o envases. Fecha de expedición: 10/02/2027');
    // La original enseña su rectificativa y ya no se puede anular.
    const ficha = await expenseInvoicesService.obtenerPorId(E, o.factura.id);
    expect(ficha.rectificativas).toEqual([expect.objectContaining({ id: r.factura.id, numero: 'R-100', total: -121, tipo: 'I' })]);
    expect(ficha.acciones.anular).toMatchObject({ permitido: false });
    expect((await estado(anularGasto(E, o.factura.id, { motivo: 'Error' }))).message).toBe('Tiene la rectificativa R-100: anúlala antes de anular la factura.');
    // Corregir sus importes, no; su vencimiento, sí.
    const cuerpo = factura(prov, 'F-100', '2027-01-15', [lin(1000)]);
    expect((await estado(editarGasto(E, o.factura.id, { ...cuerpo, lineas: [lin(900)] }))).status).toBe(409);
    await expect(editarGasto(E, o.factura.id, { ...cuerpo, fechaVencimiento: '2027-04-30' })).resolves.toMatchObject({ fechaVencimiento: '2027-04-30' });
    // Anulada la rectificativa, la original vuelve a poder anularse.
    await anularGasto(E, r.factura.id, { motivo: 'Registrada por error' });
    expect((await expenseInvoicesService.obtenerPorId(E, o.factura.id)).acciones.anular.permitido).toBe(true);
  });

  it('un abono de un profesional con retención cuadra, con la 4751 al debe', async () => {
    const o = await registrarGasto(E, factura(profesional, 'P-1', '2027-01-20', [lin(1000, { tipoRetencion: 15 })], { tipoGasto: 'SERVICIO_PROFESIONAL' }), { contabilizar: 'POSTED' });
    const r = await registrarGasto(
      E,
      factura(profesional, 'P-1R', '2027-02-20', [lin(-1000, { tipoRetencion: 15 })], {
        tipoGasto: 'SERVICIO_PROFESIONAL',
        totalDocumento: -1060,
        rectificativa: { tipo: 'I', causa: 'ANULACION_PRECIO', originales: [{ id: o.factura.id }] },
      }),
      { contabilizar: 'POSTED' },
    );
    const l = await lados(r.asientoId);
    expect(l['4751']).toEqual([150, 0]);
    expect(l['623']).toEqual([0, 1000]);
    expect(r.factura.retencionTotal).toBe(-150);
  });

  it('sin original en la app: número y fecha de la de fuera', async () => {
    const r = await registrarGasto(
      E,
      factura(prov, 'R-200', '2027-01-10', [lin(-50, { cuenta: '608' })], {
        rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ numero: 'F-2026/118', fecha: '2026-11-30' }] },
      }),
      { contabilizar: 'POSTED' },
    );
    const enlaces = await prisma.expenseInvoiceRectificada.findMany({ where: { rectificativaId: r.factura.id } });
    expect(enlaces).toEqual([expect.objectContaining({ originalId: null, numeroOriginal: 'F-2026/118', fechaOriginal: '2026-11-30', baseRectificada: -50, cuotaRectificada: -10.5 })]);
    expect(r.factura.facturaOriginalId).toBeNull();
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
    expect(a.descripcion).toMatch(/^Rectificativa de gasto R-200 .*; rectifica F-2026\/118$/);
  });

  it('varias originales sin reparto: en proporción a lo pendiente, y suma exacta', async () => {
    const a = await registrarGasto(E, factura(prov, 'F-301', '2027-01-05', [lin(300)]), { contabilizar: 'POSTED' });
    const b = await registrarGasto(E, factura(prov, 'F-302', '2027-01-06', [lin(100)]), { contabilizar: 'POSTED' });
    const r = await registrarGasto(
      E,
      factura(prov, 'R-300', '2027-02-01', [lin(-40, { cuenta: '608' })], {
        rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ id: a.factura.id }, { id: b.factura.id }] },
      }),
      { contabilizar: 'POSTED' },
    );
    const enlaces = await prisma.expenseInvoiceRectificada.findMany({ where: { rectificativaId: r.factura.id }, orderBy: { baseRectificada: 'asc' } });
    expect(enlaces.map((e) => [e.originalId, e.baseRectificada, e.cuotaRectificada])).toEqual([
      [a.factura.id, -30, -6.3],
      [b.factura.id, -10, -2.1],
    ]);
  });

  it('rappel de un periodo: fila de periodo y cuenta 609', async () => {
    const r = await registrarGasto(
      E,
      factura(prov, 'RAP-1T', '2027-04-02', [lin(-500, { cuenta: '609' })], {
        rectificativa: { tipo: 'I', causa: 'RAPPEL', periodo: { desde: '2027-01-01', hasta: '2027-03-31' } },
      }),
      { contabilizar: 'POSTED' },
    );
    expect(r.factura.rectificativa?.periodo).toEqual({ desde: '2027-01-01', hasta: '2027-03-31' });
    expect((await lados(r.asientoId))['609']).toEqual([0, 500]);
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
    expect(a.descripcion).toMatch(/rectifica las compras del 01\/01\/2027 al 31\/03\/2027$/);
  });

  it('por sustitución: guarda la diferencia con la cuota por tipo (2 × 0,07 frente a 1 × 0,14 al 21 %)', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-400', '2027-01-05', [lin(0.07), lin(0.07)]), { contabilizar: 'POSTED' });
    expect(o.factura.ivaTotal).toBe(0.02);
    const r = await registrarGasto(
      E,
      {
        ...factura(prov, 'F-400-C', '2027-01-20', []),
        lineas: undefined,
        rectificativa: { tipo: 'S', causa: 'ERROR_IVA', originales: [{ id: o.factura.id }], corregida: { lineas: [lin(0.14)] } },
      },
      { contabilizar: 'POSTED' },
    );
    expect(r.factura).toMatchObject({ baseTotal: 0, ivaTotal: 0.01, totalFactura: 0.01 });
    expect(r.factura.lineas).toEqual([expect.objectContaining({ precioUnitario: 0, baseLine: 0, ivaImporte: 0.01, tipoIva: 21 })]);
    expect(r.factura.avisos).toEqual([expect.stringMatching(/^La cuota de la diferencia es 0,01 € distinta de aplicar el 21 %/)]);
    const f = await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: r.factura.id } });
    expect(f.tipoRectificativa).toBe('S');
    expect((f.datosSustitucion as { corregida: { totales: { total: number } } }).corregida.totales.total).toBe(0.17);
  });

  it('por sustitución con más base: la diferencia completa por cuenta', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-410', '2027-01-05', [lin(1000)]), { contabilizar: 'POSTED' });
    const r = await registrarGasto(
      E,
      { ...factura(prov, 'F-410-C', '2027-01-25', []), lineas: undefined, totalDocumento: 968, rectificativa: { tipo: 'S', causa: 'ANULACION_PRECIO', originales: [{ id: o.factura.id }], corregida: { lineas: [lin(800)] } } },
      { contabilizar: 'POSTED' },
    );
    expect(r.factura).toMatchObject({ baseTotal: -200, ivaTotal: -42, totalFactura: -242 });
    expect(await lados(r.asientoId)).toMatchObject({ '600': [0, 200], '472': [0, 42] });
  });

  it('mixta por error en el IVA: -100 al 21 % y +100 al 10 %', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-500', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    const r = await registrarGasto(
      E,
      factura(prov, 'F-500-R', '2027-01-25', [lin(-100), lin(100, { tipoIva: 10 })], {
        totalDocumento: -11,
        rectificativa: { tipo: 'I', causa: 'ERROR_IVA', originales: [{ id: o.factura.id }] },
      }),
      { contabilizar: 'POSTED' },
    );
    expect(r.factura).toMatchObject({ baseTotal: 0, ivaTotal: -11, totalFactura: -11 });
    expect(r.factura.avisos).toEqual([expect.stringMatching(/no tiene IVA al 10 %/)]);
    const l = await lados(r.asientoId);
    expect(l['472']).toEqual([10, 21]);
    expect(l['600']).toBeUndefined();
  });

  it('el mismo número que la original es un duplicado', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-600', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    const e = await estado(
      registrarGasto(E, factura(prov, 'F-600', '2027-01-25', [lin(-10)], { rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ id: o.factura.id }] } }), {
        contabilizar: 'POSTED',
      }),
    );
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/^Esta factura ya está registrada/);
  });

  it('original de otro proveedor, anulada, de otra empresa o superada por el abono', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-700', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    const abono = (supplierId: string, originalId: string, precio = -10) =>
      registrarGasto(E, factura(supplierId, `R-${n++}`, '2027-01-25', [lin(precio)], { rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ id: originalId }] } }), {
        contabilizar: 'POSTED',
      });
    expect(await estado(abono(otro, o.factura.id))).toMatchObject({ status: 400, message: 'La factura F-700 es de otro proveedor.' });
    expect(await estado(abono(prov, o.factura.id, -101))).toMatchObject({
      status: 400,
      message: 'Con este abono la factura F-700 quedaría en -1,21 €: el abono no puede pasar de lo que se facturó. Revisa el importe.',
    });
    await abono(prov, o.factura.id, -60);
    expect((await estado(abono(prov, o.factura.id, -41))).message).toMatch(/quedaría en -1,21 €/);
    const ajena = await empresa(`ajena-${n++}`);
    const pAjeno = (await proveedoresService.create(ajena, { nombreFiscal: 'Ajeno SL', nifCif: cif() })).id;
    const deOtra = await registrarGasto(ajena, factura(pAjeno, 'X-1', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    expect((await estado(abono(prov, deOtra.factura.id))).status).toBe(404);
    const anulada = await registrarGasto(E, factura(prov, 'F-701', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    await anularGasto(E, anulada.factura.id, { motivo: 'Duplicada' });
    expect(await estado(abono(prov, anulada.factura.id))).toMatchObject({ status: 400, message: 'La factura F-701 está anulada: no se puede rectificar.' });
  });

  it('una factura no se convierte en abono al corregirla', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-800', '2027-01-05', [lin(100)]), { contabilizar: 'POSTED' });
    const e = await estado(editarGasto(E, o.factura.id, factura(prov, 'F-800', '2027-01-05', [lin(-100)], { rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ numero: 'A', fecha: '2027-01-01' }] } })));
    expect(e.status).toBe(400);
  });

  it('corregir una rectificativa rehace sus enlaces y su asiento', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-900', '2027-01-05', [lin(1000)]), { contabilizar: 'POSTED' });
    const cuerpo = (precio: number) =>
      factura(prov, 'R-900', '2027-01-25', [lin(precio, { cuenta: '608' })], { rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ id: o.factura.id }] } });
    const r = await registrarGasto(E, cuerpo(-100), { contabilizar: 'POSTED' });
    const d = await editarGasto(E, r.factura.id, cuerpo(-200));
    expect(d.totalFactura).toBe(-242);
    const enlaces = await prisma.expenseInvoiceRectificada.findMany({ where: { rectificativaId: r.factura.id } });
    expect(enlaces.map((e) => e.baseRectificada)).toEqual([-200]);
  });
});

describe('rutas de las candidatas a original y del prellenado', () => {
  let E: string;
  let prov: string;
  let original: string;

  function app(companyId: string, permisos?: string[]) {
    const rol = 'contable';
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = {
        userId: `u-${rol}`,
        email: `${rol}@test.local`,
        roles: [rol],
        companies: [companyId],
        rolesPorEmpresa: { [companyId]: [rol] },
        ...(permisos ? { permisosPorEmpresa: { [companyId]: permisos } } : {}),
      } as never;
      req.companyId = companyId;
      next();
    });
    a.use('/expense-invoices', expenseInvoicesRoutes);
    a.use(errorMiddleware);
    return a;
  }

  beforeAll(async () => {
    E = await empresa('rutas');
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
    original = (await registrarGasto(E, factura(prov, 'F-2027/118', '2027-01-05', [lin(1000, { cuenta: '600' })]), { contabilizar: 'POSTED' })).factura.id;
    await registrarGasto(E, factura(prov, 'F-2027/119', '2027-01-06', [lin(10)]), { contabilizar: 'POSTED' });
  });

  it('GET /originales: exacta por número normalizado y parecidas', async () => {
    const r = await request(app(E)).get('/expense-invoices/originales').query({ supplierId: prov, numero: 'f-2027/118 ' });
    expect(r.status).toBe(200);
    expect(r.body.data.coincidencia).toBe('EXACTA');
    expect(r.body.data.candidatas[0]).toMatchObject({ id: original, numero: 'F-2027/118', exacta: true });
    const p = await request(app(E)).get('/expense-invoices/originales').query({ supplierId: prov, numero: '2027/11' });
    expect(p.body.data.coincidencia).toBe('PARECIDA');
    expect(p.body.data.candidatas).toHaveLength(2);
    const nada = await request(app(E)).get('/expense-invoices/originales').query({ nif: 'B00000000', numero: 'F-1' });
    expect(nada.body.data).toEqual({ coincidencia: 'NINGUNA', candidatas: [], partidasFuera: [] });
  });

  it('GET /:id/rectificar: líneas con su cuenta, la propuesta por causa, lo pendiente y el máximo', async () => {
    const r = await request(app(E)).get(`/expense-invoices/${original}/rectificar`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ tipoGasto: 'COMPRA', pendiente: 1210, abonoMaximo: 1210, yaRectificado: 0 });
    expect(r.body.data.lineas[0]).toMatchObject({ cuenta: '600', cuentaPropuesta: { DEVOLUCION: '608', RAPPEL: '609', PRONTO_PAGO: '606', ERROR_IVA: '600' } });
  });

  it('sin permiso de lectura de Compras ni de Contabilidad: 403', async () => {
    const r1 = await request(app(E, ['nominas:read', 'ventas:read'])).get('/expense-invoices/originales').query({ supplierId: prov });
    const r2 = await request(app(E, ['nominas:read', 'ventas:read'])).get(`/expense-invoices/${original}/rectificar`);
    expect([r1.status, r2.status]).toEqual([403, 403]);
  });
});
