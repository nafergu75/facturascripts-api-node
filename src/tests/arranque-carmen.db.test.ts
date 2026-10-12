/**
 * Carmen con la contabilidad de 2026 traida: lo pendiente de 2026 se suma en
 * «quién me debe» (INT-01/02) y «qué debo» (INT-06), con los mismos filtros, y
 * «¿está bien el arranque?» (INT-40) contesta con el nivel de A4.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { intencionPorId } from '../services/carmen/intenciones/catalogo';
import type { CarmenCtx, RespuestaDatos } from '../services/carmen/tipos';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga } from './fixtures/arranque/importar';

const SUFIJO = Date.now();
const E = `arr-carmen-${SUFIJO}`;
const ctx = (companyId: string, permisos: string[] = ['*'], espanola = true): CarmenCtx => ({
  companyId,
  userId: 'u-carmen',
  permisos: new Set(permisos),
  esAdminGlobal: false,
  esAdminEmpresa: permisos.includes('*'),
  puedeNominas: false,
  hoy: '2027-01-10',
  espanola,
  monedaCuenta: espanola ? 'EUR' : 'USD',
});
const conCifras = (r: RespuestaDatos) => {
  if (r.sinPermiso) throw new Error('sin permiso');
  return r;
};

beforeAll(async () => {
  await empresaDePrueba(E);
  await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
}, 120_000);

describe('lo pendiente de 2026 en las respuestas de cobros y pagos', () => {
  it('INT-02: se suma aparte, con su indicador y su enlace', async () => {
    const r = conCifras(await intencionPorId('INT-02')!.ejecutar(ctx(E), {}));
    expect(r.texto).toMatch(/De 2026 \(lo que dejó pendiente la gestoría a 31-12\) quedan 2 facturas por cobrar por 12\.100,00\s€\.$/);
    expect(r.kpis).toContainEqual({ etiqueta: 'Pendiente de 2026', valor: '12.100,00 €', detalle: '2 facturas' });
    expect(r.enlaces).toContainEqual({ texto: 'Ver lo pendiente de 2026', href: '/dashboard/contabilidad/arranque?vista=pendientes' });
  });

  it('INT-01: solo lo del cliente', async () => {
    const alfa = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '4300000001' } });
    const r = conCifras(await intencionPorId('INT-01')!.ejecutar(ctx(E), { terceroId: alfa.id }));
    expect(r.texto).toMatch(/queda 1 factura por cobrar por 6\.050,00\s€\.$/);
  });

  it('INT-06: todo, solo lo vencido y un proveedor', async () => {
    const todo = conCifras(await intencionPorId('INT-06')!.ejecutar(ctx(E), {}));
    expect(todo.texto).toMatch(/quedan 3 facturas por pagar por 5\.445,00\s€\.$/);
    // A 10-1-2027 han vencido la de Proveedor Uno (10-4-2026) y la de la luz (5-1-2027).
    const vencidas = conCifras(await intencionPorId('INT-06')!.ejecutar(ctx(E), { soloVencidas: true }));
    expect(vencidas.texto).toMatch(/quedan 2 facturas por pagar por 3\.025,00\s€\.$/);
    const dos = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, subcuenta400: '4000000002' } });
    const r = conCifras(await intencionPorId('INT-06')!.ejecutar(ctx(E), { terceroId: dos.id, rol: 'proveedor' }));
    expect(r.texto).toMatch(/queda 1 factura por pagar por 2\.420,00\s€\.$/);
  });

  it('sin permiso, nada (ni las de 2026)', async () => {
    expect(await intencionPorId('INT-06')!.ejecutar(ctx(E, ['ventas:read']), {})).toEqual({ sinPermiso: true, area: 'pagos' });
  });
});

describe('INT-40: ¿está bien el arranque?', () => {
  it('con la carga traída, contesta con su nivel y la versión', async () => {
    const r = conCifras(await intencionPorId('INT-40')!.ejecutar(ctx(E), {}));
    expect(r.texto).toMatch(/carga provisional|versión 1/);
    expect(r.kpis?.[0].etiqueta).toBe('Estado');
    expect(['Todo correcto', 'Faltan datos']).toContain(r.kpis?.[0].valor);
    expect(r.texto).toMatch(/trae el cierre definitivo/);
    expect(r.enlaces).toEqual([{ texto: 'Ir a Traer la contabilidad de 2026', href: '/dashboard/contabilidad/arranque' }]);
  });

  it('sin carga, explica qué hacer; en una empresa extranjera, que no aplica; sin Contabilidad, sin permiso', async () => {
    const otra = `arr-carmen-b-${SUFIJO}`;
    await empresaDePrueba(otra);
    const r = conCifras(await intencionPorId('INT-40')!.ejecutar(ctx(otra), {}));
    expect(r.texto).toMatch(/^Todavía no has traído la contabilidad de 2026/);
    const us = conCifras(await intencionPorId('INT-40')!.ejecutar(ctx(otra, ['*'], false), {}));
    expect(us.texto).toMatch(/no es española/);
    expect(await intencionPorId('INT-40')!.ejecutar(ctx(E, ['ventas:read']), {})).toEqual({ sinPermiso: true, area: 'contabilidad' });
  });
});
