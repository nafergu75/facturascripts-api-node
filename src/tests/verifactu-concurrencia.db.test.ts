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
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import { comprobarCadena } from '../services/verifactu/cadena';
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
beforeAll(async () => {
  A = await empresa();
  B = await empresa();
  C = await empresa();
  D = await empresa();
});

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
