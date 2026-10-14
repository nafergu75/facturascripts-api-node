// Configuracion > Facturacion y la serie B, sin BD (Prisma y la semilla de
// series simulados): al guardar con «Vendo ceramica» marcada en una empresa
// espanola se prepara la serie B y la respuesta dice como queda; desmarcar no
// toca nada; fuera de Espana, nunca. La prueba con MySQL real esta en
// series-ceramica.db.test.ts.
jest.mock('../config/database', () => {
  const ajustes = new Map<string, Record<string, unknown>>();
  const pais = new Map<string, string>();
  return {
    prisma: {
      __ajustes: ajustes,
      __pais: pais,
      ajustesFacturacion: {
        findUnique: jest.fn(async ({ where }: { where: { companyId: string } }) => {
          const a = ajustes.get(where.companyId);
          return a ? { ...a, updatedAt: new Date('2026-10-14T10:00:00Z') } : null;
        }),
        upsert: jest.fn(async ({ where, create, update }: { where: { companyId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const a = ajustes.get(where.companyId);
          ajustes.set(where.companyId, a ? { ...a, ...update } : { ...create });
          return ajustes.get(where.companyId);
        }),
      },
      legalConfig: {
        findUnique: jest.fn(async ({ where }: { where: { companyId: string } }) => (pais.has(where.companyId) ? { pais: pais.get(where.companyId), monedaCuenta: 'USD' } : null)),
      },
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});
jest.mock('../services/seriesSemilla.service', () => ({
  prepararSerieCeramica: jest.fn(async () => ({ codigo: 'B', estado: 'creada', aviso: null })),
  estadoSerieCeramica: jest.fn(async () => ({ codigo: 'B', estado: 'activa', aviso: null })),
}));

import { prisma } from '../config/database';
import { guardarAjustesFacturacion, obtenerAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { estadoSerieCeramica, prepararSerieCeramica } from '../services/seriesSemilla.service';

const bd = prisma as unknown as { __pais: Map<string, string> };
const preparar = prepararSerieCeramica as jest.Mock;
const estado = estadoSerieCeramica as jest.Mock;

describe('ajustes de facturación y la serie B', () => {
  it('marcar «Vendo cerámica» en una empresa española prepara la serie B y la respuesta lo dice («creada»)', async () => {
    const r = await guardarAjustesFacturacion('es-1', 'u1', { vendeCeramica: true });
    expect(preparar).toHaveBeenCalledWith('es-1');
    expect(r).toMatchObject({ vendeCeramica: true, serieCeramica: { codigo: 'B', estado: 'creada', aviso: null } });
  });

  it('guardar otra cosa con la casilla ya marcada también la comprueba (si existe, no se toca; el estado viene de la semilla)', async () => {
    preparar.mockResolvedValueOnce({ codigo: 'B', estado: 'desactivada', aviso: 'La serie B está desactivada…' });
    const r = await guardarAjustesFacturacion('es-1', 'u1', { textoPie: 'Gracias' });
    expect(preparar).toHaveBeenCalledWith('es-1');
    expect(r.serieCeramica).toEqual({ codigo: 'B', estado: 'desactivada', aviso: 'La serie B está desactivada…' });
  });

  it('desmarcar no prepara ni toca la serie B, y la respuesta ya no la trae', async () => {
    const r = await guardarAjustesFacturacion('es-1', 'u1', { vendeCeramica: false });
    expect(preparar).not.toHaveBeenCalled();
    expect(estado).not.toHaveBeenCalled();
    expect(r).toMatchObject({ vendeCeramica: false, serieCeramica: null });
  });

  it('sin la casilla, guardar no prepara nada', async () => {
    await guardarAjustesFacturacion('es-2', 'u1', { diasVencimiento: 15 });
    expect(preparar).not.toHaveBeenCalled();
  });

  it('empresa extranjera: la casilla no se guarda y la serie B no se crea', async () => {
    bd.__pais.set('us-1', 'US');
    const r = await guardarAjustesFacturacion('us-1', 'u1', { vendeCeramica: true });
    expect(preparar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ vendeCeramica: false, serieCeramica: null, empresaEspanola: false });
  });

  it('si la serie no se puede crear ahora, los ajustes quedan guardados y se avisa', async () => {
    preparar.mockRejectedValueOnce(new Error('timeout'));
    const r = await guardarAjustesFacturacion('es-3', 'u1', { vendeCeramica: true });
    expect(r.vendeCeramica).toBe(true);
    expect(r.serieCeramica).toMatchObject({ codigo: 'B', estado: 'pendiente' });
    expect(r.serieCeramica?.aviso).toMatch(/se han guardado.*Se creará sola la próxima vez que abras Configuración > Series/);
  });

  it('leer (GET) solo consulta el estado, sin crear nada; sin la casilla, null', async () => {
    const con = await obtenerAjustesFacturacion('es-3');
    expect(estado).toHaveBeenCalledWith('es-3');
    expect(preparar).not.toHaveBeenCalled();
    expect(con.serieCeramica).toEqual({ codigo: 'B', estado: 'activa', aviso: null });
    estado.mockClear();
    const sin = await obtenerAjustesFacturacion('es-2');
    expect(estado).not.toHaveBeenCalled();
    expect(sin.serieCeramica).toBeNull();
  });
});
