// Alta de una empresa con sus datos completos (POST /admin/empresas con `datos`):
// validacion de los datos y orden de la transaccion, sin BD (Prisma simulado).
// La prueba contra MySQL real esta en admin.db.test.ts.
jest.mock('../config/database', () => {
  const tx = {
    $queryRaw: jest.fn(async () => [] as Array<{ companyId: string }>),
    company: {
      create: jest.fn(async ({ data }: { data: { name: string; codigo: string | null } }) => ({
        id: 'E-NUEVA',
        name: data.name,
        codigo: data.codigo,
        isActive: true,
        createdAt: new Date('2026-10-07T10:00:00Z'),
      })),
      findFirst: jest.fn(async () => null as { name: string; isActive: boolean } | null),
    },
    user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
    membership: { create: jest.fn(async () => ({})) },
    legalConfig: { create: jest.fn(async () => ({})) },
  };
  return {
    prisma: {
      user: { findUnique: jest.fn() },
      company: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});

import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { validarDatosAltaEmpresa } from '../services/admin.service';
import { camposPendientesEmpresa } from '../services/legalConfig.service';

type Mock = jest.Mock;
const bd = prisma as unknown as {
  user: { findUnique: Mock };
  company: { findUnique: Mock };
  $transaction: Mock;
  __tx: {
    $queryRaw: Mock;
    company: { create: Mock; findFirst: Mock };
    user: { findUnique: Mock };
    membership: { create: Mock };
    legalConfig: { create: Mock };
  };
};
const tx = bd.__tx;

/** Los datos de una alta real: una S.A. valenciana sin el Registro Mercantil todavia. */
const IFBIO = {
  denominacion: 'IFBIOSOLUCIONES, S.A.',
  tipoSociedad: 'SA',
  pais: 'ES',
  nif: 'A10952364',
  domicilioSocial: 'Paseo Sierra de Espadán 6',
  codigoPostal: '46120',
  municipio: 'Alboraya',
  provincia: 'Valencia',
  telefono: '+34 960 00 00 00',
  email: 'administracion@ejemplo.es',
  web: 'www.ejemplo.es',
};

const NEWZELAND = {
  denominacion: 'NEWZELAND CENTER, S.L.',
  tipoSociedad: 'SL',
  pais: 'ES',
  nif: 'B98492259',
  domicilioSocial: 'Calle de Ejemplo 1',
  codigoPostal: '46001',
  municipio: 'Valencia',
  provincia: 'Valencia',
};

/** Error de validacion: codigo HTTP y campo senalado. */
const fallo = (datos: unknown): { status?: number; campo?: string; mensaje?: string } => {
  try {
    validarDatosAltaEmpresa(datos);
    return {};
  } catch (e) {
    const err = e as { statusCode?: number; details?: { campo?: string }; message: string };
    return { status: err.statusCode, campo: err.details?.campo, mensaje: err.message };
  }
};

describe('validarDatosAltaEmpresa', () => {
  it('acepta una S.A. espanola sin Registro Mercantil y lo deja pendiente', () => {
    const d = validarDatosAltaEmpresa({ ...IFBIO, tipoSociedad: 'sa', pais: 'es', nif: 'a-10.952.364' });
    expect(d).toMatchObject({ ...IFBIO, nif: 'A10952364', tipoSociedad: 'SA', pais: 'ES' });
    expect(camposPendientesEmpresa(d as unknown as Record<string, unknown>)).toEqual([
      'Registro Mercantil (provincia)',
      'Tomo',
      'Folio',
      'Hoja',
      'Inscripción',
    ]);
  });

  it('acepta una S.L. con su CIF y guarda el Registro Mercantil si viene', () => {
    const d = validarDatosAltaEmpresa({
      ...NEWZELAND,
      registroMercantilProvincia: 'Valencia',
      registroTomo: '1234',
      registroFolio: '56',
      registroHoja: 'V-78901',
      registroInscripcion: '1ª',
    });
    expect(d.nif).toBe('B98492259');
    expect(d.registroHoja).toBe('V-78901');
    expect(camposPendientesEmpresa(d as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('el pais es Espana si no se dice', () => {
    const { pais, ...sinPais } = NEWZELAND;
    void pais;
    expect(validarDatosAltaEmpresa(sinPais).pais).toBe('ES');
  });

  it('solo se queda con los campos del alta', () => {
    const d = validarDatosAltaEmpresa({ ...NEWZELAND, companyId: 'otra', id: 'x', logo: 'bytes', obligaLibroSocios: false, cnae: '4711' });
    for (const k of ['companyId', 'id', 'logo', 'obligaLibroSocios', 'cnae']) expect(d).not.toHaveProperty(k);
  });

  it('exige los datos minimos para facturar, cada uno con su campo', () => {
    for (const campo of ['denominacion', 'nif', 'domicilioSocial', 'codigoPostal', 'municipio', 'provincia']) {
      expect(fallo({ ...NEWZELAND, [campo]: '  ' })).toMatchObject({ status: 400, campo });
    }
    expect(fallo({ ...NEWZELAND, tipoSociedad: undefined })).toMatchObject({ status: 400, campo: 'tipoSociedad' });
  });

  it('rechaza un NIF espanol con el digito de control mal', () => {
    const r = fallo({ ...IFBIO, nif: 'A10952365' });
    expect(r).toMatchObject({ status: 400, campo: 'nif' });
    expect(r.mensaje).toMatch(/dígito de control/);
    expect(fallo({ ...IFBIO, nif: '1234' })).toMatchObject({ status: 400, campo: 'nif' });
  });

  it('el NIF tiene que cuadrar con la forma juridica', () => {
    expect(fallo({ ...IFBIO, nif: 'B98492259' }).mensaje).toMatch(/anónima empieza por A/);
    expect(fallo({ ...NEWZELAND, nif: 'A10952364' }).mensaje).toMatch(/limitada empieza por B/);
    expect(fallo({ ...NEWZELAND, tipoSociedad: 'SLU', nif: 'A10952364' })).toMatchObject({ status: 400, campo: 'nif' });
    expect(fallo({ ...NEWZELAND, tipoSociedad: 'AUTONOMO', nif: 'B98492259' }).mensaje).toMatch(/autónomo/);
    // Un autonomo con su DNI o su NIE, y sin Registro Mercantil aunque lo manden.
    const autonomo = validarDatosAltaEmpresa({ ...NEWZELAND, tipoSociedad: 'AUTONOMO', nif: '12345678Z', registroTomo: '1' });
    expect(autonomo.nif).toBe('12345678Z');
    expect(autonomo).not.toHaveProperty('registroTomo');
    expect(camposPendientesEmpresa(autonomo as unknown as Record<string, unknown>)).toEqual([]);
    expect(validarDatosAltaEmpresa({ ...NEWZELAND, tipoSociedad: 'AUTONOMO', nif: 'X1234567L' }).nif).toBe('X1234567L');
  });

  it('valida CP, email, pais y forma juridica con las reglas de Datos de la empresa', () => {
    expect(fallo({ ...IFBIO, codigoPostal: '4612' })).toMatchObject({ status: 400, campo: 'codigoPostal' });
    expect(fallo({ ...IFBIO, email: 'no-es-email' })).toMatchObject({ status: 400, campo: 'email' });
    expect(fallo({ ...IFBIO, pais: 'ESP' })).toMatchObject({ status: 400, campo: 'pais' });
    expect(fallo({ ...IFBIO, pais: '' })).toMatchObject({ status: 400, campo: 'pais' });
    expect(fallo({ ...IFBIO, tipoSociedad: 'XX' })).toMatchObject({ status: 400, campo: 'tipoSociedad' });
  });

  it('valida el telefono y la web si vienen', () => {
    expect(fallo({ ...IFBIO, telefono: 'llámame' })).toMatchObject({ status: 400, campo: 'telefono' });
    expect(fallo({ ...IFBIO, telefono: '123' })).toMatchObject({ status: 400, campo: 'telefono' });
    expect(fallo({ ...IFBIO, web: 'no es una web' })).toMatchObject({ status: 400, campo: 'web' });
    expect(validarDatosAltaEmpresa({ ...IFBIO, telefono: '(+34) 961-234-567', web: 'https://ejemplo.es/inicio' }).telefono).toBe('(+34) 961-234-567');
    // Vacios: no pasa nada, son opcionales.
    const sinContacto = validarDatosAltaEmpresa({ ...IFBIO, telefono: '', email: '', web: '' });
    expect(sinContacto.telefono).toBeNull();
    expect(sinContacto.email).toBeNull();
  });

  it('rechaza textos demasiado largos o que no son texto', () => {
    expect(fallo({ ...IFBIO, domicilioSocial: 'x'.repeat(192) })).toMatchObject({ status: 400, campo: 'domicilioSocial' });
    expect(fallo({ ...IFBIO, codigoPostal: 46120 })).toMatchObject({ status: 400, campo: 'codigoPostal' });
    expect(fallo('IFBIO')).toMatchObject({ status: 400 });
    expect(fallo([IFBIO])).toMatchObject({ status: 400 });
  });

  it('fuera de Espana: identificacion libre, sin provincia ni CP de 5 cifras y con datos registrales libres', () => {
    const d = validarDatosAltaEmpresa({
      denominacion: 'Atlas Trading SARL',
      tipoSociedad: 'OTRA',
      pais: 'ma',
      nif: 'ice 001234567000089',
      domicilioSocial: 'Bd Zerktouni 10',
      codigoPostal: '20000-A',
      municipio: 'Casablanca',
      datosRegistrales: 'RC 123456 Casablanca',
      registroTomo: '99',
    });
    expect(d).toMatchObject({ pais: 'MA', nif: 'ICE001234567000089', datosRegistrales: 'RC 123456 Casablanca' });
    expect(d).not.toHaveProperty('registroTomo');
    expect(camposPendientesEmpresa(d as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('en Espana no guarda los datos registrales de texto libre (van por partes)', () => {
    expect(validarDatosAltaEmpresa({ ...NEWZELAND, datosRegistrales: 'algo' })).not.toHaveProperty('datosRegistrales');
  });
});

describe('POST /admin/empresas con datos', () => {
  const token = authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: [], esAdminGlobal: true });
  const alta = (body: object) => request(app).post('/admin/empresas').set('Authorization', `Bearer ${token}`).send(body);

  beforeEach(() => {
    // authMiddleware lee el usuario en cada peticion: administrador global vigente.
    bd.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, isGlobalAdmin: true, passwordHash: 'sal:hash', memberships: [] });
    tx.$queryRaw.mockResolvedValue([]);
    tx.company.findFirst.mockResolvedValue(null);
  });

  it('crea empresa, acceso de administrador y datos legales en una transaccion; el nombre es la denominacion', async () => {
    const res = await alta({ datos: IFBIO });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: 'E-NUEVA',
      nombre: 'IFBIOSOLUCIONES, S.A.',
      denominacion: 'IFBIOSOLUCIONES, S.A.',
      nif: 'A10952364',
      pais: 'ES',
      usuarios: 1,
      completo: false,
    });
    expect(res.body.data.pendientes).toEqual(['Registro Mercantil (provincia)', 'Tomo', 'Folio', 'Hoja', 'Inscripción']);

    expect(bd.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.membership.create).toHaveBeenCalledWith({ data: { userId: 'u1', companyId: 'E-NUEVA', role: 'admin' } });
    const guardado = tx.legalConfig.create.mock.calls[0][0].data;
    expect(guardado).toMatchObject({
      ...IFBIO,
      companyId: 'E-NUEVA',
      obligaLibroSocios: true,
      obligaLibroContratos: false,
    });
    expect(guardado).not.toHaveProperty('registroTomo');
    // El NIF se comprueba dentro de la transaccion y ANTES de crear nada.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.company.create.mock.invocationCallOrder[0]);
  });

  it('el nombre corto y el codigo se pueden elegir; la unipersonal lleva libro de contratos', async () => {
    const res = await alta({ nombre: 'Newzeland', codigo: 'NWZ', datos: { ...NEWZELAND, tipoSociedad: 'SLU' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ nombre: 'Newzeland', codigo: 'NWZ', denominacion: 'NEWZELAND CENTER, S.L.' });
    expect(tx.legalConfig.create.mock.calls[0][0].data).toMatchObject({ obligaLibroSocios: true, obligaLibroContratos: true });
  });

  it('si otra empresa ya tiene ese NIF responde 409 con su nombre y no crea nada', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ companyId: 'E-VIEJA' }]);
    tx.company.findFirst.mockResolvedValueOnce({ name: 'Ifbio antigua', isActive: false });
    const res = await alta({ datos: { ...IFBIO, nif: 'a-10952364' } });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/NIF A10952364: «Ifbio antigua» \(desactivada\)/);
    expect(res.body.details).toEqual({ campo: 'nif' });
    expect(tx.company.create).not.toHaveBeenCalled();
    expect(tx.legalConfig.create).not.toHaveBeenCalled();
  });

  it('los datos legales sueltos de una empresa que ya no existe no bloquean el alta', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ companyId: 'E-BORRADA' }]);
    tx.company.findFirst.mockResolvedValueOnce(null);
    expect((await alta({ datos: IFBIO })).status).toBe(201);
  });

  it('un dato mal responde 400 con el campo y no abre la transaccion', async () => {
    const res = await alta({ datos: { ...IFBIO, nif: 'A10952365' } });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ campo: 'nif' });
    expect(bd.$transaction).not.toHaveBeenCalled();

    const sinNombre = await alta({ nombre: 'x', datos: IFBIO });
    expect(sinNombre.status).toBe(400);
    expect(sinNombre.body.details).toEqual({ campo: 'nombre' });
    const codigoMalo = await alta({ codigo: "x'; --", datos: IFBIO });
    expect(codigoMalo.body.details).toEqual({ campo: 'codigo' });
  });

  it('sin datos sigue creando solo la empresa, como antes, y la marca como incompleta', async () => {
    const res = await alta({ nombre: 'Solo nombre SL' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ nombre: 'Solo nombre SL', nif: null, completo: false });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.legalConfig.create).not.toHaveBeenCalled();
    expect((await alta({})).status).toBe(400);
  });
});
