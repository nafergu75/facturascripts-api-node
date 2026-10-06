// Plan de cuentas de cada empresa (ChartOfAccounts).
//
// Regresiones:
// - Habia una tercera copia del PGC, con nombres cambiados y sin cuentas que usa
//   el motor (473, 4751, 628...): contabilizar fallaba con "cuenta no encontrada".
// - Si nadie inicializaba el plan a mano, el motor se negaba a contabilizar.
// - /init tomaba la empresa del cuerpo: un admin podia tocar el plan de otra.
// - Crear subcuenta: el cuerpo podia sobrescribir companyId.
type Fila = { id: string; companyId: string; codigo: string; nombre: string; esBasePGC: boolean; parentId?: string | null };
const filas: Fila[] = [];

jest.mock('../config/database', () => ({
  prisma: {
    company: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(where.id === 'otra-inexistente' ? null : { id: where.id })) },
    chartOfAccountsVersion: { upsert: jest.fn(() => Promise.resolve({})) },
    chartOfAccounts: {
      findMany: jest.fn(({ where }: { where: { companyId: string; codigo: { in: string[] } } }) =>
        Promise.resolve(filas.filter((f) => f.companyId === where.companyId && where.codigo.in.includes(f.codigo))),
      ),
      findFirst: jest.fn(({ where }: { where: { companyId: string; codigo?: string; id?: string } }) =>
        Promise.resolve(
          filas.find((f) => f.companyId === where.companyId && (where.id ? f.id === where.id : f.codigo === where.codigo)) ?? null,
        ),
      ),
      createMany: jest.fn(({ data }: { data: Fila[] }) => {
        filas.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      create: jest.fn(({ data }: { data: Fila }) => {
        const fila = { ...data, id: `n-${filas.length}` };
        filas.push(fila);
        return Promise.resolve(fila);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Fila> }) => {
        const fila = filas.find((f) => f.id === where.id)!;
        Object.assign(fila, data);
        return Promise.resolve(fila);
      }),
    },
  },
}));
jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { PGC_BASE } from '../domain/pgc-model';
import { actualizarCuenta, asegurarPlanContableEmpresa, crearSubcuentaPersonalizada } from '../services/chart-of-accounts.service';
import chartOfAccountsRoutes from '../routes/chart-of-accounts.routes';
import { CONTABLE_RULES } from '../services/accounting-engine.service';

beforeEach(() => {
  filas.length = 0;
});

describe('plan de cuentas de la empresa', () => {
  it('crea el plan base completo, con cada cuenta enlazada a su padre', async () => {
    const r = await asegurarPlanContableEmpresa('e1');
    expect(r).toEqual({ creadas: PGC_BASE.length, renombradas: 0 });
    const porCodigo = new Map(filas.map((f) => [f.codigo, f]));
    expect(porCodigo.get('629')!.parentId).toBe(porCodigo.get('62')!.id);
    expect(porCodigo.get('62')!.parentId).toBe(porCodigo.get('6')!.id);
    expect(porCodigo.get('4751')!.parentId).toBe(porCodigo.get('475')!.id);
    expect(porCodigo.get('6')!.parentId).toBeNull();
  });

  it('se puede repetir: no duplica nada', async () => {
    await asegurarPlanContableEmpresa('e1');
    const r = await asegurarPlanContableEmpresa('e1');
    expect(r).toEqual({ creadas: 0, renombradas: 0 });
    expect(filas).toHaveLength(PGC_BASE.length);
  });

  it('completa un plan antiguo y corrige nombres del PGC, sin tocar subcuentas propias', async () => {
    filas.push(
      { id: 'a', companyId: 'e1', codigo: '622', nombre: 'Gastos de arrendamiento', esBasePGC: true },
      { id: 'b', companyId: 'e1', codigo: '6220001', nombre: 'Taller Pepe', esBasePGC: false },
    );
    const r = await asegurarPlanContableEmpresa('e1');
    expect(r.renombradas).toBe(1);
    expect(r.creadas).toBe(PGC_BASE.length - 1);
    expect(filas.find((f) => f.codigo === '622')!.nombre).toBe('Reparaciones y conservación');
    expect(filas.find((f) => f.codigo === '6220001')!.nombre).toBe('Taller Pepe');
  });

  it('cada empresa tiene su plan', async () => {
    await asegurarPlanContableEmpresa('e1');
    await asegurarPlanContableEmpresa('e2');
    expect(filas.filter((f) => f.companyId === 'e2')).toHaveLength(PGC_BASE.length);
  });

  it('contiene todas las cuentas a las que contabiliza el motor', () => {
    const codigos = new Set(PGC_BASE.map((n) => n.code));
    const usadas = Object.values(CONTABLE_RULES).flatMap((r) => Object.values(r));
    for (const c of usadas) expect(codigos.has(c)).toBe(true);
  });

  it('servicios profesionales van a la 623 y suministros a la 628', () => {
    expect(CONTABLE_RULES.SERVICIO_PROFESIONAL.gasto).toBe('623');
    expect(CONTABLE_RULES.SUMINISTROS.gasto).toBe('628');
  });
});

describe('subcuentas propias', () => {
  beforeEach(() => asegurarPlanContableEmpresa('e1'));

  it('crea una subcuenta que amplia el codigo de su cuenta', async () => {
    const nueva = await crearSubcuentaPersonalizada({
      companyId: 'e1', codigo: '6290001', nombre: 'Gastos de oficina', parentCodigo: '629', naturaleza: '', tipoUso: '',
    });
    expect(nueva).toMatchObject({ codigo: '6290001', parentCodigo: '629', esPersonalizadaEmpresa: true });
  });

  it('rechaza un codigo que no cuelga de su cuenta', async () => {
    await expect(
      crearSubcuentaPersonalizada({ companyId: 'e1', codigo: '7000001', nombre: 'x', parentCodigo: '629', naturaleza: '', tipoUso: '' }),
    ).rejects.toThrow(/empezar por 629/);
  });
});

describe('editar cuentas', () => {
  beforeEach(() => asegurarPlanContableEmpresa('e1'));
  const propia = () =>
    crearSubcuentaPersonalizada({ companyId: 'e1', codigo: '6290001', nombre: 'Oficina', parentCodigo: '629', naturaleza: '', tipoUso: '' });

  it('renombra y desactiva una subcuenta propia', async () => {
    const s = await propia();
    const r = await actualizarCuenta(s.id, 'e1', { nombre: 'Material de oficina', activo: false });
    expect(r).toMatchObject({ nombre: 'Material de oficina', activo: false });
  });

  it('solo guarda nombre, activo y notas', async () => {
    const s = await propia();
    const r = await actualizarCuenta(s.id, 'e1', { nombre: 'X', codigo: '999', companyId: 'e2', esBasePGC: true } as never);
    expect(r).toMatchObject({ codigo: '6290001', companyId: 'e1', esBasePGC: false });
  });

  it('no deja desactivar ni renombrar una cuenta del PGC', async () => {
    const c400 = filas.find((f) => f.codigo === '400')!;
    await expect(actualizarCuenta(c400.id, 'e1', { activo: false })).rejects.toThrow(/no se pueden desactivar/);
    await expect(actualizarCuenta(c400.id, 'e1', { nombre: 'Otro' })).rejects.toThrow(/PGC base/);
  });

  it('no toca cuentas de otra empresa', async () => {
    const s = await propia();
    await expect(actualizarCuenta(s.id, 'e2', { nombre: 'X' })).rejects.toThrow(/no encontrada/);
  });
});

describe('rutas', () => {
  const app = express();
  app.use(express.json());
  app.use('/companies/:companyId/accounting/chart-of-accounts', (req, _res, next) => {
    req.companyId = req.params.companyId;
    req.user = { userId: 'u1', roles: ['admin'] } as never;
    next();
  }, chartOfAccountsRoutes);
  app.use((err: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  it('/init usa la empresa de la ruta, no la del cuerpo', async () => {
    const res = await request(app).post('/companies/e1/accounting/chart-of-accounts/init').send({ companyId: 'e2' });
    expect(res.status).toBe(201);
    expect(filas.every((f) => f.companyId === 'e1')).toBe(true);
  });

  it('crear subcuenta ignora el companyId del cuerpo', async () => {
    await asegurarPlanContableEmpresa('e1');
    await asegurarPlanContableEmpresa('e2');
    const res = await request(app)
      .post('/companies/e1/accounting/chart-of-accounts')
      .send({ companyId: 'e2', codigo: '6290009', nombre: 'Varios', parentCodigo: '629' });
    expect(res.status).toBe(201);
    expect(filas.find((f) => f.codigo === '6290009')!.companyId).toBe('e1');
  });
});
