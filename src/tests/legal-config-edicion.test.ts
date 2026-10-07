// Edicion de los datos de la empresa (PUT /companies/:id/legal-config ->
// legalConfigService.actualizar), sin BD (Prisma simulado). Las mismas
// garantias que el alta cuando se cambia lo que les afecta:
// - libros obligatorios recalculados al cambiar la forma juridica o el pais;
// - NIF con su control, coherente con la forma y que no tenga otra empresa;
// - pais ISO que existe y CP que existe y es de la provincia.
// Y, de divisas-iva, la moneda de la contabilidad (monedaCuenta): sin facturas
// ni asientos cambia con el pais (y las cuentas bancarias con ella); con ellos, no.
jest.mock('../config/database', () => {
  const upsert = jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'LC1', ...create }));
  const tx = {
    $queryRaw: jest.fn(async () => [] as Array<{ companyId: string }>),
    company: { findFirst: jest.fn(async () => null as { name: string; isActive: boolean } | null) },
    legalConfig: { upsert },
    bankAccount: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  return {
    prisma: {
      legalConfig: { findUnique: jest.fn(), upsert },
      // Facturas y asientos de la empresa (tieneDocumentos): por defecto, ninguno.
      incomeInvoice: { findFirst: jest.fn(async () => null) },
      expenseInvoice: { findFirst: jest.fn(async () => null) },
      journalEntry: { findFirst: jest.fn(async () => null) },
      // Nominas y seguros sociales (tieneDocumentos): por defecto, ninguno.
      nomina: { findFirst: jest.fn(async () => null) },
      liquidacionSS: { findFirst: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { legalConfigService, librosObligatorios } from '../services/legalConfig.service';

type Mock = jest.Mock;
const bd = prisma as unknown as {
  legalConfig: { findUnique: Mock; upsert: Mock };
  $transaction: Mock;
  incomeInvoice: { findFirst: Mock };
  expenseInvoice: { findFirst: Mock };
  journalEntry: { findFirst: Mock };
  nomina: { findFirst: Mock };
  liquidacionSS: { findFirst: Mock };
  __tx: { $queryRaw: Mock; company: { findFirst: Mock }; bankAccount: { updateMany: Mock } };
};
const tx = bd.__tx;

/** Lo guardado de IFBIOSOLUCIONES, S.A. */
const IFBIO = {
  pais: 'ES',
  tipoSociedad: 'SA',
  nif: 'A10952364',
  codigoPostal: '46120',
  provincia: 'Valencia',
};

/** Lo que manda la pantalla "Datos de la empresa": todo el formulario. */
const FORMULARIO = {
  denominacion: 'IFBIOSOLUCIONES, S.A.',
  ...IFBIO,
  domicilioSocial: 'Paseo Sierra de Espadán 6',
  municipio: 'Alboraya',
  telefono: '',
  email: '',
  web: '',
};

/** Lo que se paso a la BD en el upsert (update). */
const guardado = (): Record<string, unknown> => bd.legalConfig.upsert.mock.calls[0][0].update;

const fallo = async (datos: Record<string, unknown>) => {
  try {
    await legalConfigService.actualizar('E1', datos);
    return {};
  } catch (e) {
    const err = e as { statusCode?: number; details?: { campo?: string }; message: string };
    return { status: err.statusCode, campo: err.details?.campo, mensaje: err.message };
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  bd.legalConfig.findUnique.mockResolvedValue({ ...IFBIO });
  tx.$queryRaw.mockResolvedValue([]);
  tx.company.findFirst.mockResolvedValue(null);
  bd.incomeInvoice.findFirst.mockResolvedValue(null);
  bd.expenseInvoice.findFirst.mockResolvedValue(null);
  bd.journalEntry.findFirst.mockResolvedValue(null);
  bd.nomina.findFirst.mockResolvedValue(null);
  bd.liquidacionSS.findFirst.mockResolvedValue(null);
});

describe('librosObligatorios', () => {
  it('socios en SA, SL y SLU espanolas; contratos solo en la SLU', () => {
    expect(librosObligatorios('SA', 'ES')).toEqual({ obligaLibroSocios: true, obligaLibroContratos: false });
    expect(librosObligatorios('SL', 'ES')).toEqual({ obligaLibroSocios: true, obligaLibroContratos: false });
    expect(librosObligatorios('SLU', 'ES')).toEqual({ obligaLibroSocios: true, obligaLibroContratos: true });
    for (const [t, p] of [['AUTONOMO', 'ES'], ['SCP', 'ES'], ['OTRA', 'ES'], ['SL', 'PT'], ['SLU', 'MA']]) {
      expect(librosObligatorios(t, p)).toEqual({ obligaLibroSocios: false, obligaLibroContratos: false });
    }
  });
});

describe('libros obligatorios al editar', () => {
  it('una SL dada de alta como de Portugal y corregida a Espana pasa a llevar el libro de socios', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'PT', tipoSociedad: 'SL', nif: 'B98492259', codigoPostal: '46001', provincia: null });
    await legalConfigService.actualizar('E1', { pais: 'ES', provincia: 'Valencia' });
    expect(guardado()).toMatchObject({ pais: 'ES', obligaLibroSocios: true, obligaLibroContratos: false });
  });

  it('una forma "Otra" corregida a SL, y una SL corregida a SLU, se recalculan', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'ES', tipoSociedad: 'OTRA', nif: 'B98492259', codigoPostal: '46001', provincia: 'Valencia' });
    await legalConfigService.actualizar('E1', { tipoSociedad: 'SL' });
    expect(guardado()).toMatchObject({ obligaLibroSocios: true, obligaLibroContratos: false });

    jest.clearAllMocks();
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'ES', tipoSociedad: 'SL', nif: 'B98492259', codigoPostal: '46001', provincia: 'Valencia' });
    await legalConfigService.actualizar('E1', { tipoSociedad: 'SLU' });
    expect(guardado()).toMatchObject({ obligaLibroSocios: true, obligaLibroContratos: true });
  });

  it('si no cambian la forma ni el pais no se tocan (ni los de una empresa antigua)', async () => {
    await legalConfigService.actualizar('E1', FORMULARIO);
    expect(guardado()).not.toHaveProperty('obligaLibroSocios');
    expect(guardado()).not.toHaveProperty('obligaLibroContratos');
  });

  it('si el cuerpo los trae explicitos, mandan esos', async () => {
    await legalConfigService.actualizar('E1', { tipoSociedad: 'SLU', nif: 'B98492259', obligaLibroContratos: false });
    expect(guardado()).toMatchObject({ obligaLibroSocios: true, obligaLibroContratos: false });
  });

  it('sin fila todavia parte de los valores por defecto (SL, Espana)', async () => {
    bd.legalConfig.findUnique.mockResolvedValue(null);
    await legalConfigService.actualizar('E1', { tipoSociedad: 'AUTONOMO', nif: '12345678Z' });
    expect(guardado()).toMatchObject({ obligaLibroSocios: false, obligaLibroContratos: false });
  });
});

describe('NIF al editar', () => {
  it('un NIF que ya tiene otra empresa: 409 con su nombre y no se guarda', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'ES', tipoSociedad: 'SL', nif: 'B98492259', codigoPostal: '46001', provincia: 'Valencia' });
    tx.$queryRaw.mockResolvedValueOnce([{ companyId: 'E-IFBIO' }]);
    tx.company.findFirst.mockResolvedValueOnce({ name: 'IFBIOSOLUCIONES, S.A.', isActive: true });
    const r = await fallo({ tipoSociedad: 'SA', nif: 'a-10952364' });
    expect(r).toMatchObject({ status: 409, campo: 'nif' });
    expect(r.mensaje).toMatch(/NIF A10952364: «IFBIOSOLUCIONES, S\.A\.»/);
    expect(bd.legalConfig.upsert).not.toHaveBeenCalled();
    // La comprobacion es dentro de la transaccion que guarda, sin contar a la propia empresa.
    expect(bd.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.company.findFirst.mock.calls[0][0].where).toEqual({ id: { in: ['E-IFBIO'] } });
  });

  it('su propio NIF no cuenta como duplicado', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ ...IFBIO, nif: null });
    tx.$queryRaw.mockResolvedValueOnce([{ companyId: 'E1' }]);
    await legalConfigService.actualizar('E1', FORMULARIO);
    expect(tx.company.findFirst).not.toHaveBeenCalled();
    expect(guardado()).toMatchObject({ nif: 'A10952364' });
  });

  it('si el NIF no cambia no se busca en las demas empresas (no bloquea a las antiguas)', async () => {
    await legalConfigService.actualizar('E1', { ...FORMULARIO, nif: 'a-10952364' });
    expect(bd.$transaction).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(guardado()).toMatchObject({ nif: 'A10952364' });
  });

  it('un NIF nuevo con el control mal se rechaza', async () => {
    expect(await fallo({ nif: 'A10952365' })).toMatchObject({ status: 400, campo: 'nif' });
    expect(bd.legalConfig.upsert).not.toHaveBeenCalled();
  });

  it('cambiar la forma juridica sin cambiar el NIF: tiene que cuadrar, y senala la forma', async () => {
    const r = await fallo({ ...FORMULARIO, tipoSociedad: 'SL' });
    expect(r).toMatchObject({ status: 400, campo: 'tipoSociedad' });
    expect(r.mensaje).toMatch(/limitada empieza por B/);
    expect(await fallo({ ...FORMULARIO, tipoSociedad: 'AUTONOMO' })).toMatchObject({ status: 400, campo: 'tipoSociedad' });
  });

  it('un NIF nuevo que no cuadra con la forma senala el NIF', async () => {
    expect(await fallo({ ...FORMULARIO, nif: 'B98492259' })).toMatchObject({ status: 400, campo: 'nif' });
  });

  it('al pasar a Espana se comprueba el NIF que ya tenia', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'PT', tipoSociedad: 'SA', nif: 'A10952365', codigoPostal: '46120', provincia: null });
    expect(await fallo({ pais: 'ES', provincia: 'Valencia' })).toMatchObject({ status: 400, campo: 'nif' });
  });

  it('una empresa antigua con datos que hoy no pasarian puede guardar lo demas', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'ES', tipoSociedad: 'SA', nif: 'B-1234', codigoPostal: '03120', provincia: 'Valencia' });
    await legalConfigService.actualizar('E1', { ...FORMULARIO, nif: 'B-1234', codigoPostal: '03120', telefono: '960000000' });
    expect(guardado()).toMatchObject({ telefono: '960000000' });
  });

  it('fuera de Espana no se aplica el NIF espanol, pero tampoco se puede repetir', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'MA', tipoSociedad: 'OTRA', nif: 'ICE1', codigoPostal: '20000', provincia: null });
    await legalConfigService.actualizar('E1', { nif: 'ICE001234567000089' });
    expect(guardado()).toMatchObject({ nif: 'ICE001234567000089' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('pais y codigo postal al editar', () => {
  it('rechaza un pais que no existe', async () => {
    for (const pais of ['SP', 'EP', 'UK']) {
      expect(await fallo({ ...FORMULARIO, pais })).toMatchObject({ status: 400, campo: 'pais' });
    }
  });

  it('rechaza un CP que no existe o de otra provincia', async () => {
    const r = await fallo({ ...FORMULARIO, codigoPostal: '64120' });
    expect(r).toMatchObject({ status: 400, campo: 'codigoPostal' });
    expect(r.mensaje).toMatch(/64120 no existe/);
    expect(await fallo({ ...FORMULARIO, codigoPostal: '03120' })).toMatchObject({ status: 400, campo: 'codigoPostal' });
  });

  it('si lo que se cambia es la provincia, senala la provincia', async () => {
    const r = await fallo({ ...FORMULARIO, provincia: 'Alicante' });
    expect(r).toMatchObject({ status: 400, campo: 'provincia' });
    expect(r.mensaje).toBe('El código postal 46120 es de Valencia, no de Alicante. Revisa el código postal o la provincia.');
  });

  it('fuera de Espana el CP es libre', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'PT', tipoSociedad: 'OTRA', nif: 'PT1', codigoPostal: null, provincia: null });
    await legalConfigService.actualizar('E1', { codigoPostal: '1100-048', provincia: 'Lisboa' });
    expect(guardado()).toMatchObject({ codigoPostal: '1100-048' });
  });
});

describe('moneda de la contabilidad al editar (divisas-iva)', () => {
  /** Empresa de Hong Kong sin NIF espanol: lo que se toca es el pais y la moneda. */
  const HK = { pais: 'HK', tipoSociedad: 'OTRA', nif: 'HK-1234567', codigoPostal: '999077', provincia: null, monedaCuenta: 'EUR' };

  it('sin facturas ni asientos, al pasar a EE. UU. la contabilidad y las cuentas bancarias pasan a USD', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ ...HK, pais: 'PT' });
    const r = await legalConfigService.actualizar('E1', { pais: 'US' });
    expect(guardado()).toMatchObject({ pais: 'US', monedaCuenta: 'USD' });
    // Se guarda en una transaccion junto con el cambio de las cuentas bancarias.
    expect(bd.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.bankAccount.updateMany).toHaveBeenCalledWith({ where: { companyId: 'E1', moneda: 'EUR' }, data: { moneda: 'USD' } });
    expect(r).toMatchObject({ monedaCuentaEditable: true });
  });

  it('con facturas, no se puede pasar de Espana a otro pais: 400 y no se guarda', async () => {
    bd.incomeInvoice.findFirst.mockResolvedValue({ id: 'F1' });
    const r = await fallo({ pais: 'US' });
    expect(r.status).toBe(400);
    expect(r.mensaje).toMatch(/no se puede cambiar a otro país/);
    expect(bd.legalConfig.upsert).not.toHaveBeenCalled();
  });

  it('con nominas en borrador (sin asiento), no se puede pasar de Espana a EE. UU.: 400 y no se guarda', async () => {
    bd.nomina.findFirst.mockResolvedValue({ id: 'N1' });
    const r = await fallo({ pais: 'US' });
    expect(r.status).toBe(400);
    expect(r.mensaje).toMatch(/nóminas/);
    expect(bd.legalConfig.upsert).not.toHaveBeenCalled();
    // Las anuladas no cuentan.
    expect(bd.nomina.findFirst).toHaveBeenCalledWith({ where: { companyId: 'E1', estado: { not: 'ANULADA' } }, select: { id: true } });
  });

  it('con seguros sociales guardados, la moneda de la contabilidad tampoco cambia', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ ...HK, pais: 'PT' });
    bd.liquidacionSS.findFirst.mockResolvedValue({ id: 'SS1' });
    expect((await fallo({ pais: 'US', monedaCuenta: 'USD' })).status).toBe(400);
    expect(tx.bankAccount.updateMany).not.toHaveBeenCalled();
  });

  it('NIF nuevo y cambio de moneda a la vez: NIF libre, datos y cuentas bancarias en la misma transaccion', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'PT', tipoSociedad: 'OTRA', nif: 'PT1', codigoPostal: '1100-048', provincia: null, monedaCuenta: 'EUR' });
    await legalConfigService.actualizar('E1', { pais: 'US', nif: '98-7654321' });
    expect(bd.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.bankAccount.updateMany).toHaveBeenCalledWith({ where: { companyId: 'E1', moneda: 'EUR' }, data: { moneda: 'USD' } });
    // Primero se comprueba el NIF; despues se guarda y se pasan las cuentas.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(bd.legalConfig.upsert.mock.invocationCallOrder[0]);
    expect(bd.legalConfig.upsert.mock.invocationCallOrder[0]).toBeLessThan(tx.bankAccount.updateMany.mock.invocationCallOrder[0]);
    expect(guardado()).toMatchObject({ pais: 'US', monedaCuenta: 'USD' });
  });

  it('NIF nuevo y cambio de moneda: si la transaccion choca con otra (P2034), 409 en el NIF', async () => {
    bd.legalConfig.findUnique.mockResolvedValue({ pais: 'PT', tipoSociedad: 'OTRA', nif: 'PT1', codigoPostal: '1100-048', provincia: null, monedaCuenta: 'EUR' });
    bd.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Write conflict', { code: 'P2034', clientVersion: 'test' }));
    expect(await fallo({ pais: 'US', nif: '98-7654321' })).toMatchObject({ status: 409, campo: 'nif' });
  });

  it('las comprobaciones de modo-admin van antes: un pais que no existe da 400 en el pais', async () => {
    expect(await fallo({ pais: 'SP' })).toMatchObject({ status: 400, campo: 'pais' });
    expect(bd.incomeInvoice.findFirst).not.toHaveBeenCalled();
  });

  it('sin cambiar pais ni moneda no se toca la moneda ni las cuentas bancarias', async () => {
    await legalConfigService.actualizar('E1', FORMULARIO);
    expect(guardado()).not.toHaveProperty('monedaCuenta');
    expect(tx.bankAccount.updateMany).not.toHaveBeenCalled();
  });
});
