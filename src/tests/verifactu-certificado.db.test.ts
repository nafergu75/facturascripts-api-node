/**
 * Certificado de VERI*FACTU por la API (PUT/DELETE /verifactu/certificado y
 * GET /verifactu/configuracion) sobre BD real, con certificados generados aqui
 * (nunca los reales del usuario):
 *  - se guarda cifrado (v1:, ligado a la empresa) y nunca sale el PFX, la
 *    contraseña ni trozos del fichero, ni en las respuestas ni en los logs;
 *  - solo el administrador (config:write); otra empresa no lo ve;
 *  - titular distinto: hay que decir si actua como apoderado o colaborador;
 *  - sustituir, borrar (no con VERI*FACTU activo), bitacora y AuditLog sin secretos.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { controlCif } from '../utils/nif';
import { descifrarV1 } from '../utils/crypto';
import { crearCa, crearCertificado, pkcs12, sujetoRepresentante, type CertificadoPrueba } from './ayuda-certificados';

jest.setTimeout(120_000);

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const cif = (letra: 'A' | 'B') => {
  const siete = String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0');
  return `${letra}${siete}${controlCif(siete).cifra}`;
};
const E = `vfcert-${SUFIJO}`;
const OTRA = `vfcert-otra-${SUFIJO}`;
const NIF_E = cif('A');
const CLAVE = 'Clave del certificado ñ 1';

let ca: CertificadoPrueba;
let pfxPropio: Buffer;
let pfxAjeno: Buffer;
let tAdmin = '';
let tVentas = '';
let tOtra = '';

const token = (userId: string, email: string) => authService.generateToken({ userId, email, roles: [], companies: [] });
const subir = (t: string, pfx: Buffer, campos: Record<string, string> = { contrasena: CLAVE }, empresa = E) => {
  let r = request(app).put(`/companies/${empresa}/verifactu/certificado`).set('Authorization', `Bearer ${t}`).attach('certificado', pfx, 'certificado.p12');
  for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
  return r;
};

/** Todo lo que se escribe en la consola durante la prueba (el logger escribe ahi). */
const consola: string[] = [];
const espias: jest.SpyInstance[] = [];

beforeAll(async () => {
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    espias.push(jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void consola.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))));
  }
  ca = crearCa();
  pfxPropio = pkcs12({ cert: crearCertificado({ sujeto: sujetoRepresentante(NIF_E, 'EMPRESA CERT SA'), firmante: ca }), cadena: [ca], contrasena: CLAVE });
  pfxAjeno = pkcs12({ cert: crearCertificado({ sujeto: sujetoRepresentante(cif('B'), 'GESTORIA SL'), firmante: ca }), contrasena: CLAVE });

  for (const [id, nif] of [[E, NIF_E], [OTRA, cif('B')]]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.legalConfig.create({ data: { companyId: id, tipoSociedad: id === E ? 'SA' : 'SL', denominacion: id === E ? 'EMPRESA CERT SA' : 'OTRA SL', nif, domicilioSocial: 'Calle 1', codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia' } });
  }
  const crear = async (nombre: string, accesos: Array<[string, 'admin' | 'ventas']>) => {
    const u = await prisma.user.create({
      data: { email: `${nombre}-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')), memberships: { create: accesos.map(([companyId, role]) => ({ companyId, role })) } },
      select: { id: true, email: true },
    });
    return token(u.id, u.email);
  };
  tAdmin = await crear('vfcert-admin', [[E, 'admin']]);
  tVentas = await crear('vfcert-ventas', [[E, 'ventas']]);
  tOtra = await crear('vfcert-otra', [[OTRA, 'admin']]);
});

afterAll(() => {
  for (const e of espias) e.mockRestore();
});

/** Ninguna respuesta ni ningun log lleva la contraseña, el cifrado ni trozos del fichero. */
function sinSecretos(texto: string, pfx: Buffer = pfxPropio) {
  expect(texto).not.toContain(CLAVE);
  expect(texto).not.toMatch(/pfxEnc|passEnc|"v1:/);
  const b64 = pfx.toString('base64');
  for (let i = 0; i + 40 <= b64.length; i += 40) expect(texto).not.toContain(b64.slice(i, i + 40));
}

describe('certificado de VERI*FACTU (BD real)', () => {
  it('un usuario de ventas no lo sube ni lo lee (403)', async () => {
    expect((await subir(tVentas, pfxPropio)).status).toBe(403);
    expect((await request(app).get(`/companies/${E}/verifactu/configuracion`).set('Authorization', `Bearer ${tVentas}`)).status).toBe(403);
    expect((await request(app).delete(`/companies/${E}/verifactu/certificado`).set('Authorization', `Bearer ${tVentas}`)).status).toBe(403);
  });

  it('contraseña mala: 400 en el campo contrasena, sin repetirla', async () => {
    const r = await subir(tAdmin, pfxPropio, { contrasena: 'otra clave' });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ campo: 'contrasena', codigo: 'VERIFACTU_CERT_CONTRASENA' });
    expect(JSON.stringify(r.body)).not.toContain('otra clave');
  });

  it('fichero de mas de 64 KB: 400 en el campo certificado', async () => {
    const r = await subir(tAdmin, Buffer.alloc(65 * 1024, 7));
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ campo: 'certificado', codigo: 'VERIFACTU_CERT_GRANDE' });
  });

  it('lo sube el administrador: 200 con los metadatos, guardado cifrado y ligado a la empresa', async () => {
    const r = await subir(tAdmin, pfxPropio);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ sustituido: false, certificado: { titular: 'EMPRESA CERT SA', nifTitular: NIF_E, nifRepresentante: '12345678Z', tipo: 'REPRESENTANTE_PJ', actuaComo: 'OBLIGADO', nifCoincide: true, emisor: 'AC DE PRUEBAS', aviso: null, ultimaPrueba: null } });
    expect(r.body.data.certificado.subidoPor).toMatch(/^vfcert-admin-/);
    sinSecretos(JSON.stringify(r.body));
    const fila = await prisma.verifactuCertificado.findUniqueOrThrow({ where: { companyId: E } });
    expect(fila.pfxEnc.startsWith('v1:')).toBe(true);
    expect(fila.passEnc.startsWith('v1:')).toBe(true);
    expect(descifrarV1(fila.passEnc, `verifactu:${E}:pass`)).toBe(CLAVE);
    expect(Buffer.from(descifrarV1(fila.pfxEnc, `verifactu:${E}:pfx`), 'base64').equals(pfxPropio)).toBe(true);
    // Copiado a otra empresa no se descifra.
    expect(() => descifrarV1(fila.pfxEnc, `verifactu:${OTRA}:pfx`)).toThrow();
    expect(await prisma.verifactuBitacora.count({ where: { companyId: E, tipo: 'CERT_SUBIDO' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'VERIFACTU_CERTIFICADO_SUBIDO' } })).toBe(1);
  });

  it('GET /configuracion lo enseña sin ningun secreto; la otra empresa no lo ve', async () => {
    const r = await request(app).get(`/companies/${E}/verifactu/configuracion`).set('Authorization', `Bearer ${tAdmin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.certificado).toMatchObject({ nifTitular: NIF_E });
    sinSecretos(JSON.stringify(r.body));
    expect((await request(app).get(`/companies/${E}/verifactu/configuracion`).set('Authorization', `Bearer ${tOtra}`)).status).toBe(403);
    const otra = await request(app).get(`/companies/${OTRA}/verifactu/configuracion`).set('Authorization', `Bearer ${tOtra}`);
    expect(otra.body.data.certificado).toBeNull();
  });

  it('titular que no es la empresa: 400 preguntando si actua como apoderado o colaborador; con la respuesta, se sustituye', async () => {
    const sin = await subir(tAdmin, pfxAjeno);
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ campo: 'actuaComo', codigo: 'VERIFACTU_CERT_ACTUA_COMO', titular: 'GESTORIA SL', nifEmpresa: NIF_E });
    expect(sin.body.details.nifTitular).toMatch(/^B/);
    // La prueba de conexion anterior se borra al sustituir.
    await prisma.verifactuCertificado.update({ where: { companyId: E }, data: { pruebaConexionFecha: new Date(), pruebaConexionOk: true, pruebaConexionTipo: 'CORRECTO', pruebaConexionMensaje: 'ok', pruebaConexionEntorno: 'PRUEBAS' } });
    const con = await subir(tAdmin, pfxAjeno, { contrasena: CLAVE, actuaComo: 'APODERADO' });
    expect(con.status).toBe(200);
    expect(con.body.data).toMatchObject({ sustituido: true, certificado: { titular: 'GESTORIA SL', actuaComo: 'APODERADO', nifCoincide: false, ultimaPrueba: null } });
    const fila = await prisma.verifactuCertificado.findUniqueOrThrow({ where: { companyId: E } });
    expect(fila.pruebaConexionFecha).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'VERIFACTU_CERTIFICADO_SUSTITUIDO' } });
    const bitacora = await prisma.verifactuBitacora.findMany({ where: { companyId: E, tipo: 'CERT_SUBIDO' }, orderBy: { createdAt: 'asc' } });
    expect(bitacora).toHaveLength(2);
    expect((bitacora[1].detalle as { sustituye: string }).sustituye).toBe((bitacora[0].detalle as { huellaSha256: string }).huellaSha256);
    sinSecretos(JSON.stringify([audit, bitacora]), pfxAjeno);
    sinSecretos(JSON.stringify([audit, bitacora]));
    // Vuelve el certificado de la empresa.
    expect((await subir(tAdmin, pfxPropio)).status).toBe(200);
  });

  it('borrar: 200; con VERI*FACTU activo, 409 y no se borra; sin certificado, 404', async () => {
    await prisma.verifactuConfig.upsert({ where: { companyId: E }, create: { companyId: E, estado: 'ACTIVO', entorno: 'PRODUCCION' }, update: { estado: 'ACTIVO' } });
    const activo = await request(app).delete(`/companies/${E}/verifactu/certificado`).set('Authorization', `Bearer ${tAdmin}`);
    expect(activo.status).toBe(409);
    expect(activo.body.details).toMatchObject({ codigo: 'VERIFACTU_CERTIFICADO_EN_USO' });
    await prisma.verifactuConfig.update({ where: { companyId: E }, data: { estado: 'DESACTIVADO' } });
    const ok = await request(app).delete(`/companies/${E}/verifactu/certificado`).set('Authorization', `Bearer ${tAdmin}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ borrado: true });
    expect(await prisma.verifactuCertificado.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.verifactuBitacora.count({ where: { companyId: E, tipo: 'CERT_BORRADO' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'VERIFACTU_CERTIFICADO_BORRADO' } })).toBe(1);
    const otra = await request(app).delete(`/companies/${E}/verifactu/certificado`).set('Authorization', `Bearer ${tAdmin}`);
    expect(otra.status).toBe(404);
    expect(otra.body.details).toMatchObject({ codigo: 'VERIFACTU_SIN_CERTIFICADO' });
  });

  it('en los logs no ha salido ningun secreto', () => {
    sinSecretos(consola.join('\n'));
    sinSecretos(consola.join('\n'), pfxAjeno);
  });
});
