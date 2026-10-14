/**
 * VERI*FACTU F1: emisiones a la vez en la misma empresa (spec verifactu, 3.2 y
 * 12.2). La cabeza de la cadena se bloquea despues de la serie: los numeros
 * son correlativos y la cadena no se bifurca ni deja huecos.
 *
 * Tambien se pasa con DATABASE_URL ...?connection_limit=1&pool_timeout=5 (una
 * sola conexion, como en Vercel): las emisiones se encolan. La prueba de las 20
 * emisiones solo se hace con varias conexiones (con una, pool_timeout las cortaria).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import * as cadenaMod from '../services/verifactu/cadena';
import { comprobarCadena } from '../services/verifactu/cadena';
import { instanteDeHuso } from '../services/verifactu/formato';
import { hoyEspana } from '../utils/fechas';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const HOY = hoyEspana();
const UNA_CONEXION = /connection_limit=1(\D|$)/.test(process.env.DATABASE_URL ?? '');
const clientes: Record<string, string> = {};

function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}

let n = 0;
async function empresa(): Promise<string> {
  const id = `vfconc-${SUFIJO}-${++n}`;
  await prisma.company.create({ data: { id, name: `Concurrencia ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, tipoSociedad: 'SL', denominacion: `Concurrencia ${n} SL`, nif: cifSl() } });
  await listarSeries(id);
  await prisma.invoiceSeries.create({ data: { companyId: id, codigo: 'B', descripcion: 'Serie B', tipoDocumento: 'FACTURA', activa: true } });
  await prisma.verifactuConfig.create({ data: { companyId: id, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  clientes[id] = (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'Cliente SL', nifCif: 'B12345674', pais: 'ES' } })).id;
  return id;
}

const linea = (precio = 100) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const emitir = (companyId: string, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: clientes[companyId] }, fechaEmision: HOY, lineas: [linea()], ...extra } as CrearFacturaIngresoDTO);
const cadena = (companyId: string) => prisma.verifactuRegistro.findMany({ where: { companyId }, orderBy: { numeroEnCadena: 'asc' } });

let A = '';
let B = '';
let C = '';
let D = '';
let F = '';
let G = '';
let H = '';
beforeAll(async () => {
  A = await empresa();
  B = await empresa();
  C = await empresa();
  D = await empresa();
  F = await empresa();
  G = await empresa();
  H = await empresa();
});

const finalizar = (companyId: string, id: string) => incomeInvoicesService.finalizar(companyId, id, { fechaEmision: HOY });
const rectificar = (companyId: string, originalId: string) =>
  incomeInvoicesService.crearIngreso({
    companyId,
    customer: {},
    fechaEmision: HOY,
    lineas: [linea(-10)],
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: originalId }] },
  } as unknown as CrearFacturaIngresoDTO);

describe('emisiones a la vez en la misma empresa', () => {
  it('dos emisiones directas en la misma serie: números n y n+1, registros 1 y 2 y la cadena bien', async () => {
    const [x, y] = await Promise.all([emitir(A), emitir(A)]);
    expect([x.numero, y.numero].sort()).toEqual([1, 2]);
    const rs = await cadena(A);
    expect(rs.map((r) => r.numeroEnCadena)).toEqual([1, 2]);
    expect(new Set(rs.map((r) => r.incomeInvoiceId))).toEqual(new Set([x.id, y.id]));
    expect(comprobarCadena(rs)).toEqual([]);
    // El orden de la cadena es el de los numeros de la serie (la serie se bloquea antes que la cadena).
    const porFactura = new Map([x, y].map((f) => [f.id, f.numero]));
    expect(rs.map((r) => porFactura.get(r.incomeInvoiceId))).toEqual([1, 2]);
  });

  it('una factura (serie A) y una rectificativa (serie R) a la vez: dos registros encadenados', async () => {
    const o = await emitir(B, { lineas: [linea(1000)] });
    const [f, r] = await Promise.all([
      emitir(B),
      incomeInvoicesService.crearIngreso({
        companyId: B,
        customer: {},
        fechaEmision: HOY,
        lineas: [linea(-100)],
        rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: o.id }] },
      } as unknown as CrearFacturaIngresoDTO),
    ]);
    expect(f.serie).toBe('A');
    expect(r.serie).toBe('R');
    const rs = await cadena(B);
    expect(rs.map((x) => x.numeroEnCadena)).toEqual([1, 2, 3]);
    expect(comprobarCadena(rs)).toEqual([]);
  });

  it('dos finalizar del mismo borrador a la vez: uno emite, el otro 400 y un solo registro', async () => {
    const b = await emitir(C, { borrador: true });
    const resultados = await Promise.allSettled([incomeInvoicesService.finalizar(C, b.id, { fechaEmision: HOY }), incomeInvoicesService.finalizar(C, b.id, { fechaEmision: HOY })]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const fallo = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(fallo.reason).toMatchObject({ statusCode: 400 });
    const rs = await cadena(C);
    expect(rs).toHaveLength(1);
    expect(rs[0].incomeInvoiceId).toBe(b.id);
    expect((await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: C, codigo: 'A' } } })).ultimoNumero).toBe(1);
  });

  it('dos borradores de las series A y B finalizados a la vez, cinco veces: sin interbloqueo y la cadena bien', async () => {
    // La inmutabilidad filtra por la columna de la propia factura (verifactuEstado),
    // sin subconsulta a VerifactuRegistro: antes, en MariaDB/MySQL, ese filtro
    // dejaba un bloqueo en VerifactuRegistro antes de bloquear la cadena (1213).
    for (let ronda = 1; ronda <= 5; ronda++) {
      const a = await emitir(F, { borrador: true, serie: 'A' });
      const b = await emitir(F, { borrador: true, serie: 'B' });
      const resultados = await Promise.allSettled([finalizar(F, a.id), finalizar(F, b.id)]);
      expect(resultados.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : 'ok'))).toEqual(['ok', 'ok']);
    }
    const rs = await cadena(F);
    expect(rs.map((r) => r.numeroEnCadena)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(comprobarCadena(rs)).toEqual([]);
  });

  (UNA_CONEXION ? it.skip : it)('crear, finalizar y rectificativas mezclados a la vez: todas se emiten y la cadena bien', async () => {
    const borradores = [];
    for (let i = 0; i < 6; i++) borradores.push(await emitir(G, { borrador: true, serie: i % 2 ? 'B' : 'A' }));
    const originales = [];
    for (let i = 0; i < 3; i++) originales.push(await emitir(G, { lineas: [linea(1000)] }));
    const resultados = await Promise.allSettled([
      ...borradores.map((b) => finalizar(G, b.id)),
      ...Array.from({ length: 6 }, (_, i) => emitir(G, { serie: i % 2 ? 'B' : 'A' })),
      ...originales.map((o) => rectificar(G, o.id)),
    ]);
    expect(resultados.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message))).toEqual([]);
    const rs = await cadena(G);
    expect(rs.map((r) => r.numeroEnCadena)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(comprobarCadena(rs)).toEqual([]);
    const series = await prisma.invoiceSeries.findMany({ where: { companyId: G }, select: { codigo: true, ultimoNumero: true } });
    expect(Object.fromEntries(series.map((x) => [x.codigo, x.ultimoNumero]))).toMatchObject({ A: 9, B: 6, R: 3 });
  });

  it('la fecha y hora del registro se toma después de conseguir la cadena, no antes de esperarla', async () => {
    await emitir(H);
    // La espera a la cadena (otra emision la tiene) se simula con un retraso de 2,5 s al bloquearla.
    const real = cadenaMod.bloquearCadena;
    const espia = jest.spyOn(cadenaMod, 'bloquearCadena').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await new Promise((r) => setTimeout(r, 2500));
      return real(...args);
    });
    const antes = Date.now();
    const f = await emitir(H);
    espia.mockRestore();
    const r = (await cadena(H)).find((x) => x.incomeInvoiceId === f.id)!;
    // FechaHoraHusoGenRegistro va en segundos: el instante es el de despues de la espera.
    expect(instanteDeHuso(r.fechaHoraHuso).getTime()).toBeGreaterThanOrEqual(antes + 2500 - 1000);
  });

  (UNA_CONEXION ? it.skip : it)('20 emisiones a la vez en dos series: registros 1..20 sin huecos y la cadena bien', async () => {
    const emisiones = Array.from({ length: 20 }, (_, i) => emitir(D, { serie: i % 2 ? 'B' : 'A' }));
    const facturas = await Promise.all(emisiones);
    expect(facturas.filter((f) => f.serie === 'A').map((f) => f.numero).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(facturas.filter((f) => f.serie === 'B').map((f) => f.numero).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rs = await cadena(D);
    expect(rs.map((r) => r.numeroEnCadena)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(rs.map((r) => r.incomeInvoiceId)).size).toBe(20);
    expect(comprobarCadena(rs)).toEqual([]);
    const cabeza = await prisma.verifactuCadena.findUniqueOrThrow({ where: { companyId_entorno: { companyId: D, entorno: 'PRUEBAS' } } });
    expect(cabeza).toMatchObject({ numRegistros: 20, ultimoRegistroId: rs[19].id, ultimaHuella: rs[19].huella });
  });
});
