/**
 * Red de seguridad de VERI*FACTU sobre BD real (spec verifactu, 9.5).
 *
 * Desde el 1-1-2027 a las 00:00 de Madrid la emision FINAL de una empresa
 * espanola sin VERI*FACTU activo da 409 VERIFACTU_INACTIVO en los tres caminos
 * (finalizar, emision directa de crear y rectificativa emitida). Borradores,
 * proformas, duplicar, pasar a factura y el lector nunca se bloquean. El
 * interruptor solo lo toca el administrador global, con referencia del BOE.
 *
 * El reloj de la red se fija con VERIFACTU_RED_RELOJ_PRUEBAS (ver redSeguridad.ts).
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { CLAVE_RED_SEGURIDAD, CODIGO_VERIFACTU_INACTIVO } from '../services/verifactu/redSeguridad';
import { hoyEspana } from '../utils/fechas';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const ES = `vfred-es-${SUFIJO}`;
const US = `vfred-us-${SUFIJO}`;
const SII = `vfred-sii-${SUFIJO}`;
const FORAL = `vfred-foral-${SUFIJO}`;
const EMPRESAS = [ES, US, SII, FORAL];
const clientes: Record<string, string> = {};
let tokenAdminEmpresa = '';
let tokenAdminGlobal = '';
let idAdminGlobal = '';

// 31-12-2026 a las 23:59:59 y 1-1-2027 a las 00:00:00, hora de Madrid.
const ANTES = '2026-12-31T22:59:59Z';
const DESDE = '2026-12-31T23:00:00Z';
const relojRed = (instante: string) => {
  process.env.VERIFACTU_RED_RELOJ_PRUEBAS = instante;
};
const RELOJ_INICIAL = process.env.VERIFACTU_RED_RELOJ_PRUEBAS;

// La fecha de la factura no puede ser futura (P3): se emite con la de hoy.
const HOY = hoyEspana();
const linea = (precio = 100) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const emitir = (companyId: string, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: clientes[companyId] }, fechaEmision: HOY, lineas: [linea()], ...extra });
const borrador = (companyId: string) => emitir(companyId, { borrador: true });

/** Espera el 409 de la red con su codigo. */
async function esperarBloqueo(promesa: Promise<unknown>) {
  await expect(promesa).rejects.toMatchObject({
    statusCode: 409,
    details: { codigo: CODIGO_VERIFACTU_INACTIVO },
    message: expect.stringMatching(/VERI\*FACTU/),
  });
}

const ultimoNumero = async (companyId: string, codigo = 'A') =>
  (await prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo } } }))?.ultimoNumero ?? 0;

beforeAll(async () => {
  for (const id of EMPRESAS) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    clientes[id] = (await prisma.customer.create({ data: { companyId: id, nombreFiscal: `Cliente ${id}`, nifCif: 'B12345674', pais: 'ES' } })).id;
  }
  await prisma.legalConfig.create({ data: { companyId: ES, tipoSociedad: 'SL', denominacion: 'Red Test SL', nif: 'B11111111' } });
  await prisma.legalConfig.create({ data: { companyId: SII, tipoSociedad: 'SA', denominacion: 'Red SII SA', nif: 'A11111111' } });
  await prisma.legalConfig.create({ data: { companyId: FORAL, tipoSociedad: 'SL', denominacion: 'Red Foral SL', nif: 'B22222222' } });
  await prisma.legalConfig.create({
    data: { companyId: US, tipoSociedad: 'LLC', pais: 'US', monedaCuenta: 'USD', denominacion: 'Red Test LLC', nif: '12-3456789' },
  });
  await prisma.ajustesFiscales.create({ data: { companyId: SII, sii: true, periodicidadIva: 'MENSUAL' } });
  await prisma.verifactuConfig.create({ data: { companyId: FORAL, motivoExclusion: 'FORAL' } });

  // Administrador de la empresa ES y administrador global de la plataforma.
  const u = await prisma.user.create({ data: { email: `vfred-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
  await prisma.membership.create({ data: { userId: u.id, companyId: ES, role: 'admin' } });
  await prisma.membership.create({ data: { userId: u.id, companyId: US, role: 'admin' } });
  tokenAdminEmpresa = authService.generateToken({ userId: u.id, email: u.email, roles: [], companies: [] });
  const g = await prisma.user.create({
    data: { email: `vfred-g-${SUFIJO}@test.local`, isGlobalAdmin: true, passwordHash: hashPassword(randomBytes(18).toString('base64url')) },
  });
  idAdminGlobal = g.id;
  tokenAdminGlobal = authService.generateToken({ userId: g.id, email: g.email, roles: [], companies: [] });
});

afterEach(() => {
  if (RELOJ_INICIAL === undefined) delete process.env.VERIFACTU_RED_RELOJ_PRUEBAS;
  else process.env.VERIFACTU_RED_RELOJ_PRUEBAS = RELOJ_INICIAL;
});

afterAll(async () => {
  await prisma.ajustePlataforma.deleteMany({ where: { clave: CLAVE_RED_SEGURIDAD } });
  await prisma.auditLog.deleteMany({ where: { userId: idAdminGlobal } });
  await prisma.verifactuConfig.deleteMany({ where: { companyId: { in: EMPRESAS } } });
  await prisma.user.deleteMany({ where: { email: { in: [`vfred-${SUFIJO}@test.local`, `vfred-g-${SUFIJO}@test.local`] } } });
});

describe('fecha por hora de Madrid', () => {
  it('31-12-2026 a las 23:59:59 en Madrid: se emite', async () => {
    relojRed(ANTES);
    const f = await emitir(ES);
    expect(f.estadoDocumento).toBe('FINAL');
  });

  it('1-1-2027 a las 00:00 en Madrid: la emisión directa da 409 sin gastar número ni crear el cliente nuevo', async () => {
    relojRed(DESDE);
    const antes = await ultimoNumero(ES);
    await esperarBloqueo(
      incomeInvoicesService.crearIngreso({
        companyId: ES,
        customer: { nuevo: { nombreFiscal: 'Cliente Nuevo Bloqueado SL', nifCif: 'B76543213' } },
        fechaEmision: HOY,
        lineas: [linea()],
      }),
    );
    expect(await ultimoNumero(ES)).toBe(antes);
    expect(await prisma.customer.count({ where: { companyId: ES, nifCif: 'B76543213' } })).toBe(0);
  });
});

describe('los tres caminos que emiten', () => {
  it('finalizar un borrador: 409 y el borrador sigue como estaba', async () => {
    relojRed(ANTES);
    const b = await borrador(ES);
    relojRed(DESDE);
    await esperarBloqueo(incomeInvoicesService.finalizar(ES, b.id, { fechaEmision: HOY }));
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).estadoDocumento).toBe('BORRADOR');
  });

  it('rectificativa emitida al momento: 409; como borrador, sí', async () => {
    relojRed(ANTES);
    const f = await emitir(ES);
    relojRed(DESDE);
    await esperarBloqueo(incomeInvoicesService.crearRectificativa(ES, f.id, { motivo: 'Error en el precio' }));
    const r = await incomeInvoicesService.crearRectificativa(ES, f.id, { motivo: 'Error en el precio', borrador: true });
    expect(r.estadoDocumento).toBe('BORRADOR');
  });

  it('por HTTP: POST .../finalizar responde 409 con details.codigo VERIFACTU_INACTIVO', async () => {
    relojRed(ANTES);
    const b = await borrador(ES);
    relojRed(DESDE);
    const res = await request(app)
      .post(`/companies/${ES}/income-invoices/${b.id}/finalizar`)
      .set('Authorization', `Bearer ${tokenAdminEmpresa}`)
      .send({ fechaEmision: HOY });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ codigo: CODIGO_VERIFACTU_INACTIVO, code: CODIGO_VERIFACTU_INACTIVO });
    expect(res.body.message).toMatch(/borrador o como proforma/);
  });
});

describe('lo que nunca se bloquea', () => {
  it('borrador, proforma, duplicar y pasar a factura', async () => {
    relojRed(DESDE);
    const b = await borrador(ES);
    expect(b.estadoDocumento).toBe('BORRADOR');
    const p = await emitir(ES, { proforma: true });
    expect(p.estadoDocumento).toBe('PROFORMA');
    expect((await incomeInvoicesService.duplicar(ES, b.id)).estadoDocumento).toBe('BORRADOR');
    expect((await incomeInvoicesService.pasarProformaAFactura(ES, p.id)).estadoDocumento).toBe('BORRADOR');
  });

  it('la factura que llega del lector (la expidió otro programa)', async () => {
    relojRed(DESDE);
    const f = await incomeInvoicesService.crearIngreso(
      { companyId: ES, customer: { id: clientes[ES] }, serie: 'LEC', numero: 7, fechaEmision: HOY, lineas: [linea()] },
      { origen: 'lector' },
    );
    expect(f.estadoDocumento).toBe('FINAL');
  });

  it('empresa extranjera (EE. UU.)', async () => {
    relojRed(DESDE);
    expect((await emitir(US, { lineas: [{ ...linea(), tipoIva: 0, moneda: 'USD' }] })).estadoDocumento).toBe('FINAL');
  });

  it('empresa en el SII y empresa foral', async () => {
    relojRed(DESDE);
    expect((await emitir(SII)).estadoDocumento).toBe('FINAL');
    expect((await emitir(FORAL)).estadoDocumento).toBe('FINAL');
  });
});

describe('aviso previo para Ventas (GET /verifactu/red-seguridad)', () => {
  const estado = (companyId: string) =>
    request(app).get(`/companies/${companyId}/verifactu/red-seguridad`).set('Authorization', `Bearer ${tokenAdminEmpresa}`);

  it('antes del 1-12-2026: sin aviso ni bloqueo', async () => {
    relojRed('2026-11-30T22:59:59Z'); // 30-11 a las 23:59:59 en Madrid
    const res = await estado(ES);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ aplica: true, bloquea: false, aviso: null, inicio: '2027-01-01' });
  });

  it('desde el 1-12-2026: aviso, pero todavía se puede emitir', async () => {
    relojRed('2026-11-30T23:00:00Z'); // 1-12 a las 00:00 en Madrid
    const res = await estado(ES);
    expect(res.body.data).toMatchObject({ bloquea: false, motivo: null });
    expect(res.body.data.aviso).toMatch(/Desde el 1-1-2027 no podrás emitir facturas desde aquí sin VERI\*FACTU/);
  });

  it('desde el 1-1-2027: bloquea, con el motivo para el botón «Emitir»', async () => {
    relojRed(DESDE);
    const res = await estado(ES);
    expect(res.body.data).toMatchObject({ bloquea: true, aviso: null });
    expect(res.body.data.motivo).toMatch(/borrador o como proforma/);
  });

  it('empresa extranjera: no le aplica', async () => {
    relojRed(DESDE);
    const res = await estado(US);
    expect(res.body.data).toMatchObject({ aplica: false, bloquea: false, aviso: null });
  });
});

describe('interruptor del administrador global', () => {
  const ruta = '/admin/verifactu/red-seguridad';
  const comoGlobal = () => ({ Authorization: `Bearer ${tokenAdminGlobal}` });

  it('el administrador de una empresa no lo ve ni lo cambia', async () => {
    expect((await request(app).get(ruta).set('Authorization', `Bearer ${tokenAdminEmpresa}`)).status).toBe(403);
    const res = await request(app)
      .put(ruta)
      .set('Authorization', `Bearer ${tokenAdminEmpresa}`)
      .send({ activa: false, referenciaBoe: 'BOE-A-2026-24840', motivo: 'Aplazamiento' });
    expect(res.status).toBe(403);
  });

  it('sin fila, la red está activa', async () => {
    await prisma.ajustePlataforma.deleteMany({ where: { clave: CLAVE_RED_SEGURIDAD } });
    const res = await request(app).get(ruta).set(comoGlobal());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ activa: true, referenciaBoe: null });
  });

  it('desactivar exige la referencia del BOE (BOE-A-AAAA-NNNNN) y un motivo', async () => {
    const sinRef = await request(app).put(ruta).set(comoGlobal()).send({ activa: false, motivo: 'Aplazamiento' });
    expect(sinRef.status).toBe(400);
    expect(sinRef.body.details).toEqual({ campo: 'referenciaBoe' });
    const malRef = await request(app).put(ruta).set(comoGlobal()).send({ activa: false, referenciaBoe: 'RD 254/2026', motivo: 'Aplazamiento' });
    expect(malRef.status).toBe(400);
    const sinMotivo = await request(app).put(ruta).set(comoGlobal()).send({ activa: false, referenciaBoe: 'BOE-A-2026-24840' });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.details).toEqual({ campo: 'motivo' });
    expect((await request(app).get(ruta).set(comoGlobal())).body.data.activa).toBe(true);
  });

  it('desactivada: se emite aunque sea 2027, y queda en la auditoría; al reactivarla vuelve a bloquear', async () => {
    const res = await request(app)
      .put(ruta)
      .set(comoGlobal())
      .send({ activa: false, referenciaBoe: ' boe-a-2026-24840 ', motivo: 'El BOE aplaza la obligación a 2028' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ activa: false, referenciaBoe: 'BOE-A-2026-24840', motivo: 'El BOE aplaza la obligación a 2028' });

    const auditoria = await prisma.auditLog.findFirst({
      where: { userId: idAdminGlobal, action: 'RED_SEGURIDAD_CAMBIADA' },
      orderBy: { timestamp: 'desc' },
    });
    expect(auditoria?.meta).toMatchObject({ antes: { activa: true }, despues: { activa: false, referenciaBoe: 'BOE-A-2026-24840' } });

    try {
      relojRed(DESDE);
      expect((await emitir(ES)).estadoDocumento).toBe('FINAL');
    } finally {
      const vuelta = await request(app).put(ruta).set(comoGlobal()).send({ activa: true, motivo: 'Fin de la prueba' });
      expect(vuelta.status).toBe(200);
      expect(vuelta.body.data).toMatchObject({ activa: true, referenciaBoe: null });
    }
    relojRed(DESDE);
    await esperarBloqueo(emitir(ES));
  });
});
