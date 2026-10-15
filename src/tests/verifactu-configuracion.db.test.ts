/**
 * Pantalla Configuracion > VERI*FACTU (GET /verifactu/configuracion,
 * configuracion.service) y avisos del certificado en Ventas (GET
 * /verifactu/red-seguridad) sobre BD real, con el reloj fijado.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { controlCif } from '../utils/nif';
import { configuracionVerifactu, posibleForal } from '../services/verifactu/configuracion.service';
import { estadoRedEmpresa } from '../services/verifactu/redSeguridad';
import { subirCertificado } from '../services/verifactu/certificado.service';
import { marcarEmpresaPruebas } from './ayuda-empresa-pruebas';
import { hoyEspana, sumarDiasISO } from '../utils/fechas';
import { crearCa, crearCertificado, pkcs12, sujetoRepresentante } from './ayuda-certificados';

jest.setTimeout(120_000);

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const cif = () => {
  const siete = String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0');
  return `A${siete}${controlCif(siete).cifra}`;
};
const E = `vfcfg-${SUFIJO}`;
const US = `vfcfg-us-${SUFIJO}`;
const PRU = `vfcfg-pru-${SUFIJO}`;
const NIF_E = cif();
const CLAVE = 'clave-de-prueba';
const DIA = 86_400_000;
let tAdmin = '';
let tVentas = '';
let caducaEn: Date;

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `vfcfg-admin-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) }, select: { id: true, email: true } });
  const ventas = await prisma.user.create({ data: { email: `vfcfg-ventas-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) }, select: { id: true, email: true } });
  tAdmin = authService.generateToken({ userId: admin.id, email: admin.email, roles: [], companies: [] });
  tVentas = authService.generateToken({ userId: ventas.id, email: ventas.email, roles: [], companies: [] });
  for (const id of [E, US, PRU]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.membership.create({ data: { userId: admin.id, companyId: id, role: 'admin' } });
  }
  await prisma.membership.create({ data: { userId: ventas.id, companyId: E, role: 'ventas' } });
  await prisma.legalConfig.create({ data: { companyId: E, tipoSociedad: 'SA', denominacion: 'EMPRESA CFG SA', nif: NIF_E, domicilioSocial: 'Calle 1', codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia' } });
  await prisma.legalConfig.create({ data: { companyId: US, tipoSociedad: 'LLC', pais: 'US', monedaCuenta: 'USD', denominacion: 'Foreign LLC', nif: '12-3456789' } });
  await prisma.legalConfig.create({ data: { companyId: PRU, tipoSociedad: 'SA', denominacion: 'EMPRESA CFG SA', nif: NIF_E } });
  await marcarEmpresaPruebas(prisma, PRU, E);
  await prisma.verifactuConfig.create({ data: { companyId: PRU, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
  const ca = crearCa();
  await subirCertificado(E, admin.id, { pfx: pkcs12({ cert: crearCertificado({ sujeto: sujetoRepresentante(NIF_E, 'EMPRESA CFG SA'), firmante: ca }), contrasena: CLAVE }), contrasena: CLAVE });
  caducaEn = (await prisma.verifactuCertificado.findUniqueOrThrow({ where: { companyId: E }, select: { caducaEn: true } })).caducaEn;
});

describe('Configuracion > VERI*FACTU (BD real)', () => {
  it('forma del GET: obligado, exclusion, estado, certificado, checklist sin activar y sistema informatico', async () => {
    const r = await request(app).get(`/companies/${E}/verifactu/configuracion`).set('Authorization', `Bearer ${tAdmin}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      aplica: true,
      empresa: { denominacion: 'EMPRESA CFG SA', nif: NIF_E, faltan: [], obligadoCongelado: null, domicilio: { direccion: 'Calle 1', cp: '46001', municipio: 'Valencia', provincia: 'Valencia' } },
      empresaPruebas: null,
      exclusion: { motivoExclusion: null, siiEnAjustes: false, posibleForal: false },
      estado: 'DESACTIVADO',
      entorno: 'PRUEBAS',
      activaDesde: null,
      puedeActivar: false,
      sistema: { nombre: 'Conta API', id: 'CA', version: '0.1.0', productor: { nombre: 'IFBIOSOLUCIONES, S.A.', nif: 'A10952364' }, numeroInstalacion: null },
    });
    expect(d.certificado).toMatchObject({ nifTitular: NIF_E, aviso: null });
    expect(d.checklist.map((c: { clave: string }) => c.clave)).toEqual(['datos', 'certificado', 'conexionProduccion', 'pruebas', 'declaracion', 'exclusion', 'version']);
    const cumplido = Object.fromEntries(d.checklist.map((c: { clave: string; cumplido: boolean }) => [c.clave, c.cumplido]));
    expect(cumplido).toEqual({ datos: true, certificado: true, conexionProduccion: false, pruebas: false, declaracion: false, exclusion: true, version: false });
    // Solo el administrador.
    expect((await request(app).get(`/companies/${E}/verifactu/configuracion`).set('Authorization', `Bearer ${tVentas}`)).status).toBe(403);
  });

  it('avisos de caducidad a 30 dias, a 7 y caducado (reloj fijado), tambien en Ventas', async () => {
    // `dias` dias naturales antes del dia en que caduca (hora de Madrid), a mediodia.
    const a = (dias: number) => new Date(`${sumarDiasISO(hoyEspana(caducaEn), -dias)}T10:00:00Z`);
    expect((await configuracionVerifactu(E, a(40))).certificado?.aviso).toBeNull();
    expect((await configuracionVerifactu(E, a(29))).certificado).toMatchObject({ aviso: 'CADUCA_30', diasParaCaducar: 29 });
    expect((await configuracionVerifactu(E, a(6))).certificado?.aviso).toBe('CADUCA_7');
    const caducado = await configuracionVerifactu(E, new Date(caducaEn.getTime() + DIA));
    expect(caducado.certificado?.aviso).toBe('CADUCADO');
    expect(caducado.checklist.find((c) => c.clave === 'certificado')?.cumplido).toBe(false);
    expect((await estadoRedEmpresa(E, a(40))).avisoCertificado).toBeNull();
    expect((await estadoRedEmpresa(E, a(29))).avisoCertificado).toMatchObject({ nivel: 'aviso' });
    expect((await estadoRedEmpresa(E, a(6))).avisoCertificado).toMatchObject({ nivel: 'urgente' });
    expect((await estadoRedEmpresa(E, new Date(caducaEn.getTime() + DIA))).avisoCertificado).toMatchObject({ nivel: 'caducado' });
    expect((await estadoRedEmpresa(E, a(6))).avisoCertificado?.texto).toMatch(/caduca en 6 días/);
  });

  it('GET /red-seguridad dice si la empresa es de pruebas', async () => {
    const r = await request(app).get(`/companies/${E}/verifactu/red-seguridad`).set('Authorization', `Bearer ${tVentas}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ empresaPruebas: false, avisoCertificado: null });
    expect((await estadoRedEmpresa(PRU)).empresaPruebas).toBe(true);
  });

  it('empresa de pruebas: dice de que empresa es; empresa extranjera: aplica false', async () => {
    const pru = await configuracionVerifactu(PRU);
    expect(pru).toMatchObject({ empresaPruebas: { de: { id: E, nombre: `Empresa ${E}` } }, estado: 'PRUEBAS', entorno: 'PRUEBAS', certificado: null });
    expect(pru.empresa.faltan).toEqual(['domicilio']);
    expect((await configuracionVerifactu(US)).aplica).toBe(false);
  });

  it('posible regimen foral por la provincia o el codigo postal', () => {
    expect(posibleForal('Álava', null)).toBe(true);
    expect(posibleForal('Bizkaia', null)).toBe(true);
    expect(posibleForal('Navarra', null)).toBe(true);
    expect(posibleForal(null, '20001')).toBe(true);
    expect(posibleForal('Valencia', '46001')).toBe(false);
  });
});
