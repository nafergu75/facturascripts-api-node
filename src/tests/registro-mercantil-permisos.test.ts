// Rutas del Registro Mercantil (sin empresa en la URL).
//
// Regresion: authorize() usaba los roles GLOBALES del usuario, porque la ruta no
// tenia req.companyId. Alguien contable en la empresa A y solo lectura en la B
// podia cerrar el ejercicio, generar libros o presentar cuentas de la B.
const ejercicios: Record<string, { id: string; companyId: string; estado: string }> = {
  'fy-a': { id: 'fy-a', companyId: 'A', estado: 'OPEN' },
  'fy-b': { id: 'fy-b', companyId: 'B', estado: 'OPEN' },
};

jest.mock('../services/fiscalYears.service', () => ({
  fiscalYearsService: {
    obtener: jest.fn(async (id: string) => {
      if (!ejercicios[id]) {
        const e = new Error('Ejercicio contable no encontrado.') as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return ejercicios[id];
    }),
    cerrar: jest.fn(async (id: string) => ({ ...ejercicios[id], estado: 'CLOSED' })),
  },
}));
jest.mock('../services/booksService', () => ({ booksService: { obtener: jest.fn(), listar: jest.fn(async () => []) } }));
jest.mock('../services/legalizationService', () => ({ legalizationService: { obtener: jest.fn(), listar: jest.fn(async () => []) } }));
jest.mock('../services/annualAccountsService', () => ({ annualAccountsService: { obtener: jest.fn(), listar: jest.fn(async () => []) } }));
jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

import express from 'express';
import request from 'supertest';
import registroMercantilRoutes from '../routes/registroMercantil.routes';

const usuario = {
  userId: 'u1',
  roles: ['contable', 'solo_lectura'],
  companies: ['A', 'B'],
  rolesPorEmpresa: { A: ['contable'], B: ['solo_lectura'] },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = usuario as never;
  next();
});
app.use(registroMercantilRoutes);
app.use((err: { status?: number; statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message });
});

describe('Registro Mercantil: permisos por empresa', () => {
  it('cierra el ejercicio de la empresa donde es contable', async () => {
    const res = await request(app).post('/fiscal-years/fy-a/close');
    expect(res.status).toBe(200);
  });

  it('no cierra el de la empresa donde solo es lectura', async () => {
    const res = await request(app).post('/fiscal-years/fy-b/close');
    expect(res.status).toBe(403);
  });

  it('si puede consultar los expedientes de esa empresa', async () => {
    const res = await request(app).get('/fiscal-years/fy-b/legalization-packages');
    expect(res.status).toBe(200);
  });

  it('un ejercicio de una empresa ajena da 403', async () => {
    ejercicios['fy-c'] = { id: 'fy-c', companyId: 'C', estado: 'OPEN' };
    const res = await request(app).get('/fiscal-years/fy-c/legalization-packages');
    expect(res.status).toBe(403);
  });

  it('un ejercicio inexistente da 404', async () => {
    const res = await request(app).get('/fiscal-years/no-existe/books');
    expect(res.status).toBe(404);
  });
});
