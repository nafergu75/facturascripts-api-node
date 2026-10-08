/**
 * Tests unitarios/de integración del motor contable puro.
 *
 * Llaman directamente a contabilizarFacturaIngreso / contabilizarFacturaGasto
 * del servicio (sin HTTP, sin controller) y verifican el estado resultante en BD.
 *
 * Ejecutar con: npm test -- --testPathPattern=accounting-engine.service
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
// El cliente de la app (importes Decimal leidos como number), no uno propio.
import { prisma } from '../config/database';
import {
  contabilizarFacturaIngreso,
  contabilizarFacturaGasto,
} from '../services/accounting-engine.service';


// ─── helpers ─────────────────────────────────────────────────────────────────

type Linea = { accountCode: string; debe: number; haber: number };

/** Indexa líneas por código de cuenta para acceso directo. */
function porCuenta(lineas: Linea[]): Record<string, Linea> {
  return Object.fromEntries(lineas.map((l) => [l.accountCode, l]));
}

/** Devuelve DEBE, HABER y diferencia absoluta del asiento. */
function cuadre(lineas: Linea[]) {
  const debe = lineas.reduce((s, l) => s + l.debe, 0);
  const haber = lineas.reduce((s, l) => s + l.haber, 0);
  return { debe, haber, diferencia: Math.abs(debe - haber) };
}

async function getLineas(asientoId: string) {
  const a = await prisma.journalEntry.findUnique({
    where: { id: asientoId },
    include: { lineas: true },
  });
  if (!a) throw new Error(`Asiento ${asientoId} no encontrado en BD`);
  return a.lineas as Linea[];
}

// ─────────────────────────────────────────────────────────────────────────────
// INGRESOS
// ─────────────────────────────────────────────────────────────────────────────

describe('contabilizarFacturaIngreso', () => {
  // companyId ficticio: el servicio no valida que la empresa exista en BD,
  // solo lo escribe como referencia en JournalEntry / VATBook.
  const ts = Date.now();
  const companyId = `svc-ing-${ts}`;

  afterAll(async () => {
    await prisma.vATBook.deleteMany({ where: { companyId } });
    await prisma.journalEntry.deleteMany({ where: { companyId } }); // cascade lines
    await prisma.$disconnect();
  });

  // ── sin retención ─────────────────────────────────────────────────────────

  describe('sin retención — base 1000, IVA 21%, total 1210', () => {
    const numeroFactura = `F-ING-SR-${ts}`;
    let asientoId: string;

    beforeAll(async () => {
      const r = await contabilizarFacturaIngreso(companyId, `inv-sr-${ts}`, {
        baseTotal: 1000,
        ivaTotal: 210,
        ivaRate: 21,
        retencionTotal: 0,
        retencionRate: 0,
        totalFactura: 1210,
        fechaEmision: '2026-06-18',
        numeroFactura,
        clienteId: 'cli-1',
        clienteNif: '12345678A',
        clienteNombre: 'Cliente Sin Retención SL',
        tipoOperacion: 'NACIONAL',
      });
      asientoId = r.asientoId;
    });

    it('genera exactamente 3 líneas (430 / 700 / 477)', async () => {
      const lineas = await getLineas(asientoId);
      expect(lineas).toHaveLength(3);
    });

    it('430 DEBE 1210 — cliente recibe el total factura', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['430'].debe).toBeCloseTo(1210);
      expect(pc['430'].haber).toBe(0);
    });

    it('700 HABER 1000 — ingreso por ventas (base)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['700'].haber).toBeCloseTo(1000);
      expect(pc['700'].debe).toBe(0);
    });

    it('477 HABER 210 — IVA repercutido', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['477'].haber).toBeCloseTo(210);
      expect(pc['477'].debe).toBe(0);
    });

    it('NO existe línea 4751 (sin retención)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['4751']).toBeUndefined();
    });

    it('asiento equilibrado: DEBE = HABER = 1210', async () => {
      const { debe, haber, diferencia } = cuadre(await getLineas(asientoId));
      expect(debe).toBeCloseTo(1210);
      expect(haber).toBeCloseTo(1210);
      expect(diferencia).toBeLessThan(0.01);
    });

    it('registra en VATBook como EMITIDAS', async () => {
      const libro = await prisma.vATBook.findFirst({
        where: { companyId, tipoLibro: 'EMITIDAS', numeroFactura },
      });
      expect(libro).not.toBeNull();
      expect(libro?.baseImponible).toBeCloseTo(1000);
      expect(libro?.cuotaIva).toBeCloseTo(210);
      expect(libro?.tipoIva).toBe(21);
      expect(libro?.asientoId).toBe(asientoId);
    });
  });

  // ── con retención 15% ────────────────────────────────────────────────────

  describe('con retención 15% — base 1000, IVA 21%, ret 150, total 1060', () => {
    const numeroFactura = `F-ING-CR-${ts}`;
    let asientoId: string;

    beforeAll(async () => {
      // totalFactura = base + IVA - retención = 1000 + 210 - 150 = 1060
      // (lo que el cliente efectivamente nos paga; la retención la ingresa a AEAT él)
      const r = await contabilizarFacturaIngreso(companyId, `inv-cr-${ts}`, {
        baseTotal: 1000,
        ivaTotal: 210,
        ivaRate: 21,
        retencionTotal: 150,
        retencionRate: 15,
        totalFactura: 1060,
        fechaEmision: '2026-06-18',
        numeroFactura,
        clienteId: 'cli-2',
        clienteNif: '87654321B',
        clienteNombre: 'Cliente Retenedor SA',
        tipoOperacion: 'NACIONAL',
      });
      asientoId = r.asientoId;
    });

    it('genera exactamente 4 líneas (430 / 700 / 477 / 473)', async () => {
      expect(await getLineas(asientoId)).toHaveLength(4);
    });

    it('430 DEBE 1060 — lo que el cliente nos transfiere', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['430'].debe).toBeCloseTo(1060);
    });

    it('700 HABER 1000 | 477 HABER 210', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['700'].haber).toBeCloseTo(1000);
      expect(pc['477'].haber).toBeCloseTo(210);
    });

    it('473 DEBE 150 — crédito fiscal con AEAT (Hacienda deudora)', async () => {
      // En ingresos la retención está en DEBE de la cuenta 473 (HP retenciones y
      // pagos a cuenta, ACTIVO): la AEAT nos "debe" ese importe que el cliente le
      // ingresó en nuestro nombre. 4751 sería PASIVO, que es el caso del GASTO.
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['473'].debe).toBeCloseTo(150);
      expect(pc['473'].haber).toBe(0);
    });

    it('DEBE = HABER = 1210 (cuadre perfecto)', async () => {
      // DEBE: 1060 (430) + 150 (473) = 1210
      // HABER: 1000 (700) + 210 (477) = 1210
      const { debe, haber, diferencia } = cuadre(await getLineas(asientoId));
      expect(debe).toBeCloseTo(1210);
      expect(haber).toBeCloseTo(1210);
      expect(diferencia).toBeLessThan(0.01);
    });

    it('registra en VATBook EMITIDAS', async () => {
      const libro = await prisma.vATBook.findFirst({
        where: { companyId, tipoLibro: 'EMITIDAS', numeroFactura },
      });
      expect(libro?.baseImponible).toBeCloseTo(1000);
      expect(libro?.cuotaIva).toBeCloseTo(210);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOS
// ─────────────────────────────────────────────────────────────────────────────

describe('contabilizarFacturaGasto', () => {
  const ts = Date.now();
  const companyId = `svc-gst-${ts}`;

  afterAll(async () => {
    await prisma.retentionBook.deleteMany({ where: { companyId } });
    await prisma.vATBook.deleteMany({ where: { companyId } });
    await prisma.journalEntry.deleteMany({ where: { companyId } });
    await prisma.$disconnect();
  });

  // ── sin retención ─────────────────────────────────────────────────────────

  describe('sin retención — base 1000, IVA 21%, total 1210', () => {
    const numeroFactura = `F-GST-SR-${ts}`;
    let asientoId: string;

    beforeAll(async () => {
      const r = await contabilizarFacturaGasto(companyId, `ginv-sr-${ts}`, {
        baseTotal: 1000,
        ivaTotal: 210,
        ivaRate: 21,
        retencionTotal: 0,
        retencionRate: 0,
        totalFactura: 1210,
        fechaEmision: '2026-06-18',
        numeroFactura,
        proveedorId: 'prov-1',
        proveedorNif: 'B12345678',
        proveedorNombre: 'Proveedor Sin Retención SL',
        tipoGasto: 'COMPRA',
      });
      asientoId = r.asientoId;
    });

    it('genera exactamente 3 líneas (600 / 472 / 400)', async () => {
      expect(await getLineas(asientoId)).toHaveLength(3);
    });

    it('600 DEBE 1000 — compra de mercaderías (gasto)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['600'].debe).toBeCloseTo(1000);
      expect(pc['600'].haber).toBe(0);
    });

    it('472 DEBE 210 — IVA soportado deducible', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['472'].debe).toBeCloseTo(210);
      expect(pc['472'].haber).toBe(0);
    });

    it('400 HABER 1210 — proveedor acreedor (importe total)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['400'].haber).toBeCloseTo(1210);
      expect(pc['400'].debe).toBe(0);
    });

    it('NO existe línea 4751 (sin retención)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['4751']).toBeUndefined();
    });

    it('asiento equilibrado: DEBE = HABER = 1210', async () => {
      const { debe, haber, diferencia } = cuadre(await getLineas(asientoId));
      expect(debe).toBeCloseTo(1210);
      expect(haber).toBeCloseTo(1210);
      expect(diferencia).toBeLessThan(0.01);
    });

    it('registra en VATBook como RECIBIDAS', async () => {
      const libro = await prisma.vATBook.findFirst({
        where: { companyId, tipoLibro: 'RECIBIDAS', numeroFactura },
      });
      expect(libro).not.toBeNull();
      expect(libro?.baseImponible).toBeCloseTo(1000);
      expect(libro?.cuotaIva).toBeCloseTo(210);
      expect(libro?.tipoIva).toBe(21);
    });

    it('NO registra en RetentionBook (retención cero)', async () => {
      // Usamos el companyId exclusivo de este describe, así que cualquier entrada
      // existente sería de este test. Sin retención no debe haber ninguna.
      const registros = await prisma.retentionBook.findMany({ where: { companyId } });
      expect(registros).toHaveLength(0);
    });
  });

  // ── con retención 15% (profesional) ─────────────────────────────────────

  describe('con retención 15% profesional — base 1000, IVA 21%, ret 150, total 1060', () => {
    const numeroFactura = `F-GST-CR-${ts}`;
    let asientoId: string;

    beforeAll(async () => {
      // totalFactura = 1000 + 210 - 150 = 1060
      // (lo que realmente pagamos al proveedor; los 150 los retenemos y los
      //  ingresamos nosotros a AEAT → cuenta 4751 en HABER)
      const r = await contabilizarFacturaGasto(companyId, `ginv-cr-${ts}`, {
        baseTotal: 1000,
        ivaTotal: 210,
        ivaRate: 21,
        retencionTotal: 150,
        retencionRate: 15,
        totalFactura: 1060,
        fechaEmision: '2026-06-18',
        numeroFactura,
        proveedorId: 'prov-2',
        proveedorNif: 'B87654321',
        proveedorNombre: 'Consultor Profesional SA',
        tipoGasto: 'SERVICIO_PROFESIONAL',
      });
      asientoId = r.asientoId;
    });

    it('genera exactamente 4 líneas (623 / 472 / 4751 / 410)', async () => {
      // SERVICIO_PROFESIONAL → cuenta 623, no 600
      expect(await getLineas(asientoId)).toHaveLength(4);
    });

    it('623 DEBE 1000 — gasto servicios profesionales (no 600)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['623'].debe).toBeCloseTo(1000);
      expect(pc['600']).toBeUndefined(); // no es compra de mercaderías
    });

    it('472 DEBE 210 — IVA soportado', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['472'].debe).toBeCloseTo(210);
    });

    it('4751 HABER 150 — pasivo con AEAT (retenemos IRPF al proveedor)', async () => {
      // Para gastos la retención va en HABER: nosotros retenemos ese importe
      // del pago al proveedor y lo debemos a Hacienda.
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['4751'].haber).toBeCloseTo(150);
      expect(pc['4751'].debe).toBe(0);
    });

    it('410 HABER 1060 — el acreedor (un profesional no es un proveedor de mercaderías) cobra solo el neto', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['410'].haber).toBeCloseTo(1060);
      expect(pc['400']).toBeUndefined();
    });

    it('DEBE = HABER = 1210 (623+472 = 4751+410)', async () => {
      // DEBE:  1000 (623) + 210 (472) = 1210
      // HABER:  150 (4751) + 1060 (410) = 1210
      const { debe, haber, diferencia } = cuadre(await getLineas(asientoId));
      expect(debe).toBeCloseTo(1210);
      expect(haber).toBeCloseTo(1210);
      expect(diferencia).toBeLessThan(0.01);
    });

    it('registra en VATBook RECIBIDAS', async () => {
      const libro = await prisma.vATBook.findFirst({
        where: { companyId, tipoLibro: 'RECIBIDAS', numeroFactura },
      });
      expect(libro?.baseImponible).toBeCloseTo(1000);
      expect(libro?.cuotaIva).toBeCloseTo(210);
      expect(libro?.nifTercero).toBe('B87654321');
    });

    it('registra en RetentionBook como PROFESIONAL (modelo 190)', async () => {
      const entry = await prisma.retentionBook.findFirst({
        where: { companyId, tipoRetencionNombre: 'PROFESIONAL' },
      });
      expect(entry).not.toBeNull();
      expect(entry?.baseImponible).toBeCloseTo(1000);
      expect(entry?.porcentajeRetencion).toBe(15);
      expect(entry?.cuotaRetencion).toBeCloseTo(150);
      expect(entry?.nifTercero).toBe('B87654321');
      expect(entry?.asientoId).toBe(asientoId);
    });
  });

  // ── casos de Compras: varios tipos de IVA, cuentas, numero del proveedor ──

  describe('alta desde Compras', () => {
    const datos = (extra: Record<string, unknown> = {}) => ({
      baseTotal: 1000,
      ivaTotal: 210,
      ivaRate: 21,
      retencionTotal: 0,
      retencionRate: 0,
      totalFactura: 1210,
      fechaEmision: '2026-05-04',
      numeroFactura: `G-${ts}-${Math.random().toString(36).slice(2, 8)}`,
      proveedorId: 'prov-3',
      proveedorNif: 'B11111111',
      proveedorNombre: 'Proveedor Compras SL',
      tipoGasto: 'COMPRA' as const,
      ...extra,
    });

    it('IVA al 21 % y al 10 %: dos lineas 472 y dos filas del libro', async () => {
      const d = datos({
        baseTotal: 1500,
        ivaTotal: 260,
        totalFactura: 1760,
        desgloseIva: [
          { tipoIva: 21, base: 1000, cuota: 210 },
          { tipoIva: 10, base: 500, cuota: 50 },
        ],
      });
      const r = await contabilizarFacturaGasto(companyId, `ginv-2iva-${ts}`, d);
      const lineas = await getLineas(r.asientoId);
      const iva = lineas.filter((l) => l.accountCode === '472').map((l) => l.debe).sort();
      expect(iva).toEqual([210, 50].sort());
      expect(porCuenta(lineas)['400'].haber).toBeCloseTo(1760);
      expect(cuadre(lineas).diferencia).toBeLessThan(0.01);
      const libro = await prisma.vATBook.findMany({ where: { companyId, numeroFactura: d.numeroFactura } });
      expect(libro.map((l) => [l.tipoIva, l.baseImponible, l.cuotaIva]).sort()).toEqual([[10, 500, 50], [21, 1000, 210]]);
    });

    it('gastoPorCuenta con 629 y 621: dos lineas de gasto', async () => {
      const r = await contabilizarFacturaGasto(
        companyId,
        `ginv-cuentas-${ts}`,
        datos({ tipoGasto: 'SUMINISTROS', gastoPorCuenta: [{ cuenta: '629', base: 600 }, { cuenta: '621', base: 400 }] }),
      );
      const pc = porCuenta(await getLineas(r.asientoId));
      expect(pc['629'].debe).toBeCloseTo(600);
      expect(pc['621'].debe).toBeCloseTo(400);
      expect(pc['628']).toBeUndefined();
      expect(pc['410'].haber).toBeCloseTo(1210);
    });

    it('sin tipo de retencion en la cabecera: el libro de retenciones sale al 15 % de la cuota', async () => {
      const r = await contabilizarFacturaGasto(
        companyId,
        `ginv-ret0-${ts}`,
        datos({ tipoGasto: 'SERVICIO_PROFESIONAL', retencionTotal: 150, retencionRate: 0, totalFactura: 1060 }),
      );
      const fila = await prisma.retentionBook.findFirst({ where: { companyId, asientoId: r.asientoId } });
      expect(fila).toMatchObject({ porcentajeRetencion: 15, cuotaRetencion: 150, baseImponible: 1000, tipoRetencionNombre: 'PROFESIONAL', ano: 2026, mes: 5 });
    });

    it('ALQUILER: el libro de retenciones dice ARRENDAMIENTO, y la retencion va a la 4751 y el acreedor a la 410', async () => {
      const r = await contabilizarFacturaGasto(
        companyId,
        `ginv-alq-${ts}`,
        datos({ tipoGasto: 'ALQUILER', retencionTotal: 190, retencionRate: 19, totalFactura: 1020 }),
      );
      const pc = porCuenta(await getLineas(r.asientoId));
      expect(pc['621'].debe).toBeCloseTo(1000);
      expect(pc['4751'].haber).toBeCloseTo(190);
      expect(pc['410'].haber).toBeCloseTo(1020);
      const fila = await prisma.retentionBook.findFirst({ where: { companyId, asientoId: r.asientoId } });
      expect(fila?.tipoRetencionNombre).toBe('ARRENDAMIENTO');
    });

    it('el numero del proveedor llega al libro de IVA, y la fecha de expedicion a sus observaciones', async () => {
      const d = datos({ numeroFacturaProveedor: 'F2026/0012', fechaEmision: '2026-04-02', fechaExpedicion: '2026-03-28' });
      const r = await contabilizarFacturaGasto(companyId, `ginv-nfp-${ts}`, d);
      const fila = await prisma.vATBook.findFirst({ where: { companyId, asientoId: r.asientoId } });
      expect(fila).toMatchObject({ numeroFactura: d.numeroFactura, numeroFacturaEmisor: 'F2026/0012', observaciones: 'Fecha de expedición: 28/03/2026' });
      expect(fila?.fechaFactura.toISOString().slice(0, 10)).toBe('2026-04-02');
      const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
      expect(a.descripcion).toBe(`Factura de gasto F2026/0012 (registro ${d.numeroFactura}) - Proveedor Compras SL`);
    });

    it('numeroAsiento propio (al rehacer el asiento)', async () => {
      const d = datos();
      const r = await contabilizarFacturaGasto(companyId, `ginv-num-${ts}`, { ...d, numeroAsiento: `FAC-GAST-${d.numeroFactura}-R1` });
      const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
      expect(a.numeroAsiento).toBe(`FAC-GAST-${d.numeroFactura}-R1`);
    });
  });
});
