// Catalogo de productos por codigos y familias, e importacion desde Excel.
type Prod = { id: string; companyId: string; referencia: string; descripcion: string | null; precio: number; ivaPorcentaje: number; familiaId: string | null; bloqueado: boolean; tipo: string; unidad: string; stock: number; precioCompra: number | null; cuentaVentas: string | null; notas: string | null };
type Fam = { id: string; companyId: string; codigo: string; nombre: string; ivaPorcentaje: number | null; cuentaVentas: string | null; parentId: string | null; activa: boolean };

const db = { prods: [] as Prod[], fams: [] as Fam[], lineasConProducto: [] as string[] };
let sec = 0;
const conFamilia = (p: Prod) => ({ ...p, familia: db.fams.find((f) => f.id === p.familiaId) ?? null });

jest.mock('../config/database', () => ({
  prisma: {
    product: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; companyId: string; referencia?: string; NOT?: { id: string } } }) =>
        db.prods.find((p) => p.companyId === where.companyId && (where.id === undefined || p.id === where.id) && (where.referencia === undefined || p.referencia === where.referencia) && (!where.NOT || p.id !== where.NOT.id)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { companyId: string; referencia?: { startsWith?: string; in?: string[] } } }) =>
        db.prods.filter(
          (p) =>
            p.companyId === where.companyId &&
            (!where.referencia?.startsWith || p.referencia.startsWith(where.referencia.startsWith)) &&
            (!where.referencia?.in || where.referencia.in.includes(p.referencia)),
        ).map(conFamilia),
      ),
      create: jest.fn(async ({ data }: { data: Partial<Prod> }) => {
        const p = { id: `p${++sec}`, descripcion: null, precio: 0, ivaPorcentaje: 21, familiaId: null, bloqueado: false, tipo: 'PRODUCTO', unidad: 'ud', stock: 0, precioCompra: null, cuentaVentas: null, notas: null, ...data } as Prod;
        db.prods.push(p);
        return conFamilia(p);
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Prod> }) => conFamilia(Object.assign(db.prods.find((p) => p.id === where.id)!, data))),
      upsert: jest.fn(async ({ where, update, create }: { where: { companyId_referencia: { companyId: string; referencia: string } }; update: Partial<Prod>; create: Partial<Prod> }) => {
        const k = where.companyId_referencia;
        const p = db.prods.find((x) => x.companyId === k.companyId && x.referencia === k.referencia);
        if (p) return Object.assign(p, update);
        const n = { id: `p${++sec}`, descripcion: null, precio: 0, ivaPorcentaje: 21, familiaId: null, bloqueado: false, tipo: 'PRODUCTO', unidad: 'ud', stock: 0, precioCompra: null, cuentaVentas: null, notas: null, ...create } as Prod;
        db.prods.push(n);
        return n;
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        db.prods = db.prods.filter((p) => p.id !== where.id);
        return {};
      }),
    },
    productFamily: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; companyId: string; codigo?: string; NOT?: { id: string } } }) => {
        const f = db.fams.find((x) => x.companyId === where.companyId && (where.id === undefined || x.id === where.id) && (where.codigo === undefined || x.codigo === where.codigo) && (!where.NOT || x.id !== where.NOT.id));
        return f ? { ...f, _count: { productos: db.prods.filter((p) => p.familiaId === f.id).length, hijas: db.fams.filter((h) => h.parentId === f.id).length } } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { companyId: string } }) => db.fams.filter((f) => f.companyId === where.companyId)),
      create: jest.fn(async ({ data }: { data: Partial<Fam> }) => {
        const f = { id: `f${++sec}`, ivaPorcentaje: null, cuentaVentas: null, parentId: null, activa: true, ...data } as Fam;
        db.fams.push(f);
        return f;
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        db.fams = db.fams.filter((f) => f.id !== where.id);
        return {};
      }),
    },
    incomeInvoiceLine: { count: jest.fn(async ({ where }: { where: { productoServicioId: string } }) => db.lineasConProducto.filter((id) => id === where.productoServicioId).length) },
  },
}));

import * as XLSX from 'xlsx';
import { borrarFamilia, crearFamilia, importarProductos, leerProductosArchivo, productosService, siguienteCodigo } from '../services/productos.service';

function excel(filas: unknown[][]): Buffer {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Catalogo');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

beforeEach(() => {
  db.prods = [];
  db.fams = [];
  db.lineasConProducto = [];
});

describe('productos y familias', () => {
  it('un producto nuevo toma el IVA de su familia y se contabiliza en su cuenta', async () => {
    const f = await crearFamilia('e1', { codigo: '01', nombre: 'Bebidas', ivaPorcentaje: 10, cuentaVentas: '7000001' });
    const p = (await productosService.create('e1', { referencia: '01001', descripcion: 'Agua 1,5 l', precio: 0.8, familiaId: f.id })) as Record<string, unknown>;
    expect(p).toMatchObject({ ivaPorcentaje: 10, cuentaVentasEfectiva: '7000001', familia: { codigo: '01', nombre: 'Bebidas' } });
  });

  it('propone el siguiente codigo libre de la familia', async () => {
    const f = await crearFamilia('e1', { codigo: '01', nombre: 'Bebidas' });
    await productosService.create('e1', { referencia: '01001', descripcion: 'Agua', familiaId: f.id });
    await productosService.create('e1', { referencia: '01002', descripcion: 'Zumo', familiaId: f.id });
    await expect(siguienteCodigo('e1', f.id)).resolves.toBe('01003');
    await expect(siguienteCodigo('e1')).resolves.toBe('P0001');
  });

  it('no admite codigos repetidos ni cuentas de ventas fuera del grupo 7', async () => {
    await productosService.create('e1', { referencia: 'A1', descripcion: 'Uno' });
    await expect(productosService.create('e1', { referencia: 'A1', descripcion: 'Otro' })).rejects.toThrow(/Ya hay un producto/);
    await expect(productosService.create('e1', { referencia: 'A2', descripcion: 'X', cuentaVentas: '600' })).rejects.toThrow(/grupo 7/);
    await expect(crearFamilia('e1', { codigo: 'mal código', nombre: 'X' })).rejects.toThrow(/letras o números/);
  });

  it('un producto ya facturado se da de baja en vez de borrarse', async () => {
    const p = (await productosService.create('e1', { referencia: 'A1', descripcion: 'Uno' })) as { id: string };
    db.lineasConProducto.push(p.id);
    await productosService.remove('e1', p.id);
    expect(db.prods[0]).toMatchObject({ bloqueado: true });
  });

  it('no se borra una familia con productos', async () => {
    const f = await crearFamilia('e1', { codigo: '01', nombre: 'Bebidas' });
    await productosService.create('e1', { referencia: '01001', descripcion: 'Agua', familiaId: f.id });
    await expect(borrarFamilia('e1', f.id)).rejects.toThrow(/tiene productos/);
  });
});

describe('importar catalogo desde Excel', () => {
  const CATALOGO = [
    ['Tarifa 2026'],
    [],
    ['Código', 'Descripción', 'Familia', 'PVP', 'IVA', 'Unidad', 'Tipo'],
    ['01001', 'Agua 1,5 l', 'Bebidas', '0,80', '10%', 'ud', 'Producto'],
    ['01002', 'Zumo naranja', 'Bebidas', 1.5, 0.1, 'ud', ''],
    ['S001', 'Hora de instalación', 'Servicios técnicos', '35,00', '21', 'h', 'Servicio'],
  ];

  it('lee titulos, precios en texto y el IVA en % o en tanto por uno', () => {
    const filas = leerProductosArchivo(excel(CATALOGO), 'tarifa.xlsx');
    expect(filas.map((f) => [f.referencia, f.precio, f.ivaPorcentaje, f.tipo])).toEqual([
      ['01001', 0.8, 10, 'PRODUCTO'],
      ['01002', 1.5, 10, undefined],
      ['S001', 35, 21, 'SERVICIO'],
    ]);
  });

  it('vista previa sin guardar; despues crea familias y actualiza los existentes', async () => {
    await productosService.create('e1', { referencia: '01001', descripcion: 'Agua antigua', precio: 0.7 });
    const vista = await importarProductos('e1', excel(CATALOGO), 'tarifa.xlsx', true);
    expect(vista).toMatchObject({ total: 3, nuevos: 2, actualizados: 1, familiasNuevas: ['Bebidas', 'Servicios técnicos'] });
    expect(db.fams).toHaveLength(0);

    await importarProductos('e1', excel(CATALOGO), 'tarifa.xlsx');
    expect(db.fams.map((f) => f.codigo)).toEqual(['BEBIDA', 'SERVIC']);
    expect(db.prods).toHaveLength(3);
    expect(db.prods.find((p) => p.referencia === '01001')).toMatchObject({ descripcion: 'Agua 1,5 l', precio: 0.8 });
  });

  it('todo o nada: un codigo repetido en el fichero lo rechaza indicando la fila', () => {
    const malo = [...CATALOGO, ['01001', 'Duplicado', '', '1', '21', '', '']];
    expect(() => leerProductosArchivo(excel(malo), 'tarifa.xlsx')).toThrow(/fila 7: el código 01001 está repetido/);
  });
});
