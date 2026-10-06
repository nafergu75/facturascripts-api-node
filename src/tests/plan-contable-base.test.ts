// Plan contable base: una sola fuente (domain/pgc-model.ts).
//
// Regresiones:
// - La pantalla Plan contable pedia /plan-contable/base/todo y no existia (404).
// - Habia dos copias del plan: la del servicio (33 cuentas, sin tildes) y la
//   del modelo (44 cuentas). La pantalla mostraba una y la validacion de
//   subcuentas usaba la otra.
import request from 'supertest';
import express from 'express';
import planContableBaseRoutes from '../routes/planContableBase.routes';
import { PGC_BASE } from '../domain/pgc-model';
import { listarCuentasBase, listarGruposBase, listarSubgruposBase } from '../services/planContable.service';

const app = express();
app.use('/plan-contable/base', planContableBaseRoutes);

describe('plan contable base', () => {
  it('/todo devuelve el plan completo en el formato de la pantalla', async () => {
    const res = await request(app).get('/plan-contable/base/todo');
    expect(res.status).toBe(200);
    const niveles = new Set((res.body.data as Array<{ level: string }>).map((n) => n.level));
    expect(niveles).toEqual(new Set(['group', 'subgroup', 'account']));
    expect(res.body.data).toHaveLength(PGC_BASE.length);
  });

  it('las listas del servicio salen del mismo modelo', () => {
    const cuentasModelo = PGC_BASE.filter((n) => n.level === 'account').map((n) => n.code);
    expect(listarCuentasBase().map((c) => c.codigo)).toEqual(cuentasModelo);
    expect(listarGruposBase()).toHaveLength(PGC_BASE.filter((n) => n.level === 'group').length);
    expect(listarSubgruposBase()).toHaveLength(PGC_BASE.filter((n) => n.level === 'subgroup').length);
  });

  it('cada cuenta cuelga de un subgrupo existente, y este de un grupo existente', () => {
    const subgrupos = new Map(listarSubgruposBase().map((s) => [s.codigo, s]));
    const grupos = new Set(listarGruposBase().map((g) => g.codigo));
    for (const c of listarCuentasBase()) {
      const sg = subgrupos.get(c.subgrupoCodigo);
      expect(sg).toBeDefined();
      expect(grupos.has(sg!.grupoCodigo)).toBe(true);
      expect(c.codigo.startsWith(c.subgrupoCodigo)).toBe(true);
    }
  });

  it('no repite codigos', () => {
    const codigos = PGC_BASE.map((n) => n.code);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it('la 220 es "terrenos" en el subgrupo 22 (estaba en el 21 y con el nombre de la 221)', () => {
    const c220 = listarCuentasBase().find((c) => c.codigo === '220');
    expect(c220).toMatchObject({ subgrupoCodigo: '22', nombre: 'Inversiones en terrenos y bienes naturales' });
  });

  it('conserva las cuentas que usa el motor contable, con tildes', () => {
    const porCodigo = new Map(listarCuentasBase().map((c) => [c.codigo, c.nombre]));
    // Todas las cuentas de 3 digitos que usa el motor contable (CONTABLE_RULES).
    for (const codigo of ['400', '430', '472', '473', '477', '555', '570', '572', '600', '621', '622', '623', '700', '701', '702', '705']) {
      expect(porCodigo.has(codigo)).toBe(true);
    }
    expect(porCodigo.get('700')).toBe('Ventas de mercaderías');
  });
});
