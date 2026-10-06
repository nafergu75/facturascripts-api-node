// Reintento de consultas cuando no se puede conectar con la base de datos.
//
// Regresion: tras un rato sin uso, la primera peticion en Vercel (a menudo el
// login) tardaba mas de 5 s en conectar con TiDB y devolvia un 500.
import { Prisma } from '@prisma/client';
import { conReintento, esErrorDeConexion } from '../config/reintentoConexion';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const sinConexion = () =>
  new Prisma.PrismaClientInitializationError("Can't reach database server at `gateway01.example:4000`", '5.22.0');

describe('reintento de conexion', () => {
  it('reconoce los errores de conexion y no los demas', () => {
    expect(esErrorDeConexion(sinConexion())).toBe(true);
    expect(esErrorDeConexion({ code: 'P1001' })).toBe(true);
    expect(esErrorDeConexion(new Error('Timed out fetching a new connection from the connection pool'))).toBe(true);
    expect(esErrorDeConexion({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(esErrorDeConexion(new Error('Credenciales invalidas.'))).toBe(false);
  });

  it('si la base de datos tarda en despertar, el segundo intento responde', async () => {
    const consulta = jest.fn().mockRejectedValueOnce(sinConexion()).mockResolvedValueOnce({ id: 'u1' });
    await expect(conReintento(consulta, 'user.findUnique', [0, 0])).resolves.toEqual({ id: 'u1' });
    expect(consulta).toHaveBeenCalledTimes(2);
  });

  it('se rinde tras los reintentos y devuelve el error original', async () => {
    const consulta = jest.fn().mockRejectedValue(sinConexion());
    await expect(conReintento(consulta, 'user.findUnique', [0, 0])).rejects.toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(consulta).toHaveBeenCalledTimes(3);
  });

  it('otros errores no se reintentan (una escritura repetida podria duplicar)', async () => {
    const duplicado = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const consulta = jest.fn().mockRejectedValue(duplicado);
    await expect(conReintento(consulta, 'user.create', [0, 0])).rejects.toBe(duplicado);
    expect(consulta).toHaveBeenCalledTimes(1);
  });
});
