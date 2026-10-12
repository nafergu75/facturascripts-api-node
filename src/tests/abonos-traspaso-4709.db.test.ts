/**
 * Retención de abonos que no cabe en el 111 o el 115 de su periodo (decisión
 * P1, secciones 8.1 y 10.5 de la especificación de abonos), sobre BD real:
 * el asiento Debe 4709 / Haber 4751 por el exceso cuadra y deja la 4751 a
 * cero; no se hace dos veces; sin exceso da 409; la pantalla del 111/115 lo
 * enseña; se anula y se puede repetir; sin permiso, 403.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import { proveedoresService } from '../services/proveedores.service';
import { editarGasto, registrarGasto } from '../services/expense-invoices.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { crearAsientoConApuntes } from '../services/asientos.service';
import { taxModelsService } from '../services/tax-models.service';
import { aCentimos } from '../utils/money';
import { controlCif } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
function cif(): string {
  const siete = String(2000000 + ((SUFIJO + n++ * 7919) % 7999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function empresa(nombre: string): Promise<string> {
  const E = `abo4709-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id: E, name: `Traspaso ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: `Traspaso ${nombre}, S.L.`, nif: cif(), telefono: '963 11 22 33', personaContacto: 'Gómez Ruiz Ana' } });
  await asegurarPlanContableEmpresa(E);
  return E;
}

function app(companyId: string, permisos?: string[]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = {
      userId: 'u-4709',
      email: 'contable@test.local',
      roles: ['contable'],
      companies: [companyId],
      rolesPorEmpresa: { [companyId]: ['contable'] },
      ...(permisos ? { permisosPorEmpresa: { [companyId]: permisos } } : {}),
    } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/tax-models', borradoresAeatRoutes);
  a.use(errorMiddleware);
  return a;
}

const lin = (precio: number) => ({ descripcion: 'Asesoría', cantidad: 1, precioUnitario: precio, tipoIva: 21, tipoRetencion: 15 });
const prof = (sup: string, numero: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: sup },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'SERVICIO_PROFESIONAL',
  lineas: [lin(precio)],
  ...extra,
});

/** Saldo (debe menos haber, en euros) de las cuentas que empiezan por `prefijo` en asientos vigentes. */
async function saldo(E: string, prefijo: string): Promise<number> {
  const ls = await prisma.journalEntryLine.findMany({ where: { companyId: E, accountCode: { startsWith: prefijo }, entry: { estado: 'POSTED' } } });
  return ls.reduce((s, l) => s + aCentimos(Number(l.debe)) - aCentimos(Number(l.haber)), 0) / 100;
}

describe('111: traspaso a la 4709 de la retención de abonos que no cabe', () => {
  let E: string;

  beforeAll(async () => {
    E = await empresa('111');
    const sup = (await proveedoresService.create(E, { nombreFiscal: 'Asesoría Sanz SL', nifCif: cif(), cp: '46001' })).id;
    // 1T: factura de 1.000 € con 150 € de retención; el 111 del 1T se paga (la 4751 queda a cero).
    const o = await registrarGasto(E, prof(sup, 'P-1', '2027-01-10', 1000), { contabilizar: 'POSTED' });
    await crearAsientoConApuntes(E, {
      fecha: '2027-04-15',
      concepto: 'Pago modelo 111 1T/2027',
      apuntes: [
        { subcuenta: '4751', concepto: 'HP acreedora por retenciones', debe: 150, haber: 0 },
        { subcuenta: '572', concepto: 'Bancos', debe: 0, haber: 150 },
      ],
      origen: 'TESORERIA',
      exigirCuadre: true,
    });
    // 2T: otra factura con 60 € de retención y el abono entero de la del 1T (-150 €): [09] = 0 y sobran 90 €.
    await registrarGasto(E, prof(sup, 'P-2', '2027-05-05', 400), { contabilizar: 'POSTED' });
    await registrarGasto(E, prof(sup, 'P-1R', '2027-05-10', -1000, { rectificativa: { tipo: 'I', causa: 'ANULACION_PRECIO', originales: [{ id: o.factura.id }] } }), {
      contabilizar: 'POSTED',
    });
  });

  it('la pantalla del 111 del 2T enseña el exceso, sin traspaso hecho', async () => {
    const m = await taxModelsService.generarModelo111(E, 2027, '2T');
    expect(m).toMatchObject({ excesoAbonos: 90, traspaso4709: null });
    expect(m.casillasOficiales).toMatchObject({ '09_retenciones_actividades': 0 });
    expect(await saldo(E, '4751')).toBe(90);
  });

  it('sin permiso de impuestos ni de contabilidad para escribir: 403', async () => {
    const r = await request(app(E, ['impuestos:read', 'contabilidad:read', 'compras:write'])).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(r.status).toBe(403);
  });

  it('crea Debe 4709 / Haber 4751 por 90 € a fin del trimestre: cuadra y la 4751 queda a cero', async () => {
    const r = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2t' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ codigo: '111', ejercicio: 2027, periodo: '2T', importe: 90, cuenta4751: '4751', asiento: { fecha: '2027-06-30', importe: 90 } });
    const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: r.body.data.asiento.asientoId }, orderBy: { debe: 'desc' } });
    expect(lineas.map((l) => [l.accountCode, Number(l.debe), Number(l.haber)])).toEqual([
      ['4709', 90, 0],
      ['4751', 0, 90],
    ]);
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asiento.asientoId } });
    expect(asiento).toMatchObject({ estado: 'POSTED', invoiceType: 'TRASPASO_4709', invoiceId: '111-2027-2T' });
    expect(asiento.descripcion).toBe('Retención de abonos del 111 del 2T de 2027 que no se pudo restar: pasa a la 4709');
    expect(await saldo(E, '4751')).toBe(0);
    expect(await saldo(E, '4709')).toBe(90);
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: '4709' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'TRASPASO_4709' } })).toBe(1);

    // La pantalla lo dice con su asiento, y no se puede repetir.
    const m = await taxModelsService.generarModelo111(E, 2027, '2T');
    expect(m.traspaso4709).toMatchObject({ asientoId: r.body.data.asiento.asientoId, fecha: '2027-06-30', importe: 90 });
    expect(m.avisos).toContainEqual(`Los 90,00 € de retención de abonos que no caben en este 111 ya están pasados de la 4751 a la 4709 (asiento ${asiento.numeroAsiento}).`);
    const otra = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(otra.status).toBe(409);
    expect(otra.body.details).toMatchObject({ motivo: 'ya_traspasado' });
  });

  it('anularlo lo deja REVERSED y se puede volver a hacer con otra fecha', async () => {
    const anu = await request(app(E)).post('/tax-models/111/traspaso-4709/anular').send({ ejercicio: 2027, periodo: '2T' });
    expect(anu.status).toBe(200);
    expect(anu.body.data.contraasiento).toBeNull();
    expect(await saldo(E, '4709')).toBe(0);
    expect((await taxModelsService.generarModelo111(E, 2027, '2T')).traspaso4709).toBeNull();
    const otra = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T', fecha: '2027-07-20' });
    expect(otra.status).toBe(201);
    expect(otra.body.data.asiento.fecha).toBe('2027-07-20');
    const antes = await request(app(E)).post('/tax-models/111/traspaso-4709/anular').send({ ejercicio: 2027, periodo: '2T' });
    expect(antes.status).toBe(200);
    const pronto = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T', fecha: '2027-03-31' });
    expect(pronto.status).toBe(400);
    expect(pronto.body.details).toMatchObject({ campo: 'fecha' });
  });

  it('sin exceso (el 1T): 409 que lo explica; sin traspaso, anular da 409', async () => {
    const r = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '1T' });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('En el 111 del 1T de 2027 no hay retención de abonos que pasar a la 4709: los abonos caben en el modelo.');
    const anu = await request(app(E)).post('/tax-models/111/traspaso-4709/anular').send({ ejercicio: 2027, periodo: '1T' });
    expect(anu.status).toBe(409);
  });

  it('el mismo exceso no se pasa dos veces pidiendo un mes del trimestre ya traspasado (ni al revés)', async () => {
    const r = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(r.status).toBe(201);
    const numero = (await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asiento.asientoId } })).numeroAsiento;
    for (const periodo of ['05', '04', '06']) {
      const mes = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo });
      expect(mes.status).toBe(409);
      expect(mes.body.details).toMatchObject({ motivo: 'ya_traspasado' });
      expect(mes.body.message).toBe(`La retención de abonos de ese periodo ya está pasada a la 4709 con el 111 del 2T de 2027 (asiento ${numero}).`);
    }
    expect(await saldo(E, '4709')).toBe(90);
    // Al revés: con el de mayo hecho, el 2T tampoco.
    await request(app(E)).post('/tax-models/111/traspaso-4709/anular').send({ ejercicio: 2027, periodo: '2T' });
    const mayo = await crearAsientoConApuntes(E, {
      fecha: '2027-05-31',
      concepto: 'Traspaso de mayo',
      apuntes: [
        { subcuenta: '4709', concepto: '4709', debe: 90, haber: 0 },
        { subcuenta: '4751', concepto: '4751', debe: 0, haber: 90 },
      ],
      origen: 'AJUSTE_MANUAL',
      invoiceId: '111-2027-05',
      invoiceType: 'TRASPASO_4709',
      exigirCuadre: true,
    });
    const trimestre = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(trimestre.status).toBe(409);
    expect(trimestre.body.message).toBe(`La retención de abonos de ese periodo ya está pasada a la 4709 con el 111 de mayo de 2027 (asiento ${mayo.asiento.numero}).`);
  });
});

describe('115: el mismo traspaso con el abono de un alquiler', () => {
  it('a cero en [03] y 190 € a la 4709', async () => {
    const E = await empresa('115');
    const casero = (await proveedoresService.create(E, { nombreFiscal: 'Inmuebles Ruzafa SL', nifCif: cif(), cp: '46004' })).id;
    const alq = (num: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) =>
      registrarGasto(
        E,
        { proveedor: { id: casero }, numeroFacturaProveedor: num, fechaEmision: fecha, tipoGasto: 'ALQUILER', lineas: [{ descripcion: 'Alquiler', cantidad: 1, precioUnitario: precio, tipoIva: 21, tipoRetencion: 19 }], ...extra },
        { contabilizar: 'POSTED' },
      );
    const a1 = await alq('A-1', '2027-03-01', 1000);
    await alq('A-1R', '2027-04-01', -1000, { rectificativa: { tipo: 'I', causa: 'ANULACION_PRECIO', originales: [{ id: a1.factura.id }] } });
    const m = await taxModelsService.generarModelo115(E, 2027, '2T');
    expect(m).toMatchObject({ retencion: 0, excesoAbonos: 190, traspaso4709: null });
    const r = await request(app(E)).post('/tax-models/115/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ codigo: '115', importe: 190, asiento: { fecha: '2027-06-30' } });
    expect(await saldo(E, '4709')).toBe(190);
  });
});

describe('el traspaso hecho ya no coincide si después cambia el exceso', () => {
  it('corregir el abono avisa de que hay que rehacerlo; si ya no hace falta, lo dice y sigue enseñando el asiento', async () => {
    const E = await empresa('cambia');
    const sup = (await proveedoresService.create(E, { nombreFiscal: 'Asesoría Patraix SL', nifCif: cif(), cp: '46018' })).id;
    const o = await registrarGasto(E, prof(sup, 'P-1', '2027-01-10', 1000), { contabilizar: 'POSTED' });
    await registrarGasto(E, prof(sup, 'P-2', '2027-05-05', 400), { contabilizar: 'POSTED' });
    const abono = (precio: number) => prof(sup, 'RP-1', '2027-05-10', precio, { rectificativa: { tipo: 'I', causa: 'ANULACION_PRECIO', originales: [{ id: o.factura.id }] } });
    const a = await registrarGasto(E, abono(-1000), { contabilizar: 'POSTED' });
    const r = await request(app(E)).post('/tax-models/111/traspaso-4709').send({ ejercicio: 2027, periodo: '2T' });
    expect(r.status).toBe(201);
    const numero = (await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asiento.asientoId } })).numeroAsiento;

    // El abono pasa a -800 € (120 € de retención): ahora sobran 60 €, no 90 €.
    await editarGasto(E, a.factura.id, abono(-800));
    let m = await taxModelsService.generarModelo111(E, 2027, '2T');
    expect(m).toMatchObject({ excesoAbonos: 60, traspaso4709: { importe: 90 } });
    expect(m.avisos).toContainEqual(`El traspaso a la 4709 (asiento ${numero}, 90,00 €) ya no coincide con lo que ahora no cabe en este 111 (60,00 €): anúlalo y vuelve a hacerlo.`);
    expect(m.avisos.filter((x) => x.includes('ya están pasados'))).toEqual([]);

    // El abono pasa a -200 € (30 € de retención): ya cabe y el traspaso sobra, pero se sigue enseñando para anularlo.
    await editarGasto(E, a.factura.id, abono(-200));
    m = await taxModelsService.generarModelo111(E, 2027, '2T');
    expect(m).toMatchObject({ excesoAbonos: 0, traspaso4709: { importe: 90 } });
    expect(m.avisos).toContainEqual(`El traspaso a la 4709 (asiento ${numero}, 90,00 €) ya no hace falta: ahora los abonos caben en este 111. Anúlalo.`);
  });
});
