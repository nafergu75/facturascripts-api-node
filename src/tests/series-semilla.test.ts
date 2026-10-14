// Series que se crean solas (seriesSemilla.service), sin BD: una tabla
// InvoiceSeries en memoria con el unico (empresa, codigo) y el upsert de Prisma,
// y unas facturas (para las series historicas del lector).
// La prueba contra MySQL real esta en series-ceramica.db.test.ts.
jest.mock('../config/database', () => {
  type Fila = { companyId: string; codigo: string; descripcion: string; tipoDocumento: string; activa: boolean; porDefecto: boolean; plantilla: string | null };
  type Factura = { companyId: string; serie: string; origen: string | null };
  const filas: Fila[] = [];
  const facturas: Factura[] = [];
  const clave = (w: { companyId_codigo: { companyId: string; codigo: string } }) => (f: Fila) =>
    f.companyId === w.companyId_codigo.companyId && f.codigo === w.companyId_codigo.codigo;
  return {
    prisma: {
      __filas: filas,
      __facturas: facturas,
      incomeInvoice: {
        // Con readerDocument en el filtro, solo las de la app (tieneFacturasDeLaApp); sin el, todas.
        count: jest.fn(async ({ where }: { where: { companyId: string; serie: string; readerDocument?: unknown } }) =>
          facturas.filter((f) => f.companyId === where.companyId && f.serie === where.serie && (!where.readerDocument || f.origen !== 'lector')).length,
        ),
      },
      invoiceSeries: {
        findMany: jest.fn(async ({ where }: { where: { companyId: string } }) => filas.filter((f) => f.companyId === where.companyId).map((f) => ({ ...f }))),
        findUnique: jest.fn(async ({ where }: { where: { companyId_codigo: { companyId: string; codigo: string } } }) => {
          const f = filas.find(clave(where));
          return f ? { ...f } : null;
        }),
        upsert: jest.fn(
          async ({ where, create }: { where: { companyId_codigo: { companyId: string; codigo: string } }; create: Omit<Fila, 'plantilla'> & { plantilla?: string | null } }) => {
            const ya = filas.find(clave(where));
            if (ya) return { ...ya };
            const nueva = { plantilla: null, ...create };
            filas.push(nueva);
            return { ...nueva };
          },
        ),
      },
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { estadoSerieCeramica, prepararSerieCeramica, sembrarSeries, SERIE_B } from '../services/seriesSemilla.service';

type Fila = { companyId: string; codigo: string; descripcion: string; tipoDocumento: string; activa: boolean; porDefecto: boolean; plantilla: string | null };
const bd = prisma as unknown as {
  __filas: Fila[];
  __facturas: Array<{ companyId: string; serie: string; origen: string | null }>;
  invoiceSeries: { upsert: jest.Mock; findMany: jest.Mock };
};
const filas = bd.__filas;
const deEmpresa = (companyId: string) => filas.filter((f) => f.companyId === companyId);
const codigos = (companyId: string) => deEmpresa(companyId).map((f) => f.codigo);
const serie = (companyId: string, codigo: string) => filas.find((f) => f.companyId === companyId && f.codigo === codigo);
const alta = (companyId: string, codigo: string, tipoDocumento: string, extra: Partial<Fila> = {}) =>
  filas.push({ companyId, codigo, descripcion: codigo, tipoDocumento, activa: true, porDefecto: false, plantilla: null, ...extra });

const si = async () => true;
const no = async () => false;

describe('semilla de series', () => {
  it('empresa nueva que no vende cerámica: A (predeterminada), R, P y C, sin B', async () => {
    const conSerieB = jest.fn(no);
    expect(await sembrarSeries('e-nueva', conSerieB)).toEqual({ serieBCreada: false });
    expect(codigos('e-nueva')).toEqual(['A', 'R', 'P', 'C']);
    expect(serie('e-nueva', 'A')).toMatchObject({ tipoDocumento: 'FACTURA', activa: true, porDefecto: true });
    expect(conSerieB).toHaveBeenCalledTimes(1);
  });

  it('empresa nueva que marca «Vendo cerámica» antes de nada: primero la A (predeterminada) y después la B, activa, no predeterminada y sin plantilla elegida', async () => {
    const r = await prepararSerieCeramica('e-ceramica');
    expect(r).toEqual({ codigo: 'B', estado: 'creada', aviso: null });
    expect(codigos('e-ceramica')).toEqual(['A', 'R', 'P', 'C', 'B']);
    expect(serie('e-ceramica', 'A')).toMatchObject({ porDefecto: true, activa: true });
    expect(serie('e-ceramica', 'B')).toMatchObject({
      descripcion: 'Cerámica y materiales de construcción',
      tipoDocumento: 'FACTURA',
      activa: true,
      porDefecto: false,
      plantilla: null,
    });
    expect(SERIE_B.descripcion).toBe('Cerámica y materiales de construcción');
  });

  it('idempotente: otra vez no crea nada, no vuelve a preguntar y la B queda «activa»', async () => {
    const conSerieB = jest.fn(si);
    const antes = deEmpresa('e-ceramica').length;
    expect(await sembrarSeries('e-ceramica', conSerieB)).toEqual({ serieBCreada: false });
    expect(conSerieB).not.toHaveBeenCalled();
    expect(await prepararSerieCeramica('e-ceramica')).toEqual({ codigo: 'B', estado: 'activa', aviso: null });
    expect(deEmpresa('e-ceramica')).toHaveLength(antes);
  });

  it('empresa de antes con su A, R y P: recibe la C y la B sin tocar la A', async () => {
    alta('e-vieja', 'A', 'FACTURA', { porDefecto: true });
    alta('e-vieja', 'R', 'RECTIFICATIVA', { porDefecto: true });
    alta('e-vieja', 'P', 'PROFORMA', { porDefecto: true });
    expect(await sembrarSeries('e-vieja', si)).toEqual({ serieBCreada: true });
    expect(codigos('e-vieja')).toEqual(['A', 'R', 'P', 'C', 'B']);
    expect(serie('e-vieja', 'A')).toMatchObject({ porDefecto: true });
    expect(serie('e-vieja', 'B')).toMatchObject({ porDefecto: false, activa: true });
  });

  it('la B desactivada no se activa: aviso para activarla en Configuración > Series', async () => {
    alta('e-bdes', 'A', 'FACTURA', { porDefecto: true });
    alta('e-bdes', 'B', 'FACTURA', { activa: false });
    const r = await prepararSerieCeramica('e-bdes');
    expect(r).toMatchObject({ codigo: 'B', estado: 'desactivada' });
    expect(r.aviso).toMatch(/desactivada.*actívala en Configuración > Series/);
    expect(serie('e-bdes', 'B')).toMatchObject({ activa: false });
    expect(await estadoSerieCeramica('e-bdes')).toEqual(r);
  });

  it('la B histórica del lector (desactivada, con facturas de otro programa) no se activa: aviso para crear otra serie, no para activarla', async () => {
    alta('e-bhist', 'A', 'FACTURA', { porDefecto: true });
    alta('e-bhist', 'B', 'FACTURA', { activa: false, descripcion: 'Serie B (facturas de otro programa)' });
    bd.__facturas.push({ companyId: 'e-bhist', serie: 'B', origen: 'lector' });
    const r = await prepararSerieCeramica('e-bhist');
    expect(r).toMatchObject({ codigo: 'B', estado: 'historica' });
    expect(r.aviso).toMatch(/facturas de otro programa.*No la actives.*crea en Configuración > Series una serie de facturas con otro código/);
    expect(r.aviso).not.toMatch(/actívala/);
    expect(serie('e-bhist', 'B')).toMatchObject({ activa: false });
    expect(await estadoSerieCeramica('e-bhist')).toEqual(r);
    // Si la app ya emitió alguna en la B, no es histórica: es una serie de la empresa desactivada.
    bd.__facturas.push({ companyId: 'e-bhist', serie: 'B', origen: null });
    expect(await estadoSerieCeramica('e-bhist')).toMatchObject({ estado: 'desactivada' });
  });

  it('el código B de otro tipo no se toca: aviso para crear otra serie de facturas con la plantilla B', async () => {
    alta('e-botro', 'B', 'PROFORMA');
    const r = await prepararSerieCeramica('e-botro');
    expect(r).toMatchObject({ codigo: 'B', estado: 'otroTipo' });
    expect(r.aviso).toMatch(/tu serie de proformas.*crea en Configuración > Series una serie de facturas/);
    expect(serie('e-botro', 'B')).toMatchObject({ tipoDocumento: 'PROFORMA' });
    // La A se crea igual (no habia ninguna serie de facturas).
    expect(serie('e-botro', 'A')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: true });
  });

  it('la B con otra plantilla elegida no se cambia: aviso para ponerle la automática o la B', async () => {
    alta('e-botra', 'A', 'FACTURA', { porDefecto: true });
    alta('e-botra', 'B', 'FACTURA', { plantilla: 'default' });
    const r = await prepararSerieCeramica('e-botra');
    expect(r).toMatchObject({ codigo: 'B', estado: 'otraPlantilla' });
    expect(r.aviso).toMatch(/elegida la Estándar.*«Automática» o la «Plantilla B \(cerámica\)»/);
    expect(serie('e-botra', 'B')).toMatchObject({ plantilla: 'default' });
    // Con la B elegida a mano, todo bien.
    serie('e-botra', 'B')!.plantilla = 'B';
    expect(await estadoSerieCeramica('e-botra')).toEqual({ codigo: 'B', estado: 'activa', aviso: null });
  });

  it('sin la B y sin crearla (solo leer): «pendiente»', async () => {
    const upserts = bd.invoiceSeries.upsert.mock.calls.length;
    expect(await estadoSerieCeramica('e-sin-nada')).toEqual({ codigo: 'B', estado: 'pendiente', aviso: null });
    expect(bd.invoiceSeries.upsert.mock.calls.length).toBe(upserts);
    expect(codigos('e-sin-nada')).toEqual([]);
  });

  it('dos a la vez: una sola B (upsert por empresa y código)', async () => {
    await Promise.all([prepararSerieCeramica('e-carrera'), prepararSerieCeramica('e-carrera'), sembrarSeries('e-carrera', si)]);
    expect(codigos('e-carrera').filter((c) => c === 'B')).toHaveLength(1);
    expect(codigos('e-carrera').filter((c) => c === 'A')).toHaveLength(1);
  });

  it('carrera como en MySQL (el upsert lee y después inserta): si otra petición ya las creó, P2002 y se usa la suya', async () => {
    // La otra petición ya ha creado todas las series; esta leyó la lista antes (vacía) y su upsert choca con el único.
    alta('e-mysql', 'A', 'FACTURA', { porDefecto: true });
    alta('e-mysql', 'R', 'RECTIFICATIVA', { porDefecto: true });
    alta('e-mysql', 'P', 'PROFORMA', { porDefecto: true });
    alta('e-mysql', 'C', 'FACTURA');
    alta('e-mysql', 'B', 'FACTURA', { descripcion: SERIE_B.descripcion });
    bd.invoiceSeries.findMany.mockResolvedValueOnce([]);
    const atomico = bd.invoiceSeries.upsert.getMockImplementation()!;
    bd.invoiceSeries.upsert.mockImplementation(async ({ where }: { where: { companyId_codigo: { companyId: string; codigo: string } } }) => {
      if (filas.some((f) => f.companyId === where.companyId_codigo.companyId && f.codigo === where.companyId_codigo.codigo)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: InvoiceSeries_companyId_codigo_key', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      throw new Error('no debería crear nada');
    });
    try {
      const r = await prepararSerieCeramica('e-mysql');
      // La B la creó la otra a la vez: las dos lo dicen.
      expect(r).toEqual({ codigo: 'B', estado: 'creada', aviso: null });
      expect(codigos('e-mysql')).toEqual(['A', 'R', 'P', 'C', 'B']);
    } finally {
      bd.invoiceSeries.upsert.mockImplementation(atomico);
    }
  });

  it('cualquier otro error al crear una serie no se esconde', async () => {
    bd.invoiceSeries.upsert.mockRejectedValueOnce(new Error('timeout'));
    await expect(sembrarSeries('e-error', no)).rejects.toThrow('timeout');
  });
});
