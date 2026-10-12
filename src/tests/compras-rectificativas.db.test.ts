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
import { prisma } from '../config/database';
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
