// Tesoreria analitica: categorias, categorizar, parecidos, reglas y desglose.
type Mov = { id: string; companyId: string; concepto: string; importe: number; categoriaId: string | null; ivaPorcentaje: number | null; ignorado: boolean };
type Cat = { id: string; companyId: string; tipo: string; nombre: string; color: string; parentId: string | null; ivaPorcentaje: number | null; activa: boolean; orden: number; createdAt: Date };
type Parte = { id: string; movementId: string; importe: number; categoriaId: string | null };
type Regla = { companyId: string; tipo: string; clave: string; categoriaId: string };

const db = { movs: [] as Mov[], cats: [] as Cat[], partes: [] as Parte[], reglas: [] as Regla[] };
let sec = 0;

function cumple(m: Mov, w: Record<string, unknown>): boolean {
  if (w.companyId && m.companyId !== w.companyId) return false;
  if ('categoriaId' in w && w.categoriaId === null && m.categoriaId !== null) return false;
  if (w.ignorado !== undefined && m.ignorado !== w.ignorado) return false;
  if (w.id && typeof w.id === 'object' && 'not' in (w.id as object) && m.id === (w.id as { not: string }).not) return false;
  if (w.id && typeof w.id === 'object' && 'in' in (w.id as object) && !(w.id as { in: string[] }).in.includes(m.id)) return false;
  const imp = w.importe as { gte?: number; lt?: number } | undefined;
  if (imp?.gte !== undefined && !(m.importe >= imp.gte)) return false;
  if (imp?.lt !== undefined && !(m.importe < imp.lt)) return false;
  if ((w.partes as { none?: object } | undefined)?.none && db.partes.some((p) => p.movementId === m.id)) return false;
  return true;
}

jest.mock('../config/database', () => {
  const conPartes = (m: Mov | undefined) => m && { ...m, partes: db.partes.filter((p) => p.movementId === m.id) };
  const prisma = {
    treasuryCategory: {
      count: jest.fn(async ({ where }: { where: Partial<Cat> }) =>
        db.cats.filter((c) => c.companyId === where.companyId && (where.tipo === undefined || c.tipo === where.tipo) && (!('parentId' in where) || c.parentId === where.parentId)).length,
      ),
      create: jest.fn(async ({ data }: { data: Partial<Cat> }) => {
        const c = { id: `cat${++sec}`, parentId: null, ivaPorcentaje: null, activa: true, orden: 0, createdAt: new Date(), ...data } as Cat;
        db.cats.push(c);
        return c;
      }),
      findMany: jest.fn(async ({ where }: { where: { companyId?: string; parentId?: string } }) =>
        db.cats.filter((c) => (where.companyId === undefined || c.companyId === where.companyId) && (where.parentId === undefined || c.parentId === where.parentId)),
      ),
      findFirst: jest.fn(async ({ where }: { where: Partial<Cat> & { NOT?: { id: string } } }) =>
        db.cats.find(
          (c) =>
            c.companyId === where.companyId &&
            (where.id === undefined || c.id === where.id) &&
            (where.nombre === undefined || c.nombre === where.nombre) &&
            (where.tipo === undefined || c.tipo === where.tipo) &&
            (!('parentId' in where) || c.parentId === where.parentId) &&
            (!where.NOT || c.id !== where.NOT.id),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Cat> }) => Object.assign(db.cats.find((c) => c.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Cat> }) => {
        db.cats.filter((c) => where.id.in.includes(c.id)).forEach((c) => Object.assign(c, data));
        return { count: 1 };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        db.cats = db.cats.filter((c) => c.id !== where.id && c.parentId !== where.id);
        return {};
      }),
    },
    bankMovement: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; companyId: string } }) =>
        conPartes(db.movs.find((m) => m.id === where.id && m.companyId === where.companyId)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => db.movs.filter((m) => cumple(m, where))),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Mov> }) => Object.assign(db.movs.find((m) => m.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Mov> }) => {
        db.movs.filter((m) => cumple(m, where)).forEach((m) => Object.assign(m, data));
        return { count: 1 };
      }),
      count: jest.fn(async ({ where }: { where: { categoriaId: { in: string[] } } }) => db.movs.filter((m) => m.categoriaId && where.categoriaId.in.includes(m.categoriaId)).length),
    },
    bankMovementSplit: {
      count: jest.fn(async ({ where }: { where: { categoriaId: { in: string[] } } }) => db.partes.filter((p) => p.categoriaId && where.categoriaId.in.includes(p.categoriaId)).length),
      deleteMany: jest.fn(async ({ where }: { where: { movementId: string } }) => {
        db.partes = db.partes.filter((p) => p.movementId !== where.movementId);
        return {};
      }),
      create: jest.fn(async ({ data }: { data: Omit<Parte, 'id'> }) => {
        const p = { id: `p${++sec}`, ...data };
        db.partes.push(p);
        return p;
      }),
    },
    treasuryCategoryRule: {
      upsert: jest.fn(async ({ create }: { create: Regla }) => {
        db.reglas = db.reglas.filter((r) => !(r.companyId === create.companyId && r.tipo === create.tipo && r.clave === create.clave));
        db.reglas.push(create);
        return create;
      }),
      findMany: jest.fn(async ({ where }: { where: { companyId: string } }) =>
        db.reglas.filter((r) => r.companyId === where.companyId).map((r) => ({ ...r, categoria: db.cats.find((c) => c.id === r.categoriaId)! })),
      ),
    },
    // Lote de operaciones: ya se han ejecutado al construir el array.
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma };
});

import * as t from '../services/tesoreriaCategorias.service';

const mov = (id: string, concepto: string, importe: number, companyId = 'e1'): Mov => {
  const m = { id, companyId, concepto, importe, categoriaId: null, ivaPorcentaje: null, ignorado: false };
  db.movs.push(m);
  return m;
};
const cat = (nombre: string, tipo = 'GASTO') => db.cats.find((c) => c.nombre === nombre && c.tipo === tipo)!;

beforeEach(async () => {
  db.movs = [];
  db.cats = [];
  db.partes = [];
  db.reglas = [];
  await t.asegurarCategorias('e1');
});

describe('clave del concepto', () => {
  it('quita numeros, fechas y relleno de los bancos', () => {
    expect(t.claveConcepto('RECIBO AGUA 03/26 REF.4471')).toBe('agua');
    expect(t.claveConcepto('Agua mayo')).toBe('agua');
    expect(t.claveConcepto('TRANSF. A FAVOR DE ENDESA ENERGIA SA')).toBe('endesa energia');
    expect(t.claveConcepto('12/05 1234')).toBe('');
  });
});

describe('categorias', () => {
  it('cada empresa empieza con la plantilla, con subcategorias', async () => {
    const arbol = await t.listarCategorias('e1');
    expect(arbol.filter((c) => c.tipo === 'INGRESO').map((c) => c.nombre)).toContain('Ventas');
    expect(arbol.find((c) => c.nombre === 'Operación')!.hijas.map((h) => h.nombre)).toContain('Suministros');
  });

  it('una subcategoria hereda tipo y color, y no admite nietas', async () => {
    const op = cat('Operación');
    const h = await t.crearCategoria('e1', { nombre: 'Limpieza', parentId: op.id });
    expect(h).toMatchObject({ tipo: 'GASTO', color: op.color, parentId: op.id });
    await expect(t.crearCategoria('e1', { nombre: 'Nieta', parentId: h.id })).rejects.toThrow(/subcategorías/);
    await expect(t.crearCategoria('e1', { nombre: 'Limpieza', parentId: op.id })).rejects.toThrow(/Ya hay/);
  });

  it('borrar una categoria usada la archiva en vez de borrarla', async () => {
    const m = mov('m1', 'Facebook ads', -50);
    m.categoriaId = cat('Marketing').id;
    await expect(t.borrarCategoria('e1', cat('Marketing').id)).resolves.toEqual({ borrada: false, archivada: true });
    await expect(t.borrarCategoria('e1', cat('Comercial').id)).resolves.toEqual({ borrada: true, archivada: false });
  });
});

describe('categorizar', () => {
  it('ofrece los parecidos y, al aceptar, los categoriza y recuerda la regla', async () => {
    mov('a1', 'RECIBO AGUA 03/26', -120);
    mov('a2', 'Recibo agua 04/26', -118.4);
    mov('a3', 'AGUA mayo', -121);
    mov('c1', 'Cobro agua (devolución)', 30); // cobro: no es parecido de un pago
    const sum = cat('Suministros');
    const r = await t.categorizarMovimiento('e1', 'a1', { categoriaId: sum.id });
    expect(r).toMatchObject({ similares: 2, clave: 'agua' });

    const s = await t.aplicarASimilares('e1', 'a1');
    expect(s).toMatchObject({ actualizados: 2, reglaGuardada: true });
    expect(db.movs.filter((m) => m.categoriaId === sum.id).map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(db.movs.find((m) => m.id === 'c1')!.categoriaId).toBeNull();

    // El proximo extracto se categoriza solo.
    const nuevo = mov('a4', 'RECIBO AGUA 06/26', -119);
    await expect(t.aplicarReglas('e1', [nuevo])).resolves.toBe(1);
    expect(nuevo.categoriaId).toBe(sum.id);
  });

  it('un cobro no va a una categoria de gastos', async () => {
    mov('c1', 'Transferencia cliente', 1210);
    await expect(t.categorizarMovimiento('e1', 'c1', { categoriaId: cat('Proveedores').id })).rejects.toThrow(/categoría de ingresos/);
  });

  it('no toca movimientos ni categorias de otra empresa', async () => {
    mov('x1', 'Agua', -10, 'e2');
    await expect(t.categorizarMovimiento('e1', 'x1', { categoriaId: cat('Suministros').id })).rejects.toThrow(/no encontrado/);
  });
});

describe('desglose', () => {
  it('las partes tienen que sumar el importe al centimo', async () => {
    mov('s1', 'Software oficina', -320);
    await expect(
      t.desglosarMovimiento('e1', 's1', [
        { importe: -160, categoriaId: cat('Marketing').id },
        { importe: -159.99, categoriaId: cat('Comercial').id },
      ]),
    ).rejects.toThrow(/suman -319.99/);
    const r = await t.desglosarMovimiento('e1', 's1', [
      { importe: -160, categoriaId: cat('Marketing').id },
      { importe: -160, categoriaId: cat('Comercial').id },
    ]);
    expect(r.partes).toHaveLength(2);
    await expect(t.categorizarMovimiento('e1', 's1', { categoriaId: cat('Marketing').id })).rejects.toThrow(/desglosado/);
    await t.deshacerDesglose('e1', 's1');
    expect(db.partes).toHaveLength(0);
  });

  it('las partes llevan el mismo signo que el movimiento', async () => {
    mov('s2', 'Pago', -100);
    await expect(t.desglosarMovimiento('e1', 's2', [{ importe: -150 }, { importe: 50 }])).rejects.toThrow(/mismo signo/);
  });
});
