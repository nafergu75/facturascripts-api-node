/**
 * Carmen con abonos de proveedor (sección 14 de la especificación de abonos),
 * sobre BD real:
 *  - INT-06 (lo que debes a proveedores): los abonos no salen como facturas
 *    pendientes ni vencidas; lo que queda a tu favor va aparte;
 *  - INT-13 (buscar una factura): un abono dice qué rectifica, lo que ha
 *    restado y lo que queda a tu favor; la original, lo que le resta el abono
 *    (sin contarlo como pagado).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { construirContexto } from '../services/carmen/contexto';
import { intencionPorId } from '../services/carmen/intenciones/catalogo';
import { olvidarIndices } from '../services/carmen/terceros';
import { registrarGasto } from '../services/expense-invoices.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { proveedoresService } from '../services/proveedores.service';
import { controlCif } from '../utils/nif';
import type { AuthUser } from '../types/express';
import type { HuecosResueltos, RespuestaDatos } from '../services/carmen/tipos';

const SUF = Date.now();
const E = `carmen-abonos-${SUF}`;
const HOY = '2026-10-07';
let n = 0;
const cif = () => {
  const siete = String(4000000 + ((SUF + n++ * 7919) % 5999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

const usuario = (roles: string[]): AuthUser => ({ userId: `u-${SUF}`, roles, rolesPorEmpresa: { [E]: roles }, companies: [E] });
const ejecutar = (id: string, h: HuecosResueltos = {}, roles = ['admin']) => intencionPorId(id)!.ejecutar(construirContexto(usuario(roles), E, HOY), h);
const cifras = (r: RespuestaDatos) => {
  if (r.sinPermiso || r.sinCifras) throw new Error(`sin cifras: ${JSON.stringify(r)}`);
  return r;
};
const lin = (precio: number) => ({ descripcion: 'Mercancía', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const compra = (sup: string, numero: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) =>
  registrarGasto(E, { proveedor: { id: sup }, numeroFacturaProveedor: numero, fechaEmision: fecha, fechaVencimiento: fecha, tipoGasto: 'COMPRA', lineas: [lin(precio)], ...extra }, { contabilizar: 'POSTED' });

const ids: Record<string, string> = {};
const numeros: Record<string, string> = {};

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Carmen Abonos SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Carmen Abonos SL', nif: cif() } });
  await asegurarPlanContableEmpresa(E);
  ids.turia = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
  ids.sur = (await proveedoresService.create(E, { nombreFiscal: 'Envases del Sur SL', nifCif: cif() })).id;
  // Turia: F-1 de 1.210 € vencida y su abono R-1 de -121 € (resta de lo pendiente: quedan 1.089 €).
  const f1 = await compra(ids.turia, 'F-1', '2026-09-01', 1000);
  const r1 = await compra(ids.turia, 'R-1', '2026-09-10', -100, { rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ id: f1.factura.id }] } });
  // Sur: un abono de -60,50 € de una factura de antes de la app ya pagada: queda a tu favor (y su vencimiento ya pasó).
  const r2 = await compra(ids.sur, 'AB-7', '2026-09-15', -50, {
    rectificativa: { tipo: 'I', causa: 'DESCUENTO', originales: [{ numero: 'S-2025/40', fecha: '2025-12-01' }], yaPagada: true },
  });
  ids.f1 = f1.factura.id;
  ids.r1 = r1.factura.id;
  ids.r2 = r2.factura.id;
  numeros.f1 = f1.factura.numeroCompleto;
  numeros.r1 = r1.factura.numeroCompleto;
  numeros.r2 = r2.factura.numeroCompleto;
  olvidarIndices();
});

describe('INT-06 con abonos', () => {
  it('lo pendiente no lleva los abonos; lo que queda a tu favor va aparte y no sale como vencido', async () => {
    const r = cifras(await ejecutar('INT-06'));
    expect(r.texto).toBe(
      'Debes 1.089,00 € a tus proveedores en 1 factura de 1 proveedor. Todas están vencidas. Además tienes 60,50 € a tu favor en 1 abono: pide la devolución o aplícalo a otra factura. Cuenta el total a pagar de cada factura recibida (sin borradores) menos los pagos registrados hasta hoy.',
    );
    expect(r.kpis).toContainEqual({ etiqueta: 'A tu favor', valor: '60,50 €', detalle: '1 abono' });
    expect(r.tabla?.filas.map((f) => f.celdas[0])).toEqual([numeros.f1]);
    const vencidas = cifras(await ejecutar('INT-06', { soloVencidas: true }));
    expect(vencidas.tabla?.filas.map((f) => f.celdas[0])).toEqual([numeros.f1]);
  });

  it('de un proveedor al que no se le debe nada: lo que tiene a tu favor', async () => {
    const r = cifras(await ejecutar('INT-06', { terceroId: ids.sur, rol: 'proveedor' }));
    expect(r.texto).toBe(
      'No le debes nada a Envases del Sur SL a 07/10/2026. Tienes 60,50 € a tu favor en 1 abono: pide la devolución o aplícalo a otra factura. Cuenta el total a pagar de cada factura recibida (sin borradores) menos los pagos registrados hasta hoy.',
    );
  });
});

describe('INT-13 con abonos', () => {
  it('el abono dice qué rectifica y cuánto ha restado de lo pendiente', async () => {
    const r = cifras(await ejecutar('INT-13', { numeroFactura: numeros.r1 }));
    expect(r.texto).toBe(`La R-1 (registro ${numeros.r1}) es un abono de Mayorista Turia SL que rectifica la F-1, por -121,00 €. Ha restado 121,00 € de lo pendiente de la F-1.`);
    expect(r.enlaces).toEqual([
      { texto: `Abrir el abono ${numeros.r1}`, href: `/dashboard/compras/${ids.r1}` },
      { texto: 'Abrir la factura F-1', href: `/dashboard/compras/${ids.f1}` },
    ]);
    expect(r.permisoRequerido).toBe('compras:read');
  });

  it('sin compras:read no se ve el abono (ventas solo busca entre las emitidas)', async () => {
    const r = await ejecutar('INT-13', { numeroFactura: numeros.r1 }, ['ventas']);
    expect(!r.sinPermiso && r.sinCifras).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/121,00|Mayorista/);
  });

  it('un abono a tu favor lo dice', async () => {
    const r = cifras(await ejecutar('INT-13', { numeroFactura: numeros.r2 }));
    expect(r.texto).toBe(
      `La AB-7 (registro ${numeros.r2}) es un abono de Envases del Sur SL que rectifica la S-2025/40, por -60,50 €. Te quedan 60,50 € a tu favor: pide la devolución o aplícalo a otra factura.`,
    );
    expect(r.kpis).toContainEqual({ etiqueta: 'A tu favor', valor: '60,50 €' });
  });

  it('la original: lo pendiente ya descontado, con el abono aparte (no cuenta como pagado)', async () => {
    const r = cifras(await ejecutar('INT-13', { numeroFactura: numeros.f1 }));
    expect(r.texto).toBe(
      `La factura ${numeros.f1} recibida de Mayorista Turia SL, del 01/09/2026, es de 1.210,00 €. Quedan 1.089,00 € pendientes de pago. El abono R-1 le resta 121,00 €. Venció el 01/09/2026 (hace 36 días).`,
    );
    expect(r.kpis).toEqual([
      { etiqueta: 'Total', valor: '1.210,00 €' },
      { etiqueta: 'Pagado', valor: '0,00 €', detalle: '0 pagos' },
      { etiqueta: 'Abonado', valor: '121,00 €' },
      { etiqueta: 'Pendiente', valor: '1.089,00 €' },
    ]);
  });
});
