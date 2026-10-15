/**
 * «Probar conexión» de VERI*FACTU (POST /verifactu/certificado/probar y
 * conexion.service) sobre BD real, contra un servidor HTTPS LOCAL que hace de
 * AEAT (nunca prewww1 ni www1), con certificados generados aqui:
 *  - el resultado se guarda en el certificado, con bitacora y AuditLog;
 *  - una prueba por minuto y empresa (429 con los segundos que faltan), tambien
 *    con dos peticiones a la vez y al sustituir o borrar y volver a subir el certificado;
 *  - las notas del certificado de sello y del apoderado;
 *  - siempre al entorno de pruebas, aunque la configuracion diga PRODUCCION
 *    o el cuerpo pida otro;
 *  - sin certificado 404, empresa extranjera 409, certificado caducado sin llamar;
 *  - si el certificado se sustituye a mitad, su resultado no se pisa.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import https from 'https';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { controlCif } from '../utils/nif';
import { fijarDestinoParaTests } from '../services/verifactu/cliente-aeat';
import { borrarCertificado, metadatosCertificado, subirCertificado } from '../services/verifactu/certificado.service';
import { conNotaDelCertificado, NOTAS_CONEXION, probarConexion } from '../services/verifactu/conexion.service';
import { crearCa, crearCertificado, pkcs12, sujetoRepresentante, type CertificadoPrueba } from './ayuda-certificados';

jest.setTimeout(120_000);

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const cif = () => {
  const siete = String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0');
  return `A${siete}${controlCif(siete).cifra}`;
};
const E = `vfcon-${SUFIJO}`;
const E2 = `vfcon-dos-${SUFIJO}`;
const E3 = `vfcon-tres-${SUFIJO}`;
const SIN = `vfcon-sin-${SUFIJO}`;
const US = `vfcon-us-${SUFIJO}`;
const CLAVE = 'clave-de-prueba';
const NS = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/';
const SIN_DATOS = `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><r:RespuestaConsultaFactuSistemaFacturacion xmlns:r="${NS}RespuestaConsultaLR.xsd"><r:IndicadorPaginacion>N</r:IndicadorPaginacion><r:ResultadoConsulta>SinDatos</r:ResultadoConsulta></r:RespuestaConsultaFactuSistemaFacturacion></env:Body></env:Envelope>`;

let ca: CertificadoPrueba;
let servidor: https.Server;
let peticiones: string[] = [];
let alResponder: () => Promise<void> = async () => undefined;
let adminId = '';
let tAdmin = '';
let pfxE3: Buffer;

beforeAll(async () => {
  ca = crearCa();
  const srv = crearCertificado({ sujeto: [{ name: 'commonName', value: 'localhost' }], firmante: ca, dns: ['localhost'], ips: ['127.0.0.1'] });
  servidor = https.createServer({ key: srv.clavePem, cert: srv.certPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', async () => {
      peticiones.push(cuerpo);
      await alResponder();
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(SIN_DATOS);
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', () => ok()));
  fijarDestinoParaTests({ url: `https://localhost:${(servidor.address() as AddressInfo).port}/`, ca: ca.certPem });

  const admin = await prisma.user.create({ data: { email: `vfcon-admin-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) }, select: { id: true, email: true } });
  adminId = admin.id;
  tAdmin = authService.generateToken({ userId: admin.id, email: admin.email, roles: [], companies: [] });
  for (const id of [E, E2, E3, SIN, US]) {
    const nif = cif();
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.legalConfig.create({
      data: id === US ? { companyId: id, tipoSociedad: 'LLC', pais: 'US', monedaCuenta: 'USD', denominacion: 'Foreign LLC', nif: '12-3456789' } : { companyId: id, tipoSociedad: 'SA', denominacion: `EMPRESA ${id}`, nif },
    });
    await prisma.membership.create({ data: { userId: admin.id, companyId: id, role: 'admin' } });
    if (id === E || id === E2 || id === E3) {
      const cert = crearCertificado({ sujeto: sujetoRepresentante(nif, `EMPRESA ${id}`), firmante: ca });
      const pfx = pkcs12({ cert, contrasena: CLAVE });
      if (id === E3) pfxE3 = pfx;
      await subirCertificado(id, admin.id, { pfx, contrasena: CLAVE });
    }
  }
  // La configuracion dice PRODUCCION: la prueba tiene que ir igualmente al entorno de pruebas.
  await prisma.verifactuConfig.create({ data: { companyId: E, estado: 'DESACTIVADO', entorno: 'PRODUCCION' } });
});

afterAll(async () => {
  fijarDestinoParaTests(null);
  await new Promise<void>((ok) => servidor.close(() => ok()));
});

describe('probar la conexion con la AEAT (BD real, servidor local)', () => {
  it('por la API: siempre PRUEBAS (se ignora el entorno del cuerpo), resultado guardado, bitacora y AuditLog', async () => {
    peticiones = [];
    const r = await request(app).post(`/companies/${E}/verifactu/certificado/probar`).set('Authorization', `Bearer ${tAdmin}`).send({ entorno: 'PRODUCCION' });
    expect(r.status).toBe(200);
    expect(r.body.data.resultado).toMatchObject({ ok: true, tipo: 'CORRECTO', entorno: 'PRUEBAS', httpStatus: 200 });
    expect(r.body.data.resultado.mensaje).toContain('entorno de pruebas');
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0]).toContain('<con:ConsultaFactuSistemaFacturacion');
    // Solo una factura que no existe: la AEAT contesta siempre poco.
    expect(peticiones[0]).toContain('<con:NumSerieFactura>PRUEBA-CONEXION-CONTA-API</con:NumSerieFactura>');
    const fila = await prisma.verifactuCertificado.findUniqueOrThrow({ where: { companyId: E }, select: { pruebaConexionOk: true, pruebaConexionTipo: true, pruebaConexionEntorno: true, pruebaConexionFecha: true } });
    expect(fila).toMatchObject({ pruebaConexionOk: true, pruebaConexionTipo: 'CORRECTO', pruebaConexionEntorno: 'PRUEBAS' });
    expect(await prisma.verifactuBitacora.count({ where: { companyId: E, tipo: 'CONEXION_PROBADA' } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'VERIFACTU_CONEXION_PROBADA' } });
    expect(audit.meta).toMatchObject({ entorno: 'PRUEBAS', ok: true, tipo: 'CORRECTO' });
    expect(JSON.stringify(audit.meta)).not.toContain(CLAVE);
    // La configuracion no cambia.
    expect(await prisma.verifactuConfig.findUniqueOrThrow({ where: { companyId: E } })).toMatchObject({ estado: 'DESACTIVADO', entorno: 'PRODUCCION' });
  });

  it('otra prueba antes de un minuto: 429 con los segundos que faltan, sin llamar', async () => {
    peticiones = [];
    const r = await request(app).post(`/companies/${E}/verifactu/certificado/probar`).set('Authorization', `Bearer ${tAdmin}`).send({});
    expect(r.status).toBe(429);
    expect(r.body.details).toMatchObject({ codigo: 'VERIFACTU_PRUEBA_RECIENTE' });
    expect(r.body.details.esperarSegundos).toBeGreaterThan(0);
    expect(r.body.details.esperarSegundos).toBeLessThanOrEqual(60);
    expect(peticiones).toHaveLength(0);
  });

  it('sin certificado 404; empresa extranjera 409', async () => {
    const sin = await request(app).post(`/companies/${SIN}/verifactu/certificado/probar`).set('Authorization', `Bearer ${tAdmin}`).send({});
    expect(sin.status).toBe(404);
    expect(sin.body.details).toMatchObject({ codigo: 'VERIFACTU_SIN_CERTIFICADO' });
    const us = await request(app).post(`/companies/${US}/verifactu/certificado/probar`).set('Authorization', `Bearer ${tAdmin}`).send({});
    expect(us.status).toBe(409);
    expect(us.body.details).toMatchObject({ codigo: 'VERIFACTU_NO_APLICA' });
  });

  it('si el certificado se sustituye mientras se prueba, el resultado no se guarda en el nuevo (el minuto, si)', async () => {
    peticiones = [];
    alResponder = async () => {
      await prisma.verifactuCertificado.update({ where: { companyId: E2 }, data: { huellaSha256: 'F'.repeat(64) } });
    };
    const ahora = new Date();
    try {
      const r = await probarConexion(E2, adminId, ahora);
      expect(r.ok).toBe(true);
    } finally {
      alResponder = async () => undefined;
    }
    const fila = await prisma.verifactuCertificado.findUniqueOrThrow({ where: { companyId: E2 }, select: { pruebaConexionFecha: true, pruebaConexionOk: true } });
    expect(fila.pruebaConexionOk).toBeNull();
    expect(fila.pruebaConexionFecha?.getTime()).toBe(ahora.getTime());
    // El rastro si queda, con la huella del certificado que se probo.
    const b = await prisma.verifactuBitacora.findFirstOrThrow({ where: { companyId: E2, tipo: 'CONEXION_PROBADA' } });
    expect((b.detalle as { huellaCertificado: string }).huellaCertificado).not.toBe('F'.repeat(64));
  });

  it('certificado caducado: CERTIFICADO_CADUCADO sin llamar a la AEAT', async () => {
    peticiones = [];
    await prisma.verifactuCertificado.update({ where: { companyId: E2 }, data: { caducaEn: new Date('2026-01-31T12:00:00Z'), pruebaConexionFecha: null } });
    // Pasado el minuto de la prueba anterior (que tambien queda en la bitacora).
    const r = await probarConexion(E2, adminId, new Date(Date.now() + 61_000));
    expect(r).toMatchObject({ ok: false, tipo: 'CERTIFICADO_CADUCADO', entorno: 'PRUEBAS' });
    expect(r.mensaje).toContain('31-01-2026');
    expect(peticiones).toHaveLength(0);
  });

  it('dos pruebas a la vez: una sola consulta a la AEAT; la otra, 429', async () => {
    peticiones = [];
    const [a, b] = await Promise.allSettled([probarConexion(E3, adminId, new Date()), probarConexion(E3, adminId, new Date())]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rechazo = [a, b].find((x): x is PromiseRejectedResult => x.status === 'rejected')!;
    expect(rechazo.reason).toMatchObject({ statusCode: 429, details: { codigo: 'VERIFACTU_PRUEBA_RECIENTE' } });
    expect(peticiones).toHaveLength(1);
  });

  it('sustituir por el mismo fichero, o borrarlo y volver a subirlo, no da otra prueba antes del minuto', async () => {
    peticiones = [];
    await subirCertificado(E3, adminId, { pfx: pfxE3, contrasena: CLAVE });
    const m = await metadatosCertificado(E3);
    // El resultado era del certificado anterior; el minuto sigue contando.
    expect(m?.ultimaPrueba).toBeNull();
    expect(new Date(m!.proximaPruebaDesde!).getTime()).toBeGreaterThan(Date.now());
    await expect(probarConexion(E3, adminId, new Date())).rejects.toMatchObject({ statusCode: 429 });
    await borrarCertificado(E3, adminId);
    await subirCertificado(E3, adminId, { pfx: pfxE3, contrasena: CLAVE });
    await expect(probarConexion(E3, adminId, new Date())).rejects.toMatchObject({ statusCode: 429, details: { codigo: 'VERIFACTU_PRUEBA_RECIENTE' } });
    expect(peticiones).toHaveLength(0);
    // Pasado el minuto, si.
    const r = await probarConexion(E3, adminId, new Date(Date.now() + 61_000));
    expect(r.ok).toBe(true);
    expect(peticiones).toHaveLength(1);
    expect((await metadatosCertificado(E3, new Date(Date.now() + 200_000)))?.proximaPruebaDesde).toBeNull();
  });

  it('notas: certificado de sello que falla (va a otra direccion) y apoderado que pasa (el envio se comprueba aparte)', () => {
    const fallo = { ok: false, tipo: 'CERTIFICADO_RECHAZADO' as const, mensaje: 'La AEAT no acepta este certificado.' };
    const bien = { ok: true, tipo: 'CORRECTO' as const, mensaje: 'Conexión correcta.' };
    expect(conNotaDelCertificado(fallo, { tipoCertificado: 'SELLO', actuaComo: 'OBLIGADO' }).mensaje).toBe(`${fallo.mensaje} ${NOTAS_CONEXION.sello}`);
    expect(conNotaDelCertificado(bien, { tipoCertificado: 'SELLO', actuaComo: 'OBLIGADO' }).mensaje).toBe(bien.mensaje);
    expect(conNotaDelCertificado({ ...fallo, tipo: 'CERTIFICADO_CADUCADO' }, { tipoCertificado: 'SELLO', actuaComo: 'OBLIGADO' }).mensaje).toBe(fallo.mensaje);
    expect(conNotaDelCertificado(bien, { tipoCertificado: 'REPRESENTANTE_PJ', actuaComo: 'APODERADO' }).mensaje).toContain(NOTAS_CONEXION.representacion);
    expect(conNotaDelCertificado(bien, { tipoCertificado: 'PERSONA_FISICA', actuaComo: 'COLABORADOR' }).mensaje).toContain(NOTAS_CONEXION.representacion);
    expect(conNotaDelCertificado(bien, { tipoCertificado: 'REPRESENTANTE_PJ', actuaComo: 'OBLIGADO' })).toEqual(bien);
    expect(conNotaDelCertificado(fallo, { tipoCertificado: 'REPRESENTANTE_PJ', actuaComo: 'APODERADO' })).toEqual(fallo);
  });
});
