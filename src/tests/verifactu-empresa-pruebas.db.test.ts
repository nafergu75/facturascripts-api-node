/**
 * Empresas de pruebas de VERI*FACTU (plan F2, bloque F) sobre BD real: las crea
 * el administrador global, copian los datos de la real, tienen sus series
 * PRU/PRR/PRT y VERI*FACTU en PRUEBAS; solo la pareja real-pruebas comparte NIF
 * y ninguna de las dos puede cambiarlo; emitir en la de pruebas genera un
 * registro del entorno de pruebas con el NIF de la real.
 *
 * Solo corre en CI o contra una BD local (crea un administrador global, que al
 * terminar queda desactivado).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { controlCif } from '../utils/nif';
import { hoyEspana } from '../utils/fechas';
import { legalConfigService } from '../services/legalConfig.service';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { seriesEmpresaPruebas } from '../services/verifactu/empresaPruebas.service';
import { actualizarUsuario, asignarRol, CODIGO_EMPRESA_PRUEBAS_SOLO_ADMIN, crearUsuario } from '../services/admin.service';
import { archivarFacturaVenta } from '../services/archivoFacturas.service';
import { datosPdfFactura, pdfParaDescargar } from '../services/facturaPdf.service';
import { MARCA_PRUEBAS, TITULO_QR } from '../services/verifactu/qrPdf';
import { textosDePdf } from './texto-pdf';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const cif = (letra: 'A' | 'B') => {
  const siete = String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0');
  return `${letra}${siete}${controlCif(siete).cifra}`;
};
const NIF_REAL = cif('A');
const REAL = `vfpru-real-${SUFIJO}`;
const EXTRANJERA = `vfpru-us-${SUFIJO}`;
const SIN_NIF = `vfpru-sin-${SUFIJO}`;

const token = (userId: string, email: string, esAdminGlobal = false) => authService.generateToken({ userId, email, roles: [], companies: [], esAdminGlobal });
const como = (t: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${t}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${t}`).send(body),
});

let admin: { id: string; email: string };
let tAdmin: string;
let tVentas: string;
let pruebasId = '';

describeBd('empresas de pruebas de VERI*FACTU (BD real)', () => {
  beforeAll(async () => {
    admin = await prisma.user.create({
      data: { email: `vfpru-admin-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')), isGlobalAdmin: true },
      select: { id: true, email: true },
    });
    tAdmin = token(admin.id, admin.email, true);
    const ventas = await prisma.user.create({
      data: { email: `vfpru-ventas-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) },
      select: { id: true, email: true },
    });
    tVentas = token(ventas.id, ventas.email);

    await prisma.company.create({ data: { id: REAL, name: 'IFBIO Real', fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.legalConfig.create({
      data: { companyId: REAL, tipoSociedad: 'SA', denominacion: 'IFBIOSOLUCIONES, S.A.', nif: NIF_REAL, domicilioSocial: 'Calle Mayor 1', codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia', telefono: '960000000' },
    });
    await prisma.ajustesFiscales.create({ data: { companyId: REAL, criterioCaja: true } });
    await prisma.membership.create({ data: { userId: ventas.id, companyId: REAL, role: 'ventas' } });
    await prisma.company.create({ data: { id: EXTRANJERA, name: 'Foreign LLC', fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.legalConfig.create({ data: { companyId: EXTRANJERA, tipoSociedad: 'LLC', pais: 'US', monedaCuenta: 'USD', denominacion: 'Foreign LLC', nif: '12-3456789' } });
    await prisma.company.create({ data: { id: SIN_NIF, name: 'Sin NIF', fsBaseUrl: '', fsApiKeyEnc: '' } });
    await prisma.legalConfig.create({ data: { companyId: SIN_NIF, tipoSociedad: 'SL', denominacion: 'Sin NIF SL' } });
  });

  afterAll(async () => {
    // Ningun administrador global de prueba se queda activo.
    await prisma.user.updateMany({ where: { email: { endsWith: `-${SUFIJO}@test.local` } }, data: { isActive: false, isGlobalAdmin: false } });
  });

  it('solo el administrador global la crea, y hay que confirmarlo', async () => {
    expect((await como(tVentas).post(`/admin/empresas/${REAL}/pruebas-verifactu`, { confirmar: true })).status).toBe(403);
    const sin = await como(tAdmin).post(`/admin/empresas/${REAL}/pruebas-verifactu`, {});
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ campo: 'confirmar' });
    expect(await prisma.company.count({ where: { pruebasVerifactuDe: REAL } })).toBe(0);
  });

  it('la crea con los datos de la real, sus series, VERI*FACTU en PRUEBAS y rastro en las dos empresas', async () => {
    const res = await como(tAdmin).post(`/admin/empresas/${REAL}/pruebas-verifactu`, { confirmar: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ nombre: 'IFBIO Real (PRUEBAS)', nif: NIF_REAL, denominacion: 'IFBIOSOLUCIONES, S.A.', pruebasVerifactuDe: REAL, usuarios: 1 });
    pruebasId = res.body.data.id;

    expect(await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: pruebasId } })).toMatchObject({
      denominacion: 'IFBIOSOLUCIONES, S.A.',
      nif: NIF_REAL,
      tipoSociedad: 'SA',
      domicilioSocial: 'Calle Mayor 1',
      telefono: '960000000',
    });
    expect(await prisma.ajustesFiscales.findUniqueOrThrow({ where: { companyId: pruebasId } })).toMatchObject({ sii: false, criterioCaja: true });
    const s = seriesEmpresaPruebas(hoyEspana());
    const series = await prisma.invoiceSeries.findMany({ where: { companyId: pruebasId }, orderBy: { codigo: 'asc' } });
    expect(series.map((x) => [x.codigo, x.tipoDocumento, x.porDefecto, x.activa])).toEqual([
      [s.rectificativas, 'RECTIFICATIVA', true, true],
      [s.tickets, 'RECTIFICATIVA_SIMPLIFICADA', true, true],
      [s.facturas, 'FACTURA', true, true],
    ]);
    expect(s.facturas).toMatch(/^PRU\d{6}$/);
    expect(await prisma.verifactuConfig.findUniqueOrThrow({ where: { companyId: pruebasId } })).toMatchObject({ estado: 'PRUEBAS', entorno: 'PRUEBAS', activadaPor: admin.id });
    expect(await prisma.membership.findUnique({ where: { userId_companyId: { userId: admin.id, companyId: pruebasId } } })).toMatchObject({ role: 'admin' });
    for (const companyId of [REAL, pruebasId]) {
      expect(await prisma.verifactuBitacora.count({ where: { companyId, tipo: 'EMPRESA_PRUEBAS_CREADA' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { companyId, action: 'VERIFACTU_EMPRESA_PRUEBAS_CREADA', resourceId: pruebasId } })).toBe(1);
    }
  });

  it('no se crea otra para la misma real, ni desde una de pruebas, ni para una extranjera o sin NIF', async () => {
    const otra = await como(tAdmin).post(`/admin/empresas/${REAL}/pruebas-verifactu`, { confirmar: true });
    expect(otra.status).toBe(409);
    expect(otra.body.details).toMatchObject({ codigo: 'VERIFACTU_YA_TIENE_PRUEBAS', empresaPruebasId: pruebasId });
    const deDePruebas = await como(tAdmin).post(`/admin/empresas/${pruebasId}/pruebas-verifactu`, { confirmar: true });
    expect(deDePruebas.status).toBe(409);
    expect(deDePruebas.body.details).toMatchObject({ codigo: 'VERIFACTU_ES_DE_PRUEBAS' });
    expect((await como(tAdmin).post(`/admin/empresas/${EXTRANJERA}/pruebas-verifactu`, { confirmar: true })).body.details).toMatchObject({ codigo: 'VERIFACTU_NO_APLICA' });
    const sinNif = await como(tAdmin).post(`/admin/empresas/${SIN_NIF}/pruebas-verifactu`, { confirmar: true });
    expect(sinNif.status).toBe(409);
    expect(sinNif.body.details).toMatchObject({ codigo: 'VERIFACTU_DATOS_OBLIGADO', campos: ['nif'] });
    expect((await como(tAdmin).post(`/admin/empresas/no-existe-${SUFIJO}/pruebas-verifactu`, { confirmar: true })).status).toBe(404);
  });

  it('la lista de /admin dice cuál es de pruebas y de qué empresa', async () => {
    const res = await como(tAdmin).get('/admin/empresas');
    const fila = (id: string) => res.body.data.find((e: { id: string }) => e.id === id);
    expect(fila(pruebasId)).toMatchObject({ pruebasVerifactuDe: REAL, nif: NIF_REAL });
    expect(fila(REAL)).toMatchObject({ pruebasVerifactuDe: null });
  });

  it('el NIF repetido solo vale en la pareja: otra empresa nueva con ese NIF da 409', async () => {
    const res = await como(tAdmin).post('/admin/empresas', {
      nombre: 'Otra con el mismo NIF',
      datos: { denominacion: 'OTRA SA', tipoSociedad: 'SA', nif: NIF_REAL, domicilioSocial: 'Calle 2', codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia' },
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ campo: 'nif' });
  });

  it('la real y la de pruebas guardan sus datos sin cambiar el NIF; cambiarlo da 409 en las dos', async () => {
    await expect(legalConfigService.actualizar(REAL, { telefono: '961111111', nif: NIF_REAL }, { userId: admin.id, esAdministrador: true })).resolves.toMatchObject({ telefono: '961111111' });
    await expect(legalConfigService.actualizar(pruebasId, { telefono: '962222222' }, { userId: admin.id, esAdministrador: true })).resolves.toMatchObject({ telefono: '962222222' });
    const otroNif = cif('A');
    await expect(legalConfigService.actualizar(REAL, { nif: otroNif }, { userId: admin.id, esAdministrador: true })).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ campo: 'nif', codigo: 'VERIFACTU_TIENE_EMPRESA_PRUEBAS' }),
    });
    await expect(legalConfigService.actualizar(pruebasId, { nif: otroNif }, { userId: admin.id, esAdministrador: true })).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ campo: 'nif', codigo: 'VERIFACTU_EMPRESA_PRUEBAS_NIF' }),
    });
    expect((await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: REAL } })).nif).toBe(NIF_REAL);
  });

  it('emitir en la de pruebas genera un registro de PRUEBAS con el NIF de la real; en la real, sin VERI*FACTU, no', async () => {
    const clientes = new Map<string, string>();
    const emitir = async (companyId: string, extra: Record<string, unknown> = {}) => {
      const cliente =
        clientes.get(companyId) ??
        (await prisma.customer.create({ data: { companyId, nombreFiscal: 'Cliente SL', nifCif: 'B12345674', pais: 'ES', direccion: 'Calle 3', cp: '46001', municipio: 'Valencia' } })).id;
      clientes.set(companyId, cliente);
      return incomeInvoicesService.crearIngreso({
        companyId,
        customer: { id: cliente },
        fechaEmision: hoyEspana(),
        lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
        ...extra,
      } as CrearFacturaIngresoDTO);
    };
    const f = await emitir(pruebasId);
    expect(f.numeroCompleto).toBe(`${seriesEmpresaPruebas(hoyEspana()).facturas}-1`);
    const r = await prisma.verifactuRegistro.findFirstOrThrow({ where: { incomeInvoiceId: f.id } });
    expect(r).toMatchObject({ entorno: 'PRUEBAS', idEmisor: NIF_REAL, numSerie: f.numeroCompleto, tipoFactura: 'F1' });
    expect(r.xml).toContain(`<sf:IDEmisorFactura>${NIF_REAL}</sf:IDEmisorFactura>`);
    // Criterio de caja copiado de la real: clave 07.
    expect(r.xml).toContain('<sf:ClaveRegimen>07</sf:ClaveRegimen>');

    const real = await emitir(REAL);
    expect(await prisma.verifactuRegistro.count({ where: { incomeInvoiceId: real.id } })).toBe(0);

    // El PDF que se archiva al emitir (despues del commit) ya lleva el QR de prewww2 y la marca de pruebas.
    await archivarFacturaVenta(pruebasId, f.id);
    const archivado = await textosDePdf((await pdfParaDescargar(pruebasId, f.id)).contenido);
    expect(archivado.filter((x) => x.texto === TITULO_QR).map((x) => x.pagina)).toEqual([1]);
    expect(archivado.some((x) => x.texto === MARCA_PRUEBAS)).toBe(true);
    const datos = (await datosPdfFactura(pruebasId, f.id)).datos;
    expect(datos.verifactu?.url).toBe(
      `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=${NIF_REAL}&numserie=${f.numeroCompleto}&fecha=${r.fechaExpedicion}&importe=${r.importeTotal}`,
    );
    expect(datos).toMatchObject({ empresaPruebas: true });

    // La real (sin VERI*FACTU): ni QR ni marca.
    await archivarFacturaVenta(REAL, real.id);
    const pdfReal = await textosDePdf((await pdfParaDescargar(REAL, real.id)).contenido);
    expect(pdfReal.some((x) => x.texto === TITULO_QR || x.texto === MARCA_PRUEBAS)).toBe(false);

    // Borrador y proforma de la de pruebas: sin QR (no tienen registro); la proforma, con la marca.
    const borrador = await emitir(pruebasId, { borrador: true });
    const textosBorrador = await textosDePdf((await pdfParaDescargar(pruebasId, borrador.id)).contenido);
    expect(textosBorrador.some((x) => x.texto === TITULO_QR)).toBe(false);
    expect(textosBorrador.some((x) => x.texto === 'BORRADOR')).toBe(true);
    const proforma = await emitir(pruebasId, { proforma: true });
    const textosProforma = await textosDePdf((await pdfParaDescargar(pruebasId, proforma.id)).contenido);
    expect(textosProforma.some((x) => x.texto === TITULO_QR)).toBe(false);
    expect(textosProforma.some((x) => x.texto === MARCA_PRUEBAS)).toBe(true);
  });

  it('un registro de PRUEBAS en una empresa real (no deberia pasar): el PDF sale sin QR y con la marca de pruebas', async () => {
    // Se fuerza a mano: la app no deja emitir asi (409 VERIFACTU_ENTORNO_NO_PERMITIDO).
    const f = await prisma.incomeInvoice.findFirstOrThrow({ where: { companyId: pruebasId, estadoDocumento: 'FINAL' } });
    await prisma.company.update({ where: { id: pruebasId }, data: { pruebasVerifactuDe: null } });
    try {
      const datos = (await datosPdfFactura(pruebasId, f.id)).datos;
      expect(datos).toMatchObject({ verifactu: null, empresaPruebas: false, marcaPruebas: true });
    } finally {
      await prisma.company.update({ where: { id: pruebasId }, data: { pruebasVerifactuDe: REAL } });
    }
  });

  it('un registro de PRODUCCION en una empresa de pruebas (no deberia pasar): el PDF sale sin QR, con la marca de la empresa de pruebas', async () => {
    // Se fuerza con SQL a mano: la app no deja generarlo asi (409 VERIFACTU_ENTORNO_NO_PERMITIDO) ni cambiarlo (inmutabilidad).
    const f = await prisma.incomeInvoice.findFirstOrThrow({ where: { companyId: pruebasId, estadoDocumento: 'FINAL', verifactuEstado: { not: null } } });
    await prisma.$executeRaw`UPDATE VerifactuRegistro SET entorno = 'PRODUCCION' WHERE incomeInvoiceId = ${f.id}`;
    try {
      const datos = (await datosPdfFactura(pruebasId, f.id)).datos;
      expect(datos).toMatchObject({ verifactu: null, empresaPruebas: true });
    } finally {
      await prisma.$executeRaw`UPDATE VerifactuRegistro SET entorno = 'PRUEBAS' WHERE incomeInvoiceId = ${f.id}`;
    }
  });

  it('solo los administradores globales tienen acceso a la empresa de pruebas (lleva el NIF y los datos de la real)', async () => {
    const normal = await prisma.user.create({
      data: { email: `vfpru-normal-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')) },
      select: { id: true },
    });
    await expect(asignarRol(normal.id, pruebasId, 'ventas')).rejects.toMatchObject({ statusCode: 409, details: { codigo: CODIGO_EMPRESA_PRUEBAS_SOLO_ADMIN } });
    // Por la API de /admin, igual.
    const api = await request(app).put(`/admin/usuarios/${normal.id}/empresas/${pruebasId}`).set('Authorization', `Bearer ${tAdmin}`).send({ rol: 'ventas' });
    expect(api.status).toBe(409);
    // Un usuario nuevo con acceso a la empresa de pruebas tampoco (ni se crea).
    const email = `vfpru-nuevo-${SUFIJO}@test.local`;
    await expect(crearUsuario({ email, password: undefined, companyId: pruebasId, rol: 'ventas' }, { generarSiFalta: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.membership.count({ where: { companyId: pruebasId, userId: normal.id } })).toBe(0);
    // En la empresa real, como siempre.
    expect((await asignarRol(normal.id, REAL, 'ventas')).rol).toBe('ventas');

    // Un administrador global si; y no se le puede quitar el modo administrador mientras tenga ese acceso.
    const otro = await prisma.user.create({
      data: { email: `vfpru-admin2-${SUFIJO}@test.local`, passwordHash: hashPassword(randomBytes(18).toString('base64url')), isGlobalAdmin: true },
      select: { id: true },
    });
    await asignarRol(otro.id, pruebasId, 'admin');
    await expect(actualizarUsuario(admin.id, otro.id, { esAdminGlobal: false })).rejects.toMatchObject({ statusCode: 409, details: { codigo: CODIGO_EMPRESA_PRUEBAS_SOLO_ADMIN } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otro.id } })).isGlobalAdmin).toBe(true);
  });
});
