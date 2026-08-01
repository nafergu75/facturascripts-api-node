/**
 * Tests unitarios/de integración del motor contable puro.
 *
 * Llaman directamente a contabilizarFacturaIngreso / contabilizarFacturaGasto
 * del servicio (sin HTTP, sin controller) y verifican el estado resultante en BD.
 *
 * Ejecutar con: npm test -- --testPathPattern=accounting-engine.service
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import {
  contabilizarFacturaIngreso,
  contabilizarFacturaGasto,
} from '../services/accounting-engine.service';

const prisma = new PrismaClient();

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

    it('genera exactamente 4 líneas (622 / 472 / 4751 / 400)', async () => {
      // SERVICIO_PROFESIONAL → cuenta 622, no 600
      expect(await getLineas(asientoId)).toHaveLength(4);
    });

    it('622 DEBE 1000 — gasto servicios profesionales (no 600)', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['622'].debe).toBeCloseTo(1000);
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

    it('400 HABER 1060 — proveedor cobra solo el neto', async () => {
      const pc = porCuenta(await getLineas(asientoId));
      expect(pc['400'].haber).toBeCloseTo(1060);
    });

    it('DEBE = HABER = 1210 (622+472 = 4751+400)', async () => {
      // DEBE:  1000 (622) + 210 (472) = 1210
      // HABER:  150 (4751) + 1060 (400) = 1210
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
});
